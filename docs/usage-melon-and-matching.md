# Melon 추출·매칭·판정 상세

[← README](../README.md)

## Melon 로그인과 재인증

ID/PW는 프로그램이 받지 않습니다. Melon은 전용 프로필과 `--restore-last-session`으로 이전 세션을 복원합니다. 서버에서 세션이 만료되면 직접 다시 로그인해야 합니다. 같은 창에서 좋아요 목록을 주기적으로 확인하며, Melon 페이지에 보이는 `로그아웃` 표시로 로그인 완료를 확인하면 사이트의 `마이뮤직 > 좋아요` 메뉴를 눌러 곡 목록으로 자동 이동합니다. 계정별 목록 문맥은 사이트의 메뉴가 제공하며 URL 매개변수나 인증 정보를 추출하지 않습니다. 로그인 화면이나 CAPTCHA는 직접 처리하세요. 완료 표시를 감지하지 못하면 로그인 완료 후 Enter를 누르거나 직접 좋아요 목록을 열면 재개합니다. 대기 중 `q`를 입력하면 기존 결과와 checkpoint를 보존하고 종료합니다.

메뉴 이동의 15초 제한은 페이지 전환을 확인하는 시간이며, 수동 로그인 대기에는 시간 제한이 없습니다. 메뉴 또는 페이지 이동 중 Melon 로그인 화면으로 전환되면 같은 창을 앞으로 가져와 로그인 대기로 복귀합니다. 재인증 대기에서는 다른 복원 탭의 오래된 좋아요 목록을 로그인 완료로 취급하지 않습니다. 페이지를 넘기던 중 재로그인하면 전체 곡 수와 직전 검증 페이지를 다시 확인한 뒤 이어가며, 변경이 발견되면 기존 결과와 checkpoint를 보존하고 중단합니다. `--headless` 실행은 로그인 대기 대신 명확한 오류로 종료합니다.

## 매칭 기준과 재개

기본 자동 매칭 조건은 최고 점수 `0.88` 이상이면서 2위와의 차이가 `0.06` 이상인 경우입니다. 그 외에는 `ambiguous` 또는 `not_found`로 남고 자동 추가 대상에서 제외됩니다.

일반 `match` 재개는 결과 JSON의 `match_config`에 저장된 판정 기준을 그대로 사용합니다. 명시한 기준이 기존 기록과 다르거나 두 결과 파일의 기준이 서로 다르면 검색 전에 중단합니다. 기준 변경에는 `--force`가 필요합니다. 과거 파일에 기준 기록이 없으면 옵션 없는 재개는 기본값을 쓰며, 명시적으로 기준을 지정하려면 전체 재매칭해야 합니다.

검색은 요청 사이의 기본 3.1초 간격과 순차 실행을 유지합니다. 같은 실행 안에서 동일 검색과 중복 KR lookup을 메모리에 재사용하며, 한국에서 찾지 못한 ID도 해당 실행 동안 재사용합니다. 캐시는 다음 실행에 남지 않습니다. 요청·재시도·캐시 적중 횟수를 진행 상태와 최종 매칭 요약에서 확인할 수 있습니다. JSON 판정은 곡마다 저장하고, 새 검색이 끝나면 검토 CSV를 한 번 생성합니다. 검색 없는 재실행은 결과 JSON/CSV를 다시 쓰지 않으므로 필요하면 `review`를 별도로 실행하세요.

## 추출 완료와 중단 원인

곡 ID는 곡 번호 필드 또는 곡 재생·상세 링크에서 확인한 양의 정수를 사용하며, 네 자리 이하의 오래된 곡 ID도 추출합니다. 제목이나 일반 화면 숫자를 ID로 추정하지 않습니다.

복원된 차트 등 다른 탭을 제외하고 정확한 Melon 좋아요 곡 페이지에서만 추출합니다. 페이지 전체 곡 정보가 바뀌고 연속 두 번 안정적으로 읽히는지 확인한 뒤 저장합니다. 곡 제목이 없으면서 `no_result` 표시와 비활성 체크박스가 있고 곡 ID를 확인할 수 있는 행은 `unavailable_songs`에 별도로 보존하고 다음 페이지로 진행합니다. 다른 파싱 오류는 계속 `parse_skipped_rows`로 중단합니다. 비활성 행의 제목이나 가수를 만들어 매칭하지 않습니다. 이전에 저장된 정상 메타데이터는 보존하며, 해당 ID가 다시 정상 행으로 나타나면 비활성 기록을 해제합니다.

