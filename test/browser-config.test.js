import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureBrowser,
  launchConfiguredBrowser,
  loadBrowserConfig,
  resolveBrowserRuntime
} from "../src/browser-config.js";
import { resolveConfig } from "../src/config.js";
import { localStatus } from "../src/pipeline.js";
import { extractMelonLikes } from "../src/melon.js";
import { readAppleWebMediaUserToken } from "../src/apple-web-auth.js";

async function temporaryProject(t, prefix = "browser-config-test-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config: resolveConfig({ root }) };
}

test("defaults to Chrome without creating a settings file", async (t) => {
  const { config } = await temporaryProject(t);
  assert.deepEqual(await loadBrowserConfig(config), {
    browser: "chrome",
    playwright_channel: "chrome",
    source: "default",
    config_path: config.files.browserConfig
  });
  await assert.rejects(access(config.files.browserConfig));
});

test("configure atomically saves Chrome and Edge and rejects invalid values", async (t) => {
  const { config } = await temporaryProject(t);
  await configureBrowser(config, "chrome");
  assert.equal(JSON.parse(await readFile(config.files.browserConfig, "utf8")).browser, "chrome");
  await configureBrowser(config, "edge");
  const saved = await readFile(config.files.browserConfig, "utf8");
  assert.equal(JSON.parse(saved).browser, "edge");
  await assert.rejects(configureBrowser(config, "firefox"), /chrome 또는 edge/);
  assert.equal(await readFile(config.files.browserConfig, "utf8"), saved);
  assert.deepEqual((await readdir(config.stateDir)).filter((name) => name.endsWith(".tmp")), []);
});

test("corrupt and unsupported settings fail closed", async (t) => {
  const { config } = await temporaryProject(t);
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(config.files.browserConfig, "{not-json", "utf8");
  await assert.rejects(loadBrowserConfig(config), /설정 파일이 손상.*configure --browser/);
  await writeFile(config.files.browserConfig, JSON.stringify({ schema_version: 1, browser: "firefox" }), "utf8");
  await assert.rejects(loadBrowserConfig(config), /chrome 또는 edge.*configure --browser/);
  await writeFile(config.files.browserConfig, JSON.stringify({ schema_version: 2, browser: "chrome" }), "utf8");
  await assert.rejects(loadBrowserConfig(config), /지원하지 않는.*schema.*configure --browser/);
});

test("service and browser profile paths are isolated", async (t) => {
  const { config } = await temporaryProject(t);
  const chrome = await resolveBrowserRuntime(config);
  assert.equal(chrome.profiles.melon.path, path.join(config.stateDir, "profiles", "chrome", "melon"));
  assert.equal(chrome.profiles.apple_music.path, path.join(config.stateDir, "profiles", "chrome", "apple-music"));
  assert.notEqual(chrome.profiles.melon.path, chrome.profiles.apple_music.path);

  await configureBrowser(config, "edge");
  const edge = await resolveBrowserRuntime(config);
  assert.equal(edge.profiles.melon.path, path.join(config.stateDir, "profiles", "edge", "melon"));
  assert.equal(edge.profiles.apple_music.path, path.join(config.stateDir, "profiles", "edge", "apple-music"));
  assert.notEqual(chrome.profiles.melon.path, edge.profiles.melon.path);
  assert.notEqual(chrome.profiles.apple_music.path, edge.profiles.apple_music.path);
});

test("only exact legacy combinations fall back and canonical paths win", async (t) => {
  const { config } = await temporaryProject(t);
  const melonEdgeLegacy = path.join(config.stateDir, "melon-edge-profile");
  const appleChromeLegacy = path.join(config.stateDir, "apple-music-chrome-profile");
  await mkdir(melonEdgeLegacy, { recursive: true });
  await mkdir(appleChromeLegacy, { recursive: true });

  const chrome = await resolveBrowserRuntime(config);
  assert.equal(chrome.profiles.melon.kind, "canonical");
  assert.notEqual(chrome.profiles.melon.path, melonEdgeLegacy);
  assert.deepEqual(chrome.profiles.apple_music, { path: appleChromeLegacy, kind: "legacy-fallback" });

  await configureBrowser(config, "edge");
  const edge = await resolveBrowserRuntime(config);
  assert.deepEqual(edge.profiles.melon, { path: melonEdgeLegacy, kind: "legacy-fallback" });
  assert.equal(edge.profiles.apple_music.kind, "canonical");
  assert.notEqual(edge.profiles.apple_music.path, appleChromeLegacy);

  const canonicalMelon = path.join(config.stateDir, "profiles", "edge", "melon");
  await mkdir(canonicalMelon, { recursive: true });
  const withCanonical = await resolveBrowserRuntime(config);
  assert.deepEqual(withCanonical.profiles.melon, { path: canonicalMelon, kind: "canonical" });
});

