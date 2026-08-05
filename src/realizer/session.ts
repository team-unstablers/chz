/** Per-session harness machinery shared by every Realizer transport.
 *
 * `ChzRealizerBase` owns the agentic loop; this module owns everything one
 * realize session needs *underneath* that loop — the three tool runtimes, the
 * dispatch chain, output bounding, observability events, and the post-Finish
 * artifact collection. `ClaudeCodeRealizer` delegates the loop itself to Claude
 * Code (docs/61) and reuses this module verbatim, which is what keeps the
 * docs/63 guarantees identical across transports.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ChzControlToolRuntime, type ChzTerminalState } from "./tools/control.ts";
import { ChzFilesystemToolRuntime } from "./tools/filesystem.ts";
import { ChzVerificationToolRuntime } from "./tools/verification.ts";
import type {
  ChzDiagnostic,
  ChzHarnessEvent,
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzRealizeContext,
} from "./types.ts";

/** One completed tool dispatch, rendered exactly as the model will see it. */
export interface ChzToolExecution {
  /** Tool output after output bounding (docs/63). */
  output: string;
  /** The one-line outcome carried on the emitted `tool` event. */
  outcome: string;
  errored: boolean;
  durationMs: number;
  terminal?: ChzTerminalState;
}

/**
 * The harness runtimes one realize session owns, plus the dispatch chain over
 * them. Deliberately loop-free: turn counting, message history, and provider
 * calls belong to the caller.
 */
export class ChzHarnessSession {
  /** Session-local context clone carrying the synthesized `diagnoseFile`. */
  readonly context: ChzRealizeContext;

  readonly #realizerName: string;
  readonly #files: ChzFilesystemToolRuntime;
  readonly #verification: ChzVerificationToolRuntime;
  readonly #control: ChzControlToolRuntime;
  #terminal: ChzTerminalState | undefined;

  constructor(realizerName: string, symbol: ChzImagineSymbol, context: ChzRealizeContext) {
    this.#realizerName = realizerName;
    const sessionContext: ChzRealizeContext = { ...context, harness: { ...context.harness } };

    // Order matters: the verification runtime must exist before the default
    // `diagnoseFile` closes over it, and `??=` must not clobber engine-injected
    // services.
    this.#verification = new ChzVerificationToolRuntime(
      sessionContext,
      (path) => resolveHarnessOutputPath(sessionContext, path),
    );
    sessionContext.harness ??= {};
    sessionContext.harness.diagnoseFile ??= async (file) => {
      const rendered = await this.#verification.execute("RunTypeCheck", {});
      if (rendered === null) return [];
      try {
        const parsed = JSON.parse(rendered) as { diagnostics?: ChzDiagnostic[] };
        return (parsed.diagnostics ?? []).filter(
          (diagnostic) => resolve(diagnostic.file) === resolve(file),
        );
      } catch {
        return [];
      }
    };
    this.#files = new ChzFilesystemToolRuntime(sessionContext);
    this.#control = new ChzControlToolRuntime(symbol, sessionContext);
    this.context = sessionContext;
  }

  /** Set once a control tool has declared the session over. */
  get terminal(): ChzTerminalState | undefined {
    return this.#terminal;
  }

  /** Run one advertised tool, bound its output, and emit the `tool` event. */
  async run(name: string, input: unknown): Promise<ChzToolExecution> {
    const startedAt = Date.now();
    let errored = false;
    let output: string;
    let terminal: ChzTerminalState | undefined;

    try {
      const fileResult = await this.#files.execute(name, input);
      if (fileResult !== null) {
        output = fileResult;
      } else {
        const verificationResult = await this.#verification.execute(name, input);
        if (verificationResult !== null) {
          output = verificationResult;
        } else {
          const controlResult = await this.#control.execute(name, input);
          if (controlResult !== null) {
            output = controlResult.output;
            terminal = controlResult.terminal;
          } else {
            output = `Unknown tool: ${name}. Use one of the advertised harness tools.`;
            errored = true;
          }
        }
      }
    } catch (error) {
      output = (error as Error).message;
      errored = true;
    }

    if (terminal !== undefined) this.#terminal = terminal;
    return this.#finish(name, input, this.#files.boundOutput(output), terminal, errored, startedAt);
  }

  /**
   * Report a call that never reached a runtime — a malformed argument payload or
   * a tool gated off at the turn limit — with the same event shape as `run`.
   */
  reject(name: string, input: unknown, message: string): ChzToolExecution {
    return this.#finish(name, input, this.#files.boundOutput(message), undefined, true, Date.now());
  }

  emit(event: ChzHarnessEvent): void {
    emitHarnessEvent(this.context, event);
  }

  boundOutput(output: string): string {
    return this.#files.boundOutput(output);
  }

  #finish(
    name: string,
    input: unknown,
    output: string,
    terminal: ChzTerminalState | undefined,
    errored: boolean,
    startedAt: number,
  ): ChzToolExecution {
    const details = summarizeToolInput(name, input, this.context.projectRoot);
    const outcome = summarizeToolOutcome(name, output, terminal, errored);
    const durationMs = Math.max(0, Date.now() - startedAt);
    this.emit({
      kind: "tool",
      realizer: this.#realizerName,
      tool: name,
      ...(details === "" ? {} : { toolDetail: details }),
      outcome,
      durationMs,
      errored,
      text: `[${this.#realizerName}] ${name}${details === "" ? "" : `(${details})`} → ${outcome} · ${durationMs}ms`,
    });
    return { output, outcome, errored, durationMs, ...(terminal === undefined ? {} : { terminal }) };
  }
}

