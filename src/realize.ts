/** Realize engine: turns preprocessed imagine specs into Realizer sessions. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  ChzCycleError,
  buildDependencyGraph,
  mentionedSymbols,
  type ChzDependencyGraph,
} from "./graph.ts";
import { splitHumanCode } from "./human-code.ts";
import {
  extractImagineSpecs,
  realizationBaseName,
  type ImagineSpec,
} from "./preprocessor.ts";
import { ChzVerificationToolRuntime } from "./realizer/tools/verification.ts";
import type {
  ChzAskUserAnswer,
  ChzAskUserQuestion,
  ChzHarnessServices,
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzRealizationScope,
  ChzRealizer,
  ChzResolutionResolved,
  ChzVerificationResult,
} from "./realizer/types.ts";

export * from "./graph.ts";
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
  /** The session's representative symbol (a cycle group has one session). */
  symbol: ChzImagineSymbol;
  resolution: ChzResolutionResolved;
  attempt: number;
  /**
   * The full verification scope: every symbol the session realized. For a
   * cycle group this covers all members — docs/62 completes a group only
   * when the whole group's tests are green, so custom verifiers must use
   * this scope rather than `symbol` alone.
   */
  scope: ChzRealizationScope;
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
  /** Independent engine verification after Finish, scoped to one symbol. */
  verify?: (input: IndependentVerificationInput) => Promise<ChzVerificationResult>;
  /**
   * Whole-realization verification (epilogue wiring, entry point, full test
   * suite) after every symbol resolved. Defaults to the engine checks.
   */
  verifyRealization?: (baseDir: string) => Promise<ChzVerificationResult>;
  /** Explicit escape hatch used by --skip-tests. */
  skipVerification?: boolean;
  /** Maximum symbols one dependency cycle may contain (docs/62). */
  maxCycleSize?: number;
}

