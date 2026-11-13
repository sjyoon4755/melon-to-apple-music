import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveConfig } from "../src/config.js";
import { reviewResults } from "../src/pipeline.js";

const criteria = { threshold: 0.88, min_margin: 0.06 };
const song = (id, extra = {}) => ({ melon_song_id: id, title: `원곡 ${id}`, artist: "가수", album: "앨범",
  duration_ms: null, isrc: null, ...extra });
const candidate = (id, extra = {}) => ({ id, title: `후보 ${id}`, artist: "후보 가수", album: "후보 앨범",
  score: 0.91, ...extra });

async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  await mkdir(config.dataDir, { recursive: true });
  const save = async (file, value) => writeFile(file, JSON.stringify(value));
  return { config, save };
}

test("review compares all stored candidates, explains missing/truncated evidence and escapes active content", async (t) => {
  const { config, save } = await project(t);
  const songs = [song("1", { title: '<img src=x onerror="alert(1)">' }), song("2"), song("3")];
  const records = [
    { ...songs[0], match_status: "ambiguous", match_score: 0.91, match_margin: 0,
      candidates: [candidate("11", { url: "javascript:alert(1)", title: "</script><script>alert(1)</script>",
        components: { identity_reasons: ["guest_artist_mismatch"] } }),
      candidate("12", { duration_ms: 181000, url: "https://music.apple.com/kr/album/a/10?i=12" })] },
    { ...songs[1], match_status: "not_found", candidates: [] },
    { ...songs[2], match_status: "ambiguous", candidates: Array.from({ length: 5 }, (_, i) => candidate(String(20 + i))) }
  ];
  await save(config.files.melonLikes, { complete: false, songs });
  await save(config.files.unmatched, { match_config: criteria, songs: records });
  await save(config.files.manualMatches, { songs: [] });
  await save(config.files.matchDecisions, { schema_version: 1, decisions: [] });
  await save(config.files.importState, { added_song_ids: ["999"] });
  const files = [config.files.melonLikes, config.files.unmatched, config.files.manualMatches, config.files.matchDecisions, config.files.importState];
  const before = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const summary = await reviewResults(config);
  assert.equal(summary.ambiguous, 2);
  const html = await readFile(config.files.reviewHtml, "utf8");
  for (const text of ["ID 11", "ID 12", "후보 가수", "후보 앨범", "0.9100", "3:01", "피처링 차이", "후보 총수 5+",
    "저장된 비교 후보가 없습니다", "우선 검토 1곡", "미확인 또는 미완료"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('</script><script>alert'));
  assert.ok(html.includes('href="https://music.apple.com/kr/album/a/10?i=12"'));
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), before);
});

test("alternate results enrich only unresolved comparisons, preserving manual approval and effective CSV", async (t) => {
  const { config, save } = await project(t);
  const songs = [song("1"), song("2")];
  await save(config.files.melonLikes, { songs });
  await save(config.files.unmatched, { match_config: criteria, songs: songs.map((s) => ({ ...s, match_status: "not_found", candidates: [] })) });
  await save(config.files.manualMatches, { songs: [{ ...songs[1], match_status: "manual_confirmed", apple_music_song_id: "55" }] });
  const alternateDir = path.join(config.root, "recent");
  await mkdir(alternateDir);
  await save(path.join(alternateDir, "matched.json"), { match_config: criteria, songs: [] });
  await save(path.join(alternateDir, "unmatched.json"), { match_config: criteria, songs: songs.map((s) => ({ ...s,
    match_status: "ambiguous", match_score: 0.92, candidates: [candidate(s.melon_song_id === "1" ? "91" : "92")] })) });
  const alternateBefore = await readFile(path.join(alternateDir, "unmatched.json"), "utf8");
  const result = await reviewResults(config, { candidatesDir: alternateDir });
  assert.equal(result.not_found, 1);
  assert.equal(result.manual_confirmed, 1);
  const html = await readFile(config.files.reviewHtml, "utf8");
  assert.ok(html.includes("별도 재검색 결과"));
  assert.ok(html.includes("ID 91"));
  assert.ok(!html.includes("ID 92"));
  assert.ok(html.includes("ID 55"));
  assert.ok(html.includes("우선 검토 1곡"));
  assert.ok(!(await readFile(config.files.reviewCsv, "utf8")).includes("후보 91"));
  assert.equal(await readFile(path.join(alternateDir, "unmatched.json"), "utf8"), alternateBefore);
  await save(path.join(alternateDir, "unmatched.json"), { match_config: criteria,
    songs: [{ ...songs[0], album: "변경된 앨범", match_status: "ambiguous" }] });
  const before = await readFile(config.files.reviewHtml, "utf8");
  await assert.rejects(reviewResults(config, { candidatesDir: alternateDir }), /원곡 정보/);
  assert.equal(await readFile(config.files.reviewHtml, "utf8"), before);
});

