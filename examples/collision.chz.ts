/// collision.chz.ts
// chz(치즈기여어)의 공식 첫 예제 — 2D 충돌 판정.
//
// '치즈기여어'는 TypeScript의 슈퍼셋이므로, 아래 타입 정의는 전부 평범한
// TypeScript입니다. 사람은 도형 모델과 계약(ensure)만 선언하고, 실제 충돌
// 판정 알고리즘은 `chz realize` 단계에서 LLM이 구현합니다.

/** 2D 평면 위의 한 점. */
interface Point {
  x: number;
  y: number;
}

/** 중심(center)과 반지름(radius)으로 정의되는 원. */
interface Circle {
  kind: "circle";
  center: Point;
  radius: number;
}

/** 좌상단 좌표(origin)와 너비/높이로 정의되는 축 정렬 사각형(AABB). */
interface Rectangle {
  kind: "rectangle";
  origin: Point; // 좌상단 꼭짓점
  width: number;
  height: number;
}

/** 충돌 판정의 대상이 되는 도형. 원 또는 사각형의 판별 유니온. */
type Shape = Circle | Rectangle;

imagine function 충돌판정_2D(a: Shape, b: Shape): boolean {
  requirements(`
    # 두 2D 도형의 충돌(겹침) 여부를 판정하는 함수를 구현하십시오.

    ## 도형 모델
    - 도형은 '원'(circle) 또는 '축 정렬 사각형'(rectangle) 두 종류이며,
      \`kind\` 필드로 구분되는 판별 유니온입니다.
    - 원은 중심 좌표(center)와 반지름(radius)을 가집니다.
    - 사각형은 좌상단 꼭짓점(origin)과 너비(width)/높이(height)를 가집니다.
      width, height는 양수라고 가정해도 됩니다.

    ## 판정 규칙
    - 다음 세 가지 조합을 모두 처리해야 합니다: 원-원, 사각형-사각형,
      원-사각형(인자 순서와 무관하게 동작해야 합니다).
    - 두 도형이 조금이라도 겹치면 true, 한 점도 공유하지 않으면 false를 반환합니다.
    - 경계가 정확히 맞닿기만 한 경우(두 원의 중심 거리가 반지름의 합과 같거나,
      사각형의 변이 정확히 접하는 경우)도 '겹침'으로 간주하여 true를 반환합니다.
  `);

  // 짧은 계약은 assert처럼 boolean 식으로 직접 작성합니다.
  ensure(
    충돌판정_2D(
      { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
      { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
    ) === true,
    "완전히 동일한 두 원은 충돌해야 합니다.",
  );

  // 준비 과정이나 여러 assertion이 필요한 계약은 실행 가능한 scenario로 작성합니다.
  ensure("멀리 떨어진 두 도형은 충돌하지 않습니다.", () => {
    const 원: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 1 };
    const 사각형: Shape = {
      kind: "rectangle",
      origin: { x: 10, y: 10 },
      width: 2,
      height: 2,
    };

    assert(충돌판정_2D(원, 사각형) === false);
  });

  ensure("충돌 판정은 인자 순서에 대해 대칭입니다.", () => {
    const 원: Shape = { kind: "circle", center: { x: 2, y: 2 }, radius: 2 };
    const 사각형: Shape = {
      kind: "rectangle",
      origin: { x: 3, y: 1 },
      width: 3,
      height: 3,
    };

    assert(충돌판정_2D(원, 사각형) === 충돌판정_2D(사각형, 원));
  });

  ensure("원과 사각형이 한 점에서 맞닿으면 충돌입니다.", () => {
    const 원: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 2 };
    const 사각형: Shape = {
      kind: "rectangle",
      origin: { x: 2, y: -1 },
      width: 2,
      height: 2,
    };

    assert(충돌판정_2D(원, 사각형) === true);
  });
}

// --- 최소 배선 코드: realize된 함수를 호출하여 결과를 콘솔에 출력합니다. ---

const 원A: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
const 사각형B: Shape = { kind: "rectangle", origin: { x: 3, y: 3 }, width: 4, height: 4 };

const 충돌여부 = 충돌판정_2D(원A, 사각형B);
console.log(`충돌 여부: ${충돌여부}`);
