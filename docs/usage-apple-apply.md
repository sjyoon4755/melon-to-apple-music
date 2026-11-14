# Apple Music 인증과 적용 상세

[← README](../README.md)

쓰기 backend는 자동 전환되지 않으며 `--backend official` 또는 `--backend web-player`로 명시적으로 선택합니다. 생략하면 기존과 같이 `official`입니다.

## 공식 backend

Apple 공식 MusicKit on the Web을 통해 Music User Token을 받습니다.

이 단계는 Apple Developer Program 회원 자격과 developer token이 필요합니다. Apple Music 구독만으로는 실행할 수 없습니다. 로컬 매칭 결과 생성에는 이 단계가 필요하지 않습니다.

developer token 설정(`APPLE_MUSIC_DEVELOPER_TOKEN`, 또는 `APPLE_MUSIC_TEAM_ID`·`APPLE_MUSIC_KEY_ID`·`APPLE_MUSIC_PRIVATE_KEY_PATH`)은 홈 폴더의 `.melon-to-apple-music/.env`에 둡니다.

사용자가 Apple Music 앱에서 플레이리스트를 직접 만들어도 곡 자동 추가의 인증 조건은 바뀌지 않습니다. 기존 플레이리스트에 곡을 추가하는 공식 API도 developer token과 Music User Token을 모두 요구합니다.

```sh
melon-to-apple-music apple-auth --backend official
```

터미널에 표시된 `http://127.0.0.1:43117/` 주소를 브라우저에서 열고 로그인·접근 허용을 직접 수행하세요. 토큰은 `data/.apple-music-user-token`에만 저장되고 출력되지 않습니다.

먼저 dry-run으로 확인합니다.

```sh
melon-to-apple-music apply --dry-run --backend official --limit 2 --name "Melon Likes Import"
```

dry-run은 로컬 결과와 checkpoint만 읽는 계획이며 출력의 `remote_checked`는 `false`입니다. 계정을 변경하지 않고 현재 session, storefront, playlist/checkpoint, catalog `playParams`를 확인하려면 다음 읽기 전용 검사를 실행합니다.

```sh
melon-to-apple-music apply --check --backend official --limit 2
```

검토가 끝났을 때만 실제 적용합니다.

```sh
melon-to-apple-music apply --execute --backend official --limit 2 --name "Melon Likes Import"
```

첫 실제 실행은 새 비공개 Library Playlist를 만들고 그 ID를 `data/apple_import_state.json`에 기록합니다. 재실행은 **이 도구가 기록해 둔 바로 그 플레이리스트**에만 아직 추가하지 않은 곡을 이어서 추가합니다. 상태 파일이 없으면 기존 플레이리스트를 이름으로 찾아 재사용하지 않고 새로 만듭니다.

## Web-player backend(명시적 opt-in, 비공식)

Apple Developer Program에 가입하지 않은 개인 사용자는 Apple Music 웹 플레이어가 쓰는 `amp-api.music.apple.com` backend를 명시적으로 선택할 수 있습니다. 이 경로는 Apple이 외부 앱용 계약이나 안정성을 보장한 API가 아니며 웹 bundle·header·cookie 정책이 바뀌면 깨질 수 있습니다.

```sh
melon-to-apple-music apple-auth --backend web-player
melon-to-apple-music apply --dry-run --backend web-player --limit 2 --name "Melon Likes Import"

# session/catalog/playlist를 읽기만 하는 원격 검사
melon-to-apple-music apply --check --backend web-player --limit 2

# 검토와 별도 승인, 보관함 설정 확인이 끝난 뒤 첫 시험에만 실행
melon-to-apple-music apply --execute --backend web-player --limit 2 --name "Melon Likes Import"
```

`apply --limit N`은 자동 매칭 뒤 수동 확인 결과를 이은 적용 목록의 처음 N개 고유 곡만 누적 적용 대상으로 제한합니다. 첫 1~2곡의 플레이리스트 반영과 Library Song 부작용을 확인한 뒤에만 `--limit`을 늘리거나 제거하세요. `web-player`는 환경 변수로 기본 선택할 수 없으며, 매번 `--backend web-player`를 적어야 합니다.

`apply --max-add N`은 **이번 실행에서 새로 추가할 고유 Apple ID 수**를 최대 N개로 제한합니다. N은 양의 안전한 정수여야 하며, 생략하면 기존의 제한 없는 신규 추가 동작을 유지합니다. `--limit`과 함께 지정하면 먼저 누적 대상 범위를 정하고 그 범위 안에서 신규 추가 수를 제한합니다. 자동 매칭 뒤 수동 확인 결과를 이은 입력 순서를 유지하고 Apple ID 중복을 제거합니다.

