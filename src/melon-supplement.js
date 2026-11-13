import { dedupeMelonSongs } from "./melon-parser.js";

const ids = rows => rows.map(row => String(row.melon_song_id));
const sameSet = (a, b) => a.size === b.size && [...a].every(id => b.has(id));
const validId = id => /^[1-9]\d*$/.test(String(id));

async function selectArtist(page, id) {
  // The selected label changes before AJAX replaces the table, sometimes with
  // the same artist/rows. Wait for the table mutation, not the label alone.
  const changed = await page.locator("tbody").evaluateHandle(tbody => {
    let observer, timer;
    const cleanup = () => { observer?.disconnect(); clearTimeout(timer); };
    const promise = new Promise((resolve, reject) => {
      observer = new MutationObserver(mutations => {
        if (document.querySelector("tbody") !== tbody
          || mutations.some(m => tbody.contains(m.target))) { cleanup(); resolve(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(() => { cleanup(); reject(new Error("아티스트 곡 목록 갱신을 확인하지 못했습니다.")); }, 15000);
    });
    promise.catch(() => {});
    return { promise, cancel: cleanup };
  });
  try {
    await page.getByRole("combobox", { name: "아티스트 선택", exact: true }).click();
    await page.locator(`a[role='option'][data-value='${id}']`).click();
    await changed.evaluate(state => state.promise);
  } finally {
    await changed.evaluate(state => state.cancel()).catch(() => {});
    await changed.dispose();
  }
}

export async function collectArtistSupplement(page, document, { readSnapshot, readTotal, nextStart, move, onProgress, onFilter }) {
  if (!(await page.locator("#artistMenu").count())) return document;
  const artists = await page.locator("#artistMenu option").evaluateAll(options => options
    .map(option => ({ id: option.value, name: option.textContent.trim() })).filter(option => /^[1-9]\d*$/.test(option.id)));
  const knownArtists = new Set(document.songs.flatMap(song => song.artists ?? [song.artist]));
  artists.sort((a, b) => Number(knownArtists.has(a.name)) - Number(knownArtists.has(b.name)));
  const supplement = { method: "artist-filter-dom", verified_at: new Date().toISOString(),
    total_reported_before: document.source.total_reported, total_reported_after: document.source.total_reported, filters: [] };
  let result = document;
  try {
    for (const artist of artists) {
      await selectArtist(page, artist.id);
      await page.waitForFunction(id => {
        const rows = [...document.querySelectorAll("tbody tr")].filter(row => row.querySelector("input[name='input_check']"));
        return document.querySelector("#artistMenu")?.value === id
          && /현재페이지\s*1$/.test(document.querySelector(".page_num strong")?.textContent ?? "")
          && (rows.length > 0 ? rows.every(row => [...row.querySelectorAll("a[href*='goArtistDetail']")]
            .some(link => link.getAttribute("href")?.match(/goArtistDetail\(['"](\d+)/)?.[1] === id))
            : document.querySelector("tbody")?.textContent.includes("좋아요 곡이 없습니다."));
      }, artist.id, { timeout: 15_000 });
      let snapshot = await readSnapshot(page);
      const filter = { artist_id: artist.id, artist_name: artist.name, total_reported: await readTotal(page), pages: [] };
      const seen = new Set();
      let start = 1;
      while (true) {
        if (seen.has(snapshot.fingerprint)) throw new Error("아티스트 필터 페이지가 반복됩니다.");
        seen.add(snapshot.fingerprint);
        const next = await nextStart(page, start);
        filter.pages.push({ start_index: start, next_start_index: next, raw_row_count: snapshot.raw_row_count,
          unparsed_row_count: snapshot.unparsed_row_count, songs: snapshot.songs,
          unavailable_songs: snapshot.unavailable_songs.map(song => ({ ...song, artist_filter_id: artist.id, page_start_index: start })) });
        if (next == null) break;
        snapshot = await move(page, next, snapshot.fingerprint);
        start = next;
      }
      supplement.filters.push(filter);
      // Only the unfiltered total can establish coverage; a filtered count cannot.
      if (await readTotal(page) !== filter.total_reported) throw new Error("조회 중 아티스트 곡 수가 변경됐습니다.");
      result = mergeArtistSupplement(document, supplement);
      await onFilter?.({ checked_filters: supplement.filters.length, verified_unique_count: result.extraction.verified_unique_count });
      if (result.complete) break;
    }
  } finally {
    await selectArtist(page, "");
    await page.waitForFunction(() => document.querySelector("#artistMenu")?.value === ""
      && /현재페이지\s*1$/.test(document.querySelector(".page_num strong")?.textContent ?? ""), null, { timeout: 15_000 });
    await readSnapshot(page);
  }
  supplement.total_reported_after = await readTotal(page);
  supplement.verified_at = new Date().toISOString();
  result = mergeArtistSupplement(document, supplement);
  await onProgress(result);
  return result;
}

// Preserve the original scan: filtered views overlap and cannot be added as raw rows.
export function mergeArtistSupplement(document, supplement) {
  const scan = document.checkpoint?.verified_scan;
  const total = document.source?.total_reported;
  const fail = message => { throw new Error(`Melon 아티스트 보완 검증 실패: ${message}`); };
  if (!Number.isInteger(total) || total < 0 || scan?.start_index !== 1
    || scan.total_reported !== total || !Array.isArray(scan.song_ids) || !Array.isArray(scan.pages)
    || !scan.pages.length || scan.pages.at(-1).next_start_index != null
    || !["total_mismatch", "completed"].includes(document.extraction?.stop_reason)) fail("기본 목록 끝까지의 검증 기록이 필요합니다.");
  const baseIds = new Set(scan.song_ids.map(String));
  const originalIds = ids([...document.songs, ...document.unavailable_songs ?? []]);
  if (originalIds.some(id => !validId(id)) || new Set(originalIds).size !== originalIds.length) fail("원본 ID가 중복되거나 잘못되었습니다.");
  if (baseIds.size !== scan.song_ids.length || scan.song_ids.some(id => !validId(id))
    || scan.raw_row_count !== baseIds.size
    || scan.pages.reduce((n, p) => n + p.raw_row_count, 0) !== scan.raw_row_count
    || scan.pages.some((p, i) => p.raw_row_count !== p.parsed_row_count + p.unavailable_row_count
      || (i === 0 ? p.start_index !== 1 : scan.pages[i - 1].next_start_index !== p.start_index))) fail("기본 행·고유 ID·페이지 기록이 일치하지 않습니다.");
  if (supplement.method !== "artist-filter-dom" || supplement.total_reported_before !== total
    || supplement.total_reported_after !== total || !supplement.verified_at
    || !Array.isArray(supplement.filters)) fail("보완 조회 전후 표시 수 또는 출처가 다릅니다.");
  const filteredSongs = [], filteredUnavailable = [];
  const filterIds = new Set();
  for (const filter of supplement.filters) {
    if (!validId(filter.artist_id) || filterIds.has(String(filter.artist_id)) || !Array.isArray(filter.pages)
      || !filter.pages.length || !Number.isInteger(filter.total_reported) || filter.total_reported < 0) fail("아티스트 필터 기록이 잘못되었습니다.");
    filterIds.add(String(filter.artist_id));
    const rows = [];
    for (const [i, page] of filter.pages.entries()) {
      if (!Array.isArray(page.songs) || !Array.isArray(page.unavailable_songs)
        || page.unparsed_row_count !== 0 || page.raw_row_count !== page.songs.length + page.unavailable_songs.length
        || (i === 0 ? page.start_index !== 1 : filter.pages[i - 1].next_start_index !== page.start_index)
        || (i === filter.pages.length - 1 && page.next_start_index != null)) fail("필터 페이지가 누락되거나 파싱되지 않았습니다.");
      rows.push(...page.songs, ...page.unavailable_songs);
      filteredSongs.push(...page.songs);
      filteredUnavailable.push(...page.unavailable_songs);
    }
    if (rows.some(row => !validId(row.melon_song_id)) || rows.length !== filter.total_reported
      || new Set(ids(rows)).size !== rows.length) fail("필터 표시 수·행·고유 ID가 일치하지 않습니다.");
  }
  const normalIds = new Set(ids([...document.songs, ...filteredSongs]));
  const inactiveIds = new Set(ids([...document.unavailable_songs ?? [], ...filteredUnavailable]));
  if ([...normalIds].some(id => inactiveIds.has(id))) fail("정상·비활성 분류가 충돌합니다.");
  const appendNew = (original, additions) => {
    const existing = new Set(ids(original));
    return [...original, ...dedupeMelonSongs(additions).filter(row => !existing.has(String(row.melon_song_id)))];
  };
  const songs = appendNew(document.songs, filteredSongs);
  const unavailable = appendNew(document.unavailable_songs ?? [], filteredUnavailable);
  const sourceIds = new Set(ids([...songs, ...unavailable]));
  const verifiedIds = new Set([...baseIds, ...ids([...filteredSongs, ...filteredUnavailable])]);
  if (![...baseIds].every(id => sourceIds.has(id))) fail("기본 원곡 ID가 사라졌습니다.");
  const complete = sourceIds.size === total && sameSet(sourceIds, verifiedIds);
  const supplementalIds = [...verifiedIds].filter(id => !baseIds.has(id));
  return { ...document, supplemented_at: supplement.verified_at, complete, songs, unavailable_songs: unavailable,
    checkpoint: { ...document.checkpoint,
      artist_filter_supplement: { ...supplement, supplemental_song_ids: supplementalIds },
      combined_verified_scan: { method: "base-and-artist-filter-union", verified_at: supplement.verified_at,
        total_reported: total, base_raw_row_count: scan.raw_row_count,
        filtered_raw_row_count: supplement.filters.reduce((n, filter) => n + filter.pages.reduce((sum, page) => sum + page.raw_row_count, 0), 0),
        supplemental_unique_count: supplementalIds.length, raw_row_count: verifiedIds.size,
        song_ids: [...verifiedIds] } },
    extraction: { ...document.extraction, stop_reason: complete ? "completed" : "total_mismatch",
      accounted_count: sourceIds.size, unavailable_count: unavailable.length,
      verified_row_count: verifiedIds.size, verified_unique_count: verifiedIds.size,
      reported_count_gap: total - verifiedIds.size, supplemental_unique_count: supplementalIds.length } };
}
