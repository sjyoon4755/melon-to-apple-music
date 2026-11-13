import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAmpWebPlayBearerCache,
  decodeJwtClaims,
  extractAmpWebPlayBearer,
  findAppleMusicBundleUrls,
  getAmpWebPlayBearer
} from "../src/apple-web-auth.js";

function unsignedToken(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ typ: "JWT", alg: "ES256" })}.${encode(claims)}.signature`;
}

test("extracts only an unexpired AMPWebPlay JWT and reads exp", () => {
  const now = 2_000_000_000;
  const unrelated = unsignedToken({ iss: "someone-else", exp: now + 1000 });
  const expected = unsignedToken({ iss: "AMPWebPlay", exp: now + 2000 });
  const result = extractAmpWebPlayBearer(`${unrelated}\n${expected}`, now);
  assert.equal(result.token, expected);
  assert.equal(result.exp, now + 2000);
  assert.deepEqual(decodeJwtClaims(expected), { iss: "AMPWebPlay", exp: now + 2000 });
});

test("rejects expired AMPWebPlay JWTs without echoing them", () => {
  const token = unsignedToken({ iss: "AMPWebPlay", exp: 10 });
  assert.throws(
    () => extractAmpWebPlayBearer(token, 20),
    (error) => !error.message.includes(token)
  );
});

test("finds Apple-owned asset bundles and caches bearer by JWT exp", async () => {
  clearAmpWebPlayBearerCache();
  const now = 2_000_000_000;
  const token = unsignedToken({ iss: "AMPWebPlay", exp: now + 3600 });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/kr/browse")) {
      return new Response('<script src="https://example.com/ignored.js"></script><script src="/assets/index~abc.js"></script>');
    }
    return new Response(`const publicBearer = ${JSON.stringify(token)};`);
  };
  assert.deepEqual(findAppleMusicBundleUrls('<script src="/assets/index~abc.js"></script>'), [
    "https://music.apple.com/assets/index~abc.js"
  ]);
  assert.equal(await getAmpWebPlayBearer({ fetchImpl, nowSeconds: now, refreshWindowSeconds: 60 }), token);
  assert.equal(await getAmpWebPlayBearer({ fetchImpl, nowSeconds: now + 1, refreshWindowSeconds: 60 }), token);
  assert.deepEqual(calls, [
    "https://music.apple.com/kr/browse",
    "https://music.apple.com/assets/index~abc.js"
  ]);
});

test("refreshes the in-memory bearer cache before JWT expiry", async () => {
  clearAmpWebPlayBearerCache();
  const now = 2_000_000_000;
  const first = unsignedToken({ iss: "AMPWebPlay", exp: now + 1000 });
  const second = unsignedToken({ iss: "AMPWebPlay", exp: now + 5000 });
  let harvest = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/kr/browse")) {
      harvest += 1;
      return new Response('<script src="/assets/index~abc.js"></script>');
    }
    return new Response(harvest === 1 ? first : second);
  };
  assert.equal(await getAmpWebPlayBearer({
    fetchImpl,
    nowSeconds: now,
    refreshWindowSeconds: 100
  }), first);
  assert.equal(await getAmpWebPlayBearer({
    fetchImpl,
    nowSeconds: now + 950,
    refreshWindowSeconds: 100,
    minimumValiditySeconds: 10
  }), second);
  assert.equal(harvest, 2);
});
