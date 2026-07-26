# Cheese parser projection spike 결과 (2026-07-26)

이 문서는
`260726-00-ast-backed-cheese-parser.md` §7 Phase 0의 feasibility spike에서
확인한 사실을 기록한다. production 파이프라인은 바꾸지 않았고,
`src/compiler/spike/`와 fixture corpus만 추가했다. 실측에 사용한
TypeScript는 설치된 `7.0.2`의 `typescript/unstable/*` API다.

## 1. 결론: origin-mapped virtual source를 선택한다

선택한 형태는 다음 조합이다.

1. main projection에서 `imagine` 토큰은 같은 길이의 공백으로 바꾼다.
2. class body direct contract statement와 imagined property contract body는
   첫 non-newline code unit을 `;`로 바꾸고 나머지를 공백으로 만든다.
3. 해당 contract는 별도의 origin-mapped virtual source에서 파싱한다.
   virtual source는 원본과 길이와 줄바꿈이 같고, island의 contract statement만
   원래 offset에 복사하며 나머지는 공백이다.
4. main projection의 property declaration은 `readonly score: Type;` 같은
   정상 TypeScript property로 남으므로 Checker가 이름과 type symbol에
   접근한다. island SourceFile은 contract call/expression AST를 제공한다.

즉 “main source에서 island를 없애되, 원본 span을 정본으로 갖는 AST overlay를
붙인다”는 모양이다. 모든 replacement는 UTF-16 code unit 수와 CR/LF를
보존한다. 구현에서도 code point iteration이 아니라 `split("")`을 사용한다.
surrogate pair가 하나의 원소가 되는 `[...source]`를 사용하면 뒤 offset이
밀리기 때문이다.

### 비교한 후보

| 후보 | 인위적 syntactic diagnostic | 원본 위치 | Checker symbol |
|---|---:|---|---|
| synthetic function wrapper | 0 | wrapper prefix만큼 이동, 별도 map 필요 | contract call은 볼 수 있지만 imagined property 선언/type symbol은 없음 |
| origin-mapped virtual source + main placeholder | 0 | 원본 UTF-16 offset과 동일 | main projection의 imagined property symbol 접근 성공 |

`positive-class-islands.chz.fixture`에서 두 후보를 같은 TypeScript Program에
함께 넣어 비교했다. 두 후보 모두 syntactic diagnostic은 0개였다. 따라서
synthetic fragment가 실패한 이유는 “파싱이 안 됨”이 아니라 다음 두 가지다.

- wrapper prefix 때문에 diagnostic과 node position을 매번 역변환해야 한다.
- body-only fragment에는 imagined property declaration/type node가 없어서,
  Checker를 통한 property symbol 접근이 끊긴다.

origin-mapped 후보는 세 island(class-level 2개, property 1개)의 원본 위치가
그대로였고, main property node의 Checker symbol 접근도 성공했다. projection
때문에 생긴 TypeScript diagnostic을 suppression하는 목록은 두지 않았다.

## 2. 확정한 진단 코드

메시지 정본은 `src/compiler/spike/diagnostics.ts`의
`DIAGNOSTIC_DEFINITIONS`다. line/column은 전부 projected main
`SourceFile.getLineAndCharacterOfPosition()`으로 계산한다.

| 코드 | 의미 | 메시지 | 복구 힌트 |
|---|---|---|---|
| CHZ1001 | commit된 `imagine` 뒤 production이 지원 선언이 아님 | A committed 'imagine' must be followed by a supported declaration. | `imagine function`/`imagine class`를 쓰고, class에서는 modifier 뒤에 member name을 쓴다. |
| CHZ1002 | 선언 이름 누락 | An imagine declaration must have a name. | signature 앞에 valid TypeScript identifier를 추가한다. |
| CHZ1003 | imagine 선언의 TypeScript signature/body shell 오류 | The TypeScript signature or body shell of this imagine declaration is malformed. | 표시된 TypeScript syntax를 고치고 contract call은 선언 body 안에 둔다. |
| CHZ1004 | contract body 최상위의 금지 statement | Only requirements(...) and ensure(...) are allowed at the top level of an imagine contract body. | 구현 statement는 human TypeScript 또는 ensure scenario callback 안으로 옮긴다. |
| CHZ1005 | imagine 선언의 금지 modifier | This modifier is not supported on an imagine declaration. | 이름 있는 `export imagine`을 쓰고, default가 필요하면 human code에서 `export default Name;`으로 다시 내보낸다. |
| CHZ1006 | Phase 0 `.chz.tsx` 미지원 | Cheese TSX input is not supported in Phase 0. | JSX는 plain `.tsx`로 옮기고 Cheese 선언은 `.chz.ts`에 둔다. |
| CHZ1007 | declaration/contract body delimiter 미종료 | The imagine declaration or contract body is not terminated. | 누락된 closing delimiter를 추가한다. |
| CHZ1008 | 예약됐지만 Phase 0에서 미지원인 imagine kind | This imagine declaration kind is reserved but not supported by the Phase 0 grammar. | 이번 단계에서는 `imagine function` 또는 `imagine class`를 쓴다. |
| CHZ2001 | `requirements` 인자가 정적 문자열 하나가 아님 | requirements(...) must receive exactly one static string. | string literal 또는 치환 없는 template literal 하나만 넘긴다. |

