# Realize

# 자동 생성된 코드 예시

realize 과정에서 LLM은 단순히 '동작하는 코드'를 작성하는 것이 아니라, **사람이 감사(audit)할 수 있는 코드**를 작성하는 것을 목표로 합니다. 따라서 realize 산출물은 다음을 반드시 포함합니다:

- 요구사항을 어떻게 해석했는지, 각 단계가 무엇을 하는지 설명하는 **상세 주석**
- 요구사항이 애매하여 LLM이 임의로 가정한 지점을 표시하는 **인라인 `ASSUMPTION:` 주석** — 별도로 emit되는 ASSUMPTIONS 리포트와 연동되며, 애매함이 조용히 해소되지 않고 사람 눈에 보이게 합니다.

```typescript
/// payDepositInterest.ts
/// realization of `imagine function payDepositInterest(account: DepositAccount, baseRate: number): InterestStatement`
/// realized by claude-opus-4.8 (via chz-realize) on 2026-07-23T12:34:56Z

/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

/**
 * 예금 계좌에 이자를 지급하고, 지급 내역서를 반환합니다.
 *
 * [요구사항 해석]
 * - 예치 일수(account.depositDays)에 대한 이자를 단리로 계산합니다.
 * - 이자소득세를 원천징수한 후, 세후 이자만 잔액에 반영합니다.
 *
 * [계약 대응]
 * - ensure: 내역서의 netInterest는 interest - tax와 일치해야 합니다.
 */
function payDepositInterest(account: DepositAccount, baseRate: number): InterestStatement {
  // ASSUMPTION: 연 기준 일수는 365일로 가정합니다.
  // (요구사항에 윤년 처리나 360일 관례에 대한 언급이 없습니다.)
  const DAYS_IN_YEAR = 365;

  // 이자소득세율 15.4% (소득세 14% + 지방소득세 1.4%).
  // ASSUMPTION: 세율은 대한민국 기준으로 고정했습니다.
  // 세율 변경 가능성이 있다면 파라미터로 분리하는 것을 권장합니다.
  const TAX_RATE = 0.154;

  // 연이율을 일이율로 환산한 뒤, 예치 일수만큼 단리 이자를 계산합니다.
  const dailyRate = baseRate / DAYS_IN_YEAR;

  // ASSUMPTION: 이자는 원 단위 미만을 절사(floor)합니다.
  // (반올림 규칙이 요구사항에 명시되어 있지 않습니다.)
  const interest = Math.floor(account.balance * dailyRate * account.depositDays);

  // 세액도 동일하게 원 단위 미만을 절사하고, 세후 이자를 구합니다.
  const tax = Math.floor(interest * TAX_RATE);
  const netInterest = interest - tax;

  // 세액은 원천징수하므로, 세후 이자만 잔액에 반영합니다.
  account.balance += netInterest;

  // 지급 내역서를 반환합니다. paidAt은 지급 처리 시각입니다.
  return {
    accountId: account.id,
    interest,
    tax,
    netInterest,
    paidAt: new Date(),
  };
}
/// END OF AUTO-GENERATED CODE
```

## 하지만 동작을 바꾸고 싶어요

LLM이 만든 코드는 요구사항과 계약을 기반으로 생성되었지만, 때로는 동작을 더 구체화하거나 변경하고 싶을 수 있습니다. 이럴 때는 다음과 같이 진행할 수 있습니다:

- `@chz-realize-override` 주석을 사용하여, LLM이 생성한 코드의 특정 부분을 직접 수정하거나 추가할 수 있습니다.
  - 이 주석은 **바로 다음의 statement 하나**를 사용자가 소유한 코드로 **고정**합니다. LLM은 이 statement를 수정하거나 삭제할 수 없으며, 재-realize 시에도 그대로 보존됩니다.
  - 경계는 주석의 위치가 아니라 구문 트리(AST) 기준으로 결정되므로, 코드 포매터에 안전합니다.
  - 마커 뒤에 `:`를 붙여 오버라이드의 의도를 설명할 수 있습니다 (예: `// @chz-realize-override: 세율을 35%로 변경합니다.`). 새 statement를 추가하는 것뿐 아니라, LLM이 생성한 statement를 직접 수정한 뒤 마커를 붙여 사람 소유로 전환하는 것도 가능합니다.