`complete=true`는 첫 페이지부터 마지막 페이지까지 해석 가능한 행을 모두 검증했다는 뜻입니다. 정상 메타데이터와 비활성 행의 고유 ID 합집합, 이번 검증의 고유 ID 수, 검증한 원본 행 수가 모두 화면의 전체 개수와 같고 다음 페이지가 없어야 합니다. 비활성 행은 Apple 매칭 성공을 의미하지 않습니다. 전체 개수가 확인되지 않거나 과거 저장 ID가 현재 목록에 더 남아 개수가 불일치하면 마지막 페이지에서도 `complete=false`입니다. 기존 데이터는 자동 삭제하지 않습니다.

`melon-extract` 요약과 `status.source.stop_reason`에서 중단 원인을 확인합니다. `checkpoint.next_start_index`는 안전하게 다시 읽을 페이지이며, 정상 저장한 페이지를 재개 시 재검증할 수 있습니다. 이동 실패 시 아직 검증하지 않은 다음 페이지로 checkpoint를 넘기지 않습니다.

`checkpoint.verified_scan`은 첫 페이지부터 확인한 행 수와 곡 ID를 보존합니다. `pages`에는 페이지 시작 번호, DOM 행 수, 실제 곡 행 수, 정상·비활성·제외 행 수와 다음 페이지 번호를 저장합니다. 같은 checkpoint 페이지를 재생해도 페이지 기록·검증 행 수·비활성 곡을 중복 집계하지 않습니다. 페이지별 기록이 없는 과거 checkpoint, 전체 개수가 바뀐 목록, 이전 검증 페이지가 변경된 경우는 기존 곡을 보존하면서 첫 페이지부터 다시 확인합니다. 부분 추출의 `--limit`은 정상 메타데이터 곡 수를 제한합니다.

곡 ID·제목·가수·앨범·곡 링크·체크박스가 없는 빈 레이아웃 행과, 한 칸의 `colspan=9` 셀에 정확히 ‘좋아요 곡이 없습니다.’라고 표시된 안내 행만 집계에서 제외합니다. 곡을 나타내는 단서가 있거나 다른 안내 문구인 행은 계속 파싱 오류로 남습니다. 빈 목록 안내로 끝나도 표시 수와 검증 수가 다르면 `total_mismatch`, `complete=false`이며, 전체 수를 임의로 낮추거나 누락 곡을 만들어 완료 처리하지 않습니다.

전체 기본 목록을 끝까지 확인했는데 표시 수에 못 미치면 아티스트 필터를 보완 조회합니다. 필터마다 마지막 페이지까지의 표시 수·행·고유 ID를 검증하고, 기본 목록과 필터 간 중복을 제거한 합집합이 전체 표시 수와 같아야 완료됩니다. 필터 해제 후 전체 표시 수를 다시 확인하며, 변경·파싱 오류·정상/비활성 분류 충돌은 완료 처리하지 않습니다. 제목·가수가 남아 있어도 체크박스가 비활성이면 메타데이터를 `unavailable_songs`에 보존하며 자동 매칭하지 않습니다. 비활성 행의 앨범명 등에서 길이를 추정하지 않습니다.

`checkpoint.verified_scan`은 기본 목록 검증 이력을 그대로 보존합니다. 보완 조회의 페이지·곡 정보는 `artist_filter_supplement`, 중복 제거한 전체 검증 집합은 `combined_verified_scan`에 따로 기록합니다. `status.source.count`는 매칭 가능한 정상 곡 수, `unavailable_count`는 비활성 고유 ID 수, `accounted_count`는 원본 ID 합집합 크기, `verified_row_count`는 보완 조회가 있으면 중복 제거한 검증 집합의 크기입니다. 기본 목록 수와 추가 확인 수는 `base_verified_row_count`, `supplemental_unique_count`로 구분합니다. 원본 수집 완료는 비활성 곡의 승인 제외나 Apple 이관 완료를 뜻하지 않습니다.

