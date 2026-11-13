import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ITunesSearchClient } from "./apple-api.js";
import { createAppleMusicWriteAdapter } from "./apple-write-adapter.js";
import { readJson } from "./io.js";
import { readMatchSelection } from "./match-decisions.js";
import { assertDataSnapshot } from "./apply-lock.js";
import { recoveryInventory } from "./recovery-inventory.js";
import { validateActiveLinks } from "./existing-song-links.js";
import { recoveryDigest, recoveryError, validateRecoveryRemote } from "./song-recoveries.js";
import { validateCandidatePlan } from "./recovery-followups.js";

async function readPlan(config, file) {
  if (typeof file !== "string" || !file) recoveryError("후보 검토 --plan-file이 필요합니다.");
  const name = path.resolve(config.root, file);
  if ((await stat(name)).size > 1024 * 1024) recoveryError("후보 검토 계획이 너무 큽니다.");
  const bytes = await readFile(name);
  if (bytes.length > 1024 * 1024) recoveryError("후보 검토 계획이 너무 큽니다.");
  const plan = JSON.parse(bytes.toString("utf8"));
  validateCandidatePlan(plan);
  return { plan, digest: recoveryDigest(bytes.toString("base64")) };
}

export async function candidateImplementationDigest() {
  const names = ["recovery-candidate-review.js", "recovery-followup-command.js", "recovery-followups.js", "pipeline.js", "recovery-inventory.js", "song-recoveries.js", "match-decisions.js",
    "existing-song-links.js", "apply-lock.js", "apple-write-adapter.js", "apple-write-api.js", "apple-web-api.js",
    "apple-api.js", "io.js", "config.js", "cli.js", "cli-options.js"];
  return recoveryDigest(await Promise.all(names.map(async name => [name, await readFile(new URL(name, import.meta.url), "utf8")])));
}

