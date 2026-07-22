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
  /** Clock for the provenance timestamp; defaults to `new Date()`. */
  now?: () => Date;
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
 * Extracts the specs, sends each to the LLM backend, and emits the auditable
 * implementation + tests under `chz/realization/<base>/`. This milestone
 * (Step 3) stops after emit: it does NOT run the tests or record a cache — that
 * is Step 4, so a reminder is printed to stderr on success.
 *
 * Flags:
 *   --json          print the extracted specs as JSON and exit (no LLM call).
 *   --dry-run       print the assembled prompt(s) and exit (no LLM call).
 *   --model <name>  model name to pass to the claude CLI (default: CLI default).
 */
const realizeCommand: CommandHandler = (args, io, deps) => {
  let json = false;
  let dryRun = false;
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
    io.err(`usage: ${BIN_NAME} realize <file> [--json] [--dry-run] [--model <name>]`);
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

  return realize(source, sourceFile, { backend, now: deps.now })
    .then((result) => {
      writeRealization(result);
      const count = result.symbols.length;
      io.out(
        `${sourceFile}: realized ${count} imagine function${count === 1 ? "" : "s"} ` +
          `(model: ${backend.modelLabel})`,
      );
      io.out(`  output: ${result.baseDir}`);
      for (const file of result.files) io.out(`  + ${file.relPath}`);
      io.err(`${BIN_NAME} realize: tests not yet run (Step 4) — run them before trusting the realization.`);
      return 0;
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
    `                   [--json]      print the extracted specs as JSON`,
    `                   [--dry-run]   print the assembled prompt(s), no LLM call`,
    `                   [--model <n>] model to pass to the claude CLI`,
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