`verified_unique_count`는 이번 검증의 고유 ID 수, `verified_page_count`는 확인한 페이지 수, `reported_count_gap`은 표시된 전체 수에서 검증 고유 ID 수를 뺀 값입니다. 진행 중의 차이는 아직 읽지 않은 페이지를 포함하므로 누락 수로 해석하지 마세요. `extraction.dom_row_count`는 안내 행을 포함한 마지막 페이지 DOM 행 수이고, `ignored_row_count`는 그중 제외한 행 수입니다.

| stop_reason | 의미 |
| --- | --- |
| `completed` | 첫 페이지부터 검증한 행 수·고유 ID 수·저장 ID 합집합이 전체 개수와 같고 다음 페이지 없음 |
| `limit_reached` | 요청한 부분 추출 한도 도달 |
| `total_unavailable` / `total_mismatch` | 전체 개수 미확인 / 저장 수와 불일치 |
| `pagination_total_conflict` | 표시된 전체 수를 채웠는데 다음 페이지가 존재 |
| `empty_page_with_next` | 빈 목록 안내인데 다음 페이지가 존재하는 모순 |
| `parse_skipped_rows` | 표시된 행 중 곡 정보 파싱이 누락됨 |
| `repeated_page` | 페이지 반복. 이미 저장된 곡만 있는 새 페이지는 전체 검증을 위해 계속 확인함 |
| `no_song_rows` / `navigation_failed` | 곡 행 없음 / 페이지 이동 검증 실패 |

중단 원인은 프로그램이 확인한 상태이며, Melon 서버·로그인·DOM 변경 중 무엇이 근본 원인인지를 자동으로 단정하지 않습니다. `complete=false`인 결과는 전체 추출로 취급하지 마세요.

## 로컬 진행 상태

`status`는 현재 원본의 곡 ID 집합에 대해 매칭 `processed`, `unprocessed`, `complete`를 계산합니다. 이 `matching.complete`는 추출된 모든 곡에 판정이 있다는 뜻이며, 원본 전체 추출 여부인 `source.complete`와 별개입니다. `operations`는 다음 Git ignored 파일의 최근 실행 상태를 표시합니다.

`summary`와 `next_commands`는 원본 전체 추출 여부, 미처리·미결·보류, 승인 범위의 로컬 추가 대기 및 다음 명령을 함께 안내합니다. 원격 상태는 `apply --check`로 별도 확인해야 합니다. `melon-extract`의 `completion_message`는 부분 한도 도달과 전체 완료를 구분하고 표시 수·검증 고유 수·차이도 출력합니다.

`match`와 `mvp`의 판정 요약은 수동 승인·교체·보류를 반영한 현재 유효 결과입니다. `searched`와 `reused`는 자동 검색 작업의 통계입니다. 새 검색이 없는 경우 검토표를 자동으로 다시 쓰지 않으며 `review_state`로 CSV·HTML 존재, 이번 생성 여부와 입력 변경 여부(`stale`; 확인 기록이 없으면 `null`)를 알립니다. 파일 부재 또는 변경이 확인되면 `next_command=review`를 안내합니다.

- `.state/melon-extraction-run.json`: 브라우저 시작·로그인 대기·추출 단계, 저장 수, checkpoint와 중단 원인
- `.state/matching-run.json`: 처리·남은 수, 검색·재사용 수, 요청 통계, 경과 시간과 예상 잔여 시간
- `.state/review-run.json`: 검토 CSV 생성 완료·실패와 행 수

정상 종료는 `completed`, 부분 추출은 `partial`, 사용자 중단은 `cancelled`, 오류는 `failed`로 기록됩니다. 실행 중으로 저장됐지만 PID가 사라지면 파일을 변경하지 않고 `interrupted`로 표시합니다. PID 확인은 보조 신호이며 PID 재사용까지 판별하지는 않습니다. 원본이 달라졌거나 검토 CSV의 입력 결과가 바뀌면 해당 과거 상태는 `stale`입니다. 예상 잔여 시간은 이번 실행의 완료 곡 평균에 따른 추정치이며 검색을 아직 완료하지 않았다면 `null`입니다. 이 파일은 로컬 관찰용이며 자동 예약이나 외부 알림을 등록하지 않습니다.

