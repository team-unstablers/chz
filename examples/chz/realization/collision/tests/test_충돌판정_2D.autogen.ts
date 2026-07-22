/// test_충돌판정_2D.autogen.ts
/// AUTO-GENERATED tests for `imagine function 충돌판정_2D`, authored by claude CLI (default model)
/// (via chz-realize) on 2026-07-22T18:53:49.214Z. These are the LLM's own tests; the human's
/// ensure predicate contracts are enforced separately via ./test_충돌판정_2D.ensure.ts,
/// which every case below invokes through assertEnsures().

import { describe, it, expect } from "vitest";
import { 충돌판정_2D } from "../implementations/충돌판정_2D.ts";
import { assertEnsures } from "./test_충돌판정_2D.ensure.ts";

// 테스트에서 사용할 도형 타입을 로컬로 선언합니다(구현 파일과 동일한 구조).
// 판별 유니온 리터럴("circle"/"rectangle")을 정확히 좁히기 위해 명시적 타입이
// 필요하므로, 아래 팩토리 함수로 타입이 확정된 도형을 만듭니다.
type Point = { x: number; y: number };
type Circle = { kind: "circle"; center: Point; radius: number };
type Rectangle = {
  kind: "rectangle";
  origin: Point;
  width: number;
  height: number;
};
type Shape = Circle | Rectangle;

const circle = (x: number, y: number, r: number): Circle => ({
  kind: "circle",
  center: { x, y },
  radius: r,
});
const rect = (x: number, y: number, w: number, h: number): Rectangle => ({
  kind: "rectangle",
  origin: { x, y },
  width: w,
  height: h,
});

// 헬퍼: 함수를 호출하고, 그 인자/반환값에 대해 사람이 작성한 predicate 계약을
// 반드시 검증(assertEnsures)한 뒤 반환값을 돌려줍니다. 모든 케이스에서 사용합니다.
function 판정(a: Shape, b: Shape): boolean {
  const 결과 = 충돌판정_2D(a, b);
  assertEnsures([a, b], 결과); // 사람의 predicate 계약(#1 boolean, #2 동일 원)을 적용
  return 결과;
}

// 자연어 계약 1: 서로 멀리 떨어져 한 점도 공유하지 않는 두 도형은 false.
describe("자연어 계약 1 — 멀리 떨어진 도형은 충돌하지 않는다(false)", () => {
  it("원-원: 멀리 떨어지면 false", () => {
    expect(판정(circle(0, 0, 1), circle(100, 100, 1))).toBe(false);
  });

  it("사각형-사각형: 멀리 떨어지면 false", () => {
    expect(판정(rect(0, 0, 2, 2), rect(50, 50, 2, 2))).toBe(false);
  });

  it("원-사각형: 멀리 떨어지면 false", () => {
    expect(판정(circle(0, 0, 3), rect(100, 100, 4, 4))).toBe(false);
  });

  it("사각형-사각형: 한 축만 겹치고 다른 축이 분리되면 false", () => {
    // x축은 겹치지만 y축이 완전히 떨어져 있어 비충돌이어야 합니다.
    expect(판정(rect(0, 0, 10, 2), rect(0, 50, 10, 2))).toBe(false);
  });
});

// 자연어 계약 2: 판정은 인자 순서에 대해 대칭이어야 한다.
describe("자연어 계약 2 — 인자 순서에 대한 대칭성", () => {
  const 쌍들: Array<[Shape, Shape]> = [
    [circle(0, 0, 5), rect(3, 3, 4, 4)], // 충돌하는 원-사각형
    [circle(0, 0, 1), rect(100, 100, 4, 4)], // 비충돌 원-사각형
    [circle(0, 0, 5), circle(8, 0, 5)], // 충돌하는 원-원
    [rect(0, 0, 4, 4), rect(2, 2, 4, 4)], // 충돌하는 사각형-사각형
    [rect(0, 0, 4, 4), rect(4, 0, 4, 4)], // 변이 맞닿는 사각형-사각형
  ];

  it("충돌판정_2D(a, b) 와 충돌판정_2D(b, a) 는 항상 같아야 한다", () => {
    for (const [a, b] of 쌍들) {
      const 정방향 = 판정(a, b);
      const 역방향 = 판정(b, a);
      expect(정방향).toBe(역방향);
    }
  });
});

