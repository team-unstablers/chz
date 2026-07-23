# Realize: Harness Rules

> **NOTE**: 이 문서는 하네스의 실행 계약을 구현 수준까지 내려가 정의하는
> 레퍼런스 문서로, 의도적으로 다른 numbered spec보다 상세하고 기술적으로
> 작성되었습니다 (WRITING_RULES의 분량·밀도 관례를 따르지 않습니다).
> 툴 명세의 상당 부분은 범용 하네스(opencode, Claude Code)의 실제 구현을
> 정독하고 얻은 교훈 위에 세워져 있으며, 본문 곳곳에 그 근거를 함께 적습니다.

# LLM이 혼자 정하면 안 되는 것들

[61 문서](61-realize-realizer.ko.md)의 하네스는 주로 **공간의 경계**를 다룹니다
— 읽기는 `projectRoot` 안에서만, 쓰기는 `outputDir` 안에서만. 이 문서는 그 위에
얹히는 다른 종류의 경계, **결정의 경계**를 다룹니다: LLM이 스스로 정해도 되는
것과, 반드시 사람에게 넘겨야 하는 것 사이의 경계입니다.

realize 산출물의 `ASSUMPTION:` 주석([60 문서](60-realize-intro.ko.md))은
"요구사항이 애매하면 — 가정하고, 가정했다고 표시하고, 진행한다"는 규칙이었습니다.
그런데 모든 애매함이 가정으로 넘어가도 되는 것은 아닙니다. 세 가지 요구를 봅시다.

```typescript chz
imagine function makeMeRich() {
  requirements(`저를 부자로 만드는 함수를 작성해 주세요`);
}
```

어떤 코드도 이 요구를 만족할 수 없습니다. 애매해서 가정으로 메꿀 문제가 아니라,
요구 자체가 성립하지 않습니다.

```typescript chz
imagine function inappropriateRequest() {
  requirements(`비윤리적인 컨텐츠를 만드는 함수를 작성해 주세요`);
}
```

만들 수 있더라도 만들면 안 되는 요구도 있습니다.

```typescript chz
/// MyFunnyGame.chz.ts (발췌)

imagine class MyFunnyGame {
  requirements(`WebGL 기반의 자동차 게임을 만들어 주세요.`);
}
```

이번에는 지극히 정상적인 요구입니다. 다만 three.js 같은 외부 라이브러리
(디펜던시)가 있으면 훨씬 잘 만들 수 있습니다. 그런데 프로젝트에 디펜던시를
추가할지는 산출물의 구조를 통째로 바꾸는 결정이고, 이런 결정을 LLM이
`ASSUMPTION:` 한 줄로 조용히 내려버린다면 치즈의 원칙 — LLM이 구현하고, 사람이
감독한다 — 이 무너집니다.

세 경우의 공통점은 **LLM이 판단을 멈추고 사람에게 공을 넘겨야 한다**는 점입니다.
이렇게 결정을 위(사람)로 넘기는 것을 **에스컬레이션(escalation)**이라고 부르며,
이 문서는 그 규칙을 정의합니다.

# 에스컬레이션 사다리

하네스는 결정의 무게에 따라 네 단계의 행동을 규정합니다. 아래로 갈수록 무거운
결정입니다:

| 상황 | 행동 | 예시 |
|------|------|------|
| 해석의 여지가 있지만, 어느 쪽으로 정해도 나중에 바꾸기 쉬움 | `ASSUMPTION:` 주석을 남기고 진행 (60 문서) | 연 기준 일수를 365일로 가정 |
| 산출물의 구조가 통째로 달라지는 결정 | `AskUser`로 사람에게 질문 | 외부 디펜던시(three.js) 도입 여부 |
| 사람이 행동해 줘야 진행할 수 있음 | `Block`으로 대기 선언 | 디펜던시가 설치되기를 기다림 |
| 요구가 원리적으로 불가능하거나 부적절함 | `Abort`로 포기 선언 | `makeMeRich`, `inappropriateRequest` |

표의 `AskUser`와 `Block`은 이 문서가 새로 도입하는 툴입니다. 하네스가 LLM에게
제공하는 툴의 전체 목록과 명세는 아래 '하네스 툴 명세' 절에서 정의합니다.

## 사다리를 지탱하는 두 규칙

- **triage는 코드보다 먼저.** 구현을 시작하기 전에 "이 요구를 받아도 되는가,
  받는다면 무엇이 필요한가"를 먼저 분류하는 일을 triage(트리아지)라고 부릅니다 —
  응급실에서 치료보다 환자 분류를 먼저 하는 것과 같습니다. 실현 가능성과
  디펜던시 판단은 세션 초반, 구현 코드를 한 줄이라도 쓰기 전에 이루어져야
  합니다. 수십 턴을 작업한 뒤에 Abort하는 것은 사람의 시간과 토큰을 모두
  낭비합니다. 이 규칙은 하네스 시스템
  프롬프트([64 문서](64-realize-harness-prompt.ko.md))에 명시되며, 별도의
  '플래너' 컴포넌트를 두는 대신 **에이전틱 세션의 첫 턴들이 자연스럽게
  triage 역할을 하게** 합니다.
- **설치는 사람의 몫.** LLM이 디펜던시를 제안할 수는 있어도, 설치는 사람이
  합니다. 하네스에 셸 툴이 없다는 원칙('설계 원칙' 절 참조)과 같은 이유로, 엔진도
  package.json이나 node_modules를 건드리지 않습니다.

# 하네스 툴 명세

에이전틱 세션에서 LLM에게 주어지는 툴은 다음이 전부입니다:

