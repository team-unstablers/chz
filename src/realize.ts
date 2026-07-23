/** Realize engine: turns preprocessed imagine specs into Realizer sessions. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { splitHumanCode } from "./human-code.ts";
import {
  extractImagineSpecs,
  realizationBaseName,
  type ImagineSpec,
} from "./preprocessor.ts";
import { selectRealizer } from "./realizer/config.ts";
import { ChzVerificationToolRuntime } from "./realizer/tools/verification.ts";
import type {
  ChzAskUserAnswer,
  ChzAskUserQuestion,
  ChzHarnessServices,
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzRealizer,
  ChzResolutionResolved,
  ChzVerificationResult,
} from "./realizer/types.ts";

export * from "./realizer/index.ts";

export interface EmittedFile {
  relPath: string;
  content: string;
}

export interface RealizedSymbol {
  name: string;
  spec: ImagineSpec;
  symbol: ChzImagineSymbol;
  resolution: ChzResolutionResolved;
  files: EmittedFile[];
}

export interface RealizeResult {
  outcome: "resolved" | "blocked" | "failed";
  fileName: string;
  baseName: string;
  baseDir: string;
  symbols: RealizedSymbol[];
  resolutions: ChzImagineSymbolResolution[];
  files: EmittedFile[];
  reason?: string;
  todo?: string;
}

export interface IndependentVerificationInput {
  baseDir: string;
  symbol: ChzImagineSymbol;
  resolution: ChzResolutionResolved;
  attempt: number;
}

export interface RealizeOptions {
  realizers: readonly ChzRealizer[];
  projectRoot?: string;
  activeProfile?: string;
  maxTurns?: number;
  maxRetries?: number;
  askUser?: (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]>;
  now?: () => Date;
  harness?: ChzHarnessServices;
  /** Independent engine verification after Finish. */
  verify?: (input: IndependentVerificationInput) => Promise<ChzVerificationResult>;
  /** Explicit escape hatch used by --skip-tests. */
  skipVerification?: boolean;
}

export function realizationBaseDir(fileName: string): string {
  return resolve(dirname(fileName), "chz", "realization", realizationBaseName(fileName));
}

export function imagineSpecToSymbol(
  spec: ImagineSpec,
  source: string,
  fileName: string,
): ChzImagineSymbol {
  const before = source.slice(0, spec.start);
  const lines = before.split(/\r?\n/);
  return {
    name: spec.name,
    type: "function",
    definition: spec.originalText,
    file: resolve(fileName),
    posLine: lines.length,
    posCol: (lines.at(-1)?.length ?? 0) + 1,
    dependencies: [],
    circularDependencies: [],
  };
}

/**
 * Build the v0 estimated graph from explicit symbol-name mentions, then return
 * dependencies before dependents. Actual-use graph refinement remains an
 * engine concern and does not leak into Realizer transports.
 */
export function buildEstimatedRealizeOrder(
  specs: ImagineSpec[],
  source: string,
  fileName: string,
): ChzImagineSymbol[] {
  const symbols = specs.map((spec) => imagineSpecToSymbol(spec, source, fileName));
  for (const symbol of symbols) {
    symbol.dependencies = symbols.filter(
      (candidate) => candidate !== symbol && symbol.definition.includes(candidate.name),
    );
  }

  const ordered: ChzImagineSymbol[] = [];
  const permanent = new Set<ChzImagineSymbol>();
  const active: ChzImagineSymbol[] = [];
  const visit = (symbol: ChzImagineSymbol): void => {
    if (permanent.has(symbol)) return;
    const cycleAt = active.indexOf(symbol);
    if (cycleAt >= 0) {
      const cycle = active.slice(cycleAt);
      for (const member of cycle) {
        member.circularDependencies = cycle.filter((candidate) => candidate !== member);
      }
      return;
    }
    active.push(symbol);
    for (const dependency of symbol.dependencies) visit(dependency);
    active.pop();
    permanent.add(symbol);
    ordered.push(symbol);
  };
  for (const symbol of symbols) visit(symbol);
  return ordered;
}

