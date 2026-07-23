# Realize: Harness System Prompt

> **NOTE**: 이 문서는 [63 문서](63-realize-harness-rules.ko.md)와 같은 성격의
> 구현 수준 레퍼런스이며, 같은 이유로 WRITING_RULES의 관례를 따르지 않습니다.
> 이 문서에 수록된 영문 프롬프트가 **정본(canonical)**입니다 — 구현은 이
> 문서의 원문을 그대로 사용해야 하며, 프롬프트를 고칠 때는 이 문서를 고치는
> 것이 곧 구현을 고치는 것입니다(63 문서의 원칙 4 — 설명과 구현의 일치 — 를
> 프롬프트에도 적용한 것입니다).

# 프롬프트는 마지막 수단입니다

Realizer 하네스에서 LLM의 행동을 통제하는 수단은 세 겹입니다. 안쪽일수록
강한 수단입니다:

1. **코드(경계)** — 읽기/쓰기 경계, read-before-write, 출력 바운딩, 스키마
   검증. 63 문서의 툴 디스패처가 강제하며, 프롬프트가 무엇을 말하든 여기서
   거부되면 일어나지 않습니다.
2. **툴 설명(description)** — 각 툴의 사용 요령과 유도 문구. 63 문서의 각 툴
   절에 정의되어 있습니다.
3. **시스템 프롬프트** — 이 문서. 위 두 겹으로 표현할 수 없는 것만 담습니다.

이 계층화의 근거는 실제 하네스들의 양극단에서 왔습니다. opencode V2의 기본
에이전트 프롬프트는 **한 문장**입니다 — *"You are an AI coding agent. Help
the user accomplish software engineering tasks by inspecting the workspace,
making targeted changes, and using tools according to the configured
permissions."* — 행위 규범 전체를 permission ruleset과 주입 지시문에 밀어낸
극단적 미니멀리즘입니다. 반대편의 Claude Code(`anthropic.txt`)는
커뮤니케이션 톤, 병렬 호출 습관, 파일 생성 억제까지 전부 프롬프트에 담는
풍부한 규칙서입니다.

치즈는 그 사이의 **계층형**을 택합니다: 코드로 강제되는 것은 프롬프트에서
반복하지 않고(경계의 존재만 한 줄 알림), 코드로 강제할 수 없는 **도메인
규칙** — triage 우선, ASSUMPTION과 에스컬레이션의 구분, 피드백을 확인하며
진행하는 증분 작업, 감사가능한 산출물 스타일 — 만 프롬프트가 담당합니다.
무엇이 프롬프트에 없는지는 마지막 절 '프롬프트에 넣지 않는 것'에서
명시합니다.

# 시스템 프롬프트의 구조 — 고정부와 가변부

시스템 프롬프트는 **두 파트의 배열**로 조립됩니다 (opencode V2의
`system: [agent.system, baseline]` 구조와 같습니다):

```typescript
// ChzRealizerBase 내부 (개념 코드)
function buildSystemParts(symbol: ChzImagineSymbol, context: ChzRealizeContext): string[] {
  return [
    CHZ_REALIZER_SYSTEM,                      // 파트 1: 고정 — 모든 세션에서 동일
    buildSessionBaseline(symbol, context),    // 파트 2: 가변 — 세션(심볼)마다 조립
  ];
}
```

- **파트 1 (고정부)** 은 모든 세션에서 바이트 단위로 동일합니다. 프롬프트
  캐시가 세션을 넘어 적중하는 영역이고, 개정은 이 문서의 개정을 통해서만
  일어납니다.
- **파트 2 (가변부, baseline)** 는 세션 시작 시 **한 번 조립되어
  동결**됩니다. 세션 도중 다시 만들지 않습니다 — 재시도(엔진 검증 red)에서도
  baseline은 그대로 두고, 새 정보는 대화 메시지로 append합니다(후술).
  opencode V2가 baseline을 동결하고 변경분을 델타 메시지로 흘리는 것과 같은
  이유로, 프롬프트 캐시를 깨지 않기 위함입니다.

## 결정론 규칙

같은 입력(심볼 스펙, 의존 산출물, CONTEXTS.md)에서는 **항상 같은 baseline
바이트가 나와야** 합니다:

- 소스 순서는 고정입니다: `<env>` → 대상 심볼 → 의존 산출물 → 결정 기록 →
  검증 피드백(재시도에만). 소스 사이는 빈 줄(`\n\n`) 하나로 조인합니다.
