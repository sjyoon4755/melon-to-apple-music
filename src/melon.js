import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dedupeMelonSongs, parseMelonPageRows } from "./melon-parser.js";
import { readSongDocument, writeJsonAtomic } from "./io.js";
import { launchConfiguredBrowser } from "./browser-config.js";
import { startRun, sourceFingerprint } from "./run-state.js";
import { createHash } from "node:crypto";
import { withDataLocks, dataSnapshot, assertDataSnapshot } from "./apply-lock.js";
import { collectArtistSupplement } from "./melon-supplement.js";

const LIKES_URL = "https://www.melon.com/mymusic/like/mymusiclikesong_list.htm";

function navigationContextLost(error) {
  return /execution context was destroyed|cannot find context with specified id/i.test(String(error));
}

function publicPageUrl(page) {
  const url = new URL(page.url());
  return `${url.origin}${url.pathname}`;
}

function isLoginUrl(url) {
  return ["https://accounts.melon.com", "https://www.melon.com"].includes(url.origin)
    && url.pathname.startsWith("/login/");
}

function loginRequired(page) {
  try { return !page.isClosed?.() && isLoginUrl(new URL(page.url())); }
  catch { return false; }
}

function loginRequiredError() {
  const error = new Error("Melon 재인증이 필요합니다. 같은 브라우저에서 직접 로그인하세요.");
  error.code = "MELON_LOGIN_REQUIRED";
  return error;
}

function isLikesPage(page) {
  if (page.isClosed?.()) return false;
  try {
    const url = new URL(page.url());
    const target = new URL(LIKES_URL);
    return url.origin === target.origin && url.pathname === target.pathname;
  } catch { return false; }
}

async function scrapeDomRows(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = await page.locator("tbody tr").evaluateAll((elements) => elements.map((row) => {
        const text = (selector) => row.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const texts = (selector) => [...row.querySelectorAll(selector)]
          .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .filter(Boolean);
        return {
          dataSongNo: row.getAttribute("data-song-no") ?? row.dataset?.songNo ?? "",
          inputValue: row.querySelector("input[name='input_check'], input[type='checkbox']")?.value ?? "",
          hrefs: [...row.querySelectorAll("a[href]")].map((element) => element.getAttribute("href")),
          onclicks: [...row.querySelectorAll("[onclick]")].map((element) => element.getAttribute("onclick")),
          title: text(".ellipsis.rank01 a, .rank01 a, a[href*='playSong']")
            || text("a[href*='goSongDetail']").replace(/\s*상세정보 페이지 이동$/, ""),
          artists: texts(".ellipsis.rank02 a, .rank02 a, [id^='artistName'] a, a[href*='goArtistDetail']"),
          artist: text(".ellipsis.rank02, .rank02, [id^='artistName']"),
          album: text(".ellipsis.rank03 a, .rank03 a, a[href*='goAlbumDetail']"),
          noResult: row.classList.contains("no_result"),
          checkboxDisabled: Boolean(row.querySelector("input[name='input_check'], input[type='checkbox']")?.disabled),
          hasSongCheckbox: Boolean(row.querySelector("input[name='input_check'], input[type='checkbox']")),
          cellCount: row.cells.length,
          colspans: [...row.cells].map((cell) => cell.colSpan),
          rowText: row.textContent ?? ""
        };
      }));
      const parsed = parseMelonPageRows(rows);
      return { ...parsed, raw_row_count: rows.length - parsed.ignored_row_count, dom_row_count: rows.length,
        fingerprint: createHash("sha256").update(JSON.stringify(rows.map((row) => {
          const fields = [row.dataSongNo, row.inputValue, row.hrefs, row.onclicks, row.title, row.artists, row.artist, row.album];
          if (row.noResult || row.checkboxDisabled) return [...fields, row.noResult, row.checkboxDisabled];
          return parsed.ignored_row_count ? [...fields, row.cellCount, row.colspans, row.rowText] : fields;
        }))).digest("hex") };
    } catch (error) {
      if (attempt > 0 || !navigationContextLost(error)) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    }
  }
  throw new Error("멜론 곡 목록을 읽지 못했습니다.");
}

