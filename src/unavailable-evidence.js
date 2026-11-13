import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^\d+$/;
export const evidenceDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesDigest = value => createHash("sha256").update(value).digest("hex");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 1000) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new Error("비활성 공개 근거의 schema·정확한 ID·원본 해시·메타데이터·출처를 확인하세요. 기존 자료는 변경하지 않았습니다."); };

function validSourceUrl(value, type, id) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.melon.com" && !url.port && !url.username && !url.password
      && !url.hash && url.pathname === `/${type}/detail.htm` && [...url.searchParams].length === 1
      && url.searchParams.get(type === "song" ? "songId" : "albumId") === id;
  } catch { return false; }
}

export function validateUnavailableEvidence(document, source, appleId) {
  if (!exactKeys(document, ["schema_version", "melon_song_id", "apple_music_song_id", "operating_source_sha256",
    "public_metadata", "provenance", "comparison", "limitations"])
    || document.schema_version !== 1 || typeof document.melon_song_id !== "string" || !ID.test(document.melon_song_id)
    || document.melon_song_id !== String(source.melon_song_id)
    || document.apple_music_song_id !== appleId || !ID.test(appleId)
    || !HASH.test(document.operating_source_sha256 ?? "") || document.operating_source_sha256 !== evidenceDigest(source)
    || !text(document.comparison, 2000) || !Array.isArray(document.limitations) || !document.limitations.length
    || document.limitations.length > 20 || document.limitations.some(value => !text(value, 500))) fail();
  const metadata = document.public_metadata, provenance = document.provenance;
  if (!exactKeys(metadata, ["title", "artist", "album", "album_id", "isrc", "duration_ms", "content_rating"])
    || ![metadata.title, metadata.artist, metadata.album].every(value => text(value))
    || typeof metadata.album_id !== "string" || !ID.test(metadata.album_id)
    || !(metadata.isrc === null || (typeof metadata.isrc === "string" && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(metadata.isrc)))
    || !(metadata.duration_ms === null || (Number.isSafeInteger(metadata.duration_ms) && metadata.duration_ms > 0))
    || ![null, "explicit", "not_explicit"].includes(metadata.content_rating)
    || !exactKeys(provenance, ["song_url", "album_url", "checked_at", "method"])
    || !validSourceUrl(provenance.song_url, "song", document.melon_song_id)
    || !validSourceUrl(provenance.album_url, "album", metadata.album_id)
    || typeof provenance.checked_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(provenance.checked_at)
    || !Number.isFinite(Date.parse(provenance.checked_at))
    || provenance.method !== "official-public-page-GET") fail();
  return document;
}

export function metadataWithEvidence(source, evidence) {
  if (!evidence) return source;
  const result = { ...source }, metadata = evidence.document.public_metadata;
  // The original inactive row is stored separately; only fill absent review fields.
  for (const key of ["title", "artist", "album", "isrc", "duration_ms", "content_rating"]) {
    if (result[key] == null || result[key] === "") result[key] = metadata[key];
  }
  return result;
}

export function validateStoredUnavailableEvidence(evidence, source, appleId, record) {
  if (!exactKeys(evidence, ["file_sha256", "document_sha256", "document"])
    || !HASH.test(evidence.file_sha256 ?? "") || !HASH.test(evidence.document_sha256 ?? "")
    || evidenceDigest(evidence.document) !== evidence.document_sha256) fail();
  validateUnavailableEvidence(evidence.document, source, appleId);
  const expected = metadataWithEvidence(source, evidence);
  if (["title", "artist", "album", "isrc", "duration_ms", "content_rating"].some(key => record[key] !== expected[key])) fail();
}

export async function readUnavailableEvidence(file, source, appleId) {
  let bytes, document;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024) fail();
    bytes = await readFile(file);
    if (bytes.length > 64 * 1024) fail();
    document = JSON.parse(bytes.toString("utf8"));
  } catch { fail(); }
  validateUnavailableEvidence(document, source, appleId);
  return { file_sha256: bytesDigest(bytes), document_sha256: evidenceDigest(document), document };
}

export async function assertUnavailableEvidenceFile(file, evidence) {
  let bytes;
  try { bytes = await readFile(file); } catch { fail(); }
  if (bytesDigest(bytes) !== evidence.file_sha256) {
    throw new Error("검사 중 공개 근거 파일이 바뀌었습니다. 새 미리보기를 확인하세요.");
  }
}
