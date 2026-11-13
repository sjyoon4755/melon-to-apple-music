import { stat } from "node:fs/promises";
import { readJson } from "./io.js";
import { recoveryDigest, recoveryError, validRecoveryCatalog } from "./song-recoveries.js";

const hash = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const stamp = x => typeof x === "string" && Number.isFinite(Date.parse(x));
const text = x => typeof x === "string" && x.trim() && x.length <= 2000;
const uuid = x => typeof x === "string" && /^[a-f0-9-]{36}$/.test(x);
export const followupPhase = t => t.events.at(-1).type;

export function validateCandidatePlan(plan) {
  const keys = ["schema_version", "recovery_id", "parent_payload_hash", "parent_settlement_hash", "melon_song_id", "candidate", "reason", "limitations", "evidence"];
  if (!plan || Object.keys(plan).length !== keys.length || Object.keys(plan).some(k => !keys.includes(k))
    || plan.schema_version !== 1 || !uuid(plan.recovery_id) || !hash(plan.parent_payload_hash) || !hash(plan.parent_settlement_hash)
    || !/^\d+$/.test(plan.melon_song_id ?? "") || !validRecoveryCatalog(plan.candidate) || !text(plan.reason)
    || !Array.isArray(plan.limitations) || !plan.limitations.length || plan.limitations.length > 20 || !plan.limitations.every(text)
    || !Array.isArray(plan.evidence) || !plan.evidence.length || plan.evidence.length > 20) recoveryError("후보 검토 계획의 형식·부모 해시·한계를 확인하세요.");
  for (const e of plan.evidence) {
    if (!e || Object.keys(e).length !== 2 || !text(e.summary) || !text(e.url)) recoveryError("공개 근거 URL·요약이 필요합니다.");
    const u = new URL(e.url);
    if (u.protocol !== "https:" || u.username || u.password || !Object.hasOwn(e, "summary") || !Object.hasOwn(e, "url")) recoveryError("공개 근거는 인증 정보 없는 HTTPS URL이어야 합니다.");
  }
  return plan;
}

export function validateFollowups(doc) {
  if (doc?.schema_version !== 1 || !Array.isArray(doc.transactions)) recoveryError("후속 복구 이력이 손상됐습니다.");
  const ids = new Set(), sources = new Set(), targets = new Set(); let pending = false;
  for (const t of doc.transactions) {
    const p = t?.payload;
    if (!t || !uuid(t.id) || ids.has(t.id) || pending || !stamp(t.created_at) || !hash(t.base_snapshot)
      || !hash(t.payload_hash) || t.payload_hash !== recoveryDigest(p) || !p || p.backend !== "web-player" || p.storefront !== "kr"
      || !text(p.playlist_id) || !hash(p.implementation_sha256) || !hash(p.plan_digest)
      || !p.source || !p.before || !/^i\.[A-Za-z0-9]+$/.test(p.original_resource_id ?? "")
      || !validRecoveryCatalog(p.previous_candidate) || !Array.isArray(p.baseline_playlist) || !Array.isArray(p.baseline_library)
      || !Array.isArray(p.unknown_isrc) || !Array.isArray(t.events) || t.events.length < 1 || t.events.length > 3
      || !hash(t.events_hash) || t.events_hash !== recoveryDigest(t.events)) recoveryError("후속 복구 transaction이 손상됐습니다.");
    validateCandidatePlan(p.plan);
    if (sources.has(p.plan.melon_song_id) || targets.has(p.plan.candidate.id)) recoveryError("후속 원곡·후보가 중복됩니다.");
    for (const records of [p.baseline_playlist, p.baseline_library]) {
      if (records.some(r => !r || !/^i\.[A-Za-z0-9]+$/.test(r.id ?? "") || (r.catalog_id != null && !/^\d+$/.test(r.catalog_id)))
        || new Set(records.map(r => r.id)).size !== records.length) recoveryError("후속 복구 기준선이 손상됐습니다.");
    }
    for (const [i, event] of t.events.entries()) {
      if (!event || event.type !== ["approved", "attempted", "confirmed"][i] || !stamp(event.at) || Date.parse(event.at) < Date.parse(t.created_at)
        || (i === 0 ? !hash(event.preview_hash) : event.previous_hash !== recoveryDigest(t.events[i - 1]))
        || (i === 2 && (!hash(event.remote_snapshot) || !/^i\.[A-Za-z0-9]+$/.test(event.library_song_id ?? "")))) recoveryError("후속 복구 이벤트 순서·해시가 손상됐습니다.");
      if (i && Date.parse(event.at) < Date.parse(t.events[i - 1].at)) recoveryError("후속 복구 이벤트 시간이 역전됐습니다.");
      if (i === 2 && [...p.baseline_playlist, ...p.baseline_library].some(r => r.id === event.library_song_id)) recoveryError("후속 확인 resource가 원래 항목과 충돌합니다.");
    }
    ids.add(t.id); sources.add(p.plan.melon_song_id); targets.add(p.plan.candidate.id);
    pending = followupPhase(t) !== "confirmed";
  }
  return doc;
}