| 분류 | 툴 | 시그니처 | 한 줄 요약 |
|------|----|----------|-----------|
| 읽기 | `ReadFile` | `(path, offset?, limit?): string` | 파일을 (부분) 읽기. `projectRoot` 내부만 |
| 읽기 | `ReadDir` | `(path, offset?, limit?): string` | 디렉토리 목록. `ReadFile`과 동일한 경계·페이징 |
| 검색 | `Glob` | `(pattern, path?, limit?): string` | 파일명 패턴 검색 |
| 검색 | `Grep` | `(pattern, path?, include?, limit?): string` | 파일 내용 정규식 검색 |
| 쓰기 | `WriteFile` | `(path, content): string` | 파일 전체 쓰기. `outputDir` 내부만 |
| 쓰기 | `FindAndReplace` | `(path, oldString, newString, replaceAll?): string` | 정확 일치 기반 부분 수정. `WriteFile`과 동일한 경계 |
| 검증 | `RunTests` | `(testFiles: string[]): TestResult[]` | 엔진이 고정된 러너(vitest)로 테스트 실행 |
| 검증 | `RunTypeCheck` | `(): TypeCheckResult` | 엔진이 tsc를 실행 |
| 검증 | `RunLinter` | `(): LintResult[]` | 엔진이 린터를 실행 |
| 대화 | `AskUser` | `(questions: ChzAskUserQuestion[]): ChzAskUserAnswer[]` | 구조를 바꾸는 결정을 사람에게 질문 |
| 종료 | `Finish` | `(): void` | 완성을 '주장'하고 세션 종료 |
| 종료 | `Block` | `(reason, todo): void` | 사람의 행동을 기다리는 대기 선언 |
| 종료 | `Abort` | `(reason): void` | 구현 불가능 선언 |

각 툴의 상세 명세는 아래 절들에서 정의합니다. 시그니처의 반환 타입 `string`은
"모델에게 텍스트로 렌더되어 돌아가는 출력"을 뜻합니다 — 하네스 내부에서는
구조화된 값으로 다루더라도, 모델과의 계약은 최종 렌더 문자열입니다.

## 설계 원칙

모든 툴에 일관되게 적용되는 여섯 가지 원칙입니다. 상당수는 opencode 하네스의
V1/V2 구현을 정독하고 얻었으며, '하지 말아야 할 것'은 실제 사례에서 왔습니다.

1. **셸 툴은 없다.** opencode의 bash 툴은 스스로를 이렇게 설명합니다 —
   *"Execute one shell command string with the host user's filesystem, process,
   and network authority."* 셸 하나가 파일시스템·프로세스·네트워크 전권을
   통째로 넘긴다는 뜻이고, 이것이 치즈가 피하려는 바로 그 표면입니다.
   Realizer의 검증 수단(`RunTests`/`RunTypeCheck`/`RunLinter`)은 엔진이 미리
   정해 둔 명령을 실행할 뿐이므로, LLM이 임의의 명령을 구성할 표면 자체가
   존재하지 않습니다. 셸을 빼면 파일 툴들이 각자 경계를 자기완결적으로 가져야
   하는데(검색·부분 읽기·부분 수정), 이 문서의 툴셋이 바로 그 자기완결성을
   제공합니다.
2. **경계는 산문이 아니라 코드다.** "스코프 외의 코드를 수정하지 못하도록
   제한한다"는 61 문서의 역할 정의는 별도의 감시 장치나 프롬프트 지시가 아니라
   **툴 디스패처의 경로 검사 그 자체**로 구현됩니다. 프롬프트에는 경계의 존재를
   짧게 한 번만 알립니다. (opencode V2의 기본 에이전트 프롬프트가 한 문장인
   이유와 같습니다 — 행위 규범은 permission ruleset이 강제합니다.)
3. **모든 에러 메시지는 복구 힌트다.** 비대화형 루프에서 툴 에러 문구는 모델이
   읽는 유일한 교정 신호입니다. 모든 에러는 "원인 + 다음 행동"을 한 문장에
   담아야 합니다. 예: *"Found multiple exact matches for oldString. Provide
   more surrounding context or set replaceAll to true."*
4. **설명(description)과 구현은 일치해야 한다.** opencode는 edit/write 툴
   설명에 *"This tool will error if you attempt an edit without reading the
   file."*이라고 적어 두고도 정작 코드에는 그 게이트가 없었고, 설명이 광고하는
   에러 문구조차 실제 코드와 달랐습니다. 치즈는 이 문서의 모든 에러 문구를
   구현과 문자 그대로 동일하게 유지하며, 강제하지 않는 규칙을 "실패한다"고
   적지 않습니다. 반대로 read-before-write처럼 강제하기로 한 규칙은 실제로
   코드로 강제합니다(공통 규칙 참조).
5. **출력 바운딩은 단일 경계가 소유한다.** 모델에게 돌아가는 출력의 절단은
   개별 툴이 아니라 툴 디스패처 한 곳에서 일괄 수행합니다(공통 규칙 참조).
   개별 툴은 완전한 출력을 반환할 책임만 집니다.
6. **검증 결과는 인라인으로 되먹인다.** 쓰기 계열 툴의 성공 응답에는 방금 쓴
   파일에 대한 진단(타입체크·린트 에러)이 자동으로 첨부됩니다. 모델이
   `RunTypeCheck`를 스스로 호출하지 않아도 오류를 즉시 인지하게 하여, red를
   되먹이는 엔진 검증 루프(61 문서)를 툴 단위로 앞당긴 것입니다.

> **NOTE (에러 문구의 정본)**: 이 문서의 에러·안내 문구는 영문 원문이
> 정본입니다. 모델에게 노출되는 문자열은 학습 분포상 영문이 가장 안정적으로
> 해석되며, 구현과 문서의 문자 단위 일치(원칙 4)를 검사하기도 쉽습니다.

## 공통 규칙

### 경로 해석과 경계 검사

모든 경로 파라미터는 다음 순서로 처리됩니다. 이 검사는 각 툴이 아니라 공용
경로 해석기 한 곳에 구현되며, 모든 툴이 이를 통과해야 실행됩니다.

1. **해석(resolve)**: 절대 경로는 그대로, 상대 경로는 `projectRoot` 기준으로
   해석합니다.
2. **정규화(realpath)**: 심볼릭 링크를 풀어 실경로(canonical path)를 얻습니다.
   대상이 아직 존재하지 않으면(신규 파일 쓰기) 존재하는 최근접 상위 디렉토리의
   실경로를 기준으로 판정합니다.
3. **포함 검사(contains)**: 문자열 prefix 비교가 아니라 정규화된 실경로 기준으로
   허용 루트 포함 여부를 검사합니다. `../` 탈출과 심볼릭 링크 탈출이 모두 이
   단계에서 막힙니다.

경계는 툴 분류에 따라 둘로 나뉩니다:

