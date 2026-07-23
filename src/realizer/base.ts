import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ChzControlToolRuntime, type ChzTerminalState } from "./tools/control.ts";
import { ChzFilesystemToolRuntime } from "./tools/filesystem.ts";
import { ChzVerificationToolRuntime } from "./tools/verification.ts";
import { buildSystemParts, TURN_LIMIT_PROMPT } from "./prompt.ts";
import type {
  ChzChatMessage,
  ChzChatResponse,
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzImagineSymbolType,
  ChzRealizeContext,
  ChzRealizer,
  ChzToolCall,
  ChzToolDefinition,
} from "./types.ts";

const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const pathProperty = {
  type: "string",
  description: "An absolute path or a path relative to the project root.",
};
const pageProperties = {
  offset: { type: "integer", minimum: 1, description: "One-based starting line or entry." },
  limit: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum results." },
};

/** The complete, fixed harness tool surface from docs/63. */
export const CHZ_HARNESS_TOOLS: readonly ChzToolDefinition[] = [
  {
    name: "ReadFile",
    description:
      "Read a UTF-8 text file inside the project root with line-number prefixes. Sensitive paths such as chz.config.js and .env files (except .env.example) are inaccessible. Continue with a larger offset; prefer a large window over tiny repeated slices. Use Grep for specific content and Glob for uncertain paths. Do not copy line-number prefixes into edits.",
    inputSchema: objectSchema({ path: pathProperty, ...pageProperties }, ["path"]),
  },
  {
    name: "ReadDir",
    description:
      "List a directory inside the project root, excluding sensitive paths, directories first and then lexically, with deterministic paging.",
    inputSchema: objectSchema({ path: pathProperty, ...pageProperties }, ["path"]),
  },
  {
    name: "Glob",
    description:
      "Find files by a gitignore-style glob inside the project root. Sensitive paths are excluded. Results are project-relative and unordered; do not rely on result order.",
    inputSchema: objectSchema(
      {
        pattern: { type: "string" },
        path: pathProperty,
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
      ["pattern"],
    ),
  },
  {
    name: "Grep",
    description:
      "Search non-sensitive UTF-8 project files with a ripgrep/Rust regular expression. Use include to restrict file names.",
    inputSchema: objectSchema(
      {
        pattern: { type: "string" },
        path: pathProperty,
        include: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
      ["pattern"],
    ),
  },
  {
    name: "WriteFile",
    description:
      "Create or replace the complete contents of one non-sensitive file for the current increment inside the realization output directory. The file may be revised in later turns. Existing files must first be read with ReadFile. Parent directories are created automatically and inline diagnostics are returned.",
    inputSchema: objectSchema({ path: pathProperty, content: { type: "string" } }, ["path", "content"]),
  },
  {
    name: "FindAndReplace",
    description:
      "Replace an exact string in a non-sensitive file inside the realization output directory. Read the file first. Whitespace and indentation must match exactly; set replaceAll only when every exact occurrence should change.",
    inputSchema: objectSchema(
      {
        path: pathProperty,
        oldString: { type: "string", minLength: 1 },
        newString: { type: "string" },
        replaceAll: { type: "boolean" },
      },
      ["path", "oldString", "newString"],
    ),
  },
  {
    name: "RunTests",
    description:
      "Run the engine-fixed vitest runner. Pass output-directory test files, or an empty array to run all realization tests. This is useful feedback; Finish still triggers independent verification.",
    inputSchema: objectSchema({ testFiles: { type: "array", items: { type: "string" } } }, ["testFiles"]),
  },
  {
    name: "RunTypeCheck",
    description: "Run the engine-fixed strict TypeScript check over the realization output directory.",
    inputSchema: objectSchema(),
  },
  {
    name: "RunLinter",
    description:
      "Run the engine-fixed restricted-subset linter over realized code, including no eval, no any, and no __epilogue__ imports.",
    inputSchema: objectSchema(),
  },
  {
    name: "AskUser",
    description:
      "Ask the human one or more structural questions. Group related decisions into one call; put a recommended option first and suffix its label with (Recommended). Do not add an Other option because the UI supplies free-form input.",
    inputSchema: objectSchema(
      {
        questions: {
          type: "array",
          minItems: 1,
          items: objectSchema(
            {
              question: { type: "string", minLength: 1 },
              header: { type: "string", minLength: 1, maxLength: 30 },
              options: {
                type: "array",
                minItems: 2,
                items: objectSchema(
                  { label: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 } },
                  ["label", "description"],
                ),
              },
              multiple: { type: "boolean" },
            },
            ["question", "header", "options"],
          ),
        },
      },
      ["questions"],
    ),
  },
  {
    name: "Finish",
    description: "Claim that implementation and tests are complete, then end the session for independent verification.",
    inputSchema: objectSchema(),
  },
  {
    name: "Block",
    description:
      "End the session because a concrete human action is required. State what is missing and an executable todo that unblocks a later realize run.",
    inputSchema: objectSchema({ reason: { type: "string", minLength: 1 }, todo: { type: "string", minLength: 1 } }, ["reason", "todo"]),
  },
  {
    name: "Abort",
    description:
      "End the session because the request is contradictory, impossible, or inappropriate. Use Block instead when environment preparation would unblock it.",
    inputSchema: objectSchema({ reason: { type: "string", minLength: 1 } }, ["reason"]),
  },
] as const;

const TERMINAL_TOOL_NAMES = new Set(["Finish", "Block", "Abort"]);
const TERMINAL_TOOLS = CHZ_HARNESS_TOOLS.filter((tool) => TERMINAL_TOOL_NAMES.has(tool.name));

export interface ChzRealizerBaseOptions {
  model: string;
  supportedSymbolTypes?: readonly ChzImagineSymbolType[];
  /** Number of retries after the initial provider request. */
  maxApiRetries?: number;
  retryDelayMs?: number;
}

/**
 * Vendor-neutral Realizer harness. Subclasses implement only one provider turn;
 * this class owns the agent loop, tools, boundaries, turn cap, and retries.
 */
export abstract class ChzRealizerBase implements ChzRealizer {
  abstract readonly name: string;
  readonly modelLabel: string;
  readonly supportedSymbolTypes: readonly ChzImagineSymbolType[];
  private readonly maxApiRetries: number;
  private readonly retryDelayMs: number;

  protected constructor(options: ChzRealizerBaseOptions) {
    this.modelLabel = options.model;
    this.supportedSymbolTypes = options.supportedSymbolTypes ?? ["function", "class", "variable"];
    this.maxApiRetries = options.maxApiRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }

  /** Send exactly one provider turn. The shared loop executes returned tools. */
  protected abstract chat(
    messages: readonly ChzChatMessage[],
    tools: readonly ChzToolDefinition[],
  ): Promise<ChzChatResponse>;

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    if (!this.supportedSymbolTypes.includes(symbol.type)) {
      return { outcome: "failed", symbol, reason: `${this.name} does not support symbol type '${symbol.type}'.` };
    }
    if (!Number.isInteger(context.maxTurns) || context.maxTurns < 1) {
      return { outcome: "failed", symbol, reason: "maxTurns must be an integer greater than zero." };
    }

    mkdirSync(context.outputDir, { recursive: true });
    let systemParts: readonly [string, string];
    try {
      systemParts = buildSystemParts(symbol, context, this.modelLabel);
    } catch (error) {
      return { outcome: "failed", symbol, reason: (error as Error).message };
    }

    const messages: ChzChatMessage[] = systemParts.map((content) => ({ role: "system", content }));
    const sessionContext: ChzRealizeContext = {
      ...context,
      harness: { ...context.harness },
    };
    const verification = new ChzVerificationToolRuntime(
      sessionContext,
      (path) => resolveHarnessOutputPath(sessionContext, path),
    );
    sessionContext.harness ??= {};
    sessionContext.harness.diagnoseFile ??= async (file) => {
      const rendered = await verification.execute("RunTypeCheck", {});
      if (rendered === null) return [];
      try {
        const parsed = JSON.parse(rendered) as { diagnostics?: import("./types.ts").ChzDiagnostic[] };
        return (parsed.diagnostics ?? []).filter(
          (diagnostic) => resolve(diagnostic.file) === resolve(file),
        );
      } catch {
        return [];
      }
    };
    const files = new ChzFilesystemToolRuntime(sessionContext);
    const control = new ChzControlToolRuntime(symbol, sessionContext);
    let terminal: ChzTerminalState | undefined;

    for (let turn = 1; turn <= context.maxTurns && terminal === undefined; turn++) {
      const closing = turn === context.maxTurns;
      if (closing) messages.push({ role: "user", content: TURN_LIMIT_PROMPT });
      emitHarnessEvent(sessionContext, `[${this.name}] turn ${turn}/${context.maxTurns}`);

      let response: ChzChatResponse;
      try {
        response = await this.chatWithRetry(messages, closing ? TERMINAL_TOOLS : CHZ_HARNESS_TOOLS);
      } catch (error) {
        return { outcome: "failed", symbol, reason: `Model request failed: ${(error as Error).message}` };
      }
      if (response.reasoning?.trim()) {
        emitModelReasoning(
          sessionContext,
          `[${this.name}] reasoning turn ${turn}/${context.maxTurns}\n${response.reasoning.trim()}`,
        );
      }
      messages.push(response.message);

      if (response.message.toolCalls.length === 0) {
        if (!closing) {
          messages.push({
            role: "user",
            content: "Call a tool to continue working, or call Finish, Block, or Abort to end the session.",
          });
        }
        continue;
      }

      for (const call of response.message.toolCalls) {
        const input = parseToolArguments(call);
        const startedAt = Date.now();
        let dispatchErrored = false;
        let output: string;

        try {
          if (closing && !TERMINAL_TOOL_NAMES.has(call.name)) {
            output = "Tools are disabled at the turn limit. Call Finish, Block, or Abort.";
            dispatchErrored = true;
          } else if (input.error !== undefined) {
            output = input.error;
            dispatchErrored = true;
          } else {
            const fileResult = await files.execute(call.name, input.value);
            if (fileResult !== null) {
              output = fileResult;
            } else {
              const verificationResult = await verification.execute(call.name, input.value);
              if (verificationResult !== null) {
                output = verificationResult;
              } else {
                const controlResult = await control.execute(call.name, input.value);
                if (controlResult !== null) {
                  output = controlResult.output;
                  terminal = controlResult.terminal;
                } else {
                  output = `Unknown tool: ${call.name}. Use one of the advertised harness tools.`;
                  dispatchErrored = true;
                }
              }
            }
          }
        } catch (error) {
          output = (error as Error).message;
          dispatchErrored = true;
        }

        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: files.boundOutput(output),
        });
        const details = summarizeToolInput(call.name, input.value, sessionContext.projectRoot);
        const outcome = summarizeToolOutcome(call.name, output, terminal, dispatchErrored);
        const durationMs = Math.max(0, Date.now() - startedAt);
        emitHarnessEvent(
          sessionContext,
          `[${this.name}] ${call.name}${details === "" ? "" : `(${details})`} → ${outcome} · ${durationMs}ms`,
        );
        if (terminal !== undefined) break;
      }
    }

    if (terminal === undefined) {
      return {
        outcome: "failed",
        symbol,
        reason: `Turn limit (${context.maxTurns}) reached without Finish, Block, or Abort.`,
      };
    }
    if (terminal.kind === "blocked") {
      return { outcome: "blocked", symbol, reason: terminal.reason, todo: terminal.todo };
    }
    if (terminal.kind === "aborted") {
      return { outcome: "failed", symbol, reason: terminal.reason };
    }

    try {
      return collectResolution(symbol, context, this.modelLabel);
    } catch (error) {
      return { outcome: "failed", symbol, reason: (error as Error).message };
    }
  }

  private async chatWithRetry(
    messages: readonly ChzChatMessage[],
    tools: readonly ChzToolDefinition[],
  ): Promise<ChzChatResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxApiRetries; attempt++) {
      try {
        return await this.chat(messages, tools);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxApiRetries) break;
        await delay(this.retryDelayMs * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function parseToolArguments(call: ChzToolCall): { value: unknown; error?: undefined } | { value?: undefined; error: string } {
  if (typeof call.arguments !== "string") return { value: call.arguments };
  try {
    return { value: JSON.parse(call.arguments) as unknown };
  } catch (error) {
    return {
      error: `Invalid tool input: arguments are not valid JSON (${(error as Error).message}). Please rewrite the input so it satisfies the expected schema.`,
    };
  }
}

function emitHarnessEvent(context: ChzRealizeContext, message: string): void {
  try {
    context.harness?.onEvent?.(message);
  } catch {
    // Observability must never alter the realization result.
  }
}

function emitModelReasoning(context: ChzRealizeContext, message: string): void {
  try {
    context.harness?.onModelReasoning?.(message);
  } catch {
    // Human-only diagnostics must never alter the realization result.
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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

function collectResolution(
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
