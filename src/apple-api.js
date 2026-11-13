import { createPrivateKey, randomInt, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AppleMusicWriteAdapter } from "./apple-write-api.js";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export async function getDeveloperToken() {
  if (process.env.APPLE_MUSIC_DEVELOPER_TOKEN?.trim()) {
    return process.env.APPLE_MUSIC_DEVELOPER_TOKEN.trim();
  }
  const teamId = process.env.APPLE_MUSIC_TEAM_ID?.trim();
  const keyId = process.env.APPLE_MUSIC_KEY_ID?.trim();
  const keyPath = process.env.APPLE_MUSIC_PRIVATE_KEY_PATH?.trim();
  if (!teamId || !keyId || !keyPath) {
    throw new Error(
      "APPLE_MUSIC_DEVELOPER_TOKEN 또는 APPLE_MUSIC_TEAM_ID/APPLE_MUSIC_KEY_ID/APPLE_MUSIC_PRIVATE_KEY_PATH가 필요합니다."
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: now, exp: now + 30 * 24 * 60 * 60 }));
  const signingInput = `${header}.${payload}`;
  const privateKey = createPrivateKey(await readFile(keyPath));
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${base64url(signature)}`;
}

function parseRetryAfter(value, attempt) {
  if (value && /^\d+(?:\.\d+)?$/.test(value)) return Math.min(30_000, Number(value) * 1000);
  return Math.min(15_000, 500 * 2 ** attempt + randomInt(0, 250));
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function mapITunesSong(result, sourceStorefront) {
  if (result?.wrapperType !== "track" || result?.kind !== "song" || result.trackId == null) return null;
  const explicitness = String(result.trackExplicitness ?? "").toLowerCase();
  return {
    id: String(result.trackId),
    title: result.trackName ?? "",
    artist: result.artistName ?? "",
    album: result.collectionName ?? "",
    duration_ms: Number.isFinite(result.trackTimeMillis) ? result.trackTimeMillis : null,
    isrc: null,
    content_rating: explicitness === "explicit"
      ? "explicit"
      : explicitness === "cleaned"
        ? "clean"
        : explicitness === "notexplicit"
          ? "not_explicit"
          : null,
    url: result.trackViewUrl ?? null,
    title_aliases: uniqueValues([result.trackName]),
    artist_aliases: uniqueValues([result.artistName]),
    album_aliases: uniqueValues([result.collectionName]),
    source_storefronts: sourceStorefront ? [sourceStorefront] : []
  };
}

export class ITunesSearchClient {
  constructor({ storefront = "kr", fetchImpl = fetch, minIntervalMs = 3_100, onProgress = null }) {
    this.storefront = storefront.toLowerCase();
    this.fetch = fetchImpl;
    this.minIntervalMs = minIntervalMs;
    this.nextRequestAt = 0;
    this.searchCache = new Map();
    this.lookupCache = new Map();
    this.stats = { requests: 0, retries: 0, search_cache_hits: 0, lookup_cache_hits: 0 };
    this.onProgress = onProgress;
  }

  async waitForRateLimit() {
    const delay = this.nextRequestAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    this.nextRequestAt = Date.now() + this.minIntervalMs;
  }

  async request(path, maxAttempts = 5) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.waitForRateLimit();
      this.stats.requests += 1;
      await this.onProgress?.({ ...this.stats });
      let response;
      try {
        response = await this.fetch(new URL(path, "https://itunes.apple.com"), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(30_000)
        });
      } catch (error) {
        if (attempt + 1 >= maxAttempts) throw error;
        this.stats.retries += 1;
        await this.onProgress?.({ ...this.stats });
        await new Promise((resolve) => setTimeout(resolve, parseRetryAfter(null, attempt)));
        continue;
      }
      if (response.ok) return response.json();
      const retryable = [403, 429, 500, 502, 503, 504].includes(response.status);
      if (retryable && attempt + 1 < maxAttempts) {
        this.stats.retries += 1;
        await this.onProgress?.({ ...this.stats });
        await new Promise((resolve) => setTimeout(resolve, parseRetryAfter(response.headers.get("retry-after"), attempt)));
        continue;
      }
      const body = await response.text();
      throw new Error(`iTunes Search API ${response.status}: ${body.slice(0, 500)}`);
    }
    throw new Error("iTunes Search API 재시도 횟수를 초과했습니다.");
  }

  async searchSongs(term, limit = 15, options = {}) {
    const sourceStorefront = (options.sourceStorefront ?? "us").toLowerCase();
    const params = new URLSearchParams({
      term,
      country: sourceStorefront,
      media: "music",
      entity: "song",
      limit: String(limit),
      explicit: "Yes"
    });
    const cacheKey = params.toString();
    let searchResult = this.searchCache.get(cacheKey);
    if (searchResult) this.stats.search_cache_hits += 1;
    else {
      searchResult = await this.request(`/search?${params}`);
      this.searchCache.set(cacheKey, searchResult);
    }
    const searched = (searchResult?.results ?? [])
      .map((result) => mapITunesSong(result, sourceStorefront))
      .filter(Boolean);
    if (!searched.length) return [];

    const verifiedById = new Map((await this.lookupSongs(
      searched.map((song) => song.id),
      { sourceStorefront }
    )).map((song) => [song.id, song]));
    return searched.flatMap((song) => {
      const verified = verifiedById.get(song.id);
      return verified ? [{
        ...verified,
        title_aliases: uniqueValues([...verified.title_aliases, ...song.title_aliases]),
        artist_aliases: uniqueValues([...verified.artist_aliases, ...song.artist_aliases]),
        album_aliases: uniqueValues([...verified.album_aliases, ...song.album_aliases])
      }] : [];
    });
  }

  async lookupSongs(ids, options = {}) {
    const uniqueIds = [...new Set(ids.map(String).map((id) => id.trim()).filter(Boolean))];
    if (!uniqueIds.length) return [];
    const sourceStorefront = (options.sourceStorefront ?? this.storefront).toLowerCase();
    const cacheKey = (id) => `${this.storefront}:${id}`;
    const missing = uniqueIds.filter((id) => !this.lookupCache.has(cacheKey(id)));
    this.stats.lookup_cache_hits += uniqueIds.length - missing.length;
    if (missing.length) {
      const lookupParams = new URLSearchParams({ id: missing.join(","), country: this.storefront, entity: "song" });
      const lookupResult = await this.request(`/lookup?${lookupParams}`);
      const byId = new Map((lookupResult?.results ?? [])
        .filter((result) => result.wrapperType === "track" && result.kind === "song" && result.trackId != null)
        .map((result) => [String(result.trackId), result]));
      for (const id of missing) this.lookupCache.set(cacheKey(id), byId.get(id) ?? null);
    }
    return uniqueIds.map((id) => this.lookupCache.get(cacheKey(id)))
      .map((result) => mapITunesSong(result, sourceStorefront))
      .filter(Boolean)
      .filter((song) => uniqueIds.includes(song.id));
  }
}

export class AppleMusicClient extends AppleMusicWriteAdapter {
  constructor({ developerToken, musicUserToken = null, storefront = "kr", fetchImpl = fetch, ...options }) {
    super({
      backend: "official",
      baseUrl: "https://api.music.apple.com",
      storefront,
      fetchImpl,
      includeIsPublic: true,
      getAuthHeaders: () => {
        const headers = { Authorization: `Bearer ${developerToken}` };
        if (musicUserToken) headers["Music-User-Token"] = musicUserToken;
        return headers;
      },
      ...options
    });
    this.developerToken = developerToken;
    this.musicUserToken = musicUserToken;
  }

  async searchSongs(term, limit = 15) {
    const params = new URLSearchParams({ term, types: "songs", limit: String(limit), l: "ko-KR" });
    const result = await this.request(`/v1/catalog/${encodeURIComponent(this.storefront)}/search?${params}`);
    return (result?.results?.songs?.data ?? []).map((resource) => {
      const attributes = resource.attributes ?? {};
      return {
        id: resource.id,
        title: attributes.name ?? "",
        artist: attributes.artistName ?? "",
        album: attributes.albumName ?? "",
        duration_ms: attributes.durationInMillis ?? null,
        isrc: attributes.isrc ?? null,
        content_rating: attributes.contentRating ?? null,
        url: attributes.url ?? null
      };
    });
  }
}