export function emitHarnessEvent(context: ChzRealizeContext, event: ChzHarnessEvent): void {
  try {
    context.harness?.onEvent?.(event);
  } catch {
    // Observability must never alter the realization result.
  }
}

function summarizeToolInput(name: string, input: unknown, projectRoot: string): string {
  const values = asRecord(input);
  if (values === undefined) return "";

  const details: string[] = [];
  const addPath = (): void => {
    if (typeof values.path === "string") {
      details.push(`path=${formatLogValue(compactProjectPath(values.path, projectRoot))}`);
    }
  };
  const addPaging = (): void => {
    if (typeof values.offset === "number") details.push(`offset=${values.offset}`);
    if (typeof values.limit === "number") details.push(`limit=${values.limit}`);
  };

  switch (name) {
    case "ReadFile":
    case "ReadDir":
      addPath();
      addPaging();
      break;
    case "Glob":
      if (typeof values.pattern === "string") details.push(`pattern=${formatLogValue(values.pattern)}`);
      addPath();
      if (typeof values.limit === "number") details.push(`limit=${values.limit}`);
      break;
    case "Grep":
      if (typeof values.pattern === "string") details.push(`pattern=${formatLogValue(values.pattern)}`);
      addPath();
      if (typeof values.include === "string") details.push(`include=${formatLogValue(values.include)}`);
      if (typeof values.limit === "number") details.push(`limit=${values.limit}`);
      break;
    case "WriteFile":
      addPath();
      if (typeof values.content === "string") {
        details.push(`size=${formatByteCount(Buffer.byteLength(values.content, "utf8"))}`);
        details.push(`lines=${countLines(values.content)}`);
      }
      break;
    case "FindAndReplace":
      addPath();
      if (typeof values.oldString === "string") {
        details.push(`oldSize=${formatByteCount(Buffer.byteLength(values.oldString, "utf8"))}`);
      }
      if (typeof values.newString === "string") {
        details.push(`newSize=${formatByteCount(Buffer.byteLength(values.newString, "utf8"))}`);
      }
      if (typeof values.replaceAll === "boolean") details.push(`replaceAll=${values.replaceAll}`);
      break;
    case "RunTests": {
      const testFiles = Array.isArray(values.testFiles) ? values.testFiles : [];
      details.push(testFiles.length === 0 ? "files=all" : `files=${testFiles.length}`);
      break;
    }
    case "AskUser":
      if (Array.isArray(values.questions)) details.push(`questions=${values.questions.length}`);
      break;
  }

  return details.join(", ");
}