```sh
# 로컬 checkpoint에서 이미 적용한 곡을 제외하고 신규 최대 2곡을 계획
melon-to-apple-music apply --dry-run --backend web-player --max-add 2

# 실제 플레이리스트와 대조하는 읽기 전용 검사
melon-to-apple-music apply --check --backend web-player --max-add 2

# 누적 대상 처음 100개 고유 곡 범위에서 이번 실행 신규 최대 2곡
melon-to-apple-music apply --check --backend web-player --limit 100 --max-add 2

# 실제 계정 쓰기 명령: 사용자가 별도로 실행을 승인한 경우에만 사용
melon-to-apple-music apply --execute --backend web-player --max-add 2
```

예를 들어 1,616곡 중 처음 16곡이 checkpoint에 있으면 `--limit 2`는 이미 적용한 2곡만 대상으로 삼습니다. 반면 `--max-add 2`는 대기 목록의 다음 2곡을 선택합니다. dry-run은 `plan_basis="local_checkpoint"`, `remote_checked=false`인 로컬 계획이므로 서버에만 존재하는 곡까지 제외했다고 해석하면 안 됩니다.

check와 execute는 전체 checkpoint의 반영 여부, backend/storefront, playlist 편집 가능 상태를 검증하고 누적 대상의 catalog/playParams를 확인한 뒤, 실제 플레이리스트에 없는 검증된 신규 곡을 동일한 순서로 선택합니다. 서버에 존재하지만 checkpoint에 없는 곡과 catalog 검증을 통과하지 못한 곡은 신규 한도를 소비하지 않습니다. `--max-add`를 지정한 실행에서 신규 대상이 없으면 플레이리스트를 새로 만들지 않습니다. 실행은 기존 100곡 배치와 배치별 반영 확인을 유지합니다.

`--max-add` 결과에는 `max_add`, `eligible_new`(한도 적용 전 신규 후보 수), `deferred_new`(한도로 다음 실행에 남긴 수), `selected_add_song_ids`(이번 신규 대상 ID)를 표시합니다. dry-run의 `would_add`와 check의 `pending_verified`는 한도 적용 후 수이며, execute의 `added_this_run`은 실제 확인된 신규 추가 수입니다. 동일 입력과 원격 상태의 check/execute는 같은 `selected_add_song_ids`를 선택하지만, 두 실행 사이 원격 상태가 바뀌면 다시 대조한 결과를 사용합니다.

모든 apply 계획에는 원본 추출 상태인 `source`와 이번 신규 대상의 Apple 제목·가수·ID 및 대응 원곡 목록인 `selected_add_songs`를 표시합니다. 저장된 제목·가수가 없으면 `null`이며 임의로 채우지 않습니다. 같은 Apple ID에 대응하는 원곡은 한 신규 항목 안에 함께 표시합니다.

`apply --check`의 `playlist_diagnostics`는 선택 범위의 `server_present`와 별도로 전체 플레이리스트의 항목 수·catalog 고유 수·catalog ID 없는 항목 수·중복 ID와 빈도·예상 밖 ID·checkpoint 미기록 ID를 출력합니다. `--limit`/`--max-add`를 지정해도 전체 목록과 전체 checkpoint를 확인합니다. 예상 밖 ID는 현재 전체 선택과 checkpoint 모두에 없는 ID이며 사용자 수동 추가일 수도 있습니다. 진단만 제공하고 자동 삭제하지 않습니다. checkpoint 곡 누락은 기존처럼 자동 재추가하지 않고 중단합니다. 이 진단은 보관함 대조나 전체 이관 완료 판정이 아닙니다.

`melon-to-apple-music COMMAND --help` 또는 `-h`는 해당 명령의 사용법을 표시합니다. `--execute`와 함께 지정해도 도움말만 출력하며 환경 파일·브라우저 설정·인증을 읽기 전에 종료합니다. 문자열 옵션의 inline 형식(`--name=검토=플레이리스트`)은 첫 `=` 이후 값을 모두 보존합니다.

인증 명령은 공통 브라우저 설정으로 해석된 Apple Music 전용 persistent profile만 엽니다. Apple ID 로그인과 2FA는 사용자가 직접 처리하며 프로그램은 credentials를 읽거나 대신 입력하지 않습니다. `media-user-token`은 profile cookie에서 매번 읽어 메모리에서만 사용합니다. AMPWebPlay Bearer도 Apple Music web bundle에서 자동 추출해 JWT `exp` 기준으로 메모리 cache를 갱신합니다. 이 두 web-player token은 console, import state, 결과 파일에 저장하지 않습니다. 공식 backend의 기존 MusicKit 인증 방식은 이 설정의 영향을 받지 않습니다.

| backend | 인증 | 위치 | 판단 |
| --- | --- | --- | --- |
| `official` | developer token + Music User Token | `api.music.apple.com` | 가장 안정적이며 Program 가입 사용자용으로 유지 |
| `web-player` | AMPWebPlay Bearer + `media-user-token` | `amp-api.music.apple.com` | Program 미가입 개인 사용자를 위한 opt-in 실험 기능 |

