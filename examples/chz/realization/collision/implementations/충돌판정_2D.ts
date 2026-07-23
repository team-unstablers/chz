/// 충돌판정_2D.ts
/// realization of `imagine function 충돌판정_2D(a: Shape, b: Shape): boolean`
/// realized by x-ai/grok-4.5 (via chz-realize) on 2026-07-23T08:57:26.479Z
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

import type { Shape, Circle, Rectangle, Point } from "./__prologue__";

/**
 * 두 점 사이 거리의 제곱을 반환합니다.
 * 제곱근을 피하면 비교 시 부동소수점 오차와 비용을 줄일 수 있습니다.
 */
function distanceSquared(p: Point, q: Point): number {
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  return dx * dx + dy * dy;
}

/**
 * 원-원 충돌: 중심 거리 ≤ 반지름 합 이면 겹침(경계 맞닿음 포함).
 */
function circleCircleCollides(a: Circle, b: Circle): boolean {
  const rSum = a.radius + b.radius;
  // ASSUMPTION: radius는 0 이상이라고 가정합니다(음수 반지름은 스펙에 없음).
  return distanceSquared(a.center, b.center) <= rSum * rSum;
}

/**
 * 축 정렬 사각형(AABB) 끼리의 충돌.
 * 한 축이라도 완전히 분리되어 있으면 비충돌, 그 외(변/모서리 맞닿음 포함)는 충돌.
 *
 * 좌표계: origin은 좌상단. y가 아래로 증가하는지 위로 증가하는지는
 * 스펙에 명시되지 않으나, origin + height 가 반대편 y 경계라는 관례로 처리합니다.
 * ASSUMPTION: 사각형은 [origin.x, origin.x + width] × [origin.y, origin.y + height]
 * 닫힌 구간(closed interval)으로 취급합니다. height가 "아래로" 뻗든 "위로" 뻗든
 * 양수 width/height만 쓰므로 구간 표현은 동일합니다.
 */
function rectRectCollides(a: Rectangle, b: Rectangle): boolean {
  const aLeft = a.origin.x;
  const aRight = a.origin.x + a.width;
  const aTop = a.origin.y;
  const aBottom = a.origin.y + a.height;

  const bLeft = b.origin.x;
  const bRight = b.origin.x + b.width;
  const bTop = b.origin.y;
  const bBottom = b.origin.y + b.height;

  // 완전 분리 조건의 부정 = 겹침(경계 포함)
  const separated =
    aRight < bLeft || bRight < aLeft || aBottom < bTop || bBottom < aTop;
  return !separated;
}

/**
 * 원-사각형 충돌.
 * 원의 중심에서 사각형 영역으로의 최근접점을 구한 뒤,
 * 그 점과 중심 사이 거리가 반지름 이하이면 충돌(경계 포함).
 */
function circleRectCollides(circle: Circle, rect: Rectangle): boolean {
  const left = rect.origin.x;
  const right = rect.origin.x + rect.width;
  const top = rect.origin.y;
  const bottom = rect.origin.y + rect.height;

  // 중심 좌표를 사각형의 닫힌 구간으로 클램프 → 최근접점
  const closestX = clamp(circle.center.x, left, right);
  const closestY = clamp(circle.center.y, top, bottom);

  const distSq = distanceSquared(circle.center, { x: closestX, y: closestY });
  return distSq <= circle.radius * circle.radius;
}

/** value를 [min, max] 닫힌 구간으로 제한합니다. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 두 2D 도형(원 또는 축 정렬 사각형)의 충돌(겹침) 여부를 판정합니다.
 * 경계가 정확히 맞닿는 경우도 충돌(true)로 간주합니다.
 * 인자 순서에 대해 대칭입니다.
 */
export function 충돌판정_2D(a: Shape, b: Shape): boolean {
  // kind 조합에 따라 분기. 각 분기에서 양쪽 kind를 모두 검사해
  // 판별 유니온이 올바르게 내로잉되도록 합니다.
  if (a.kind === "circle") {
    if (b.kind === "circle") {
      return circleCircleCollides(a, b);
    }
    // b.kind === "rectangle"
    return circleRectCollides(a, b);
  }

  // a.kind === "rectangle"
  if (b.kind === "rectangle") {
    return rectRectCollides(a, b);
  }
  // b.kind === "circle"
  return circleRectCollides(b, a);
}

/// END OF AUTO-GENERATED CODE
