#!/usr/bin/env node
/** chz command-line entrypoint. */

import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import {
  analyzeChzSources,
  renderChzDiagnostics,
  type ChzAnalysisBatch,
  type ChzSourceInput,
  type ChzSourceFile,
} from "./compiler/index.ts";
import {
  imagineSpecsFromChzSource,
  type ImagineSpec,
} from "./preprocessor.ts";
import {
  buildDependencyGraph,
  realize,
  realizationBaseDir,
  type ChzAskUserAnswer,
  type ChzAskUserQuestion,
  type ChzDependencyGraph,
  type ChzProjectConfig,
  type ChzRealizationScope,
  type ChzRealizer,
  type RealizeResult,
} from "./realize.ts";
import { findChzConfig, loadChzConfig } from "./realizer/config.ts";
import { createRenderer } from "./render.ts";
import { ChzOpenAIRealizer } from "./realizer/openai.ts";
import { buildSystemParts } from "./realizer/prompt.ts";
import {
  ChzVerificationToolRuntime,
  runSelectedTests,
} from "./realizer/tools/verification.ts";
import {
  readChzVersion,
  writeRealizationCache,
  type RealizationTestOutcome,
} from "./verify.ts";

export interface CliIO {
  out: (message: string) => void;
  err: (message: string) => void;
}

export interface CliDeps {
  /** Override configuration loading in tests or embedding applications. */
  config?: ChzProjectConfig;
  projectRoot?: string;
  makeDefaultRealizer?: (options: { model: string; baseURL?: string }) => ChzRealizer;
  now?: () => Date;
  runTests?: (
    baseDir: string,
    testFiles: readonly string[],
  ) => Promise<RealizationTestOutcome>;
  askUser?: (questions: ChzAskUserQuestion[]) => Promise<ChzAskUserAnswer[]>;
  chzVersion?: string;
}

export type CommandHandler = (
  args: string[],
  io: CliIO,
  deps: CliDeps,
) => number | Promise<number>;

export const BIN_NAME = "chz";

interface RealizeArguments {
  file?: string;
  json: boolean;
  dryRun: boolean;
  skipTests: boolean;
  simplify: boolean;
  jobs?: number;
  model?: string;
  baseURL?: string;
  configPath?: string;
}

function parseRealizeArguments(args: string[], io: CliIO): RealizeArguments | null {
  const parsed: RealizeArguments = { json: false, dryRun: false, skipTests: false, simplify: false };
  const setJobs = (value: string): boolean => {
    const jobs = Number(value);
    if (!Number.isInteger(jobs) || jobs < 1) {
      io.err(`${BIN_NAME} realize: --jobs requires a positive integer, got '${value}'`);
      return false;
    }
    parsed.jobs = jobs;
    return true;
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--json") parsed.json = true;
    else if (argument === "--dry-run") parsed.dryRun = true;
    else if (argument === "--skip-tests") parsed.skipTests = true;
    else if (argument === "-s" || argument === "--simplify-output") parsed.simplify = true;
    else if (argument === "-j" || argument === "--jobs") {
      const value = args[++index];
      if (value === undefined) {
        io.err(`${BIN_NAME} realize: ${argument} requires a value`);
        return null;
      }
      if (!setJobs(value)) return null;
    } else if (argument.startsWith("--jobs=")) {
      if (!setJobs(argument.slice("--jobs=".length))) return null;
    } else if (/^-j\d+$/.test(argument)) {
      if (!setJobs(argument.slice(2))) return null;
    } else if (argument === "--model" || argument === "--base-url" || argument === "--config") {
      const value = args[++index];
      if (value === undefined) {
        io.err(`${BIN_NAME} realize: ${argument} requires a value`);
        return null;
      }
      if (argument === "--model") parsed.model = value;
      else if (argument === "--base-url") parsed.baseURL = value;
      else parsed.configPath = value;
    } else if (argument.startsWith("--model=")) parsed.model = argument.slice("--model=".length);
    else if (argument.startsWith("--base-url=")) parsed.baseURL = argument.slice("--base-url=".length);
    else if (argument.startsWith("--config=")) parsed.configPath = argument.slice("--config=".length);
    else if (argument.startsWith("--")) {
      io.err(`${BIN_NAME} realize: unknown option '${argument}'`);
      return null;
    } else if (parsed.file === undefined) parsed.file = argument;
    else {
      io.err(`${BIN_NAME} realize: unexpected argument '${argument}'`);
      return null;
    }
  }
  return parsed;
}

