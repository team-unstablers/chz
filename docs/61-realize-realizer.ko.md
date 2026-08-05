# Realize: Realizer

# 'Realizer'

Realizer는 LLM과 상호작용하며 imagine 선언에 대한 구현을 생성하는 어댑터이자 하네스입니다.

# Realizer의 역할

- Realizer는 LLM에게 코드베이스 및 주변 코드의 맥락을 제공하고, imagine 선언에 대한 구현을 생성하도록 요청합니다.
- Realizer는 LLM에게 하네스 역할을 수행합니다.
  - LLM이 imagine 선언을 구현할 때 필요한 정보(예: 타입 정의, 요구사항, 계약 등)를 온-디맨드로 제공합니다.
    - `ReadFile`, `ReadDir` 등과 같은 API를 통해, LLM은 현재 프로젝트의 코드베이스와 주변 코드에 대한 정보를 읽을 수 있습니다.
  - 하지만, 구현에 필요하지 않은 전혀 관련 없는 정보 (사용자 홈 디렉토리의 파일, 시스템 환경 변수, `.env` 등)은 제공하지 않으며 읽을 수 없도록 막습니다.
  - 또한, 스코프 외의 코드를 수정하거나 삭제하지 못하도록 제한합니다.

# 현재 제공 중인 / 제공 예정인 Realizer

| 이름                   | 설명                                                                                                                             | 생성 가능한 리소스 | 구현 여부 |
|----------------------|--------------------------------------------------------------------------------------------------------------------------------|------------|------|
| `ChzRealizerBase`    | 베이스 Realizer. <br /> 기본 하네스로의 룰만 정의되어 있으며, LLM과 상호작용할 수 있는 기능은 없습니다.                                                           | 코드, 이미지    | 구현됨 |
| `ChzOpenAIRealizer`  | OpenAI (또는 Compatible API)를 사용하는 LLM과 상호작용할 수 있는 Realizer. <br /> `ChzRealizerBase`를 상속하며, OpenAI API를 통해 imagine 선언에 대한 구현을 생성합니다. | 코드, 이미지    | 구현됨 |
| `ClaudeCodeRealizer` | Claude Code를 하네스로써 사용합니다. <br /> **비대화형 세션을 여는 것이므로 정액 요금제를 쓰더라도 사용량을 소모합니다!**                                                            | 코드   | 구현됨 |
| `ComfyRealizer`      | ComfyUI 워크플로우를 API로써 호출하여 이미지/비디오/오디오 리소스를 생성합니다.                                                                              | 이미지, 비디오, 오디오 | 구현 중 |


# `chz realize`의 실제 구현 (간략화 버전) / 직접 Realizer를 구현하는 방법

Realizer는 작은 인터페이스 하나로 정의됩니다. `chz realize` 엔진은 의존성
그래프([62 문서](62-realize-dependency-graph.ko.md))가 정한 순서대로 심볼을 꺼내, 그 심볼을 처리할 수 있는 Realizer의
`realize()`를 호출할 뿐입니다. 따라서 이 인터페이스만 구현하면 누구나 자신의
Realizer를 만들어 끼울 수 있습니다.

## 핵심 타입

