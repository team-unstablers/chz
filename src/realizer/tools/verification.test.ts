import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChzRealizeContext } from "../types.ts";
import { ChzVerificationToolRuntime } from "./verification.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "chz-verification-tools-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

function makeContext(
  harness: ChzRealizeContext["harness"] = undefined,
): { context: ChzRealizeContext; resolveOutputPath: (path: string) => string } {
  const projectRoot = makeTempDir();
  const outputDir = join(projectRoot, "output");
  mkdirSync(outputDir, { recursive: true });
  const context: ChzRealizeContext = {
    projectRoot,
    outputDir,
    activeProfile: "console",
    resolvedDependencies: [],
    maxTurns: 20,
    maxRetries: 3,
    baseContexts: "",
    harness,
  };
  const resolveOutputPath = (path: string): string => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
    const fromOutput = relative(outputDir, absolute);
    if (fromOutput === ".." || fromOutput.startsWith(`..${sep}`) || isAbsolute(fromOutput)) {
      throw new Error(
        `Write access denied: ${absolute} is outside the realization output directory (${outputDir}). Realized code and tests must be written there.`,
      );
    }
    return absolute;
  };
  return { context, resolveOutputPath };
}

function parseOutput(output: string | null): Record<string, unknown> {
  expect(output).not.toBeNull();
  return JSON.parse(output!) as Record<string, unknown>;
}

describe("ChzVerificationToolRuntime injected services", () => {
  it("uses the injected runners and passes only validated test file paths", async () => {
    const runTests = vi.fn(async (files: string[]) => ({ passed: true, output: files.join("|") }));
    const runTypeCheck = vi.fn(async () => ({ passed: false, output: "type red" }));
    const runLinter = vi.fn(async () => ({ passed: true, output: "lint green" }));
    const { context, resolveOutputPath } = makeContext({ runTests, runTypeCheck, runLinter });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    const tests = parseOutput(
      await runtime.execute("RunTests", { testFiles: ["output/tests/test_x.autogen.ts"] }),
    );
    expect(runTests).toHaveBeenCalledWith([join(context.outputDir, "tests/test_x.autogen.ts")]);
    expect(tests).toMatchObject({ passed: true });

    const typeCheck = parseOutput(await runtime.execute("RunTypeCheck", {}));
    const linter = parseOutput(await runtime.execute("RunLinter", {}));
    expect(runTypeCheck).toHaveBeenCalledOnce();
    expect(runLinter).toHaveBeenCalledOnce();
    expect(typeCheck).toMatchObject({ passed: false, output: "type red" });
    expect(linter).toMatchObject({ passed: true, output: "lint green" });
  });

  it("preserves the empty RunTests list as the whole-realization signal", async () => {
    const runTests = vi.fn(async (_files: string[]) => ({ passed: true, output: "all" }));
    const { context, resolveOutputPath } = makeContext({ runTests });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    await runtime.execute("RunTests", { testFiles: [] });

    expect(runTests).toHaveBeenCalledWith([]);
  });
});

describe("ChzVerificationToolRuntime input validation", () => {
  it("rejects malformed RunTests input with the canonical recovery hint", async () => {
    const runTests = vi.fn(async (_files: string[]) => ({ passed: true, output: "unused" }));
    const { context, resolveOutputPath } = makeContext({ runTests });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    await expect(runtime.execute("RunTests", { testFiles: "all" })).rejects.toThrow(
      "Invalid tool input: testFiles must be an array of strings. Please rewrite the input so it satisfies the expected schema.",
    );
    await expect(
      runtime.execute("RunTests", { testFiles: [], command: "vitest --watch" }),
    ).rejects.toThrow("Invalid tool input: unexpected field: command.");
    expect(runTests).not.toHaveBeenCalled();
  });

  it("rejects arguments for no-argument tools and never accepts a shell command", async () => {
    const runTypeCheck = vi.fn(async () => ({ passed: true, output: "unused" }));
    const { context, resolveOutputPath } = makeContext({ runTypeCheck });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    await expect(runtime.execute("RunTypeCheck", { command: "tsc --noEmit" })).rejects.toThrow(
      "Invalid tool input: unexpected field: command.",
    );
    expect(runTypeCheck).not.toHaveBeenCalled();
  });

  it("applies the output boundary to every selected test file", async () => {
    const runTests = vi.fn(async (_files: string[]) => ({ passed: true, output: "unused" }));
    const { context, resolveOutputPath } = makeContext({ runTests });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    await expect(runtime.execute("RunTests", { testFiles: ["outside.ts"] })).rejects.toThrow(
      "outside the realization output directory",
    );
    expect(runTests).not.toHaveBeenCalled();
  });

  it("returns null for tools owned by another runtime", async () => {
    const { context, resolveOutputPath } = makeContext();
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);
    await expect(runtime.execute("ReadFile", "not even an object")).resolves.toBeNull();
  });
});