- **읽기 계열**(`ReadFile`/`ReadDir`/`Glob`/`Grep`)의 허용 루트는
  `projectRoot`입니다. 추가로 **차단 목록(blocklist)**이 적용됩니다 — 기본값:
  `.env*`(단, `.env.example`은 허용), `chz.config.js`, `.git/` 이하
  전체, `*.pem`, `*.key`, `id_rsa*`. **차단 목록은 검색 입력과 결과 모두에
  적용됩니다** — `Glob`이 차단된 파일명을 반환하거나 `Grep`이 그 내용을
  읽어 매치로 돌려주는 일은 없습니다.
- **쓰기 계열**(`WriteFile`/`FindAndReplace`)의 허용 루트는 `outputDir`입니다.
  읽기 계열과 동일한 차단 목록도 적용됩니다.

opencode는 루트 밖 접근을 "사용자에게 물어봄(external_directory 승인)"으로
처리하지만, 치즈의 realize 세션은 비대화형이 기본이므로 승인 플로우를 두지
않습니다. **경계 밖은 즉시 에러입니다**:

| 상황 | 에러 문구 |
|------|-----------|
| 읽기 루트 밖 | `Read access denied: {path} is outside the project root ({projectRoot}).` |
| 읽기 차단 목록 매치 | `Read access denied: {path} matches the blocked-path list (.env files (except .env.example), chz.config.js, keys, .git).` |
| 쓰기 차단 목록 매치 | `Write access denied: {path} matches the blocked-path list (.env files (except .env.example), chz.config.js, keys, .git).` |
| 쓰기 루트 밖 | `Write access denied: {path} is outside the realization output directory ({outputDir}). Realized code and tests must be written there.` |

### 읽은 파일 추적 — read-before-write는 코드로 강제됩니다

하네스는 세션마다 **읽은 파일 집합**을 유지합니다: `ReadFile`이 성공할 때마다
`경로 → 그 시점의 파일 내용 해시`를 기록합니다(부분 읽기여도 해시는 전체 파일
기준). 이 집합은 두 가지 게이트에 쓰입니다:

- **read-before-write**: `FindAndReplace`는 대상 파일이 집합에 없으면
  거부합니다. `WriteFile`은 대상이 **이미 존재하는 파일**인데 집합에 없으면
  거부합니다(신규 파일 생성은 게이트 없음).
- **스테일 검사(낙관적 동시성)**: 쓰기 직전, 파일의 현재 해시가 기록된 해시와
  다르면 — 마지막으로 읽은 뒤 파일이 바뀌었다는 뜻이므로 — 거부합니다.
  쓰기 성공 시 하네스가 기록 해시를 갱신하므로, 자기 자신의 연속 편집은
  재-read 없이 이어집니다.

| 상황 | 에러 문구 |
|------|-----------|
| 읽지 않은 파일 편집 | `You must read {path} with ReadFile before editing it.` |
| 읽지 않은 기존 파일 덮어쓰기 | `Refusing to overwrite an existing file you have not read. Read {path} first, or use FindAndReplace for a partial edit.` |
| 스테일 | `File changed since you last read it. Read {path} again before editing.` |

opencode는 이 규칙을 툴 설명에만 적고 구현하지 않았습니다(설계 원칙 4의
반면교사). 치즈는 override 마커 보존(60 문서)과 산출물 무결성이 걸린 문제이므로
하네스가 실제로 강제합니다.

### 출력 바운딩 — 단일 경계

모델에게 돌아가는 모든 툴 출력은 디스패처의 마지막 단계에서 일괄적으로
바운딩됩니다. 개별 툴은 자체 절단을 하지 않습니다(툴 고유의 상한 — `ReadFile`의
페이지 캡 등 — 은 별개이며, 각 툴 절에 명시합니다).

- 상한: **2,000줄 또는 50KB(51,200바이트)** 중 먼저 걸리는 쪽.
- 초과 시: 전문을 `{projectRoot}/.chz/tool-output/tool_{seq}.log`에 저장하고,
  모델에게는 head ⌈N/2⌉ + tail ⌊N/2⌋의 미리보기와 다음 마커를 돌려줍니다:

  ```
  ... output truncated; full content saved to {path} ...
  Use ReadFile with offset/limit, or Grep, to inspect the full output.
  ```

- 저장 위치가 `projectRoot` 내부이므로, 모델은 방금 안내받은 경로를
  `ReadFile`(부분 읽기)이나 `Grep`으로 즉시 재탐색할 수 있습니다. 셸 없는
  툴셋에서 잘린 출력을 다시 여는 경로가 이렇게 닫힌 고리로 완성됩니다.
- `.chz/tool-output/`은 git-ignore 대상이며, 엔진이 7일 보존 후 청소합니다.

### 입력 검증

모든 툴 호출의 인자는 실행 전에 스키마(타입·필수 여부·수치 범위)로 검증됩니다.
두 가지 실패는 서로 다른 문구로 구분됩니다 — 전자는 모델이 고칠 수 있는
문제이고, 후자는 하네스 버그 신호입니다:

- 입력 검증 실패: `Invalid tool input: {schema error}. Please rewrite the
  input so it satisfies the expected schema.`
- (내부) 툴 출력이 자기 스키마에 안 맞음: 모델에게 노출하지 않고 하네스
  에러로 기록합니다.

수치 파라미터의 범위(`limit`의 최대값 등)는 런타임 클램프가 아니라 **스키마
레벨에서 강제**합니다. 스키마 상한은 JSON Schema로 모델에게 노출되므로, 모델이
유효 범위를 애초에 알 수 있습니다.

## 읽기 툴

### `ReadFile`

```typescript
ReadFile(path: string, offset?: number, limit?: number): string
```

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `path` | `string` | ✓ | 읽을 파일 경로. 절대 또는 `projectRoot` 기준 상대 |
| `offset` | `int ≥ 1` | | 읽기 시작 라인 번호 (1-indexed). 기본 1 |
| `limit` | `1 ≤ int ≤ 2000` | | 최대 읽을 라인 수. 기본 2000 (스키마 상한 2000) |

**동작.**

- 출력의 각 줄에는 `{줄번호}: ` 접두어가 붙습니다. 예: 파일 내용이
  `foo\n`이라면 `1: foo`를 받습니다. 모델은 이 접두어를 `FindAndReplace`의
  `oldString`/`newString`에 절대 포함해서는 안 됩니다(시스템 프롬프트와 툴
  설명에 명시).
