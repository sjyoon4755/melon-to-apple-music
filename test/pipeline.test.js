import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWriteBackend } from "../src/apple-write-adapter.js";
import { resolveConfig } from "../src/config.js";
import {
  applyPlaylist,
  buildSearchQueries,
  localStatus,
  matchAppleMusic,
  reviewResults,
  resolveManualMatch
} from "../src/pipeline.js";

async function projectWithMatches(t, count = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-apple-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.files.matched, JSON.stringify({ songs: Array.from({ length: count }, (_, index) => ({
    melon_song_id: `m${index + 1}`,
    apple_music_song_id: String(index + 1),
    match_status: "matched"
  })) }));
  return config;
}

function fakeAdapter(options = {}) {
  const tracks = new Set(options.initialTracks ?? []);
  const batches = [];
  const adapter = {
    backend: options.backend ?? "web-player",
    batches,
    createCalls: 0,
    async validateSession() { return { storefront: options.sessionStorefront ?? "kr" }; },
    async getStorefront() { return options.sessionStorefront ?? "kr"; },
    async validateCatalogSongs(ids) {
      const allowed = options.verifiedIds ? new Set(options.verifiedIds) : new Set(ids);
      return ids.filter((id) => allowed.has(id)).map((id) => ({
        id,
        attributes: { playParams: { id } }
      }));
    },
    async createLibraryPlaylist() {
      adapter.createCalls += 1;
      return { id: "p.tool" };
    },
    async getLibraryPlaylist() {
      if (options.playlistMissing) return null;
      return { id: "p.tool", name: "Melon Likes Import", canEdit: options.canEdit !== false };
    },
    async getPlaylistTracks() {
      return [...tracks].map((id) => ({ id: `i.${id}`, catalog_id: id }));
    },
    async addTracks(_playlistId, ids) {
      batches.push([...ids]);
      if (options.reflectWrites !== false) for (const id of ids) tracks.add(id);
    }
  };
  return adapter;
}

test("builds conservative fallback queries from title, artist aliases, and album", () => {
  assert.deepEqual(buildSearchQueries({
    title: "SPARK (feat. 한도윤)",
    artist: "번개 (BOLT)",
    album: "SPARK"
  }), [
    "SPARK (feat. 한도윤) 번개 (BOLT)",
    "SPARK BOLT",
    "SPARK"
  ]);
  assert.ok(buildSearchQueries({
    title: "눈이 그친 뒤",
    artist: "루나 (LUNa)",
    album: "SEEDS OF SPRING"
  }).includes("SEEDS OF SPRING LUNa"));
});

test("status separately counts unavailable source IDs without adding invented matches or Apple pending", async (t) => {
  const config = await projectWithMatches(t);
  await writeFile(config.files.melonLikes, JSON.stringify({
    complete: true, source: { total_reported: 2 },
    songs: [{ melon_song_id: "m1", title: "Known song", artist: "Artist" }],
    unavailable_songs: [{ melon_song_id: "10001", reason: "disabled_no_result" }],
    checkpoint: { next_start_index: 1, verified_scan: { raw_row_count: 2, pages: [{ start_index: 1 }] } },
    extraction: { verified_unique_count: 2, reported_count_gap: 0 }
  }));
  const status = await localStatus(config);
  assert.equal(status.source.count, 1);
  assert.equal(status.source.unavailable_count, 1);
  assert.equal(status.source.accounted_count, 2);
  assert.equal(status.source.verified_row_count, 2);
  assert.equal(status.source.verified_unique_count, 2);
  assert.equal(status.source.reported_count_gap, 0);
  assert.equal(status.source.verified_page_count, 1);
  assert.equal(status.matching.processed, 1);
  assert.equal(status.matching.unprocessed, 0);
  assert.equal(status.matching.unresolved, 0);
  assert.equal(status.apply.pending, 1);
});

async function projectWithSource(t, count = 2) {
  const config = await projectWithMatches(t, 0);
  const songs = Array.from({ length: count }, (_, index) => ({
    melon_song_id: `m${index + 1}`, title: `Song ${index + 1}`, artist: "Artist", album: "Album"
  }));
  await writeFile(config.files.melonLikes, JSON.stringify({ complete: false, songs }));
  return { config, songs };
}

test("status reports the verified filter union while retaining the base scan count", async (t) => {
  const config = await projectWithMatches(t);
  await writeFile(config.files.melonLikes, JSON.stringify({ complete: true, source: { total_reported: 3 },
    songs: [{ melon_song_id: "m1", title: "Known", artist: "Artist" }],
    unavailable_songs: [{ melon_song_id: "10001" }, { melon_song_id: "10002" }],
    checkpoint: { verified_scan: { raw_row_count: 2, pages: [{}] },
      combined_verified_scan: { raw_row_count: 3, supplemental_unique_count: 1 } },
    extraction: { verified_unique_count: 3, reported_count_gap: 0 } }));
  const status = await localStatus(config);
  assert.equal(status.source.verified_row_count, 3);
  assert.equal(status.source.base_verified_row_count, 2);
  assert.equal(status.source.supplemental_unique_count, 1);
  assert.equal(status.source.unavailable_count, 2);
  assert.equal(status.apply.pending, 1);
});

