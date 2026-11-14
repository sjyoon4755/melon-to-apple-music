import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readSongDocument } from "./io.js";
import { sourceFingerprint } from "./run-state.js";

const UNRESOLVED = new Set(["ambiguous", "not_found"]);
const STATUS = { matched: "자동 확정", manual_confirmed: "수동 승인", ambiguous: "후보 검토 필요",
  not_found: "검색 미확정", held: "사용자 보류", unprocessed: "아직 검색하지 않음", linked_existing: "기존 이관 곡에 연결" };
const LINK_BASIS = { recording_evidence: "원곡·대상 ISRC 일치", user_accepted_uncertainty: "녹음 불확실성을 확인하고 수락",
  user_accepted_confirmed_anchor: "원본 제목·가수·참여 가수가 같은 수동 승인 기준 원곡에 연결" };
const LINK_UNCERTAINTIES = { source_isrc_unknown: "원곡 ISRC 미상", source_duration_unknown: "원곡 재생시간 미상",
  source_rating_unknown: "원곡 등급 미상", album_differs: "앨범 표기 차이", release_date_differs: "발매일 차이",
  target_isrc_unknown: "대상 ISRC 미상", target_duration_unknown: "대상 재생시간 미상", target_rating_unknown: "대상 등급 미상", duration_differs: "재생시간 차이",
  confirmed_anchor_recording_unverified: "수동 승인 기준 원곡을 사용하며 동일 녹음은 미입증" };
const REASONS = { below_threshold: "점수 기준 미달", insufficient_margin: "후보 간 점수 차이 부족",
  no_candidates: "저장 후보 없음", version_mismatch: "버전 차이", participant_information_missing: "참여 가수 정보 부족",
  participant_mismatch: "참여 가수 차이", guest_artist_information_missing: "피처링 정보 부족",
  guest_artist_mismatch: "피처링 차이", user_confirmed: "사용자 승인", user_hold: "사용자 보류",
  primary_artist_missing: "주 가수 정보 부족", guest_artist_role_conflict: "주 가수·피처링 역할 차이",
  alias_participant_count_conflict: "별칭의 참여 가수 수 차이", language_version_conflict: "언어 버전 차이",
  language_version_information_missing: "언어 버전 정보 부족", arrangement_version_conflict: "편곡 버전 차이",
  arrangement_version_information_missing: "편곡 버전 정보 부족",
  high_confidence: "자동 판정 기준 통과", needs_review: "추가 검토 필요",
  source_changed_since_confirmation: "승인 이후 원본 변경", not_searched: "아직 검색하지 않음" };
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const display = (value) => value == null || value === "" ? "정보 없음" : escape(value);
const score = (value) => Number.isFinite(value) ? value.toFixed(4) : "정보 없음";
const reasons = (values) => (values ?? []).map((value) => REASONS[value] ?? value).join(" · ") || "정보 없음";

