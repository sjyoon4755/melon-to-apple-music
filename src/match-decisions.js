import { createHash, randomUUID } from "node:crypto";
import { ITunesSearchClient } from "./apple-api.js";
import { readJson, readSongDocument, writeJsonAtomic } from "./io.js";
import { sourceFingerprint } from "./run-state.js";
import { acquireDataLocks, releaseDataLocks, dataSnapshot } from "./apply-lock.js";
import { readExistingLinks, projectExistingLinks } from "./existing-song-links.js";
import { readUnavailableMatches, projectUnavailableMatches } from "./unavailable-matches.js";
import { readRecoveryJournal, projectRecoveries, readRecoveryCatalogApprovals } from "./song-recoveries.js";
import { readFollowups, projectFollowups } from "./recovery-followups.js";

const SELECTED = new Set(["matched", "manual_confirmed"]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function previewRecord(record) {
  const fields = ["melon_song_id", "title", "artist", "album", "apple_music_song_id", "apple_music_title",
    "apple_music_artist", "apple_music_album", "apple_music_duration_ms", "apple_music_isrc",
    "apple_music_content_rating", "apple_music_url", "match_status", "match_source", "decision_revision"];
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]));
}

export function appleSongIdFromOptions(options) {
  if (options.appleSongId && options.appleUrl) throw new Error("--apple-song-id와 --apple-url은 함께 사용할 수 없습니다.");
  if (options.appleSongId) {
    const id = String(options.appleSongId).trim();
    if (!/^\d+$/.test(id)) throw new Error("--apple-song-id는 숫자 catalog ID여야 합니다.");
    return id;
  }
  if (options.appleUrl) {
    let url;
    try { url = new URL(String(options.appleUrl)); }
    catch { throw new Error("--apple-url 형식이 올바르지 않습니다."); }
    if (url.protocol !== "https:" || url.hostname !== "music.apple.com") {
      throw new Error("--apple-url은 https://music.apple.com 주소여야 합니다.");
    }
    const id = url.searchParams.get("i") ?? url.pathname.split("/").filter(Boolean).at(-1);
    if (!/^\d+$/.test(id ?? "")) throw new Error("Apple Music URL에서 song ID를 찾지 못했습니다.");
    return id;
  }
  throw new Error("--apple-song-id 또는 --apple-url이 필요합니다.");
}

async function readDecisions(config) {
  const document = await readJson(config.files.matchDecisions, { schema_version: 1, decisions: [] });
  if (document?.schema_version !== 1 || !Array.isArray(document.decisions)) {
    throw new Error("match_decisions.json 형식이 잘못되었습니다. 기존 기록을 보존하고 확인하세요.");
  }
  const revisions = new Set();
  for (const decision of document.decisions) {
    if (!decision || !["hold", "replace"].includes(decision.action)
      || typeof decision.melon_song_id !== "string" || !decision.melon_song_id
      || typeof decision.revision_id !== "string" || !decision.revision_id || revisions.has(decision.revision_id)
      || !/^[a-f0-9]{64}$/.test(decision.source_fingerprint ?? "")
      || typeof decision.reason !== "string" || !decision.reason.trim()
      || !decision.confirmed_at || decision.before?.melon_song_id !== decision.melon_song_id
      || (decision.action === "replace" && (decision.replacement?.melon_song_id !== decision.melon_song_id
        || decision.replacement.match_status !== "manual_confirmed"
        || !/^\d+$/.test(decision.replacement.apple_music_song_id ?? "")))) {
      throw new Error("match_decisions.json 판정 기록이 잘못되었습니다. 자동 결과로 돌아가지 않고 중단합니다.");
    }
    revisions.add(decision.revision_id);
  }
  return document;
}

// All consumers use the same effective records; original automatic/manual files stay intact.
export async function readMatchSelection(config, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await dataSnapshot(config);
    const result = await readMatchSelectionOnce(config, options);
    if (before === await dataSnapshot(config)) return { ...result, input_fingerprint: before };
  }
  throw new Error("로컬 판정 snapshot이 계속 변경됩니다. 진행 중인 작업을 마친 뒤 다시 확인하세요.");
}

