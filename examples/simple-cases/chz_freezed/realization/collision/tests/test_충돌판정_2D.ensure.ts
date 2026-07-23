/// test_충돌판정_2D.ensure.ts
/// AUTO-GENERATED executable ensure tests — DO NOT EDIT.
/// Generated deterministically by chz-realize from collision.chz.ts.

import { 충돌판정_2D } from "../implementations/충돌판정_2D.ts";
import type { Shape } from "../implementations/__prologue__.ts";

declare const it: (name: string, test: () => unknown | Promise<unknown>) => void;

function assert(condition: boolean, message = "ensure assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

it("Two identical circles must collide.", () => {
  assert(
    충돌판정_2D(
          { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
          { kind: "circle", center: { x: 0, y: 0 }, radius: 5 },
        ) === true,
    "ensure assertion failed (collision.chz.ts › 충돌판정_2D › ensure #1)\ncondition: 충돌판정_2D(\n      { kind: \"circle\", center: { x: 0, y: 0 }, radius: 5 },\n      { kind: \"circle\", center: { x: 0, y: 0 }, radius: 5 },\n    ) === true",
  );
});

it("Distant shapes must not collide.", async () => {
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
    throw new Error("ensure scenario (collision.chz.ts › 충돌판정_2D › ensure #2) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (collision.chz.ts › 충돌판정_2D › ensure #2)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (collision.chz.ts › 충돌판정_2D › ensure #2): " + detail);
  }
});

it("Collision detection must be symmetric with respect to argument order.", async () => {
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
    throw new Error("ensure scenario (collision.chz.ts › 충돌판정_2D › ensure #3) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (collision.chz.ts › 충돌판정_2D › ensure #3)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (collision.chz.ts › 충돌판정_2D › ensure #3): " + detail);
  }
});

it("A circle and rectangle touching at one point must collide.", async () => {
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
    throw new Error("ensure scenario (collision.chz.ts › 충돌판정_2D › ensure #4) must not declare parameters");
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error("ensure scenario returned false (collision.chz.ts › 충돌판정_2D › ensure #4)");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error("ensure scenario failed (collision.chz.ts › 충돌판정_2D › ensure #4): " + detail);
  }
});
