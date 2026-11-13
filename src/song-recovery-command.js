import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ITunesSearchClient } from "./apple-api.js";
import { createAppleMusicWriteAdapter } from "./apple-write-adapter.js";
import { readJson, writeJsonAtomic } from "./io.js";
import { readMatchSelection } from "./match-decisions.js";
import { acquireDataLocks, releaseDataLocks, acquireApplyLock, playlistTarget, dataSnapshot, assertDataSnapshot } from "./apply-lock.js";
import { readRecoveryJournal, recoveryDigest, recoveryError, validateRecoveryRows, recoveryIsClosed, validateRecoveryLibraryAdditions } from "./song-recoveries.js";
import { recoveryInventory } from "./recovery-inventory.js";

export const RECOVERY_BASE = ["melonLikes", "matched", "unmatched", "manualMatches", "unavailableMatches", "matchDecisions", "existingSongLinks", "importState"];
const BASE = RECOVERY_BASE;
async function implementationDigest() {
  const names = ["song-recovery-command.js", "song-recoveries.js", "recovery-inventory.js", "match-decisions.js", "apply-lock.js",
    "pipeline.js", "apple-write-api.js", "apple-write-adapter.js", "apple-api.js", "io.js", "config.js"];
  return recoveryDigest(await Promise.all(names.map(async name => [name, await readFile(new URL(name, import.meta.url), "utf8")])));
}
async function planFile(config, file) {
  const name = path.resolve(config.root, file);
  if ((await stat(name)).size > 1024 * 1024) recoveryError("계획 파일이 너무 큽니다.");
  let plan;
  try { plan = JSON.parse(await readFile(name, "utf8")); } catch { recoveryError("계획 JSON을 확인하세요."); }
  if (plan?.schema_version !== 1 || Object.keys(plan).some(k => !["schema_version", "rows"].includes(k))) recoveryError("계획 schema를 확인하세요.");
  validateRecoveryRows(plan.rows);
  return plan;
}
export function matchRecoveryInventory(payload, inventory, selection, state, resume, libraryAdditions = []) {
  validateRecoveryLibraryAdditions(libraryAdditions, payload);
  const rows = payload.rows, newIds = new Set(rows.map(r => r.new_apple_music_song_id));
  const expectedMissing = new Set(rows.map(r => r.old_catalog.id));
  const present = new Set(inventory.playlist.map(r => r.catalog_id).filter(Boolean));
  const required = selection.recoveries.required;
  const missing = [...required].filter(id => !present.has(id));
  if (missing.length !== expectedMissing.size || missing.some(id => !expectedMissing.has(id))) recoveryError("계획 밖 checkpoint 연결 누락 또는 옛ID 복원이 있습니다.");
  if ([...present].some(id => !selection.recoveries.history.has(id) && !(resume && newIds.has(id)))) recoveryError("예상 밖 playlist ID가 있습니다.");
  for (const r of rows) {
    const c = inventory.catalog.find(c => c.id === r.new_apple_music_song_id);
    if (c.isrc !== r.old_catalog.isrc || c.duration_ms !== r.old_catalog.duration_ms
      || c.duration_ms !== r.before.apple_music_duration_ms || (r.new_catalog && recoveryDigest(c) !== recoveryDigest(r.new_catalog))) recoveryError("후보 ISRC·길이·메타데이터가 변경됐습니다.");
    for (const records of [inventory.playlist, inventory.library]) {
      const old = records.filter(x => x.id === r.library_song_id);
      if (old.length !== 1 || old[0].catalog_id) recoveryError("자기 기존 resource가 없거나 다시 연결됐습니다.");
      const hits = records.filter(x => x.catalog_id === c.id || x.isrc === c.isrc);
      if ((!resume && hits.length) || hits.length > 1 || hits.some(x => x.catalog_id !== c.id)) recoveryError("새ID 또는 같은 ISRC가 중복됩니다.");
    }
    if (!state.added_song_ids.includes(r.old_catalog.id)) recoveryError("옛ID가 원래 checkpoint에 없습니다.");
  }
  if (resume) {
    const stripNew = records => records.filter(r => !newIds.has(r.catalog_id));
    const additionIds = new Set(libraryAdditions.map(r => r.id));
    if (recoveryDigest(inventory.library.filter(r => additionIds.has(r.id))) !== recoveryDigest(libraryAdditions)) recoveryError("검토한 보관함 추가분과 실제 목록이 다릅니다.");
    if (recoveryDigest(stripNew(inventory.playlist)) !== recoveryDigest(payload.baseline_playlist)
      || recoveryDigest(stripNew(inventory.library).filter(r => !additionIds.has(r.id))) !== recoveryDigest(payload.baseline_library)) recoveryError("준비 이후 대상 외 원격 목록이 변경됐습니다.");
  }
}
export async function recoverSongs(config, options = {}) {
  if (config.storefront !== "kr" || options.backend !== "web-player") recoveryError("--backend web-player와 KR 설정이 필요합니다.");
  if (Boolean(options.planFile) === Boolean(options.resume)) recoveryError("--plan-file 또는 --resume 중 하나만 지정하세요.");
  if (options.execute && !/^[a-f0-9]{64}$/.test(options.expectedPreview ?? "")) recoveryError("무쓰기 미리보기 후 --execute --expected-preview HASH가 필요합니다.");
  if (!options.execute && options.expectedPreview != null) recoveryError("HASH는 --execute와 함께 사용하세요.");
  const locks = [];
  try {
    if (options.execute) locks.push(...await acquireDataLocks(config));
    const journal = await readRecoveryJournal(config), pending = journal.transactions.find(t => !recoveryIsClosed(t));
    const implementation = await implementationDigest();
    if (options.resume && pending?.id !== options.resume) recoveryError("해당 미완료 복구 이력이 없습니다.");
    if (pending && !options.resume) recoveryError(`미완료 복구 ${pending.id}를 먼저 --resume으로 확인하세요.`);
    const selection = await readMatchSelection(config, { allowPendingRecovery: Boolean(options.resume) });
    const snapshot = selection.input_fingerprint, base = await dataSnapshot(config, BASE);
    const state = await readJson(config.files.importState);
    if (!state?.playlist_id || state.backend !== "web-player" || state.storefront !== "kr") recoveryError("기존 KR checkpoint가 필요합니다.");
    if (options.execute) locks.push(await acquireApplyLock(playlistTarget(state.playlist_id), config.applyLockDir));
    const adapter = options.writeAdapter ?? await createAppleMusicWriteAdapter(config, { backend: "web-player" });
    const client = options.lookupClient ?? new ITunesSearchClient({ storefront: "kr" });
    let payload;
    if (pending) {
      if (base !== pending.base_snapshot || state.playlist_id !== pending.payload.playlist_id) recoveryError("미완료 복구의 운영 입력이 변경됐습니다.");
      if (implementation !== pending.payload.implementation_sha256) recoveryError("미완료 복구의 구현 버전이 변경됐습니다. 이력을 보존하고 검토하세요.");
      payload = pending.payload;
    } else {
      const plan = await planFile(config, options.planFile), rows = [];
      for (const r of plan.rows) {
        const source = selection.sourceDocument?.songs?.find(s => s.melon_song_id === r.melon_song_id), before = selection.effective.get(r.melon_song_id);
        if (!source || !before || !["matched", "manual_confirmed"].includes(before.match_status)
          || before.apple_music_song_id !== r.old_catalog.id || before.apple_music_duration_ms !== r.old_catalog.duration_ms
          || (before.apple_music_isrc && before.apple_music_isrc !== r.old_catalog.isrc)
          || selection.recoveries.protectedSources.has(r.melon_song_id)
          || selection.linksDocument.events.some(e => e.melon_song_id === r.melon_song_id || e.anchor_melon_song_id === r.melon_song_id)
          || selection.selected.some(s => s.apple_music_song_id === r.new_apple_music_song_id || s.melon_song_id !== r.melon_song_id && s.apple_music_isrc === r.old_catalog.isrc)
          || selection.recoveries.history.has(r.new_apple_music_song_id)) recoveryError("원곡·기존 승인·연결·보류 또는 로컬 중복을 확인하세요.");
        rows.push({ ...r, source, before });
      }
      payload = { backend: "web-player", storefront: "kr", playlist_id: state.playlist_id, implementation_sha256: implementation, rows };
    }
    const inventory = await recoveryInventory(adapter, state.playlist_id, payload.rows.map(r => r.new_apple_music_song_id), client);
    const old = await adapter.validateCatalogSongs(payload.rows.map(r => r.old_catalog.id));
    if (old.length) recoveryError("옛ID의 한국 제공이 복원됐습니다. 새 승인을 검토하세요.");
    matchRecoveryInventory(payload, inventory, selection, state, Boolean(pending));
    if (!pending) payload = { ...payload, rows: payload.rows.map(r => ({ ...r, new_catalog: inventory.catalog.find(c => c.id === r.new_apple_music_song_id) })),
      baseline_playlist: inventory.playlist, baseline_library: inventory.library };
    const remaining = payload.rows.filter(r => !inventory.playlist.some(t => t.catalog_id === r.new_apple_music_song_id)).map(r => r.new_apple_music_song_id);
    const preview = { action: pending ? "resume-recovery" : "recover", recovery_id: pending?.id ?? null, backend: "web-player", playlist_id: state.playlist_id,
      implementation_sha256: implementation,
      rows: payload.rows, remaining_new_ids: remaining, unknown_isrc: inventory.unknown_isrc, same_audio_master_verified: false,
      counts: { playlist: inventory.playlist.length, library: inventory.library.length, append: remaining.length,
        historical_checkpoint: selection.recoveries.history.size, active_selection: new Set(selection.selected.map(s => s.apple_music_song_id)).size },
      saved: false, account_changed: false };
    const expected = recoveryDigest([payload, base, snapshot, pending?.phase ?? null, inventory.digest, preview]);
    await assertDataSnapshot(config, snapshot);
    // Re-read the plan so concurrent file replacement cannot reuse a displayed approval.
    if (!pending && recoveryDigest((await planFile(config, options.planFile)).rows) !== recoveryDigest(payload.rows.map(({ source, before, new_catalog, ...r }) => r))) recoveryError("검사 중 계획 파일이 변경됐습니다.");
    if (!options.execute) return { ...preview, preview_hash: expected };
    if (expected !== options.expectedPreview) recoveryError("미리보기 이후 입력·후보·원격 상태가 변경됐습니다.");
    const assertOwned = async () => { for (const lock of locks) await lock.assertOwned(); };
    let transaction = pending ?? { id: randomUUID(), phase: "prepared", created_at: new Date().toISOString(), base_snapshot: base, payload, payload_hash: recoveryDigest(payload) };
    let journalHash = recoveryDigest(journal);
    const save = async () => { await assertOwned(); await assertDataSnapshot(config, base, BASE);
      if (recoveryDigest(await readRecoveryJournal(config)) !== journalHash) recoveryError("복구 이력이 동시에 변경됐습니다.");
      const next = { schema_version: 1, transactions: pending ? journal.transactions.map(t => t.id === pending.id ? transaction : t) : [...journal.transactions, transaction] };
      await writeJsonAtomic(config.files.songRecoveries, next); journalHash = recoveryDigest(next); };
    if (!pending) await save();
    if (pending?.phase === "remote_confirmed" && remaining.length) recoveryError("서버 확인 후 대상이 누락됐습니다. 자동 재추가하지 않습니다.");
    if (remaining.length) {
      try { await assertOwned(); await adapter.addTracks(state.playlist_id, remaining); }
      catch { recoveryError(`쓰기 결과 미확정. ${transaction.id}를 --resume으로 GET 확인하세요. 자동 재시도하지 않습니다.`); }
    }
    const after = await recoveryInventory(adapter, state.playlist_id, payload.rows.map(r => r.new_apple_music_song_id), client);
    matchRecoveryInventory(payload, after, selection, state, true);
    if (payload.rows.some(r => after.playlist.filter(x => x.catalog_id === r.new_apple_music_song_id).length !== 1
      || after.library.filter(x => x.catalog_id === r.new_apple_music_song_id).length !== 1)) recoveryError(`서버·보관함 미확인. ${transaction.id}를 --resume으로 확인하세요.`);
    transaction = { ...transaction, phase: "remote_confirmed", remote_confirmed_at: new Date().toISOString(), remote_snapshot: after.digest }; await save();
    transaction = { ...transaction, phase: "committed", committed_at: new Date().toISOString() }; await save();
    return { ...preview, recovery_id: transaction.id, saved: true, account_changed: remaining.length > 0, phase: "committed" };
  } catch (error) {
    if (error.message?.startsWith("곡 복구:")) throw error;
    throw new Error("곡 복구: 읽기/실행을 완료하지 못했습니다. 이력을 보존했으며 인증·응답 진단은 출력하지 않습니다.");
  } finally { await releaseDataLocks(locks); }
}
