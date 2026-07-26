/**
 * chz — symbol-level dependency graph (docs/62).
 *
 * Realize order is decided per strongly connected component (SCC), leaves
 * first. Edges are discovered in the three stages of docs/62:
 *
 *   1-2. Estimated edges — three deliberately separate sources:
 *        signature TypeNodes, executable ensure AST, and natural-language
 *        requirements prose.
 *   3.   Confirmed edges — imports extracted from a realized implementation
 *        after its session ends. The engine records them in
 *        `realization-cache.json`; re-runs will prefer them over estimates.
 *
 * Cycles are grouped into one realize session each. A cycle always warns, and
 * a cycle larger than the configurable cap is an error: the more symbols one
 * session must realize together, the less reliable the session becomes.
 */

import { resolve } from "node:path";

import {
  analyzeChzSource,
  collectModuleSpecifiersFromSource,
  collectSymbolReferences,
  collectTypeSymbolReferences,
  declarationEnsureScopes,
  unaliasSymbol,
  type ChzImagineDeclaration,
  type ChzSourceFile,
} from "./compiler/index.ts";
import {
  imagineSpecsFromChzSource,
  type ImagineSpec,
} from "./preprocessor.ts";
import type { ChzImagineSymbol } from "./realizer/types.ts";
import { mentionedSymbols } from "./requirements-mentions.ts";

export {
  maskOccurrences,
  mentionedSymbols,
  mentionsSymbol,
} from "./requirements-mentions.ts";

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
  /** Every graph edge with its independently recorded discovery sources. */
  edges: ChzDependencyEdge[];
}

export type ChzDependencyEdgeSource =
  | "signature"
  | "ensure"
  | "requirements-prose"
  | "confirmed";

export interface ChzDependencyEdge {
  dependent: string;
  dependency: string;
  sources: ChzDependencyEdgeSource[];
}

export interface ChzEstimatedDependencySources {
  signature: readonly string[];
  ensure: readonly string[];
  requirementsProse: readonly string[];
}

