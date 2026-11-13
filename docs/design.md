# 설계 메모와 조사 결과

조사일: 2026-09-11

## 선택한 구조

```text
Selected Chrome/Edge + dedicated Melon profile
        ↓
data/melon_likes.json
        ↓
iTunes Search candidates (us, fallback jp)
        ↓
iTunes lookup (kr) availability filter
        ↓
matched.json + unmatched.json + review.csv
        ↓ optional explicit manual confirmation
manual_matches.json
        ↓ local status / read-only remote check
        ↓ explicit apply --execute only
AppleMusicWriteAdapter (official or explicit web-player opt-in)
        ↓
new Library Playlist + apple_import_state.json
```

읽기/매칭과 Apple 계정 쓰기를 서로 다른 명령으로 분리했다. 매칭 결과를 사람이 먼저 검토할 수 있고, 실패 후에도 마지막 checkpoint에서 이어갈 수 있다.

`status`는 원본 추출의 complete/checkpoint, 자동·수동 매칭, 미해결 곡과 로컬 apply checkpoint를 합쳐 보여 준다. 원격 상태를 읽지 않았으면 반드시 `remote_validation.checked=false`로 표시한다.

## 공통 브라우저 설정과 프로필 해석

`src/browser-config.js`가 Melon과 Apple Music web-player의 유일한 브라우저 선택 경계다. 설정 파일이 없는 최초 상태만 Chrome을 기본값으로 사용한다. `configure --browser chrome|edge`는 `.state/browser-config.json`을 원자적으로 저장하며, 손상된 JSON이나 지원하지 않는 값은 fail-closed한다. Playwright channel mapping은 `chrome -> chrome`, `edge -> msedge`로 고정하고 실행 실패 시 다른 channel을 시도하지 않는다. 기존 `MELON_BROWSER_CHANNEL` override는 폐기했으며 서비스별 또는 명령별 browser override를 노출하지 않는다. Apple 공식 backend의 MusicKit 인증 경로는 이 설정과 무관하게 유지한다.

프로필은 `.state/profiles/<browser>/<service>/`를 canonical로 사용한다. 브라우저와 서비스가 모두 일치하는 `edge + melon -> .state/melon-edge-profile/`, `chrome + apple-music -> .state/apple-music-chrome-profile/`만 canonical 부재 시 legacy fallback이 된다. canonical이 있으면 legacy보다 우선한다. `chrome + melon`이 Edge legacy를, `edge + apple-music`이 Chrome legacy를 여는 경로는 없다. 해석기는 경로 존재 여부만 확인하며 프로필 내용·cookie·token을 검사하거나 복사·이동·병합하지 않는다. `status`는 선택값/channel과 두 실제 경로 및 경로 종류를 출력한다.

## 멜론

개인 `좋아요한 곡`을 읽는 공개 공식 API는 확인하지 못했다. 로그인하지 않은 현재 웹에서 좋아요 URL은 회원 예외 처리로 이동하며, 공개 자료와 현재 멜론 페이지 구조에서 곡 목록이 서버 렌더링 테이블이고 pagination이 `pageObj.sendPage(startIndex)` 형태임을 확인했다.

따라서 MVP는 다음 순서로 설계했다.

1. 전용 Playwright persistent profile을 사용한다.
2. 로그인은 사용자가 선택한 브라우저에서 직접 한다.
3. `data-song-no`, 곡 상세/play 함수, checkbox 값에서 Melon song ID를 교차 추출한다.
4. 표의 제목/아티스트/앨범/재생시간을 읽고 페이지별로 저장한다.
5. 향후 인증 상태에서 안정적인 JSON/XHR이 확인되면 `src/melon.js`만 교체한다.

DOM 선택자는 비공식 계약이므로 fail-fast한다. 곡 행을 찾지 못한 상태에서 빈 결과로 기존 파일을 덮어쓰지 않는다.

## Apple 공식 검색 경로

