# 곡 복구·비활성 검토 명령 안내

[← README](../README.md)

이미 플레이리스트에 넣은 곡의 제공이 중단됐을 때의 복구와, 멜론에서 비활성(재생 불가)으로 표시된 곡의 검토 명령 요약입니다. 모든 명령은 기본이 미리보기이며, 승인한 미리보기 HASH가 있을 때만 저장하거나 계정을 바꿉니다. 계획 파일과 근거 파일의 정확한 형식은 각 명령의 소스와 테스트를 참고하세요.

| 명령 | 하는 일 | 소스 |
| --- | --- | --- |
| `recover --backend web-player (--plan-file PATH | --resume ID) [--execute --expected-preview HASH]` | 기존 승인·checkpoint를 보존한 채 제공 중단곡을 다른 발매본으로 복구합니다. `--plan-file`만 주면 읽기 전용입니다. | `src/song-recovery-command.js` |
| `settle-recovery --backend web-player --recovery-id ID --reason "검토 사유" [--confirm --expected-preview HASH]` | 일부 곡만 반영된 복구 결과를 GET으로 검사하고, 확정 시 로컬 기록만 저장합니다. 미해결 복구가 남으면 일반 추가가 막힙니다. | `src/song-recovery-settlement.js` |
| `review-recovery-candidate --backend web-player --plan-file PATH` | 미해결 곡의 다른 발매본을 읽기 전용으로 검토합니다. 저장·실행은 하지 않습니다. | `src/recovery-candidate-review.js` |
| `recover-followup --backend web-player (--plan-file PATH | --resume ID) [--execute --expected-preview HASH]` | 부분 확정 뒤 다른 발매본으로 후속 복구를 합니다. 시도 후 결과가 불확실하면 다시 추가하지 않습니다. | `src/recovery-followup-command.js` |
| `inactive-review --input-file PATH [--output-dir NEW_PATH]` | 비활성 곡의 복원 자료를 정상 매칭 목록과 분리해 HTML/JSON으로 봅니다. 승인·추가·연결은 하지 않습니다. | `src/inactive-review.js` |
