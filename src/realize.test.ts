import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { extractImagineSpecs } from "./preprocessor.ts";
import {
  buildRealizePrompt,
  FakeBackend,
  parseRealizeResponse,
  realize,
  RealizeResponseError,
  renderEnsureHarness,
  writeRealization,
} from "./realize.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NAME = "충돌판정_2D";
const SOURCE = [
  "const EPS = 0.0001;",
  `imagine function ${NAME}(ax: number, ay: number, bx: number, by: number): boolean {`,
  "  requirements(`두 점이 같은 위치인지 판정합니다.`);",
  "  ensure((args, retval) => typeof retval === 'boolean');",
  "  ensure(`같은 좌표가 주어지면 반드시 true 를 반환해야 합니다.`);",
  "}",
  "",
].join("\n");
const FILE = "collide.chz.ts";

/** A well-formed LLM response emitting the two expected files for `NAME`. */
function fakeResponse(name: string): string {
  return [
    "Sure! Here is the realization (this preamble is outside the markers).",
    `===FILE: implementations/${name}.ts===`,
    "/**",
    " * 두 점이 같은지 판정합니다.",
    " *",
    " * [요구사항 해석]",
    " * - 좌표가 모두 일치하면 같은 위치로 봅니다.",
    " *",
    " * [계약 대응]",
    " * - ensure: 반환값은 boolean 입니다.",
    " */",
    `export function ${name}(ax: number, ay: number, bx: number, by: number): boolean {`,
    "  // ASSUMPTION: 부동소수 오차는 무시하고 정확히 비교합니다.",
    "  return ax === bx && ay === by;",
    "}",
    "===END===",
    `===FILE: tests/test_${name}.autogen.ts===`,
    'import { describe, it, expect } from "vitest";',
    `import { ${name} } from "../implementations/${name}.ts";`,
    `import { assertEnsures } from "./test_${name}.ensure.ts";`,
    "",
    `describe("${name}", () => {`,
    '  it("같은 좌표면 true", () => {',
    `    const r = ${name}(1, 2, 1, 2);`,
    "    expect(r).toBe(true);",
    "    assertEnsures([1, 2, 1, 2], r);",
    "  });",
    "});",
    "===END===",
    "That's it — hope it helps!",
  ].join("\n");
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chz-realize-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// buildRealizePrompt
// ---------------------------------------------------------------------------

describe("buildRealizePrompt", () => {
  const spec = extractImagineSpecs(SOURCE, FILE)[0]!;
  const prompt = buildRealizePrompt(spec, SOURCE, FILE);

  it("embeds the whole source file for context", () => {
    expect(prompt).toContain("const EPS = 0.0001;");
    expect(prompt).toContain(SOURCE);
  });

  it("embeds the target imagine block verbatim and the signature", () => {
    expect(prompt).toContain(spec.originalText);
    expect(prompt).toContain(`${NAME}(ax: number, ay: number, bx: number, by: number): boolean`);
  });

  it("includes the requirements and both ensure contracts", () => {
    expect(prompt).toContain("두 점이 같은 위치인지 판정합니다.");
    expect(prompt).toContain("(args, retval) => typeof retval === 'boolean'");
    expect(prompt).toContain("같은 좌표가 주어지면 반드시 true 를 반환해야 합니다.");
  });

  it("instructs the file-marker output format and the assertEnsures obligation", () => {
    expect(prompt).toContain("===FILE:");
    expect(prompt).toContain("===END===");
    expect(prompt).toContain(`implementations/${NAME}.ts`);
    expect(prompt).toContain(`tests/test_${NAME}.autogen.ts`);
    expect(prompt).toContain("assertEnsures");
    // Audit-comment obligations from docs/60-realize.ko.md.
    expect(prompt).toContain("[요구사항 해석]");
    expect(prompt).toContain("[계약 대응]");
    expect(prompt).toContain("ASSUMPTION:");
  });

  it("notes when requirements are absent", () => {
    const noReq = extractImagineSpecs(
      "imagine function ping(): void {\n  ensure((a, r) => r === undefined);\n}\n",
      "ping.chz.ts",
    )[0]!;
    expect(buildRealizePrompt(noReq, "…", "ping.chz.ts")).toContain("(none provided");
  });
});

// ---------------------------------------------------------------------------
// parseRealizeResponse
// ---------------------------------------------------------------------------

describe("parseRealizeResponse", () => {
  it("extracts the marked files and ignores surrounding prose", () => {
    const files = parseRealizeResponse(fakeResponse(NAME));
    expect(files.map((f) => f.path)).toEqual([
      `implementations/${NAME}.ts`,
      `tests/test_${NAME}.autogen.ts`,
    ]);
    expect(files[0]!.content).toContain(`export function ${NAME}`);
    expect(files[0]!.content).not.toContain("preamble");
    expect(files[1]!.content).toContain("assertEnsures([1, 2, 1, 2], r)");
  });

  it("tolerates leading/trailing whitespace on marker lines", () => {
    const resp = ["  ===FILE: a.ts===", "const a = 1;", "===END===  "].join("\n");
    expect(parseRealizeResponse(resp)).toEqual([{ path: "a.ts", content: "const a = 1;" }]);
  });

  it("throws when a file is never closed", () => {
    const resp = ["===FILE: a.ts===", "const a = 1;"].join("\n");
    expect(() => parseRealizeResponse(resp)).toThrow(RealizeResponseError);
    expect(() => parseRealizeResponse(resp)).toThrow(/never closed/);
  });

  it("throws on an '===END===' with no open file", () => {
    expect(() => parseRealizeResponse("===END===")).toThrow(/no open/);
  });

  it("throws on a new file marker before the previous one closed", () => {
    const resp = ["===FILE: a.ts===", "===FILE: b.ts===", "===END==="].join("\n");
    expect(() => parseRealizeResponse(resp)).toThrow(/still open/);
  });

  it("throws on a duplicate file marker", () => {
    const resp = [
      "===FILE: a.ts===",
      "x",
      "===END===",
      "===FILE: a.ts===",
      "y",
      "===END===",
    ].join("\n");
    expect(() => parseRealizeResponse(resp)).toThrow(/duplicate/);
  });

  it("throws when there are no markers at all", () => {
    expect(() => parseRealizeResponse("just some prose, no files")).toThrow(/no '===FILE/);
  });
});

// ---------------------------------------------------------------------------
// renderEnsureHarness (deterministic, engine-owned)
// ---------------------------------------------------------------------------

describe("renderEnsureHarness", () => {
  const spec = extractImagineSpecs(SOURCE, FILE)[0]!;

  it("copies predicate ensures verbatim and exports assertEnsures", () => {
    const harness = renderEnsureHarness(spec, FILE);
    expect(harness).toContain("export function assertEnsures(");
    expect(harness).toContain("const ENSURE_PREDICATES: readonly EnsurePredicate[] = [");
    // Predicate copied verbatim.
    expect(harness).toContain("(args, retval) => typeof retval === 'boolean',");
    // The natural-language ensure is NOT part of the predicate harness.
    expect(harness).not.toContain("같은 좌표가 주어지면");
    // Verbatim source recorded for failure messages.
    expect(harness).toContain(JSON.stringify("(args, retval) => typeof retval === 'boolean'"));
  });

  it("emits a valid (empty) harness when there are no predicate contracts", () => {
    const naturalOnly = extractImagineSpecs(
      "imagine function f(): void {\n  ensure(`무언가를 해야 합니다.`);\n}\n",
      "f.chz.ts",
    )[0]!;
    const harness = renderEnsureHarness(naturalOnly, "f.chz.ts");
    expect(harness).toContain("no predicate `ensure(...)` contracts");
    expect(harness).toContain("export function assertEnsures(");
  });
});

// ---------------------------------------------------------------------------
// realize + writeRealization (end-to-end with a fake backend, no real CLI)
// ---------------------------------------------------------------------------

describe("realize", () => {
  it("records every prompt on the backend", async () => {
    const backend = new FakeBackend(() => fakeResponse(NAME));
    const file = join(makeTempDir(), FILE);
    await realize(SOURCE, file, { backend });
    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain(NAME);
  });

  it("produces the chz/realization/<base>/ layout in memory", async () => {
    const backend = new FakeBackend(() => fakeResponse(NAME));
    const file = join(makeTempDir(), FILE);
    const result = await realize(SOURCE, file, { backend });

    expect(result.baseName).toBe("collide");
    expect(result.baseDir.endsWith(join("chz", "realization", "collide"))).toBe(true);
    expect(result.files.map((f) => f.relPath).sort()).toEqual(
      [
        "implementation.ts",
        `implementations/${NAME}.ts`,
        `tests/test_${NAME}.autogen.ts`,
        `tests/test_${NAME}.ensure.ts`,
      ].sort(),
    );
  });

  it("attaches the provenance header and AUTO-GENERATED markers to the implementation", async () => {
    const backend = new FakeBackend(() => fakeResponse(NAME), "claude-opus-4.8");
    const file = join(makeTempDir(), FILE);
    const result = await realize(SOURCE, file, {
      backend,
      now: () => new Date("2026-07-23T12:34:56.000Z"),
    });
    const impl = result.files.find((f) => f.relPath === `implementations/${NAME}.ts`)!.content;

    expect(impl.startsWith(`/// ${NAME}.ts\n`)).toBe(true);
    expect(impl).toContain(`/// realization of \`imagine function ${NAME}(`);
    expect(impl).toContain(
      "/// realized by claude-opus-4.8 (via chz-realize) on 2026-07-23T12:34:56.000Z",
    );
    expect(impl).toContain("/// AUTO-GENERATED CODE - DO NOT EDIT");
    expect(impl).toContain("/// END OF AUTO-GENERATED CODE");
    // The LLM body is present, without its markers.
    expect(impl).toContain(`export function ${NAME}(`);
    expect(impl).not.toContain("===FILE:");
  });

  it("generates the re-export entry point the preprocessor import points at", async () => {
    const backend = new FakeBackend(() => fakeResponse(NAME));
    const file = join(makeTempDir(), FILE);
    const result = await realize(SOURCE, file, { backend });
    const entry = result.files.find((f) => f.relPath === "implementation.ts")!.content;
    expect(entry).toContain(`export { ${NAME} } from "./implementations/${NAME}.ts";`);
  });

  it("writes the files to disk under the base directory", async () => {
    const backend = new FakeBackend(() => fakeResponse(NAME));
    const dir = makeTempDir();
    const file = join(dir, FILE);
    const result = await realize(SOURCE, file, { backend });
    const written = writeRealization(result);

    expect(written).toHaveLength(result.files.length);
    for (const abs of written) expect(existsSync(abs)).toBe(true);

    const ensurePath = join(result.baseDir, "tests", `test_${NAME}.ensure.ts`);
    expect(readFileSync(ensurePath, "utf8")).toContain("export function assertEnsures(");
  });

  it("throws a clear error when the response omits an expected file", async () => {
    const backend = new FakeBackend(
      () => [`===FILE: implementations/${NAME}.ts===`, "export function x() {}", "===END==="].join("\n"),
    );
    const file = join(makeTempDir(), FILE);
    await expect(realize(SOURCE, file, { backend })).rejects.toThrow(
      new RegExp(`missing the expected file 'tests/test_${NAME}\\.autogen\\.ts'`),
    );
  });
});