// 자연어 계약 3: 원과 사각형이 경계에서 정확히 한 점으로만 맞닿아도 true.
describe("자연어 계약 3 — 원과 사각형의 한 점 접촉도 충돌(true)", () => {
  it("변 위의 한 점에서만 접촉하면 true", () => {
    // 원 중심 (0,0), 반지름 5. 사각형의 왼쪽 변이 x=5.
    // 사각형 y구간 [-2, 2]는 y=0을 포함 → 가장 가까운 점 (5, 0), 거리 5 = 반지름.
    const 원 = circle(0, 0, 5);
    const 사각형 = rect(5, -2, 4, 4);
    expect(판정(원, 사각형)).toBe(true);
  });

  it("꼭짓점에서만 접촉해도 true (인자 순서 무관)", () => {
    // 원 중심 (0,0), 반지름 5. 사각형의 좌상단 꼭짓점이 (3,4): 거리 = 5 = 반지름.
    const 원 = circle(0, 0, 5);
    const 사각형 = rect(3, 4, 2, 2);
    expect(판정(원, 사각형)).toBe(true);
    expect(판정(사각형, 원)).toBe(true);
  });

  it("접촉 지점보다 아주 조금 더 멀면 false (경계의 반대편 확인)", () => {
    // 위 변-접촉 케이스에서 사각형을 x축으로 한 칸 밀면 최근접 거리가 반지름보다 커짐.
    const 원 = circle(0, 0, 5);
    const 사각형 = rect(6, -2, 4, 4); // 최근접점 (6,0), 거리 6 > 5
    expect(판정(원, 사각형)).toBe(false);
  });
});

// predicate 계약 및 일반적인 겹침 성질에 대한 보강 테스트.
describe("보강 — 겹침의 기본 성질", () => {
  it("predicate #2: 완전히 동일한 두 원은 반드시 충돌(true)", () => {
    // assertEnsures 안에서 '동일한 원 → retval === true' 계약이 강제로 검증됩니다.
    const 원 = circle(2, 3, 4);
    const 원사본 = circle(2, 3, 4);
    expect(판정(원, 원사본)).toBe(true);
  });

  it("원-원: 경계가 정확히 맞닿으면 true (중심거리 = 반지름 합)", () => {
    expect(판정(circle(0, 0, 5), circle(10, 0, 5))).toBe(true);
  });

  it("원-원: 겹치면 true, 겨우 떨어지면 false", () => {
    expect(판정(circle(0, 0, 5), circle(9, 0, 5))).toBe(true); // 중심거리 9 < 10
    expect(판정(circle(0, 0, 5), circle(11, 0, 5))).toBe(false); // 중심거리 11 > 10
  });

  it("사각형-사각형: 변이 정확히 접하면 true", () => {
    // a의 오른쪽 변(x=4)과 b의 왼쪽 변(x=4)이 맞닿음 → 겹침으로 간주.
    expect(판정(rect(0, 0, 4, 4), rect(4, 0, 4, 4))).toBe(true);
  });

  it("사각형-사각형: 꼭짓점만 접해도 true", () => {
    // a의 우하단 꼭짓점 (4,4) 과 b의 좌상단 꼭짓점 (4,4) 이 한 점에서 만남.
    expect(판정(rect(0, 0, 4, 4), rect(4, 4, 4, 4))).toBe(true);
  });

  it("사각형-사각형: 한쪽이 다른 쪽을 완전히 포함해도 true", () => {
    expect(판정(rect(0, 0, 10, 10), rect(3, 3, 2, 2))).toBe(true);
  });

  it("원-사각형: 원의 중심이 사각형 내부에 있으면 true", () => {
    expect(판정(circle(5, 5, 1), rect(0, 0, 10, 10))).toBe(true);
  });

  it("원-사각형: 사각형이 원 내부에 완전히 들어가도 true", () => {
    expect(판정(circle(0, 0, 100), rect(-1, -1, 2, 2))).toBe(true);
  });
});
