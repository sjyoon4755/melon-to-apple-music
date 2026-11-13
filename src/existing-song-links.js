import { createHash } from "node:crypto";
import { readJson } from "./io.js";
import { sourceFingerprint } from "./run-state.js";
import { scoreCandidate } from "./matcher.js";
import { verifiedRecoveryPreservedIds } from "./song-recoveries.js";
import { metadataWithEvidence, validateUnavailableEvidence } from "./unavailable-evidence.js";

export const linkDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sourceDigest = (song) => linkDigest([sourceFingerprint([song]), song.artists ?? [], song.release_date ?? null]);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^\d+$/;
const id = value => typeof value === "string" && ID.test(value);
const UNRESOLVED = new Set(["ambiguous", "not_found"]);
const SELECTED = new Set(["matched", "manual_confirmed"]);
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 2000) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const validCatalog = value => plain(value) && id(value.id) && [value.title, value.artist, value.album].every(v => text(v, 1000))
  && (value.duration_ms === null || (Number.isFinite(value.duration_ms) && value.duration_ms > 0))
  && (value.isrc === null || text(value.isrc, 40)) && [null, "explicit", "not_explicit"].includes(value.content_rating)
  && (value.release_date === null || text(value.release_date, 40)) && (value.url === null || text(value.url, 2000));
export class ExistingLinkError extends Error {
  constructor(message) { super(message); this.name = "ExistingLinkError"; }
}
export function linkError(message) { throw new ExistingLinkError(message); }

export function catalogMetadata(resource) {
  const a = resource?.attributes;
  if (!a || resource.type !== "songs" || !ID.test(String(resource.id))
    || String(a.playParams?.id ?? a.playParams?.catalogId ?? "") !== String(resource.id)) {
    linkError("한국 catalog/playParams의 정확한 song ID를 확인할 수 없습니다.");
  }
  const result = { id: String(resource.id), title: a.name, artist: a.artistName, album: a.albumName,
    duration_ms: a.durationInMillis ?? null, isrc: a.isrc ?? null, content_rating: normalizedRating(a.contentRating),
    release_date: a.releaseDate ?? null, url: a.url ?? null };
  if (!validCatalog(result)) linkError("대상 catalog 곡의 필수 메타데이터 형식이 잘못되었습니다.");
  return result;
}

function normalizedRating(value) {
  return ["notExplicit", "clean"].includes(value) ? "not_explicit" : value ?? null;
}

export function identityUncertainties(source, target) {
  const result = [];
  if (!source.isrc) result.push("source_isrc_unknown");
  if (!Number.isFinite(source.duration_ms)) result.push("source_duration_unknown");
  if (!source.content_rating) result.push("source_rating_unknown");
  if (source.album !== target.album) result.push("album_differs");
  if (source.release_date && source.release_date !== target.release_date) result.push("release_date_differs");
  if (!target.isrc) result.push("target_isrc_unknown");
  if (!Number.isFinite(target.duration_ms)) result.push("target_duration_unknown");
  if (!target.content_rating) result.push("target_rating_unknown");
  if (Number.isFinite(source.duration_ms) && Number.isFinite(target.duration_ms)
    && Math.abs(source.duration_ms - target.duration_ms) > 2000) result.push("duration_differs");
  return result;
}

export function validateLinkEvidence(evidence, ids) {
  const allowed = ["schema_version", "melon_song_id", "anchor_melon_song_id", "apple_music_song_id",
    "identity_basis", "comparison", "references", "accepted_uncertainties", "unavailable_origin"];
  if (!plain(evidence) || Object.keys(evidence).some((k) => !allowed.includes(k)) || evidence.schema_version !== 1
    || !["recording_evidence", "user_accepted_uncertainty", "user_accepted_confirmed_anchor"].includes(evidence.identity_basis)
    || !text(evidence.comparison) || !Array.isArray(evidence.references) || evidence.references.length < 1 || evidence.references.length > 20
    || evidence.references.some((ref) => !text(ref, 1000)) || !Array.isArray(evidence.accepted_uncertainties)
    || evidence.accepted_uncertainties.some((item) => !text(item, 100))
    || new Set(evidence.accepted_uncertainties).size !== evidence.accepted_uncertainties.length
    || Object.entries(ids).some(([key, value]) => evidence[key] !== value)) {
    linkError("연결 근거 JSON의 schema, 정확한 세 ID, 비교·자료 참조·불확실성 수락 항목을 확인하세요.");
  }
  return evidence;
}