interface ConfiguredProject {
  config: ChzProjectConfig;
  projectRoot: string;
  path?: string;
}

const realizeCommand: CommandHandler = async (args, io, deps) => {
  const parsed = parseRealizeArguments(args, io);
  if (parsed === null) return 1;

  if (parsed.file !== undefined) {
    const sourceFile = resolve(parsed.file);
    let configured: ConfiguredProject | undefined;
    return realizeSourceFiles(
      [{ sourceFile, displayName: parsed.file }],
      parsed,
      io,
      deps,
      async () =>
        (configured ??= await resolveConfiguration(sourceFile, parsed, deps)),
    );
  }

  // Without a file, chz.config.js names the sources through 'include' globs.
  if (parsed.json) {
    io.err(`${BIN_NAME} realize: --json requires an explicit <file> argument`);
    return 1;
  }
  let configured: ConfiguredProject;
  try {
    configured = await resolveIncludeConfiguration(parsed, deps);
  } catch (error) {
    io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
    return 1;
  }
  const include = configured.config.include;
  if (include === undefined || include.length === 0) {
    io.err(
      `${BIN_NAME} realize: missing <file> argument and the configuration declares no 'include' globs`,
    );
    io.err(
      `usage: ${BIN_NAME} realize [file] [--json] [--dry-run] [--skip-tests] [-j <n>] [--model <name>] [--base-url <url>] [--config <path>]`,
    );
    return 1;
  }
  const files = [
    ...new Set(
      globSync(include, { cwd: configured.projectRoot }).map((path) =>
        resolve(configured.projectRoot, path),
      ),
    ),
  ]
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .sort();
  if (files.length === 0) {
    io.err(`${BIN_NAME} realize: 'include' matched no files (${include.join(", ")})`);
    return 1;
  }
  if (configured.path !== undefined) io.err(`config: ${configured.path}`);
  return realizeSourceFiles(
    files.map((file) => ({
      sourceFile: file,
      displayName: relative(process.cwd(), file) || file,
    })),
    parsed,
    io,
    deps,
    async () => configured,
    false,
    true,
  );
};

interface RealizeSourceRequest {
  sourceFile: string;
  displayName: string;
}

async function realizeSourceFiles(
  requests: readonly RealizeSourceRequest[],
  parsed: RealizeArguments,
  io: CliIO,
  deps: CliDeps,
  getConfigured: () => Promise<ConfiguredProject>,
  announceConfig = true,
  announceFiles = false,
): Promise<number> {
  const readable: Array<{
    request: RealizeSourceRequest;
    input: ChzSourceInput;
  }> = [];
  let exitCode = 0;
  for (const request of requests) {
    try {
      readable.push({
        request,
        input: {
          source: readFileSync(request.sourceFile, "utf8"),
          fileName: request.sourceFile,
        },
      });
    } catch (error) {
      io.err(
        `${BIN_NAME} realize: cannot read file '${request.displayName}': ${(error as Error).message}`,
      );
      exitCode = 1;
    }
  }
  if (readable.length === 0) return exitCode;

  let batch: ChzAnalysisBatch;
  try {
    batch = analyzeChzSources(readable.map(({ input }) => input));
  } catch (error) {
    io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
    return 1;
  }

  // The CLI owns one compiler snapshot for the complete source batch. Every
  // file shares its Program/lib state, and the snapshot stays alive until all
  // dry-run, JSON, or asynchronous realization consumers have finished.
  try {
    for (const [index, analysis] of batch.sourceFiles.entries()) {
      const request = readable[index]!.request;
      if (announceFiles) io.err(`==> ${request.displayName}`);
      const code = await realizeAnalyzedSourceFile(
        analysis,
        request.displayName,
        parsed,
        io,
        deps,
        getConfigured,
        announceConfig,
      );
      exitCode = Math.max(exitCode, code);
    }
    return exitCode;
  } finally {
    batch.dispose();
  }
}