/** Realize every imagine symbol, selecting the first configured compatible Realizer. */
export async function realize(
  source: string,
  fileName: string,
  options: RealizeOptions,
): Promise<RealizeResult> {
  const specs = extractImagineSpecs(source, fileName);
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));
  const baseName = realizationBaseName(fileName);
  const baseDir = realizationBaseDir(fileName);
  const projectRoot = resolve(options.projectRoot ?? dirname(resolve(fileName)));
  const maxTurns = options.maxTurns ?? 24;
  const maxRetries = options.maxRetries ?? 2;
  const activeProfile = options.activeProfile ?? extractProfile(source) ?? "console";
  mkdirSync(join(baseDir, "implementations"), { recursive: true });
  mkdirSync(join(baseDir, "tests"), { recursive: true });
  const humanCode = splitHumanCode(source, fileName, specs);
  const writeHumanCode = (): void => {
    writeFileSync(join(baseDir, "implementations", "__prologue__.ts"), humanCode.prologue, "utf8");
    writeFileSync(join(baseDir, "implementations", "__epilogue__.ts"), humanCode.epilogue, "utf8");
  };
  writeHumanCode();

  const order = buildEstimatedRealizeOrder(specs, source, fileName);
  const resolutions: ChzImagineSymbolResolution[] = [];
  const resolvedByName = new Map<string, ChzResolutionResolved>();
  const realizedSymbols: RealizedSymbol[] = [];

  for (const symbol of order) {
    const spec = specByName.get(symbol.name)!;
    const ensurePath = join(baseDir, "tests", `test_${symbol.name}.ensure.ts`);
    writeFileSync(ensurePath, renderEnsureHarness(spec, fileName), "utf8");

    const realizer = selectRealizer(options.realizers, symbol);
    if (realizer === null) {
      const resolution: ChzImagineSymbolResolution = {
        outcome: "failed",
        symbol,
        reason: `No realizer found for symbol '${symbol.name}' (type: ${symbol.type}).`,
      };
      resolutions.push(resolution);
      return resultWithFailure("failed", resolution.reason);
    }

    let feedback: string | undefined;
    let finalResolution: ChzImagineSymbolResolution | undefined;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const baseContexts = readContexts(baseDir);
      const context = {
        projectRoot,
        outputDir: baseDir,
        activeProfile,
        resolvedDependencies: symbol.dependencies.flatMap((dependency) => {
          const resolution = resolvedByName.get(dependency.name);
          return resolution === undefined ? [] : [resolution];
        }),
        maxTurns,
        maxRetries,
        baseContexts,
        askUser: options.askUser,
        attempt,
        verificationFeedback: feedback,
        now: options.now,
        harness: options.harness,
      };
      const resolution = await realizer.realize(symbol, context);
      // This harness is human-contract material owned by the engine. Restore
      // it after every session so a model edit can never weaken self-grading.
      writeFileSync(ensurePath, renderEnsureHarness(spec, fileName), "utf8");
      // The split human source is engine-owned for the same reason: the model
      // may read prologue helpers but must never rewrite either human layer.
      writeHumanCode();
      finalResolution = resolution;
      if (resolution.outcome !== "resolved") break;

      attachProvenance(spec, resolution, options.now ? options.now() : new Date());
      if (options.skipVerification) break;

      const verification = options.verify === undefined
        ? await runDefaultIndependentVerification(
            { baseDir, symbol, resolution, attempt },
            projectRoot,
            activeProfile,
            maxTurns,
            maxRetries,
            options.harness,
          )
        : await options.verify({ baseDir, symbol, resolution, attempt });
      if (verification.passed) break;
      feedback = boundVerificationFeedback(verification.output);
      if (attempt > maxRetries) {
        finalResolution = {
          outcome: "failed",
          symbol,
          reason: `Independent verification failed after ${attempt} attempt${attempt === 1 ? "" : "s"}:\n${feedback}`,
        };
      }
    }

    if (finalResolution === undefined) {
      finalResolution = { outcome: "failed", symbol, reason: "Realizer returned no resolution." };
    }
    resolutions.push(finalResolution);
    if (finalResolution.outcome === "blocked") {
      return resultWithFailure("blocked", finalResolution.reason, finalResolution.todo);
    }
    if (finalResolution.outcome === "failed") {
      return resultWithFailure("failed", finalResolution.reason);
    }

    resolvedByName.set(symbol.name, finalResolution);
    const files = collectSymbolFiles(baseDir, spec, finalResolution);
    realizedSymbols.push({ name: symbol.name, spec, symbol, resolution: finalResolution, files });
  }

  if (realizedSymbols.length > 0) {
    writeFileSync(join(baseDir, "implementation.ts"), renderEntryPoint(specs, fileName), "utf8");
  }
  const files = collectAllEmittedFiles(baseDir);
  return {
    outcome: "resolved",
    fileName,
    baseName,
    baseDir,
    symbols: realizedSymbols,
    resolutions,
    files,
  };

  function resultWithFailure(
    outcome: "blocked" | "failed",
    reason: string,
    todo?: string,
  ): RealizeResult {
    return {
      outcome,
      fileName,
      baseName,
      baseDir,
      symbols: realizedSymbols,
      resolutions,
      files: collectAllEmittedFiles(baseDir),
      reason,
      ...(todo === undefined ? {} : { todo }),
    };
  }
}

