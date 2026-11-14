import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { readMatchSelection } from "../src/match-decisions.js";
import { parseArgs } from "../src/cli-options.js";
import { exportInactiveReview, inactiveInputFromAudit, readInactiveReview, renderInactiveReview } from "../src/inactive-review.js";

const record = () => ({ source_kind: "inactive", melon_song_id: "2", status: "held",
  metadata: { title: "<script>alert(1)</script>", artist: "A", album: "Album", album_id: "3", isrc: null, duration_ms: null, content_rating: null },
  provenance: { song_url: "https://www.melon.com/song/detail.htm?songId=2", album_url: "https://www.melon.com/album/detail.htm?albumId=3",
    checked_at: "2026-10-13T00:00:00Z", method: "public-detail", evidence_references: ["saved-report.json"] },
  candidates: [{ id: "9", title: "Song", artist: "A", album: "Album", isrc: "USAAA1200001", duration_ms: 1000, content_rating: null,
    url: "https://music.apple.com/kr/album/song/8?i=9" }], uncertainties: ["원본 녹음 미확인"], review_evidence: { original_note: "preserve" } });
const document = () => ({ schema_version: 1, source_kind: "inactive", records: [record()] });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-inactive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  await mkdir(config.dataDir);
  const source = { songs: [{ melon_song_id: "1", title: "Normal", artist: "A", album: "Album" }],
    unavailable_songs: [{ melon_song_id: "2", reason: "disabled_no_result", row_index: 3, page_start_index: 1 }] };
  await writeFile(config.files.melonLikes, JSON.stringify(source));
  await writeFile(config.files.matched, JSON.stringify({ songs: [{ ...source.songs[0], match_status: "matched", apple_music_song_id: "9" }] }));
  await writeFile(config.files.importState, JSON.stringify({ added_song_ids: ["9"] }));
  const inputFile = path.join(root, "input.json");
  await writeFile(inputFile, JSON.stringify(document()));
  const before = Object.fromEntries(await Promise.all((await readdir(config.dataDir)).map(async name => [name, await readFile(path.join(config.dataDir, name), "utf8")])));
  return { root, config, inputFile, source, before, options: { inputFile } };
}

test("read-only intake preserves provenance, held reasons and evidence without normal selection changes", async t => {
  const f = await fixture(t), selection = await readMatchSelection(f.config);
  const result = await readInactiveReview(f.config, f.options);
  assert.deepEqual(result.input, document());
  assert.equal(result.rows[0].review_evidence.original_note, "preserve");
  assert.equal(result.rows[0].status, "held");
  assert.equal(result.rows[0].recording_identity, "unproven");
  assert.equal(result.rows[0].candidate_checks[0].checkpoint_present, true);
  assert.equal(result.rows[0].candidate_checks[0].normal_selection_present, true);
  assert.equal(result.summary.apply_eligible, 0);
  assert.equal(result.summary.approved, 0);
  assert.equal(result.summary.remote_checked, false);
  assert.deepEqual((await readMatchSelection(f.config)).records, selection.records);
  for (const [name, content] of Object.entries(f.before)) assert.equal(await readFile(path.join(f.config.dataDir, name), "utf8"), content);
  assert.deepEqual((await readdir(f.root)).sort(), ["data", "input.json"]);
});

test("invalid input, missing provenance, duplicate IDs/candidates and executable states fail before output", async t => {
  const f = await fixture(t);
  const invalid = [
    d => { d.schema_version = 2; }, d => { d.source_kind = "normal"; },
    d => { d.records[0].melon_song_id = 2; }, d => { d.records[0].source_kind = "normal"; },
    d => { delete d.records[0].provenance; }, d => { delete d.records[0].provenance.checked_at; },
    d => { d.records[0].provenance.song_url = "https://www.melon.com/song/detail.htm?songId=99"; },
    d => { d.records[0].candidates[0].url = "javascript:alert(1)"; },
    d => { d.records[0].candidates[0].url = "https://music.apple.com/us/song/9"; },
    d => { d.records[0].candidates[0].duration_ms = -1; },
    d => { d.records[0].candidates[0].isrc = "unknown"; },
    d => { d.records[0].metadata.isrc = "unknown"; },
    d => { d.records[0].metadata.duration_ms = -1; },
    d => { d.records[0].metadata.content_rating = "safe"; },
    d => { d.records[0].uncertainties = []; },
    d => { d.records.push(d.records[0]); }, d => { d.records[0].candidates.push(d.records[0].candidates[0]); },
    d => { d.records[0].approved = true; }, d => { d.records[0].status = "applied_verified"; }
  ];
  for (const mutate of invalid) {
    const d = document(); mutate(d); await writeFile(f.inputFile, JSON.stringify(d));
    await assert.rejects(exportInactiveReview(f.config, { ...f.options, outputDir: path.join(f.root, "output") }));
  }
  await writeFile(f.inputFile, "not json");
  await assert.rejects(readInactiveReview(f.config, f.options), /JSON/);
  assert.deepEqual((await readdir(f.root)).sort(), ["data", "input.json"]);
});

test("normal-list contamination, unknown unavailable IDs, duplicate observations and source changes are blocked", async t => {
  const f = await fixture(t);
  for (const source of [
    { ...f.source, songs: [...f.source.songs, { melon_song_id: "2" }] },
    { ...f.source, unavailable_songs: [] },
    { ...f.source, unavailable_songs: [...f.source.unavailable_songs, ...f.source.unavailable_songs] },
    { ...f.source, unavailable_songs: [{ melon_song_id: "2", reason: "other" }] }
  ]) {
    await writeFile(f.config.files.melonLikes, JSON.stringify(source));
    await assert.rejects(readInactiveReview(f.config, f.options));
  }
  await writeFile(f.config.files.melonLikes, JSON.stringify(f.source));
  await assert.rejects(readInactiveReview(f.config, { ...f.options, melonSongId: "99" }), /입력에 없는/);
});