test("review exposes participant reasons and preserves approved manual results", async (t) => {
  const { config, songs } = await projectWithSource(t);
  const { chooseMatch } = await import("../src/matcher.js");
  const decision = chooseMatch({ ...songs[0], title: "Song (Feat. B)" },
    [{ id: "1", title: "Song (Feat. C)", artist: "Artist", album: "Album" }]);
  const unmatched = JSON.stringify({ songs: [{ ...songs[0], match_status: decision.status,
    match_reasons: decision.reasons, match_components: decision.best.components }] });
  const manual = JSON.stringify({ songs: [{ ...songs[1], match_status: "manual_confirmed", apple_music_song_id: "2" }] });
  await writeFile(config.files.unmatched, unmatched);
  await writeFile(config.files.manualMatches, manual);
  const summary = await reviewResults(config);
  assert.equal(summary.manual_confirmed, 1);
  assert.equal(summary.ambiguous, 1);
  const csv = await readFile(config.files.reviewCsv, "utf8");
  assert.match(csv, /guest_artist_mismatch/);
  assert.match(csv, /user_confirmed/);
  assert.equal(await readFile(config.files.manualMatches, "utf8"), manual);
  assert.equal(await readFile(config.files.unmatched, "utf8"), unmatched);
});

test("resumes with saved custom criteria and rejects conflicting criteria before searching", async (t) => {
  const { config, songs } = await projectWithSource(t);
  const criteria = { threshold: 0.97, min_margin: 0.12 };
  await writeFile(config.files.matched, JSON.stringify({ match_config: criteria,
    songs: [{ ...songs[0], apple_music_song_id: "1", match_status: "matched" }] }));
  await writeFile(config.files.unmatched, JSON.stringify({ match_config: criteria, songs: [] }));
  let searches = 0;
  const lookupClient = { async searchSongs() {
    searches += 1;
    return [{ id: "2", title: "Song 2", artist: "Artist", album: "Different" }];
  } };
  await assert.rejects(matchAppleMusic(config, { threshold: 0.88, lookupClient }), /--force/);
  assert.equal(searches, 0);
  const result = await matchAppleMusic(config, { lookupClient });
  assert.equal(result.threshold, criteria.threshold);
  assert.equal(result.min_margin, criteria.min_margin);
  assert.equal(result.matched, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.reused, 1);
  assert.equal(result.searched, 1);
  for (const file of [config.files.matched, config.files.unmatched]) {
    assert.deepEqual(JSON.parse(await readFile(file)).match_config, criteria);
  }
  const csv = await readFile(config.files.reviewCsv, "utf8");
  assert.match(csv, /candidate_count,match_reasons/);
  assert.match(csv, /below_threshold/);
  const forced = await matchAppleMusic(config, { force: true, threshold: 0.88, minMargin: 0.06,
    lookupClient: { async searchSongs(query) {
      const song = songs.find((value) => query.includes(value.title));
      return song ? [{ ...song, id: song.melon_song_id, album: "Different" }] : [];
    } } });
  assert.equal(forced.searched, 2);
  assert.equal(forced.matched, 2);
});

test("rejects disagreement between saved criteria and invalid numeric criteria", async (t) => {
  const { config } = await projectWithSource(t);
  await writeFile(config.files.matched, JSON.stringify({ match_config: { threshold: 0.9, min_margin: 0.1 }, songs: [] }));
  await writeFile(config.files.unmatched, JSON.stringify({ match_config: { threshold: 0.88, min_margin: 0.06 }, songs: [] }));
  await assert.rejects(matchAppleMusic(config), /서로 다릅니다/);
  await assert.rejects(matchAppleMusic(config, { force: true, threshold: NaN }), /숫자/);
});

test("records failure without diagnostic payloads, preserves completed songs, and resumes only the remainder", async (t) => {
  const { config, songs } = await projectWithSource(t);
  let calls = 0;
  await assert.rejects(matchAppleMusic(config, { lookupClient: { stats: { requests: 2 }, async searchSongs() {
    calls += 1;
    if (calls === 2) {
      const running = JSON.parse(await readFile(config.files.matchingRun));
      assert.equal(running.status, "running");
      assert.equal(running.processed, 1);
      assert.equal(running.remaining, 1);
      throw new Error("private diagnostic payload");
    }
    return [{ ...songs[0], id: "1" }];
  } } }), /private diagnostic payload/);
  const failedText = await readFile(config.files.matchingRun, "utf8");
  const failed = JSON.parse(failedText);
  assert.equal(failed.status, "failed");
  assert.equal(failed.processed, 1);
  assert.equal(failed.remaining, 1);
  assert.equal(failed.stop_reason, "matching_failed");
  assert.equal(failedText.includes("private diagnostic payload"), false);
  assert.equal((await localStatus(config)).matching.unprocessed, 1);
  const result = await matchAppleMusic(config, { lookupClient: { async searchSongs() {
    return [{ ...songs[1], id: "2" }];
  } } });
  assert.equal(result.searched, 1);
  assert.equal(result.reused, 1);
  const status = await localStatus(config);
  assert.equal(status.matching.complete, true);
  assert.equal(status.operations.matching.status, "completed");
  assert.equal(status.operations.review.status, "completed");
  await matchAppleMusic(config, {});
  assert.equal((await localStatus(config)).operations.review.status, "completed");
  await writeFile(config.files.manualMatches, JSON.stringify({ songs: [{ ...songs[1], match_status: "manual_confirmed", apple_music_song_id: "2" }] }));
  assert.equal((await localStatus(config)).operations.review.status, "stale");
  await writeFile(config.files.melonLikes, JSON.stringify({ songs: [...songs, { melon_song_id: "m3" }] }));
  const changed = await localStatus(config);
  assert.equal(changed.operations.matching.status, "stale");
  assert.equal(changed.matching.unprocessed, 1);
  assert.equal(changed.matching.complete, false);
});