async function totalLikeCount(page) {
  const values = await page.locator("#totCnt, .title .cnt, .wrap_song_info + .cnt").allTextContents();
  for (const value of values) {
    const digits = value.replaceAll(",", "").match(/\d+/)?.[0];
    if (digits) return Number(digits);
  }
  return null;
}

async function hasSongs(page) {
  if (!isLikesPage(page)) return false;
  const snapshot = await scrapeDomRows(page);
  return snapshot.songs.length + snapshot.unavailable_songs.length > 0 || snapshot.empty_list;
}

async function findPageWithSongs(context, preferredPage, ignoredPages = new Set()) {
  const pages = [preferredPage, ...context.pages().toReversed()]
    .filter((page, index, all) => page && all.indexOf(page) === index);
  for (const candidate of pages) {
    if (ignoredPages.has(candidate) || !isLikesPage(candidate)) continue;
    await candidate.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    try {
      if (await hasSongs(candidate)) return candidate;
    } catch (error) {
      if (!candidate.isClosed?.()) throw error;
    }
  }
  return null;
}

function isMelonPage(page) {
  if (page.isClosed?.()) return false;
  try { return new URL(page.url()).origin === new URL(LIKES_URL).origin; }
  catch { return false; }
}

async function hasVisibleLogout(page) {
  try {
    return await page.locator("a, button").evaluateAll((elements) => elements.some((element) => {
      if (!/^(로그아웃|logout)$/i.test(element.textContent?.trim() ?? "")) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
    }));
  } catch (error) {
    if (page.isClosed?.() || navigationContextLost(error)) return false;
    throw error;
  }
}

async function waitForMenuDestination(page, pathname) {
  await page.waitForURL((url) => isLoginUrl(url)
    || (url.origin === new URL(LIKES_URL).origin && url.pathname === pathname),
  { waitUntil: "domcontentloaded", timeout: 15_000 });
  if (loginRequired(page)) throw loginRequiredError();
}

async function openLikesFromMenu(page) {
  const likes = page.locator("a[href*='mymusic.mymusicLink.goLikeSong']:visible").first();
  const myMusic = page.locator("a[href*='menu.goMyMusicMain']:visible").first();
  if (!(await myMusic.count())) return false;
  await myMusic.click();
  await waitForMenuDestination(page, "/mymusic/main/mymusicmain_list.htm");
  await likes.waitFor({ state: "visible", timeout: 15_000 });
  // Let Melon's own navigation supply its account-specific list context.
  await likes.click();
  await waitForMenuDestination(page, new URL(LIKES_URL).pathname);
  return true;
}

