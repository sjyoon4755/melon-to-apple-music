import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { recoverSongs } from "../src/song-recovery-command.js";
import { readMatchSelection } from "../src/match-decisions.js";
import { readRecoveryJournal, recoveryDigest, validateRecoveryJournal, validateRecoveryRemote } from "../src/song-recoveries.js";
import { verifyExistingTarget } from "../src/existing-song-links.js";
import { settleRecovery } from "../src/song-recovery-settlement.js";
import { reviewRecoveryCandidate } from "../src/recovery-candidate-review.js";
import { recoverFollowup } from "../src/recovery-followup-command.js";
import { readFollowups, validateFollowups, followupPhase } from "../src/recovery-followups.js";
import { applyPlaylist, localStatus, resolveManualMatch, reviewResults, linkExisting } from "../src/pipeline.js";
import { dataSnapshot, acquireDataLocks, releaseDataLocks } from "../src/apply-lock.js";
import { parseArgs } from "../src/cli-options.js";

async function fixture(t, count = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root }); config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  const sources = [], records = [], rows = [], catalog = [], oldResources = [];
  for (let i = 0; i < count; i++) {
    const source = { melon_song_id: String(100 + i), title: "Song " + i, artist: "Artist", album: "Album", duration_ms: null };
    const id = String(900 + i), oldId = String(700 + i), isrc = "ABAAA" + String(i + 1).padStart(7, "0");
    const old = { id: oldId, title: source.title, artist: "Artist", album: "Album", isrc, duration_ms: 200000,
      content_rating: null, release_date: "2020-01-01", url: null };
    sources.push(source); records.push({ ...source, apple_music_song_id: oldId, apple_music_duration_ms: 200000, match_status: "matched" });
    rows.push({ melon_song_id: source.melon_song_id, old_catalog: old, new_apple_music_song_id: id,
      library_song_id: "i.old" + i, reason: "Reviewed ISRC and duration <b>", limitations: ["source recording unknown"] });
    catalog.push({ id, type: "songs", attributes: { name: source.title, artistName: "Artist", albumName: "Album",
      isrc, durationInMillis: 200000, releaseDate: "2020-01-01", playParams: { id, kind: "song" } } });
    oldResources.push({ id: "i.old" + i, type: "library-songs", attributes: { name: source.title, artistName: "Artist", albumName: "Album", durationInMillis: 200000 } });
  }
  const awake = { melon_song_id: "91000002", title: "Night Shift", duration_ms: 1466000, match_status: "ambiguous" };
  const held = { melon_song_id: "200", title: "held", match_status: "held" };
  await writeFile(config.files.melonLikes, JSON.stringify({ complete: true, songs: [...sources, awake, held], unavailable_songs: [{ melon_song_id: "300" }] }));
  await writeFile(config.files.matched, JSON.stringify({ songs: records }));
  await writeFile(config.files.unmatched, JSON.stringify({ songs: [awake, held] }));
  await writeFile(config.files.importState, JSON.stringify({ schema_version: 2, backend: "web-player", storefront: "kr", playlist_id: "p1", added_song_ids: rows.map(r => r.old_catalog.id) }));
  const plan = path.join(root, "plan.json"); await writeFile(plan, JSON.stringify({ schema_version: 1, rows }));
  const remote = { playlist: structuredClone(oldResources), library: structuredClone(oldResources), posts: 0, mode: "ok" };
  const adapter = { backend: "web-player", validateSession: async () => ({ storefront: "kr" }),
    getLibraryPlaylist: async () => ({ id: "p1", canEdit: true }), resolveUrl: p => new URL(p, "https://example.test"),
    validateCatalogSongs: async ids => structuredClone(catalog.filter(c => ids.includes(c.id))),
    getLibrarySong: async id => { const r = remote.library.find(r => r.id === id); return r ? { id, catalog_id: r.attributes.playParams?.catalogId ?? null } : null; },
    getPlaylistTracks: async () => remote.playlist.map(r => ({ id: r.id, catalog_id: r.attributes.playParams?.catalogId ?? null })),
    request: async (url, init) => {
      assert.equal(init.method, "GET"); const u = new URL(url, "https://example.test");
      if (u.pathname === "/v1/me/library/songs") return { data: structuredClone(remote.library), meta: { total: remote.library.length } };
      if (u.pathname.includes("/playlists/")) return { data: structuredClone(remote.playlist), meta: { total: remote.playlist.length } };
      return { data: structuredClone(catalog.filter(c => u.searchParams.get("ids").split(",").includes(c.id))) };
    },
    addTracks: async (_, ids) => {
      remote.posts++;
      const add = remote.mode === "partial" ? ids.slice(0, 1) : remote.mode === "partial-seven" ? ids.slice(0, -1) : ids;
      if (remote.mode !== "timeout-before") for (const id of add) {
        const c = catalog.find(c => c.id === id);
        const r = { id: "i.new" + id, type: "library-songs", attributes: { ...c.attributes, playParams: { id: "i.new" + id, catalogId: id } } };
        remote.playlist.push(structuredClone(r)); remote.library.push(structuredClone(r));
      }
      if (remote.mode !== "ok") throw Error("network uncertainty");
    } };
  const lookupClient = { lookupSongs: async ids => catalog.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, duration_ms: c.attributes.durationInMillis })) };
  const options = { backend: "web-player", planFile: plan, writeAdapter: adapter, lookupClient };
  return { config, rows, catalog, remote, adapter, options, lookupClient, plan };
}
const preview = f => recoverSongs(f.config, f.options);
async function execute(f) { const p = await preview(f); return recoverSongs(f.config, { ...f.options, execute: true, expectedPreview: p.preview_hash }); }

