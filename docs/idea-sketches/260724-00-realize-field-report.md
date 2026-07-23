# `chz realize` 필드 리포트 (2026-07-24)

`chz realize`를 실제 사용자 입장에서 여러 예제 × 여러 모델로 실행해 보고,
좋지 않았던 지점을 증거와 함께 정리한 리포트입니다. 수정 제안은 방향성
수준으로만 적었으며, 코드는 일절 수정하지 않았습니다.

- 평가 환경: commit `ea3b6e2`, Node v25.2.1, macOS, OpenRouter 경유
  (`ChzOpenAIRealizer`), 모델은 `x-ai/grok-4.5`, `deepseek/deepseek-v4-flash`,
  `google/gemini-3.6-flash`, `anthropic/claude-sonnet-5`.
- 실행 방식: `examples/`에서 `npm exec chz realize <file>` (출력 리다이렉트 —
  즉 non-TTY 세션). 매 실행 전 해당 예제의 `chz/realization/<name>/` 삭제
  (재실행 실험 제외).
- 이번 평가를 위해 2심볼 의존성 예제 `examples/slug-tools.chz.ts`를 추가했고,
  Abort 경로 확인용 일회성 예제(`impossible.chz.ts`)는 실행 후 삭제했습니다.

## 1. 실행 매트릭스

| 예제 | 모델 | 결과 | 소요 | 비고 |
|---|---|---|---|---|
| collision (fresh) | grok-4.5 | 성공 | 1m14s | 9턴, 20 tests |
| collision (재실행, 산출물 유지) | grok-4.5 | 성공 | 49s | 세션 2회 — 1회는 구조적 낭비 (§3.2) |
| phone-number-normalizer | deepseek-v4-flash | 성공 | 1m05s | ASSUMPTION 주석 충실 |
| phone-number-normalizer | claude-sonnet-5 | **BLOCKED** | 23s | AskUser → non-TTY 자동 Block (§4.1) |
| todo-list | gemini-3.6-flash | **실패** | 57s | 턴 리밋 — 근본 원인은 엔진 버그 (§3.1) |
| gomoku | grok-4.5 | 성공 | 1m32s | 6턴, 21 tests. 실제 플레이 가능, SIGINT 시 '비겁한 놈!' 계약 이행 확인 |
| slug-tools (2심볼, 신규) | deepseek-v4-flash | 성공 | 3m28s | 세션 6회 — 선행 심볼 1차 시도는 구조적으로 실패 (§3.3) |
| impossible (모순 계약) | deepseek-v4-flash | Abort | **8s** | triage-first가 의도대로 동작 (§2) |
| phone-number-normalizer (복구 재실행) | deepseek-v4-flash | 성공 | ~1m | 1차 실행과 **의미가 다른** 구현 생성 (§4.7) |

성공한 산출물은 모두 실행까지 확인했습니다(collision `충돌 여부: true`,
phone 3케이스 정상, gomoku 보드 렌더링·SIGINT 메시지, slug-tools
`['hello-world', 'hello-world-2', 'untitled']`).

## 2. 잘 동작한 것 (짧게)

- **WriteFile 인라인 진단.** 모델이 쓰기 직후 같은 턴에 타입 에러를 보고
  다음 턴에 바로 고침. 이 피드백 루프가 성공 런들의 핵심 동력이었음.
- **FindAndReplace의 diff 로그 출력** — 사람이 변경을 따라가기 좋음.
- **툴 콜 요약 로그 포맷** (`ReadFile(path=…) → ok (39 lines) · 2ms`) 자체는
  훌륭함. 단 §4.4의 정보 누락이 아쉬움.
- **read 경계가 실제로 동작.** sonnet-5가 프로젝트 루트 밖
  (`/Users/cheesekun/works/chz`)을 읽으려다 차단됨.
- **triage-first / Abort 경로.** 모순 계약 예제에서 deepseek이 8초 만에
  명확한 사유와 함께 Abort. 낭비 없는 이상적인 동작.
- **세션 종료 후 ensure/prologue/epilogue 복원** (src/realize.ts:209-214) —
  계약 무결성의 최종 방어선으로서 유효. 단 §4.2의 부작용 참고.
- **성공 산출물의 품질.** 주석 밀도, `ASSUMPTION:` 표기 준수(모델 불문),
  구현 정확성 모두 기대 이상. CLI 자체 에러 메시지(파일 없음, 미지 옵션,
  괄호 미종결 `file:line:col`)도 명확.

## 3. 엔진이 스스로를 실패시키는 결함 3건 (Critical)