function sameUnavailableArtists(artists, publicArtists) {
  return Array.isArray(artists) && artists.length === publicArtists.length && publicArtists.every(({ id, name }, index) => {
    const artist = artists[index];
    return typeof artist === "string" ? artist === name : artist?.name === name && artist?.id === id;
  });
}

const asciiTitleKey = title => title.replace(/[A-Z]/g, letter => letter.toLowerCase());

export function unavailableLinkSource(source, evidence) {
  const origin = evidence.unavailable_origin;
  if (!plain(origin) || Object.keys(origin).length !== 3 || evidence.identity_basis !== "user_accepted_confirmed_anchor"
    || !Array.isArray(origin.artists) || !origin.artists.length || origin.artists.length > 30
    || origin.artists.some(artist => !plain(artist) || Object.keys(artist).length !== 2 || !id(artist.id) || !text(artist.name, 1000))
    || new Set(origin.artists.map(artist => artist.id)).size !== origin.artists.length
    || !/^\d{4}-\d{2}-\d{2}$/.test(origin.release_date ?? "") || !stamp(origin.release_date)) {
    linkError("비활성 연결에는 공개 원곡 근거와 수동 승인 기준 원곡이 필요합니다.");
  }
  validateUnavailableEvidence(origin.document, source, evidence.apple_music_song_id);
  const reviewed = metadataWithEvidence(source, origin);
  const metadata = origin.document.public_metadata;
  if (["title", "artist", "album", "isrc", "duration_ms", "content_rating"].some(key =>
    metadata[key] != null && reviewed[key] !== metadata[key])
    || (source.artists?.length && !sameUnavailableArtists(source.artists, origin.artists))
    || (source.release_date && source.release_date !== origin.release_date)) linkError("비활성 원곡과 공개 근거가 충돌합니다.");
  return { ...reviewed, artists: origin.artists.map(artist => artist.name), release_date: origin.release_date, source_availability: "unavailable" };
}

export const unavailableLinkBase = source => ({ melon_song_id: source.melon_song_id, match_status: "unavailable", source });

