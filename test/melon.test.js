import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { extractMelonLikes } from "../src/melon.js";

test("reuses a partial extraction before opening a browser when it already satisfies the limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-extract-reuse-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  await mkdir(config.dataDir, { recursive: true });
  const text = JSON.stringify({
    complete: false,
    checkpoint: { next_start_index: 21 },
    songs: Array.from({ length: 20 }, (_, index) => ({ melon_song_id: String(index + 1) }))
  });
  await writeFile(config.files.melonLikes, text);

  const result = await extractMelonLikes(config, { limit: 20, headless: true });

  assert.equal(result.songs.length, 20);
  assert.equal(result.complete, false);
  assert.equal(await readFile(config.files.melonLikes, "utf8"), text);
});

async function loginFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-login-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  const state = { ready: false, loggedIn: false, launches: 0, closes: 0, navigations: 0, prompts: 0, readlineCloses: 0 };
  state.extraPages = [];
  const rows = [{
    dataSongNo: "10000", title: "테스트 곡", artist: "테스트 가수",
    artists: ["테스트 가수"], album: "테스트 앨범", hrefs: [], onclicks: [], rowText: ""
  }];
  function makePage(isLikes) {
    let likesPage = isLikes;
    let loginPage = false;
    return {
      on() {},
      url: () => {
        if (loginPage && state.loggedIn) loginPage = false;
        return loginPage ? "https://accounts.melon.com/login/login.htm"
          : likesPage ? "https://www.melon.com/mymusic/like/mymusiclikesong_list.htm" : "https://www.melon.com/";
      },
      async goto() { state.navigations += 1; likesPage = false; },
      async waitForLoadState() {},
      async waitForURL() {
        if (state.navigationTimeout) {
          const error = new Error("Synthetic menu navigation timeout");
          error.name = "TimeoutError";
          throw error;
        }
        if (state.pendingLikes) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          likesPage = state.loggedIn || state.ready;
          state.pendingLikes = false;
          state.navigationWaits = (state.navigationWaits ?? 0) + 1;
        }
      },
      locator(selector) {
        if (selector === "tbody tr") return { evaluateAll: async () => likesPage && state.ready ? rows : [] };
        if (selector === "a, button") return { evaluateAll: async () => !likesPage && state.loggedIn };
        if (selector === "a[href*='menu.goMyMusicMain']:visible") return { first: () => ({
          count: async () => 1,
          async click() {
            state.navigations += 1;
            state.menuOpen = true;
            state.myMusicClicks = (state.myMusicClicks ?? 0) + 1;
            if (state.myMusicClicks === state.redirectMyMusicAt) {
              loginPage = true;
              likesPage = false;
              state.loggedIn = false;
            }
          }
        }) };
        if (selector === "a[href*='mymusic.mymusicLink.goLikeSong']:visible") return { first: () => ({
          count: async () => state.menuOpen ? 1 : 0,
          async waitFor() { assert.equal(state.menuOpen, true); },
          async click() {
            state.navigations += 1;
            if (state.deferLikes) { likesPage = false; state.pendingLikes = true; }
            else if (state.loggedIn || state.ready) likesPage = true;
          }
        }) };
        if (selector === "#totCnt, .title .cnt, .wrap_song_info + .cnt") return { allTextContents: async () => ["1"] };
        if (selector === "[href*='sendPage'], [onclick*='sendPage']") return { evaluateAll: async () => [] };
        throw new Error(`Unexpected fixture locator: ${selector}`);
      }
    };
  }
  const home = makePage(false);
  const likes = makePage(true);
  const chromium = {
    async launchPersistentContext() {
      state.launches += 1;
      return { pages: () => [home, ...(state.onlyHome ? [] : [likes]), ...state.extraPages], async close() { state.closes += 1; } };
    }
  };
  function prompt(onQuestion) {
    return () => ({
      async question() {
        state.prompts += 1;
        assert.equal(state.launches, 1);
        assert.equal(state.closes, 0);
        assert.ok(state.navigations >= 1);
        return onQuestion(state);
      },
      close() { state.readlineCloses += 1; }
    });
  }
  return { config, state, chromium, prompt };
}