`review.csv`에는 `candidate_count`와 `match_reasons`가 추가됩니다. `no_candidates`, `below_threshold`, `insufficient_margin`, `version_mismatch` 등으로 사람이 검토할 이유를 구분합니다. 과거 JSON의 이유는 저장된 점수와 기준으로 추정하며 원본 JSON을 다시 쓰지 않습니다. 과거에는 상위 후보를 5개까지만 저장했으므로 후보 5개인 기록의 수는 정확한 총수 대신 `5+`로 표시합니다.

`review` 요약의 `source`는 원본 파일 부재(`present=false`, `count=null`), 실제 빈 원본(`count=0`), 판정·미처리 수를 구분합니다. 아직 판정 없는 원곡은 검토표에 `unprocessed` / ‘아직 검색하지 않음’으로 표시하며 `not_found` 판정을 저장하지 않습니다. 비교 화면의 ‘미처리’ 범위에서 따로 볼 수 있습니다. JSON 문법이나 곡 배열 구조가 잘못된 입력은 해당 파일과 복구 안내를 표시하고 기존 음악 자료를 보존합니다.

`review`는 `data/review.html`도 함께 만듭니다. 브라우저에서 열면 원곡과 저장된 모든 후보의 제목·가수·앨범·길이·ISRC·등급·ID/링크·점수를 나란히 비교할 수 있습니다. 후보별 참여 가수·버전 차이와 별칭 분석도 펼쳐볼 수 있습니다. 우선 검토, 미확정, 보류, 전체 범위와 제목·가수·앨범·ID 검색을 제공하며 20곡씩 표시합니다. 우선 검토는 저장 점수가 검색 기준 이상인 미확정 곡이며 자동 승인 대상이 아닙니다.

별도 재검색 결과가 있으면 `node src/cli.js review --candidates-dir PATH`로 해당 디렉터리의 `matched.json`과 `unmatched.json`을 비교 화면에만 사용할 수 있습니다. 두 파일에 같은 `match_config`가 있어야 하고 원곡 정보가 현재 원본과 일치해야 합니다. 이미 승인하거나 보류한 곡에는 별도 후보를 적용하지 않습니다. `review.csv`와 명령 요약은 계속 현재 유효 판정을 표시하며, HTML은 별도 검색 결과임을 구분합니다. 원곡 정보 불일치·중복 ID·판정 기준 불일치 시 보고서 생성을 중단합니다.

비교표 생성은 저장된 로컬 결과만 읽으며 새 검색, 원격 재생 검사, 판정 저장, Apple 계정 변경을 하지 않습니다. 링크가 없으면 임의로 만들지 않습니다. HTML은 생성 당시 자료이므로 판정이나 후보가 바뀌면 다시 생성하세요. `review.html`도 개인 음악 목록을 포함하므로 Git에서 제외합니다.

## 수동 매칭

`not_found`/`ambiguous` 곡은 첫 명령에서 한국 iTunes lookup 결과를 미리 보고, 같은 명령에 `--confirm`을 추가했을 때만 자동 결과와 분리된 `data/manual_matches.json`에 저장할 수 있습니다.

```sh
# 미리보기: 파일을 변경하지 않음
node src/cli.js resolve --melon-song-id MELON_ID --apple-url "https://music.apple.com/kr/album/...?...i=APPLE_ID"

# 표시된 제목·아티스트·앨범을 사람이 확인한 뒤에만 저장
node src/cli.js resolve --melon-song-id MELON_ID --apple-song-id APPLE_ID --confirm
```

수동 확인 결과는 `manual_confirmed` provenance로 유지되며 자동 매칭으로 둔갑하지 않습니다. 한국 iTunes lookup은 계정 재생 가능성이나 `playParams`를 보장하지 않으므로 실제 쓰기 전 `apply --check`에서 선택 backend의 한국 catalog를 다시 확인해야 합니다.

`resolve --confirm`은 판정 저장(`saved`)과 CSV·HTML 갱신(`review_updated`) 결과를 구분합니다. 저장 후 검토표 생성이 실패하면 `saved=true`, `review_updated=false`, `next_command=review`를 반환합니다. 파일 장애를 해결하고 `review`를 실행하거나 같은 승인을 다시 실행하면 기존 승인 자료를 다시 쓰지 않고 검토표를 복구합니다.