export function checkRecordingIdentity(source, target, evidence, confirmedAnchor) {
  // Missing source rating is uncertainty, not a known clean/explicit conflict.
  const sourceRating = normalizedRating(source.content_rating);
  const targetRating = normalizedRating(target.content_rating);
  if (sourceRating && targetRating && sourceRating !== targetRating) linkError("원곡과 대상의 등급이 다릅니다. 별도 발매본 검토가 필요합니다.");
  const comparison = scoreCandidate({ ...source, content_rating: sourceRating ?? targetRating }, { ...target, content_rating: targetRating });
  const usesAnchor = evidence.identity_basis === "user_accepted_confirmed_anchor";
  if (usesAnchor) {
    const anchor = confirmedAnchor?.source, selection = confirmedAnchor?.selection;
    const sameArtists = evidence.unavailable_origin ? sameUnavailableArtists(anchor?.artists, evidence.unavailable_origin.artists)
      : linkDigest(source.artists ?? []) === linkDigest(anchor?.artists ?? []);
    const sameTitle = source.title === anchor?.title || (evidence.unavailable_origin && text(source.title) && text(anchor?.title)
      && asciiTitleKey(source.title) === asciiTitleKey(anchor.title));
    if (!anchor || selection?.match_status !== "manual_confirmed"
      || String(source.melon_song_id) !== evidence.melon_song_id
      || String(anchor.melon_song_id) !== evidence.anchor_melon_song_id
      || String(selection.melon_song_id) !== evidence.anchor_melon_song_id
      || String(selection.apple_music_song_id) !== evidence.apple_music_song_id
      || String(target.id) !== evidence.apple_music_song_id
      || source.melon_song_id === anchor.melon_song_id
      || !text(source.title) || !text(source.artist) || !sameTitle || source.artist !== anchor.artist
      || !sameArtists) {
      linkError("수동 승인 기준 원곡과 정확히 같은 원본 제목·가수·참여 가수 및 승인된 대상 ID가 필요합니다.");
    }
    if (source.isrc && anchor.isrc && source.isrc.toUpperCase() !== anchor.isrc.toUpperCase()) linkError("원곡과 기준 원곡의 ISRC가 다릅니다.");
    const anchorRating = normalizedRating(anchor.content_rating);
    if (sourceRating && anchorRating && sourceRating !== anchorRating) linkError("원곡과 기준 원곡의 등급이 다릅니다.");
    if (anchor.isrc && target.isrc && anchor.isrc.toUpperCase() !== target.isrc.toUpperCase()) linkError("기준 원곡과 대상의 ISRC가 다릅니다.");
    if (anchorRating && targetRating && anchorRating !== targetRating) linkError("기준 원곡과 대상의 등급이 다릅니다.");
    if (Number.isFinite(anchor.duration_ms) && Number.isFinite(target.duration_ms) && Math.abs(anchor.duration_ms - target.duration_ms) >= 15000) {
      linkError("기준 원곡과 대상의 재생시간 차이가 큽니다.");
    }
    if (Number.isFinite(source.duration_ms) && Number.isFinite(anchor.duration_ms) && Math.abs(source.duration_ms - anchor.duration_ms) >= 15000) {
      linkError("원곡과 기준 원곡의 재생시간 차이가 큽니다.");
    }
  } else if (comparison.components.title < 0.95 || comparison.components.artist < 0.95 || comparison.components.identity_reasons.length) {
    linkError("가수·참여 가수·제목·버전이 일치하지 않습니다. 제목만으로 기존 곡에 연결하지 않습니다.");
  }
  if (source.isrc && target.isrc && source.isrc.toUpperCase() !== target.isrc.toUpperCase()) linkError("원곡과 대상의 ISRC가 다릅니다.");
  if (Number.isFinite(source.duration_ms) && Number.isFinite(target.duration_ms) && Math.abs(source.duration_ms - target.duration_ms) >= 15000) {
    linkError("원곡과 대상의 재생시간 차이가 큽니다. 별도 녹음 검토가 필요합니다.");
  }
  const uncertainties = identityUncertainties(source, target);
  // A manual anchor establishes an accepted mapping, not proof of the same recording.
  if (usesAnchor) uncertainties.push("confirmed_anchor_recording_unverified");
  if (evidence.identity_basis === "recording_evidence") {
    if (!source.isrc || !target.isrc || !comparison.components.isrc_exact) linkError("recording_evidence에는 현재 원곡과 대상의 일치하는 ISRC가 필요합니다. 제목·점수는 녹음 증명이 아닙니다.");
  }
  if (uncertainties.some((value) => !evidence.accepted_uncertainties.includes(value))) {
    linkError(`명시적으로 수락되지 않은 불확실성: ${uncertainties.filter((value) => !evidence.accepted_uncertainties.includes(value)).join(", ")}`);
  }
  return uncertainties;
}