test("legacy review explains stored decisions without rewriting JSON and marks truncated candidate counts", async (t) => {
  const { config, songs } = await projectWithSource(t, 1);
  const original = JSON.stringify({ match_config: { threshold: 0.97, min_margin: 0.12 }, songs: [{ ...songs[0],
    match_status: "ambiguous", match_score: 0.95, match_margin: 0.1,
    match_components: { qualifier_mismatch: true }, candidates: Array.from({ length: 5 }, (_, id) => ({ id }))
  }] });
  await writeFile(config.files.unmatched, original);
  await reviewResults(config);
  assert.equal(await readFile(config.files.unmatched, "utf8"), original);
  const csv = await readFile(config.files.reviewCsv, "utf8");
  assert.match(csv, /5\+,below_threshold \| insufficient_margin \| version_mismatch/);
  await assert.rejects(reviewResults({ ...config, files: { ...config.files, reviewCsv: config.dataDir } }));
  assert.equal(JSON.parse(await readFile(config.files.reviewRun)).status, "failed");
});

test("status and reuse count only IDs in the current source", async (t) => {
  const { config, songs } = await projectWithSource(t, 1);
  await writeFile(config.files.matched, JSON.stringify({ songs: [
    { ...songs[0], apple_music_song_id: "1", match_status: "matched" },
    { melon_song_id: "obsolete", apple_music_song_id: "99", match_status: "matched" }
  ] }));
  const status = await localStatus(config);
  assert.equal(status.matching.processed, 1);
  assert.equal(status.matching.automatic_matched, 1);
  assert.equal(status.apply.pending, 1);
  assert.equal((await matchAppleMusic(config)).reused, 1);
});

test("web-player requires an explicit backend argument", () => {
  const previous = process.env.APPLE_MUSIC_WRITE_BACKEND;
  process.env.APPLE_MUSIC_WRITE_BACKEND = "web-player";
  try {
    assert.equal(resolveWriteBackend(), "official");
    assert.equal(resolveWriteBackend("web-player"), "web-player");
  } finally {
    if (previous == null) delete process.env.APPLE_MUSIC_WRITE_BACKEND;
    else process.env.APPLE_MUSIC_WRITE_BACKEND = previous;
  }
});

test("apply is a no-credential, no-adapter dry-run by default", async (t) => {
  const config = await projectWithMatches(t);
  const result = await applyPlaylist(config, {});
  const { source, selected_add_songs, ...legacyPlan } = result;
  assert.equal(source.present, false);
  assert.equal(selected_add_songs[0].apple_music_song_id, "1");
  assert.deepEqual(legacyPlan, {
    dry_run: true,
    backend: "official",
    storefront: "kr",
    playlist_name: "Melon Likes Import",
    playlist_already_created: false,
    matched_unique: 1,
    already_added: 0,
    would_add: 1,
    remote_checked: false,
    plan_basis: "local_checkpoint"
  });
  await assert.rejects(access(config.files.importState));
});

test("dry-run requires explicit valid backend and rejects resume mismatch", async (t) => {
  const config = await projectWithMatches(t);
  await writeFile(config.files.importState, JSON.stringify({
    schema_version: 2,
    backend: "official",
    storefront: "kr",
    playlist_id: "p.tool",
    added_song_ids: []
  }));
  await assert.rejects(
    applyPlaylist(config, { backend: "web-player" }),
    /state backend\(official\).*backend\(web-player\)/
  );
  await writeFile(config.files.importState, JSON.stringify({
    schema_version: 2,
    backend: "official",
    storefront: "us",
    playlist_id: "p.tool",
    added_song_ids: []
  }));
  await assert.rejects(applyPlaylist(config, { backend: "official" }), /state storefront\(us\).*storefront\(kr\)/);
  await assert.rejects(applyPlaylist(config, { backend: "automatic" }), /official 또는 web-player/);
});

