import { createAppleMusicWriteAdapter, resolveWriteBackend } from "./apple-write-adapter.js";
import { ITunesSearchClient } from "./apple-api.js";
import { chooseMatch, matchReasons } from "./matcher.js";
import { stat } from "node:fs/promises";
import { readJson, writeCsv, writeJsonAtomic } from "./io.js";
import { resolveBrowserRuntime } from "./browser-config.js";
import { startRun, readRunState, sourceFingerprint, reviewFingerprint } from "./run-state.js";
import { ApplyLockError, acquireApplyLock, playlistTarget, readApplyRun, withDataLocks, acquireDataLocks, dataSnapshot, assertDataSnapshot } from "./apply-lock.js";
import { appleSongIdFromOptions, readMatchSelection, reviseMatchDecision } from "./match-decisions.js";
import { prepareReviewReport, writeReviewReport } from "./review-report.js";
import { linkExistingSong, unlinkExistingSong, issueLinkPreview, confirmLinkPreview } from "./existing-song-link-commands.js";
import { sourceDigest, validateActiveLinks, ExistingLinkError } from "./existing-song-links.js";
import { unavailableSourceDigest } from "./unavailable-matches.js";
import { validateRecoveryRemote, UnresolvedRecoveryError } from "./song-recoveries.js";

const REVIEW_COLUMNS = [
  "melon_song_id", "title", "artist", "album", "duration_ms", "isrc", "melon_url",
  "apple_music_song_id", "apple_music_title", "apple_music_artist", "apple_music_album",
  "apple_music_content_rating", "apple_music_url", "match_score", "match_margin", "match_status",
  "match_source", "manual_confirmed_at", "candidate_count", "match_reasons",
  "decision_reason", "decision_revision", "decision_confirmed_at", "decision_stale",
  "source_availability", "unavailable_mapping_stale", "unavailable_mapping_duplicate",
  "public_metadata_title", "public_metadata_artist", "public_metadata_album", "public_metadata_checked_at",
  "public_metadata_song_url", "public_metadata_album_url", "public_evidence_file_sha256", "public_evidence_document_sha256",
  "link_anchor_melon_song_id", "link_revision", "link_reason", "link_identity_basis", "link_uncertainties",
  "link_confirmed_at", "link_remote_checked_at", "link_stale",
  "recovery_id", "recovery_followup_id", "recovery_old_apple_id", "recovery_reason", "recovery_confirmed_at"
];

const DEFAULT_THRESHOLD = 0.88;
const DEFAULT_MIN_MARGIN = 0.06;

function reviewSourceFingerprint(source) {
  const normal = source?.songs ?? [], unavailable = source?.unavailable_songs ?? [];
  return unavailable.length ? unavailableSourceDigest([sourceFingerprint(normal), unavailable]) : sourceFingerprint(normal);
}

function mergeCandidates(...groups) {
  const byId = new Map();
  for (const candidate of groups.flat()) {
    if (!candidate?.id) continue;
    const existing = byId.get(candidate.id);
    byId.set(candidate.id, existing ? {
      ...existing,
      ...candidate,
      source_storefronts: [...new Set([
        ...(existing.source_storefronts ?? []),
        ...(candidate.source_storefronts ?? [])
      ])],
      title_aliases: [...new Set([...(existing.title_aliases ?? []), ...(candidate.title_aliases ?? [])])],
      artist_aliases: [...new Set([...(existing.artist_aliases ?? []), ...(candidate.artist_aliases ?? [])])],
      album_aliases: [...new Set([...(existing.album_aliases ?? []), ...(candidate.album_aliases ?? [])])]
    } : candidate);
  }
  return [...byId.values()];
}

function searchCoreTitle(value) {
  return String(value ?? "")
    .replace(/(?:\(|\[)?\s*(?:feat\.?|featuring|ft\.?)\s+[^)\]]+(?:\)|\])?/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parentheticalArtistAlias(value) {
  const aliases = [...String(value ?? "").matchAll(/\(([^)]+)\)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  return aliases.find((alias) => /[A-Za-z]/.test(alias)) ?? null;
}

export function buildSearchQueries(song) {
  const title = String(song.title ?? "").trim();
  const artist = String(song.artist ?? "").trim();
  const album = String(song.album ?? "").trim();
  const coreTitle = searchCoreTitle(title);
  const artistAlias = parentheticalArtistAlias(artist) ?? artist;
  return [...new Set([
    [title, artist].filter(Boolean).join(" "),
    [coreTitle, artistAlias].filter(Boolean).join(" "),
    coreTitle,
    [album, artistAlias].filter(Boolean).join(" ")
  ].filter(Boolean))];
}

function outputRecord(song, decision) {
  const best = decision.best;
  return {
    ...song,
    apple_music_song_id: best?.id ?? null,
    apple_music_title: best?.title ?? null,
    apple_music_artist: best?.artist ?? null,
    apple_music_album: best?.album ?? null,
    apple_music_duration_ms: best?.duration_ms ?? null,
    apple_music_isrc: best?.isrc ?? null,
    apple_music_content_rating: best?.content_rating ?? null,
    apple_music_url: best?.url ?? null,
    match_source: "itunes-search-verified-kr",
    match_score: best ? Number(best.score.toFixed(4)) : null,
    match_margin: best ? Number(decision.margin.toFixed(4)) : null,
    match_status: decision.status,
    candidate_count: decision.candidate_count,
    match_reasons: decision.reasons,
    match_components: best?.components ?? null,
    candidates: decision.candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      artist: candidate.artist,
      album: candidate.album,
      duration_ms: candidate.duration_ms,
      isrc: candidate.isrc,
      content_rating: candidate.content_rating,
      url: candidate.url,
      title_aliases: candidate.title_aliases,
      artist_aliases: candidate.artist_aliases,
      album_aliases: candidate.album_aliases,
      source_storefronts: candidate.source_storefronts,
      score: Number(candidate.score.toFixed(4)),
      components: candidate.components
    }))
  };
}

