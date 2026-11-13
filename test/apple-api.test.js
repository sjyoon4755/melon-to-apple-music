import test from "node:test";
import assert from "node:assert/strict";
import { AppleMusicClient, ITunesSearchClient } from "../src/apple-api.js";

test("searches an iTunes source storefront and keeps only songs returned by KR lookup", async () => {
  const requests = [];
  const client = new ITunesSearchClient({
    storefront: "kr",
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("/search?")) {
        return Response.json({ resultCount: 3, results: [
          {
            wrapperType: "track", kind: "song", trackId: 42, trackName: "노래",
            artistName: "가수", collectionName: "앨범", trackTimeMillis: 123000,
            trackExplicitness: "explicit", trackViewUrl: "https://music.apple.com/us/album/x/1?i=42"
          },
          {
            wrapperType: "track", kind: "song", trackId: 43, trackName: "미제공",
            artistName: "가수", collectionName: "앨범"
          },
          { wrapperType: "track", kind: "music-video", trackId: 44, trackName: "영상" }
        ] });
      }
      return Response.json({ resultCount: 1, results: [{
        wrapperType: "track", kind: "song", trackId: 42, trackName: "노래",
        artistName: "가수", collectionName: "앨범", trackTimeMillis: 123000,
        trackExplicitness: "explicit", trackViewUrl: "https://music.apple.com/kr/album/x/1?i=42"
      }] });
    }
  });

  const songs = await client.searchSongs("노래 가수", 15, { sourceStorefront: "us" });

  assert.match(requests[0].url, /^https:\/\/itunes\.apple\.com\/search\?/);
  assert.match(requests[0].url, /country=us/);
  assert.match(requests[0].url, /media=music/);
  assert.match(requests[0].url, /entity=song/);
  assert.match(requests[0].url, /explicit=Yes/);
  assert.match(requests[1].url, /^https:\/\/itunes\.apple\.com\/lookup\?/);
  assert.match(requests[1].url, /id=42%2C43/);
  assert.match(requests[1].url, /country=kr/);
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.deepEqual(songs, [{
    id: "42",
    title: "노래",
    artist: "가수",
    album: "앨범",
    duration_ms: 123000,
    isrc: null,
    content_rating: "explicit",
    url: "https://music.apple.com/kr/album/x/1?i=42",
    title_aliases: ["노래"],
    artist_aliases: ["가수"],
    album_aliases: ["앨범"],
    source_storefronts: ["us"]
  }]);
});

test("keeps the official catalog client and request host", async () => {
  let request;
  const client = new AppleMusicClient({
    developerToken: "developer",
    storefront: "kr",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return Response.json({ results: { songs: { data: [{
        id: "42",
        attributes: { name: "노래", artistName: "가수", albumName: "앨범", durationInMillis: 123000, isrc: "KR123" }
      }] } } });
    }
  });
  const songs = await client.searchSongs("노래 가수");
  assert.match(request.url, /^https:\/\/api\.music\.apple\.com\/v1\/catalog\/kr\/search\?/);
  assert.match(request.url, /types=songs/);
  assert.equal(request.init.headers.get("Authorization"), "Bearer developer");
  assert.deepEqual(songs[0], {
    id: "42", title: "노래", artist: "가수", album: "앨범", duration_ms: 123000,
    isrc: "KR123", content_rating: null, url: null
  });
});