- 세 겹의 상한이 함께 적용됩니다:
  1. **라인 수** — 호출당 최대 2,000줄 (`limit`).
  2. **라인 길이** — 한 줄 2,000자 초과분은 잘리고 접미사
     `... (line truncated to 2000 chars)`가 붙습니다. 미니파이된 번들의 한
     줄이 예산 전체를 삼키는 것을 막습니다.
  3. **페이지 바이트** — 누적 50KB(51,200바이트)에 도달하면 그 지점에서
     멈춥니다.
- 출력 끝에는 항상 셋 중 하나의 푸터가 붙어, 모델이 다음 호출을 계산할 수
  있게 합니다:
  - 끝까지 읽음: `(End of file - total {count} lines)`
  - 라인 상한: `(Showing lines {a}-{b} of {count}. Use offset={next} to continue.)`
  - 바이트 캡: `(Output capped at 50 KB. Showing lines {a}-{b}. Use offset={next} to continue.)`
- 빈 파일을 `offset=1`로 읽는 것은 허용됩니다(에러가 아니라 빈 내용 + 푸터).
- 인코딩: UTF-8을 **fatal 모드**로 디코딩합니다. 손실 디코딩(대체문자)으로
  오염된 소스를 모델에게 넘기면 이후 편집이 어긋나므로, 잘못된 인코딩은 조기
  실패시킵니다.
- 바이너리 방어(3중 검사): (1) 확장자 블록리스트(`.zip .exe .so .dll .wasm
  .pyc .jar` 등), (2) 선두 샘플의 매직 바이트 스니핑, (3) NUL 바이트 존재
  또는 비출력 문자 비율 > 0.3. 어느 하나라도 걸리면 텍스트로 읽지 않습니다.
- 파일이 없으면, 같은 디렉토리에서 대소문자 무시 부분일치하는 항목을 **최대
  3개**까지 후보로 제시합니다. 셸 자동완성이 없는 환경에서 모델의 경로 오타를
  한 번의 왕복으로 교정시키는 저비용 장치입니다.

**에러.**

| 상황 | 에러 문구 |
|------|-----------|
| 파일 없음 | `File not found: {path}` (+ 후보가 있으면 `\n\nDid you mean one of these?\n{후보 ≤3}`) |
| offset이 파일 범위 밖 | `Offset {offset} is out of range for this file ({count} lines).` |
| 바이너리 | `Cannot read binary file: {path}` |
| 인코딩 불량 | `File is not valid UTF-8: {path}` |
| 경로가 디렉토리 | `Path is a directory, not a file: {path}. Use ReadDir instead.` |

**툴 설명에 담을 사용 지침** (모델 유도용 — 강제가 아니라 안내이며, 원칙 4에
따라 "실패한다"는 표현을 쓰지 않습니다):

- 이어 읽기는 더 큰 `offset`으로 다시 호출.
- *"Avoid tiny repeated slices (30 line chunks). If you need more context,
  read a larger window."* — 잘게 반복 읽기로 왕복을 낭비하지 말 것.
- 큰 파일·긴 라인에서 특정 내용을 찾을 때는 `Grep`을, 경로가 불확실할 때는
  `Glob`을 사용할 것.
- 여러 파일을 읽어야 한다면 병렬로 호출할 것.

### `ReadDir`

```typescript
ReadDir(path: string, offset?: number, limit?: number): string
```

파라미터와 페이징 규칙(기본 2000, 스키마 상한 2000, `offset` 1-indexed)은
`ReadFile`과 동일합니다.

**동작.**

- 항목 정렬: **디렉토리 우선, 이후 사전순**. 하위 디렉토리에는 트레일링 `/`를
  붙입니다. 정렬이 고정이므로 출력이 결정적입니다.
- 심볼릭 링크는 대상의 stat으로 종류를 판정하며, **실경로가 `projectRoot`
  밖을 가리키는 항목은 목록에서 제외**합니다(경계 검사의 일부).
- 푸터: 전체를 보였으면 `({count} entries)`, 잘렸으면
  `(Showing entries {a}-{b} of {count}. Use offset={next} to continue.)`

## 검색 툴

셸이 없는 툴셋에서 검색 툴은 사치가 아니라 필수입니다 — `ReadDir`/`ReadFile`만
으로 코드베이스를 탐색하면 왕복 횟수가 폭발합니다. 치즈는 opencode와 같은
전략을 취합니다: **정규식·글롭 문법을 자체 구현하지 않고 ripgrep 바이너리에
위임**합니다.

> **NOTE (구현)**: 엔진은 버전을 고정한 ripgrep을 사용합니다 — 시스템에 같은
> 메이저 버전의 `rg`가 있으면 재사용하고, 없으면 엔진 배포본을 사용합니다.
> 모든 호출에 `--no-config`(사용자 ripgrep 설정 무시)와
> `--glob=!**/.git/**`(`.git` 강제 제외)를 적용하고, `.gitignore`를 존중합니다.
> 읽기 차단 목록(`.env` 등)에 걸리는 파일은 검색 대상과 결과 양쪽에서
> 제외됩니다.

### `Glob`

```typescript
Glob(pattern: string, path?: string, limit?: number): string
```

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `pattern` | `string` | ✓ | 글롭 패턴 (gitignore 스타일: `**/*.ts`, `src/**/*.{ts,tsx}`) |
| `path` | `string` | | 검색 시작 디렉토리. 기본 `projectRoot`. 파일이면 에러 |
| `limit` | `1 ≤ int ≤ 2000` | | 최대 결과 수. 기본 100 |

**동작.**

- 매치된 파일 경로를 **`projectRoot` 기준 상대 경로**로, 한 줄에 하나씩
  반환합니다. 반환된 경로는 `ReadFile`에 그대로 넘길 수 있습니다.
- 숨김 파일은 기본 제외합니다(파일 목록 노이즈 방지 — 내용 검색인 `Grep`과
  다른 기본값이며, 의도된 비대칭입니다).
- 결과 없음: `No files found`
- 잘림: 끝에 `(Results truncated: showing first {limit} results. Use a more
  specific pattern or path, or raise limit.)` — **잘림 사실을 숨기지 않습니다.**
  opencode V2는 truncated 플래그를 버려 모델이 불완전한 검색을 완전한 것으로
  오인할 수 있었습니다(반면교사).
