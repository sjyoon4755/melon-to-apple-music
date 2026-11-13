import { createHash } from "node:crypto";
import { readJson } from "./io.js";
import { validateStoredUnavailableEvidence } from "./unavailable-evidence.js";

// Bind approval to the complete saved inactive row, including its availability evidence.
export const unavailableSourceDigest = song => createHash("sha256").update(JSON.stringify(song)).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const ID = /^\d+$/;

export async function readUnavailableMatches(config) {
  const document = await readJson(config.files.unavailableMatches, { schema_version: 1, mappings: [] });
  const ids = new Set();
  if (document?.schema_version !== 1 || !Array.isArray(document.mappings)) {
    throw new Error("비활성 대응 판정 형식이 잘못되었습니다. 기존 파일을 보존하고 확인하세요.");
  }
  for (const mapping of document.mappings) {
    if (!mapping || !ID.test(mapping.melon_song_id ?? "") || ids.has(mapping.melon_song_id)
      || !HASH.test(mapping.source_fingerprint ?? "") || !HASH.test(mapping.approved_preview_hash ?? "")
      || typeof mapping.reason !== "string" || !mapping.reason.trim() || mapping.reason.length > 500
      || !Number.isFinite(Date.parse(mapping.confirmed_at)) || mapping.storefront !== "kr"
      || mapping.source?.melon_song_id !== mapping.melon_song_id
      || unavailableSourceDigest(mapping.source) !== mapping.source_fingerprint
      || mapping.record?.melon_song_id !== mapping.melon_song_id
      || mapping.record?.match_status !== "manual_confirmed"
      || mapping.record?.source_availability !== "unavailable"
      || !ID.test(mapping.record?.apple_music_song_id ?? "")) {
      throw new Error("비활성 대응 판정 기록이 잘못되었습니다. 자동 적용하지 않고 중단합니다.");
    }
    ids.add(mapping.melon_song_id);
    if (Object.hasOwn(mapping, "evidence")) {
      validateStoredUnavailableEvidence(mapping.evidence, mapping.source, mapping.record.apple_music_song_id, mapping.record);
    } else if (["title", "artist", "album"].some(key => typeof mapping.source[key] !== "string" || !mapping.source[key].trim())) {
      throw new Error("공개 근거 없는 비활성 대응의 원곡 메타데이터가 누락됐습니다. 기존 기록을 보존하고 확인하세요.");
    }
  }
  return document;
}

export function projectUnavailableMatches(source, document, selected) {
  const normalIds = new Set((source?.songs ?? []).map(s => String(s.melon_song_id)));
  const unavailable = source?.unavailable_songs ?? [];
  const usedIds = new Set(selected.map(s => String(s.apple_music_song_id)));
  return document.mappings.map(mapping => {
    const rows = unavailable.filter(s => String(s.melon_song_id) === mapping.melon_song_id);
    const stale = rows.length !== 1 || normalIds.has(mapping.melon_song_id)
      || unavailableSourceDigest(rows[0]) !== mapping.source_fingerprint;
    const duplicate = usedIds.has(String(mapping.record.apple_music_song_id));
    if (!stale && !duplicate) usedIds.add(String(mapping.record.apple_music_song_id));
    return { ...mapping.record, match_status: stale || duplicate ? "held" : "manual_confirmed",
      ...(mapping.evidence ? { public_metadata_title: mapping.evidence.document.public_metadata.title,
        public_metadata_artist: mapping.evidence.document.public_metadata.artist,
        public_metadata_album: mapping.evidence.document.public_metadata.album,
        public_metadata_checked_at: mapping.evidence.document.provenance.checked_at,
        public_metadata_song_url: mapping.evidence.document.provenance.song_url,
        public_metadata_album_url: mapping.evidence.document.provenance.album_url,
        public_evidence_file_sha256: mapping.evidence.file_sha256,
        public_evidence_document_sha256: mapping.evidence.document_sha256 } : {}),
      unavailable_mapping_stale: stale, unavailable_mapping_duplicate: duplicate,
      decision_reason: mapping.reason, manual_confirmed_at: mapping.confirmed_at,
      match_reasons: [stale ? "source_changed_since_confirmation" : duplicate ? "duplicate_apple_selection" : "user_confirmed"] };
  });
}