async function realizeAnalyzedSourceFile(
  analysis: ChzSourceFile,
  displayName: string,
  parsed: RealizeArguments,
  io: CliIO,
  deps: CliDeps,
  getConfigured: () => Promise<ConfiguredProject>,
  announceConfig: boolean,
): Promise<number> {
  // One shared analysis owns grammar, syntactic, and semantic preflight.
  // Promoted obligations are intentionally absent from diagnostics and do not
  // block any of the JSON, dry-run, or realization command paths.
  if (analysis.diagnostics.length > 0) {
    const format = parsed.json ? "json" : "human";
    const write = parsed.json ? io.out : io.err;
    for (const rendered of renderChzDiagnostics(analysis.diagnostics, format)) {
      write(rendered);
    }
    return 1;
  }
  const source = analysis.source;
  const sourceFile = analysis.fileName;
  const specs: ImagineSpec[] = imagineSpecsFromChzSource(analysis);
  if (parsed.json) {
    io.out(JSON.stringify(specs, null, 2));
    return 0;
  }
  if (specs.length === 0) {
    io.out(`${displayName}: no imagine symbols to realize`);
    return 0;
  }

  let configured: ConfiguredProject;
  try {
    configured = await getConfigured();
  } catch (error) {
    io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
    return 1;
  }

  if (parsed.dryRun) {
    let graph: ChzDependencyGraph;
    try {
      graph = buildDependencyGraph(analysis, {
        maxCycleSize: configured.config.maxCycleSize,
      });
    } catch (error) {
      io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
      return 1;
    }
    for (const warning of graph.warnings) io.err(`${BIN_NAME} realize: warning: ${warning}`);
    for (const group of graph.groups) {
      // Mirror the engine: a cycle is one session, so one Realizer must
      // support every member type.
      const realizer = configured.config.realizers.find((candidate) =>
        group.symbols.every((member) => candidate.supportedSymbolTypes.includes(member.type)),
      );
      if (realizer === undefined) {
        const label = group.symbols
          .map((member) => `'${member.name}' (${member.type})`)
          .join(", ");
        io.err(`${BIN_NAME} realize: no Realizer supports ${label}`);
        return 1;
      }
      const representative = group.symbols[0]!;
      const model = "modelLabel" in realizer && typeof realizer.modelLabel === "string"
        ? realizer.modelLabel
        : realizer.name;
      const context = {
        projectRoot: configured.projectRoot,
        outputDir: realizationBaseDir(sourceFile),
        activeProfile:
          configured.config.profile ?? analysis.profile?.name ?? "console",
        ...(configured.config.blockedPaths === undefined
          ? {}
          : { blockedPaths: configured.config.blockedPaths }),
        resolvedDependencies: [],
        maxTurns: configured.config.maxTurns ?? 24,
        maxRetries: configured.config.maxRetries ?? 2,
        baseContexts: "",
        now: deps.now,
      };
      const [fixed, baseline] = buildSystemParts(representative, context, model);
      const sessionLabel = group.symbols.map((member) => member.name).join(" ↔ ");
      io.out(`===== Realizer system prompt: ${sessionLabel} (${realizer.name}) =====`);
      io.out(fixed);
      io.out("");
      io.out(baseline);
    }
    return 0;
  }

  if (announceConfig && configured.path !== undefined) io.err(`config: ${configured.path}`);
  let lastTestOutcome: RealizationTestOutcome | undefined;
  const runTests = deps.runTests ?? runSelectedTests;
  const runVerificationChecks = async (baseDir: string, scope?: ChzRealizationScope) => {
    const verificationContext = {
      projectRoot: configured.projectRoot,
      outputDir: baseDir,
      activeProfile:
        configured.config.profile ?? analysis.profile?.name ?? "console",
      scope,
      resolvedDependencies: [],
      maxTurns: configured.config.maxTurns ?? 24,
      maxRetries: configured.config.maxRetries ?? 2,
      baseContexts: "",
      harness: {
        runTests: async (testFiles: string[]) => {
          lastTestOutcome = await runTests(baseDir, testFiles);
          return {
            passed: lastTestOutcome.passed,
            output: lastTestOutcome.output,
            testCount: lastTestOutcome.testCount,
            timedOut: lastTestOutcome.timedOut,
          };
        },
      },
    };
    const runtime = new ChzVerificationToolRuntime(
      verificationContext,
      (path) => resolve(configured.projectRoot, path),
    );
    const checks = await Promise.all([
      runtime.execute("RunTests", { testFiles: [] }),
      runtime.execute("RunTypeCheck", {}),
      runtime.execute("RunLinter", {}),
    ]);
    const parsed = checks.map((check, index) => {
      if (check === null) return { passed: false, output: `verification tool ${index + 1} was unavailable` };
      try {
        return JSON.parse(check) as { passed: boolean; output?: string; diagnostics?: unknown[] };
      } catch {
        return { passed: false, output: check };
      }
    });
    return {
      passed: parsed.every((check) => check.passed),
      output: parsed.map((check, index) =>
        `## ${["Tests", "Type check", "Linter"][index]}\n${check.output ?? JSON.stringify(check.diagnostics ?? [], null, 2)}`,
      ).join("\n\n"),
    };
  };

  // All progress (events, reasoning, live view) renders on stderr; stdout
  // carries only results, so `chz realize > out.txt` stays clean.
  const stderrTTY = process.stderr.isTTY === true;
  const renderer = createRenderer({
    simplify: parsed.simplify,
    color: stderrTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb",
    err: io.err,
    ...(parsed.simplify && stderrTTY ? { tty: process.stderr } : {}),
  });
  const baseAskUser = deps.askUser ??
    (process.stdin.isTTY && stderrTTY ? interactiveAskUser(io) : undefined);
  const askUser = baseAskUser === undefined
    ? undefined
    : async (questions: ChzAskUserQuestion[]): Promise<ChzAskUserAnswer[]> => {
        // The live view and an interactive prompt cannot share the terminal.
        renderer.suspend();
        try {
          return await baseAskUser(questions);
        } finally {
          renderer.resume();
        }
      };

  let result: RealizeResult;
  try {
    result = await realize(analysis, {
      realizers: configured.config.realizers,
      projectRoot: configured.projectRoot,
      activeProfile: configured.config.profile,
      blockedPaths: configured.config.blockedPaths,
      maxTurns: configured.config.maxTurns,
      maxRetries: configured.config.maxRetries,
      maxCycleSize: configured.config.maxCycleSize,
      jobs: parsed.jobs ?? configured.config.jobs,
      chzVersion: deps.chzVersion,
      askUser,
      now: deps.now,
      skipVerification: parsed.skipTests,
      // input.scope covers every session symbol — for a cycle group, scoping
      // to input.symbol alone would verify only the representative (docs/62
      // completes a group only when the whole group is green).
      verify: (input) => runVerificationChecks(input.baseDir, input.scope),
      verifyRealization: (baseDir) => runVerificationChecks(baseDir),
      harness: {
        runTests: async (testFiles) => {
          const outcome = await runTests(realizationBaseDir(sourceFile), testFiles);
          return {
            passed: outcome.passed,
            output: outcome.output,
            testCount: outcome.testCount,
            timedOut: outcome.timedOut,
          };
        },
        onEvent: (event) => renderer.event(event),
      },
    });
  } catch (error) {
    renderer.close();
    io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
    return 1;
  }
  renderer.close();

  if (result.outcome === "blocked") {
    io.err(`== BLOCKED ==\n${result.reason ?? "Realizer requires human action."}`);
    if (result.todo !== undefined) io.err(`TODO: ${result.todo}`);
    return 1;
  }
  if (result.outcome === "failed") {
    io.err(`${BIN_NAME} realize: ${result.reason ?? "realization failed"}`);
    return 1;
  }

  const count = result.symbols.length;
  const reusedCount = result.symbols.filter((symbol) => symbol.reused).length;
  const reuseNote = reusedCount === 0 ? "" : ` (${reusedCount} reused from cache)`;
  io.out(`${displayName}: realized ${count} symbol${count === 1 ? "" : "s"}${reuseNote}`);
  io.out(`  output: ${result.baseDir}`);
  for (const file of result.files) io.out(`  + ${file.relPath}`);
  // The shim lives next to the source, not under the output directory, so it
  // is reported on its own line (docs/20).
  if (result.shim !== undefined) io.out(`  shim: ${result.shim}`);

  const realizedAt = (deps.now ? deps.now() : new Date()).toISOString();
  if (parsed.skipTests) {
    io.err(
      `${BIN_NAME} realize: --skip-tests set — emitted files were NOT independently verified; cache records testsPassed: false (skipped).`,
    );
  }
  const cachePath = writeRealizationCache({
    result,
    source,
    chzVersion: deps.chzVersion ?? readChzVersion(),
    modelLabel: result.symbols.map((symbol) => symbol.resolution.resolvedBy).join(", "),
    realizedAt,
    testsPassed: !parsed.skipTests,
    testsSkipped: parsed.skipTests,
  });
  io.out(`  cache: ${cachePath}`);
  if (lastTestOutcome !== undefined && !parsed.skipTests) {
    const countLabel = lastTestOutcome.testCount === null ? "tests passed" : `${lastTestOutcome.testCount} tests passed`;
    io.out(`  ${countLabel}`);
  }
  return 0;
}

