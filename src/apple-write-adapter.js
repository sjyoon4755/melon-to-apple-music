import { readFile } from "node:fs/promises";
import { AppleMusicClient, getDeveloperToken } from "./apple-api.js";
import { AppleWebPlayerClient } from "./apple-web-api.js";
import { createAppleWebAuthProviders } from "./apple-web-auth.js";

export function resolveWriteBackend(value = "official") {
  const backend = String(value).trim().toLowerCase();
  if (backend !== "official" && backend !== "web-player") {
    throw new Error("--backend는 official 또는 web-player여야 합니다.");
  }
  return backend;
}

async function loadOfficialMusicUserToken(config) {
  if (process.env.APPLE_MUSIC_USER_TOKEN?.trim()) return process.env.APPLE_MUSIC_USER_TOKEN.trim();
  try {
    const token = (await readFile(config.files.musicUserToken, "utf8")).trim();
    if (!token) throw new Error("empty");
    return token;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.message === "empty") {
      throw new Error("Music User Token이 없습니다. apple-auth --backend official을 먼저 실행하세요.");
    }
    throw error;
  }
}

export async function createAppleMusicWriteAdapter(config, options = {}) {
  const backend = resolveWriteBackend(options.backend);
  if (backend === "official") {
    const [developerToken, musicUserToken] = await Promise.all([
      options.developerToken ?? getDeveloperToken(),
      options.musicUserToken ?? loadOfficialMusicUserToken(config)
    ]);
    return new AppleMusicClient({
      developerToken,
      musicUserToken,
      storefront: config.storefront,
      fetchImpl: options.fetchImpl
    });
  }

  const providers = options.webAuthProviders ?? createAppleWebAuthProviders(config, options);
  return new AppleWebPlayerClient({
    bearerTokenProvider: providers.getBearerToken,
    mediaUserTokenProvider: providers.getMediaUserToken,
    storefront: config.storefront,
    fetchImpl: options.fetchImpl
  });
}

// Expose only read operations to commands which must never mutate an account.
export function readOnlyAppleAdapter(adapter) {
  return Object.freeze(Object.fromEntries(["backend", "validateSession", "getStorefront", "getLibraryPlaylist",
    "getPlaylistTracks", "getLibrarySong", "validateCatalogSongs"].map(key =>
    [key, typeof adapter[key] === "function" ? adapter[key].bind(adapter) : adapter[key]])));
}

export async function createAppleMusicReadAdapter(config, options = {}) {
  return readOnlyAppleAdapter(await createAppleMusicWriteAdapter(config, options));
}
