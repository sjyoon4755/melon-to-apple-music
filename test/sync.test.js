import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { parseArgs } from "../src/cli-options.js";
import { formatSyncReport, syncLikes } from "../src/sync-command.js";

const song = (n) => ({ melon_song_id: `m${n}`, title: `Song ${n}`, artist: "Artist", album: `Album ${n}` });
const sourceDoc = (songs, extra = {}) => ({ schema_version: 1, complete: true, source: { total_reported: songs.length },
  extraction: { stop_reason: "completed", verified_unique_count: songs.length, reported_count_gap: 0 }, songs, ...extra });

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  const old = [song(1), song(2)];
  await writeFile(config.files.melonLikes, JSON.stringify(sourceDoc(old)));
  const matchConfig = { threshold: 0.88, min_margin: 0.06 };
  await writeFile(config.files.matched, JSON.stringify({ match_config: matchConfig, songs: [
    { ...song(1), apple_music_song_id: "1", apple_music_title: "Song 1", apple_music_artist: "Artist", match_status: "matched" }] }));
  await writeFile(config.files.unmatched, JSON.stringify({ match_config: matchConfig, songs: [
    { ...song(2), apple_music_song_id: null, match_status: "ambiguous", candidates: [] }] }));
  await writeFile(config.files.manualMatches, JSON.stringify({ songs: [
    { ...song(2), apple_music_song_id: "2", match_status: "manual_confirmed", manual_confirmed_at: "2026-11-01T00:00:00.000Z" }] }));
  await writeFile(config.files.importState, JSON.stringify({ schema_version: 2, backend: "web-player", storefront: "kr",
    playlist_id: "p.tool", playlist_name: "Melon Likes Import", added_song_ids: ["1", "2"] }));
  return config;
}

// New likes m3 (auto-matchable) and m4 (no candidates → not_found).
function newLikes(config, document = sourceDoc([song(1), song(2), song(3), song(4)])) {
  const calls = [];
  return { calls, async extract(cfg, options) {
    calls.push(options);
    await writeFile(cfg.files.melonLikes, JSON.stringify(document));
    return document;
  } };
}

function lookup() {
  const queries = [];
  return { queries, async searchSongs(query) {
    queries.push(query);
    return query.includes("Song 3") ? [{ ...song(3), id: "3", url: "https://music.apple.com/kr/song/3" }] : [];
  } };
}

function fakeAdapter(initial = ["1", "2"]) {
  const tracks = new Set(initial);
  const adapter = { backend: "web-player", batches: [], createCalls: 0,
    async validateSession() { return { storefront: "kr" }; },
    async getStorefront() { return "kr"; },
    async validateCatalogSongs(ids) { return ids.map((id) => ({ id, attributes: { playParams: { id } } })); },
    async createLibraryPlaylist() { adapter.createCalls += 1; return { id: "p.new" }; },
    async getLibraryPlaylist() { return { id: "p.tool", name: "Melon Likes Import", canEdit: true }; },
    async getPlaylistTracks() { return [...tracks].map((id) => ({ id: `i.${id}`, catalog_id: id })); },
    async addTracks(_id, ids) { adapter.batches.push([...ids]); for (const id of ids) tracks.add(id); } };
  return adapter;
}

const PRESERVED = ["manualMatches", "importState"];
const readAll = async (config) => Object.fromEntries(await Promise.all(PRESERVED.map(async (key) => [key, await readFile(config.files[key], "utf8")])));

test("sync preview refreshes, matches only new songs, and changes no account or approval data", async (t) => {
  const config = await project(t);
  const before = await readAll(config);
  const melon = newLikes(config), client = lookup(), adapter = fakeAdapter();
  const result = await syncLikes(config, { backend: "web-player", extract: melon.extract, lookupClient: client, writeAdapter: adapter });

  assert.equal(melon.calls[0].refresh, true);
  assert.ok(client.queries.every((query) => !query.includes("Song 1") && !query.includes("Song 2")));
  assert.equal(result.stopped, false);
  assert.deepEqual(result.new_songs.map((s) => [s.melon_song_id, s.match_status]), [["m3", "matched"], ["m4", "not_found"]]);
  assert.deepEqual(result.needs_review.map((s) => s.melon_song_id), ["m4"]);
  assert.deepEqual(result.add_songs.map((s) => s.apple_music_song_id), ["3"]);
  assert.equal(result.playlist.track_count, 2);
  assert.match(result.preview_hash, /^[0-9a-f]{64}$/);
  assert.equal(result.next_command, `node src/cli.js sync --backend web-player --execute --expected-preview ${result.preview_hash}`);
  assert.deepEqual(adapter.batches, []);
  assert.equal(adapter.createCalls, 0);
  assert.deepEqual(await readAll(config), before);
  await readFile(config.files.reviewHtml);

  const report = formatSyncReport(result);
  assert.match(report, /Melon 새 좋아요 2곡/);
  assert.match(report, /수동 검토 필요 1곡 \(not_found 1\)/);
  assert.match(report, /\+ Song 3 — Artist/);
  assert.match(report, /추가하려면: node src\/cli\.js sync --backend web-player --execute --expected-preview/);
});