```typescript
/// payDepositInterest.ts
/// realization of `imagine function payDepositInterest(account: DepositAccount, baseRate: number): InterestStatement`
/// realized by claude-opus-4.8 (via chz-realize) on 2026-07-23T12:34:56Z

/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

/**
 * 예금 계좌에 이자를 지급하고, 지급 내역서를 반환합니다.
 *
 * [요구사항 해석]
 * - 예치 일수(account.depositDays)에 대한 이자를 단리로 계산합니다.
 * - 이자소득세를 원천징수한 후, 세후 이자만 잔액에 반영합니다.
 *
 * [계약 대응]
 * - ensure: 내역서의 netInterest는 interest - tax와 일치해야 합니다.
 */
function payDepositInterest(account: DepositAccount, baseRate: number): InterestStatement {
  // @chz-realize-override: 예금주가 '치즈군'인 경우에만 이율을 2배로 적용합니다. 
  if (account.ownerName === "치즈군") {
    baseRate *= 2;
  }

  // ASSUMPTION: 연 기준 일수는 365일로 가정합니다.
  // (요구사항에 윤년 처리나 360일 관례에 대한 언급이 없습니다.)
  const DAYS_IN_YEAR = 365;
  
  // @chz-realize-override: 세율을 35%로 변경합니다.
  const TAX_RATE = 0.35;

  // 연이율을 일이율로 환산한 뒤, 예치 일수만큼 단리 이자를 계산합니다.
  const dailyRate = baseRate / DAYS_IN_YEAR;

  // ASSUMPTION: 이자는 원 단위 미만을 절사(floor)합니다.
  const interest = Math.floor(account.balance * dailyRate * account.depositDays);

  // 세액도 동일하게 원 단위 미만을 절사하고, 세후 이자를 구합니다.
  const tax = Math.floor(interest * TAX_RATE);
  const netInterest = interest - tax;

  // 세액은 원천징수하므로, 세후 이자만 잔액에 반영합니다.
  account.balance += netInterest;

  // @chz-realize-override: 여러 statements를 추가해야 한다면, 블록 구문을 사용하세요.
  {
    // :blobowoevil:
    const auditRecord = {
      accountId: account.id,
      appliedRate: baseRate,
      paidInterest: interest,
    };
    fetch("https://big.brother:1984/interest-payments", {
      method: "POST",
      body: JSON.stringify(auditRecord),
    });
  }

  // 지급 내역서를 반환합니다. paidAt은 지급 처리 시각입니다.
  return {
    accountId: account.id,
    interest,
    tax,
    netInterest,
    paidAt: new Date(),
  };
}
/// END OF AUTO-GENERATED CODE
```

> **NOTE**: 블록 구문(`{ }`)으로 그룹핑된 오버라이드 안에서 선언한 변수는 블록 밖에서 보이지 않습니다. 이는 의도된 설계로, LLM이 생성하는 코드가 사용자 오버라이드의 내부 구현에 의존할 수 없도록 격리하기 위함입니다. 오버라이드를 나중에 수정하거나 제거해도 재생성 코드는 깨지지 않습니다.

> **NOTE**: 재-realize 시 오버라이드 statement의 *내용*은 보존이 보장되지만, 재생성된 주변 코드 속에서의 *위치* 보존 규칙은 아직 설계 중입니다. (idea-sketch §4.8 참조)

## 마커 없이 직접 편집하면 어떻게 되나요?

`@chz-realize-override` 마커 없이 realize 산출물을 직접 수정하는 것("무단 드리프트")은 다음과 같이 처리됩니다:

- `realization-cache.json`에 기록된 해시와 실제 코드를 비교하여 드리프트를 감지합니다.
- 드리프트가 감지된 심볼은 **사람 편집 우선 원칙**에 따라 재-realize 대상에서 제외되며, 경고가 출력됩니다.
- `chz realize --adopt` 명령을 사용하면, 편집된 부분에 `@chz-realize-override` 마커를 자동으로 부착하여 정식 오버라이드로 편입할 수 있습니다.

