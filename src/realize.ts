/**
 * chz — realize engine.
 *
 * `realize` is the development-time step where an LLM turns an `imagine
 * function` spec (lifted by the preprocessor) into committed, *auditable*
 * TypeScript plus vitest tests. This module owns everything from prompt
 * assembly through file emit; it deliberately does NOT run the emitted tests or
 * record a realization cache — that is Step 4.
 *
 * The pipeline for one file is:
 *
 *   extractImagineSpecs(source)             (preprocessor)
 *     -> buildRealizePrompt(spec, source)   assemble the prompt
 *     -> backend.complete(prompt)           call the LLM (abstracted)
 *     -> parseRealizeResponse(response)     pull files out of the markers
 *     -> render{Implementation,Autogen,Ensure,EntryPoint}   shape the emit
 *     -> writeRealization(result)           write chz/realization/<base>/...
 *
 * Two design rules from the docs are load-bearing here:
 *
 *   1. Auditability. Realized code targets a human reviewer, so the prompt
 *      demands dense audit comments and inline `ASSUMPTION:` notes, and the
 *      engine (not the LLM) attaches the provenance header + AUTO-GENERATED
 *      markers so their format is trustworthy.
 *   2. No self-grading. The human's predicate `ensure(...)` contracts are
 *      compiled by the *engine* into a deterministic `assertEnsures` harness
 *      (`tests/test_<name>.ensure.ts`), and the prompt forces every LLM test
 *      case to call it. The LLM therefore cannot route around the human's
 *      contracts — they ride along on the LLM's own test inputs.
 *
 * Zero third-party dependencies: only node builtins.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { extractImagineSpecs, realizationBaseName, type ImagineSpec } from "./preprocessor.ts";

// ---------------------------------------------------------------------------
// LLM backend abstraction
// ---------------------------------------------------------------------------

/**
 * A source of LLM completions. Assembling the prompt and shaping the emit are
 * pure and testable; the actual model call is hidden behind this interface so
 * unit tests can substitute a {@link FakeBackend} and never touch the real
 * claude CLI.
 */
export interface RealizeBackend {
  /**
   * A label identifying the model, embedded verbatim in the provenance header
   * of every emitted implementation (`realized by <modelLabel> ...`).
   */
  readonly modelLabel: string;
  /** Send `prompt` to the model and resolve with its raw text response. */
  complete(prompt: string): Promise<string>;
}

/** Options for {@link ClaudeCliBackend}. */
export interface ClaudeCliOptions {
  /** Model name passed to the claude CLI via `--model`. Omit for the CLI default. */
  model?: string;
  /** Hard timeout for a single call, in milliseconds. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** The executable to spawn. Defaults to `"claude"`; injectable for tests. */
  command?: string;
}

/** Ten minutes: realize prompts are large and the model may think for a while. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * {@link RealizeBackend} backed by the headless claude CLI (`claude -p`).
 *
 * The prompt is delivered over **stdin**, not argv, so it is not bounded by the
 * shell/OS argument-length limit — realize prompts embed the whole source file
 * and are easily tens of kilobytes.
 */
export class ClaudeCliBackend implements RealizeBackend {
  readonly modelLabel: string;
  private readonly options: ClaudeCliOptions;

  constructor(options: ClaudeCliOptions = {}) {
    this.options = options;
    this.modelLabel = options.model ?? "claude CLI (default model)";
  }

  complete(prompt: string): Promise<string> {
    const command = this.options.command ?? "claude";
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = ["-p"];
    if (this.options.model !== undefined) args.push("--model", this.options.model);

    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finishError = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        rejectPromise(new Error(message));
      };

      const timer = setTimeout(() => {
        finishError(`claude CLI timed out after ${timeoutMs} ms`);
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));

