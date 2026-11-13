import test from "node:test";
import assert from "node:assert/strict";
import { chooseMatch, matchReasons, normalizeText, scoreCandidate, similarity } from "../src/matcher.js";

test("normalizes punctuation, case and featuring text", () => {
  assert.equal(normalizeText("Hello (Feat. Jane) — REMASTERED"), "hello remastered");
  assert.equal(similarity("봄날", "봄 날"), 1);
});

test("matches exact metadata with a high score", () => {
  const melon = { title: "Ditto", artist: "NewJeans", album: "OMG", duration_ms: 185_000 };
  const apple = { id: "1", title: "Ditto", artist: "NewJeans", album: "OMG", duration_ms: 185_500 };
  const result = scoreCandidate(melon, apple);
  assert.ok(result.score > 0.99);
  assert.equal(result.components.qualifier_mismatch, false);
});

test("accepts Korean/English artist aliases in parentheses", () => {
  const melon = { title: "LOVE DIVE", artist: "아이브 (IVE)", album: "LOVE DIVE" };
  const apple = { id: "1", title: "LOVE DIVE", artist: "IVE", album: "LOVE DIVE" };
  assert.ok(scoreCandidate(melon, apple).score >= 0.99);
});

test("uses source-storefront aliases when the KR result localizes an artist", () => {
  const melon = { title: "Marlow", artist: "Doyun", album: "Atelier" };
  const apple = {
    id: "1", title: "Marlow", artist: "도윤", artist_aliases: ["도윤", "Doyun"],
    album: "Atelier - EP"
  };
  assert.ok(scoreCandidate(melon, apple).score >= 0.98);
});

test("penalizes live/studio version mismatches", () => {
  const melon = { title: "Song", artist: "Artist", album: "Album" };
  const apple = { id: "1", title: "Song (Live)", artist: "Artist", album: "Album" };
  const result = scoreCandidate(melon, apple);
  assert.equal(result.components.qualifier_mismatch, true);
  assert.ok(result.score < 0.88);
});

test("penalizes explicit/clean mismatches when ratings are known", () => {
  const melon = { title: "Song", artist: "Artist", album: "Album", content_rating: "explicit" };
  const apple = { id: "1", title: "Song", artist: "Artist", album: "Album", content_rating: null };
  assert.ok(scoreCandidate(melon, apple).score < 0.88);
});

test("requires a margin over the second candidate", () => {
  const melon = { title: "Stay", artist: "Artist", album: "Album" };
  const candidates = [
    { id: "1", title: "Stay", artist: "Artist", album: "Album" },
    { id: "2", title: "Stay", artist: "Artist", album: "Album" }
  ];
  assert.equal(chooseMatch(melon, candidates).status, "ambiguous");
});

test("exact ISRC wins", () => {
  const melon = { title: "Slightly Different", artist: "Artist", isrc: "KR-A12-34-56789" };
  const apple = { id: "1", title: "Different", artist: "Artist", isrc: "kra123456789" };
  assert.equal(scoreCandidate(melon, apple).score, 1);
});

test("explains absent candidates, ties, version mismatches and retained candidate totals", () => {
  const song = { title: "Song", artist: "Artist", album: "Album" };
  assert.deepEqual(chooseMatch(song, []).reasons, ["no_candidates"]);
  const tied = chooseMatch(song, Array.from({ length: 7 }, (_, id) => ({ ...song, id: String(id) })));
  assert.equal(tied.candidate_count, 7);
  assert.equal(tied.candidates.length, 5);
  assert.deepEqual(tied.reasons, ["insufficient_margin"]);
  assert.deepEqual(chooseMatch(song, [{ ...song, id: "1", title: "Song (Live)" }]).reasons,
    ["below_threshold", "version_mismatch"]);
  assert.deepEqual(chooseMatch(song, [{ ...song, id: "1" }]).reasons, ["high_confidence"]);
  assert.deepEqual(matchReasons({ status: "manual_confirmed" }), ["user_confirmed"]);
});

const baseSong = { title: "Song", artist: "A", album: "Album" };