export interface BuildDependencyGraphOptions {
  /** Maximum symbols one cycle may contain. Default {@link DEFAULT_MAX_CYCLE_SIZE}. */
  maxCycleSize?: number;
  /**
   * Confirmed edges from a previous run's `realization-cache.json` (docs/62
   * stage 3), keyed by symbol name. They are united with the estimated
   * edges: a dependency the model chose during realization must
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

function imagineSpecToAnalyzedSymbol(
  spec: ImagineSpec,
  analysis: ChzSourceFile,
): ChzImagineSymbol {
  const position =
    analysis.typescript.sourceFile.getLineAndCharacterOfPosition(spec.start);
  return {
    name: spec.name,
    type: spec.type,
    definition: spec.originalText,
    file: resolve(analysis.fileName),
    posLine: position.line + 1,
    posCol: position.character + 1,
    dependencies: [],
    circularDependencies: [],
  };
}

/** Lift a compatibility spec with positions from the canonical SourceFile. */
export function imagineSpecToSymbol(
  spec: ImagineSpec,
  analysis: ChzSourceFile,
): ChzImagineSymbol;
export function imagineSpecToSymbol(
  spec: ImagineSpec,
  source: string,
  fileName: string,
): ChzImagineSymbol;
export function imagineSpecToSymbol(
  spec: ImagineSpec,
  sourceOrAnalysis: string | ChzSourceFile,
  fileName?: string,
): ChzImagineSymbol {
  if (typeof sourceOrAnalysis !== "string") {
    return imagineSpecToAnalyzedSymbol(spec, sourceOrAnalysis);
  }
  if (fileName === undefined) {
    throw new Error("A file name is required when lifting an unanalyzed spec.");
  }
  const analysis = analyzeChzSource(sourceOrAnalysis, fileName);
  try {
    return imagineSpecToAnalyzedSymbol(spec, analysis);
  } finally {
    analysis.dispose();
  }
}

function imagineSymbolsById(
  analysis: ChzSourceFile,
): ReadonlyMap<number, string> {
  const checker = analysis.typescript.checker;
  const symbols = new Map<number, string>();
  for (const declaration of analysis.imagineDeclarations) {
    const name = declaration.declaration.name;
    if (name === undefined) continue;
    const symbol = unaliasSymbol(checker, checker.getSymbolAtLocation(name));
    if (symbol !== undefined) symbols.set(symbol.id, declaration.name);
  }
  return symbols;
}

function requirementsProse(
  declaration: ChzImagineDeclaration,
): string {
  return [
    declaration.requirements?.value.text ?? "",
    ...(declaration.kind === "ImagineClass"
      ? declaration.members.map((member) =>
          member.requirements?.value.text ?? ""
        )
      : []),
  ].join("\n");
}

/**
 * Analyze the three estimated-edge sources without mixing their semantics.
 * Signature and ensure identities come from Checker symbols; only prose uses
 * the explicit natural-language matcher.
 */
export function collectEstimatedDependencySources(
  analysis: ChzSourceFile,
): ReadonlyMap<string, ChzEstimatedDependencySources> {
  const imagineById = imagineSymbolsById(analysis);
  const names = analysis.imagineDeclarations.map((declaration) =>
    declaration.name
  );
  const result = new Map<string, ChzEstimatedDependencySources>();
  for (const declaration of analysis.imagineDeclarations) {
    const signature = new Set<string>();
    for (
      const reference of collectTypeSymbolReferences(
        analysis,
        declaration.declaration,
        declaration.declaration,
      )
    ) {
      const name = imagineById.get(reference.symbol.id);
      if (name !== undefined) signature.add(name);
    }

    const ensure = new Set<string>();
    for (const scope of declarationEnsureScopes(declaration)) {
      for (
        const reference of collectSymbolReferences(
          analysis,
          scope.ensure.conditionOrScenario,
          scope.owner,
        )
      ) {
        const name = imagineById.get(reference.symbol.id);
        if (name !== undefined) ensure.add(name);
      }
    }

    result.set(declaration.name, {
      signature: names.filter((name) => signature.has(name)),
      ensure: names.filter((name) => ensure.has(name)),
      requirementsProse: mentionedSymbols(
        requirementsProse(declaration),
        names,
      ),
    });
  }
  return result;
}

const EDGE_SOURCE_ORDER: readonly ChzDependencyEdgeSource[] = [
  "signature",
  "ensure",
  "requirements-prose",
  "confirmed",
];

function buildAnalyzedDependencyGraph(
  analysis: ChzSourceFile,
  specs: readonly ImagineSpec[],
  options: BuildDependencyGraphOptions,
): ChzDependencyGraph {
  const maxCycleSize = options.maxCycleSize ?? DEFAULT_MAX_CYCLE_SIZE;
  const symbols = specs.map((spec) =>
    imagineSpecToAnalyzedSymbol(spec, analysis)
  );
  const estimated = collectEstimatedDependencySources(analysis);
  const sourcesByDependent = new Map<
    string,
    Map<string, Set<ChzDependencyEdgeSource>>
  >();
  const add = (
    dependent: string,
    dependency: string,
    source: ChzDependencyEdgeSource,
  ): void => {
    if (dependent === dependency) return;
    const byDependency = sourcesByDependent.get(dependent) ??
      new Map<string, Set<ChzDependencyEdgeSource>>();
    const sources = byDependency.get(dependency) ??
      new Set<ChzDependencyEdgeSource>();
    sources.add(source);
    byDependency.set(dependency, sources);
    sourcesByDependent.set(dependent, byDependency);
  };

  for (const symbol of symbols) {
    const discovered = estimated.get(symbol.name);
    for (const dependency of discovered?.signature ?? []) {
      add(symbol.name, dependency, "signature");
    }
    for (const dependency of discovered?.ensure ?? []) {
      add(symbol.name, dependency, "ensure");
    }
    for (const dependency of discovered?.requirementsProse ?? []) {
      add(symbol.name, dependency, "requirements-prose");
    }
    for (const dependency of options.confirmedEdges?.get(symbol.name) ?? []) {
      add(symbol.name, dependency, "confirmed");
    }
  }

  const knownNames = new Set(symbols.map((symbol) => symbol.name));
  for (const symbol of symbols) {
    const discovered = sourcesByDependent.get(symbol.name);
    symbol.dependencies = symbols.filter((candidate) =>
      candidate !== symbol &&
      knownNames.has(candidate.name) &&
      discovered?.has(candidate.name) === true
    );
  }

  const sourceIndex = new Map(
    symbols.map((symbol, index) => [symbol, index]),
  );
  const groups: ChzRealizeGroup[] = tarjanComponents(symbols).map(
    (members) => {
      const ordered = [...members].sort(
        (left, right) =>
          sourceIndex.get(left)! - sourceIndex.get(right)!,
      );
      const circular = ordered.length > 1;
      for (const member of ordered) {
        member.circularDependencies = circular
          ? ordered.filter((candidate) => candidate !== member)
          : [];
      }
      return { symbols: ordered, circular };
    },
  );

  const warnings = groups
    .filter((group) => group.circular)
    .map(
      (group) =>
        `Dependency cycle detected: ${group.symbols.map((symbol) => symbol.name).join(" ↔ ")}. ` +
        `The whole cycle will be realized together in one session; consider extracting a ` +
        `shared human-owned interface to break it.`,
    );

  const oversized = groups.find((group) =>
    group.symbols.length > maxCycleSize
  );
  if (oversized !== undefined) {
    throw new ChzCycleError(
      oversized.symbols.map((symbol) => symbol.name),
      maxCycleSize,
    );
  }

  const edges = symbols.flatMap((dependent) => {
    const sources = sourcesByDependent.get(dependent.name);
    return symbols.flatMap((dependency): ChzDependencyEdge[] => {
      if (
        dependency === dependent ||
        sources?.has(dependency.name) !== true
      ) {
        return [];
      }
      const discoveredSources = sources.get(dependency.name)!;
      return [{
        dependent: dependent.name,
        dependency: dependency.name,
        sources: EDGE_SOURCE_ORDER.filter((source) =>
          discoveredSources.has(source)
        ),
      }];
    });
  });

  return { symbols, groups, warnings, edges };
}

/**
 * Build the dependency graph and the SCC realize order for one source file.
 *
 * @throws {ChzCycleError} when a cycle exceeds `maxCycleSize`.
 */
export function buildDependencyGraph(
  analysis: ChzSourceFile,
  options?: BuildDependencyGraphOptions,
): ChzDependencyGraph;
export function buildDependencyGraph(
  specs: readonly ImagineSpec[],
  source: string,
  fileName: string,
  options?: BuildDependencyGraphOptions,
): ChzDependencyGraph;
export function buildDependencyGraph(
  analysisOrSpecs: ChzSourceFile | readonly ImagineSpec[],
  sourceOrOptions: string | BuildDependencyGraphOptions = {},
  fileName?: string,
  legacyOptions: BuildDependencyGraphOptions = {},
): ChzDependencyGraph {
  if (!Array.isArray(analysisOrSpecs)) {
    const analysis = analysisOrSpecs as ChzSourceFile;
    const options = typeof sourceOrOptions === "string"
      ? {}
      : sourceOrOptions;
    return buildAnalyzedDependencyGraph(
      analysis,
      imagineSpecsFromChzSource(analysis),
      options,
    );
  }
  if (typeof sourceOrOptions !== "string" || fileName === undefined) {
    throw new Error(
      "Legacy dependency graph input requires source text and a file name.",
    );
  }
  const analysis = analyzeChzSource(sourceOrOptions, fileName);
  try {
    return buildAnalyzedDependencyGraph(
      analysis,
      analysisOrSpecs,
      legacyOptions,
    );
  } finally {
    analysis.dispose();
  }
}

/**
 * The flattened estimated realize order (dependencies before dependents).
 * Cycle members stay adjacent in source order. Kept as a tolerant preview
 * API: it never throws on large cycles, unlike {@link buildDependencyGraph}
 * which the engine and `--dry-run` use with the configured cap.
 */
export function buildEstimatedRealizeOrder(
  analysis: ChzSourceFile,
): ChzImagineSymbol[];
export function buildEstimatedRealizeOrder(
  specs: ImagineSpec[],
  source: string,
  fileName: string,
): ChzImagineSymbol[];
export function buildEstimatedRealizeOrder(
  analysisOrSpecs: ChzSourceFile | ImagineSpec[],
  source?: string,
  fileName?: string,
): ChzImagineSymbol[] {
  const graph = Array.isArray(analysisOrSpecs)
    ? buildDependencyGraph(
        analysisOrSpecs,
        source ?? "",
        fileName ?? "",
        { maxCycleSize: Number.POSITIVE_INFINITY },
      )
    : buildDependencyGraph(
        analysisOrSpecs as ChzSourceFile,
        { maxCycleSize: Number.POSITIVE_INFINITY },
      );
  return graph.groups.flatMap((group) => group.symbols);
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
