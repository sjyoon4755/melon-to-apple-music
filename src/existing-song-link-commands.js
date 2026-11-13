import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "./io.js";
import { readMatchSelection, appleSongIdFromOptions } from "./match-decisions.js";
import { ITunesSearchClient } from "./apple-api.js";
import { createAppleMusicReadAdapter, readOnlyAppleAdapter, resolveWriteBackend } from "./apple-write-adapter.js";
import { acquireDataLocks, acquireApplyLock, playlistTarget, releaseDataLocks, assertDataSnapshot } from "./apply-lock.js";
import { ExistingLinkError, linkError, linkDigest, sourceDigest, validateLinkEvidence, checkRecordingIdentity, verifyExistingTarget,
  unavailableLinkBase, unavailableLinkSource } from "./existing-song-links.js";
import { validateRecoveryRemote } from "./song-recoveries.js";

const MAX_PREVIEW_AGE = 10 * 60_000;
const numericId = value => /^\d+$/.test(value);
const reasonText = value => typeof value === "string" && value.trim() && value.length <= 500;
const previewFile = (config, hash) => path.join(config.stateDir, "existing-link-previews", `${hash}.json`);

function previewCounts(selection, state, delta, inactive = false) {
  const resolved = selection.records.filter(record => ["matched", "manual_confirmed", "linked_existing"].includes(record.match_status)).length;
  const unresolved = selection.records.length - resolved;
  const unique = new Set(selection.selected.map(record => String(record.apple_music_song_id))).size;
  const checkpoint = new Set((state?.added_song_ids ?? []).map(String)).size;
  const normalDelta = inactive ? 0 : delta;
  const inactiveResolved = selection.unavailableRecords.filter(record => ["manual_confirmed", "linked_existing"].includes(record.match_status)).length;
  const inactiveUnresolved = (selection.sourceDocument?.unavailable_songs?.length ?? 0) - inactiveResolved;
  return { resolved_sources: { before: resolved, after: resolved + normalDelta }, unresolved_sources: { before: unresolved, after: unresolved - normalDelta },
    ...(inactive ? { unavailable_unresolved: { before: inactiveUnresolved, after: inactiveUnresolved - delta },
      unavailable_linked_existing: { before: selection.links.unavailable.size, after: selection.links.unavailable.size + delta } } : {}),
    linked_existing: { before: selection.links.active.length, after: selection.links.active.length + delta },
    unique_apple_targets: { before: unique, after: unique }, checkpoint_unique: { before: checkpoint, after: checkpoint },
    unprocessed_sources: selection.sourceDocument ? selection.sourceDocument.songs.length - selection.records.length : null };
}

export async function issueLinkPreview(config, payload, now = Date.now()) {
  const document = { schema_version: 1, preview_id: randomUUID(), issued_at: new Date(now).toISOString(), expires_at: new Date(now + MAX_PREVIEW_AGE).toISOString(), payload };
  const hash = linkDigest(document);
  await writeJsonAtomic(previewFile(config, hash), document);
  return { preview_hash: hash, expires_at: document.expires_at };
}

export async function confirmLinkPreview(config, expected, payload, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) linkError("--confirm --expected-preview HASH가 필요합니다.");
  const document = await readJson(previewFile(config, expected));
  if (!document || document.schema_version !== 1 || linkDigest(document) !== expected || linkDigest(document.payload) !== linkDigest(payload)) {
    linkError("승인한 미리보기 또는 입력이 바뀌었습니다. 새 미리보기를 확인하세요.");
  }
  const issued = Date.parse(document.issued_at), expires = Date.parse(document.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || now < issued || expires - issued !== MAX_PREVIEW_AGE || now > expires) {
    linkError("미리보기 유효시간 10분이 지났습니다. 새 미리보기를 확인하세요.");
  }
}

function optionsFor(action, options) {
  const melonId = String(options.melonSongId ?? "").trim(), reason = String(options.reason ?? "").trim();
  if (!numericId(melonId) || !reasonText(reason)) linkError("숫자 --melon-song-id와 1~500자의 --reason이 필요합니다.");
  if (options.execute || options.force) linkError("연결/취소 명령은 execute/force를 지원하지 않습니다.");
  if (options.expectedPreview != null && !options.confirm) linkError("--expected-preview는 --confirm과 함께 사용하세요.");
  if (options.confirm && !/^[a-f0-9]{64}$/.test(options.expectedPreview ?? "")) linkError("--confirm --expected-preview HASH가 필요합니다.");
  return { action, melonId, reason };
}