test("recovery preview writes nothing and keeps original decisions, held tracks and checkpoint", async t => {
  const f = await fixture(t); const before = await dataSnapshot(f.config);
  const p = await preview(f); assert.equal(p.saved, false); assert.equal(p.account_changed, false); assert.equal(p.rows.length, 1);
  assert.equal(p.unknown_isrc.length, 1); assert.equal(await dataSnapshot(f.config), before); assert.equal(f.remote.posts, 0);
  const s = await readMatchSelection(f.config); assert.equal(s.effective.get("91000002").duration_ms, 1466000); assert.equal(s.effective.get("200").match_status, "held");
  await assert.rejects(recoverSongs(f.config, { ...f.options, execute: true }), /미리보기/);
});
test("committed recovery projects a current ID while retaining original approvals and raw checkpoint bytes", async t => {
  const f = await fixture(t); const files = [f.config.files.melonLikes, f.config.files.matched, f.config.files.unmatched, f.config.files.importState];
  const before = await Promise.all(files.map(p => readFile(p, "utf8")));
  const result = await execute(f); assert.equal(result.phase, "committed"); assert.equal(f.remote.posts, 1);
  assert.deepEqual(await Promise.all(files.map(p => readFile(p, "utf8"))), before);
  const s = await readMatchSelection(f.config); assert.equal(s.selected[0].apple_music_song_id, "900"); assert.equal(s.recoveries.history.size, 2); assert.deepEqual([...s.recoveries.required], ["900"]);
  const status = await localStatus(f.config); assert.equal(status.apply.pending, 0); assert.equal(status.apply.checkpoint_raw_total_unique, 1); assert.equal(status.apply.checkpoint_total_unique, 2);
  const checked = await applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter }); assert.equal(checked.pending_verified, 0);
  await reviewResults(f.config); const html = await readFile(f.config.files.reviewHtml, "utf8"); assert(html.includes("복구 이력")); assert(html.includes("&lt;b&gt;"));
  await assert.rejects(resolveManualMatch(f.config, { melonSongId: "100", appleSongId: "901" }), /복구 이력/);
  await assert.rejects(execute(f), /기존 승인|로컬 중복/); assert.equal(f.remote.posts, 1);
});
test("changed plan, catalog, checkpoint, and remote inventory invalidate prior preview", async t => {
  const f = await fixture(t); const p = await preview(f);
  f.catalog[0].attributes.releaseDate = "2020-01-02";
  await assert.rejects(recoverSongs(f.config, { ...f.options, execute: true, expectedPreview: p.preview_hash }), /미리보기 이후/);
  assert.equal(f.remote.posts, 0); assert.equal((await readRecoveryJournal(f.config)).transactions.length, 0);
  f.catalog[0].attributes.durationInMillis = 200001; await assert.rejects(preview(f), /lookup|ISRC·길이/);
});
test("unexpected checkpoint gap, other-ID ISRC collision and held source block before any write", async t => {
  const f = await fixture(t);
  const state = JSON.parse(await readFile(f.config.files.importState)); state.added_song_ids.push("999"); await writeFile(f.config.files.importState, JSON.stringify(state));
  await assert.rejects(preview(f), /계획 밖/); state.added_song_ids.pop(); await writeFile(f.config.files.importState, JSON.stringify(state));
  f.remote.library.push({ id: "i.other", type: "library-songs", attributes: { name: "other", isrc: f.rows[0].old_catalog.isrc } });
  await assert.rejects(preview(f), /중복/); f.remote.library.pop();
  const plan = { schema_version: 1, rows: [{ ...f.rows[0], melon_song_id: "200" }] }; await writeFile(f.plan, JSON.stringify(plan));
  await assert.rejects(preview(f), /보류|기존 승인/); assert.equal(f.remote.posts, 0);
});
test("ambiguous successful POST leaves a prepared journal; GET resume commits without a second POST", async t => {
  const f = await fixture(t); f.remote.mode = "timeout-after";
  await assert.rejects(execute(f), /미확정/); assert.equal(f.remote.posts, 1);
  const tx = (await readRecoveryJournal(f.config)).transactions[0]; assert.equal(tx.phase, "prepared");
  await assert.rejects(localStatus(f.config), /미완료 이력/);
  const opts = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  const p = await recoverSongs(f.config, opts); assert.deepEqual(p.remaining_new_ids, []); assert.equal(f.remote.posts, 1);
  await recoverSongs(f.config, { ...opts, execute: true, expectedPreview: p.preview_hash }); assert.equal(f.remote.posts, 1);
  assert.equal((await readMatchSelection(f.config)).selected[0].apple_music_song_id, "900");
});
test("partial POST resumes only proven absent IDs and never rewrites original checkpoint", async t => {
  const f = await fixture(t, 2); const before = await readFile(f.config.files.importState, "utf8"); f.remote.mode = "partial";
  await assert.rejects(execute(f), /미확정/);
  const tx = (await readRecoveryJournal(f.config)).transactions[0], opts = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  const p = await recoverSongs(f.config, opts); assert.deepEqual(p.remaining_new_ids, ["901"]); f.remote.mode = "ok";
  await recoverSongs(f.config, { ...opts, execute: true, expectedPreview: p.preview_hash }); assert.equal(f.remote.posts, 2);
  assert.equal(await readFile(f.config.files.importState, "utf8"), before); assert.equal(f.remote.playlist.length, 4);
});
test("pending input drift and unrelated remote changes stop resume; corrupted journals stop readers", async t => {
  const f = await fixture(t); f.remote.mode = "timeout-before"; await assert.rejects(execute(f), /미확정/);
  const tx = (await readRecoveryJournal(f.config)).transactions[0], opts = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  f.remote.library[0].attributes.name = "changed"; await assert.rejects(recoverSongs(f.config, opts), /対象外|대상 외/); assert.equal(f.remote.posts, 1);
  const journal = await readRecoveryJournal(f.config); journal.transactions[0].payload.rows[0].reason = "tamper";
  await writeFile(f.config.files.songRecoveries, JSON.stringify(journal)); await assert.rejects(readMatchSelection(f.config), /손상/);
});
test("stale committed source and changed remote target stop generic readers and apply", async t => {
  const f = await fixture(t); await execute(f);
  f.catalog[0].attributes.releaseDate = "2020-01-02";
  await assert.rejects(applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter }), /복구 후/);
  const source = JSON.parse(await readFile(f.config.files.melonLikes)); source.songs[0].title = "changed";
  await writeFile(f.config.files.melonLikes, JSON.stringify(source)); await assert.rejects(readMatchSelection(f.config), /복구 원본/);
});
test("CLI recovery requires explicit mode and does not accept delete or ordinary confirmation flags", () => {
  assert.equal(parseArgs(["recover", "--backend", "web-player", "--plan-file", "plan.json"]).options.planFile, "plan.json");
  for (const flag of ["--confirm", "--delete", "--hold"]) assert.throws(() => parseArgs(["recover", flag]), /알 수 없는 옵션/);
});

test("existing data lock blocks recovery execution before reads or writes", async t => {
  const f = await fixture(t), p = await preview(f), locks = await acquireDataLocks(f.config);
  try { await assert.rejects(recoverSongs(f.config, { ...f.options, execute: true, expectedPreview: p.preview_hash }), /읽기\/실행/); }
  finally { await releaseDataLocks(locks); }
  assert.equal(f.remote.posts, 0); assert.equal((await readRecoveryJournal(f.config)).transactions.length, 0);
});

test("a remote-confirmed transaction never reposts a target that later disappears", async t => {
  const f = await fixture(t); f.remote.mode = "timeout-after"; await assert.rejects(execute(f), /미확정/);
  const journal = await readRecoveryJournal(f.config), tx = journal.transactions[0];
  tx.phase = "remote_confirmed"; tx.remote_confirmed_at = new Date().toISOString(); tx.remote_snapshot = "a".repeat(64);
  await writeFile(f.config.files.songRecoveries, JSON.stringify(journal));
  f.remote.playlist.pop(); f.remote.library.pop();
  const opts = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  const p = await recoverSongs(f.config, opts);
  await assert.rejects(recoverSongs(f.config, { ...opts, execute: true, expectedPreview: p.preview_hash }), /서버 확인 후/);
  assert.equal(f.remote.posts, 1);
});

test("plan and checkpoint drift invalidate approval, and raw remote diagnostics are redacted", async t => {
  const f = await fixture(t), p = await preview(f);
  const changed = { schema_version: 1, rows: [{ ...f.rows[0], reason: "changed reason" }] };
  await writeFile(f.plan, JSON.stringify(changed));
  await assert.rejects(recoverSongs(f.config, { ...f.options, execute: true, expectedPreview: p.preview_hash }), /미리보기 이후/);
  const state = JSON.parse(await readFile(f.config.files.importState)); state.extra = "changed";
  await writeFile(f.config.files.importState, JSON.stringify(state));
  await assert.rejects(recoverSongs(f.config, { ...f.options, execute: true, expectedPreview: p.preview_hash }), /미리보기 이후/);
  f.adapter.validateSession = async () => { throw Error("PRIVATE_REMOTE_BODY"); };
  await assert.rejects(preview(f), e => !e.message.includes("PRIVATE_REMOTE_BODY") && /진단/.test(e.message));
  assert.equal(f.remote.posts, 0);
});

async function partialFixture(t, count = 8) {
  const f = await fixture(t, count); f.remote.mode = "partial-seven";
  await assert.rejects(execute(f), /미확정/);
  const tx = (await readRecoveryJournal(f.config)).transactions[0];
  return { ...f, tx, settle: { backend: "web-player", recoveryId: tx.id, reason: "Confirm seven; keep Alarm unresolved <b>",
    writeAdapter: f.adapter, lookupClient: f.lookupClient } };
}
async function settle(f) {
  const p = await settleRecovery(f.config, f.settle);
  return settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: p.preview_hash });
}

test("partial settlement previews seven confirmed and one unresolved with no local or account writes", async t => {
  const f = await partialFixture(t), before = await dataSnapshot(f.config);
  const p = await settleRecovery(f.config, f.settle);
  assert.deepEqual(p.counts, { confirmed: 7, unresolved: 1, playlist: 15, library: 15, library_additions: 0 });
  assert.equal(p.saved, false); assert.equal(p.account_changed, false); assert.equal(p.whole_recovery_complete, false);
  assert.equal(p.outcomes[7].status, "unresolved"); assert.equal(p.outcomes[7].library_song_id, null);
  assert.equal(await dataSnapshot(f.config), before); assert.equal(f.remote.posts, 1);
  await assert.rejects(localStatus(f.config), /미완료 이력/);
});

test("settlement preserves original transaction payload, approval files, raw checkpoint, held and unresolved decisions", async t => {
  const f = await partialFixture(t), base = await dataSnapshot(f.config, ["melonLikes", "matched", "unmatched", "manualMatches", "unavailableMatches", "matchDecisions", "existingSongLinks", "importState"]);
  const before = await readMatchSelection(f.config, { allowPendingRecovery: true });
  const result = await settle(f); assert.equal(result.phase, "settled"); assert.equal(result.account_changed, false); assert.equal(f.remote.posts, 1);
  const tx = (await readRecoveryJournal(f.config)).transactions[0];
  const { settlement, settlement_hash, ...original } = tx;
  assert.deepEqual({ ...original, phase: settlement.previous_phase }, f.tx); assert.equal(settlement_hash, recoveryDigest(settlement));
  assert.equal(await dataSnapshot(f.config, ["melonLikes", "matched", "unmatched", "manualMatches", "unavailableMatches", "matchDecisions", "existingSongLinks", "importState"]), base);
  const s = await readMatchSelection(f.config);
  assert.equal(s.recoveries.sources.size, 7); assert.equal(s.recoveries.protectedSources.size, 8); assert.equal(s.recoveries.history.size, 15);
  for (const [id, record] of before.effective) {
    if (s.recoveries.sources.has(id)) assert.notEqual(s.effective.get(id).apple_music_song_id, record.apple_music_song_id);
    else assert.deepEqual(s.effective.get(id), record);
  }
  assert.deepEqual(s.effective.get("107"), before.effective.get("107"));
  assert.equal(s.effective.get("91000002").duration_ms, 1466000); assert.equal(s.effective.get("200").match_status, "held");
  await assert.rejects(resolveManualMatch(f.config, { melonSongId: "107", appleSongId: "907" }), /복구 이력/);
  await assert.rejects(settle(f), /prepared/);
});

