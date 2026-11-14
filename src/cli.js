#!/usr/bin/env node
import path from "node:path";
import { loadDotEnv } from "./io.js";
import { defaultAppDir, resolveConfig } from "./config.js";
import { extractMelonLikes } from "./melon.js";
import { applyPlaylist, localStatus, matchAppleMusic, resolveManualMatch, reviseMatch, reviewResults, linkExisting, unlinkExisting } from "./pipeline.js";
import { authorizeAppleMusic } from "./apple-auth.js";
import { authorizeAppleWebPlayer } from "./apple-web-auth.js";
import { resolveWriteBackend } from "./apple-write-adapter.js";
import { parseArgs } from "./cli-options.js";
import { configureBrowser } from "./browser-config.js";
import { resolveUnavailableMatch } from "./unavailable-match-command.js";
import { recoverSongs } from "./song-recovery-command.js";
import { settleRecovery } from "./song-recovery-settlement.js";
import { reviewRecoveryCandidate } from "./recovery-candidate-review.js";
import { recoverFollowup } from "./recovery-followup-command.js";
import { exportInactiveReview } from "./inactive-review.js";
import { formatSyncReport, syncLikes } from "./sync-command.js";
import { formatDecisionsReport, resolveDecisions } from "./bulk-resolve.js";