export async function readFollowups(config) {
  const file = config.files.recoveryFollowups;
  if (!file) return { schema_version: 1, transactions: [] };
  try { if ((await stat(file)).size > 8 * 1024 * 1024) recoveryError("후속 복구 이력이 너무 큽니다."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return validateFollowups(await readJson(file, { schema_version: 1, transactions: [] }));
}

export function projectFollowups(recoveries, journal, doc, state, allowPending = false) {
  validateFollowups(doc);
  const result = { ...recoveries, effective: new Map(recoveries.effective), unresolved: [...recoveries.unresolved], mappings: [...recoveries.mappings],
    sources: new Set(recoveries.sources), targets: new Set(recoveries.targets), retired: new Set(recoveries.retired),
    history: new Set(recoveries.history), required: new Set(recoveries.required), followupPending: null };
  for (const t of doc.transactions) {
    const p = t.payload, plan = p.plan, c = plan.candidate;
    const parent = journal.transactions.find(r => r.id === plan.recovery_id), row = parent?.payload.rows.find(r => r.melon_song_id === plan.melon_song_id);
    const unresolved = result.unresolved.find(r => r.recovery_id === plan.recovery_id && r.melon_song_id === plan.melon_song_id);
    if (parent?.phase !== "settled" || parent.payload_hash !== plan.parent_payload_hash || parent.settlement_hash !== plan.parent_settlement_hash
      || !row || !unresolved || p.playlist_id !== state?.playlist_id || p.backend !== state?.backend || state?.storefront !== "kr"
      || recoveryDigest(p.source) !== recoveryDigest(row.source) || recoveryDigest(p.before) !== recoveryDigest(row.before)
      || recoveryDigest(result.effective.get(plan.melon_song_id)) !== recoveryDigest(row.before)
      || p.original_resource_id !== row.library_song_id || recoveryDigest(p.previous_candidate) !== recoveryDigest(row.new_catalog)
      || (result.history.has(c.id) && followupPhase(t) !== "confirmed") || journal.transactions.some(tx => tx.payload.rows.some(r => r.new_catalog.id === c.id))
      || [...result.effective.values()].some(r => r.melon_song_id !== plan.melon_song_id && ["matched", "manual_confirmed"].includes(r.match_status)
        && (r.apple_music_song_id === c.id || r.apple_music_isrc === c.isrc))) recoveryError("후속 복구의 부모·원래 판정·후보가 변경되거나 충돌합니다.");
    for (const name of ["baseline_playlist", "baseline_library"]) {
      const original = parent.payload[name].filter(r => r.id === p.original_resource_id), kept = p[name].filter(r => r.id === p.original_resource_id);
      if (original.length !== 1 || kept.length !== 1 || recoveryDigest(original) !== recoveryDigest(kept)) recoveryError("후속 기준선의 원래 항목이 변경됐습니다.");
    }
    if (followupPhase(t) !== "confirmed") {
      result.followupPending = t;
      if (!allowPending) recoveryError(`미완료 후속 복구 ${t.id}. recover-followup --resume으로 GET 확인하세요.`);
      continue;
    }
    const event = t.events.at(-1);
    result.effective.set(plan.melon_song_id, { ...row.before, apple_music_song_id: c.id, apple_music_title: c.title, apple_music_artist: c.artist,
      apple_music_album: c.album, apple_music_duration_ms: c.duration_ms, apple_music_isrc: c.isrc, apple_music_content_rating: c.content_rating,
      apple_music_url: c.url, recovery_id: parent.id, recovery_followup_id: t.id, recovery_old_apple_id: row.old_catalog.id,
      recovery_reason: plan.reason, recovery_confirmed_at: event.at });
    result.unresolved = result.unresolved.filter(r => r !== unresolved);
    result.sources.add(plan.melon_song_id); result.targets.add(c.id); result.retired.add(row.old_catalog.id);
    result.history.add(c.id); result.required.add(c.id);
    result.mappings.push({ ...row, new_apple_music_song_id: c.id, new_catalog: c, confirmed_library_song_id: event.library_song_id });
  }
  return result;
}