export async function readExistingLinks(config) {
  const document = await readJson(config.files.existingSongLinks, { schema_version: 1, events: [] });
  if (!plain(document) || document.schema_version !== 1 || !Array.isArray(document.events)) linkError("existing_song_links.json 형식이 잘못되었습니다. 기존 이력을 보존하세요.");
  const revisions = new Set(), latest = new Map();
  for (const event of document.events) {
    const prior = latest.get(event?.melon_song_id);
    if (!plain(event) || !["link", "unlink"].includes(event.action) || !id(event.melon_song_id)
      || !text(event.revision_id, 100) || revisions.has(event.revision_id) || !text(event.reason, 500)
      || !stamp(event.confirmed_at) || !HASH.test(event.approved_preview_hash ?? "")
      || event.previous_revision !== (prior?.revision_id ?? null)) linkError("기존 곡 연결 이력의 revision/schema가 손상됐습니다. 자동 판정으로 돌아가지 않습니다.");
    if (event.action === "link") {
      if (!id(event.anchor_melon_song_id) || event.anchor_melon_song_id === event.melon_song_id || !id(event.apple_music_song_id)
        || ![event.source_fingerprint, event.anchor_fingerprint, event.anchor_selection_fingerprint, event.base_record_fingerprint].every(v => HASH.test(v ?? ""))
        || event.before?.melon_song_id !== event.melon_song_id
        || (event.evidence?.unavailable_origin ? event.before.match_status !== "unavailable" : !UNRESOLVED.has(event.before.match_status))
        || event.base_record_fingerprint !== linkDigest(event.before)
        || !plain(event.target) || event.target.id !== event.apple_music_song_id || event.target.storefront !== "kr"
        || !["official", "web-player"].includes(event.target.backend) || !text(event.target.playlist_id, 200)
        || !validCatalog(event.target.catalog) || event.target.catalog.id !== event.apple_music_song_id
        || !plain(event.remote_evidence) || !stamp(event.remote_evidence.checked_at)
        || event.remote_evidence.playlist_occurrences !== 1 || event.remote_evidence.library_catalog_id !== event.apple_music_song_id
        || !text(event.remote_evidence.library_song_id, 200) || !HASH.test(event.evidence_hash ?? "")
        || event.evidence_hash !== linkDigest(event.evidence) || (prior && prior.action !== "unlink")) linkError("기존 곡 연결 승인 자료가 손상되거나 충돌했습니다.");
      validateLinkEvidence(event.evidence, { melon_song_id: event.melon_song_id, anchor_melon_song_id: event.anchor_melon_song_id, apple_music_song_id: event.apple_music_song_id });
      if (event.evidence.unavailable_origin) {
        const raw = event.before.source;
        if (raw?.melon_song_id !== event.melon_song_id || linkDigest(raw) !== event.source_fingerprint) linkError("비활성 연결의 원본 기록이 손상됐습니다.");
        unavailableLinkSource(raw, event.evidence);
      }
    } else if (!prior || prior.action !== "link" || event.link_revision !== prior.revision_id
      || (event.after === "unavailable" && !prior.evidence.unavailable_origin)
      || (event.source_fingerprint !== null && !HASH.test(event.source_fingerprint ?? ""))
      || (event.base_record_fingerprint !== null && !HASH.test(event.base_record_fingerprint ?? ""))) linkError("연결 취소 이력의 이전 연결을 확인할 수 없습니다.");
    revisions.add(event.revision_id); latest.set(event.melon_song_id, event);
  }
  return document;
}

