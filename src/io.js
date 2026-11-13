import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`JSON 문법이 잘못되었습니다: ${filePath}. 기존 파일을 보존하고 JSON 형식을 확인하세요.`);
    }
    throw error;
  }
}

export async function readSongDocument(filePath, fallback = null) {
  const missing = {};
  const document = await readJson(filePath, missing);
  if (document === missing) return fallback;
  const invalid = (field) => new Error(`곡 데이터 구조가 잘못되었습니다: ${filePath} (${field}). 기존 파일을 보존하고 배열 형식을 확인하세요.`);
  if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.songs)) throw invalid("songs");
  for (const field of ["songs", "unavailable_songs"]) {
    if (field === "unavailable_songs" && !Object.hasOwn(document, field)) continue;
    if (!Array.isArray(document[field]) || document[field].some((song) => !song || typeof song !== "object" || Array.isArray(song))) throw invalid(field);
  }
  return document;
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function csvCell(value) {
  if (value == null) return "";
  const text = Array.isArray(value) ? value.join(" | ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function writeCsv(filePath, rows, columns) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  await writeFile(filePath, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

export async function loadDotEnv(filePath = ".env") {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}