```typescript
type ChzImagineSymbolType = 'variable' | 'function' | 'class' | 'resource' | 'module';

type ChzImagineSymbol = {
  name: string;
  type: ChzImagineSymbolType;

  definition: string; // imagine 선언의 원문 (requirements, ensure 포함)
  file: string;
  posLine: number;
  posCol: number;

  dependencies: ChzImagineSymbol[];         // 이 선언이 의존하는 다른 imagine 선언들 (62 문서)
  circularDependencies: ChzImagineSymbol[]; // 이 선언과 같은 순환 그룹(SCC)에 속한 선언들.
                                            // 비어 있지 않다면, 그룹 전체가 한 세션에서 함께 realize됩니다 (62 문서)
};

/** 세션에 주어지는 주변 정보. 엔진이 구성하여 Realizer에 전달합니다. */
type ChzRealizeContext = {
  projectRoot: string;   // 읽기 허용 범위의 최상단
  outputDir: string;     // 산출물이 쓰여야 하는 위치이자, 유일한 쓰기 허용 범위
  activeProfile: string; // 이 세션에 적용되는 @profile 이름

  /** 이번 세션이 책임지는 심볼들. 검증의 판정 범위가 됩니다 (후술) */
  scope?: ChzRealizationScope;

  /** 이미 realize된 의존 심볼들의 산출물. LLM이 읽고 그 위에 구현을 쌓습니다 (62 문서) */
  resolvedDependencies: ChzResolutionResolved[];

  maxTurns: number;   // 에이전틱 루프의 턴 상한
  maxRetries: number; // 검증 실패 시 재시도 상한

  baseContexts: string; // 지난 세션에서 사람이 답해 준 결정들 (CONTEXTS.md, 63 문서)
  askUser?: (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]>;

  attempt?: number;              // 재시도라면 몇 번째인지
  verificationFeedback?: string; // 직전 시도가 검증에서 red였다면 그 로그
  now?: () => Date;              // 프롬프트·기록의 시각을 고정하기 위한 주입 지점
  harness?: ChzHarnessServices;  // 엔진이 소유한 검증 실행기와 관찰 이벤트 수신자
};

/**
 * 세션의 결말은 셋 중 하나입니다. `outcome`을 먼저 보고 나머지 필드를 읽는
 * 형태라서, 실패한 세션에서 산출물 경로를 꺼내려다 undefined를 만나는 일이
 * 생기지 않습니다. 세 결말의 의미는 63 문서에서 정합니다.
 */
type ChzImagineSymbolResolution =
  | ChzResolutionResolved
  | ChzResolutionBlocked
  | ChzResolutionFailed;

type ChzResolutionResolved = {
  outcome: "resolved";
  symbol: ChzImagineSymbol;

  resolvedFile: string;            // 구현이 생성된 파일 경로
  resolvedTestFiles: string[];     // Realizer가 함께 emit한 autogen 유닛 테스트
  assumptionsReport?: string;      // ASSUMPTIONS 리포트 경로 (60 문서)
  resolvedLine?: [number, number]; // 구현이 생성된 라인 범위
  resolvedAt: Date;                // 구현이 생성된 시각
  resolvedBy: string;              // 모델 이름 (claude-opus-4.8, gpt-5-... 등)
};

/** 사람이 환경을 준비해 주면 풀립니다. 캐시에는 아무것도 남기지 않습니다. */
type ChzResolutionBlocked = {
  outcome: "blocked";
  symbol: ChzImagineSymbol;
  reason: string; // 무엇이 부족한지
  todo: string;   // 사람이 그대로 실행할 수 있는 조치
};

/** 사람이 `.chz.ts`를 고쳐야 풀립니다. Abort, 턴 상한 초과, 검증 실패 등. */
type ChzResolutionFailed = {
  outcome: "failed";
  symbol: ChzImagineSymbol;
  reason: string;
};

interface ChzRealizer {
  readonly name: string;
  readonly supportedSymbolTypes: readonly ChzImagineSymbolType[];

  realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution>;
}
```

## 예시 1: 원샷 Realizer

가장 단순한 형태입니다. 프롬프트 하나를 보내고, 응답을 그대로 산출물로 저장합니다.

```typescript
import OpenAI from 'openai';

/// 에이전틱 루프 없이 원샷으로 모든걸 해보이겠어!
class ChzExampleOpenAIOneShotRealizer implements ChzRealizer {
  readonly name = 'ChzExampleOpenAIOneShotRealizer';
  readonly supportedSymbolTypes: ChzImagineSymbolType[] = ['function', 'class', 'variable'];

  constructor(private openai: OpenAI) {}

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    // 원샷에는 온-디맨드 탐색이 없으므로, 필요한 모든 맥락(선언 원문,
    // 의존 산출물의 타입 정의 등)을 프롬프트에 미리 담아야 합니다.
    const prompt = this.buildPrompt(symbol, context);

    const response = await this.openai.chat.completions.create({
      model: 'gpt-oss-20b',
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: prompt },
      ],
    });

    const implementation = response.choices[0].message?.content ?? '';

    // 구현을 outputDir에 저장하고, resolution을 반환합니다.
    const resolvedFile = this.saveImplementationToFile(symbol, context, implementation);

    return {
      symbol,
      outcome: 'resolved',
      resolvedFile,
      resolvedLine: [1, implementation.split('\n').length],
      resolvedAt: new Date(),
      resolvedBy: 'gpt-oss-20b',
    };
  }
}
```

원샷 방식은 구현이 간단하지만 두 가지 근본적인 한계가 있습니다:

1. **맥락을 스스로 탐색할 수 없습니다.** 세션 도중 `ReadFile`로 주변 코드를
   확인할 수 없으므로, 프롬프트를 만드는 쪽(사람)이 필요한 맥락을 전부 예측해서
   넣어야 합니다.
