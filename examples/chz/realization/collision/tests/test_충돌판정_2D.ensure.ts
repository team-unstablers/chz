/// test_충돌판정_2D.ensure.ts
/// AUTO-GENERATED tests for `imagine function 충돌판정_2D`, authored by deepseek/deepseek-v4-flash
/// (via chz-realize) on 2026-07-22T23:28:44.617Z.

/// test_충돌판정_2D.ensure.ts
/// AUTO-GENERATED ensure-contract harness — DO NOT EDIT.
/// Generated deterministically by chz-realize from collision.chz.ts.

import type { Shape } from "../implementations/충돌판정_2D.ts";

type EnsurePredicate = (args: readonly unknown[], retval: unknown) => unknown;

const ENSURE_PREDICATES: readonly EnsurePredicate[] = [
  (args, retval) => typeof retval === "boolean",
  (args, retval) => {
    const [a, b] = args as [Shape, Shape];
    const 동일한원 =
      a.kind === "circle" &&
      b.kind === "circle" &&
      a.center.x === b.center.x &&
      a.center.y === b.center.y &&
      a.radius === b.radius;
    return 동일한원 ? retval === true : true;
  },
];

const ENSURE_SOURCES: readonly string[] = [
  "(args, retval) => typeof retval === \"boolean\"",
  "(args, retval) => {\n    const [a, b] = args as [Shape, Shape];\n    const 동일한원 =\n      a.kind === \"circle\" &&\n      b.kind === \"circle\" &&\n      a.center.x === b.center.x &&\n      a.center.y === b.center.y &&\n      a.radius === b.radius;\n    return 동일한원 ? retval === true : true;\n  }",
];

export function assertEnsures(args: readonly unknown[], retval: unknown): void {
  ENSURE_PREDICATES.forEach((predicate, index) => {
    const satisfied = predicate(args, retval);
    if (!satisfied) {
      throw new Error(
        `ensure contract #${index + 1} of \`충돌판정_2D\` was violated.\n` +
          `  contract: ${ENSURE_SOURCES[index]}\n` +
          `  args:     ${describeValue(args)}\n` +
          `  returned: ${describeValue(retval)}\n` +
          `  predicate returned: ${describeValue(satisfied)}`,
      );
    }
  });
}

function describeValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