세 건 모두 "모델이 못한 것"이 아니라 **엔진이 만든 함정에 모델이 빠진 것**
입니다. 오늘 관찰된 실패/낭비 전부가 이 세 건으로 설명됩니다.

### 3.1 ensure 하네스가 전역 내장 객체를 prologue 타입으로 import — todo-list 전멸의 원인

엔진이 결정론적으로 방출한 `test_TodoList.ensure.ts`에:

```ts
import type { RangeError, TodoItem } from "../implementations/__prologue__.ts";
```

`RangeError`는 ensure 계약의 `error instanceof RangeError`에서 수집된 전역
내장 객체인데 prologue import로 방출되었습니다. 같은 컴파일 옵션으로 재현한
tsc 결과:

```
error TS2305: Module '"../implementations/__prologue__.ts"' has no exported member 'RangeError'.
error TS1361: 'RangeError' cannot be used as a value because it was imported using 'import type'.
```

- 근본 원인: `collectExternalTypeNames`(src/realize.ts:406)가 대문자 식별자
  정규식 `\b[A-Z][A-Za-z0-9_$]*\b`으로 타입을 수집하고, 하드코딩 내장 목록
  (src/realize.ts:374-395)에 `RangeError`가 없음. `TypeError`, `JSON`,
  `Math`, `NaN`, ensure 시나리오 안의 대문자 로컬 변수 등도 같은 지뢰.
- 결과: **이 ensure 파일은 엔진 소유(수정 금지)이므로 어떤 모델이 와도 이
  세션은 성공이 불가능**함. gemini-3.6-flash는 원인을 정확히 진단하고
  prologue에 `export const RangeError = globalThis.RangeError;`를 추가하는
  (그 자체로는 영리한) 우회를 시도했으나, ①`import type`이라 TS1361은 그대로
  남고 ②prologue는 세션 종료 후 복원되므로 어차피 무효. 결국 턴 리밋으로
  사망했고 CLI는 "Turn limit (24) reached"만 출력.

### 3.2 엔진이 생성한 entry point가 엔진 린터 규칙을 위반 — 재실행마다 세션 1회 결정론적 낭비

- `implementation.ts`(엔진 생성 엔트리포인트)는 `__epilogue__`를 import함
  (renderEntryPoint). 그런데 `RunLinter`/독립 검증의 `no-epilogue-import`
  규칙은 출력 디렉토리의 **모든** .ts 파일을 검사함
  (src/realizer/tools/verification.ts:403-414).
- 첫 realize에서는 `implementation.ts`가 성공 후에야 쓰이므로 안 걸리지만,
  **재실행에서는 이전 성공 산출물이 남아 있어 즉시 린트 위반**이 됨.
- 관찰된 전개(collision 재실행): 세션 1에서 grok이 "auto-generated 파일이라
  내가 고치면 안 된다"고 올바르게 판단하고 Finish → 독립 검증이 린트에서
  탈락 → 재시도 세션 2에서 모델이 결국 굴복하여 엔진 소유
  `implementation.ts`를 재작성해 통과 → **성공 직후 엔진이 entry point를
  다시 (위반 상태로) 덮어씀**(src/realize.ts:259). 즉 다음 재실행도 동일한
  낭비를 반복하는 고정 루프.

### 3.3 멀티 심볼 파일: 선행 심볼의 1차 시도는 구조적으로 실패 (slug-tools에서 재현)

- 엔진은 realize 시작 시 `__epilogue__.ts`를 먼저 방출하는데, 여기에는 아직
  realize되지 않은 후행 심볼의 import(`./buildUniqueSlugs.ts`)가 들어 있음.
- 독립 검증의 RunTypeCheck는 디렉토리 전체를 검사하므로, **선행 심볼(slugify)이
  아무리 완벽해도 후행 심볼이 없는 한 선행 심볼의 검증은 통과 불가**.
- 관찰된 전개: slugify 1차 시도 → 검증 탈락(존재하지 않는 모듈 import) →
  재시도에서 deepseek이 "내 책임이 아니다"라고 정확히 판단하고도 통과를
  위해 **자기 스코프가 아닌 `buildUniqueSlugs.ts` 스텁을 대신 작성**해 통과.
  2개의 소함수에 세션 6회, 3m28s가 소요됨.
- 사용자가 별도로 관찰한 "자기 스코프가 아닌 파일을 수정하는 경우"의 유력한
  메커니즘이 이것임: 전체 디렉토리 검증이 스코프 밖 수정을 **부추김**.