test("settled status and read-only apply show unresolved recovery separately from zero local pending; execute stays blocked", async t => {
  const f = await partialFixture(t); await settle(f);
  const status = await localStatus(f.config);
  assert.equal(status.apply.pending, 0); assert.equal(status.apply.recovered_sources, 7);
  assert.equal(status.apply.unresolved_recoveries, 1); assert.equal(status.apply.execution_blocked, true);
  assert.match(status.summary, /미해결 복구 1곡/);
  const checked = await applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter });
  assert.equal(checked.pending_verified, 0); assert.equal(checked.recovery.confirmed, 7);
  assert.equal(checked.recovery.unresolved[0].melon_song_id, "107"); assert.equal(checked.recovery.execution_blocked, true);
  const dry = await applyPlaylist(f.config, { backend: "web-player" }); assert.equal(dry.recovery.unresolved.length, 1);
  await assert.rejects(applyPlaylist(f.config, { execute: true, backend: "web-player", writeAdapter: f.adapter }), /미해결 복구/);
  assert.equal(f.remote.posts, 1);
  const active = f.remote.library.pop();
  await assert.rejects(applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter }), /새 보관함/);
  f.remote.library.push(active);
  f.remote.playlist.push(structuredClone(f.remote.playlist[7]));
  await assert.rejects(applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter }), /미해결 복구/);
});

test("a new settlement implementation may reconcile an old prepared attempt without changing its original implementation evidence", async t => {
  const f = await partialFixture(t), journal = await readRecoveryJournal(f.config);
  journal.transactions[0].payload.implementation_sha256 = "a".repeat(64);
  journal.transactions[0].payload_hash = recoveryDigest(journal.transactions[0].payload);
  await writeFile(f.config.files.songRecoveries, JSON.stringify(journal));
  await settle(f);
  const tx = (await readRecoveryJournal(f.config)).transactions[0];
  assert.equal(tx.payload.implementation_sha256, "a".repeat(64)); assert.notEqual(tx.settlement.implementation_sha256, tx.payload.implementation_sha256);
});

test("duplicate old occurrence, one-sided presence, unrelated drift, and same-ISRC collision refuse settlement", async t => {
  const f = await partialFixture(t), journal = await readFile(f.config.files.songRecoveries, "utf8");
  const check = async pattern => { await assert.rejects(settleRecovery(f.config, f.settle), pattern); assert.equal(await readFile(f.config.files.songRecoveries, "utf8"), journal); };
  f.remote.playlist.push(structuredClone(f.remote.playlist[7])); await check(/resource 중복/); f.remote.playlist.pop();
  const newTrack = f.remote.library.pop(); await check(/불일치/); f.remote.library.push(newTrack);
  f.remote.library[0].attributes.name = "changed"; await check(/대상 외/); f.remote.library[0].attributes.name = "Song 0";
  f.remote.library.push({ id: "i.collision", attributes: { isrc: f.rows[7].old_catalog.isrc } }); await check(/중복|메타데이터/); f.remote.library.pop();
  assert.equal(f.remote.posts, 1);
});

test("changed reason, catalog, local input and remote state invalidate settlement approval", async t => {
  const f = await partialFixture(t), p = await settleRecovery(f.config, f.settle);
  const confirm = extra => settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: p.preview_hash, ...extra });
  await assert.rejects(confirm({ reason: "changed" }), /미리보기 이후/);
  f.catalog[7].attributes.releaseDate = "2020-01-02"; await assert.rejects(confirm(), /메타데이터/); f.catalog[7].attributes.releaseDate = "2020-01-01";
  const newResource = structuredClone(f.remote.playlist[8]); newResource.id = "i.changed";
  f.remote.playlist[8] = newResource; f.remote.library[8] = structuredClone(newResource);
  await assert.rejects(confirm(), /미리보기 이후/);
  const input = await readFile(f.config.files.matched, "utf8"); await writeFile(f.config.files.matched, input + "\n");
  await assert.rejects(confirm(), /운영 입력/); assert.equal((await readRecoveryJournal(f.config)).transactions[0].phase, "prepared"); assert.equal(f.remote.posts, 1);
});

test("a final GET drift, data lock, malformed outcomes and private remote errors fail closed", async t => {
  const f = await partialFixture(t), p = await settleRecovery(f.config, f.settle), request = f.adapter.request;
  let reads = 0;
  f.adapter.request = async (...args) => { if (new URL(args[0]).pathname.includes("/playlists/") && ++reads === 2) f.remote.library[0].attributes.name = "changed"; return request(...args); };
  await assert.rejects(settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: p.preview_hash }), /대상 외|저장 직전/);
  f.adapter.request = request; f.remote.library[0].attributes.name = "Song 0";
  const locks = await acquireDataLocks(f.config);
  try { await assert.rejects(settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: p.preview_hash }), /부분 결과 확인을 완료/); }
  finally { await releaseDataLocks(locks); }
  await settle(f); const journal = await readRecoveryJournal(f.config);
  journal.transactions[0].settlement.outcomes[0].status = "unresolved";
  journal.transactions[0].settlement_hash = recoveryDigest(journal.transactions[0].settlement);
  assert.throws(() => validateRecoveryJournal(journal), /곡별 결과/);
  f.adapter.validateSession = async () => { throw Error("PRIVATE_REMOTE_BODY"); };
  // Use a prepared copy so the transport is actually exercised.
  await writeFile(f.config.files.songRecoveries, JSON.stringify({ schema_version: 1, transactions: [f.tx] }));
  await assert.rejects(settleRecovery(f.config, f.settle), e => !e.message.includes("PRIVATE_REMOTE_BODY") && /진단/.test(e.message));
});

test("settlement cannot downgrade remote-confirmed or fully successful attempts and rejects account-write CLI flags", async t => {
  const f = await partialFixture(t), journal = await readRecoveryJournal(f.config);
  journal.transactions[0].phase = "remote_confirmed"; journal.transactions[0].remote_confirmed_at = new Date().toISOString(); journal.transactions[0].remote_snapshot = "a".repeat(64);
  await writeFile(f.config.files.songRecoveries, JSON.stringify(journal)); await assert.rejects(settleRecovery(f.config, f.settle), /prepared/);
  await writeFile(f.config.files.songRecoveries, JSON.stringify({ schema_version: 1, transactions: [f.tx] }));
  f.remote.mode = "ok"; await f.adapter.addTracks("p1", ["907"]);
  await assert.rejects(settleRecovery(f.config, f.settle), /부분 결과만/);
  for (const flag of ["--execute", "--delete", "--resume", "--plan-file"]) assert.throws(() => parseArgs(["settle-recovery", flag]), /알 수 없는 옵션/);
  assert.equal(parseArgs(["settle-recovery", "--confirm", "--recovery-id", f.tx.id]).options.confirm, true);
});

function outsideLibrarySong() {
  return { id: "i.outside", type: "library-songs", attributes: { name: "Mille Incendi (Bonus Track)", artistName: "Anthony Lazaro",
    albumName: "A Different Kind Of Love - Single", durationInMillis: 217700, isrc: "QZHNB2150446",
    playParams: { id: "i.outside", catalogId: "1572040665" } } };
}

test("a single outside library addition is explicitly previewed and preserved in the approved settlement, not the original payload", async t => {
  const f = await partialFixture(t), originalPayload = JSON.stringify(f.tx.payload), originalState = await readFile(f.config.files.importState, "utf8");
  f.remote.library.unshift(outsideLibrarySong());
  const remoteBefore = structuredClone(f.remote), before = await dataSnapshot(f.config);
  const p = await settleRecovery(f.config, f.settle);
  assert.equal(p.library_additions.length, 1); assert.equal(p.counts.library_additions, 1);
  assert.deepEqual(p.library_additions[0], { id: "i.outside", catalog_id: "1572040665", title: "Mille Incendi (Bonus Track)",
    artist: "Anthony Lazaro", album: "A Different Kind Of Love - Single", duration_ms: 217700, isrc: "QZHNB2150446" });
  assert.equal(p.counts.confirmed, 7); assert.equal(p.counts.unresolved, 1); assert.equal(p.saved, false);
  assert.equal(await dataSnapshot(f.config), before); assert.deepEqual(f.remote, remoteBefore);
  await settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: p.preview_hash });
  const tx = (await readRecoveryJournal(f.config)).transactions[0];
  assert.deepEqual(tx.settlement.library_additions, p.library_additions); assert.equal(JSON.stringify(tx.payload), originalPayload);
  assert.equal(tx.payload_hash, f.tx.payload_hash); assert.equal(tx.base_snapshot, f.tx.base_snapshot);
  assert.equal(await readFile(f.config.files.importState, "utf8"), originalState); assert.deepEqual(f.remote, remoteBefore);
  const s = await readMatchSelection(f.config); assert.equal(s.recoveries.sources.size, 7); assert.equal(s.recoveries.unresolved.length, 1);
  assert.equal(s.recoveries.history.has("1572040665"), false); assert(!s.selected.some(r => r.apple_music_song_id === "1572040665"));
  assert.equal(s.effective.get("107").apple_music_song_id, "707"); assert.equal(s.effective.get("200").match_status, "held");
  assert.equal(s.effective.get("91000002").duration_ms, 1466000);
});