function printHelp(command = null) {
  const help = `melon-to-apple-music

새 좋아요 반영(권장):
  melon-to-apple-music sync --backend official|web-player                                # 추출→매칭→검토표→apply --check, 계정 변경 없음
  melon-to-apple-music sync --backend official|web-player --execute --expected-preview HASH  # 미리보기에서 안내한 곡만 추가
  melon-to-apple-music resolve --decisions-file PATH [--confirm --expected-preview HASH]       # review.html에서 고른 곡을 한 번에 수동 승인

단계별 명령:
  melon-to-apple-music configure --browser chrome|edge
  melon-to-apple-music melon-extract [--limit 20] [--force] [--headless]
  melon-to-apple-music match [--threshold 0.88] [--min-margin 0.06] [--force]
  melon-to-apple-music review [--candidates-dir PATH]              # CSV + 후보 비교 HTML
  melon-to-apple-music inactive-review --input-file PATH [--output-dir NEW_PATH] [--melon-song-id ID]
  melon-to-apple-music status
  melon-to-apple-music recover --backend web-player (--plan-file PATH | --resume ID) [--execute --expected-preview HASH]
  melon-to-apple-music settle-recovery --backend web-player --recovery-id ID --reason "부분 결과 확인 사유" [--confirm --expected-preview HASH]
  melon-to-apple-music review-recovery-candidate --backend web-player --plan-file PATH
  melon-to-apple-music recover-followup --backend web-player (--plan-file PATH | --resume ID) [--execute --expected-preview HASH]
  melon-to-apple-music resolve --melon-song-id ID (--apple-song-id ID | --apple-url URL) [--confirm]
  melon-to-apple-music resolve-unavailable --melon-song-id ID (--apple-song-id ID | --apple-url URL) --reason "검토 사유" [--evidence-file PATH] [--confirm --expected-preview HASH]
  melon-to-apple-music link-existing --melon-song-id ID --anchor-melon-song-id ID --apple-song-id ID --backend official|web-player --evidence-file PATH --reason "연결 사유" [--confirm --expected-preview HASH]
  melon-to-apple-music unlink-existing --melon-song-id ID --reason "취소 사유" [--confirm --expected-preview HASH]
  melon-to-apple-music revise --melon-song-id ID (--hold | --apple-song-id ID | --apple-url URL) --reason "검토 사유" [--confirm --expected-preview HASH]
  melon-to-apple-music apple-auth [--backend official] [--port 43117]
  melon-to-apple-music apple-auth --backend web-player [--timeout 600]
  melon-to-apple-music apply [--dry-run] [--backend official|web-player] [--limit 2] [--max-add 2] [--name "Melon Likes Import"]
  melon-to-apple-music apply --check --backend official|web-player [--limit 2] [--max-add 2]
  melon-to-apple-music apply --execute --backend official|web-player [--limit 2] [--max-add 2] [--name "Melon Likes Import"]
  melon-to-apple-music mvp [--limit 20]                            # extract + match only

공통 옵션:
  --data-dir PATH   결과 디렉터리(기본: data)

브라우저 정책:
  기본값은 Chrome이며 configure 설정은 Melon 추출과 Apple Music web-player 인증에 함께 적용됩니다.
  서비스별 로그인 프로필은 분리되며, 선택한 브라우저가 실패해도 자동 fallback하지 않습니다.

안전 경계:
  apply는 --execute가 없으면 Apple Music을 변경하지 않습니다.
  sync는 기존 곡·판정·checkpoint를 보존한 채 다시 추출하며, 추출이 완료되지 않으면 매칭·추가로 넘어가지 않습니다.
  sync --execute는 추출·매칭을 다시 하지 않고, 미리보기 HASH와 같은 추가 목록일 때만 추가한 뒤 플레이리스트를 대조합니다.
  recover는 기본 무쓰기 미리보기입니다. 실행 시 기존 승인·checkpoint를 보존하고 별도 복구 이력만 저장하며 삭제하지 않습니다.
  settle-recovery는 GET으로 부분 결과를 검사하고 --confirm으로 로컬 복구 이력만 저장합니다. 계정 추가·삭제 없이 성공/미해결을 구분하며 미해결 복구는 일반 실제 추가를 차단합니다.
  review-recovery-candidate는 최신 settled 거래의 미해결 곡에 대한 별도 발매본을 GET으로 검토합니다. 실행·저장은 지원하지 않으며 기존 recover의 동일 ISRC·길이 조건을 완화하지 않습니다.
  recover-followup은 별도 승인 HASH로 후속 이벤트만 저장하고 후보1개를 추가합니다. 원래 승인·checkpoint·부모 거래를 보존하며 시도 후 재개는 GET 확인만 허용합니다.
  apply --check는 원격 session/catalog/playlist를 읽기만 하고 변경하지 않습니다.
  resolve는 --confirm을 지정하기 전에는 수동 매칭을 저장하지 않습니다.
  resolve-unavailable은 비활성 원본을 보존하며 미리보기 HASH로 확인한 대응만 별도 이력에 저장합니다. 계정은 변경하지 않습니다.
  원곡 제목·가수·앨범이 없는 비활성 행은 --evidence-file로 공개 메타데이터·출처·원본 해시를 제공해야 합니다.
  link-existing/unlink-existing은 승인한 로컬 연결 이력만 저장하고 곡·checkpoint를 추가/삭제하지 않습니다.
  비활성 원곡의 link-existing은 공개 원곡 근거와 수동 승인한 정상 기준 원곡이 필요합니다.
  link-existing은 현재 KR playlist/catalog/library를 GET으로 확인합니다. preview 유효시간은 10분입니다.
  unlink 후 검토 보호를 해제하는 resolve에는 --confirm --expected-preview HASH가 필요합니다.
  revise는 기존 자동 매칭의 교체·보류를 미리 보여주고, --confirm --expected-preview HASH로 확인한 변경만 별도 이력에 저장합니다.
  보류곡은 모든 apply 모드에서 제외하며 기존 수동 승인·Apple checkpoint는 덮어쓰지 않습니다.
  web-player backend는 --backend web-player로만 선택되며 official에서 자동 전환하지 않습니다.
  apply --limit N은 matched 결과 순서에서 처음 N곡만 누적 적용 대상으로 제한합니다.
  apply --max-add N은 이번 실행에서 새로 추가할 고유 곡을 최대 N곡으로 제한합니다(양의 정수).
  함께 지정하면 --limit 범위 안에서 --max-add를 적용합니다.
  dry-run은 로컬 checkpoint 기준 계획(remote_checked=false)이며, check/execute는 실제 플레이리스트와 대조합니다.
  이 도구는 Favorite API를 호출하지 않고, 이름으로 기존 플레이리스트를 찾아 수정하지 않습니다.`;
  console.log(command ? help.split("\n").filter((line) => !line.startsWith("  melon-to-apple-music ")
    || line.startsWith(`  melon-to-apple-music ${command} `) || line === `  melon-to-apple-music ${command}`).join("\n") : help);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(command)) { printHelp(options.helpCommand); return; }
  await loadDotEnv(path.join(defaultAppDir, ".env"));
  const config = resolveConfig(options);
  switch (command) {
    case "configure":
      console.log(JSON.stringify(await configureBrowser(config, options.browser), null, 2));
      break;
    case "melon-extract": {
      const result = await extractMelonLikes(config, options);
      console.log(JSON.stringify({ songs: result.songs.length, complete: result.complete,
        unavailable_songs: result.unavailable_songs?.length ?? 0,
        accounted_count: result.extraction?.accounted_count ?? result.songs.length,
        total_reported: result.source?.total_reported ?? null,
        verified_unique_count: result.extraction?.verified_unique_count ?? null,
        reported_count_gap: result.extraction?.reported_count_gap ?? null,
        completion_message: result.complete ? "원본 전체 추출 검증 완료"
          : result.extraction?.stop_reason === "limit_reached" ? "요청한 부분 추출 한도에 도달했습니다. 원본 전체 추출은 미완료입니다."
          : "원본 전체 추출은 미완료입니다. stop_reason과 표시 수·검증 수 차이를 확인하세요.",
        stop_reason: result.extraction?.stop_reason ?? null, checkpoint: result.checkpoint,
        file: config.files.melonLikes }, null, 2));
      break;
    }
    case "match":
      console.log(JSON.stringify({ ...(await matchAppleMusic(config, options)), review_csv: config.files.reviewCsv }, null, 2));
      break;
    case "review":
      console.log(JSON.stringify({ ...(await reviewResults(config, options)), review_csv: config.files.reviewCsv,
        review_html: config.files.reviewHtml }, null, 2));
      break;
    case "inactive-review": {
      const result = await exportInactiveReview(config, options);
      console.log(JSON.stringify({ ...result.summary, input_revision: result.input_revision,
        output_dir: result.output_dir ?? null, already_exported: result.already_exported ?? false,
        rows: result.rows }, null, 2));
      break;
    }
    case "status":
      console.log(JSON.stringify(await localStatus(config), null, 2));
      break;
    case "settle-recovery":
      console.log(JSON.stringify(await settleRecovery(config, options), null, 2));
      break;
    case "review-recovery-candidate":
      console.log(JSON.stringify(await reviewRecoveryCandidate(config, options), null, 2));
      break;
    case "recover-followup":
      console.log(JSON.stringify(await recoverFollowup(config, options), null, 2));
      break;
    case "recover":
      console.log(JSON.stringify(await recoverSongs(config, options), null, 2));
      break;
    case "resolve":
      if (options.decisionsFile) console.log(formatDecisionsReport(await resolveDecisions(config, options)));
      else console.log(JSON.stringify(await resolveManualMatch(config, options), null, 2));
      break;
    case "resolve-unavailable":
      console.log(JSON.stringify(await resolveUnavailableMatch(config, options), null, 2));
      break;
    case "revise":
      console.log(JSON.stringify(await reviseMatch(config, options), null, 2));
      break;
    case "link-existing":
      console.log(JSON.stringify(await linkExisting(config, options), null, 2));
      break;
    case "unlink-existing":
      console.log(JSON.stringify(await unlinkExisting(config, options), null, 2));
      break;
    case "apple-auth": {
      const backend = resolveWriteBackend(options.backend);
      if (backend === "web-player") await authorizeAppleWebPlayer(config, options);
      else await authorizeAppleMusic(config, options);
      break;
    }
    case "apply":
      console.log(JSON.stringify(await applyPlaylist(config, options), null, 2));
      break;
    case "sync":
      console.log(formatSyncReport(await syncLikes(config, options)));
      break;
    case "mvp": {
      await extractMelonLikes(config, options);
      console.log(JSON.stringify({ ...(await matchAppleMusic(config, options)), review_csv: config.files.reviewCsv }, null, 2));
      break;
    }
    default:
      throw new Error(`알 수 없는 명령: ${command}`);
  }
}

main().catch((error) => {
  console.error(`오류: ${error?.message ?? error}`);
  process.exitCode = 1;
});
