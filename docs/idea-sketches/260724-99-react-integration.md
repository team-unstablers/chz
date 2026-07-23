# '치즈기여어'로 React 컴포넌트 작성을 요청해보자!

```typescript jsx chz
/// star-rating.chz.tsx
// React 통합 스케치용 예제 — 별점(StarRating) 위젯.
//
// 사람은 props 계약과 상호작용 계약(ensure)만 선언하고, 마크업·상태 관리·
// 이벤트 처리는 `chz realize` 단계에서 LLM이 구현합니다.

import React, { useState } from "react";

// NOTE: 아래 두 import는 ensure 시나리오에서만 사용됩니다. `*.ensure.ts`로
// 추출될 때 이 import를 어떻게 따라 보낼지는 열린 질문입니다. (하단 참고)
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** StarRating 컴포넌트의 props. */
interface StarRatingProps {
  /** 현재 별점. 0 이상 5 이하의 정수. */
  value: number;
  /** n번째 별을 클릭했을 때 onChange(n)으로 호출됩니다. */
  onChange?: (next: number) => void;
  /** true이면 표시 전용으로 동작하며 클릭에 반응하지 않습니다. */
  readonly?: boolean;
}

imagine function StarRating(props: StarRatingProps): React.JSX.Element {
  requirements(`
    # 5개의 별로 별점을 표시하고 입력받는 React 컴포넌트를 구현하십시오.

    ## 표시
    - 별 5개를 왼쪽부터 렌더링하고, value개만큼 채워진 별(★)로,
      나머지는 빈 별(☆)로 표시합니다.
    - 접근성: 전체는 role="radiogroup", 각 별은 role="radio"로 노출하며,
      value번째 별에만 aria-checked="true"를 부여합니다.
    - n번째 별의 접근 가능한 이름(accessible name)은 "n점"입니다.

    ## 상호작용
    - n번째 별을 클릭하면 onChange(n)을 호출합니다. (1 <= n <= 5)
    - 자신의 상태를 갖지 않는 controlled 컴포넌트입니다. 클릭해도 스스로
      표시를 바꾸지 않으며, 부모가 value를 갱신해야 표시가 바뀝니다.
    - readonly이면 클릭해도 onChange를 호출하지 않습니다.
  `);

  ensure("value만큼 채워진 별을 aria-checked로 확인할 수 있습니다.", () => {
    render(<StarRating value={3} />);

    const 별들 = screen.getAllByRole("radio");
    assert(별들.length === 5);
    assert(별들[2]!.getAttribute("aria-checked") === "true");
  });

  ensure("3번째 별을 클릭하면 onChange(3)이 호출됩니다.", async () => {
    let picked = -1;
    render(<StarRating value={0} onChange={(n) => { picked = n; }} />);

    await userEvent.click(screen.getByRole("radio", { name: "3점" }));
    assert(picked === 3);
  });

  ensure("readonly이면 클릭해도 onChange가 호출되지 않습니다.", async () => {
    let called = false;
    render(
      <StarRating value={2} readonly onChange={() => { called = true; }} />,
    );

    await userEvent.click(screen.getByRole("radio", { name: "5점" }));
    assert(called === false);
  });
}

// --- 최소 배선 코드: realize된 컴포넌트를 사용하는 사람 쪽 코드입니다. ---

export function 리뷰폼() {
  const [별점, set별점] = useState(0);

  return (
    <section>
      <h2>이 치즈, 몇 점이었나요?</h2>
      <StarRating value={별점} onChange={set별점} />
      <p>{별점 > 0 ? `${별점}점을 선택했습니다.` : "별을 눌러 평가해 주세요."}</p>
    </section>
  );
}
```

## 이 예시가 드러내는 설계 질문

- **파일 확장자와 JSX** — `.chz.ts`가 아니라 `.chz.tsx`가 필요한가? 전처리기는
  선언 수준에서만 동작하므로 JSX 파싱 자체는 TS 컴파일러 API가 처리하겠지만,
  사이드카 심(doc 20)도 `.tsx`로 내보내야 하는지, 사용자 tsconfig의 `jsx`
  옵션을 realize 파이프라인이 어떻게 존중할지가 남는다.
- **ensure 실행 환경** — 지금 ensure는 vitest node 환경에서 돈다. 컴포넌트
  ensure는 jsdom + @testing-library가 필요한데, 이걸 chz.config.js에서
  명시하게 할지, `@profile react` 같은 프로필이 자동으로 준비해 줄지.
- **ensure 전용 import** — `render`/`userEvent`처럼 계약에서만 쓰는 import를
  본 파일 상단에 두면 프로덕션 코드에 테스트 의존성이 섞인다. `*.ensure.ts`
  추출 시 import를 따라 보내고 본체에서는 제거하는 재배치 규칙이 필요하다.
- **boolean형 ensure의 한계** — 컴포넌트 계약은 대부분 render 준비가 필요해서
  짧은 boolean형(`ensure(식, 메시지)`)은 사실상 쓸 수 없고, scenario형이
  기본이 된다. 문법 문서에서 이 비대칭을 인정해 둘 것.
- **@profile의 경계** — realize된 컴포넌트가 useEffect 안에서 fetch를 해도
  되는가? react 프로필의 허용 API(DOM, 이벤트, 훅)와 금지 API(네트워크,
  스토리지)의 경계를 어디에 긋고 어떻게 검사할지.
- **시각 속성 검증의 한계** — "채워진 별" 같은 시각적 사실은 ensure로 직접
  검증하기 어렵다. 이 예시는 aria 속성이라는 계약 가능한 표면으로 우회했는데,
  이것이 일반화되는 패턴인지는 `imagine resource`의 검증 문제와 맞닿아 있다.