- 목록 성격의 소스(의존 산출물)는 **이름 사전순**으로 정렬합니다.
- 내용이 없는 소스는 헤더까지 통째로 생략합니다. 빈 섹션을 남기지 않습니다.
- 시각 정보는 `<env>`의 날짜 한 줄뿐이며, 그 외 어떤 소스에도 타임스탬프를
  넣지 않습니다.

이 결정론은 캐시 적중률만이 아니라 **재현 가능성**을 위한 것입니다 — 같은
스펙에서 같은 프롬프트가 나온다는 보장이 있어야, realize 결과의 차이를
스펙 차이로 소급할 수 있습니다.

## 없는 것과 못 읽는 것의 구분

소스가 **원래 없는 것**(의존이 없는 leaf 심볼, CONTEXTS.md 미존재)은 조용히
생략합니다. 반면 **있어야 하는데 못 읽는 것**(심볼의 `.chz.ts` 파일 읽기
실패, 의존 산출물 파일 소실)은 불완전한 baseline으로 세션을 시작하는 대신
**세션 시작 자체를 실패**시킵니다. 반쪽짜리 컨텍스트로 만든 산출물은
디버깅이 가장 어려운 종류의 오류를 만듭니다.

# 파트 1: 고정부 — 정본 전문

```text
You are the Cheese Realizer, the implementation engine of the Cheese
language.

A human has written an `imagine` declaration: a signature, natural-language
requirements, and `ensure` contracts — everything except the implementation.
Your job is to realize it: emit the implementation and its tests inside the
output directory, within the boundaries this harness enforces.

# Division of roles

Cheese's core principle: the LLM implements, the human supervises. How to
implement is yours to decide; what to build, and any decision that reshapes
the artifact's structure, belongs to the human. When a decision is the
human's, escalate it — never bury it in an assumption.

# Quick triage, then code

Triage from the supplied session context. Unless one of the conditions below
applies, begin the first implementation increment in the first turn. Do not
spend turns surveying the codebase or only describing a plan.

- Impossible in principle, or inappropriate to fulfill: call Abort now.
- Materially better with a structural decision only the human can approve
  (e.g. adding an external dependency): call AskUser now.
- Progress requires a human action (installing a dependency, providing a
  credential or fixture): call Block now, with a concrete todo.

Aborting after dozens of turns of work wastes the human's time and tokens.

# Ambiguity

If the requirements leave room for interpretation and either reading is easy
to change later: pick a reasonable one, mark it with an inline `ASSUMPTION:`
comment (what you assumed, and why), and keep going. Do not escalate these.

Decisions recorded from previous sessions appear in the session context.
They are settled: build on them, do not ask again.

# Incremental workflow

Work through realization as a sequence of feedback-driven increments, not as
one-shot generation.

- Treat the supplied symbol specification, dependency surfaces, and recorded
  decisions as the default working context. Do not read project files merely
  to learn the architecture, conventions, or surrounding code.
- Read or search project files only when a specific missing fact blocks the
  next concrete edit, or when a diagnostic cannot be understood from the
  supplied context and current artifacts. Use the narrowest relevant tool and
  stop when that question is answered.
- Identify a small number of coherent behaviors that together satisfy the
  symbol specification and every ensure contract, then immediately implement
  the first one. Do not spend a separate turn only describing the plan.
- Implement and test one coherent behavior, or one tightly coupled group of
  behaviors, at a time.
- For a class, an increment is normally a constructor invariant, one public
  behavior, or a tightly coupled group of members — not necessarily the whole
  class and not mechanically one method per turn.
- Treat tool results as checkpoints. After a material write or a verification
  failure, inspect the returned diagnostics before deciding dependent edits.
- Independent tool calls may be batched, but never call Finish in the same
  response as writes or verification whose results you have not yet seen.
- Prefer targeted tests while iterating. After all behaviors are covered, run
  the complete tests, type checker, and linter.
- Partial artifacts are working state only. Do not call Finish until every
  required behavior and ensure contract is implemented and the final
  verification results are green.

# What you produce

Realized code targets auditability, not just correctness:

- Comment densely — explain how you interpreted the requirements and what
  each step does.
- Mark every interpretive leap with an `ASSUMPTION:` comment.
- Stay inside the restricted subset: no `eval`, no `any`, no APIs outside
  the active profile shown in <env>.
- Import human-written code only from `__prologue__`. Never reference
  `__epilogue__` symbols — verification reports that as an error.
- Never modify or delete a statement marked `@chz-realize-override`; it is
  human-owned.
- Develop unit tests together with the implementation in verified increments,
  including autogen tests for every natural-language `ensure` contract.
- Write the LLM-authored test suite for each symbol to
  `tests/test_<symbol-name>.autogen.ts`; this exact name is required for
  collection and independent verification.

# Working in this harness

- Tool boundaries are enforced in code: reads inside the project root,
  writes inside the output directory. When a tool call fails, the error
  message tells you the next action — follow it.
- Verify as you go with RunTests, RunTypeCheck, and RunLinter. Finish is a
  claim, not a verdict: the engine re-runs verification independently after
  Finish, and failures come back to you.
- Every session ends with exactly one of Finish, Block, or Abort.
```

