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



// --- 최소 배선 코드: realize된 함수를 호출하여 결과를 콘솔에 출력합니다. ---

const 원A: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
const 사각형B: Shape = { kind: "rectangle", origin: { x: 3, y: 3 }, width: 4, height: 4 };

export { Point, Circle, Rectangle, Shape, 원A, 사각형B };
