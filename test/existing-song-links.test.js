import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { readMatchSelection } from "../src/match-decisions.js";
import { linkExisting, unlinkExisting, localStatus, applyPlaylist, resolveManualMatch, reviseMatch, matchAppleMusic, reviewResults } from "../src/pipeline.js";
import { readExistingLinks, linkDigest, checkRecordingIdentity } from "../src/existing-song-links.js";
import { issueLinkPreview, confirmLinkPreview } from "../src/existing-song-link-commands.js";
import { acquireApplyLock, checkpointTarget } from "../src/apply-lock.js";
import { parseArgs } from "../src/cli-options.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-existing-links-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("melon-existing-links-"));
    await rm(root, { recursive: true, force: true });
  });
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  const save = (file, value) => writeFile(file, JSON.stringify(value));
  const known = { title: "Song (Remastered)", artist: "Northbound", album: "Album [Remastered]",
    isrc: "ZZXYZ2600158", duration_ms: 200000, content_rating: "not_explicit" };
  const source = [{ ...known, melon_song_id: "1" },
    { ...known, melon_song_id: "2", isrc: null, duration_ms: null, content_rating: null },
    { ...known, melon_song_id: "3", album: "Compilation", isrc: null, duration_ms: null, content_rating: null },
    { ...known, melon_song_id: "4", title: "Other", artist: "Other" }];
  const manual = [{ ...source[0], apple_music_song_id: "100", match_status: "manual_confirmed", match_source: "manual-user-confirmed-itunes-lookup-kr" }];
  const unmatched = source.slice(1).map(song => ({ ...song, match_status: "ambiguous", apple_music_song_id: "100" }));
  await save(config.files.melonLikes, { songs: source, complete: false, unavailable_songs: [{ melon_song_id: "9" }], source: { total_reported: 31 }, extraction: { reported_count_gap: 26 } });
  await save(config.files.matched, { songs: [] });
  await save(config.files.unmatched, { songs: unmatched });
  await save(config.files.manualMatches, { songs: manual });
  await save(config.files.matchDecisions, { schema_version: 1, decisions: [] });
  await save(config.files.importState, { backend: "web-player", storefront: "kr", playlist_id: "p.1", added_song_ids: ["100"] });
  const protectedFiles = [config.files.melonLikes, config.files.matched, config.files.unmatched, config.files.manualMatches, config.files.matchDecisions, config.files.importState];
  const baseline = await Promise.all(protectedFiles.map(file => readFile(file, "utf8")));
  const unchanged = async () => assert.deepEqual(await Promise.all(protectedFiles.map(file => readFile(file, "utf8"))), baseline);
  const catalog = { id: "100", type: "songs", attributes: { name: known.title, artistName: known.artist, albumName: known.album,
    isrc: known.isrc, durationInMillis: known.duration_ms, contentRating: known.content_rating,
    playParams: { id: "100" }, releaseDate: "2014-09-29", url: "https://music.apple.com/kr/album/a/10?i=100" } };
  const reads = [], writes = [];
  const adapter = {
    backend: "web-player", tracks: [{ id: "i.100", catalog_id: "100" }], library: { id: "i.100", catalog_id: "100" }, catalog,
    async validateSession() { reads.push("session"); return { storefront: "kr" }; },
    async getLibraryPlaylist(id) { reads.push("playlist"); return { id, canEdit: true }; },
    async getPlaylistTracks() { reads.push("tracks"); return structuredClone(this.tracks); },
    async getLibrarySong() { reads.push("library"); return this.library; },
    async validateCatalogSongs() { reads.push("catalog"); return [structuredClone(this.catalog)]; },
    async createLibraryPlaylist() { writes.push("create"); assert.fail("account create called"); },
    async addTracksToLibraryPlaylist() { writes.push("add"); assert.fail("account add called"); },
    async addTracks() { writes.push("add"); assert.fail("account add called"); }
  };
  const lookupClient = { async lookupSongs(ids) { return ids.map(id => ({ id, ...known, url: catalog.attributes.url })); } };
  const evidence = { schema_version: 1, melon_song_id: "2", anchor_melon_song_id: "1", apple_music_song_id: "100",
    identity_basis: "user_accepted_uncertainty", comparison: "Reviewed singer, remastered version and album; original ISRC, duration and rating are unavailable.",
    references: ["docs/reviewed-recording.md"], accepted_uncertainties: ["source_isrc_unknown", "source_duration_unknown", "source_rating_unknown"] };
  const evidenceFile = path.join(root, "evidence.json");
  await save(evidenceFile, evidence);
  const options = { melonSongId: "2", anchorMelonSongId: "1", appleSongId: "100", backend: "web-player", evidenceFile,
    reason: "Reviewed this exact additional source", readAdapter: adapter, lookupClient };
  return { config, root, source, unmatched, manual, known, adapter, reads, writes, lookupClient, options, evidence, evidenceFile, save, unchanged };
}

async function approve(f, overrides = {}) {
  const options = { ...f.options, ...overrides };
  const preview = await linkExisting(f.config, options);
  const confirmed = { ...options, confirm: true, expectedPreview: preview.preview_hash };
  return { preview, confirmed, result: await linkExisting(f.config, confirmed) };
}

