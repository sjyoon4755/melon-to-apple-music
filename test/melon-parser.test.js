import test from "node:test";
import assert from "node:assert/strict";
import { dedupeMelonSongs, parseDurationMillis, parseMelonRowsFromData, parseMelonPageRows } from "../src/melon-parser.js";

test("extracts Melon metadata from row data", () => {
  const [song] = parseMelonRowsFromData([{
    dataSongNo: "12345678",
    title: "  곡 제목 ",
    artists: ["가수 A", "가수 B"],
    album: "앨범",
    rowText: "곡 제목 가수 A 03:42"
  }]);
  assert.deepEqual(song, {
    melon_song_id: "12345678",
    title: "곡 제목",
    artist: "가수 A, 가수 B",
    artists: ["가수 A", "가수 B"],
    album: "앨범",
    duration_ms: 222_000,
    isrc: null,
    content_rating: null,
    melon_url: "https://www.melon.com/song/detail.htm?songId=12345678",
    apple_music_song_id: null,
    apple_music_title: null,
    apple_music_artist: null,
    match_score: null,
    match_status: null
  });
});

test("finds song ID inside a play function", () => {
  const [song] = parseMelonRowsFromData([{
    title: "Title",
    artist: "Artist",
    onclicks: ["melon.play.playSong('10010101',37928381);"]
  }]);
  assert.equal(song.melon_song_id, "37928381");
});

test("accepts short positive Melon IDs from explicit song fields and links", () => {
  for (const id of ["1", "123", "9828"]) {
    for (const source of [
      { songId: id }, { dataSongNo: id }, { inputValue: id },
      { onclicks: [`melon.play.playSong('10010101',${id});`] },
      { hrefs: [`javascript:melon.link.goSongDetail('${id}');`] },
      { hrefs: [`https://www.melon.com/song/detail.htm?songId=${id}`] }
    ]) {
      const [song] = parseMelonRowsFromData([{ ...source, title: "Title", artist: "Artist" }]);
      assert.equal(song?.melon_song_id, id);
    }
  }
  assert.equal(parseMelonPageRows([{ inputValue: "9828", noResult: true, checkboxDisabled: true }])
    .unavailable_songs[0].melon_song_id, "9828");
});

test("short ID support still rejects zero, malformed IDs and unrelated numbers", () => {
  for (const source of [
    { inputValue: "0" }, { inputValue: "-1" }, { inputValue: "98.28" }, { inputValue: "9828abc" },
    { hrefs: ["javascript:goAlbumDetail('9828')"] },
    { onclicks: ["melon.play.playSong('10010101','9828abc');"] },
    { hrefs: ["https://www.melon.com/song/detail.htm?songId=9828.5"] },
    { rowText: "9828 likes" }
  ]) assert.equal(parseMelonRowsFromData([{ ...source, title: "Title", artist: "Artist" }]).length, 0);
});

test("deduplicates by Melon song ID and keeps the newest record", () => {
  assert.deepEqual(dedupeMelonSongs([
    { melon_song_id: "1", title: "old" },
    { melon_song_id: "1", title: "new" },
    { melon_song_id: "2", title: "other" }
  ]), [
    { melon_song_id: "1", title: "new" },
    { melon_song_id: "2", title: "other" }
  ]);
});

test("parses durations conservatively", () => {
  assert.equal(parseDurationMillis("03:07"), 187_000);
  assert.equal(parseDurationMillis("no duration"), null);
});

test("keeps disabled rows with visible metadata out of normal matching and never infers their duration from album text", () => {
  const result = parseMelonPageRows([{ dataSongNo: "9100001", title: "작별", artist: "종이배",
    artists: ["종이배"], album: "2EP 작은서점", checkboxDisabled: true, rowText: "Album 18:42" }]);
  assert.equal(result.songs.length, 0);
  assert.equal(result.unparsed_row_count, 0);
  assert.equal(result.unavailable_songs[0].melon_song_id, "9100001");
  assert.equal(result.unavailable_songs[0].title, "작별");
  assert.equal(result.unavailable_songs[0].reason, "disabled_with_metadata");
  assert.equal(result.unavailable_songs[0].duration_ms, null);
});

test("separately records only identifiable disabled no-result rows without inventing metadata", () => {
  const unavailable = { inputValue: "10001", title: "", noResult: true, checkboxDisabled: true };
  const parsed = parseMelonPageRows([
    { dataSongNo: "10000", title: "Title", artist: "Artist" }, unavailable,
    { ...unavailable, inputValue: "10002", noResult: false },
    { ...unavailable, inputValue: "10003", checkboxDisabled: false },
    { ...unavailable, inputValue: "" },
    { ...unavailable, inputValue: "10004", title: "Title", artist: "" }
  ]);
  assert.equal(parsed.songs.length, 1);
  assert.deepEqual(parsed.unavailable_songs, [{ melon_song_id: "10001", reason: "disabled_no_result", row_index: 2 }]);
  assert.equal(parsed.unparsed_row_count, 4);
});

test("ignores only verified layout rows and the exact empty-likes notice", () => {
  const layout = { hasSongCheckbox: false, cellCount: 0, colspans: [], rowText: "" };
  const notice = { hasSongCheckbox: false, cellCount: 1, colspans: [9], rowText: "좋아요 곡이 없습니다." };
  const empty = parseMelonPageRows([layout, notice]);
  assert.equal(empty.ignored_row_count, 2);
  assert.equal(empty.unparsed_row_count, 0);
  assert.equal(empty.empty_list, true);
  const mixed = parseMelonPageRows([layout, { dataSongNo: "9828", title: "Title", artist: "Artist" }]);
  assert.equal(mixed.songs.length, 1);
  assert.equal(mixed.ignored_row_count, 1);
  assert.equal(mixed.empty_list, false);
});

test("empty-row handling never hides song evidence or an unfamiliar notice", () => {
  const notice = { hasSongCheckbox: false, cellCount: 1, colspans: [9], rowText: "좋아요 곡이 없습니다." };
  const parsed = parseMelonPageRows([
    { ...notice, inputValue: "9828" }, { ...notice, title: "Unparsed song" },
    { ...notice, hasSongCheckbox: true }, { ...notice, noResult: true },
    { ...notice, colspans: [8] }, { ...notice, rowText: "로그인이 필요합니다." },
    { cellCount: 0, rowText: "" }, { ...notice, hrefs: ["javascript:goSongDetail('9828')"] }
  ]);
  assert.equal(parsed.ignored_row_count, 0);
  assert.equal(parsed.unparsed_row_count, 8);
  assert.equal(parsed.empty_list, false);
});
