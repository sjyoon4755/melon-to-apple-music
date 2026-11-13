import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { resolveManualMatch } from "../src/pipeline.js";
import { formatDecisionsReport, resolveDecisions } from "../src/bulk-resolve.js";

const song = (id) => ({ melon_song_id: id, title: `원곡 ${id}`, artist: "가수", album: "앨범" });
const apple = (id) => ({ id, title: `Apple ${id}`, artist: "가수", album: "앨범", duration_ms: 200000,
  isrc: null, content_rating: null, url: `https://music.apple.com/kr/album/x/1?i=${id}` });

function lookupClient(known = null) {
  const client = { calls: [], async lookupSongs(ids) {
    client.calls.push([...ids]);
    return ids.filter((id) => !known || known.has(id)).map(apple);
  } };
  return client;
}

async function project(t, { songs = [song("m1"), song("m2"), song("m3")], matched = [], decisions = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-bulk-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  const matchedIds = new Set(matched.map((record) => record.melon_song_id));
  await writeFile(config.files.melonLikes, JSON.stringify({ complete: true, songs }));
  await writeFile(config.files.matched, JSON.stringify({ songs: matched }));
  await writeFile(config.files.unmatched, JSON.stringify({ songs: songs.filter((s) => !matchedIds.has(s.melon_song_id))
    .map((s) => ({ ...s, match_status: "ambiguous", candidates: [] })) }));
  await writeFile(config.files.matchDecisions, JSON.stringify({ schema_version: 1, decisions }));
  const file = path.join(root, "review-decisions.json");
  const write = (entries, extra = {}) => writeFile(file, JSON.stringify({ schema_version: 1, kind: "melon-review-decisions",
    review_fingerprint: "unknown", decisions: entries, ...extra }));
  return { config, file, write };
}

test("bulk preview writes nothing and confirm saves exactly the previewed records", async (t) => {
  const { config, file, write } = await project(t);
  await write([{ melon_song_id: "m1", apple_song_id: "11", source: "candidate" },
    { melon_song_id: "m2", apple_song_id: "12", source: "bulk_top1" }, { melon_song_id: "m3", apple_song_id: "13", source: "url" }]);
  const client = lookupClient();
  const preview = await resolveDecisions(config, { decisionsFile: file, lookupClient: client });
  assert.equal(preview.saved, false);
  assert.deepEqual(preview.counts, { accepted: 3, direct: 2, bulk_top1: 1, already_confirmed: 0, rejected: 0 });
  assert.match(preview.next_command, /--confirm --expected-preview [a-f0-9]{64}$/);
  await assert.rejects(access(config.files.manualMatches));
  assert.match(formatDecisionsReport(preview), /한꺼번에 고름 1/);

  const saved = await resolveDecisions(config, { decisionsFile: file, lookupClient: client, confirm: true, expectedPreview: preview.preview_hash });
  assert.equal(saved.saved, true);
  assert.equal(saved.review_updated, true);
  const manual = JSON.parse(await readFile(config.files.manualMatches, "utf8")).songs;
  assert.deepEqual(manual.map((r) => [r.melon_song_id, r.apple_music_song_id, r.match_status, r.manual_selection ?? null]),
    [["m1", "11", "manual_confirmed", null], ["m2", "12", "manual_confirmed", "bulk_top1"], ["m3", "13", "manual_confirmed", null]]);
  assert.ok(manual.every((r) => r.manual_confirmed_at));
  await access(config.files.reviewHtml);

  const bytes = await readFile(config.files.manualMatches, "utf8");
  const again = await resolveDecisions(config, { decisionsFile: file, lookupClient: client });
  assert.deepEqual(again.counts, { accepted: 0, direct: 0, bulk_top1: 0, already_confirmed: 3, rejected: 0 });
  assert.equal(again.next_command, null);
  assert.equal(await readFile(config.files.manualMatches, "utf8"), bytes);
});

test("a bulk record matches the single resolve record apart from timestamp and selection method", async (t) => {
  const single = await project(t, { songs: [song("m1")] });
  await resolveManualMatch(single.config, { melonSongId: "m1", appleSongId: "11", confirm: true, lookupClient: lookupClient() });
  const bulk = await project(t, { songs: [song("m1")] });
  await bulk.write([{ melon_song_id: "m1", apple_song_id: "11", source: "bulk_top1" }]);
  const preview = await resolveDecisions(bulk.config, { decisionsFile: bulk.file, lookupClient: lookupClient() });
  await resolveDecisions(bulk.config, { decisionsFile: bulk.file, lookupClient: lookupClient(), confirm: true, expectedPreview: preview.preview_hash });
  const strip = ({ manual_confirmed_at, manual_selection, ...rest }) => rest;
  const [a] = JSON.parse(await readFile(single.config.files.manualMatches, "utf8")).songs;
  const [b] = JSON.parse(await readFile(bulk.config.files.manualMatches, "utf8")).songs;
  assert.deepEqual(strip(b), strip(a));
  assert.equal(b.manual_selection, "bulk_top1");
});

test("confirm refuses a stale hash and writes nothing", async (t) => {
  const { config, file, write } = await project(t);
  await write([{ melon_song_id: "m1", apple_song_id: "11", source: "candidate" }]);
  const preview = await resolveDecisions(config, { decisionsFile: file, lookupClient: lookupClient() });
  await resolveManualMatch(config, { melonSongId: "m2", appleSongId: "22", confirm: true, lookupClient: lookupClient() });
  const bytes = await readFile(config.files.manualMatches, "utf8");
  await assert.rejects(resolveDecisions(config, { decisionsFile: file, lookupClient: lookupClient(), confirm: true,
    expectedPreview: preview.preview_hash }), /미리보기를 다시 실행하세요/);
  assert.equal(await readFile(config.files.manualMatches, "utf8"), bytes);
  await assert.rejects(resolveDecisions(config, { decisionsFile: file, confirm: true }), /--expected-preview/);
});

test("guards reject unsafe songs individually and only accepted songs are saved", async (t) => {
  const songs = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map(song);
  const { config, file, write } = await project(t, { songs,
    matched: [{ ...songs[0], match_status: "matched", apple_music_song_id: "90" }] });
  await resolveManualMatch(config, { melonSongId: "m2", appleSongId: "91", confirm: true, lookupClient: lookupClient() });
  await write([
    { melon_song_id: "m1", apple_song_id: "11", source: "candidate" },      // automatic match
    { melon_song_id: "m2", apple_song_id: "12", source: "candidate" },      // already confirmed differently
    { melon_song_id: "m3", apple_song_id: "90", source: "candidate" },      // Apple ID used by another song
    { melon_song_id: "m4", apple_song_id: "14", source: "bulk_top1" },      // duplicate within file
    { melon_song_id: "m5", apple_song_id: "14", source: "candidate" },
    { melon_song_id: "m6", apple_song_id: "404", source: "url" },           // missing from KR lookup
    { melon_song_id: "m7", apple_song_id: "17", source: "url" }             // accepted
  ]);
  const client = lookupClient(new Set(["17"]));
  const preview = await resolveDecisions(config, { decisionsFile: file, lookupClient: client });
  assert.deepEqual(preview.accepted.map((s) => s.melon_song_id), ["m7"]);
  assert.deepEqual(preview.rejected.map((s) => s.melon_song_id).sort(), ["m1", "m2", "m3", "m4", "m5", "m6"]);
  assert.match(preview.rejected.find((s) => s.melon_song_id === "m2").reason, /revise/);
  assert.match(preview.rejected.find((s) => s.melon_song_id === "m6").reason, /lookup에 없습니다/);
  await resolveDecisions(config, { decisionsFile: file, lookupClient: client, confirm: true, expectedPreview: preview.preview_hash });
  const manual = JSON.parse(await readFile(config.files.manualMatches, "utf8")).songs;
  assert.deepEqual(manual.map((r) => [r.melon_song_id, r.apple_music_song_id]), [["m2", "91"], ["m7", "17"]]);
});

test("songs with a local hold decision are routed to revise", async (t) => {
  const songs = [song("m1")];
  const { sourceFingerprint } = await import("../src/run-state.js");
  const { config, file, write } = await project(t, { songs, decisions: [{ action: "hold", melon_song_id: "m1", revision_id: "r1",
    source_fingerprint: sourceFingerprint([songs[0]]), reason: "보류", confirmed_at: "2026-01-01T00:00:00Z",
    before: { ...songs[0], match_status: "ambiguous" } }] });
  await write([{ melon_song_id: "m1", apple_song_id: "11", source: "candidate" }]);
  const preview = await resolveDecisions(config, { decisionsFile: file, lookupClient: lookupClient() });
  assert.equal(preview.counts.accepted, 0);
  assert.match(preview.rejected[0].reason, /revise/);
});

test("lookups are chunked and malformed files are refused before any lookup", async (t) => {
  const songs = Array.from({ length: 51 }, (_, i) => song(`m${i}`));
  const { config, file, write } = await project(t, { songs });
  await write(songs.map((s, i) => ({ melon_song_id: s.melon_song_id, apple_song_id: String(1000 + i), source: "candidate" })));
  const client = lookupClient();
  const preview = await resolveDecisions(config, { decisionsFile: file, lookupClient: client });
  assert.equal(preview.counts.accepted, 51);
  assert.deepEqual(client.calls.map((ids) => ids.length), [50, 1]);

  for (const bad of [
    { decisions: [{ melon_song_id: "m0", apple_song_id: "1", source: "guess" }] },
    { decisions: [{ melon_song_id: "m0", apple_song_id: "abc", source: "url" }] },
    { decisions: [{ melon_song_id: "m0", apple_song_id: "1", source: "url" }, { melon_song_id: "m0", apple_song_id: "2", source: "url" }] },
    { kind: "other", decisions: [] }
  ]) {
    await write(bad.decisions, bad.kind ? { kind: bad.kind } : {});
    const silent = lookupClient();
    await assert.rejects(resolveDecisions(config, { decisionsFile: file, lookupClient: silent }), /결정 파일/);
    assert.equal(silent.calls.length, 0);
  }
});
