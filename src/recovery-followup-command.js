import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./io.js";
import { createAppleMusicWriteAdapter } from "./apple-write-adapter.js";
import { ITunesSearchClient } from "./apple-api.js";
import { readMatchSelection } from "./match-decisions.js";
import { inspectRecoveryCandidate, candidateImplementationDigest } from "./recovery-candidate-review.js";
import { readFollowups, validateFollowups, followupPhase, projectFollowups } from "./recovery-followups.js";
import { recoveryInventory } from "./recovery-inventory.js";
import { validateActiveLinks } from "./existing-song-links.js";
import { recoveryDigest, recoveryError, validateRecoveryRemote } from "./song-recoveries.js";
import { acquireDataLocks, acquireApplyLock, playlistTarget, releaseDataLocks, dataSnapshot, assertDataSnapshot } from "./apply-lock.js";

// Parent journal is part of the immutable base; only the separate followup journal may change.
const BASE = ["melonLikes", "matched", "unmatched", "manualMatches", "unavailableMatches", "matchDecisions", "existingSongLinks", "importState", "songRecoveries"];
function reader(raw) {
  const methods = ["validateSession", "getLibraryPlaylist", "getLibrarySong", "validateCatalogSongs", "resolveUrl"];
  return { backend: raw.backend, ...Object.fromEntries(methods.map(k => [k, (...args) => raw[k](...args)])), request: (url, init = {}) => {
    if ((init.method ?? "GET").toUpperCase() !== "GET") recoveryError("후속 검사에는 GET만 허용합니다.");
    return raw.request(url, { ...init, method: "GET" });
  } };
}

async function inspectAttempt(config, transaction, selection, state, adapter, client) {
  const p = transaction.payload, c = p.plan.candidate;
  if (await dataSnapshot(config, BASE) !== transaction.base_snapshot) recoveryError("후속 승인 이후 원래 운영 입력·부모 이력이 변경됐습니다.");
  if (await candidateImplementationDigest() !== p.implementation_sha256) recoveryError("후속 복구 구현이 변경됐습니다. 자동 재개하지 않습니다.");
  const parent = selection.recoveryDocument.transactions.find(t => t.id === p.plan.recovery_id);
  const inventory = await recoveryInventory(adapter, state.playlist_id, [...new Set([c.id, ...parent.payload.rows.map(r => r.new_catalog.id)])], client);
  if (recoveryDigest(inventory.catalog.find(r => r.id === c.id)) !== recoveryDigest(c)) recoveryError("승인한 후속 후보 metadata가 변경됐습니다.");
  if ((await adapter.validateCatalogSongs(parent.payload.rows.map(r => r.old_catalog.id))).length) recoveryError("원래ID 제공이 복원됐습니다. 다시 검토하세요.");
  const playlist = inventory.playlist.filter(r => r.catalog_id === c.id), library = inventory.library.filter(r => r.catalog_id === c.id);
  if (followupPhase(transaction) === "approved" && (playlist.length || library.length)) recoveryError("후속 시도 이력 전에 새 후보가 반영됐습니다. 자동으로 성공 처리하지 않습니다.");
  if (playlist.length > 1 || library.length > 1 || playlist.length !== library.length
    || (playlist.length && (playlist[0].id !== library[0].id
      || [...p.baseline_playlist, ...p.baseline_library].some(r => r.id === playlist[0].id)))
    || [...inventory.playlist, ...inventory.library].some(r => r.isrc === c.isrc && r.catalog_id !== c.id)) recoveryError("후속 후보의 중복·한쪽 반영·기존 resource 치환을 확인할 수 없습니다.");
  const strip = records => records.filter(r => r.catalog_id !== c.id);
  if (recoveryDigest(strip(inventory.playlist)) !== recoveryDigest(p.baseline_playlist)
    || recoveryDigest(strip(inventory.library)) !== recoveryDigest(p.baseline_library)) recoveryError("후속 대상 밖 원격 목록이 변경됐습니다. 원래 항목을 보존하고 중단합니다.");
  const tracks = strip(inventory.playlist).map(r => ({ id: r.id, catalog_id: r.catalog_id }));
  const proof = await validateRecoveryRemote(selection, adapter, tracks, state);
  await validateActiveLinks(selection, state, adapter, { playlist: { id: state.playlist_id, canEdit: true }, tracks, recoveryValidation: proof });
  if (await candidateImplementationDigest() !== p.implementation_sha256) recoveryError("후속 검사 중 구현이 변경됐습니다.");
  return { inventory, confirmed: playlist.length === 1, libraryId: library[0]?.id ?? null };
}