async function waitForLikesAfterLogin(context, preferredPage, options, ignoredPages = new Set()) {
  const readline = (options.createInterfaceImpl ?? createInterface)({ input, output });
  const controller = new AbortController();
  const navigated = new WeakSet();
  let pendingAnswer;
  let confirmed = false;
  try {
    while (true) {
      const songPage = await findPageWithSongs(context, preferredPage, ignoredPages);
      if (songPage) return songPage;
      const pages = [preferredPage, ...context.pages().toReversed()]
        .filter((candidate, index, all) => candidate && !ignoredPages.has(candidate)
          && all.indexOf(candidate) === index && isMelonPage(candidate));
      if (!context.pages().some((candidate) => !candidate.isClosed?.())) {
        throw new Error("Melon 브라우저가 닫혔습니다. 기존 결과와 checkpoint는 유지됩니다.");
      }
      for (const candidate of pages) {
        if ((!confirmed && navigated.has(candidate)) || (!confirmed && !(await hasVisibleLogout(candidate)))) continue;
        navigated.add(candidate);
        confirmed = false;
        console.log("Melon 로그인 완료를 확인했습니다. 좋아요 곡 목록으로 이동합니다.");
        let opened = false;
        try { opened = await openLikesFromMenu(candidate); }
        catch (error) {
          if (error.code !== "MELON_LOGIN_REQUIRED" && error.name !== "TimeoutError") throw error;
          if (loginRequired(candidate)) navigated.delete(candidate);
        }
        if (!opened) {
          console.log(loginRequired(candidate) ? "Melon 재인증을 기다립니다. 같은 창에서 직접 로그인하세요."
            : "Melon 메뉴를 찾지 못했습니다. 같은 창에서 직접 ‘마이뮤직 > 좋아요 > 곡’을 열면 자동으로 재개합니다.");
        }
        preferredPage = candidate;
        break;
      }
      const readyPage = await findPageWithSongs(context, preferredPage, ignoredPages);
      if (readyPage) return readyPage;
      pendingAnswer ??= readline.question("로그인 후 자동으로 재개합니다 (감지되지 않으면 Enter, 중단: q): ", {
        signal: controller.signal
      }).then((answer) => ({ answer }), (error) => ({ error }));
      let timer;
      const event = await Promise.race([pendingAnswer, new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), options.loginPollMs ?? 1000);
      })]).finally(() => clearTimeout(timer));
      if (event == null) continue;
      pendingAnswer = null;
      if (event.error) throw event.error;
      if (event.answer.trim().toLowerCase() === "q") {
        const error = new Error("사용자가 멜론 추출을 중단했습니다. 기존 결과와 checkpoint는 유지됩니다.");
        error.code = "EXTRACTION_CANCELLED";
        throw error;
      }
      confirmed = true;
    }
  } finally {
    controller.abort();
    readline.close();
  }
}

async function collectPageDiagnostics(context) {
  return Promise.all(context.pages().map(async (candidate) => {
    const url = new URL(candidate.url());
    const counts = await candidate.locator("body").evaluate((body) => ({
      table_rows: body.querySelectorAll("tbody tr").length,
      song_number_rows: body.querySelectorAll("tr[data-song-no]").length,
      song_checkboxes: body.querySelectorAll("input[name='input_check'], input[type='checkbox']").length,
      title_cells: body.querySelectorAll(".ellipsis.rank01, .rank01").length,
      artist_cells: body.querySelectorAll(".ellipsis.rank02, .rank02, [id^='artistName']").length,
      album_cells: body.querySelectorAll(".ellipsis.rank03, .rank03").length
    })).catch(() => null);
    return { url: `${url.origin}${url.pathname}`, title: await candidate.title().catch(() => ""), counts };
  }));
}