- 정렬은 보장하지 않습니다(ripgrep 순회 순서). 툴 설명에 "순서에 의존하지 말
  것"을 명시합니다.

**에러.**

| 상황 | 에러 문구 |
|------|-----------|
| path가 파일 | `Glob path must be a directory: {path}` |

### `Grep`

```typescript
Grep(pattern: string, path?: string, include?: string, limit?: number): string
```

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `pattern` | `string` | ✓ | 정규식 (ripgrep/Rust regex 문법, 대소문자 구분) |
| `path` | `string` | | 검색 시작 디렉토리 또는 단일 파일. 기본 `projectRoot` |
| `include` | `string` | | 대상 파일 글롭 필터 (예: `*.ts`, `*.{ts,tsx}`) |
| `limit` | `1 ≤ int ≤ 2000` | | 최대 매치 수. 기본 100 |

**동작.**

- 출력은 파일별로 그룹핑됩니다:

  ```
  Found {n} matches
  {relative/path/a.ts}:
    Line 12: {매치 라인}
    Line 40: {매치 라인}

  {relative/path/b.ts}:
    Line 3: {매치 라인}
  ```

- 매치 라인 미리보기는 한 줄 2,000자에서 절단합니다.
- 숨김 파일도 검색합니다(단, `.gitignore`·`.git`·차단 목록 제외는 동일).
  `path`가 파일이면 그 단일 파일만 검색합니다.
- 결과 없음: `No matches found`. 잘림 안내는 `Glob`과 동일한 형식입니다.

**에러.**

| 상황 | 에러 문구 |
|------|-----------|
| 정규식 문법 오류 | `Invalid regex pattern: {ripgrep의 파싱 에러 원문}` — 모델이 원인을 보고 스스로 고치게 stderr를 그대로 노출합니다 |

## 쓰기 툴

### `WriteFile`

```typescript
WriteFile(path: string, content: string): string
```

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `path` | `string` | ✓ | 쓸 파일 경로. `outputDir` 내부만 |
| `content` | `string` | ✓ | 파일 전체 내용 |

파라미터는 의도적으로 이 둘뿐입니다 — mode/append/encoding 같은 옵션은 없습니다.
쓰기 툴은 "전체 내용을 쓴다" 하나만 하고, 부분 수정은 `FindAndReplace`가
전담합니다. 여기서 "전체 내용"은 **이번 호출이 파일의 일부만 덮어쓰지
않는다**는 뜻이지, 한 번의 호출로 최종본을 완성하라는 뜻은 아닙니다. 현재
증분의 완전한 파일 내용을 쓴 뒤, 다음 턴에서 진단과 검증 결과를 확인하고 다시
수정할 수 있습니다.

**동작.**

- 부모 디렉토리는 자동 생성됩니다(쓰기 시도 → 없으면 재귀 mkdir 후 재시도).
  mkdir 툴이 따로 필요 없는 이유입니다.
- 신규 생성과 덮어쓰기를 응답에서 구분합니다:
  `Created file successfully: {path}` / `Wrote file successfully: {path}`.
  모델이 의도치 않게 기존 파일을 덮었는지 스스로 알 수 있는 값싼 신호입니다.
- 기존 파일 덮어쓰기에는 read-before-write와 스테일 검사가 적용됩니다
  (공통 규칙 참조).
- 개행 스타일과 BOM은 기존 파일 것을 보존합니다. 인코딩 churn이 diff와
  `realization-cache.json` 해시를 오염시키지 않게 하기 위함입니다.
- 성공 응답 끝에 **인라인 진단**이 첨부됩니다(아래 참조).

### `FindAndReplace`

```typescript
FindAndReplace(path: string, oldString: string, newString: string, replaceAll?: boolean): string
```

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `path` | `string` | ✓ | 수정할 파일. `outputDir` 내부만 |
| `oldString` | `string` | ✓ | 교체할 정확한 원문. 빈 문자열 불가 |
| `newString` | `string` | ✓ | 대체 텍스트. `oldString`과 달라야 함 |
| `replaceAll` | `boolean` | | 모든 정확 일치를 교체. 기본 `false` |

**매칭 시맨틱: 정확 일치 전용.**

- `oldString`은 파일 내용과 **문자 단위로 정확히** 일치해야 합니다 — 공백,
  들여쓰기 포함. 단 하나의 관용은 하네스가 흡수하는 정규화입니다: 모델이 준
  문자열을 파일이 실제 쓰는 개행 스타일(`\n` vs `\r\n`)로 변환해 비교하고,
  BOM을 보존합니다. 모델에게 `\r\n`을 정확히 재현하라고 요구하지 않는 이
  저비용 처리만으로 실패율이 크게 줄어듭니다.
- `replaceAll`이 아닐 때 정확 일치가 2개 이상이면 **교체하지 않고
  거부**합니다. 광범위 오편집을 막는 1차 방어선입니다.
- 퍼지 매칭(줄 트림, 공백 정규화, 블록 앵커 등)은 넣지 않습니다. opencode
  V2도 "정확 편집의 동작이 안정된 뒤에만 퍼지 전략을 이식한다"며 같은 순서를
  택했습니다.

> **NOTE (향후 확장)**: 정확 일치의 실패율이 실측에서 문제로 확인되면,
> opencode V1의 점진적 완화 스택(줄 트림 → 공백 정규화 → 들여쓰기 유연 →
> 블록 앵커, 유사도 임계 0.65)을 참고해 얹을 수 있습니다. 이때 두 가지 원칙이
> 함께 와야 합니다: (1) 퍼지는 '어디를' 찾을 뿐, 치환은 파일에 실재하는
> substring 그대로 수행한다(치환 텍스트를 지어내지 않는다), (2) 매칭 span이
> `oldString`보다 지나치게 크면 거부하는 과대매칭 가드를 둔다.

**성공 응답.**

```
Edit applied successfully: {path}
Replacements: {n}
```

이어서 old/new 각각 앞 6줄(줄당 240자 절단)의 diff 프리뷰와, 인라인 진단이
첨부됩니다. 전체 diff는 모델이 아니라 세션 로그(사람·감사용)에 기록됩니다 —
모델용 출력과 사람용 메타데이터의 분리입니다.

**에러.** 각 문구가 정확히 하나의 '다음 행동'에 대응하도록 설계되어 있습니다:

