const SONG_ID_PATTERNS = [
  /playSong\s*\([^,]+,\s*['"]?([1-9][0-9]*)(?![0-9a-z_.])/i,
  /goSongDetail\s*\(\s*['"]?([1-9][0-9]*)(?![0-9a-z_.])/i,
  /(?:songId|songNo)[^0-9]{0,30}([1-9][0-9]*)(?![0-9a-z_.])/i
];

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

export function parseDurationMillis(text) {
  const match = String(text ?? "").match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/);
  if (!match) return null;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

function songIdFromRow(row) {
  const haystack = [row.songId, row.dataSongNo, row.inputValue, row.hrefs, row.onclicks]
    .flat().filter(Boolean).join(" ");
  const directId = [row.songId, row.dataSongNo, row.inputValue]
    .map((value) => String(value ?? "").match(/^[1-9]\d*$/)?.[0]).find(Boolean);
  return directId ?? SONG_ID_PATTERNS.map((pattern) => haystack.match(pattern)?.[1]).find(Boolean) ?? null;
}

export function parseMelonRowsFromData(rows) {
  const songs = [];
  for (const row of rows) {
    const melonSongId = songIdFromRow(row);
    const title = clean(row.title);
    const artists = unique(row.artists ?? []);
    const artist = clean(row.artist) || artists.join(", ");
    if (!melonSongId || !title || !artist) continue;
    songs.push({
      melon_song_id: melonSongId,
      title,
      artist,
      artists: artists.length ? artists : [artist],
      album: clean(row.album),
      duration_ms: row.durationMs ?? parseDurationMillis(row.rowText),
      isrc: clean(row.isrc) || null,
      content_rating: /(?:19금|청소년\s*이용\s*불가)/u.test(String(row.rowText ?? "")) ? "explicit" : null,
      melon_url: `https://www.melon.com/song/detail.htm?songId=${melonSongId}`,
      apple_music_song_id: null,
      apple_music_title: null,
      apple_music_artist: null,
      match_score: null,
      match_status: null
    });
  }
  return songs;
}

export function parseMelonPageRows(rows) {
  const songs = [];
  const unavailableSongs = [];
  let unparsedRowCount = 0;
  let ignoredRowCount = 0;
  let emptyNotice = false;
  rows.forEach((row, index) => {
    const hasSongEvidence = songIdFromRow(row) || clean(row.title) || clean(row.artist)
      || unique(row.artists ?? []).length || clean(row.album) || row.hasSongCheckbox !== false
      || row.hrefs?.length || row.onclicks?.length || row.noResult || row.checkboxDisabled;
    if (!hasSongEvidence && ((!clean(row.rowText) && row.cellCount === 0)
      || (clean(row.rowText) === "좋아요 곡이 없습니다." && row.cellCount === 1 && row.colspans?.[0] === 9))) {
      ignoredRowCount += 1;
      if (clean(row.rowText) === "좋아요 곡이 없습니다.") emptyNotice = true;
      return;
    }
    const parsed = parseMelonRowsFromData([row]);
    if (parsed.length && row.checkboxDisabled === true) {
      unavailableSongs.push({ ...parsed[0], duration_ms: row.durationMs ?? null,
        reason: "disabled_with_metadata", row_index: index + 1 });
    } else if (parsed.length) songs.push(...parsed);
    else {
      const id = songIdFromRow(row);
      if (id && !clean(row.title) && row.noResult === true && row.checkboxDisabled === true) {
        unavailableSongs.push({ melon_song_id: id, reason: "disabled_no_result", row_index: index + 1 });
      } else unparsedRowCount += 1;
    }
  });
  return { songs, unavailable_songs: unavailableSongs, unparsed_row_count: unparsedRowCount,
    ignored_row_count: ignoredRowCount, empty_list: emptyNotice && ignoredRowCount === rows.length };
}

export function dedupeMelonSongs(songs) {
  const byId = new Map();
  for (const song of songs) if (song?.melon_song_id) byId.set(String(song.melon_song_id), song);
  return [...byId.values()];
}
