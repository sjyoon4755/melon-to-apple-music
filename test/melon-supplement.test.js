import test from "node:test";
import assert from "node:assert/strict";
import { mergeArtistSupplement, collectArtistSupplement } from "../src/melon-supplement.js";

const song = id => ({ melon_song_id: String(id), title: `Song ${id}`, artist: "Artist", duration_ms: null });
const inactive = id => ({ ...song(id), reason: "disabled_with_metadata", row_index: 1 });
function base() {
  return { complete: false, source: { total_reported: 4 }, songs: [song(10000), song(10001)], unavailable_songs: [],
    checkpoint: { next_start_index: 1, verified_scan: { start_index: 1, total_reported: 4, raw_row_count: 2,
      song_ids: ["10000", "10001"], pages: [{ start_index: 1, next_start_index: null, raw_row_count: 2,
        parsed_row_count: 2, unavailable_row_count: 0 }] } },
    extraction: { stop_reason: "total_mismatch" } };
}
function page(songs, unavailable_songs, start_index = 1, next_start_index = null) {
  return { start_index, next_start_index, songs, unavailable_songs, raw_row_count: songs.length + unavailable_songs.length,
    unparsed_row_count: 0 };
}
function evidence() {
  return { method: "artist-filter-dom", verified_at: "2026-11-01T07:56:13.147Z", total_reported_before: 4,
    total_reported_after: 4, filters: [
      { artist_id: "10", total_reported: 2, pages: [page([song(10000)], [inactive(10002)])] },
      { artist_id: "20", total_reported: 2, pages: [page([], [inactive(10002), inactive(10003)])] }
    ] };
}

test("unions overlapping artist filters, preserves the base scan and existing recording metadata, and replays idempotently", () => {
  const document = base();
  document.songs[0].duration_ms = 1466000;
  const original = structuredClone(document);
  const result = mergeArtistSupplement(document, evidence());
  assert.deepEqual(document, original);
  assert.deepEqual(result.songs, original.songs);
  assert.deepEqual(result.checkpoint.verified_scan, original.checkpoint.verified_scan);
  assert.equal(result.complete, true);
  assert.equal(result.extraction.stop_reason, "completed");
  assert.equal(result.unavailable_songs.length, 2);
  assert.equal(result.checkpoint.combined_verified_scan.raw_row_count, 4);
  assert.equal(result.checkpoint.artist_filter_supplement.supplemental_song_ids.length, 2);
  assert.deepEqual(mergeArtistSupplement(result, evidence()), result);
});

test("insufficient coverage and stale saved IDs never become complete", () => {
  const e = evidence();
  e.filters.pop();
  assert.equal(mergeArtistSupplement(base(), e).complete, false);
  const stale = base();
  stale.songs.push(song(99999));
  assert.equal(mergeArtistSupplement(stale, evidence()).complete, false);
});

test("validates all pages in a filter instead of treating its first page as complete", () => {
  const e = evidence();
  e.filters = [{ artist_id: "10", total_reported: 3, pages: [
    page([song(10000)], [inactive(10002)], 1, 3), page([], [inactive(10003)], 3)
  ] }];
  assert.equal(mergeArtistSupplement(base(), e).complete, true);
  e.filters[0].pages.pop();
  assert.throws(() => mergeArtistSupplement(base(), e), /누락/);
});

for (const [name, mutate] of [
  ["changed overall count", (d, e) => { e.total_reported_after = 5; }],
  ["filtered count mismatch", (d, e) => { e.filters[0].total_reported = 3; }],
  ["unparsed filter row", (d, e) => { e.filters[0].pages[0].unparsed_row_count = 1; }],
  ["duplicate rows within a filter", (d, e) => { e.filters[0].pages[0].unavailable_songs[0] = song(10000); }],
  ["duplicate artist filters", (d, e) => { e.filters.push(e.filters[0]); }],
  ["conflicting availability", (d, e) => { e.filters[0].pages[0].unavailable_songs[0] = inactive(10001); }],
  ["unverified base rows", d => { d.checkpoint.verified_scan.raw_row_count++; }],
  ["unfinished base pagination", d => { d.checkpoint.verified_scan.pages[0].next_start_index = 3; }],
  ["duplicate saved IDs", d => { d.songs.push(song(10000)); }],
  ["a partial base extraction", d => { d.extraction.stop_reason = "limit_reached"; }]
]) test(`refuses ${name}`, () => {
  const d = base(), e = evidence();
  mutate(d, e);
  assert.throws(() => mergeArtistSupplement(d, e), /보완 검증 실패/);
});

function collectionFixture({ changedTotal = false, broken = false } = {}) {
  let artist = "", start = 1, saved = null;
  const records = evidence().filters;
  const getPage = () => records.find(r => r.artist_id === artist)?.pages[0];
  const page = {
    getByRole() { return { async click() {} }; },
    async waitForFunction() {},
    locator(selector) {
      if (selector === "tbody") return { evaluateHandle: async () => ({
        evaluate: async () => {}, dispose: async () => {}
      }) };
      if (selector === "#artistMenu") return { count: async () => 1 };
      if (selector === "#artistMenu option") return { evaluateAll: async () => [{ id: "10", name: "A" }, { id: "20", name: "B" }] };
      const id = selector.match(/data-value='(\d*)'/)?.[1];
      return { async click() { artist = id; start = 1; } };
    }
  };
  return { page, read: () => ({ artist, start, saved }), deps: {
    readSnapshot: async () => {
      if (broken && artist === "20") throw new Error("Synthetic session expired");
      const p = artist ? getPage() : { songs: base().songs, unavailable_songs: [], raw_row_count: 2, unparsed_row_count: 0 };
      return { ...p, fingerprint: `${artist}:${start}` };
    },
    readTotal: async () => artist ? getPage().raw_row_count : changedTotal ? 5 : 4,
    nextStart: async () => null,
    move: async () => { throw new Error("Unexpected pagination"); },
    onProgress: async result => { saved = result; }
  } };
}
test("collects UI filters, merges their overlapping IDs and resets the filter before saving", async () => {
  const f = collectionFixture();
  const result = await collectArtistSupplement(f.page, base(), f.deps);
  assert.equal(result.complete, true);
  assert.equal(f.read().artist, "");
  assert.equal(f.read().saved, result);
});
test("a changed unfiltered total prevents saving even after coverage was found", async () => {
  const f = collectionFixture({ changedTotal: true });
  await assert.rejects(collectArtistSupplement(f.page, base(), f.deps), /表示数|表示|表示 수|표시 수/);
  assert.equal(f.read().saved, null);
});
test("a failed filtered lookup restores the unfiltered view and preserves saved data", async () => {
  const f = collectionFixture({ broken: true });
  await assert.rejects(collectArtistSupplement(f.page, base(), f.deps), /session expired/);
  assert.equal(f.read().artist, "");
  assert.equal(f.read().saved, null);
});