- 계획 중인 `chz realize -j8`(심볼 병렬 realize)과 정면 충돌: 전체 디렉토리
  단위 typecheck/테스트가 유지되는 한, 동시 세션들은 서로의 미완성 상태
  때문에 상호 실패함. 심볼 단위 검증 스코프가 병렬화의 전제 조건.

## 4. 하네스·툴 설계 문제 (Major)

### 4.1 AskUser: non-TTY면 즉사하고, 질문에 답할 방법이 없음

- stdin/stdout 둘 중 하나라도 TTY가 아니면(파이프, `tee`, 리다이렉트, CI)
  interactive 핸들러가 아예 주입되지 않고(src/cli.ts:236), AskUser는 즉시
  Block으로 변환됨(src/realizer/tools/control.ts:197-199).
- sonnet-5는 phone 스펙의 실제 모호점 2개(무효 번호의 반환값, 010 이외
  번호 처리)를 정확히 짚어 AskUser를 호출했고 23초 만에 BLOCKED로 종료.
- Block 메시지에는 질문 헤더/본문만 있고 **선택지가 출력되지 않으며**,
  질문이 CONTEXTS.md 등 어디에도 기록되지 않음. "Answer these questions and
  rerun chz realize"라는 TODO를 **이행할 방법 자체가 없음** (재실행해도 같은
  모델은 같은 질문을 다시 하고 다시 죽을 뿐). 터미널 스크롤이 지나가면
  질문은 유실됨.
- 방향: 비대화형 세션에서는 질문을 파일(예: CONTEXTS.md에 미답변 섹션)로
  기록하고, 사람이 채운 뒤 재실행하면 회수되는 루프가 필요함.

### 4.2 쓰기 경계가 '디렉토리'까지만 — 소유권 경계는 코드로 강제되지 않음

- 문서 63의 원칙은 "경계는 디스패처에서 강제, prose는 코드로 강제할 수 없는
  것만"인데, 사람 소유(`__prologue__`, `__epilogue__`, `*.ensure.ts`)와 엔진
  소유(`implementation.ts`) 파일 보호는 전부 prose로만 존재함. 디스패처는
  outputDir 안이면 전부 허용.
- 실제 관찰: gemini가 prologue를 2회 수정(허용됨), grok이 entry point를
  재작성(§3.2), deepseek이 타 심볼 파일을 작성(§3.3). 사용자도 동일 현상을
  별도로 관찰함.
- 특히 나쁜 상호작용: 모델이 prologue를 고쳐 세션 내 검증을 green으로
  만들어도 **세션 종료 후 조용히 복원**되므로, 독립 검증은 모델이 본 적
  없는 상태에서 돌아감. 모델 입장에서는 "고쳤는데 왜 또 실패?"가 되고,
  재시도 토큰이 낭비됨. 쓰기 시점에 하드 거부(에러 메시지 = 복구 힌트)가
  문서의 원칙과도 일치함.

### 4.3 RunTests 경로 규약 — 오늘 실행한 **모든** 세션이 최초 1회 실패

- 5/5 세션에서 `RunTests` 첫 호출이 `error`(0-1ms)였고, 두 번째 호출에서
  성공. 시스템 프롬프트는 `tests/test_<name>.autogen.ts`라는 출력 디렉토리
  상대 경로를 각인시키는데, 경로 해석은 projectRoot 기준
  (src/realizer/base.ts:609-619)이라 모델의 첫 직감이 항상 틀림.
- 모델은 에러 메시지를 보고 즉시 복구하므로 치명적이진 않지만, 세션마다
  왕복 1회(느린 모델 기준 수십 초)와 토큰이 고정 비용으로 낭비됨. 툴 스펙
  원칙("descriptions must match implementation")에 정확히 해당하는 사례.

### 4.4 관측성: 실패의 '왜'가 사람에게 전달되지 않음

- 툴 에러의 **내용**이 로그에 없음 (`RunTests(files=2) → error · 0ms`가
  전부. 무슨 경로를 넘겼고 무슨 에러였는지는 모델만 앎).
- 진단 개수만 나오고 내용이 없음 (`RunTypeCheck → failed (2 diagnostics)`).
  §3.1을 진단하는 데 소스 코드를 읽고 tsc를 별도로 재현해야 했음.
- **독립 검증 결과와 재시도 사유가 전혀 출력되지 않음.** collision 재실행
  로그에는 Finish 직후 아무 설명 없이 `turn 1/24`가 다시 시작됨. 사람은
  세션이 왜 2번 도는지 알 수 없음.
