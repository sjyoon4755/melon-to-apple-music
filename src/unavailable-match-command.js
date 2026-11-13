import { createHash } from "node:crypto";
import path from "node:path";
import { ITunesSearchClient } from "./apple-api.js";
import { appleSongIdFromOptions, readMatchSelection } from "./match-decisions.js";
import { assertDataSnapshot, withDataLocks } from "./apply-lock.js";
import { readJson, writeJsonAtomic } from "./io.js";
import { unavailableSourceDigest } from "./unavailable-matches.js";
import { readUnavailableEvidence, assertUnavailableEvidenceFile, metadataWithEvidence } from "./unavailable-evidence.js";

export async function resolveUnavailableMatch(config, options = {}) {
  const operation = assertOwned => resolve(config, options, assertOwned);
  return options.confirm ? withDataLocks(config, operation) : operation();
}

async function resolve(config, options, assertOwned) {
  const melonId = String(options.melonSongId ?? "").trim();
  const reason = String(options.reason ?? "").trim();
  if (!/^\d+$/.test(melonId)) throw new Error("숫자 --melon-song-id가 필요합니다.");
  if (!reason || reason.length > 500) throw new Error("--reason에 1~500자의 검토 사유를 지정하세요.");
  if (config.storefront !== "kr") throw new Error("비활성 대응은 KR storefront에서만 지원합니다.");
  if (options.confirm && !/^[a-f0-9]{64}$/.test(options.expectedPreview ?? "")) {
    throw new Error("미리보기 확인 후 --confirm --expected-preview HASH를 지정하세요.");
  }
  if (!options.confirm && options.expectedPreview != null) throw new Error("--expected-preview는 --confirm과 함께 지정하세요.");
  const appleId = appleSongIdFromOptions(options);
  const selection = await readMatchSelection(config);
  const source = selection.sourceDocument;
  const rows = (source?.unavailable_songs ?? []).filter(song => String(song.melon_song_id) === melonId);
  if (rows.length !== 1 || source.songs.some(song => String(song.melon_song_id) === melonId)) {
    throw new Error("고유한 비활성 원곡만 대응할 수 있습니다. 정상 원곡은 resolve를 사용하세요.");
  }
  if (selection.unavailableDocument.mappings.some(mapping => mapping.melon_song_id === melonId)) {
    throw new Error("이미 저장된 비활성 대응 이력이 있습니다. 덮어쓰지 않습니다.");
  }
  const link = selection.links.latest.get(melonId);
  if ((link && (link.action !== "unlink" || link.after !== "unavailable")) || selection.latest.has(melonId)
    || selection.recoveries.protectedSources.has(melonId)
    || [...selection.manualDocument.songs, ...selection.matchedDocument.songs, ...selection.unmatchedDocument.songs]
      .some(song => String(song.melon_song_id) === melonId)) {
    throw new Error("기존 정상곡 판정/연결 이력과 충돌합니다. 별도 검토가 필요합니다.");
  }
  const song = rows[0];
  const evidenceFile = options.evidenceFile ? path.resolve(config.root, options.evidenceFile) : null;
  const evidence = evidenceFile ? await readUnavailableEvidence(evidenceFile, song, appleId) : null;
  if (!evidence && ["title", "artist", "album"].some(key => typeof song[key] !== "string" || !song[key].trim())) {
    throw new Error("원곡 제목·가수·앨범이 없는 비활성 행은 --evidence-file 공개 근거가 필요합니다.");
  }
  const state = await readJson(config.files.importState);
  if (selection.selected.some(song => String(song.apple_music_song_id) === appleId)
    || selection.unavailableDocument.mappings.some(mapping => String(mapping.record.apple_music_song_id) === appleId)
    || (state?.added_song_ids ?? []).map(String).includes(appleId)) {
    throw new Error("다른 선택 곡 또는 checkpoint의 Apple ID와 중복됩니다. 재사용 여부를 별도로 검토하세요.");
  }
  const client = options.lookupClient ?? new ITunesSearchClient({ storefront: config.storefront });
  const apple = (await client.lookupSongs([appleId], { sourceStorefront: config.storefront }))[0];
  if (!apple || String(apple.id) !== appleId) throw new Error("선택한 Apple 곡이 한국 lookup에 없습니다.");
  const record = { ...metadataWithEvidence(song, evidence), source_availability: "unavailable", apple_music_song_id: appleId,
    apple_music_title: apple.title, apple_music_artist: apple.artist, apple_music_album: apple.album,
    apple_music_duration_ms: apple.duration_ms ?? null, apple_music_isrc: apple.isrc ?? null,
    apple_music_content_rating: apple.content_rating ?? null, apple_music_url: apple.url ?? null,
    match_status: "manual_confirmed", match_source: "manual-user-confirmed-unavailable-itunes-lookup-kr",
    match_score: null, match_margin: null, match_components: null, candidates: [] };
  const preview = { melon: song, apple_music: apple, reason, source_availability: "unavailable",
    ...(evidence ? { public_metadata: evidence.document.public_metadata, public_provenance: evidence.document.provenance,
      public_evidence: evidence, comparison: evidence.document.comparison, limitations: evidence.document.limitations } : {}),
    storefront: "kr", saved: false, account_changed: false, remote_play_params_checked: false,
    same_recording_verified: false, warning: "Melon 비활성 상태를 보존합니다. 동일 녹음은 lookup만으로 증명되지 않습니다." };
  const previewHash = createHash("sha256").update(JSON.stringify([preview, record, selection.input_fingerprint])).digest("hex");
  await assertDataSnapshot(config, selection.input_fingerprint);
  if (evidence) await assertUnavailableEvidenceFile(evidenceFile, evidence);
  if (!options.confirm) return { ...preview, preview_hash: previewHash };
  if (previewHash !== options.expectedPreview) throw new Error("미리보기 이후 후보 또는 로컬 결과가 바뀌었습니다. 새 미리보기를 확인하세요.");
  await assertOwned();
  if (evidence) await assertUnavailableEvidenceFile(evidenceFile, evidence);
  const confirmedAt = new Date().toISOString();
  await writeJsonAtomic(config.files.unavailableMatches, { schema_version: 1, updated_at: confirmedAt,
    mappings: [...selection.unavailableDocument.mappings, { melon_song_id: melonId, source: song,
      source_fingerprint: unavailableSourceDigest(song), storefront: "kr", reason,
      approved_preview_hash: previewHash, confirmed_at: confirmedAt, record, ...(evidence ? { evidence } : {}) }] });
  return { ...preview, saved: true, preview_hash: previewHash };
}