test("held decisions keep their candidates and reason when an alternate search includes them", async (t) => {
  const { config, save } = await project(t);
  const { reviseMatch } = await import("../src/pipeline.js");
  const original = song("1");
  await save(config.files.melonLikes, { songs: [original] });
  await save(config.files.matched, { match_config: criteria, songs: [{ ...original, match_status: "matched",
    apple_music_song_id: "11", candidates: [candidate("11")] }] });
  config.applyLockDir = path.join(config.root, "locks");
  const opts = { melonSongId: "1", hold: true, reason: "버전 확인 필요" };
  const preview = await reviseMatch(config, opts);
  await reviseMatch(config, { ...opts, confirm: true, expectedPreview: preview.preview_hash });
  const alternateDir = path.join(config.root, "recent");
  await mkdir(alternateDir);
  await save(path.join(alternateDir, "matched.json"), { match_config: criteria, songs: [] });
  await save(path.join(alternateDir, "unmatched.json"), { match_config: criteria, songs: [{ ...original,
    match_status: "ambiguous", match_score: 1, candidates: [candidate("99")] }] });
  const before = await readFile(config.files.matchDecisions, "utf8");
  await reviewResults(config, { candidatesDir: alternateDir });
  const html = await readFile(config.files.reviewHtml, "utf8");
  assert.ok(html.includes("보류 전 연결"));
  assert.ok(html.includes("버전 확인 필요"));
  assert.ok(!html.includes("ID 99"));
  assert.ok(html.includes("우선 검토 0곡"));
  assert.equal(await readFile(config.files.matchDecisions, "utf8"), before);
});

test("alternate report rejects missing inputs, duplicate IDs and inconsistent criteria", async (t) => {
  const { config, save } = await project(t);
  const dir = path.join(config.root, "recent");
  await mkdir(dir);
  await assert.rejects(reviewResults(config, { candidatesDir: dir }), /필요합니다/);
  await save(path.join(dir, "matched.json"), { match_config: criteria, songs: [{ ...song("1"), match_status: "matched" }] });
  await save(path.join(dir, "unmatched.json"), { match_config: criteria, songs: [{ ...song("1"), match_status: "ambiguous" }] });
  await assert.rejects(reviewResults(config, { candidatesDir: dir }), /중복/);
  await save(path.join(dir, "unmatched.json"), { match_config: { ...criteria, threshold: 0.95 }, songs: [] });
  await assert.rejects(reviewResults(config, { candidatesDir: dir }), /판정 기준/);
});

test("review offers decision controls only for unresolved songs and blocks doubtful top-1 bulk picks", async (t) => {
  const { config, save } = await project(t);
  const songs = ["1", "2", "3", "4", "5"].map((id) => song(id));
  await save(config.files.melonLikes, { songs });
  await save(config.files.unmatched, { match_config: criteria, songs: [
    { ...songs[0], match_status: "ambiguous", match_score: 0.91, candidates: [candidate("11"), candidate("12", { score: 0.5 })] },
    { ...songs[1], match_status: "ambiguous", candidates: [candidate("21", { score: 0.95, components: { qualifier_mismatch: true } })] },
    { ...songs[2], match_status: "ambiguous", candidates: [candidate("31", { score: 0.5 })] },
    { ...songs[3], match_status: "not_found", candidates: [] }
  ] });
  await save(config.files.manualMatches, { songs: [{ ...songs[4], match_status: "manual_confirmed", apple_music_song_id: "55" }] });
  await reviewResults(config);
  const html = await readFile(config.files.reviewHtml, "utf8");
  const block = (id) => html.match(new RegExp(`<div class="decide" data-melon="${id}" data-top="([^"]*)" data-top-blocked="([^"]*)">`))?.slice(1);
  assert.deepEqual(block("1"), ["11", ""]);
  assert.deepEqual(block("2"), ["21", "버전이 다를 수 있음"]);
  assert.deepEqual(block("3"), ["31", "비슷한 정도가 낮음"]);
  assert.deepEqual(block("4"), ["", "후보 없음"]);
  assert.equal(block("5"), undefined);
  assert.equal((html.match(/name="pick-1" value="1[12]"/g) ?? []).length, 2);
  assert.ok(!html.includes('name="pick-5"'));
  assert.match(html, /<main data-fingerprint="[^"]+">/);
  assert.ok(html.includes('<option value="unresolved" selected>결정할 곡 (4)</option>'));
  assert.equal((html.match(/value="__skip"/g) ?? []).length, 4);
  assert.ok(html.includes("music.apple.com/kr/search?term=" + encodeURIComponent("원곡 4 가수")));
  assert.ok(html.includes("--decisions-file &quot;$HOME/Downloads/review-decisions.json&quot;"));
  const vm = await import("node:vm");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});
