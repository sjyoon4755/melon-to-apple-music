import path from "node:path";
import { createHash } from "node:crypto";
import { ITunesSearchClient } from "./apple-api.js";
import { readJson, writeJsonAtomic } from "./io.js";
import { withDataLocks, assertDataSnapshot } from "./apply-lock.js";
import { readMatchSelection } from "./match-decisions.js";
import { assertManuallyResolvable, manualMatchRecord, updateReviewAfterSave } from "./pipeline.js";

const SOURCES = new Set(["candidate", "url", "bulk_top1"]);
const UNRESOLVED = new Set(["ambiguous", "not_found"]);
const LOOKUP_CHUNK = 50;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readDecisionsFile(file) {
  const document = await readJson(file, null);
  if (!document) throw new Error(`결정 파일을 찾지 못했습니다: ${file}`);
  if (document.schema_version !== 1 || document.kind !== "melon-review-decisions" || !Array.isArray(document.decisions)) {
    throw new Error("결정 파일 형식이 잘못되었습니다. review.html에서 내려받은 파일인지 확인하세요.");
  }
  const seen = new Set();
  for (const decision of document.decisions) {
    const id = decision?.melon_song_id;
    if (typeof id !== "string" || !id.trim() || !/^\d+$/.test(String(decision.apple_song_id ?? ""))
      || !SOURCES.has(decision.source)) throw new Error("결정 파일의 곡 항목이 잘못되었습니다. 파일을 수정하지 말고 다시 내려받으세요.");
    if (seen.has(id)) throw new Error(`결정 파일에 같은 Melon 곡이 두 번 있습니다: ${id}`);
    seen.add(id);
  }
  return document;
}

async function lookupAll(client, ids, storefront) {
  const found = new Map();
  for (let index = 0; index < ids.length; index += LOOKUP_CHUNK) {
    for (const song of await client.lookupSongs(ids.slice(index, index + LOOKUP_CHUNK), { sourceStorefront: storefront })) {
      found.set(String(song.id), song);
    }
  }
  return found;
}

// Builds the exact save set; preview and confirm both call this so the hash covers what was shown.
async function plan(config, document, options) {
  const selection = await readMatchSelection(config);
  const rejected = [], alreadyConfirmed = [], candidates = [];
  const appleCount = new Map();
  for (const decision of document.decisions) {
    const id = String(decision.apple_song_id);
    appleCount.set(id, (appleCount.get(id) ?? 0) + 1);
  }
  for (const decision of document.decisions) {
    const melonId = decision.melon_song_id, appleId = String(decision.apple_song_id);
    const effective = selection.effective.get(melonId);
    const reject = (reason) => rejected.push({ melon_song_id: melonId, title: effective?.title ?? null, artist: effective?.artist ?? null, reason });
    const manual = selection.manualDocument.songs.find((song) => String(song.melon_song_id) === melonId);
    if (manual) {
      if (String(manual.apple_music_song_id) === appleId) alreadyConfirmed.push({ melon_song_id: melonId, title: manual.title, apple_music_song_id: appleId });
      else reject("이미 다른 곡으로 수동 승인되어 있습니다. 바꾸려면 revise를 사용하세요.");
      continue;
    }
    if (appleCount.get(appleId) > 1) { reject("결정 파일에서 같은 Apple 곡을 여러 원곡에 골랐습니다."); continue; }
    try {
      const { melonSong, linkEvent } = assertManuallyResolvable(selection, melonId, appleId);
      if (linkEvent) { reject("기존 곡 연결을 해제한 곡은 개별 resolve로 처리하세요."); continue; }
      if (!UNRESOLVED.has(effective?.match_status)) { reject("미확정(ambiguous/not_found) 곡이 아닙니다."); continue; }
      candidates.push({ decision, melonSong });
    } catch (error) { reject(error.message); }
  }
  const client = options.lookupClient ?? new ITunesSearchClient({ storefront: config.storefront });
  const found = await lookupAll(client, candidates.map(({ decision }) => String(decision.apple_song_id)), config.storefront);
  const accepted = [];
  for (const { decision, melonSong } of candidates) {
    const appleSong = found.get(String(decision.apple_song_id));
    if (!appleSong) {
      rejected.push({ melon_song_id: decision.melon_song_id, title: melonSong.title, artist: melonSong.artist,
        reason: `Apple song ID ${decision.apple_song_id}가 ${config.storefront.toUpperCase()} storefront lookup에 없습니다.` });
      continue;
    }
    const record = manualMatchRecord(melonSong, appleSong, null);
    if (decision.source === "bulk_top1") record.manual_selection = "bulk_top1";
    accepted.push({ record, source: decision.source });
  }
  const previewHash = digest({ command: "resolve-decisions", storefront: config.storefront,
    input_fingerprint: selection.input_fingerprint, records: accepted.map(({ record }) => record) });
  return { selection, accepted, alreadyConfirmed, rejected, previewHash };
}

