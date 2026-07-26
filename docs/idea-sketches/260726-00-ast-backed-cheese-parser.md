# TypeScript AST 기반 Cheese 문법 분석기 스케치 (2026-07-26)

현재 Cheese 전처리기가 `imagine` 선언을 문자열 스캔으로 찾아 제거하는
방식에 대한 불만에서 시작한 설계 논의의 기록입니다. 특히 다음 입력이
Cheese 문법 오류로 즉시 거부되지 않는 문제가 출발점이었습니다.

```typescript chz
imagine imagine imagine function x(): number {
  requirements(`x를 구현하십시오.`);
}
```

목표는 TypeScript 문법을 자체적으로 다시 구현하는 것이 아니라,
**Cheese가 추가한 얇은 확장 문법만 직접 소유하고 나머지 소스 구조는
TypeScript AST와 Checker를 정본으로 사용하는 것**입니다. 이 과정에서
TypeScript/Cheese 소스를 해석하기 위해 흩어져 있는 정규식과 수동
스캐너도 함께 제거합니다.

## 1. 현재 구현의 진단

### 1.1 전처리기는 TypeScript 파서가 아닌 brace-depth scanner

`src/preprocessor.ts`는 문자열, 주석, template literal과 `()[]{}` 깊이를
직접 추적하여 다음 문법을 찾습니다.

- top-level `imagine function`
- top-level `imagine class`
- imagined class method/property
- `requirements(...)`
- `ensure(...)`

시그니처의 parameter와 return type, ensure의 expression도 AST 노드가
아니라 원본 문자열 조각으로 저장됩니다. 이 때문에 현재 파일 상단에 다음
제약이 명시되어 있습니다.

- regex literal을 추적하지 못함
- `{}`가 들어간 object/generic return type을 처리하지 못함
- generic function type parameter를 처리하지 못함
- `export`/`default` modifier를 처리하지 못함

`tryParseImagine()`은 `imagine` 다음 토큰이 `function`, `class`,
`resource`, `var` 중 하나가 아니면 오류가 아니라 `null`을 반환합니다.
따라서 위 중복 예에서는 세 번째 `imagine function`만 spec으로 인식하고
앞의 `imagine imagine`은 human code로 남깁니다.

### 1.2 TypeScript는 오류를 잡을 수 있지만 preflight가 연결되어 있지 않음

중복 예를 현재 코드로 실행한 결과는 다음과 같습니다.

```text
추출된 spec.start: 세 번째 imagine 위치
plain TS 잔여 코드: imagine imagine
human prologue: imagine imagine
```

같은 잔여 코드를 TypeScript Program에 넣으면 TypeScript는 두 토큰 모두
`TS1434 Unexpected keyword or identifier`로 진단합니다. 문제는 TypeScript가
진단할 수 없다는 것이 아니라, 현재 파이프라인이 이 진단을 source
preflight로 사용하지 않는다는 점입니다.

`src/human-code.ts`의 `splitHumanCode()`는 이미 다음 TypeScript API를
사용합니다.

- `typescript/unstable/ast`
- `typescript/unstable/sync`의 `API`, `Program`, `Checker`
- imagined declaration을 `declare function/class` placeholder로 바꾼
  position-preserving virtual source
- AST symbol identity를 이용한 prologue/epilogue 분류

그러나 이 Program의 syntactic diagnostics는 수거하지 않습니다. 또한
현재 `realize()`는 완전한 source preflight보다 먼저 realization 디렉터리를
생성하고 human layer를 씁니다. 문법 오류는 모든 파일 쓰기와 LLM 세션보다
앞에서 차단되어야 합니다.

### 1.3 소스 구조를 다시 해석하는 로직이 여러 곳에 분산되어 있음

전처리기 외에도 다음 source-aware 휴리스틱이 존재합니다.

- `src/graph.ts`
  - realized implementation의 import/export/dynamic import/require를 찾는
    자체 lexer
  - regex literal과 division을 구분하는 heuristic
  - signature, requirements, ensure를 구분하지 않고 `originalText` 전체에서
    imagine symbol 이름을 찾는 mention scan
- `src/realize.ts`
  - 주석/문자열을 공백으로 바꾼 뒤 대문자로 시작하는 식별자를 찾는
    external type name 정규식
  - `@profile` 정규식
- `src/human-code.ts`
  - top-level export 여부를 `statement.getText()` 정규식으로 판별
- `src/realizer/tools/verification.ts`
  - 반대로 이 파일에는 이미 AST 기반 static/dynamic import, export,
    import-equals, require 판별 코드가 있음