test("injected web-player adapter preflights ids and records backend without tokens", async (t) => {
  const config = await projectWithMatches(t, 3);
  const adapter = fakeAdapter({ verifiedIds: ["1", "3"] });
  const result = await applyPlaylist(config, {
    execute: true,
    backend: "web-player",
    writeAdapter: adapter
  });
  assert.deepEqual(adapter.batches, [["1", "3"]]);
  assert.equal(result.verified_catalog, 2);
  assert.equal(result.skipped_unverified, 1);
  const stateText = await readFile(config.files.importState, "utf8");
  const state = JSON.parse(stateText);
  assert.equal(state.backend, "web-player");
  assert.equal(state.storefront, "kr");
  assert.deepEqual(state.added_song_ids, ["1", "3"]);
  assert.equal(/token|bearer|cookie/i.test(stateText), false);
});

test("apply limit caps an account trial to the first matched songs", async (t) => {
  const config = await projectWithMatches(t, 5);
  const preview = await applyPlaylist(config, { backend: "web-player", limit: 2 });
  const { source, selected_add_songs, ...legacyPlan } = preview;
  assert.equal(source.present, false);
  assert.deepEqual(selected_add_songs.map((song) => song.apple_music_song_id), ["1", "2"]);
  assert.deepEqual(legacyPlan, {
    dry_run: true,
    backend: "web-player",
    storefront: "kr",
    playlist_name: "Melon Likes Import",
    playlist_already_created: false,
    matched_unique: 5,
    already_added: 0,
    would_add: 2,
    remote_checked: false,
    plan_basis: "local_checkpoint",
    apply_limit: 2,
    selected_unique: 2
  });

  const adapter = fakeAdapter();
  const result = await applyPlaylist(config, {
    execute: true,
    backend: "web-player",
    limit: 2,
    writeAdapter: adapter
  });
  assert.deepEqual(adapter.batches, [["1", "2"]]);
  assert.equal(result.apply_limit, 2);
  assert.equal(result.selected_unique, 2);
  assert.equal(result.added_this_run, 2);
  await assert.rejects(applyPlaylist(config, { backend: "web-player", limit: 0 }), /1 이상의 정수/);
  await assert.rejects(applyPlaylist(config, { backend: "web-player", limit: 1.5 }), /1 이상의 정수/);
});

test("read-only remote check validates session, playlist, checkpoint, and catalog without writes", async (t) => {
  const config = await projectWithMatches(t, 2);
  const state = {
    schema_version: 2,
    backend: "web-player",
    storefront: "kr",
    playlist_id: "p.tool",
    playlist_name: "Melon Likes Import",
    added_song_ids: ["1"]
  };
  await writeFile(config.files.importState, JSON.stringify(state));
  const before = await readFile(config.files.importState, "utf8");
  const adapter = fakeAdapter({ initialTracks: ["1"], verifiedIds: ["1", "2"] });

  const result = await applyPlaylist(config, {
    check: true,
    backend: "web-player",
    writeAdapter: adapter
  });

  assert.equal(result.remote_checked, true);
  assert.equal(result.playlist_exists, true);
  assert.equal(result.verified_catalog, 2);
  assert.equal(result.checkpoint_added, 1);
  assert.equal(result.server_present, 1);
  assert.equal(result.pending_verified, 1);
  assert.deepEqual(adapter.batches, []);
  assert.equal(adapter.createCalls, 0);
  assert.equal(await readFile(config.files.importState, "utf8"), before);
  await assert.rejects(
    applyPlaylist(config, { check: true, execute: true, backend: "web-player", writeAdapter: adapter }),
    /함께 사용할 수 없습니다/
  );
});

test("manual resolution previews before confirmation and stays separate from automatic results", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-apple-manual-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.files.melonLikes, JSON.stringify({
    complete: false,
    checkpoint: { next_start_index: 2 },
    songs: [{ melon_song_id: "m1", title: "원곡", artist: "가수", album: "앨범" }]
  }));
  await writeFile(config.files.matched, JSON.stringify({ songs: [] }));
  await writeFile(config.files.unmatched, JSON.stringify({
    songs: [{ melon_song_id: "m1", title: "원곡", artist: "가수", album: "앨범", match_status: "not_found" }]
  }));
  const lookupClient = {
    async lookupSongs() {
      return [{
        id: "42", title: "확인한 곡", artist: "가수", album: "앨범", duration_ms: 123000,
        isrc: null, content_rating: null, url: "https://music.apple.com/kr/album/x/1?i=42"
      }];
    }
  };

  const preview = await resolveManualMatch(config, {
    melonSongId: "m1",
    appleSongId: "42",
    lookupClient
  });
  assert.equal(preview.saved, false);
  await assert.rejects(access(config.files.manualMatches));

  const saved = await resolveManualMatch(config, {
    melonSongId: "m1",
    appleSongId: "42",
    confirm: true,
    lookupClient
  });
  assert.equal(saved.saved, true);
  const manual = JSON.parse(await readFile(config.files.manualMatches, "utf8"));
  assert.equal(manual.songs[0].match_status, "manual_confirmed");
  assert.equal(manual.songs[0].match_source, "manual-user-confirmed-itunes-lookup-kr");

  const status = await localStatus(config);
  assert.equal(status.matching.manual_confirmed, 1);
  assert.equal(status.matching.unresolved, 0);
  assert.equal(status.apply.pending, 1);
  const dryRun = await applyPlaylist(config, { backend: "official" });
  assert.equal(dryRun.matched_unique, 1);
  assert.equal(dryRun.would_add, 1);
});