async function evidenceFromFile(file) {
  if (!file || (await stat(file)).size > 64 * 1024) linkError("64KiB 이하의 --evidence-file JSON이 필요합니다.");
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { linkError("연결 근거 JSON을 읽을 수 없습니다. 파일 형식을 확인하세요."); }
}

async function inspectTarget(config, options, selection, state, appleId, source, evidence, confirmedAnchor) {
  try {
    const adapter = options.readAdapter ? readOnlyAppleAdapter(options.readAdapter) : await createAppleMusicReadAdapter(config, { backend: options.backend });
    const backend = resolveWriteBackend(options.backend);
    if (config.storefront !== "kr" || adapter.backend !== backend) linkError("연결은 지정 backend의 KR storefront에서만 지원합니다.");
    const session = await adapter.validateSession();
    if (String(session?.storefront ?? await adapter.getStorefront()).toLowerCase() !== "kr") linkError("현재 계정 storefront가 KR이 아닙니다.");
    const client = options.lookupClient ?? new ITunesSearchClient({ storefront: "kr" });
    const results = await client.lookupSongs([appleId], { sourceStorefront: "kr" });
    if (results.length !== 1 || String(results[0].id) !== appleId) linkError("한국 lookup의 정확한 대상 song ID를 확인할 수 없습니다.");
    let snapshot;
    if (state?.playlist_id && selection.recoveries.mappings.length) {
      const tracks = await adapter.getPlaylistTracks(state.playlist_id, { requireComplete: true });
      const recoveryValidation = await validateRecoveryRemote(selection, adapter, tracks, state);
      snapshot = { tracks, recoveryValidation };
    }
    const { catalog, remote } = await verifyExistingTarget(adapter, state, appleId, results[0], snapshot);
    const uncertainties = checkRecordingIdentity(source, catalog, evidence, confirmedAnchor);
    return { target: { id: appleId, playlist_id: state.playlist_id, backend, storefront: "kr", catalog,
      lookup: { id: String(results[0].id), title: results[0].title, artist: results[0].artist, album: results[0].album,
        isrc: results[0].isrc ?? null, duration_ms: results[0].duration_ms ?? null, content_rating: results[0].content_rating ?? null } }, remote, uncertainties };
  } catch (error) {
    if (error instanceof ExistingLinkError) throw error;
    linkError("기존 Apple 곡의 읽기 전용 검사가 실패했습니다. 인증 갱신이 필요하면 기존 프로그램 경로에서 직접 처리하세요. 인증/응답 진단은 출력하지 않았습니다.");
  }
}

