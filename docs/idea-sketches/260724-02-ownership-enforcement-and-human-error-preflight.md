# 소유권 경계의 코드 강제 + 범용 human-error 프리플라이트 (2026-07-24)

두 가지 사용자 보고에서 출발한 설계 토론의 정리입니다.

1. WriteFile이 프롤로그/에필로그 등 스코프와 무관한 파일을 수정할 수 있음.
2. 프롤로그/에필로그에 문법·언어 오류(예: top-level await)가 있으면 모델이
   해당 파일을 수정해 버리거나 테스트를 무한 반복함.

필드 리포트(260724-00) §4.2가 같은 현상을 독립적으로 관찰했습니다
(gemini의 prologue 2회 수정, grok의 entry point 재작성, deepseek의 타 심볼
스텁 작성). 추가 사례: gomoku.chz.ts 첫 버전의 top-level `await
game.start()`(에필로그로 분류되는 문장)에서 gemini가 에필로그 파일을 수정한
뒤 세션을 종료함.

## 1. 진단

### 1.1 근본 원인은 하나 — 소유권 경계가 prose에만 있음

쓰기 경계(outputDir 컨테인먼트)는 디스패처가 강제하지만
(`#resolveWrite`, src/realizer/tools/filesystem.ts:419), 소유권 경계는
docs/64 프롬프트 산문에만 존재합니다. human 소유(`__prologue__`,
`__epilogue__`), 엔진 소유(`implementation.ts`, `CONTEXTS.md`,
`realization-cache.json`, `tests/*.ensure.ts`)가 전부 outputDir **안에**
살기 때문에 디스패처는 이들 전부에 대한 쓰기를 허용합니다. 문서 63의 원칙
"경계는 디스패처에서 강제, prose는 코드로 강제할 수 없는 것만"과 어긋난
상태입니다.

소유권 분류 로직 자체는 이미 존재합니다 — 린터용
`isModelAuthoredFile`(src/realizer/tools/verification.ts:166). 쓰기 경계가
이를 공유하지 않는 것이 구멍입니다.

### 1.2 "이길 수 없는 세션" — 두 번째 문제의 일반형

두 번째 보고의 일반형은 TLA가 아니라 이것입니다:

> **빨간 검증의 원인이 모델이 합법적으로 수정할 수 없는 파일에 있으면,
> 그 세션은 구조적으로 이길 수 없다.**

이길 수 없는 세션에 진입한 모델의 선택지는 (a) 소유권 침범(1.1의 구멍으로
가능), (b) 무한 재검증, (c) 턴 리밋 사망뿐입니다. 정답인 Block으로 가는
표지판이 어디에도 없습니다. 필드 리포트 §3.1(엔진 버그가 ensure 파일에
있던 사례)도 정확히 이 계열입니다.

악화 요인: 세션 종료 후 prologue/epilogue/ensure 복원
(src/realize.ts:209-214, 필드 리포트 §4.2). 모델이 human 파일을 "고쳐"
세션 내 검증을 green으로 만들어도 복원 후의 독립 검증은 모델이 본 적 없는
상태에서 돌며, "고쳤는데 왜 또 실패?"라는 재시도 토큰 낭비로 이어집니다.

### 1.3 확인된 노출 경로

- scoped RunTypeCheck는 진단을 스코프 파일로 필터링하지 않습니다
  (src/realizer/tools/verification.ts:280-283 — `getSemanticDiagnostics()`
  무인자 호출은 프로그램 내 **모든** 파일의 진단을 반환). 구현체가
  `__prologue__`를 import하므로 프롤로그 내부 오류가 모델에게 무표식으로
  노출됩니다.
- 에필로그는 scoped 검증의 루트 파일에 들어가지 않고(`collectScopeFiles`),
  realized 코드의 에필로그 import는 린트로 금지되므로 진단 경로로는
  격리되어 있습니다. 최종 whole-realization 패스의 실패는 의도적으로
  모델에 피드백되지 않습니다(src/realize.ts:675-678 주석). 따라서 에필로그
  수정 사례의 유력한 경로는 진단이 아니라 모델의 자발적 탐색 + 쓰기 허용
  (1.1)입니다.

## 2. 결정 사항

### 2.1 쓰기 소유권을 디스패처에서 강제

`#resolveWrite`(WriteFile/FindAndReplace 공용)에 거부 목록을 추가:

- human 소유: `implementations/__prologue__.ts`,
  `implementations/__epilogue__.ts`
- 엔진 소유: `implementation.ts`, `CONTEXTS.md`, `realization-cache.json`,
  `tests/*.ensure.ts`
- **세션 스코프 밖 심볼의 파일**: 스코프에 없는 심볼 name에 대한
  `implementations/<name>.ts`, `tests/test_<name>.autogen.ts`. 심볼 전체
  목록은 그래프에서 이미 알 수 있음. (필드 리포트 §3.3의 "전체 디렉토리
  검증이 스코프 밖 수정을 부추김"은 심볼 단위 검증 스코프 도입으로 유인이
  제거되었고, 이 거부는 남은 능력 자체를 제거)
- 심볼 이름에 매핑되지 않는 새 파일(예: 공유 헬퍼)은 계속 허용 —
  의도적 느슨함으로 기록해 둠.

구현 방침: `isModelAuthoredFile`을 공유 소유권 모듈로 승격해 린터와 쓰기
경계가 같은 분류를 쓰게 함. 에러 메시지는 문서 63 원칙대로 복구 힌트를
포함: "이 파일은 human 소유라 수정할 수 없다. 이 파일이 realization을
막는다면 Block으로 에스컬레이션하라."