## 결정 파일로 한 번에 수동 승인

`review.html`의 미확정(`ambiguous`/`not_found`) 곡 카드에서 고른 결과를 `review-decisions.json`으로 내려받아 한 번에 승인합니다. 저장되는 기록은 곡별 `resolve --confirm`과 같은 검사를 거친 `manual_confirmed` 기록입니다.

```sh
# 미리보기: 파일을 변경하지 않음. 곡별 저장 예정·이미 승인·제외 사유와 HASH 출력
node src/cli.js resolve --decisions-file "$HOME/Downloads/review-decisions.json"

# 미리보기 목록을 확인한 뒤 저장
node src/cli.js resolve --decisions-file "$HOME/Downloads/review-decisions.json" --confirm --expected-preview HASH
```

- 선택 방법은 세 가지입니다. 후보 직접 선택(`candidate`), Apple Music 링크 붙여 넣기(`url`), 한꺼번에 고르기(`bulk_top1`)이며 건너뛴 곡은 파일에 들어가지 않습니다. 기본 보기는 결정할 곡 전체이고, **결정할 곡 중 아직 안 고른 곡** 보기로 남은 곡만 볼 수 있습니다.
- **비슷한 후보로 한꺼번에 고르기**는 지금 보이는 목록(보기·검색 결과)에서 아직 고르지 않은 곡에만 적용됩니다. 1순위 점수가 판정 기준(기본 0.88) 미만이거나 버전 차이·참여 가수 차이가 표시된 곡, 후보가 없는 곡은 제외하고 '직접 골라 주세요'로 표시합니다. 이미 직접 고른 곡은 덮어쓰지 않으며 **한꺼번에 고른 것 취소**는 한꺼번에 고른 곡만 되돌립니다.
- 일괄 선택으로 저장한 기록에는 `manual_selection: "bulk_top1"`이 남아 나중에 따로 다시 검토할 수 있습니다.
- 제외되는 곡: 이미 자동 매칭된 곡, 로컬 판정(보류·교체)이 있는 곡(→ `revise`), 복구 이력이 있는 곡, 기존 곡 연결이나 연결 해제 이력이 있는 곡(→ 개별 `resolve`), 다른 곡으로 이미 수동 승인된 곡, 다른 원곡에 이미 쓰인 Apple ID, 파일 안에서 같은 Apple ID를 여러 곡에 고른 경우, 한국 lookup에 없는 ID.
- 수락된 곡만 저장하고 제외된 곡은 그대로 미결로 남습니다. HASH는 현재 로컬 판정 snapshot과 저장할 기록 전체에 묶여 있어, 미리보기 이후 하나라도 바뀌면 저장하지 않고 새 미리보기를 요구합니다.
- 검토표를 만든 뒤 로컬 판정이 바뀌었으면 경고를 출력하고 각 곡을 현재 상태로 다시 검사합니다.
- 같은 파일을 다시 실행하면 이미 승인된 곡은 `이미 승인`으로 표시만 하고 다시 쓰지 않습니다.
- 이 명령은 Apple Music 계정을 바꾸지 않습니다. 저장한 곡은 이후 `sync` 미리보기에서 추가 예정 곡으로 표시됩니다.

## 기존 자동 매칭의 교체·보류

`resolve`는 기존 자동 매칭을 덮어쓰지 않습니다. 검토한 자동 매칭은 `revise`로 변경 전후를 먼저 확인한 뒤 승인할 수 있습니다. 후보 교체는 한국 iTunes catalog를 조회하며, `--hold` 미리보기는 네트워크를 사용하지 않습니다. `--reason`에 검토 사유를 지정합니다.

비활성 원곡의 Apple 대응은 `resolve-unavailable`로 별도 승인합니다. 정상 원곡은 기존 `resolve`를 사용하세요. 첫 명령은 한국 lookup과 로컬 중복을 확인한 미리보기이며 저장하지 않습니다. 원곡·후보·사유·전체 로컬 snapshot이 같을 때만 HASH로 승인할 수 있습니다.

```sh
node src/cli.js resolve-unavailable --melon-song-id MELON_ID --apple-song-id APPLE_ID --reason "검토한 근거와 수락한 한계"
node src/cli.js resolve-unavailable --melon-song-id MELON_ID --apple-song-id APPLE_ID --reason "검토한 근거와 수락한 한계" --confirm --expected-preview HASH
node src/cli.js review
```