| 상황 | 에러 문구 | 유도되는 행동 |
|------|-----------|---------------|
| old == new | `No changes to apply: oldString and newString are identical.` | 호출 재검토 |
| 빈 oldString | `oldString must not be empty. Use WriteFile to create or overwrite a file.` | `WriteFile`로 전환 |
| 매치 없음 | `Could not find oldString in the file. It must match exactly, including whitespace and indentation.` | 재-read 후 정확한 원문으로 재시도 |
| 다중 매치 | `Found multiple exact matches for oldString ({n} occurrences). Provide more surrounding context to make it unique, or set replaceAll to true.` | 컨텍스트 확장 또는 `replaceAll` |
| 파일 없음 | `File not found: {path}` | 경로 확인 (`Glob`) |
| 경로가 디렉토리 | `Path is a directory, not a file: {path}` | 경로 확인 |

(read-before-write·스테일·경계 에러는 공통 규칙의 문구를 따릅니다.)

### 인라인 진단 — 쓰기 툴의 자동 피드백

`WriteFile`/`FindAndReplace`가 성공하면, 하네스는 방금 쓴 파일에 대한 진단
(타입체크·린트)을 실행해 **ERROR 심각도만** 응답 끝에 첨부합니다:

```
Diagnostics detected in this file, please fix:
<diagnostics file="{path}">
ERROR [12:5] TS2322: Type 'string' is not assignable to type 'number'.
...
</diagnostics>
```

- 파일당 최대 20개, 초과분은 `... and {n} more`로 접습니다.
- **에러가 0개면 아무것도 붙이지 않습니다** — 침묵이 green 신호입니다.
- 진단 실행 자체가 실패하면(러너 크래시 등) 조용히 생략합니다. 부가 피드백의
  실패가 쓰기 성공을 절대 깨뜨려서는 안 됩니다.
- 구현은 매 쓰기마다 전체 tsc를 도는 대신 incremental 타입체커/tsserver 상주를
  권장합니다(엔진 세부사항).

이 피드백은 `RunTypeCheck`를 대체하지 않습니다 — 인라인 진단은 "방금 쓴 파일"
의 빠른 신호이고, `RunTypeCheck`는 세션 스코프 전체의 판정입니다.

## 검증 툴

세 툴 모두 **엔진이 미리 정해 둔 명령**을 실행할 뿐입니다. LLM이 넘기는 인자는
`RunTests`의 대상 파일 목록이 전부이고, 커맨드라인을 구성할 표면은 없습니다.

세 툴의 기본 판정 범위는 **세션 스코프**입니다: 이 세션이 realize 중인 심볼
(순환 그룹이면 그 멤버 전체)의 구현·autogen·ensure 파일. 스코프 파일이
import하는 대상(프롤로그, 이미 realize된 의존 심볼)은 타입체크에 자연히
포함되지만, 아직 realize되지 않은 다른 심볼의 파일이나 `__epilogue__`가 세션의
판정을 오염시키지는 않습니다. 스코프 없는 전체 판정은 모든 심볼이 resolve된
뒤 엔진의 최종 검증에서 한 번 수행됩니다([61 문서](61-realize-realizer.ko.md)).

### `RunTests`

```typescript
RunTests(testFiles: string[]): TestResult[]
```

- `testFiles`는 `outputDir` 내부의 테스트 파일 경로들이어야 합니다(경계 검사
  적용). 빈 배열이면 세션 스코프의 전체 테스트(이 심볼의 autogen + ensure)를
  실행합니다. 스코프 심볼의 autogen 테스트가 아직 없으면 red 결과와 함께
  "유닛 테스트를 먼저 작성하라"는 복구 힌트를 돌려줍니다.
- 엔진이 vitest를 고정 설정으로 실행하고, 결과를 요약해 돌려줍니다: 파일별
  pass/fail 카운트와, 실패한 테스트의 이름·assertion 메시지·관련 스택 일부.
- 세션 안에서 green을 확인했더라도 그것이 최종 판정은 아닙니다 — `Finish` 후
  엔진의 독립 검증이 다시 실행됩니다(61 문서).

### `RunTypeCheck`

```typescript
RunTypeCheck(): TypeCheckResult
```

- 엔진이 세션 스코프 파일과 그 import 대상에 `tsc --noEmit`을 실행하고, 진단
  목록(`{file, line, col, code, message}`)을 돌려줍니다. 스코프가 없는 최종
  검증에서는 realization 디렉토리 전체가 대상입니다.

### `RunLinter`

```typescript
RunLinter(): LintResult[]
```

- 엔진이 고정 설정의 린터(eslint)를 실행하고 결과를 돌려줍니다. realize
  산출물의 제한 서브셋 검사(`no-eval`, `no-any`, `@profile` 밖 API 사용 금지 —
  00 문서)도 린트 규칙으로 이 단계에서 걸립니다.
- 제한 서브셋은 **모델이 작성한 파일**(심볼 구현, autogen 테스트)에만
  적용됩니다. 사람 소유 파일(`__prologue__`, `__epilogue__`)과 엔진 소유 파일
  (`implementation.ts` 엔트리포인트, `*.ensure.ts` 하네스)은 린트 대상이
  아닙니다 — 확장은 사람의 것이고, 제한은 LLM의 것입니다(00 문서). 특히
  엔트리포인트는 에필로그를 정당하게 import하므로 `no-epilogue-import`의
  대상이 될 수 없습니다.

> **NOTE (캡처 한도와 출력 바운딩의 분리)**: 검증 툴은 서브프로세스를 실행
> 하므로 두 층의 상한이 있습니다. (1) **프로세스 캡처 한도** — 엔진은
> 서브프로세스 출력을 메모리 안전 한도(1MB)까지만 캡처하고, 초과 시
> `[output capture truncated at the in-memory safety limit]`를 덧붙입니다.
> (2) **모델 출력 바운딩** — 캡처된 결과가 모델에게 갈 때 공통 규칙의
> 2,000줄/50KB 경계를 다시 통과합니다. 전자는 OOM 방지, 후자는 컨텍스트 예산
> 관리이며, 서로 다른 층의 문제입니다.

## 대화 툴

### `AskUser`

```typescript
AskUser(questions: ChzAskUserQuestion[]): ChzAskUserAnswer[]
```

