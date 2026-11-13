import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { resolveUnavailableMatch } from "../src/unavailable-match-command.js";
import { readMatchSelection } from "../src/match-decisions.js";
import { evidenceDigest } from "../src/unavailable-evidence.js";
import { dataSnapshot } from "../src/apply-lock.js";
import { localStatus, reviewResults, applyPlaylist } from "../src/pipeline.js";
import { parseArgs } from "../src/cli-options.js";

const bare = { melon_song_id: "100", reason: "disabled_no_result", row_index: 7, page_start_index: 21 };
const awake = { melon_song_id: "91000002", title: "Night Shift", duration_ms: 1466000, match_status: "ambiguous" };
const held = { melon_song_id: "200", title: "Held song", artist: "Singer", album: "Album", match_status: "held" };
const apple = { id: "900", title: "Public title", artist: "Singer", album: "Album", duration_ms: 200000, isrc: null, content_rating: null };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-public-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.files.melonLikes, JSON.stringify({ songs: [awake, held], unavailable_songs: [bare], complete: true }));
  await writeFile(config.files.unmatched, JSON.stringify({ songs: [awake, held] }));
  const document = { schema_version: 1, melon_song_id: "100", apple_music_song_id: "900",
    operating_source_sha256: evidenceDigest(bare),
    public_metadata: { title: "Public title", artist: "Singer", album: "Album", album_id: "300", isrc: null, duration_ms: null, content_rating: null },
    provenance: { song_url: "https://www.melon.com/song/detail.htm?songId=100", album_url: "https://www.melon.com/album/detail.htm?albumId=300", checked_at: "2026-11-01T15:00:00.000Z", method: "official-public-page-GET" },
    comparison: "Same album and track position; original recording remains unverified.", limitations: ["Original ISRC and duration unknown"] };
  const file = path.join(root, "evidence.json");
  await writeFile(file, JSON.stringify(document, null, 2));
  const options = { melonSongId: "100", appleSongId: "900", reason: "Reviewed uncertainty", evidenceFile: "evidence.json", lookupClient: { lookupSongs: async () => [apple] } };
  return { config, document, file, options };
}

async function save(f) {
  const preview = await resolveUnavailableMatch(f.config, f.options);
  return resolveUnavailableMatch(f.config, { ...f.options, confirm: true, expectedPreview: preview.preview_hash });
}

test("bare inactive rows require evidence before lookup; rich legacy records remain a separate path", async t => {
  const f = await fixture(t), before = await dataSnapshot(f.config);
  await assert.rejects(resolveUnavailableMatch(f.config, { ...f.options, evidenceFile: undefined,
    lookupClient: { lookupSongs: () => assert.fail("must reject before lookup") } }), /--evidence-file/);
  assert.equal(await dataSnapshot(f.config), before);
});

test("public preview is read-only and approval stores self-contained evidence without altering the raw source", async t => {
  const f = await fixture(t), before = await dataSnapshot(f.config), source = await readFile(f.config.files.melonLikes, "utf8");
  const prior = await readMatchSelection(f.config);
  const preview = await resolveUnavailableMatch(f.config, f.options);
  assert.deepEqual(preview.melon, bare);
  assert.deepEqual(preview.public_metadata, f.document.public_metadata);
  assert.deepEqual(preview.public_provenance, f.document.provenance);
  assert.match(preview.public_evidence.file_sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.saved, false);
  assert.equal(preview.same_recording_verified, false);
  assert.equal(await dataSnapshot(f.config), before);
  assert.equal((await save(f)).saved, true);
  const stored = JSON.parse(await readFile(f.config.files.unavailableMatches, "utf8")).mappings[0];
  assert.deepEqual(stored.source, bare);
  assert.deepEqual(stored.evidence.document, f.document);
  assert.equal(stored.evidence.document_sha256, evidenceDigest(f.document));
  assert.equal(stored.record.title, "Public title");
  assert.equal(stored.record.artist, "Singer");
  assert.equal(stored.record.album, "Album");
  assert.equal(await readFile(f.config.files.melonLikes, "utf8"), source);
  const selection = await readMatchSelection(f.config);
  assert.deepEqual([...selection.effective], [...prior.effective]);
  assert.equal(selection.effective.get("200").match_status, "held");
  assert.equal(selection.effective.get("91000002").duration_ms, 1466000);
  await assert.rejects(readFile(f.config.files.importState), { code: "ENOENT" });
  await assert.rejects(readFile(f.config.files.manualMatches), { code: "ENOENT" });
  await unlink(f.file);
  assert.equal((await readMatchSelection(f.config)).selected[0].title, "Public title");
  await reviewResults(f.config);
  const html = await readFile(f.config.files.reviewHtml, "utf8"), csv = await readFile(f.config.files.reviewCsv, "utf8");
  assert(html.includes("승인한 공개 메타데이터·출처") && html.includes(stored.evidence.file_sha256));
  assert(html.includes(f.document.provenance.checked_at));
  assert(csv.includes("public_metadata_title") && csv.includes(stored.evidence.file_sha256));
  assert.equal((await applyPlaylist(f.config)).would_add, 1);
});

test("any evidence content or byte change invalidates the prior approval hash", async t => {
  const f = await fixture(t), first = await resolveUnavailableMatch(f.config, f.options);
  f.document.public_metadata.album = "Reissued album";
  await writeFile(f.file, JSON.stringify(f.document));
  await assert.rejects(resolveUnavailableMatch(f.config, { ...f.options, confirm: true, expectedPreview: first.preview_hash }), /바뀌었습니다/);
  const second = await resolveUnavailableMatch(f.config, f.options);
  await writeFile(f.file, JSON.stringify(f.document, null, 2));
  await assert.rejects(resolveUnavailableMatch(f.config, { ...f.options, confirm: true, expectedPreview: second.preview_hash }), /바뀌었습니다/);
  await assert.rejects(readFile(f.config.files.unavailableMatches), { code: "ENOENT" });
});