승인한 대응은 `data/unavailable_matches.json`에 원본 비활성 행 전체·후보·사유·승인 시각·미리보기 HASH를 보존합니다. Melon 원본과 기존 정상곡 판정은 변경하지 않습니다. 같은 원곡의 저장 이력은 덮어쓰지 않으며, 기존 선택 곡/checkpoint와 같은 Apple ID는 별도 재사용 검토가 필요합니다. 원본 변경·누락·정상곡 복귀·원곡 ID 중복 또는 다른 선택 곡과 Apple ID 중복이 발생하면 해당 대응은 보류로 표시하고 모든 apply 모드에서 제외합니다.

`status.unavailable_matching`은 저장·유효 승인·원본 변경·중복·현재 비활성 미결 수를 정상곡 집계와 따로 표시합니다. 유효 승인 대응만 기존 apply 대상에 포함됩니다. 판정 저장은 계정 추가가 아니며, 실제 적용 전에는 최신 catalog/playParams와 전체 보관함 중복을 별도로 검사하고 적용 범위를 승인해야 합니다. lookup 통과는 같은 녹음의 증명이 아닙니다. `resolve-unavailable` 저장 후에는 `review`를 실행해 CSV·HTML을 갱신하세요.

원본 행에 제목·가수·앨범이 없으면 `--evidence-file PATH`가 필요합니다. 공개 근거 파일의 정확한 원곡/Apple ID·현재 원본 해시·메타데이터·출처를 검증하고, 미리보기에 추출 원본과 공개 정보를 나눠 표시합니다. 승인 HASH는 실제 파일 바이트와 근거 snapshot에도 묶이며, 승인 저장 시 공개 근거 전체와 출처·확인 시각·해시를 이력에 포함합니다. 원본 비활성 행은 그대로 유지합니다. 기존에 제목·가수·앨범이 있는 승인 이력은 그대로 읽습니다.

```sh
node src/cli.js resolve-unavailable --melon-song-id MELON_ID --apple-song-id APPLE_ID --reason "검토 사유" --evidence-file PATH
# 위 미리보기와 한계를 승인한 경우에만 동일 옵션에 추가:
# --confirm --expected-preview HASH
```

근거 JSON의 정확한 schema와 변경 감지 규칙은 `src/unavailable-evidence.js`와 `test/unavailable-evidence.test.js`를 참고하세요. 근거 파일을 읽는 명령 자체가 공개 웹페이지나 계정 재생을 새로 검증하는 것은 아닙니다.

```sh
# 보류 미리보기: 기존 파일이나 계정을 변경하지 않음
node src/cli.js revise --melon-song-id MELON_ID --hold --reason "참여 가수 추가 확인 필요"

# 후보 교체 미리보기
node src/cli.js revise --melon-song-id MELON_ID --apple-song-id APPLE_ID --reason "원곡 참여자와 앨범 확인"

# 표시된 변경을 승인한 뒤, 같은 옵션에 preview_hash를 지정하여 저장
node src/cli.js revise --melon-song-id MELON_ID --hold --reason "참여 가수 추가 확인 필요" --confirm --expected-preview PREVIEW_HASH
```

미리보기 이후 원본·매칭·수동 승인·checkpoint·변경 이력 또는 후보 정보가 달라지면 저장하지 않고 새 미리보기를 요구합니다. 기존 수동 승인 곡과 이미 Apple checkpoint에 적용된 곡은 `revise`로 변경할 수 없습니다. 다른 선택 곡이나 checkpoint와 중복되는 후보 ID도 거부합니다.

승인한 변경은 `data/match_decisions.json`에 변경 전 원본, 교체 후보, 사유, 승인 시각과 이전 revision을 누적 저장합니다. `matched.json`, `unmatched.json`, `manual_matches.json`, Melon 원본과 Apple checkpoint는 그대로 보존됩니다. 기존 결과에서 값을 지우거나 파일을 편집할 필요가 없습니다. 승인 저장 후 `review.csv`를 갱신하며, 갱신 실패 시에도 `saved=true`, `review_updated=false`, `next_command=review`로 저장 여부와 후속 작업을 구분합니다.