test("addition metadata, identity, removal and an old no-addition preview cannot reuse approval", async t => {
  const f = await partialFixture(t), noAddition = await settleRecovery(f.config, f.settle);
  const addition = outsideLibrarySong(); f.remote.library.push(addition);
  await assert.rejects(settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: noAddition.preview_hash }), /미리보기 이후/);
  const p = await settleRecovery(f.config, f.settle), confirm = () => settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: p.preview_hash });
  addition.attributes.name = "changed title"; await assert.rejects(confirm(), /미리보기 이후/); addition.attributes.name = "Mille Incendi (Bonus Track)";
  addition.id = "i.changed"; await assert.rejects(confirm(), /미리보기 이후/); addition.id = "i.outside";
  f.remote.library.pop(); await assert.rejects(confirm(), /미리보기 이후/);
  assert.equal(f.remote.posts, 1); assert.equal((await readRecoveryJournal(f.config)).transactions[0].phase, "prepared");
});

test("multiple, unidentified, duplicate-ISRC additions and baseline replacement still refuse settlement", async t => {
  const f = await partialFixture(t), outside = outsideLibrarySong(); f.remote.library.push(outside);
  const check = async pattern => { await assert.rejects(settleRecovery(f.config, f.settle), pattern); assert.equal((await readRecoveryJournal(f.config)).transactions[0].phase, "prepared"); };
  const second = outsideLibrarySong(); second.id = "i.second"; f.remote.library.push(second); await check(/최대 1곡/); f.remote.library.pop();
  outside.attributes.isrc = null; await check(/ISRC/); outside.attributes.isrc = f.rows[7].old_catalog.isrc; await check(/중복/);
  outside.attributes.isrc = "QZHNB2150446";
  const original = f.remote.library.shift(); await check(/기존 resource/); f.remote.library.unshift(original);
  original.attributes.name = "changed baseline metadata"; await check(/대상 외/); original.attributes.name = "Song 0";
  f.remote.library.reverse(); await check(/대상 외/); f.remote.library.reverse();
  assert.equal(f.remote.posts, 1);
});

test("an addition in the playlist, and a library-only recovery candidate, cannot be hidden as unrelated library review", async t => {
  const f = await partialFixture(t), outside = outsideLibrarySong(); f.remote.library.push(outside); f.remote.playlist.push(structuredClone(outside));
  await assert.rejects(settleRecovery(f.config, f.settle), /예상 밖 playlist/); f.remote.playlist.pop();
  outside.attributes.playParams.catalogId = "907"; outside.attributes.isrc = f.rows[7].old_catalog.isrc;
  await assert.rejects(settleRecovery(f.config, f.settle), /불일치/); assert.equal(f.remote.posts, 1);
});

test("the final GET detects an addition changed after approval even if the first confirmation read matched", async t => {
  const f = await partialFixture(t); f.remote.library.push(outsideLibrarySong());
  const p = await settleRecovery(f.config, f.settle), request = f.adapter.request; let libraries = 0;
  f.adapter.request = async (...args) => {
    if (new URL(args[0], "https://example.test").pathname === "/v1/me/library/songs" && ++libraries === 2) f.remote.library.at(-1).attributes.name = "changed during final GET";
    return request(...args);
  };
  await assert.rejects(settleRecovery(f.config, { ...f.settle, confirm: true, expectedPreview: p.preview_hash }), /저장 직전/);
  assert.equal((await readRecoveryJournal(f.config)).transactions[0].phase, "prepared"); assert.equal(f.remote.posts, 1);
});

test("settlement addition evidence is integrity checked and cannot refer to original resources or recovery targets", async t => {
  const f = await partialFixture(t); f.remote.library.push(outsideLibrarySong()); await settle(f);
  const original = await readRecoveryJournal(f.config);
  for (const edit of [
    s => { s.library_additions[0].title = "tampered"; },
    s => { s.library_additions[0].id = "i.old0"; },
    s => { s.library_additions[0].catalog_id = "900"; },
    s => { s.library_additions[0].isrc = null; },
    s => { s.library_additions = null; }
  ]) {
    const changed = structuredClone(original); edit(changed.transactions[0].settlement);
    if (changed.transactions[0].settlement.library_additions?.[0]?.title !== "tampered") changed.transactions[0].settlement_hash = recoveryDigest(changed.transactions[0].settlement);
    assert.throws(() => validateRecoveryJournal(changed), /곡 복구/);
  }
  const legacy = structuredClone(original); delete legacy.transactions[0].settlement.library_additions;
  legacy.transactions[0].settlement_hash = recoveryDigest(legacy.transactions[0].settlement);
  assert.doesNotThrow(() => validateRecoveryJournal(legacy));
});

test("ordinary recover resume keeps strict baseline checks and never adopts a library addition", async t => {
  const f = await partialFixture(t); f.remote.library.push(outsideLibrarySong());
  await assert.rejects(recoverSongs(f.config, { backend: "web-player", resume: f.tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient }), /대상 외/);
  assert.equal(f.remote.posts, 1);
});

async function mixedRecoveryLinks(t, recoveryUrl) {
  const f = await fixture(t, 8), source = JSON.parse(await readFile(f.config.files.melonLikes)), matched = JSON.parse(await readFile(f.config.files.matched)), unmatched = JSON.parse(await readFile(f.config.files.unmatched)), state = JSON.parse(await readFile(f.config.files.importState));
  if (recoveryUrl) f.catalog[0].attributes.url = recoveryUrl;
  const anchor = { melon_song_id: "501", title: "Linked song", artist: "Artist", album: "Album", duration_ms: 200000, isrc: "ZZXYZ2600158" };
  source.songs.push(anchor, ...["502", "503"].map(id => ({ ...anchor, melon_song_id: id, duration_ms: null, isrc: null })));
  matched.songs.push({ ...anchor, apple_music_song_id: "9900", match_status: "matched" });
  unmatched.songs.push(...source.songs.filter(s => ["502", "503"].includes(s.melon_song_id)).map(s => ({ ...s, match_status: "ambiguous" })));
  state.added_song_ids.push("9900");
  for (const [file, value] of [[f.config.files.melonLikes, source], [f.config.files.matched, matched], [f.config.files.unmatched, unmatched], [f.config.files.importState, state]]) await writeFile(file, JSON.stringify(value));
  const catalog = { id: "9900", type: "songs", attributes: { name: anchor.title, artistName: anchor.artist, albumName: anchor.album,
    durationInMillis: 200000, isrc: anchor.isrc, contentRating: "not_explicit", releaseDate: "2020-01-01", playParams: { id: "9900" } } };
  f.catalog.push(catalog);
  const resource = { id: "i.anchor", type: "library-songs", attributes: { ...catalog.attributes, playParams: { id: "i.anchor", catalogId: "9900" } } };
  const originals = f.remote.playlist; f.remote.playlist = [structuredClone(resource)]; f.remote.library.push(structuredClone(resource));
  // Create historical links before the original resources become unavailable in the fixture playlist.
  for (const id of ["502", "503"]) {
    const evidenceFile = path.join(f.config.root, "evidence-" + id + ".json");
    await writeFile(evidenceFile, JSON.stringify({ schema_version: 1, melon_song_id: id, anchor_melon_song_id: "501", apple_music_song_id: "9900",
      identity_basis: "user_accepted_uncertainty", comparison: "Reviewed exact existing recording and accepted missing source metadata",
      references: ["docs/reviewed-recording.md"], accepted_uncertainties: ["source_isrc_unknown", "source_duration_unknown", "source_rating_unknown"] }));
    const options = { melonSongId: id, anchorMelonSongId: "501", appleSongId: "9900", backend: "web-player", evidenceFile,
      reason: "Historical approved existing link", readAdapter: f.adapter, lookupClient: f.lookupClient };
    const p = await linkExisting(f.config, options); await linkExisting(f.config, { ...options, confirm: true, expectedPreview: p.preview_hash });
  }
  f.remote.playlist = [...originals, structuredClone(resource)]; f.remote.mode = "partial-seven";
  await assert.rejects(execute(f), /미확정/); const tx = (await readRecoveryJournal(f.config)).transactions[0];
  f.settle = { backend: "web-player", recoveryId: tx.id, reason: "Confirm seven and retain unresolved Alarm", writeAdapter: f.adapter, lookupClient: f.lookupClient };
  await settle(f); return { ...f, state, selection: await readMatchSelection(f.config) };
}