test("both services launch both mapped channels and ignore the retired Melon override", async (t) => {
  const { config } = await temporaryProject(t);
  const calls = [];
  const chromium = {
    async launchPersistentContext(profilePath, options) {
      calls.push({ profilePath, channel: options.channel });
      return { async close() {} };
    }
  };
  const previous = process.env.MELON_BROWSER_CHANNEL;
  process.env.MELON_BROWSER_CHANNEL = "msedge";
  try {
    const melon = await launchConfiguredBrowser(config, "melon", {}, { chromium });
    await melon.context.close();
    const apple = await launchConfiguredBrowser(config, "apple-music", {}, { chromium });
    await apple.context.close();
    await configureBrowser(config, "edge");
    const edgeMelon = await launchConfiguredBrowser(config, "melon", {}, { chromium });
    await edgeMelon.context.close();
    const edgeApple = await launchConfiguredBrowser(config, "apple-music", {}, { chromium });
    await edgeApple.context.close();
  } finally {
    if (previous == null) delete process.env.MELON_BROWSER_CHANNEL;
    else process.env.MELON_BROWSER_CHANNEL = previous;
  }
  assert.deepEqual(calls.map((call) => call.channel), ["chrome", "chrome", "msedge", "msedge"]);
  assert.notEqual(calls[0].profilePath, calls[1].profilePath);
  assert.notEqual(calls[0].profilePath, calls[2].profilePath);
});

test("Melon extraction launches through the shared Chrome policy", async (t) => {
  const { config } = await temporaryProject(t, "browser-melon-integration-test-");
  const calls = [];
  const rows = [{
    dataSongNo: "10000",
    inputValue: "",
    hrefs: [],
    onclicks: [],
    title: "테스트 곡",
    artists: ["테스트 가수"],
    artist: "테스트 가수",
    album: "테스트 앨범",
    rowText: ""
  }];
  const page = {
    url: () => "https://www.melon.com/mymusic/like/mymusiclikesong_list.htm",
    on() {},
    async goto() {},
    async waitForLoadState() {},
    async waitForURL() {},
    locator(selector) {
      if (selector === "tbody tr") return { evaluateAll: async () => rows };
      if (selector === "a[href*='mymusic.mymusicLink.goLikeSong']:visible") return { first: () => ({
        count: async () => 1, async waitFor() {}, async click() {}
      }) };
      if (selector === "a[href*='menu.goMyMusicMain']:visible") return { first: () => ({
        count: async () => 1, async click() {}
      }) };
      if (selector === "#totCnt, .title .cnt, .wrap_song_info + .cnt") return { allTextContents: async () => ["1"] };
      if (selector === "[href*='sendPage'], [onclick*='sendPage']") return { evaluateAll: async () => [] };
      throw new Error(`Unexpected fixture locator: ${selector}`);
    }
  };
  const chromium = {
    async launchPersistentContext(profilePath, options) {
      calls.push({ profilePath, channel: options.channel, args: options.args });
      return { pages: () => [page], async close() {} };
    }
  };
  const result = await extractMelonLikes(config, {
    limit: 1,
    browserDependencies: { chromium }
  });
  assert.equal(result.songs.length, 1);
  assert.deepEqual(calls, [{
    profilePath: path.join(config.stateDir, "profiles", "chrome", "melon"),
    channel: "chrome",
    args: ["--restore-last-session"]
  }]);
});

test("Apple web auth launches through the shared Edge policy", async (t) => {
  const { config } = await temporaryProject(t, "browser-apple-integration-test-");
  await configureBrowser(config, "edge");
  const calls = [];
  let closed = false;
  const chromium = {
    async launchPersistentContext(profilePath, options) {
      calls.push({ profilePath, channel: options.channel, args: options.args });
      return {
        async cookies() { return [{ name: "media-user-token", value: "fixture-token" }]; },
        async close() { closed = true; }
      };
    }
  };
  const token = await readAppleWebMediaUserToken(config, {
    interactive: false,
    browserDependencies: { chromium }
  });
  assert.equal(token, "fixture-token");
  assert.equal(closed, true);
  assert.deepEqual(calls, [{
    profilePath: path.join(config.stateDir, "profiles", "edge", "apple-music"),
    channel: "msedge",
    args: ["--no-first-run", "--no-default-browser-check"]
  }]);
});

test("a selected-browser launch failure does not try another channel", async (t) => {
  const { config } = await temporaryProject(t);
  const calls = [];
  const chromium = {
    async launchPersistentContext(_profilePath, options) {
      calls.push(options.channel);
      throw new Error("fixture launch failure");
    }
  };
  await assert.rejects(
    launchConfiguredBrowser(config, "melon", {}, { chromium }),
    /선택한 브라우저 chrome \(Playwright channel: chrome\).*configure --browser edge.*자동 전환하지 않았습니다/
  );
  assert.deepEqual(calls, ["chrome"]);
});

test("status reports the selected browser, channel, and actual profile paths", async (t) => {
  const { config } = await temporaryProject(t);
  const appleChromeLegacy = path.join(config.stateDir, "apple-music-chrome-profile");
  await mkdir(appleChromeLegacy, { recursive: true });
  const status = await localStatus(config);
  assert.equal(status.browser.selected, "chrome");
  assert.equal(status.browser.playwright_channel, "chrome");
  assert.deepEqual(status.browser.profiles.apple_music, {
    path: appleChromeLegacy,
    kind: "legacy-fallback"
  });
  assert.deepEqual(status.browser.profiles.melon, {
    path: path.join(config.stateDir, "profiles", "chrome", "melon"),
    kind: "canonical"
  });
});