`review`, `status`, 모든 `apply` 모드는 최신 로컬 판정을 공통으로 사용합니다. 보류곡은 `held`로 표시하며 dry-run/check/execute에서 제외합니다. 교체 곡은 `manual_confirmed`와 `manual-user-revised-itunes-lookup-kr` provenance로 표시하고, 새 ID만 선택합니다. `status.matching`의 `held`, `revised`, `stale_decisions`로 해당 수를 확인할 수 있습니다. `review.csv`에는 사유·revision·승인 시각·원본 변경 여부가 함께 표시됩니다.

일반 재매칭과 `match --force`도 이 승인을 지우지 않습니다. 승인 당시 원곡 정보가 달라지면 기존 교체를 자동으로 적용하지 않고 보류로 표시합니다. 새 원곡과 후보를 다시 미리 보고 승인해야 실행 대상에 들어갑니다. 기록이 손상되거나 기존 수동 승인과 충돌하면 자동 매칭으로 돌아가지 않고 중단합니다. 교체·보류 저장과 `apply --execute`는 checkpoint와 판정 파일의 잠금을 공유하므로 서로 실행 중인 상태에서 판정을 바꾸거나 동시에 저장할 수 없습니다.

보류를 해제하려면 검토한 후보를 `revise --apple-song-id ...`로 다시 승인합니다. 이 기능은 Apple 계정을 수정하거나 이미 추가한 곡을 삭제하지 않으며, 새 후보의 실제 계정 재생 가능성은 별도의 `apply --check`가 필요합니다. 검토표를 만드는 것만으로 판정이 저장되지는 않습니다.

## 이미 이관한 곡에 추가 원곡 연결

`link-existing`은 미결 원곡을 이미 확정·이관된 다른 정상 원곡의 Apple ID에 연결합니다. 정상 미결(`ambiguous`/`not_found`)과 공개 근거가 있는 미결 비활성 원곡을 지원합니다. `linked_existing`은 해결된 원곡으로 집계하며 Apple 추가 대상에서는 제외합니다. `unlink-existing`은 로컬 연결을 취소합니다.

```sh
# 근거 JSON을 준비한 뒤 현재 KR playlist/catalog/library를 읽어 미리보기
node src/cli.js link-existing --melon-song-id MELON_ID --anchor-melon-song-id ANCHOR_ID --apple-song-id APPLE_ID --backend web-player --evidence-file PATH --reason "원곡 대응 검토"

# 사람이 정확한 연결과 불확실성을 승인한 뒤 10분 안에 같은 옵션과 hash로 저장
node src/cli.js link-existing --melon-song-id MELON_ID --anchor-melon-song-id ANCHOR_ID --apple-song-id APPLE_ID --backend web-player --evidence-file PATH --reason "원곡 대응 검토" --confirm --expected-preview PREVIEW_HASH

# 연결 취소는 원격 조회 없이 미리보기 → 같은 옵션에 --confirm --expected-preview HASH
node src/cli.js unlink-existing --melon-song-id MELON_ID --reason "연결 재검토"
```

미리보기는 `.state/existing-link-previews/`에 승인용 자료를 저장합니다. 확인 전 음악 판정 파일이나 연결 이력을 바꾸지 않습니다. 연결·취소는 별도 `data/existing_song_links.json`에 이력을 누적합니다. 원본·기준 판정·근거·checkpoint 또는 원격 대상이 달라지면 저장을 거부합니다. 제목 일치만으로 같은 녹음이라고 판정하지 않으며, 근거 파일의 불확실성 수락은 별도의 사용자 승인 내용을 기록해야 합니다.

비활성 원곡은 `identity_basis`를 `user_accepted_confirmed_anchor`로 지정하고 기존 연결 근거에 `unavailable_origin`을 포함합니다. `unavailable_origin.document`는 `resolve-unavailable`과 같은 형식의 공개 메타데이터·출처·원본 해시·한계 문서입니다. `unavailable_origin.artists`에는 공개 Melon 가수의 `{ "id": "숫자 ID", "name": "가수명" }` 배열을, `unavailable_origin.release_date`에는 `YYYY-MM-DD` 발매일을 넣습니다. 정상 기준 원곡의 수동 승인과 제목·가수·참여자 일치를 확인하며, 유효한 연결은 `status.unavailable_matching.linked_existing`에 표시합니다. 취소하면 현재 비활성 원곡은 미결로 돌아갑니다. 복구 보존 항목이 있는 경우 연결 검사에서 현재 플레이리스트와 checkpoint에 묶인 보존 검증을 사용합니다.