commit 자체가 실패하여 CHZ1001/1002/1005/1007/1008이 생긴 경우,
half-neutralized source에서 따라 나오는 TS parser cascading diagnostic은
수거하지 않는다. 반대로 plain TypeScript는 원본 그대로 Program에 넣고 모든
syntactic diagnostic의 code/text/offset을 그대로 반환한다. malformed imagine
signature의 첫 TypeScript syntax 오류만 CHZ1003으로 승격한다.

## 3. contextual keyword commit 규칙 실측

TypeScript scanner를 `skipTrivia: true`로 사용하고 token의
`hasPrecedingLineBreak()`를 함께 기록했다. scanner는 `/`를 문맥 없이
regex로 확정하지 않으므로, expression을 끝낼 수 없는 token 뒤의 slash에만
`reScanSlashToken()`을 호출한다. template interpolation은 brace depth stack을
두고 `reScanTemplateToken()`으로 tail까지 한 token으로 유지했다. 이 두
처리가 없으면 regex/template 안의 가짜 `imagine`이 token stream 밖으로
새어 나온다.

statement/class-member 시작 위치의 raw token text가 정확히 `imagine`일 때만
commit 후보가 된다. `\u0069magine`처럼 escape로 같은 identifier value를
만든 경우에는 ordinary TypeScript identifier다.

commit 판정은 문서대로 blacklist다. 다음 token에 line terminator가 있거나
아래 닫힌 집합에 속할 때만 ordinary identifier로 남는다.

- 호출·접근: `(`, `.`, `?.`, `[`, `<`, no-substitution/template head
- 대입·연산: 단순/복합 대입, 산술/shift/비교/equality/bit/logical,
  `??`, `?`, `:`
- 타입 연산: `as`, `satisfies`, `instanceof`, `in`
- 후위·단언: `++`, `--`, `!`
- 문 경계: `;`, `,`, `)`, `]`, `}`, EOF
- 줄바꿈: `imagine`과 다음 token 사이의 line terminator

`<`는 comparison과 `imagine<Preview>(seed)` 양쪽을 포괄하는 cancel token이다.
tagged template는 scanner가 backtick 하나가 아니라 template literal token을
반환한다는 API 형상에 맞춰 두 template token kind를 blacklist에 넣었다.

fixture로 고정한 경계는 다음과 같다.

- `positive-commit-call-access.ts.fixture`: call, property/optional/element
  access, generic call, tagged template
- `positive-commit-assignment-operators.ts.fixture`: assignment, arithmetic,
  comparison, logical, conditional
- `positive-commit-type-operators.ts.fixture`: `as`, `satisfies`,
  `instanceof`, `in`
- `positive-commit-postfix.ts.fixture`: postfix와 non-null assertion
- `positive-commit-boundaries.ts.fixture`,
  `positive-commit-eof.ts.fixture`: statement/closing boundary와 EOF
- `positive-commit-linebreak.ts.fixture`: restricted-production line break
- `negative-duplicate-imagine.chz.fixture`,
  `negative-misspelled-kind.chz.fixture`: commit 이후 `null` fallback이
  없음을 확인하는 negative pair

`imagine imagine imagine function x(): void {}`는 첫 token에서 commit되고
두 번째 `imagine`의 원본 위치(line 2, column 9)에서 CHZ1001 하나로
결정적으로 실패한다.

## 4. JSX와 `<` 판정 비용

`unsupported-jsx.chz.tsx.fixture`에는 generic arrow의 `<T,>`와 실제 JSX
`<span>`을 함께 넣었다. TypeScript raw parse 비용을 보기 위해 `imagine`
token만 같은 길이의 공백으로 바꾼 source 40개를 한 snapshot에 열고,
TS/TSX 확장자를 번갈아 8회 측정했다.