async function inactiveFixture(t) {
  const f = await fixture(t);
  const raw = { melon_song_id: "9", availability: "unavailable" };
  const artists = [{ id: "71", name: f.known.artist }];
  f.source[0].artists = artists.map(artist => artist.name);
  const sourceDocument = { songs: f.source, unavailable_songs: [raw, { melon_song_id: "10" }] };
  await f.save(f.config.files.melonLikes, sourceDocument);
  const evidence = { ...f.evidence, melon_song_id: "9", identity_basis: "user_accepted_confirmed_anchor",
    accepted_uncertainties: [...f.evidence.accepted_uncertainties, "album_differs", "release_date_differs", "confirmed_anchor_recording_unverified"],
    unavailable_origin: { artists, release_date: "2013-01-01", document: {
      schema_version: 1, melon_song_id: "9", apple_music_song_id: "100", operating_source_sha256: linkDigest(raw),
      public_metadata: { title: f.known.title, artist: f.known.artist, album: "Earlier release", album_id: "20",
        isrc: null, duration_ms: null, content_rating: null },
      provenance: { song_url: "https://www.melon.com/song/detail.htm?songId=9", album_url: "https://www.melon.com/album/detail.htm?albumId=20",
        checked_at: "2026-11-05T00:00:00Z", method: "official-public-page-GET" },
      comparison: "Same public credits; different release", limitations: ["Original ISRC and master unknown"] } } };
  await f.save(f.evidenceFile, evidence);
  f.options.melonSongId = "9";
  return { ...f, evidence, sourceDocument, raw };
}

test("inactive link previews public evidence, then isolated approval and unlink affect only the link journal and counts", async t => {
  const f = await inactiveFixture(t), sourceBefore = await readFile(f.config.files.melonLikes, "utf8");
  const preview = await linkExisting(f.config, f.options);
  assert.equal(preview.approval_required, true);
  assert.equal(preview.saved, false);
  assert.deepEqual(preview.before.source, f.raw);
  assert.deepEqual(preview.unavailable_origin, f.evidence.unavailable_origin);
  assert.deepEqual(preview.counts.unavailable_unresolved, { before: 2, after: 1 });
  assert.deepEqual(preview.counts.unique_apple_targets, { before: 1, after: 1 });
  await assert.rejects(access(f.config.files.existingSongLinks));
  const confirmed = { ...f.options, confirm: true, expectedPreview: preview.preview_hash };
  assert.equal((await linkExisting(f.config, confirmed)).saved, true);
  assert.equal((await linkExisting(f.config, confirmed)).already_linked, true);
  const selection = await readMatchSelection(f.config);
  assert.deepEqual(selection.selected.map(row => row.melon_song_id), ["1"]);
  assert.equal(selection.effective.has("9"), false);
  assert.equal(selection.unavailableRecords[0].match_status, "linked_existing");
  assert.equal(selection.links.active.length, 1);
  const status = await localStatus(f.config);
  assert.equal(status.unavailable_matching.linked_existing, 1);
  assert.equal(status.unavailable_matching.unresolved, 1);
  assert.equal(status.matching.linked_existing, 0);
  assert.equal(status.apply.pending, 0);
  assert.equal(status.apply.checkpoint_total_unique, 1);
  const apply = { check: true, backend: "web-player", writeAdapter: f.adapter };
  assert.equal((await applyPlaylist(f.config, apply)).pending_verified, 0);
  f.adapter.tracks[0].id = f.adapter.library.id = "i.replaced";
  await assert.rejects(applyPlaylist(f.config, apply), /보관함 리소스가 변경/);
  const unlink = { melonSongId: "9", reason: "Return to review" };
  const cancellation = await unlinkExisting(f.config, unlink);
  assert.equal(cancellation.after, "unavailable");
  assert.equal((await unlinkExisting(f.config, { ...unlink, confirm: true, expectedPreview: cancellation.preview_hash })).saved, true);
  assert.equal((await localStatus(f.config)).unavailable_matching.unresolved, 2);
  assert.deepEqual((await readExistingLinks(f.config)).events.map(event => event.action), ["link", "unlink"]);
  assert.equal(await readFile(f.config.files.melonLikes, "utf8"), sourceBefore);
  await assert.rejects(access(f.config.files.unavailableMatches));
  assert.deepEqual(f.writes, []);
});

test("inactive link rejects wrong public evidence, a nonmanual anchor and a changed or reactivated origin", async t => {
  const f = await inactiveFixture(t);
  const document = f.evidence.unavailable_origin.document;
  await f.save(f.evidenceFile, { ...f.evidence, unavailable_origin: { ...f.evidence.unavailable_origin,
    document: { ...document, operating_source_sha256: "a".repeat(64) } } });
  await assert.rejects(linkExisting(f.config, f.options), /원본 해시/);
  await f.save(f.evidenceFile, f.evidence);
  await f.save(f.config.files.manualMatches, { songs: [] });
  await f.save(f.config.files.matched, { songs: [{ ...f.manual[0], match_status: "matched" }] });
  await assert.rejects(linkExisting(f.config, f.options), /수동 승인/);
  await f.save(f.config.files.manualMatches, { songs: f.manual });
  const { result } = await approve(f);
  assert.equal(result.saved, true);
  f.raw.availability = "changed";
  await f.save(f.config.files.melonLikes, f.sourceDocument);
  assert.equal((await localStatus(f.config)).matching.stale_links, 1);
  assert.equal((await localStatus(f.config)).unavailable_matching.linked_existing, 0);
  f.sourceDocument.unavailable_songs.shift();
  f.sourceDocument.songs.push({ ...f.source[0], melon_song_id: "9" });
  await f.save(f.config.files.melonLikes, f.sourceDocument);
  assert.equal((await readMatchSelection(f.config)).effective.get("9").match_status, "held");
  assert.deepEqual(f.writes, []);
});