Apple의 현행 [iTunes Search API](https://performance-partners.apple.com/search-api)는 인증 없이 음악 곡 검색과 ID lookup을 제공한다. `country`, `media=music`, `entity=song`, `limit`, `explicit` 파라미터를 사용할 수 있고, 응답에는 track ID, 제목, 아티스트, 앨범, 재생시간, explicit 상태와 Apple Music 링크가 포함된다. 공식 문서의 호출량 안내는 대략 분당 20회이므로 구현은 요청 사이에 3.1초를 둔다.

2026-09-11 실제 요청에서는 `country=kr&media=music&entity=song` 검색이 알려진 곡에도 0건을 반환했다. 반면 미국 검색으로 얻은 track ID를 `country=kr` lookup에 전달하면 한국 URL, KRW와 한국 지역 메타데이터가 반환됐다. 따라서 매칭은 다음 순서로 동작한다.

1. 미국 storefront에서 제목+아티스트를 검색한다.
2. 충분한 점수가 나오지 않으면 feat. 구문 제거, 괄호 속 영문 아티스트명, 제목 단독, 앨범+아티스트 검색어를 순서대로 시도한다.
3. 그래도 자동 매칭되지 않을 때만 같은 검색을 일본 storefront에서 보완한다.
4. 각 검색 결과 ID를 한국 lookup에 전달하고, 반환되지 않는 ID는 후보에서 제외한다.
5. 한국 표시명과 미국·일본 검색 표시명을 함께 별칭으로 점수화하되, 최종 출력은 한국 lookup 메타데이터와 URL을 사용한다.

이 방식은 공식·무인증이라는 사용자 조건 안에서 가능한 보수적 fallback이다. 다만 iTunes Search는 Apple Music 한국 카탈로그 전용 검색 API가 아니다. 미국·일본에 없는 한국 전용 곡을 놓칠 수 있고, 한국 lookup 반환만으로 구독 계정에서 실제 재생 가능하다고 확정할 수도 없다. 검색어에는 곡 제목·아티스트·앨범이 Apple의 미국 및 필요 시 일본 검색 서버로 전송된다.

## Apple Music 쓰기 backend 결정

카탈로그 매칭과 계정 쓰기를 분리한 기존 구조는 유지한다. `match`는 계속 iTunes Search API만 사용하고, `apply` 아래에 교체 가능한 쓰기 adapter를 둔다.

```text
matched.json
    ↓ explicit apply --execute only
AppleMusicWriteAdapter
    ├─ official: api.music.apple.com
    │    developer token + Music User Token
    └─ web-player: amp-api.music.apple.com
         AMPWebPlay Bearer + media-user-token
    ↓
tool-owned Library Playlist + apple_import_state.json
```

`official`과 `web-player`를 모두 구현하되 `web-player`는 Program 미가입 개인 사용자가 CLI에서 `--backend web-player`를 명시적으로 선택할 때만 사용한다. 환경 변수로 web-player를 기본 선택할 수 없고, 공식 방식 실패 시 자동 fallback하지 않는다. 비공식 인증 변경이 matcher·Melon 추출·출력 schema에 번지지 않도록 다음 공통 계약만 파이프라인에 노출한다.

```text
validateSession()
getStorefront()
validateCatalogSongs(ids)
createLibraryPlaylist(name, description)
getPlaylistTracks(playlistId)
addTracks(playlistId, songIds)
```

공통 HTTP·resource 계약과 mutation 재확인은 `src/apple-write-api.js`, backend 선택은 `src/apple-write-adapter.js`에 둔다. 기존 `AppleMusicClient`는 official adapter로 이 계약을 구현한다. web-player의 bundle/cookie 인증은 `src/apple-web-auth.js`, AMP host client는 `src/apple-web-api.js`에 격리한다. pipeline은 테스트나 다른 구현에서 write adapter를 주입할 수 있다.

### 공식 backend

- 모든 API 호출에는 ES256 developer token이 필요하다. Apple은 `iss`, `iat`, 최대 6개월 이내의 `exp`를 요구한다. 이 도구는 더 짧은 30일 토큰을 런타임에 만든다: [Generating Developer Tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens)
- 사용자 라이브러리 작업에는 Music User Token이 추가로 필요하고, 웹 앱에서는 MusicKit on the Web이 인증을 관리한다: [User Authentication for MusicKit](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit)
- Program 가입 사용자에게 가장 안정적인 경로이므로 현재 구현과 설정은 삭제하지 않는다.

### Web-player backend

쓰기 기능이 있는 세 프로젝트는 Apple 웹 플레이어가 자체적으로 사용하는 공개 AMPWebPlay JWT를 Bearer token으로 쓰고, 로그인 사용자의 `media-user-token` 쿠키 값을 사용자 토큰 헤더로 보낸다. `sync-fm/applemusic-api`는 공개 Bearer 자동 추출과 catalog client를 제공하지만 확인한 revision에는 user token header 주입과 playlist endpoint가 구현되어 있지 않았다. 쿠키 이름과 요청 헤더 이름은 다르다.

```http
Authorization: Bearer <AMPWebPlay JWT>
Music-User-Token: <media-user-token cookie value>
Origin: https://music.apple.com
Content-Type: application/json
```

`SongMirror`에는 `Media-User-Token` 표기가 있지만 Apple 공식 Music User Token 헤더와 다른 구현들의 실제 요청에 맞춰 이 프로젝트는 `Music-User-Token`으로 통일한다.

Windows 11의 선택한 Chrome 또는 Edge에서는 다음 흐름을 사용한다.

1. 평소 브라우저 프로필이 아닌, 공통 설정에서 해석한 Apple Music 전용 persistent profile을 연다.
2. 사용자가 Apple ID 로그인과 2FA를 직접 완료한다. 프로그램은 비밀번호나 2FA 값을 읽거나 입력하지 않는다.
3. Playwright가 로그인 후 `music.apple.com`의 `media-user-token` 쿠키를 읽어 전용 profile에서 재사용한다. token 자체를 별도 state 파일로 복제하지 않는다.
4. AMPWebPlay Bearer는 웹 플레이어 JavaScript bundle에서 추출해 JWT의 `exp`까지 프로세스 메모리에 캐시한다.
5. Bearer가 만료되면 bundle에서 다시 추출한다. opaque한 `media-user-token`에는 문서화된 refresh 규약이 없으므로 `401`/`403`에서 선택한 전용 브라우저를 다시 열어 쿠키를 갱신하고, 필요하면 사용자 재로그인을 요청한다.

2026-09-11에 확인한 공개 AMPWebPlay JWT는 발급 2026-08-13 14:55 UTC, 만료 2026-10-22 14:55 UTC로 정확히 70일이었다. 일부 프로젝트 문서의 약 180일 가정을 하드코딩하지 않고 항상 JWT `exp`를 읽는다.

이 방식은 Apple이 제3자 앱용으로 보장한 공개 계약이 아니다. 개인 계정의 선택 기능으로만 제공하고, UI/API 변경 시 backend만 교체하거나 비활성화할 수 있어야 한다.

### Playlist 생성과 곡 추가 요청

공식 backend와 web-player backend는 host와 인증 출처는 다르지만 다음 resource 형태를 공유한다.

```http
POST /v1/me/library/playlists

{"attributes":{"name":"Melon Likes Import","description":"..."}}
```

```http
POST /v1/me/library/playlists/{playlistId}/tracks

{"data":[{"id":"<catalog-song-id>","type":"songs"}]}
```

공식 문서: [Create a New Library Playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist), [Add Tracks to a Library Playlist](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist), [Library Playlist Tracks Request data](https://developer.apple.com/documentation/applemusicapi/libraryplaylisttracksrequest/data-data.dictionary).

`type: "songs"`인 catalog song을 플레이리스트에 직접 넣을 수 있으므로 먼저 `/v1/me/library`에 추가할 필요가 없다. `library-songs`도 허용되지만 이 프로젝트에서는 사용하지 않는다. 플레이리스트 자체는 Library Playlist로 만들어진다.

개별 곡이 Library Song에도 추가되는지는 계정 설정의 영향을 받는다. Windows용 Apple Music에서 `설정 > 고급 > 플레이리스트에 추가할 때 보관함에 노래 추가`를 끌 수 있다: [Create, edit, and delete playlists in Apple Music on Windows](https://support.apple.com/guide/music-windows/create-edit-and-delete-playlists-musd5d051981/windows). 요청별 강제 플래그는 확인되지 않으므로 전체 적용 전에 `apply --execute --backend web-player --limit 2`처럼 적용 상한을 두고 1~2곡으로 실제 계정 동작을 검증한다. `--limit`은 matched 순서의 처음 N곡에 대한 누적 상한이다. 실제 계정에서 이 설정을 켠 채 시험했을 때 곡이 플레이리스트와 보관함에 함께 추가되었고 Favorite는 바뀌지 않았다.

### iTunes ID를 쓰기 전에 검증

iTunes Search 문서는 ID lookup을 지원하지만 `trackId`가 모든 storefront와 시점에서 Apple Music catalog song ID와 항상 같다고 명시적으로 보장하지는 않는다. 2026-09-11 읽기 전용 표본에서는 한 곡의 미국 iTunes `trackId`, 한국 lookup ID, Apple Music 한국 catalog ID가 모두 같았고 ISRC도 일치했다. `SongMirror`도 iTunes ID를 쓰기 입력으로 사용한다.

따라서 현재 미국·일본 검색 후 한국 lookup 매칭은 유지하되, 실제 `apply` 직전 선택한 backend에서 `GET /v1/catalog/{storefront}/songs?ids=...`로 배치 검증한다. 같은 ID와 `playParams`가 반환된 곡만 쓰고 누락된 ID는 미검증 상태로 제외한다. 이 검증은 매칭 중 인증 요청을 늘리지 않고 최종 write set에만 수행한다.

자동으로 확정하지 못한 곡은 `resolve`에서 사용자가 지정한 Apple song ID/URL을 한국 iTunes lookup으로 미리 본 뒤 `--confirm`을 다시 명시한 경우에만 `manual_matches.json`에 저장한다. 자동 결과 파일은 덮어쓰지 않고 provenance를 `manual_confirmed`로 유지한다. 수동 결과도 실제 적용 전 `apply --check` 또는 `apply --execute`의 선택 backend catalog preflight를 똑같이 통과해야 한다.

`apply --dry-run`은 token이나 adapter를 만들지 않는 로컬 계획이라 `remote_checked=false`다. `apply --check`는 session/storefront, 도구 소유 playlist의 존재·편집 가능성, checkpoint 일치, catalog ID와 `playParams`를 GET으로 검증하지만 playlist 생성, 곡 추가 또는 checkpoint 갱신은 하지 않는다. 실제 mutation은 계속 `apply --execute`만 허용한다.

### Rate limit과 mutation 안전성

- iTunes Search의 공식 안내는 대략 분당 20회이므로 현재 3.1초 간격을 유지한다.
- 공개 AMPWebPlay token의 공식 rate limit, quota와 SLA는 없다. [`applemusic-mcp` 이슈 #42](https://github.com/epheterson/applemusic-mcp/issues/42)에는 catalog search 약 250~280회 후 rolling hour 동안 `429`가 발생했고 rate-limit header도 없었다는 관찰이 있으나 보장값으로 사용하지 않는다.
- AMP 요청은 session/storefront 확인, 최종 ID batch validation, playlist write로 제한한다. 전 곡 catalog 검색에는 사용하지 않는다.
- `GET`은 제한적으로 재시도할 수 있고, `429`는 보수적으로 backoff한다.
- `POST`의 network 오류나 `5xx`는 성공 응답만 잃은 상태일 수 있으므로 자동 재전송하지 않는다. 생성 후 playlist를, 곡 추가 후 track 목록을 다시 읽어 반영이 확인되면 성공으로 회복하고, 확인할 수 없으면 fail-closed한다.
- 곡은 100개 이하 batch로 보내되 각 batch 후 실제 playlist 내용을 확인한 다음 checkpoint를 저장한다. 곡마다 한 번씩 보내는 구현은 불필요한 요청이 많아 채택하지 않는다.

`apple_import_state.json`에는 최소한 `backend`, `storefront`, 도구가 생성한 `playlist_id`, 확인된 song ID를 기록한다. 토큰은 절대 이 상태나 결과 파일에 넣지 않는다. 재시작할 때 저장된 playlist가 해당 backend에서 존재하고 편집 가능한지 먼저 확인한다. 이름으로 사용자의 기존 playlist를 찾아 합치지 않는다.

### 오픈소스별 확인 결과와 채택 범위

조사 시점의 revision을 고정해 구현을 비교했다.

| 프로젝트 | 인증 획득·재사용 | Playlist write / Library 선행 변경 | 판단 |
| --- | --- | --- | --- |
| [`epheterson/applemusic-mcp`](https://github.com/epheterson/applemusic-mcp/tree/ca94ca2630cfd721ecf3ff008637c84ae60b0ea0) `ca94ca2` | web bundle에서 Bearer 자동 추출. Chrome/Playwright 로그인으로 cookie를 포착·저장해 재사용 | 생성·곡 추가 가능. `type: songs`를 지원하므로 Library Song 선행 추가 불필요 | 자동 인증과 persistent profile 흐름 채택 |
| [`helmedeiros/tapeIt`](https://github.com/helmedeiros/tapeIt/tree/1ae13b6722752e04a7bf8b54e805be5afb5b3fbf) `1ae13b6` | DevTools에서 Bearer와 cookie를 사용자가 복사해 `auth apple`에 전달하고 사용자 config에 저장 | 생성·batch 추가 가능. catalog `songs` 직접 추가 | 작은 client 경계와 batch 형태만 채택, 수동 복사는 기본 UX로 비채택 |
| [`ahnafnafee/SongMirror`](https://github.com/ahnafnafee/SongMirror/tree/efcfe13ad22e0f54cf9dee509726e78984001d73) `efcfe13` | browser wizard가 Bearer와 user token 수동 paste를 안내하고 앱 data에 저장. token 거부 시 다시 paste | 생성·추가·삭제 가능. iTunes/catalog ID를 `type: songs`로 직접 추가 | ID 사용과 write 후 재확인 참고. `Media-User-Token` 표기는 따르지 않음 |
| [`sync-fm/applemusic-api`](https://github.com/sync-fm/applemusic-api/tree/ac533e5e0b22dd36b585968d62c25b2978f06e35) `ac533e5` | web bundle의 공개 Bearer를 자동 추출하고 자체 lifetime으로 cache/검증 | 확인 revision에는 playlist endpoint와 실제 user-token header 주입이 없어 write 불가 | Bearer 추출 참고만 하고 playlist writer 근거로 사용하지 않음 |

네 프로젝트 모두 MIT License다. HTTP 계약을 바탕으로 필요한 부분을 작게 재구현하는 것을 우선한다. 실질적인 코드를 복사하거나 파생하면 해당 저작권·MIT 고지를 포함한 `THIRD_PARTY_NOTICES.md`를 추가한다. MIT License는 Apple 서비스 사용 권리나 비공식 endpoint의 안정성을 보장하지 않는다.

채택하지 않는 항목은 다음과 같다.

- 사용자가 DevTools에서 토큰을 매번 복사하는 흐름을 기본 UX로 만들지 않는다.
- AMP catalog search를 매칭의 기본 검색으로 사용하지 않는다.
- playlist 추가 전 곡을 `/me/library`에 넣지 않는다.
- 외부 프로젝트 전체나 불필요한 의존성을 가져오지 않는다.
- mutation을 맹목적으로 재시도하거나 곡마다 요청하지 않는다.
- 공식 backend 실패 시 web-player backend로 자동 전환하지 않는다.
- Windows Apple Music UI 자동화를 API 대체 수단으로 도입하지 않는다.

이 프로젝트는 계속 ratings/Favorite endpoint와 사용자가 만든 기존 playlist의 이름 검색·수정을 하지 않는다. iPhone/iPad Shortcuts는 비공식 backend가 깨질 때의 수동 대안일 수 있지만 현재 핵심 구현 경로에는 넣지 않는다.

## 실제 계정 종단 검증

한국 storefront의 Apple Music 구독 계정으로 `--limit 2` 소량 적용, 서버 재조회, 남은 곡 적용 순서를 검증했다. 새 `Melon Likes Import` 플레이리스트에 곡이 반영되고 Favorite는 바뀌지 않았다. Apple ID 로그인과 2FA는 사용자가 전용 프로필에서 직접 처리했고, credentials와 인증 token은 출력하거나 별도 파일에 저장하지 않았다. 이 검증은 당시 AMPWebPlay 계약의 동작 증거이며 비공식 endpoint의 장기 호환성을 보장하지 않는다.

### 브라우저 조합 검증 구분

외부 계정 없는 fixture 테스트는 Chrome/Edge의 channel mapping, Melon/Apple Music의 동일 선택 사용, 네 canonical 경로 분리, 정확한 두 legacy fallback, canonical 우선순위, cross-browser legacy 차단과 launch 실패 시 무자동전환을 검증한다. 과거 실사용 증거는 legacy `Edge + Melon` 추출과 legacy `Chrome + Apple Music` 인증·쓰기 조합에 한정된다. `Chrome + Melon`, `Edge + Apple Music`, 그리고 새 canonical 프로필 네 경로에서의 실제 로그인·cookie 지속성은 아직 검증하지 않았다. 이번 정책 구현에서는 로그인, 네트워크 인증, `apply --execute`, Favorite 또는 기존 playlist 변경을 실행하지 않았다.

## 매칭 정책

가중치는 제목 54%, 아티스트 31%, 앨범 10%, 재생시간 5%다. 없는 필드는 가중치 분모에서 제외한다.

- Unicode NFKC, 대소문자, 구두점, 공백을 정규화한다.
- `feat.`/`featuring`은 제목 핵심 비교에서 제거한다.
- 괄호 안 영문/한글 아티스트 별칭은 별도 alias로 비교한다.
- `live`, `instrumental/inst.`, `remix`, `acoustic`, `remaster`가 서로 다르면 큰 감점을 준다.
- ISRC가 양쪽에 있고 같으면 확정 점수로, 다르면 감점으로 사용한다.
- 자동 매칭은 절대점수와 2위 후보와의 margin을 동시에 통과해야 한다.

점수는 휴리스틱이므로 `unmatched.json`에 상위 5개 후보와 구성 점수를 남겨 사람이 판단할 수 있게 한다.