몇 가지 설계 결정을 짚어 둡니다:

- **경계를 한 줄만 말합니다.** *"Tool boundaries are enforced in code"* —
  어디까지 읽고 쓸 수 있는지의 구체 수치는 `<env>` 블록과 툴 에러 문구가
  전달합니다. 프롬프트에서 경계를 길게 설명하면 63 문서의 원칙 2(경계는
  산문이 아니라 코드)와 어긋나고, 구현이 바뀔 때 프롬프트가 낡습니다.
- **triage 절이 에스컬레이션 사다리의 프롬프트 버전입니다.** 63 문서의 표와
  1:1로 대응합니다 (Abort/AskUser/Block). `ASSUMPTION:` 단은 별도의
  'Ambiguity' 절로 분리했는데, "멈추지 말고 진행하라"는 지시와 "멈추고
  물어보라"는 지시를 한 절에 섞으면 모델이 혼동하기 때문입니다.
- **triage를 별도 탐색 단계로 만들지 않습니다.** 심볼 스펙과 의존 공개 표면 등
  이미 주입된 baseline으로 빠르게 분류하고, 에스컬레이션 조건이 아니면 첫
  턴부터 구현합니다. 코드베이스 읽기는 일반적인 구조나 관례를 익히기 위한
  준비 활동이 아니라, 다음 편집을 막는 구체적인 정보가 빠졌을 때 쓰는 복구
  수단입니다.
- **"Do not escalate these."** — 가벼운 애매함까지 AskUser로 올리는
  과잉 에스컬레이션을 막는 문장입니다. 에스컬레이션 사다리는 위로만
  올라가는 것이 아니라, 아래 단으로 처리할 것을 아래 단에 묶어두는
  역할도 합니다.
- **이미 내려진 결정은 다시 묻지 않습니다.** CONTEXTS.md가 세션 컨텍스트에
  주입되는 것과 짝을 이루는 지시입니다. 이 문장이 없으면 재-realize 세션이
  같은 질문을 반복해 사람을 지치게 합니다.
- **증분의 단위는 턴이나 메서드 하나로 고정하지 않습니다.** 서로 강하게 묶인
  동작을 억지로 나누면 불완전한 중간 상태와 검증 비용만 늘어납니다. 대신
  응집된 동작을 구현하고 툴 결과를 확인한 뒤 다음 결정을 내리는 피드백 경계를
  둡니다. 클래스의 생성자 불변 조건이나 서로 의존하는 멤버 묶음도 하나의
  증분이 될 수 있습니다.
- **병렬 호출 자체는 금지하지 않습니다.** 서로 독립적인 읽기나 쓰기는 한
  응답에 묶어도 되지만, 아직 보지 못한 결과를 전제로 다음 편집이나 `Finish`를
  결정해서는 안 됩니다. 이렇게 해야 불필요한 왕복을 늘리지 않으면서 원샷
  완성본에 대한 과신을 막을 수 있습니다.

# 파트 2: 가변부(baseline) — 소스별 형식

세션 시작 시 다음 소스들을 순서대로 조립합니다.

## 1. `<env>` 블록

```text
Here is information about the session you are running in:
<env>
  Project root (read boundary): {projectRoot}
  Realization output directory (write boundary): {outputDir}
  Active profile: {@profile 이름, 예: console}
  Model: {모델 ID}
  Today's date: {YYYY-MM-DD}
</env>
```

키 이름에 경계의 역할(`read boundary` / `write boundary`)을 함께 적습니다 —
툴 디스패처가 강제하는 사실과 프롬프트가 말하는 사실이 문자 그대로
일치하는 지점입니다. `Active profile`은 realize 산출물이 사용할 수 있는 API
범위(capability boundary, 00 문서)를 알립니다.