test("sync stops before matching when extraction is incomplete", async (t) => {
  const config = await project(t);
  const incomplete = sourceDoc([song(1), song(2), song(3)], { complete: false,
    extraction: { stop_reason: "total_mismatch", verified_unique_count: 3, reported_count_gap: -1 } });
  const melon = newLikes(config, incomplete), client = lookup(), adapter = fakeAdapter();
  let checked = false;
  adapter.validateSession = async () => { checked = true; return { storefront: "kr" }; };
  const result = await syncLikes(config, { backend: "web-player", extract: melon.extract, lookupClient: client, writeAdapter: adapter });
  assert.equal(result.stopped, true);
  assert.equal(result.stage, "extract");
  assert.equal(result.stop_reason, "total_mismatch");
  assert.deepEqual(client.queries, []);
  assert.equal(checked, false);
  assert.match(formatSyncReport(result), /Melon 추출이 완료되지 않았습니다 \(stop_reason: total_mismatch/);
  assert.doesNotMatch(formatSyncReport(result), /추가하려면/);
  await assert.rejects(syncLikes(config, { backend: "web-player", execute: true, expectedPreview: "x".repeat(64), writeAdapter: adapter }),
    /매칭·추가로 넘어가지 않았습니다/);
  assert.deepEqual(adapter.batches, []);
});

test("sync execute adds exactly the approved songs, then checks the playlist", async (t) => {
  const config = await project(t);
  const melon = newLikes(config), adapter = fakeAdapter();
  const preview = await syncLikes(config, { backend: "web-player", extract: melon.extract, lookupClient: lookup(), writeAdapter: adapter });

  await assert.rejects(syncLikes(config, { backend: "web-player", execute: true, expectedPreview: "0".repeat(64), writeAdapter: adapter }),
    /새 미리보기/);
  assert.deepEqual(adapter.batches, []);

  const result = await syncLikes(config, { backend: "web-player", execute: true, expectedPreview: preview.preview_hash, writeAdapter: adapter });
  assert.equal(melon.calls.length, 1);
  assert.deepEqual(adapter.batches, [["3"]]);
  assert.equal(adapter.createCalls, 0);
  assert.equal(result.added_this_run, 1);
  assert.equal(result.pending_after, 0);
  assert.equal(result.playlist.track_count, 3);
  assert.equal(result.playlist.duplicate_count, 0);
  assert.deepEqual(JSON.parse(await readFile(config.files.importState)).added_song_ids.sort(), ["1", "2", "3"]);
  assert.match(formatSyncReport(result), /1곡을 추가했습니다\.\n플레이리스트 'Melon Likes Import': 3항목, 남은 대기 0곡, 중복 0건/);

  // The same approval cannot be replayed once the playlist has changed.
  await assert.rejects(syncLikes(config, { backend: "web-player", execute: true, expectedPreview: preview.preview_hash, writeAdapter: adapter }),
    /새 미리보기/);
  assert.equal(adapter.batches.length, 1);
});

test("sync preview with nothing new prints no execute command", async (t) => {
  const config = await project(t);
  const melon = newLikes(config, sourceDoc([song(1), song(2)]));
  const result = await syncLikes(config, { backend: "web-player", extract: melon.extract, lookupClient: lookup(), writeAdapter: fakeAdapter() });
  assert.equal(result.new_songs.length, 0);
  assert.equal(result.add_songs.length, 0);
  assert.equal(result.next_command, null);
  const report = formatSyncReport(result);
  assert.match(report, /추가할 새 곡이 없습니다/);
  assert.doesNotMatch(report, /추가하려면/);
});

test("apply execute refuses a selection that differs from the approved list before writing", async (t) => {
  const config = await project(t);
  const melon = newLikes(config), adapter = fakeAdapter();
  const preview = await syncLikes(config, { backend: "web-player", extract: melon.extract, lookupClient: lookup(), writeAdapter: adapter });
  const { applyPlaylist } = await import("../src/pipeline.js");
  await assert.rejects(applyPlaylist(config, { execute: true, backend: "web-player", maxAdd: 1, expectedAddSongIds: ["999"], writeAdapter: adapter }),
    /승인한 미리보기와 이번 추가 대상이 다릅니다/);
  assert.deepEqual(adapter.batches, []);
  assert.equal(preview.add_songs.length, 1);
});

test("sync requires an explicit backend and a paired execute approval", () => {
  assert.throws(() => parseArgs(["sync"]), /--backend/);
  assert.throws(() => parseArgs(["sync", "--backend", "web-player", "--execute"]), /함께 지정/);
  assert.throws(() => parseArgs(["sync", "--backend", "web-player", "--expected-preview", "abc"]), /함께 지정/);
  assert.throws(() => parseArgs(["sync", "--backend", "web-player", "--max-add", "2"]), /알 수 없는 옵션/);
  assert.deepEqual(parseArgs(["sync", "--backend", "web-player"]).options, { backend: "web-player" });
  assert.equal(parseArgs(["sync", "--help"]).command, "help");
});
