import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BIN_NAME, buildUsage, run } from "./cli.ts";

/** Write `source` to a temp `.chz.ts` file and return its path. */
const tempDirs: string[] = [];
function writeChzFixture(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chz-cli-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, source, "utf8");
  return file;
}

afterAll(() => {
  // Temp fixtures live under the OS temp dir; the OS reclaims them. Nothing to
  // clean up eagerly, but keep the array referenced for clarity.
  tempDirs.length = 0;
});

describe("buildUsage", () => {
  it("names the binary and lists the realize command", () => {
    const usage = buildUsage();
    expect(usage).toContain(`usage: ${BIN_NAME} <command>`);
    expect(usage).toContain("realize");
    expect(usage).toContain("--help");
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

  it("realize summarizes the extracted specs, then reports the engine is unimplemented (exit 1)", () => {
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
    const code = run(["realize", file], { out: (m) => out.push(m), err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("found 1 imagine function");
    expect(out.join("\n")).toContain("충돌판정_2D");
    expect(err.join("\n")).toContain("not implemented yet");
  });

  it("realize --json prints the extracted specs as JSON", () => {
    const file = writeChzFixture(
      "j.chz.ts",
      "imagine function greet(name: string): string {\n  ensure(`인사말을 반환합니다.`);\n}\n",
    );
    const out: string[] = [];
    const code = run(["realize", "--json", file], { out: (m) => out.push(m), err: () => {} });
    expect(code).toBe(1);
    const specs = JSON.parse(out.join("\n"));
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe("greet");
    expect(specs[0].ensures[0].kind).toBe("natural");
  });

  it("realize reports a read error for a missing file (exit 1)", () => {
    const err: string[] = [];
    const code = run(["realize", "does-not-exist.chz.ts"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("cannot read file");
    expect(err.join("\n")).toContain("does-not-exist.chz.ts");
  });

  it("realize without a file reports the missing argument (exit 1)", () => {
    const err: string[] = [];
    const code = run(["realize"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("missing <file>");
  });
});