test("inactive link accepts only ASCII title case differences and preserves the public title in the preview", async t => {
  const f = await inactiveFixture(t);
  f.source[0].title = "a hundred lanterns";
  await f.save(f.config.files.melonLikes, f.sourceDocument);
  const metadata = f.evidence.unavailable_origin.document.public_metadata;
  metadata.title = "A Hundred Lanterns";
  await f.save(f.evidenceFile, f.evidence);
  const preview = await linkExisting(f.config, f.options);
  assert.equal(preview.source.title, "A Hundred Lanterns");
  assert.equal(preview.anchor.title, "a hundred lanterns");
  assert.equal(preview.saved, false);
  assert.equal(preview.approval_required, true);

  for (const title of ["A Hundred Lanterns (Live)", "A Hundred  Lanterns", "A Hundred Lanterns!", "À Hundred Lanterns"]) {
    metadata.title = title;
    await f.save(f.evidenceFile, f.evidence);
    await assert.rejects(linkExisting(f.config, f.options), /정확히 같은 원본 제목/);
  }
  metadata.title = "A Hundred Lanterns";
  metadata.artist = f.known.artist.toLowerCase();
  await f.save(f.evidenceFile, f.evidence);
  await assert.rejects(linkExisting(f.config, f.options), /정확히 같은 원본 제목/);

  metadata.artist = f.known.artist;
  metadata.title = "Écho";
  f.source[0].title = "écho";
  await f.save(f.config.files.melonLikes, f.sourceDocument);
  await f.save(f.evidenceFile, f.evidence);
  await assert.rejects(linkExisting(f.config, f.options), /정확히 같은 원본 제목/);

  const normalEvidence = { ...f.evidence, melon_song_id: "2" };
  delete normalEvidence.unavailable_origin;
  f.source[0].title = "a hundred lanterns";
  f.source[1].title = "A Hundred Lanterns";
  await f.save(f.config.files.melonLikes, f.sourceDocument);
  await f.save(f.evidenceFile, normalEvidence);
  await assert.rejects(linkExisting(f.config, { ...f.options, melonSongId: "2" }), /정확히 같은 원본 제목/);
  await assert.rejects(access(f.config.files.existingSongLinks));
  assert.deepEqual(f.writes, []);
});

test("explicit confirmed-anchor basis links identical raw origins despite cross-script catalog credits", async t => {
  const f = await fixture(t);
  const raw = { title: "밤마중 (With 김하늘 Of 은빛정원)", artist: "MIDNIGHT WORKS" };
  Object.assign(f.source[0], raw); Object.assign(f.source[1], raw); Object.assign(f.manual[0], raw); Object.assign(f.unmatched[0], raw);
  Object.assign(f.adapter.catalog.attributes, { name: "밤마중 (feat. Kim Ha Neul)", artistName: "미드나잇 웍스" });
  f.lookupClient.lookupSongs = async ids => ids.map(id => ({ id, ...f.known, title: f.adapter.catalog.attributes.name, artist: f.adapter.catalog.attributes.artistName }));
  await f.save(f.config.files.melonLikes, { songs: f.source }); await f.save(f.config.files.manualMatches, { songs: f.manual });
  await f.save(f.config.files.unmatched, { songs: f.unmatched });
  await assert.rejects(linkExisting(f.config, f.options), /가수·참여 가수/);
  const evidence = { ...f.evidence, identity_basis: "user_accepted_confirmed_anchor" };
  await f.save(f.evidenceFile, evidence);
  await assert.rejects(linkExisting(f.config, f.options), /confirmed_anchor_recording_unverified/);
  evidence.accepted_uncertainties = [...evidence.accepted_uncertainties, "confirmed_anchor_recording_unverified"];
  await f.save(f.evidenceFile, evidence);
  const sourceBefore = await readFile(f.config.files.melonLikes, "utf8");
  const { result } = await approve(f);
  assert.equal(result.saved, true); assert.equal(result.identity_basis, "user_accepted_confirmed_anchor");
  assert.equal((await localStatus(f.config)).matching.linked_existing, 1);
  assert.equal(await readFile(f.config.files.melonLikes, "utf8"), sourceBefore); assert.deepEqual(f.writes, []);
  assert.match(await readFile(f.config.files.reviewHtml, "utf8"), /동일 녹음은 미입증/);
  f.source[0].title += " (Live)"; await f.save(f.config.files.melonLikes, { songs: f.source });
  assert.equal((await localStatus(f.config)).matching.stale_links, 1);
});

test("confirmed-anchor basis rejects mismatched origins, nonmanual anchors, IDs and known contradictions", () => {
  const source = { melon_song_id: "2", title: "Song (With Guest)", artist: "Artist", artists: ["Artist"], album: "EP" };
  const anchor = { ...source, melon_song_id: "1", album: "Single" };
  const target = { id: "100", title: "다른 표기", artist: "다른 표기", album: "Single", isrc: "ISRC1", duration_ms: 200000, content_rating: "explicit" };
  const selection = { melon_song_id: "1", apple_music_song_id: "100", match_status: "manual_confirmed" };
  const evidence = { melon_song_id: "2", anchor_melon_song_id: "1", apple_music_song_id: "100", identity_basis: "user_accepted_confirmed_anchor",
    accepted_uncertainties: ["source_isrc_unknown", "source_duration_unknown", "source_rating_unknown", "album_differs", "confirmed_anchor_recording_unverified"] };
  const check = (s = source, a = anchor, sel = selection, tar = target) => checkRecordingIdentity(s, tar, evidence, { source: a, selection: sel });
  assert.doesNotThrow(() => check());
  for (const changed of [{ title: "Song (Live)" }, { artist: "Other" }, { artists: ["Artist", "Guest"] }, { melon_song_id: "3" },
    { isrc: "ISRC2" }, { duration_ms: 220000 }, { content_rating: "not_explicit" }]) {
    assert.throws(() => check({ ...source, ...changed }));
  }
  for (const changed of [{ isrc: "ISRC2" }, { duration_ms: 220000 }, { content_rating: "not_explicit" }, { title: "Song (Remix)" }]) {
    assert.throws(() => check(source, { ...anchor, ...changed }));
  }
  for (const changed of [{ match_status: "matched" }, { match_status: "linked_existing" }, { apple_music_song_id: "101" }, { melon_song_id: "3" }]) {
    assert.throws(() => check(source, anchor, { ...selection, ...changed }));
  }
  assert.throws(() => check(source, anchor, selection, { ...target, id: "101" }));
  assert.throws(() => checkRecordingIdentity(source, target, evidence));
});