test("keeps the same browser open after early Enter and resumes from the likes tab", async (t) => {
  const { config, state, chromium, prompt } = await loginFixture(t);
  const result = await extractMelonLikes(config, {
    browserDependencies: { chromium },
    createInterfaceImpl: prompt((current) => {
      current.ready = current.prompts === 2;
      return "";
    })
  });
  assert.equal(result.complete, true);
  assert.equal(result.songs.length, 1);
  assert.equal(result.source.url, "https://www.melon.com/mymusic/like/mymusiclikesong_list.htm");
  assert.equal(state.prompts, 2);
  assert.equal(state.launches, 1);
  assert.equal(state.closes, 1);
  assert.equal(state.readlineCloses, 1);
  assert.equal(JSON.parse(await readFile(config.files.extractionRun)).status, "completed");
});

test("automatically resumes when the likes list appears without Enter and aborts the input wait", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  let inputAborted = false;
  const result = await extractMelonLikes(config, {
    browserDependencies: { chromium }, loginPollMs: 1,
    createInterfaceImpl: () => ({
      question(_, { signal }) {
        state.prompts += 1;
        assert.equal(state.navigations, 1);
        setTimeout(() => { state.ready = true; }, 5);
        return new Promise((_, reject) => signal.addEventListener("abort", () => {
          inputAborted = true;
          reject(new Error("Input aborted"));
        }, { once: true }));
      },
      close() { state.readlineCloses += 1; }
    })
  });
  assert.equal(result.complete, true);
  assert.equal(state.prompts, 1);
  assert.equal(state.navigations, 3);
  assert.equal(state.closes, 1);
  assert.equal(inputAborted, true);
});

test("automatically opens likes after the visible login completion marker, without navigating during login", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  state.onlyHome = true;
  const result = await extractMelonLikes(config, {
    browserDependencies: { chromium }, loginPollMs: 1,
    createInterfaceImpl: () => ({
      question() {
        assert.equal(state.navigations, 1);
        setTimeout(() => { state.loggedIn = true; state.ready = true; }, 5);
        return new Promise(() => {});
      },
      close() { state.readlineCloses += 1; }
    })
  });
  assert.equal(result.complete, true);
  assert.equal(state.launches, 1);
  assert.equal(state.closes, 1);
  assert.equal(state.navigations, 5);
});

test("Enter after login navigates from home when no completion marker is available", async (t) => {
  const { config, state, chromium, prompt } = await loginFixture(t);
  state.onlyHome = true;
  const result = await extractMelonLikes(config, {
    browserDependencies: { chromium },
    createInterfaceImpl: prompt((current) => { current.ready = true; return ""; })
  });
  assert.equal(result.complete, true);
  assert.equal(state.prompts, 1);
  assert.equal(state.navigations, 5);
});

test("cancelling the login wait preserves existing extraction and checkpoint", async (t) => {
  const { config, state, chromium, prompt } = await loginFixture(t);
  await mkdir(config.dataDir, { recursive: true });
  const original = JSON.stringify({
    complete: false, checkpoint: { next_start_index: 21 }, songs: [{ melon_song_id: "20000" }]
  });
  await writeFile(config.files.melonLikes, original);
  await assert.rejects(extractMelonLikes(config, {
    browserDependencies: { chromium },
    createInterfaceImpl: prompt(() => " q ")
  }), /사용자가 멜론 추출을 중단/);
  assert.equal(await readFile(config.files.melonLikes, "utf8"), original);
  assert.equal(state.closes, 1);
  assert.equal(state.readlineCloses, 1);
  assert.equal(JSON.parse(await readFile(config.files.extractionRun)).status, "cancelled");
});

test("headless extraction still fails without songs and never prompts for login", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  await assert.rejects(extractMelonLikes(config, {
    headless: true,
    browserDependencies: { chromium },
    createInterfaceImpl() { assert.fail("headless extraction must not prompt"); }
  }), /로그인된 멜론 세션이 없습니다/);
  assert.equal(state.closes, 1);
});

