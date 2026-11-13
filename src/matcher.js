import { isDeepStrictEqual } from "node:util";

const QUALIFIERS = new Map([
  ["live", /(?:\blive\b|라이브)/iu],
  ["instrumental", /(?:\binst(?:rumental)?\.?\b|연주곡)/iu],
  ["remix", /(?:\bremix\b|리믹스)/iu],
  ["acoustic", /(?:\bacoustic\b|어쿠스틱)/iu],
  ["remaster", /(?:\bremaster(?:ed)?\b|리마스터)/iu],
  ["explicit", /(?:\bexplicit\b|19금|청소년\s*이용\s*불가)/iu]
]);

function fold(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[’‘`]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFeaturing(value) {
  return fold(value).replace(/(?:\(|\[)?\s*(?:feat\.?|featuring|ft\.?)\s+[^)\]]+(?:\)|\])?/giu, " ");
}

export function normalizeText(value) {
  return stripFeaturing(value)
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(value) {
  const compact = normalizeText(value).replaceAll(" ", "");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

export function similarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aa = bigrams(a);
  const bb = bigrams(b);
  const counts = new Map();
  for (const gram of aa) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let overlap = 0;
  for (const gram of bb) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / (aa.length + bb.length);
}

// Credits are removed only from the title core; they remain identity evidence.
function credits(value) {
  const guests = [];
  let core = fold(value);
  const marker = /(?:\(|\[)?\s*\b(?:feat\.?|featuring|ft\.?|vocal(?:\s+by)?|song\s+by)\s*[:.]?\s+/iu;
  let match;
  while ((match = marker.exec(core))) {
    const start = match.index + match[0].length;
    let end = start;
    let depth = 0;
    for (; end < core.length; end += 1) {
      if (/[([]/.test(core[end])) depth += 1;
      else if (/[\])]/.test(core[end])) {
        if (!depth) break;
        depth -= 1;
      }
    }
    const names = core.slice(start, end).split(/\bprod(?:uced|ucer)?\.?\s*(?:by\s+)?/iu)[0]
      .replace(/[,;&/\s]+$/u, "");
    guests.push(...participants(names));
    core = core.slice(0, match.index) + " " + core.slice(end < core.length ? end + 1 : end);
  }
  return { core, guests };
}

function nameAliases(value) {
  const raw = fold(value);
  const base = raw.replace(/\([^)]*\)/g, " ").trim();
  const parts = [raw];
  const parenthetical = [...raw.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  // Only an explicit cross-script name is an alias, not another collaborator.
  if (parenthetical.length === 1 && !/[,;&/]|\band\b/iu.test(parenthetical[0])
    && ((/[가-힣]/u.test(base) && /^[\x00-\x7f]+$/.test(parenthetical[0]))
      || (/^[\x00-\x7f]+$/.test(base) && /[가-힣]/u.test(parenthetical[0])))) {
    parts.push(base, parenthetical[0]);
  }
  return [...new Set(parts.map((part) => normalizeText(part).replaceAll(" ", "")).filter(Boolean))];
}

function participants(value) {
  // Protect parenthetical aliases while splitting collaborator delimiters.
  const raw = fold(value);
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "(") depth += 1;
    else if (raw[index] === ")") depth = Math.max(0, depth - 1);
    if (depth) continue;
    const delimiter = /^(?:[,;&/]|\s+(?:and|x|×)\s+)/iu.exec(raw.slice(index));
    if (!delimiter) continue;
    parts.push(raw.slice(start, index));
    index += delimiter[0].length - 1;
    start = index + 1;
  }
  parts.push(raw.slice(start));
  return parts.map(nameAliases).filter((part) => part.length);
}

function sameName(a, b) { return a.some((name) => b.includes(name)); }

function uniqueParticipants(values) {
  return values.reduce((all, value) => {
    if (!all.some((other) => sameName(value, other))) all.push(value);
    return all;
  }, []);
}

function participantEvidence(song, artist = song.artist) {
  const titleCredits = credits(song.title);
  const artistCredits = credits(artist);
  const primary = uniqueParticipants([...participants(artistCredits.core),
    ...(artist === song.artist ? (song.artists ?? []).flatMap((value) => participants(value)) : [])]);
  const guests = uniqueParticipants([...titleCredits.guests, ...artistCredits.guests]);
  return { primary, guests, all: uniqueParticipants([...primary, ...guests]) };
}

function compareParticipants(a, b) {
  const used = new Set();
  const matched = a.all.filter((name) => {
    const index = b.all.findIndex((other, i) => !used.has(i) && sameName(name, other));
    if (index < 0) return false;
    used.add(index);
    return true;
  }).length;
  const reasons = [];
  if (!a.primary.length || !b.primary.length) reasons.push("primary_artist_missing");
  if (a.all.length !== b.all.length) reasons.push("participant_information_missing");
  if (matched < Math.min(a.all.length, b.all.length)) reasons.push("participant_mismatch");
  if (a.guests.some((name) => !b.all.some((other) => sameName(name, other)))
    || b.guests.some((name) => !a.all.some((other) => sameName(name, other)))) {
    reasons.push(a.guests.length && b.guests.length ? "guest_artist_mismatch" : "guest_artist_information_missing");
  }
  if (matched === a.all.length && matched === b.all.length && a.guests.length && b.guests.length && (a.guests.length !== b.guests.length
    || a.guests.some((name) => !b.guests.some((other) => sameName(name, other))))) {
    reasons.push("guest_artist_role_conflict");
  }
  return { score: a.all.length + b.all.length ? 2 * matched / (a.all.length + b.all.length) : 0,
    reasons, source: a, candidate: b };
}

function participantComparison(melon, apple) {
  const source = participantEvidence(melon);
  const canonical = participantEvidence(apple);
  const comparisons = [apple.title, ...(apple.title_aliases ?? [])].flatMap((title) =>
    [apple.artist, ...(apple.artist_aliases ?? [])].map((artist) => {
    const evidence = participantEvidence({ ...apple, title }, artist);
    const comparison = compareParticipants(source, evidence);
    // Storefront aliases cannot erase collaborators or explicit credit roles.
    if (evidence.primary.length !== canonical.primary.length || evidence.guests.length !== canonical.guests.length) {
      comparison.reasons.push("alias_participant_count_conflict");
    }
    return comparison;
  }));
  return comparisons.sort((a, b) => a.reasons.length - b.reasons.length || b.score - a.score)[0];
}

function editionEvidence(value) {
  const text = credits(value).core.replace(/[([]\s*prod(?:uced|ucer)?\.?\s+[^\])]*[\])]/giu, " ");
  const result = { language: [], arrangement: [] };
  const groups = [...text.matchAll(/[([]([^\])]+)[\])]/g)].map((m) => m[1]);
  groups.push(...[...text.matchAll(/\b(?:english|korean|japanese|guitar|cello|band)\s+(?:ver(?:sion)?\.?|edition)\b/giu)].map((m) => m[0]));
  for (const group of groups) {
    if (/\bprod(?:uced|ucer)?\.?\b/iu.test(group)) continue;
    for (const [name, pattern] of [["english", /\benglish\b|영어/iu], ["korean", /\bkorean\b|한국어/iu], ["japanese", /\bjapanese\b|일본어/iu]]) {
      if (pattern.test(group)) result.language.push(name);
    }
    for (const [name, pattern] of [["guitar", /\bguitar\b|기타/iu], ["cello", /\bcello\b|첼로/iu], ["band", /\bband\b|밴드/iu]]) {
      if (pattern.test(group)) result.arrangement.push(name);
    }
  }
  return Object.fromEntries(Object.entries(result).map(([key, values]) => [key, [...new Set(values)].sort()]));
}

function bestSimilarity(left, right, rightAliases, compare = similarity) {
  return Math.max(0, ...[right, ...(rightAliases ?? [])].map((candidate) => compare(left, candidate)));
}

function qualifierSet(value, contentRating) {
  const result = [];
  for (const [name, pattern] of QUALIFIERS) if (pattern.test(fold(value))) result.push(name);
  if (String(contentRating ?? "").toLowerCase() === "explicit" && !result.includes("explicit")) result.push("explicit");
  return result.sort();
}

function durationScore(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const delta = Math.abs(left - right);
  if (delta <= 2_000) return 1;
  if (delta >= 15_000) return 0;
  return 1 - (delta - 2_000) / 13_000;
}

export function scoreCandidate(melon, apple) {
  const title = bestSimilarity(credits(melon.title).core, credits(apple.title).core,
    apple.title_aliases?.map((value) => credits(value).core));
  const participantCheck = participantComparison(melon, apple);
  const artist = participantCheck.score;
  const album = melon.album && apple.album
    ? bestSimilarity(melon.album, apple.album, apple.album_aliases)
    : null;
  const duration = durationScore(melon.duration_ms, apple.duration_ms);
  const parts = [
    [title, 0.54],
    [artist, 0.31],
    [album, 0.10],
    [duration, 0.05]
  ].filter(([value]) => value != null);
  let score = parts.reduce((sum, [value, weight]) => sum + value * weight, 0) /
    parts.reduce((sum, [, weight]) => sum + weight, 0);

  const melonIsrc = String(melon.isrc ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const appleIsrc = String(apple.isrc ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const isrcExact = Boolean(melonIsrc && appleIsrc && melonIsrc === appleIsrc);
  if (isrcExact) score = 1;
  else if (melonIsrc && appleIsrc) score -= 0.25;

  const melonQualifiers = qualifierSet(melon.title, melon.content_rating);
  const appleQualifiers = qualifierSet(apple.title, apple.content_rating);
  const qualifierMismatch = !isDeepStrictEqual(melonQualifiers, appleQualifiers);
  if (qualifierMismatch) score -= 0.18;

  const sourceEdition = editionEvidence(melon.title);
  const candidateEdition = editionEvidence(apple.title);
  const identityReasons = [...participantCheck.reasons];
  for (const key of ["language", "arrangement"]) {
    if (!isDeepStrictEqual(sourceEdition[key], candidateEdition[key])) {
      identityReasons.push(sourceEdition[key].length && candidateEdition[key].length
        ? `${key}_version_conflict` : `${key}_version_information_missing`);
    }
  }
  if (qualifierMismatch) identityReasons.push("version_mismatch");

  return {
    score: Math.max(0, Math.min(1, score)),
    components: { title, artist, album, duration, isrc_exact: isrcExact, qualifier_mismatch: qualifierMismatch,
      identity_reasons: [...new Set(identityReasons)], participants: participantCheck,
      editions: { source: sourceEdition, candidate: candidateEdition } }
  };
}

export function chooseMatch(melon, candidates, options = {}) {
  const threshold = options.threshold ?? 0.88;
  const ambiguityThreshold = options.ambiguityThreshold ?? 0.72;
  const minMargin = options.minMargin ?? 0.06;
  const ranked = candidates
    .map((candidate) => ({ ...candidate, ...scoreCandidate(melon, candidate) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  const margin = best ? best.score - (second?.score ?? 0) : 0;
  let status = "not_found";
  if (best && best.score >= threshold && margin >= minMargin && !best.components.identity_reasons.length) status = "matched";
  else if (best && best.score >= ambiguityThreshold) status = "ambiguous";
  if (best?.components.identity_reasons.length) status = "ambiguous";
  return { status, best, margin, candidates: ranked.slice(0, 5), candidate_count: ranked.length,
    reasons: matchReasons({ status, best, margin }, options) };
}

export function matchReasons({ status, best, margin }, options = {}) {
  if (status === "manual_confirmed") return ["user_confirmed"];
  if (status === "matched") return ["high_confidence"];
  if (!best) return ["no_candidates"];
  const reasons = [];
  if (best.score < (options.threshold ?? 0.88)) reasons.push("below_threshold");
  if (margin < (options.minMargin ?? 0.06)) reasons.push("insufficient_margin");
  if (best.components?.qualifier_mismatch) reasons.push("version_mismatch");
  reasons.push(...(best.components?.identity_reasons ?? []));
  return reasons.length ? [...new Set(reasons)] : ["needs_review"];
}