export function projectExistingLinks(baseEffective, sourceDocument, document, checkpoint, unavailableDocument = { mappings: [] }) {
  const effective = new Map(baseEffective), latest = new Map(document.events.map(event => [event.melon_song_id, event]));
  const sources = new Map((sourceDocument?.songs ?? []).map(song => [String(song.melon_song_id), song]));
  const unavailableRows = sourceDocument?.unavailable_songs ?? [];
  const mappedUnavailableIds = new Set(unavailableDocument.mappings.map(mapping => mapping.melon_song_id));
  const unavailable = new Map();
  const orphan = [], active = [], stale = [];
  const hold = (id, source, event, reason) => {
    const before = baseEffective.get(id) ?? event.before ?? {};
    effective.set(id, { ...before, ...source, match_status: "held", match_source: "existing-link-review-required",
      link_revision: event.revision_id, link_stale: true, link_reason: event.reason,
      link_anchor_melon_song_id: event.anchor_melon_song_id ?? null, link_identity_basis: event.evidence?.identity_basis ?? null,
      link_uncertainties: event.evidence?.accepted_uncertainties ?? [], match_reasons: [reason] });
    stale.push(event);
  };
  for (const [id, event] of latest) {
    let source = sources.get(id), base = baseEffective.get(id);
    let output = effective;
    const inactiveRows = unavailableRows.filter(row => String(row.melon_song_id) === id);
    const inactive = event.action === "link" && Boolean(event.evidence.unavailable_origin);
    if (inactive && !source && inactiveRows.length) {
      source = inactiveRows[0];
      base = unavailableLinkBase(source);
      output = unavailable;
    }
    if (event.action === "unlink" && event.after === "unavailable" && !source && inactiveRows.length) continue;
    if (!source) { orphan.push(event); effective.delete(id); continue; }
    if (event.action === "unlink") {
      const explicitlyResolved = base?.match_status === "manual_confirmed" && base.supersedes_existing_link_revision === event.revision_id
        && base.confirmed_source_fingerprint === sourceDigest(source);
      const restored = UNRESOLVED.has(base?.match_status) && event.source_fingerprint === sourceDigest(source)
        && event.base_record_fingerprint === linkDigest(base);
      if (!explicitlyResolved && !restored) hold(id, source, event, "cancelled_link_requires_review");
      continue;
    }
    const anchorSource = sources.get(event.anchor_melon_song_id), anchor = baseEffective.get(event.anchor_melon_song_id);
    const anchorEvent = latest.get(event.anchor_melon_song_id);
    const originValid = inactive
      ? output === unavailable && inactiveRows.length === 1 && !mappedUnavailableIds.has(id) && linkDigest(source) === event.source_fingerprint
        && anchor?.match_status === "manual_confirmed"
        && sourceDocument.songs.filter(row => String(row.melon_song_id) === event.anchor_melon_song_id).length === 1
        && !unavailableRows.some(row => String(row.melon_song_id) === event.anchor_melon_song_id)
      : sourceDigest(source) === event.source_fingerprint;
    const valid = originValid && base && linkDigest(base) === event.base_record_fingerprint
      && anchorSource && sourceDigest(anchorSource) === event.anchor_fingerprint && anchor && SELECTED.has(anchor.match_status)
      && linkDigest(anchor) === event.anchor_selection_fingerprint && String(anchor.apple_music_song_id) === event.apple_music_song_id
      && anchorEvent?.action !== "link" && checkpoint?.playlist_id === event.target.playlist_id
      && (checkpoint.backend ?? "official") === event.target.backend && checkpoint.storefront === "kr"
      && checkpoint.added_song_ids?.map(String).includes(event.apple_music_song_id);
    if (!valid) {
      if (output === unavailable) stale.push(event);
      else hold(id, source, event, "existing_link_inputs_changed");
      continue;
    }
    const target = event.target.catalog;
    if (inactive) source = unavailableLinkSource(source, event.evidence);
    output.set(id, { ...source, apple_music_song_id: event.apple_music_song_id, apple_music_title: target.title,
      apple_music_artist: target.artist, apple_music_album: target.album, apple_music_duration_ms: target.duration_ms,
      apple_music_isrc: target.isrc, apple_music_content_rating: target.content_rating, apple_music_url: target.url,
      match_status: "linked_existing", match_source: "manual-user-linked-existing-kr", match_reasons: ["user_linked_existing"],
      link_revision: event.revision_id, link_anchor_melon_song_id: event.anchor_melon_song_id, link_reason: event.reason,
      link_identity_basis: event.evidence.identity_basis, link_uncertainties: event.evidence.accepted_uncertainties,
      link_confirmed_at: event.confirmed_at, link_remote_checked_at: event.remote_evidence.checked_at, link_stale: false });
    active.push(event);
  }
  return { effective, unavailable, latest, active, stale, orphan, source_missing: document.events.length > 0 && !sourceDocument };
}