test("link preview verifies reads, records a bounded preview, and leaves the journal/account/input files untouched", async t => {
  const f = await fixture(t), preview = await linkExisting(f.config, f.options);
  assert.equal(preview.saved, false); assert.equal(preview.account_changed, false); assert.equal(preview.checkpoint_changed, false);
  assert.deepEqual(preview.existing_origins, ["1"]); assert.equal(preview.after, "linked_existing");
  assert.match(preview.preview_hash, /^[a-f0-9]{64}$/); assert.equal(preview.remote_evidence.playlist_occurrences, 1);
  assert.deepEqual(preview.counts.resolved_sources, { before: 1, after: 2 });
  assert.deepEqual(preview.counts.unique_apple_targets, { before: 1, after: 1 });
  assert.deepEqual(f.reads, ["session", "playlist", "tracks", "library", "catalog"]); assert.deepEqual(f.writes, []);
  await assert.rejects(access(f.config.files.existingSongLinks)); await f.unchanged();
});

test("confirmed link resolves one source while unique Apple selection/checkpoint/pending remain unchanged", async t => {
  const f = await fixture(t), { result } = await approve(f);
  assert.equal(result.saved, true); assert.equal(result.review_updated, true);
  const status = await localStatus(f.config), selection = await readMatchSelection(f.config);
  assert.equal(status.matching.resolved_sources, 2); assert.equal(status.matching.linked_existing, 1);
  assert.equal(status.matching.unresolved, 2); assert.equal(status.apply.selected_unique, 1); assert.equal(status.apply.pending, 0);
  assert.equal(status.apply.checkpoint_total_unique, 1); assert.equal(status.source.complete, false); assert.equal(status.source.reported_count_gap, 26);
  assert.deepEqual(selection.selected.map(record => record.melon_song_id), ["1"]);
  assert.equal(selection.effective.get("2").match_status, "linked_existing");
  assert.match(await readFile(f.config.files.reviewCsv, "utf8"), /linked_existing/);
  const html = await readFile(f.config.files.reviewHtml, "utf8");
  assert.match(html, /기존 이관 곡에 연결/); assert.match(html, /확정 원곡 2곡/); assert.match(html, /선택 고유 Apple 대상 1곡/);
  assert.match(html, /value="linked_existing"/); assert.equal(status.operations.review.status, "completed");
  await f.unchanged(); assert.deepEqual(f.writes, []);
});

test("duplicate confirm after lost output is idempotent and cannot accept another preview or overwrite evidence", async t => {
  const f = await fixture(t), { confirmed, result } = await approve(f);
  const before = await readFile(f.config.files.existingSongLinks, "utf8");
  const repeated = await linkExisting(f.config, confirmed);
  assert.equal(repeated.saved, false); assert.equal(repeated.already_linked, true); assert.equal(repeated.revision_id, result.revision_id);
  assert.equal(await readFile(f.config.files.existingSongLinks, "utf8"), before);
  await assert.rejects(linkExisting(f.config, { ...confirmed, expectedPreview: "0".repeat(64) }), /preview hash/);
  await assert.rejects(linkExisting(f.config, { ...f.options, reason: "Changed approval" }), /덮어쓰지/);
  await f.unchanged(); assert.deepEqual(f.writes, []);
});

test("two separately approved origins link to one target without linking chains", async t => {
  const f = await fixture(t); await approve(f);
  const third = { ...f.evidence, melon_song_id: "3", accepted_uncertainties: [...f.evidence.accepted_uncertainties, "album_differs"] };
  await f.save(f.evidenceFile, third);
  await approve(f, { melonSongId: "3" });
  const status = await localStatus(f.config);
  assert.equal(status.matching.resolved_sources, 3); assert.equal(status.matching.linked_existing, 2); assert.equal(status.apply.selected_unique, 1);
  await f.save(f.evidenceFile, { ...third, anchor_melon_song_id: "2" });
  await assert.rejects(linkExisting(f.config, { ...f.options, melonSongId: "3", anchorMelonSongId: "2" }), /기준 원곡/);
  await f.unchanged();
});

test("missing ISRC is uncertainty, never recording proof; all missing/different fields require explicit acceptance", async t => {
  const f = await fixture(t);
  await f.save(f.evidenceFile, { ...f.evidence, identity_basis: "recording_evidence" });
  await assert.rejects(linkExisting(f.config, f.options), /일치하는 ISRC/);
  await f.save(f.evidenceFile, { ...f.evidence, accepted_uncertainties: [] });
  await assert.rejects(linkExisting(f.config, f.options), /source_isrc_unknown/);
  await f.save(f.evidenceFile, { ...f.evidence, melon_song_id: "3" });
  await assert.rejects(linkExisting(f.config, { ...f.options, melonSongId: "3" }), /album_differs/);
  await assert.rejects(access(f.config.files.existingSongLinks)); await f.unchanged();
});

test("current source ISRC and version-compatible metadata can support recording_evidence", async t => {
  const f = await fixture(t); Object.assign(f.source[1], f.known);
  Object.assign(f.unmatched[0], f.known); await f.save(f.config.files.melonLikes, { songs: f.source });
  await f.save(f.config.files.unmatched, { songs: f.unmatched });
  await f.save(f.evidenceFile, { ...f.evidence, identity_basis: "recording_evidence", accepted_uncertainties: [] });
  const { result } = await approve(f); assert.equal(result.identity_basis, "recording_evidence");
});

