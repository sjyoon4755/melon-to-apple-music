import { recoveryCatalog, recoveryDigest, recoveryError } from "./song-recoveries.js";

export async function recoveryInventory(adapter, playlistId, ids, lookupClient) {
  if (adapter.backend !== "web-player" || (await adapter.validateSession()).storefront !== "kr") recoveryError("KR web-player만 지원합니다.");
  if (!(await adapter.getLibraryPlaylist(playlistId))?.canEdit) recoveryError("기존 playlist를 확인할 수 없습니다.");
  const catalog = (await adapter.validateCatalogSongs(ids)).map(recoveryCatalog);
  if (catalog.length !== ids.length) recoveryError("새 후보의 한국 catalog/playParams를 확인할 수 없습니다.");
  const lookup = await lookupClient.lookupSongs(ids, { sourceStorefront: "kr" });
  for (const c of catalog) if (!lookup.some(l => l.id === c.id && l.duration_ms === c.duration_ms)) recoveryError("한국 lookup ID·길이가 다릅니다.");
  async function pages(endpoint) {
    const records = [], seen = new Set(); let next = endpoint + "?limit=100&include=catalog", total = null;
    while (next) {
      const url = adapter.resolveUrl(next); url.searchParams.set("limit", "100");
      if (url.pathname !== endpoint || seen.has(url.href)) recoveryError("원격 페이지 순회가 불완전합니다.");
      seen.add(url.href);
      const page = await adapter.request(url.href, { method: "GET" });
      if (!Array.isArray(page?.data) || (page.next != null && typeof page.next !== "string")) recoveryError("원격 목록이 불완전합니다.");
      if (page.meta?.total != null) {
        if (!Number.isSafeInteger(page.meta.total) || (total != null && total !== page.meta.total)) recoveryError("원격 총수가 달라졌습니다.");
        total = page.meta.total;
      }
      for (const r of page.data) {
        if (!r.id || records.some(p => p.id === r.id)) recoveryError("원격 resource 중복입니다.");
        records.push({ id: String(r.id), catalog_id: r.attributes?.playParams?.catalogId ?? r.relationships?.catalog?.data?.[0]?.id ?? (r.type === "songs" ? String(r.id) : null),
          title: r.attributes?.name ?? null, artist: r.attributes?.artistName ?? null, album: r.attributes?.albumName ?? null,
          duration_ms: r.attributes?.durationInMillis ?? null, isrc: r.attributes?.isrc ?? r.relationships?.catalog?.data?.[0]?.attributes?.isrc ?? null });
      }
      next = page.next ?? null;
    }
    if (total != null && total !== records.length) recoveryError("원격 총수와 수집 수가 다릅니다.");
    return records;
  }
  const playlist = await pages(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`);
  const library = await pages("/v1/me/library/songs");
  const byId = new Map(catalog.map(c => [c.id, c]));
  const missing = [...new Set([...playlist, ...library].map(r => r.catalog_id).filter(Boolean))].filter(id => !byId.has(id));
  for (let offset = 0; offset < missing.length; offset += 100) {
    const page = await adapter.request("/v1/catalog/kr/songs?" + new URLSearchParams({ ids: missing.slice(offset, offset + 100).join(",") }), { method: "GET" });
    if (!Array.isArray(page?.data)) recoveryError("중복 검사 catalog 응답이 불완전합니다.");
    for (const r of page.data) {
      if (!missing.includes(String(r.id))) recoveryError("예상 밖 catalog ID입니다.");
      byId.set(String(r.id), { isrc: r.attributes?.isrc ?? null });
    }
  }
  for (const r of [...playlist, ...library]) r.isrc ??= byId.get(r.catalog_id)?.isrc ?? null;
  return { catalog, playlist, library, unknown_isrc: library.filter(r => !r.isrc), digest: recoveryDigest([catalog, playlist, library]) };
}