2. **스스로 검증할 수 없습니다.** 생성한 코드가 컴파일되는지, 테스트가 통과하는지
   세션 안에서 확인할 방법이 없습니다. 틀렸다면 엔진 측 검증(후술)에서 실패한 뒤
   세션 전체를 처음부터 재시도하는 수밖에 없습니다.

의존이 없고 스펙이 짧은 leaf 심볼에는 이 정도로도 충분할 수 있습니다.

## 예시 2: 에이전틱 Realizer

Realizer가 '하네스'라고 불리는 이유가 이 형태입니다. LLM에게 툴 목록을 주고,
LLM이 툴을 호출하면 하네스가 대신 실행해 결과를 돌려주는 루프를 돕니다.

```typescript
class ChzExampleOpenAIAgenticRealizer implements ChzRealizer {
  readonly name = 'ChzExampleOpenAIAgenticRealizer';
  readonly supportedSymbolTypes: ChzImagineSymbolType[] = ['function', 'class', 'variable'];

  constructor(private openai: OpenAI) {}

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: CHZ_HARNESS_SYSTEM_PROMPT }, // 하네스 시스템 프롬프트: 64 문서 참조
      { role: 'user', content: this.buildPrompt(symbol, context) },
    ];

    let done: { ok: boolean; reason?: string } | null = null;

    for (let turn = 0; turn < context.maxTurns && !done; turn++) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-oss-20b',
        messages,
        tools: CHZ_HARNESS_TOOLS, // ReadFile, WriteFile, RunTests, Finish, ... (63 문서 참조)
      });

      const message = response.choices[0].message;
      messages.push(message);

      // 툴 호출이 없는 턴은 종료 선언도 작업도 아니므로, 다음 행동을 요구합니다.
      if (!message.tool_calls?.length) {
        messages.push({
          role: 'user',
          content: '툴을 호출하여 작업을 계속하거나, Finish/Abort로 종료를 선언하십시오.',
        });
        continue;
      }

      for (const call of message.tool_calls) {
        // 경계 검사와 실제 실행은 전부 하네스(이 코드)의 소관입니다.
        // LLM이 무엇을 요청하든, 여기서 거부하면 일어나지 않습니다.
        const result = await this.dispatchTool(call, context);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });

        if (result.kind === 'finish') done = { ok: true };
        if (result.kind === 'abort') done = { ok: false, reason: result.reason };
      }
    }

    if (!done?.ok) {
      return {
        symbol,
        outcome: 'failed',
        reason: done?.reason ?? `턴 상한(${context.maxTurns}) 초과`,
      };
    }

    return {
      symbol,
      outcome: 'resolved',
      // resolvedFile 등은 dispatchTool이 기록해 둔 WriteFile 내역으로 채웁니다.
      ...this.collectArtifacts(context),
      resolvedAt: new Date(),
      resolvedBy: 'gpt-oss-20b',
    };
  }
}
```

### 그런데, 재시도나 예외 처리는 각 Realizer의 책임인가요?

아니요. 위 예시를 그대로 벤더 수만큼 복제하면 그렇게 되어버리지만, 잘 보면 이
루프에서 LLM 벤더에 따라 달라지는 부분은 사실상 `chat.completions.create` 호출
한 줄뿐입니다. 그래서 실제 구현에서는 **루프, 툴 디스패치, 경계 검사, 턴 상한,
API 재시도를 전부 `ChzRealizerBase`가 공통으로 소유**하고, 서브클래스는 전송
계층만 구현합니다:

```typescript
abstract class ChzRealizerBase implements ChzRealizer {
  // 에이전틱 루프 전체(위 예시의 완성판)를 공통 구현으로 제공합니다.
  async realize(symbol: ChzImagineSymbol, context: ChzRealizeContext) { /* ... */ }

  // 서브클래스가 구현하는 것은 '메시지를 보내고 응답을 받는' 전송 계층뿐입니다.
  protected abstract chat(
    messages: ChzChatMessage[],
    tools: ChzToolDefinition[],
  ): Promise<ChzChatResponse>;
}
```

- `ChzOpenAIRealizer`는 `chat()`을 OpenAI SDK로 구현한 것입니다.
- `ClaudeCodeRealizer`는 예외적으로 이 루프를 사용하지 않습니다. Claude Code
  자체가 이미 에이전틱 하네스이므로 루프를 통째로 위임합니다. 말하자면
  '하네스 속의 하네스'입니다.

### 루프만 넘기고, 툴은 넘기지 않습니다

