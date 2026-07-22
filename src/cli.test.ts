import { describe, expect, it } from "vitest";

import { BIN_NAME, buildUsage, run } from "./cli.ts";

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

  it("realize with a file is not implemented yet (exit 1)", () => {
    const err: string[] = [];
    const code = run(["realize", "foo.chz.ts"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not implemented yet");
    expect(err.join("\n")).toContain("foo.chz.ts");
  });

  it("realize without a file reports the missing argument (exit 1)", () => {
    const err: string[] = [];
    const code = run(["realize"], { out: () => {}, err: (m) => err.push(m) });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("missing <file>");
  });
});