test("held/confirmed/inactive/missing/duplicate origins are not eligible for a new link", async t => {
  for (const kind of ["held", "confirmed", "inactive", "missing", "duplicate"]) {
    const f = await fixture(t);
    if (kind === "held") { f.unmatched[0].match_status = "held"; await f.save(f.config.files.unmatched, { songs: f.unmatched }); }
    if (kind === "confirmed") await f.save(f.config.files.manualMatches, { songs: [...f.manual, { ...f.source[1], match_status: "manual_confirmed", apple_music_song_id: "101" }] });
    if (kind === "inactive") await f.save(f.config.files.melonLikes, { songs: f.source, unavailable_songs: [f.source[1]] });
    if (kind === "missing") await f.save(f.config.files.melonLikes, { songs: f.source.filter(song => song.melon_song_id !== "2") });
    if (kind === "duplicate") await f.save(f.config.files.melonLikes, { songs: [...f.source, f.source[1]] });
    await assert.rejects(linkExisting(f.config, f.options)); await assert.rejects(access(f.config.files.existingSongLinks)); assert.deepEqual(f.writes, []);
  }
});

test("changing the anchor or its participant array invalidates a saved link", async t => {
  for (const change of [f => { f.manual[0].apple_music_song_id = "101"; }, f => { f.source[0].artists = ["Northbound", "Other singer"]; }]) {
    const f = await fixture(t); await approve(f); change(f);
    await f.save(f.config.files.manualMatches, { songs: f.manual }); await f.save(f.config.files.melonLikes, { songs: f.source });
    const status = await localStatus(f.config);
    assert.equal(status.matching.linked_existing, 0); assert.equal(status.matching.stale_links, 1);
    assert.equal((await readMatchSelection(f.config)).effective.get("2").match_status, "held");
  }
});

test("unknown target grade/duration also require explicit uncertainty acceptance", async t => {
  const f = await fixture(t); f.adapter.catalog.attributes.contentRating = null; delete f.adapter.catalog.attributes.durationInMillis;
  await assert.rejects(linkExisting(f.config, f.options), /target_duration_unknown|target_rating_unknown/);
  await f.save(f.evidenceFile, { ...f.evidence, accepted_uncertainties: [...f.evidence.accepted_uncertainties, "target_duration_unknown", "target_rating_unknown"] });
  assert.equal((await approve(f)).result.saved, true);
});

test("concurrent previews remain distinct and cancel/relink history is an ordered append-only chain", async t => {
  const f = await fixture(t), previews = await Promise.all([linkExisting(f.config, f.options), linkExisting(f.config, f.options)]);
  assert.notEqual(previews[0].preview_hash, previews[1].preview_hash);
  await linkExisting(f.config, { ...f.options, confirm: true, expectedPreview: previews[0].preview_hash });
  const opts = { melonSongId: "2", reason: "Cancel first link" }, preview = await unlinkExisting(f.config, opts);
  await unlinkExisting(f.config, { ...opts, confirm: true, expectedPreview: preview.preview_hash });
  await approve(f);
  const events = (await readExistingLinks(f.config)).events;
  assert.deepEqual(events.map(event => event.action), ["link", "unlink", "link"]);
  assert.equal(events[2].previous_revision, events[1].revision_id);
});

test("multiple aliases reuse a complete playlist scan and check one library/catalog resource per unique target", async t => {
  const f = await fixture(t); await approve(f);
  await f.save(f.evidenceFile, { ...f.evidence, melon_song_id: "3", accepted_uncertainties: [...f.evidence.accepted_uncertainties, "album_differs"] });
  await approve(f, { melonSongId: "3" }); f.reads.length = 0;
  const result = await applyPlaylist(f.config, { backend: "web-player", check: true, writeAdapter: f.adapter });
  assert.equal(result.linked_remote_validation.results.length, 2);
  assert.equal(f.reads.filter(name => name === "tracks").length, 1);
  assert.equal(f.reads.filter(name => name === "library").length, 1);
});

for (const [label, change] of [
  ["wrong artist", f => { f.source[1].artist = "Different Artist"; }],
  ["live recording", f => { f.source[1].title = "Song (Live)"; }],
  ["known rating conflict", f => { f.source[1].content_rating = "explicit"; }],
  ["conflicting ISRC", f => { f.source[1].isrc = "OTHER0000001"; }],
  ["large duration conflict", f => { f.source[1].duration_ms = 300000; }]
]) test(`identity cannot be bypassed by accepting uncertainty: ${label}`, async t => {
  const f = await fixture(t); change(f); await f.save(f.config.files.melonLikes, { songs: f.source });
  await assert.rejects(linkExisting(f.config, f.options), /가수|버전|등급|ISRC|재생시간/);
  await assert.rejects(access(f.config.files.existingSongLinks)); assert.deepEqual(f.writes, []);
});

for (const [label, change] of [
  ["playlist missing", f => { f.adapter.getLibraryPlaylist = async () => null; }],
  ["playlist empty", f => { f.adapter.tracks = []; }],
  ["duplicate occurrence", f => { f.adapter.tracks.push({ id: "i.second", catalog_id: "100" }); }],
  ["unmapped playlist resource", f => { f.adapter.tracks.push({ id: "i.unknown", catalog_id: null }); }],
  ["library missing", f => { f.adapter.library = null; }],
  ["library wrong catalog", f => { f.adapter.library.catalog_id = "999"; }],
  ["catalog wrong playParams", f => { f.adapter.catalog.attributes.playParams.id = "999"; }],
  ["foreign storefront", f => { f.adapter.validateSession = async () => ({ storefront: "us" }); }],
  ["lookup/catalog changed", f => { f.adapter.catalog.attributes.name = "Different"; }]
]) test(`remote preconditions fail closed: ${label}`, async t => {
  const f = await fixture(t); change(f);
  await assert.rejects(linkExisting(f.config, f.options));
  await assert.rejects(access(f.config.files.existingSongLinks)); await f.unchanged(); assert.deepEqual(f.writes, []);
});