- 턴 리밋 사망 시 "Turn limit (24) reached without Finish, Block, or
  Abort." 한 줄이 전부 — 어디까지 진행됐고 뭐에 막혀 있었는지 요약이 없음
  (문서 64가 말하는 handover summary는 Finish/Block/Abort를 불렀을 때만
  존재).
- 원칙 제안: **모델에게 피드백으로 준 정보는 전부 사람도 볼 수 있어야 함.**

### 4.5 스트리밍/하트비트 없음

- `chat.completions.create`가 논스트리밍(src/realizer/openai.ts:53)이라
  느린 추론 모델(grok-4.5)에서는 턴 사이에 콘솔이 수십 초씩 완전 침묵함.
  경과 시간 표시나 스피너, 최소한 "waiting for model…" 한 줄이 필요함.
- 부수: temperature 0.2 하드코딩, 턴당 모델 응답 시간도 로그에 없음
  (툴 실행 ms만 표시됨 — 정작 지배적 비용인 모델 시간은 안 보임).

### 4.6 고정 턴 캡 24 — '턴'의 실질 가치가 모델 스타일에 좌우됨

- grok은 턴당 여러 툴을 배칭하고 510줄을 원샷으로 써서 6턴 만에 끝냄
  (역설적으로 프롬프트의 "incremental workflow"를 무시한 쪽이 효율적).
- gemini는 턴당 툴 1개 + 페이징 플레일(같은 13줄 파일을 offset/limit만
  바꿔 **5회** 재독)로 캡을 소진. 함수 하나든 5메서드 클래스든 캡은 동일.
- 심볼 복잡도(멤버 수, ensure 수)에 비례한 캡, 혹은 최소한 config의
  `maxTurns`를 CLI에서 노출하는 것을 검토할 만함.

### 4.7 캐시는 기록만 되고 소비되지 않음 + 재실행마다 산출물이 통째로 바뀜

- 재실행 시 `specHash`가 동일해도 무조건 전체 재-realize (알려진 v0 제약).
  실측: 동일 스펙·동일 모델 재실행에서 **구현이 헬퍼 구조까지 통째로 다른
  코드**로 재생성됨. 커밋된 산출물의 diff가 매번 전량 발생 → 감사(재리뷰)
  비용도 매번 전량 발생.
- 타임스탬프가 파일 헤더와 cache에 박혀 있어 내용이 같아도 diff가 남.
- **동작(의미) 드리프트까지 확인됨.** phone 예제를 같은 모델(deepseek)로
  두 번 realize한 결과, 1차 구현은 10자리(`0101239999`)를
  `010-123-9999`로 포매팅했고 2차 구현은 "10자리는 구식이므로 무효"로
  해석해 입력을 그대로 반환함 — 요구사항의 "두 가지 형식이 있습니다"와
  사실상 모순되는 해석. phone에는 ensure 계약이 하나도 없어서 **양쪽 모두
  검증 green**. 즉 ensure가 계약을 고정하지 않은 동작은 재-realize마다
  조용히 바뀔 수 있고 엔진은 이를 감지하지 못함. 부수적으로 2차 구현은
  해석적 결정을 내렸음에도 `ASSUMPTION:` 마커가 없고 주석 언어도 영어로
  바뀜 — ASSUMPTION 표기·주석 스타일은 prose 요구일 뿐 린터가 검사하지
  않는다는 방증 (1차 구현과 grok의 collision 구현에는 표기가 있었고,
  grok은 주석에 한자 혼입(`[min, max] 闭구간`)도 있었음. 산출물 언어/스타일
  정책이 강제되지 않음).
- ensure 파일의 실패 메시지에 **절대 경로**
  (`/Users/cheesekun/works/chz/examples/...`)가 포함됨 — 커밋 대상 파일이
  머신 간 이식성이 없고, 협업 시 diff 노이즈가 됨.

### 4.8 기타 CLI/UX

- `chz.config.js`가 존재하면 `--model`/`--base-url`이 **에러로 거부**됨
  (src/cli.ts:309). 모델을 바꿔가며 실험하려면 config를 매번 편집하거나
  config 파일을 여러 개 만들어 `--config`로 지정해야 함. "config의 기본
  OpenAI realizer가 하나뿐이면 그 모델만 오버라이드" 같은 완화가 필요함.
- 실패/Block된 세션은 캐시 없는 고아 산출물(구현/스텁/절반의 테스트)을
  남기고, 다음 세션의 모델이 이를 "기존 작업물"로 읽음. 도움이 될 때도
  있지만(§collision 재실행) 실패 상태가 다음 세션의 컨텍스트를 오염시키는
  경로이기도 함(§3.3의 스텁). 최소한 실패 시 "고아 산출물이 남아 있음"
  안내가 필요함.