한 소스 구조를 여러 구현이 서로 다른 규칙으로 읽고 있어, TypeScript 문법이
확장될 때 동작이 갈라질 위험이 있습니다.

## 2. 검토한 선택지

### 2.1 TypeScript 파서 포크 또는 custom SyntaxKind 주입 — 기각

이상적인 모양만 보면 TypeScript AST 안에
`SyntaxKind.ImagineFunctionDeclaration` 같은 노드를 추가하고 싶습니다.
그러나 현재 TypeScript 공개/설치 API에는 외부 grammar production을
주입하는 parser plugin 경계가 없습니다. compiler transformer와 AST
factory는 TypeScript가 파싱한 뒤의 노드를 다루며, 알 수 없는 원본 문법을
파서가 받아들이게 만들지는 못합니다.

현재 프로젝트는 native TypeScript 7의 `unstable` AST/API를 직접 사용하고
있습니다. 파서 포크는 다음 부담을 만듭니다.

- native parser와 JS API bridge를 함께 추적해야 함
- TypeScript 버전마다 grammar와 AST shape를 재병합해야 함
- custom node를 만들어도 TypeScript Checker가 의미를 알지 못하므로 결국
  별도의 lowering이 필요함
- 프로젝트의 "declaration-level preprocessor + TypeScript compiler API,
  full parser 자작 없음" 결정과 어긋남

비용에 비해 얻는 이점이 작으므로 채택하지 않습니다.

### 2.2 TypeScript 전체를 포함하는 별도 Cheese parser — 기각

Tree-sitter 확장 grammar나 별도 TypeScript parser를 정본으로 두면 Cheese
노드를 자연스럽게 포함할 수 있지만, TypeScript grammar·diagnostics·JSX와
향후 문법을 Cheese가 중복 소유하게 됩니다. TypeScript Checker와도 별도의
node mapping이 필요합니다.

Cheese가 TypeScript superset이라는 현재 원칙상 적합하지 않습니다.

### 2.3 Cheese를 valid TypeScript 인코딩으로 변경 — fallback으로만 유지

decorator, tagged template, 함수 호출 DSL 등으로 문법을 바꾸면 TypeScript
AST를 바로 사용할 수 있습니다. 그러나 실제 `imagine` 확장 키워드를 언어의
정체성으로 채택한 기존 결정을 되돌리고 사용자 문법을 크게 바꿉니다.

AST 마이그레이션을 위해 표면 문법까지 동시에 변경하지 않습니다. 향후 특정
구문이 지나치게 큰 구현 부담을 만든다는 실측이 있을 때만 별도 언어 설계
논의로 다시 엽니다.

### 2.4 얇은 Cheese parser + TypeScript projection + AST overlay — 채택

Cheese parser는 TypeScript 전체가 아니라 다음 확장 껍질만 인식합니다.

- `@profile`
- top-level `imagine function/class`
- imagine class의 imagined method/property
- imagine body의 `requirements`/`ensure` statement 경계

함수 시그니처, type expression, contract expression, function expression,
import/export, identifier binding과 symbol resolution은 TypeScript가
담당합니다.

## 3. 권장 아키텍처

```text
원본 .chz.ts
    │
    ├─ Cheese lexical/grammar pass
    │    @profile, imagine shell, contract statement만 인식
    │
    ├─ TypeScript projection
    │    Cheese 확장을 valid TS placeholder/island로 변환
    │    모든 변경 구간에 원본 OriginSpan 기록
    │
    ├─ TypeScript Program
    │    SourceFile + syntactic diagnostics + Checker
    │
    ├─ AST binding
    │    Cheese 노드와 대응 TS AST 노드를 연결
    │
    └─ downstream views
         ImagineSpec / human split / dependency graph / emit / verify
```

핵심 원칙은 다음과 같습니다.

1. **원본에서 imagine declaration을 삭제하기 전에 진단합니다.**
2. stripping은 parser 동작이 아니라 green source의 최종 emit 동작입니다.
3. 가능한 projection은 원본과 UTF-16 길이·줄바꿈을 보존합니다.
4. 길이 보존이 불가능한 island에는 명시적인 원본 span mapping을 둡니다.
5. downstream consumer는 source text를 다시 파싱하지 않고 통합 분석 결과를
   받습니다.

예상 public model의 스케치는 다음과 같습니다.

