import { randomUUID, createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "./io.js";

export function sourceFingerprint(songs) {
  return createHash("sha256").update(JSON.stringify(songs.map((song) => [
    String(song.melon_song_id), song.title, song.artist, song.album, song.duration_ms, song.isrc, song.content_rating
  ]))).digest("hex");
}

export function reviewFingerprint(matched, unmatched, manual, decisions = [], links = [], unavailable = [], recoveries = []) {
  const inputs = [matched.match_config, matched.songs, unmatched.match_config, unmatched.songs, manual];
  if (decisions.length) inputs.push(decisions);
  if (links.length) inputs.push(links);
  if (unavailable.length) inputs.push(unavailable);
  if (recoveries.length) inputs.push(recoveries);
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

export async function startRun(file, details = {}) {
  const started = Date.now();
  let state = {
    schema_version: 1, run_id: randomUUID(), pid: process.pid,
    started_at: new Date(started).toISOString(), status: "running", ...details
  };
  async function update(details) {
    state = { ...state, ...details, updated_at: new Date().toISOString(), elapsed_ms: Date.now() - started };
    await writeJsonAtomic(file, state);
  }
  await update({});
  return {
    update,
    finish: (status, details = {}) => update({ ...details, status, finished_at: new Date().toISOString() })
  };
}

export async function readRunState(file) {
  const state = await readJson(file);
  if (!state || state.status !== "running") return state;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch (error) {
    if (error.code !== "ESRCH") return { ...state, status: "unknown" };
    return { ...state, status: "interrupted", stop_reason: "process_exited_without_final_status" };
  }
}
