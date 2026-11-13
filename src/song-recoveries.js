import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { readJson } from "./io.js";

export const recoveryDigest = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
export const recoveryError = message => { throw new Error(`곡 복구: ${message}`); };
const id = value => typeof value === "string" && /^\d+$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
export const recoveryIsClosed = t => ["committed", "settled"].includes(t.phase);
export class UnresolvedRecoveryError extends Error {
  constructor() { super("미해결 복구가 남아 있습니다. 일반 실제 추가는 차단하며 상태 확인·읽기 전용 검사만 허용합니다."); }
}
// Runtime-only evidence: callers cannot replace validation with an ID allowlist.
const verifiedPreservedSnapshots = new WeakMap();
export function verifiedRecoveryPreservedIds(proof, state, tracks, backend) {
  if (proof == null) return new Set();
  const verified = verifiedPreservedSnapshots.get(proof);
  if (!verified || verified.backend !== backend || verified.state !== recoveryDigest(state)
    || verified.tracks !== recoveryDigest(tracks)) recoveryError("보존 항목의 검증 근거가 없거나 checkpoint·원격 목록이 변경됐습니다.");
  return new Set(verified.ids);
}
export function validRecoveryCatalog(c) {
  return c && id(c.id) && [c.title, c.artist, c.album].every(s => typeof s === "string" && s.trim() && s.length <= 1000)
    && typeof c.isrc === "string" && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(c.isrc)
    && Number.isSafeInteger(c.duration_ms) && c.duration_ms > 0
    && [null, "explicit", "not_explicit", "clean"].includes(c.content_rating)
    && (c.release_date === null || typeof c.release_date === "string")
    && (c.url === null || typeof c.url === "string");
}
export function recoveryCatalog(resource) {
  const a = resource?.attributes;
  const c = a && { id: String(resource.id), title: a.name, artist: a.artistName, album: a.albumName,
    isrc: a.isrc, duration_ms: a.durationInMillis, content_rating: a.contentRating ?? null,
    release_date: a.releaseDate ?? null, url: a.url ?? null };
  if (resource?.type !== "songs" || String(a?.playParams?.id ?? a?.playParams?.catalogId) !== c?.id || !validRecoveryCatalog(c)) {
    recoveryError("KR catalog/playParams·ISRC·길이를 확인할 수 없습니다.");
  }
  return c;
}

function recoveryAlbumId(value, songId) {
  if (typeof value !== "string" || value.length > 2000) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== "https://music.apple.com" || url.username || url.password || url.hash
    || url.search !== `?i=${songId}`) return null;
  return /^\/kr\/album\/[^/]+\/(\d+)$/.exec(url.pathname)?.[1] ?? null;
}

