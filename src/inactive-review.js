import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./io.js";
import { readMatchSelection } from "./match-decisions.js";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && /^[1-9]\d*$/.test(value);
const required = (value, label) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${label}이 필요합니다.`); };
const escape = value => String(value ?? "미확인").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function publicUrl(value, host) {
  let url;
  try { url = new URL(value); } catch { throw new Error("출처 URL이 잘못되었습니다."); }
  if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) {
    throw new Error("공식 HTTPS 출처 URL이 필요합니다.");
  }
  return url;
}

function validateInput(document) {
  if (!object(document) || document.schema_version !== 1 || document.source_kind !== "inactive" || !Array.isArray(document.records)) {
    throw new Error("비활성 입력 schema_version=1, source_kind=inactive, records 배열이 필요합니다.");
  }
  const seen = new Set();
  for (const record of document.records) {
    if (!object(record) || record.source_kind !== "inactive" || !id(record.melon_song_id)) throw new Error("비활성 원곡 종류와 문자열 ID가 필요합니다.");
    if (seen.has(record.melon_song_id)) throw new Error(`중복 비활성 ID: ${record.melon_song_id}`);
    seen.add(record.melon_song_id);
    if (!object(record.metadata)) throw new Error("복원 metadata가 필요합니다.");
    for (const field of ["title", "artist", "album"]) required(record.metadata[field], `metadata.${field}`);
    if (!id(record.metadata.album_id)) throw new Error("원앨범 문자열 ID가 필요합니다.");
    if (record.metadata.isrc != null && (typeof record.metadata.isrc !== "string" || !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(record.metadata.isrc))) throw new Error("원본 ISRC가 잘못되었습니다.");
    if (record.metadata.duration_ms != null && (!Number.isSafeInteger(record.metadata.duration_ms) || record.metadata.duration_ms <= 0)) throw new Error("원본 곡 길이가 잘못되었습니다.");
    if (record.metadata.content_rating != null && !["explicit", "clean", "not_explicit"].includes(record.metadata.content_rating)) throw new Error("원본 등급이 잘못되었습니다.");
    if (!object(record.provenance)) throw new Error("출처 provenance가 필요합니다.");
    const songUrl = publicUrl(record.provenance.song_url, "www.melon.com");
    const albumUrl = publicUrl(record.provenance.album_url, "www.melon.com");
    if (songUrl.pathname !== "/song/detail.htm" || songUrl.searchParams.get("songId") !== record.melon_song_id
      || albumUrl.pathname !== "/album/detail.htm" || albumUrl.searchParams.get("albumId") !== record.metadata.album_id) {
      throw new Error("출처의 원곡·앨범 ID가 입력과 다릅니다.");
    }
    if (typeof record.provenance.checked_at !== "string" || !Number.isFinite(Date.parse(record.provenance.checked_at))) throw new Error("출처 조회 시각이 필요합니다.");
    required(record.provenance.method, "출처 수집 방법");
    if (!Array.isArray(record.uncertainties) || !record.uncertainties.length || record.uncertainties.some(x => typeof x !== "string" || !x.trim())) {
      throw new Error("불확실성·보류 사유 배열이 필요합니다.");
    }
    if (!Array.isArray(record.candidates)) throw new Error("후보 배열이 필요합니다.");
    const candidateIds = new Set();
    for (const candidate of record.candidates) {
      if (!object(candidate) || !id(candidate.id) || candidateIds.has(candidate.id)) throw new Error("후보 ID가 잘못됐거나 중복되었습니다.");
      candidateIds.add(candidate.id);
      for (const field of ["title", "artist", "album"]) required(candidate[field], `candidate.${field}`);
      const url = publicUrl(candidate.url, "music.apple.com");
      const targetId = url.searchParams.get("i") ?? url.pathname.split("/").filter(Boolean).at(-1);
      if (!url.pathname.startsWith("/kr/") || targetId !== candidate.id) throw new Error("후보의 한국 Apple URL과 ID가 다릅니다.");
      if (candidate.duration_ms != null && (!Number.isSafeInteger(candidate.duration_ms) || candidate.duration_ms <= 0)) throw new Error("후보 곡 길이가 잘못되었습니다.");
      if (candidate.isrc != null && (typeof candidate.isrc !== "string" || !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(candidate.isrc))) throw new Error("후보 ISRC가 잘못되었습니다.");
      if (candidate.content_rating != null && !["explicit", "clean", "not_explicit"].includes(candidate.content_rating)) throw new Error("후보 등급이 잘못되었습니다.");
    }
    // This first stage accepts evidence only, never a caller's executable decision.
    if (["approved", "ready", "apply_eligible"].some(k => record[k] === true)
      || record.status && !["needs_evidence", "held"].includes(record.status)) throw new Error("승인·적용 상태를 비활성 검토 입력으로 받을 수 없습니다.");
  }
  return document;
}

// Explicit adapter for the saved 22-item research artifact; normal rows are not imported.
export function inactiveInputFromAudit(document) {
  if (!object(document?.summary?.exact_scope) || !Array.isArray(document.summary.exact_scope.inactive7) || !Array.isArray(document.rows)) {
    throw new Error("22개 조사 산출물의 exact_scope와 rows가 필요합니다.");
  }
  const records = document.rows.filter(row => row?.group === "inactive7").map(row => {
    const source = row.current_public_source;
    return {
      source_kind: "inactive", melon_song_id: row.source_id, status: "needs_evidence",
      metadata: { title: source?.title, artist: source?.artists?.map(x => x.name).join(", "), album: source?.fields?.앨범,
        album_id: source?.album_id, isrc: source?.isrc ?? null, duration_ms: source?.duration_ms ?? null, content_rating: source?.content_rating ?? null },
      provenance: { song_url: source?.url, album_url: `https://www.melon.com/album/detail.htm?albumId=${source?.album_id}`,
        checked_at: source?.at, method: "saved-official-public-metadata", evidence_references: row.evidence_references },
      candidates: row.current_candidates, uncertainties: row.uncertainties,
      review_evidence: row // Preserve the complete source, comparison, limits and prior references.
    };
  });
  const wanted = document.summary.exact_scope.inactive7;
  if (new Set(wanted).size !== wanted.length || records.length !== wanted.length
    || records.some(record => !wanted.includes(record.melon_song_id))) throw new Error("비활성 조사 범위와 행 ID가 다릅니다.");
  return validateInput({ schema_version: 1, source_kind: "inactive", records });
}

