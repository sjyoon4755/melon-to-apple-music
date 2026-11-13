import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { readMatchSelection } from "../src/match-decisions.js";
import { resolveUnavailableMatch } from "../src/unavailable-match-command.js";
import { applyPlaylist, localStatus, reviewResults, resolveManualMatch } from "../src/pipeline.js";
import { dataSnapshot } from "../src/apply-lock.js";
import { parseArgs } from "../src/cli-options.js";

const inactive = { melon_song_id: "100", title: "Song", artist: "Artist", album: "Album", reason: "disabled_with_metadata", duration_ms: null };
const awake = { melon_song_id: "91000002", title: "Night Shift", duration_ms: 1466000, match_status: "ambiguous", candidates: [] };
const apple = { id: "900", title: "Song", artist: "Artist", album: "Album", duration_ms: 200000, isrc: "TEST00000001", content_rating: "not_explicit" };
const options = { melonSongId: "100", appleSongId: "900", reason: "Reviewed original recording limitations", lookupClient: { lookupSongs: async () => [apple] } };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-inactive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.files.melonLikes, JSON.stringify({ complete: true, songs: [awake], unavailable_songs: [inactive, { ...inactive, melon_song_id: "101" }] }));
  await writeFile(config.files.unmatched, JSON.stringify({ songs: [awake] }));
  return config;
}

async function save(config) {
  const preview = await resolveUnavailableMatch(config, options);
  return resolveUnavailableMatch(config, { ...options, confirm: true, expectedPreview: preview.preview_hash });
}

test("inactive approval is separate, preview is read-only, source and normal decisions remain intact", async t => {
  const config = await fixture(t);
  const before = await dataSnapshot(config);
  const source = await readFile(config.files.melonLikes, "utf8");
  const normal = await readFile(config.files.unmatched, "utf8");
  const preview = await resolveUnavailableMatch(config, options);
  assert.equal(preview.saved, false);
  assert.equal(preview.same_recording_verified, false);
  assert.equal(preview.remote_play_params_checked, false);
  assert.equal(await dataSnapshot(config), before);
  await assert.rejects(resolveUnavailableMatch(config, { ...options, confirm: true }), /미리보기/);
  await assert.rejects(resolveUnavailableMatch(config, { ...options, confirm: true, expectedPreview: "a".repeat(64) }), /바뀌었습니다/);
  assert.equal((await save(config)).saved, true);
  assert.notEqual(await dataSnapshot(config), before);
  assert.equal(await readFile(config.files.melonLikes, "utf8"), source);
  assert.equal(await readFile(config.files.unmatched, "utf8"), normal);
  await assert.rejects(readFile(config.files.manualMatches), { code: "ENOENT" });
  await assert.rejects(readFile(config.files.importState), { code: "ENOENT" });
  const selection = await readMatchSelection(config);
  assert.deepEqual(selection.records, [awake]);
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.selected[0].source_availability, "unavailable");
  const status = await localStatus(config);
  assert.equal(status.matching.unresolved, 1);
  assert.equal(status.source.unavailable_count, 2);
  assert.deepEqual(status.unavailable_matching, { stored: 1, approved: 1, linked_existing: 0, stale: 0, duplicates: 0, unresolved: 1 });
  assert.equal(status.apply.pending, 1);
  await assert.rejects(resolveUnavailableMatch(config, options), /이미 저장/);
  await reviewResults(config);
  assert.match(await readFile(config.files.reviewHtml, "utf8"), /비활성 원곡의 별도 Apple 대응/);
  assert.match(await readFile(config.files.reviewCsv, "utf8"), /source_availability/);
});

test("changes to candidate or any snapshot input invalidate confirmation", async t => {
  const config = await fixture(t);
  const preview = await resolveUnavailableMatch(config, options);
  await assert.rejects(resolveUnavailableMatch(config, { ...options, lookupClient: { lookupSongs: async () => [{ ...apple, album: "Other" }] }, confirm: true, expectedPreview: preview.preview_hash }), /바뀌었습니다/);
  await writeFile(config.files.importState, JSON.stringify({ added_song_ids: [] }));
  await assert.rejects(resolveUnavailableMatch(config, { ...options, confirm: true, expectedPreview: preview.preview_hash }), /바뀌었습니다/);
  await assert.rejects(readFile(config.files.unavailableMatches), { code: "ENOENT" });
});

test("changed, missing, duplicated or reactivated inactive sources are excluded in every apply mode", async t => {
  const config = await fixture(t);
  await save(config);
  const source = JSON.parse(await readFile(config.files.melonLikes, "utf8"));
  for (const document of [
    { ...source, unavailable_songs: [{ ...inactive, title: "Changed" }] },
    { ...source, unavailable_songs: [] },
    { ...source, unavailable_songs: [inactive, inactive] },
    { ...source, songs: [...source.songs, inactive] },
    { ...source, unavailable_songs: [{ ...inactive, reason: "changed availability evidence" }] }
  ]) {
    await writeFile(config.files.melonLikes, JSON.stringify(document));
    const selection = await readMatchSelection(config);
    assert.equal(selection.selected.length, 0);
    assert.equal(selection.unavailableRecords[0].match_status, "held");
    for (const mode of [{}, { check: true }, { execute: true }]) {
      let accessed = false;
      await assert.rejects(applyPlaylist(config, { ...mode, backend: "web-player", writeAdapter: new Proxy({}, { get: () => { accessed = true; assert.fail("must not access account"); } }) }), /추가할 matched|Apple 적용 실패/);
      assert.equal(accessed, false);
    }
    assert.equal(selection.effective.get("91000002").duration_ms, 1466000);
  }
});

