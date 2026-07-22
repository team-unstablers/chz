import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BIN_NAME, buildUsage, run } from "./cli.ts";
import { FakeBackend } from "./realize.ts";

const tempDirs: string[] = [];
/** Write `source` to a temp `.chz.ts` file and return its path. */
function writeChzFixture(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chz-cli-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, source, "utf8");
  return file;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** A minimal LLM response emitting the two files realize expects for `name`. */
function fakeResponse(name: string): string {
  return [
    `===FILE: implementations/${name}.ts===`,
    `export function ${name}(a: number, b: number): boolean {`,
    "  return a === b;",
    "}",
    "===END===",
    `===FILE: tests/test_${name}.autogen.ts===`,
    'import { it, expect } from "vitest";',
    `import { ${name} } from "../implementations/${name}.ts";`,
    `import { assertEnsures } from "./test_${name}.ensure.ts";`,
    `it("x", () => { const r = ${name}(1, 1); expect(r).toBe(true); assertEnsures([1, 1], r); });`,
    "===END===",
  ].join("\n");
}

describe("buildUsage", () => {
  it("names the binary and lists the realize command", () => {
    const usage = buildUsage();
    expect(usage).toContain(`usage: ${BIN_NAME} <command>`);
    expect(usage).toContain("realize");
    expect(usage).toContain("--help");
    expect(usage).toContain("--dry-run");
  });
});

describe("run", () => {
  it("prints usage and exits 0 with no arguments", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run([], { out: (m) => out.push(m), err: (m) => err.push(m) });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`usage: ${BIN_NAME}`);
    expect(err).toEqual([]);
  });

  it("prints usage and exits 0 for --help", () => {
    const out: string[] = [];
    const code = run(["--help"], { out: (m) => out.push(m), err: () => {} });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`usage: ${BIN_NAME}`);
  });

  it("reports unknown commands to stderr and exits 1", () => {
    const err: string[] = [];
    const code = run(["frobnicate"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown command 'frobnicate'");
  });

  it("realize --json prints the extracted specs as JSON and exits 0 (no LLM call)", async () => {
    const file = writeChzFixture(
      "j.chz.ts",
      "imagine function greet(name: string): string {\n  ensure(`인사말을 반환합니다.`);\n}\n",
    );
    const out: string[] = [];
    const code = await run(["realize", "--json", file], { out: (m) => out.push(m), err: () => {} });
    expect(code).toBe(0);
    const specs = JSON.parse(out.join("\n"));
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe("greet");
    expect(specs[0].ensures[0].kind).toBe("natural");
  });

  it("realize --dry-run prints the assembled prompt without calling the LLM", async () => {
    const file = writeChzFixture(
      "demo.chz.ts",
      [
        "imagine function 충돌판정_2D(a: number, b: number): boolean {",
        "  requirements(`두 값이 겹치는지 판정합니다.`);",
        "  ensure((args, retval) => typeof retval === 'boolean');",
        "}",
        "",
      ].join("\n"),
    );
    const out: string[] = [];
    const err: string[] = [];
    // A backend that would explode if called — proving --dry-run never calls it.
    const backend = new FakeBackend(() => {
      throw new Error("backend must not be called for --dry-run");
    });
    const code = await run(
      ["realize", "--dry-run", file],
      { out: (m) => out.push(m), err: (m) => err.push(m) },
      { makeBackend: () => backend },
    );
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("===== realize prompt: 충돌판정_2D =====");
    expect(printed).toContain("두 값이 겹치는지 판정합니다.");
    expect(printed).toContain("===FILE:");
    expect(backend.prompts).toEqual([]);
  });

  it("realize emits the realization layout via an injected fake backend (exit 0)", async () => {
    const file = writeChzFixture(
      "collide.chz.ts",
      [
        "imagine function collide(a: number, b: number): boolean {",
        "  ensure((args, retval) => typeof retval === 'boolean');",
        "}",
        "",
      ].join("\n"),
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["realize", "--model", "test-model", file],
      { out: (m) => out.push(m), err: (m) => err.push(m) },
      { makeBackend: (opts) => new FakeBackend(() => fakeResponse("collide"), opts.model ?? "?") },
    );

    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("realized 1 imagine function");
    expect(printed).toContain("model: test-model");
    expect(printed).toContain(`implementations/collide.ts`);
    // Step 4 hand-off reminder on stderr.
    expect(err.join("\n")).toContain("tests not yet run (Step 4)");

    // Files landed on disk next to the source under chz/realization/collide.
    const baseDir = join(file, "..", "chz", "realization", "collide");
    expect(existsSync(join(baseDir, "implementation.ts"))).toBe(true);
    expect(existsSync(join(baseDir, "implementations", "collide.ts"))).toBe(true);
    expect(existsSync(join(baseDir, "tests", "test_collide.autogen.ts"))).toBe(true);
    const ensureFile = join(baseDir, "tests", "test_collide.ensure.ts");
    expect(readFileSync(ensureFile, "utf8")).toContain(
      "(args, retval) => typeof retval === 'boolean',",
    );
  });

  it("realize reports a read error for a missing file (exit 1)", async () => {
    const err: string[] = [];
    const code = await run(["realize", "does-not-exist.chz.ts"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("cannot read file");
    expect(err.join("\n")).toContain("does-not-exist.chz.ts");
  });

  it("realize without a file reports the missing argument (exit 1)", async () => {
    const err: string[] = [];
    const code = await run(["realize"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("missing <file>");
  });

  it("realize rejects an unknown option (exit 1)", async () => {
    const err: string[] = [];
    const code = await run(["realize", "--nope", "x.chz.ts"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown option '--nope'");
  });
});
