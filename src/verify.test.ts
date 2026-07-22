import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { extractImagineSpecs } from "./preprocessor.ts";
import { FakeBackend, realize, writeRealization } from "./realize.ts";
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
    "reports success and a test count for a green realization (incl. an ensure harness)",
    async () => {
      const baseDir = join(makeTempDir(), "green");
      // Mirrors the real emit: an .ensure.ts harness (no suite) imported by the
      // autogen tests. The harness must NOT be reported as a failure.
      writeTree(baseDir, {
        "tests/test_x.ensure.ts":
          "export function assertEnsures(_args, retval) {\n" +
          '  if (typeof retval !== "number") throw new Error("not a number");\n' +
          "}\n",
        "tests/test_x.autogen.ts":
          'import { it, expect } from "vitest";\n' +
          'import { assertEnsures } from "./test_x.ensure.ts";\n' +
          'it("a", () => { expect(1).toBe(1); assertEnsures([], 1); });\n' +
          'it("b", () => { expect(2).toBe(2); assertEnsures([], 2); });\n',
      });

      const outcome = await runRealizationTests(baseDir);
      expect(outcome.passed).toBe(true);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.testCount).toBe(2);
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

  it("returns a non-passing outcome (no spawn) when there are no test files", async () => {
    const baseDir = join(makeTempDir(), "empty");
    mkdirSync(baseDir, { recursive: true });
    const outcome = await runRealizationTests(baseDir);
    expect(outcome.passed).toBe(false);
    expect(outcome.testFiles).toEqual([]);
    expect(outcome.output).toContain("no test files");
  });

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
  "  ensure((args, retval) => typeof retval === 'boolean');",
  "  ensure(`같은 좌표가 주어지면 반드시 true 를 반환해야 합니다.`);",
  "}",
  "",
].join("\n");
const FILE = "collide.chz.ts";

function fakeResponse(name: string): string {
  return [
    `===FILE: implementations/${name}.ts===`,
    `export function ${name}(ax: number, ay: number, bx: number, by: number): boolean {`,
    "  return ax === bx && ay === by;",
    "}",
    "===END===",
    `===FILE: tests/test_${name}.autogen.ts===`,
    'import { it, expect } from "vitest";',
    `import { ${name} } from "../implementations/${name}.ts";`,
    `import { assertEnsures } from "./test_${name}.ensure.ts";`,
    `it("same", () => { const r = ${name}(1, 2, 1, 2); expect(r).toBe(true); assertEnsures([1, 2, 1, 2], r); });`,
    "===END===",
  ].join("\n");
}

async function realizeFixture(): Promise<Awaited<ReturnType<typeof realize>>> {
  const backend = new FakeBackend(() => fakeResponse(NAME), "fake-model");
  const file = join(makeTempDir(), FILE);
  return realize(SOURCE, file, { backend, now: () => new Date("2026-07-23T12:34:56.000Z") });
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
    writeRealization(result); // create the base dir + emitted files
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