function summarizeToolOutcome(
  name: string,
  output: string,
  terminal: ChzTerminalState | undefined,
  dispatchErrored: boolean,
): string {
  if (name === "Finish" && terminal?.kind === "finish") return "finished";
  if (name === "Block" && terminal?.kind === "blocked") return "blocked";
  if (name === "Abort" && terminal?.kind === "aborted") return "aborted";

  const result = parseResultObject(output);
  if (typeof result?.passed === "boolean") {
    const details: string[] = [];
    if (Array.isArray(result.diagnostics)) details.push(`${result.diagnostics.length} diagnostics`);
    if (typeof result.testCount === "number") details.push(`${result.testCount} tests`);
    if (result.timedOut === true) details.push("timed out");
    return `${result.passed ? "passed" : "failed"}${details.length === 0 ? "" : ` (${details.join(", ")})`}`;
  }

  if (dispatchErrored || looksLikeToolError(output)) return "error";
  if (/^No (?:files|matches) found\b/.test(output)) return "ok (no matches)";
  if (name === "AskUser") return terminal?.kind === "blocked" ? "blocked" : "answered";
  const successDetails = summarizeSuccessDetails(name, output);
  return successDetails === undefined ? "ok" : `ok (${successDetails})`;
}

function summarizeSuccessDetails(name: string, output: string): string | undefined {
  if (name === "ReadFile") {
    const page = output.match(/\(Showing lines (\d+)-(\d+) of (\d+)\./);
    if (page !== null) return `${Number(page[2]) - Number(page[1]) + 1}/${page[3]} lines`;
    const capped = output.match(/\(Output capped at 50 KB\. Showing lines (\d+)-(\d+)\./);
    if (capped !== null) return `${Number(capped[2]) - Number(capped[1]) + 1} lines, capped`;
    const end = output.match(/\(End of file - total (\d+) lines\)$/);
    if (end !== null) return `${Math.max(0, output.split("\n").length - 1)} lines`;
  }
  if (name === "ReadDir") {
    const page = output.match(/\(Showing entries (\d+)-(\d+) of (\d+)\./);
    if (page !== null) return `${Number(page[2]) - Number(page[1]) + 1}/${page[3]} entries`;
    const total = output.match(/\((\d+) entries\)$/);
    if (total !== null) return `${total[1]} entries`;
  }
  if (name === "Glob") {
    const lines = output.split("\n");
    const truncated = lines.at(-1)?.startsWith("(Results truncated:") ?? false;
    return `${lines.length - (truncated ? 1 : 0)} files${truncated ? ", truncated" : ""}`;
  }
  if (name === "Grep") {
    const matches = output.match(/^Found (\d+) matches\b/);
    if (matches !== null) return `${matches[1]} matches`;
  }
  if (name === "WriteFile") {
    const diagnostics = output.match(/^ERROR \[/gm)?.length ?? 0;
    if (diagnostics > 0) return `${diagnostics} diagnostics`;
  }
  if (name === "FindAndReplace") {
    const replacements = output.match(/^Replacements: (\d+)$/m);
    if (replacements !== null) return `${replacements[1]} replacements`;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseResultObject(output: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(output) as unknown);
  } catch {
    return undefined;
  }
}

function looksLikeToolError(output: string): boolean {
  const firstLine = output.trimStart().split(/\r?\n/, 1)[0] ?? "";
  return [
    "Invalid tool input:",
    "Read access denied:",
    "Write access denied:",
    "Test file access denied:",
    "File not found:",
    "File is not valid UTF-8:",
    "Path is ",
    "Cannot read binary file:",
    "Cannot store bounded tool output",
    "Offset ",
    "Glob path must be a directory:",
    "Tools are disabled",
    "Unknown tool:",
    "Refusing to write",
    "You must read",
    "File changed since",
    "oldString must not be empty",
    "No changes to apply:",
    "Could not find",
    "Found multiple exact matches",
    "Invalid regex pattern:",
  ].some((prefix) => firstLine.startsWith(prefix));
}

function compactProjectPath(path: string, projectRoot: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(resolve(projectRoot), resolve(path));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}

function formatLogValue(value: string, maxLength = 120): string {
  const singleLine = value.replace(/[\r\n]+/g, " ");
  const shortened = singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength - 1)}…`;
  return JSON.stringify(shortened);
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kilobytes = bytes / 1024;
    return `${kilobytes >= 10 ? kilobytes.toFixed(0) : kilobytes.toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLines(content: string): number {
  if (content === "") return 0;
  const lines = content.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(content) ? lines - 1 : lines;
}

function canonicalizePossiblyMissing(path: string): string {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync.native(ancestor);
  const suffix = relative(ancestor, path);
  return suffix === "" ? canonicalAncestor : resolve(canonicalAncestor, suffix);
}

function pathContains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveHarnessOutputPath(context: ChzRealizeContext, path: string): string {
  const lexical = resolve(context.projectRoot, path);
  const canonical = canonicalizePossiblyMissing(lexical);
  const output = canonicalizePossiblyMissing(resolve(context.outputDir));
  if (!pathContains(output, canonical)) {
    throw new Error(
      `Test file access denied: ${path} is outside the realization output directory (${context.outputDir}). Choose test files inside the output directory.`,
    );
  }
  return canonical;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function collectResolution(
  symbol: ChzImagineSymbol,
  context: ChzRealizeContext,
  model: string,
): ChzImagineSymbolResolution {
  const allFiles = walkFiles(context.outputDir);
  const exactImplementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
  const implementationCandidates = allFiles.filter((file) => {
    if (!file.endsWith(".ts") || file.includes(`${join(context.outputDir, "tests")}`)) return false;
    return basename(file, ".ts") === symbol.name;
  });
  const resolvedFile = existsSync(exactImplementation)
    ? exactImplementation
    : implementationCandidates.length === 1
      ? implementationCandidates[0]
      : undefined;
  if (resolvedFile === undefined) {
    throw new Error(
      `Finish called, but no unambiguous implementation file for '${symbol.name}' was found. Write implementations/${symbol.name}.ts and finish again.`,
    );
  }

  const expectedTestFile = join(
    context.outputDir,
    "tests",
    `test_${symbol.name}.autogen.ts`,
  );
  if (!existsSync(expectedTestFile)) {
    throw new Error(
      `Finish called, but the required autogen test file for '${symbol.name}' was not found. Write tests/test_${symbol.name}.autogen.ts and finish again.`,
    );
  }
  const resolvedTestFiles = [expectedTestFile];

  // A dependency cycle is realized as one session (docs/62): every member
  // must have its implementation and autogen tests before Finish is accepted.
  for (const member of symbol.circularDependencies) {
    if (!existsSync(join(context.outputDir, "implementations", `${member.name}.ts`))) {
      throw new Error(
        `Finish called, but cycle member '${member.name}' has no implementation. Write implementations/${member.name}.ts and finish again.`,
      );
    }
    if (!existsSync(join(context.outputDir, "tests", `test_${member.name}.autogen.ts`))) {
      throw new Error(
        `Finish called, but cycle member '${member.name}' has no autogen tests. Write tests/test_${member.name}.autogen.ts and finish again.`,
      );
    }
  }

  const lineCount = readFileSync(resolvedFile, "utf8").split(/\r?\n/).length;
  const assumptionsReport = allFiles.find((file) => /^ASSUMPTIONS(?:\..+)?$/i.test(basename(file)));
  return {
    outcome: "resolved",
    symbol,
    resolvedFile,
    resolvedTestFiles,
    ...(assumptionsReport === undefined ? {} : { assumptionsReport }),
    resolvedLine: [1, lineCount],
    resolvedAt: context.now ? context.now() : new Date(),
    resolvedBy: model,
  };
}