      child.on("error", (err) => {
        finishError(`failed to launch '${command}': ${err.message}`);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const detail = stderr.trim() ? `:\n${stderr.trim()}` : "";
          rejectPromise(new Error(`claude CLI exited with code ${code}${detail}`));
          return;
        }
        resolvePromise(stdout);
      });

      child.stdin.on("error", () => {
        // A broken pipe (e.g. the CLI exited early) surfaces via 'close'/'error';
        // swallow the stdin write error so it does not become an unhandled event.
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/**
 * A {@link RealizeBackend} that returns a canned response for a prompt, for use
 * in tests and by Step 4. It records every prompt it was asked to complete.
 * Unit tests MUST use this (or another fake) — they never call the real CLI.
 */
export class FakeBackend implements RealizeBackend {
  readonly modelLabel: string;
  /** Every prompt passed to {@link complete}, in call order. */
  readonly prompts: string[] = [];
  private readonly responder: (prompt: string) => string | Promise<string>;

  constructor(responder: (prompt: string) => string | Promise<string>, modelLabel = "fake-model") {
    this.responder = responder;
    this.modelLabel = modelLabel;
  }

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.responder(prompt);
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/** The marker a file block opens with in the LLM response (see {@link parseRealizeResponse}). */
const FILE_MARKER_HINT = "===FILE: <path>===";

/** Reconstruct the human-readable signature of an imagine function for headers/prompts. */
function formatSignature(spec: ImagineSpec): string {
  const head = `${spec.name}(${spec.parameters})`;
  return spec.returnType ? `${head}: ${spec.returnType}` : head;
}

/** Render the predicate / natural-language ensure contracts as prompt bullet lists. */
function describeContracts(spec: ImagineSpec): { predicates: string; naturals: string } {
  const predicates = spec.ensures.filter((e) => e.kind === "predicate");
  const naturals = spec.ensures.filter((e) => e.kind === "natural");
  const renderList = (items: { source: string }[], empty: string): string =>
    items.length === 0
      ? empty
      : items.map((item, i) => `  ${i + 1}. ${item.source}`).join("\n");
  return {
    predicates: renderList(predicates, "  (none)"),
    naturals: renderList(naturals, "  (none)"),
  };
}

/**
 * Assemble the realize prompt for one imagine spec. Pure and deterministic so
 * it can be inspected with `chz realize --dry-run` and asserted in tests.
 *
 * The prompt carries: (1) the whole `.chz.ts` source as context, (2) the target
 * imagine block verbatim, (3) the requirements + ensure contracts, and (4) the
 * output-format and audit-comment instructions.
 */
export function buildRealizePrompt(spec: ImagineSpec, source: string, fileName: string): string {
  const signature = formatSignature(spec);
  const { predicates, naturals } = describeContracts(spec);
  const requirements =
    spec.requirements !== null && spec.requirements.trim() !== ""
      ? spec.requirements
      : "(none provided — infer the intent from the signature and the function name.)";

  return `You are the code resolver for **chz**, a TypeScript superset built on the principle
"the LLM writes the implementation, the human supervises". Your task is to REALIZE
exactly one \`imagine function\`: produce a plain-TypeScript implementation plus vitest
tests that a human can *audit*, not merely run. Auditability outranks cleverness.

# Context — the whole source file
The imagine function lives in \`${fileName}\`. Here is the entire file, for context
(it may reference other symbols in the file):

\`\`\`typescript
${source}
\`\`\`

# Target — the imagine function to realize
Realize this block, and only this block:

\`\`\`typescript
${spec.originalText}
\`\`\`

- Function name: \`${spec.name}\`
- Signature your implementation MUST match exactly: \`${signature}\`

# Requirements (human intent)
${requirements}

# ensure contracts (human-authored)
Machine-checked predicate contracts — these are enforced automatically for you and
you must NOT reimplement them; just make your implementation satisfy them:
${predicates}

Natural-language contracts — you MUST convert EACH of these into at least one autogen
test case:
${naturals}

# What to produce — exactly two files

## File 1 — \`implementations/${spec.name}.ts\` (the implementation)
- Plain TypeScript that compiles under \`strict\` mode. FORBIDDEN: \`any\`, \`eval\`,
  \`@ts-ignore\`/\`@ts-expect-error\`, and any API outside a plain computation.
- Export the function as a named export matching the signature exactly, e.g.
  \`export function ${spec.name}(...) { ... }\`.
- Do NOT write a provenance header or AUTO-GENERATED markers yourself — the engine
  attaches those. Start the file at the implementation's doc comment.
- Audit-oriented comments are MANDATORY (this is the whole point of chz):
  - A doc comment (\`/** ... */\`) directly above the function with these two exact
    section headers:
    - \`[요구사항 해석]\` — how you interpreted the requirements (prose bullets).
    - \`[계약 대응]\` — how the implementation satisfies each ensure contract.
  - Step-by-step explanatory comments through the body.
  - Wherever the requirements left room for interpretation, an inline
    \`// ASSUMPTION: ...\` comment stating the assumption AND why you made it.

## File 2 — \`tests/test_${spec.name}.autogen.ts\` (your own tests)
- vitest format. Begin with: \`import { describe, it, expect } from "vitest";\`
- Import the implementation with exactly:
  \`import { ${spec.name} } from "../implementations/${spec.name}.ts";\`
- Import the human-contract harness with exactly:
  \`import { assertEnsures } from "./test_${spec.name}.ensure.ts";\`
- Convert EACH natural-language contract above into at least one \`it(...)\` case.
- CRITICAL: in EVERY test case, after calling \`${spec.name}(...)\`, you MUST call
  \`assertEnsures([...the args you passed], theReturnValue);\`. This applies the human's
  predicate contracts to your inputs. Never skip it and never reimplement it.
- Add any further test cases you judge necessary for correctness.

# Audit-comment style to follow
\`\`\`typescript
/**
 * 예금 계좌에 이자를 지급하고, 지급 내역서를 반환합니다.
 *
 * [요구사항 해석]
 * - 예치 일수에 대한 이자를 단리로 계산합니다.
 *
 * [계약 대응]
 * - ensure: netInterest 는 interest - tax 와 일치해야 합니다.
 */
function payDepositInterest(/* ... */) {
  // ASSUMPTION: 연 기준 일수는 365일로 가정합니다.
  // (요구사항에 윤년 처리에 대한 언급이 없습니다.)
  const DAYS_IN_YEAR = 365;
  // ...
}
\`\`\`

# OUTPUT FORMAT (strict)
Emit each file between markers exactly as below. Anything you write outside the
markers is ignored. Emit each of the two files exactly once, with the exact paths
shown, and nothing else between \`===FILE:\` and \`===END===\` besides file contents:

\`\`\`
${FILE_MARKER_HINT}
<file contents>
===END===
\`\`\`

Concretely, produce:

\`\`\`
===FILE: implementations/${spec.name}.ts===
...implementation...
===END===
===FILE: tests/test_${spec.name}.autogen.ts===
...tests...
===END===
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** A malformed LLM realize response (missing / duplicate / unbalanced markers). */
export class RealizeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealizeResponseError";
  }
}

/** One file lifted from an LLM response by {@link parseRealizeResponse}. */
export interface ParsedResponseFile {
  /** The path exactly as written in the `===FILE: ... ===` marker, trimmed. */
  path: string;
  /** The file contents between the markers, trimmed of surrounding blank lines. */
  content: string;
}

const FILE_OPEN_RE = /^\s*===FILE:\s*(.+?)\s*===\s*$/;
const FILE_CLOSE_RE = /^\s*===END===\s*$/;

/**
 * Pull the marker-delimited files out of an LLM response. Text outside any
 * `===FILE: ... ===` / `===END===` pair is ignored, so the model may add prose
 * around the blocks. Throws a {@link RealizeResponseError} for unbalanced,
 * duplicated, or entirely absent markers.
 */
export function parseRealizeResponse(response: string): ParsedResponseFile[] {
  const lines = response.split(/\r?\n/);
  const files: ParsedResponseFile[] = [];
  const seen = new Set<string>();
  let current: { path: string; body: string[] } | null = null;

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const open = FILE_OPEN_RE.exec(line);
    if (open) {
      if (current !== null) {
        throw new RealizeResponseError(
          `line ${n + 1}: new '===FILE:' marker for '${open[1]}' while '${current.path}' ` +
            `is still open (missing '===END===')`,
        );
      }
      const path = open[1]!.trim();
      if (seen.has(path)) {
        throw new RealizeResponseError(`line ${n + 1}: duplicate file marker for '${path}'`);
      }
      seen.add(path);
      current = { path, body: [] };
      continue;
    }
    if (FILE_CLOSE_RE.test(line)) {
      if (current === null) {
        throw new RealizeResponseError(
          `line ${n + 1}: '===END===' with no open '===FILE:' marker`,
        );
      }
      files.push({ path: current.path, content: current.body.join("\n").trim() });
      current = null;
      continue;
    }
    if (current !== null) current.body.push(line);
  }

  if (current !== null) {
    throw new RealizeResponseError(`file '${current.path}' was never closed with '===END==='`);
  }
  if (files.length === 0) {
    throw new RealizeResponseError("no '===FILE: ... ===' markers found in the response");
  }
  return files;
}

// ---------------------------------------------------------------------------
// File rendering
// ---------------------------------------------------------------------------

/**
 * Wrap the LLM's implementation body in the engine-owned provenance header and
 * AUTO-GENERATED markers. The header format is fixed by the engine (not the
 * LLM) so a reviewer can trust it: see docs/60-realize.ko.md.
 */
export function renderImplementationFile(
  spec: ImagineSpec,
  llmContent: string,
  modelLabel: string,
  isoTime: string,
): string {
  return `/// ${spec.name}.ts
/// realization of \`imagine function ${formatSignature(spec)}\`
/// realized by ${modelLabel} (via chz-realize) on ${isoTime}
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

${llmContent.trim()}

/// END OF AUTO-GENERATED CODE
`;
}

/** Prepend a light provenance header to the LLM-authored autogen test file. */
export function renderAutogenFile(
  spec: ImagineSpec,
  llmContent: string,
  modelLabel: string,
  isoTime: string,
): string {
  return `/// test_${spec.name}.autogen.ts
/// AUTO-GENERATED tests for \`imagine function ${spec.name}\`, authored by ${modelLabel}
/// (via chz-realize) on ${isoTime}. These are the LLM's own tests; the human's
/// ensure predicate contracts are enforced separately via ./test_${spec.name}.ensure.ts,
/// which every case below invokes through assertEnsures().

${llmContent.trim()}
`;
}

/**
 * Deterministically build the ensure harness for a spec: the human's predicate
 * `ensure(...)` contracts copied VERBATIM into an array, plus an `assertEnsures`
 * helper the autogen tests call. This is the anti-self-grading mechanism — the
 * engine, not the LLM, writes this file.
 */
export function renderEnsureHarness(spec: ImagineSpec, fileName: string): string {
  const base = realizationBaseName(fileName);
  const predicates = spec.ensures.filter((e) => e.kind === "predicate");

  const predicateEntries =
    predicates.length === 0
      ? "  // (no predicate `ensure(...)` contracts were declared for this function)"
      : predicates.map((p) => `  ${p.source},`).join("\n");
  const sourceEntries =
    predicates.length === 0 ? "" : predicates.map((p) => `  ${JSON.stringify(p.source)},`).join("\n");

  return `/// test_${spec.name}.ensure.ts
/// AUTO-GENERATED ensure-contract harness — DO NOT EDIT.
/// Generated deterministically by chz-realize from the human-authored
/// \`ensure((args, retval) => ...)\` predicate contracts of
/// \`imagine function ${spec.name}\` in ${base}.chz.ts.
///
/// The predicates below are copied VERBATIM from the .chz.ts spec. To change a
/// contract, edit the ensure(...) in the source and re-realize — never edit this
/// file. assertEnsures is invoked from every autogen test case so the human's
/// contracts ride along on the LLM's own test inputs (no self-grading).

/** One human-authored ensure predicate: receives the call args and its return value. */
type EnsurePredicate = (args: readonly unknown[], retval: unknown) => unknown;

/** The predicate ensure(...) contracts, copied verbatim from the spec. */
const ENSURE_PREDICATES: readonly EnsurePredicate[] = [
${predicateEntries}
];

/** The verbatim source text of each predicate, used only in failure messages. */
const ENSURE_SOURCES: readonly string[] = [
${sourceEntries}
];

/**
 * Apply every human-authored ensure predicate to one concrete call of
 * \`${spec.name}\`. Throws with a precise message if any predicate is not satisfied.
 *
 * @param args   the argument list passed to the implementation, as an array
 * @param retval the value the implementation returned
 */
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

/** Best-effort human-readable rendering of a value for failure messages. */
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

/** Build the re-export entry point that the preprocessor's import points at. */
export function renderEntryPoint(specs: ImagineSpec[], fileName: string): string {
  const base = realizationBaseName(fileName);
  const exports = specs
    .map((spec) => `export { ${spec.name} } from "./implementations/${spec.name}.ts";`)
    .join("\n");
  return `/// implementation.ts — realization entry point for ${base}.chz.ts (AUTO-GENERATED by chz-realize).
/// Re-exports every realized symbol. Do not edit; re-run \`chz realize\` instead.

${exports}
`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** A single emitted file, path relative to the realization base directory. */
export interface EmittedFile {
  /** Path relative to {@link RealizeResult.baseDir} (POSIX-style, e.g. `tests/test_x.ensure.ts`). */
  relPath: string;
  content: string;
}

/** The realization of one imagine function: its prompt, raw response, and emitted files. */
export interface RealizedSymbol {
  name: string;
  spec: ImagineSpec;
  /** The exact prompt sent to the backend (also what `--dry-run` prints). */
  prompt: string;
  /** The raw backend response. */
  response: string;
  /** The three files emitted for this symbol (implementation + autogen + ensure). */
  files: EmittedFile[];
}

/** The full result of realizing one `.chz.ts` file. Nothing is written until {@link writeRealization}. */
export interface RealizeResult {
  /** The source file that was realized. */
  fileName: string;
  /** The realization base name (`example.chz.ts` -> `example`). */
  baseName: string;
  /** Absolute path of the realization directory (`.../chz/realization/<base>`). */
  baseDir: string;
  /** One entry per realized imagine function, in source order. */
  symbols: RealizedSymbol[];
  /** Every emitted file (all symbols' files plus the shared `implementation.ts`). */
  files: EmittedFile[];
}

/** Options for {@link realize}. */
export interface RealizeOptions {
  backend: RealizeBackend;
  /** Injectable clock for the provenance timestamp; defaults to `new Date()`. */
  now?: () => Date;
}

/** Compute the absolute realization base directory for a source file. */
export function realizationBaseDir(fileName: string): string {
  return resolve(dirname(fileName), "chz", "realization", realizationBaseName(fileName));
}

/** Find the file a marker with `relPath` produced, or throw a helpful error. */
function requireResponseFile(
  parsed: ParsedResponseFile[],
  relPath: string,
  spec: ImagineSpec,
): ParsedResponseFile {
  const found = parsed.find((f) => f.path === relPath);
  if (found === undefined) {
    const got = parsed.map((f) => f.path).join(", ") || "(none)";
    throw new RealizeResponseError(
      `realize response for '${spec.name}' is missing the expected file '${relPath}'; ` +
        `the response provided: ${got}`,
    );
  }
  return found;
}

/**
 * Realize every imagine function in `source` into an in-memory {@link RealizeResult}.
 * Pure except for the backend call and the clock — writes nothing to disk. Call
 * {@link writeRealization} to persist the result.
 */
export async function realize(
  source: string,
  fileName: string,
  options: RealizeOptions,
): Promise<RealizeResult> {
  const specs = extractImagineSpecs(source, fileName);
  const baseName = realizationBaseName(fileName);
  const baseDir = realizationBaseDir(fileName);
  const isoTime = (options.now ? options.now() : new Date()).toISOString();
  const modelLabel = options.backend.modelLabel;

  const symbols: RealizedSymbol[] = [];
  const files: EmittedFile[] = [];

  for (const spec of specs) {
    const prompt = buildRealizePrompt(spec, source, fileName);
    const response = await options.backend.complete(prompt);
    const parsed = parseRealizeResponse(response);

    const implSource = requireResponseFile(parsed, `implementations/${spec.name}.ts`, spec);
    const autogenSource = requireResponseFile(parsed, `tests/test_${spec.name}.autogen.ts`, spec);

    const symFiles: EmittedFile[] = [
      {
        relPath: `implementations/${spec.name}.ts`,
        content: renderImplementationFile(spec, implSource.content, modelLabel, isoTime),
      },
      {
        relPath: `tests/test_${spec.name}.autogen.ts`,
        content: renderAutogenFile(spec, autogenSource.content, modelLabel, isoTime),
      },
      {
        relPath: `tests/test_${spec.name}.ensure.ts`,
        content: renderEnsureHarness(spec, fileName),
      },
    ];

    symbols.push({ name: spec.name, spec, prompt, response, files: symFiles });
    files.push(...symFiles);
  }

  if (specs.length > 0) {
    files.push({ relPath: "implementation.ts", content: renderEntryPoint(specs, fileName) });
  }

  return { fileName, baseName, baseDir, symbols, files };
}

/**
 * Write a {@link RealizeResult} under its `baseDir`, creating directories as
 * needed. Returns the absolute paths written, in emit order. Overwrites existing
 * files (re-realize is idempotent at the file level for v0).
 */
export function writeRealization(result: RealizeResult): string[] {
  const written: string[] = [];
  for (const file of result.files) {
    const abs = join(result.baseDir, file.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf8");
    written.push(abs);
  }
  return written;
}