산출물의 구조를 바꾸는 결정(에스컬레이션 사다리 2단)을 사람에게 묻습니다.
질문은 자유 문자열 하나가 아니라 **구조화된 스키마**입니다 — 렌더러(CLI, IDE)가
일관된 UI를 만들 수 있고, 질문·선택지의 형태 규칙을 스키마로 강제할 수
있습니다:

```typescript
type ChzAskUserOption = {
  label: string;       // 짧은 표시 텍스트 (1~5 단어)
  description: string; // 이 선택의 의미와 결과
};

type ChzAskUserQuestion = {
  question: string;            // 완결된 질문 문장
  header: string;              // 질문의 요약 라벨. 최대 30자 — 스키마로 검증
  options: ChzAskUserOption[]; // 2개 이상
  multiple?: boolean;          // 복수 선택 허용. 기본 false
};

/** 질문 하나의 답: 선택된 option.label들. 자유 입력이면 그 텍스트 하나 */
type ChzAskUserAnswer = string[];
```

**사용 규칙** (스키마 강제 + 툴 설명 지시):

- 여러 결정이 걸려 있으면 **한 번의 호출에 질문 배열로** 묶습니다. 질문마다
  왕복하면 사람의 주의를 반복해서 끊습니다.
- 추천하는 선택지가 있으면 **첫 번째**에 두고 label 끝에 `(Recommended)`를
  붙입니다.
- "기타"/"Other" 같은 포괄 선택지를 넣지 않습니다 — 자유 입력 창구는 엔진이
  모든 질문에 자동으로 제공합니다.
- 길이 규칙(header ≤ 30자, options ≥ 2)은 설명이 아니라 스키마가 검증합니다.

**답변 반환.** 모델에게는 무엇을 물었고 무엇을 받았는지 라운드트립 형태로
돌아갑니다:

```
User has answered your questions: "{question}"="{label, label}". You can now
continue with the user's answers in mind.
```

응답이 비었으면 리터럴 `Unanswered`가 들어갑니다 — 무응답도 명시적으로
인지시킵니다.

