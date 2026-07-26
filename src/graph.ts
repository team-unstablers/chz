/**
 * chz — symbol-level dependency graph (docs/62).
 *
 * Realize order is decided per strongly connected component (SCC), leaves
 * first. Edges are discovered in the three stages of docs/62:
 *
 *   1-2. Estimated edges — identifier mentions of other imagine symbols inside
 *        an imagine block (signature type refs plus requirements/ensure body
 *        mentions; both live in `spec.originalText`, so one scan covers both).
 *   3.   Confirmed edges — imports extracted from a realized implementation
 *        after its session ends. The engine records them in
 *        `realization-cache.json`; re-runs will prefer them over estimates.
 *
 * Cycles are grouped into one realize session each. A cycle always warns, and
 * a cycle larger than the configurable cap is an error: the more symbols one
 * session must realize together, the less reliable the session becomes.
 */

import { resolve } from "node:path";

import { collectModuleSpecifiersFromSource } from "./compiler/index.ts";
import type { ImagineSpec } from "./preprocessor.ts";
import type { ChzImagineSymbol } from "./realizer/types.ts";

/**
 * Cycles above this size fail realize unless `maxCycleSize` raises the cap.
 * Two or three mutually recursive symbols are a realistic single session;
 * beyond that the combined spec volume degrades session quality (docs/62).
 */
export const DEFAULT_MAX_CYCLE_SIZE = 3;

/** One realize session unit: a lone symbol, or a whole dependency cycle. */
export interface ChzRealizeGroup {
  /** Group members in source order. More than one only for cycles. */
  symbols: ChzImagineSymbol[];
  circular: boolean;
}

export interface ChzDependencyGraph {
  /** Every imagine symbol in source order, with estimated edges attached. */
  symbols: ChzImagineSymbol[];
  /** Realize order: one entry per SCC, dependencies before dependents. */
  groups: ChzRealizeGroup[];
  /** Human-facing cycle warnings (a cycle is legal but always warned). */
  warnings: string[];
}

export interface BuildDependencyGraphOptions {
  /** Maximum symbols one cycle may contain. Default {@link DEFAULT_MAX_CYCLE_SIZE}. */
  maxCycleSize?: number;
  /**
   * Confirmed edges from a previous run's `realization-cache.json` (docs/62
   * stage 3), keyed by symbol name. They are united with the estimated
   * mention-scan edges: a dependency the model chose during realization must
   * keep constraining the order even when the spec text never names it.
   * Callers must only pass edges of symbols whose spec is unchanged — a
   * changed spec invalidates its old implementation's imports.
   */
  confirmedEdges?: ReadonlyMap<string, readonly string[]>;
}

/** A dependency cycle exceeded the configured size cap. */
export class ChzCycleError extends Error {
  readonly members: readonly string[];

  constructor(members: readonly string[], maxCycleSize: number) {
    super(
      `Dependency cycle of ${members.length} symbols exceeds the maximum cycle size of ${maxCycleSize}: ` +
        `${members.join(" ↔ ")}. Break the cycle by extracting a shared human-owned interface ` +
        `(human types are not graph nodes), or raise maxCycleSize in chz.config.js if the cycle is intentional.`,
    );
    this.name = "ChzCycleError";
    this.members = members;
  }
}

/**
 * True when the character continues an ASCII identifier. Non-ASCII characters
 * are deliberately NOT treated as identifier continuations here: requirements
 * prose attaches Korean particles directly to symbol names (`크리티컬_판정을`),
 * and rejecting those suffixes would silently drop real dependency edges. The
 * cost is a rare over-match when one Korean symbol name prefixes another; an
 * extra estimated edge only makes the realize order more conservative.
 */
function isAsciiIdentifierPart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

/**
 * Whether `text` mentions the symbol `name` at an identifier boundary. Unlike
 * plain substring search this never matches inside a longer ASCII identifier
 * (`slug` does not match `slugify`). The same matcher must be used everywhere
 * mentions decide behavior (graph edges, ensure-harness imports), or the
 * realize order and the emitted imports would disagree.
 */