test("an authenticated headless run opens its own likes menu without requesting login", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  state.onlyHome = true;
  state.loggedIn = true;
  state.ready = true;
  const result = await extractMelonLikes(config, {
    headless: true, browserDependencies: { chromium },
    createInterfaceImpl() { assert.fail("authenticated extraction must not prompt"); }
  });
  assert.equal(result.complete, true);
  assert.equal(state.navigations, 5);
  assert.equal(state.closes, 1);
});

test("waits for a delayed likes navigation before reading rows or requesting login", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  Object.assign(state, { onlyHome: true, loggedIn: true, ready: true, deferLikes: true });
  const result = await extractMelonLikes(config, {
    headless: true, browserDependencies: { chromium },
    createInterfaceImpl() { assert.fail("a pending menu navigation is not a missing login"); }
  });
  assert.equal(result.complete, true);
  assert.equal(state.navigationWaits, 2);
});

for (const redirectMyMusicAt of [1, 2]) {
  test(`menu login redirect at navigation ${redirectMyMusicAt} waits in the same browser and ignores stale likes tabs`, async (t) => {
    const { config, state, chromium, prompt } = await loginFixture(t);
    Object.assign(state, { loggedIn: true, ready: true, redirectMyMusicAt });
    const result = await extractMelonLikes(config, {
      browserDependencies: { chromium },
      createInterfaceImpl: prompt(async (current) => {
        assert.equal(JSON.parse(await readFile(config.files.extractionRun)).phase, "awaiting_login");
        current.loggedIn = true;
        return "";
      })
    });
    assert.equal(result.complete, true);
    assert.equal(state.prompts, 1, "restored likes rows must not bypass reauthentication");
    assert.equal(state.launches, 1);
    assert.equal(state.closes, 1);
  });
}

test("headless login redirect fails clearly without prompting or relaunching", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  Object.assign(state, { loggedIn: true, ready: true, redirectMyMusicAt: 1 });
  await assert.rejects(extractMelonLikes(config, {
    headless: true, browserDependencies: { chromium },
    createInterfaceImpl() { assert.fail("headless reauthentication must not prompt"); }
  }), /로그인된 멜론 세션이 없습니다/);
  assert.equal(state.launches, 1);
  assert.equal(state.closes, 1);
});

test("reauthentication also resumes automatically without Enter", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  Object.assign(state, { loggedIn: true, ready: true, redirectMyMusicAt: 2 });
  const result = await extractMelonLikes(config, {
    browserDependencies: { chromium }, loginPollMs: 1,
    createInterfaceImpl: () => ({
      question() {
        state.prompts += 1;
        setTimeout(() => { state.loggedIn = true; }, 10);
        return new Promise(() => {});
      }, close() {}
    })
  });
  assert.equal(result.complete, true);
  assert.equal(state.prompts, 1);
  assert.equal(state.launches, 1);
});

test("ordinary menu timeouts do not trigger reauthentication or hide failures", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  Object.assign(state, { loggedIn: true, ready: true, navigationTimeout: true });
  await assert.rejects(extractMelonLikes(config, {
    browserDependencies: { chromium },
    createInterfaceImpl() { assert.fail("a non-login timeout must not request authentication"); }
  }), /Synthetic menu navigation timeout/);
  assert.equal(state.launches, 1);
  assert.equal(state.closes, 1);
});

test("ignores restored chart tabs and closed likes tabs when selecting the source", async (t) => {
  const { config, state, chromium, prompt } = await loginFixture(t);
  state.extraPages = [
    { url: () => "https://www.melon.com/chart/index.htm", async waitForLoadState() {}, on() {},
      locator(selector) {
        assert.equal(selector, "a, button", "chart rows must never be scraped");
        return { evaluateAll: async () => false };
      } },
    { isClosed: () => true, on() {}, locator() { assert.fail("closed tabs must never be scraped"); } }
  ];
  const result = await extractMelonLikes(config, { browserDependencies: { chromium },
    createInterfaceImpl: prompt((current) => { current.ready = current.prompts === 2; return ""; }) });
  assert.equal(result.songs.length, 1);
  assert.equal(state.prompts, 2);
});