test("no-op match reuses records without rewriting result documents", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-apple-reuse-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.files.melonLikes, JSON.stringify({
    songs: [{ melon_song_id: "m1", title: "원곡", artist: "가수", album: "앨범" }]
  }));
  const matchedText = JSON.stringify({
    match_config: { threshold: 0.88, min_margin: 0.06 },
    songs: [{ melon_song_id: "m1", apple_music_song_id: "42", match_status: "matched" }]
  });
  const unmatchedText = JSON.stringify({
    match_config: { threshold: 0.88, min_margin: 0.06 },
    songs: []
  });
  await writeFile(config.files.matched, matchedText);
  await writeFile(config.files.unmatched, unmatchedText);

  const result = await matchAppleMusic(config, {});

  assert.equal(result.searched, 0);
  assert.equal(result.reused, 1);
  assert.equal(await readFile(config.files.matched, "utf8"), matchedText);
  assert.equal(await readFile(config.files.unmatched, "utf8"), unmatchedText);
  assert.deepEqual(result.review_state, { csv_present: false, html_present: false, generated: false, stale: null });
  assert.equal(result.next_command, "review");
  await reviewResults(config);
  const csvText=await readFile(config.files.reviewCsv,"utf8");
  const repeated=await matchAppleMusic(config);
  assert.deepEqual(repeated.review_state,{csv_present:true,html_present:true,generated:false,stale:false});
  assert.equal(repeated.next_command,null);assert.equal(await readFile(config.files.reviewCsv,"utf8"),csvText);
});

test("resolve reports a saved approval separately from export failure and repairs an existing approval", async (t) => {
  const {config,songs}=await projectWithSource(t,1);
  await mkdir(config.files.reviewCsv);
  const lookupClient={async lookupSongs(){return [{id:"42",title:"선택곡",artist:"가수",album:"앨범"}];}};
  const options={melonSongId:songs[0].melon_song_id,appleSongId:"42",confirm:true,lookupClient};
  const saved=await resolveManualMatch(config,options);
  assert.equal(saved.saved,true);assert.equal(saved.review_updated,false);assert.equal(saved.next_command,"review");
  const bytes=await readFile(config.files.manualMatches,"utf8");
  const repeated=await resolveManualMatch(config,options);
  assert.equal(repeated.saved,false);assert.equal(repeated.already_confirmed,true);assert.equal(repeated.review_updated,false);
  assert.equal(await readFile(config.files.manualMatches,"utf8"),bytes);
  await rmdir(config.files.reviewCsv);
  const recovered=await resolveManualMatch(config,options);
  assert.equal(recovered.review_updated,true);assert.equal(recovered.already_confirmed,true);
  assert.equal(await readFile(config.files.manualMatches,"utf8"),bytes);
  await access(config.files.reviewCsv);await assert.rejects(access(config.files.importState));
});

test("review distinguishes missing and empty sources and exports unprocessed songs without inventing decisions", async (t) => {
  const {config,songs}=await projectWithSource(t,2);
  await writeFile(config.files.matched,JSON.stringify({songs:[{...songs[0],match_status:"matched",apple_music_song_id:"1"}]}));
  const before=await readFile(config.files.melonLikes,"utf8"),summary=await reviewResults(config);
  assert.equal(summary.total,1);assert.equal(summary.source.count,2);assert.equal(summary.source.processed,1);assert.equal(summary.source.unprocessed,1);assert.equal(summary.next_command,"match");
  assert.match(await readFile(config.files.reviewCsv,"utf8"),/unprocessed/);
  const html=await readFile(config.files.reviewHtml,"utf8");assert.match(html,/현재 판정 1곡/);assert.match(html,/미처리 1곡/);assert.match(html,/아직 검색하지 않음/);assert.match(html,/value="unprocessed"/);
  assert.equal(await readFile(config.files.melonLikes,"utf8"),before);assert.equal((await localStatus(config)).matching.unprocessed,1);
  await writeFile(config.files.melonLikes,JSON.stringify({songs:[],complete:true}));const empty=await reviewResults(config);assert.equal(empty.source.present,true);assert.equal(empty.source.count,0);assert.equal(empty.source.complete,true);
  await rm(config.files.melonLikes);const missing=await reviewResults(config);assert.equal(missing.source.present,false);assert.equal(missing.source.count,null);assert.equal(missing.next_command,"melon-extract");
});

