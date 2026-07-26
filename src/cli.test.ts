import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BIN_NAME, buildUsage, run } from "./cli.ts";
import type { ChzDiagnostic } from "./compiler/index.ts";
import type {
  ChzImagineSymbol,
  ChzImagineSymbolResolution,
  ChzRealizeContext,
  ChzRealizer,
} from "./realize.ts";
import type { RealizationTestOutcome } from "./verify.ts";

const roots: string[] = [];
function makeFixture(name = "demo.chz.ts"): string {
  const root = mkdtempSync(join(tmpdir(), "chz-cli-"));
  roots.push(root);
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    "imagine function greet(name: string): string {\n  ensure(greet('Cheese') === 'Cheese', '이름을 포함합니다.');\n}\n",
    "utf8",
  );
  return file;
}

function makeClassFixture(name = "game.chz.ts"): string {
  const root = mkdtempSync(join(tmpdir(), "chz-cli-class-"));
  roots.push(root);
  const file = join(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      "imagine class Game {",
      "  requirements(`테스트 가능한 게임을 구현합니다.`);",
      "  imagine async start(): Promise<void> {}",
      "  imagine async cleanup(): Promise<void> { requirements(`리소스를 정리합니다.`); }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function makeFatalIslandFixture(name = "fatal-island.chz.ts"): string {
  const root = mkdtempSync(join(tmpdir(), "chz-cli-fatal-"));
  roots.push(root);
  const file = join(root, name);
  writeFileSync(
    file,
    [
      "imagine class Counter {",
      "  ensure(value === );",
      "  imagine readonly score: number {",
      "    requirements(limit);",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function makeSemanticFatalFixture(name = "semantic-fatal.chz.ts"): string {
  const root = mkdtempSync(join(tmpdir(), "chz-cli-semantic-fatal-"));
  roots.push(root);
  const file = join(root, name);
  writeFileSync(
    file,
    [
      "imagine class Game {}",
      "const game = new Game();",
      "game.start();",
      "const human = { value: 1 };",
      "human.missing();",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class CliRealizer implements ChzRealizer {
  readonly name = "CliRealizer";
  readonly supportedSymbolTypes = ["function"] as const;
  calls = 0;

  constructor(private readonly reasoning?: string) {}

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    this.calls++;
    if (this.reasoning !== undefined) {
      context.harness?.onEvent?.({ kind: "reasoning", text: this.reasoning });
    }
    const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
    const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dirname(implementation), { recursive: true });
    await mkdir(dirname(test), { recursive: true });
    await writeFile(implementation, `export function ${symbol.name}(name: string): string { return name; }\n`);
    await writeFile(test, "export {};\n");
    return {
      outcome: "resolved",
      symbol,
      resolvedFile: implementation,
      resolvedTestFiles: [test],
      resolvedAt: new Date(),
      resolvedBy: "cli-test-model",
    };
  }
}

class TestRunningCliRealizer extends CliRealizer {
  override async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    const resolution = await super.realize(symbol, context);
    if (resolution.outcome === "resolved") {
      await context.harness?.runTests?.(resolution.resolvedTestFiles);
    }
    return resolution;
  }
}

class ClassCliRealizer implements ChzRealizer {
  readonly name = "ClassCliRealizer";
  readonly supportedSymbolTypes = ["class"] as const;
  calls = 0;

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    this.calls++;
    const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
    const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dirname(implementation), { recursive: true });
    await mkdir(dirname(test), { recursive: true });
    await writeFile(
      implementation,
      `export class ${symbol.name} { async start(): Promise<void> {} async cleanup(): Promise<void> {} }\n`,
    );
    await writeFile(test, "export {};\n");
    return {
      outcome: "resolved",
      symbol,
      resolvedFile: implementation,
      resolvedTestFiles: [test],
      resolvedAt: new Date(),
      resolvedBy: "class-cli-test-model",
    };
  }
}

const greenTests = (): Promise<RealizationTestOutcome> =>
  Promise.resolve({
    passed: true,
    timedOut: false,
    output: "Tests  1 passed (1)",
    testFiles: [],
    testCount: 1,
  });

describe("usage and dispatch", () => {
  it("documents Realizer config and OpenAI-compatible flags", () => {
    const usage = buildUsage();
    expect(usage).toContain(`usage: ${BIN_NAME}`);
    expect(usage).toContain("chz.config.js");
    expect(usage).toContain("--base-url");
  });

  it("prints help and rejects unknown commands", () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(run([], { out: (message) => out.push(message), err: (message) => err.push(message) })).toBe(0);
    expect(out.join("\n")).toContain("usage:");
    expect(run(["wat"], { out: () => {}, err: (message) => err.push(message) })).toBe(1);
    expect(err.join("\n")).toContain("unknown command 'wat'");
  });
});

describe("realize command", () => {
  it("prints JSON without loading a model or config", async () => {
    const file = makeFixture();
    const out: string[] = [];
    const code = await run(["realize", "--json", file], {
      out: (message) => out.push(message),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))[0].name).toBe("greet");
  });

  it("uses injected Realizers and writes a green cache", async () => {
    const file = makeFixture();
    const realizer = new CliRealizer();
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["realize", file],
      { out: (message) => out.push(message), err: (message) => err.push(message) },
      {
        config: { realizers: [realizer], maxRetries: 1 },
        projectRoot: dirname(file),
        runTests: greenTests,
        chzVersion: "9.9.9",
        now: () => new Date("2026-07-23T00:00:00.000Z"),
      },
    );
    expect(code).toBe(0);
    expect(realizer.calls).toBe(1);
    // stderr carries only the progress stream, no errors.
    expect(err.every((line) => line.startsWith("[chz-realize]"))).toBe(true);
    expect(err.join("\n")).toContain("[ OK ] greet");
    const baseDir = join(dirname(file), "chz", "realization", "demo");
    expect(existsSync(join(baseDir, "implementations", "greet.ts"))).toBe(true);
    const cache = JSON.parse(readFileSync(join(baseDir, "realization-cache.json"), "utf8"));
    expect(cache.chzVersion).toBe("9.9.9");
    expect(cache.symbols.greet.model).toBe("cli-test-model");
    expect(out.join("\n")).toContain("1 tests passed");
  });

  it("realizes an imagine class through the CLI as a class symbol", async () => {
    const file = makeClassFixture();
    const realizer = new ClassCliRealizer();
    const out: string[] = [];
    const err: string[] = [];

    const code = await run(
      ["realize", file],
      { out: (message) => out.push(message), err: (message) => err.push(message) },
      {
        config: { realizers: [realizer] },
        projectRoot: dirname(file),
        runTests: greenTests,
        now: () => new Date("2026-07-23T00:00:00.000Z"),
      },
    );

    expect(code).toBe(0);
    expect(err.every((line) => line.startsWith("[chz-realize]"))).toBe(true);
    expect(realizer.calls).toBe(1);
    const baseDir = join(dirname(file), "chz", "realization", "game");
    expect(readFileSync(join(baseDir, "implementations", "Game.ts"), "utf8"))
      .toContain("realization of `imagine class Game`");
    expect(out.join("\n")).toContain("realized 1 symbol");
  });

  it("routes provider reasoning diagnostics to stderr", async () => {
    const file = makeFixture();
    const realizer = new CliRealizer("private reasoning");
    const out: string[] = [];
    const err: string[] = [];

    const code = await run(
      ["realize", file],
      { out: (message) => out.push(message), err: (message) => err.push(message) },
      {
        config: { realizers: [realizer] },
        projectRoot: dirname(file),
        runTests: greenTests,
      },
    );

    expect(code).toBe(0);
    // The audit renderer indents reasoning under a per-realizer header.
    expect(err).toContain("    private reasoning");
    expect(out.join("\n")).not.toContain("private reasoning");
  });

  it("keeps only group results on stderr with --simplify-output off a TTY", async () => {
    const file = makeFixture();
    const realizer = new CliRealizer("noisy reasoning");
    const out: string[] = [];
    const err: string[] = [];

    const code = await run(
      ["realize", file, "-s"],
      { out: (message) => out.push(message), err: (message) => err.push(message) },
      {
        config: { realizers: [realizer] },
        projectRoot: dirname(file),
        runTests: greenTests,
      },
    );

    expect(code).toBe(0);
    expect(err).toEqual(["[chz-realize] [1/1] [ OK ] greet"]);
    expect(out.join("\n")).toContain("realized 1 symbol");
  });

  it("forwards selected test files, scopes symbol verification, and runs an unscoped final pass", async () => {
    const file = makeFixture();
    const calls: Array<{ baseDir: string; testFiles: readonly string[] }> = [];
    const runTests = async (
      baseDir: string,
      testFiles: readonly string[],
    ): Promise<RealizationTestOutcome> => {
      calls.push({ baseDir, testFiles: [...testFiles] });
      return {
        passed: true,
        timedOut: false,
        output: "Tests  1 passed (1)",
        testFiles: [...testFiles],
        testCount: 1,
      };
    };

    const code = await run(
      ["realize", file],
      { out: () => {}, err: () => {} },
      {
        config: { realizers: [new TestRunningCliRealizer()] },
        projectRoot: dirname(file),
        runTests,
      },
    );

    const baseDir = join(dirname(file), "chz", "realization", "demo");
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        baseDir,
        testFiles: [join(baseDir, "tests", "test_greet.autogen.ts")],
      },
      {
        // Independent symbol verification narrows the empty list to the scope.
        baseDir,
        testFiles: [
          join(baseDir, "tests", "test_greet.autogen.ts"),
          join(baseDir, "tests", "test_greet.ensure.ts"),
        ],
      },
      // The whole-realization pass stays unscoped: empty means every test.
      { baseDir, testFiles: [] },
    ]);
  });

  it("loads chz.config.js and selects its Realizer", async () => {
    const file = makeFixture("nested/demo.chz.ts");
    const root = dirname(dirname(file));
    writeFileSync(
      join(root, "chz.config.js"),
      `import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export default {
  maxTurns: 4,
  realizers: [{
    name: "ConfigRealizer",
    supportedSymbolTypes: ["function"],
    async realize(symbol, context) {
      const implementation = join(context.outputDir, "implementations", symbol.name + ".ts");
      const test = join(context.outputDir, "tests", "test_" + symbol.name + ".autogen.ts");
      await mkdir(dirname(implementation), { recursive: true });
      await mkdir(dirname(test), { recursive: true });
      await writeFile(implementation, "export function greet(name: string): string { return name; }\\n");
      await writeFile(test, "export {};\\n");
      return { outcome: "resolved", symbol, resolvedFile: implementation, resolvedTestFiles: [test], resolvedAt: new Date(), resolvedBy: "config-model" };
    }
  }]
};
`,
      "utf8",
    );
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(
      ["realize", file],
      { out: (message) => out.push(message), err: (message) => err.push(message) },
      { runTests: greenTests },
    );
    expect(code).toBe(0);
    expect(err.join("\n")).toContain(`config: ${join(root, "chz.config.js")}`);
    const cache = JSON.parse(
      readFileSync(join(dirname(file), "chz", "realization", "demo", "realization-cache.json"), "utf8"),
    );
    expect(cache.symbols.greet.model).toBe("config-model");
  });

  it("realizes every 'include' match when no file argument is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-cli-include-"));
    roots.push(root);
    for (const name of ["alpha", "beta"]) {
      const file = join(root, "src", `${name}.chz.ts`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `imagine function ${name}(input: string): string {\n  requirements(\`${name}를 계산합니다.\`);\n}\n`,
        "utf8",
      );
    }
    const realizer: ChzRealizer = {
      name: "IncludeRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
        const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(dirname(implementation), { recursive: true });
        await mkdir(dirname(test), { recursive: true });
        await writeFile(implementation, `export function ${symbol.name}(input: string): string { return input; }\n`);
        await writeFile(test, "export {};\n");
        return {
          outcome: "resolved",
          symbol,
          resolvedFile: implementation,
          resolvedTestFiles: [test],
          resolvedAt: new Date(),
          resolvedBy: "include-model",
        };
      },
    };

    const out: string[] = [];
    const code = await run(
      ["realize"],
      { out: (message) => out.push(message), err: () => {} },
      {
        config: { realizers: [realizer], include: ["src/*.chz.ts"] },
        projectRoot: root,
        runTests: greenTests,
      },
    );

    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("alpha.chz.ts: realized 1 symbol");
    expect(printed).toContain("beta.chz.ts: realized 1 symbol");
    expect(existsSync(join(root, "src", "chz", "realization", "alpha", "implementations", "alpha.ts"))).toBe(true);
    expect(existsSync(join(root, "src", "chz", "realization", "beta", "implementations", "beta.ts"))).toBe(true);
  });

  it("rejects the file-less form when the configuration has no include globs", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-cli-noinc-"));
    roots.push(root);
    const err: string[] = [];
    const code = await run(
      ["realize"],
      { out: () => {}, err: (message) => err.push(message) },
      { config: { realizers: [new CliRealizer()] }, projectRoot: root },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("declares no 'include' globs");
  });

  it("rejects a non-positive --jobs value and accepts the attached -jN form", async () => {
    const err: string[] = [];
    expect(
      await run(
        ["realize", makeFixture(), "-j", "0"],
        { out: () => {}, err: (message) => err.push(message) },
        { config: { realizers: [new CliRealizer()] }, runTests: greenTests },
      ),
    ).toBe(1);
    expect(err.join("\n")).toContain("--jobs requires a positive integer");

    const file = makeFixture();
    expect(
      await run(
        ["realize", file, "-j2"],
        { out: () => {}, err: () => {} },
        { config: { realizers: [new CliRealizer()] }, projectRoot: dirname(file), runTests: greenTests },
      ),
    ).toBe(0);
  });

  it("dry-run prints canonical harness prompt without invoking the Realizer", async () => {
    const file = makeFixture();
    const realizer = new CliRealizer();
    const out: string[] = [];
    const code = await run(
      ["realize", "--dry-run", file],
      { out: (message) => out.push(message), err: () => {} },
      { config: { realizers: [realizer] }, projectRoot: dirname(file) },
    );
    expect(code).toBe(0);
    expect(realizer.calls).toBe(0);
    expect(out.join("\n")).toContain("You are the Cheese Realizer");
    expect(out.join("\n")).toContain("# Symbol to realize");
  });

  it("creates no realization directory or file when source preflight is fatal", async () => {
    const file = makeFatalIslandFixture();
    const code = await run(
      ["realize", file],
      { out: () => {}, err: () => {} },
      {
        config: { realizers: [new ClassCliRealizer()] },
        projectRoot: dirname(file),
      },
    );

    expect(code).toBe(1);
    expect(existsSync(join(dirname(file), "chz"))).toBe(false);
  });

  it("starts no Realizer session when source preflight is fatal", async () => {
    const file = makeFatalIslandFixture();
    const realizer = new ClassCliRealizer();
    const code = await run(
      ["realize", file],
      { out: () => {}, err: () => {} },
      {
        config: { realizers: [realizer] },
        projectRoot: dirname(file),
      },
    );

    expect(code).toBe(1);
    expect(realizer.calls).toBe(0);
  });

  it("reports the same complete diagnostics in JSON, dry-run, and realize paths", async () => {
    const file = makeFatalIslandFixture();
    const jsonOut: string[] = [];
    const dryRunErr: string[] = [];
    const realizeErr: string[] = [];
    const realizer = new ClassCliRealizer();

    const jsonCode = await run(
      ["realize", "--json", file],
      { out: (message) => jsonOut.push(message), err: () => {} },
    );
    const dryRunCode = await run(
      ["realize", "--dry-run", file],
      { out: () => {}, err: (message) => dryRunErr.push(message) },
      { config: { realizers: [realizer] }, projectRoot: dirname(file) },
    );
    const realizeCode = await run(
      ["realize", file],
      { out: () => {}, err: (message) => realizeErr.push(message) },
      { config: { realizers: [realizer] }, projectRoot: dirname(file) },
    );

    const diagnostics = JSON.parse(jsonOut.join("\n")) as ChzDiagnostic[];
    const humanDiagnostics = diagnostics.map(
      (diagnostic) =>
        `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
    );
    expect([jsonCode, dryRunCode, realizeCode]).toEqual([1, 1, 1]);
    expect(diagnostics.map((diagnostic) => diagnostic.code))
      .toEqual(["CHZ1003", "CHZ2001"]);
    expect(dryRunErr).toEqual(humanDiagnostics);
    expect(realizeErr).toEqual(humanDiagnostics);
    expect(realizer.calls).toBe(0);
  });

  it("maps class-contract and property-contract island diagnostics to exact original positions", async () => {
    const file = makeFatalIslandFixture();
    const out: string[] = [];
    const code = await run(
      ["realize", "--json", file],
      { out: (message) => out.push(message), err: () => {} },
    );

    const diagnostics = JSON.parse(out.join("\n")) as ChzDiagnostic[];
    expect(code).toBe(1);
    expect(
      diagnostics.map(({ code: diagnosticCode, offset, line, column }) => ({
        code: diagnosticCode,
        offset,
        line,
        column,
      })),
    ).toEqual([
      { code: "CHZ1003", offset: 43, line: 2, column: 20 },
      { code: "CHZ2001", offset: 98, line: 4, column: 18 },
    ]);
  });

  it("shares semantic diagnostics across JSON, dry-run, and realize without writes or sessions", async () => {
    const file = makeSemanticFatalFixture();
    const jsonOut: string[] = [];
    const dryRunErr: string[] = [];
    const realizeErr: string[] = [];
    const realizer = new ClassCliRealizer();

    const jsonCode = await run(
      ["realize", "--json", file],
      { out: (message) => jsonOut.push(message), err: () => {} },
    );
    const dryRunCode = await run(
      ["realize", "--dry-run", file],
      { out: () => {}, err: (message) => dryRunErr.push(message) },
      { config: { realizers: [realizer] }, projectRoot: dirname(file) },
    );
    const realizeCode = await run(
      ["realize", file],
      { out: () => {}, err: (message) => realizeErr.push(message) },
      { config: { realizers: [realizer] }, projectRoot: dirname(file) },
    );

    const diagnostics = JSON.parse(jsonOut.join("\n")) as ChzDiagnostic[];
    const rendered = diagnostics.map(
      (diagnostic) =>
        `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
    );
    expect([jsonCode, dryRunCode, realizeCode]).toEqual([1, 1, 1]);
    expect(diagnostics).toMatchObject([
      {
        code: "TS2339",
        line: 5,
        column: 7,
      },
    ]);
    expect(dryRunErr).toEqual(rendered);
    expect(realizeErr).toEqual(rendered);
    expect(realizer.calls).toBe(0);
    expect(existsSync(join(dirname(file), "chz"))).toBe(false);
  });

  it("requires a configured model when no config exists", async () => {
    const file = makeFixture();
    const previous = process.env.OPENAI_MODEL;
    delete process.env.OPENAI_MODEL;
    const err: string[] = [];
    try {
      const code = await run(["realize", file], { out: () => {}, err: (message) => err.push(message) });
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("no OpenAI model was configured");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = previous;
    }
  });
});
