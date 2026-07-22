/// 충돌판정_2D.ts
/// realization of `imagine function 충돌판정_2D(a: Shape, b: Shape): boolean`
/// realized by claude CLI (default model) (via chz-realize) on 2026-07-22T18:53:49.214Z
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

// 도형 모델 타입. 원본 collision.chz.ts의 선언과 동일한 구조를 재정의합니다.
// ASSUMPTION: 이 구현 파일이 단독으로 strict 모드에서 컴파일될 수 있도록,
// 원본의 Point/Circle/Rectangle/Shape 타입을 여기에 다시 선언하고 export 합니다.
// (원본은 .chz.ts 전처리 대상 파일이라 평범한 TS 모듈로 import 한다고 보장할 수
//  없기 때문입니다. 형태가 정확히 일치하므로 동작상 차이는 없습니다.)

/** 2D 평면 위의 한 점. */
export interface Point {
  x: number;
  y: number;
}

/** 중심(center)과 반지름(radius)으로 정의되는 원. */
export interface Circle {
  kind: "circle";
  center: Point;
  radius: number;
}

/** 좌상단 좌표(origin)와 너비/높이로 정의되는 축 정렬 사각형(AABB). */
export interface Rectangle {
  kind: "rectangle";
  origin: Point; // 좌상단 꼭짓점
  width: number;
  height: number;
}

/** 충돌 판정의 대상이 되는 도형. 원 또는 사각형의 판별 유니온. */
export type Shape = Circle | Rectangle;

/**
 * 두 2D 도형(원 또는 축 정렬 사각형)이 겹치는지 판정합니다.
 *
 * [요구사항 해석]
 * - 도형은 `kind` 필드로 구분되는 판별 유니온(Circle | Rectangle)이며,
 *   원-원 / 사각형-사각형 / 원-사각형 세 조합을 모두 처리해야 합니다.
 * - "인자 순서와 무관하게 동작"해야 하므로, 원-사각형 조합은 어느 쪽이 원이든
 *   항상 (원, 사각형) 순서로 정규화하여 단 하나의 경로(circleRect)로 계산합니다.
 *   이렇게 하면 대칭성이 알고리즘 구조상 자동으로 보장됩니다.
 * - "조금이라도 겹치면 true, 경계가 정확히 맞닿기만 해도 true"라는 규칙을 위해,
 *   모든 거리/구간 비교에서 '<'가 아닌 '<='(등호 포함) 또는 그와 동치인 조건을
 *   사용합니다. 즉 경계 접촉(한 점 접촉 포함)은 항상 '겹침'으로 간주합니다.
 * - 부동소수점 오차를 줄이기 위해, 원이 관여하는 거리 비교는 제곱근을 쓰지 않고
 *   '거리의 제곱 vs 반지름의 제곱'으로 비교합니다(정수 입력에서는 정확히 일치).
 *
 * [계약 대응]
 * - ensure #1 (retval은 boolean): 도달 가능한 모든 반환 지점이 비교 연산(<=, ||)의
 *   결과인 boolean이므로 항상 boolean을 반환합니다.
 * - ensure #2 (완전히 동일한 두 원은 충돌): 동일한 원은 중심 거리 0, 반지름 합은
 *   양수이므로 `0 <= (r+r)^2` 가 참 → true. 이는 circleCircle 경로가 보장합니다.
 * - 자연어 계약도 함께 충족됩니다:
 *   · (멀리 떨어짐 → false) 거리/구간이 완전히 분리되면 각 분기가 false를 반환.
 *   · (대칭성) 위에서 설명한 (원, 사각형) 정규화 + 좌우 대칭 조건식으로 보장.
 *   · (경계 한 점 접촉 → true) 등호 포함 비교로 접촉 지점을 겹침으로 처리.
 */
export function 충돌판정_2D(a: Shape, b: Shape): boolean {
  // 조합별로 분기합니다. 아래 네 분기는 (Circle|Rectangle) × (Circle|Rectangle)의
  // 모든 경우를 남김없이 망라합니다.
  if (a.kind === "circle" && b.kind === "circle") {
    return circleCircle(a, b);
  }
  if (a.kind === "rectangle" && b.kind === "rectangle") {
    return rectRect(a, b);
  }
  // 남은 경우는 정확히 한쪽이 원, 다른 쪽이 사각형입니다.
  // 어느 순서로 들어오든 (원, 사각형) 순으로 정규화하여 동일한 경로로 처리합니다.
  if (a.kind === "circle" && b.kind === "rectangle") {
    return circleRect(a, b);
  }
  if (a.kind === "rectangle" && b.kind === "circle") {
    return circleRect(b, a);
  }

  // 위 네 분기가 모든 도형 조합을 망라하므로 이 지점에는 도달할 수 없습니다.
  // (Shape는 Circle | Rectangle 두 종류뿐입니다.) 방어적으로 명시적 오류를 던져,
  // 만약 도형 종류가 늘어나 처리 누락이 생기면 조용히 통과하지 않고 드러나게 합니다.
  throw new Error("도달 불가능: 처리되지 않은 도형 조합입니다.");
}