async function saveMatchOutputs(config, records, matchConfig, expected) {
  const matched = records.filter((record) => record.match_status === "matched");
  const unmatched = records.filter((record) => record.match_status !== "matched");
  const base = { schema_version: 1, updated_at: new Date().toISOString(), match_config: matchConfig };
  return withDataLocks(config, async assertOwned => {
    try { await assertDataSnapshot(config, expected); }
    catch (error) {
      await writeJsonAtomic(`${config.files.matchingRun}.conflict.json`, { ...base, songs: records, expected_input: expected });
      throw error;
    }
    await assertOwned();
    await writeJsonAtomic(config.files.matched, { ...base, songs: matched });
    await writeJsonAtomic(config.files.unmatched, { ...base, songs: unmatched });
    return dataSnapshot(config);
  });
}

function matchingConfig(document) {
  const value = document?.match_config;
  if (!value) return null;
  return {
    threshold: Number(value.threshold),
    min_margin: Number(value.min_margin)
  };
}

function resolveMatchingConfig(options, ...documents) {
  const configs = documents.map(matchingConfig).filter(Boolean);
  if (!options.force && configs.some((value) => value.threshold !== configs[0].threshold || value.min_margin !== configs[0].min_margin)) {
    throw new Error("매칭 결과 파일의 판정 기준이 서로 다릅니다. 전체 재매칭에는 --force가 필요합니다.");
  }
  const stored = options.force ? null : configs[0];
  const hasRecords = documents.some((document) => document.songs?.length);
  if (!options.force && !stored && hasRecords && (options.threshold != null || options.minMargin != null)) {
    throw new Error("기존 매칭 결과에는 판정 기준 기록이 없습니다. 기준을 바꾸려면 --force를 지정하세요.");
  }
  const threshold = options.threshold ?? stored?.threshold ?? DEFAULT_THRESHOLD;
  const minMargin = options.minMargin ?? stored?.min_margin ?? DEFAULT_MIN_MARGIN;
  if (![threshold, minMargin].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("매칭 판정 기준은 0 이상 1 이하의 숫자여야 합니다.");
  }
  if (stored && (threshold !== stored.threshold || minMargin !== stored.min_margin)) {
    throw new Error("기존 매칭 결과와 다른 판정 기준입니다. 전체 재매칭하려면 --force를 지정하세요.");
  }
  return { threshold, min_margin: minMargin };
}

export async function matchAppleMusic(config, options = {}) {
  const initial = await readMatchSelection(config);
  const source = initial.sourceDocument;
  if (!source?.songs?.length) throw new Error("먼저 melon-extract를 실행해 data/melon_likes.json을 만드세요.");
  let run;
  const client = options.lookupClient ?? new ITunesSearchClient({ storefront: config.storefront,
    onProgress: async (requests) => run?.update({ requests }) });
  const { matchedDocument, unmatchedDocument } = initial;
  let expectedInput = initial.input_fingerprint;
  const matchConfig = resolveMatchingConfig(options, matchedDocument, unmatchedDocument);
  const oldMatched = matchedDocument.songs ?? [];
  const oldUnmatched = unmatchedDocument.songs ?? [];
  const sourceIds = new Set(source.songs.map((song) => String(song.melon_song_id)));
  const recordsById = new Map(
    (options.force ? [] : [...oldMatched, ...oldUnmatched])
      .filter((record) => sourceIds.has(String(record.melon_song_id)))
      .map((record) => [String(record.melon_song_id), record])
  );

  const threshold = matchConfig.threshold;
  const minMargin = matchConfig.min_margin;
  let searched = 0;
  let phase = "searching";
  const started = Date.now();
  const fingerprint = sourceFingerprint(source.songs);
  const progress = () => {
    const processed = source.songs.filter((song) => recordsById.has(String(song.melon_song_id))).length;
    const elapsed = Date.now() - started;
    return { phase, source_fingerprint: fingerprint, source_count: source.songs.length, processed, remaining: source.songs.length - processed,
      searched, reused: processed - searched, requests: { ...(client.stats ?? {}) },
      estimated_remaining_ms: searched ? Math.round(elapsed / searched * (source.songs.length - processed)) : null };
  };
  run = await startRun(config.files.matchingRun, progress());
  try {
    for (let index = 0; index < source.songs.length; index += 1) {
      const song = source.songs[index];
      if (recordsById.has(String(song.melon_song_id))) continue;
      const queries = buildSearchQueries(song);
      let candidates = [];
      let decision = chooseMatch(song, candidates, { threshold, minMargin });
      search: for (const sourceStorefront of ["us", "jp"]) {
        for (const query of queries) {
          const found = await client.searchSongs(query, 15, { sourceStorefront });
          candidates = mergeCandidates(candidates, found);
          decision = chooseMatch(song, candidates, { threshold, minMargin });
          if (decision.status === "matched") break search;
        }
      }
      const record = outputRecord(song, decision);
      expectedInput = await saveMatchOutputs(config, [...recordsById.values(), record], matchConfig, expectedInput);
      recordsById.set(String(song.melon_song_id), record);
      searched += 1;
      await run.update(progress());
      console.log(`Apple Music 매칭 ${progress().processed}/${source.songs.length}: ${song.title} → ${record.match_status} (${record.match_score ?? "-"}), 요청 ${client.stats?.requests ?? "-"}회, 경과 ${Math.round((Date.now() - started) / 1000)}초`);
    }
    const records = [...recordsById.values()];
    if (!searched) console.log(`기존 매칭 ${records.length}건을 재사용했습니다. 새 검색 0건.`);
    if (searched) {
      phase = "reviewing";
      await run.update(progress());
      await reviewResults(config);
    }
    phase = "finished";
    await run.finish("completed", { ...progress(), stop_reason: "all_source_songs_processed" });
    const selection = await readMatchSelection(config);
    const reviewState = await reviewFileState(config, selection, searched > 0);
    return {
      ...summarize(selection.records),
      source: sourceSummary(selection),
      review_state: reviewState,
      next_command: !reviewState.csv_present || !reviewState.html_present || reviewState.stale ? "review" : null,
      searched,
      reused: records.length - searched,
      threshold,
      min_margin: minMargin,
      requests: { ...(client.stats ?? {}) },
      elapsed_ms: Date.now() - started
    };
  } catch (error) {
    await run.finish("failed", { ...progress(), stop_reason: phase === "reviewing" ? "review_failed" : "matching_failed" });
    throw error;
  }
}