function summary(document, result, extra) {
  const { selection, accepted, alreadyConfirmed, rejected, previewHash } = result;
  return {
    review_fingerprint_matches: document.review_fingerprint === selection.input_fingerprint,
    counts: { accepted: accepted.length, direct: accepted.filter((item) => item.source !== "bulk_top1").length,
      bulk_top1: accepted.filter((item) => item.source === "bulk_top1").length,
      already_confirmed: alreadyConfirmed.length, rejected: rejected.length },
    accepted: accepted.map(({ record, source }) => ({ melon_song_id: String(record.melon_song_id), title: record.title, artist: record.artist,
      apple_music_song_id: record.apple_music_song_id, apple_music_title: record.apple_music_title,
      apple_music_artist: record.apple_music_artist, apple_music_album: record.apple_music_album, source })),
    already_confirmed: alreadyConfirmed, rejected, preview_hash: previewHash, ...extra
  };
}

export async function resolveDecisions(config, options = {}) {
  if (options.confirm && !options.expectedPreview) throw new Error("결정 파일 확정에는 --confirm과 --expected-preview HASH가 함께 필요합니다.");
  const file = path.resolve(options.decisionsFile);
  const document = await readDecisionsFile(file);
  if (!options.confirm) {
    const result = await plan(config, document, options);
    const dataDir = options.dataDir ? ` --data-dir "${options.dataDir}"` : "";
    return summary(document, result, { mode: "preview", saved: false, decisions_file: file,
      next_command: result.accepted.length
        ? `melon-to-apple-music resolve --decisions-file "${file}"${dataDir} --confirm --expected-preview ${result.previewHash}` : null });
  }
  const saved = await withDataLocks(config, async (assertOwned) => {
    const result = await plan(config, document, options);
    if (result.previewHash !== options.expectedPreview) {
      throw new Error("미리보기 이후 로컬 판정이나 Apple 곡 정보가 바뀌었습니다. 저장하지 않았습니다. 미리보기를 다시 실행하세요.");
    }
    await assertDataSnapshot(config, result.selection.input_fingerprint);
    await assertOwned();
    if (result.accepted.length) {
      const now = new Date().toISOString();
      await writeJsonAtomic(config.files.manualMatches, { schema_version: 1, updated_at: now,
        songs: [...result.selection.manualDocument.songs, ...result.accepted.map(({ record }) => ({ ...record, manual_confirmed_at: now }))] });
    }
    return summary(document, result, { mode: "confirm", saved: result.accepted.length > 0, decisions_file: file });
  });
  return saved.saved || saved.already_confirmed.length ? updateReviewAfterSave(config, saved) : saved;
}

export function formatDecisionsReport(result) {
  const c = result.counts;
  const out = [];
  if (!result.review_fingerprint_matches) out.push("주의: 검토표를 만든 뒤 로컬 판정이 바뀌었습니다. 각 곡을 현재 상태로 다시 검사했습니다.");
  out.push(result.mode === "preview"
    ? `저장 예정 ${c.accepted}곡 (직접 선택 ${c.direct} · 한꺼번에 고름 ${c.bulk_top1}) · 이미 승인 ${c.already_confirmed}곡 · 제외 ${c.rejected}곡`
    : `${result.saved ? "저장 완료" : "저장할 곡 없음"} ${c.accepted}곡 (직접 선택 ${c.direct} · 한꺼번에 고름 ${c.bulk_top1}) · 이미 승인 ${c.already_confirmed}곡 · 제외 ${c.rejected}곡`);
  for (const song of result.accepted) {
    out.push(`  ${song.source === "bulk_top1" ? "*" : "+"} ${song.title ?? "(제목 없음)"} — ${song.artist ?? "(가수 없음)"}  →  ${song.apple_music_title} — ${song.apple_music_artist} [${song.apple_music_album ?? ""}] (${song.apple_music_song_id})`);
  }
  if (c.bulk_top1) out.push("  (* 표시는 review.html에서 한꺼번에 고른 곡입니다)");
  for (const song of result.rejected) out.push(`  - 제외: ${song.title ?? song.melon_song_id} — ${song.reason}`);
  if (result.mode === "preview") {
    out.push(result.next_command ? `위 목록을 확인했다면 저장: ${result.next_command}` : "저장할 곡이 없습니다.");
    out.push("저장해도 Apple Music 계정은 바뀌지 않습니다. 추가는 이후 sync에서 별도로 승인합니다.");
  } else if (result.review_updated === false) out.push("검토표 갱신에 실패했습니다. melon-to-apple-music review 를 실행하세요.");
  return out.join("\n");
}