/** Configuration lookup for the file-less form: search from the cwd. */
async function resolveIncludeConfiguration(
  parsed: RealizeArguments,
  deps: CliDeps,
): Promise<ConfiguredProject> {
  if (deps.config !== undefined) {
    return { config: deps.config, projectRoot: resolve(deps.projectRoot ?? process.cwd()) };
  }
  const configPath = parsed.configPath === undefined
    ? findChzConfig(process.cwd())
    : resolve(parsed.configPath);
  if (configPath === null) {
    throw new Error(
      "missing <file> argument and no chz.config.js was found to supply 'include' globs.",
    );
  }
  if (parsed.model !== undefined || parsed.baseURL !== undefined) {
    throw new Error("--model and --base-url configure only the default OpenAI Realizer; configure injected realizers in chz.config.js instead.");
  }
  const loaded = await loadChzConfig(configPath);
  return { config: loaded.config, projectRoot: loaded.projectRoot, path: loaded.path };
}

async function resolveConfiguration(
  sourceFile: string,
  parsed: RealizeArguments,
  deps: CliDeps,
): Promise<{ config: ChzProjectConfig; projectRoot: string; path?: string }> {
  if (deps.config !== undefined) {
    return { config: deps.config, projectRoot: resolve(deps.projectRoot ?? dirname(sourceFile)) };
  }
  const configPath = parsed.configPath === undefined
    ? findChzConfig(dirname(sourceFile))
    : resolve(parsed.configPath);
  if (configPath !== null) {
    if (parsed.model !== undefined || parsed.baseURL !== undefined) {
      throw new Error("--model and --base-url configure only the default OpenAI Realizer; configure injected realizers in chz.config.js instead.");
    }
    const loaded = await loadChzConfig(configPath);
    return { config: loaded.config, projectRoot: loaded.projectRoot, path: loaded.path };
  }

  const model = parsed.model ?? process.env.OPENAI_MODEL;
  if (model === undefined || model.trim() === "") {
    throw new Error(
      "no chz.config.js was found and no OpenAI model was configured. Set OPENAI_MODEL, pass --model, or inject realizers from chz.config.js.",
    );
  }
  const makeDefault = deps.makeDefaultRealizer ?? ((options) => new ChzOpenAIRealizer(options));
  return {
    config: { realizers: [makeDefault({ model, baseURL: parsed.baseURL })] },
    projectRoot: resolve(deps.projectRoot ?? defaultProjectRoot(sourceFile)),
  };
}

