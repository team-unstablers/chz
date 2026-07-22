/// test_충돌판정_2D.ensure.ts
/// AUTO-GENERATED ensure-contract harness — DO NOT EDIT.
/// Generated deterministically by chz-realize from the human-authored
/// `ensure((args, retval) => ...)` predicate contracts of
/// `imagine function 충돌판정_2D` in collision.chz.ts.
///
/// The predicates below are copied VERBATIM from the .chz.ts spec. To change a
/// contract, edit the ensure(...) in the source and re-realize — never edit this
/// file. assertEnsures is invoked from every autogen test case so the human's
/// contracts ride along on the LLM's own test inputs (no self-grading).

/** One human-authored ensure predicate: receives the call args and its return value. */
type EnsurePredicate = (args: readonly unknown[], retval: unknown) => unknown;

/** The predicate ensure(...) contracts, copied verbatim from the spec. */
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

/** The verbatim source text of each predicate, used only in failure messages. */
const ENSURE_SOURCES: readonly string[] = [
  "(args, retval) => typeof retval === \"boolean\"",
  "(args, retval) => {\n    const [a, b] = args as [Shape, Shape];\n    const 동일한원 =\n      a.kind === \"circle\" &&\n      b.kind === \"circle\" &&\n      a.center.x === b.center.x &&\n      a.center.y === b.center.y &&\n      a.radius === b.radius;\n    return 동일한원 ? retval === true : true;\n  }",
];

/**
 * Apply every human-authored ensure predicate to one concrete call of
 * `충돌판정_2D`. Throws with a precise message if any predicate is not satisfied.
 *
 * @param args   the argument list passed to the implementation, as an array
 * @param retval the value the implementation returned
 */
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

/** Best-effort human-readable rendering of a value for failure messages. */
function describeValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