/** Deterministic human ensure harness; this file is engine-owned. */
export function renderEnsureHarness(spec: ImagineSpec, fileName: string): string {
  const base = realizationBaseName(fileName);
  const predicates = spec.ensures.filter((ensure) => ensure.kind === "predicate");
  const externalTypes = collectExternalTypeNames(spec);
  const typeImports = externalTypes.length === 0
    ? ""
    : `import type { ${externalTypes.join(", ")} } from "../implementations/__prologue__.ts";\n\n`;
  const predicateEntries =
    predicates.length === 0
      ? "  // (no predicate `ensure(...)` contracts were declared for this function)"
      : predicates.map((predicate) => `  ${predicate.source},`).join("\n");
  const sourceEntries = predicates.map((predicate) => `  ${JSON.stringify(predicate.source)},`).join("\n");

  return `/// test_${spec.name}.ensure.ts
/// AUTO-GENERATED ensure-contract harness — DO NOT EDIT.
/// Generated deterministically by chz-realize from ${base}.chz.ts.

${typeImports}type EnsurePredicate = (args: readonly unknown[], retval: unknown) => unknown;

const ENSURE_PREDICATES: readonly EnsurePredicate[] = [
${predicateEntries}
];

const ENSURE_SOURCES: readonly string[] = [
${sourceEntries}
];

export function assertEnsures(args: readonly unknown[], retval: unknown): void {
  ENSURE_PREDICATES.forEach((predicate, index) => {
    const satisfied = predicate(args, retval);
    if (!satisfied) {
      throw new Error(
        \`ensure contract #\${index + 1} of \\\`${spec.name}\\\` was violated.\\n\` +
          \`  contract: \${ENSURE_SOURCES[index]}\\n\` +
          \`  args:     \${describeValue(args)}\\n\` +
          \`  returned: \${describeValue(retval)}\\n\` +
          \`  predicate returned: \${describeValue(satisfied)}\`,
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
`;
}

function collectExternalTypeNames(spec: ImagineSpec): string[] {
  const builtins = new Set([
    "Array",
    "BigInt",
    "Boolean",
    "Date",
    "Error",
    "Function",
    "Map",
    "Number",
    "Object",
    "Promise",
    "Readonly",
    "ReadonlyArray",
    "Record",
    "RegExp",
    "Set",
    "String",
    "Symbol",
    "Uint8Array",
    "WeakMap",
    "WeakSet",
  ]);
  const typeText = [
    spec.parameters,
    spec.returnType,
    ...spec.ensures.filter((ensure) => ensure.kind === "predicate").map((ensure) => ensure.source),
  ].join("\n");
  const names = typeText.match(/\b[A-Z][A-Za-z0-9_$]*\b/g) ?? [];
  return [...new Set(names.filter((name) => !builtins.has(name)))].sort();
}

export function renderEntryPoint(specs: ImagineSpec[], fileName: string): string {
  const base = realizationBaseName(fileName);
  const exports = specs
    .map((spec) => `export { ${spec.name} } from "./implementations/${spec.name}.ts";`)
    .join("\n");
  return `/// implementation.ts — realization entry point for ${base}.chz.ts (AUTO-GENERATED by chz-realize).
/// Loads human prologue, realized symbols, then human epilogue. Do not edit; re-run \`chz realize\` instead.

import "./implementations/__prologue__.ts";

${exports}

import "./implementations/__epilogue__.ts";
`;
}

