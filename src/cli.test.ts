import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BIN_NAME, buildUsage, run } from "./cli.ts";
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
      "  imagine async start() {}",
      "  imagine async cleanup() { requirements(`리소스를 정리합니다.`); }",
      "}",
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
    if (this.reasoning !== undefined) context.harness?.onModelReasoning?.(this.reasoning);
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
    expect(err).toEqual([]);
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
    expect(err).toEqual([]);
    expect(realizer.calls).toBe(1);
    const baseDir = join(dirname(file), "chz", "realization", "game");
    expect(readFileSync(join(baseDir, "implementations", "Game.ts"), "utf8"))
      .toContain("realization of `imagine class Game`");
    expect(out.join("\n")).toContain("realized 1 symbol");
  });

  it("routes provider reasoning diagnostics to stderr", async () => {
    const file = makeFixture();
    const realizer = new CliRealizer("[CliRealizer] reasoning turn 1/1\nprivate reasoning");
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
    expect(err).toContain("[CliRealizer] reasoning turn 1/1\nprivate reasoning");
    expect(out.join("\n")).not.toContain("private reasoning");
  });

  it("forwards selected test files from the Realizer and uses an empty list for final verification", async () => {
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
    const code = await run(
      ["realize", file],
      { out: (message) => out.push(message), err: () => {} },
      { runTests: greenTests },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`config: ${join(root, "chz.config.js")}`);
    const cache = JSON.parse(
      readFileSync(join(dirname(file), "chz", "realization", "demo", "realization-cache.json"), "utf8"),
    );
    expect(cache.symbols.greet.model).toBe("config-model");
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