변경된 연결은 보류로 표시합니다. 취소 후에도 자동 매칭으로 안전하게 돌아갈 수 없으면 보류를 유지하고, 검토한 후보의 `resolve` 미리보기를 `--confirm --expected-preview HASH`로 승인해야 합니다. `apply --check`/`--execute`는 활성 연결의 기존 원격 곡도 재검증하며 연결 원곡을 추가 요청에 넣지 않습니다. 상세 근거 형식과 복구 조건은 `src/existing-song-links.js`와 `test/existing-song-links.test.js`를 참고하세요. 실제 연결은 별도 승인 전까지 저장하지 않습니다.

## 새 좋아요 한 번에 반영

`sync`는 `melon-extract` → `match` → `review` → `apply --check`를 이어서 실행하고, 승인한 경우에만 `apply --execute`와 사후 `apply --check`를 수행합니다. `--backend official|web-player`는 생략할 수 없습니다.

```sh
node src/cli.js sync --backend web-player
node src/cli.js sync --backend web-player --execute --expected-preview HASH
```

기본 실행(미리보기)의 단계와 중단 조건:

1. **추출**: 이전 추출이 `complete=true`여도 첫 페이지부터 다시 검증합니다. `--force`와 달리 저장된 곡·비활성 기록을 비우지 않고 새 곡만 더합니다.
2. **추출 완료 확인**: `complete=true`이고 `stop_reason=completed`가 아니면 매칭·원격 확인으로 넘어가지 않고 원인만 출력합니다. Melon에서 좋아요를 취소한 곡이 있으면 저장 ID가 표시 수보다 많아 `total_mismatch`로 멈춥니다(기존 데이터를 자동 삭제하지 않는 정책).
3. **매칭**: `--force` 없이 실행하므로 이미 판정한 곡은 다시 검색하지 않고 저장된 판정 기준을 그대로 씁니다. 미처리 곡이 남으면 멈춥니다.
4. **검토표**: 입력이 바뀐 경우에만 `review.csv`/`review.html`을 다시 만듭니다.
5. **원격 확인**: `apply --check`와 같은 읽기 전용 대조로 이번에 추가될 곡을 정합니다.

출력에는 새로 들어온 Melon 곡과 판정, 수동 검토가 필요한 새 곡(`ambiguous`/`not_found`/보류 등), 새 비활성 곡 수, 추가 예정 곡, 현재 플레이리스트 항목 수와 실행 명령이 표시됩니다. 추가할 곡이 없거나 미해결 복구가 있으면 실행 명령을 표시하지 않습니다.

`--execute --expected-preview HASH`:

- Melon 추출과 매칭을 다시 하지 않습니다. 원본 완료·미처리 0곡을 다시 확인하고 읽기 전용 대조를 다시 실행합니다.
- HASH는 backend, storefront, 도구가 기록한 playlist ID, 순서가 있는 추가 Apple ID 목록, 로컬 판정·checkpoint 파일 snapshot에 묶입니다. 미리보기 이후 하나라도 바뀌면 계정을 변경하지 않고 새 미리보기를 요구합니다. 같은 HASH는 추가 후 다시 쓸 수 없습니다.
- 실제 추가는 기존 `apply --execute`(실행 잠금, 100곡 배치, 배치별 반영 확인, 불명확한 POST 재전송 금지)를 사용합니다. 잠금 안에서 계산한 추가 대상이 승인 목록과 다르면 쓰기 전에 중단합니다.
- 추가 후 `apply --check`로 플레이리스트 항목 수, 남은 대기, 중복을 확인해 출력합니다.

`sync`는 수동 판정·보류·연결·복구 이력과 `apple_import_state.json`을 직접 쓰지 않습니다. 새 곡의 수동 검토는 기존 `resolve`/`revise` 등으로 처리한 뒤 `sync`를 다시 실행하세요. 세부 출력이 필요하면 단계별 명령을 사용할 수 있습니다.
