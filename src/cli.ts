/**
 * chz — command-line entrypoint.
 *
 * v0 scaffolding: this file establishes the subcommand dispatch structure that
 * later milestones (preprocessor, realize engine) will hang their commands off.
 * It intentionally parses `process.argv` by hand — v0 is a zero-dependency CLI.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ChzSyntaxError, extractImagineSpecs, type ImagineSpec } from "./preprocessor.ts";
import {
  buildRealizePrompt,
  ClaudeCliBackend,
  realize,
  writeRealization,
  type RealizeBackend,
} from "./realize.ts";
import {
  readChzVersion,
  runRealizationTests,
  writeRealizationCache,
  type RealizationTestOutcome,
} from "./verify.ts";

/** Sink for user-facing output, injected so the dispatcher stays testable. */
export interface CliIO {
  out: (message: string) => void;
  err: (message: string) => void;
}

/**
 * Injected dependencies for command handlers. Kept out of {@link CliIO} because
 * only realize needs them: they let tests exercise the full realize wiring with
 * a fake backend and a fixed clock, never touching the real claude CLI.
 */
export interface CliDeps {
  /** Factory for the realize backend. Defaults to a {@link ClaudeCliBackend}. */
  makeBackend?: (opts: { model?: string }) => RealizeBackend;
  /** Clock for the provenance/cache timestamp; defaults to `new Date()`. */
  now?: () => Date;
  /**
   * Realization test runner. Defaults to the real vitest spawner
   * ({@link runRealizationTests}); injected so tests never spawn vitest.
   */
  runTests?: (baseDir: string) => Promise<RealizationTestOutcome>;
  /** chz tool version stamped into the cache; defaults to reading package.json. */
  chzVersion?: string;
}

/** A subcommand implementation. Returns the process exit code (sync or async). */
export type CommandHandler = (
  args: string[],
  io: CliIO,
  deps: CliDeps,
) => number | Promise<number>;

export const BIN_NAME = "chz";

/**
 * `chz realize <file>` — realize the `imagine` functions in a `.chz.ts` file.
 *
 * Extracts the specs, sends each to the LLM backend, emits the auditable
 * implementation + tests under `chz/realization/<base>/`, then runs those tests
 * (Step 4). On green it records `realization-cache.json` and exits 0; on red it
 * keeps the emitted files, shows the vitest output on stderr, records the cache
 * with `testsPassed: false`, and exits 1 so a human can review the artifacts.
 *
 * Flags:
 *   --json          print the extracted specs as JSON and exit (no LLM call).
 *   --dry-run       print the assembled prompt(s) and exit (no LLM call).
 *   --model <name>  model name to pass to the claude CLI (default: CLI default).
 *   --skip-tests    emit and cache but do not run the tests (cache marks them
 *                   unverified); the explicit escape hatch from idea-sketch §4.3.
 */