export async function verifyExistingTarget(adapter, state, appleId, lookup, snapshot = {}) {
  if (!state?.playlist_id || !Array.isArray(state.added_song_ids) || !state.added_song_ids.map(String).includes(appleId)
    || state.storefront !== "kr" || state.backend !== adapter.backend) linkError("기존 KR playlist/backend/checkpoint가 일치하지 않습니다.");
  const playlist = snapshot.playlist ?? await adapter.getLibraryPlaylist(state.playlist_id);
  if (!playlist || playlist.id !== state.playlist_id) linkError("기존 도구 플레이리스트를 확인할 수 없습니다.");
  const tracks = snapshot.tracks ?? await adapter.getPlaylistTracks(state.playlist_id, { requireComplete: true });
  const preservedIds = () => {
    try { return verifiedRecoveryPreservedIds(snapshot.recoveryValidation, state, tracks, adapter.backend); }
    catch { linkError("복구 보존 항목의 검증 근거가 없거나 checkpoint·원격 목록이 변경됐습니다."); }
  };
  const preserved = preservedIds();
  if (!Array.isArray(tracks) || tracks.some(track => !track?.catalog_id && !preserved.has(track?.id))) linkError("플레이리스트 catalog 매핑이 불완전합니다.");
  const occurrences = tracks.filter(track => String(track.catalog_id) === appleId);
  if (occurrences.length !== 1 || !occurrences[0].id) linkError("기존 곡은 플레이리스트에 정확히 1회 존재해야 합니다.");
  const library = await adapter.getLibrarySong(occurrences[0].id);
  if (!library || library.id !== occurrences[0].id || library.catalog_id !== appleId) linkError("보관함 resource와 catalog ID의 대응을 확인할 수 없습니다.");
  const resources = await adapter.validateCatalogSongs([appleId]);
  if (!Array.isArray(resources) || resources.length !== 1) linkError("한국 catalog 대상이 정확히 하나여야 합니다.");
  const catalog = catalogMetadata(resources[0]);
  if (catalog.id !== appleId) linkError("한국 catalog ID가 승인 대상과 다릅니다.");
  if (lookup) {
    const keys = ["id", "title", "artist", "album", "duration_ms", "isrc", "content_rating"];
    for (const key of keys) {
      const left = key === "content_rating" ? normalizedRating(lookup[key]) : lookup[key];
      const right = key === "content_rating" ? normalizedRating(catalog[key]) : catalog[key];
      if (left != null && right != null && left !== right) linkError("한국 lookup과 catalog 메타데이터가 다릅니다. 새 검토가 필요합니다.");
    }
  }
  if (snapshot.recoveryValidation != null) preservedIds();
  return { catalog, remote: { checked_at: new Date().toISOString(), playlist_occurrences: 1,
    library_song_id: library.id, library_catalog_id: library.catalog_id } };
}

export async function validateActiveLinks(selection, state, adapter, snapshot = {}) {
  if (selection.links.source_missing || selection.links.stale.some(event => event.action === "link") || selection.links.orphan.some(event => event.action === "link")) {
    linkError("기존 곡 연결의 원본/기준 판정이 변경됐습니다. 먼저 연결을 검토하거나 취소하세요.");
  }
  const results = [];
  const checkedTargets = new Map();
  for (const event of selection.links.active) {
    if (!checkedTargets.has(event.apple_music_song_id)) {
      checkedTargets.set(event.apple_music_song_id, await verifyExistingTarget(adapter, state, event.apple_music_song_id, null, snapshot));
    }
    const { catalog, remote } = checkedTargets.get(event.apple_music_song_id);
    if (linkDigest(catalog) !== linkDigest(event.target.catalog)) linkError("기존 연결의 catalog 메타데이터가 변경됐습니다. 자동 대체하지 않습니다.");
    if (event.evidence.unavailable_origin && remote.library_song_id !== event.remote_evidence.library_song_id) linkError("비활성 연결의 기존 보관함 리소스가 변경됐습니다.");
    results.push({ melon_song_id: event.melon_song_id, apple_music_song_id: event.apple_music_song_id, checked: true, ...remote });
  }
  return results;
}