export async function readInactiveReview(config, options = {}) {
  required(options.inputFile, "--input-file");
  const inputPath = path.resolve(options.inputFile);
  const original = await readJson(inputPath);
  const input = original?.schema_version === 1 ? validateInput(original) : inactiveInputFromAudit(original);
  const selection = await readMatchSelection(config);
  if (!selection.sourceDocument) throw new Error("원본 추출 파일이 필요합니다.");
  const unavailable = selection.sourceDocument.unavailable_songs ?? [];
  const normalIds = new Set(selection.sourceDocument.songs.map(row => String(row.melon_song_id)));
  const occurrences = new Map();
  for (const row of unavailable) {
    if (!id(row.melon_song_id)) throw new Error("원본 비활성 ID가 잘못되었습니다.");
    occurrences.set(row.melon_song_id, (occurrences.get(row.melon_song_id) ?? 0) + 1);
  }
  const checkpoint = await readJson(config.files.importState, { added_song_ids: [] });
  if (!Array.isArray(checkpoint?.added_song_ids)) throw new Error("체크포인트 ID 배열이 잘못되었습니다.");
  const imported = new Set(checkpoint.added_song_ids.map(String));
  const selectedIds = new Set(selection.selected.map(row => row.apple_music_song_id));
  const uses = new Map();
  for (const row of input.records) for (const candidate of row.candidates) {
    uses.set(candidate.id, [...(uses.get(candidate.id) ?? []), row.melon_song_id]);
  }
  const rows = input.records.map(record => {
    if (normalIds.has(record.melon_song_id)) throw new Error(`일반 목록 혼입: ${record.melon_song_id}`);
    if (occurrences.get(record.melon_song_id) !== 1) throw new Error(`원본 비활성 ID가 없거나 중복되었습니다: ${record.melon_song_id}`);
    const observed = unavailable.find(row => row.melon_song_id === record.melon_song_id);
    if (observed.reason !== "disabled_no_result") throw new Error("지원하지 않는 비활성 관찰 원인입니다.");
    return { ...record, metadata_revision: digest(record), observed_disabled_record: observed,
      observation_fingerprint: digest(observed), status: record.status ?? "needs_evidence", approved: false, apply_eligible: false,
      recording_identity: "unproven", remote_revalidated: false,
      review_blockers: [...record.uncertainties, "읽기 전용 검토 단계: 승인·추가·연결 실행 미지원"],
      candidate_checks: record.candidates.map(candidate => ({ apple_id: candidate.id,
        checkpoint_present: imported.has(candidate.id), normal_selection_present: selectedIds.has(candidate.id),
        inactive_source_ids: uses.get(candidate.id), duplicate_target: uses.get(candidate.id).length > 1 })) };
  });
  if (options.melonSongId != null && (!id(options.melonSongId) || !rows.some(row => row.melon_song_id === options.melonSongId))) {
    throw new Error("입력에 없는 비활성 --melon-song-id입니다.");
  }
  return { schema_version: 1, source_kind: "inactive", input_revision: digest(input), source_snapshot: selection.input_fingerprint,
    summary: { observed_disabled: unavailable.length, input_records: rows.length, review_records: options.melonSongId ? 1 : rows.length,
      apply_eligible: 0, approved: 0, account_changed: false, operational_data_changed: false, remote_checked: false },
    input, rows: options.melonSongId ? rows.filter(row => row.melon_song_id === options.melonSongId) : rows };
}