// A related edition with different identifiers needs its own review, never a relaxed recover/resume.
// There is deliberately no persistent journal writer or account-write method in this command.
export async function inspectRecoveryCandidate(config, options = {}) {
  if (config.storefront !== "kr" || options.backend !== "web-player") recoveryError("후보 검토는 KR --backend web-player만 지원합니다.");
  if (options.execute || options.confirm || options.resume != null || options.expectedPreview != null) recoveryError("후보 검토는 무쓰기 전용이며 실행·확정·재개를 지원하지 않습니다.");
  try {
    const { plan, digest: planDigest } = await readPlan(config, options.planFile);
    const selection = await readMatchSelection(config), snapshot = selection.input_fingerprint;
    const journal = selection.recoveryDocument, parent = journal.transactions.at(-1);
    if (parent?.id !== plan.recovery_id || parent.phase !== "settled"
      || parent.payload_hash !== plan.parent_payload_hash || parent.settlement_hash !== plan.parent_settlement_hash) recoveryError("최신 settled 부모 거래와 payload·부분 확정 해시가 다릅니다.");
    const row = parent.payload.rows.find(r => r.melon_song_id === plan.melon_song_id);
    if (!row || !selection.recoveries.unresolved.some(r => r.recovery_id === parent.id && r.melon_song_id === plan.melon_song_id)) recoveryError("부모 거래의 현재 미해결 원곡만 새 후보를 검토할 수 있습니다.");
    const c = plan.candidate;
    if (selection.recoveries.history.has(c.id) || journal.transactions.some(t => t.payload.rows.some(r => r.new_catalog.id === c.id))
      || selection.selected.some(r => r.melon_song_id !== plan.melon_song_id && (r.apple_music_song_id === c.id || r.apple_music_isrc === c.isrc))) recoveryError("후보가 기존 승인·복구 ID 또는 선택곡과 중복됩니다.");
    const state = await readJson(config.files.importState);
    if (state?.backend !== "web-player" || state.storefront !== "kr" || state.playlist_id !== parent.payload.playlist_id) recoveryError("부모 거래의 KR checkpoint가 필요합니다.");
    const implementation = await candidateImplementationDigest();
    const raw = options.writeAdapter ?? await createAppleMusicWriteAdapter(config, { backend: "web-player" });
    const methods = ["validateSession", "getLibraryPlaylist", "validateCatalogSongs", "getLibrarySong", "resolveUrl"];
    const adapter = { backend: raw.backend, ...Object.fromEntries(methods.map(name => [name, (...args) => raw[name](...args)])),
      request: (url, init = {}) => {
        if ((init.method ?? "GET").toUpperCase() !== "GET") recoveryError("후보 검토는 GET만 허용합니다.");
        return raw.request(url, { ...init, method: "GET" });
      } };
    const ids = [...new Set([c.id, ...parent.payload.rows.map(r => r.new_catalog.id)])];
    const inventory = await recoveryInventory(adapter, state.playlist_id, ids, options.lookupClient ?? new ITunesSearchClient({ storefront: "kr" }));
    const current = inventory.catalog.find(r => r.id === c.id);
    if (!current || Object.keys(current).length !== Object.keys(c).length
      || Object.keys(current).some(key => !Object.hasOwn(c, key) || current[key] !== c[key])) recoveryError("검토한 후보의 KR metadata가 변경됐습니다.");
    if ((await adapter.validateCatalogSongs(parent.payload.rows.map(r => r.old_catalog.id))).length) recoveryError("원래ID 제공이 복원됐습니다. 기존 복구 범위를 다시 검토하세요.");
    const tracks = inventory.playlist.map(r => ({ id: r.id, catalog_id: r.catalog_id }));
    const proof = await validateRecoveryRemote(selection, adapter, tracks, state);
    const links = await validateActiveLinks(selection, state, adapter, { playlist: { id: state.playlist_id, canEdit: true }, tracks, recoveryValidation: proof });
    for (const records of [inventory.playlist, inventory.library]) {
      if (records.some(r => r.catalog_id === c.id || r.isrc === c.isrc)) recoveryError("후보 ID 또는 같은 ISRC가 원격 목록과 중복됩니다.");
    }
    // The latest settled attempt already reviewed its one unrelated library addition.
    // Preserve that exact baseline and every successful resource; do not adopt new drift.
    const confirmed = new Set(parent.settlement.outcomes.filter(r => r.status === "confirmed").map(r => r.new_apple_music_song_id));
    const additions = parent.settlement.library_additions ?? [], additionIds = new Set(additions.map(r => r.id));
    if (recoveryDigest(inventory.library.filter(r => additionIds.has(r.id))) !== recoveryDigest(additions)
      || recoveryDigest(inventory.playlist.filter(r => !confirmed.has(r.catalog_id))) !== recoveryDigest(parent.payload.baseline_playlist)
      || recoveryDigest(inventory.library.filter(r => !confirmed.has(r.catalog_id) && !additionIds.has(r.id))) !== recoveryDigest(parent.payload.baseline_library)) recoveryError("부모 거래에서 확인한 대상 밖 원격 기준선이 변경됐습니다.");
    const present = new Set(tracks.map(r => r.catalog_id).filter(Boolean));
    if ([...selection.recoveries.required].some(id => !present.has(id)) || [...present].some(id => !selection.recoveries.history.has(id))) recoveryError("현재 checkpoint와 원격 선택곡이 다릅니다.");
    const preview = { action: "review-recovery-candidate", review_only: true, execution_supported: false, approval_required: true,
      saved: false, account_changed: false, execution_blocked: true, same_audio_master_verified: false,
      parent: { recovery_id: parent.id, payload_hash: parent.payload_hash, settlement_hash: parent.settlement_hash, phase: parent.phase },
      backend: "web-player", playlist_id: state.playlist_id, implementation_sha256: implementation,
      source: row.source, existing_approval: row.before, original_resource_id: row.library_song_id, previous_candidate: row.new_catalog,
      candidate: current, reason: plan.reason, limitations: plan.limitations, supplied_evidence: plan.evidence,
      differences: Object.keys(current).filter(k => k !== "id" && current[k] !== row.new_catalog[k]).map(field => ({ field, previous: row.new_catalog[field], candidate: current[field] })),
      unknown_isrc: inventory.unknown_isrc, preserved_library_additions: additions,
      counts: { playlist: inventory.playlist.length, library: inventory.library.length, confirmed: confirmed.size,
        unresolved: selection.recoveries.unresolved.length, active_links_checked: links.length, candidate_id_hits: 0, candidate_isrc_hits: 0 },
      followup_policy: "실행은 지원하지 않습니다. 향후 별도 승인을 받은 후속 이벤트가 부모 거래·원래 승인·checkpoint를 보존하도록 구현해야 합니다." };
    try { await assertDataSnapshot(config, snapshot); }
    catch { recoveryError("검사 중 운영 입력이 바뀌었습니다. 저장하지 않고 중단합니다."); }
    if ((await readPlan(config, options.planFile)).digest !== planDigest || await candidateImplementationDigest() !== implementation) recoveryError("검사 중 계획 또는 구현이 변경됐습니다.");
    return { plan, planDigest, selection, state, inventory, preview: { ...preview, input_snapshot: snapshot, remote_snapshot: inventory.digest,
      preview_hash: recoveryDigest([snapshot, planDigest, inventory.digest, preview]) } };
  } catch (error) {
    if (error.message?.startsWith("곡 복구:")) throw error;
    throw new Error("곡 복구: 후보 검토를 완료하지 못했습니다. 이력을 보존했으며 인증·응답 진단은 출력하지 않습니다.");
  }
}

export async function reviewRecoveryCandidate(config, options = {}) {
  return (await inspectRecoveryCandidate(config, options)).preview;
}