async function findNextStartIndex(page, currentStart) {
  const starts = await page.locator("[href*='sendPage'], [onclick*='sendPage']").evaluateAll((links) => links
    .flatMap((link) => [link.getAttribute("href"), link.getAttribute("onclick")])
    .map((value) => value?.match(/sendPage\s*\(\s*['"]?(\d+)/)?.[1])
    .filter(Boolean)
    .map(Number));
  const visibleNext = starts.filter((value) => value > currentStart).sort((a, b) => a - b)[0];
  if (visibleNext) return visibleNext;
  return null;
}

async function stablePage(page, previousFingerprint = null) {
  let previous = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (loginRequired(page)) throw loginRequiredError();
    if (!isLikesPage(page)) throw new Error("Melon 좋아요 페이지를 벗어났습니다.");
    const snapshot = await scrapeDomRows(page);
    if (snapshot.fingerprint !== previousFingerprint && snapshot.fingerprint === previous?.fingerprint) return snapshot;
    previous = snapshot;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Melon 페이지 이동 또는 곡 목록 안정화를 확인하지 못했습니다.");
}

async function moveToStart(page, startIndex, previousFingerprint) {
  await page.waitForFunction(() => typeof globalThis.pageObj?.sendPage === "function", null, { timeout: 15_000 });
  const available = await page.evaluate(() => typeof globalThis.pageObj?.sendPage === "function");
  if (!available) throw new Error("멜론 페이지의 pageObj.sendPage를 찾지 못했습니다. 페이지 구조가 변경되었을 수 있습니다.");
  try {
    await page.evaluate((start) => globalThis.pageObj.sendPage(String(start)), startIndex);
  } catch (error) {
    if (!navigationContextLost(error)) throw error;
  }
  return stablePage(page, previousFingerprint);
}

export async function extractMelonLikes(config, options = {}) {
  let expectedInput = await dataSnapshot(config);
  const existing = await readSongDocument(config.files.melonLikes, { songs: [], checkpoint: {} });
  await assertDataSnapshot(config, expectedInput);
  // refresh rescans from the first page while keeping every saved song (used by sync).
  if (existing.complete && !options.force && !options.refresh) {
    console.log(`이미 완료된 멜론 추출 결과 ${existing.songs.length}곡을 사용합니다. 새로 받으려면 --force를 지정하세요.`);
    return existing;
  }
  if (!options.force && Number.isInteger(options.limit) && options.limit > 0
    && (existing.songs?.length ?? 0) >= options.limit) {
    console.log(
      `기존 부분 추출 ${existing.songs.length}곡이 요청 limit ${options.limit}을 충족해 재사용합니다. 전체 재개는 --limit을 생략하세요.`
    );
    return existing;
  }

  const run = await startRun(config.files.extractionRun, { phase: "opening_browser",
    source_fingerprint: sourceFingerprint(existing.songs ?? []), saved_count: existing.songs?.length ?? 0 });
  let context;
  let page;
  let result = existing;
  let wroteSource = false;
  try {
    let runtime;
    ({ context, runtime } = await launchConfiguredBrowser(config, "melon", {
      headless: Boolean(options.headless),
      viewport: null,
      locale: "ko-KR",
      args: ["--restore-last-session"]
    }, options.browserDependencies));
    const attached = new WeakSet();
    const attachDialogs = (candidate) => {
      if (attached.has(candidate)) return;
      attached.add(candidate);
      candidate.on("dialog", async (dialog) => {
        console.log("멜론 안내 창이 표시되었습니다. 인증이 필요한 경우 직접 처리하세요.");
        await dialog.dismiss().catch(() => {});
      });
    };
    context.on?.("page", attachDialogs);
    for (const candidate of context.pages()) attachDialogs(candidate);
    page = context.pages().find((candidate) => !candidate.isClosed?.()) ?? await context.newPage();
    attachDialogs(page);
    const awaitLogin = async (reauthentication = false) => {
      if (options.headless) throw new Error("로그인된 멜론 세션이 없습니다. 먼저 headed 모드로 실행해 직접 로그인하세요.");
      await page.bringToFront?.();
      console.log(`\n열린 ${runtime.selected}에서 멜론에 직접 로그인하세요. 로그인 완료 또는 좋아요 곡 목록을 감지하면 자동으로 재개합니다.`);
      console.log("ID/PW는 이 프로그램이 읽거나 저장하지 않습니다.");
      await run.update({ phase: "awaiting_login" });
      const ignoredPages = reauthentication ? new Set(context.pages().filter((candidate) => candidate !== page)) : new Set();
      page = await waitForLikesAfterLogin(context, page, options, ignoredPages);
      await run.update({ phase: "extracting" });
    };
    const openFirstPage = async () => {
      while (true) {
        try {
          if (!(await openLikesFromMenu(page))) throw new Error("전체 재검증을 위한 Melon 좋아요 메뉴를 찾지 못했습니다. 기존 결과는 유지됩니다.");
          return await stablePage(page);
        } catch (error) {
          if (error.code !== "MELON_LOGIN_REQUIRED" && !loginRequired(page)) throw error;
          await awaitLogin(true);
        }
      }
    };
    await page.goto("https://www.melon.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!(await hasSongs(page)) && await hasVisibleLogout(page)) {
      try { await openLikesFromMenu(page); }
      catch (error) {
        if (error.code !== "MELON_LOGIN_REQUIRED" && !loginRequired(page)) throw error;
        await awaitLogin(true);
      }
    }
    if (!(await hasSongs(page))) {
      await awaitLogin(loginRequired(page));
    }
    if (!(await hasSongs(page))) {
      console.log(`Melon page diagnostics: ${JSON.stringify(await collectPageDiagnostics(context))}`);
      throw new Error(`좋아요 곡 행을 찾지 못했습니다. 현재 주소: ${publicPageUrl(page)}`);
    }

    let songs = options.force ? [] : existing.songs ?? [];
    await run.update({ phase: "extracting" });
    let snapshot = await openFirstPage();
    const total = await totalLikeCount(page);
    const moveWithLogin = async (targetIndex, previousSnapshot, previousIndex) => {
      let recovering = false;
      let base = previousSnapshot;
      while (true) {
        try {
          if (recovering) {
            base = await openFirstPage();
            if (await totalLikeCount(page) !== total) throw new Error("재로그인 후 Melon 전체 곡 수가 변경됐습니다. 기존 결과와 checkpoint를 보존하며 중단합니다. 다시 실행해 전체 재검증하세요.");
            if (previousIndex > 1) base = await moveToStart(page, previousIndex, base.fingerprint);
            if (base.fingerprint !== previousSnapshot.fingerprint) throw new Error("재로그인 후 이전 검증 페이지가 변경됐습니다. 기존 결과와 checkpoint를 보존하며 중단합니다. 다시 실행해 전체 재검증하세요.");
            recovering = false;
          }
          return await moveToStart(page, targetIndex, base.fingerprint);
        } catch (error) {
          if (error.code !== "MELON_LOGIN_REQUIRED" && !loginRequired(page)) throw error;
          await awaitLogin(true);
          recovering = true;
        }
      }
    };
    const previousScan = existing.checkpoint?.verified_scan;
    let resumeScan = !options.force && !options.refresh && previousScan?.start_index === 1
      && previousScan.total_reported === total && Array.isArray(previousScan.song_ids)
      && Number.isInteger(previousScan.raw_row_count) && previousScan.raw_row_count > 0
      && Number.isInteger(existing.checkpoint?.last_processed_start_index)
      && typeof existing.checkpoint?.page_fingerprint === "string" && Array.isArray(previousScan.pages);
    let startIndex = resumeScan ? Number(existing.checkpoint.next_start_index) : 1;
    if (resumeScan) {
      const lastStart = existing.checkpoint.last_processed_start_index;
      if (lastStart > 1) snapshot = await moveWithLogin(lastStart, snapshot, 1);
      if (snapshot.fingerprint !== existing.checkpoint.page_fingerprint) {
        console.log("이전 검증 페이지가 변경되어 기존 곡을 보존하며 첫 페이지부터 다시 검증합니다.");
        resumeScan = false;
        startIndex = 1;
        snapshot = await openFirstPage();
      } else if (startIndex !== lastStart) {
        snapshot = await moveWithLogin(startIndex, snapshot, lastStart);
      }
    }
    if (!options.force && !resumeScan && Number(existing.checkpoint?.next_start_index ?? 1) > 1) {
      console.log("기존 곡을 보존하며 첫 페이지부터 전체 행을 재검증합니다. 이전 checkpoint의 페이지별 검증 기록을 사용할 수 없습니다.");
    }
    const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
    const seen = new Set();
    let unavailableSongs = options.force ? [] : existing.unavailable_songs ?? [];
    let checkpoint = resumeScan ? { ...existing.checkpoint } : {
      verified_scan: { start_index: 1, total_reported: total, raw_row_count: 0, song_ids: [], pages: [] }
    };
    delete checkpoint.artist_filter_supplement;
    delete checkpoint.combined_verified_scan;
    const verifiedIds = new Set(checkpoint.verified_scan.song_ids);
    const accountedCount = () => new Set([...songs, ...unavailableSongs].map((song) => String(song.melon_song_id))).size;
    const save = async (stopReason, complete = false) => {
      result = {
        schema_version: 1, extracted_at: new Date().toISOString(),
        source: { service: "melon", url: LIKES_URL, method: "playwright-dom", total_reported: total },
        complete, checkpoint: { ...checkpoint, next_start_index: startIndex },
        extraction: { stop_reason: stopReason, last_verified_start_index: startIndex,
          raw_row_count: snapshot.raw_row_count, parsed_row_count: snapshot.songs.length,
          dom_row_count: snapshot.dom_row_count, ignored_row_count: snapshot.ignored_row_count,
          empty_list: snapshot.empty_list,
          unavailable_row_count: snapshot.unavailable_songs.length, unparsed_row_count: snapshot.unparsed_row_count,
          unavailable_count: unavailableSongs.length, accounted_count: accountedCount(),
          verified_row_count: checkpoint.verified_scan.raw_row_count,
          verified_unique_count: verifiedIds.size,
          reported_count_gap: total == null ? null : total - verifiedIds.size,
          page_count: checkpoint.verified_scan.pages.length,
          new_song_count: songs.length - before }, songs, unavailable_songs: unavailableSongs
      };
      expectedInput = await withDataLocks(config, async assertOwned => {
        try { await assertDataSnapshot(config, expectedInput); }
        catch (error) {
          await writeJsonAtomic(`${config.files.extractionRun}.conflict.json`, result);
          throw error;
        }
        await assertOwned();
        await writeJsonAtomic(config.files.melonLikes, result);
        return dataSnapshot(config);
      });
      wroteSource = true;
      await run.update({ source_fingerprint: sourceFingerprint(songs), saved_count: songs.length,
        next_start_index: startIndex, ...result.extraction });
    };
    let before = songs.length;
    while (songs.length < limit) {
      const pageSongs = snapshot.songs;
      before = songs.length;
      const replay = checkpoint.last_processed_start_index === startIndex && checkpoint.page_fingerprint === snapshot.fingerprint;
      if (checkpoint.last_processed_start_index === startIndex && !replay) {
        throw new Error("저장된 checkpoint 페이지의 곡 목록이 변경되었습니다. 전체 검증 기록을 다시 확인해야 합니다.");
      }
      const repeated = seen.has(snapshot.fingerprint);
      seen.add(snapshot.fingerprint);
      const remaining = limit - songs.length;
      songs = dedupeMelonSongs([...songs, ...pageSongs.slice(0, remaining)]);
      const parsedIds = new Set(pageSongs.map((song) => String(song.melon_song_id)));
      unavailableSongs = dedupeMelonSongs([
        ...unavailableSongs.filter((song) => !parsedIds.has(String(song.melon_song_id))),
        ...snapshot.unavailable_songs.map((song) => ({ ...song, page_start_index: startIndex }))
      ]);
      const consumedWholePage = remaining >= pageSongs.length;
      const discoveredNext = await findNextStartIndex(page, startIndex);
      const verifiedPage = (snapshot.raw_row_count > 0 || snapshot.empty_list)
        && snapshot.unparsed_row_count === 0 && !repeated && consumedWholePage;
      if (verifiedPage && !replay) {
        for (const song of [...pageSongs, ...snapshot.unavailable_songs]) verifiedIds.add(String(song.melon_song_id));
        checkpoint.verified_scan = { ...checkpoint.verified_scan,
          raw_row_count: checkpoint.verified_scan.raw_row_count + snapshot.raw_row_count,
          song_ids: [...verifiedIds], pages: [...checkpoint.verified_scan.pages, {
            start_index: startIndex, dom_row_count: snapshot.dom_row_count, raw_row_count: snapshot.raw_row_count,
            parsed_row_count: pageSongs.length, unavailable_row_count: snapshot.unavailable_songs.length,
            ignored_row_count: snapshot.ignored_row_count, next_start_index: discoveredNext
          }] };
      }
      let stopReason = null;
      if (snapshot.empty_list) stopReason = discoveredNext != null ? "empty_page_with_next"
        : total == null ? "total_unavailable"
          : accountedCount() === total && verifiedIds.size === total && checkpoint.verified_scan.raw_row_count === total
            ? "completed" : "total_mismatch";
      else if (!snapshot.raw_row_count) stopReason = "no_song_rows";
      else if (snapshot.unparsed_row_count > 0) stopReason = "parse_skipped_rows";
      else if (repeated) stopReason = "repeated_page";
      else if (!consumedWholePage) stopReason = "limit_reached";
      else if (discoveredNext == null) stopReason = total == null ? "total_unavailable"
        : accountedCount() === total && verifiedIds.size === total && checkpoint.verified_scan.raw_row_count === total
          ? "completed" : "total_mismatch";
      else if (total != null && checkpoint.verified_scan.raw_row_count >= total) stopReason = "pagination_total_conflict";
      else if (songs.length >= limit) stopReason = "limit_reached";
      if (verifiedPage) {
        checkpoint = { ...checkpoint, last_processed_start_index: startIndex, page_fingerprint: snapshot.fingerprint };
      }
      await save(stopReason ?? "running", stopReason === "completed");
      console.log(`멜론 추출: ${songs.length}곡 저장, 비활성 ${unavailableSongs.length}곡, 검증 ${checkpoint.verified_scan.raw_row_count}${total != null ? `/${total}` : ""}행`);
      if (stopReason) break;
      try {
        const nextSnapshot = await moveWithLogin(discoveredNext, snapshot, startIndex);
        if (seen.has(nextSnapshot.fingerprint)) {
          await save("repeated_page");
          break;
        }
        snapshot = nextSnapshot;
        startIndex = discoveredNext;
      } catch (error) {
        await save(error.code === "EXTRACTION_CANCELLED" ? "user_cancelled" : "navigation_failed");
        throw error;
      }
    }
    if (result.extraction?.stop_reason === "total_mismatch" && !Number.isFinite(options.limit)
      && total > verifiedIds.size) {
      await run.update({ phase: "artist_filter_supplement" });
      result = await collectArtistSupplement(page, result, {
        readSnapshot: stablePage, readTotal: totalLikeCount, nextStart: findNextStartIndex, move: moveToStart,
        onFilter: async progress => {
          await run.update(progress);
          if (progress.checked_filters % 25 === 0) console.log(`멜론 아티스트 보완: 필터 ${progress.checked_filters}개, 고유 ID ${progress.verified_unique_count}/${total}`);
        },
        onProgress: async supplemented => {
          expectedInput = await withDataLocks(config, async assertOwned => {
            await assertDataSnapshot(config, expectedInput);
            await assertOwned();
            await writeJsonAtomic(config.files.melonLikes, supplemented);
            return dataSnapshot(config);
          });
        }
      });
      await run.update({ source_fingerprint: sourceFingerprint(result.songs), saved_count: result.songs.length,
        ...result.extraction });
    }
    await run.finish(result.complete ? "completed" : "partial", {
      stop_reason: result.extraction?.stop_reason ?? "limit_reached",
      next_start_index: result.checkpoint?.next_start_index ?? startIndex
    });
    return result;
  } catch (error) {
    await run.finish(error.code === "EXTRACTION_CANCELLED" ? "cancelled" : "failed", {
      stop_reason: error.code === "EXTRACTION_CANCELLED" ? "user_cancelled"
        : wroteSource ? result.extraction.stop_reason : "extraction_failed_before_save"
    });
    throw error;
  } finally {
    await context?.close();
  }
}