범위 밖: 파일 *내부의* `@chz-realize-override` 구간 보호는 content-level
검사가 필요한 별개 과제로, 기존대로 future work.

### 2.2 범용 human-error 프리플라이트 — split의 스텁 프로그램 재활용

TLA를 특수 케이스로 잡지 않습니다. 대신 "human layer의 임의 오류를 세션
시작 전에 결정론적으로 잡는" 범용 스테이지를 둡니다. 재료는 이미
있습니다:

`splitHumanCode`(src/human-code.ts:46)는 분할 분석을 위해 **imagine
선언부를 `declare` 스텁으로 치환한 human 소스 전체**를 가상 TypeScript
프로젝트로 띄웁니다. 현재는 이 프로그램의 진단을 아무도 읽지 않습니다.
이 진단을 수거하면:

- **파일 전체가 typecheck 가능** — 스텁이 imagine 계약을 대신 서므로
  "에필로그는 미실현 심볼 참조 때문에 사전 검증 불가" 문제가 사라짐.
  `await game.start()`도 스텁 위에서 정상 판정됨.
- **완전히 범용** — 구문 오류, TLA-in-CJS(모듈 종류 문법 오류), human
  코드 내부 타입 오류, imagine 시그니처 오호출까지 tsc가 잡는 것 전부.
- **위치가 원본과 1:1** — `replaceImagineDeclarations`가 치환 시 원본
  길이를 공백 패딩으로 보존하므로(src/human-code.ts:135) 진단 위치가
  사용자의 `.chz.ts` 라인과 그대로 일치.
- **obligation과의 구분이 자연스러움** — imagine 스텁 멤버에 대한 미해결
  참조(예: TS2339)는 오류가 아니라 "usage creates the contract"의
  obligation. 이 분류는 파이프라인의 "tsc diagnostics → obligation 변환"
  스테이지가 원래 하기로 한 일이므로, 이 프리플라이트는 새 발명이 아니라
  **그 스테이지의 구현**임.

동작: split 시점에 진단 수거 → obligation 분류 제외 → 나머지가 있으면
LLM 세션 0회로 realize 즉시 실패 + `.chz.ts` 라인 기준 리포트. "human
코드는 human이 고친다"가 엔진 수준에서 강제됨.

구현 주의점:

- 현재 가상 FS에는 대상 파일 하나만 있어(createVirtualFileSystem) NodeNext
  모듈 종류 판정이 실제 프로젝트와 다를 수 있음. TLA 합법성이 사용자
  툴체인과 일치하려면 package.json이 보이는 상태로 판정해야 함.
- split이 만들어내는 프롤로그/에필로그 산출물 자체의 오류(분할 과정에서
  생기는 것)는 이 단계로 못 잡음 — 그것은 엔진 버그 카테고리이며 최종
  whole-realization 패스가 담당.

### 2.3 검증 진단에 소유권 attribution

1.3의 진단 누수는 숨기지 않고 표식을 붙입니다: 스코프 밖·human 소유
파일의 진단에는 "이 파일은 네가 수정할 수 없다. 이것이 realization을
막는다면 Block + 구체적 todo로 종료하라"를 마킹. 스코프 파일로 필터링만
하는 안은 기각 — 프롤로그가 실제로 깨졌을 때 typecheck green / 테스트
red의 더 헷갈리는 괴리가 생김. 프리플라이트(2.2)가 있으면 이 경로는 거의
밟히지 않지만, 밟혔을 때 폭주 대신 Block으로 수렴시키는 심층 방어.

## 3. 보류·기각

- **무진전 루프 가드**(성공한 쓰기 없이 동일 검증 결과 반복 시 nudge):
  보류. 턴 캡이 최종 방어선이고, 2.1–2.3 적용 후에도 필요한지 관찰 후
  결정.
- **CJS+TLA 특수 처리**(async 래퍼 자동 변환, realization 디렉토리 ESM
  강제 사이드카 package.json): 불필요로 기각. TLA 합법성은 호스트 모듈
  종류의 문제이며 2.2의 범용 검사가 흡수함. 호스트가 CJS면 사용자 자신의
  tsc도 그 파일을 거부하므로(no-build 원칙) 엔진이 덮어줄 대상이 아님.

## 4. 열린 질문

- obligation 판별의 정확한 규칙: 어떤 진단 코드/형상까지를 obligation으로
  볼 것인가 (imagine 스텁 타입에 대한 TS2339 멤버 접근이 중심; `required
  imagine` 명시 선언과의 통합 포함).
- 쓰기 거부(2.1) 도입 후에도 세션 종료 후 human 파일 복원 로직
  (src/realize.ts:209-214)을 유지할 것인가 — 거부가 완전하면 복원은
  안전망으로 강등되지만, 제거 근거로는 아직 약함.
- 헬퍼 파일(심볼 이름에 매핑되지 않는 새 파일)의 소유권: 현재는 무소속
  허용. 캐시/무효화와의 상호작용은 별도 검토 필요.

## 5. 문서 반영 필요

- 문서 63: 쓰기 도구 계약에 소유권 거부 목록과 에러 메시지 추가, 검증
  도구의 attribution 동작 추가.
- 문서 60: 실현 디렉토리 소유권 표(사람/엔진/모델/스코프)를 명시.
- 문서 62 또는 파이프라인 문서: 프리플라이트 스테이지의 위치(split 직후,
  세션 전)와 실패 시 동작.