function songRow(id) {
  return { dataSongNo: String(id), title: `Song ${id}`, artist: "Artist", artists: ["Artist"],
    album: "Album", hrefs: [], onclicks: [], rowText: "" };
}

function emptyLikesRows() {
  return [
    { hasSongCheckbox: false, cellCount: 0, colspans: [], rowText: "" },
    { hasSongCheckbox: false, cellCount: 1, colspans: [9], rowText: "좋아요 곡이 없습니다." }
  ];
}

async function paginationFixture(t, pages, total = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-pagination-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  const state = { index: 1, failAt: null, totalReported: total };
  const page = {
    on() {}, isClosed: () => false,
    url: () => state.loginRequired ? "https://accounts.melon.com/login/login.htm"
      : "https://www.melon.com/mymusic/like/mymusiclikesong_list.htm",
    async goto() { state.index = 1; },
    async waitForLoadState() {},
    async waitForURL() {},
    async waitForFunction() { state.controllerReady = true; },
    async evaluate(_, start) {
      if (start == null) return true;
      assert.equal(state.controllerReady, true, "pagination must wait for the page controller");
      if (start === state.failAt) throw new Error("Synthetic navigation failure");
      if (start === state.authAt) {
        state.authAt = null;
        state.loginRequired = true;
        return;
      }
      state.index = start;
    },
    locator(selector) {
      if (selector === "#artistMenu") return { count: async () => 0 };
      if (selector === "tbody tr") return { evaluateAll: async () => pages[state.index].rows };
      if (selector === "a[href*='mymusic.mymusicLink.goLikeSong']:visible") return { first: () => ({
        count: async () => 1, async waitFor() {}, async click() { state.index = 1; }
      }) };
      if (selector === "a[href*='menu.goMyMusicMain']:visible") return { first: () => ({
        count: async () => 1, async click() {}
      }) };
      if (selector === "#totCnt, .title .cnt, .wrap_song_info + .cnt") return { allTextContents: async () => state.totalReported == null ? [] : [String(state.totalReported)] };
      if (selector === "[href*='sendPage'], [onclick*='sendPage']") return { evaluateAll: async () => pages[state.index].next ? [pages[state.index].next] : [] };
      throw new Error(`Unexpected fixture locator: ${selector}`);
    }
  };
  return { config, state, options: { browserDependencies: { chromium: {
    async launchPersistentContext() { return { pages: () => [page], async close() {} }; }
  } } } };
}

test("pagination reauthentication resumes with verified rows counted only once", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), songRow(9828)], next: 3 },
    3: { rows: [songRow(10002)] }
  }, 3);
  fixture.state.authAt = 3;
  let prompts = 0;
  const result = await extractMelonLikes(fixture.config, { ...fixture.options,
    createInterfaceImpl: () => ({
      async question() {
        prompts += 1;
        const saved = JSON.parse(await readFile(fixture.config.files.melonLikes));
        assert.equal(saved.checkpoint.verified_scan.raw_row_count, 2);
        assert.equal(JSON.parse(await readFile(fixture.config.files.extractionRun)).phase, "awaiting_login");
        fixture.state.loginRequired = false;
        fixture.state.index = 1;
        return "";
      }, close() {}
    })
  });
  assert.equal(result.complete, true);
  assert.equal(prompts, 1);
  assert.equal(result.songs.length, 3);
  assert.equal(result.checkpoint.verified_scan.raw_row_count, 3);
});

