import test from "node:test";
import assert from "node:assert/strict";
import { AppleWebPlayerClient } from "../src/apple-web-api.js";
import { AmbiguousAppleMusicWriteError } from "../src/apple-write-api.js";

function webClient(fetchImpl, options = {}) {
  let media = "media-value";
  return new AppleWebPlayerClient({
    bearerTokenProvider: async () => "bearer-value",
    mediaUserTokenProvider: async ({ forceRefresh = false } = {}) => {
      if (forceRefresh) media = "media-refreshed";
      return media;
    },
    storefront: "kr",
    fetchImpl,
    sleepImpl: async () => {},
    ...options
  });
}

test("web-player adapter uses amp-api headers, catalog preflight, and catalog song writes", async () => {
  const requests = [];
  let tracks = [];
  const client = webClient(async (url, init) => {
    const request = {
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null
    };
    requests.push(request);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/me/storefront") return Response.json({ data: [{ id: "kr" }] });
    if (pathname === "/v1/catalog/kr/songs") {
      return Response.json({ data: [
        { id: "1", attributes: { playParams: { id: "1" } } },
        { id: "2", attributes: {} }
      ] });
    }
    if (pathname === "/v1/me/library/playlists" && request.method === "GET") return Response.json({ data: [] });
    if (pathname === "/v1/me/library/playlists" && request.method === "POST") {
      return Response.json({ data: [{ id: "p.new" }] }, { status: 201 });
    }
    if (pathname.endsWith("/tracks") && request.method === "GET") {
      return Response.json({ data: tracks.map((id) => ({
        id: `i.${id}`,
        attributes: { playParams: { catalogId: id } }
      })) });
    }
    if (pathname.endsWith("/tracks") && request.method === "POST") {
      tracks.push(...request.body.data.map((item) => item.id));
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected request");
  });

  assert.deepEqual(await client.validateSession(), { storefront: "kr" });
  assert.deepEqual((await client.validateCatalogSongs(["1", "2"])).map((song) => song.id), ["1"]);
  await client.createLibraryPlaylist("Import", "Description");
  await client.addTracks("p.new", ["1"]);

  assert.equal(requests.every((request) => request.url.startsWith("https://amp-api.music.apple.com/v1/")), true);
  for (const request of requests) {
    assert.equal(request.headers.get("Authorization"), "Bearer bearer-value");
    assert.equal(request.headers.get("Music-User-Token"), "media-value");
    assert.equal(request.headers.get("Media-User-Token"), null);
    assert.equal(request.headers.get("Origin"), "https://music.apple.com");
  }
  const catalogRequest = requests.find((request) => request.url.includes("/catalog/kr/songs?"));
  assert.match(catalogRequest.url, /ids=1%2C2/);
  const createRequest = requests.find((request) => request.method === "POST" && request.url.endsWith("/playlists"));
  assert.deepEqual(createRequest.body, { attributes: { name: "Import", description: "Description" } });
  const addRequest = requests.find((request) => request.method === "POST" && request.url.endsWith("/tracks"));
  assert.deepEqual(addRequest.body, { data: [{ id: "1", type: "songs" }] });
  assert.equal(requests.some((request) => /favorite|rating|\/me\/library\?ids/i.test(request.url)), false);
});

test("web-player GET rechecks the dedicated-profile token once on 401", async () => {
  const headers = [];
  const client = webClient(async (_url, init) => {
    headers.push(init.headers.get("Music-User-Token"));
    if (headers.length === 1) return new Response(null, { status: 401 });
    return Response.json({ data: [{ id: "kr" }] });
  });
  assert.equal(await client.getStorefront(), "kr");
  assert.deepEqual(headers, ["media-value", "media-refreshed"]);
});

test("web-player GET refreshes the public bearer once on 401", async () => {
  let bearer = "bearer-old";
  const headers = [];
  const client = new AppleWebPlayerClient({
    bearerTokenProvider: async ({ forceRefresh = false } = {}) => {
      if (forceRefresh) bearer = "bearer-new";
      return bearer;
    },
    mediaUserTokenProvider: async () => "media-unchanged",
    storefront: "kr",
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      headers.push(init.headers.get("Authorization"));
      if (headers.length === 1) return new Response(null, { status: 401 });
      return Response.json({ data: [{ id: "kr" }] });
    }
  });
  assert.equal(await client.getStorefront(), "kr");
  assert.deepEqual(headers, ["Bearer bearer-old", "Bearer bearer-new"]);
});

test("API failures redact bearer, media token, and response body", async () => {
  const client = webClient(async () => new Response(
    "bearer-value media-value should never be surfaced",
    { status: 400 }
  ));
  await assert.rejects(client.getStorefront(), (error) => {
    assert.equal(error.message.includes("bearer-value"), false);
    assert.equal(error.message.includes("media-value"), false);
    assert.equal(error.message.includes("should never be surfaced"), false);
    return true;
  });
});

test("ambiguous playlist POST is reconciled without retrying the mutation", async () => {
  let listCalls = 0;
  let postCalls = 0;
  const client = webClient(async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/v1/me/library/playlists" && init.method === "GET") {
      listCalls += 1;
      return Response.json({ data: listCalls === 1 ? [] : [{
        id: "p.recovered",
        attributes: { name: "Import", canEdit: true }
      }] });
    }
    if (pathname === "/v1/me/library/playlists" && init.method === "POST") {
      postCalls += 1;
      throw new Error("connection lost after send");
    }
    throw new Error("unexpected request");
  });
  assert.equal((await client.createLibraryPlaylist("Import", "Description")).id, "p.recovered");
  assert.equal(postCalls, 1);
});

test("ambiguous playlist POST never reuses a pre-existing playlist by name", async () => {
  let postCalls = 0;
  const client = webClient(async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/v1/me/library/playlists" && init.method === "GET") {
      return Response.json({ data: [{
        id: "p.existing",
        attributes: { name: "Import", canEdit: true }
      }] });
    }
    if (pathname === "/v1/me/library/playlists" && init.method === "POST") {
      postCalls += 1;
      throw new Error("connection lost after send");
    }
    throw new Error("unexpected request");
  });
  await assert.rejects(
    client.createLibraryPlaylist("Import", "Description"),
    AmbiguousAppleMusicWriteError
  );
  assert.equal(postCalls, 1);
});

test("ambiguous track POST is confirmed from playlist contents and never resent", async () => {
  let postCalls = 0;
  let reflected = false;
  const client = webClient(async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/tracks") && init.method === "GET") {
      return Response.json({ data: reflected ? [{
        id: "i.1",
        attributes: { playParams: { catalogId: "1" } }
      }] : [] });
    }
    if (pathname.endsWith("/tracks") && init.method === "POST") {
      postCalls += 1;
      reflected = true;
      return new Response(null, { status: 503 });
    }
    throw new Error("unexpected request");
  });
  assert.deepEqual(await client.addTracks("p.new", ["1"]), { added: 1, reconciled: true });
  assert.equal(postCalls, 1);
});

test("unresolved ambiguous track POST fails closed without retry", async () => {
  let postCalls = 0;
  const client = webClient(async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/tracks") && init.method === "GET") return Response.json({ data: [] });
    if (pathname.endsWith("/tracks") && init.method === "POST") {
      postCalls += 1;
      return new Response(null, { status: 500 });
    }
    throw new Error("unexpected request");
  });
  await assert.rejects(client.addTracks("p.new", ["1"]), AmbiguousAppleMusicWriteError);
  assert.equal(postCalls, 1);
});