export async function linkExistingSong(config, options = {}) {
  const { melonId, reason } = optionsFor("link", options);
  const anchorId = String(options.anchorMelonSongId ?? "").trim(), appleId = appleSongIdFromOptions(options);
  if (!numericId(anchorId) || anchorId === melonId) linkError("서로 다른 숫자 --anchor-melon-song-id가 필요합니다.");
  const evidence = validateLinkEvidence(await evidenceFromFile(options.evidenceFile), {
    melon_song_id: melonId, anchor_melon_song_id: anchorId, apple_music_song_id: appleId });
  const locks = [];
  try {
    if (options.confirm) locks.push(...await acquireDataLocks(config));
    const selection = await readMatchSelection(config);
    if ([melonId, anchorId].some(id => selection.recoveries.protectedSources.has(id))) linkError("복구 이력이 있는 원곡은 기존 연결로 변경하지 않습니다.");
    const normal = selection.sourceDocument?.songs ?? [], unavailable = selection.sourceDocument?.unavailable_songs ?? [];
    const inactive = Boolean(evidence.unavailable_origin);
    const sourceRows = inactive ? unavailable : normal;
    const raw = sourceRows.find(song => String(song.melon_song_id) === melonId);
    const anchorSource = normal.find(song => String(song.melon_song_id) === anchorId);
    const anchor = selection.effective.get(anchorId);
    const prior = selection.links.latest.get(melonId);
    if (!raw || !anchorSource) linkError("원곡과 정상 기준 원곡을 찾지 못했습니다. 비활성 원곡은 공개 근거가 필요합니다.");
    if (raw.melon_song_id !== melonId || anchorSource.melon_song_id !== anchorId
      || sourceRows.filter(song => String(song.melon_song_id) === melonId).length !== 1
      || (inactive ? normal : unavailable).some(song => String(song.melon_song_id) === melonId)
      || normal.filter(song => String(song.melon_song_id) === anchorId).length !== 1
      || unavailable.some(song => String(song.melon_song_id) === anchorId)) {
      linkError("원곡 ID가 중복되거나 비활성 목록과 충돌합니다. ID는 문자열이어야 합니다.");
    }
    if (inactive && (selection.unavailableDocument.mappings.some(mapping => mapping.melon_song_id === melonId)
      || selection.latest.has(melonId)
      || [selection.manualDocument, selection.matchedDocument, selection.unmatchedDocument]
        .some(document => document.songs.some(song => String(song.melon_song_id) === melonId)))) linkError("비활성 원곡의 기존 판정 이력과 충돌합니다.");
    const source = inactive ? unavailableLinkSource(raw, evidence) : raw;
    const before = inactive ? unavailableLinkBase(raw) : selection.baseEffective.get(melonId);
    const current = inactive ? selection.links.unavailable.get(melonId) ?? before : selection.effective.get(melonId);
    if (!anchor || !["matched", "manual_confirmed"].includes(anchor.match_status) || String(anchor.apple_music_song_id) !== appleId) {
      linkError("기준 원곡이 지정 Apple ID의 기존 확정 판정이어야 합니다. 연결 사슬은 지원하지 않습니다.");
    }
    if (prior?.action === "link" && current?.match_status !== "linked_existing") linkError("기존 연결이 변경됐습니다. unlink-existing으로 검토한 뒤 다시 연결하세요.");
    if (!inactive && prior?.action !== "link" && !["ambiguous", "not_found"].includes(current?.match_status)) linkError("새 연결은 정상 미결 ambiguous/not_found 원곡에만 지원합니다.");
    const state = await readJson(config.files.importState);
    if (options.confirm && state?.playlist_id) locks.push(await acquireApplyLock(playlistTarget(state.playlist_id), config.applyLockDir));
    const { target, remote, uncertainties } = await inspectTarget(config, options, selection, state, appleId, source, evidence, { source: anchorSource, selection: anchor });
    if (linkDigest(await evidenceFromFile(options.evidenceFile)) !== linkDigest(evidence)) linkError("검사 중 연결 근거 파일이 바뀌었습니다. 새 미리보기를 확인하세요.");
    await assertDataSnapshot(config, selection.input_fingerprint);
    const result = { action: "link", melon_song_id: melonId, anchor_melon_song_id: anchorId, apple_music_song_id: appleId,
      reason, before: current, after: "linked_existing", source, anchor: anchorSource, target,
      ...(inactive ? { unavailable_origin: evidence.unavailable_origin, comparison: evidence.comparison, references: evidence.references,
        approval_required: !options.confirm && prior?.action !== "link" } : {}),
      counts: previewCounts(selection, state, prior?.action === "link" ? 0 : 1, inactive),
      existing_origins: selection.selected.filter(record => String(record.apple_music_song_id) === appleId).map(record => String(record.melon_song_id)),
      identity_basis: evidence.identity_basis, uncertainties, remote_evidence: remote, account_changed: false, checkpoint_changed: false, saved: false };
    if (prior?.action === "link") {
      if (prior.anchor_melon_song_id !== anchorId || prior.apple_music_song_id !== appleId || prior.evidence_hash !== linkDigest(evidence)
        || prior.reason !== reason || linkDigest(prior.target) !== linkDigest(target)
        || (inactive && prior.remote_evidence.library_song_id !== remote.library_song_id)) linkError("이미 연결된 원곡의 대상/근거를 덮어쓰지 않습니다. 먼저 취소하세요.");
      if (options.confirm && options.expectedPreview !== prior.approved_preview_hash) linkError("기존 연결을 승인한 preview hash와 다릅니다.");
      return { ...result, already_linked: true, revision_id: prior.revision_id };
    }
    const payload = { action: "link", melon_song_id: melonId, anchor_melon_song_id: anchorId, apple_music_song_id: appleId, reason,
      source_fingerprint: inactive ? linkDigest(raw) : sourceDigest(source), anchor_fingerprint: sourceDigest(anchorSource), anchor_selection_fingerprint: linkDigest(anchor),
      base_record_fingerprint: linkDigest(before), input_fingerprint: selection.input_fingerprint, previous_revision: prior?.revision_id ?? null,
      target, evidence, evidence_hash: linkDigest(evidence), remote_identity: { ...remote, checked_at: undefined }, counts: result.counts };
    if (!options.confirm) return { ...result, ...(await issueLinkPreview(config, payload)) };
    await confirmLinkPreview(config, options.expectedPreview, payload);
    if (linkDigest(await evidenceFromFile(options.evidenceFile)) !== linkDigest(evidence)) linkError("저장 전 연결 근거 파일이 바뀌었습니다.");
    await assertDataSnapshot(config, selection.input_fingerprint);
    for (const lock of locks) await lock.assertOwned();
    const event = { ...payload, before, remote_evidence: remote, revision_id: randomUUID(), confirmed_at: new Date().toISOString(), approved_preview_hash: options.expectedPreview };
    delete event.input_fingerprint; delete event.remote_identity;
    await writeJsonAtomic(config.files.existingSongLinks, { schema_version: 1, events: [...selection.linksDocument.events, event] });
    return { ...result, saved: true, revision_id: event.revision_id };
  } finally { await releaseDataLocks(locks); }
}

