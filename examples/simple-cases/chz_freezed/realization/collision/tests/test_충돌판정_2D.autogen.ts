/// test_충돌판정_2D.autogen.ts
/// AUTO-GENERATED tests for `imagine function 충돌판정_2D`, authored by openai/gpt-5.6-luna
/// (via chz-realize) on 2026-07-23T21:44:21.786Z.

import { describe, expect, it } from "vitest";
import { 충돌판정_2D } from "../implementations/충돌판정_2D.ts";
import type { Shape } from "../implementations/__prologue__.ts";

describe("충돌판정_2D", () => {
  it("detects identical and tangent circles", () => {
    const first: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
    const identical: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
    const tangent: Shape = { kind: "circle", center: { x: 10, y: 0 }, radius: 5 };

    expect(충돌판정_2D(first, identical)).toBe(true);
    expect(충돌판정_2D(first, tangent)).toBe(true);
  });

  it("rejects separated circles and detects rectangle edge contact", () => {
    const circle: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 1 };
    const distantCircle: Shape = { kind: "circle", center: { x: 3, y: 0 }, radius: 1 };
    const left: Shape = { kind: "rectangle", origin: { x: 2, y: -1 }, width: 2, height: 2 };
    const touching: Shape = { kind: "rectangle", origin: { x: 4, y: -1 }, width: 2, height: 2 };

    expect(충돌판정_2D(circle, distantCircle)).toBe(false);
    expect(충돌판정_2D(left, touching)).toBe(true);
  });

  it("handles rectangle overlap and separation", () => {
    const first: Shape = { kind: "rectangle", origin: { x: 0, y: 0 }, width: 4, height: 4 };
    const overlapping: Shape = { kind: "rectangle", origin: { x: 3, y: 2 }, width: 4, height: 4 };
    const separate: Shape = { kind: "rectangle", origin: { x: 5, y: 0 }, width: 2, height: 2 };

    expect(충돌판정_2D(first, overlapping)).toBe(true);
    expect(충돌판정_2D(first, separate)).toBe(false);
  });

  it("handles circle-rectangle collisions in either argument order", () => {
    const circle: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 2 };
    const touchingCorner: Shape = { kind: "rectangle", origin: { x: 2, y: -1 }, width: 2, height: 2 };
    const distant: Shape = { kind: "rectangle", origin: { x: 10, y: 10 }, width: 2, height: 2 };

    expect(충돌판정_2D(circle, touchingCorner)).toBe(true);
    expect(충돌판정_2D(touchingCorner, circle)).toBe(true);
    expect(충돌판정_2D(circle, distant)).toBe(false);
    expect(충돌판정_2D(distant, circle)).toBe(false);
  });
});
