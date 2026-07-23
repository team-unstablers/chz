/// test_충돌판정_2D.ensure.ts
/// AUTO-GENERATED executable ensure tests — DO NOT EDIT.
/// Generated deterministically by chz-realize from collision.chz.ts.

import { 충돌판정_2D } from "../implementations/충돌판정_2D.ts";
import type { Shape } from "../implementations/__prologue__.ts";

declare const it: (name: string, test: () => unknown | Promise<unknown>) => void;

function assert(condition: boolean, message = "ensure assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

it("완전히 동일한 두 원은 충돌해야 합니다.", () => {
  assert(
    충돌판정_2D(
          { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
          { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
        ) === true,
    "ensure assertion failed at /Users/cheesekun/works/chz/examples/collision.chz.ts:52:3\ncondition: 충돌판정_2D(\n      { kind: \"circle\", center: { x: 0, y: 0 }, radius: 5 },\n      { kind: \"circle\", center: { x: 0, y: 0 }, radius: 5 },\n    ) === true",
  );
});

it("멀리 떨어진 두 도형은 충돌하지 않습니다.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
    const 원: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 1 };
    const 사각형: Shape = {
      kind: "rectangle",
      origin: { x: 10, y: 10 },
      width: 2,
      height: 2,
    };

    assert(충돌판정_2D(원, 사각형) === false);
  };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/collision.chz.ts:61:3 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/collision.chz.ts:61:3");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/collision.chz.ts:61:3: " + detail);
  }
});

it("충돌 판정은 인자 순서에 대해 대칭입니다.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
    const 원: Shape = { kind: "circle", center: { x: 2, y: 2 }, radius: 2 };
    const 사각형: Shape = {
      kind: "rectangle",
      origin: { x: 3, y: 1 },
      width: 3,
      height: 3,
    };

    assert(충돌판정_2D(원, 사각형) === 충돌판정_2D(사각형, 원));
  };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/collision.chz.ts:73:3 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/collision.chz.ts:73:3");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/collision.chz.ts:73:3: " + detail);
  }
});

it("원과 사각형이 한 점에서 맞닿으면 충돌입니다.", async () => {
  const scenario: () => unknown | Promise<unknown> = () => {
    const 원: Shape = { kind: "circle", center: { x: 0, y: 0 }, radius: 2 };
    const 사각형: Shape = {
      kind: "rectangle",
      origin: { x: 2, y: -1 },
      width: 2,
      height: 2,
    };

    assert(충돌판정_2D(원, 사각형) === true);
  };
  if (scenario.length !== 0) {
    throw new Error("ensure scenario at /Users/cheesekun/works/chz/examples/collision.chz.ts:85:3 must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false at /Users/cheesekun/works/chz/examples/collision.chz.ts:85:3");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed at /Users/cheesekun/works/chz/examples/collision.chz.ts:85:3: " + detail);
  }
});