function link(value, service, label = `${service} 곡 페이지`, missing = "링크 없음") {
  try {
    const url = new URL(value);
    const allowed = service === "Apple" ? url.hostname === "music.apple.com"
      : url.hostname === "melon.com" || url.hostname.endsWith(".melon.com");
    if (url.protocol === "https:" && allowed && !url.username && !url.password) {
      return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
  } catch { /* Missing and unsafe URLs are displayed without a link. */ }
  return missing;
}

function duration(value) {
  if (!Number.isFinite(value) || value <= 0) return "정보 없음";
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Alternate search results are report inputs only. Confirmed and held selections always take precedence.
export async function prepareReviewReport(config, selection, records, criteria, options = {}) {
  let alternate = new Map();
  let alternateCriteria = criteria;
  if (options.candidatesDir) {
    const dir = path.resolve(config.root, options.candidatesDir);
    const documents = await Promise.all(["matched.json", "unmatched.json"].map((name) => readSongDocument(path.join(dir, name))));
    if (documents.some((doc) => !Array.isArray(doc?.songs))) throw new Error("후보 디렉터리에 matched.json과 unmatched.json이 필요합니다.");
    const storedCriteria = documents.map((doc) => doc.match_config);
    if (storedCriteria.some((value) => !value || ![value.threshold, value.min_margin].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
      || storedCriteria[0].threshold !== storedCriteria[1].threshold || storedCriteria[0].min_margin !== storedCriteria[1].min_margin) {
      throw new Error("별도 후보 결과의 판정 기준이 없거나 서로 다릅니다.");
    }
    alternateCriteria = storedCriteria[0];
    for (const record of documents.flatMap((doc) => doc.songs)) {
      const id = String(record.melon_song_id ?? "");
      if (!id || alternate.has(id) || !["matched", "ambiguous", "not_found"].includes(record.match_status)) {
        throw new Error("별도 후보 결과의 곡 ID 또는 상태가 잘못되었거나 중복되었습니다.");
      }
      alternate.set(id, record);
    }
  }
  const source = new Map([...(selection.sourceDocument?.songs ?? []), ...(selection.sourceDocument?.unavailable_songs ?? [])]
    .map((song) => [String(song.melon_song_id), song]));
  const items = records.map((effective) => {
    const recent = UNRESOLVED.has(effective.match_status) ? alternate.get(String(effective.melon_song_id)) : null;
    const original = source.get(String(effective.melon_song_id)) ?? effective;
    if (recent && sourceFingerprint([original]) !== sourceFingerprint([recent])) {
      throw new Error(`별도 후보의 원곡 정보가 현재 원본과 다릅니다: ${effective.melon_song_id}`);
    }
    const record = recent ?? effective;
    const threshold = recent ? alternateCriteria.threshold : criteria.threshold;
    return { original, effective, record, criteria: recent ? alternateCriteria : criteria, recent: Boolean(recent),
      priority: UNRESOLVED.has(effective.match_status) && Number.isFinite(record.match_score) && record.match_score >= threshold };
  });
  items.sort((a, b) => Number(b.priority) - Number(a.priority)
    || Number(UNRESOLVED.has(b.effective.match_status)) - Number(UNRESOLVED.has(a.effective.match_status))
    || (b.record.match_score ?? -1) - (a.record.match_score ?? -1));
  return { items, sourceDocument: selection.sourceDocument, generatedAt: new Date().toISOString(), inputFingerprint: selection.input_fingerprint };
}

// Plain-language labels for why a top candidate is not offered for bulk selection.
const BULK_BLOCK = { below_threshold: "비슷한 정도가 낮음", version_mismatch: "버전이 다를 수 있음", no_candidates: "후보 없음" };
const doubtsOf = (candidate) => [...(candidate?.components?.qualifier_mismatch ? ["version_mismatch"] : []), ...(candidate?.components?.identity_reasons ?? [])];
// Summary lines show only what is known; the collapsed evidence table still says "정보 없음" explicitly.
const facts = (artist, album, length) => [artist, album].filter((value) => value != null && value !== "").map(escape)
  .concat(Number.isFinite(length) && length > 0 ? [duration(length)] : []).join(" · ");
const DECISIONS_COMMAND ='melon-to-apple-music resolve --decisions-file "$HOME/Downloads/review-decisions.json"';

// Bulk top-1 selection is offered only when the matcher itself raised no doubt about the leading candidate.
function topPick(item) {
  const top = (item.record.candidates ?? [])[0];
  if (!top?.id) return { id: "", blocked: BULK_BLOCK.no_candidates };
  const doubts = doubtsOf(top);
  if (!(Number.isFinite(top.score) && top.score >= item.criteria.threshold)) doubts.unshift("below_threshold");
  return { id: String(top.id), blocked: doubts.map((key) => BULK_BLOCK[key] ?? REASONS[key] ?? key).join(" · ") };
}

function choice(candidate, index, melonId) {
  const tags = [index === 0 ? `<span class="tag">가장 비슷함</span>` : "",
    ...doubtsOf(candidate).map((key) => `<span class="tag warn">${escape(REASONS[key] ?? key)}</span>`),
    candidate.content_rating === "explicit" ? `<span class="tag">청소년 이용 불가</span>` : ""].join("");
  const similarity = Number.isFinite(candidate.score) ? `<span>일치도 ${Math.round(candidate.score * 100)}%</span>` : "";
  return `<label class="choice"><input type="radio" name="pick-${escape(melonId)}" value="${escape(candidate.id)}">
    <span class="c-body"><span class="c-title">${display(candidate.title)}</span>
      <span class="c-meta">${facts(candidate.artist, candidate.album, candidate.duration_ms)}</span></span>
    <span class="c-side">${similarity}<span>${tags}</span>${link(candidate.url, "Apple", "Apple Music에서 보기 ↗", "")}</span></label>`;
}

function decisionControls(item, melonId) {
  const { original } = item;
  const candidates = (item.record.candidates ?? []).filter((candidate) => candidate.id);
  const { id, blocked } = topPick(item);
  const term = [original.title, original.artist].filter(Boolean).join(" ");
  const search = `https://music.apple.com/kr/search?term=${encodeURIComponent(term)}`;
  return `<div class="decide" data-melon="${escape(melonId)}" data-top="${escape(id)}" data-top-blocked="${escape(blocked)}">
    <fieldset><legend>${candidates.length ? "어느 곡이 같은 곡인가요?" : "비슷한 후보를 찾지 못했습니다. 직접 찾아 링크를 붙여 넣거나 건너뛰세요."}</legend>
    ${candidates.map((candidate, index) => choice(candidate, index, melonId)).join("")}
    <label class="choice other"><input type="radio" name="pick-${escape(melonId)}" value="__url">
      <span class="c-body"><span class="c-title">${candidates.length ? "목록에 없어요 · " : ""}Apple Music 링크 붙여 넣기</span>
        <span class="c-meta"><a href="${escape(search)}" target="_blank" rel="noopener noreferrer">Apple Music에서 이 곡 찾기 ↗</a> 후 곡의 공유 메뉴에서 링크를 복사해 붙여 넣으세요.</span>
        <input class="url" type="text" inputmode="url" placeholder="https://music.apple.com/kr/album/...?i=..." aria-label="Apple Music 곡 링크"></span></label>
    <label class="choice other"><input type="radio" name="pick-${escape(melonId)}" value="__skip">
      <span class="c-body"><span class="c-title">건너뛰기</span><span class="c-meta">이 곡은 옮기지 않습니다.</span></span></label>
    </fieldset><p class="pick-note" role="status"></p></div>`;
}

function metadata(title, artist, album, length, isrc, rating, url, service) {
  return `<td>${display(title)}</td><td>${display(artist)}</td><td>${display(album)}</td>
    <td>${duration(length)}</td><td>${display(isrc)}<br>${display(({ explicit: "청소년 이용 불가", not_explicit: "일반 등급" })[rating] ?? rating)}</td><td>${link(url, service)}</td>`;
}

function candidateRow(candidate, index) {
  const parts = candidate.components;
  const similarity = parts ? ["title", "artist", "album", "duration"].map((key, i) =>
    `${["제목", "가수", "앨범", "길이"][i]} ${score(parts[key])}`).join(" · ") : "정보 없음";
  const aliases = [candidate.title_aliases, candidate.artist_aliases, candidate.album_aliases].flatMap((values) => values ?? []);
  const people = (group) => group ? `주 가수: ${group.primary?.map((names) => names.join(" / ")).join(", ") || "표기 없음"}; 피처링: ${group.guests?.map((names) => names.join(" / ")).join(", ") || "표기 없음"}` : "정보 없음";
  const editions = (group) => group ? `언어: ${group.language?.join(", ") || "표기 없음"}; 편곡: ${group.arrangement?.join(", ") || "표기 없음"}` : "정보 없음";
  const evidence = `원곡 참여 가수: ${people(parts?.participants?.source)}\n후보 참여 가수: ${people(parts?.participants?.candidate)}\n원곡 버전: ${editions(parts?.editions?.source)}\n후보 버전: ${editions(parts?.editions?.candidate)}`;
  return `<tr><th scope="row">후보 ${index + 1}<br>ID ${display(candidate.id)}</th>
    ${metadata(candidate.title, candidate.artist, candidate.album, candidate.duration_ms, candidate.isrc, candidate.content_rating, candidate.url, "Apple")}
    <td>${score(candidate.score)}<small>${escape(similarity)}</small></td>
    <td>${escape(parts?.identity_reasons?.length === 0 ? "저장된 차이 사유 없음" : reasons(parts?.identity_reasons))}<details><summary>별칭·분석 근거</summary>
      <p>별칭: ${display(aliases.join(" / "))}</p><pre>${escape(evidence)}</pre></details></td></tr>`;
}

// Full evidence: the whole card for settled songs, a collapsed section under the choices for unresolved ones.
function evidence(item) {
  const { original, effective, record, recent, criteria } = item;
  const candidates = record.candidates ?? [];
  const count = record.candidate_count ?? (candidates.length === 5 ? "5+" : candidates.length);
  const truncated = String(count).endsWith("+") || Number(count) > candidates.length;
  const selected = ["matched", "manual_confirmed", "held", "linked_existing"].includes(effective.match_status) && effective.apple_music_song_id
    ? `<tr><th scope="row">${effective.match_status === "held" ? "보류 전 연결" : "현재 확정 연결"}<br>ID ${display(effective.apple_music_song_id)}</th>
      ${metadata(effective.apple_music_title, effective.apple_music_artist, effective.apple_music_album, effective.apple_music_duration_ms,
        effective.apple_music_isrc, effective.apple_music_content_rating, effective.apple_music_url, "Apple")}
      <td>${score(effective.match_score)}</td><td>${escape(reasons(effective.match_reasons))}</td></tr>` : "";
  return `${effective.recovery_id ? `<p>복구 이력 ${display(effective.recovery_id)}${effective.recovery_followup_id ? ` · 후속 이력 ${display(effective.recovery_followup_id)}` : ""} · 기존 Apple ID ${display(effective.recovery_old_apple_id)}<br>복구 사유: ${display(effective.recovery_reason)}<br>확인 시각: ${display(effective.recovery_confirmed_at)} · 원래 승인·checkpoint 이력 보존</p>` : ""}
    ${effective.source_availability === "unavailable" ? `<p>Melon 비활성 원곡의 별도 Apple 대응입니다. 원본 비활성 상태는 유지됩니다.${effective.unavailable_mapping_stale ? " 원본 변경 또는 누락으로 적용에서 제외됨." : ""}${effective.unavailable_mapping_duplicate ? " 다른 선택 곡과 중복되어 적용에서 제외됨." : ""}</p>` : ""}
    ${effective.public_evidence_file_sha256 ? `<details><summary>승인한 공개 메타데이터·출처</summary><p>공개 제목: ${display(effective.public_metadata_title)}<br>가수: ${display(effective.public_metadata_artist)}<br>앨범: ${display(effective.public_metadata_album)}<br>공개 자료 확인 시각: ${display(effective.public_metadata_checked_at)}<br>곡 출처: ${display(effective.public_metadata_song_url)}<br>앨범 출처: ${display(effective.public_metadata_album_url)}<br>근거 파일 SHA-256: ${display(effective.public_evidence_file_sha256)}<br>저장 근거 snapshot SHA-256: ${display(effective.public_evidence_document_sha256)}</p><p>추출 원본과 구분해 승인한 공개 정보입니다. 같은 녹음이나 현재 원격 재생 가능성을 증명하지 않습니다.</p></details>` : ""}
    ${effective.link_revision ? `<p>기준 원곡 ${display(effective.link_anchor_melon_song_id)} · 연결 사유: ${display(effective.link_reason)}<br>근거: ${display(LINK_BASIS[effective.link_identity_basis])}<br>수락한 불확실성: ${display((effective.link_uncertainties ?? []).map(key => LINK_UNCERTAINTIES[key] ?? key).join(", "))}<br>${effective.link_stale ? "연결 입력 변경 · 검토 필요" : "계정 재추가 없이 원곡 연결만 승인됨"} · 현재 원격 상태는 이 화면에서 검사하지 않았습니다.</p><details><summary>연결 승인 이력</summary><p>${display(effective.link_revision)}<br>승인 시각: ${display(effective.link_confirmed_at)}<br>원격 검사 이력: ${display(effective.link_remote_checked_at)}</p></details>` : ""}
    ${recent ? `<p>별도 재검색 결과: ${display(STATUS[record.match_status] ?? record.match_status)} · 현재 판정에 저장되지 않은 비교 자료</p>` : ""}
    <p>점수 ${score(record.match_score)} / 후보 간 차이 ${score(record.match_margin)} · 기준 ${score(criteria.threshold)} / ${score(criteria.min_margin)}<br>
      검토 사유: ${escape(reasons(record.match_reasons))}${effective.decision_reason ? `<br>사용자 사유: ${escape(effective.decision_reason)}` : ""}</p>
    <p>후보 총수 ${display(count)} · 저장 후보 ${candidates.length}개${truncated ? " · 일부 상위 후보만 저장됨" : ""}</p>
    <div class="table-wrap"><table><thead><tr><th>구분 / ID</th><th>제목</th><th>가수·참여 가수</th><th>앨범</th><th>길이</th><th>ISRC / 등급</th><th>저장 링크</th><th>점수 / 유사도</th><th>후보별 차이·근거</th></tr></thead><tbody>
      <tr class="original"><th scope="row">원곡</th>${metadata(original.title, original.artist, original.album, original.duration_ms,
        original.isrc, original.content_rating, original.melon_url, "Melon")}<td>—</td><td>제목의 참여 가수·버전 표기도 확인하세요.</td></tr>
      ${selected}${candidates.map(candidateRow).join("")}</tbody></table></div>
    ${candidates.length ? "" : "<p>저장된 비교 후보가 없습니다. 검색 미확정은 Apple Music에 곡이 없다는 확정이 아닙니다.</p>"}`;
}

function article(item) {
  const { original, effective, record } = item;
  const candidates = record.candidates ?? [];
  const melonId = String(original.melon_song_id ?? effective.melon_song_id ?? "");
  const decidable = UNRESOLVED.has(effective.match_status) && melonId !== "";
  const search = [original.melon_song_id, original.title, original.artist, original.album,
    effective.public_metadata_title, effective.public_metadata_artist, effective.public_metadata_album,
    effective.apple_music_song_id, effective.link_anchor_melon_song_id,
    ...candidates.flatMap((c) => [c.id, c.title, c.artist, c.album])].join(" ").toLocaleLowerCase();
  const attributes = `hidden data-status="${escape(effective.match_status)}" data-priority="${item.priority}" data-search="${escape(search)}"`;
  const title = display(original.title ?? effective.title);
  if (!decidable) {
    return `<article ${attributes}>
    <h2>${title} <small>${display(original.artist ?? effective.artist)} · Melon ID ${display(original.melon_song_id)}</small></h2>
    <p class="state">현재 판정: ${display(STATUS[effective.match_status] ?? effective.match_status)}${item.priority ? " · 우선 검토" : ""}</p>
    ${evidence(item)}
  </article>`;
  }
  return `<article ${attributes} data-melon="${escape(melonId)}">
    <header><div><p class="eyebrow">Melon 곡</p><h2>${title}</h2>
      <p class="meta">${[facts(original.artist, original.album, original.duration_ms), link(original.melon_url, "Melon", "Melon에서 보기 ↗", "")].filter(Boolean).join(" · ")}</p></div>
      <span class="badge">아직 안 고름</span></header>
    ${decisionControls(item, melonId)}
    <details class="more"><summary>자세한 비교 정보 (점수·ISRC·분석 근거)</summary>${evidence(item)}</details>
  </article>`;
}

export function renderReviewReport(report) {
  const { items, sourceDocument, generatedAt } = report;
  const priority = items.filter((item) => item.priority).length;
  const unresolved = items.filter((item) => UNRESOLVED.has(item.effective.match_status)).length;
  const unprocessed = items.filter((item) => item.effective.match_status === "unprocessed").length;
  const held = items.filter((item) => item.effective.match_status === "held").length;
  const linked = items.filter(item => item.effective.match_status === "linked_existing").length;
  const resolved = items.filter(item => ["matched", "manual_confirmed", "linked_existing"].includes(item.effective.match_status)).length;
  const uniqueTargets = new Set(items.filter(item => ["matched", "manual_confirmed"].includes(item.effective.match_status))
    .map(item => item.effective.apple_music_song_id).filter(Boolean).map(String)).size;
  const initial = unresolved ? "unresolved" : "all";
  const option = (value, label) => `<option value="${value}"${initial === value ? " selected" : ""}>${label}</option>`;
  const generatedTime = new Date(generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Melon → Apple Music 곡 고르기</title><style>
  :root{--bg:#f6f7f9;--card:#fff;--line:#dfe3ea;--text:#1f2633;--muted:#5f6b7d;--accent:#1f5fbf;--accent-bg:#eaf1fc;--ok:#1d7a46;--ok-bg:#e8f5ee;--warn:#8a5300;--warn-bg:#fdf3e1}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;word-break:keep-all}
  main{max-width:920px;margin:auto;padding:24px 16px 64px}h1{font-size:26px;line-height:1.3;margin:0 0 8px}a{color:var(--accent)}summary{cursor:pointer}small{display:block;color:var(--muted);font-size:13px}
  .intro,article,.next{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:16px 0}article[hidden]{display:none}
  .lead{font-size:17px;margin:0 0 10px}.steps{margin:0 0 10px;padding-left:22px}.steps li{margin:4px 0}.intro details{color:var(--muted);font-size:14px}
  .toolbar{position:sticky;top:0;z-index:2;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line)}
  .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0}.actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-left:auto}#visible{color:var(--muted);font-size:14px}
  select,input[type=search],input.url{font:inherit;padding:7px 10px;border:1px solid #b7c0cd;border-radius:6px;background:#fff;color:inherit;max-width:100%}input[type=search]{flex:1;min-width:160px}
  button{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid #b7c0cd;background:#fff;color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}button.plain{border-color:transparent;background:none;color:var(--accent);padding:7px 4px}
  .progress{font-weight:600}.progress.warn{color:var(--warn)}
  article header{display:flex;gap:12px;justify-content:space-between;align-items:flex-start}.eyebrow{margin:0;font-size:13px;color:var(--muted)}article h2{font-size:20px;line-height:1.35;margin:0}.meta{margin:2px 0 0;color:var(--muted)}
  .badge{flex:none;font-size:13px;padding:2px 10px;border-radius:999px;background:#eef0f4;color:var(--muted);white-space:nowrap}
  article[data-state=picked]{border-left:5px solid var(--ok)}article[data-state=picked] .badge{background:var(--ok-bg);color:var(--ok)}article[data-state=skipped]{border-left:5px solid #9aa4b2}
  .state{font-weight:700;color:var(--accent)}
  fieldset{border:0;margin:14px 0 0;padding:0;min-width:0}legend{font-weight:600;margin-bottom:4px;padding:0}
  .choice{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin:6px 0;cursor:pointer}.choice:hover{border-color:#9fb3d1}
  .choice:has(input:checked){border-color:var(--accent);background:var(--accent-bg);box-shadow:inset 0 0 0 1px var(--accent)}.choice.other{background:#fafbfc}
  .choice input[type=radio]{margin:4px 0 0;width:18px;height:18px;flex:none;accent-color:var(--accent)}
  .c-body{flex:1;min-width:0}.c-title{display:block;font-weight:600}.c-meta{display:block;color:var(--muted);font-size:14px}
  .c-side{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:14px;color:var(--muted);text-align:right}
  .tag{display:inline-block;font-size:12px;padding:1px 8px;margin-left:4px;border-radius:999px;background:#eef0f4;color:#3d4757}.tag.warn{background:var(--warn-bg);color:var(--warn)}
  input.url{width:100%;margin-top:6px}
  .pick-note{margin:8px 0 0;padding:6px 10px;border-radius:6px;font-size:14px;background:#eef0f4}.pick-note.warn{background:var(--warn-bg);color:var(--warn)}.pick-note:empty{display:none}
  details.more{margin-top:12px}details.more>summary{color:var(--muted);font-size:14px}
  .table-wrap{overflow-x:auto}table{width:100%;min-width:1000px;border-collapse:collapse;font-size:14px}th,td{padding:8px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}thead,.original{background:#f2f5fa}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 system-ui;max-width:400px}
  .pager{display:flex;justify-content:center;align-items:center;gap:12px;margin:20px 0}
  .next{background:var(--ok-bg);border-color:#b9dfc8}.next h2{font-size:18px;margin:0 0 6px}.next p{margin:6px 0}
  .cmd{display:flex;gap:8px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:6px;padding:6px 6px 6px 10px}.cmd code{flex:1;overflow-x:auto;white-space:nowrap;font-size:14px}
  @media(max-width:640px){h1{font-size:22px}.toolbar{position:static}.intro,article,.next{padding:14px}article header{flex-direction:column}.choice{flex-wrap:wrap}
    .c-side{flex-basis:100%;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px;padding-left:30px;text-align:left}.tag{margin:0}}
  </style></head><body><main data-fingerprint="${escape(report.inputFingerprint ?? "")}">
  <section class="intro"><h1>자동으로 못 찾은 곡 고르기</h1>
  <p class="lead">${unresolved ? `Melon 좋아요 중 Apple Music 곡을 자동으로 정하지 못한 곡이 <b>${unresolved}곡</b> 있습니다. 곡마다 같은 곡을 골라 주세요.` : "자동으로 정하지 못한 곡이 없습니다. 아래에서 전체 결과를 볼 수 있습니다."}</p>
  ${unresolved ? `<ol class="steps"><li><b>고르기</b> · 후보 중 같은 곡을 누르세요. 없으면 링크를 붙여 넣거나 건너뛰세요.</li>
  <li><b>내려받기</b> · 다 고르면 <b>결정 파일 내려받기</b>를 누르세요. 중간에 닫아도 고른 내용은 이 브라우저에 남습니다.</li>
  <li><b>저장</b> · 안내되는 명령을 터미널에서 실행하면 미리보기 후 저장됩니다. 이 화면 자체는 아무것도 바꾸지 않습니다.</li></ol>` : ""}
  <details><summary>전체 현황과 이 화면에 대해</summary>
  <p>현재 판정 ${items.length - unprocessed}곡 · 미확정 ${unresolved}곡 · 우선 검토 ${priority}곡 · 보류 ${held}곡 · 미처리 ${unprocessed}곡<br>
  확정 원곡 ${resolved}곡 · 기존 곡 연결 ${linked}곡 · 선택 고유 Apple 대상 ${uniqueTargets}곡<br>
  원본: ${sourceDocument ? `${sourceDocument.songs.length}곡` : "파일 없음 · melon-extract를 먼저 실행하세요"} · 원본 추출 완료: ${sourceDocument?.complete === true ? "예" : "미확인 또는 미완료"} · 매칭 처리와 전체 이관 완료는 별도입니다.</p>
  <p>우선 검토는 저장 점수가 해당 검색 기준 이상인 미확정 곡입니다. 자동 승인 대상이라는 뜻은 아닙니다. 참여 가수·버전과 후보 간 차이를 함께 확인하세요.</p>
  <p>생성 시각: ${escape(generatedTime)} (한국 시간) · 현재 로컬 결과의 비교표입니다. 링크는 저장된 곡 페이지이며 재생 가능성을 보증하지 않습니다. 데이터가 바뀌면 비교표를 다시 생성하세요.</p></details></section>
  <section id="next-step" class="next" hidden><h2>다음 단계: 터미널에서 저장하기</h2>
  <p>터미널(Windows는 PowerShell, macOS는 터미널 앱)에서 이 프로젝트 폴더로 이동해 아래 명령을 실행하세요. 먼저 미리보기가 나오고, 확인 후 안내되는 명령으로 저장합니다.</p>
  <div class="cmd"><code id="cmd">${escape(DECISIONS_COMMAND)}</code><button id="copy" type="button">복사</button></div>
  <p><small>브라우저가 파일 이름을 바꿨다면(예: review-decisions (1).json) 명령의 경로도 맞게 고치세요.</small></p></section>
  <div class="toolbar"><div class="row"><label for="scope">보기</label><select id="scope">${option("unresolved", `결정할 곡 (${unresolved})`)}${option("undecided", "결정할 곡 중 아직 안 고른 곡")}${option("priority", `점수 높은 미확정 곡 (${priority})`)}${option("held", `보류 (${held})`)}${option("unprocessed", `아직 검색 안 한 곡 (${unprocessed})`)}${option("linked_existing", `기존 곡에 연결 (${linked})`)}${option("all", `전체 곡 (${items.length})`)}</select>
  <input id="query" type="search" placeholder="곡·가수·앨범 검색" aria-label="곡·가수·앨범·ID 검색"><span id="visible" role="status" aria-live="polite"></span></div>
  ${unresolved ? `<div class="row"><span id="pick-count" class="progress" role="status" aria-live="polite"></span>
  <span class="actions"><button id="bulk-undo" type="button" class="plain" hidden>한꺼번에 고른 것 취소</button><button id="bulk" type="button">비슷한 후보로 한꺼번에 고르기</button>
  <button id="download" type="button" class="primary" disabled>결정 파일 내려받기</button></span></div>` : ""}</div>
  <noscript>검색·페이지 이동·곡 고르기를 사용하려면 브라우저의 JavaScript를 켜세요. 곡별 요약은 함께 생성된 review.csv에서도 볼 수 있습니다.</noscript>
  <div id="list"><p id="empty" hidden>해당하는 곡이 없습니다.</p>${items.map(article).join("")}</div>
  <nav class="pager"><button id="previous" type="button">← 이전 20곡</button><span id="range"></span><button id="next" type="button">다음 20곡 →</button></nav>
  </main><script>
  const $=id=>document.getElementById(id),scope=$('scope'),query=$('query'),cards=[...document.querySelectorAll('article')];
  const fp=document.querySelector('main').dataset.fingerprint,key='melon-review-decisions:'+fp,deciders=new Map([...document.querySelectorAll('.decide')].map(d=>[d.dataset.melon,d])),flagged=new Set();
  let state={};try{state=JSON.parse(localStorage.getItem(key))||{};}catch{state={};}
  for(const id of Object.keys(state))if(!deciders.has(id))delete state[id];
  let position=0,current=[],dupMap=new Map();
  function titleOf(id){return deciders.get(id).closest('article').querySelector('h2').textContent;}
  function refreshDuplicates(){const byApple=new Map();for(const[id,s] of Object.entries(state)){if(!s.apple_song_id)continue;if(!byApple.has(s.apple_song_id))byApple.set(s.apple_song_id,[]);byApple.get(s.apple_song_id).push(id);}
    const next=new Map();for(const ids of byApple.values())if(ids.length>1)for(const id of ids)next.set(id,ids.filter(x=>x!==id));
    const touched=new Set([...dupMap.keys(),...next.keys()]);dupMap=next;for(const id of touched)if(deciders.has(id))paint(id);}
  function inScope(card){const status=card.dataset.status,open=['ambiguous','not_found'].includes(status);switch(scope.value){case'all':return true;case'unresolved':return open;case'undecided':return open&&!state[card.dataset.melon];case'priority':return card.dataset.priority==='true';default:return status===scope.value;}}
  function filter(){const term=query.value.trim().toLocaleLowerCase();const matches=current=cards.filter(card=>inScope(card)&&card.dataset.search.includes(term));const visible=new Set(matches.slice(position,position+20));for(const card of cards)card.hidden=!visible.has(card);$('visible').textContent=matches.length+'곡';$('empty').hidden=matches.length!==0;$('range').textContent=matches.length?(position+1)+'–'+Math.min(position+20,matches.length)+' / '+matches.length+'곡':'';$('previous').disabled=position===0;$('next').disabled=position+20>=matches.length;}
  function reset(){position=0;filter();}
  function page(step){position=Math.max(0,position+step);filter();$('list').scrollIntoView();}
  scope.addEventListener('change',reset);query.addEventListener('input',reset);$('previous').addEventListener('click',()=>page(-20));$('next').addEventListener('click',()=>page(20));
  function persist(){try{localStorage.setItem(key,JSON.stringify(state));}catch{}}
  function appleId(text){const v=text.trim();if(/^\\d+$/.test(v))return v;try{const u=new URL(v);if(u.protocol!=='https:'||u.hostname!=='music.apple.com')return null;const id=u.searchParams.get('i')||u.pathname.split('/').filter(Boolean).pop();return /^\\d+$/.test(id||'')?id:null;}catch{return null;}}
  function paint(id){const d=deciders.get(id),s=state[id],card=d.closest('article'),value=!s?null:s.source==='skip'?'__skip':s.source==='url'?'__url':s.apple_song_id;
    for(const radio of card.querySelectorAll('input[type=radio]'))radio.checked=radio.value===value;
    const field=d.querySelector('.url');if(s&&s.source==='url'&&field.value!==s.url)field.value=s.url;
    card.dataset.state=s&&s.apple_song_id?'picked':s&&s.source==='skip'?'skipped':'';
    card.querySelector('.badge').textContent=s&&s.source==='bulk_top1'?'한꺼번에 고름':s&&s.apple_song_id?'고름':s&&s.source==='skip'?'건너뜀':'아직 안 고름';
    const note=d.querySelector('.pick-note'),bad=s&&s.source==='url'&&s.url.trim()&&!s.apple_song_id,dup=dupMap.get(id);
    note.className='pick-note'+(flagged.has(id)||bad||dup?' warn':'');
    note.textContent=dup?'다른 곡도 같은 후보를 선택했습니다 · '+dup.map(titleOf).join(', ')
      :s&&s.source==='bulk_top1'?'가장 비슷한 후보로 한꺼번에 골랐습니다. 맞는지 확인하고, 다르면 다른 후보를 누르세요.'
      :flagged.has(id)?'직접 골라 주세요 · '+d.dataset.topBlocked
      :bad?'링크에서 곡을 찾지 못했습니다. music.apple.com 곡 링크(?i=숫자 포함)를 붙여 넣으세요.'
      :'';}
  function count(){if(!$('pick-count'))return;const all=Object.values(state),picked=all.filter(s=>s.apple_song_id).length,skipped=all.filter(s=>s.source==='skip').length,bulk=all.filter(s=>s.source==='bulk_top1').length;
    let text='고름 '+picked+' · 건너뜀 '+skipped+' · 남음 '+(deciders.size-picked-skipped);
    if(dupMap.size)text+=' · 중복 선택 '+dupMap.size+'곡';
    $('pick-count').textContent=text;$('pick-count').classList.toggle('warn',dupMap.size>0);
    $('download').disabled=!picked;$('download').textContent=picked?'결정 파일 내려받기 ('+picked+'곡)':'결정 파일 내려받기';$('bulk-undo').hidden=!bulk;}
  function setUrl(d,text){state[d.dataset.melon]={source:'url',url:text,apple_song_id:appleId(text)};}
  document.addEventListener('change',e=>{const t=e.target;if(t.type!=='radio'||!t.name.startsWith('pick-'))return;const d=t.closest('article').querySelector('.decide'),id=d.dataset.melon;flagged.delete(id);
    if(t.value==='__skip')state[id]={source:'skip'};else if(t.value==='__url'){setUrl(d,d.querySelector('.url').value);d.querySelector('.url').focus();}else state[id]={source:'candidate',apple_song_id:t.value};persist();refreshDuplicates();paint(id);count();});
  document.addEventListener('input',e=>{const t=e.target;if(!t.classList.contains('url'))return;const d=t.closest('.decide');flagged.delete(d.dataset.melon);setUrl(d,t.value);persist();refreshDuplicates();paint(d.dataset.melon);count();});
  if($('bulk'))$('bulk').addEventListener('click',()=>{const ids=current.map(card=>card.querySelector('.decide')).filter(Boolean).map(d=>d.dataset.melon).filter(id=>!state[id]);
    if(!ids.length){alert('지금 보기·검색 결과에 아직 고르지 않은 곡이 없습니다.');return;}
    const ok=new Set(ids.filter(id=>deciders.get(id).dataset.top&&!deciders.get(id).dataset.topBlocked));
    if(!ok.size){for(const id of ids){flagged.add(id);paint(id);}alert('지금 보기·검색 결과에는 한꺼번에 고를 수 있는 곡이 없습니다. 표시된 곡은 직접 골라 주세요.');return;}
    if(!confirm('지금 보기·검색 결과에서 아직 고르지 않은 '+ids.length+'곡 중 '+ok.size+'곡을 가장 비슷한 후보로 고릅니다.\\n나머지 '+(ids.length-ok.size)+'곡은 비슷한 정도가 낮거나 버전·가수가 다를 수 있어 직접 골라야 합니다.\\n\\n가장 비슷한 후보가 틀릴 때도 있으니 저장 전 미리보기에서 확인하세요.'))return;
    for(const id of ids){if(ok.has(id))state[id]={source:'bulk_top1',apple_song_id:deciders.get(id).dataset.top};else flagged.add(id);paint(id);}persist();refreshDuplicates();count();});
  if($('bulk-undo'))$('bulk-undo').addEventListener('click',()=>{for(const [id,s] of Object.entries(state))if(s.source==='bulk_top1'){delete state[id];paint(id);}for(const id of [...flagged]){flagged.delete(id);paint(id);}persist();refreshDuplicates();count();});
  if($('download'))$('download').addEventListener('click',()=>{
    if(dupMap.size&&!confirm('같은 Apple 후보를 선택한 곡이 있습니다: '+[...dupMap.keys()].map(titleOf).join(', ')+'\\n이대로 저장하면 겹치는 곡 중 하나만 반영되고 나머지는 제외됩니다. 그래도 내려받을까요?'))return;
    const decisions=Object.entries(state).filter(([,s])=>s.apple_song_id).map(([id,s])=>({melon_song_id:id,apple_song_id:s.apple_song_id,source:s.source}));
    const blob=new Blob([JSON.stringify({schema_version:1,kind:'melon-review-decisions',review_fingerprint:fp,generated_at:new Date().toISOString(),decisions},null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='review-decisions.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    $('next-step').hidden=false;$('next-step').scrollIntoView({behavior:'smooth',block:'center'});});
  $('copy').addEventListener('click',async()=>{const text=$('cmd').textContent;try{await navigator.clipboard.writeText(text);$('copy').textContent='복사됨';}catch{const r=document.createRange();r.selectNodeContents($('cmd'));const sel=getSelection();sel.removeAllRanges();sel.addRange(r);$('copy').textContent='선택됨 · Ctrl+C';}setTimeout(()=>{$('copy').textContent='복사';},2000);});
  filter();refreshDuplicates();for(const id of deciders.keys())paint(id);count();
  </script></body></html>`;
}

export async function writeReviewReport(file, report) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderReviewReport(report), "utf8");
}