test("apply check validates two existing links beside seven recovered tracks and one unresolved preserved original without writes", async t => {
  const f = await mixedRecoveryLinks(t), before = await dataSnapshot(f.config), remote = structuredClone(f.remote);
  const checked = await applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter });
  assert.equal(checked.linked_existing, 2); assert.equal(checked.linked_remote_validation.checked, true); assert.equal(checked.linked_remote_validation.results.length, 2);
  assert.equal(checked.recovery.confirmed, 7); assert.equal(checked.recovery.unresolved.length, 1); assert.equal(checked.recovery.execution_blocked, true); assert.equal(checked.pending_verified, 0);
  assert.equal(await dataSnapshot(f.config), before); assert.deepEqual(f.remote, remote);
  assert.equal((await localStatus(f.config)).matching.held, 1); assert.equal(f.selection.effective.get("91000002").duration_ms, 1466000);
});

test("apply check allows only an approved recovery title and URL pair without changing the historical projection", async t => {
  const beforeUrl = "https://music.apple.com/kr/album/song-old-credit/800?i=900";
  const afterUrl = "https://music.apple.com/kr/album/song-new-credit/800?i=900";
  const f = await mixedRecoveryLinks(t, beforeUrl);
  const parent = f.selection.recoveryDocument.transactions[0];
  const history = await readFile(f.config.files.songRecoveries, "utf8");
  const checkpoint = await readFile(f.config.files.importState, "utf8");
  const entry = { recovery_id: parent.id, payload_hash: parent.payload_hash, melon_song_id: "100", apple_music_song_id: "900",
    approved_at: "2026-11-11T00:00:00Z", before: { title: "Song 0", url: beforeUrl }, after: { title: "Song 0 (new credit)", url: afterUrl } };
  const save = approvals => writeFile(f.config.files.recoveryCatalogApprovals, JSON.stringify({ schema_version: 1, approvals }));
  const check = () => applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter });
  const attributes = f.catalog[0].attributes;
  Object.assign(attributes, { name: entry.after.title, url: entry.after.url });
  await assert.rejects(check, /복구 후 서버/);
  const withoutApproval = await dataSnapshot(f.config);
  await save([entry]);
  const withApproval = await dataSnapshot(f.config);
  assert.notEqual(withApproval, withoutApproval);
  const remote = structuredClone(f.remote);
  const checked = await check();
  assert.equal(checked.linked_remote_validation.checked, true);
  assert.equal(checked.recovery.confirmed, 7);
  assert.equal(checked.pending_verified, 0);
  assert.equal(await dataSnapshot(f.config), withApproval);
  assert.deepEqual(f.remote, remote);
  assert.equal(await readFile(f.config.files.songRecoveries, "utf8"), history);
  assert.equal(await readFile(f.config.files.importState, "utf8"), checkpoint);
  assert.deepEqual([...(await readMatchSelection(f.config)).effective], [...f.selection.effective]);

  for (const [key, value] of [["name", entry.before.title], ["url", entry.before.url], ["name", "Different credit"],
    ["isrc", "ABAAA0000099"], ["durationInMillis", 200001], ["contentRating", "explicit"], ["playParams", { id: "901" }]]) {
    const previous = attributes[key]; attributes[key] = value;
    await assert.rejects(check, /곡 복구/);
    if (previous === undefined) delete attributes[key]; else attributes[key] = previous;
  }
  for (const invalid of [[{ ...entry, payload_hash: "0".repeat(64) }], [{ ...entry, before: entry.after }],
    [{ ...entry, after: { ...entry.after, url: afterUrl.replace("/800?", "/801?") } }],
    [{ ...entry, after: { ...entry.after, url: afterUrl.replace("?i=900", "?i=901") } }], [entry, entry]]) {
    await save(invalid);
    await assert.rejects(check, /카탈로그 표기 승인/);
  }
  await save([entry]);
  Object.assign(attributes, { name: entry.before.title, url: entry.before.url });
  assert.equal((await check()).pending_verified, 0);
  assert.deepEqual(f.remote, remote);
});

test("link command validates the real recovery snapshot and rejects an unrelated unmapped row", async t => {
  const f = await mixedRecoveryLinks(t);
  const source = JSON.parse(await readFile(f.config.files.melonLikes)), unmatched = JSON.parse(await readFile(f.config.files.unmatched));
  const extra = { ...source.songs.find(row => row.melon_song_id === "502"), melon_song_id: "504" };
  source.songs.push(extra); unmatched.songs.push({ ...extra, match_status: "ambiguous" });
  await writeFile(f.config.files.melonLikes, JSON.stringify(source));
  await writeFile(f.config.files.unmatched, JSON.stringify(unmatched));
  const evidenceFile = path.join(f.config.root, "evidence-504.json");
  await writeFile(evidenceFile, JSON.stringify({ schema_version: 1, melon_song_id: "504", anchor_melon_song_id: "501", apple_music_song_id: "9900",
    identity_basis: "user_accepted_uncertainty", comparison: "Compared release metadata", references: ["docs/review.md"],
    accepted_uncertainties: ["source_isrc_unknown", "source_duration_unknown", "source_rating_unknown"] }));
  const options = { melonSongId: "504", anchorMelonSongId: "501", appleSongId: "9900", backend: "web-player", evidenceFile,
    reason: "Check existing target beside preserved resources", readAdapter: f.adapter, lookupClient: f.lookupClient };
  const before = await dataSnapshot(f.config), posts = f.remote.posts;
  const p = await linkExisting(f.config, options);
  assert.equal(p.saved, false); assert.equal(p.remote_evidence.playlist_occurrences, 1);
  f.remote.playlist.push({ id: "i.unrelated", attributes: {} });
  await assert.rejects(linkExisting(f.config, options), /매핑이 불완전/);
  assert.equal(await dataSnapshot(f.config), before); assert.equal(f.remote.posts, posts);
});

test("missing, forged and serialized recovery validation cannot allow unmapped playlist rows", async t => {
  const f = await mixedRecoveryLinks(t), tracks = await f.adapter.getPlaylistTracks(), playlist = await f.adapter.getLibraryPlaylist("p1");
  const proof = await validateRecoveryRemote(f.selection, f.adapter, tracks, f.state);
  await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, { playlist, tracks }), /매핑이 불완전/);
  for (const fake of [{}, { ids: tracks.map(r => r.id) }, JSON.parse(JSON.stringify(proof))]) {
    await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, { playlist, tracks, recoveryValidation: fake }), /검증 근거/);
  }
  await assert.doesNotReject(verifyExistingTarget(f.adapter, f.state, "9900", null, { playlist, tracks, recoveryValidation: proof }));
});

test("proof binds the exact checkpoint, backend and full tracks snapshot, and never permits an unknown unmapped row", async t => {
  const f = await mixedRecoveryLinks(t), tracks = await f.adapter.getPlaylistTracks(), playlist = await f.adapter.getLibraryPlaylist("p1");
  const proof = await validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), snapshot = { playlist, tracks, recoveryValidation: proof };
  await assert.rejects(verifyExistingTarget(f.adapter, { ...f.state, added_song_ids: [...f.state.added_song_ids, "123"] }, "9900", null, snapshot), /검증 근거/);
  await assert.rejects(verifyExistingTarget({ ...f.adapter, backend: "official" }, { ...f.state, backend: "official" }, "9900", null, snapshot), /검증 근거/);
  tracks[0].note = "changed after verification"; await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, snapshot), /검증 근거/); delete tracks[0].note;
  tracks.push({ id: "i.unknown", catalog_id: null });
  await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, snapshot), /검증 근거/);
  const fresh = await validateRecoveryRemote(f.selection, f.adapter, tracks, f.state);
  await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, { playlist, tracks, recoveryValidation: fresh }), /매핑이 불완전/);
});

test("duplicates and changes to preserved originals, old library identities or recovered library connections stop before any exemption", async t => {
  const f = await mixedRecoveryLinks(t), tracks = await f.adapter.getPlaylistTracks(), getLibrary = f.adapter.getLibrarySong;
  tracks.push({ ...tracks[0] }); await assert.rejects(validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), /복구 후 서버/); tracks.pop();
  tracks[0].catalog_id = "700"; await assert.rejects(validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), /복구 후 서버/); tracks[0].catalog_id = null;
  f.adapter.getLibrarySong = async id => id === "i.old0" ? { id: "i.wrong", catalog_id: null } : getLibrary(id);
  await assert.rejects(validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), /기존 보관함/);
  f.adapter.getLibrarySong = async id => id === "i.old7" ? null : getLibrary(id);
  await assert.rejects(validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), /미해결 복구/);
  f.adapter.getLibrarySong = async id => id === "i.new900" ? { id, catalog_id: "999" } : getLibrary(id);
  await assert.rejects(validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), /새 보관함/);
});