function defaultProjectRoot(sourceFile: string): string {
  const cwd = resolve(process.cwd());
  const relativeSource = relative(cwd, resolve(sourceFile));
  return relativeSource !== ".." && !relativeSource.startsWith("../") && !isAbsolute(relativeSource)
    ? cwd
    : dirname(sourceFile);
}

function interactiveAskUser(io: CliIO) {
  return async (questions: ChzAskUserQuestion[]): Promise<ChzAskUserAnswer[]> => {
    // Prompts are interaction, not results: stderr, like the progress stream.
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answers: ChzAskUserAnswer[] = [];
      for (const question of questions) {
        io.err(`Question from Realizer — ${question.header}:`);
        io.err(question.question);
        question.options.forEach((option, index) => {
          io.err(`  ${index + 1}. ${option.label} — ${option.description}`);
        });
        io.err("  Enter option number(s), or type a free-form answer.");
        const raw = (await readline.question("> ")).trim();
        const tokens = question.multiple ? raw.split(",").map((part) => part.trim()) : [raw];
        answers.push(tokens.filter(Boolean).map((token) => {
          const optionIndex = Number(token) - 1;
          return Number.isInteger(optionIndex) && question.options[optionIndex] !== undefined
            ? question.options[optionIndex]!.label
            : token;
        }));
      }
      return answers;
    } finally {
      readline.close();
    }
  };
}