export function realizationBaseDir(fileName: string): string {
  return resolve(dirname(fileName), "chz", "realization", realizationBaseName(fileName));
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

  const resolutions: ChzImagineSymbolResolution[] = [];
  const resolvedByName = new Map<string, ChzResolutionResolved>();
  const realizedSymbols: RealizedSymbol[] = [];
  /**
   * Members of groups that did not resolve, with the root cause. Dependents
   * are skipped either way, but a blocked root keeps the run's outcome
   * "blocked" so the human still sees the todo (docs/63).
   */
  const unrealized = new Map<string, "failed" | "blocked">();

  let graph: ChzDependencyGraph;
  try {
    graph = buildDependencyGraph(specs, source, fileName, { maxCycleSize: options.maxCycleSize });
  } catch (error) {
    if (error instanceof ChzCycleError) return resultWithFailure("failed", error.message);
    throw error;
  }
  for (const warning of graph.warnings) options.harness?.onEvent?.(`[chz-realize] ${warning}`);

  for (const group of graph.groups) {
    const members = group.symbols;
    const memberNames = new Set(members.map((member) => member.name));

    // docs/62: a failed symbol halts only its dependents. Groups arrive in
    // topological order, so every outside dependency has already either
    // resolved or landed in `unrealized` — independent groups keep going.
    const missingDependency = members
      .flatMap((member) => member.dependencies)
      .find((dependency) => !memberNames.has(dependency.name) && unrealized.has(dependency.name));
    if (missingDependency !== undefined) {
      const cause = unrealized.get(missingDependency.name)!;
      for (const member of members) {
        unrealized.set(member.name, cause);
        resolutions.push(
          cause === "blocked"
            ? {
                outcome: "blocked",
                symbol: member,
                reason: `Skipped '${member.name}': dependency '${missingDependency.name}' is blocked.`,
                todo: `Unblock '${missingDependency.name}', then rerun chz realize.`,
              }
            : {
                outcome: "failed",
                symbol: member,
                reason: `Skipped '${member.name}': dependency '${missingDependency.name}' was not realized.`,
              },
        );
      }
      continue;
    }

    const writeEnsures = (): void => {
      for (const member of members) {
        writeFileSync(
          join(baseDir, "tests", `test_${member.name}.ensure.ts`),
          renderEnsureHarness(specByName.get(member.name)!, fileName, specs),
          "utf8",
        );
      }
    };
    writeEnsures();

    // A cycle is one session, so one Realizer must support every member type.
    const realizer = options.realizers.find((candidate) =>
      members.every((member) => candidate.supportedSymbolTypes.includes(member.type)),
    );
    if (realizer === undefined) {
      for (const member of members) {
        unrealized.set(member.name, "failed");
        resolutions.push({
          outcome: "failed",
          symbol: member,
          reason: group.circular
            ? `No realizer supports every symbol type in the dependency cycle ${members.map((item) => `'${item.name}'`).join(", ")}.`
            : `No realizer found for symbol '${member.name}' (type: ${member.type}).`,
        });
      }
      continue;
    }

    const representative = members[0]!;
    const scope: ChzRealizationScope = { symbolNames: members.map((member) => member.name) };
    const memberResolution = (
      member: ChzImagineSymbol,
      resolution: ChzResolutionResolved,
    ): ChzResolutionResolved =>
      member === resolution.symbol ? resolution : {
        outcome: "resolved",
        symbol: member,
        resolvedFile: join(baseDir, "implementations", `${member.name}.ts`),
        resolvedTestFiles: [join(baseDir, "tests", `test_${member.name}.autogen.ts`)],
        // The session-level assumptions report covers the whole cycle.
        ...(resolution.assumptionsReport === undefined
          ? {}
          : { assumptionsReport: resolution.assumptionsReport }),
        resolvedAt: resolution.resolvedAt,
        resolvedBy: resolution.resolvedBy,
      };

    let feedback: string | undefined;
    let groupResolution: ChzImagineSymbolResolution | undefined;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const baseContexts = readContexts(baseDir);
      const context = {
        projectRoot,
        outputDir: baseDir,
        activeProfile,
        scope,
        resolvedDependencies: [
          ...new Map(
            members
              .flatMap((member) => member.dependencies)
              .filter((dependency) => !memberNames.has(dependency.name))
              .flatMap((dependency) => {
                const resolution = resolvedByName.get(dependency.name);
                return resolution === undefined
                  ? []
                  : [[dependency.name, resolution] as const];
              }),
          ).values(),
        ],
        maxTurns,
        maxRetries,
        baseContexts,
        askUser: options.askUser,
        attempt,
        verificationFeedback: feedback,
        now: options.now,
        harness: options.harness,
      };
      const resolution = await realizer.realize(representative, context);
      // These harnesses are human-contract material owned by the engine.
      // Restore them after every session so a model edit can never weaken
      // self-grading.
      writeEnsures();
      // The split human source is engine-owned for the same reason: the model
      // may read prologue helpers but must never rewrite either human layer.
      writeHumanCode();
      groupResolution = resolution;
      if (resolution.outcome !== "resolved") break;

      // The base harness validates every session file at Finish; a custom
      // Realizer may not, and a missing file must never surface later as a
      // raw fs error from provenance stamping or cache building.
      const requiredFiles = members.flatMap((member) =>
        member === resolution.symbol
          ? [resolution.resolvedFile, ...resolution.resolvedTestFiles]
          : [
              join(baseDir, "implementations", `${member.name}.ts`),
              join(baseDir, "tests", `test_${member.name}.autogen.ts`),
            ],
      );
      const missingFile = requiredFiles.find((file) => !existsSync(file));
      if (missingFile !== undefined) {
        groupResolution = {
          outcome: "failed",
          symbol: representative,
          reason: `Realizer claimed Finish, but ${relative(baseDir, missingFile)} was not written.`,
        };
        break;
      }

      const stampedAt = options.now ? options.now() : new Date();
      for (const member of members) {
        attachProvenance(
          specByName.get(member.name)!,
          memberResolution(member, resolution),
          stampedAt,
        );
      }
      if (options.skipVerification) break;

      const verification = options.verify === undefined
        ? await runDefaultVerification(
            baseDir,
            scope,
            projectRoot,
            activeProfile,
            maxTurns,
            maxRetries,
            options.harness,
          )
        : await options.verify({ baseDir, symbol: representative, resolution, attempt, scope });
      if (verification.passed) break;
      feedback = boundVerificationFeedback(verification.output);
      if (attempt > maxRetries) {
        groupResolution = {
          outcome: "failed",
          symbol: representative,
          reason: `Independent verification failed after ${attempt} attempt${attempt === 1 ? "" : "s"}:\n${feedback}`,
        };
      }
    }

    if (groupResolution === undefined) {
      groupResolution = {
        outcome: "failed",
        symbol: representative,
        reason: "Realizer returned no resolution.",
      };
    }

    if (groupResolution.outcome === "resolved") {
      for (const member of members) {
        const resolution = memberResolution(member, groupResolution);
        const spec = specByName.get(member.name)!;
        resolutions.push(resolution);
        resolvedByName.set(member.name, resolution);
        realizedSymbols.push({
          name: member.name,
          spec,
          symbol: member,
          resolution,
          files: collectSymbolFiles(baseDir, spec, resolution),
        });
      }
    } else {
      for (const member of members) {
        unrealized.set(member.name, groupResolution.outcome === "blocked" ? "blocked" : "failed");
        resolutions.push(
          member === groupResolution.symbol
            ? groupResolution
            : { ...groupResolution, symbol: member },
        );
      }
    }
  }

  if (unrealized.size > 0) {
    const failed = resolutions.filter((resolution) => resolution.outcome === "failed");
    const blocked = resolutions.filter((resolution) => resolution.outcome === "blocked");
    const reason = [...new Set([...failed, ...blocked].map((resolution) => resolution.reason))]
      .join("\n");
    const todo = [...new Set(blocked.map((resolution) => resolution.todo))].join("\n");
    return resultWithFailure(
      failed.length > 0 ? "failed" : "blocked",
      reason,
      todo === "" ? undefined : todo,
    );
  }

  if (realizedSymbols.length > 0) {
    writeFileSync(join(baseDir, "implementation.ts"), renderEntryPoint(specs, fileName), "utf8");
  }

  // Per-symbol verification is scoped, so the human epilogue wiring, the entry
  // point, and cross-symbol integration have not been judged yet. One unscoped
  // pass covers them; its failures are not fed back to a model because no
  // single symbol owns them.
  if (realizedSymbols.length > 0 && !options.skipVerification) {
    const finalVerification = options.verifyRealization === undefined
      ? await runDefaultVerification(
          baseDir,
          undefined,
          projectRoot,
          activeProfile,
          maxTurns,
          maxRetries,
          options.harness,
        )
      : await options.verifyRealization(baseDir);
    if (!finalVerification.passed) {
      return resultWithFailure(
        "failed",
        `Whole-realization verification failed after every symbol resolved. The realized symbols are individually green; check the human-owned wiring (__epilogue__) and cross-symbol integration:\n${boundVerificationFeedback(finalVerification.output)}`,
      );
    }
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

/** Deterministic executable tests for human-authored ensures; engine-owned. */
export function renderEnsureHarness(
  spec: ImagineSpec,
  fileName: string,
  allSpecs: readonly ImagineSpec[] = [spec],
): string {
  const base = realizationBaseName(fileName);
  const contracts = [
    ...spec.ensures.map((ensure) => ({ scope: spec.name, ensure })),
    ...spec.members.flatMap((member) =>
      member.ensures.map((ensure) => ({ scope: `${spec.name}.${member.name}`, ensure })),
    ),
  ];
  const contractSource = contracts.map(({ ensure }) => ensure.source).join("\n");
  // The same boundary-aware matcher builds the dependency graph; using it here
  // keeps the harness imports consistent with the realize order (an imported
  // symbol without a graph edge could be realized after this one).
  const mentioned = new Set(
    mentionedSymbols(contractSource, allSpecs.map((candidate) => candidate.name)),
  );
  const importedSymbols = allSpecs
    .filter((candidate) => candidate.name === spec.name || mentioned.has(candidate.name))
    .map((candidate) => candidate.name);
  const valueImports = contracts.length === 0
    ? ""
    : importedSymbols
        .map((name) => `import { ${name} } from "../implementations/${name}.ts";`)
        .join("\n") + "\n";
  const externalTypes = collectExternalTypeNames(spec, new Set(importedSymbols));
  const typeImports = externalTypes.length === 0
    ? ""
    : `import type { ${externalTypes.join(", ")} } from "../implementations/__prologue__.ts";\n`;
  const tests = contracts.length === 0
    ? "// No executable ensure() contracts were declared for this symbol.\n\nexport {};"
    : contracts.map(({ scope, ensure }, index) => {
        const label = ensure.messageSource ?? JSON.stringify(`${scope} ensure #${index + 1}`);
        const location = `${fileName}:${ensure.line}:${ensure.column}`;
        if (ensure.kind === "assertion") {
          const failure = `ensure assertion failed at ${location}\ncondition: ${ensure.source}`;
          return `it(${label}, () => {
  assert(
${indentSource(ensure.source, 4)},
    ${JSON.stringify(failure)},
  );
});`;
        }

        const failurePrefix = `ensure scenario failed at ${location}: `;
        const falseResult = `ensure scenario returned false at ${location}`;
        const argumentsFailure = `ensure scenario at ${location} must not declare parameters`;
        return `it(${label}, async () => {
  const scenario: () => unknown | Promise<unknown> = ${ensure.source};
  if (scenario.length !== 0) {
    throw new Error(${JSON.stringify(argumentsFailure)});
  }
  try {
    const result = await scenario();
    if (result === false) throw new Error(${JSON.stringify(falseResult)});
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(${JSON.stringify(failurePrefix)} + detail);
  }
});`;
      }).join("\n\n");

  return `/// test_${spec.name}.ensure.ts
/// AUTO-GENERATED executable ensure tests — DO NOT EDIT.
/// Generated deterministically by chz-realize from ${base}.chz.ts.

${valueImports}${typeImports}${contracts.length === 0 ? "" : `
declare const it: (name: string, test: () => unknown | Promise<unknown>) => void;

function assert(condition: boolean, message = "ensure assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

`}${tests}
`;
}

function indentSource(source: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return source.split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function collectExternalTypeNames(
  spec: ImagineSpec,
  valueImports: ReadonlySet<string>,
): string[] {
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
    ...spec.ensures.map((ensure) => ensure.source),
    ...spec.members.flatMap((member) => [
      member.parameters,
      member.returnType,
      ...member.ensures.map((ensure) => ensure.source),
    ]),
  ].join("\n");
  const names = maskNonCodeText(typeText).match(/\b[A-Z][A-Za-z0-9_$]*\b/g) ?? [];
  return [...new Set(names.filter((name) => !valueImports.has(name) && !builtins.has(name)))].sort();
}

function maskNonCodeText(source: string): string {
  let result = "";
  let i = 0;
  while (i < source.length) {
    const start = i;
    if (source[i] === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
    } else if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(source.length, i + 2);
    } else if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
      const quote = source[i]!;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        const ch = source[i++];
        if (ch === quote) break;
      }
    } else {
      result += source[i++];
      continue;
    }
    result += source.slice(start, i).replace(/[^\r\n]/g, " ");
  }
  return result;
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
    const declaration = spec.type === "function"
      ? `imagine function ${spec.name}(${spec.parameters})${spec.returnType ? `: ${spec.returnType}` : ""}`
      : `imagine class ${spec.name}`;
    writeFileSync(
      resolution.resolvedFile,
      `/// ${spec.name}.ts\n/// realization of \`${declaration}\`\n/// realized by ${resolution.resolvedBy} (via chz-realize) on ${now.toISOString()}\n///\n/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)\n\n${implementation.trim()}\n\n/// END OF AUTO-GENERATED CODE\n`,
      "utf8",
    );
  }
  for (const testFile of resolution.resolvedTestFiles) {
    const test = readFileSync(testFile, "utf8");
    if (test.includes("AUTO-GENERATED tests")) continue;
    writeFileSync(
      testFile,
      `/// ${relative(dirname(testFile), testFile)}\n/// AUTO-GENERATED tests for \`imagine ${spec.type} ${spec.name}\`, authored by ${resolution.resolvedBy}\n/// (via chz-realize) on ${now.toISOString()}.\n\n${test.trim()}\n`,
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

async function runDefaultVerification(
  baseDir: string,
  scope: ChzRealizationScope | undefined,
  projectRoot: string,
  activeProfile: string,
  maxTurns: number,
  maxRetries: number,
  harness: ChzHarnessServices | undefined,
): Promise<ChzVerificationResult> {
  const context = {
    projectRoot,
    outputDir: baseDir,
    activeProfile,
    scope,
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