test("evidence changed during lookup is rejected in preview and confirmation", async t => {
  const f = await fixture(t), original = await readFile(f.file, "utf8");
  const preview = await resolveUnavailableMatch(f.config, f.options);
  for (const confirm of [false, true]) {
    await writeFile(f.file, original);
    await assert.rejects(resolveUnavailableMatch(f.config, { ...f.options, confirm,
      ...(confirm ? { expectedPreview: preview.preview_hash } : {}),
      lookupClient: { lookupSongs: async () => { await writeFile(f.file, original + "\n"); return [apple]; } } }), /공개 근거 파일이 바뀌었습니다/);
  }
  await assert.rejects(readFile(f.config.files.unavailableMatches), { code: "ENOENT" });
});

test("wrong IDs, source hashes, provenance, malformed metadata and oversized files fail before lookup", async t => {
  const f = await fixture(t), invalid = [];
  const change = fn => { const d = structuredClone(f.document); fn(d); invalid.push(d); };
  change(d => d.melon_song_id = "101"); change(d => d.apple_music_song_id = "901");
  change(d => d.operating_source_sha256 = "a".repeat(64));
  change(d => d.public_metadata.title = ""); change(d => d.public_metadata.album_id = "301");
  change(d => d.provenance.song_url = "https://www.melon.com/song/detail.htm?songId=101");
  change(d => d.provenance.album_url = "https://evil.example/album/detail.htm?albumId=300");
  change(d => d.provenance.song_url = "https://user:secret@www.melon.com/song/detail.htm?songId=100");
  change(d => d.provenance.checked_at = "unknown"); change(d => d.provenance.method = "guessed");
  change(d => d.provenance.checked_at = "2026-11-01");
  change(d => d.public_metadata.duration_ms = -1); change(d => d.public_metadata.isrc = "invalid");
  change(d => d.limitations = []); change(d => d.approved = true);
  const options = { ...f.options, lookupClient: { lookupSongs: () => assert.fail("invalid evidence must fail before lookup") } };
  for (const d of invalid) { await writeFile(f.file, JSON.stringify(d)); await assert.rejects(resolveUnavailableMatch(f.config, options), /공개 근거/); }
  await writeFile(f.file, "not valid JSON with a private-marker");
  await assert.rejects(resolveUnavailableMatch(f.config, options), e => !e.message.includes("private-marker") && /공개 근거/.test(e.message));
  await writeFile(f.file, " ".repeat(64 * 1024 + 1));
  await assert.rejects(resolveUnavailableMatch(f.config, options), /공개 근거/);
  await assert.rejects(readFile(f.config.files.unavailableMatches), { code: "ENOENT" });
});

test("source drift excludes public mappings and corrupt embedded evidence stops readers", async t => {
  const f = await fixture(t); await save(f);
  const file = f.config.files.unavailableMatches, valid = await readFile(file, "utf8");
  const d = JSON.parse(valid); d.mappings[0].evidence.document.public_metadata.title = "tampered";
  await writeFile(file, JSON.stringify(d));
  for (const consume of [() => readMatchSelection(f.config), () => localStatus(f.config), () => applyPlaylist(f.config)]) await assert.rejects(consume, /공개 근거/);
  await writeFile(file, valid);
  const r = JSON.parse(valid); r.mappings[0].record.title = "tampered";
  await writeFile(file, JSON.stringify(r)); await assert.rejects(readMatchSelection(f.config), /공개 근거/);
  await writeFile(file, valid);
  const source = JSON.parse(await readFile(f.config.files.melonLikes, "utf8")); source.unavailable_songs[0].row_index++;
  await writeFile(f.config.files.melonLikes, JSON.stringify(source));
  const current = await readMatchSelection(f.config);
  assert.equal(current.selected.length, 0); assert.equal(current.unavailableRecords[0].match_status, "held");
  assert.equal(current.unavailableRecords[0].public_metadata_title, "Public title");
});

test("new evidence applies only through existing selection guards and preserves duplicate prevention", async t => {
  const f = await fixture(t); await save(f);
  await writeFile(f.config.files.manualMatches, JSON.stringify({ songs: [{ ...awake, match_status: "manual_confirmed", apple_music_song_id: "900" }] }));
  const selection = await readMatchSelection(f.config);
  assert.equal(selection.selected.length, 1); assert.equal(selection.unavailableRecords[0].unavailable_mapping_duplicate, true);
});

test("review escapes public metadata and CLI exposes evidence only for supported commands", async t => {
  const f = await fixture(t); f.document.public_metadata.title = '<script>alert("x")</script>';
  await writeFile(f.file, JSON.stringify(f.document)); await save(f); await reviewResults(f.config);
  const html = await readFile(f.config.files.reviewHtml, "utf8");
  assert(!html.includes('<script>alert("x")</script>'));
  assert(html.includes("&lt;script&gt;alert"));
  const parsed = parseArgs(["resolve-unavailable", "--evidence-file", "evidence.json"]);
  assert.equal(parsed.options.evidenceFile, "evidence.json");
  assert.throws(() => parseArgs(["resolve", "--evidence-file", "evidence.json"]), /알 수 없는 옵션/);
  assert.throws(() => parseArgs(["resolve-unavailable", "--execute"]), /알 수 없는 옵션/);
});