export function mentionsSymbol(text: string, name: string): boolean {
  if (name.length === 0) return false;
  for (let from = 0; ; ) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = at > 0 ? text[at - 1]! : "";
    const after = at + name.length < text.length ? text[at + name.length]! : "";
    if (
      (before === "" || !isAsciiIdentifierPart(before)) &&
      (after === "" || !isAsciiIdentifierPart(after))
    ) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Which of `names` are mentioned in `text`. A mention of a longer known name
 * never doubles as a mention of a shorter name it contains: with symbols
 * `판정` and `판정기`, the text `판정기를 사용` mentions only `판정기` — the
 * tolerant non-ASCII boundary would otherwise also match `판정` and could
 * even manufacture cycles out of a symbol's own declaration header.
 */
export function mentionedSymbols(text: string, names: readonly string[]): string[] {
  return names.filter((name) => {
    const shadowing = names
      .filter((other) => other !== name && other.length > name.length && other.includes(name))
      .sort((a, b) => b.length - a.length);
    return mentionsSymbol(maskOccurrences(text, shadowing), name);
  });
}

/** Blank out every boundary-tolerant occurrence of the given names. */
function maskOccurrences(text: string, names: readonly string[]): string {
  let masked = text;
  for (const name of names) {
    if (name.length === 0) continue;
    let result = "";
    let from = 0;
    for (;;) {
      const at = masked.indexOf(name, from);
      if (at < 0) {
        result += masked.slice(from);
        break;
      }
      const before = at > 0 ? masked[at - 1]! : "";
      const after = at + name.length < masked.length ? masked[at + name.length]! : "";
      const bounded =
        (before === "" || !isAsciiIdentifierPart(before)) &&
        (after === "" || !isAsciiIdentifierPart(after));
      result += masked.slice(from, at) + (bounded ? " ".repeat(name.length) : name);
      from = at + name.length;
    }
    masked = result;
  }
  return masked;
}

/** Lift a preprocessor spec into the Realizer's symbol shape. */
export function imagineSpecToSymbol(
  spec: ImagineSpec,
  source: string,
  fileName: string,
): ChzImagineSymbol {
  const before = source.slice(0, spec.start);
  const lines = before.split(/\r?\n/);
  return {
    name: spec.name,
    type: spec.type,
    definition: spec.originalText,
    file: resolve(fileName),
    posLine: lines.length,
    posCol: (lines.at(-1)?.length ?? 0) + 1,
    dependencies: [],
    circularDependencies: [],
  };
}

/**
 * Build the dependency graph and the SCC realize order for one source file.
 *
 * @throws {ChzCycleError} when a cycle exceeds `maxCycleSize`.
 */
export function buildDependencyGraph(
  specs: readonly ImagineSpec[],
  source: string,
  fileName: string,
  options: BuildDependencyGraphOptions = {},
): ChzDependencyGraph {
  const maxCycleSize = options.maxCycleSize ?? DEFAULT_MAX_CYCLE_SIZE;
  const symbols = specs.map((spec) => imagineSpecToSymbol(spec, source, fileName));
  const names = symbols.map((symbol) => symbol.name);
  for (const symbol of symbols) {
    const mentioned = new Set(mentionedSymbols(symbol.definition, names));
    for (const confirmed of options.confirmedEdges?.get(symbol.name) ?? []) {
      mentioned.add(confirmed);
    }
    symbol.dependencies = symbols.filter(
      (candidate) => candidate !== symbol && mentioned.has(candidate.name),
    );
  }

  const sourceIndex = new Map(symbols.map((symbol, index) => [symbol, index]));
  const groups: ChzRealizeGroup[] = tarjanComponents(symbols).map((members) => {
    const ordered = [...members].sort((a, b) => sourceIndex.get(a)! - sourceIndex.get(b)!);
    const circular = ordered.length > 1;
    for (const member of ordered) {
      member.circularDependencies = circular
        ? ordered.filter((candidate) => candidate !== member)
        : [];
    }
    return { symbols: ordered, circular };
  });

  const warnings = groups
    .filter((group) => group.circular)
    .map(
      (group) =>
        `Dependency cycle detected: ${group.symbols.map((symbol) => symbol.name).join(" ↔ ")}. ` +
        `The whole cycle will be realized together in one session; consider extracting a ` +
        `shared human-owned interface to break it.`,
    );

  const oversized = groups.find((group) => group.symbols.length > maxCycleSize);
  if (oversized !== undefined) {
    throw new ChzCycleError(
      oversized.symbols.map((symbol) => symbol.name),
      maxCycleSize,
    );
  }

  return { symbols, groups, warnings };
}

/**
 * The flattened estimated realize order (dependencies before dependents).
 * Cycle members stay adjacent in source order. Kept as a tolerant preview
 * API: it never throws on large cycles, unlike {@link buildDependencyGraph}
 * which the engine and `--dry-run` use with the configured cap.
 */
export function buildEstimatedRealizeOrder(
  specs: ImagineSpec[],
  source: string,
  fileName: string,
): ChzImagineSymbol[] {
  return buildDependencyGraph(specs, source, fileName, {
    maxCycleSize: Number.POSITIVE_INFINITY,
  }).groups.flatMap((group) => group.symbols);
}

/**
 * Tarjan's strongly-connected-components algorithm. SCCs are emitted in
 * reverse topological order of the condensation — every dependency's SCC
 * before its dependents' — which is exactly the realize order of docs/62.
 * Deterministic: symbols are visited in source order.
 */
function tarjanComponents(symbols: readonly ChzImagineSymbol[]): ChzImagineSymbol[][] {
  const components: ChzImagineSymbol[][] = [];
  const index = new Map<ChzImagineSymbol, number>();
  const lowLink = new Map<ChzImagineSymbol, number>();
  const onStack = new Set<ChzImagineSymbol>();
  const stack: ChzImagineSymbol[] = [];
  let nextIndex = 0;

  const connect = (symbol: ChzImagineSymbol): void => {
    index.set(symbol, nextIndex);
    lowLink.set(symbol, nextIndex);
    nextIndex++;
    stack.push(symbol);
    onStack.add(symbol);

    for (const dependency of symbol.dependencies) {
      if (!index.has(dependency)) {
        connect(dependency);
        lowLink.set(symbol, Math.min(lowLink.get(symbol)!, lowLink.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLink.set(symbol, Math.min(lowLink.get(symbol)!, index.get(dependency)!));
      }
    }

    if (lowLink.get(symbol) === index.get(symbol)) {
      const component: ChzImagineSymbol[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === symbol) break;
      }
      components.push(component);
    }
  };

  for (const symbol of symbols) {
    if (!index.has(symbol)) connect(symbol);
  }
  return components;
}

// ---------------------------------------------------------------------------
// Stage 3: confirmed edges from realized artifacts
// ---------------------------------------------------------------------------

/**
 * The imagine symbols a realized implementation actually depends on, read
 * from its import statements (stage 3 of docs/62). In the realized ES-module
 * layout every cross-symbol use must be imported from a sibling module
 * (`./<name>.ts`), so import specifiers are the complete usage record.
 *
 * Realized files have already passed the strict type check. The shared
 * compiler traversal handles static imports, re-exports, dynamic imports,
 * import-equals, and unshadowed CommonJS require calls.
 */
export function extractConfirmedDependencies(
  implementationSource: string,
  symbolName: string,
  knownSymbolNames: readonly string[],
): string[] {
  const known = new Set(knownSymbolNames);
  const found = new Set<string>();
  for (const specifier of extractModuleSpecifiers(implementationSource)) {
    const dependency = specifierToSymbolName(specifier);
    if (dependency !== null && dependency !== symbolName && known.has(dependency)) {
      found.add(dependency);
    }
  }
  return [...found].sort();
}

/**
 * Map a module specifier to the realized symbol it names, if any. Realized
 * implementations live flat in one `implementations/` directory, so only a
 * sibling import (`./<name>.ts`, single path segment) can reference another
 * symbol — a nested path like `./helpers/slugify.ts` is a model-authored
 * helper whose basename must not fabricate a confirmed edge.
 */
function specifierToSymbolName(specifier: string): string | null {
  if (!specifier.startsWith("./")) return null;
  const rest = specifier.slice(2);
  if (rest === "" || rest.includes("/")) return null;
  const name = rest.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "");
  if (name === "" || name === "__prologue__" || name === "__epilogue__") return null;
  return name;
}

/** Every string literal used as a module specifier, in source order. */
export function extractModuleSpecifiers(source: string): string[] {
  return collectModuleSpecifiersFromSource(source);
}
