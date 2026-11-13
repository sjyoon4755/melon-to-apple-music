import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditMatches } from "../scripts/audit-matches.js";

test("offline audit preserves all input bytes and manual confirmations and refuses reused output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "match-audit-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "data"), { recursive: true });
  const song = { melon_song_id: "1", title: "Song (Feat. B)", artist: "A" };
  const automatic = { ...song, apple_music_song_id: "2", apple_music_title: "Song (Feat. C)",
    apple_music_artist: "A", match_status: "matched", match_score: 1, match_margin: 1,
    candidates: [{ id: "2", title: "Song (Feat. C)", artist: "A" }] };
  const manual = { ...song, melon_song_id: "3", match_status: "manual_confirmed" };
  const documents = { melon_likes: { songs: [song, manual], complete: false },
    matched: { songs: [automatic] }, unmatched: { songs: [manual] }, manual_matches: { songs: [manual] } };
  for (const [name, document] of Object.entries(documents)) {
    await writeFile(path.join(source, "data", `${name}.json`), JSON.stringify(document));
  }
  const output = path.join(root, "report");
  const summary = await auditMatches(source, output);
  assert.equal(summary.automatic_audited, 1);
  assert.equal(summary.needs_review, 1);
  assert.equal(summary.manual_preserved, 1);
  assert.equal(summary.unresolved, 0);
  assert.equal(summary.network_used, false);
  assert.match(await readFile(path.join(output, "needs-review.csv"), "utf8"), /guest_artist_mismatch/);
  for (const [name, document] of Object.entries(documents)) {
    assert.equal(await readFile(path.join(source, "data", `${name}.json`), "utf8"), JSON.stringify(document));
  }
  await assert.rejects(auditMatches(source, output), { code: "EEXIST" });
  await assert.rejects(auditMatches(source, path.join(source, "report")), /outside the source/);
});
