/**
 * chz — command-line entrypoint.
 *
 * v0 scaffolding: this file establishes the subcommand dispatch structure that
 * later milestones (preprocessor, realize engine) will hang their commands off.
 * It intentionally parses `process.argv` by hand — v0 is a zero-dependency CLI.
 */

import { pathToFileURL } from "node:url";

/** Sink for user-facing output, injected so the dispatcher stays testable. */
export interface CliIO {
  out: (message: string) => void;
  err: (message: string) => void;
}

/** A subcommand implementation. Returns the process exit code. */
export type CommandHandler = (args: string[], io: CliIO) => number;

export const BIN_NAME = "chz";

/**
 * `chz realize <file>` — realize the `imagine` symbols in a `.chz.ts` file.
 * Not implemented in this milestone; the command exists only so the dispatch
 * wiring and usage text are in place for the realize engine to fill in later.
 */
const realizeCommand: CommandHandler = (args, io) => {
  const file = args[0];
  if (file === undefined) {
    io.err(`${BIN_NAME} realize: missing <file> argument`);
    io.err(`usage: ${BIN_NAME} realize <file>`);
    return 1;
  }
  io.err(`${BIN_NAME} realize: not implemented yet (requested: ${file})`);
  return 1;
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