측정 결과:

- `.ts` median: 36.67 ms / 40 files
- `.tsx` median: 36.96 ms / 40 files
- median 차이: TSX가 약 0.78% 느림
- 같은 fixture를 `.ts`로 읽으면 JSX 때문에 file당 syntactic diagnostic
  1개, `.tsx`에서는 0개
- 첫 `.ts` 측정에는 API warm-up으로 205.60 ms outlier가 있었으므로 median을
  사용했다.

이 수치는 작은 fixture와 현재 장비에 한정된 microbenchmark다. 그래도
ScriptKind에 따른 `<` 판정 자체의 관측 비용은 snapshot startup/Program
구성 비용보다 작았다. 성능 때문에 Cheese가 TSX ambiguity를 자체 판정할
이유는 없다. `.chz.tsx` milestone에서도 확장자로 `ScriptKind.TSX`를 고르고
TypeScript parser에 맡기는 편이 맞다.

Phase 0에서는 `scriptKindForFileName()`까지 준비했지만 `.chz.tsx` 입력은
CHZ1006으로 명시적으로 막는다. TypeScript 7 native parser는 알려지지 않은
virtual filename 확장자에서 ScriptKind를 추론하지 못하면 panic할 수 있었기
때문에, virtual source 이름도 반드시 `.ts`/`.tsx`/`.d.ts`로 끝내야 한다.

## 5. Phase 1 승격 권고

예정된 정식 경계로 옮길 때는 다음 순서가 안전하다.

1. `syntax.ts`: 현재 `spike/syntax.ts`의 span/overlay model을 옮기되,
   public model은 Program snapshot lifetime을 명시한다.
2. `diagnostics.ts`: 이번에 확정한 code table과
   `getLineAndCharacterOfPosition()` 경로를 그대로 승격한다.
3. `projection.ts`: UTF-16/line-preserving replacement와 origin island
   source 생성을 옮긴다. replacement overlap은 hard failure로 유지한다.
4. `typescript.ts`: 지금처럼 호출마다 API process/snapshot을 만드는 spike
   lifecycle 대신 파일 batch 단위 Program lifecycle을 소유한다.
5. `parser.ts`: commit blacklist를 하나의 token table로 유지한다.
   현재 `looksLikeContractBody()`는 feasibility용 body locator이므로 정식
   parser에서는 TypeScript AST binding과 복구 전략을 더 명시적으로 나눈다.
6. `analyze.ts`: Cheese shell → projection → TS diagnostics → AST binding →
   contract shape 순서를 하나의 preflight entry로 고정한다.

`src/compiler/ts-api.ts`는 현재 production consumer가 실제로 쓰는 symbol과
spike가 쓰는 scanner/AST predicate/API type을 모두 type/value로 나눠
재수출한다. Phase 0 지시대로 `src/human-code.ts`와
`src/realizer/tools/verification.ts`는 아직 직접 import를 유지한다.
Phase 1에서 두 파일을 이 경계로 옮긴 뒤에야 repository 전체의
`typescript/unstable/*` 직접 import가 진짜 한 파일로 수렴한다.

fixture 파일은 invalid TypeScript도 포함하므로 `tsconfig`의 `src/**/*.ts`
수집을 피하기 위해 `.fixture` suffix를 사용하고, `manifest.json`에서 실제
논리 확장자와 성공/진단 code/원본 line-column을 데이터로 고정했다. 정식
parser 테스트도 이 corpus를 그대로 읽는 편이 좋다.

## 6. 260726-00 문서와 어긋난 사실

한 가지가 확인됐다.

- §3.1은 class body direct contract statement와 imagined property contract
  body를 “길이 보존이 불가능한 두 구문”으로 분류한다. 실측상 main projection
  placeholder 자체는 첫 non-newline code unit을 `;`로 바꾸고 나머지를
  공백으로 만들면 **UTF-16 길이와 줄바꿈을 모두 보존하면서 valid
  TypeScript**가 된다. 별도 island가 여전히 필요한 이유는 길이가 아니라,
  contract expression AST가 main projection에서 사라지기 때문이다.

정본 문서는 이번 Phase에서 수정하지 않았다. Phase 1 문서 갱신 때
“길이 보존 불가능”을 “main AST와 contract AST를 동시에 보존 불가능”으로
고치는 것이 정확하다.

## 7. 구현을 끝낸 뒤 추가로 확인된 사실 (2026-07-27)

Phase 1~4를 끝낸 뒤, 스파이크 단계에서는 보이지 않던 것들이 드러났다.