Claude Code에게도 파일을 읽고 쓰는 자기 툴이 있습니다. 그것을 쓰면 편할 것
같지만, 치즈는 그 툴을 **전부 꺼 버리고** 위에서 정한 하네스 툴 13종을 대신
꽂아 줍니다. 넘기는 것은 '누가 다음에 무엇을 할지 정하는 루프'뿐이고, '무엇을
할 수 있는지'는 여전히 치즈가 정합니다.

이유는 셋입니다.

- **경계는 산문이 아니라 코드입니다.** 읽기는 프로젝트 루트, 쓰기는 출력
  디렉토리라는 규칙을 남의 툴에 설정으로 부탁하는 것과, 우리 디스패처가 직접
  거부하는 것은 다릅니다. 후자만이 [63 문서](63-realize-harness-rules.ko.md)가
  요구하는 보증입니다. 편집 전 읽기 강제, 그 사이 파일이 바뀌었는지 검사, 출력
  길이 제한, 쓰기 직후 진단 첨부, 검색 결과에서 비밀 파일 걸러내기 — 이것들은
  설정으로 표현할 수 있는 종류의 것이 아닙니다.
- **셸이 없어야 합니다.** Claude Code의 툴에는 셸이 포함되어 있고, 셸 하나면
  파일시스템·프로세스·네트워크 권한이 통째로 넘어갑니다. 63 문서가 피하려고
  한 바로 그 표면입니다. 테스트와 타입 체크는 셸 대신 엔진이 미리 정해 둔
  검증 툴로만 돌립니다.
- **세션의 끝을 선언할 방법이 필요합니다.** `Finish`/`Block`/`Abort`, 그리고
  사람에게 묻는 `AskUser`는 Claude Code에 대응물이 없습니다. 우리 툴을 꽂기
  때문에 이것들이 그대로 살아 있습니다.

`AskUser`는 오히려 이득을 봅니다. 툴을 실행하는 쪽이 `chz` 프로세스 자신이라,
질문이 곧바로 사람의 터미널에 뜹니다. 물어볼 사람이 없는 세션에서는 질문을
blocked로 격하해야 한다는 63 문서의 규칙이, 이 Realizer에는 적용되지 않습니다.

한편 잃는 것도 하나 있는데, 이건 설계가 아니라 한계입니다.
[64 문서](64-realize-harness-prompt.ko.md)는 마지막 턴에 툴을 종료 3종으로
좁히고 클로징 프롬프트를 넣어, 턴이 다 떨어진 세션도 인계 요약은 남기게
합니다. 루프를 넘겨 버리면 그 마지막 턴에 끼어들 자리가 없어서, 턴 상한은
그냥 세션이 끊기는 것으로 끝나고 요약은 받지 못합니다.

### 이 Realizer를 붙이려면

```javascript
// chz.config.js
import { ClaudeCodeRealizer, defineConfig } from "chz";

export default defineConfig({
  realizers: [
    new ClaudeCodeRealizer({
      model: "opus",
      effort: "high",
      maxBudgetUsd: 5, // 이 금액에 닿으면 세션이 blocked로 끝납니다
    }),
  ],
});
```

Claude Code 연동에 필요한 패키지는 **선택 사항**이라 치즈를 설치할 때 같이
따라오지 않습니다. 이 Realizer를 처음 쓰면 세션이 blocked로 끝나면서 설치
명령을 알려 주므로, 그대로 실행한 뒤 `chz realize`를 다시 돌리면 됩니다.

## 하네스 툴

에이전틱 세션에서 LLM에게 주어지는 툴의 목록과 명세는
63 문서의 '하네스 툴 명세' 절에서 정의합니다.
요약하면 — 읽기(`ReadFile`/`ReadDir`)와 검색(`Glob`/`Grep`)은 `projectRoot`로,
쓰기(`WriteFile`/`FindAndReplace`)는 `outputDir`로 제한되고,
검증(`RunTests`/`RunTypeCheck`/`RunLinter`)은 엔진이 미리 정해 둔 명령만
실행하며, 세션의 종료는 `Finish`/`Block`/`Abort`로 선언합니다. **셸 툴은
의도적으로 없습니다.** 사람에게 질문하는 `AskUser` 툴과 에스컬레이션 규칙
역시 63 문서를 따릅니다.

## 세션의 종료와 검증

세션은 다음 세 가지 경우에 종료됩니다: `Finish` 호출, `Abort` 호출, 턴 상한
초과.

단, **`Finish`는 어디까지나 LLM의 '주장'입니다.** 세션 안에서 `RunTests`로
green을 확인했다고 하더라도, 엔진은 이를 신뢰하지 않고 세션 종료 후 독립적으로
검증(타입 체크 + 유닛 테스트 + ensure 계약 테스트)을 다시 실행합니다.

