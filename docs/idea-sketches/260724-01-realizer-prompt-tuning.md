# Realizer 프롬프트 튜닝 실험 — 탐색-우선 습관 억제 (2026-07-24)

간단한 함수 하나를 realize해도 대부분의 모델이 구현 대신 **코드베이스
탐색부터 시작하는 습관**을 프롬프트/하네스 레벨에서 억제해 본 실험
기록입니다. 필드 리포트(260724-00) §6의 sonnet-5 관찰("1턴에 12콜 폭발적
탐색")과 같은 계열의 문제입니다.

- 원칙: docs는 수정하지 않고 코드만 임시 튜닝. 따라서 **현재 코드는
  docs 63/64의 정본과 의도적으로 어긋난 상태**이며, 코드 쪽에 NOTE 주석으로
  표시해 두었습니다.
- 의도적으로 깨둔 테스트 2건 (튜닝 확정 전까지 유지):
  - `src/realize.test.ts:105` — 삭제된 프롬프트 문구("Do not read project
    files merely")의 포함 검사.
  - `src/realize.test.ts:154` — docs/64 정본과의 byte-identical 검사.

## 1. 원인 조사 — 프롬프트 밖 요인이 더 컸음

기존 고정 프롬프트에도 "Do not spend turns surveying the codebase"류의
지시는 이미 있었으나 효과가 부족했음. 모델에게 실제로 전달되는 전체
컨텍스트를 조사한 결과:

- **(A) 세션에 user 턴이 전무.** 대화가 system 2개(고정부 + 베이스라인)로만
  시작해 첫 생성 시점에 user 지시가 하나도 없음 (`base.ts`의 메시지 조립).
  행동 지침이 컨텍스트 최상단 system 산문에 묻혀 있어, "가장 최근 user
  지시"에 강하게 반응하는 모델 특성과 어긋남.
- **(B) 툴 목록이 탐색을 전경화.** ReadFile → ReadDir → Glob → Grep이
  목록 맨 앞(모델은 앞쪽 툴 선호 경향). ReadFile 설명은 탐색 *요령*("prefer
  a large window", "Use Grep for …")만 코칭하고, "언제 쓰지 말아야 하는지"는
  툴 설명에 없었음 — 제약이 결정 지점(툴 선택 순간)에 부재.
- **(C) symbol 블록의 `file` 어트리뷰트.** 내용이 이미 verbatim 전문인데
  경로가 보이면 "일단 그 파일을 열어 주변을 보자"는 반사를 유발. — 미적용.
- **(D) env 블록 첫 줄이 "Project root (read boundary)"** — 읽기를 미묘하게
  전경화. — 미적용.
- **(E) 코드 레벨 소프트 가드** (첫 write 전 outputDir 밖 읽기에 코칭 에러
  반환). 모델 불문 확실하지만 doc 63의 툴 계약과 어긋나는 최후 수단. — 미적용.

## 2. 적용한 조정 3건

### 2.1 고정 프롬프트 강화 (`src/realizer/prompt.ts`)

- `# Your context is pre-assembled` 섹션 신설 (triage 앞): 탐색 습관을
  이름 붙여 정면 부정("the usual opening move — explore the repository —
  does not apply here"), "There is nothing to discover before writing"
  (파일 배치·테스트 네이밍·검증 커맨드는 프롬프트/툴 계약으로 고정임을
  명시), 탐색 툴의 존재 이유를 "구체적 다음 편집을 막는 특정 사실 하나의
  조회"로 한정.
- triage 섹션의 첫 액션 앵커를 "begin the first implementation increment"
  에서 **"your first tool call is a WriteFile — not a read, not a survey,
  not a plan"** 으로 구체화.
- Incremental workflow의 중복 불릿 2개를 새 섹션 참조 1개로 압축.

### 2.2 툴 순서 + 게이트 문구 (`src/realizer/base.ts`)

- 툴 목록 재배치: WriteFile → FindAndReplace → RunTests → RunTypeCheck →
  RunLinter → ReadFile → ReadDir → Glob → Grep → AskUser → Finish/Block/
  Abort. 목록 순서 자체가 "탐색은 예외 경로"라는 신호가 되도록.
- 탐색 툴 4개 설명에 게이트 문구 삽입 — 결정 지점에 제약이 보이도록.
  예: ReadFile "read any other project file only to fetch a specific fact
  that a concrete next edit is blocked on — never to survey the codebase or
  learn conventions." 단 **outputDir 안 자기 산출물 읽기는 명시적으로
  허용** (read-before-write 규칙과의 충돌 방지).
- 스키마/디스패처 동작은 불변. 설명 문자열과 배열 순서만 변경.

### 2.3 kickoff user 메시지 (`prompt.ts` `buildKickoffPrompt()` + `base.ts`)

- 세션 시작 시 system 2개 뒤에 user 턴 1개를 추가. 대화가
  `[system 고정부, system 베이스라인, user kickoff]`가 되어 모델이 마지막에
  보는 것이 직접 지시가 됨.
- 신규 세션: "Realize \`X\` now. … Do not open with ReadFile, ReadDir, Glob,
  or Grep — open with the WriteFile of your first implementation increment."
- 재시도 세션(verification feedback 존재 시)은 앵커를 다르게: 피드백과 자기
  산출물을 먼저 읽고 고치라고 지시 (이때는 읽기가 올바른 첫 행동이므로).
- cycle 세션이면 멤버 이름을 전부 나열. 기존 베이스라인과 중복되던 cycle
  계산은 `cycleMembers()` 헬퍼로 공용화.

## 3. 실측 결과

- 2.2(툴 순서+게이트)만 적용한 상태: **여전히 프로젝트 파일을 읽으려 함.**
  결정 지점 게이트만으로는 부족.
- 2.3(kickoff)까지 적용: **첫 턴에 구현이 수행됨** — 목표 행동 달성.
  user 턴 앵커가 지배적 요인이었던 것으로 보임.
- **신규 문제: 잘못된 디렉토리에 파일을 쓰는 문제가 발생.**

## 4. "잘못된 디렉토리" 가설과 다음 단계

- 유력한 메커니즘: **경로 해석 비대칭이 쓰기에서 표면화된 것.** 시스템
  프롬프트는 `tests/test_<name>.autogen.ts` 같은 outputDir-상대 경로를
  각인시키는데, WriteFile의 상대 경로 해석은 projectRoot 기준
  (src/realizer/tools/filesystem.ts:420; RunTests도 동일 —
  src/realizer/base.ts:624, 필드 리포트 §4.3과 같은 계열).
- 탐색 턴이 사라지면서 **모델이 실제 경로를 관찰로 학습할 기회도 함께
  사라짐** — 기존의 탐색이 사실상 경로 그라운딩 역할을 하고 있었다는 방증.
  탐색 억제 튜닝은 경로 규약을 프롬프트에서 완전하게 공급할 의무를 동반함.
- 후보 대응 (미적용):
  1. kickoff 또는 베이스라인에 기대 산출물의 **구체 경로**를 명시
     (예: `<outputDir>/implementations/<name>.ts`,
     `<outputDir>/tests/test_<name>.autogen.ts` — 절대 경로 예시 포함).
  2. 쓰기·테스트 경로 해석을 outputDir 기준으로 변경 — §4.3의 RunTests
     최초 1회 실패도 동시에 해소되나 docs 63 갱신 필요.
  3. WriteFile 거부/성공 메시지에 올바른 경로 예시를 복구 힌트로 포함.

## 5. 정본화 / 롤백 체크리스트

- 효과 확정 시: docs/64 파트 1 정본과 docs/63 툴 설명·순서에 역반영하고,
  깨진 테스트 2건의 기대 문구를 갱신. kickoff 턴은 docs/64의 세션 구조
  기술([system, system] → [system, system, user])에도 반영 필요.
- 폐기 시: prompt.ts / base.ts의 NOTE 주석과 함께 원상 복구.

## 6. 2라운드 — 리셋 후 약화 버전 재구성과 실측 (같은 날, 후속)

1라운드 변경 전체를 `git reset`으로 되돌린 뒤 다음 조합으로 재구성함:

- **시스템 프롬프트 (약화판).** "Your context is pre-assembled" 섹션을
  권고형 톤으로("rarely need to explore", "not as an opening move"),
  triage에는 "normally starting with a WriteFile rather than a read" 힌트만
  추가. Incremental workflow 불릿은 원문 유지 — 그 결과 의도적으로 깨진
  테스트가 `realize.test.ts:154`(byte-identical) 하나로 줄어듦.
- **kickoff user 턴 (약화 + 경로 그라운딩).** §4 후보 1을 채택해 산출물
  경로를 실제 값으로 명시: `<outputDir>/implementations/<이름>.ts`,
  `<outputDir>/tests/test_<이름>.autogen.ts`. 재시도 세션 변형 유지.
- **툴 재배치 + 게이트 문구.** 1라운드(§2.2)와 동일하게 재적용.

kickoff의 핵심 문장은 사용자가 직접 **중간형**으로 조정함 — 순한 권고
("If you do not need to check … first, start right away")가 아니라
**금지 + 명시적 탈출 조건** 형태:

> Do not open with ReadFile, ReadDir, Glob, or Grep unless realizing \`X\`
> requires a specific fact that the supplied context does not contain.

(초안의 "unless if … cannot be realized without a specific missing fact"는
이중부정이 꼬여 있어 문법만 위와 같이 다듬음. 구조는 동일.)

실측:

- 이 중간형에서 모델이 **빠르게 구현을 시작하는 것으로 관찰됨.** 순한
  권고("확인할 필요가 없으면 바로 시작")보다 금지+조건부 허용이 기본
  행동을 구현-우선으로 뒤집는 데 유효해 보임. 탐색이 정말 필요한 경우의
  경로는 조건절로 열려 있음.
- **잘못된 디렉토리 문제는 해소된 것으로 관찰됨** — §4의 가설(탐색 턴
  제거로 경로 그라운딩 소실)과 부합. 후보 1(경로 명시)로 충분했고 후보
  2(경로 해석 기준 변경)까지는 급하지 않을 수 있음. 단 이는 kickoff가
  경로를 공급해 우회한 것이며, 필드 리포트 §4.3의 경로 해석 비대칭
  자체는 남아 있음.

현재 살아있는 정본과의 어긋남: `realize.test.ts:154`만 의도적으로 깨진
상태. 역반영 대상은 docs/64 고정부(신설 섹션 + triage 힌트)와 세션 구조
([system, system] → kickoff user 턴 추가), docs/63 툴 순서·설명(게이트
문구).

## 7. 3라운드 — 탐색 억제가 드러낸 두 번째 컨텍스트 공백: prologue 타입 재선언

2라운드 조합으로 collision을 realize한 산출물
(`implementations/충돌판정_2D.ts`)에서 새 문제를 발견함: prologue가 이미
export하는 `Point`/`Circle`/`Rectangle`/`Shape`를 import하지 않고 **4개
타입 전부를 산출물 안에 재선언**함.

메커니즘 (§4의 경로 그라운딩과 동일한 패턴의 두 번째 사례):

- 세션 베이스라인에 **prologue가 아예 실리지 않음.** doc 64의 베이스라인
  구성(env → 심볼 스펙 → resolved dependency surfaces → CONTEXTS.md)에서
  dependency surfaces는 imagine 심볼만 다루므로, 시그니처가 참조하는
  사람 소유 타입(`Shape`)의 정의는 어디에도 없음.
- 기존에는 모델이 탐색으로 prologue를 읽고 import했음 — 탐색이 경로에
  이어 **타입 그라운딩**까지 하고 있었던 것. 탐색을 억제하자 모델은
  requirements/ensure에서 타입을 역산해 재선언하는 쪽을 택함.
- 고정 프롬프트의 "Import human-written code **only from**
  `__prologue__`"는 import 출처의 *제한*이지 import하라는 *지시*가 아님
  — 아무것도 import하지 않으면 공허하게 만족됨. 재선언 금지 규칙은
  부재했음.
- 구조적 타이핑 때문에 재선언본도 검증이 green으로 통과함. 이후 사람이
  prologue 타입을 수정해도 산출물은 자기 복사본을 유지 — **검증은 green인
  채 계약만 어긋나는 조용한 드리프트** (§4.7의 의미 드리프트와 같은 부류).

적용한 대응 (1+2):

1. **베이스라인에 "Human-written prologue" 섹션 주입** — 심볼 스펙과
   dependency surfaces 사이. `<outputDir>/implementations/__prologue__.ts`
   가 존재하면 전문을 `<prologue>` 블록으로 포함하고, "제공되는 타입/값은
   `./__prologue__.ts`에서 import하고 재선언하지 말 것"을 머리에 명시.
   파일이 없으면 섹션 생략 (doc 64의 absent-source 규칙과 동일). v0에서는
   전문 포함이며, prologue가 커질 경우의 발췌 전략은 추후 과제.
2. **고정 프롬프트의 prologue 불릿 강화** — "When the prologue already
   provides a type or value your implementation needs, import it from
   `./__prologue__.ts` — never re-declare it in realized code, or the copy
   will silently drift from the human-owned original."

미적용 (후속 후보): **no-prologue-shadowing 린트 규칙** — 산출물이
prologue export와 같은 이름을 재선언하면 검증에서 실패시키는 코드 레벨
강제. `no-epilogue-import`와 대칭이며 모델 불문 확실함. 재선언이 다시
관찰되면 착수.

교훈 (일반화): **탐색 억제 튜닝은 "탐색이 암묵적으로 조달하던 컨텍스트"를
전부 명시 공급으로 전환할 의무를 동반한다.** 지금까지 드러난 것: ① 산출물
경로(§4, kickoff로 해소), ② prologue 타입(§7, 베이스라인 주입으로 해소).
셋째가 나올 수 있음 — 유력 후보는 @profile별 허용 API 목록과 프로젝트
tsconfig 제약.