test("backend and checkpoint membership must match; no new playlist or repair is attempted", async t => {
  const f = await fixture(t);
  await assert.rejects(linkExisting(f.config, { ...f.options, backend: "official" }), /KR storefront/);
  await f.save(f.config.files.importState, { backend: "web-player", storefront: "kr", playlist_id: "p.1", added_song_ids: [] });
  await assert.rejects(linkExisting(f.config, f.options), /checkpoint/); assert.deepEqual(f.writes, []);
});

test("network/auth exceptions are redacted and confirmation does not write after an interrupted GET", async t => {
  const f = await fixture(t), preview = await linkExisting(f.config, f.options);
  f.adapter.getLibrarySong = async () => { throw new Error("SECRET bearer cookie response"); };
  await assert.rejects(linkExisting(f.config, { ...f.options, confirm: true, expectedPreview: preview.preview_hash }), error => {
    assert.match(error.message, /읽기 전용 검사가 실패/); assert.doesNotMatch(error.message, /SECRET|bearer|cookie/); return true;
  });
  await assert.rejects(access(f.config.files.existingSongLinks)); await f.unchanged();
});

test("changing source, evidence, another decision or catalog after preview invalidates approval", async t => {
  for (const change of [
    async f => { f.source[1].album = "Changed album"; await f.save(f.config.files.melonLikes, { songs: f.source }); },
    async f => { await f.save(f.evidenceFile, { ...f.evidence, comparison: "Another concrete review" }); },
    async f => { await f.save(f.config.files.manualMatches, { songs: [...f.manual, { ...f.source[3], apple_music_song_id: "101", match_status: "manual_confirmed" }] }); },
    async f => { f.adapter.catalog.attributes.releaseDate = "2020-01-01"; }
  ]) {
    const f = await fixture(t), preview = await linkExisting(f.config, f.options); await change(f);
    await assert.rejects(linkExisting(f.config, { ...f.options, confirm: true, expectedPreview: preview.preview_hash }));
    await assert.rejects(access(f.config.files.existingSongLinks)); assert.deepEqual(f.writes, []);
  }
});

test("preview hashes are integrity checked and expire, with no real-time wait", async t => {
  const f = await fixture(t), payload = { test: "fixed payload" };
  const issued = await issueLinkPreview(f.config, payload, 1000000);
  await confirmLinkPreview(f.config, issued.preview_hash, payload, 1000001);
  await assert.rejects(confirmLinkPreview(f.config, issued.preview_hash, payload, 1600001), /10분/);
  await assert.rejects(confirmLinkPreview(f.config, issued.preview_hash, { test: "changed" }, 1000001), /입력이 바뀌/);
  const file = path.join(f.config.stateDir, "existing-link-previews", `${issued.preview_hash}.json`);
  const stored = JSON.parse(await readFile(file)); stored.expires_at = new Date(99999999).toISOString(); await f.save(file, stored);
  await assert.rejects(confirmLinkPreview(f.config, issued.preview_hash, payload, 1000001), /미리보기/);
});

test("local inputs changed during GET cannot be silently approved", async t => {
  const f = await fixture(t), original = f.adapter.getLibrarySong;
  f.adapter.getLibrarySong = async function (...args) {
    await f.save(f.config.files.manualMatches, { songs: [...f.manual, { ...f.source[3], apple_music_song_id: "101", match_status: "manual_confirmed" }] });
    return original.apply(this, args);
  };
  await assert.rejects(linkExisting(f.config, f.options), /로컬 입력이 바뀌/);
  await assert.rejects(access(f.config.files.existingSongLinks));
});

test("source/base/anchor drift becomes a held stale link without reviving a new automatic target", async t => {
  const f = await fixture(t); await approve(f);
  f.unmatched[0].match_status = "matched"; f.unmatched[0].apple_music_song_id = "777";
  await f.save(f.config.files.unmatched, { songs: f.unmatched });
  const selection = await readMatchSelection(f.config), status = await localStatus(f.config);
  assert.equal(selection.effective.get("2").match_status, "held"); assert.equal(status.matching.stale_links, 1);
  assert.deepEqual(selection.selected.map(record => record.apple_music_song_id), ["100"]);
  await assert.rejects(applyPlaylist(f.config, { backend: "web-player", check: true, writeAdapter: f.adapter }), /기존 곡 연결/);
  await assert.rejects(applyPlaylist(f.config, { backend: "web-player", execute: true, writeAdapter: f.adapter }), /Apple 적용 실패/);
  assert.deepEqual(f.writes, []);
});

test("deleted source stays in historical orphan links until an offline unlink", async t => {
  const f = await fixture(t); await approve(f);
  await f.save(f.config.files.melonLikes, { songs: f.source.filter(song => song.melon_song_id !== "2") });
  assert.equal((await localStatus(f.config)).matching.orphan_links, 1);
  await assert.rejects(applyPlaylist(f.config, { backend: "web-player", check: true, writeAdapter: f.adapter }), /기존 곡 연결/);
  const opts = { melonSongId: "2", reason: "Source removed" }, preview = await unlinkExisting(f.config, opts);
  assert.equal(preview.after, "orphan_cancelled");
  const saved = await unlinkExisting(f.config, { ...opts, confirm: true, expectedPreview: preview.preview_hash });
  assert.equal(saved.saved, true); assert.equal((await readExistingLinks(f.config)).events.length, 2);
});

