import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { extractImagineSpecs } from "./preprocessor.ts";
import {
  realize,
  renderEnsureHarness,
  type ChzImagineSymbol,
  type ChzImagineSymbolResolution,
  type ChzRealizeContext,
  type ChzRealizer,
} from "./realize.ts";
import {
  buildRealizationCache,
  findRealizationTestFiles,
  runRealizationTests,
  sha256,
  writeRealizationCache,
} from "./verify.ts";

// ---------------------------------------------------------------------------
// Temp-dir plumbing
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chz-verify-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** Write `{ relPath: content }` under `baseDir`, creating parent dirs. */
function writeTree(baseDir: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(baseDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

// Spawning a real vitest child costs ~1-2s; give these cases generous timeouts.
const SPAWN_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// runRealizationTests — the vitest-in-vitest runner
// ---------------------------------------------------------------------------

describe("runRealizationTests", () => {
  it(
    "reports success and a test count for green autogen and executable ensure tests",
    async () => {
      const baseDir = join(makeTempDir(), "green");
      // Mirrors the real emit: human ensures are an independent executable
      // suite and do not rely on the model-authored tests importing a helper.
      writeTree(baseDir, {
        "tests/test_x.ensure.ts":
          "declare const it: (name: string, test: () => unknown) => void;\n" +
          'it("human contract", () => { if (1 + 1 !== 2) throw new Error("bad math"); });\n',
        "tests/test_x.autogen.ts":
          'import { it, expect } from "vitest";\n' +
          'it("a", () => { expect(1).toBe(1); });\n' +
          'it("b", () => { expect(2).toBe(2); });\n',
      });

      const outcome = await runRealizationTests(baseDir);
      expect(outcome.passed).toBe(true);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.testCount).toBe(3);
      expect(outcome.testFiles).toHaveLength(2);
      expect(outcome.output).toContain("passed");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "reports failure and preserves the vitest output for a red realization",
    async () => {
      const baseDir = join(makeTempDir(), "red");
      writeTree(baseDir, {
        "tests/test_r.autogen.ts":
          'import { it, expect } from "vitest";\n' +
          'it("boom", () => { expect(1).toBe(2); });\n',
      });

      const outcome = await runRealizationTests(baseDir);
      expect(outcome.passed).toBe(false);
      expect(outcome.timedOut).toBe(false);
      // The full vitest output is preserved so the CLI can show it.
      expect(outcome.output.length).toBeGreaterThan(0);
      expect(outcome.output).toContain("test_r.autogen.ts");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "runs a generated human assertion even when the autogen test never imports it",
    async () => {
      const baseDir = join(makeTempDir(), "human-assertion");
      const source =
        "imagine function answer(): number { ensure(answer() === 42, '정답은 42입니다.'); }\n";
      const spec = extractImagineSpecs(source, "answer.chz.ts")[0]!;

      writeTree(baseDir, {
        "implementations/answer.ts": "export function answer(): number { return 41; }\n",
        "tests/test_answer.ensure.ts": renderEnsureHarness(spec, "answer.chz.ts"),
        "tests/test_answer.autogen.ts":
          'import { it, expect } from "vitest";\n' +
          'it("unrelated autogen check", () => { expect(true).toBe(true); });\n',
      });

      const outcome = await runRealizationTests(baseDir);

      expect(outcome.passed).toBe(false);
      expect(outcome.output).toContain("정답은 42입니다.");
      expect(outcome.output).toContain("ensure assertion failed at answer.chz.ts:1:");
    },
    SPAWN_TIMEOUT,
  );

  it("returns a non-passing outcome (no spawn) when there are no test files", async () => {
    const baseDir = join(makeTempDir(), "empty");
    mkdirSync(baseDir, { recursive: true });
    const outcome = await runRealizationTests(baseDir);
    expect(outcome.passed).toBe(false);
    expect(outcome.testFiles).toEqual([]);
    expect(outcome.output).toContain("no test files");
  });

  it("does not treat an ensure harness without an autogen suite as green", async () => {
    const baseDir = join(makeTempDir(), "ensure-only");
    writeTree(baseDir, {
      "tests/test_x.ensure.ts":
        "declare const it: (name: string, test: () => unknown) => void;\n" +
        'it("human contract", () => {});\n',
    });

    const outcome = await runRealizationTests(baseDir);

    expect(outcome.passed).toBe(false);
    expect(outcome.testCount).toBe(0);
    expect(outcome.output).toContain("no autogen test file");
  });

  it(
    "does not report an empty autogen suite as green",
    async () => {
      const baseDir = join(makeTempDir(), "empty-autogen");
      writeTree(baseDir, {
        "tests/test_x.autogen.ts": "export {};\n",
      });

      const outcome = await runRealizationTests(baseDir);

      expect(outcome.passed).toBe(false);
      expect(outcome.testCount).toBeNull();
      expect(outcome.output).toContain("without executing any tests");
    },
    SPAWN_TIMEOUT,
  );

  it("finds only test_*.autogen.ts / test_*.ensure.ts files", () => {
    const baseDir = join(makeTempDir(), "glob");
    writeTree(baseDir, {
      "tests/test_a.autogen.ts": "",
      "tests/test_a.ensure.ts": "",
      "tests/helper.ts": "",
      "tests/notes.md": "",
    });
    const found = findRealizationTestFiles(baseDir).map((p) => basename(p));
    expect(found).toEqual(["test_a.autogen.ts", "test_a.ensure.ts"]);
  });
});

// ---------------------------------------------------------------------------
// realization-cache.json
// ---------------------------------------------------------------------------

const NAME = "충돌판정_2D";
const SOURCE = [
  `imagine function ${NAME}(ax: number, ay: number, bx: number, by: number): boolean {`,
  "  requirements(`두 점이 같은 위치인지 판정합니다.`);",
  `  ensure(${NAME}(0, 0, 0, 0) === true, '같은 좌표는 true입니다.');`,
  `  ensure('반환값은 boolean입니다.', () => { assert(typeof ${NAME}(0, 0, 1, 1) === 'boolean'); });`,
  "}",
  "",
].join("\n");
const FILE = "collide.chz.ts";

class FixtureRealizer implements ChzRealizer {
  readonly name = "FixtureRealizer";
  readonly supportedSymbolTypes = ["function"] as const;

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
    const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
    mkdirSync(dirname(implementation), { recursive: true });
    mkdirSync(dirname(test), { recursive: true });
    writeFileSync(
      implementation,
      `export function ${symbol.name}(ax: number, ay: number, bx: number, by: number): boolean { return ax === bx && ay === by; }\n`,
      "utf8",
    );
    writeFileSync(test, 'import { it, expect } from "vitest";\nit("same", () => expect(true).toBe(true));\n', "utf8");
    return {
      outcome: "resolved",
      symbol,
      resolvedFile: implementation,
      resolvedTestFiles: [test],
      resolvedAt: new Date("2026-07-23T12:34:56.000Z"),
      resolvedBy: "fake-model",
    };
  }
}

async function realizeFixture(): Promise<Awaited<ReturnType<typeof realize>>> {
  const file = join(makeTempDir(), FILE);
  writeFileSync(file, SOURCE, "utf8");
  return realize(SOURCE, file, {
    realizers: [new FixtureRealizer()],
    now: () => new Date("2026-07-23T12:34:56.000Z"),
    skipVerification: true,
  });
}

describe("buildRealizationCache", () => {
  it("records version, source hash, and per-symbol hashes + provenance", async () => {
    const result = await realizeFixture();
    const cache = buildRealizationCache({
      result,
      source: SOURCE,
      chzVersion: "1.2.3",
      modelLabel: "fake-model",
      realizedAt: "2026-07-23T12:34:56.000Z",
      testsPassed: true,
    });

    expect(cache.chzVersion).toBe("1.2.3");
    expect(cache.sourceFileName).toBe(FILE);
    expect(cache.sourceHash).toBe(sha256(SOURCE));
    expect(cache.testsSkipped).toBe(false);

    const spec = extractImagineSpecs(SOURCE, FILE)[0]!;
    const sym = cache.symbols[NAME]!;
    expect(sym.name).toBe(NAME);
    expect(sym.model).toBe("fake-model");
    expect(sym.realizedAt).toBe("2026-07-23T12:34:56.000Z");
    expect(sym.testsPassed).toBe(true);

    // Hashes are sha256 hex and match the exact spec / emitted-file contents.
    for (const h of [sym.specHash, sym.implementationHash, sym.autogenTestHash, sym.ensureTestHash]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(sym.specHash).toBe(sha256(spec.originalText));
    const implContent = result.files.find((f) => f.relPath === `implementations/${NAME}.ts`)!.content;
    expect(sym.implementationHash).toBe(sha256(implContent));
    const autogenContent = result.files.find((f) => f.relPath === `tests/test_${NAME}.autogen.ts`)!.content;
    expect(sym.autogenTestHash).toBe(sha256(autogenContent));
  });

  it("marks testsSkipped and testsPassed:false when tests were skipped", async () => {
    const result = await realizeFixture();
    const cache = buildRealizationCache({
      result,
      source: SOURCE,
      chzVersion: "1.2.3",
      modelLabel: "fake-model",
      realizedAt: "2026-07-23T12:34:56.000Z",
      testsPassed: false,
      testsSkipped: true,
    });
    expect(cache.testsSkipped).toBe(true);
    expect(cache.symbols[NAME]!.testsPassed).toBe(false);
  });
});

describe("writeRealizationCache", () => {
  it("writes pretty-printed JSON to <baseDir>/realization-cache.json", async () => {
    const result = await realizeFixture();
    const path = writeRealizationCache({
      result,
      source: SOURCE,
      chzVersion: "0.0.0",
      modelLabel: "fake-model",
      realizedAt: "2026-07-23T12:34:56.000Z",
      testsPassed: true,
    });

    expect(path).toBe(join(result.baseDir, "realization-cache.json"));
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  "); // 2-space indentation
    const parsed = JSON.parse(raw);
    expect(parsed.symbols[NAME].testsPassed).toBe(true);
    expect(parsed.chzVersion).toBe("0.0.0");
  });
});