test("unavailable mapping enters dry-run/check/mock execute once and leaves source inactive", async t => {
  const config = await fixture(t);
  await save(config);
  assert.equal((await applyPlaylist(config)).would_add, 1);
  const tracks = [], writes = [];
  const adapter = { backend: "web-player", validateSession: async () => ({ storefront: "kr" }),
    validateCatalogSongs: async ids => ids.map(id => ({ id, attributes: { playParams: { id } } })),
    createLibraryPlaylist: async () => ({ id: "p.test" }),
    getLibraryPlaylist: async () => ({ id: "p.test", canEdit: true }),
    getPlaylistTracks: async () => tracks,
    addTracks: async (_id, ids) => { writes.push(ids); tracks.push(...ids.map(id => ({ catalog_id: id }))); } };
  await applyPlaylist(config, { check: true, backend: "web-player", writeAdapter: adapter });
  assert.equal(writes.length, 0);
  await applyPlaylist(config, { execute: true, backend: "web-player", writeAdapter: adapter });
  await applyPlaylist(config, { execute: true, backend: "web-player", writeAdapter: adapter });
  assert.deepEqual(writes, [["900"]]);
  assert.equal((await localStatus(config)).apply.pending, 0);
  assert.equal(JSON.parse(await readFile(config.files.melonLikes, "utf8")).unavailable_songs.length, 2);
});

test("normal routes, missing KR target, conflicting IDs and checkpoint duplicates fail closed", async t => {
  const config = await fixture(t);
  await assert.rejects(resolveManualMatch(config, options), /찾지 못했습니다/);
  await assert.rejects(resolveUnavailableMatch(config, { ...options, melonSongId: "91000002" }), /비활성 원곡/);
  await assert.rejects(resolveUnavailableMatch(config, { ...options, lookupClient: { lookupSongs: async () => [{ ...apple, id: "901" }] } }), /한국 lookup/);
  await writeFile(config.files.importState, JSON.stringify({ added_song_ids: ["900"] }));
  await assert.rejects(resolveUnavailableMatch(config, options), /중복/);
  await writeFile(config.files.importState, JSON.stringify({ added_song_ids: [] }));
  await writeFile(config.files.manualMatches, JSON.stringify({ songs: [{ ...awake, apple_music_song_id: "900", match_status: "manual_confirmed" }] }));
  await assert.rejects(resolveUnavailableMatch(config, options), /중복/);
});

test("malformed mapping documents stop status, review and apply instead of ignoring approvals", async t => {
  const config = await fixture(t);
  await save(config);
  const valid = JSON.parse(await readFile(config.files.unavailableMatches, "utf8"));
  for (const document of [{ schema_version: 1, mappings: {} }, { ...valid, mappings: [...valid.mappings, ...valid.mappings] },
    { ...valid, mappings: [{ ...valid.mappings[0], source_fingerprint: "a".repeat(64) }] }]) {
    await writeFile(config.files.unavailableMatches, JSON.stringify(document));
    for (const consume of [() => localStatus(config), () => reviewResults(config), () => applyPlaylist(config)]) {
      await assert.rejects(consume, /비활성 대응 판정/);
    }
  }
});

test("a later normal selection of the same Apple ID suppresses inactive duplicate", async t => {
  const config = await fixture(t);
  await save(config);
  await writeFile(config.files.manualMatches, JSON.stringify({ songs: [{ ...awake, match_status: "manual_confirmed", apple_music_song_id: "900" }] }));
  const selection = await readMatchSelection(config);
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.unavailableRecords[0].unavailable_mapping_duplicate, true);
  assert.equal(selection.unavailableRecords[0].match_status, "held");
});

test("review freshness covers inactive approvals and availability evidence changes", async t => {
  const config = await fixture(t);
  await reviewResults(config);
  assert.equal((await localStatus(config)).operations.review.status, "completed");
  await save(config);
  assert.equal((await localStatus(config)).operations.review.status, "stale");
  await reviewResults(config);
  assert.equal((await localStatus(config)).operations.review.status, "completed");
  const source = JSON.parse(await readFile(config.files.melonLikes, "utf8"));
  source.unavailable_songs[0].reason = "changed availability evidence";
  await writeFile(config.files.melonLikes, JSON.stringify(source));
  assert.equal((await localStatus(config)).operations.review.status, "stale");
  assert.equal((await localStatus(config)).unavailable_matching.approved, 0);
});

test("CLI accepts explicit inactive preview/confirmation and rejects account-write flags", () => {
  assert.equal(parseArgs(["resolve-unavailable", "--melon-song-id", "100", "--apple-song-id", "900", "--reason", "review"]).command, "resolve-unavailable");
  assert.throws(() => parseArgs(["resolve-unavailable", "--execute"]), /알 수 없는 옵션/);
});