- `requirements`가 없는 imagine 심볼이 무경고로 통과함(`--json`에서
  `requirements: null`). 핵심 계약의 부재는 최소 경고 대상.
- 최종 요약의 "N tests passed"가 세션 중 표시(autogen만, 16)와 최종 표시
  (ensure 포함, 20)가 달라 혼동됨.

## 5. 실행 수단의 부재 (Major, 별도 항목)

realize 성공 후 **프로그램을 실행할 공식 경로가 없음**:

- `chz build`/`chz run`이 없고, `implementation.ts`를 node로 직접 실행하면
  examples가 `"type": "commonjs"`라 ESM 산출물과 충돌하여 즉사
  (`SyntaxError: Cannot use import statement outside a module`).
- vitest는 자체 변환으로 테스트를 돌려주지만, 정작 사용자가 첫 성공의
  보상(`충돌 여부: true`)을 보려면 문서화되지 않은 외부 도구(tsx 등)를
  스스로 동원해야 함. examples 패키지에는 tsx가 없음 (이번 평가에서는 루트
  devDependency의 tsx를 차용함).
- v0 스코프 문제라기보다 "첫 5분 경험"의 마지막 조각이 비어 있는 문제.

## 6. 모델별 관찰

| 모델 | 스타일 | 결과 |
|---|---|---|
| grok-4.5 | 배칭 + 사실상 원샷 구현. 프롬프트의 incremental 워크플로는 무시 | 전부 성공. 다만 추론이 느려 §4.5 체감 최악 |
| deepseek-v4-flash | reasoning에 코드 전문을 먼저 쓰고 옮겨 적음. ASSUMPTION 기록 충실 | 성공. §3.3에서 스코프 밖 스텁이라는 '창의적' 우회 |
| gemini-3.6-flash | 턴당 툴 1개, 페이징 플레일(동일 파일 5회 재독) | 엔진 버그(§3.1)와 겹쳐 턴 리밋 사망 |
| claude-sonnet-5 | 1턴에 12콜 폭발적 탐색(프로젝트 전체 glob, 루트 밖 접근 시도) 후 AskUser | 스펙상 가장 '올바른' 에스컬레이션이 현 하네스에서 최악의 결과(BLOCKED)로 이어짐 |

- 사용자 선행 관찰("Sonnet 5는 chz가 뭔지 알아야만 진행하는 느낌")과 정확히
  일치함. Claude 계열은 프롬프트의 에스컬레이션 규칙("모호하면 AskUser")을
  가장 충실히 따르는데, 비대화형 AskUser가 즉사 경로(§4.1)라서 "Claude와
  궁합이 나쁜 하네스"처럼 보이게 됨. 모델 문제가 아니라 하네스의 비대칭임.
- 공통 관찰: 4개 모델 전부 RunTests 경로를 처음에 틀림(§4.3). 모델 개성과
  무관한 툴 스펙 문제라는 방증.

## 7. 우선순위 제안 (요약)

1. **검증·테스트 스코프를 심볼 단위로** (§3.3, §3.2 동시 해소, `-j8`의 전제).
   엔진 소유 파일(entry point, ensure)과 타 심볼 파일은 린트/typecheck
   대상에서 세션별로 제외하거나 스코프를 명시.
2. **§3.1 수정**: 정규식 휴리스틱 대신 TS AST 기반 수집, 혹은 최소한 전역
   내장 식별자 전체 목록으로 필터.
3. **소유권 쓰기 금지를 디스패처에서 강제** (§4.2) — 에러 메시지에 "이
   파일은 사람/엔진 소유이며 수정 대신 X를 하라"는 복구 힌트 포함.
4. **실패 관측성** (§4.4): 툴 에러 본문·검증 diagnostics·재시도 사유를
   사람에게도 출력, 턴 리밋 시 마지막 상태 요약.
5. **비대화형 AskUser의 질문 영속화 + 회수 루프** (§4.1).
6. **실행 경로 제공** (§5): `chz run` 혹은 최소한 문서화.

## 부록: 증거 로그 위치

세션 로그 원본은 `examples/__donotcommit__tmpfile/realize-field-report-logs/`
(gitignore 대상)에 보존함: `collision-run1.log`, `collision-rerun.log`,
`phone-deepseek.log`, `phone-sonnet.log`, `todo-gemini.log`,
`gomoku-grok.log`, `slug-deepseek.log`, `impossible-deepseek.log`,
`phone-restore.log`. 본문에 인용된 로그 발췌와 tsc 재현 결과가 1차 증거임.
