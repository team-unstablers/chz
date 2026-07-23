/**
 * chz — realization verification loop (Step 4).
 *
 * Once the realize engine (Step 3) has emitted `chz/realization/<base>/`, this
 * module runs the emitted tests and, when they pass, records a hash of the
 * realization into `realization-cache.json`. Two design rules from the docs are
 * load-bearing here:
 *
 *   1. Lockfile model (idea-sketch §3.2). The imagine block is the "version
 *      range"; the realized code is the "lockfile". `realization-cache.json`
 *      pins the exact spec + emitted-file hashes plus provenance (model,
 *      timestamp), so a later `chz` run can tell whether the committed code
 *      still matches what was realized — the basis for drift detection
 *      (milestone 2). This module only *records* the cache; it never skips work
 *      based on it.
 *   2. The build never calls an LLM. Verification is a plain child-process
 *      vitest run over committed files, so it is reproducible and offline.
 *
 * ── The vitest-collection problem ────────────────────────────────────────────
 * The emitted tests are named `tests/test_<name>.autogen.ts` and
 * `tests/test_<name>.ensure.ts`. Neither matches vitest's default include glob
 * (`**\/*.{test,spec}.*`), and `chz/` is excluded from the root tsconfig, so a
 * plain `vitest run` would never collect them. We solve this without touching
 * the root config by spawning a *separate* vitest process with a throwaway
 * config whose `test.include` is the explicit absolute paths of just this
 * realization's test files. `globals` lets the engine-owned `.ensure.ts` files
 * call their locally declared `it` binding without importing a user dependency.
 * `passWithNoTests` remains enabled because a symbol with no human ensures emits
 * an intentionally empty `.ensure.ts` module.
 *
 * The child is spawned with its cwd set to the chz project root (where
 * `node_modules/vitest` lives) so that the emitted tests' `import ... from
 * "vitest"` resolves even when the realization lives outside the chz repo.
 *
 * Zero third-party dependencies: only node builtins.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractConfirmedDependencies } from "./graph.ts";
import { publicSurfaceText } from "./preprocessor.ts";
import type { RealizeResult } from "./realize.ts";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Lower-case sha256 hex digest of a UTF-8 string. Used for every cache hash. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Locating the test files and the vitest binary
// ---------------------------------------------------------------------------

/** Only the two emitted realization test-file kinds are ever run. */
const TEST_FILE_RE = /^test_.+\.(autogen|ensure)\.ts$/;

/**
 * The absolute paths of the realization's test files (`tests/test_*.autogen.ts`
 * and `tests/test_*.ensure.ts`), sorted for a deterministic run order. Returns
 * `[]` when the `tests/` directory is absent or holds no matching files.
 */
export function findRealizationTestFiles(baseDir: string): string[] {
  const testsDir = join(baseDir, "tests");
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir)
    .filter((name) => TEST_FILE_RE.test(name))
    .sort()
    .map((name) => join(testsDir, name));
}

/** The chz project root and the resolved vitest CLI entry point. */
interface VitestLocation {
  /** Absolute path of `node_modules/vitest/vitest.mjs`, spawned via `node`. */
  binPath: string;
  /** Directory containing `node_modules/vitest` — used as the child's cwd. */
  projectRoot: string;
}

/**
 * Resolve vitest from this module's own dependency tree (not from wherever the
 * realization lives). `require.resolve("vitest/package.json")` walks the normal
 * node resolution chain, so this keeps working regardless of the realization's
 * location or the caller's cwd.
 */
function locateVitest(): VitestLocation {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("vitest/package.json");
  const vitestDir = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const binEntry = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.vitest ?? "./vitest.mjs");
  const binPath = resolve(vitestDir, binEntry);
  // pkgPath = .../node_modules/vitest/package.json
  //   dirname       -> .../node_modules/vitest
  //   dirname       -> .../node_modules
  //   dirname       -> <project root>
  const projectRoot = dirname(dirname(vitestDir));
  return { binPath, projectRoot };
}

// ---------------------------------------------------------------------------
// Running the realization's tests
// ---------------------------------------------------------------------------

/** The outcome of one {@link runRealizationTests} invocation. */
export interface RealizationTestOutcome {
  /** True only when vitest exited 0 with every collected test passing. */
  passed: boolean;
  /** True when the run was killed for exceeding the timeout. */
  timedOut: boolean;
  /** Combined stdout+stderr of the vitest run, preserved verbatim for display. */
  output: string;
  /** Absolute paths of the test files that were targeted. */
  testFiles: string[];
  /** Passing-test count parsed from vitest's summary, or `null` if unparseable. */
  testCount: number | null;
}

/** Options for {@link runRealizationTests}. */
export interface RunRealizationTestsOptions {
  /** Hard timeout for the vitest child, in ms. Defaults to 2 minutes. */
  timeoutMs?: number;
}