test("unlink is offline and idempotent, restores unresolved state, and never deletes checkpoint/account music", async t => {
  const f = await fixture(t); await approve(f);
  const beforeReads = f.reads.length, opts = { melonSongId: "2", reason: "Cancel association only" };
  const preview = await unlinkExisting(f.config, opts);
  assert.equal(preview.after, "ambiguous");
  assert.deepEqual(preview.counts.resolved_sources, { before: 2, after: 1 });
  const result = await unlinkExisting(f.config, { ...opts, confirm: true, expectedPreview: preview.preview_hash });
  assert.equal(result.saved, true); assert.equal(f.reads.length, beforeReads);
  assert.equal((await localStatus(f.config)).matching.linked_existing, 0);
  assert.equal((await readMatchSelection(f.config)).effective.get("2").match_status, "ambiguous");
  const again = await unlinkExisting(f.config, { ...opts, confirm: true, expectedPreview: preview.preview_hash });
  assert.equal(again.already_unlinked, true); assert.equal((await readExistingLinks(f.config)).events.length, 2);
  await f.unchanged(); assert.deepEqual(f.writes, []);
});

test("cancelled link cannot silently revive changed automatic output; explicit resolve binds its cancel revision", async t => {
  const f = await fixture(t); await approve(f);
  f.unmatched[0].match_status = "matched"; f.unmatched[0].apple_music_song_id = "777";
  await f.save(f.config.files.unmatched, { songs: f.unmatched });
  const opts = { melonSongId: "2", reason: "Cancel stale link" }, preview = await unlinkExisting(f.config, opts);
  await unlinkExisting(f.config, { ...opts, confirm: true, expectedPreview: preview.preview_hash });
  assert.equal((await readMatchSelection(f.config)).effective.get("2").match_status, "held");
  const resolveOpts = { melonSongId: "2", appleSongId: "101", lookupClient: f.lookupClient };
  await assert.rejects(resolveManualMatch(f.config, { ...resolveOpts, confirm: true }), /expected-preview/);
  const resolvePreview = await resolveManualMatch(f.config, resolveOpts);
  const resolved = await resolveManualMatch(f.config, { ...resolveOpts, confirm: true, expectedPreview: resolvePreview.preview_hash });
  assert.equal(resolved.saved, true); assert.equal((await readMatchSelection(f.config)).effective.get("2").match_status, "manual_confirmed");
  assert.equal((await resolveManualMatch(f.config, { ...resolveOpts, confirm: true, expectedPreview: resolvePreview.preview_hash })).already_confirmed, true);
  assert.equal((await localStatus(f.config)).apply.pending, 1); assert.deepEqual(f.writes, []);
});

test("active link cannot be overwritten through resolve/revise and checkpoint target is not re-added in apply modes", async t => {
  const f = await fixture(t); await approve(f);
  await assert.rejects(resolveManualMatch(f.config, { melonSongId: "2", appleSongId: "101", lookupClient: f.lookupClient }), /unlink-existing/);
  await assert.rejects(reviseMatch(f.config, { melonSongId: "2", hold: true, reason: "Override" }), /unlink-existing/);
  const dry = await applyPlaylist(f.config, { backend: "web-player" }); assert.equal(dry.would_add, 0);
  const checked = await applyPlaylist(f.config, { backend: "web-player", check: true, writeAdapter: f.adapter });
  assert.equal(checked.linked_remote_validation.checked, true); assert.equal(checked.pending_verified, 0);
  const executed = await applyPlaylist(f.config, { backend: "web-player", execute: true, writeAdapter: f.adapter, maxAdd: 1 });
  assert.equal(executed.added_this_run, 0); assert.deepEqual(f.writes, []);
});

test("remote drift after a saved link stops apply without repair or leaking adapter diagnostics", async t => {
  const f = await fixture(t); await approve(f);
  f.adapter.catalog.attributes.releaseDate = "2020-01-01";
  await assert.rejects(applyPlaylist(f.config, { backend: "web-player", check: true, writeAdapter: f.adapter }), /메타데이터가 변경/);
  f.adapter.getLibrarySong = async () => { throw new Error("SECRET transport payload"); };
  await assert.rejects(applyPlaylist(f.config, { backend: "web-player", check: true, writeAdapter: f.adapter }), error => {
    assert.doesNotMatch(error.message, /SECRET|transport/); return true;
  });
  assert.deepEqual(f.writes, []);
});

test("applying an unrelated approved target posts it once without including linked origins", async t => {
  const f = await fixture(t); await approve(f);
  await f.save(f.config.files.manualMatches, { songs: [...f.manual, { ...f.source[3], match_status: "manual_confirmed", apple_music_song_id: "101" }] });
  const batches = [];
  f.adapter.validateCatalogSongs = async ids => ids.map(id => ({ ...structuredClone(f.adapter.catalog), id, attributes: { ...f.adapter.catalog.attributes, playParams: { id } } }));
  f.adapter.addTracks = async (_playlist, ids) => {
    batches.push(ids); f.adapter.tracks.push(...ids.map(id => ({ id: `i.${id}`, catalog_id: id })));
  };
  const result = await applyPlaylist(f.config, { backend: "web-player", execute: true, maxAdd: 1, writeAdapter: f.adapter });
  assert.equal(result.added_this_run, 1); assert.deepEqual(batches, [["101"]]);
  assert.deepEqual(result.selected_add_songs[0].melon_songs.map(song => song.melon_song_id), ["4"]);
  assert.deepEqual(JSON.parse(await readFile(f.config.files.importState)).added_song_ids, ["100", "101"]);
  assert.equal((await localStatus(f.config)).matching.linked_existing, 1);
});

test("repeated link/unlink previews do not rewrite reports and session errors in apply check are redacted", async t => {
  const f = await fixture(t); await approve(f);
  const report = await readFile(f.config.files.reviewHtml, "utf8");
  await linkExisting(f.config, f.options); assert.equal(await readFile(f.config.files.reviewHtml, "utf8"), report);
  f.adapter.validateSession = async () => { throw new Error("SECRET auth response"); };
  await assert.rejects(applyPlaylist(f.config, { backend: "web-player", check: true, writeAdapter: f.adapter }), error => {
    assert.match(error.message, /읽기 전용/); assert.doesNotMatch(error.message, /SECRET|auth response/); return true;
  });
});