export const COMMANDS: Record<string, CommandHandler> = { realize: realizeCommand };

export function buildUsage(): string {
  return [
    "chz — a TypeScript superset where the LLM writes the implementation",
    "      and the human supervises.",
    "",
    `usage: ${BIN_NAME} <command> [options]`,
    "",
    "commands:",
    "  realize [file]   realize imagine symbols through configured Realizers;",
    "                   without <file>, the chz.config.js 'include' globs name",
    "                   the sources",
    "                   [--json]          print extracted specs",
    "                   [--dry-run]       print canonical Realizer prompts",
    "                   [--skip-tests]    skip independent verification",
    "                   [-j, --jobs <n>]  concurrent realize sessions",
    "                   [-s, --simplify-output]",
    "                                     compact per-session progress instead of",
    "                                     the full audit log (live view on a TTY)",
    "                   [--model <name>]  default OpenAI model",
    "                   [--base-url <u>]  OpenAI-compatible API base URL",
    "                   [--config <path>] explicit chz.config.js",
    "",
    "configuration:",
    "  chz.config.js exports { realizers: [...] }; the first Realizer supporting",
    "  a symbol type is selected. Optional keys: include (source globs for the",
    "  file-less form), jobs, maxTurns, maxRetries, maxCycleSize, profile,",
    "  blockedPaths (extra globs the harness may not read or write, added to the",
    "  built-in secrets list).",
    "  Without a config, OPENAI_MODEL/OPENAI_API_KEY/OPENAI_BASE_URL configure",
    "  the default ChzOpenAIRealizer.",
    "",
    "options:",
    "  -h, --help       show this help and exit",
  ].join("\n");
}

export function run(argv: string[], io: CliIO, deps: CliDeps = {}): number | Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.out(buildUsage());
    return 0;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    io.err(`${BIN_NAME}: unknown command '${command}'`);
    io.err(buildUsage());
    return 1;
  }
  return handler(rest, io, deps);
}

const consoleIO: CliIO = {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
};

export async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2), consoleIO);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