test("remote check reports full-playlist duplicates, extra and unmapped items outside a limited selection without writing", async (t) => {
  const {config,songs}=await projectWithSource(t,2);
  await writeFile(config.files.matched,JSON.stringify({songs:songs.map((s,i)=>({...s,match_status:"matched",apple_music_song_id:String(i+1)}))}));
  await writeFile(config.files.importState,JSON.stringify({backend:"web-player",storefront:"kr",playlist_id:"p.tool",added_song_ids:["1","2"]}));
  const before=await readFile(config.files.importState,"utf8"),adapter=fakeAdapter();
  adapter.getPlaylistTracks=async()=>[{catalog_id:"1"},{catalog_id:"2"},{catalog_id:"2"},{catalog_id:"9999"},{id:"uploaded.track"}];
  const result=await applyPlaylist(config,{check:true,backend:"web-player",limit:1,maxAdd:1,writeAdapter:adapter});
  assert.equal(result.server_present,1);assert.equal(result.pending_verified,0);
  assert.deepEqual(result.playlist_diagnostics,{track_count:5,catalog_unique_count:3,unmapped_track_count:1,duplicate_catalog_ids:[{id:"2",occurrences:2}],extra_catalog_ids:["9999"],uncheckpointed_catalog_ids:["9999"]});
  assert.equal(adapter.createCalls,0);assert.deepEqual(adapter.batches,[]);assert.equal(await readFile(config.files.importState,"utf8"),before);
});

test("apply previews expose source incompleteness and every original linked to the selected new ID", async(t)=>{
  const {config,songs}=await projectWithSource(t,2);
  await writeFile(config.files.matched,JSON.stringify({songs:songs.map(s=>({...s,match_status:"matched",apple_music_song_id:"42",apple_music_title:"Apple 제목",apple_music_artist:"Apple 가수"}))}));
  const result=await applyPlaylist(config,{maxAdd:1});assert.equal(result.source.complete,false);assert.equal(result.source.count,2);assert.equal(result.selected_add_songs.length,1);
  assert.equal(result.selected_add_songs[0].apple_music_title,"Apple 제목");assert.equal(result.selected_add_songs[0].apple_music_artist,"Apple 가수");assert.deepEqual(result.selected_add_songs[0].melon_songs.map(s=>s.title),songs.map(s=>s.title));
  assert.deepEqual(result.selected_add_song_ids,result.selected_add_songs.map(s=>s.apple_music_song_id));await assert.rejects(access(config.files.importState));
});

test("apply limits track writes to 100 songs and confirms every batch", async (t) => {
  const config = await projectWithMatches(t, 201);
  const adapter = fakeAdapter();
  const result = await applyPlaylist(config, {
    execute: true,
    backend: "web-player",
    writeAdapter: adapter
  });
  assert.deepEqual(adapter.batches.map((batch) => batch.length), [100, 100, 1]);
  assert.equal(result.added_total, 201);
});

test("resume verifies playlist existence and editability before writes", async (t) => {
  const config = await projectWithMatches(t);
  await writeFile(config.files.importState, JSON.stringify({
    schema_version: 2,
    backend: "web-player",
    storefront: "kr",
    playlist_id: "p.tool",
    playlist_name: "Melon Likes Import",
    added_song_ids: []
  }));
  const missingAdapter = fakeAdapter({ playlistMissing: true });
  await assert.rejects(
    applyPlaylist(config, { execute: true, backend: "web-player", writeAdapter: missingAdapter }),
    /단계: validating/
  );
  assert.deepEqual(missingAdapter.batches, []);
  const adapter = fakeAdapter({ canEdit: false });
  await assert.rejects(
    applyPlaylist(config, { execute: true, backend: "web-player", writeAdapter: adapter }),
    /단계: validating/
  );
  assert.deepEqual(adapter.batches, []);
});

test("resume checkpoints tracks that were reflected before a previous crash", async (t) => {
  const config = await projectWithMatches(t, 2);
  await writeFile(config.files.importState, JSON.stringify({
    schema_version: 2,
    backend: "web-player",
    storefront: "kr",
    playlist_id: "p.tool",
    playlist_name: "Melon Likes Import",
    added_song_ids: ["1"]
  }));
  const adapter = fakeAdapter({ initialTracks: ["1", "2"] });
  const result = await applyPlaylist(config, {
    execute: true,
    backend: "web-player",
    writeAdapter: adapter
  });
  assert.deepEqual(adapter.batches, []);
  assert.equal(result.added_total, 2);
  const state = JSON.parse(await readFile(config.files.importState, "utf8"));
  assert.deepEqual(state.added_song_ids, ["1", "2"]);
});

test("apply does not checkpoint an unconfirmed track batch", async (t) => {
  const config = await projectWithMatches(t);
  const adapter = fakeAdapter({ reflectWrites: false });
  await assert.rejects(
    applyPlaylist(config, { execute: true, backend: "web-player", writeAdapter: adapter }),
    /단계: confirming_batch/
  );
  const state = JSON.parse(await readFile(config.files.importState, "utf8"));
  assert.deepEqual(state.added_song_ids, []);
  assert.deepEqual(adapter.batches, [["1"]]);
});

async function saveApplyState(config, addedIds) {
  await writeFile(config.files.importState, JSON.stringify({
    schema_version: 2, backend: "web-player", storefront: "kr",
    playlist_id: "p.tool", playlist_name: "Melon Likes Import", added_song_ids: addedIds
  }));
  return readFile(config.files.importState, "utf8");
}

