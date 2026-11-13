import { createHash } from "node:crypto";
import { extractMelonLikes } from "./melon.js";
import { applyPlaylist, matchAppleMusic, reviewResults } from "./pipeline.js";
import { readMatchSelection } from "./match-decisions.js";
import { readJson, readSongDocument } from "./io.js";
import { resolveWriteBackend } from "./apple-write-adapter.js";

const RESOLVED = new Set(["matched", "manual_confirmed", "linked_existing"]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const idsOf = (songs) => (songs ?? []).map((song) => String(song.melon_song_id));

function extractionStop(source) {
  const stopReason = source?.extraction?.stop_reason ?? null;
  if (source?.complete === true && stopReason === "completed") return null;
  return {
    stop_reason: stopReason,
    total_reported: source?.source?.total_reported ?? null,
    verified_unique_count: source?.extraction?.verified_unique_count ?? null,
    reported_count_gap: source?.extraction?.reported_count_gap ?? null,
    hint: stopReason === "total_mismatch"
      ? "좋아요를 취소한 곡이 있거나 목록이 바뀌었을 수 있습니다. 매칭·추가로 넘어가지 않았습니다."
      : "원본 전체 추출이 완료되지 않아 매칭·추가로 넘어가지 않았습니다."
  };
}

function unprocessedCount(selection) {
  return (selection.sourceDocument?.songs ?? []).filter((song) => !selection.effective.has(String(song.melon_song_id))).length;
}

// Read-only remote plan shared by preview and execute; the hash binds the exact add list.
async function remotePlan(config, backend, options) {
  const selection = await readMatchSelection(config);
  const check = await applyPlaylist(config, { check: true, backend, writeAdapter: options.writeAdapter });
  const importState = await readJson(config.files.importState, null);
  const addSongs = check.selected_add_songs ?? [];
  const addIds = addSongs.map((song) => String(song.apple_music_song_id));
  const previewHash = digest({ command: "sync", backend, storefront: check.storefront,
    playlist_id: importState?.playlist_id ?? null, add_ids: addIds, input_fingerprint: selection.input_fingerprint });
  return { selection, check, addSongs, addIds, previewHash };
}

function playlistSummary(check) {
  return { name: check.playlist_name, exists: check.playlist_exists,
    track_count: check.playlist_diagnostics?.track_count ?? 0,
    duplicate_count: check.playlist_diagnostics?.duplicate_catalog_ids?.length ?? 0 };
}

export async function syncLikes(config, options = {}) {
  if (!options.backend) throw new Error("sync에는 --backend official 또는 --backend web-player를 명시해야 합니다.");
  const backend = resolveWriteBackend(options.backend);
  if (Boolean(options.execute) !== Boolean(options.expectedPreview)) {
    throw new Error("--execute와 --expected-preview HASH는 함께 지정해야 합니다.");
  }
  return options.execute ? executeSync(config, backend, options) : previewSync(config, backend, options);
}

async function previewSync(config, backend, options) {
  const before = await readSongDocument(config.files.melonLikes, { songs: [], unavailable_songs: [] });
  const known = new Set([...idsOf(before.songs), ...idsOf(before.unavailable_songs)]);
  const extract = options.extract ?? extractMelonLikes;
  const source = await extract(config, { refresh: true, browserDependencies: options.browserDependencies });
  const stop = extractionStop(source);
  if (stop) return { mode: "preview", backend, stopped: true, stage: "extract", ...stop };

  const match = await matchAppleMusic(config, { lookupClient: options.lookupClient });
  if (match.next_command === "review") await reviewResults(config);

  const unprocessed = unprocessedCount(await readMatchSelection(config));
  if (unprocessed) return { mode: "preview", backend, stopped: true, stage: "match", unprocessed,
    hint: "매칭되지 않은 원곡이 남아 있어 추가 단계로 넘어가지 않았습니다." };
  const { selection, check, addSongs, previewHash } = await remotePlan(config, backend, options);

  const newSongs = (source.songs ?? []).filter((song) => !known.has(String(song.melon_song_id))).map((song) => ({
    melon_song_id: String(song.melon_song_id), title: song.title ?? null, artist: song.artist ?? null,
    match_status: selection.effective.get(String(song.melon_song_id))?.match_status ?? "unprocessed" }));
  const newUnavailable = (source.unavailable_songs ?? []).filter((song) => !known.has(String(song.melon_song_id)));
  const recoveryBlocked = selection.recoveries.unresolved.length > 0;
  const dataDir = options.dataDir ? ` --data-dir "${options.dataDir}"` : "";
  return {
    mode: "preview", backend, stopped: false,
    source: { count: source.songs.length, unavailable_count: source.unavailable_songs?.length ?? 0,
      total_reported: source.source?.total_reported ?? null },
    new_songs: newSongs,
    new_unavailable_count: newUnavailable.length,
    needs_review: newSongs.filter((song) => !RESOLVED.has(song.match_status)),
    add_songs: addSongs.map((song) => ({ apple_music_song_id: String(song.apple_music_song_id),
      title: song.apple_music_title, artist: song.apple_music_artist })),
    playlist: playlistSummary(check),
    recovery_blocked: recoveryBlocked,
    preview_hash: previewHash,
    next_command: addSongs.length && !recoveryBlocked
      ? `node src/cli.js sync --backend ${backend}${dataDir} --execute --expected-preview ${previewHash}` : null
  };
}

async function executeSync(config, backend, options) {
  const source = await readSongDocument(config.files.melonLikes, null);
  const stop = extractionStop(source);
  if (stop) throw new Error(`${stop.hint} (stop_reason: ${stop.stop_reason ?? "없음"}) 계정을 변경하지 않았습니다.`);
  if (unprocessedCount(await readMatchSelection(config))) throw new Error("매칭되지 않은 원곡이 남아 있습니다. 계정을 변경하지 않았습니다.");
  const { addIds, previewHash } = await remotePlan(config, backend, options);
  if (previewHash !== options.expectedPreview) {
    throw new Error("미리보기 이후 로컬 판정이나 플레이리스트 상태가 바뀌었습니다. 계정을 변경하지 않았습니다. sync를 다시 실행해 새 미리보기를 확인하세요.");
  }
  if (!addIds.length) return { mode: "execute", backend, added_this_run: 0, nothing_to_add: true };
  const applied = await applyPlaylist(config, { execute: true, backend, maxAdd: addIds.length,
    expectedAddSongIds: addIds, writeAdapter: options.writeAdapter });
  const after = await applyPlaylist(config, { check: true, backend, writeAdapter: options.writeAdapter });
  return { mode: "execute", backend, added_this_run: applied.added_this_run,
    playlist: playlistSummary(after), pending_after: after.pending_verified };
}

const line = (song) => `  + ${song.title ?? "(제목 없음)"} — ${song.artist ?? "(가수 없음)"}`;

export function formatSyncReport(result) {
  if (result.mode === "execute") {
    if (result.nothing_to_add) return "추가할 새 곡이 없습니다. 계정을 변경하지 않았습니다.";
    const p = result.playlist;
    return [`${result.added_this_run}곡을 추가했습니다.`,
      `플레이리스트 '${p.name}': ${p.track_count.toLocaleString("en-US")}항목, 남은 대기 ${result.pending_after}곡, 중복 ${p.duplicate_count}건`].join("\n");
  }
  if (result.stopped) {
    return result.stage === "extract"
      ? [`Melon 추출이 완료되지 않았습니다 (stop_reason: ${result.stop_reason ?? "없음"}, 표시 ${result.total_reported ?? "?"} · 검증 ${result.verified_unique_count ?? "?"}).`,
        result.hint, "중단 원인표: docs/usage-melon-and-matching.md"].join("\n")
      : [`미처리 원곡 ${result.unprocessed}곡이 남아 있습니다.`, result.hint, "node src/cli.js match 실행 후 다시 시도하세요."].join("\n");
  }
  const review = result.needs_review;
  const out = [`Melon 새 좋아요 ${result.new_songs.length + result.new_unavailable_count}곡 (전체 ${result.source.total_reported ?? result.source.count}곡, 추출 완료)`];
  if (result.new_songs.length) out.push(`  자동·기존 판정으로 해결 ${result.new_songs.length - review.length}곡`);
  if (review.length) {
    const counts = {};
    for (const song of review) counts[song.match_status] = (counts[song.match_status] ?? 0) + 1;
    out.push(`  수동 검토 필요 ${review.length}곡 (${Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(" · ")}) — data/review.html 확인`);
    for (const song of review) out.push(`    ? ${song.title ?? "(제목 없음)"} — ${song.artist ?? "(가수 없음)"} [${song.match_status}]`);
    out.push("  review.html에서 곡을 고르고 결정 파일을 내려받은 뒤: node src/cli.js resolve --decisions-file \"내려받은 파일 경로\"");
  }
  if (result.new_unavailable_count) out.push(`  비활성(재생 불가) ${result.new_unavailable_count}곡 — 자동 추가하지 않습니다`);
  const p = result.playlist;
  out.push(`플레이리스트 '${p.name}': 현재 ${p.track_count.toLocaleString("en-US")}항목, 추가 예정 ${result.add_songs.length}곡`);
  for (const song of result.add_songs) out.push(line(song));
  if (!result.add_songs.length) out.push("추가할 새 곡이 없습니다.");
  else if (result.recovery_blocked) out.push("미해결 복구가 있어 실제 추가가 차단됩니다. docs/usage-recovery.md를 참고하세요.");
  else out.push(`추가하려면: ${result.next_command}`);
  return out.join("\n");
}