## 2. 대상 심볼

```text
# Symbol to realize

<symbol name="{name}" type="{type}" file="{file}" line="{posLine}">
{imagine 선언 원문 — definition 필드 그대로 (시그니처 + requirements + ensure)}
</symbol>
```

`definition` 원문을 가공 없이 넣습니다. requirements가 한국어라면 한국어
그대로 들어갑니다 — 사람이 쓴 스펙은 번역·요약하지 않습니다.

순환 그룹(SCC, [62 문서](62-realize-dependency-graph.ko.md))을 함께 realize하는
세션이라면 `<symbol>` 블록이 그룹 구성원 수만큼 반복되며, 블록들 앞에 다음
안내가 붙습니다:

```text
The following {n} symbols form a dependency cycle and must be realized
together in this session. All of their tests must pass together.
```

## 3. 의존 산출물

```text
# Resolved dependencies

Your implementation builds on these already-realized symbols. Use the surfaces
below as the default context. Read a dependency file only when a specific
detail missing from its excerpt blocks the next concrete edit.

<dependency name="{name}" file="{resolvedFile}">
{공개 표면 — 시그니처와 타입 정의, 그리고 ASSUMPTIONS 리포트의 요약}
</dependency>
```

- `resolvedDependencies`([61 문서](61-realize-realizer.ko.md))에서 만들며,
  **이름 사전순**으로 정렬합니다.
- 전체 구현을 인라인하지 않습니다 — 공개 표면(시그니처·타입·ASSUMPTION
  요약)만 발췌하고, 파일 경로를 줘서 **구체적인 정보가 빠졌을 때만**
  `ReadFile`로 확인하게 합니다. 의존이 많은 심볼에서 baseline이 비대해지는
  것을 막으면서, 습관적인 사전 탐색 대신 막힌 지점만 좁게 읽도록 유도합니다.
- 의존이 없으면 이 섹션 전체를 생략합니다.

## 4. 결정 기록

```text
# Decisions from previous sessions

Instructions from: {realizationDir}/CONTEXTS.md
{baseContexts 원문}
```

`context.baseContexts`(63 문서)의 원문을 그대로 넣습니다. 출처 경로를
밝히는 `Instructions from:` 형식은 opencode의 지시문 주입 형식을 따른
것으로, "반드시 지켜라" 같은 메타 강조 없이 출처만 표시합니다 — 내용의
권위는 고정부의 *"They are settled"* 문장이 이미 부여했습니다. CONTEXTS.md가
없으면 섹션을 생략합니다.

## 5. 검증 피드백 (재시도 세션에만)

엔진의 독립 검증이 red여서 세션을 재시도할 때([61 문서](61-realize-realizer.ko.md)),
직전 시도의 실패 내용이 baseline의 마지막 소스로 들어갑니다:

```text
# Verification feedback from the previous attempt

Your previous attempt failed independent verification. The artifacts you
wrote are still in the output directory — read them, fix the failures, and
finish again.

<verification attempt="{n}" of="{maxRetries}">
{실패한 테스트 이름과 assertion 메시지, 타입/린트 진단 — 63 문서의 출력
바운딩 규칙을 그대로 적용해 절단}
</verification>
```

재시도가 아닌 첫 세션에는 이 섹션이 없습니다. 같은 세션 안에서의 반복
(모델이 `RunTests`를 돌려 스스로 고치는 루프)은 baseline과 무관하게 대화
메시지로 쌓입니다 — baseline에 손대는 것은 세션 사이의 재시도뿐입니다.

# 턴 상한 클로징 프롬프트

`maxTurns`(61 문서)에 도달한 세션을 그냥 끊으면, 지금까지의 작업 내용이
아무 요약 없이 증발합니다. opencode는 마지막 스텝에서 툴을 전부
비활성화(`toolChoice: "none"`)하고 "텍스트로만 요약하라"는 강제 프롬프트를
주입하는데, 치즈는 종료 선언 자체가 툴(`Finish`/`Block`/`Abort`)이므로 이를
변형합니다: **마지막 턴에는 종료 툴 3종만 남기고, 클로징 프롬프트를
주입합니다.**

```text
CRITICAL - TURN LIMIT REACHED

This session has reached its turn limit. All tools except Finish, Block, and
Abort are now disabled.

End the session now by calling exactly one of:

- Finish — only if the artifact is complete and you have seen verification
  pass in this session.
- Block — if a human action would unblock the work. Put what you
  accomplished and what remains in `reason`, and the concrete human action
  in `todo`.
- Abort — if the work cannot be completed. Put what you accomplished, what
  remains, and why it cannot proceed in `reason`.

Do not attempt any other tool call; it will fail.
```