test("duplicate Apple targets remain separate source records with explicit local diagnostics", async t => {
  const f = await fixture(t), d = document();
  const second = structuredClone(d.records[0]); second.melon_song_id = "4"; second.provenance.song_url = "https://www.melon.com/song/detail.htm?songId=4";
  d.records.push(second);
  await writeFile(f.inputFile, JSON.stringify(d));
  await writeFile(f.config.files.melonLikes, JSON.stringify({ ...f.source, unavailable_songs: [...f.source.unavailable_songs, { melon_song_id: "4", reason: "disabled_no_result" }] }));
  const result = await readInactiveReview(f.config, f.options);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0].candidate_checks[0].inactive_source_ids, ["2", "4"]);
  assert(result.rows.every(row => row.candidate_checks[0].duplicate_target && row.apply_eligible === false));
});

test("new output is deterministic and repeated exports do not overwrite altered or unrelated files", async t => {
  const f = await fixture(t), outputDir = path.join(f.root, "review");
  const first = await exportInactiveReview(f.config, { ...f.options, outputDir });
  const bytes = await readFile(path.join(outputDir, "inactive-review.json"), "utf8");
  const second = await exportInactiveReview(f.config, { ...f.options, outputDir });
  assert.equal(first.already_exported, false); assert.equal(second.already_exported, true);
  assert.equal(await readFile(path.join(outputDir, "inactive-review.json"), "utf8"), bytes);
  const roundTrip = await exportInactiveReview(f.config, { inputFile: path.join(outputDir, "inactive-input.json"), outputDir });
  assert.equal(roundTrip.already_exported, true);
  await writeFile(path.join(outputDir, "inactive-review.json"), "user edit");
  await assert.rejects(exportInactiveReview(f.config, { ...f.options, outputDir }), /새 --output-dir/);
  assert.equal(await readFile(path.join(outputDir, "inactive-review.json"), "utf8"), "user edit");
  await assert.rejects(exportInactiveReview(f.config, { ...f.options, outputDir: f.root }), /덮어쓰지/);
});

test("data/state/code output paths and junction aliases are rejected", async t => {
  const f = await fixture(t);
  for (const dir of [f.config.dataDir, f.config.stateDir, path.join(f.root, "src")]) {
    await assert.rejects(exportInactiveReview(f.config, { ...f.options, outputDir: path.join(dir, "new") }), /운영·코드/);
  }
  const alias = path.join(f.root, "alias");
  await symlink(f.config.dataDir, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportInactiveReview(f.config, { ...f.options, outputDir: path.join(alias, "new") }), /운영·코드/);
});

test("audit adapter imports only exact inactive IDs and retains original evidence", () => {
  const r = record();
  const row = { group: "inactive7", source_id: "2", current_public_source: { url: r.provenance.song_url,
    title: r.metadata.title, artists: [{ name: "A" }], fields: { 앨범: "Album" }, album_id: "3", at: r.provenance.checked_at },
    current_candidates: r.candidates, uncertainties: r.uncertainties, evidence_references: ["old.md"] };
  const audit = { summary: { exact_scope: { inactive7: ["2"] } }, rows: [row, { group: "edition15", source_id: "1" }] };
  const input = inactiveInputFromAudit(audit);
  assert.equal(input.records.length, 1); assert.deepEqual(input.records[0].review_evidence, row);
  assert.throws(() => inactiveInputFromAudit({ ...audit, rows: [row, row] }), /범위|중복/);
  assert.throws(() => inactiveInputFromAudit({ ...audit, rows: [] }), /범위/);
});

test("HTML has escaped evidence, no scripts, no execute controls and zero eligibility", async t => {
  const f = await fixture(t), html = renderInactiveReview(await readInactiveReview(f.config, f.options));
  assert(!html.includes("<script>")); assert(html.includes("&lt;script&gt;"));
  assert(html.includes("원본 녹음 미확인")); assert(html.includes("적용 가능 0개"));
  assert(html.includes("Content-Security-Policy")); assert(!html.includes("<form"));
});

test("CLI workflow supports local review and denies approval/execute options", async t => {
  const f = await fixture(t), cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const args = [cli, "inactive-review", "--input-file", f.inputFile, "--data-dir", f.config.dataDir];
  const result = JSON.parse(execFileSync(process.execPath, args, { cwd: f.root, env: { ...process.env, HOME: f.root, USERPROFILE: f.root }, encoding: "utf8" }));
  assert.equal(result.review_records, 1); assert.equal(result.apply_eligible, 0); assert.equal(result.output_dir, null);
  for (const flag of ["--execute", "--confirm", "--hold", "--backend"]) assert.throws(() => parseArgs(["inactive-review", flag]), /알 수 없는 옵션/);
  assert.throws(() => execFileSync(process.execPath, [cli, "inactive-review"], { cwd: f.root, env: { ...process.env, HOME: f.root, USERPROFILE: f.root }, encoding: "utf8", stdio: "pipe" }), /input-file/);
  const help = execFileSync(process.execPath, [cli, "inactive-review", "--help"], { cwd: f.root, env: { ...process.env, HOME: f.root, USERPROFILE: f.root }, encoding: "utf8" });
  assert(help.includes("inactive-review --input-file"));
});