## 오버라이드가 ensure 계약과 충돌하면 어떻게 되나요?

**기본적으로 계약이 이깁니다.**

- `ensure` 계약 테스트는 오버라이드를 포함한 최종 코드에 대해 실행되며, 실패하면 빌드가 실패합니다.
- 계약 역시 사람이 작성한 스펙입니다. 오버라이드와 계약이 충돌한다는 것은 '사람이 작성한 의도끼리의 모순'이며, 치즈는 이를 감추지 않고 드러냅니다. 오버라이드를 고치거나, 계약을 갱신하십시오.
- 단, `--skip-tests` 같은 옵션을 명시적으로 사용한 경우에는 검증을 건너뛰고 편집이 우선할 수 있습니다. 이 경우에도 경고는 출력됩니다.

## 사람이 작성한 코드는 어디에 저장되나요?

`chz build`와 CI는 커밋된 realization 디렉토리만으로 — LLM 호출 없이 — 빌드를
수행합니다. 따라서 realization 디렉토리는 그 자체로 완결된 TypeScript 컴파일
단위여야 하며, LLM이 생성한 구현뿐 아니라 **사람이 직접 작성한 코드의 사본**도
포함해야 합니다.

이때 사람 코드는 imagine 심볼과의 관계에 따라 두 파일로 나뉘어 저장됩니다
(00 문서의 `example.chz.ts` 기준):

```
chz/realization/example/implementations/
├── __prologue__.ts     # imagine 심볼을 참조하지 않는 사람 코드
├── greetLikePirate.ts  # realize 산출물 (imagine 심볼당 파일 하나)
├── ShootingGame.ts
└── __epilogue__.ts     # imagine 심볼을 참조하는 사람 코드
```

- **`__prologue__.ts`** — imagine 심볼이 없는, 원래부터 구현되어 있는 심볼들
  (타입 정의, 상수, 헬퍼 함수 등)이 모입니다. realize 산출물보다 **먼저**
  로드됩니다.
- **`__epilogue__.ts`** — imagine 심볼을 참조하는 사람 코드(배선 코드, 진입
  코드)가 모입니다. realize 산출물보다 **나중에** 로드됩니다.

세 층은 평범한 ES 모듈 import로 연결됩니다. `__prologue__.ts`를 realize
산출물들이 import하고, 그 산출물들을 `__epilogue__.ts`가 import하는 단방향
레이어링입니다. 이 레이어링에서 중요한 규칙 하나가 따라 나옵니다:

> **realize 산출물이 참조할 수 있는 사람 코드는 `__prologue__.ts`에 있는
> 것뿐입니다.** 구현이 `__epilogue__.ts`의 심볼을 참조하면 import가 순환하게
> 되므로, realize 단계에서 에러로 보고됩니다. 구현에게 보여주고 싶은 타입과
> 헬퍼는 imagine 심볼을 참조하지 않는 형태로 작성하여 prologue에 남게 하십시오.

또한 `.chz.ts` 원본이 여전히 유일한 source of truth입니다. prologue와
epilogue는 파생 산출물이므로 직접 수정해서는 안 되며(수정은 `.chz.ts`에서),
직접 편집은 위의 '무단 드리프트'와 동일하게 해시 비교로 감지됩니다.

> **NOTE (설계 중)**: 최상위(top-level)에서 부작용을 일으키는 문장들은 분할
> 후에도 소스에서의 상대 실행 순서가 보존되어야 합니다. 참조 여부만으로 나누면
> 순서가 보존되지 않는 배치가 존재합니다 — 예를 들어 imagine 심볼을 참조하는
> 문장 *뒤에* 놓인, 참조하지 않는 부작용 문장은 prologue로 끌려 올라가면서
> 실행 시점이 앞당겨집니다. 이런 배치를 에러로 보고할지, 순서를 보존하는 더
> 정교한 분할을 수행할지는 설계 중입니다.