test("max-add selects two new songs after 16 checkpoint songs and keeps previews read-only", async (t) => {
  const config = await projectWithMatches(t, 1616);
  const added = Array.from({ length: 16 }, (_, index) => String(index + 1));
  const before = await saveApplyState(config, added);
  const options = { backend: "web-player", maxAdd: 2 };
  const dryAdapter = fakeAdapter();
  dryAdapter.validateSession = () => { throw new Error("dry-run must not use an adapter"); };
  const dry = await applyPlaylist(config, { ...options, writeAdapter: dryAdapter });
  assert.equal(dry.remote_checked, false);
  assert.equal(dry.plan_basis, "local_checkpoint");
  assert.equal(dry.already_added, 16);
  assert.equal(dry.eligible_new, 1600);
  assert.equal(dry.would_add, 2);
  assert.equal(dry.deferred_new, 1598);
  assert.deepEqual(dry.selected_add_song_ids, ["17", "18"]);
  assert.equal(dryAdapter.createCalls, 0);
  assert.deepEqual(dryAdapter.batches, []);
  assert.equal(await readFile(config.files.importState, "utf8"), before);

  const adapter = fakeAdapter({ initialTracks: added });
  const checked = await applyPlaylist(config, { ...options, check: true, writeAdapter: adapter });
  assert.equal(checked.remote_checked, true);
  assert.equal(checked.pending_verified, 2);
  assert.deepEqual(checked.selected_add_song_ids, dry.selected_add_song_ids);
  assert.equal(adapter.createCalls, 0);
  assert.deepEqual(adapter.batches, []);
  assert.equal(await readFile(config.files.importState, "utf8"), before);
  const executed = await applyPlaylist(config, { ...options, execute: true, writeAdapter: adapter });
  assert.deepEqual(executed.selected_add_song_ids, checked.selected_add_song_ids);
  assert.deepEqual(adapter.batches, [["17", "18"]]);
  assert.equal(executed.added_this_run, 2);
  assert.equal(executed.added_total, 18);
});

test("server-only and unverified songs do not consume max-add; check and execute select identical IDs", async (t) => {
  const config = await projectWithMatches(t, 6);
  const before = await saveApplyState(config, ["1"]);
  const adapter = fakeAdapter({ initialTracks: ["1", "2"], verifiedIds: ["1", "2", "4", "5", "6"] });
  const options = { backend: "web-player", maxAdd: 2, writeAdapter: adapter };
  const checked = await applyPlaylist(config, { ...options, check: true });
  assert.equal(checked.server_uncheckpointed, 1);
  assert.equal(checked.skipped_unverified, 1);
  assert.equal(checked.eligible_new, 3);
  assert.deepEqual(checked.selected_add_song_ids, ["4", "5"]);
  assert.equal(await readFile(config.files.importState, "utf8"), before);
  assert.equal(adapter.createCalls, 0);
  assert.deepEqual(adapter.batches, []);
  const executed = await applyPlaylist(config, { ...options, execute: true });
  assert.deepEqual(executed.selected_add_song_ids, checked.selected_add_song_ids);
  assert.deepEqual(adapter.batches, [["4", "5"]]);
  assert.deepEqual(JSON.parse(await readFile(config.files.importState, "utf8")).added_song_ids, ["1", "2", "4", "5"]);
});

test("limit selects the cumulative range before max-add selects new songs", async (t) => {
  const config = await projectWithMatches(t, 8);
  await saveApplyState(config, ["1", "2"]);
  for (const [limit, maxAdd, expected] of [[2, 2, []], [3, 2, ["3"]], [5, 2, ["3", "4"]]]) {
    const adapter = fakeAdapter({ initialTracks: ["1", "2"] });
    const options = { backend: "web-player", limit, maxAdd, writeAdapter: adapter };
    const dry = await applyPlaylist(config, options);
    const checked = await applyPlaylist(config, { ...options, check: true });
    assert.equal(checked.selected_unique, limit);
    assert.equal(checked.apply_limit, limit);
    assert.deepEqual(dry.selected_add_song_ids, expected);
    assert.deepEqual(checked.selected_add_song_ids, expected);
  }
  const adapter = fakeAdapter({ initialTracks: ["1", "2"] });
  const result = await applyPlaylist(config, { backend: "web-player", execute: true, limit: 3, maxAdd: 2, writeAdapter: adapter });
  assert.equal(result.added_this_run, 1);
  assert.deepEqual(adapter.batches, [["3"]]);
});

test("max-add handles zero new songs without creating or adding a playlist", async (t) => {
  const config = await projectWithMatches(t, 2);
  const before = await saveApplyState(config, ["1", "2"]);
  const adapter = fakeAdapter({ initialTracks: ["1", "2"] });
  for (const mode of [{}, { check: true }, { execute: true }]) {
    const result = await applyPlaylist(config, { backend: "web-player", maxAdd: 2, writeAdapter: adapter, ...mode });
    assert.deepEqual(result.selected_add_song_ids, []);
    assert.equal(result.eligible_new, 0);
  }
  assert.equal(adapter.createCalls, 0);
  assert.deepEqual(adapter.batches, []);
  assert.equal(await readFile(config.files.importState, "utf8"), before);
});

