/// 충돌판정_2D.ts
/// realization of `imagine function 충돌판정_2D(a: Shape, b: Shape): boolean`
/// realized by openai/gpt-5.6-luna (via chz-realize) on 2026-07-23T21:44:21.786Z
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

import { Shape } from "./__prologue__.ts";

/**
 * Determines whether two supported 2D shapes have at least one point in
 * common.  Every comparison uses <=, so touching boundaries count as overlap.
 */
export function 충돌판정_2D(a: Shape, b: Shape): boolean {
  // ASSUMPTION: Rectangle coordinates use the stated top-left origin with
  // width extending along x and height extending along y; this is the usual
  // axis-aligned screen-coordinate interpretation and is equivalent to using
  // the rectangle's two axis-aligned bounds for these tests.
  if (a.kind === "circle" && b.kind === "circle") {
    // Two disks meet when the center distance is no greater than the sum of
    // their radii. Squared distances avoid an unnecessary square root.
    const dx = a.center.x - b.center.x;
    const dy = a.center.y - b.center.y;
    const radiusSum = a.radius + b.radius;
    return dx * dx + dy * dy <= radiusSum * radiusSum;
  }

  if (a.kind === "rectangle" && b.kind === "rectangle") {
    // Each pair of intervals must overlap. Inclusive comparisons preserve
    // collision at an edge or corner.
    const aRight = a.origin.x + a.width;
    const aBottom = a.origin.y + a.height;
    const bRight = b.origin.x + b.width;
    const bBottom = b.origin.y + b.height;
    return (
      a.origin.x <= bRight &&
      aRight >= b.origin.x &&
      a.origin.y <= bBottom &&
      aBottom >= b.origin.y
    );
  }

  // Normalize the mixed case through explicit discriminant checks. This also
  // makes symmetry visible: either argument may provide the circle.
  if (a.kind === "circle" && b.kind === "rectangle") {
    return circleRectangleCollision(a, b);
  }
  if (a.kind === "rectangle" && b.kind === "circle") {
    return circleRectangleCollision(b, a);
  }

  // ASSUMPTION: The declared Shape union has no variants beyond circle and
  // rectangle, so reaching this fallback is impossible for valid inputs.
  return false;
}

/**
 * Tests one circle against one rectangle. The caller has already established
 * the argument variants, so this helper can use both variant-specific fields.
 */
function circleRectangleCollision(
  circle: Extract<Shape, { kind: "circle" }>,
  rectangle: Extract<Shape, { kind: "rectangle" }>,
): boolean {
  // The closest point in an axis-aligned rectangle to the circle's center is
  // found by clamping each coordinate to the rectangle's inclusive bounds.
  const right = rectangle.origin.x + rectangle.width;
  const bottom = rectangle.origin.y + rectangle.height;
  const closestX = Math.max(rectangle.origin.x, Math.min(circle.center.x, right));
  const closestY = Math.max(rectangle.origin.y, Math.min(circle.center.y, bottom));
  const dx = circle.center.x - closestX;
  const dy = circle.center.y - closestY;

  // Inclusive comparison makes a single tangent point a collision.
  return dx * dx + dy * dy <= circle.radius * circle.radius;
}

/// END OF AUTO-GENERATED CODE