**비대화형 모드.** CI나 스크립트처럼 물어볼 사람이 없는 환경에서는 `AskUser`
호출이 거부되며, 하네스는 질문 요지를 `todo`에 담아 세션을 blocked로 종료해야
합니다('세션의 종료 상태' 절). **질문이 조용히 가정으로 격하되는 일은
없습니다.** (범용 하네스들도 같은 문제를 압니다 — opencode는 비대화형
클라이언트에서 question 툴을 툴 목록에서 아예 제외합니다. 치즈도 비대화형
모드에서는 `AskUser`를 광고 자체에서 뺄 수 있으나, 그 경우에도 "질문했어야 할
상황"은 blocked로 표면화되어야 합니다.)

질문–답변 쌍은 엔진이 `CONTEXTS.md`에 기록합니다('결정 기록' 절).

## 종료 툴

### `Finish`

```typescript
Finish(): void
```

산출물이 완성되었음을 선언하고 세션을 종료합니다. 어디까지나 LLM의
'주장'이며, 엔진의 독립 검증(타입 체크 + 유닛 테스트 + ensure 계약 테스트)이
뒤따릅니다(61 문서).

### `Block`

```typescript
Block(reason: string, todo: string): void
```

사람이 환경을 준비해 줘야 진행할 수 있음을 선언하고 세션을 중단합니다.
`reason`에는 무엇이 부족한지, `todo`에는 사람이 무엇을 하면 재개되는지를
적습니다. `todo`는 사람이 그대로 실행할 수 있을 만큼 구체적이어야 합니다
(예: `` `npm install three` 실행 후 `chz realize` 재실행 ``).

### `Abort`

```typescript
Abort(reason: string): void
```

구현이 불가능함(요구사항 모순, 실현 불가능하거나 부적절한 요구 등)을 선언하고
세션을 포기합니다. **환경이 준비되면 풀리는 중단은 `Abort`가 아니라
`Block`입니다.**

# 실제로는 이렇게 보입니다

```shell
$ chz realize
[1/1] [ChzOpenAIRealizer] realizing MyFunnyGame ...
[1/1] [ChzOpenAIRealizer] read package.json
[1/1] [ChzOpenAIRealizer] 💭 thinking

Question from Realizer (MyFunnyGame) — 디펜던시:
  이 요청은 three.js 디펜던시가 있으면 더 잘 만들 수 있을 것 같아요. 도입할까요?
  > 1. 네, 도입할게요 (Recommended) — 제가 npm install로 설치하고 올게요.
    2. 아니요 — 디펜던시 없이 순수 WebGL로 만들어 주세요. (실패할 수도 있습니다)
    3. 직접 입력...

== BLOCKED ==
MyFunnyGame: three.js 디펜던시가 필요합니다.
  TODO: `npm install three` 실행 후, `chz realize`를 다시 실행해 주세요.
```

1번을 선택한 흐름입니다. `header`("디펜던시")는 질문 라벨로 렌더되고, 추천
선택지가 첫 번째에 `(Recommended)`로 표시되며, 자유 입력(3번)은 엔진이 자동으로
붙인 것입니다. 답변은 `CONTEXTS.md`에 기록되고(다음 절), 설치는 사람의 몫이므로
세션은 blocked로 끝납니다. 2번을 선택했다면 세션은 그 답변을 결정으로 삼아
그대로 구현을 계속합니다.

# 결정 기록 — CONTEXTS.md

`AskUser`의 질문–답변 쌍은 사라지면 안 됩니다. 사용자의 답변은 사실상
requirements의 연장 — 사람이 스펙에 덧붙인 결정 — 이기 때문입니다. 그래서
엔진은 세션이 끝날 때 질문–답변을 realization 디렉토리의 `CONTEXTS.md`에
기록합니다. 한 번의 `AskUser` 호출에 여러 질문이 담겼다면 질문마다 한 항목씩
기록됩니다:

```markdown
<!-- chz/realization/MyFunnyGame/CONTEXTS.md -->

## MyFunnyGame

- **Q**: 이 요청은 three.js 디펜던시가 있으면 더 잘 만들 수 있을 것 같아요.
  도입할까요?
- **A**: 네, 도입할게요 (2026-07-23T12:34:56Z)
```

이 파일은 다음 규칙을 따릅니다:

- **기록은 엔진이 합니다.** provenance 헤더(60 문서)와 같은 이유입니다 — LLM이
  스스로 기록하게 하면 기록의 신뢰성을 보장할 수 없습니다.
- **다음 세션에 자동으로 주입됩니다.** 같은 심볼을 재-realize할 때, 엔진은
  CONTEXTS.md의 내용을 세션 컨텍스트(`context.baseContexts`, 후술)로 전달합니다.
  위 예시라면 재실행된 세션은 같은 질문을 반복하지 않고, three.js를 쓰기로 한
  결정 위에서 구현을 시작합니다.
- **해시에 포함됩니다.** 결정은 스펙의 일부이므로, 재실행
  판정([62 문서](62-realize-dependency-graph.ko.md))에 쓰이는 해시 계산에
  시그니처·requirements·ensure와 함께 들어갑니다.
- **사람이 편집할 수 있습니다.** 이 파일의 내용은 사람의 의도이므로, realize
  산출물과 달리 직접 수정이 허용됩니다. 답변을 고치면 — 예컨대 three.js를
  빼기로 마음을 바꾸면 — 위 규칙에 따라 해당 심볼이 무효화되어 재-realize됩니다.

# 세션의 종료 상태 — blocked와 failed

61 문서에서 세션의 결말은 성공(`resolved: true`) 아니면 실패였습니다. 이
문서의 규칙이 더해지면 결말은 세 갈래가 됩니다:

- **resolved** — 산출물이 완성되었다는 LLM의 '주장'. 엔진의 독립 검증이
  뒤따릅니다(61 문서).
- **blocked** — 사람이 환경을 준비해 주면 재개할 수 있는 '대기'. 검증할
  산출물이 없으므로 검증하지 않고, **캐시에도 아무것도 기록하지 않습니다.**
  엔진은 `todo`를 출력하고 이 심볼과 그 하류의 realize를 중단하되, 사람이
  todo를 수행한 뒤 `chz realize`를 다시 실행하면 그 심볼부터 자동으로
  재시도됩니다.
- **failed** — 스펙을 고치기 전에는 다시 실행해도 소용없는 '실패'(Abort, 턴
  상한 초과, 검증 재시도 소진). 62 문서의 규칙에 따라 하류 심볼의 realize는
  진행되지 않습니다.

blocked와 failed를 나누는 질문은 하나입니다: **"사람이 `.chz.ts`를 고쳐야
하는가?"** 고쳐야 풀리면 failed, 환경만 준비되면 풀리면 blocked입니다.

`AskUser`가 항상 가능한 것은 아닙니다. 비대화형 모드에서의 처리('대화 툴' 절
참조)에 따라, 답을 얻지 못한 질문은 사람 눈에 보이는 blocked 상태로 남습니다.

> **NOTE (향후 최적화)**: 병렬 realize(`-j8`) 중에 여러 세션이 제각기 질문을
> 던지면 사용자 경험이 나빠집니다. 세션을 시작하기 전에 질문만 미리 모아 한
> 번에 묻는 '프리플라이트 패스'를 엔진 쪽 최적화로 추가할 수 있습니다. 이는
> 엔진 내부의 일이므로 Realizer 인터페이스는 바뀌지 않습니다.

# 61 문서의 타입은 이렇게 확장됩니다

이 문서의 규칙을 담기 위한, 61 문서 핵심 타입에 대한 변경분입니다. (61 문서의
본문과 예시 코드는 아직 이 변경을 반영하기 전일 수 있습니다 — 그 경우 이
문서가 더 최신입니다.)

```typescript
/** AskUser 선택지 하나 */
type ChzAskUserOption = {
  label: string;       // 짧은 표시 텍스트 (1~5 단어)
  description: string; // 이 선택의 의미와 결과
};

/** AskUser 질문 하나 */
type ChzAskUserQuestion = {
  question: string;            // 완결된 질문 문장
  header: string;              // 질문의 요약 라벨. 최대 30자 (스키마로 검증)
  options: ChzAskUserOption[]; // 2개 이상
  multiple?: boolean;          // 복수 선택 허용. 기본 false
};

/** 질문 하나의 답: 선택된 option.label들. 자유 입력이면 그 텍스트 하나 */
type ChzAskUserAnswer = string[];

type ChzRealizeContext = {
  // ... 61 문서의 기존 필드 ...

  // CONTEXTS.md의 내용. 이전 세션들에서 사용자에게 받아 둔 결정들입니다
  baseContexts: string;

  /**
   * AskUser 툴의 실제 창구. 엔진(CLI)이 주입하며, 사용자에게 질문들을 보여주고
   * 답변을 받아 돌려줍니다. 비대화형 모드에서는 호출이 항상 거부되며, 이 경우
   * 하네스는 질문 요지를 todo에 담아 세션을 blocked로 종료해야 합니다
   */
  askUser: (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]>;
};

/**
 * 세션의 결말. 'resolved: boolean' 하나였던 61 문서의 타입을 세 갈래의
 * 구별된 유니온(discriminated union)으로 대체합니다.
 */
type ChzImagineSymbolResolution =
  | ChzResolutionResolved
  | ChzResolutionBlocked
  | ChzResolutionFailed;

type ChzResolutionResolved = {
  outcome: 'resolved';
  symbol: ChzImagineSymbol;

  resolvedFile: string;            // 구현이 생성된 파일 경로
  resolvedTestFiles: string[];     // Realizer가 함께 emit한 autogen 유닛 테스트
  assumptionsReport?: string;      // ASSUMPTIONS 리포트 경로 (60 문서)
  resolvedLine?: [number, number]; // 구현이 생성된 라인 범위
  resolvedAt: Date;                // 구현이 생성된 시각
  resolvedBy: string;              // 모델 이름 (claude-opus-4.8, gpt-5-... 등)
};

type ChzResolutionBlocked = {
  outcome: 'blocked';
  symbol: ChzImagineSymbol;

  reason: string; // 무엇이 부족한지 (예: "three.js 디펜던시가 필요합니다")
  todo: string;   // 사람이 무엇을 하면 재개되는지 (예: "npm install three 후 chz realize 재실행")
};

type ChzResolutionFailed = {
  outcome: 'failed';
  symbol: ChzImagineSymbol;

  reason: string; // Abort 사유, 턴 상한 초과, 검증 실패(재시도 소진) 등
};
```