export async function unlinkExistingSong(config, options = {}) {
  const { melonId, reason } = optionsFor("unlink", options);
  const locks = [];
  try {
    if (options.confirm) locks.push(...await acquireDataLocks(config));
    const selection = await readMatchSelection(config), prior = selection.links.latest.get(melonId);
    if (!prior) linkError("이 원곡의 기존 연결 이력이 없습니다.");
    if (prior.action === "unlink") return { action: "unlink", melon_song_id: melonId, saved: false, already_unlinked: true, account_changed: false, checkpoint_changed: false };
    const source = selection.sourceDocument?.songs.find(song => String(song.melon_song_id) === melonId), base = selection.baseEffective.get(melonId);
    const inactive = Boolean(prior.evidence.unavailable_origin);
    const stillUnavailable = inactive && !source && selection.sourceDocument?.unavailable_songs?.some(song => String(song.melon_song_id) === melonId);
    const safeRestore = source && ["ambiguous", "not_found"].includes(base?.match_status);
    const payload = { action: "unlink", melon_song_id: melonId, reason, previous_revision: prior.revision_id, link_revision: prior.revision_id,
      input_fingerprint: selection.input_fingerprint, source_fingerprint: source ? sourceDigest(source) : null,
      base_record_fingerprint: base ? linkDigest(base) : null, after: stillUnavailable ? "unavailable" : !source ? "orphan_cancelled" : safeRestore ? base.match_status : "held",
      counts: previewCounts(selection, await readJson(config.files.importState), selection.links.active.includes(prior) ? -1 : 0, inactive) };
    const result = { ...payload, account_changed: false, checkpoint_changed: false, saved: false };
    await assertDataSnapshot(config, selection.input_fingerprint);
    if (!options.confirm) return { ...result, ...(await issueLinkPreview(config, payload)) };
    await confirmLinkPreview(config, options.expectedPreview, payload);
    await assertDataSnapshot(config, selection.input_fingerprint);
    for (const lock of locks) await lock.assertOwned();
    const event = { ...payload, revision_id: randomUUID(), confirmed_at: new Date().toISOString(), approved_preview_hash: options.expectedPreview };
    delete event.input_fingerprint;
    await writeJsonAtomic(config.files.existingSongLinks, { schema_version: 1, events: [...selection.linksDocument.events, event] });
    return { ...result, saved: true, revision_id: event.revision_id };
  } finally { await releaseDataLocks(locks); }
}