test("max-add skips unnecessary playlist creation when no catalog songs are usable", async (t) => {
  const config = await projectWithMatches(t, 2);
  const adapter = fakeAdapter({ verifiedIds: [] });
  for (const mode of [{ check: true }, { execute: true }]) {
    const result = await applyPlaylist(config, { backend: "web-player", maxAdd: 2, writeAdapter: adapter, ...mode });
    assert.equal(result.verified_catalog, 0);
    assert.deepEqual(result.selected_add_song_ids, []);
    await assert.rejects(access(config.files.importState));
  }
  assert.equal(adapter.createCalls, 0);
  assert.deepEqual(adapter.batches, []);
});

test("max-add deduplicates Apple IDs across automatic and manual matches in input order", async (t) => {
  const config = await projectWithMatches(t, 2);
  await writeFile(config.files.manualMatches, JSON.stringify({ songs: [
    { melon_song_id: "m3", apple_music_song_id: "1", match_status: "manual_confirmed" },
    { melon_song_id: "m4", apple_music_song_id: "3", match_status: "manual_confirmed" },
    { melon_song_id: "m5", apple_music_song_id: "3", match_status: "manual_confirmed" }
  ] }));
  const adapter = fakeAdapter();
  const options = { backend: "web-player", maxAdd: 5, writeAdapter: adapter };
  const dry = await applyPlaylist(config, options);
  const checked = await applyPlaylist(config, { ...options, check: true });
  assert.equal(dry.matched_unique, 3);
  assert.equal(dry.would_add, 3);
  assert.equal(dry.deferred_new, 0);
  assert.deepEqual(checked.selected_add_song_ids, ["1", "2", "3"]);
  assert.equal(adapter.createCalls, 0);
  assert.deepEqual(adapter.batches, []);
  await assert.rejects(access(config.files.importState));
  const executed = await applyPlaylist(config, { ...options, execute: true });
  assert.deepEqual(executed.selected_add_song_ids, checked.selected_add_song_ids);
  assert.equal(executed.added_this_run, 3);
  assert.deepEqual(adapter.batches, [["1", "2", "3"]]);
});

test("max-add keeps the 100-song batch boundary and never sends more than the cap", async (t) => {
  const config = await projectWithMatches(t, 220);
  const adapter = fakeAdapter();
  let reads = 0;
  const getTracks = adapter.getPlaylistTracks;
  adapter.getPlaylistTracks = async (...args) => { reads += 1; return getTracks(...args); };
  const result = await applyPlaylist(config, { backend: "web-player", maxAdd: 101, execute: true, writeAdapter: adapter });
  assert.deepEqual(adapter.batches.map((batch) => batch.length), [100, 1]);
  assert.equal(reads, 2);
  assert.equal(result.added_this_run, 101);
  assert.equal(result.deferred_new, 119);
  assert.deepEqual(adapter.batches.flat(), result.selected_add_song_ids);
});

test("max-add validates the entire checkpoint even outside the limit and keeps backend/storefront guards", async (t) => {
  const config = await projectWithMatches(t, 3);
  const before = await saveApplyState(config, ["3"]);
  for (const mode of [{ check: true }, { execute: true }]) {
    const adapter = fakeAdapter();
    await assert.rejects(applyPlaylist(config, { backend: "web-player", maxAdd: 1, limit: 1, writeAdapter: adapter, ...mode }), mode.execute ? /단계: validating/ : /checkpoint와/);
    assert.equal(adapter.createCalls, 0);
    assert.deepEqual(adapter.batches, []);
    assert.equal(await readFile(config.files.importState, "utf8"), before);
  }
  await assert.rejects(applyPlaylist(config, { backend: "official", maxAdd: 1 }), /state backend/);
  for (const adapter of [fakeAdapter({ backend: "official" }), fakeAdapter({ sessionStorefront: "us" })]) {
    await assert.rejects(applyPlaylist(config, { backend: "web-player", check: true, maxAdd: 1, writeAdapter: adapter }), /backend|storefront/);
    assert.equal(adapter.createCalls, 0);
    assert.deepEqual(adapter.batches, []);
  }
});

test("max-add rejects invalid values even when called outside the CLI", async (t) => {
  const config = await projectWithMatches(t);
  for (const maxAdd of [0, -1, 1.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER + 1]) {
    for (const mode of [{}, { check: true }, { execute: true }]) {
      await assert.rejects(applyPlaylist(config, { maxAdd, ...mode }), /max-add.*정수/);
    }
  }
  await assert.rejects(access(config.files.importState));
  await assert.rejects(access(`${config.files.importState}.run.json`));
});

test("max-add preserves failed reflection protection", async (t) => {
  const config = await projectWithMatches(t, 3);
  const adapter = fakeAdapter({ reflectWrites: false });
  await assert.rejects(applyPlaylist(config, { backend: "web-player", execute: true, maxAdd: 2, writeAdapter: adapter }), /단계: confirming_batch/);
  assert.deepEqual(adapter.batches, [["1", "2"]]);
  assert.deepEqual(JSON.parse(await readFile(config.files.importState, "utf8")).added_song_ids, []);
});
