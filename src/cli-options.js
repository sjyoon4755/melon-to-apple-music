const BOOLEAN_OPTIONS = new Set(["force", "headless", "execute", "dryRun", "check", "confirm", "hold"]);
const NUMBER_OPTIONS = new Set(["limit", "maxAdd", "port", "timeout", "threshold", "minMargin"]);
const COMMON_OPTIONS = ["dataDir"];

const ALLOWED_OPTIONS = new Map([
  ["help", []],
  ["--help", []],
  ["-h", []],
  ["configure", ["browser"]],
  ["melon-extract", [...COMMON_OPTIONS, "limit", "force", "headless"]],
  ["match", [...COMMON_OPTIONS, "threshold", "minMargin", "force"]],
  ["review", [...COMMON_OPTIONS, "candidatesDir"]],
  ["inactive-review", [...COMMON_OPTIONS, "inputFile", "outputDir", "melonSongId"]],
  ["status", [...COMMON_OPTIONS]],
  ["recover", [...COMMON_OPTIONS, "planFile", "resume", "backend", "execute", "expectedPreview"]],
  ["settle-recovery", [...COMMON_OPTIONS, "recoveryId", "reason", "backend", "confirm", "expectedPreview"]],
  ["review-recovery-candidate", [...COMMON_OPTIONS, "planFile", "backend"]],
  ["recover-followup", [...COMMON_OPTIONS, "planFile", "resume", "backend", "execute", "expectedPreview"]],
  ["resolve", [...COMMON_OPTIONS, "melonSongId", "appleSongId", "appleUrl", "decisionsFile", "confirm", "expectedPreview"]],
  ["resolve-unavailable", [...COMMON_OPTIONS, "melonSongId", "appleSongId", "appleUrl", "reason", "evidenceFile", "confirm", "expectedPreview"]],
  ["link-existing", [...COMMON_OPTIONS, "melonSongId", "anchorMelonSongId", "appleSongId", "backend", "evidenceFile", "reason", "confirm", "expectedPreview"]],
  ["unlink-existing", [...COMMON_OPTIONS, "melonSongId", "reason", "confirm", "expectedPreview"]],
  ["revise", [...COMMON_OPTIONS, "melonSongId", "appleSongId", "appleUrl", "hold", "reason", "confirm", "expectedPreview"]],
  ["apple-auth", [...COMMON_OPTIONS, "backend", "port", "timeout"]],
  ["apply", [...COMMON_OPTIONS, "dryRun", "execute", "check", "backend", "limit", "maxAdd", "name"]],
  ["sync", [...COMMON_OPTIONS, "backend", "execute", "expectedPreview"]],
  ["mvp", [...COMMON_OPTIONS, "limit", "force", "headless", "threshold", "minMargin"]]
]);

function optionKey(rawKey) {
  return rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function validateNumber(key, value) {
  if (!Number.isFinite(value)) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}는 유효한 숫자여야 합니다.`);
  if (key === "maxAdd" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("--max-add는 1 이상의 안전한 정수여야 합니다.");
  }
  if (["limit", "port"].includes(key) && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`--${key}은 1 이상의 정수여야 합니다.`);
  }
  if (key === "port" && value > 65_535) throw new Error("--port는 65535 이하여야 합니다.");
  if (key === "timeout" && value <= 0) throw new Error("--timeout은 0보다 커야 합니다.");
  if (["threshold", "minMargin"].includes(key) && (value < 0 || value > 1)) {
    throw new Error(`--${key === "minMargin" ? "min-margin" : key}은 0 이상 1 이하여야 합니다.`);
  }
}

export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "--") args.shift();
  const command = args[0] ?? "help";
  const allowed = ALLOWED_OPTIONS.get(command);
  if (!allowed) throw new Error(`알 수 없는 명령: ${command}`);
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) return { command: "help", options: { helpCommand: command } };
  const allowedSet = new Set(allowed);
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) throw new Error(`알 수 없는 인수: ${arg}`);
    const separator = arg.indexOf("=");
    const rawKey = arg.slice(2, separator < 0 ? undefined : separator);
    const inlineValue = separator < 0 ? undefined : arg.slice(separator + 1);
    const key = optionKey(rawKey);
    if (!allowedSet.has(key)) throw new Error(`${command} 명령에서 알 수 없는 옵션: --${rawKey}`);
    if (Object.hasOwn(options, key)) throw new Error(`옵션이 중복되었습니다: --${rawKey}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      if (inlineValue != null) throw new Error(`--${rawKey}에는 값을 지정하지 않습니다.`);
      options[key] = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value == null || value === "--" || value.startsWith("--")) throw new Error(`--${rawKey} 값이 필요합니다.`);
    options[key] = NUMBER_OPTIONS.has(key) ? Number(value) : value;
  }
  for (const key of NUMBER_OPTIONS) if (options[key] != null) validateNumber(key, options[key]);
  if (command === "apply") {
    const modes = [options.execute, options.dryRun, options.check].filter(Boolean).length;
    if (modes > 1) throw new Error("--execute, --dry-run, --check는 함께 사용할 수 없습니다.");
  }
  if (command === "resolve" && options.decisionsFile) {
    if (options.melonSongId || options.appleSongId || options.appleUrl) {
      throw new Error("--decisions-file은 --melon-song-id, --apple-song-id, --apple-url과 함께 사용할 수 없습니다.");
    }
    if (Boolean(options.confirm) !== Boolean(options.expectedPreview)) {
      throw new Error("결정 파일 확정에는 --confirm과 --expected-preview HASH가 함께 필요합니다.");
    }
  }
  if (command === "sync") {
    if (!options.backend) throw new Error("sync에는 --backend official 또는 --backend web-player를 명시해야 합니다.");
    if (Boolean(options.execute) !== Boolean(options.expectedPreview)) throw new Error("--execute와 --expected-preview HASH는 함께 지정해야 합니다.");
  }
  return { command, options };
}
