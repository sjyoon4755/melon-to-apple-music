import { randomInt } from "node:crypto";

const RETRYABLE_GET_STATUS = new Set([429, 500, 502, 503, 504]);
const AMBIGUOUS_POST_STATUS = new Set([500, 502, 503, 504]);

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return Math.min(30_000, Number(retryAfter) * 1000);
  }
  return Math.min(15_000, 500 * 2 ** attempt + randomInt(0, 250));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AppleMusicApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AppleMusicApiError";
    this.status = options.status ?? null;
    this.code = options.code ?? "APPLE_MUSIC_API_ERROR";
  }
}

export class AmbiguousAppleMusicWriteError extends AppleMusicApiError {
  constructor(action, options = {}) {
    super(
      `Apple Music ${action} 결과를 안전하게 판정할 수 없습니다. 중복 쓰기를 피하기 위해 중단했습니다.`,
      { ...options, code: "APPLE_MUSIC_WRITE_AMBIGUOUS" }
    );
    this.name = "AmbiguousAppleMusicWriteError";
  }
}

function catalogIdFromTrack(track) {
  const playParams = track?.attributes?.playParams;
  return playParams?.catalogId ?? playParams?.id ?? null;
}

export class AppleMusicWriteAdapter {
  constructor({
    backend,
    baseUrl,
    storefront = "kr",
    fetchImpl = fetch,
    getAuthHeaders,
    refreshAuth = null,
    maxGetAttempts = 3,
    sleepImpl = sleep,
    includeIsPublic = false
  }) {
    this.backend = backend;
    this.baseUrl = new URL(baseUrl);
    this.storefront = storefront.toLowerCase();
    this.fetch = fetchImpl;
    this.getAuthHeaders = getAuthHeaders;
    this.refreshAuth = refreshAuth;
    this.maxGetAttempts = maxGetAttempts;
    this.sleep = sleepImpl;
    this.includeIsPublic = includeIsPublic;
  }

  resolveUrl(pathOrUrl) {
    const url = new URL(pathOrUrl, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new AppleMusicApiError("Apple Music pagination URL의 host가 예상과 다릅니다.");
    }
    return url;
  }

  async request(pathOrUrl, init = {}, options = {}) {
    const method = String(init.method ?? "GET").toUpperCase();
    const isGet = method === "GET";
    const attempts = isGet ? this.maxGetAttempts : 1;
    let authWasRefreshed = false;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const headers = new Headers(await this.getAuthHeaders());
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
      headers.set("Accept", "application/json");
      if (init.body) headers.set("Content-Type", "application/json");

      let response;
      try {
        response = await this.fetch(this.resolveUrl(pathOrUrl), {
          ...init,
          method,
          headers,
          signal: init.signal ?? AbortSignal.timeout(30_000)
        });
      } catch {
        if (isGet && attempt + 1 < attempts) {
          await this.sleep(retryDelay(null, attempt));
          continue;
        }
        if (!isGet) throw new AmbiguousAppleMusicWriteError(`${method} 요청`);
        throw new AppleMusicApiError(`Apple Music ${method} 요청이 네트워크 오류로 실패했습니다.`);
      }

      if (response.ok) {
        if (response.status === 204) return null;
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new AppleMusicApiError(`Apple Music ${method} 응답이 올바른 JSON이 아닙니다.`, {
            status: response.status
          });
        }
      }

      if (response.status === 404 && options.allowNotFound) return null;

      if ((response.status === 401 || response.status === 403) && this.refreshAuth && !authWasRefreshed) {
        let refreshed = false;
        try {
          refreshed = await this.refreshAuth();
        } catch {
          refreshed = false;
        }
        authWasRefreshed = true;
        if (isGet && refreshed && attempt + 1 < attempts) continue;
      }