```typescript
interface ChzSourceFile {
  fileName: string;
  source: string;
  profile: ChzProfileDirective | null;
  imagineDeclarations: ChzImagineDeclaration[];
  typescript: {
    projectedSource: string;
    sourceFile: SourceFile;
    program: Program;
    checker: Checker;
  };
  diagnostics: ChzDiagnostic[];
}

interface ChzImagineFunction {
  kind: "ImagineFunction";
  span: SourceSpan;
  declaration: FunctionDeclaration;
  requirements: ChzRequirements | null;
  ensures: ChzEnsure[];
}

interface ChzEnsure {
  kind: "assertion" | "scenario";
  span: SourceSpan;
  call: CallExpression;
  conditionOrScenario: Expression;
  message: StringLiteralLike | null;
}
```

기존 `ImagineSpec`의 `parameters`, `returnType`, `ensure.source` 문자열은
호환 adapter에서 원본 node span을 slice하여 만들 수 있습니다. 분석의
정본은 문자열이 아니라 TS AST node가 됩니다.

### 3.1 projection 전략

다음 구문은 `imagine` 토큰을 공백으로 neutralize하면 나머지가 valid
TypeScript가 됩니다.

```typescript chz
imagine function f<T>(value: T): Promise<{ value: T }> {
  requirements(`값을 감쌉니다.`);
  ensure((await f(1)).value === 1);
}
```

```typescript chz
imagine class Service {
  imagine static async create(): Promise<Service> {
    ensure((await Service.create()) instanceof Service);
  }
}
```

반면 다음 두 구문은 `imagine`만 제거해도 valid TypeScript가 아닙니다.

```typescript chz
imagine class Counter {
  requirements(`카운터를 관리합니다.`);

  imagine readonly score: number {
    requirements(`현재 점수입니다.`);
  }
}
```

- class body direct contract statement
- imagined property의 contract body

이 둘은 Cheese island로 유지합니다. main projection에는 위치 보존
placeholder를 만들고, contract expression과 property type은 synthetic
TypeScript fragment 또는 origin-mapped virtual source로 파싱합니다.
정확한 projection 형태는 구현 전 feasibility spike에서 확정합니다.

## 4. 문법 결정

### 4.1 imagine body의 허용 statement를 제한 — 확정

사용자 결정:

> imagine 함수/메서드/프로퍼티 및 class-level contract body의 최상위에는
> `requirements(...)`와 `ensure(...)` 외의 statement를 금지한다.

현재 `parseImagineBody()`는 알 수 없는 statement를 조용히 무시합니다.
새 parser는 다음과 같은 입력을 오류로 처리해야 합니다.

```typescript chz
imagine function f(): number {
  requirements(`1을 반환합니다.`);
  const expected = 1; // 오류
  return expected;    // 오류
}
```

단, scenario ensure의 callback 내부는 실행 가능한 테스트이므로 일반
TypeScript statement를 허용합니다.

```typescript chz
imagine function f(): number {
  ensure("1을 반환합니다.", () => {
    const result = f();
    assert(result === 1);
  });
}
```

이 제한으로 contract 오타나 실수로 작성한 구현 코드가 조용히 버려지는
문제를 방지합니다.

### 4.2 imagined property의 현재 문법을 보존 — 확정

사용자 결정:

> `imagine readonly score: number { requirements(...); }` 형태는 보존한다.

AST 도입을 이유로 decorator, getter, initializer DSL 등으로 바꾸지
않습니다. 이 구문은 Cheese가 소유하는 명시적인 island production으로
처리합니다.

### 4.3 `imagine`은 contextual keyword로 유지 — 확정

TypeScript superset 성질을 최대한 보존하려면 다음 ordinary identifier
사용은 계속 허용하는 편이 좋습니다.

```typescript
const imagine = createPreview();
imagine();
object.imagine();
```

사용자 결정:

> statement/class-member 시작 위치의 `imagine`은, 바로 뒤에 표현식을
> 이어갈 수 있는 토큰이나 줄바꿈이 오는 경우에만 평범한 식별자로 본다.
> 그 외에는 전부 Cheese 선언으로 commit한다.

즉 commit 규칙은 **화이트리스트(뒤에 `function`/`class`가 올 때만 인식)가
아니라 블랙리스트**입니다. commit을 취소시키는 후속 토큰 집합은 다음과
같이 닫혀 있습니다.