// Separate approvals affect only remote comparison, never the historical projection.
export async function readRecoveryCatalogApprovals(config, journal, mappings) {
  const approved = new Map();
  const file = config.files.recoveryCatalogApprovals;
  if (!file) return approved;
  const doc = await readJson(file, { schema_version: 1, approvals: [] });
  if (doc?.schema_version !== 1 || !Array.isArray(doc.approvals)) recoveryError("카탈로그 표기 승인 기록 형식이 잘못됐습니다.");
  for (const entry of doc.approvals) {
    const { recovery_id, payload_hash, melon_song_id, apple_music_song_id, approved_at, before, after } = entry ?? {};
    const parent = journal.transactions.find(t => t.id === recovery_id && recoveryIsClosed(t));
    const matches = r => r.melon_song_id === melon_song_id && r.new_catalog.id === apple_music_song_id;
    const historical = parent?.payload.rows.find(matches)?.new_catalog;
    const active = mappings.find(matches)?.new_catalog;
    const albumId = recoveryAlbumId(before?.url, apple_music_song_id);
    const pair = value => value && Object.keys(value).length === 2 && typeof value.title === "string"
      && value.title.trim() && value.title.length <= 1000 && typeof value.url === "string";
    if (!historical || !active || recoveryDigest(active) !== recoveryDigest(historical)
      || !hash(payload_hash) || parent.payload_hash !== payload_hash || !stamp(approved_at)
      || !pair(before) || !pair(after) || historical.title !== before.title || historical.url !== before.url
      || before.title === after.title || before.url === after.url || !albumId
      || albumId !== recoveryAlbumId(after.url, apple_music_song_id) || approved.has(apple_music_song_id)) {
      recoveryError("카탈로그 표기 승인이 복구 이력·곡·앨범과 일치하지 않습니다.");
    }
    approved.set(apple_music_song_id, { ...historical, title: after.title, url: after.url });
  }
  return approved;
}
export function validateRecoveryRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) recoveryError("대상은 1~100개여야 합니다.");
  const sources = new Set(), oldIds = new Set(), newIds = new Set(), libraries = new Set(), isrcs = new Set();
  for (const r of rows) {
    if (!r || !id(r.melon_song_id) || !validRecoveryCatalog(r.old_catalog) || !id(r.new_apple_music_song_id)
      || !/^i\.[A-Za-z0-9]+$/.test(r.library_song_id ?? "") || r.old_catalog.id === r.new_apple_music_song_id
      || typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 2000
      || !Array.isArray(r.limitations) || !r.limitations.length
      || r.limitations.some(s => typeof s !== "string" || !s.trim() || s.length > 2000)
      || sources.has(r.melon_song_id) || oldIds.has(r.old_catalog.id) || newIds.has(r.new_apple_music_song_id)
      || libraries.has(r.library_song_id) || isrcs.has(r.old_catalog.isrc)) recoveryError("대상 형식 또는 원곡·ID·ISRC 중복을 확인하세요.");
    sources.add(r.melon_song_id); oldIds.add(r.old_catalog.id); newIds.add(r.new_apple_music_song_id);
    libraries.add(r.library_song_id); isrcs.add(r.old_catalog.isrc);
  }
  if ([...newIds].some(x => oldIds.has(x))) recoveryError("옛ID·새ID가 교차합니다.");
  return rows;
}
export function validateRecoveryLibraryAdditions(additions, payload) {
  if (!Array.isArray(additions) || additions.length > 1) recoveryError("검토 가능한 대상 밖 보관함 추가는 최대 1곡입니다.");
  if (!additions.length) return additions;
  const baseline = [...payload.baseline_library, ...payload.baseline_playlist];
  const keys = ["id", "catalog_id", "title", "artist", "album", "duration_ms", "isrc"];
  for (const r of additions) {
    if (!r || Object.keys(r).length !== keys.length || Object.keys(r).some(k => !keys.includes(k))
      || !/^i\.[A-Za-z0-9]+$/.test(r.id ?? "") || !id(r.catalog_id)
      || ![r.title, r.artist, r.album].every(s => typeof s === "string" && s.trim() && s.length <= 1000)
      || !Number.isSafeInteger(r.duration_ms) || r.duration_ms <= 0
      || typeof r.isrc !== "string" || !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(r.isrc)) recoveryError("추가 보관함 곡의 ID·메타데이터·ISRC·길이를 확인할 수 없습니다.");
    if (baseline.some(b => b.id === r.id || b.catalog_id === r.catalog_id || b.isrc === r.isrc)
      || payload.rows.some(b => b.library_song_id === r.id || [b.old_catalog.id, b.new_catalog.id].includes(r.catalog_id)
        || b.old_catalog.isrc === r.isrc)) recoveryError("추가 보관함 곡이 기존 항목 또는 복구 대상 ID·ISRC와 중복됩니다.");
  }
  return additions;
}
export function recoveryLibraryAdditions(payload, inventory) {
  const baseline = new Set(payload.baseline_library.map(r => r.id)), targets = new Set(payload.rows.map(r => r.new_catalog.id));
  return validateRecoveryLibraryAdditions(inventory.library.filter(r => !baseline.has(r.id) && !targets.has(r.catalog_id)), payload);
}
export async function readRecoveryJournal(config) {
  try { if ((await stat(config.files.songRecoveries)).size > 8 * 1024 * 1024) recoveryError("복구 이력이 너무 큽니다."); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const doc = await readJson(config.files.songRecoveries, { schema_version: 1, transactions: [] });
  return validateRecoveryJournal(doc);
}
export function validateRecoveryJournal(doc) {
  if (doc?.schema_version !== 1 || !Array.isArray(doc.transactions)) recoveryError("복구 이력이 손상됐습니다.");
  const ids = new Set(); let pending = false;
  for (const t of doc.transactions) {
    if (!t || typeof t.id !== "string" || !/^[a-f0-9-]{36}$/.test(t.id) || ids.has(t.id) || pending
      || !["prepared", "remote_confirmed", "committed", "settled"].includes(t.phase) || !stamp(t.created_at)
      || !hash(t.payload_hash) || t.payload_hash !== recoveryDigest(t.payload) || !hash(t.base_snapshot)
      || !t.payload || t.payload.backend !== "web-player" || t.payload.storefront !== "kr"
      || !hash(t.payload.implementation_sha256)
      || typeof t.payload.playlist_id !== "string" || !t.payload.playlist_id
      || !Array.isArray(t.payload.baseline_playlist) || !Array.isArray(t.payload.baseline_library)) recoveryError("복구 transaction이 손상됐습니다.");
    validateRecoveryRows(t.payload.rows);
    for (const r of t.payload.rows) if (!r.source || r.source.melon_song_id !== r.melon_song_id
      || !r.before || r.before.melon_song_id !== r.melon_song_id || r.before.apple_music_song_id !== r.old_catalog.id
      || !["matched", "manual_confirmed"].includes(r.before.match_status) || !validRecoveryCatalog(r.new_catalog)
      || r.new_catalog.id !== r.new_apple_music_song_id || r.new_catalog.isrc !== r.old_catalog.isrc
      || r.new_catalog.duration_ms !== r.old_catalog.duration_ms || r.before.apple_music_duration_ms !== r.new_catalog.duration_ms) recoveryError("복구 원곡·기존 승인·후보 근거가 손상됐습니다.");
    if (["remote_confirmed", "committed"].includes(t.phase) && (!stamp(t.remote_confirmed_at) || !hash(t.remote_snapshot))) recoveryError("서버 확인 이력이 없습니다.");
    if (t.phase === "committed" && !stamp(t.committed_at)) recoveryError("복구 완료 이력이 없습니다.");
    if (t.phase === "settled") {
      const s = t.settlement;
      if (!s || s.previous_phase !== "prepared" || !stamp(s.confirmed_at) || !hash(s.implementation_sha256)
        || !hash(s.input_snapshot) || !hash(s.remote_snapshot) || !hash(t.settlement_hash)
        || t.settlement_hash !== recoveryDigest(s) || s.payload_hash !== t.payload_hash
        || typeof s.reason !== "string" || !s.reason.trim() || s.reason.length > 2000
        || !Array.isArray(s.outcomes) || s.outcomes.length !== t.payload.rows.length || s.outcomes.some(r => !r || typeof r !== "object")
        || !s.outcomes.some(r => r.status === "confirmed") || !s.outcomes.some(r => r.status === "unresolved")) recoveryError("부분 복구 확인 이력이 손상됐습니다.");
      // Older settled journals have no addition review; their original hash remains valid.
      if (Object.hasOwn(s, "library_additions")) validateRecoveryLibraryAdditions(s.library_additions, t.payload);
      for (const [i, r] of s.outcomes.entries()) {
        const row = t.payload.rows[i];
        if (!r || r.melon_song_id !== row.melon_song_id || r.new_apple_music_song_id !== row.new_apple_music_song_id
          || !["confirmed", "unresolved"].includes(r.status)
          || (r.status === "confirmed" ? !/^i\.[A-Za-z0-9]+$/.test(r.library_song_id ?? "") : r.library_song_id !== null)) recoveryError("부분 복구 곡별 결과가 손상됐습니다.");
      }
      if (s.library_additions?.some(r => s.outcomes.some(o => o.library_song_id === r.id))) recoveryError("검토한 보관함 추가분과 복구 결과 resource가 충돌합니다.");
    } else if (t.settlement != null || t.settlement_hash != null) recoveryError("미확정 부분 복구 이력이 있습니다.");
    ids.add(t.id); pending = !recoveryIsClosed(t);
  }
  return doc;
}
export function projectRecoveries(effective, source, links, state, journal, allowPending = false) {
  const pending = journal.transactions.find(t => !recoveryIsClosed(t));
  if (pending && !allowPending) recoveryError(`미완료 이력 ${pending.id}. recover --resume으로 GET 확인 후 재개하세요.`);
  const next = new Map(effective), sources = new Set(), protectedSources = new Set(), retired = new Set(), targets = new Set(), mappings = [], unresolved = [];
  const history = new Set((state?.added_song_ids ?? []).map(String));
  for (const t of journal.transactions.filter(recoveryIsClosed)) {
    if (state?.playlist_id !== t.payload.playlist_id || (state.backend ?? "official") !== t.payload.backend || state.storefront !== "kr") recoveryError("checkpoint 대상이 복구 이력과 다릅니다.");
    for (const r of t.payload.rows) {
      const original = source?.songs?.find(s => s.melon_song_id === r.melon_song_id), base = next.get(r.melon_song_id);
      if (protectedSources.has(r.melon_song_id) || retired.has(r.old_catalog.id) || targets.has(r.new_catalog.id)
        || !history.has(r.old_catalog.id) || recoveryDigest(original) !== recoveryDigest(r.source)
        || recoveryDigest(base) !== recoveryDigest(r.before)
        || [...next.values()].some(s => s.melon_song_id !== r.melon_song_id && s.apple_music_song_id === r.new_catalog.id)
        || links.events.some(e => e.melon_song_id === r.melon_song_id || e.anchor_melon_song_id === r.melon_song_id)) recoveryError("복구 원본·기준 판정·연결이 변경됐거나 대상이 충돌합니다.");
      protectedSources.add(r.melon_song_id);
      const outcome = t.settlement?.outcomes.find(x => x.melon_song_id === r.melon_song_id);
      if (outcome?.status === "unresolved") { unresolved.push({ ...r, recovery_id: t.id }); continue; }
      const c = r.new_catalog;
      next.set(r.melon_song_id, { ...base, apple_music_song_id: c.id, apple_music_title: c.title, apple_music_artist: c.artist,
        apple_music_album: c.album, apple_music_duration_ms: c.duration_ms, apple_music_isrc: c.isrc,
        apple_music_content_rating: c.content_rating, apple_music_url: c.url,
        recovery_id: t.id, recovery_old_apple_id: r.old_catalog.id, recovery_reason: r.reason, recovery_confirmed_at: t.committed_at ?? t.settlement.confirmed_at });
      sources.add(r.melon_song_id); retired.add(r.old_catalog.id); targets.add(c.id); history.add(c.id);
      mappings.push({ ...r, confirmed_library_song_id: outcome?.library_song_id ?? null });
    }
  }
  const unresolvedIds = new Set(unresolved.map(r => r.old_catalog.id));
  return { effective: next, sources, protectedSources, retired, targets, mappings, unresolved, pending, history,
    required: new Set([...history].filter(id => !retired.has(id) && !unresolvedIds.has(id))) };
}
export async function validateRecoveryRemote(selection, adapter, tracks, state) {
  const mappings = selection.recoveries.mappings;
  if (!mappings.length) return null;
  if (!state?.playlist_id || state.backend !== adapter.backend || state.storefront !== "kr") recoveryError("보존 항목 검증의 KR checkpoint/backend가 다릅니다.");
  const closed = selection.recoveryDocument.transactions.filter(recoveryIsClosed);
  if (!closed.length || closed.some(t => t.payload.playlist_id !== state.playlist_id || t.payload.backend !== state.backend)) recoveryError("보존 항목 검증의 복구 이력과 checkpoint 대상이 다릅니다.");
  for (const t of selection.followupDocument?.transactions ?? []) {
    if (t.events.at(-1).type === "confirmed" && tracks.some(r => r.catalog_id === t.payload.previous_candidate.id)) recoveryError("후속 복구 뒤 이전 실패 후보가 나타났습니다. 다시 검토하세요.");
  }
  const stateDigest = recoveryDigest(state), tracksDigest = recoveryDigest(tracks);
  const resources = await adapter.validateCatalogSongs(mappings.map(r => r.new_catalog.id));
  for (const r of mappings) {
    const current = resources.find(c => String(c.id) === r.new_catalog.id);
    const currentHash = current && recoveryDigest(recoveryCatalog(current));
    const approved = selection.recoveryCatalogApprovals?.get(r.new_catalog.id);
    const old = tracks.filter(t => t.id === r.library_song_id), active = tracks.filter(t => t.catalog_id === r.new_catalog.id);
    if (!current || (currentHash !== recoveryDigest(r.new_catalog) && (!approved || currentHash !== recoveryDigest(approved)))
      || old.length !== 1 || old[0].catalog_id || active.length !== 1
      || (r.confirmed_library_song_id && active[0].id !== r.confirmed_library_song_id)) recoveryError("복구 후 서버 항목·후보가 변경됐습니다.");
    const library = await adapter.getLibrarySong(r.library_song_id);
    if (!library || library.id !== r.library_song_id || library.catalog_id) recoveryError("기존 보관함 항목이 누락되거나 연결이 복구됐습니다.");
    if (r.confirmed_library_song_id) {
      const confirmed = await adapter.getLibrarySong(r.confirmed_library_song_id);
      if (!confirmed || confirmed.id !== r.confirmed_library_song_id || confirmed.catalog_id !== r.new_catalog.id) recoveryError("부분 확인한 새 보관함 항목이 변경됐습니다.");
    }
  }
  for (const r of selection.recoveries.unresolved) {
    const old = tracks.filter(t => t.id === r.library_song_id);
    if (old.length !== 1 || old[0].catalog_id || tracks.some(t => t.catalog_id === r.new_catalog.id || t.catalog_id === r.old_catalog.id)) recoveryError("미해결 복구의 서버 상태가 변경됐습니다. 다시 검토하세요.");
    const library = await adapter.getLibrarySong(r.library_song_id);
    if (!library || library.id !== r.library_song_id || library.catalog_id) recoveryError("미해결 복구의 원래 보관함 항목이 변경됐습니다.");
  }
  if (stateDigest !== recoveryDigest(state) || tracksDigest !== recoveryDigest(tracks)) recoveryError("보존 항목 검사 중 checkpoint·원격 목록이 변경됐습니다.");
  const proof = Object.freeze({});
  verifiedPreservedSnapshots.set(proof, { backend: adapter.backend, state: stateDigest, tracks: tracksDigest,
    ids: [...mappings, ...selection.recoveries.unresolved].map(r => r.library_song_id) });
  return proof;
}
