import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./io.js";

const DEFAULT_BROWSER = "chrome";
const BROWSER_CHANNELS = Object.freeze({
  chrome: "chrome",
  edge: "msedge"
});
const SERVICES = new Set(["melon", "apple-music"]);

function browserError(message) {
  return new Error(`${message} 해결하려면 melon-to-apple-music configure --browser chrome 또는 melon-to-apple-music configure --browser edge를 실행하세요.`);
}

function validateBrowser(browser, label = "--browser") {
  if (!Object.hasOwn(BROWSER_CHANNELS, browser)) {
    throw browserError(`${label} 값은 chrome 또는 edge만 허용됩니다.`);
  }
  return browser;
}

async function pathExists(targetPath, accessImpl = access) {
  try {
    await accessImpl(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function loadBrowserConfig(config, options = {}) {
  const readFileImpl = options.readFileImpl ?? readFile;
  let text;
  try {
    text = await readFileImpl(config.files.browserConfig, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        browser: DEFAULT_BROWSER,
        playwright_channel: BROWSER_CHANNELS[DEFAULT_BROWSER],
        source: "default",
        config_path: config.files.browserConfig
      };
    }
    throw browserError(`브라우저 설정 파일을 읽을 수 없습니다: ${config.files.browserConfig}.`);
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw browserError(`브라우저 설정 파일이 손상되었습니다: ${config.files.browserConfig}.`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw browserError(`브라우저 설정 파일 형식이 올바르지 않습니다: ${config.files.browserConfig}.`);
  }
  if (document.schema_version !== 1) {
    throw browserError(`지원하지 않는 브라우저 설정 schema입니다: ${config.files.browserConfig}.`);
  }
  const browser = validateBrowser(document.browser, `브라우저 설정 파일의 browser`);
  return {
    browser,
    playwright_channel: BROWSER_CHANNELS[browser],
    source: "configured",
    config_path: config.files.browserConfig
  };
}

export async function configureBrowser(config, browser, options = {}) {
  validateBrowser(browser);
  const writeImpl = options.writeJsonAtomicImpl ?? writeJsonAtomic;
  await writeImpl(config.files.browserConfig, { schema_version: 1, browser });
  return {
    browser,
    playwright_channel: BROWSER_CHANNELS[browser],
    config_path: config.files.browserConfig,
    note: `브라우저별 Melon/Apple Music 프로필은 서로 분리됩니다. ${browser} 프로필에 로그인이 없으면 서비스별로 다시 로그인해야 할 수 있습니다.`
  };
}

function profileCandidates(config, browser, service) {
  if (!SERVICES.has(service)) throw new Error(`지원하지 않는 브라우저 서비스: ${service}`);
  const canonical = path.join(config.stateDir, "profiles", browser, service);
  let legacy = null;
  if (browser === "edge" && service === "melon") legacy = path.join(config.stateDir, "melon-edge-profile");
  if (browser === "chrome" && service === "apple-music") legacy = path.join(config.stateDir, "apple-music-chrome-profile");
  return { canonical, legacy };
}

export async function resolveServiceProfile(config, browser, service, options = {}) {
  validateBrowser(browser, "browser");
  const { canonical, legacy } = profileCandidates(config, browser, service);
  const accessImpl = options.accessImpl ?? access;
  if (await pathExists(canonical, accessImpl)) {
    return { path: canonical, kind: "canonical" };
  }
  if (legacy && await pathExists(legacy, accessImpl)) {
    return { path: legacy, kind: "legacy-fallback" };
  }
  return { path: canonical, kind: "canonical" };
}

export async function resolveBrowserRuntime(config, options = {}) {
  const selection = await loadBrowserConfig(config, options);
  const [melon, appleMusic] = await Promise.all([
    resolveServiceProfile(config, selection.browser, "melon", options),
    resolveServiceProfile(config, selection.browser, "apple-music", options)
  ]);
  return {
    selected: selection.browser,
    playwright_channel: selection.playwright_channel,
    config_source: selection.source,
    config_path: selection.config_path,
    profiles: {
      melon,
      apple_music: appleMusic
    }
  };
}

export async function launchConfiguredBrowser(config, service, launchOptions = {}, dependencies = {}) {
  const runtime = dependencies.runtime ?? await resolveBrowserRuntime(config, dependencies);
  const profileKey = service === "apple-music" ? "apple_music" : service;
  const profile = runtime.profiles[profileKey];
  if (!profile) throw new Error(`지원하지 않는 브라우저 서비스: ${service}`);
  const chromium = dependencies.chromium ?? (await import("playwright")).chromium;
  try {
    await (dependencies.mkdirImpl ?? mkdir)(profile.path, { recursive: true });
    const context = await chromium.launchPersistentContext(profile.path, {
      ...launchOptions,
      channel: runtime.playwright_channel
    });
    return { context, runtime, profile };
  } catch (cause) {
    const alternative = runtime.selected === "chrome" ? "edge" : "chrome";
    const error = new Error(
      `선택한 브라우저 ${runtime.selected} (Playwright channel: ${runtime.playwright_channel})를 실행할 수 없습니다. `
      + `설치 상태를 확인하거나 melon-to-apple-music configure --browser ${alternative}로 명시적으로 변경하세요. 다른 브라우저로 자동 전환하지 않았습니다.`,
      { cause }
    );
    error.code = "BROWSER_LAUNCH_FAILED";
    throw error;
  }
}
