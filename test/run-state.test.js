import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { readRunState, sourceFingerprint, startRun } from "../src/run-state.js";

test("reports a process that exited without final state as interrupted without changing the file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-run-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "run.json");
  assert.equal(await readRunState(file), null);
  const run = await startRun(file, { processed: 1, remaining: 2 });
  assert.equal((await readRunState(file)).status, "running");
  await run.finish("completed", { remaining: 0 });
  assert.equal((await readRunState(file)).remaining, 0);
  const exited = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  assert.equal(exited.status, 0);
  const state = JSON.stringify({ pid: exited.pid, status: "running" });
  await writeFile(file, state);
  assert.equal((await readRunState(file)).status, "interrupted");
  assert.equal(await readFile(file, "utf8"), state);
});

test("source fingerprints include metadata used by the matcher", () => {
  const song = { melon_song_id: "1", title: "Song", artist: "Artist", album: "Album" };
  for (const field of ["title", "artist", "album", "duration_ms", "isrc", "content_rating"]) {
    assert.notEqual(sourceFingerprint([song]), sourceFingerprint([{ ...song, [field]: "changed" }]));
  }
});