| 분류 | 토큰 |
|---|---|
| 호출·접근 | `(` `.` `?.` `[` 태그드 템플릿의 `` ` `` |
| 대입·연산 | `=`와 복합 대입, 이항/비교/논리 연산자, `?` `:` |
| 타입 연산 | `as` `satisfies` `instanceof` `in` |
| 후위·단언 | `++` `--` `!` |
| 문 경계 | `;` `,` `)` `]` `}` EOF |
| 줄바꿈 | `imagine`과 다음 토큰 사이의 line terminator |

줄바꿈을 목록에 넣는 이유는 TypeScript의 `async function` restricted
production과 같습니다. `imagine`만 있는 문장 뒤에 다음 줄부터 별개의
선언이 오는 plain TypeScript를 Cheese가 가로채지 않기 위해서입니다.

이 규칙의 귀결:

- `imagine();`, `imagine.preview()`, `imagine<T>(x)`, `const imagine = ...`
  는 계속 valid TypeScript로 통과합니다.
- 그 외의 declaration-position `imagine`은 **commit되며, 이후에는 절대
  `null` 폴백이 없습니다.** 뒤따르는 토큰이 `function`/`class`/`resource`/
  `var`가 아니면 그 토큰 위치에서 CHZ1xxx 진단입니다.

```typescript chz
imagine imagine function f(): void {}
//      ^ CHZ1xxx: 'imagine' 다음에는 function 또는 class가 와야 합니다
```

클래스 본문에서도 같은 규칙을 쓰되, commit 이후 허용되는 후속 토큰에
멤버 modifier(`static` `readonly` `async` `public`/`private`/`protected`)와
멤버 이름이 추가됩니다.

정확한 토큰 집합은 Phase 0의 grammar fixture로 고정합니다. 특히 위 표의
각 항목마다 "identifier로 남는다"를 확인하는 positive fixture를 둡니다.

### 4.4 `export imagine`은 허용, `export default`는 금지 — 확정

사용자 결정:

> `export imagine function/class`를 정식 문법으로 인정한다.
> `export default` / `declare` / `abstract`는 CHZ 오류로 거부한다.
> 그리고 shim 노출을 소스의 `export` 여부에 맞추는 변경도 이번에 함께
> 적용한다.

현재 상태를 먼저 기록해 둡니다. `examples/chz-import/battle.chz.ts:12`는
이미 `export imagine function`을 쓰고 있지만, 전처리기의 선언 span이
`imagine` 토큰에서 시작하므로(src/preprocessor.ts:181) 남은 plain TS에는
`export `만 덩그러니 남습니다. 아무도 그 진단을 읽지 않기 때문에 지금은
우연히 동작하는 상태입니다. 새 parser에서는 `export` modifier가 선언
노드의 일부가 되어 span에 포함됩니다.

`export default`를 거부하는 이유는 이름이 없기 때문입니다. realization
파일명, 캐시 키, public surface 식별자, 의존성 그래프 노드 ID가 모두
심볼 이름에 묶여 있습니다. 진단은 문서 63 원칙대로 복구 힌트를 포함해야
합니다 — "이름 있는 `export imagine`으로 선언하고, default가 필요하면
human 코드에서 `export default 이름;`으로 다시 내보내십시오."

노출 규칙은 문서 20의 "소스 `.chz.ts`가 export한 것 = shim이 export하는
것"을 그대로 구현합니다.

- `renderEntryPoint()`(src/realize.ts:889)는 현재 export 여부와 무관하게
  모든 imagine 심볼을 re-export합니다. 이것을 소스의 export 여부에 따라
  갈라야 합니다.
- 비-export 심볼도 realize 대상이고 realization 디렉터리 안에서는 그대로
  import되지만, entrypoint에서는 `export {}` 대신 side-effect import 또는
  epilogue 경유로만 연결됩니다.
- 판정 근거는 선언의 export modifier뿐 아니라 human 코드의
  `export { 이름 }` 재-export 문도 포함합니다. 두 경로 모두 AST에서
  읽습니다(§5.1의 export modifier 항목과 같은 정본).
- 사이드카 shim 자체는 아직 미구현이므로(문서 20은 설계만) 이번 변경의
  영향 범위는 entrypoint 렌더러와 그 테스트로 한정됩니다.
- 공식 예제는 이 변경으로 깨지지 않습니다. `collision.chz.ts`의
  비-export `충돌판정_2D`는 같은 파일의 epilogue에서만 사용됩니다.

### 4.5 human 심볼의 노출과 specifier 재작성 — 확정

§4.4가 imagine 심볼의 노출을 정했다면, 문서 20의 규칙은 human이 작성한
타입·상수·함수에도 똑같이 적용됩니다. 현재 entrypoint는 prologue를
side-effect import만 하므로 `export type CombatStats` 같은 human 선언이
바깥에서 보이지 않습니다.

사용자 결정:

> 소스가 export한 human 심볼을 entrypoint가 forward한다. 값과 타입은
> 나누어 emit하고, `export default`도 forward한다. 그리고 human 코드의
> 상대 경로 specifier 재작성도 이번에 함께 해결한다.

**forward 목록의 정본은 소스 AST의 export 정보입니다.** prologue가
realized 코드와의 내부 연결을 위해 덧붙이는 `export { ... }`
(src/human-code.ts:380)는 노출 대상이 아닙니다. entrypoint에서
`export * from "./implementations/__prologue__.ts"` 같은 와일드카드를 쓸 수
없는 이유가 이것입니다 — human의 비공개 심볼이 그대로 새어나갑니다.

emit 형태:

```typescript
import "./implementations/__prologue__.ts";
export { 원점 } from "./implementations/__prologue__.ts";
export type { Shape } from "./implementations/__prologue__.ts";