function attachProvenance(spec: ImagineSpec, resolution: ChzResolutionResolved, now: Date): void {
  const implementation = readFileSync(resolution.resolvedFile, "utf8");
  if (!implementation.includes("AUTO-GENERATED CODE - DO NOT EDIT")) {
    const parameters = `${spec.name}(${spec.parameters})${spec.returnType ? `: ${spec.returnType}` : ""}`;
    writeFileSync(
      resolution.resolvedFile,
      `/// ${spec.name}.ts\n/// realization of \`imagine function ${parameters}\`\n/// realized by ${resolution.resolvedBy} (via chz-realize) on ${now.toISOString()}\n///\n/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)\n\n${implementation.trim()}\n\n/// END OF AUTO-GENERATED CODE\n`,
      "utf8",
    );
  }
  for (const testFile of resolution.resolvedTestFiles) {
    const test = readFileSync(testFile, "utf8");
    if (test.includes("AUTO-GENERATED tests")) continue;
    writeFileSync(
      testFile,
      `/// ${relative(dirname(testFile), testFile)}\n/// AUTO-GENERATED tests for \`imagine function ${spec.name}\`, authored by ${resolution.resolvedBy}\n/// (via chz-realize) on ${now.toISOString()}.\n\n${test.trim()}\n`,
      "utf8",
    );
  }
}

function collectSymbolFiles(
  baseDir: string,
  spec: ImagineSpec,
  resolution: ChzResolutionResolved,
): EmittedFile[] {
  const paths = [
    resolution.resolvedFile,
    ...resolution.resolvedTestFiles,
    join(baseDir, "tests", `test_${spec.name}.ensure.ts`),
  ];
  return [...new Set(paths)].filter(existsSync).map((path) => ({
    relPath: relative(baseDir, path).split("\\").join("/"),
    content: readFileSync(path, "utf8"),
  }));
}

function collectAllEmittedFiles(baseDir: string, directory = baseDir): EmittedFile[] {
  if (!existsSync(directory)) return [];
  const result: EmittedFile[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectAllEmittedFiles(baseDir, path));
    else if (entry.isFile() && entry.name !== "CONTEXTS.md" && entry.name !== "realization-cache.json") {
      result.push({
        relPath: relative(baseDir, path).split("\\").join("/"),
        content: readFileSync(path, "utf8"),
      });
    }
  }
  return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function readContexts(baseDir: string): string {
  const path = join(baseDir, "CONTEXTS.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function extractProfile(source: string): string | null {
  return /^\s*@profile\s+([\p{L}_$][\p{L}\p{N}_$]*)/mu.exec(source)?.[1] ?? null;
}

function boundVerificationFeedback(output: string): string {
  const lines = output.split(/\r?\n/);
  const boundedLines = lines.length <= 2_000 ? lines : [...lines.slice(0, 1_000), "... output truncated ...", ...lines.slice(-1_000)];
  let bounded = boundedLines.join("\n");
  if (Buffer.byteLength(bounded, "utf8") > 51_200) {
    bounded = Buffer.from(bounded, "utf8").subarray(0, 51_000).toString("utf8") + "\n... output truncated ...";
  }
  return bounded;
}

async function runDefaultIndependentVerification(
  input: IndependentVerificationInput,
  projectRoot: string,
  activeProfile: string,
  maxTurns: number,
  maxRetries: number,
  harness: ChzHarnessServices | undefined,
): Promise<ChzVerificationResult> {
  const context = {
    projectRoot,
    outputDir: input.baseDir,
    activeProfile,
    resolvedDependencies: [],
    maxTurns,
    maxRetries,
    baseContexts: "",
    harness,
  };
  const runtime = new ChzVerificationToolRuntime(context, (path) => resolve(projectRoot, path));
  const checks = await Promise.all([
    runtime.execute("RunTests", { testFiles: [] }),
    runtime.execute("RunTypeCheck", {}),
    runtime.execute("RunLinter", {}),
  ]);
  const names = ["Tests", "Type check", "Linter"];
  const parsed = checks.map((check, index) => {
    if (check === null) return { passed: false, output: `${names[index]} tool was unavailable.` };
    try {
      return JSON.parse(check) as { passed: boolean; output?: string; diagnostics?: unknown[] };
    } catch {
      return { passed: false, output: check };
    }
  });
  return {
    passed: parsed.every((check) => check.passed),
    output: parsed.map((check, index) =>
      `## ${names[index]}\n${check.output ?? JSON.stringify(check.diagnostics ?? [], null, 2)}`,
    ).join("\n\n"),
  };
}
