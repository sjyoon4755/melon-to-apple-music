import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { extractMelonLikes } from "../src/melon.js";
import { applyPlaylist, localStatus, matchAppleMusic, reviewResults } from "../src/pipeline.js";

test("malformed saved song documents stop every consumer and preserve decisions before lookup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-input-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  const song = { melon_song_id: "m1", title: "Song", artist: "Artist" };
  const documents = {
    melonLikes: { complete: false, songs: [song] },
    matched: { songs: [] }, unmatched: { songs: [] }, manualMatches: { songs: [] }
  };
  const consumers = [
    () => localStatus(config), () => reviewResults(config),
    () => applyPlaylist(config, { backend: "web-player" }),
    () => matchAppleMusic(config, { lookupClient: { searchSongs: async () => assert.fail("unexpected lookup") } })
  ];
  for (const [field, malformed] of [
    ["melonLikes", { songs: { bad: true } }], ["matched", { songs: [null] }],
    ["unmatched", { songs: "wrong" }], ["manualMatches", { songs: [[]] }],
    ["melonLikes", { songs: [song], unavailable_songs: {} }]
  ]) {
    for (const [name, value] of Object.entries(documents)) {
      await writeFile(config.files[name], JSON.stringify(name === field ? malformed : value));
    }
    const before = await Promise.all(Object.keys(documents).map((name) => readFile(config.files[name], "utf8")));
    for (const consume of consumers) {
      await assert.rejects(consume, (error) => {
        assert.match(error.message, /곡 데이터 구조.*기존 파일을 보존/);
        assert.ok(error.message.includes(config.files[field]));
        return true;
      });
    }
    if (field === "melonLikes") {
      await assert.rejects(() => extractMelonLikes(config, { headless: true }), /곡 데이터 구조/);
    }
    assert.deepEqual(await Promise.all(Object.keys(documents).map((name) => readFile(config.files[name], "utf8"))), before);
    await assert.rejects(() => readFile(config.files.importState), { code: "ENOENT" });
    await assert.rejects(() => readFile(config.files.matchingRun), { code: "ENOENT" });
  }
});

test("JSON syntax failure identifies the file without echoing its contents or changing it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-json-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  await mkdir(config.dataDir, { recursive: true });
  const text = '{"songs": [private-fixture-marker]';
  await writeFile(config.files.melonLikes, text);
  await assert.rejects(() => localStatus(config), (error) => {
    assert.match(error.message, /JSON 문법.*기존 파일을 보존/);
    assert.ok(error.message.includes(config.files.melonLikes));
    assert.ok(!error.message.includes("private-fixture-marker"));
    return true;
  });
  assert.equal(await readFile(config.files.melonLikes, "utf8"), text);
});
