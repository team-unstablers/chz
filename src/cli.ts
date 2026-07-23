#!/usr/bin/env node
/** chz command-line entrypoint. */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { ChzSyntaxError, extractImagineSpecs, type ImagineSpec } from "./preprocessor.ts";
import {
  buildEstimatedRealizeOrder,
  realize,
  realizationBaseDir,
  type ChzAskUserAnswer,
  type ChzAskUserQuestion,
  type ChzProjectConfig,
  type ChzRealizer,
  type IndependentVerificationInput,
  type RealizeResult,
} from "./realize.ts";
import { findChzConfig, loadChzConfig, selectRealizer } from "./realizer/config.ts";
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
  model?: string;
  baseURL?: string;
  configPath?: string;
}

function parseRealizeArguments(args: string[], io: CliIO): RealizeArguments | null {
  const parsed: RealizeArguments = { json: false, dryRun: false, skipTests: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--json") parsed.json = true;
    else if (argument === "--dry-run") parsed.dryRun = true;
    else if (argument === "--skip-tests") parsed.skipTests = true;
    else if (argument === "--model" || argument === "--base-url" || argument === "--config") {
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

const realizeCommand: CommandHandler = async (args, io, deps) => {
  const parsed = parseRealizeArguments(args, io);
  if (parsed === null) return 1;
  if (parsed.file === undefined) {
    io.err(`${BIN_NAME} realize: missing <file> argument`);
    io.err(
      `usage: ${BIN_NAME} realize <file> [--json] [--dry-run] [--skip-tests] [--model <name>] [--base-url <url>] [--config <path>]`,
    );
    return 1;
  }

  const sourceFile = resolve(parsed.file);
  let source: string;
  try {
    source = readFileSync(sourceFile, "utf8");
  } catch (error) {
    io.err(`${BIN_NAME} realize: cannot read file '${parsed.file}': ${(error as Error).message}`);
    return 1;
  }

  let specs: ImagineSpec[];
  try {
    specs = extractImagineSpecs(source, sourceFile);
  } catch (error) {
    if (error instanceof ChzSyntaxError) {
      io.err(`${BIN_NAME} realize: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (parsed.json) {
    io.out(JSON.stringify(specs, null, 2));
    return 0;
  }
  if (specs.length === 0) {
    io.out(`${parsed.file}: no imagine functions to realize`);
    return 0;
  }

  let configured: { config: ChzProjectConfig; projectRoot: string; path?: string };
  try {
    configured = await resolveConfiguration(sourceFile, parsed, deps);
  } catch (error) {
    io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
    return 1;
  }

  const symbols = buildEstimatedRealizeOrder(specs, source, sourceFile);
  if (parsed.dryRun) {
    for (const symbol of symbols) {
      const realizer = selectRealizer(configured.config.realizers, symbol);
      if (realizer === null) {
        io.err(`${BIN_NAME} realize: no Realizer supports '${symbol.name}' (${symbol.type})`);
        return 1;
      }
      const model = "modelLabel" in realizer && typeof realizer.modelLabel === "string"
        ? realizer.modelLabel
        : realizer.name;
      const context = {
        projectRoot: configured.projectRoot,
        outputDir: realizationBaseDir(sourceFile),
        activeProfile: configured.config.profile ?? "console",
        resolvedDependencies: [],
        maxTurns: configured.config.maxTurns ?? 24,
        maxRetries: configured.config.maxRetries ?? 2,
        baseContexts: "",
        now: deps.now,
      };
      const [fixed, baseline] = buildSystemParts(symbol, context, model);
      io.out(`===== Realizer system prompt: ${symbol.name} (${realizer.name}) =====`);
      io.out(fixed);
      io.out("");
      io.out(baseline);
    }
    return 0;
  }

  if (configured.path !== undefined) io.out(`config: ${configured.path}`);
  let lastTestOutcome: RealizationTestOutcome | undefined;
  const runTests = deps.runTests ?? runSelectedTests;
  const verify = async (input: IndependentVerificationInput) => {
    const verificationContext = {
      projectRoot: configured.projectRoot,
      outputDir: input.baseDir,
      activeProfile: configured.config.profile ?? "console",
      resolvedDependencies: [],
      maxTurns: configured.config.maxTurns ?? 24,
      maxRetries: configured.config.maxRetries ?? 2,
      baseContexts: "",
      harness: {
        runTests: async (testFiles: string[]) => {
          lastTestOutcome = await runTests(input.baseDir, testFiles);
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

  let result: RealizeResult;
  try {
    result = await realize(source, sourceFile, {
      realizers: configured.config.realizers,
      projectRoot: configured.projectRoot,
      activeProfile: configured.config.profile,
      maxTurns: configured.config.maxTurns,
      maxRetries: configured.config.maxRetries,
      askUser: deps.askUser ?? (process.stdin.isTTY && process.stdout.isTTY ? interactiveAskUser(io) : undefined),
      now: deps.now,
      skipVerification: parsed.skipTests,
      verify,
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
        onEvent: (message) => io.out(message),
        onModelReasoning: (message) => io.err(message),
      },
    });
  } catch (error) {
    io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
    return 1;
  }

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
  io.out(`${parsed.file}: realized ${count} symbol${count === 1 ? "" : "s"}`);
  io.out(`  output: ${result.baseDir}`);
  for (const file of result.files) io.out(`  + ${file.relPath}`);

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
};

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
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answers: ChzAskUserAnswer[] = [];
      for (const question of questions) {
        io.out(`Question from Realizer — ${question.header}:`);
        io.out(question.question);
        question.options.forEach((option, index) => {
          io.out(`  ${index + 1}. ${option.label} — ${option.description}`);
        });
        io.out("  Enter option number(s), or type a free-form answer.");
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
    "  realize <file>   realize imagine symbols through configured Realizers",
    "                   [--json]          print extracted specs",
    "                   [--dry-run]       print canonical Realizer prompts",
    "                   [--skip-tests]    skip independent verification",
    "                   [--model <name>]  default OpenAI model",
    "                   [--base-url <u>]  OpenAI-compatible API base URL",
    "                   [--config <path>] explicit chz.config.js",
    "",
    "configuration:",
    "  chz.config.js exports { realizers: [...] }; the first Realizer supporting",
    "  a symbol type is selected. Without it, OPENAI_MODEL/OPENAI_API_KEY/",
    "  OPENAI_BASE_URL configure the default ChzOpenAIRealizer.",
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