const realizeCommand: CommandHandler = (args, io, deps) => {
  let json = false;
  let dryRun = false;
  let skipTests = false;
  let model: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-tests") {
      skipTests = true;
      continue;
    }
    if (arg === "--model") {
      const next = args[i + 1];
      if (next === undefined) {
        io.err(`${BIN_NAME} realize: --model requires a value`);
        return 1;
      }
      model = next;
      i++;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    if (arg.startsWith("--")) {
      io.err(`${BIN_NAME} realize: unknown option '${arg}'`);
      return 1;
    }
    if (file === undefined) file = arg;
  }

  if (file === undefined) {
    io.err(`${BIN_NAME} realize: missing <file> argument`);
    io.err(`usage: ${BIN_NAME} realize <file> [--json] [--dry-run] [--skip-tests] [--model <name>]`);
    return 1;
  }
  const sourceFile = file;

  let source: string;
  try {
    source = readFileSync(sourceFile, "utf8");
  } catch (error) {
    io.err(`${BIN_NAME} realize: cannot read file '${sourceFile}': ${(error as Error).message}`);
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

  // --json: inspection only. Preserve the Step 2 behaviour of dumping the specs,
  // but this is now a successful pass (exit 0) since realize is implemented.
  if (json) {
    io.out(JSON.stringify(specs, null, 2));
    return 0;
  }

  // --dry-run: show what would be sent to the LLM, without calling it.
  if (dryRun) {
    if (specs.length === 0) {
      io.err(`${BIN_NAME} realize: no imagine functions found in '${sourceFile}'`);
      return 0;
    }
    for (const spec of specs) {
      io.out(`===== realize prompt: ${spec.name} =====`);
      io.out(buildRealizePrompt(spec, source, sourceFile));
    }
    return 0;
  }

  if (specs.length === 0) {
    io.out(`${sourceFile}: no imagine functions to realize`);
    return 0;
  }

  const makeBackend = deps.makeBackend ?? ((opts) => new ClaudeCliBackend(opts));
  const backend = makeBackend({ model });
  const runTests = deps.runTests ?? ((baseDir) => runRealizationTests(baseDir));
  const chzVersion = deps.chzVersion ?? readChzVersion();

  return realize(source, sourceFile, { backend, now: deps.now })
    .then(async (result) => {
      writeRealization(result);
      const count = result.symbols.length;
      const realizedAt = (deps.now ? deps.now() : new Date()).toISOString();
      io.out(
        `${sourceFile}: realized ${count} imagine function${count === 1 ? "" : "s"} ` +
          `(model: ${backend.modelLabel})`,
      );
      io.out(`  output: ${result.baseDir}`);
      for (const file of result.files) io.out(`  + ${file.relPath}`);

      // The cache write is shared across all three outcomes; only the flags
      // (testsPassed / testsSkipped) differ.
      const recordCache = (testsPassed: boolean, testsSkipped: boolean): void => {
        const cachePath = writeRealizationCache({
          result,
          source,
          chzVersion,
          modelLabel: backend.modelLabel,
          realizedAt,
          testsPassed,
          testsSkipped,
        });
        io.out(`  cache: ${cachePath}`);
      };

      // --skip-tests: emit + cache, but record the realization as unverified.
      if (skipTests) {
        io.err(
          `${BIN_NAME} realize: --skip-tests set — emitted files were NOT verified; ` +
            `cache records testsPassed: false (skipped).`,
        );
        recordCache(false, true);
        return 0;
      }

      const outcome = await runTests(result.baseDir);
      if (outcome.passed) {
        recordCache(true, false);
        const testsLabel = outcome.testCount === null ? "tests" : `${outcome.testCount} test`;
        const plural = outcome.testCount === 1 ? "" : "s";
        io.out(
          `${sourceFile}: realized ${count} symbol${count === 1 ? "" : "s"}, ` +
            `${testsLabel}${outcome.testCount === null ? "" : plural} passed`,
        );
        return 0;
      }

      // Red: keep the emitted files, surface the full vitest output for review,
      // and record the realization as failed so the cache reflects reality.
      io.err(outcome.output);
      io.err(
        outcome.timedOut
          ? `${BIN_NAME} realize: tests TIMED OUT — see output above; emitted files kept for review.`
          : `${BIN_NAME} realize: tests FAILED — see output above; emitted files kept for review.`,
      );
      recordCache(false, false);
      return 1;
    })
    .catch((error) => {
      io.err(`${BIN_NAME} realize: ${(error as Error).message}`);
      return 1;
    });
};

/**
 * Registry of subcommands. New subcommands (build, check, …) are added here;
 * `run` dispatches purely off this map so no command needs bespoke wiring.
 */
export const COMMANDS: Record<string, CommandHandler> = {
  realize: realizeCommand,
};

/** Build the `--help` / usage text. Pure, so it is trivially testable. */
export function buildUsage(): string {
  const commandNames = Object.keys(COMMANDS).sort();
  const lines = [
    "chz — a TypeScript superset where the LLM writes the implementation",
    "      and the human supervises.",
    "",
    `usage: ${BIN_NAME} <command> [options]`,
    "",
    "commands:",
    `  realize <file>   realize the imagine symbols in a .chz.ts file`,
    `                   [--json]        print the extracted specs as JSON`,
    `                   [--dry-run]     print the assembled prompt(s), no LLM call`,
    `                   [--skip-tests]  emit + cache but do not run the tests`,
    `                   [--model <n>]   model to pass to the claude CLI`,
    "",
    "options:",
    "  -h, --help       show this help and exit",
    "",
    `available commands: ${commandNames.join(", ")}`,
  ];
  return lines.join("\n");
}

/** True when `arg` requests help output. */
function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

/**
 * Dispatch `argv` (already stripped of `node` and the script path) against
 * {@link COMMANDS}. Returns the exit code; all output goes through `io`. Sync
 * commands return a number; `realize` returns a promise, so callers that may hit
 * it should `await` the result.
 */
export function run(argv: string[], io: CliIO, deps: CliDeps = {}): number | Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || isHelpFlag(command)) {
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

/** Default IO sink: line-buffered writes to the real stdout/stderr. */
const consoleIO: CliIO = {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
};

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2), consoleIO);
}

// Only run when invoked directly (e.g. `tsx src/cli.ts`), not when imported by
// tests. Under NodeNext, `process.argv[1]` is the executed entry script.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
