import { AppleMusicWriteAdapter } from "./apple-write-api.js";

export class AppleWebPlayerClient extends AppleMusicWriteAdapter {
  constructor({
    bearerTokenProvider,
    mediaUserTokenProvider,
    storefront = "kr",
    fetchImpl = fetch,
    ...options
  }) {
    let currentMediaUserToken = null;
    const readMediaToken = async (providerOptions = {}) => {
      const result = await mediaUserTokenProvider(providerOptions);
      const token = typeof result === "string" ? result : result?.token;
      if (!token) throw new Error("Apple Music web-player media-user-token을 확인할 수 없습니다.");
      const changed = token !== currentMediaUserToken;
      currentMediaUserToken = token;
      return { token, changed };
    };
    super({
      backend: "web-player",
      baseUrl: "https://amp-api.music.apple.com",
      storefront,
      fetchImpl,
      getAuthHeaders: async () => {
        const [bearerToken, media] = await Promise.all([
          bearerTokenProvider(),
          readMediaToken()
        ]);
        return {
          Authorization: `Bearer ${bearerToken}`,
          "Music-User-Token": media.token,
          Origin: "https://music.apple.com"
        };
      },
      refreshAuth: async () => {
        const [bearerToken, media] = await Promise.all([
          bearerTokenProvider({ forceRefresh: true }),
          readMediaToken({ forceRefresh: true })
        ]);
        return Boolean(bearerToken) || media.changed;
      },
      ...options
    });
  }
}
