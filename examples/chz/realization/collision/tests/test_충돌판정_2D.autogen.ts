/// test_충돌판정_2D.autogen.ts
/// AUTO-GENERATED tests for `imagine function 충돌판정_2D`, authored by x-ai/grok-4.5
/// (via chz-realize) on 2026-07-23T08:57:26.479Z.

import { describe, it, expect } from "vitest";
import { 충돌판정_2D } from "../implementations/충돌판정_2D";
import type { Shape } from "../implementations/__prologue__";

describe("충돌판정_2D", () => {
  describe("원-원", () => {
    it("완전히 동일한 두 원은 충돌한다", () => {
      const a: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
      const b: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 5 };
      expect(충돌판정_2D(a, b)).toBe(true);
    });

    it("중심 거리가 반지름 합보다 작으면 충돌한다", () => {
      const a: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 3 };
      const b: Shape = { kind: "circle", center: { x: 4, y: 0 }, radius: 2 };
      expect(충돌판정_2D(a, b)).toBe(true);
    });

    it("중심 거리가 반지름 합과 같으면(맞닿음) 충돌한다", () => {
      const a: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 3 };
      const b: Shape = { kind: "circle", center: { x: 5, y: 0 }, radius: 2 };
      expect(충돌판정_2D(a, b)).toBe(true);
    });

    it("중심 거리가 반지름 합보다 크면 비충돌이다", () => {
      const a: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 1 };
      const b: Shape = { kind: "circle", center: { x: 10, y: 0 }, radius: 1 };
      expect(충돌판정_2D(a, b)).toBe(false);
    });

    it("한 원이 다른 원 내부에 완전히 포함되면 충돌한다", () => {
      const outer: Shape = {
        kind: "circle",
        center: { x: 0, y: 0 },
        radius: 10,
      };
      const inner: Shape = {
        kind: "circle",
        center: { x: 1, y: 1 },
        radius: 1,
      };
      expect(충돌판정_2D(outer, inner)).toBe(true);
    });
  });

  describe("사각형-사각형", () => {
    it("겹치는 두 사각형은 충돌한다", () => {
      const a: Shape = {
        kind: "rectangle",
        origin: { x: 0, y: 0 },
        width: 4,
        height: 4,
      };
      const b: Shape = {
        kind: "rectangle",
        origin: { x: 2, y: 2 },
        width: 4,
        height: 4,
      };
      expect(충돌판정_2D(a, b)).toBe(true);
    });

    it("변이 정확히 맞닿으면 충돌한다", () => {
      const a: Shape = {
        kind: "rectangle",
        origin: { x: 0, y: 0 },
        width: 2,
        height: 2,
      };
      const b: Shape = {
        kind: "rectangle",
        origin: { x: 2, y: 0 },
        width: 2,
        height: 2,
      };
      expect(충돌판정_2D(a, b)).toBe(true);
    });

    it("모서리만 맞닿아도 충돌한다", () => {
      const a: Shape = {
        kind: "rectangle",
        origin: { x: 0, y: 0 },
        width: 2,
        height: 2,
      };
      const b: Shape = {
        kind: "rectangle",
        origin: { x: 2, y: 2 },
        width: 2,
        height: 2,
      };
      expect(충돌판정_2D(a, b)).toBe(true);
    });

    it("완전히 떨어진 두 사각형은 비충돌이다", () => {
      const a: Shape = {
        kind: "rectangle",
        origin: { x: 0, y: 0 },
        width: 1,
        height: 1,
      };
      const b: Shape = {
        kind: "rectangle",
        origin: { x: 5, y: 5 },
        width: 1,
        height: 1,
      };
      expect(충돌판정_2D(a, b)).toBe(false);
    });

    it("한 사각형이 다른 사각형 내부에 있으면 충돌한다", () => {
      const outer: Shape = {
        kind: "rectangle",
        origin: { x: 0, y: 0 },
        width: 10,
        height: 10,
      };
      const inner: Shape = {
        kind: "rectangle",
        origin: { x: 2, y: 2 },
        width: 1,
        height: 1,
      };
      expect(충돌판정_2D(outer, inner)).toBe(true);
    });
  });

  describe("원-사각형", () => {
    it("원이 사각형 내부에 있으면 충돌한다", () => {
      const circle: Shape = {
        kind: "circle",
        center: { x: 5, y: 5 },
        radius: 1,
      };
      const rect: Shape = {
        kind: "rectangle",
        origin: { x: 0, y: 0 },
        width: 10,
        height: 10,
      };
      expect(충돌판정_2D(circle, rect)).toBe(true);
    });

    it("원 중심이 사각형 밖이지만 가장자리가 겹치면 충돌한다", () => {
      const circle: Shape = {
        kind: "circle",
        center: { x: 0, y: 0 },
        radius: 3,
      };
      const rect: Shape = {
        kind: "rectangle",
        origin: { x: 2, y: -1 },
        width: 4,
        height: 2,
      };
      expect(충돌판정_2D(circle, rect)).toBe(true);
    });

    it("원과 사각형이 한 점에서 맞닿으면 충돌한다", () => {
      // 원 중심 (0,0) r=2, 사각형 origin (2,-1) 2x2 → 좌변이 x=2, y∈[-1,1]
      // 최근접점은 (2,0), 거리 2 = radius → 맞닿음
      const circle: Shape = {
        kind: "circle",
        center: { x: 0, y: 0 },
        radius: 2,
      };
      const rect: Shape = {
        kind: "rectangle",
        origin: { x: 2, y: -1 },
        width: 2,
        height: 2,
      };
      expect(충돌판정_2D(circle, rect)).toBe(true);
    });

    it("멀리 떨어진 원과 사각형은 비충돌이다", () => {
      const circle: Shape = {
        kind: "circle",
        center: { x: 0, y: 0 },
        radius: 1,
      };
      const rect: Shape = {
        kind: "rectangle",
        origin: { x: 10, y: 10 },
        width: 2,
        height: 2,
      };
      expect(충돌판정_2D(circle, rect)).toBe(false);
    });

    it("인자 순서에 대해 대칭이다", () => {
      const circle: Shape = {
        kind: "circle",
        center: { x: 2, y: 2 },
        radius: 2,
      };
      const rect: Shape = {
        kind: "rectangle",
        origin: { x: 3, y: 1 },
        width: 3,
        height: 3,
      };
      expect(충돌판정_2D(circle, rect)).toBe(충돌판정_2D(rect, circle));
    });

    it("원과 사각형이 모서리에서만 맞닿아도 충돌한다", () => {
      // 원 (0,0) r=√2 ≈ 1.414..., 사각형 origin (1,1) → 최근접 (1,1), 거리 √2
      const circle: Shape = {
        kind: "circle",
        center: { x: 0, y: 0 },
        radius: Math.SQRT2,
      };
      const rect: Shape = {
        kind: "rectangle",
        origin: { x: 1, y: 1 },
        width: 2,
        height: 2,
      };
      expect(충돌판정_2D(circle, rect)).toBe(true);
    });
  });
});