export function summarize(records) {
  const summary = { total: records.length, matched: 0, manual_confirmed: 0, ambiguous: 0, not_found: 0 };
  if (records.some((record) => record.match_status === "held")) summary.held = 0;
  if (records.some((record) => record.match_status === "linked_existing")) summary.linked_existing = 0;
  for (const record of records) {
    if (Object.hasOwn(summary, record.match_status)) summary[record.match_status] += 1;
  }
  return summary;
}

function sourceSummary(selection) {
  const source = selection.sourceDocument;
  const unprocessed = source ? (source.songs ?? []).filter((song) => !selection.effective.has(String(song.melon_song_id))).length : null;
  return { present: Boolean(source), count: source?.songs.length ?? null, unavailable_count: source ? source.unavailable_songs?.length ?? 0 : null,
    complete: source?.complete === true, processed: source ? source.songs.length - unprocessed : null, unprocessed,
    reported_count_gap: source?.extraction?.reported_count_gap ?? null };
}

async function reviewFileState(config, selection, generated) {
  const present = async (file) => { try { return (await stat(file)).isFile(); } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  const recorded = await readJson(config.files.reviewRun);
  const stale = recorded?.result_fingerprint ? recorded.status !== "completed"
    || recorded.result_fingerprint !== reviewFingerprint(selection.matchedDocument, selection.unmatchedDocument, selection.manualDocument.songs, selection.decisionsDocument.decisions, selection.linksDocument.events, selection.unavailableDocument.mappings, selection.recoveryDocument.transactions)
    || recorded.source_fingerprint !== reviewSourceFingerprint(selection.sourceDocument) : null;
  return { csv_present: await present(config.files.reviewCsv), html_present: await present(config.files.reviewHtml), generated, stale };
}

export async function reviewResults(config, options = {}) {
  return withDataLocks(config, assertOwned => reviewResultsUnlocked(config, options, assertOwned));
}

async function reviewResultsUnlocked(config, options, assertOwned) {
  const run = await startRun(config.files.reviewRun);
  try {
    const selection = await readMatchSelection(config);
    const { matchedDocument, unmatchedDocument, records, decisionsDocument } = selection;
    const manual = selection.manualDocument.songs ?? [];
    const source = selection.sourceDocument?.songs ?? [];
    await run.update({ source_fingerprint: reviewSourceFingerprint(selection.sourceDocument),
      matching_run_id: (await readJson(config.files.matchingRun))?.run_id ?? null,
      result_fingerprint: reviewFingerprint(matchedDocument, unmatchedDocument, manual, decisionsDocument.decisions, selection.linksDocument.events, selection.unavailableDocument.mappings, selection.recoveryDocument.transactions) });
    const matchConfig = matchingConfig(matchedDocument) ?? matchingConfig(unmatchedDocument)
      ?? { threshold: DEFAULT_THRESHOLD, min_margin: DEFAULT_MIN_MARGIN };
    const explained = [...records, ...selection.unavailableRecords].map((record) => ({ ...record,
      candidate_count: record.candidate_count ?? (record.candidates?.length === 5 ? "5+" : record.candidates?.length ?? 0),
      match_reasons: record.match_reasons ?? matchReasons({ status: record.match_status,
        best: record.match_score != null ? { score: record.match_score, components: record.match_components } : null,
        margin: record.match_margin ?? 0 }, { threshold: matchConfig.threshold, minMargin: matchConfig.min_margin }) }));
    const unprocessed = source.filter((song) => !selection.effective.has(String(song.melon_song_id)));
    explained.push(...unprocessed
      .map((song) => ({ ...song, match_status: "unprocessed", candidates: [], candidate_count: 0, match_reasons: ["not_searched"] })));
    const report = await prepareReviewReport(config, selection, explained, matchConfig, options);
    await assertDataSnapshot(config, selection.input_fingerprint);
    await assertOwned();
    await writeCsv(config.files.reviewCsv, explained, REVIEW_COLUMNS);
    await writeReviewReport(config.files.reviewHtml, report);
    const unavailableMappings = selection.unavailableDocument.mappings.length;
    await run.finish("completed", { records: records.length, unavailable_mappings: unavailableMappings, unprocessed: unprocessed.length });
    return { ...summarize(records), unavailable_mappings: unavailableMappings, source: sourceSummary(selection), next_command: !selection.sourceDocument ? "melon-extract"
      : unprocessed.length ? "match" : null };
  } catch (error) {
    await run.finish("failed", { stop_reason: "review_failed" });
    throw error;
  }
}

export async function updateReviewAfterSave(config, result) {
  try { result.review = await reviewResults(config); result.review_updated = true; }
  catch { result.review_updated = false; result.next_command = "review"; }
  return result;
}

export async function reviseMatch(config, options = {}) {
  const result = await reviseMatchDecision(config, options);
  return result.saved ? updateReviewAfterSave(config, result) : result;
}

export async function linkExisting(config, options = {}) {
  const result = await linkExistingSong(config, options);
  return result.saved || (result.already_linked && options.confirm) ? updateReviewAfterSave(config, result) : result;
}

export async function unlinkExisting(config, options = {}) {
  const result = await unlinkExistingSong(config, options);
  return result.saved || (result.already_unlinked && options.confirm) ? updateReviewAfterSave(config, result) : result;
}

export async function resolveManualMatch(config, options = {}) {
  const result = options.confirm
    ? await withDataLocks(config, assertOwned => resolveManualMatchUnlocked(config, options, assertOwned))
    : await resolveManualMatchUnlocked(config, options);
  return result.saved || result.already_confirmed ? updateReviewAfterSave(config, result) : result;
}

// Shared by single and bulk resolve so both apply identical guards before any lookup.
export function assertManuallyResolvable(selection, melonSongId, appleSongId) {
  const linkEvent = selection.links.latest.get(melonSongId);
  if (selection.recoveries.protectedSources.has(melonSongId)) throw new Error("복구 이력이 있는 곡은 일반 resolve로 변경하지 않습니다.");
  if (linkEvent?.action === "link") throw new Error("기존 연결 원곡은 먼저 unlink-existing으로 취소하세요.");
  if (selection.latest.has(melonSongId)) {
    throw new Error("로컬 판정이 있는 곡은 revise로 새 후보를 확인하세요.");
  }
  const source = selection.sourceDocument ?? { songs: [] };
  const melonSong = (source.songs ?? []).find((song) => String(song.melon_song_id) === melonSongId);
  if (!melonSong) throw new Error(`Melon song ID ${melonSongId}를 원본 추출 결과에서 찾지 못했습니다.`);

  const matched = selection.matchedDocument.songs;
  if (!linkEvent && matched.some((record) => String(record.melon_song_id) === melonSongId)) {
    throw new Error("이미 자동 매칭된 곡입니다. 수동 결과로 덮어쓰지 않습니다.");
  }
  const manual = selection.manualDocument.songs;
  const duplicate = selection.selected.find((record) =>
    String(record.apple_music_song_id) === appleSongId && String(record.melon_song_id) !== melonSongId
  );
  if (duplicate) throw new Error("해당 Apple song ID는 다른 Melon 곡에 이미 연결되어 있습니다.");
  return { melonSong, linkEvent, manual };
}

export function manualMatchRecord(melonSong, appleSong, linkEvent) {
  return {
    ...melonSong,
    apple_music_song_id: appleSong.id,
    apple_music_title: appleSong.title,
    apple_music_artist: appleSong.artist,
    apple_music_album: appleSong.album,
    apple_music_duration_ms: appleSong.duration_ms,
    apple_music_isrc: appleSong.isrc,
    apple_music_content_rating: appleSong.content_rating,
    apple_music_url: appleSong.url,
    match_source: "manual-user-confirmed-itunes-lookup-kr",
    match_score: null,
    match_margin: null,
    match_status: "manual_confirmed",
    match_components: null,
    candidates: [],
    manual_confirmed_at: null,
    ...(linkEvent ? { supersedes_existing_link_revision: linkEvent.revision_id, confirmed_source_fingerprint: sourceDigest(melonSong) } : {})
  };
}

async function resolveManualMatchUnlocked(config, options, assertOwned) {
  const melonSongId = String(options.melonSongId ?? "").trim();
  if (!melonSongId) throw new Error("--melon-song-id가 필요합니다.");
  const appleSongId = appleSongIdFromOptions(options);
  const selection = await readMatchSelection(config);
  const { melonSong, linkEvent, manual } = assertManuallyResolvable(selection, melonSongId, appleSongId);

  const client = options.lookupClient ?? new ITunesSearchClient({ storefront: config.storefront });
  const appleSong = (await client.lookupSongs([appleSongId], { sourceStorefront: config.storefront }))[0];
  if (!appleSong) throw new Error(`Apple song ID ${appleSongId}가 ${config.storefront.toUpperCase()} storefront lookup에 없습니다.`);
  const record = manualMatchRecord(melonSong, appleSong, linkEvent);
  const preview = {
    melon: { id: melonSongId, title: melonSong.title, artist: melonSong.artist, album: melonSong.album },
    apple_music: { id: appleSong.id, title: appleSong.title, artist: appleSong.artist, album: appleSong.album, url: appleSong.url },
    storefront: config.storefront,
    saved: false,
    remote_play_params_checked: false
  };
  const payload = { action: "resolve-unlinked", melon_song_id: melonSongId, record, link_revision: linkEvent?.revision_id,
    input_fingerprint: selection.input_fingerprint };
  if (linkEvent) await assertDataSnapshot(config, selection.input_fingerprint);
  if (!options.confirm) return linkEvent ? { ...preview, ...(await issueLinkPreview(config, payload)) } : preview;
  const existing = manual.find((item) => String(item.melon_song_id) === melonSongId);
  if (linkEvent && existing?.apple_music_song_id === appleSongId
    && existing.supersedes_existing_link_revision === linkEvent.revision_id
    && existing.confirmed_source_fingerprint === sourceDigest(melonSong)
    && existing.approved_link_release_preview_hash === options.expectedPreview
    && ["title", "artist", "album", "duration_ms", "isrc", "content_rating"].every(key => existing[key] === record[key])
    && ["title", "artist", "album", "duration_ms", "isrc", "content_rating", "url"].every(key => existing[`apple_music_${key}`] === record[`apple_music_${key}`])) {
    await assertDataSnapshot(config, selection.input_fingerprint); await assertOwned();
    return { ...preview, saved: false, already_confirmed: true };
  }
  if (linkEvent) await confirmLinkPreview(config, options.expectedPreview, payload);
  await assertDataSnapshot(config, selection.input_fingerprint);
  await assertOwned();

  if (!linkEvent && existing && String(existing.apple_music_song_id) === appleSongId) {
    return { ...preview, saved: false, already_confirmed: true };
  }
  const songs = [...manual.filter((item) => String(item.melon_song_id) !== melonSongId), { ...record, manual_confirmed_at: new Date().toISOString(),
    ...(linkEvent ? { approved_link_release_preview_hash: options.expectedPreview } : {}) }];
  await writeJsonAtomic(config.files.manualMatches, {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    songs
  });
  return { ...preview, saved: true, manual_matches: songs.length };
}

export async function localStatus(config) {
  const browser = await resolveBrowserRuntime(config);
  const selection = await readMatchSelection(config);
  const { sourceDocument, matchedDocument, unmatchedDocument, decisionsDocument, records } = selection;
  const sourceIds = sourceDocument ? new Set((sourceDocument.songs ?? []).map((song) => String(song.melon_song_id))) : null;
  const allManual = selection.manualDocument.songs ?? [];
  const matched = records.filter((record) => record.match_status === "matched");
  const manual = records.filter((record) => record.match_status === "manual_confirmed");
  const linked = records.filter(record => record.match_status === "linked_existing");
  const unresolved = records.filter((record) => !["matched", "manual_confirmed", "linked_existing"].includes(record.match_status));
  const held = unresolved.filter((record) => record.match_status === "held");
  const processedIds = new Set(records.map((record) => String(record.melon_song_id)));
  const unprocessed = sourceIds ? [...sourceIds].filter((id) => !processedIds.has(id)).length : null;
  const operations = {};
  for (const [name, file] of [["extraction", config.files.extractionRun], ["matching", config.files.matchingRun], ["review", config.files.reviewRun]]) {
    const state = await readRunState(file);
    const fingerprint = name === "review" ? reviewSourceFingerprint(sourceDocument) : sourceFingerprint(sourceDocument?.songs ?? []);
    operations[name] = state?.source_fingerprint && sourceDocument && state.source_fingerprint !== fingerprint
      ? { ...state, status: "stale" } : state;
  }
  if (operations.review?.result_fingerprint
    && operations.review.result_fingerprint !== reviewFingerprint(matchedDocument, unmatchedDocument, allManual, decisionsDocument.decisions, selection.linksDocument.events, selection.unavailableDocument.mappings, selection.recoveryDocument.transactions)) {
    operations.review = { ...operations.review, status: "stale" };
  }
  operations.apply = await readApplyRun(`${config.files.importState}.run.json`);
  const importState = await readJson(config.files.importState, null);
  const selectedIds = [...new Set(selection.selected
    .map((record) => record.apple_music_song_id)
    .filter(Boolean)
    .map(String))];
  const addedIds = selection.recoveries.history;
  return {
    browser,
    source: {
      present: Boolean(sourceDocument),
      count: sourceDocument?.songs?.length ?? 0,
      unavailable_count: sourceDocument?.unavailable_songs?.length ?? 0,
      accounted_count: new Set([...(sourceDocument?.songs ?? []), ...(sourceDocument?.unavailable_songs ?? [])]
        .map((song) => String(song.melon_song_id))).size,
      verified_row_count: sourceDocument?.checkpoint?.combined_verified_scan?.raw_row_count
        ?? sourceDocument?.checkpoint?.verified_scan?.raw_row_count ?? null,
      base_verified_row_count: sourceDocument?.checkpoint?.verified_scan?.raw_row_count ?? null,
      supplemental_unique_count: sourceDocument?.checkpoint?.combined_verified_scan?.supplemental_unique_count ?? 0,
      verified_unique_count: sourceDocument?.extraction?.verified_unique_count ?? null,
      reported_count_gap: sourceDocument?.extraction?.reported_count_gap ?? null,
      verified_page_count: sourceDocument?.checkpoint?.verified_scan?.pages?.length ?? null,
      complete: Boolean(sourceDocument?.complete),
      total_reported: sourceDocument?.source?.total_reported ?? null,
      next_start_index: sourceDocument?.checkpoint?.next_start_index ?? null,
      stop_reason: sourceDocument?.extraction?.stop_reason ?? operations.extraction?.stop_reason ?? null
    },
    matching: {
      processed: sourceIds ? sourceIds.size - unprocessed : processedIds.size,
      unprocessed,
      complete: Boolean(sourceDocument && unprocessed === 0),
      automatic_matched: matched.length,
      manual_confirmed: manual.length,
      linked_existing: linked.length,
      resolved_sources: matched.length + manual.length + linked.length,
      stale_links: selection.links.stale.filter(event => event.action === "link").length,
      cancelled_links_requiring_review: selection.links.stale.filter(event => event.action === "unlink").length,
      orphan_links: selection.links.orphan.length,
      ambiguous: unresolved.filter((record) => record.match_status === "ambiguous").length,
      not_found: unresolved.filter((record) => record.match_status === "not_found").length,
      unresolved: unresolved.length,
      held: held.length,
      revised: records.filter((record) => record.match_source === "manual-user-revised-itunes-lookup-kr").length,
      stale_decisions: records.filter((record) => record.decision_stale).length
    },
    unavailable_matching: {
      stored: selection.unavailableDocument.mappings.length,
      approved: selection.unavailableRecords.filter(record => record.match_status === "manual_confirmed").length,
      linked_existing: selection.links.unavailable.size,
      stale: selection.unavailableRecords.filter(record => record.unavailable_mapping_stale).length,
      duplicates: selection.unavailableRecords.filter(record => record.unavailable_mapping_duplicate).length,
      unresolved: (sourceDocument?.unavailable_songs ?? []).filter(song => !selection.unavailableRecords.some(record =>
        String(record.melon_song_id) === String(song.melon_song_id) && ["manual_confirmed", "linked_existing"].includes(record.match_status))).length
    },
    apply: {
      backend: importState?.backend ?? null,
      storefront: importState?.storefront ?? config.storefront,
      playlist_created: Boolean(importState?.playlist_id),
      selected_unique: selectedIds.length,
      checkpoint_added: selectedIds.filter((id) => addedIds.has(id)).length,
      checkpoint_total_unique: addedIds.size,
      checkpoint_raw_total_unique: new Set(importState?.added_song_ids ?? []).size,
      recovered_sources: selection.recoveries.sources.size,
      ...(selection.followupDocument.transactions.length ? { confirmed_followups: selection.followupDocument.transactions.filter(t => t.events.at(-1).type === "confirmed").length } : {}),
      unresolved_recoveries: selection.recoveries.unresolved.length,
      execution_blocked: selection.recoveries.unresolved.length > 0,
      pending: selectedIds.filter((id) => !addedIds.has(id)).length
    },
    operations,
    remote_validation: {
      checked: false,
      command: "apply --check --backend official|web-player"
    },
    summary: !sourceDocument ? "원본 파일이 없습니다. melon-extract부터 실행하세요."
      : `원본 전체 추출 ${sourceDocument.complete ? "완료" : "미완료"} · 미처리 ${unprocessed}곡 · 미결 ${unresolved.length}곡(보류 ${held.length} 포함) · 승인 범위 로컬 추가 대기 ${selectedIds.filter((id) => !addedIds.has(id)).length}곡 · 미해결 복구 ${selection.recoveries.unresolved.length}곡 · 원격 미검증`,
    next_commands: !sourceDocument ? ["melon-extract"] : [
      ...(unprocessed ? ["match"] : []), ...(unresolved.length ? ["review"] : []),
      `apply --check --backend ${importState?.backend ?? "official"}`
    ]
  };
}

function stateBackend(state) {
  return state?.backend ?? "official";
}

function assertStateMatches(state, backend, storefront) {
  if (!state) return;
  if (stateBackend(state) !== backend) {
    throw new Error(`저장된 import state backend(${stateBackend(state)})가 선택한 backend(${backend})와 다릅니다.`);
  }
  if (state.storefront && String(state.storefront).toLowerCase() !== storefront) {
    throw new Error(`저장된 import state storefront(${state.storefront})가 현재 storefront(${storefront})와 다릅니다.`);
  }
}

function catalogIdsFromTracks(tracks) {
  return new Set((tracks ?? []).map((track) => track?.catalog_id).filter(Boolean).map(String));
}

function playlistDiagnostics(tracks, selectedIds, checkpointIds) {
  const counts = new Map();
  let unmapped = 0;
  for (const track of tracks) {
    if (!track?.catalog_id) { unmapped++; continue; }
    const id = String(track.catalog_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const known = new Set([...selectedIds, ...checkpointIds]);
  return { track_count: tracks.length, catalog_unique_count: counts.size, unmapped_track_count: unmapped,
    duplicate_catalog_ids: [...counts].filter(([, count]) => count > 1).map(([id, occurrences]) => ({ id, occurrences })),
    extra_catalog_ids: [...counts.keys()].filter((id) => !known.has(id)),
    uncheckpointed_catalog_ids: [...counts.keys()].filter((id) => !checkpointIds.has(id)) };
}

function catalogIdsFromPreflight(resources) {
  return new Set((resources ?? []).map((resource) =>
    typeof resource === "string" ? resource : resource?.id
  ).filter(Boolean).map(String));
}

function applyLimit(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("apply의 --limit은 1 이상의 정수여야 합니다.");
  }
  return value;
}

export async function applyPlaylist(config, options = {}) {
  if (options.execute && options.check) throw new Error("--execute와 --check는 함께 사용할 수 없습니다.");
  const maxAdd = options.maxAdd ?? null;
  if (maxAdd != null && (!Number.isSafeInteger(maxAdd) || maxAdd <= 0)) {
    throw new Error("apply의 --max-add는 1 이상의 안전한 정수여야 합니다.");
  }
  if (!options.execute) return applyPlaylistUnlocked(config, options);
  const locks = [];
  let run;
  let phase = "starting";
  let confirmedAdded = 0;
  const assertOwned = async () => { for (const lock of locks) await lock.assertOwned(); };
  const lockPlaylist = async (id) => {
    locks.push(await acquireApplyLock(playlistTarget(id), config.applyLockDir));
  };
  const progress = async (nextPhase, added = confirmedAdded) => {
    await assertOwned();
    phase = nextPhase;
    confirmedAdded = added;
    await run.update({ phase, confirmed_added: confirmedAdded });
  };
  try {
    locks.push(...await acquireDataLocks(config));
    run = await startRun(`${config.files.importState}.run.json`, { phase, confirmed_added: 0,
      lock_path: locks[0].lockPath, lock_nonce: locks[0].nonce });
    const state = await readJson(config.files.importState);
    if (state?.playlist_id) await lockPlaylist(state.playlist_id);
    const result = await applyPlaylistUnlocked(config, options, { assertOwned, progress, lockPlaylist });
    await assertOwned();
    await run.finish("completed", { phase: "finished", confirmed_added: confirmedAdded, stop_reason: "apply_completed" });
    return result;
  } catch (error) {
    if (run) {
      try {
        await assertOwned();
        await run.finish("failed", { phase, confirmed_added: confirmedAdded,
          stop_reason: error.code === "APPLE_MUSIC_WRITE_AMBIGUOUS" ? "ambiguous_remote_write" :
            error.code === "APPLY_SELECTION_CHANGED" ? "selection_changed" :
            error instanceof ApplyLockError ? "target_locked" : ({
              starting: "apply_setup_failed", validating: "apply_validation_failed",
              creating_playlist: "playlist_creation_failed", adding_batch: "track_add_failed",
              confirming_batch: "batch_confirmation_failed", saving_checkpoint: "checkpoint_save_failed"
            }[phase] ?? "apply_failed") });
      } catch { /* Do not overwrite another owner's run state. */ }
    }
    // Never propagate adapter diagnostics into CLI logs.
    if (error instanceof ApplyLockError || error instanceof UnresolvedRecoveryError || error.code === "APPLY_SELECTION_CHANGED") throw error;
    throw new Error(`Apple 적용 실패 (단계: ${phase}). 인증/응답 진단은 기록하지 않았습니다.`);
  } finally {
    let releaseError;
    for (const lock of locks.reverse()) {
      try { await lock.release(); } catch (error) { releaseError ??= error; }
    }
    if (releaseError) throw new ApplyLockError("Apple 적용 잠금 해제를 확인할 수 없습니다. 소유권 불명확 잠금을 보존했습니다.", "APPLY_LOCK_RELEASE_FAILED");
  }
}

async function applyPlaylistUnlocked(config, options = {}, execution = null) {
  if (options.execute && options.check) throw new Error("--execute와 --check는 함께 사용할 수 없습니다.");
  const maxAdd = options.maxAdd ?? null;
  const selectNew = (ids) => maxAdd == null ? ids : ids.slice(0, maxAdd);
  const selection = await readMatchSelection(config);
  if (options.execute && selection.recoveries.unresolved.length) throw new UnresolvedRecoveryError();
  let linkValidation = null;
  const additionSummary = (eligible, selected) => ({
    source: sourceSummary(selection),
    ...(selection.recoveries.protectedSources.size ? { recovery: { confirmed: selection.recoveries.sources.size, unresolved: selection.recoveries.unresolved.map(r => ({
      melon_song_id: r.melon_song_id, old_apple_music_song_id: r.old_catalog.id, new_apple_music_song_id: r.new_catalog.id,
      status: "unresolved", recovery_id: r.recovery_id })), execution_blocked: selection.recoveries.unresolved.length > 0,
      ...(selection.followupDocument.transactions.length ? { confirmed_followups: selection.followupDocument.transactions.filter(t => t.events.at(-1).type === "confirmed").length } : {}) } } : {}),
    ...(selection.linksDocument.events.length ? { linked_existing: selection.links.active.length,
      linked_remote_validation: linkValidation ?? { checked: false } } : {}),
    selected_add_songs: selected.map((id) => {
      const records = selection.selected.filter((song) => String(song.apple_music_song_id) === id);
      return { apple_music_song_id: id, apple_music_title: records[0]?.apple_music_title ?? null,
        apple_music_artist: records[0]?.apple_music_artist ?? null,
        melon_songs: records.map((song) => ({ melon_song_id: song.melon_song_id ?? null,
          title: song.title ?? null, artist: song.artist ?? null, album: song.album ?? null })) };
    }),
    ...(maxAdd == null ? {} : { max_add: maxAdd, eligible_new: eligible.length,
      deferred_new: eligible.length - selected.length, selected_add_song_ids: selected })
  });
  const allSongIds = [...new Set(selection.selected
    .filter((song) => ["matched", "manual_confirmed"].includes(song.match_status) && song.apple_music_song_id)
    .map((song) => String(song.apple_music_song_id)))];
  if (!allSongIds.length) throw new Error("추가할 matched 곡이 없습니다.");
  const limit = applyLimit(options.limit);
  const songIds = limit == null ? allSongIds : allSongIds.slice(0, limit);

  const backend = resolveWriteBackend(options.backend);
  const storefront = config.storefront.toLowerCase();
  const name = options.name || "Melon Likes Import";
  const existingState = await readJson(config.files.importState, null);
  assertStateMatches(existingState, backend, storefront);
  const alreadyAdded = selection.recoveries.history;
  const pending = songIds.filter((id) => !alreadyAdded.has(id));
  if (!options.execute && !options.check) {
    const selected = selectNew(pending);
    const result = {
      dry_run: true,
      backend,
      storefront,
      playlist_name: existingState?.playlist_name ?? name,
      playlist_already_created: Boolean(existingState?.playlist_id),
      matched_unique: allSongIds.length,
      already_added: songIds.length - pending.length,
      would_add: selected.length,
      remote_checked: false,
      plan_basis: "local_checkpoint",
      ...additionSummary(pending, selected)
    };
    if (limit != null) {
      result.apply_limit = limit;
      result.selected_unique = songIds.length;
    }
    return result;
  }

  await execution?.progress("validating");
  const adapter = options.writeAdapter ?? await createAppleMusicWriteAdapter(config, { backend });
  if (adapter.backend !== backend) {
    throw new Error(`주입된 write adapter backend(${adapter.backend})가 선택한 backend(${backend})와 다릅니다.`);
  }
  const read = async (method, ...args) => {
    try { return await adapter[method](...args); }
    catch (error) {
      if (!selection.linksDocument.events.length) throw error;
      throw new ExistingLinkError("기존 연결의 읽기 전용 검사가 실패했습니다. 인증/응답 진단은 출력하지 않았습니다.");
    }
  };
  const session = await read("validateSession");
  const sessionStorefront = String(session?.storefront ?? await read("getStorefront")).toLowerCase();
  if (sessionStorefront !== storefront) {
    throw new Error(`Apple Music 계정 storefront(${sessionStorefront})가 설정 storefront(${storefront})와 다릅니다.`);
  }

  let state = existingState;
  let playlistTrackIds = new Set();
  let playlistTracks = [];
  let playlistResource = null;
  let recoveryValidation = null;
  if (state?.playlist_id) {
    const playlist = await read("getLibraryPlaylist", state.playlist_id);
    playlistResource = playlist;
    if (!playlist) throw new Error("저장된 Apple Music 플레이리스트가 선택한 backend에 존재하지 않습니다.");
    if (!playlist.canEdit) throw new Error("저장된 Apple Music 플레이리스트를 선택한 backend에서 편집할 수 없습니다.");
    playlistTracks = await read("getPlaylistTracks", state.playlist_id, { requireComplete: selection.linksDocument.events.length > 0 || selection.recoveries.protectedSources.size > 0 });
    playlistTrackIds = catalogIdsFromTracks(playlistTracks);
    const missingCheckpointIds = [...selection.recoveries.required].filter((id) => !playlistTrackIds.has(String(id)));
    if (missingCheckpointIds.length) {
      throw new Error("저장된 checkpoint와 실제 플레이리스트 내용이 다릅니다. 자동 재추가하지 않고 중단합니다.");
    }
    recoveryValidation = await validateRecoveryRemote(selection, adapter, playlistTracks, state);
  }

  const verifiedIds = catalogIdsFromPreflight(await read("validateCatalogSongs", songIds));
  if (selection.linksDocument.events.length) {
    const linkedReader = { backend: adapter.backend, ...Object.fromEntries(["getLibraryPlaylist", "getPlaylistTracks", "getLibrarySong", "validateCatalogSongs"]
      .map(method => [method, (...args) => read(method, ...args)])) };
    try { linkValidation = { checked: true, results: await validateActiveLinks(selection, existingState, linkedReader, { playlist: playlistResource, tracks: playlistTracks, recoveryValidation }) }; }
    catch (error) {
      if (error instanceof ExistingLinkError) throw error;
      throw new Error("기존 연결의 읽기 전용 검사가 실패했습니다. 인증/응답 진단은 출력하지 않았습니다.");
    }
  }
  await assertDataSnapshot(config, selection.input_fingerprint);
  const unverifiedIds = songIds.filter((id) => !verifiedIds.has(id));
  if (!verifiedIds.size && maxAdd == null) throw new Error("선택한 storefront에서 playParams까지 검증된 catalog song이 없습니다.");

  // Share the ordered, remotely reconciled selection between check and execute.
  const eligibleNew = songIds.filter((id) => verifiedIds.has(id)
    && !playlistTrackIds.has(id) && (maxAdd == null || !alreadyAdded.has(id)));
  const pendingVerified = selectNew(eligibleNew);
  if (options.execute && options.expectedAddSongIds
    && JSON.stringify(pendingVerified) !== JSON.stringify(options.expectedAddSongIds.map(String))) {
    const error = new Error("승인한 미리보기와 이번 추가 대상이 다릅니다. 계정을 변경하지 않았습니다. sync를 다시 실행해 새 미리보기를 확인하세요.");
    error.code = "APPLY_SELECTION_CHANGED";
    throw error;
  }

  if (options.check) {
    const serverPresent = songIds.filter((id) => playlistTrackIds.has(id));
    const checkpointIds = songIds.filter((id) => alreadyAdded.has(id));
    return {
      check: true,
      dry_run: true,
      remote_checked: true,
      backend,
      storefront,
      playlist_name: existingState?.playlist_name ?? name,
      playlist_exists: Boolean(existingState?.playlist_id),
      playlist_editable: Boolean(existingState?.playlist_id),
      matched_unique: allSongIds.length,
      verified_catalog: verifiedIds.size,
      skipped_unverified: unverifiedIds.length,
      checkpoint_added: checkpointIds.length,
      server_present: serverPresent.length,
      server_uncheckpointed: serverPresent.filter((id) => !alreadyAdded.has(id)).length,
      pending_verified: pendingVerified.length,
      playlist_diagnostics: playlistDiagnostics(playlistTracks, allSongIds, alreadyAdded),
      ...additionSummary(eligibleNew, pendingVerified),
      ...(limit == null ? {} : { apply_limit: limit, selected_unique: songIds.length })
    };
  }

  if (!state?.playlist_id && maxAdd != null && !pendingVerified.length) {
    return {
      dry_run: false,
      backend,
      storefront,
      playlist_id: null,
      playlist_name: name,
      verified_catalog: verifiedIds.size,
      skipped_unverified: unverifiedIds.length,
      added_total: alreadyAdded.size,
      added_this_run: 0,
      ...additionSummary(eligibleNew, pendingVerified),
      ...(limit == null ? {} : { apply_limit: limit, selected_unique: songIds.length })
    };
  }

  if (!state?.playlist_id) {
    await execution?.progress("creating_playlist");
    const playlist = await adapter.createLibraryPlaylist(
      name,
      "High-confidence matches imported from Melon likes by melon-to-apple-music."
    );
    await execution?.lockPlaylist(playlist.id);
    state = {
      schema_version: 2,
      backend,
      storefront,
      playlist_id: playlist.id,
      playlist_name: name,
      created_at: new Date().toISOString(),
      added_song_ids: []
    };
    await execution?.assertOwned();
    await writeJsonAtomic(config.files.importState, state);
    const savedPlaylist = await adapter.getLibraryPlaylist(state.playlist_id);
    if (!savedPlaylist?.canEdit) {
      throw new Error("새 Apple Music 플레이리스트의 존재와 편집 가능 상태를 확인할 수 없습니다.");
    }
  }

  const completed = new Set(alreadyAdded);
  for (const id of playlistTrackIds) {
    if (verifiedIds.has(id)) completed.add(id);
  }
  const metadataNeedsUpdate = state.schema_version !== 2
    || state.backend !== backend
    || state.storefront !== storefront
    || completed.size !== (state.added_song_ids ?? []).length;
  if (metadataNeedsUpdate) {
    state = {
      ...state,
      schema_version: 2,
      backend,
      storefront,
      updated_at: new Date().toISOString(),
      added_song_ids: [...completed]
    };
    await execution?.assertOwned();
    await writeJsonAtomic(config.files.importState, state);
  }
  let addedThisRun = 0;
  for (let offset = 0; offset < pendingVerified.length; offset += 100) {
    const batch = pendingVerified.slice(offset, offset + 100);
    await execution?.progress("adding_batch", addedThisRun);
    await adapter.addTracks(state.playlist_id, batch);
    await execution?.progress("confirming_batch", addedThisRun);
    const confirmed = catalogIdsFromTracks(await adapter.getPlaylistTracks(state.playlist_id));
    if (!batch.every((id) => confirmed.has(id))) {
      throw new Error("곡 추가 후 실제 플레이리스트 내용을 확인할 수 없어 checkpoint를 저장하지 않았습니다.");
    }
    for (const id of batch) completed.add(id);
    addedThisRun += batch.length;
    await execution?.progress("saving_checkpoint", addedThisRun);
    state = {
      ...state,
      schema_version: 2,
      backend,
      storefront,
      updated_at: new Date().toISOString(),
      added_song_ids: [...completed]
    };
    await execution?.assertOwned();
    await writeJsonAtomic(config.files.importState, state);
    console.log(`Apple Music 플레이리스트 확인 완료: ${completed.size}/${verifiedIds.size}곡`);
  }
  return {
    dry_run: false,
    backend,
    storefront,
    playlist_id: state.playlist_id,
    playlist_name: state.playlist_name,
    verified_catalog: verifiedIds.size,
    skipped_unverified: unverifiedIds.length,
    added_total: completed.size,
    added_this_run: addedThisRun,
    ...additionSummary(eligibleNew, pendingVerified),
    ...(limit == null ? {} : { apply_limit: limit, selected_unique: songIds.length })
  };
}