test("journal corruption, duplicate revisions, invalid predecessor and conflicting active events fail closed", async t => {
  const f = await fixture(t); await approve(f);
  const valid = await readExistingLinks(f.config);
  for (const change of [
    d => { d.schema_version = 2; }, d => { d.events[0].action = "unknown"; }, d => { d.events[0].previous_revision = "missing"; },
    d => { d.events.push(d.events[0]); }, d => { d.events[0].anchor_melon_song_id = "2"; },
    d => { d.events[0].base_record_fingerprint = "0".repeat(64); }, d => { d.events[0].remote_evidence.playlist_occurrences = 2; },
    d => { d.events[0].evidence.extra = "not allowed"; }, d => { d.events = [{ action: "unlink" }]; }
  ]) {
    const document = structuredClone(valid); change(document); await f.save(f.config.files.existingSongLinks, document);
    await assert.rejects(localStatus(f.config)); await assert.rejects(applyPlaylist(f.config, { backend: "web-player" }));
  }
  await f.unchanged();
});

test("an invalid journal destination fails before storing; report failure after storing is separate", async t => {
  const f = await fixture(t), preview = await linkExisting(f.config, f.options);
  // The reader must refuse a broken journal destination instead of overwriting it.
  await mkdir(f.config.files.existingSongLinks);
  await assert.rejects(linkExisting(f.config, { ...f.options, confirm: true, expectedPreview: preview.preview_hash }));
  await rmdir(f.config.files.existingSongLinks); // verified empty fixture directory only
  assert.equal((await localStatus(f.config)).matching.linked_existing, 0);
  const bad = { ...f.config, files: { ...f.config.files, reviewCsv: f.config.dataDir } };
  const renewed = await linkExisting(bad, f.options);
  const result = await linkExisting(bad, { ...f.options, confirm: true, expectedPreview: renewed.preview_hash });
  assert.equal(result.saved, true); assert.equal(result.review_updated, false); assert.equal(result.next_command, "review");
  await reviewResults(f.config); assert.equal((await localStatus(f.config)).operations.review.status, "completed");
  await f.unchanged();
});

test("all account/source/selection writers honor the same connection lock without overriding another owner", async t => {
  const f = await fixture(t), preview = await linkExisting(f.config, f.options);
  const lock = await acquireApplyLock(await checkpointTarget(f.config.files.existingSongLinks), f.config.applyLockDir);
  try {
    await assert.rejects(linkExisting(f.config, { ...f.options, confirm: true, expectedPreview: preview.preview_hash }), /잠금/);
    await assert.rejects(resolveManualMatch(f.config, { melonSongId: "4", appleSongId: "101", confirm: true, lookupClient: f.lookupClient }), /잠금/);
    await assert.rejects(reviseMatch(f.config, { melonSongId: "3", hold: true, reason: "Check", confirm: true, expectedPreview: "0".repeat(64) }), /잠금/);
    await assert.rejects(applyPlaylist(f.config, { backend: "web-player", execute: true, writeAdapter: f.adapter }), /잠금/);
    await assert.rejects(matchAppleMusic(f.config, { force: true, lookupClient: { async searchSongs() { return []; } } }), /잠금/);
    await f.unchanged(); assert.deepEqual(f.writes, []);
  } finally { await lock.release(); }
  await approve(f);
});

test("optional file preserves legacy duplicate selections and review fingerprint notices link cancellation", async t => {
  const f = await fixture(t);
  await f.save(f.config.files.manualMatches, { songs: [...f.manual, { ...f.source[2], apple_music_song_id: "100", match_status: "manual_confirmed" }] });
  const old = await localStatus(f.config);
  assert.equal(old.matching.manual_confirmed, 2); assert.equal(old.apply.selected_unique, 1); assert.equal(old.matching.linked_existing, 0);
  const { confirmed } = await approve(f);
  assert.equal((await localStatus(f.config)).operations.review.status, "completed");
  const rawCommand = await import("../src/existing-song-link-commands.js");
  const opts = { melonSongId: "2", reason: "Cancel without report" }, preview = await rawCommand.unlinkExistingSong(f.config, opts);
  await rawCommand.unlinkExistingSong(f.config, { ...opts, confirm: true, expectedPreview: preview.preview_hash });
  assert.equal((await localStatus(f.config)).operations.review.status, "stale");
  assert.equal((await readExistingLinks(f.config)).events[0].approved_preview_hash, confirmed.expectedPreview);
});

test("command option boundaries reject execute/force, malformed approval and unrelated fields", async t => {
  for (const command of ["link-existing", "unlink-existing"]) {
    for (const option of ["--execute", "--force", "--hold"]) assert.throws(() => parseArgs([command, option]), /알 수 없는 옵션/);
  }
  assert.equal(parseArgs(["link-existing", "--evidence-file", "e.json", "--confirm", "--expected-preview", "x"]).options.evidenceFile, "e.json");
  const f = await fixture(t);
  await assert.rejects(linkExisting(f.config, { ...f.options, confirm: true }), /expected-preview/);
  await assert.rejects(linkExisting(f.config, { ...f.options, expectedPreview: "x" }), /confirm/);
  await assert.rejects(linkExisting(f.config, { ...f.options, anchorMelonSongId: "2" }), /서로 다른/);
  await f.save(f.evidenceFile, { ...f.evidence, arbitrary: "unknown" });
  await assert.rejects(linkExisting(f.config, f.options), /근거 JSON/);
  await f.unchanged();
});
