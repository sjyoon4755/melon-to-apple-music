import { readFile } from "node:fs/promises";
import { ITunesSearchClient } from "./apple-api.js";
import { createAppleMusicWriteAdapter } from "./apple-write-adapter.js";
import { readJson, writeJsonAtomic } from "./io.js";
import { readMatchSelection } from "./match-decisions.js";
import { acquireDataLocks, releaseDataLocks, acquireApplyLock, playlistTarget, dataSnapshot, assertDataSnapshot } from "./apply-lock.js";
import { readRecoveryJournal, validateRecoveryJournal, projectRecoveries, recoveryDigest, recoveryError, recoveryLibraryAdditions } from "./song-recoveries.js";
import { matchRecoveryInventory, RECOVERY_BASE } from "./song-recovery-command.js";
import { recoveryInventory } from "./recovery-inventory.js";

async function implementationDigest() {
  const names = ["song-recovery-settlement.js", "song-recovery-command.js", "song-recoveries.js", "recovery-inventory.js",
    "match-decisions.js", "apply-lock.js", "pipeline.js", "apple-write-api.js", "apple-write-adapter.js", "apple-api.js", "io.js", "config.js"];
  return recoveryDigest(await Promise.all(names.map(async name => [name, await readFile(new URL(name, import.meta.url), "utf8")])));
}

