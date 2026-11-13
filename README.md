# Melon Likes → Apple Music

멜론에서 **좋아요한 곡**을 Apple Music 플레이리스트로 옮기는 Windows용 명령줄 도구입니다.

- **새 플레이리스트 하나에만 추가합니다.** 기존 플레이리스트나 Apple Music의 좋아요(Favorite)는 건드리지 않습니다.
- **확인하기 전에는 아무것도 바꾸지 않습니다.** 먼저 무엇을 추가할지 보여 주고, 안내된 명령을 실행해야만 실제로 추가합니다.
- **확실한 곡만 자동으로 고릅니다.** 나머지는 브라우저 화면에서 직접 고르거나 건너뜁니다.

## 준비물

- Windows 11
- [Node.js](https://nodejs.org/) 20 이상
- Google Chrome 또는 Microsoft Edge
- 멜론 계정, Apple Music 구독 계정

Apple Music에 곡을 넣는 방식은 두 가지 중 하나를 고릅니다. 아래 예시는 모두 `web-player` 기준입니다.

| 방식 | 필요한 것 | 참고 |
| --- | --- | --- |
| `web-player` | Apple Music 구독만 있으면 됨 | Apple Music 웹 플레이어와 같은 방식으로 동작하는 **비공식** 방법입니다. Apple이 웹 구현을 바꾸면 동작하지 않을 수 있습니다. |
| `official` | Apple Developer Program 가입(유료)과 `.env` 설정 | Apple 공식 API를 씁니다. 설정 방법은 [Apple Music 인증과 적용 상세](docs/usage-apple-apply.md#공식-backend)를 참고하세요. |

## 설치

```powershell
git clone https://github.com/sjyoon4755/melon-to-apple-music.git
cd melon-to-apple-music
npm install
```

## 처음 옮기기

**1. (선택) 브라우저 고르기.** 기본은 Chrome입니다. Edge를 쓰려면 한 번만 실행합니다.

```powershell
node src/cli.js configure --browser edge
```

**2. Apple Music 로그인.** 이 도구 전용 브라우저 창이 열리면 Apple ID로 직접 로그인합니다. 평소 쓰는 브라우저의 로그인 정보는 쓰지 않습니다.

```powershell
node src/cli.js apple-auth --backend web-player
```

**3. 미리보기.** 멜론 좋아요 목록을 가져와 Apple Music 곡을 찾고, 추가할 곡 목록을 보여 줍니다. 이 단계에서는 Apple Music이 바뀌지 않습니다.

```powershell
node src/cli.js sync --backend web-player
```

- 처음에는 멜론 전용 창이 열립니다. 직접 로그인하면 좋아요 목록으로 이동해 이어서 진행합니다.
- 곡이 많으면 오래 걸립니다. 중간에 멈춰도 다시 실행하면 이어서 진행합니다.

**4. 추가.** 3단계 출력의 마지막 줄에 나온 명령을 그대로 실행합니다. `Melon Likes Import`라는 새 플레이리스트가 만들어지고 자동으로 확정된 곡이 들어갑니다.

```powershell
node src/cli.js sync --backend web-player --execute --expected-preview HASH
```

**5. 자동으로 못 찾은 곡 고르기.** 아래 [자동으로 못 찾은 곡 고르기](#자동으로-못-찾은-곡-고르기)대로 고른 뒤, 3·4단계를 다시 실행하면 고른 곡이 추가됩니다.

## 자동으로 못 찾은 곡 고르기

1. `data/review.html`을 브라우저로 엽니다. 곡마다 같은 곡인 후보를 누르고, 목록에 없으면 **Apple Music 링크 붙여 넣기**, 옮기지 않을 곡은 **건너뛰기**를 고릅니다.
   - **비슷한 후보로 한꺼번에 고르기**를 누르면 가장 비슷한 후보를 한꺼번에 고릅니다. 비슷한 정도가 낮거나 버전·참여 가수가 다를 수 있는 곡은 제외되니 직접 골라 주세요.
   - 고르던 내용은 브라우저에 남으니 나눠서 해도 됩니다.
2. **결정 파일 내려받기**를 누릅니다.
3. 미리보기를 확인한 뒤, 마지막 줄에 안내된 명령으로 저장합니다. 저장만 하며 Apple Music은 바뀌지 않습니다.

```powershell
node src/cli.js resolve --decisions-file "$HOME\Downloads\review-decisions.json"
node src/cli.js resolve --decisions-file "$HOME\Downloads\review-decisions.json" --confirm --expected-preview HASH
```

자세한 규칙은 [결정 파일로 한 번에 수동 승인](docs/usage-melon-and-matching.md#결정-파일로-한-번에-수동-승인)을 참고하세요.

## 새 좋아요 반영하기

나중에 멜론에서 좋아요를 더 누르면 [처음 옮기기](#처음-옮기기)의 3·4단계를 다시 실행합니다. 이미 고른 곡은 그대로 두고 새 곡만 찾아서 추가합니다.

멜론에서 좋아요를 취소한 곡은 자동으로 지우지 않으며, 이때는 미리보기가 멈추고 이유를 알려 줍니다. 중단 조건은 [sync 상세](docs/usage-melon-and-matching.md#새-좋아요-한-번에-반영)를 참고하세요.

## 알아 두면 좋은 것

- **보관함에도 추가될 수 있습니다.** Apple Music의 **플레이리스트에 추가할 때 보관함에 노래 추가** 설정이 켜져 있으면 곡이 보관함에도 들어갑니다. 원하지 않으면 미리 꺼 두세요. ([자세히](docs/usage-apple-apply.md#library-song-직접-호출과-보관함-설정))
- **한국에만 있는 곡은 놓칠 수 있습니다.** 곡은 iTunes 검색(미국·일본)으로 찾은 뒤 한국 Apple Music에 있는지 확인합니다. 못 찾은 곡은 검토 화면에서 링크를 직접 붙여 넣으세요.
- **로그인이 풀리면 다시 로그인합니다.** Apple Music 인증이 만료되면 `apple-auth`를, 멜론은 열리는 창에서 다시 로그인하면 됩니다. 아이디와 비밀번호는 이 도구가 받거나 저장하지 않습니다.
- **멜론 화면이 바뀌면 동작하지 않을 수 있습니다.** 멜론은 좋아요 목록용 공개 API가 없어 웹 화면을 읽습니다.
- **내 데이터는 내 컴퓨터에만 남습니다.** 결과는 `data/`, 전용 브라우저 로그인 정보는 `.state/`에 저장되며 Git에 올라가지 않습니다.

## 더 자세한 사용법

| 문서 | 내용 |
| --- | --- |
| [Melon 추출·매칭 상세](docs/usage-melon-and-matching.md) | 로그인·재인증, 매칭 기준, 추출 중단 원인, 수동 매칭·교체·보류, 기존 곡 연결 |
| [Apple Music 인증과 적용 상세](docs/usage-apple-apply.md) | 공식 방식 설정, `apply` 명령, 추가 개수 제한, 실행 잠금 |
| [복구 명령 안내](docs/usage-recovery.md) | 제공이 중단된 곡의 복구, 멜론 비활성 곡 검토 |
| [설계와 근거](docs/design.md) | 동작 방식, 안전 장치, 공식 문서 근거 |

`sync` 대신 단계별로 실행할 수도 있습니다.

```powershell
node src/cli.js melon-extract   # 멜론 좋아요 추출
node src/cli.js match           # Apple Music 곡 찾기
node src/cli.js review          # 검토표(review.csv, review.html) 만들기
node src/cli.js status          # 현재 진행 상황 확인
node src/cli.js apply --check --backend web-player    # 추가할 곡 확인(읽기 전용)
```

전체 명령과 옵션은 `node src/cli.js --help`로 볼 수 있습니다.

## 저장 파일

| 파일 | 내용 |
| --- | --- |
| `data/melon_likes.json` | 멜론에서 가져온 좋아요 목록 |
| `data/matched.json` | 자동으로 확정한 곡 |
| `data/unmatched.json` | 자동으로 못 찾은 곡과 후보 |
| `data/manual_matches.json` | 직접 고른 곡 |
| `data/review.html`, `data/review.csv` | 검토 화면과 엑셀용 표 |
| `data/apple_import_state.json` | 이 도구가 만든 플레이리스트와 추가한 곡 기록 |
| `.state/` | 브라우저 선택과 전용 로그인 프로필 |

보류·교체·기존 곡 연결 같은 고급 명령이 쓰는 기록 파일은 [Melon 추출·매칭 상세](docs/usage-melon-and-matching.md)에 설명되어 있습니다.

## 개발

```powershell
npm test
```

테스트는 외부 계정이나 네트워크 없이 실행됩니다.