test("checkpoint or tracks mutation during recovery validation and during existing-target GET cannot reuse prior proof", async t => {
  const f = await mixedRecoveryLinks(t), tracks = await f.adapter.getPlaylistTracks(), playlist = await f.adapter.getLibraryPlaylist("p1"), getLibrary = f.adapter.getLibrarySong;
  f.adapter.getLibrarySong = async id => { tracks[0].note = "mutated during recovery GET"; return getLibrary(id); };
  await assert.rejects(validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), /검사 중/); delete tracks[0].note;
  f.adapter.getLibrarySong = async id => { f.state.note = "mutated checkpoint"; return getLibrary(id); };
  await assert.rejects(validateRecoveryRemote(f.selection, f.adapter, tracks, f.state), /검사 중/); delete f.state.note; f.adapter.getLibrarySong = getLibrary;
  const proof = await validateRecoveryRemote(f.selection, f.adapter, tracks, f.state);
  f.adapter.getLibrarySong = async id => { if (id === "i.anchor") tracks[0].note = "mutated during link GET"; return getLibrary(id); };
  await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, { playlist, tracks, recoveryValidation: proof }), /검증 근거/);
});

test("the linked target still requires one mapped occurrence and matching library and catalog after preservation validation", async t => {
  const f = await mixedRecoveryLinks(t), tracks = await f.adapter.getPlaylistTracks(), playlist = await f.adapter.getLibraryPlaylist("p1"), getLibrary = f.adapter.getLibrarySong;
  tracks.push({ id: "i.anchor2", catalog_id: "9900" });
  const duplicatedProof = await validateRecoveryRemote(f.selection, f.adapter, tracks, f.state);
  await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, { playlist, tracks, recoveryValidation: duplicatedProof }), /정확히 1회/); tracks.pop();
  const proof = await validateRecoveryRemote(f.selection, f.adapter, tracks, f.state);
  f.adapter.getLibrarySong = async id => id === "i.anchor" ? { id, catalog_id: "123" } : getLibrary(id);
  await assert.rejects(verifyExistingTarget(f.adapter, f.state, "9900", null, { playlist, tracks, recoveryValidation: proof }), /대응을 확인/);
});

async function candidateReviewFixture(t, existingLinks = false) {
  const f = existingLinks ? await mixedRecoveryLinks(t) : await partialFixture(t, 2);
  if (!existingLinks) await settle(f);
  const parent = (await readRecoveryJournal(f.config)).transactions.at(-1);
  const source = parent.payload.rows.at(-1);
  const resource = { id: "9901", type: "songs", attributes: { name: "Song - single", artistName: "Solo Artist", albumName: "Single",
    isrc: "USCGJ1919104", durationInMillis: 200661, releaseDate: "2019-02-15", playParams: { id: "9901", kind: "song" } } };
  f.catalog.push(resource);
  const candidate = { id: "9901", title: "Song - single", artist: "Solo Artist", album: "Single", isrc: "USCGJ1919104", duration_ms: 200661,
    content_rating: null, release_date: "2019-02-15", url: null };
  const plan = { schema_version: 1, recovery_id: parent.id, parent_payload_hash: parent.payload_hash, parent_settlement_hash: parent.settlement_hash,
    melon_song_id: source.melon_song_id, candidate, reason: "Related edition review", limitations: ["Different ISRC and duration; full master unverified"],
    evidence: [{ url: "https://example.test/public-release", summary: "Public release credits and preview comparison, not an approval" }] };
  const planFile = path.join(f.config.root, "candidate-review.json"); await writeFile(planFile, JSON.stringify(plan));
  return { ...f, parent, candidatePlan: plan, candidateFile: planFile, candidateResource: resource,
    candidateOptions: { backend: "web-player", planFile, writeAdapter: f.adapter, lookupClient: f.lookupClient } };
}
const candidatePreview = f => reviewRecoveryCandidate(f.config, f.candidateOptions);

test("related-edition review is read-only, parent-bound and exposes differences without weakening ordinary recovery", async t => {
  const f = await candidateReviewFixture(t), before = await dataSnapshot(f.config), remote = structuredClone(f.remote);
  const p = await candidatePreview(f);
  assert.equal(p.review_only, true); assert.equal(p.execution_supported, false); assert.equal(p.saved, false); assert.equal(p.account_changed, false);
  assert.equal(p.same_audio_master_verified, false); assert.equal(p.execution_blocked, true); assert.equal(p.candidate.id, "9901");
  assert.equal(p.parent.settlement_hash, f.parent.settlement_hash); assert(p.differences.some(d => d.field === "isrc"));
  assert.equal(p.counts.confirmed, 1); assert.equal(p.counts.unresolved, 1); assert.equal(p.counts.candidate_id_hits, 0);
  assert.equal((await candidatePreview(f)).preview_hash, p.preview_hash);
  assert.equal(await dataSnapshot(f.config), before); assert.deepEqual(f.remote, remote);
  const selection = await readMatchSelection(f.config); assert.equal(selection.effective.get(f.candidatePlan.melon_song_id).apple_music_song_id, "701");
  assert.equal(selection.effective.get("91000002").duration_ms, 1466000); assert.equal(selection.effective.get("200").match_status, "held");
  await assert.rejects(recoverSongs(f.config, { ...f.options, planFile: f.candidateFile }), /형식|schema|계획/);
});

test("candidate review validates historical links and preserves the settled library addition", async t => {
  const f = await candidateReviewFixture(t, true), before = await dataSnapshot(f.config);
  const p = await candidatePreview(f); assert.equal(p.counts.confirmed, 7); assert.equal(p.counts.active_links_checked, 2);
  assert.equal(await dataSnapshot(f.config), before);
  const g = await partialFixture(t, 2); g.remote.library.push(outsideLibrarySong()); await settle(g);
  // Use the same candidate fixture plan shape with this separately settled parent.
  const parent = (await readRecoveryJournal(g.config)).transactions[0];
  g.catalog.push(structuredClone(f.candidateResource));
  const plan = { ...f.candidatePlan, recovery_id: parent.id, parent_payload_hash: parent.payload_hash,
    parent_settlement_hash: parent.settlement_hash, melon_song_id: parent.payload.rows.at(-1).melon_song_id };
  const file = path.join(g.config.root, "candidate.json"); await writeFile(file, JSON.stringify(plan));
  const result = await reviewRecoveryCandidate(g.config, { ...g.options, planFile: file });
  assert.equal(result.preserved_library_additions.length, 1); assert.deepEqual(result.preserved_library_additions, parent.settlement.library_additions);
});

test("candidate review rejects write flags, stale parents, successful and held sources, and former recovery IDs", async t => {
  const f = await candidateReviewFixture(t), before = await dataSnapshot(f.config);
  for (const extra of [{ execute: true }, { confirm: true }, { expectedPreview: "" }, { resume: f.parent.id }, { backend: "official" }]) {
    await assert.rejects(reviewRecoveryCandidate(f.config, { ...f.candidateOptions, ...extra }), /무쓰기|KR/);
  }
  for (const edit of [p => p.parent_payload_hash = "a".repeat(64), p => p.parent_settlement_hash = "a".repeat(64),
    p => p.melon_song_id = "100", p => p.melon_song_id = "200", p => p.candidate.id = "901", p => p.candidate.id = "700"]) {
    const plan = structuredClone(f.candidatePlan); edit(plan); await writeFile(f.candidateFile, JSON.stringify(plan));
    await assert.rejects(candidatePreview(f), /부모|미해결|중복/);
  }
  assert.equal(await dataSnapshot(f.config), before);
});

test("candidate metadata changes and remote candidate ID or ISRC collisions refuse a review", async t => {
  const f = await candidateReviewFixture(t), before = await dataSnapshot(f.config);
  f.candidateResource.attributes.durationInMillis++; await assert.rejects(candidatePreview(f), /metadata/); f.candidateResource.attributes.durationInMillis--;
  for (const r of [{ id: "i.duplicate", type: "library-songs", attributes: { playParams: { catalogId: "9901" } } },
    { id: "i.sameisrc", type: "library-songs", attributes: { isrc: "USCGJ1919104" } }]) {
    f.remote.library.push(r); await assert.rejects(candidatePreview(f), /중복/); f.remote.library.pop();
  }
  f.remote.library.push({ id: "i.extra", type: "library-songs", attributes: { name: "Unreviewed addition" } });
  await assert.rejects(candidatePreview(f), /기준선/); assert.equal(await dataSnapshot(f.config), before);
});

