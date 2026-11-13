import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scoreCandidate, matchReasons } from "../src/matcher.js";
import { writeCsv } from "../src/io.js";

// Offline: open only these four data files, never profiles or pipeline clients.
export async function auditMatches(sourceRoot, outputDir) {
  const source = path.resolve(sourceRoot);
  const output = path.resolve(outputDir);
  const relative = path.relative(source, output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("Audit output must be outside the source repository.");
  }
  const documents = {};
  const hashes = {};
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const name of ["melon_likes", "matched", "unmatched", "manual_matches"]) {
    const bytes = await readFile(path.join(source, "data", `${name}.json`));
    hashes[name] = digest(bytes);
    documents[name] = JSON.parse(bytes);
  }
  const sourceById = new Map(documents.melon_likes.songs.map((s) => [String(s.melon_song_id), s]));
  const manualIds = new Set(documents.manual_matches.songs.map((s) => String(s.melon_song_id)));
  const options = { threshold: documents.matched.match_config?.threshold ?? 0.88,
    minMargin: documents.matched.match_config?.min_margin ?? 0.06 };
  const rows = documents.matched.songs.map((record) => {
    const song = sourceById.get(String(record.melon_song_id));
    const stored = record.candidates?.find((c) => String(c.id) === String(record.apple_music_song_id));
    // Selected saved fields are authoritative; aliases come only from its saved candidate.
    const candidate = { ...stored, id: record.apple_music_song_id, title: record.apple_music_title,
      artist: record.apple_music_artist, album: record.apple_music_album,
      duration_ms: record.apple_music_duration_ms, isrc: record.apple_music_isrc,
      content_rating: record.apple_music_content_rating };
    const scored = song ? scoreCandidate(song, candidate) : null;
    const margin = record.match_margin ?? null;
    const reasons = scored ? matchReasons({ status: "ambiguous", best: scored, margin: margin ?? 0 }, options)
      .filter((r) => r !== "needs_review") : ["source_record_missing"];
    if (!stored) reasons.push("saved_candidate_alias_evidence_missing");
    if (margin == null) reasons.push("saved_margin_missing");
    return { melon_song_id: record.melon_song_id, title: song?.title ?? record.title,
      artist: song?.artist ?? record.artist, apple_music_song_id: candidate.id,
      apple_music_title: candidate.title, apple_music_artist: candidate.artist,
      previous_status: record.match_status, previous_score: record.match_score,
      audit_score: scored?.score ?? null, saved_margin: margin,
      audit_status: reasons.length ? "needs_review" : "no_new_review_reason", reasons,
      evidence: stored ? "saved_selected_candidate" : "saved_selected_metadata_only",
      manual_confirmed_preserved: manualIds.has(String(record.melon_song_id)),
      components: scored?.components ?? null };
  });
  const reasonCounts = {};
  for (const row of rows) for (const reason of row.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  const summary = { source_root: source, audited_at: new Date().toISOString(), network_used: false,
    interpretation: "Review flags are not confirmed mismatches. Only saved evidence was used; no search or decisions were written.",
    source_count: documents.melon_likes.songs.length,
    unavailable_count: documents.melon_likes.unavailable_songs?.length ?? 0,
    source_complete: documents.melon_likes.complete,
    source_stop_reason: documents.melon_likes.extraction?.stop_reason,
    reported_count_gap: documents.melon_likes.extraction?.reported_count_gap,
    checkpoint: documents.melon_likes.checkpoint?.next_start_index,
    automatic_audited: rows.length, manual_preserved: documents.manual_matches.songs.length,
    unresolved: documents.unmatched.songs.filter((s) => !manualIds.has(String(s.melon_song_id))).length,
    needs_review: rows.filter((r) => r.audit_status === "needs_review").length,
    no_new_review_reason: rows.filter((r) => r.audit_status !== "needs_review").length,
    reason_counts: reasonCounts, match_options: options, source_sha256: hashes };
  for (const [name, hash] of Object.entries(hashes)) {
    if (digest(await readFile(path.join(source, "data", `${name}.json`))) !== hash) {
      throw new Error(`Source changed during audit: ${name}`);
    }
  }
  // Require a fresh directory to avoid replacing an earlier report.
  await mkdir(output, { recursive: false });
  await writeFile(path.join(output, "audit.json"), JSON.stringify({ summary, rows }, null, 2) + "\n", { flag: "wx" });
  await writeCsv(path.join(output, "needs-review.csv"), rows.filter((r) => r.audit_status === "needs_review"),
    ["melon_song_id", "title", "artist", "apple_music_song_id", "apple_music_title", "apple_music_artist",
      "previous_status", "previous_score", "audit_score", "saved_margin", "audit_status", "reasons", "evidence"]);
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: node scripts/audit-matches.js SOURCE_ROOT FRESH_OUTPUT_DIRECTORY");
  console.log(JSON.stringify(await auditMatches(process.argv[2], process.argv[3]), null, 2));
}