test("different guests and missing collaborators cannot auto-match, even with exact ISRC", () => {
  for (const [source, candidate, reason] of [
    [{ title: "Song (Feat. B)" }, { title: "Song (Feat. C)" }, "guest_artist_mismatch"],
    [{ artist: "A, B" }, {}, "participant_information_missing"],
    [{ title: "Song (Vocal B)" }, {}, "guest_artist_information_missing"],
    [{ title: "Song (Song By B)" }, { title: "Song (Song By C)" }, "guest_artist_mismatch"],
    [{ artist: "A", artists: ["A", "B"] }, {}, "participant_information_missing"],
    [{ artist: "A", title: "Song (Feat. B)" }, { artist: "B", title: "Song (Feat. A)" }, "guest_artist_role_conflict"]
  ]) {
    for (const isrc of [undefined, "KR1234567890"]) {
      const result = chooseMatch({ ...baseSong, ...source, isrc }, [{ ...baseSong, ...candidate, isrc }]);
      assert.equal(result.status, "ambiguous");
      assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
    }
  }
});

test("compares complete bilingual aliases and delimiter variants without best-pair shortcuts", () => {
  for (const artist of ["Doyun & IVE", "IVE and Doyun", "Doyun / IVE", "IVE x Doyun"]) {
    assert.equal(chooseMatch({ ...baseSong, artist: "아이브 (IVE), 도윤 (Doyun)" },
      [{ ...baseSong, artist }]).status, "matched");
  }
  assert.equal(chooseMatch({ ...baseSong, title: "Song (Feat. 도윤 (Doyun))" },
    [{ ...baseSong, title: "Song (featuring Doyun)" }]).status, "matched");
  assert.equal(chooseMatch({ ...baseSong, title: "Song (Feat. B)" },
    [{ ...baseSong, artist: "A & B" }]).status, "matched");
  assert.equal(chooseMatch({ ...baseSong, title: "Song (Feat. 김호연)" },
    [{ ...baseSong, title: "Song (Feat. Hoyeon Kim)", title_aliases: ["Song (Feat. 김호연)"] }]).status, "matched");
  assert.equal(chooseMatch({ ...baseSong },
    [{ ...baseSong, title: "Song (Feat. B)", title_aliases: ["Song"] }]).status, "ambiguous");
  assert.equal(chooseMatch({ ...baseSong, artist: "A & B" },
    [{ ...baseSong, artist: "A & C", artist_aliases: ["A"] }]).status, "ambiguous");
  assert.equal(chooseMatch({ ...baseSong, artist: "Artist" },
    [{ ...baseSong, artist: "Artist2" }]).status, "ambiguous");
  assert.equal(chooseMatch({ ...baseSong, artist: "X Ambassadors" },
    [{ ...baseSong, artist: "Ambassadors" }]).status, "ambiguous");
});

test("explicit language and arrangement conflicts or omissions require review", () => {
  for (const [a, b, reason] of [
    ["English Ver.", "Korean Ver.", "language_version_conflict"],
    ["Japanese Version", "English Version", "language_version_conflict"],
    ["Guitar Ver.", "Cello Ver.", "arrangement_version_conflict"],
    ["Band Version", "Guitar Version", "arrangement_version_conflict"],
    ["English Ver.", "", "language_version_information_missing"],
    ["Cello Ver.", "", "arrangement_version_information_missing"]
  ]) {
    const result = chooseMatch({ ...baseSong, title: `Song (${a})`, isrc: "same" },
      [{ ...baseSong, title: b ? `Song (${b})` : "Song", isrc: "same" }]);
    assert.equal(result.status, "ambiguous");
    assert.ok(result.reasons.includes(reason));
  }
  assert.equal(chooseMatch({ ...baseSong, title: "English Guitar", artist: "Korean Band" },
    [{ ...baseSong, title: "English Guitar", artist: "Korean Band" }]).status, "matched");
  assert.equal(chooseMatch({ ...baseSong, title: "Song (Prod. Guitar)" },
    [{ ...baseSong, title: "Song (Prod. Guitar)" }]).status, "matched");
  assert.equal(chooseMatch({ ...baseSong, title: "Song (Band Ver.)" },
    [{ ...baseSong, title: "Song (Band Ver.)" }]).status, "matched");
  const prod = scoreCandidate({ ...baseSong, title: "Song (Prod. Guitar Version)" }, baseSong);
  assert.deepEqual(prod.components.editions.source.arrangement, []);
  const guestProd = scoreCandidate({ ...baseSong, title: "Song (Feat. B, Prod. C)" },
    { ...baseSong, title: "Song (Feat. B)" });
  assert.deepEqual(guestProd.components.identity_reasons, []);
});

test("missing primary artist is explained rather than rescued by title or ISRC", () => {
  const result = chooseMatch({ ...baseSong, artist: "", isrc: "same" }, [{ ...baseSong, isrc: "same" }]);
  assert.equal(result.status, "ambiguous");
  assert.ok(result.reasons.includes("primary_artist_missing"));
});