test("the empty terminal notice records a total mismatch instead of skipped song rows", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), songRow(10001)], next: 3 },
    3: { rows: [songRow(10002)], next: 5 },
    5: { rows: emptyLikesRows() }
  }, 5);
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.complete, false);
  assert.equal(result.extraction.stop_reason, "total_mismatch");
  assert.equal(result.checkpoint.next_start_index, 5);
  assert.equal(result.songs.length, 3);
  assert.equal(result.extraction.raw_row_count, 0);
  assert.equal(result.extraction.dom_row_count, 2);
  assert.equal(result.extraction.ignored_row_count, 2);
  assert.equal(result.extraction.unparsed_row_count, 0);
  assert.equal(result.extraction.empty_list, true);
  assert.equal(result.extraction.verified_row_count, 3);
  assert.equal(result.extraction.verified_unique_count, 3);
  assert.equal(result.extraction.reported_count_gap, 2);
  assert.equal(result.extraction.page_count, 3);
  assert.deepEqual(result.checkpoint.verified_scan.pages.map(p => [p.start_index, p.raw_row_count, p.ignored_row_count]),
    [[1, 2, 0], [3, 1, 0], [5, 0, 2]]);
  const replayed = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(replayed.extraction.page_count, 3);
  assert.equal(replayed.extraction.verified_row_count, 3);
});

test("a truly empty source completes only with a known zero total and preserves old metadata", async (t) => {
  const fixture = await paginationFixture(t, { 1: { rows: emptyLikesRows() } }, 0);
  const result = await extractMelonLikes(fixture.config, { ...fixture.options, headless: true });
  assert.equal(result.complete, true);
  assert.equal(result.songs.length, 0);
  assert.equal(result.extraction.reported_count_gap, 0);
  assert.equal(result.extraction.verified_row_count, 0);
  await writeFile(fixture.config.files.melonLikes, JSON.stringify({
    complete: false, songs: [{ melon_song_id: "10000", title: "Saved song", artist: "Artist" }]
  }));
  const preserved = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(preserved.complete, false);
  assert.equal(preserved.extraction.stop_reason, "total_mismatch");
  assert.equal(preserved.songs.length, 1);
});

test("empty notices with unknown totals or later pages never falsely complete", async (t) => {
  const unknown = await paginationFixture(t, { 1: { rows: emptyLikesRows() } });
  const incomplete = await extractMelonLikes(unknown.config, unknown.options);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.extraction.stop_reason, "total_unavailable");
  assert.equal(incomplete.extraction.reported_count_gap, null);
  const withNext = await paginationFixture(t, {
    1: { rows: emptyLikesRows(), next: 3 }, 3: { rows: [songRow(10000)] }
  }, 1);
  const stopped = await extractMelonLikes(withNext.config, withNext.options);
  assert.equal(stopped.complete, false);
  assert.equal(stopped.extraction.stop_reason, "empty_page_with_next");
});

test("unknown song rows still stop even when an empty-likes notice is present", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [...emptyLikesRows(), songRow(10001), { dataSongNo: "10000", title: "Unparsed song" }] }
  }, 2);
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.complete, false);
  assert.equal(result.extraction.stop_reason, "parse_skipped_rows");
  assert.equal(result.extraction.raw_row_count, 2);
  assert.equal(result.extraction.ignored_row_count, 2);
  assert.equal(result.extraction.unparsed_row_count, 1);
});

test("cancelling pagination reauthentication preserves songs and records a cancelled run", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000)], next: 2 },
    2: { rows: [songRow(10001)] }
  }, 2);
  fixture.state.authAt = 2;
  await assert.rejects(extractMelonLikes(fixture.config, { ...fixture.options,
    createInterfaceImpl: () => ({ async question() { return "q"; }, close() {} })
  }), /사용자가 멜론 추출을 중단/);
  const saved = JSON.parse(await readFile(fixture.config.files.melonLikes));
  assert.equal(saved.complete, false);
  assert.equal(saved.songs.length, 1);
  assert.equal(saved.source.url, "https://www.melon.com/mymusic/like/mymusiclikesong_list.htm");
  assert.equal(saved.checkpoint.next_start_index, 1);
  assert.equal(saved.checkpoint.verified_scan.raw_row_count, 1);
  assert.equal(saved.extraction.stop_reason, "user_cancelled");
  assert.equal(JSON.parse(await readFile(fixture.config.files.extractionRun)).status, "cancelled");
});