test("caches repeated searches and overlapping KR lookups without losing source aliases", async () => {
  const requests = [];
  const client = new ITunesSearchClient({ minIntervalMs: 0, fetchImpl: async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const song = (id, title) => ({ wrapperType: "track", kind: "song", trackId: id,
      trackName: title, artistName: "Artist", collectionName: "Album" });
    if (parsed.pathname === "/search") return Response.json({ results: [
      song(42, parsed.searchParams.get("country") === "jp" ? "日本語" : "English"), song(43, "Unavailable")
    ] });
    return Response.json({ results: parsed.searchParams.get("id").split(",")
      .filter((id) => id !== "43").map((id) => song(Number(id), "한국어")) });
  } });
  const us = await client.searchSongs("Song", 15, { sourceStorefront: "us" });
  assert.deepEqual(await client.searchSongs("Song", 15, { sourceStorefront: "us" }), us);
  const jp = await client.searchSongs("Song", 15, { sourceStorefront: "jp" });
  assert.deepEqual(jp[0].title_aliases, ["한국어", "日本語"]);
  assert.deepEqual(jp[0].source_storefronts, ["jp"]);
  assert.deepEqual(us[0].title_aliases, ["한국어", "English"]);
  assert.deepEqual((await client.lookupSongs([42, 43, 44])).map((song) => song.id), ["42", "44"]);
  assert.deepEqual(requests.filter((url) => url.pathname === "/lookup").map((url) => url.searchParams.get("id")), ["42,43", "44"]);
  assert.deepEqual(client.stats, { requests: 4, retries: 0, search_cache_hits: 1, lookup_cache_hits: 6 });
  client.storefront = "us";
  await client.lookupSongs([42]);
  assert.equal(requests.at(-1).searchParams.get("country"), "us");
  assert.equal(client.minIntervalMs, 0);
  assert.equal(new ITunesSearchClient({}).minIntervalMs, 3100);
});

test("does not cache failed searches and exposes retry progress", async () => {
  let calls = 0;
  const progress = [];
  const client = new ITunesSearchClient({ minIntervalMs: 0, onProgress: (stats) => progress.push(stats),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("invalid", { status: 400 });
      if (calls === 2) return new Response("retry", { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ results: [] });
    } });
  await assert.rejects(client.searchSongs("Song"), /400/);
  assert.deepEqual(await client.searchSongs("Song"), []);
  assert.deepEqual(await client.searchSongs("Song"), []);
  assert.equal(calls, 3);
  assert.equal(client.stats.retries, 1);
  assert.equal(client.stats.search_cache_hits, 1);
  assert.ok(progress.some((stats) => stats.retries === 1 && stats.requests === 2));
});

test("official adapter creates only a private playlist and posts catalog songs", async () => {
  const requests = [];
  let added = false;
  const client = new AppleMusicClient({
    developerToken: "developer",
    musicUserToken: "user",
    fetchImpl: async (url, init) => {
      const request = { url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
      requests.push(request);
      if (new URL(request.url).pathname === "/v1/me/library/playlists" && request.method === "GET") {
        return Response.json({ data: [] });
      }
      if (request.url.endsWith("/v1/me/library/playlists") && request.method === "POST") {
        return Response.json({ data: [{ id: "p.new" }] }, { status: 201 });
      }
      if (request.url.includes("/tracks?") && request.method === "GET") {
        return Response.json({ data: added ? [{ id: "i.1", attributes: { playParams: { catalogId: "1" } } }] : [] });
      }
      if (request.url.endsWith("/tracks") && request.method === "POST") {
        added = true;
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected request");
    }
  });
  await client.createLibraryPlaylist("Import", "Description");
  await client.addTracks("p.new", ["1"]);
  const createRequest = requests.find((request) => request.method === "POST" && request.url.endsWith("/playlists"));
  const addRequest = requests.find((request) => request.method === "POST" && request.url.endsWith("/tracks"));
  assert.deepEqual(createRequest.body.attributes, { name: "Import", description: "Description", isPublic: false });
  assert.deepEqual(addRequest.body, { data: [{ id: "1", type: "songs" }] });
  assert.equal(addRequest.headers.get("Music-User-Token"), "user");
  assert.equal(requests.some((request) => /rating|favorite|\/me\/library\?ids/i.test(request.url)), false);
});

test("official adapter preflights exact catalog ids with matching playParams", async () => {
  const client = new AppleMusicClient({
    developerToken: "developer",
    musicUserToken: "user",
    storefront: "kr",
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://api.music.apple.com/v1/catalog/kr/songs?ids=1%2C2%2C3");
      return Response.json({ data: [
        { id: "1", attributes: { playParams: { id: "1" } } },
        { id: "2", attributes: {} },
        { id: "3", attributes: { playParams: { id: "different" } } }
      ] });
    }
  });
  assert.deepEqual((await client.validateCatalogSongs(["1", "2", "3"])).map((song) => song.id), ["1"]);
});
