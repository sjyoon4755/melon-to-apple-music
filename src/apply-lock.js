import { mkdir, realpath, lstat, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import os from "node:os";

export const defaultLockDir = path.join(os.homedir(), ".melon-to-apple-music", "apply-locks");
export class ApplyLockError extends Error {
  constructor(message, code) { super(message); this.name = "ApplyLockError"; this.code = code; }
}
const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function checkpointTarget(file) {
  await mkdir(path.dirname(file), { recursive: true });
  let canonical;
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new ApplyLockError("Apple checkpoint의 symbolic link는 실행 대상으로 지원하지 않습니다.", "APPLY_LOCK_TARGET_INVALID");
    canonical = await realpath(file);
  }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonical = path.join(await realpath(path.dirname(file)), path.basename(file));
  }
  return `checkpoint:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}

export function playlistTarget(id) { return `playlist:${String(id)}`; }

// All source/selection writers share the same order, including before a link journal exists.
export async function acquireDataLocks(config) {
  const locks = [];
  try {
    for (const file of [config.files.importState, config.files.matchDecisions, config.files.existingSongLinks, config.files.songRecoveries, config.files.recoveryFollowups].filter(Boolean)) {
      locks.push(await acquireApplyLock(await checkpointTarget(file), config.applyLockDir));
    }
    return locks;
  } catch (error) {
    await releaseDataLocks(locks);
    throw error;
  }
}

export async function releaseDataLocks(locks) {
  let failure;
  for (const lock of [...locks].reverse()) {
    try { await lock.release(); } catch (error) { failure ??= error; }
  }
  if (failure) throw new ApplyLockError("잠금 소유권/해제를 확인할 수 없습니다. 자동 복구하지 않습니다.", "APPLY_LOCK_RELEASE_FAILED");
}

export async function withDataLocks(config, operation) {
  const locks = await acquireDataLocks(config);
  try { return await operation(async () => { for (const lock of locks) await lock.assertOwned(); }); }
  finally { await releaseDataLocks(locks); }
}

export async function dataSnapshot(config, keys = ["melonLikes", "matched", "unmatched", "manualMatches", "unavailableMatches", "matchDecisions", "existingSongLinks", "importState", "songRecoveries", "recoveryFollowups", "recoveryCatalogApprovals"]) {
  const values = [];
  for (const key of keys) {
    const optional = key === "recoveryFollowups" || key === "recoveryCatalogApprovals";
    if (optional && !config.files[key]) continue;
    try { values.push([key, hash(await readFile(config.files[key]))]); }
    catch (error) { if (error.code !== "ENOENT") throw error; if (!optional) values.push([key, null]); }
  }
  return hash(JSON.stringify(values));
}

export async function assertDataSnapshot(config, expected, keys) {
  if (await dataSnapshot(config, keys) !== expected) throw new Error("확인 중 로컬 입력이 바뀌었습니다. 덮어쓰지 않고 중단합니다. 새 미리보기 또는 검색이 필요합니다.");
}

export async function acquireApplyLock(target, directory = defaultLockDir) {
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, hash(target));
  try { await mkdir(lockPath); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new ApplyLockError(`Apple 적용 잠금이 존재합니다. 진행 중이거나 중단/소유권 불명확 상태입니다. 자동 복구하지 않습니다. 잠금: ${lockPath}`, "APPLY_LOCKED");
  }
  const ownerPath = path.join(lockPath, "owner.json");
  const nonce = randomUUID();
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end(nonce);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref();
    await writeFile(ownerPath, JSON.stringify({ schema_version: 1, nonce, pid: process.pid,
      port: server.address().port, started_at: new Date().toISOString() }), { flag: "wx" });
  } catch (error) {
    server.close();
    // Incomplete locks stay closed: ownership was never durably established.
    throw error;
  }
  async function assertOwned() {
    let owner;
    try { owner = JSON.parse(await readFile(ownerPath, "utf8")); } catch { /* fail closed */ }
    if (owner?.nonce !== nonce) throw new ApplyLockError("Apple 적용 잠금 소유권이 변경되었거나 확인되지 않습니다.", "APPLY_LOCK_OWNERSHIP_LOST");
  }
  return { lockPath, nonce,
    async assertOwned() { await assertOwned(); },
    async release() {
      try {
        await assertOwned();
        await unlink(ownerPath);
        await rmdir(lockPath);
      } finally { server.close(); }
    }
  };
}

export async function readApplyRun(file) {
  let state;
  try { state = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (state.status !== "running") return state;
  let owner;
  try { owner = JSON.parse(await readFile(path.join(state.lock_path, "owner.json"), "utf8")); }
  catch { return { ...state, status: "unknown", stop_reason: "lock_ownership_unverifiable" }; }
  if (owner.nonce !== state.lock_nonce) return { ...state, status: "unknown", stop_reason: "lock_ownership_mismatch" };
  if (!Number.isInteger(owner.port) || owner.port < 1 || owner.port > 65535 || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { ...state, status: "unknown", stop_reason: "invalid_lock_owner" };
  }
  const alive = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: owner.port });
    let result = "";
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.on("data", (data) => { result += data; if (result.length > 100) done(false); });
    socket.on("end", () => done(result === owner.nonce));
    socket.on("error", () => done(false));
  });
  if (alive) return state;
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code === "ESRCH") return { ...state, status: "interrupted", stop_reason: "owner_process_exited" };
  }
  return { ...state, status: "unknown", stop_reason: "owner_liveness_unverifiable" };
}
