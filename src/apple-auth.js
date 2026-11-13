import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getDeveloperToken } from "./apple-api.js";

function htmlPage(developerToken, nonce) {
  const tokenJson = JSON.stringify(developerToken).replaceAll("<", "\\u003c");
  const nonceJson = JSON.stringify(nonce);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Apple Music 인증</title>
<style>body{font:16px system-ui;max-width:680px;margin:64px auto;padding:0 24px;line-height:1.55}button{font:inherit;padding:12px 18px}#status{white-space:pre-wrap}</style>
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js"></script></head>
<body><h1>Apple Music 접근 허용</h1>
<p>이 로컬 도구가 새 플레이리스트를 만들고 곡을 추가할 수 있도록 Apple Music 로그인을 진행합니다. Favorite 상태와 기존 플레이리스트는 변경하지 않습니다.</p>
<button id="authorize">Apple Music 로그인 및 허용</button><p id="status"></p>
<script>
const status = document.querySelector('#status');
document.querySelector('#authorize').addEventListener('click', async () => {
  try {
    status.textContent = 'MusicKit을 준비하는 중…';
    await MusicKit.configure({ developerToken: ${tokenJson}, app: { name: 'Melon Likes Import', build: '0.1.0' } });
    const music = MusicKit.getInstance();
    const userToken = await music.authorize();
    status.textContent = '토큰을 로컬 프로그램에 저장하는 중…';
    const response = await fetch('/token?nonce=' + encodeURIComponent(${nonceJson}), {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({token: userToken})
    });
    if (!response.ok) throw new Error(await response.text());
    status.textContent = '완료되었습니다. 이 탭을 닫아도 됩니다.';
  } catch (error) { status.textContent = '인증 실패: ' + (error?.message ?? error); }
});
</script></body></html>`;
}

async function readSmallJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 32_768) throw new Error("요청이 너무 큽니다.");
  }
  return JSON.parse(body);
}

export async function authorizeAppleMusic(config, options = {}) {
  const developerToken = await getDeveloperToken();
  const nonce = randomBytes(24).toString("base64url");
  const port = options.port ?? 43117;
  let resolveToken;
  let rejectToken;
  const tokenReceived = new Promise((resolve, reject) => { resolveToken = resolve; rejectToken = reject; });

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(htmlPage(developerToken, nonce));
        return;
      }
      if (request.method === "POST" && url.pathname === "/token" && url.searchParams.get("nonce") === nonce) {
        const { token } = await readSmallJson(request);
        if (typeof token !== "string" || token.length < 40) throw new Error("Music User Token 형식이 올바르지 않습니다.");
        await mkdir(path.dirname(config.files.musicUserToken), { recursive: true });
        await writeFile(config.files.musicUserToken, `${token.trim()}\n`, { encoding: "utf8", mode: 0o600 });
        response.writeHead(204);
        response.end();
        resolveToken(token);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(String(error?.message ?? error));
      rejectToken(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`브라우저에서 다음 주소를 여세요: http://127.0.0.1:${port}/`);
  console.log("로그인과 접근 허용은 사용자가 직접 수행합니다. 토큰 값은 화면이나 로그에 출력하지 않습니다.");
  try {
    await tokenReceived;
    console.log(`Music User Token을 ${config.files.musicUserToken}에 저장했습니다.`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
