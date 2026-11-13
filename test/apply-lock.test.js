import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireApplyLock, checkpointTarget, readApplyRun } from "../src/apply-lock.js";
import { resolveConfig } from "../src/config.js";
import { applyPlaylist, localStatus } from "../src/pipeline.js";

async function fixture(t, count = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "apply-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir);
  await writeFile(config.files.matched, JSON.stringify({ songs: Array.from({ length: count }, (_, i) => ({
    match_status: "matched", apple_music_song_id: String(i + 1)
  })) }));
  return config;
}
function adapter(id = "p.fixture") {
  const tracks = new Set();
  return { backend: "official", writes: 0,
    async validateSession() { return { storefront: "kr" }; },
    async validateCatalogSongs(ids) { return ids; },
    async createLibraryPlaylist() { this.writes++; return { id }; },
    async getLibraryPlaylist() { return { id, canEdit: true }; },
    async getPlaylistTracks() { return [...tracks].map((catalog_id) => ({ catalog_id })); },
    async addTracks(_, ids) { this.writes++; for (const song of ids) tracks.add(song); }
  };
}
const execute = (config, writeAdapter) => applyPlaylist(config, { execute: true, writeAdapter });
const runFile = (config) => `${config.files.importState}.run.json`;

async function child(t, config) {
  const proc = fork(fileURLToPath(new URL("../scripts/fixtures/apply-lock-child.js", import.meta.url)), [JSON.stringify(config)], {
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill(); });
  const [message] = await Promise.race([
    once(proc, "message"),
    once(proc, "exit").then(() => { throw new Error("fixture process exited before acquiring lock"); })
  ]);
  assert.equal(message, "locked");
  return proc;
}

test("another process is rejected before adapter reads/writes and completion releases all locks", async (t) => {
  const config = await fixture(t);
  const proc = await child(t, config);
  const current = await localStatus(config);
  assert.equal(current.operations.apply.status, "running");
  const other = adapter();
  other.validateSession = async () => { assert.fail("second execution reached adapter"); };
  await assert.rejects(execute(config, other), { code: "APPLY_LOCKED" });
  assert.equal(other.writes, 0);
  const exit = once(proc, "exit");
  proc.send("continue");
  await exit;
  assert.equal((await readApplyRun(runFile(config))).status, "completed");
  assert.deepEqual(await readdir(config.applyLockDir), []);
  const resumed = adapter();
  resumed.getPlaylistTracks = async () => [{ catalog_id: "1" }];
  assert.equal((await execute(config, resumed)).added_this_run, 0);
});

test("independent targets run concurrently in a shared lock directory", async (t) => {
  const first = await fixture(t), second = await fixture(t);
  second.applyLockDir = first.applyLockDir;
  const proc = await child(t, first);
  assert.equal((await execute(second, adapter("p.independent"))).added_this_run, 1);
  const exit = once(proc, "exit"); proc.send("continue"); await exit;
});

test("same remote playlist in different checkpoint directories and backends is blocked", async (t) => {
  const first = await fixture(t), second = await fixture(t);
  second.applyLockDir = first.applyLockDir;
  for (const config of [first, second]) await writeFile(config.files.importState, JSON.stringify({
    playlist_id: "p.shared", backend: config === first ? "official" : "web-player", added_song_ids: []
  }));
  const proc = await child(t, first);
  const other = adapter("p.shared"); other.backend = "web-player";
  await assert.rejects(applyPlaylist(second, { execute: true, backend: "web-player", writeAdapter: other }), { code: "APPLY_LOCKED" });
  assert.equal(other.writes, 0);
  const exit = once(proc, "exit"); proc.send("continue"); await exit;
});

test("forced exit preserves interrupted lock; PID reuse is unknown and never permits recovery", async (t) => {
  const config = await fixture(t);
  const proc = await child(t, config);
  const exit = once(proc, "exit"); proc.kill(); await exit;
  assert.equal((await readApplyRun(runFile(config))).status, "interrupted");
  await assert.rejects(execute(config, adapter()), { code: "APPLY_LOCKED" });
  const state = JSON.parse(await readFile(runFile(config)));
  const ownerFile = path.join(state.lock_path, "owner.json");
  const owner = JSON.parse(await readFile(ownerFile));
  await writeFile(ownerFile, JSON.stringify({ ...owner, pid: process.pid }));
  assert.equal((await readApplyRun(runFile(config))).status, "unknown");
  await assert.rejects(execute(config, adapter()), { code: "APPLY_LOCKED" });
  assert.equal(JSON.parse(await readFile(ownerFile)).nonce, owner.nonce);
});