describe("ChzVerificationToolRuntime default type checker", () => {
  it("checks every TypeScript file with strict and noEmit compiler options", async () => {
    const { context, resolveOutputPath } = makeContext();
    writeTree(context.outputDir, {
      "implementations/green.ts": "export const count: number = 1;\n",
      "implementations/red.ts": 'export const count: number = "one";\n',
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    const result = parseOutput(await runtime.execute("RunTypeCheck", {}));
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;

    expect(result.passed).toBe(false);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TS2322", severity: "error" }),
      ]),
    );
    expect(diagnostics.some((item) => String(item.file).endsWith("red.ts"))).toBe(true);
  });

  it("returns a structured green result for an empty or valid output directory", async () => {
    const { context, resolveOutputPath } = makeContext();
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);
    expect(parseOutput(await runtime.execute("RunTypeCheck", {}))).toEqual({
      passed: true,
      diagnostics: [],
    });

    writeTree(context.outputDir, {
      "implementations/value.ts": "export function value(input: unknown): boolean { return input !== null; }\n",
    });
    expect(parseOutput(await runtime.execute("RunTypeCheck", {}))).toEqual({
      passed: true,
      diagnostics: [],
    });
  });

  it("loads Node globals for the console profile", async () => {
    const { context, resolveOutputPath } = makeContext();
    writeTree(context.outputDir, {
      "implementations/__epilogue__.ts": 'console.log("ready");\n',
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    expect(parseOutput(await runtime.execute("RunTypeCheck", {}))).toEqual({
      passed: true,
      diagnostics: [],
    });
  });
});