/**
 * 원-원 충돌: 두 중심 사이 거리가 반지름의 합보다 작거나 같으면 겹칩니다.
 * 등호(=)를 포함하므로 경계가 정확히 맞닿는 경우도 true입니다.
 */
function circleCircle(a: Circle, b: Circle): boolean {
  const dx = a.center.x - b.center.x;
  const dy = a.center.y - b.center.y;
  const 거리제곱 = dx * dx + dy * dy;
  const 반지름합 = a.radius + b.radius;
  // 제곱근을 피하기 위해 양변을 제곱하여 비교합니다(반지름합 >= 0 이므로 등가).
  return 거리제곱 <= 반지름합 * 반지름합;
}

/**
 * 사각형-사각형(AABB) 충돌: 두 사각형을 각각 x축 구간과 y축 구간으로 보고,
 * 어느 한 축이라도 완전히 분리되어 있으면 겹치지 않습니다(false).
 * 두 축 모두 구간이 겹치거나 맞닿으면 겹칩니다(true).
 */
function rectRect(a: Rectangle, b: Rectangle): boolean {
  // ASSUMPTION: width/height는 양수라고 가정합니다(요구사항에서 명시적으로 허용).
  // 따라서 오른쪽/아래 경계는 항상 왼쪽/위 경계보다 큽니다.
  const aLeft = a.origin.x;
  const aRight = a.origin.x + a.width;
  const aTop = a.origin.y;
  const aBottom = a.origin.y + a.height;

  const bLeft = b.origin.x;
  const bRight = b.origin.x + b.width;
  const bTop = b.origin.y;
  const bBottom = b.origin.y + b.height;

  // ASSUMPTION: origin이 '좌상단'이지만 y축의 방향(위/아래)이 무엇이든 AABB 겹침
  // 판정 결과는 동일합니다. 각 축을 단순한 수치 구간 [min, max]로 다루기 때문입니다.

  // 한 축이라도 '완전히' 분리되면(경계가 닿지도 않으면) 비충돌.
  // '<'를 사용하므로 aRight === bLeft(변이 정확히 접함)는 분리로 보지 않아 true가 됩니다.
  if (aRight < bLeft || bRight < aLeft) {
    return false; // x축 구간이 서로 떨어져 있음
  }
  if (aBottom < bTop || bBottom < aTop) {
    return false; // y축 구간이 서로 떨어져 있음
  }
  // 두 축 모두 구간이 겹치거나 맞닿음 → 겹침.
  return true;
}

/**
 * 원-사각형 충돌: 사각형 내부(경계 포함)에서 원의 중심에 가장 가까운 점을 구한 뒤,
 * 그 점과 중심 사이 거리가 반지름보다 작거나 같으면 겹칩니다.
 * 가장 가까운 점은 중심 좌표를 사각형의 각 축 구간으로 클램프하여 구합니다.
 */
function circleRect(circle: Circle, rect: Rectangle): boolean {
  const left = rect.origin.x;
  const right = rect.origin.x + rect.width;
  const top = rect.origin.y;
  const bottom = rect.origin.y + rect.height;

  // 사각형 영역 안에서 원의 중심에 가장 가까운 점.
  // - 중심이 사각형 안에 있으면 가장 가까운 점 = 중심(거리 0) → 무조건 겹침.
  // - 중심이 밖에 있으면 가장 가까운 변 또는 꼭짓점 위의 점이 선택됩니다.
  const nearestX = clamp(circle.center.x, left, right);
  const nearestY = clamp(circle.center.y, top, bottom);

  const dx = circle.center.x - nearestX;
  const dy = circle.center.y - nearestY;
  const 거리제곱 = dx * dx + dy * dy;

  // 등호 포함 비교이므로, 원이 변/꼭짓점에 '정확히 한 점'으로만 닿는 경우도 true.
  return 거리제곱 <= circle.radius * circle.radius;
}

/** value를 [min, max] 구간으로 제한(클램프)합니다. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/// END OF AUTO-GENERATED CODE
