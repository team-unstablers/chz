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

/** Sink for user-facing output, injected so the dispatcher stays testable. */
export interface CliIO {
  out: (message: string) => void;
  err: (message: string) => void;
}

/** A subcommand implementation. Returns the process exit code. */
export type CommandHandler = (args: string[], io: CliIO) => number;

export const BIN_NAME = "chz";

/**
 * `chz realize <file>` — extract the `imagine` specs from a `.chz.ts` file.
 *
 * In this milestone (Step 2) the command runs the preprocessor and prints a
 * summary of the extracted specs (or their raw JSON with `--json`), then bows
 * out — the actual realize engine (the LLM call) lands in Step 3, so the
 * command still reports "not implemented yet" and exits 1.
 */
const realizeCommand: CommandHandler = (args, io) => {
  let json = false;
  let file: string | undefined;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
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
    io.err(`usage: ${BIN_NAME} realize <file> [--json]`);
    return 1;
  }

  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    io.err(`${BIN_NAME} realize: cannot read file '${file}': ${(error as Error).message}`);
    return 1;
  }

  let specs: ImagineSpec[];
  try {
    specs = extractImagineSpecs(source, file);
  } catch (error) {
    if (error instanceof ChzSyntaxError) {
      io.err(`${BIN_NAME} realize: ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (json) {
    io.out(JSON.stringify(specs, null, 2));
  } else {
    for (const line of formatSpecSummary(file, specs)) io.out(line);
  }

  io.err(`${BIN_NAME} realize: realize engine not implemented yet (Step 3)`);
  return 1;
};

/** Render a human-readable summary of the extracted specs, one string per line. */
function formatSpecSummary(fileName: string, specs: ImagineSpec[]): string[] {
  const lines: string[] = [
    `${fileName}: found ${specs.length} imagine function${specs.length === 1 ? "" : "s"}`,
  ];
  for (const spec of specs) {
    const predicates = spec.ensures.filter((e) => e.kind === "predicate").length;
    const naturals = spec.ensures.filter((e) => e.kind === "natural").length;
    // Collapse whitespace so a multi-line parameter list stays on one summary line.
    const params = spec.parameters.replace(/\s+/g, " ").trim();
    const signature = `${spec.name}(${params})${spec.returnType ? `: ${spec.returnType}` : ""}`;
    lines.push(`  - ${signature}`);
    lines.push(
      `      requirements: ${spec.requirements !== null ? "yes" : "no"} | ` +
        `ensure: ${spec.ensures.length} (${predicates} predicate, ${naturals} natural)`,
    );
  }
  return lines;
}

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
    `                   (--json prints the extracted specs as JSON)`,
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
 * {@link COMMANDS}. Returns the exit code; all output goes through `io`.
 */
export function run(argv: string[], io: CliIO): number {
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

  return handler(rest, io);
}

/** Default IO sink: line-buffered writes to the real stdout/stderr. */
const consoleIO: CliIO = {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
};

function main(): void {
  const exitCode = run(process.argv.slice(2), consoleIO);
  process.exitCode = exitCode;
}

// Only run when invoked directly (e.g. `tsx src/cli.ts`), not when imported by
// tests. Under NodeNext, `process.argv[1]` is the executed entry script.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