- **검증 통과(green)**: 산출물 해시를 `realization-cache.json`에
  기록하고([60 문서](60-realize-intro.ko.md)), 의존성 그래프의 다음 심볼로
  진행합니다(62 문서).
- **검증 실패(red)**: 실패한 테스트와 진단 로그를 피드백으로 붙여 세션을
  재시도합니다. `maxRetries`를 소진하면 해당 심볼은 `outcome: 'failed'`로
  확정되고, 62 문서의 규칙에 따라 이 심볼에 의존하는 하류 심볼들의 realize는
  진행되지 않습니다.

독립 검증의 판정 범위는 **세션 스코프**입니다: 이 세션이 realize한 심볼의
구현·autogen·ensure 파일과, 그 파일들이 import하는 대상(프롤로그, 이미
realize된 의존 심볼). 아직 realize되지 않은 다른 심볼의 파일이나 사람 소유
`__epilogue__` 때문에 심볼의 검증이 red가 되는 일은 없습니다(63 문서의
검증 툴 참조). 대신 모든 심볼이 resolve된 뒤 엔진은 스코프 없는 **전체 검증**을
한 번 더 실행하여, 에필로그 배선과 심볼 간 통합까지 판정합니다. 이 단계의
실패는 특정 심볼의 책임이 아니므로 세션 재시도로 이어지지 않고, realize 전체의
실패로 보고됩니다.

## 프로젝트에 Realizer 연결하기

```javascript
// chz.config.js

import { ChzExampleOpenAIOneShotRealizer } from 'realizers/ChzExampleOpenAIOneShotRealizer';
import { ComfyRealizer } from '@chz/realizer-comfy';

export default {
  realizers: [
    // 심볼 타입별로 앞에서부터 매칭됩니다: supportedSymbolTypes에 해당 타입이
    // 포함된 첫 번째 Realizer가 그 심볼을 담당합니다.
    new ChzExampleOpenAIOneShotRealizer(
      new OpenAI({ baseURL: 'https://api.closeai.com/v1', apiKey: process.env.CLOSE_AI_KEY }),
    ),
    new ComfyRealizer({ endpoint: 'http://localhost:8188' }), // 'resource' 담당
  ],

  // 파일 인자 없이 `chz realize`를 실행할 때 realize할 소스 글롭 (프로젝트
  // 루트 기준). 파일마다 각자의 의존성 그래프가 만들어집니다.
  include: ['src/**/*.chz.ts'],

  // 동시에 실행할 realize 세션 수 (`-j`/`--jobs` CLI 플래그가 우선).
  // 심볼 단위 검증 스코프 덕에 독립 그룹들은 서로를 오염시키지 않습니다.
  jobs: 4,

  // 의존성 순환(SCC) 하나가 포함할 수 있는 심볼 수의 상한 (62 문서). 순환은
  // 한 세션으로 묶여 함께 realize되므로, 그룹이 클수록 세션 품질이 떨어집니다.
  maxCycleSize: 3,
};
```

## 엔진 쪽에서 보면

`chz realize`의 드라이버는 지금까지의 조각을 이어 붙인 것입니다:

```typescript
// chz/cli.ts (간략화)

const graph = buildDependencyGraph(); // 62 문서

// 위상 정렬 순서로 순회합니다. 순환 그룹(SCC)은 하나의 노드로 병합되어 있고,
// 그룹 구성원은 symbol.circularDependencies를 통해 세션에 함께 전달됩니다.
for (const node of graph.topologicalOrder()) {
  if (!node.invalidated) continue; // 캐시 히트: 재실행하지 않습니다 (60, 62 문서)

  const realizer = findRealizerForSymbol(config.realizers, node.symbol);
  if (!realizer) {
    console.error(`No realizer found for symbol: ${node.symbol.name}`);
    graph.markFailed(node); // 하류도 진행 불가
    continue;
  }

  let resolution: ChzImagineSymbolResolution | undefined;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    resolution = await realizer.realize(node.symbol, buildContext(node, attempt));
    if (resolution.resolved && (await verify(resolution)).green) break; // 엔진 측 독립 검증
  }

  if (resolution?.resolved && resolution.verified) {
    recordToCache(resolution); // realization-cache.json (60 문서)
    console.log(`realized: ${node.symbol.name} → ${resolution.resolvedFile}`);
  } else {
    console.error(`failed: ${node.symbol.name} — ${resolution?.reason}`);
    graph.markFailed(node); // 이 심볼에 의존하는 하류는 realize하지 않습니다 (62 문서)
  }
}
```