test("changed original resources, failed candidates and confirmed resources stop review without another post", async t => {
  const f = await candidateReviewFixture(t), before = await dataSnapshot(f.config), posts = f.remote.posts;
  f.remote.playlist.push(structuredClone(f.remote.playlist[0])); await assert.rejects(candidatePreview(f), /resource 중복/); f.remote.playlist.pop();
  const failed = { id: "i.failednow", type: "library-songs", attributes: { playParams: { catalogId: "901" } } };
  f.remote.playlist.push(failed); await assert.rejects(candidatePreview(f), /미해결/); f.remote.playlist.pop();
  f.remote.library[0].attributes.playParams = { catalogId: "700" }; await assert.rejects(candidatePreview(f), /기존 보관함/);
  assert.equal(f.remote.posts, posts); assert.equal(await dataSnapshot(f.config), before);
});

test("plan changes during GET and local input changes invalidate the read-only result; remote diagnostics stay private", async t => {
  const f = await candidateReviewFixture(t), request = f.adapter.request; let changed = false;
  f.adapter.request = async (...args) => { if (!changed) { changed = true; await writeFile(f.candidateFile, JSON.stringify({ ...f.candidatePlan, reason: "changed during GET" })); } return request(...args); };
  await assert.rejects(candidatePreview(f), /검사 중|검사중/);
  f.adapter.request = request; await writeFile(f.candidateFile, JSON.stringify(f.candidatePlan));
  f.adapter.request = async (...args) => { const state = JSON.parse(await readFile(f.config.files.importState)); state.marker = "concurrent"; await writeFile(f.config.files.importState, JSON.stringify(state)); return request(...args); };
  await assert.rejects(candidatePreview(f), /입력이 바뀌/);
  f.adapter.request = async () => { throw Error("PRIVATE_REMOTE_BODY"); };
  await assert.rejects(candidatePreview(f), e => /진단/.test(e.message) && !e.message.includes("PRIVATE_REMOTE_BODY"));
});

test("candidate evidence is bounded and never treated as write authorization", async t => {
  const f = await candidateReviewFixture(t);
  for (const edit of [p => p.limitations = [], p => p.evidence = [], p => p.evidence[0].url = "https://user:password@example.test/",
    p => p.evidence[0].url = "file:///secret", p => p.execute = true]) {
    const plan = structuredClone(f.candidatePlan); edit(plan); await writeFile(f.candidateFile, JSON.stringify(plan));
    await assert.rejects(candidatePreview(f), /계획|근거/);
  }
  assert.equal(parseArgs(["review-recovery-candidate", "--backend", "web-player", "--plan-file", "review.json"]).options.planFile, "review.json");
  for (const flag of ["--execute", "--confirm", "--expected-preview", "--resume", "--delete"]) assert.throws(() => parseArgs(["review-recovery-candidate", flag]), /알 수 없는 옵션/);
});

test("candidate metadata key order is immaterial and other local selections still block candidate IDs and ISRCs", async t => {
  const f = await candidateReviewFixture(t);
  const reordered = { ...f.candidatePlan, candidate: Object.fromEntries(Object.entries(f.candidatePlan.candidate).reverse()) };
  await writeFile(f.candidateFile, JSON.stringify(reordered)); assert.equal((await candidatePreview(f)).candidate.id, "9901");
  const source = JSON.parse(await readFile(f.config.files.melonLikes)), matched = JSON.parse(await readFile(f.config.files.matched));
  const extra = { melon_song_id: "999", title: "Another source", artist: "Artist", album: "Album" };
  source.songs.push(extra); matched.songs.push({ ...extra, match_status: "matched", apple_music_song_id: "9901" });
  await writeFile(f.config.files.melonLikes, JSON.stringify(source)); await writeFile(f.config.files.matched, JSON.stringify(matched));
  await assert.rejects(candidatePreview(f), /선택곡.*중복/);
  matched.songs.at(-1).apple_music_song_id = "9902"; matched.songs.at(-1).apple_music_isrc = "USCGJ1919104";
  await writeFile(f.config.files.matched, JSON.stringify(matched)); await assert.rejects(candidatePreview(f), /선택곡.*중복/);
});

const followupPreview = f => recoverFollowup(f.config, f.candidateOptions);
async function followupExecute(f) { const p = await followupPreview(f); return recoverFollowup(f.config, { ...f.candidateOptions, execute: true, expectedPreview: p.preview_hash }); }
const originalKeys = ["melonLikes", "matched", "unmatched", "manualMatches", "unavailableMatches", "matchDecisions", "existingSongLinks", "importState", "songRecoveries"];

test("followup previews an exact one-song append with no journal or account writes and legacy snapshots remain compatible", async t => {
  const f = await candidateReviewFixture(t), before = await dataSnapshot(f.config), remote = structuredClone(f.remote);
  assert.equal(before, await dataSnapshot(f.config, originalKeys));
  const p = await followupPreview(f); assert.equal(p.execution_supported, true); assert.equal(p.saved, false);
  assert.equal(p.write_scope.candidate_playlist_posts, 1); assert.equal(p.write_scope.library_posts, 0); assert.equal(p.write_scope.deletes, 0);
  assert.equal(p.parent.payload_hash, f.parent.payload_hash); assert.equal(p.same_audio_master_verified, false);
  assert.equal(await dataSnapshot(f.config), before); assert.deepEqual(f.remote, remote); assert.equal((await readFollowups(f.config)).transactions.length, 0);
  await assert.rejects(recoverFollowup(f.config, { ...f.candidateOptions, execute: true }), /미리보기/);
  for (const flag of ["--confirm", "--delete"]) assert.throws(() => parseArgs(["recover-followup", flag]), /알 수 없는 옵션/);
});

test("followup appends approval-attempt-confirmation events, preserves all original files and projects only the unresolved source", async t => {
  const f = await candidateReviewFixture(t, true), base = await dataSnapshot(f.config, originalKeys), parent = await readFile(f.config.files.songRecoveries, "utf8");
  f.remote.mode = "ok"; const add = f.adapter.addTracks;
  f.adapter.addTracks = async (playlist, ids) => { assert.equal(playlist, "p1"); assert.deepEqual(ids, ["9901"]); assert.equal(followupPhase((await readFollowups(f.config)).transactions[0]), "attempted"); return add(playlist, ids); };
  const posts = f.remote.posts, result = await followupExecute(f);
  assert.equal(result.phase, "confirmed"); assert.equal(f.remote.posts, posts + 1); assert.equal(result.account_changed, true);
  const doc = await readFollowups(f.config), tx = doc.transactions[0];
  assert.deepEqual(tx.events.map(e => e.type), ["approved", "attempted", "confirmed"]); assert.equal(tx.payload.plan.parent_settlement_hash, f.parent.settlement_hash);
  assert.equal(await dataSnapshot(f.config, originalKeys), base); assert.equal(await readFile(f.config.files.songRecoveries, "utf8"), parent);
  assert.notEqual(await dataSnapshot(f.config), base);
  const selection = await readMatchSelection(f.config); assert.equal(selection.effective.get(f.candidatePlan.melon_song_id).apple_music_song_id, "9901");
  assert.equal(selection.recoveries.sources.size, 8); assert.equal(selection.recoveries.unresolved.length, 0); assert.equal(selection.recoveries.history.size, 17);
  assert.equal(selection.effective.get("91000002").duration_ms, 1466000); assert.equal(selection.effective.get("200").match_status, "held");
  const checked = await applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter });
  assert.equal(checked.linked_existing, 2); assert.equal(checked.recovery.confirmed_followups, 1); assert.equal(checked.recovery.unresolved.length, 0); assert.equal(checked.pending_verified, 0);
  const status = await localStatus(f.config); assert.equal(status.apply.confirmed_followups, 1);
  await reviewResults(f.config); assert((await readFile(f.config.files.reviewHtml, "utf8")).includes("후속 이력 " + tx.id));
  await assert.rejects(followupExecute(f), /미해결|중복/);
  await assert.rejects(recoverFollowup(f.config, { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient }), /확인된 이력/);
  assert.equal(f.remote.posts, posts + 1);
});

test("an ambiguous successful followup is reconciled by GET and a separate hash with no second POST", async t => {
  const f = await candidateReviewFixture(t), base = await dataSnapshot(f.config, originalKeys); f.remote.mode = "timeout-after";
  const posts = f.remote.posts; await assert.rejects(followupExecute(f), /미확정/); const tx = (await readFollowups(f.config)).transactions[0];
  assert.equal(followupPhase(tx), "attempted"); assert.equal(f.remote.posts, posts + 1);
  await assert.rejects(localStatus(f.config), /미완료 후속/);
  const options = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  const p = await recoverFollowup(f.config, options); assert.equal(p.remote_confirmed, true); assert.equal(p.write_scope.candidate_playlist_posts, 0);
  await recoverFollowup(f.config, { ...options, execute: true, expectedPreview: p.preview_hash });
  assert.equal(f.remote.posts, posts + 1); assert.equal(followupPhase((await readFollowups(f.config)).transactions[0]), "confirmed");
  assert.equal(await dataSnapshot(f.config, originalKeys), base);
});