test("a changed total after reauthentication stops and preserves the verified checkpoint", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000)], next: 2 },
    2: { rows: [songRow(10001)] }
  }, 2);
  fixture.state.authAt = 2;
  await assert.rejects(extractMelonLikes(fixture.config, { ...fixture.options,
    createInterfaceImpl: () => ({
      async question() {
        fixture.state.loginRequired = false;
        fixture.state.totalReported = 3;
        return "";
      }, close() {}
    })
  }), /전체 곡 수가 변경/);
  const saved = JSON.parse(await readFile(fixture.config.files.melonLikes));
  assert.equal(saved.complete, false);
  assert.equal(saved.checkpoint.next_start_index, 1);
  assert.equal(saved.checkpoint.verified_scan.raw_row_count, 1);
  assert.equal(saved.extraction.stop_reason, "navigation_failed");
});

test("a changed page after reauthentication stops rather than combining different traversals", async (t) => {
  const pages = {
    1: { rows: [songRow(10000)], next: 2 },
    2: { rows: [songRow(10001)] }
  };
  const fixture = await paginationFixture(t, pages, 2);
  fixture.state.authAt = 2;
  await assert.rejects(extractMelonLikes(fixture.config, { ...fixture.options,
    createInterfaceImpl: () => ({
      async question() {
        fixture.state.loginRequired = false;
        pages[1].rows[0].title = "Changed after login";
        return "";
      }, close() {}
    })
  }), /이전 검증 페이지가 변경/);
  const saved = JSON.parse(await readFile(fixture.config.files.melonLikes));
  assert.equal(saved.songs[0].title, "Song 10000");
  assert.equal(saved.checkpoint.verified_scan.raw_row_count, 1);
  assert.equal(saved.complete, false);
});

test("does not declare unknown totals or contradictory pagination complete", async (t) => {
  const unknown = await paginationFixture(t, { 1: { rows: [songRow(10000)] } });
  const result = await extractMelonLikes(unknown.config, unknown.options);
  assert.equal(result.complete, false);
  assert.equal(result.extraction.stop_reason, "total_unavailable");
  const conflict = await paginationFixture(t, { 1: { rows: [songRow(10000)], next: 2 } }, 1);
  const inconsistent = await extractMelonLikes(conflict.config, conflict.options);
  assert.equal(inconsistent.complete, false);
  assert.equal(inconsistent.extraction.stop_reason, "pagination_total_conflict");
});

test("records skipped rows and keeps their page as the retry checkpoint", async (t) => {
  const fixture = await paginationFixture(t, { 1: { rows: [songRow(10000), { ...songRow(10001), artist: "", artists: [] }], next: 3 } }, 2);
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.extraction.stop_reason, "parse_skipped_rows");
  assert.equal(result.extraction.raw_row_count, 2);
  assert.equal(result.extraction.parsed_row_count, 1);
  assert.equal(result.checkpoint.next_start_index, 1);
  assert.equal(result.complete, false);
});

test("reads the comma-separated live total but stops on a row without a song title", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), { ...songRow(10001), title: "" }], next: 3 }
  }, "3,517");
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.source.total_reported, 3517);
  assert.equal(result.complete, false);
  assert.equal(result.extraction.stop_reason, "parse_skipped_rows");
  assert.equal(result.extraction.raw_row_count, 2);
  assert.equal(result.extraction.parsed_row_count, 1);
  assert.equal(result.checkpoint.next_start_index, 1);
});

test("keeps the last verified checkpoint after navigation failure and safely replays it", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), songRow(10001)], next: 3 },
    3: { rows: [songRow(10002), songRow(10003)] }
  }, 4);
  fixture.state.failAt = 3;
  await assert.rejects(extractMelonLikes(fixture.config, fixture.options), /Synthetic navigation failure/);
  const partial = JSON.parse(await readFile(fixture.config.files.melonLikes, "utf8"));
  assert.equal(partial.complete, false);
  assert.equal(partial.checkpoint.next_start_index, 1);
  assert.equal(partial.extraction.stop_reason, "navigation_failed");
  fixture.state.failAt = null;
  const resumed = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.songs.length, 4);
});