      if (isGet && RETRYABLE_GET_STATUS.has(response.status) && attempt + 1 < attempts) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      if (!isGet && AMBIGUOUS_POST_STATUS.has(response.status)) {
        throw new AmbiguousAppleMusicWriteError(`${method} 요청`, { status: response.status });
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppleMusicApiError(
          `Apple Music 인증이 만료되었거나 거부되었습니다. ${this.backend === "web-player" ? "apple-auth --backend web-player를 다시 실행하세요." : "공식 Apple Music 인증을 다시 확인하세요."}`,
          { status: response.status, code: "APPLE_MUSIC_AUTH_REQUIRED" }
        );
      }
      throw new AppleMusicApiError(`Apple Music ${method} 요청이 HTTP ${response.status}로 실패했습니다.`, {
        status: response.status
      });
    }
    throw new AppleMusicApiError("Apple Music GET 재시도 횟수를 초과했습니다.");
  }

  async validateSession() {
    return { storefront: await this.getStorefront() };
  }

  async getStorefront() {
    const result = await this.request("/v1/me/storefront");
    const storefront = result?.data?.[0]?.id;
    if (!storefront) throw new AppleMusicApiError("Apple Music 사용자 storefront를 확인할 수 없습니다.");
    return String(storefront).toLowerCase();
  }

  async validateCatalogSongs(songIds) {
    const uniqueIds = [...new Set(songIds.map(String).filter(Boolean))];
    const verified = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const batch = uniqueIds.slice(offset, offset + 100);
      const params = new URLSearchParams({ ids: batch.join(",") });
      const result = await this.request(
        `/v1/catalog/${encodeURIComponent(this.storefront)}/songs?${params}`
      );
      const requested = new Set(batch);
      for (const resource of result?.data ?? []) {
        const id = String(resource?.id ?? "");
        const playParamsId = resource?.attributes?.playParams?.id
          ?? resource?.attributes?.playParams?.catalogId;
        if (requested.has(id) && String(playParamsId ?? "") === id) verified.push(resource);
      }
    }
    return verified;
  }

  async getLibraryPlaylist(playlistId) {
    const result = await this.request(
      `/v1/me/library/playlists/${encodeURIComponent(playlistId)}`,
      {},
      { allowNotFound: true }
    );
    const resource = result?.data?.[0];
    if (!resource?.id) return null;
    return {
      id: String(resource.id),
      name: resource.attributes?.name ?? "",
      canEdit: resource.attributes?.canEdit !== false
    };
  }

  async listLibraryPlaylists() {
    const playlists = [];
    let next = "/v1/me/library/playlists?limit=100";
    while (next) {
      const result = await this.request(next);
      for (const resource of result?.data ?? []) {
        if (!resource?.id) continue;
        playlists.push({
          id: String(resource.id),
          name: resource.attributes?.name ?? "",
          canEdit: resource.attributes?.canEdit !== false
        });
      }
      next = result?.next ?? null;
    }
    return playlists;
  }

  async getLibrarySong(libraryId) {
    const result = await this.request(`/v1/me/library/songs/${encodeURIComponent(libraryId)}`, {}, { allowNotFound: true });
    if (!Array.isArray(result?.data) || result.data.length !== 1) return null;
    const resource = result?.data?.[0];
    if (!resource || resource.type !== "library-songs" || String(resource.id) !== String(libraryId)) return null;
    const catalogId = resource.attributes?.playParams?.catalogId ?? resource.relationships?.catalog?.data?.[0]?.id;
    return { id: String(resource.id), catalog_id: catalogId ? String(catalogId) : null };
  }

  async getPlaylistTracks(playlistId, { requireComplete = false } = {}) {
    const tracks = [];
    let next = `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;
    const seen = new Set();
    while (next) {
      if (requireComplete) {
        const url = this.resolveUrl(next);
        if (seen.has(url.href) || url.pathname !== `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`) {
          throw new AppleMusicApiError("플레이리스트 페이지 순회가 불완전하거나 예상 경로와 다릅니다.");
        }
        seen.add(url.href);
      }
      const result = await this.request(next, {}, { allowNotFound: true });
      if (requireComplete && (!Array.isArray(result?.data) || (result.next != null && typeof result.next !== "string"))) {
        throw new AppleMusicApiError("플레이리스트 페이지를 끝까지 확인할 수 없습니다.");
      }
      if (result == null) return tracks;
      for (const resource of result?.data ?? []) {
        const catalogId = catalogIdFromTrack(resource);
        tracks.push({
          id: resource?.id ? String(resource.id) : null,
          catalog_id: catalogId ? String(catalogId) : null
        });
      }
      next = result?.next ?? null;
    }
    return tracks;
  }

  async createLibraryPlaylist(name, description) {
    const before = await this.listLibraryPlaylists();
    const attributes = { name, description };
    if (this.includeIsPublic) attributes.isPublic = false;
    try {
      const result = await this.request("/v1/me/library/playlists", {
        method: "POST",
        body: JSON.stringify({ attributes })
      });
      const playlist = result?.data?.[0];
      if (!playlist?.id) throw new AmbiguousAppleMusicWriteError("플레이리스트 생성");
      return playlist;
    } catch (error) {
      if (!(error instanceof AmbiguousAppleMusicWriteError)) throw error;
      const beforeIds = new Set(before.map((playlist) => playlist.id));
      let candidates;
      try {
        candidates = (await this.listLibraryPlaylists()).filter((playlist) =>
          !beforeIds.has(playlist.id) && playlist.name === name && playlist.canEdit
        );
      } catch {
        throw new AmbiguousAppleMusicWriteError("플레이리스트 생성");
      }
      if (candidates.length === 1) return candidates[0];
      throw new AmbiguousAppleMusicWriteError("플레이리스트 생성");
    }
  }

  async addTracks(playlistId, songIds) {
    const requested = [...new Set(songIds.map(String).filter(Boolean))];
    if (!requested.length) return { added: 0, reconciled: false };
    const before = new Set((await this.getPlaylistTracks(playlistId))
      .map((track) => track.catalog_id)
      .filter(Boolean));
    const pending = requested.filter((id) => !before.has(id));
    if (!pending.length) return { added: 0, reconciled: true };
    try {
      await this.request(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: "POST",
        body: JSON.stringify({ data: pending.map((id) => ({ id, type: "songs" })) })
      });
      return { added: pending.length, reconciled: false };
    } catch (error) {
      if (!(error instanceof AmbiguousAppleMusicWriteError)) throw error;
      let after;
      try {
        after = new Set((await this.getPlaylistTracks(playlistId))
          .map((track) => track.catalog_id)
          .filter(Boolean));
      } catch {
        throw new AmbiguousAppleMusicWriteError("곡 추가");
      }
      if (pending.every((id) => after.has(id))) {
        return { added: pending.length, reconciled: true };
      }
      throw new AmbiguousAppleMusicWriteError("곡 추가");
    }
  }
}