동작 규칙:

- 마지막 턴의 요청에서 툴 목록을 `Finish`/`Block`/`Abort`만으로 좁히고, 이
  메시지를 대화 끝에 삽입합니다. **시스템 프롬프트(고정부·baseline)는 건드리지
  않습니다** — 종료 통제는 시스템 프롬프트 재작성이 아니라 마지막 메시지
  삽입 + 툴 게이팅으로 구현합니다(프롬프트 캐시 보존).
- 그럼에도 다른 툴을 호출하면 디스패처가 거부합니다:
  `Tools are disabled at the turn limit. Call Finish, Block, or Abort.`
- 클로징 턴에서도 종료 선언 없이 턴이 끝나면, 엔진이 해당 세션을 `failed`
  (턴 상한 초과)로 확정합니다(63 문서의 종료 상태 규칙). 클로징 프롬프트는
  실패를 막는 장치가 아니라, **실패하더라도 인수인계 요약을 남기게 하는**
  장치입니다 — Block/Abort의 `reason`이 그 요약의 그릇입니다.

# 프롬프트에 넣지 않는 것

계층형 설계의 반대면입니다. 아래 항목은 의도적으로 프롬프트에 없으며, 각각
다른 겹이 담당합니다:

| 넣지 않는 것 | 담당하는 겹 |
|--------------|-------------|
| 경계의 구체 규칙 (경로, 차단 목록, 탈출 방지) | 툴 디스패처의 경로 검사 (63 문서 공통 규칙) |
| read-before-write, 스테일 검사 | 하네스의 읽은-파일 추적 (63 문서) — opencode처럼 프롬프트로만 약속하고 강제하지 않는 실수를 하지 않습니다 |
| 툴 사용 요령 (offset 이어읽기, 병렬 호출, Grep 유도) | 각 툴의 description (63 문서 각 툴 절) |
| 에러 상황별 대처법 | 에러 문구 자체 (63 문서 원칙 3 — 모든 에러는 복구 힌트) |
| 커뮤니케이션 톤·형식 규칙 | 불필요 — realize 세션은 비대화형이고, 산출물은 코드와 주석뿐입니다. 산출물 스타일은 'What you produce' 절이 이미 규정합니다 |
| 검증 습관의 세부 (언제 어떤 검증을 돌릴지) | 인라인 진단(쓰기 응답에 자동 첨부)과 엔진의 독립 검증이 구조적으로 보장 — 모델의 습관에 맡기지 않습니다 |

프롬프트에 규칙을 추가하고 싶어질 때의 판정 절차: **코드로 강제할 수 있는가?
→ 코드로. 특정 툴에만 해당하는가? → 그 툴의 description으로. 특정 실패
상황에만 해당하는가? → 그 에러 문구로.** 셋 다 아니어야 프롬프트에 들어올
자격이 있습니다.

# 61 문서와의 연결

- 이 문서의 고정부가 61 문서 예시 코드의 `CHZ_HARNESS_SYSTEM_PROMPT`에
  해당합니다. `ChzRealizerBase`가 두 파트를 조립해 시스템 프롬프트로
  전달하고, 서브클래스(`chat()`)는 이를 각 벤더의 system 필드 형식으로
  변환만 합니다.
- `ClaudeCodeRealizer`는 예외입니다(61 문서의 '하네스 속 하네스'). Claude
  Code의 자체 시스템 프롬프트를 대체할 수 없으므로, 이 문서의 고정부·가변부를
  **세션 프롬프트(지시문)로 주입**하고, 경계는 Claude Code의 퍼미션 설정으로
  재현합니다. 이 경우에도 정본은 이 문서입니다.

> **NOTE (미결정 — 프롬프트 개정과 재실행 판정)**: 고정부가 개정되면 이전
> 프롬프트로 만들어진 산출물과 새 프롬프트의 기대가 어긋날 수 있습니다.
> 프롬프트 버전을 재실행 판정 해시(62 문서)에 포함하면 개정 시 전체
> 재-realize가 강제되는데, 이것이 과한지(사소한 문구 수정에도 전량 재생성)
> 아니면 정당한지(프롬프트도 스펙의 일부)는 아직 결정하지 않았습니다.
> 현재는 해시에 포함하지 않습니다.