test("an attempted but absent candidate never reposts even with execute approval", async t => {
  const f = await candidateReviewFixture(t); f.remote.mode = "timeout-before";
  await assert.rejects(followupExecute(f), /미확정/); const tx = (await readFollowups(f.config)).transactions[0], posts = f.remote.posts;
  const options = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  const p = await recoverFollowup(f.config, options); assert.equal(p.execution_blocked, true); assert.equal(p.write_scope.candidate_playlist_posts, 0);
  await assert.rejects(recoverFollowup(f.config, { ...options, execute: true, expectedPreview: p.preview_hash }), /GET 확인만/);
  assert.equal(f.remote.posts, posts); assert.equal(followupPhase((await readFollowups(f.config)).transactions[0]), "attempted");
});

test("followup old-resource substitution, duplicate, library-only and baseline changes fail closed and retain attempted history", async t => {
  const f = await candidateReviewFixture(t), original = f.adapter.addTracks;
  f.adapter.addTracks = async () => { f.remote.posts++; f.remote.playlist.push(structuredClone(f.remote.playlist[1])); };
  await assert.rejects(followupExecute(f), /resource 중복/); const tx = (await readFollowups(f.config)).transactions[0], posts = f.remote.posts;
  assert.equal(followupPhase(tx), "attempted"); f.remote.playlist.pop(); f.adapter.addTracks = original;
  const c = f.candidateResource, resource = { id: "i.only", type: "library-songs", attributes: { ...c.attributes, playParams: { catalogId: c.id } } };
  f.remote.library.push(resource);
  const options = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  await assert.rejects(recoverFollowup(f.config, options), /한쪽 반영/); f.remote.library.pop();
  const oldPlaylist = structuredClone(f.remote.playlist[1]), oldLibrary = structuredClone(f.remote.library[1]);
  f.remote.playlist[1].attributes.playParams = { catalogId: "9901" }; f.remote.library[1].attributes.playParams = { catalogId: "9901" };
  await assert.rejects(recoverFollowup(f.config, options), /기존 resource 치환/);
  f.remote.playlist[1] = oldPlaylist; f.remote.library[1] = oldLibrary;
  f.remote.library[0].attributes.name = "drift"; await assert.rejects(recoverFollowup(f.config, options), /대상 밖/);
  assert.equal(f.remote.posts, posts); assert.equal(followupPhase((await readFollowups(f.config)).transactions[0]), "attempted");
});

test("stale followup approval, final GET drift and data locks refuse execution before any journal or POST", async t => {
  const f = await candidateReviewFixture(t), p = await followupPreview(f), posts = f.remote.posts;
  await writeFile(f.candidateFile, JSON.stringify({ ...f.candidatePlan, reason: "changed" }));
  await assert.rejects(recoverFollowup(f.config, { ...f.candidateOptions, execute: true, expectedPreview: p.preview_hash }), /미리보기 이후/);
  await writeFile(f.candidateFile, JSON.stringify(f.candidatePlan));
  const locks = await acquireDataLocks(f.config); try { await assert.rejects(recoverFollowup(f.config, { ...f.candidateOptions, execute: true, expectedPreview: p.preview_hash }), /완료하지 못/); } finally { await releaseDataLocks(locks); }
  const request = f.adapter.request; let scans = 0;
  f.adapter.request = async (url, init) => { if (String(url).includes('/library/playlists/') && ++scans === 2) f.remote.library[0].attributes.name = "late drift"; return request(url, init); };
  await assert.rejects(recoverFollowup(f.config, { ...f.candidateOptions, execute: true, expectedPreview: p.preview_hash }), /기준선|직전/);
  assert.equal((await readFollowups(f.config)).transactions.length, 0); assert.equal(f.remote.posts, posts);
});

test("followup reader rejects altered payload, parent, event chains and candidate library identity", async t => {
  const f = await candidateReviewFixture(t); f.remote.mode = "ok"; await followupExecute(f);
  const saved = await readFile(f.config.files.recoveryFollowups, "utf8"), original = JSON.parse(saved);
  for (const edit of [d => d.transactions[0].payload.plan.reason = "tampered", d => d.transactions[0].events[1].previous_hash = "a".repeat(64),
    d => { const tx = d.transactions[0]; tx.payload.plan.parent_settlement_hash = "a".repeat(64); tx.payload_hash = recoveryDigest(tx.payload); }]) {
    const doc = structuredClone(original); edit(doc); await writeFile(f.config.files.recoveryFollowups, JSON.stringify(doc));
    await assert.rejects(readMatchSelection(f.config), /후속/);
  }
  await writeFile(f.config.files.recoveryFollowups, saved);
  const get = f.adapter.getLibrarySong; f.adapter.getLibrarySong = async id => id === "i.new9901" ? { id, catalog_id: "123" } : get(id);
  await assert.rejects(applyPlaylist(f.config, { check: true, backend: "web-player", writeAdapter: f.adapter }), /새 보관함/);
});

test("an approval saved before a POST can resume once, but unexplained presence cannot be adopted", async t => {
  const f = await candidateReviewFixture(t); f.remote.mode = "timeout-before";
  await assert.rejects(followupExecute(f), /미확정/); const doc = await readFollowups(f.config), tx = doc.transactions[0];
  // Simulate a process stopping after approval persistence and before attempted persistence/POST.
  tx.events = tx.events.slice(0, 1); tx.events_hash = recoveryDigest(tx.events); await writeFile(f.config.files.recoveryFollowups, JSON.stringify(doc));
  const options = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  const p = await recoverFollowup(f.config, options); assert.equal(p.write_scope.candidate_playlist_posts, 1);
  f.remote.mode = "ok"; const posts = f.remote.posts; await recoverFollowup(f.config, { ...options, execute: true, expectedPreview: p.preview_hash });
  assert.equal(f.remote.posts, posts + 1); assert.equal(followupPhase((await readFollowups(f.config)).transactions[0]), "confirmed");
  const g = await candidateReviewFixture(t); g.remote.mode = "timeout-after"; await assert.rejects(followupExecute(g), /미확정/);
  const unexplained = await readFollowups(g.config); unexplained.transactions[0].events = unexplained.transactions[0].events.slice(0, 1); unexplained.transactions[0].events_hash = recoveryDigest(unexplained.transactions[0].events);
  await writeFile(g.config.files.recoveryFollowups, JSON.stringify(unexplained));
  await assert.rejects(recoverFollowup(g.config, { ...options, resume: unexplained.transactions[0].id, writeAdapter: g.adapter, lookupClient: g.lookupClient }), /시도 이력 전에/);
});

test("followup resume refuses parent/input or implementation drift and malformed/truncated event sequences", async t => {
  const f = await candidateReviewFixture(t); f.remote.mode = "timeout-before"; await assert.rejects(followupExecute(f), /미확정/);
  const original = await readFollowups(f.config), tx = original.transactions[0], options = { backend: "web-player", resume: tx.id, writeAdapter: f.adapter, lookupClient: f.lookupClient };
  const changed = structuredClone(original); changed.transactions[0].payload.implementation_sha256 = "a".repeat(64); changed.transactions[0].payload_hash = recoveryDigest(changed.transactions[0].payload);
  await writeFile(f.config.files.recoveryFollowups, JSON.stringify(changed)); await assert.rejects(recoverFollowup(f.config, options), /구현이 변경/);
  await writeFile(f.config.files.recoveryFollowups, JSON.stringify(original)); const state = JSON.parse(await readFile(f.config.files.importState)); state.marker = "drift";
  await writeFile(f.config.files.importState, JSON.stringify(state)); await assert.rejects(recoverFollowup(f.config, options), /운영 입력/);
  for (const events of [[], [tx.events[1]], [tx.events[0], { ...tx.events[1], type: "confirmed" }]]) {
    const bad = structuredClone(original); bad.transactions[0].events = events; assert.throws(() => validateFollowups(bad), /후속/);
  }
});

test("confirmed followup remains readable after a separately authorized ordinary apply evolves its checkpoint", async t => {
  const f = await candidateReviewFixture(t); f.remote.mode = "ok"; await followupExecute(f);
  const parent = await readFile(f.config.files.songRecoveries, "utf8"), child = await readFile(f.config.files.recoveryFollowups, "utf8"), posts = f.remote.posts;
  await applyPlaylist(f.config, { execute: true, backend: "web-player", writeAdapter: f.adapter });
  const selection = await readMatchSelection(f.config); assert.equal(selection.effective.get(f.candidatePlan.melon_song_id).apple_music_song_id, "9901");
  assert.equal(selection.recoveries.unresolved.length, 0); assert.equal(f.remote.posts, posts);
  assert.equal(await readFile(f.config.files.songRecoveries, "utf8"), parent); assert.equal(await readFile(f.config.files.recoveryFollowups, "utf8"), child);
});