describe("ChzVerificationToolRuntime default restricted-subset linter", () => {
  it("reports eval, explicit any, and __epilogue__ imports from the TypeScript AST", async () => {
    const { context, resolveOutputPath } = makeContext();
    writeTree(context.outputDir, {
      "implementations/red.ts": [
        'import { humanValue } from "../__epilogue__.ts";',
        "export function unsafe(value: any): unknown {",
        '  return eval("value") ?? humanValue;',
        "}",
        "",
      ].join("\n"),
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    const result = parseOutput(await runtime.execute("RunLinter", {}));
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    const codes = diagnostics.map((item) => item.code);

    expect(result.passed).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining(["no-eval", "no-explicit-any", "no-epilogue-import"]),
    );
    expect(diagnostics.every((item) => item.severity === "error")).toBe(true);
  });

  it("accepts code in the minimum restricted subset", async () => {
    const { context, resolveOutputPath } = makeContext();
    writeTree(context.outputDir, {
      "implementations/green.ts": [
        "export function display(value: unknown): string {",
        '  return typeof value === "string" ? value : String(value);',
        "}",
        "",
      ].join("\n"),
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    expect(parseOutput(await runtime.execute("RunLinter", {}))).toEqual({
      passed: true,
      diagnostics: [],
    });
  });

  it("enforces the console profile network capability boundary", async () => {
    const { context, resolveOutputPath } = makeContext();
    writeTree(context.outputDir, {
      "implementations/network.ts": [
        'import { connect } from "node:net";',
        'const https = require("node:https");',
        'export async function network(): Promise<void> {',
        '  connect(80, "example.com");',
        '  await fetch("https://example.com");',
        '  await globalThis.fetch("https://example.com");',
        '  new WebSocket("wss://example.com");',
        '  new globalThis.WebSocket("wss://example.com");',
        '  https.get("https://example.com");',
        '}',
        "",
      ].join("\n"),
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    const result = parseOutput(await runtime.execute("RunLinter", {}));
    const diagnostics = result.diagnostics as Array<Record<string, unknown>>;
    expect(result.passed).toBe(false);
    expect(diagnostics.filter((item) => item.code === "profile-console")).toHaveLength(6);
  });

  it("does not apply the console network boundary to another profile", async () => {
    const { context, resolveOutputPath } = makeContext();
    context.activeProfile = "server";
    writeTree(context.outputDir, {
      "implementations/network.ts": [
        'import { connect } from "node:net";',
        'export function network(): void { connect(80, "example.com"); fetch("https://example.com"); }',
        "",
      ].join("\n"),
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    expect(parseOutput(await runtime.execute("RunLinter", {}))).toEqual({
      passed: true,
      diagnostics: [],
    });
  });
});

describe("ChzVerificationToolRuntime verification scope", () => {
  it("judges a scoped session only on its own files, never the epilogue or later symbols", async () => {
    const { context, resolveOutputPath } = makeContext();
    writeTree(context.outputDir, {
      "implementations/__prologue__.ts": "export type Title = string;\n",
      "implementations/slugify.ts": [
        'import type { Title } from "./__prologue__.ts";',
        "export function slugify(input: Title): string { return input.toLowerCase(); }",
        "",
      ].join("\n"),
      "tests/test_slugify.autogen.ts": [
        'import { slugify } from "../implementations/slugify.ts";',
        'export const checked: string = slugify("A");',
        "",
      ].join("\n"),
      // Human wiring already references the not-yet-realized second symbol.
      "implementations/__epilogue__.ts": [
        'import { buildUniqueSlugs } from "./buildUniqueSlugs.ts";',
        "console.log(buildUniqueSlugs([]));",
        "",
      ].join("\n"),
    });
    context.scope = { symbolNames: ["slugify"] };
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    expect(parseOutput(await runtime.execute("RunTypeCheck", {}))).toEqual({
      passed: true,
      diagnostics: [],
    });

    // The unscoped final pass still surfaces the dangling epilogue import.
    context.scope = undefined;
    const finalResult = parseOutput(await runtime.execute("RunTypeCheck", {}));
    expect(finalResult.passed).toBe(false);
  });

  it("exempts engine-owned and human-owned files from the restricted-subset linter", async () => {
    const { context, resolveOutputPath } = makeContext();
    writeTree(context.outputDir, {
      // The engine-owned entry point legitimately imports the epilogue.
      "implementation.ts": 'import "./implementations/__epilogue__.ts";\n',
      // Human layers may use full TypeScript, including explicit any.
      "implementations/__prologue__.ts": "export const config: any = {};\n",
      "implementations/__epilogue__.ts": "export const wired: any = true;\n",
      "tests/test_greet.ensure.ts": "export const harnessValue: any = null;\n",
      "implementations/greet.ts": "export function greet(name: string): string { return name; }\n",
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    expect(parseOutput(await runtime.execute("RunLinter", {}))).toEqual({
      passed: true,
      diagnostics: [],
    });
  });

  it("substitutes the session scope for an empty RunTests list and demands autogen tests first", async () => {
    const runTests = vi.fn(async (files: string[]) => ({ passed: true, output: files.join("|") }));
    const { context, resolveOutputPath } = makeContext({ runTests });
    context.scope = { symbolNames: ["greet"] };
    writeTree(context.outputDir, {
      "tests/test_greet.ensure.ts": "export {};\n",
    });
    const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

    // No autogen test yet: a red result with a recovery hint, nothing runs.
    const missing = parseOutput(await runtime.execute("RunTests", { testFiles: [] }));
    expect(missing.passed).toBe(false);
    expect(String(missing.output)).toContain("tests/test_greet.autogen.ts");
    expect(runTests).not.toHaveBeenCalled();

    writeTree(context.outputDir, { "tests/test_greet.autogen.ts": "export {};\n" });
    const substituted = parseOutput(await runtime.execute("RunTests", { testFiles: [] }));
    expect(substituted).toMatchObject({ passed: true });
    expect(runTests).toHaveBeenCalledWith([
      join(context.outputDir, "tests", "test_greet.autogen.ts"),
      join(context.outputDir, "tests", "test_greet.ensure.ts"),
    ]);
  });
});

describe("ChzVerificationToolRuntime default test runner", () => {
  it(
    "runs only selected tests and uses an empty list for the complete realization suite",
    async () => {
      const { context, resolveOutputPath } = makeContext();
      writeTree(context.outputDir, {
        "tests/test_green.autogen.ts": [
          'import { expect, it } from "vitest";',
          'it("green", () => expect(1).toBe(1));',
          "",
        ].join("\n"),
        "tests/test_red.autogen.ts": [
          'import { expect, it } from "vitest";',
          'it("red", () => expect(1).toBe(2));',
          "",
        ].join("\n"),
      });
      const runtime = new ChzVerificationToolRuntime(context, resolveOutputPath);

      const selected = parseOutput(
        await runtime.execute("RunTests", {
          testFiles: ["output/tests/test_green.autogen.ts"],
        }),
      );
      const complete = parseOutput(await runtime.execute("RunTests", { testFiles: [] }));

      expect(selected.passed).toBe(true);
      expect(selected.testFiles).toEqual([join(context.outputDir, "tests/test_green.autogen.ts")]);
      expect(complete.passed).toBe(false);
      expect(complete.testFiles).toHaveLength(2);
    },
    60_000,
  );
});
