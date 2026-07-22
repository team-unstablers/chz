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
| `ChzRealizerBase`    | 베이스 Realizer. <br /> 기본 하네스로의 룰만 정의되어 있으며, LLM과 상호작용할 수 있는 기능은 없습니다.                                                           | 코드, 이미지    | 구현 중 |
| `ChzOpenAIRealizer`  | OpenAI (또는 Compatible API)를 사용하는 LLM과 상호작용할 수 있는 Realizer. <br /> `ChzRealizer`를 상속하며, OpenAI API를 통해 imagine 선언에 대한 구현을 생성합니다. | 코드, 이미지    | 구현 중 |
| `ClaudeCodeRealizer` | Claude Code CLI를 하네스로써 사용합니다. <br /> **`-p` (eval) 옵션을 통해 상호작용 하므로 정액 요금제를 사용하더라도 요금이 발생합니다!**                                 | 코드   | 구현 중 |
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
  projectRoot: string; // 읽기 허용 범위의 최상단
  outputDir: string;   // 산출물이 쓰여야 하는 위치이자, 유일한 쓰기 허용 범위

  /** 이미 realize된 의존 심볼들의 산출물. LLM이 읽고 그 위에 구현을 쌓습니다 (62 문서) */
  resolvedDependencies: ChzImagineSymbolResolution[];

  maxTurns: number;   // 에이전틱 루프의 턴 상한
  maxRetries: number; // 검증 실패 시 재시도 상한
};

type ChzImagineSymbolResolution = {
  symbol: ChzImagineSymbol;

  resolved: boolean;               // 구현 생성에 성공했는지 여부
  resolvedFile?: string;           // 구현이 생성된 파일 경로
  resolvedTestFiles?: string[];    // 함께 emit된 유닛 테스트 / ensure autogen 테스트
  assumptionsReport?: string;      // ASSUMPTIONS 리포트 경로 (60 문서)
  resolvedLine?: [number, number]; // 구현이 생성된 라인 범위
  resolvedAt?: Date;               // 구현이 생성된 시각

  resolvedBy?: string;  // 모델 이름 (claude-opus-4.8, gpt-5-... 등)
  failReason?: string;  // resolved === false인 경우: Abort 사유, 턴 상한 초과, 검증 실패 등
};

interface ChzRealizer {
  name: string;
  supportedSymbolTypes: ChzImagineSymbolType[];

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
      resolved: true,
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
      { role: 'system', content: CHZ_HARNESS_SYSTEM_PROMPT }, // '하네스 툴' 절 참조
      { role: 'user', content: this.buildPrompt(symbol, context) },
    ];

    let done: { ok: boolean; reason?: string } | null = null;

    for (let turn = 0; turn < context.maxTurns && !done; turn++) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-oss-20b',
        messages,
        tools: CHZ_HARNESS_TOOLS, // ReadFile, WriteFile, RunTests, Finish, ... ('하네스 툴' 절 참조)
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
        resolved: false,
        failReason: done?.reason ?? `턴 상한(${context.maxTurns}) 초과`,
      };
    }

    return {
      symbol,
      resolved: true,
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
    tools: ChzToolDef[],
  ): Promise<ChzChatResponse>;
}
```

- `ChzOpenAIRealizer`는 `chat()`을 OpenAI SDK로 구현한 것입니다.
- `ClaudeCodeRealizer`는 예외적으로 이 루프를 사용하지 않습니다. Claude Code
  자체가 이미 에이전틱 하네스이므로 루프를 통째로 위임하고, 대신 위의 하네스
  룰(읽기/쓰기 경계)을 시스템 프롬프트와 퍼미션 설정으로 주입합니다.
  말하자면 '하네스 속의 하네스'입니다.

## 하네스 툴

에이전틱 세션에서 LLM에게 주어지는 툴은 다음이 전부입니다:

| 툴 | 시그니처 | 설명과 경계 |
|----|----------|-------------|
| `ReadFile` | `(path: string): string` | 파일 읽기. `projectRoot` 내부만 허용되며, `.env`·`.git` 등 차단 목록에 걸리는 경로는 거부됩니다. |
| `ReadDir` | `(path: string): string[]` | 디렉토리 목록. `ReadFile`과 동일한 경계를 따릅니다. |
| `WriteFile` | `(path: string, content: string): void` | 파일 쓰기. **`outputDir` 내부만** 허용됩니다. 스코프 밖의 기존 코드는 이 툴로 수정할 수 없습니다. |
| `FindAndReplace` | `(path: string, find: string, replace: string): void` | 자기 산출물의 부분 수정용. `WriteFile`과 동일한 경계를 따릅니다. |
| `RunTests` | `(testFiles: string[]): TestResult[]` | 엔진이 고정된 테스트 러너(vitest)로 실행하고 결과만 돌려줍니다. |
| `RunTypeCheck` | `(): TypeCheckResult` | 엔진이 tsc를 실행하고 진단 결과를 돌려줍니다. |
| `RunLinter` | `(): LintResult[]` | 엔진이 린터를 실행하고 결과를 돌려줍니다. |
| `Finish` | `(): void` | 산출물이 완성되었음을 선언하고 세션을 종료합니다. |
| `Abort` | `(reason: string): void` | 구현이 불가능함(요구사항 모순, 정보 부족 등)을 선언하고 세션을 포기합니다. |

여기서 중요한 설계 결정은 **셸 툴이 없다**는 점입니다. Claude Code 같은
범용 하네스와 달리, Realizer의 검증 수단(`RunTests`/`RunTypeCheck`/`RunLinter`)은
엔진이 미리 정해 둔 명령을 실행할 뿐이므로, LLM이 임의의 명령을 실행할 수 있는
표면 자체가 존재하지 않습니다. 읽기는 `projectRoot`로, 쓰기는 `outputDir`로
제한되므로, "스코프 외의 코드를 수정하거나 삭제하지 못하도록 제한한다"는 앞의
역할 정의는 별도의 감시 장치가 아니라 툴 디스패처의 경로 검사 그 자체로
구현됩니다.

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
  재시도합니다. `maxRetries`를 소진하면 해당 심볼은 `resolved: false`로
  확정되고, 62 문서의 규칙에 따라 이 심볼에 의존하는 하류 심볼들의 realize는
  진행되지 않습니다.

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
    console.error(`failed: ${node.symbol.name} — ${resolution?.failReason}`);
    graph.markFailed(node); // 이 심볼에 의존하는 하류는 realize하지 않습니다 (62 문서)
  }
}
```