export function renderInactiveReview(report) {
  const rows = report.rows.map(row => `<article><h2>${escape(row.melon_song_id)} · ${escape(row.metadata.title)}</h2>
<p>${escape(row.metadata.artist)} / ${escape(row.metadata.album)} · 원본 관찰 ${escape(row.observed_disabled_record.reason)} · 상태 ${escape(row.status)}</p>
<p>복원 출처: <a href="${escape(row.provenance.song_url)}">Melon 곡 상세</a> / <a href="${escape(row.provenance.album_url)}">원앨범</a> · ${escape(row.provenance.checked_at)}</p>
<p>원본 ISRC ${escape(row.metadata.isrc)} · 길이 ${escape(row.metadata.duration_ms)} · 등급 ${escape(row.metadata.content_rating)} · 녹음 일치 미입증</p>
<ul>${row.review_blockers.map(reason => `<li>${escape(reason)}</li>`).join("")}</ul>
<table><thead><tr><th>후보</th><th>가수 / 앨범</th><th>ISRC / 길이 / 등급</th><th>로컬 중복</th></tr></thead><tbody>${row.candidates.map(candidate => {
    const check = row.candidate_checks.find(x => x.apple_id === candidate.id);
    return `<tr><td><a href="${escape(candidate.url)}">${escape(candidate.id)} · ${escape(candidate.title)}</a></td><td>${escape(candidate.artist)} / ${escape(candidate.album)}</td><td>${escape(candidate.isrc)} / ${escape(candidate.duration_ms)}ms / ${escape(candidate.content_rating)}</td><td>checkpoint ${check.checkpoint_present} · 정상 선택 ${check.normal_selection_present} · 비활성 후보 중복 ${check.duplicate_target}</td></tr>`;
  }).join("")}</tbody></table><details><summary>전체 근거·복원 정보</summary><pre>${escape(JSON.stringify(row, null, 2))}</pre></details></article>`).join("");
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>비활성 읽기 전용 검토</title><style>body{font:16px system-ui;max-width:1100px;margin:auto;padding:24px}article{border-top:1px solid #ccc;padding:16px 0}table{border-collapse:collapse;width:100%}th,td{padding:8px;border:1px solid #ddd;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>비활성 읽기 전용 검토</h1><p>검토 ${report.summary.review_records}개 · 적용 가능 0개 · 승인 0개. 실제 추가·연결 기능은 없습니다. 공개 상세 조회는 좋아요 목록 활성화·동일 녹음 증명이 아닙니다. 외부 자료는 저장 당시 정보이며 이번 원격 검증이 아닙니다.</p>${rows}</html>\n`;
}

async function canonical(file) {
  try { return await realpath(file); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}
const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };

export async function exportInactiveReview(config, options = {}) {
  const report = await readInactiveReview(config, options);
  if (!options.outputDir) return report;
  const target = await canonical(path.resolve(options.outputDir));
  const forbidden = [config.dataDir, config.stateDir, ...["src", "test", "scripts", ".git", ".agents", ".codex", ".aws"].map(dir => path.join(config.root, dir))];
  for (const dir of forbidden) if (contains(await canonical(dir), target)) throw new Error("운영·코드 디렉터리에는 비활성 검토 자료를 저장할 수 없습니다.");
  const files = { "inactive-input.json": `${JSON.stringify(report.input, null, 2)}\n`,
    "inactive-review.json": `${JSON.stringify(report, null, 2)}\n`, "inactive-review.html": renderInactiveReview(report) };
  try {
    const names = await readdir(target);
    if (names.length !== Object.keys(files).length || Object.keys(files).some(name => !names.includes(name))) throw new Error("기존 출력 디렉터리를 덮어쓰지 않습니다.");
    for (const [name, content] of Object.entries(files)) if (await readFile(path.join(target, name), "utf8") !== content) throw new Error("출력 내용이 변경됐습니다. 새 --output-dir을 지정하세요.");
    return { ...report, output_dir: target, already_exported: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.${process.pid}.${cryptoRandom()}.tmp`;
  await mkdir(staging);
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(staging, name), content, { flag: "wx" });
    await rename(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { ...report, output_dir: target, already_exported: false };
}
const cryptoRandom = () => createHash("sha256").update(`${process.hrtime.bigint()}`).digest("hex").slice(0, 16);