`match`는 어느 backend도 사용하지 않고 계속 무인증 iTunes Search API를 사용합니다. 쓰기 직전 선택한 backend에서 catalog ID와 `playParams`를 batch 검증하며, 검증된 `type: songs`만 새 도구 전용 플레이리스트에 직접 추가합니다.

## Library Song 직접 호출과 보관함 설정

Apple의 플레이리스트 곡 추가 요청은 카탈로그 ID를 `type: "songs"`로 직접 받을 수 있으므로, 먼저 `/v1/me/library`에 Library Song으로 추가할 필요가 없습니다. 다만 Apple Music 계정의 **플레이리스트에 추가할 때 보관함에 노래 추가** 설정이 켜져 있으면 서버가 곡을 보관함에도 추가할 수 있고, API 요청마다 이를 끄는 별도 플래그는 확인되지 않았습니다.

보관함 추가를 원하지 않으면 Apple Music의 해당 설정을 끈 뒤 1~2곡으로 먼저 확인해야 합니다. 설정 위치는 Windows용 Apple Music 앱은 `설정 > 고급`, Mac의 음악 앱은 `음악 > 설정 > 고급`입니다. 실제 계정에서 설정을 켠 채 2곡으로 시험했을 때 곡이 플레이리스트와 보관함에 함께 들어가고 Favorite는 바뀌지 않았습니다. 플레이리스트 자체는 Library Playlist로 생성되지만 이 도구가 개별 곡을 Library Song endpoint로 먼저 추가하지는 않습니다.

## Apple 적용 실행 잠금

`apply --execute`는 원격 adapter 생성/조회와 checkpoint 처리에 앞서 로컬 파일시스템의 원자적 `mkdir`로 잠금을 확보하고 종료까지 유지합니다. 동일한 canonical checkpoint 경로는 하나의 실행만 허용합니다. 저장된 playlist ID가 있으면 backend와 작업 폴더가 달라도 같은 ID를 추가로 잠급니다. 새 playlist는 생성 후 ID를 확보한 즉시 잠그고 checkpoint를 저장합니다. 서로 다른 checkpoint와 playlist는 독립 실행할 수 있습니다. checkpoint 파일 자체의 symbolic link는 지원하지 않습니다.

잠금은 같은 OS 사용자와 머신의 `~/.melon-to-apple-music/apply-locks/<대상 SHA-256>/`에 저장합니다. 계정 식별 정보를 읽지 않으므로 서로 다른 계정이라도 playlist ID가 같으면 보수적으로 충돌합니다. 다른 머신/OS 사용자 또는 잠금 기능이 없는 이전 버전/직접 adapter 호출과의 동시 실행은 보호 범위 밖입니다. `config.applyLockDir`는 임시 fixture 테스트 전용 주입점이며 실제 실행에서는 공통 기본 경로를 사용합니다.

각 잠금은 실행별 UUID, PID, 시작 시각, loopback 상태 확인 포트를 기록합니다. `status`의 `operations.apply`는 `data/apple_import_state.json.run.json`에서 시작/단계/확인된 추가 수/종료/고정 실패 사유를 읽습니다. 실행별 UUID가 일치하는 loopback 응답이 있어야 `running`으로 표시합니다. 응답이 없고 PID가 사라졌으면 `interrupted`, PID가 살아 있거나 소유권 확인이 불가능하면 `unknown`입니다. PID 재사용만으로 실행 중이라고 판정하지 않습니다. 정상/오류 종료는 자신의 UUID가 일치하는 잠금만 해제하며, 강제 종료는 잠금을 남깁니다. 단계는 `starting`, `validating`, `creating_playlist`, `adding_batch`, `confirming_batch`, `saving_checkpoint`, `finished`입니다. 실패는 `failed`, 완료는 `completed`로 표시합니다.

중단, 오래된 시각, 죽은 PID, `unknown`, 잘못된 owner JSON은 **자동 잠금 삭제나 재시도 사유가 아닙니다**. 복구하려면 관련 실행을 모두 중지하고 잠금·실행 상태·checkpoint를 보존한 상태에서 원격 playlist와 마지막 단계의 결과를 별도로 확인해야 합니다. 소유권/원격 반영이 불명확하면 계속 차단합니다. 확인을 마친 잠금의 수동 격리 후에만 재개하고, 특히 playlist 생성 중단은 생성 여부를 확인하기 전 재실행하지 않습니다. 자동 해제 명령이나 TTL 강제 해제 옵션은 제공하지 않습니다.

적용 상태/새 오류 로그에는 인증 값, 요청 헤더, 응답 원문, 프로필 내용, adapter 오류 원문을 저장하지 않습니다. 100곡 배치, 실제 반영 확인 후 checkpoint 저장, 불명확한 POST의 무조건 재시도 금지는 유지됩니다. dry-run과 `--check`는 잠금 및 실행 상태 파일을 만들거나 checkpoint를 수정하지 않습니다.
