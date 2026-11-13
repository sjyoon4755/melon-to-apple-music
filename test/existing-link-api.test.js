import test from "node:test";
import assert from "node:assert/strict";
import { AppleMusicClient } from "../src/apple-api.js";
import { readOnlyAppleAdapter } from "../src/apple-write-adapter.js";

function client(fetchImpl) {
  return new AppleMusicClient({ developerToken: "fixture-developer", musicUserToken: "fixture-user", storefront: "kr",
    fetchImpl, maxGetAttempts: 1, sleepImpl: async () => {} });
}

test("library resource GET preserves the distinction between library and catalog IDs", async () => {
  const calls = [], api = client(async (url, init) => {
    calls.push({ pathname: new URL(url).pathname, method: init.method });
    return Response.json({ data: [{ id: "i.100", type: "library-songs", attributes: { playParams: { id: "i.100", catalogId: "100" } } }] });
  });
  assert.deepEqual(await api.getLibrarySong("i.100"), { id: "i.100", catalog_id: "100" });
  assert.deepEqual(calls, [{ pathname: "/v1/me/library/songs/i.100", method: "GET" }]);
  const facade = readOnlyAppleAdapter(api);
  for (const key of ["request", "createLibraryPlaylist", "addTracks", "fetch"]) assert.equal(facade[key], undefined);
  assert(Object.isFrozen(facade));
});

test("library GET rejects another resource/ID and never guesses a library id is a catalog ID", async () => {
  for (const resource of [
    { id: "i.other", type: "library-songs" }, { id: "i.100", type: "songs" },
    { id: "i.100", type: "library-songs", attributes: { playParams: { id: "i.100" } } }
  ]) {
    const api = client(async () => Response.json({ data: [resource] }));
    const result = await api.getLibrarySong("i.100");
    if (resource.type === "library-songs" && resource.id === "i.100") assert.equal(result.catalog_id, null);
    else assert.equal(result, null);
  }
});

test("complete playlist inspection traverses every page using only GET", async () => {
  const calls = [], api = client(async (url, init) => {
    const u = new URL(url); calls.push(init.method);
    return Response.json({ data: [{ id: `i.${u.searchParams.has("offset") ? "2" : "1"}`, attributes: { playParams: { catalogId: u.searchParams.has("offset") ? "2" : "1" } } }],
      ...(u.searchParams.has("offset") ? {} : { next: "/v1/me/library/playlists/p.1/tracks?offset=100" }) });
  });
  assert.deepEqual(await api.getPlaylistTracks("p.1", { requireComplete: true }), [{ id: "i.1", catalog_id: "1" }, { id: "i.2", catalog_id: "2" }]);
  assert.deepEqual(calls, ["GET", "GET"]);
});

for (const [name, response] of [
  ["missing data", {}], ["pagination cycle", { data: [], next: "/v1/me/library/playlists/p.1/tracks?limit=100" }],
  ["different endpoint", { data: [], next: "/v1/me/library/songs?offset=100" }],
  ["different host", { data: [], next: "https://example.invalid/v1/me/library/playlists/p.1/tracks" }],
  ["invalid next", { data: [], next: 3 }]
]) test(`complete playlist inspection refuses ${name}`, async () => {
  const api = client(async () => Response.json(response));
  await assert.rejects(api.getPlaylistTracks("p.1", { requireComplete: true }));
});

test("a missing later playlist page is a failed complete scan, not a partial success", async () => {
  let count = 0;
  const api = client(async () => ++count === 1
    ? Response.json({ data: [{ id: "i.1", attributes: { playParams: { catalogId: "1" } } }], next: "/v1/me/library/playlists/p.1/tracks?offset=100" })
    : new Response(null, { status: 404 }));
  await assert.rejects(api.getPlaylistTracks("p.1", { requireComplete: true }), /끝까지/);
});