export { 충돌판정_2D } from "./implementations/충돌판정_2D.ts";

import "./implementations/__epilogue__.ts";
export { default } from "./implementations/__epilogue__.ts";
```

- 값 export와 type-only 선언(interface, type alias, `export type`)을 AST로
  구분해 나누어 씁니다. 사용자 프로젝트가 `verbatimModuleSyntax`를 켜도
  안전해야 하기 때문입니다.
- 기존 side-effect import 줄은 그대로 둡니다. ESM 모듈 인스턴스는 중복
  평가되지 않으므로 prologue → 실현 코드 → epilogue 평가 순서가 보존되고,
  export가 하나도 없는 층도 계속 평가됩니다.
- `export default`는 소스에 최대 하나이므로 어느 층에 실렸는지 판정이
  결정적입니다. imagine의 `export default` 거부(§4.4)와 모순되지
  않습니다 — 그쪽은 심볼 이름이 필요해서 거부하는 것입니다.

**module specifier 재작성.** 현재 `src/human-code.ts`에는 specifier
재작성이 전혀 없습니다. 그래서 human 코드가 prologue/epilogue로 복사될 때
`import { 크리티컬_판정 } from "./stats"`
(examples/chz-import/battle.chz.ts:10)가
`chz/realization/battle/implementations/stats`를 가리키게 됩니다. human
export를 forward해도 이 상태에서는 cross-file 예제가 실행되지 않으므로,
재작성이 선행 조건입니다.

- 상대 specifier(`./`, `../`)만 realization 디렉터리 기준으로 다시 씁니다.
  bare specifier와 절대 경로, tsconfig path alias는 그대로 둡니다.
- 대상 노드는 import declaration, `export ... from`, `import type`,
  정적 문자열을 받는 `import()`, `import x = require(...)`입니다. §5.1의
  공용 traversal을 그대로 씁니다.
- 정적 문자열이 아닌 `import()`는 재작성할 수 없습니다. 조용히 두지 않고
  진단으로 알립니다.
- 다른 `.chz.ts`의 shim을 가리키는 import도 같은 규칙으로 처리됩니다.

### 4.6 `requirements` 인자는 정적 문자열로 제한 — 확정

사용자 결정:

> `requirements(...)`의 인자는 문자열 리터럴 또는 치환 없는 템플릿
> 리터럴 하나로 제한한다.

`${...}` 치환, 식별자 참조, 문자열 연결, 다중 인자는 CHZ2xxx 오류입니다.
근거는 requirements가 **realize 시점에 프롬프트로 들어가는 값**이라는
점입니다. 런타임 값이 개입할 여지가 없고, 무효화 해시도 소스만 보고
결정되어야 합니다.

Checker의 리터럴 타입 폴딩으로 상수 치환을 허용하는 안은 기각했습니다.
공통 문구 재사용이라는 이점보다 "접히지 않는 치환" 진단과 해시 계산의
Checker 의존이 더 큰 비용입니다.

## 5. source-aware 정규식과 수동 scanner 마이그레이션

### 5.1 AST로 교체

| 현재 분석 | 새 정본 |
|---|---|
| imagine brace-depth scanner | 얇은 Cheese parser + TS AST |
| ensure static string 정규식 | `StringLiteral` / `NoSubstitutionTemplateLiteral` |
| ensure function 정규식 | `ArrowFunction` / `FunctionExpression` |
| import/export/dynamic import/require 수동 lexer | 공용 TS AST traversal |
| signature dependency 문자열 검색 | TypeNode + Checker symbol |
| ensure dependency 문자열 검색 | expression AST + Checker symbol |
| external type 대문자 정규식 | free type reference + Checker declaration |
| export text 정규식 | AST modifier/export declaration |
| `@profile` 정규식 | `ChzProfileDirective` |
| line/column 직접 계산 | `SourceFile.getLineAndCharacterOfPosition()` |

`src/realizer/tools/verification.ts`의 AST 기반 `importedModule()` 계열 로직을
공용 compiler utility로 승격하여 graph와 linter가 같은 규칙을 사용합니다.

### 5.2 AST로 바꾸지 않음

다음은 TypeScript source structure 분석이 아니므로 정규식 또는 명시적 text
parser를 유지합니다.

- 자연어 requirements 안의 imagine symbol 언급
- CLI argument
- 파일명·확장자·경로 convention
- ANSI escape와 Vitest/tool output
- line ending 정규화

의존성 그래프의 estimated edge는 다음처럼 출처를 분리합니다.

```text
signature type reference → TypeScript TypeNode/Checker
ensure executable code   → TypeScript expression AST/Checker
requirements prose       → natural-language mention matcher
```

현재처럼 `spec.originalText` 전체를 하나의 mention scan에 넣지 않습니다.
자연어 matcher는 AST의 대체물이 아니라 명시적인 별도 분석 단계로
이름 붙입니다.

## 6. diagnostics와 preflight

통합 진입점은 `parseChzSource()` 또는 `analyzeChzSource()` 하나로 두고,
모든 CLI 경로가 같은 결과를 사용합니다.

```text
read source
→ Cheese parse
→ TS projection parse
→ diagnostics 수거/원본 위치 매핑
→ fatal diagnostics가 없을 때만 graph/split/write/session
```

필수 동작:

- `--json`, `--dry-run`, 실제 realize가 동일한 parse/preflight를 사용
- syntax error 시 realization 디렉터리 생성, 파일 쓰기, LLM 호출 모두 0회
- Cheese parser가 committed production을 조용히 `null`로 되돌리지 않음
- projection 자체가 valid TS여야 하며 인위적인 TS diagnostic을 suppression
  목록으로 숨기지 않음
- 가능하면 첫 오류만 throw하지 않고 복구 가능한 범위의 diagnostics를 함께
  반환
- diagnostics는 원본 file/UTF-16 offset/line/column을 가짐

diagnostic namespace 제안:

```text
CHZ1xxx  Cheese grammar
TSxxxx   TypeScript syntax/type
CHZ2xxx  requirements/ensure contract shape
CHZ3xxx  realize/profile/ownership static rule
```

human preflight의 semantic diagnostics에는 기존 docs/idea-sketches/
260724-02에서 논의한 obligation 분류가 필요합니다. `Property 'start' does
not exist`처럼 "usage creates the contract"로 승격할 진단과 실제 human
error를 분리해야 합니다. syntactic diagnostics와 Cheese grammar
diagnostics는 obligation과 무관하게 항상 fatal입니다.

### 6.1 obligation 승격 규칙 — 확정

사용자 결정:

> 진단 코드 목록이 아니라 **진단이 가리키는 심볼의 소유자**로 판정한다.

판정 절차:

1. 진단의 에러 노드가 property access 또는 static string element access인가.
2. 그 노드의 객체 타입을 Checker로 따라갔을 때, 선언이 imagine 심볼
   (또는 imagine 선언에서 만들어진 스텁)에 도달하는가.
3. 둘 다 참일 때만 obligation. 나머지는 전부 human error이며 LLM 세션 0회로
   즉시 실패합니다.

초기 코드 집합은 `TS2339`(Property does not exist)와 `TS2551`(오타 제안이
붙은 변형) 두 개로 시작하고, fixture로 실증된 경우에만 확장합니다.
코드 기반 allowlist를 기각한 이유는, imagine과 무관한 객체의 오타가 같은
`TS2339`를 내기 때문입니다. 코드로만 거르면 human이 만든 오타가 조용히
LLM의 obligation 목록으로 넘어갑니다.

`required imagine func/var` 명시 선언은 이 경로를 타지 않습니다. 명시
선언이 있으면 스텁이 존재하므로 애초에 진단이 발생하지 않고, obligation은
선언 자체에서 직접 수집됩니다. 따라서 `TS2304`(Cannot find name)는
obligation이 아닙니다 — 소유자를 특정할 수 없는 이름이기 때문입니다.

## 7. 구현 단계

### Phase 0 — grammar contract와 feasibility spike

아직 production 코드를 교체하지 않고 다음을 작은 prototype/fixture로
검증합니다.

- regex literal과 division
- template literal과 중첩 `${...}`
- generic function/class/method
- object/mapped/conditional return type
- Unicode identifier
- comment/string/template/regex 안의 가짜 `imagine`
- `.chz.tsx`와 JSX
- class-level contracts와 imagined property projection
- projection diagnostic의 원본 위치 mapping

이 단계의 종료 조건:

1. 기존 공식 예제가 모두 parse됨.
2. known limitation의 generic/object return type/regex 사례가 parse됨.
3. 중복 imagine이 deterministic CHZ diagnostic으로 실패함.
4. plain TypeScript 입력은 원래 TypeScript diagnostics와 차이가 없음.

`.chz.tsx`는 **설계만 준비하고 지원은 별도 마일스톤**으로 둡니다(사용자
결정). 이번 스파이크에서는 JSX fixture로 `<`가 generic인지 JSX인지의
비용만 측정하고, projection이 확장자로 ScriptKind(TS/TSX)를 고르는
구조까지만 만들어 둡니다. 실제 `.chz.tsx` 입력은 이번 범위에서 명시적인
미지원 진단으로 차단합니다 — 조용히 `.ts`로 파싱하지 않습니다.

### Phase 1 — compiler core 도입

예상 모듈 경계:

```text
src/compiler/ts-api.ts       typescript/unstable 재수출 경계 (유일한 직접 import 지점)
src/compiler/syntax.ts       Chz AST와 span
src/compiler/parser.ts       Cheese extension productions
src/compiler/projection.ts   TS virtual source + origin mapping
src/compiler/typescript.ts   Program/Checker lifecycle
src/compiler/diagnostics.ts  diagnostic model/rendering
src/compiler/analyze.ts      analyzeChzSource public entry
```

파일명은 구현 시 조정할 수 있으나, Program 생성과 source parsing은 한 곳에
모읍니다. `extractImagineSpecs()`는 새 AST에서 기존 `ImagineSpec`을 만드는
호환 adapter가 됩니다.

TypeScript 7 `unstable` API 전략(사용자 결정): **버전은 caret(`^7.0.2`)을
유지하고, 경계 모듈만 둡니다.** `typescript/unstable/*`를 직접 import하는
파일은 `src/compiler/ts-api.ts` 하나로 제한하고, 나머지 모듈은 이 경계를
통해서만 AST/Program/Checker에 접근합니다. 마이너 업데이트에서 API 형상이
바뀌면 수정 지점이 한 파일로 모이고, 파손은 기존 테스트와 fixture corpus가
드러냅니다. 버전 고정은 실제로 깨지는 사례가 관측되면 그때 도입합니다.

### Phase 2 — write-before-preflight 제거

- CLI JSON/dry-run/realize entry를 통합 analyzer에 연결
- diagnostics green 이후에만 output directory 생성
- `splitHumanCode()`가 별도 virtual Program을 만들지 않고 통합 Program과
  Checker를 재사용

### Phase 3 — consumer를 AST로 순차 이전

위험이 낮고 독립적인 순서:

1. import/export/module specifier 수집 + 상대 경로 재작성 (§4.5)
2. `@profile`
3. export modifier 판정
4. entrypoint 노출 규칙을 소스 export 여부에 맞춤 — imagine 심볼(§4.4)과
   human 심볼·`export default`(§4.5)
5. external type reference 수집
6. ensure shape와 source emission
7. signature/ensure dependency graph
8. human code split의 parse lifecycle 통합

각 단계에서 기존 fixture와 새 AST 결과를 비교한 뒤 해당 정규식/수동
scanner를 삭제합니다. 두 구현을 장기간 병존시키지 않습니다.

### Phase 4 — legacy preprocessor 제거

- brace-depth/string/comment/template scanner 제거
- `scanCall`, `isStaticStringLiteral`, `isFunctionExpression` 제거
- raw string 기반 line/column 계산 제거
- compatibility adapter만 public boundary에 남기거나 downstream을 Chz AST로
  직접 전환

### Phase 5 — 문서와 editor 경로

- 10번대 문서: contextual keyword commit 규칙, imagine body statement 제한,
  property island grammar, `export imagine` 문법과 `export default` 거부,
  requirements 인자 제한
- 20번대 문서: projection, AST overlay, diagnostic/preflight pipeline,
  obligation 승격 규칙. 노출 규칙(§4.4–4.5)은 기존 문서 20의 서술과 이미
  일치하므로 구현만 따라가면 되지만, human 코드의 상대 경로 specifier
  재작성은 문서 20에 새로 적어야 합니다 — "no-build" 원칙에서 사용자가
  기대하는 동작이기 때문입니다.
- 향후 editor/LSP는 같은 analyzer와 origin mapping을 재사용

## 8. 테스트 계획

### 8.1 negative grammar

```typescript chz
imagine imagine imagine function x(): void {}
imagine functon x(): void {}
imagine function (): void {}
imagine function f<T(: void {}
imagine function f(): void {
  requirments(`오타`);
}
imagine function f(): void {
  requirements(`요구`);
  const implementation = 1;
}
export default imagine class C {}
imagine export function f(): void {}
imagine function f(): void {
  requirements(`값 ${limit}`);
}
```

commit 규칙(§4.3)의 negative 짝으로, 다음은 전부 오류 없이 통과해야
합니다.

```typescript
imagine();
imagine.preview();
imagine<Preview>(seed);
imagine satisfies Factory;
imagine
function next(): void {}
```

### 8.2 TypeScript parity

- generic/object/mapped/conditional type
- overload와 modifier
- regex에 `{}`, quote, `imagine function` 문자열 포함
- nested template/regex/JSX
- Unicode와 escaped identifier
- import attributes와 dynamic import

### 8.3 AST consumer

- type-only/static/side-effect/dynamic/import-equals/require
- alias, shadowing, 같은 문자열의 property name
- lowercase type alias와 Unicode type name
- requirements prose의 한국어 조사 결합
- ensure expression에서 실제 Checker symbol identity 사용

### 8.4 pipeline safety

- fatal source에서 디렉터리/파일 생성 0회
- Realizer 호출 0회
- JSON/dry-run/realize diagnostics 일치
- 원본 line/column 일치
- unchanged valid source의 realization-cache/public-surface hash 의미 유지
- entrypoint가 re-export하는 심볼 목록이 소스의 export 목록과 일치 —
  imagine·human 심볼 모두, prologue의 내부 연결용 export는 제외 (§4.4–4.5)
- 값/타입 export가 분리 emit되어 `verbatimModuleSyntax`에서도 typecheck
- 재작성된 상대 specifier가 realization 디렉터리에서 원본과 같은 모듈로
  해석됨 (cross-file 예제 실행)
- imagine 스텁 멤버 접근은 obligation, 같은 `TS2339`라도 human 객체의
  오타는 human error로 분류 (§6.1)

property-based 또는 fuzz test에서는 plain TypeScript 조각의 string/comment/
template/regex 위치에 `imagine` 텍스트를 삽입해 false positive가 없는지
검증합니다.

## 9. 남은 열린 질문

2026-07-26 후속 논의에서 기존 6개 질문은 모두 해소되었습니다(§4.3–4.6,
§6.1, §7). 남은 것은 그 결정에서 파생된 항목들입니다.

- imagine `export default`의 재검토 시점. React 컴포넌트처럼 default
  export가 관용구인 대상을 imagine으로 선언하려는 실제 요구가 생기면,
  이름 기반 식별자 규칙(파일명/캐시 키/그래프 노드 ID)과 함께 다시 엽니다.
  human 코드의 `export default`는 §4.5에서 이미 forward하기로 했습니다.
- obligation allowlist의 확장 절차. 소유자 기반 판정은 확정이지만, 초기
  `TS2339`/`TS2551` 외의 코드를 추가할 때 무엇을 근거로 삼을지(재현
  fixture 필수 여부)는 정하지 않았습니다.
- prompt/문법 개정이 realization-cache 무효화 해시에 참여하는지 (문서 64의
  기존 열린 질문과 동일한 항목).

## 10. 이번 논의의 확정 요약

1. TypeScript 파서를 포크하지 않습니다.
2. TypeScript 전체 parser를 자체 구현하지 않습니다.
3. Cheese extension parser + TypeScript projection + AST overlay를 채택합니다.
4. TypeScript/Cheese source structure를 읽는 정규식과 수동 scanner는 AST로
   교체합니다.
5. 자연어, CLI, 파일명, 출력 protocol 정규식은 AST 전환 범위가 아닙니다.
6. imagine contract body 최상위에는 `requirements()`와 `ensure()`만
   허용합니다.
7. imagined property의 현재 contract body 문법은 보존합니다.
8. stripping은 모든 source diagnostics가 green인 뒤의 emit 단계로
   이동합니다.
9. `imagine`은 contextual keyword로 남되, 표현식을 이어갈 수 있는 후속
   토큰·줄바꿈이 아닌 한 declaration position에서 commit하고 폴백하지
   않습니다.
10. `export imagine`은 정식 문법이고 imagine의 `export default`는
    거부하며, 노출 범위는 소스의 export 여부를 따릅니다.
11. human이 export한 심볼도 entrypoint가 forward합니다. 값과 타입은 나누어
    emit하고 `export default`도 forward하며, human 코드의 상대 경로
    specifier는 realization 디렉터리 기준으로 재작성합니다.
12. `requirements`의 인자는 정적 문자열 하나로 제한합니다.
13. obligation 승격은 진단 코드가 아니라 소유자로 판정합니다.
14. `.chz.tsx`는 projection 설계와 fixture만 준비하고 지원은 별도
    마일스톤입니다.
15. `typescript/unstable` 접근은 `src/compiler/ts-api.ts` 한 곳으로
    모으고, 버전은 caret을 유지합니다.