test("stops a pagination cycle without advancing past the last distinct page", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000)], next: 2 },
    2: { rows: [songRow(10001)], next: 3 },
    3: { rows: [songRow(10000)], next: 4 }
  });
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.extraction.stop_reason, "repeated_page");
  assert.equal(result.checkpoint.next_start_index, 2);
  assert.equal(result.songs.length, 2);
});

test("resumes a whole-page limit but refuses completion when raw rows repeat a song ID", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), songRow(10001)], next: 3 },
    3: { rows: [songRow(10000), songRow(10002)] }
  }, 3);
  const limited = await extractMelonLikes(fixture.config, { ...fixture.options, limit: 2 });
  assert.equal(limited.complete, false);
  assert.equal(limited.extraction.stop_reason, "limit_reached");
  assert.equal(limited.checkpoint.next_start_index, 1);
  const resumed = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(resumed.complete, false);
  assert.equal(resumed.extraction.stop_reason, "total_mismatch");
  assert.equal(resumed.checkpoint.verified_scan.raw_row_count, 4);
  assert.equal(resumed.songs.length, 3);
});

function unavailableRow(id) {
  return { ...songRow(id), title: "", noResult: true, checkboxDisabled: true };
}

test("retains unavailable IDs and resumes through them without counting replayed rows twice", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), unavailableRow(10001)], next: 3 },
    3: { rows: [unavailableRow(10002), songRow(10003)] }
  }, 4);
  fixture.state.failAt = 3;
  await assert.rejects(extractMelonLikes(fixture.config, fixture.options), /Synthetic navigation failure/);
  const partial = JSON.parse(await readFile(fixture.config.files.melonLikes, "utf8"));
  assert.equal(partial.checkpoint.verified_scan.raw_row_count, 2);
  assert.equal(partial.unavailable_songs.length, 1);
  fixture.state.failAt = null;
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.complete, true);
  assert.deepEqual(result.songs.map((song) => song.melon_song_id), ["10000", "10003"]);
  assert.deepEqual(result.unavailable_songs, [
    { melon_song_id: "10001", reason: "disabled_no_result", row_index: 2, page_start_index: 1 },
    { melon_song_id: "10002", reason: "disabled_no_result", row_index: 1, page_start_index: 3 }
  ]);
  assert.equal(result.checkpoint.verified_scan.raw_row_count, 4);
  assert.equal(result.extraction.accounted_count, 4);
});

test("can verify a list consisting only of unavailable rows", async (t) => {
  const fixture = await paginationFixture(t, { 1: { rows: [unavailableRow(10000), unavailableRow(10001)] } }, 2);
  const result = await extractMelonLikes(fixture.config, { ...fixture.options, headless: true });
  assert.equal(result.complete, true);
  assert.equal(result.songs.length, 0);
  assert.equal(result.unavailable_songs.length, 2);
});

test("legacy resume rechecks earlier pages and preserves existing metadata instead of skipping known pages", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), unavailableRow(10001)], next: 3 },
    3: { rows: [songRow(10002)] }
  }, 3);
  await mkdir(fixture.config.dataDir, { recursive: true });
  await writeFile(fixture.config.files.melonLikes, JSON.stringify({
    songs: [{ melon_song_id: "10000", title: "Old title", artist: "Artist" }],
    complete: false, checkpoint: { next_start_index: 3 }
  }));
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.complete, true);
  assert.equal(result.songs.length, 2);
  assert.equal(result.unavailable_songs.length, 1);
  assert.equal(result.checkpoint.verified_scan.raw_row_count, 3);
});