/** Two minutes: enough for a realization's small unit suite, bounded for CI. */
const DEFAULT_TEST_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

/** Pull the "Tests  N passed" count out of vitest's default summary output. */
function parseVitestTestCount(output: string): number | null {
  // Matches lines like "      Tests  3 passed (3)". Tolerates the leading pad.
  const match = /Tests\s+(\d+)\s+passed/.exec(output);
  return match ? Number(match[1]) : null;
}

/**
 * Run the emitted tests of the realization at `baseDir` in a child vitest
 * process and report success plus the full output. Never throws for test
 * failures — a red run is a normal result reported via `passed: false`; the
 * caller decides what to do with it. See the module header for how the
 * vitest-collection problem is solved.
 */
export async function runRealizationTests(
  baseDir: string,
  options: RunRealizationTestsOptions = {},
): Promise<RealizationTestOutcome> {
  const testFiles = findRealizationTestFiles(baseDir);
  if (testFiles.length === 0) {
    return {
      passed: false,
      timedOut: false,
      output: `no test files (tests/test_*.autogen.ts or tests/test_*.ensure.ts) found under ${baseDir}`,
      testFiles,
      testCount: 0,
    };
  }
  if (!testFiles.some((file) => file.endsWith(".autogen.ts"))) {
    return {
      passed: false,
      timedOut: false,
      output: `no autogen test file (tests/test_*.autogen.ts) found under ${baseDir}`,
      testFiles,
      testCount: 0,
    };
  }

  const { binPath, projectRoot } = locateVitest();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  // A throwaway vitest config whose only job is to point `include` at exactly
  // this realization's test files. Written as a plain-object .mjs (no imports)
  // so it needs no module resolution of its own, and dropped in a temp dir so
  // it never pollutes the realization output.
  const configDir = mkdtempSync(join(tmpdir(), "chz-vitest-"));
  const configPath = join(configDir, "vitest.config.mjs");
  const configSource =
    `export default {\n` +
    `  test: {\n` +
    `    // Executable human ensures use the injected global test function.\n` +
    `    globals: true,\n` +
    `    // Symbols without ensures still emit an intentionally empty module.\n` +
    `    passWithNoTests: true,\n` +
    `    include: ${JSON.stringify(testFiles)},\n` +
    `  },\n` +
    `};\n`;
  writeFileSync(configPath, configSource, "utf8");

  try {
    return await new Promise<RealizationTestOutcome>((resolvePromise) => {
      const child = spawn(process.execPath, [binPath, "run", "--config", configPath], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        // Strip ANSI colour so the preserved output is clean in logs/stderr, and
        // signal non-interactive so vitest never tries to open a watcher/TTY UI.
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "true" },
      });

      // Append both streams to one buffer in arrival order for readable output.
      let combined = "";
      let capturedBytes = 0;
      let captureTruncated = false;
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const capture = (chunk: string): void => {
        if (captureTruncated) return;
        const bytes = Buffer.from(chunk, "utf8");
        const available = MAX_PROCESS_OUTPUT_BYTES - capturedBytes;
        if (bytes.length <= available) {
          combined += chunk;
          capturedBytes += bytes.length;
          return;
        }
        if (available > 0) combined += bytes.subarray(0, available).toString("utf8");
        capturedBytes = MAX_PROCESS_OUTPUT_BYTES;
        captureTruncated = true;
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      const finish = (processPassed: boolean, extra = "") => {
        clearTimeout(timer);
        const truncation = captureTruncated
          ? "\n[output capture truncated at the in-memory safety limit]\n"
          : "";
        const capturedOutput = combined + truncation + extra;
        const testCount = parseVitestTestCount(capturedOutput);
        const noTestsExecuted = processPassed && (testCount === null || testCount === 0);
        const output = noTestsExecuted
          ? `${capturedOutput}\nvitest completed without executing any tests.\n`
          : capturedOutput;
        resolvePromise({
          passed: processPassed && !noTestsExecuted,
          timedOut,
          output,
          testFiles,
          testCount,
        });
      };

      child.on("error", (err) => {
        finish(false, `\nfailed to launch vitest ('${binPath}'): ${err.message}\n`);
      });

      child.on("close", (code) => {
        if (timedOut) {
          finish(false, `\nvitest timed out after ${timeoutMs} ms and was killed.\n`);
          return;
        }
        finish(code === 0);
      });
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// realization-cache.json
// ---------------------------------------------------------------------------

/** Per-symbol record in {@link RealizationCache}. Field order is stable for diffs. */
export interface RealizationCacheSymbol {
  /** Symbol name (also the map key, kept here so each entry is self-describing). */
  name: string;
  /** sha256 of the imagine block's `originalText` — the spec that was realized. */
  specHash: string;
  /**
   * sha256 of the declaration's public surface (signature + ensure contracts,
   * docs/62). Re-realize propagates invalidation to dependents only when this
   * hash changes; a requirements-only edit leaves it stable.
   */
  publicSurfaceHash: string;
  /** sha256 of the emitted `implementations/<name>.ts` content. */
  implementationHash: string;
  /** sha256 of the emitted `tests/test_<name>.autogen.ts` content. */
  autogenTestHash: string;
  /** sha256 of the emitted `tests/test_<name>.ensure.ts` content. */
  ensureTestHash: string;
  /**
   * Confirmed dependency edges (docs/62 stage 3): the imagine symbols this
   * realized implementation actually imports, sorted by name. Re-runs prefer
   * these over the estimated mention-scan edges.
   */
  dependencies: string[];
  /** Model label that realized this symbol (provenance). */
  model: string;
  /** ISO-8601 time the realization was recorded. */
  realizedAt: string;
  /** Whether the emitted tests passed (false when red or skipped). */
  testsPassed: boolean;
}

/** The v0 `realization-cache.json` shape. A lockfile for one `.chz.ts` file. */
export interface RealizationCache {
  /** chz tool version (`package.json` version) that produced this cache. */
  chzVersion: string;
  /** Base name of the source `.chz.ts` file. */
  sourceFileName: string;
  /** sha256 of the entire original source, before preprocessing. */
  sourceHash: string;
  /** True when tests were explicitly skipped (`--skip-tests`) rather than run. */
  testsSkipped: boolean;
  /** One entry per realized symbol, keyed by name, in source order. */
  symbols: Record<string, RealizationCacheSymbol>;
}

/** Inputs for building/writing a {@link RealizationCache}. */
export interface BuildRealizationCacheInput {
  /** The realize result whose emitted files and specs are hashed. */
  result: RealizeResult;
  /** The full original source (pre-preprocess) that was realized. */
  source: string;
  /** chz tool version to stamp into the cache. */
  chzVersion: string;
  /** Legacy fallback label; each resolved symbol normally records resolvedBy. */
  modelLabel?: string;
  /** ISO-8601 timestamp recorded for every symbol. */
  realizedAt: string;
  /** Whether the emitted tests passed. */
  testsPassed: boolean;
  /** Whether tests were skipped rather than run (implies `testsPassed: false`). */
  testsSkipped?: boolean;
}

/** Absolute path of a realization's cache file. */
export function realizationCachePath(baseDir: string): string {
  return join(baseDir, "realization-cache.json");
}

/** Locate an emitted file's content within a symbol by its relative path. */
function emittedContent(result: RealizeResult, symbolName: string, relPath: string): string {
  const symbol = result.symbols.find((s) => s.name === symbolName);
  const file = symbol?.files.find((f) => f.relPath === relPath);
  if (file === undefined) {
    throw new Error(`realization result is missing emitted file '${relPath}' for symbol '${symbolName}'`);
  }
  return file.content;
}

/**
 * Build the in-memory {@link RealizationCache} for a realize result. Pure: it
 * only hashes strings, so tests can assert the schema without touching disk.
 */
export function buildRealizationCache(input: BuildRealizationCacheInput): RealizationCache {
  const { result, source, chzVersion, realizedAt, testsPassed } = input;
  const testsSkipped = input.testsSkipped ?? false;

  const knownSymbolNames = result.symbols.map((symbol) => symbol.name);
  const symbols: Record<string, RealizationCacheSymbol> = {};
  for (const symbol of result.symbols) {
    const implementation = emittedContent(result, symbol.name, `implementations/${symbol.name}.ts`);
    symbols[symbol.name] = {
      name: symbol.name,
      specHash: sha256(symbol.spec.originalText),
      publicSurfaceHash: sha256(publicSurfaceText(symbol.spec)),
      implementationHash: sha256(implementation),
      autogenTestHash: sha256(emittedContent(result, symbol.name, `tests/test_${symbol.name}.autogen.ts`)),
      ensureTestHash: sha256(emittedContent(result, symbol.name, `tests/test_${symbol.name}.ensure.ts`)),
      dependencies: extractConfirmedDependencies(implementation, symbol.name, knownSymbolNames),
      model: symbol.resolution.resolvedBy ?? input.modelLabel ?? "unknown-realizer",
      realizedAt,
      testsPassed,
    };
  }

  return {
    chzVersion,
    sourceFileName: basename(result.fileName),
    sourceHash: sha256(source),
    testsSkipped,
    symbols,
  };
}

/**
 * Build and write `<baseDir>/realization-cache.json`, pretty-printed with a
 * trailing newline. Returns the absolute path written.
 */
export function writeRealizationCache(input: BuildRealizationCacheInput): string {
  const cache = buildRealizationCache(input);
  const path = realizationCachePath(input.result.baseDir);
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// chz version
// ---------------------------------------------------------------------------

/** Read the chz tool version from the package.json shipped alongside `src/`. */
export function readChzVersion(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}