async function readMatchSelectionOnce(config, options) {
  const [sourceDocument, matchedDocument, unmatchedDocument, manualDocument, decisionsDocument] = await Promise.all([
    readSongDocument(config.files.melonLikes), readSongDocument(config.files.matched, { songs: [] }),
    readSongDocument(config.files.unmatched, { songs: [] }), readSongDocument(config.files.manualMatches, { songs: [] }), readDecisions(config)
  ]);
  const matched = matchedDocument.songs ?? [], unmatched = unmatchedDocument.songs ?? [], manual = manualDocument.songs ?? [];
  const latest = new Map(decisionsDocument.decisions.map((d) => [d.melon_song_id, d]));
  const source = sourceDocument?.songs ?? [];
  // Legacy records without a Melon ID remain distinct; only real IDs can receive decisions.
  const recordKey = (record) => record.melon_song_id == null || String(record.melon_song_id).trim() === ""
    ? record : String(record.melon_song_id);
  const sourceById = new Map(source.map((s) => [recordKey(s), s]));
  const manualById = new Map(manual.map((s) => [recordKey(s), s]));
  if (latest.size && !sourceDocument) throw new Error("로컬 판정의 원본 Melon 목록이 없어 실행 대상을 확인할 수 없습니다.");
  const automaticById = new Map([...matched, ...unmatched].map((s) => [recordKey(s), s]));
  const storedOrder = [...new Set([...matched, ...manual, ...unmatched].map(recordKey).concat([...latest.keys()]))];
  let effective = new Map();
  for (const id of storedOrder) {
    if (sourceDocument && !sourceById.has(id)) continue;
    let record = manualById.get(id) ?? automaticById.get(id);
    const decision = latest.get(id);
    if (decision) {
      if (manualById.has(id)) throw new Error("로컬 판정과 기존 수동 승인 곡이 충돌합니다. 자동으로 덮어쓰지 않습니다.");
      const sourceRecord = sourceById.get(id);
      const stale = sourceFingerprint([sourceRecord]) !== decision.source_fingerprint;
      record = decision.action === "replace" && !stale ? decision.replacement : {
        ...(decision.action === "replace" ? decision.replacement : decision.before), title: sourceRecord.title, artist: sourceRecord.artist,
        album: sourceRecord.album, duration_ms: sourceRecord.duration_ms, isrc: sourceRecord.isrc, match_status: "held",
        match_source: "manual-user-held", match_reasons: [stale ? "source_changed_since_confirmation" : "user_hold"]
      };
      record = { ...record, decision_reason: decision.reason, decision_revision: decision.revision_id,
        decision_confirmed_at: decision.confirmed_at, decision_stale: stale };
    }
    if (record) effective.set(id, record);
  }
  const linksDocument = await readExistingLinks(config);
  const recoveryDocument = await readRecoveryJournal(config);
  const importState = await readJson(config.files.importState);
  const unavailableDocument = await readUnavailableMatches(config);
  const baseEffective = effective;
  const links = projectExistingLinks(baseEffective, sourceDocument, linksDocument, importState, unavailableDocument);
  effective = links.effective;
  const originalRecoveries = projectRecoveries(effective, sourceDocument, linksDocument, importState, recoveryDocument, options.allowPendingRecovery);
  const followupDocument = await readFollowups(config);
  const recoveries = projectFollowups(originalRecoveries, recoveryDocument, followupDocument, importState, options.allowPendingRecovery);
  const recoveryCatalogApprovals = await readRecoveryCatalogApprovals(config, recoveryDocument, recoveries.mappings);
  effective = recoveries.effective;
  const reviewOrder = sourceDocument ? source.map(recordKey) : storedOrder;
  const records = reviewOrder.flatMap((id) => effective.has(id) ? [effective.get(id)] : []);
  const selected = storedOrder.flatMap((id) => {
    const record = effective.get(id);
    return record && SELECTED.has(record.match_status) && record.apple_music_song_id ? [record] : [];
  });
  const unavailableRecords = projectUnavailableMatches(sourceDocument, unavailableDocument, selected);
  selected.push(...unavailableRecords.filter(record => record.match_status === "manual_confirmed"));
  unavailableRecords.push(...links.unavailable.values());
  return { sourceDocument, matchedDocument, unmatchedDocument, manualDocument, decisionsDocument,
    records, selected, effective, latest, baseEffective, linksDocument, links, unavailableDocument, unavailableRecords, recoveryDocument, followupDocument, originalRecoveries, recoveries, recoveryCatalogApprovals };
}