test("normal limit resume and a changed total both produce a fully verified scan", async (t) => {
  const fixture = await paginationFixture(t, {
    1: { rows: [songRow(10000), songRow(10001)], next: 3 },
    3: { rows: [songRow(10002), songRow(10003)] }
  }, 4);
  await extractMelonLikes(fixture.config, { ...fixture.options, limit: 2 });
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.complete, true);
  assert.equal(result.checkpoint.verified_scan.raw_row_count, 4);

  const changed = await paginationFixture(t, {
    1: { rows: [songRow(20000)], next: 2 },
    2: { rows: [songRow(20001)] }
  }, 1);
  await extractMelonLikes(changed.config, { ...changed.options, limit: 1 });
  changed.state.totalReported = 2;
  const rescanned = await extractMelonLikes(changed.config, changed.options);
  assert.equal(rescanned.complete, true);
  assert.equal(rescanned.checkpoint.verified_scan.raw_row_count, 2);
});

test("a changed checkpoint page restarts verification while retaining previously saved songs", async (t) => {
  const pages = {
    1: { rows: [songRow(10000)], next: 2 },
    2: { rows: [songRow(10001)] }
  };
  const fixture = await paginationFixture(t, pages, 2);
  await extractMelonLikes(fixture.config, { ...fixture.options, limit: 1 });
  pages[1].rows[0].title = "Updated title";
  const result = await extractMelonLikes(fixture.config, fixture.options);
  assert.equal(result.complete, true);
  assert.equal(result.songs[0].title, "Updated title");
  assert.equal(result.checkpoint.verified_scan.raw_row_count, 2);
});

test("unknown parse errors still stop and stale saved IDs prevent a false completion", async (t) => {
  const unknown = await paginationFixture(t, {
    1: { rows: [songRow(10000), { ...unavailableRow(10001), checkboxDisabled: false }], next: 3 },
    3: { rows: [songRow(10002)] }
  }, 3);
  const incomplete = await extractMelonLikes(unknown.config, unknown.options);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.extraction.stop_reason, "parse_skipped_rows");
  assert.equal(incomplete.unavailable_songs.length, 0);
  assert.equal(incomplete.checkpoint.next_start_index, 1);

  const stale = await paginationFixture(t, { 1: { rows: [songRow(10000)] } }, 1);
  await mkdir(stale.config.dataDir, { recursive: true });
  await writeFile(stale.config.files.melonLikes, JSON.stringify({
    songs: [{ melon_song_id: "99999", title: "Saved metadata", artist: "Artist" }], complete: false
  }));
  const result = await extractMelonLikes(stale.config, stale.options);
  assert.equal(result.complete, false);
  assert.equal(result.extraction.stop_reason, "total_mismatch");
  assert.equal(result.songs.some((song) => song.melon_song_id === "99999"), true);
});

test("refresh rescans a completed extraction from the first page while keeping saved songs", async (t) => {
  const { config, state, chromium } = await loginFixture(t);
  state.onlyHome = true;
  state.loggedIn = true;
  state.ready = true;
  await mkdir(config.dataDir, { recursive: true });
  const saved = { melon_song_id: "10000", title: "테스트 곡", artist: "테스트 가수", album: "테스트 앨범", saved_note: "kept" };
  await writeFile(config.files.melonLikes, JSON.stringify({ complete: true, extraction: { stop_reason: "completed" },
    checkpoint: { next_start_index: 1, last_processed_start_index: 1, page_fingerprint: "old",
      verified_scan: { start_index: 1, total_reported: 1, raw_row_count: 1, song_ids: ["10000"], pages: [{ start_index: 1 }] } },
    songs: [saved] }));
  const options = { headless: true, browserDependencies: { chromium },
    createInterfaceImpl() { assert.fail("authenticated extraction must not prompt"); } };

  const reused = await extractMelonLikes(config, options);
  assert.equal(state.launches, 0);
  assert.equal(reused.songs[0].saved_note, "kept");

  const refreshed = await extractMelonLikes(config, { ...options, refresh: true });
  assert.equal(state.launches, 1);
  assert.equal(refreshed.complete, true);
  assert.equal(refreshed.extraction.stop_reason, "completed");
  assert.deepEqual(refreshed.songs.map((song) => song.melon_song_id), ["10000"]);
  assert.equal(refreshed.checkpoint.verified_scan.pages.length, 1);
  assert.notEqual(refreshed.checkpoint.page_fingerprint, "old");
});
