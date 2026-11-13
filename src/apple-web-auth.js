import { launchConfiguredBrowser } from "./browser-config.js";

const APPLE_MUSIC_ORIGIN = "https://music.apple.com";
const BROWSE_URL = `${APPLE_MUSIC_ORIGIN}/kr/browse`;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const REFRESH_WINDOW_SECONDS = 15 * 24 * 60 * 60;

let bearerCache = null;

export function decodeJwtClaims(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new Error("AMPWebPlay token 형식이 올바르지 않습니다.");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("AMPWebPlay token payload를 읽을 수 없습니다.");
  }
}

export function extractAmpWebPlayBearer(source, nowSeconds = Math.floor(Date.now() / 1000)) {
  for (const token of String(source ?? "").match(JWT_PATTERN) ?? []) {
    try {
      const claims = decodeJwtClaims(token);
      if (claims.iss === "AMPWebPlay" && Number.isFinite(Number(claims.exp)) && Number(claims.exp) > nowSeconds) {
        return { token, exp: Number(claims.exp) };
      }
    } catch {
      // Other bundle strings that merely look like JWTs are ignored.
    }
  }
  throw new Error("Apple Music web bundle에서 유효한 AMPWebPlay Bearer를 찾지 못했습니다.");
}

export function findAppleMusicBundleUrls(html, pageUrl = BROWSE_URL) {
  const urls = [];
  const pattern = /<script\b[^>]*\bsrc=["']([^"']+\.js(?:\?[^"']*)?)["'][^>]*>/giu;
  for (const match of String(html ?? "").matchAll(pattern)) {
    const url = new URL(match[1], pageUrl);
    if (url.origin === APPLE_MUSIC_ORIGIN && url.pathname.startsWith("/assets/")) urls.push(url.href);
  }
  return [...new Set(urls)].sort((left, right) =>
    Number(!/\/index[^/]*\.js/i.test(left)) - Number(!/\/index[^/]*\.js/i.test(right))
  );
}

async function fetchText(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "text/html,application/javascript;q=0.9,*/*;q=0.8" },
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error("Apple Music web bundle 요청이 네트워크 오류로 실패했습니다.");
  }
  if (!response.ok) throw new Error(`Apple Music web bundle 요청이 HTTP ${response.status}로 실패했습니다.`);
  return response.text();
}

export async function getAmpWebPlayBearer(options = {}) {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const refreshWindowSeconds = options.refreshWindowSeconds ?? REFRESH_WINDOW_SECONDS;
  const minimumValiditySeconds = options.minimumValiditySeconds ?? 300;
  if (bearerCache?.exp > nowSeconds + refreshWindowSeconds) return bearerCache.token;

  const fetchImpl = options.fetchImpl ?? fetch;
  const pageUrl = options.pageUrl ?? BROWSE_URL;
  const html = await fetchText(fetchImpl, pageUrl);
  try {
    const direct = extractAmpWebPlayBearer(html, nowSeconds + minimumValiditySeconds);
    bearerCache = direct;
    return direct.token;
  } catch {
    // The normal path is an external asset; inline tokens remain supported.
  }

  const bundleUrls = findAppleMusicBundleUrls(html, pageUrl);
  if (!bundleUrls.length) throw new Error("Apple Music web-player JavaScript bundle을 찾지 못했습니다.");
  for (const bundleUrl of bundleUrls) {
    try {
      const bundle = await fetchText(fetchImpl, bundleUrl);
      const found = extractAmpWebPlayBearer(bundle, nowSeconds + minimumValiditySeconds);
      bearerCache = found;
      return found.token;
    } catch {
      // Continue through Apple-owned asset scripts without exposing their contents.
    }
  }
  throw new Error("Apple Music web bundle에서 유효한 AMPWebPlay Bearer를 찾지 못했습니다.");
}

export function clearAmpWebPlayBearerCache() {
  bearerCache = null;
}

function mediaUserToken(cookies) {
  return cookies.find((cookie) => cookie.name === "media-user-token" && cookie.value)?.value ?? null;
}

export async function readAppleWebMediaUserToken(config, options = {}) {
  const interactive = options.interactive === true;
  const timeoutMs = options.timeoutMs ?? 600_000;
  let context;
  let runtime;
  try {
    ({ context, runtime } = await launchConfiguredBrowser(config, "apple-music", {
      headless: !interactive,
      viewport: null,
      locale: "ko-KR",
      args: ["--no-first-run", "--no-default-browser-check"]
    }, options.browserDependencies));
    let token = mediaUserToken(await context.cookies(APPLE_MUSIC_ORIGIN));
    if (token || !interactive) return token;

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(BROWSE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log(`전용 ${runtime.selected}에서 Apple Music에 로그인하세요. Apple ID와 2FA는 프로그램이 읽거나 입력하지 않습니다.`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      token = mediaUserToken(await context.cookies(APPLE_MUSIC_ORIGIN));
      if (token) return token;
    }
    throw new Error("Apple Music 로그인 대기 시간이 초과되었습니다. apple-auth --backend web-player를 다시 실행하세요.");
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes("로그인 대기 시간이")) throw error;
    if (error?.code === "BROWSER_LAUNCH_FAILED") throw error;
    throw new Error(`전용 Apple Music ${runtime?.selected ?? "browser"} profile을 열거나 cookie를 읽을 수 없습니다.`);
  } finally {
    await context?.close().catch(() => {});
  }
}

export async function authorizeAppleWebPlayer(config, options = {}) {
  const token = await readAppleWebMediaUserToken(config, {
    interactive: true,
    timeoutMs: options.timeoutMs ?? (options.timeout ? Number(options.timeout) * 1000 : undefined),
    browserDependencies: options.browserDependencies
  });
  if (!token) throw new Error("media-user-token cookie가 없습니다. 선택한 전용 브라우저에서 Apple Music 로그인을 완료하세요.");
  console.log("Apple Music web-player 로그인을 선택한 전용 브라우저 profile에서 확인했습니다. 토큰 값은 출력하거나 별도 파일에 저장하지 않습니다.");
}

export function createAppleWebAuthProviders(config, options = {}) {
  let currentMediaUserToken = null;
  return {
    getBearerToken({ forceRefresh = false } = {}) {
      if (forceRefresh) clearAmpWebPlayBearerCache();
      return getAmpWebPlayBearer(options);
    },
    async getMediaUserToken({ forceRefresh = false } = {}) {
      if (currentMediaUserToken && !forceRefresh) return currentMediaUserToken;
      const token = await readAppleWebMediaUserToken(config, {
        interactive: false,
        browserDependencies: options.browserDependencies
      });
      if (!token) {
        throw new Error("Apple Music web-player 로그인이 없습니다. apple-auth --backend web-player를 실행하세요.");
      }
      const changed = token !== currentMediaUserToken;
      currentMediaUserToken = token;
      return { token, changed };
    }
  };
}