export async function recoverFollowup(config, options = {}) {
  if (config.storefront !== "kr" || options.backend !== "web-player" || Boolean(options.planFile) === Boolean(options.resume)
    || options.confirm) recoveryError("KR web-player와 --plan-file 또는 --resume 하나가 필요합니다.");
  if (options.execute ? !/^[a-f0-9]{64}$/.test(options.expectedPreview ?? "") : options.expectedPreview != null) recoveryError("후속 실행에는 새 미리보기의 --execute --expected-preview HASH가 필요합니다.");
  const locks = [];
  try {
    if (options.execute) locks.push(...await acquireDataLocks(config));
    const journal = await readFollowups(config), journalHash = recoveryDigest(journal);
    const pending = journal.transactions.find(t => followupPhase(t) !== "confirmed");
    if (options.resume ? pending?.id !== options.resume : Boolean(pending)) recoveryError("해당 미완료 후속 이력을 --resume으로 확인하세요. 확인된 이력은 다시 실행하지 않습니다.");
    const raw = options.writeAdapter ?? await createAppleMusicWriteAdapter(config, { backend: "web-player" });
    const adapter = reader(raw), client = options.lookupClient ?? new ITunesSearchClient({ storefront: "kr" });
    let selection, state, payload, inventory, confirmed = false, libraryId = null, base, snapshot;
    let candidateReview = null;
    if (pending) {
      selection = await readMatchSelection(config, { allowPendingRecovery: true });
      snapshot = selection.input_fingerprint; state = await readJson(config.files.importState); payload = pending.payload; base = pending.base_snapshot;
      ({ inventory, confirmed, libraryId } = await inspectAttempt(config, pending, selection, state, adapter, client));
    } else {
      const inspected = await inspectRecoveryCandidate(config, { backend: "web-player", planFile: options.planFile, writeAdapter: raw, lookupClient: client });
      ({ selection, state, inventory } = inspected); snapshot = selection.input_fingerprint; base = await dataSnapshot(config, BASE); candidateReview = inspected.preview;
      payload = { backend: "web-player", storefront: "kr", playlist_id: state.playlist_id, implementation_sha256: await candidateImplementationDigest(),
        plan: { ...inspected.plan, candidate: candidateReview.candidate }, plan_digest: inspected.planDigest,
        source: candidateReview.source, before: candidateReview.existing_approval, original_resource_id: candidateReview.original_resource_id,
        previous_candidate: candidateReview.previous_candidate, baseline_playlist: inventory.playlist, baseline_library: inventory.library,
        unknown_isrc: inventory.unknown_isrc };
    }
    if (options.execute) locks.push(await acquireApplyLock(playlistTarget(state.playlist_id), config.applyLockDir));
    const phase = pending ? followupPhase(pending) : "not_saved";
    const canPost = !pending || phase === "approved";
    const preview = { action: "recover-followup", followup_id: pending?.id ?? null, phase, backend: "web-player", playlist_id: state.playlist_id,
      candidate: payload.plan.candidate, parent: { recovery_id: payload.plan.recovery_id, payload_hash: payload.plan.parent_payload_hash, settlement_hash: payload.plan.parent_settlement_hash },
      original_resource_id: payload.original_resource_id, source: payload.source, existing_approval: payload.before, previous_candidate: payload.previous_candidate,
      reason: payload.plan.reason, limitations_requiring_acceptance: payload.plan.limitations, supplied_evidence: payload.plan.evidence,
      unknown_isrc: inventory.unknown_isrc, same_audio_master_verified: false, execution_supported: true, approval_required: true,
      preserved_library_additions: selection.recoveryDocument.transactions.find(t => t.id === payload.plan.recovery_id).settlement.library_additions ?? [],
      write_scope: { journal: "recovery_followups.json", append_only_events: true, candidate_playlist_posts: canPost && !confirmed ? 1 : 0,
        library_posts: 0, deletes: 0, parent_changes: 0, checkpoint_changes: 0 },
      remote_confirmed: confirmed, automatic_repost_allowed: false, execution_blocked: !canPost && !confirmed,
      counts: { playlist: inventory.playlist.length, library: inventory.library.length, confirmed_recoveries: selection.recoveries.sources.size,
        unresolved_recoveries: selection.recoveries.unresolved.length, active_links_checked: selection.links.active.length,
        candidate_playlist_occurrences: confirmed ? 1 : 0, candidate_library_occurrences: confirmed ? 1 : 0, other_known_same_isrc_hits: 0 },
      implementation_sha256: payload.implementation_sha256, saved: false, account_changed: false };
    const expected = recoveryDigest([snapshot, base, journalHash, payload, phase, inventory.digest, preview]);
    await assertDataSnapshot(config, snapshot);
    if (recoveryDigest(await readFollowups(config)) !== journalHash) recoveryError("후속 검사 중 이력이 변경됐습니다.");
    if (!options.execute) return { ...preview, preview_hash: expected };
    if (expected !== options.expectedPreview) recoveryError("후속 미리보기 이후 입력·후보·이력·원격 상태가 변경됐습니다.");
    if (!canPost && !confirmed) recoveryError("이미 시도한 후속 복구가 미확정입니다. GET 확인만 허용하며 다시 추가하지 않습니다.");
    // Re-inspect immediately before approval persistence or any POST, still under shared locks.
    if (pending) {
      const latest = await inspectAttempt(config, pending, selection, state, adapter, client);
      if (latest.inventory.digest !== inventory.digest) recoveryError("후속 실행 직전 원격 결과가 변경됐습니다.");
    } else {
      const latest = await inspectRecoveryCandidate(config, { backend: "web-player", planFile: options.planFile, writeAdapter: raw, lookupClient: client });
      if (latest.preview.preview_hash !== candidateReview.preview_hash) recoveryError("후속 실행 직전 계획·원격 결과가 변경됐습니다.");
    }
    await assertDataSnapshot(config, snapshot);
    let currentJournalHash = journalHash;
    let transaction = pending ?? { id: randomUUID(), created_at: new Date().toISOString(), base_snapshot: base,
      payload, payload_hash: recoveryDigest(payload), events: [{ type: "approved", at: new Date().toISOString(), preview_hash: expected }] };
    const save = async () => {
      transaction = { ...transaction, events_hash: recoveryDigest(transaction.events) };
      for (const lock of locks) await lock.assertOwned();
      if (await candidateImplementationDigest() !== payload.implementation_sha256) recoveryError("후속 저장 직전 구현이 변경됐습니다.");
      await assertDataSnapshot(config, base, BASE);
      if (recoveryDigest(await readFollowups(config)) !== currentJournalHash) recoveryError("후속 이력이 동시에 변경됐습니다.");
      const next = { schema_version: 1, transactions: pending || currentJournalHash !== journalHash
        ? [...journal.transactions.filter(t => t.id !== transaction.id), transaction] : [...journal.transactions, transaction] };
      validateFollowups(next); projectFollowups(selection.originalRecoveries, selection.recoveryDocument, next, state, true);
      if (Buffer.byteLength(JSON.stringify(next, null, 2)) > 8 * 1024 * 1024) recoveryError("후속 이력이 너무 큽니다.");
      await writeJsonAtomic(config.files.recoveryFollowups, next); currentJournalHash = recoveryDigest(next);
    };
    if (!pending) await save();
    let accountChanged = false;
    if (!confirmed) {
      // Persist BEFORE POST. An attempted record can only be reconciled by GET, never reposted.
      const event = { type: "attempted", at: new Date().toISOString(), previous_hash: recoveryDigest(transaction.events.at(-1)) };
      transaction = { ...transaction, events: [...transaction.events, event] }; await save();
      try {
        for (const lock of locks) await lock.assertOwned();
        await assertDataSnapshot(config, base, BASE);
        if (recoveryDigest(await readFollowups(config)) !== currentJournalHash || await candidateImplementationDigest() !== payload.implementation_sha256) recoveryError("후속 POST 직전 이력·구현이 변경됐습니다.");
        const result = await raw.addTracks(state.playlist_id, [payload.plan.candidate.id]); accountChanged = result?.added !== 0;
      }
      catch { recoveryError(`후속 쓰기 결과 미확정. ${transaction.id}를 --resume으로 GET 확인하세요. 재추가하지 않습니다.`); }
      const latest = await inspectAttempt(config, transaction, selection, state, adapter, client);
      if (!latest.confirmed) recoveryError(`후속 서버·보관함 미확인. ${transaction.id}를 GET으로 확인하세요. 재추가하지 않습니다.`);
      inventory = latest.inventory; libraryId = latest.libraryId;
    }
    const event = { type: "confirmed", at: new Date().toISOString(), previous_hash: recoveryDigest(transaction.events.at(-1)), remote_snapshot: inventory.digest, library_song_id: libraryId };
    transaction = { ...transaction, events: [...transaction.events, event] }; await save();
    return { ...preview, followup_id: transaction.id, phase: "confirmed", saved: true, account_changed: accountChanged, remote_confirmed: true };
  } catch (error) {
    if (error.message?.startsWith("곡 복구:")) throw error;
    throw new Error("곡 복구: 후속 복구를 완료하지 못했습니다. 이력을 보존했으며 인증·응답 진단은 출력하지 않습니다.");
  } finally { await releaseDataLocks(locks); }
}