### 7.1 projection은 `imagine`을 공백이 아니라 `declare`로 바꾼다

스파이크는 §1에서 "`imagine` 토큰을 같은 길이의 공백으로 바꾼다"고 적었다.
production projection은 top-level `imagine function/class`에 한해 **같은 길이의
`declare`**로 바꾼다. 두 토큰 모두 UTF-16 7 code unit이다.

- `export imagine` → `export declare`
- imagine class 내부의 imagined method/property에 붙은 `imagine`, 그리고
  imagined `async` modifier는 ambient stub 호환을 위해 공백 처리
- `@profile`도 공백 처리
- 계약 body와 class-level 계약 statement는 첫 위치에 `;`를 남기는 placeholder

`declare`를 쓰는 이유는 human 코드가 **아직 실현되지 않은 심볼을 상대로
타입 검사를 받을 수 있어야** 하기 때문이다. 공백으로만 바꾸면 계약 body가
사라진 함수가 "본문 없는 일반 선언"이 되어 TypeScript가 구현을 요구한다.

### 7.2 island는 세 종류다

§1은 island를 class-level contract와 imagined property contract 둘로 봤다.
실제 `ProjectionIslandKind`는 셋이다.

| kind | 원본 구문 |
|---|---|
| `class-contract-statement` | imagine class 바로 아래의 `requirements`/`ensure` 한 문장 |
| `callable-contract-body` | top-level imagine function과 imagined method의 계약 본문 |
| `property-contract-body` | imagined property의 계약 본문 |

7.1의 결과다. `declare` 선언에는 본문이 올 수 없어 callable의 계약 본문도
main projection에서 사라지므로, 그쪽에도 origin-mapped island가 필요하다.

### 7.3 반환 타입 주석을 필수로 만들었다 (CHZ1009)

7.1의 ambient stub은 반환 타입 주석이 없으면 `TS7010`을 낸다. 원본이 짓지
않은 진단이므로 제외 목록에 넣는 안이 먼저 나왔지만, 260726-00 §6의
"인위적인 TS diagnostic을 suppression 목록으로 숨기지 않는다"에 어긋난다.

사용자 결정으로 **문법 쪽을 바꿨다.** imagine callable과 property는 타입
주석이 필수이며, 없으면 CHZ1009다. 반환값이 없으면 `: void`를 쓴다. 공식
예제 중 `phone-number-normalizer.chz.ts` 하나가 걸려 `: string`을 추가했다.

### 7.4 `declare class` 안의 human 멤버 — 유일하게 남은 예외

`imagine class`가 `declare class`가 되면, 같은 클래스 안의 **human이 직접
구현한 멤버**가 ambient context 위반으로 잡힌다.

- `TS1036` statements are not allowed in ambient contexts
- `TS1039` initializers are not allowed in ambient contexts
- `TS1040` modifier is not allowed in an ambient context
- `TS1183` an implementation cannot be declared in ambient contexts

human 멤버는 `docs/00-chz-intro.ko.md`가 명시적으로 약속한 기능이므로
문법을 좁혀 해결할 수 없다(7.3과 달리 선택지가 없다). 계약 본문은 `{}`처럼
짧을 수 있어, 길이를 보존하면서 임의의 반환 타입을 만족시키는 본문을 끼워
넣는 것도 불가능하다.

사용자 결정으로 **이 네 코드만, human 멤버 span 안에서만 제외**한다. 같은
멤버 안의 일반 타입 오류는 그대로 보고된다. **§6의 suppression 금지 원칙에
대한 유일한 예외이며, 다른 예외는 없다.** 늘리려면 같은 수준의 근거 —
"문법으로는 해결할 수 없고, 길이 보존과 양립하지 않는다" — 가 필요하다.

### 7.5 CHZ1004가 클래스 멤버 선언까지 막고 있었다

260726-00 §4.1은 "계약 body 최상위의 **statement**"를 제한했는데, 구현이
클래스 본문 전체에 적용해 human 멤버 선언까지 거부했다. 00 문서의
`collisionDetection2D` 예제가 파싱되지 않는 상태였다.

멤버 선언은 statement가 아니다. 판정을 "TypeScript가 클래스 멤버로
파싱했는가"로 바꿔 고쳤다. 허용 목록을 두지 않은 이유는, 새 멤버 문법이
생길 때마다 같은 버그가 재발하기 때문이다. 클래스 본문의 statement는 계속
CHZ1004이며, positive/negative fixture 짝으로 고정했다.