export async function reviseMatchDecision(config, options = {}) {
  const melonId = String(options.melonSongId ?? "").trim();
  const reason = String(options.reason ?? "").trim();
  if (!melonId) throw new Error("--melon-song-id가 필요합니다.");
  if (!reason || reason.length > 500) throw new Error("--reason에 1~500자의 검토 사유를 지정하세요.");
  if (options.hold && (options.appleSongId || options.appleUrl)) throw new Error("--hold와 Apple 후보는 함께 지정할 수 없습니다.");
  const appleId = options.hold ? null : appleSongIdFromOptions(options);
  if (options.confirm && !/^[a-f0-9]{64}$/.test(options.expectedPreview ?? "")) {
    throw new Error("먼저 미리보기를 확인하고 --confirm --expected-preview HASH를 지정하세요.");
  }
  if (!options.confirm && options.expectedPreview != null) throw new Error("--expected-preview는 --confirm과 함께 지정하세요.");
  const locks = [];
  try {
    if (options.confirm) {
      // Same order as execute: serialize decisions/checkpoint reads against real apply and other revisions.
      locks.push(...await acquireDataLocks(config));
    }
    const selection = await readMatchSelection(config);
    if (selection.recoveries.protectedSources.has(melonId)) throw new Error("복구 이력이 있는 곡은 일반 revise로 변경하지 않습니다.");
    if (selection.links.latest.has(melonId)) throw new Error("연결 이력이 있는 원곡은 unlink-existing 후 resolve로 새 판정을 확인하세요.");
    const song = selection.sourceDocument?.songs?.find((s) => String(s.melon_song_id) === melonId);
    if (!song) throw new Error("Melon 원본 목록에서 해당 곡을 찾지 못했습니다.");
    if ((selection.manualDocument.songs ?? []).some((s) => String(s.melon_song_id) === melonId)) {
      throw new Error("기존 수동 승인 곡은 revise로 덮어쓰지 않습니다.");
    }
    const before = selection.effective.get(melonId);
    if (!before || (!selection.latest.has(melonId) && before.match_status !== "matched")) {
      throw new Error("revise는 기존 자동 매칭 또는 로컬 교체·보류 판정에만 사용합니다. 미해결 곡은 resolve를 사용하세요.");
    }
    const importState = await readJson(config.files.importState);
    const checkpointIds = new Set((importState?.added_song_ids ?? []).map(String));
    const prior = selection.latest.get(melonId);
    if ([before, prior?.before, prior?.replacement].some((r) => r?.apple_music_song_id && checkpointIds.has(String(r.apple_music_song_id)))) {
      throw new Error("이미 Apple에 적용한 곡은 로컬 교체·보류하지 않습니다. 기존 checkpoint와 계정 내용을 먼저 별도로 검토하세요.");
    }
    let replacement = null;
    if (appleId) {
      if (config.storefront !== "kr") throw new Error("revise의 교체 확인은 KR storefront에서만 지원합니다.");
      const client = options.lookupClient ?? new ITunesSearchClient({ storefront: config.storefront });
      const apple = (await client.lookupSongs([appleId], { sourceStorefront: config.storefront }))[0];
      if (!apple || String(apple.id) !== appleId) throw new Error("선택한 Apple 곡이 현재 한국 catalog lookup에 없습니다.");
      if (selection.selected.some((r) => String(r.melon_song_id) !== melonId && String(r.apple_music_song_id) === appleId)
        || checkpointIds.has(appleId)) throw new Error("해당 Apple song ID는 다른 선택 곡 또는 기존 checkpoint에 이미 연결되어 있습니다.");
      replacement = { ...song, apple_music_song_id: appleId, apple_music_title: apple.title,
        apple_music_artist: apple.artist, apple_music_album: apple.album,
        apple_music_duration_ms: apple.duration_ms ?? null, apple_music_isrc: apple.isrc ?? null,
        apple_music_content_rating: apple.content_rating ?? null, apple_music_url: apple.url,
        match_status: "manual_confirmed", match_source: "manual-user-revised-itunes-lookup-kr",
        match_score: null, match_margin: null, match_components: null, candidates: [], match_reasons: ["user_confirmed"] };
    }
    const after = replacement ?? { ...before, match_status: "held", match_source: "manual-user-held", match_reasons: ["user_hold"] };
    const preview = { melon_song_id: melonId, action: options.hold ? "hold" : "replace", reason, before: previewRecord(before),
      after: previewRecord(after),
      apply_eligible_before: SELECTED.has(before.match_status), apply_eligible_after: !options.hold,
      storefront: config.storefront, remote_play_params_checked: false, account_changed: false, saved: false };
    // Bind approval to the concrete proposed metadata and all local inputs, including the checkpoint/history.
    const expectedPreview = digest([preview, replacement, selection.sourceDocument, selection.matchedDocument,
      selection.unmatchedDocument, selection.manualDocument, selection.decisionsDocument, importState]);
    if (!options.confirm) return { ...preview, preview_hash: expectedPreview };
    if (expectedPreview !== options.expectedPreview) throw new Error("미리보기 이후 후보 또는 로컬 결과가 바뀌었습니다. 새 미리보기를 확인하세요.");
    const current = await readMatchSelection(config);
    if (digest([current.sourceDocument, current.matchedDocument, current.unmatchedDocument, current.manualDocument, current.decisionsDocument,
      await readJson(config.files.importState)]) !== digest([selection.sourceDocument, selection.matchedDocument,
      selection.unmatchedDocument, selection.manualDocument, selection.decisionsDocument, importState])) {
      throw new Error("확인 중 로컬 결과가 바뀌었습니다. 기존 파일을 보존하고 새 미리보기를 확인하세요.");
    }
    for (const lock of locks) await lock.assertOwned();
    const confirmedAt = new Date().toISOString();
    const decision = { revision_id: randomUUID(), melon_song_id: melonId, action: preview.action, reason,
      source_fingerprint: sourceFingerprint([song]), approved_preview_hash: expectedPreview,
      confirmed_at: confirmedAt, previous_revision: prior?.revision_id ?? null,
      before, replacement: replacement ? { ...replacement, manual_confirmed_at: confirmedAt } : null };
    await writeJsonAtomic(config.files.matchDecisions, { schema_version: 1, updated_at: confirmedAt,
      decisions: [...selection.decisionsDocument.decisions, decision] });
    return { ...preview, saved: true, revision_id: decision.revision_id,
      history_count: selection.decisionsDocument.decisions.length + 1 };
  } finally {
    await releaseDataLocks(locks);
  }
}