test("owner mismatch blocks release and preserves foreign files; malformed locks stay closed", async (t) => {
  const config = await fixture(t);
  const target = await checkpointTarget(config.files.importState);
  const lock = await acquireApplyLock(target, config.applyLockDir);
  const ownerFile = path.join(lock.lockPath, "owner.json");
  await writeFile(ownerFile, JSON.stringify({ nonce: "foreign-owner" }));
  await assert.rejects(lock.assertOwned(), { code: "APPLY_LOCK_OWNERSHIP_LOST" });
  await assert.rejects(lock.release(), { code: "APPLY_LOCK_OWNERSHIP_LOST" });
  assert.equal(JSON.parse(await readFile(ownerFile)).nonce, "foreign-owner");
  await assert.rejects(execute(config, adapter()), { code: "APPLY_LOCKED" });
  await writeFile(ownerFile, "partial-json");
  await assert.rejects(execute(config, adapter()), { code: "APPLY_LOCKED" });
});

test("batch failure records confirmed progress without diagnostics and releases locks", async (t) => {
  const config = await fixture(t, 101), fake = adapter();
  const add = fake.addTracks;
  let calls = 0;
  fake.addTracks = async function(id, ids) {
    if (++calls === 2) {
      assert.equal(JSON.parse(await readFile(config.files.importState)).added_song_ids.length, 100);
      throw Object.assign(new Error("secret cookie/token/header/response/profile"), { code: "secret-diagnostic" });
    }
    return add.call(this, id, ids);
  };
  await assert.rejects(execute(config, fake), (error) => !error.message.includes("secret"));
  const text = await readFile(runFile(config), "utf8"), state = JSON.parse(text);
  assert.equal(state.status, "failed");
  assert.equal(state.confirmed_added, 100);
  assert.equal(state.phase, "adding_batch");
  assert.equal(state.stop_reason, "track_add_failed");
  assert.ok(state.finished_at);
  assert.equal(text.includes("secret"), false);
  assert.deepEqual(await readdir(config.applyLockDir), []);
});

test("dry-run and check leave locks, run state and checkpoint untouched", async (t) => {
  const config = await fixture(t);
  await applyPlaylist(config);
  await applyPlaylist(config, { check: true, writeAdapter: adapter() });
  assert.deepEqual(await readdir(config.dataDir), ["matched.json"]);
  await assert.rejects(readdir(config.applyLockDir), { code: "ENOENT" });
});

test("ownership change during execution stops before POST/checkpoint and preserves foreign owner", async (t) => {
  const config = await fixture(t), fake = adapter();
  let foreignFile;
  fake.validateCatalogSongs = async (ids) => {
    const state = JSON.parse(await readFile(runFile(config)));
    foreignFile = path.join(state.lock_path, "owner.json");
    await writeFile(foreignFile, JSON.stringify({ nonce: "foreign" }));
    return ids;
  };
  await assert.rejects(execute(config, fake), { code: "APPLY_LOCK_RELEASE_FAILED" });
  assert.equal(fake.writes, 0);
  await assert.rejects(readFile(config.files.importState), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(foreignFile)).nonce, "foreign");
  assert.equal((await readApplyRun(runFile(config))).status, "unknown");
});

test("same process overlap is rejected and failure releases owned locks for a later run", async (t) => {
  const config = await fixture(t), fake = adapter();
  let resume, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  fake.validateSession = async () => {
    entered();
    await new Promise((resolve) => { resume = resolve; });
    throw new Error("private diagnostic");
  };
  const first = execute(config, fake);
  await waiting;
  await assert.rejects(execute(config, adapter()), { code: "APPLY_LOCKED" });
  resume();
  await assert.rejects(first, (error) => error.cause === undefined && !error.message.includes("private"));
  assert.equal((await execute(config, adapter())).added_this_run, 1);
});