// This command closes a partial attempt locally. It never calls account write methods.
export async function settleRecovery(config, options = {}) {
  if (config.storefront !== "kr" || options.backend !== "web-player") recoveryError("부분 결과 확인은 KR --backend web-player만 지원합니다.");
  if (!/^[a-f0-9-]{36}$/.test(options.recoveryId ?? "")) recoveryError("--recovery-id가 필요합니다.");
  const reason = String(options.reason ?? "").trim();
  if (!reason || reason.length > 2000) recoveryError("부분 결과를 확정하는 --reason이 필요합니다.");
  if (options.execute || (options.confirm ? !/^[a-f0-9]{64}$/.test(options.expectedPreview ?? "") : options.expectedPreview != null)) recoveryError("계정 실행은 지원하지 않습니다. 미리보기 후 --confirm --expected-preview HASH로 로컬 이력만 저장하세요.");
  const locks = [];
  try {
    if (options.confirm) locks.push(...await acquireDataLocks(config));
    const journal = await readRecoveryJournal(config), transaction = journal.transactions.find(t => t.id === options.recoveryId);
    // A fully remote-confirmed or closed transaction must never be downgraded.
    if (transaction?.phase !== "prepared") recoveryError("prepared 복구 이력만 부분 확인할 수 있습니다.");
    const selection = await readMatchSelection(config, { allowPendingRecovery: true });
    const snapshot = selection.input_fingerprint, base = await dataSnapshot(config, RECOVERY_BASE);
    const state = await readJson(config.files.importState), payload = transaction.payload;
    if (base !== transaction.base_snapshot || state?.playlist_id !== payload.playlist_id
      || state.backend !== "web-player" || state.storefront !== "kr") recoveryError("기존 승인·checkpoint 또는 운영 입력이 변경됐습니다.");
    if (options.confirm) locks.push(await acquireApplyLock(playlistTarget(state.playlist_id), config.applyLockDir));
    const implementation = await implementationDigest();
    const rawAdapter = options.writeAdapter ?? await createAppleMusicWriteAdapter(config, { backend: "web-player" });
    const adapter = { backend: rawAdapter.backend, ...Object.fromEntries(["validateSession", "getLibraryPlaylist", "validateCatalogSongs", "resolveUrl"]
      .map(name => [name, (...args) => rawAdapter[name](...args)])), request: (url, init = {}) => {
      if ((init.method ?? "GET").toUpperCase() !== "GET") recoveryError("부분 결과 확인은 GET만 허용합니다.");
      return rawAdapter.request(url, { ...init, method: "GET" });
    } };
    const client = options.lookupClient ?? new ITunesSearchClient({ storefront: "kr" });
    const inspect = async () => {
      const inventory = await recoveryInventory(adapter, state.playlist_id, payload.rows.map(r => r.new_apple_music_song_id), client);
      if ((await adapter.validateCatalogSongs(payload.rows.map(r => r.old_catalog.id))).length) recoveryError("옛ID의 한국 제공이 복원됐습니다. 다시 검토하세요.");
      const libraryAdditions = recoveryLibraryAdditions(payload, inventory);
      matchRecoveryInventory(payload, inventory, selection, state, true, libraryAdditions);
      const outcomes = payload.rows.map(r => {
        const playlist = inventory.playlist.filter(x => x.catalog_id === r.new_apple_music_song_id);
        const library = inventory.library.filter(x => x.catalog_id === r.new_apple_music_song_id);
        if (playlist.length !== library.length || (playlist.length && playlist[0].id !== library[0].id)) recoveryError("새ID의 서버·보관함 결과가 불일치합니다.");
        return { melon_song_id: r.melon_song_id, new_apple_music_song_id: r.new_apple_music_song_id,
          status: playlist.length ? "confirmed" : "unresolved", library_song_id: library[0]?.id ?? null };
      });
      if (!outcomes.some(r => r.status === "confirmed") || !outcomes.some(r => r.status === "unresolved")) recoveryError("성공·미해결이 함께 있는 부분 결과만 지원합니다.");
      return { inventory, outcomes, libraryAdditions };
    };
    const { inventory, outcomes, libraryAdditions } = await inspect();
    const preview = { action: "settle-partial-recovery", recovery_id: transaction.id, backend: "web-player", playlist_id: state.playlist_id,
      original_payload_hash: transaction.payload_hash, original_implementation_sha256: payload.implementation_sha256,
      implementation_sha256: implementation, reason, outcomes, library_additions: libraryAdditions,
      rows: payload.rows.map((r, i) => ({ ...r, outcome: outcomes[i] })), unknown_isrc: inventory.unknown_isrc,
      counts: { confirmed: outcomes.filter(r => r.status === "confirmed").length, unresolved: outcomes.filter(r => r.status === "unresolved").length,
        playlist: inventory.playlist.length, library: inventory.library.length, library_additions: libraryAdditions.length },
      phase_after_confirmation: "settled", whole_recovery_complete: false, execution_blocked: true, saved: false, account_changed: false };
    const expected = recoveryDigest([snapshot, base, inventory.digest, preview]);
    await assertDataSnapshot(config, snapshot);
    if (!options.confirm) return { ...preview, preview_hash: expected };
    if (expected !== options.expectedPreview) recoveryError("미리보기 이후 운영 입력·사유·구현·원격 결과가 변경됐습니다.");
    // Repeat GET verification immediately before the only write: the local journal.
    const latest = await inspect();
    if (latest.inventory.digest !== inventory.digest) recoveryError("저장 직전 원격 결과가 변경됐습니다.");
    for (const lock of locks) await lock.assertOwned();
    await assertDataSnapshot(config, snapshot);
    const settlement = { previous_phase: transaction.phase, confirmed_at: new Date().toISOString(), reason,
      implementation_sha256: implementation, payload_hash: transaction.payload_hash, input_snapshot: snapshot,
      remote_snapshot: inventory.digest, outcomes, library_additions: libraryAdditions };
    const next = { ...journal, transactions: journal.transactions.map(t => t.id === transaction.id ? {
      ...t, phase: "settled", settlement, settlement_hash: recoveryDigest(settlement) } : t) };
    validateRecoveryJournal(next);
    projectRecoveries(selection.links.effective, selection.sourceDocument, selection.linksDocument, state, next);
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") > 8 * 1024 * 1024) recoveryError("복구 이력이 너무 큽니다.");
    await writeJsonAtomic(config.files.songRecoveries, next);
    return { ...preview, saved: true, phase: "settled" };
  } catch (error) {
    if (error.message?.startsWith("곡 복구:")) throw error;
    throw new Error("곡 복구: 부분 결과 확인을 완료하지 못했습니다. 이력을 보존했으며 인증·응답 진단은 출력하지 않습니다.");
  } finally { await releaseDataLocks(locks); }
}
