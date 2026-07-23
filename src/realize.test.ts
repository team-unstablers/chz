import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractImagineSpecs } from "./preprocessor.ts";
import { buildRealizationCache, writeRealizationCache } from "./verify.ts";
import {
  CHZ_HARNESS_TOOLS,
  CHZ_REALIZER_SYSTEM,
  ChzRealizerBase,
  buildEstimatedRealizeOrder,
  buildSessionBaseline,
  imagineSpecToSymbol,
  realize,
  renderEnsureHarness,
  renderEntryPoint,
  type ChzChatMessage,
  type ChzChatResponse,
  type ChzImagineSymbol,
  type ChzImagineSymbolResolution,
  type ChzRealizeContext,
  type ChzRealizer,
  type ChzToolDefinition,
} from "./realize.ts";

const roots: string[] = [];
function fixture(): { root: string; sourceFile: string; outputDir: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "chz-realizer-base-"));
  roots.push(root);
  const sourceFile = join(root, "sample.chz.ts");
  const outputDir = join(root, "chz", "realization", "sample");
  const source = [
    "imagine function greet(name: string): string {",
    "  requirements(`인사말을 만듭니다.`);",
    "  ensure(greet('Cheese') === 'Hi Cheese', '이름을 포함해야 합니다.');",
    "  ensure('문자열을 반환합니다.', () => {",
    "    assert(typeof greet('Cheese') === 'string');",
    "  });",
    "}",
    "",
  ].join("\n");
  writeFileSync(sourceFile, source, "utf8");
  return { root, sourceFile, outputDir, source };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function contextFor(root: string, outputDir: string): ChzRealizeContext {
  return {
    projectRoot: root,
    outputDir,
    activeProfile: "console",
    resolvedDependencies: [],
    maxTurns: 3,
    maxRetries: 2,
    baseContexts: "",
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
}

class ScriptedRealizer extends ChzRealizerBase {
  readonly name = "ScriptedRealizer";
  readonly seenMessages: ChzChatMessage[][] = [];
  readonly seenTools: ChzToolDefinition[][] = [];
  private readonly turns: Array<ChzChatResponse | Error>;

  constructor(turns: Array<ChzChatResponse | Error>, maxApiRetries = 0) {
    super({ model: "scripted-model", maxApiRetries, retryDelayMs: 0 });
    this.turns = [...turns];
  }

  protected async chat(
    messages: readonly ChzChatMessage[],
    tools: readonly ChzToolDefinition[],
  ): Promise<ChzChatResponse> {
    this.seenMessages.push([...messages]);
    this.seenTools.push([...tools]);
    const next = this.turns.shift();
    if (next === undefined) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

function response(toolCalls: ChzChatResponse["message"]["toolCalls"]): ChzChatResponse {
  return { message: { role: "assistant", content: "", toolCalls } };
}

describe("canonical prompt and symbol graph", () => {
  it("uses the canonical fixed prompt and deterministic baseline", () => {
    const data = fixture();
    const spec = extractImagineSpecs(data.source, data.sourceFile)[0]!;
    const symbol = imagineSpecToSymbol(spec, data.source, data.sourceFile);
    const context = contextFor(data.root, data.outputDir);
    const first = buildSessionBaseline(symbol, context, "gpt-test");
    const second = buildSessionBaseline(symbol, context, "gpt-test");

    expect(CHZ_REALIZER_SYSTEM).toContain("You are the Cheese Realizer");
    expect(CHZ_REALIZER_SYSTEM).toContain("a sequence of feedback-driven increments");
    expect(CHZ_REALIZER_SYSTEM).toContain("begin the first implementation increment in the first turn");
    expect(CHZ_REALIZER_SYSTEM).toContain("Do not read project files merely");
    expect(CHZ_REALIZER_SYSTEM).toContain("not mechanically one method per turn");
    expect(CHZ_REALIZER_SYSTEM).not.toContain("Before the first write, inspect");
    expect(CHZ_REALIZER_SYSTEM).toContain("Every session ends with exactly one of Finish, Block, or Abort.");
    expect(first).toBe(second);
    expect(first).toContain("Project root (read boundary)");
    expect(first).toContain(spec.originalText);
    expect(first).toContain("Today's date: 2026-07-23");
  });

  it("uses dependency surfaces before falling back to dependency file reads", () => {
    const data = fixture();
    const spec = extractImagineSpecs(data.source, data.sourceFile)[0]!;
    const symbol = imagineSpecToSymbol(spec, data.source, data.sourceFile);
    const dependencyFile = join(data.root, "chz", "realization", "dependency.ts");
    const dependencySymbol: ChzImagineSymbol = {
      ...symbol,
      name: "dependency",
      definition: "imagine function dependency(): number",
    };
    mkdirSync(dirname(dependencyFile), { recursive: true });
    writeFileSync(dependencyFile, "export function dependency(): number { return 1; }\n", "utf8");

    const baseline = buildSessionBaseline(symbol, {
      ...contextFor(data.root, data.outputDir),
      resolvedDependencies: [{
        outcome: "resolved",
        symbol: dependencySymbol,
        resolvedFile: dependencyFile,
        resolvedTestFiles: [],
        resolvedAt: new Date("2026-07-23T00:00:00.000Z"),
        resolvedBy: "test",
      }],
    }, "gpt-test");

    expect(baseline).toContain("Use the surfaces\nbelow as the default context");
    expect(baseline).toContain("only when a specific\ndetail missing from its excerpt blocks");
    expect(baseline).not.toContain("Read their\nfiles for full details");
  });

  it("keeps the implemented fixed prompt byte-identical to the canonical document", () => {
    const document = readFileSync(
      new URL("../docs/64-realize-harness-prompt.ko.md", import.meta.url),
      "utf8",
    );
    const canonical = document.match(
      /# 파트 1: 고정부 — 정본 전문\n\n```text\n([\s\S]*?)\n```/,
    )?.[1];

    expect(canonical).toBe(CHZ_REALIZER_SYSTEM);
  });

  it("describes WriteFile as revisable incremental state", () => {
    const writeFile = CHZ_HARNESS_TOOLS.find((tool) => tool.name === "WriteFile");

    expect(writeFile?.description).toContain("for the current increment");
    expect(writeFile?.description).toContain("may be revised in later turns");
  });

  it("orders mentioned dependencies before dependents", () => {
    const source = [
      "imagine function leaf(): number { requirements(`leaf`); }",
      "imagine function parent(): number { requirements(`Use leaf to calculate.`); }",
    ].join("\n");
    const order = buildEstimatedRealizeOrder(extractImagineSpecs(source, "graph.chz.ts"), source, "graph.chz.ts");
    expect(order.map((symbol) => symbol.name)).toEqual(["leaf", "parent"]);
    expect(order[1]!.dependencies.map((symbol) => symbol.name)).toEqual(["leaf"]);
  });

  it("renders ensure harnesses independent of file position and checkout path", () => {
    const data = fixture();
    const shifted = `// a comment moving every symbol down one line\n\n${data.source}`;
    const specAtOrigin = extractImagineSpecs(data.source, data.sourceFile)[0]!;
    const specShifted = extractImagineSpecs(shifted, "/entirely/other/path/sample.chz.ts")[0]!;

    expect(specShifted.ensures[0]!.line).not.toBe(specAtOrigin.ensures[0]!.line);
    // Identical harness bytes: cache reuse must not break when an edit
    // elsewhere shifts the block, or when the repo lives at another path.
    expect(renderEnsureHarness(specShifted, "/entirely/other/path/sample.chz.ts", [specShifted]))
      .toBe(renderEnsureHarness(specAtOrigin, data.sourceFile, [specAtOrigin]));
  });

  it("imports external signature types into the engine-owned ensure harness", () => {
    const source =
      "imagine function inspect(value: Widget): Result { ensure(inspect({} as Widget) !== undefined); }\n";
    const spec = extractImagineSpecs(source, "types.chz.ts")[0]!;
    const harness = renderEnsureHarness(spec, "types.chz.ts");
    expect(harness).toContain('import type { Result, Widget } from "../implementations/__prologue__.ts";');
  });

  it("turns an imagine class into a class symbol and executable ensure tests", () => {
    const source = [
      "imagine class Counter {",
      "  imagine increment(by: number): number {",
      "    ensure('increment는 number를 반환합니다.', () => {",
      "      const counter = new Counter();",
      "      assert(typeof counter.increment(1) === 'number');",
      "    });",
      "  }",
      "}",
    ].join("\n");
    const spec = extractImagineSpecs(source, "counter.chz.ts")[0]!;
    const symbol = imagineSpecToSymbol(spec, source, "counter.chz.ts");
    const harness = renderEnsureHarness(spec, "counter.chz.ts");

    expect(symbol.type).toBe("class");
    expect(symbol.definition).toContain("imagine increment");
    expect(harness).toContain('import { Counter } from "../implementations/Counter.ts";');
    expect(harness).toContain("it('increment는 number를 반환합니다.'");
    expect(harness).toContain("typeof counter.increment(1) === 'number'");
    expect(harness).not.toContain("assertEnsures");
  });

  it("connects prologue, realized symbols, and epilogue in entry-point order", () => {
    const source = "imagine function greet(): string { ensure(greet() === '안녕'); }\n";
    const specs = extractImagineSpecs(source, "example.chz.ts");
    const entry = renderEntryPoint(specs, "example.chz.ts");

    expect(entry.indexOf('import "./implementations/__prologue__.ts";'))
      .toBeLessThan(entry.indexOf('export { greet } from "./implementations/greet.ts";'));
    expect(entry.indexOf('export { greet } from "./implementations/greet.ts";'))
      .toBeLessThan(entry.indexOf('import "./implementations/__epilogue__.ts";'));
  });
});

describe("ChzRealizerBase", () => {
  it("owns the tool loop and resolves files after Finish", async () => {
    const data = fixture();
    const events: string[] = [];
    const symbol = buildEstimatedRealizeOrder(
      extractImagineSpecs(data.source, data.sourceFile),
      data.source,
      data.sourceFile,
    )[0]!;
    const implementation = join(data.outputDir, "implementations", "greet.ts");
    const test = join(data.outputDir, "tests", "test_greet.autogen.ts");
    const realizer = new ScriptedRealizer([
      response([
        { id: "write-impl", name: "WriteFile", arguments: { path: implementation, content: "export function greet(name: string): string { return `Hi ${name}`; }\n" } },
        { id: "write-test", name: "WriteFile", arguments: { path: test, content: "export {};\n" } },
      ]),
      response([{ id: "finish", name: "Finish", arguments: {} }]),
    ]);

    const result = await realizer.realize(symbol, {
      ...contextFor(data.root, data.outputDir),
      maxTurns: 2,
      harness: { onEvent: (message) => events.push(message) },
    });

    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") throw new Error("expected resolved");
    expect(result.resolvedFile).toBe(implementation);
    expect(result.resolvedTestFiles).toContain(test);
    expect(readFileSync(implementation, "utf8")).toContain("function greet");
    expect(realizer.seenMessages[0]![0]).toEqual({ role: "system", content: CHZ_REALIZER_SYSTEM });
    expect(realizer.seenTools[0]!.map((tool) => tool.name)).toEqual(CHZ_HARNESS_TOOLS.map((tool) => tool.name));
    expect(realizer.seenTools[1]!.map((tool) => tool.name)).toEqual(["Finish", "Block", "Abort"]);
    expect(events[0]).toBe("[ScriptedRealizer] turn 1/2");
    expect(events.find((event) => event.includes("WriteFile(path=\"chz/realization/sample/implementations/greet.ts\"")))
      .toMatch(/size=\d+ B, lines=1\) → ok · \d+ms$/);
    expect(events).toContain("[ScriptedRealizer] turn 2/2");
    expect(events.at(-1)).toMatch(/^\[ScriptedRealizer\] Finish → finished · \d+ms$/);
    expect(events.join("\n")).not.toContain("return `Hi ${name}`");
  });

  it("logs verification outcomes without leaking diagnostic output", async () => {
    const data = fixture();
    const events: string[] = [];
    const symbol = buildEstimatedRealizeOrder(
      extractImagineSpecs(data.source, data.sourceFile),
      data.source,
      data.sourceFile,
    )[0]!;
    const implementation = join(data.outputDir, "implementations", "greet.ts");
    const test = join(data.outputDir, "tests", "test_greet.autogen.ts");
    mkdirSync(dirname(implementation), { recursive: true });
    mkdirSync(dirname(test), { recursive: true });
    writeFileSync(implementation, "export function greet(name: string): string { return name; }\n", "utf8");
    writeFileSync(test, "export {};\n", "utf8");
    const realizer = new ScriptedRealizer([
      response([{ id: "typecheck", name: "RunTypeCheck", arguments: {} }]),
      response([{ id: "finish", name: "Finish", arguments: {} }]),
    ]);

    const result = await realizer.realize(symbol, {
      ...contextFor(data.root, data.outputDir),
      maxTurns: 2,
      harness: {
        onEvent: (message) => events.push(message),
        runTypeCheck: async () => ({ passed: false, output: "private compiler diagnostic" }),
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(events).toContainEqual(expect.stringMatching(/^\[ScriptedRealizer\] RunTypeCheck → failed · \d+ms$/));
    expect(events.join("\n")).not.toContain("private compiler diagnostic");
  });

  it("retries provider failures in the base class", async () => {
    const data = fixture();
    const symbol = buildEstimatedRealizeOrder(extractImagineSpecs(data.source, data.sourceFile), data.source, data.sourceFile)[0]!;
    const implementation = join(data.outputDir, "implementations", "greet.ts");
    const test = join(data.outputDir, "tests", "test_greet.autogen.ts");
    mkdirSync(dirname(implementation), { recursive: true });
    mkdirSync(dirname(test), { recursive: true });
    writeFileSync(implementation, "export function greet(name: string): string { return name; }\n", "utf8");
    writeFileSync(test, "export {};\n", "utf8");
    const realizer = new ScriptedRealizer([
      new Error("temporary outage"),
      response([{ id: "finish", name: "Finish", arguments: {} }]),
    ], 1);
    const context = { ...contextFor(data.root, data.outputDir), maxTurns: 1 };

    expect((await realizer.realize(symbol, context)).outcome).toBe("resolved");
    expect(realizer.seenMessages).toHaveLength(2);
  });

  it("returns the three-way blocked/failed outcomes", async () => {
    const data = fixture();
    const symbol = buildEstimatedRealizeOrder(extractImagineSpecs(data.source, data.sourceFile), data.source, data.sourceFile)[0]!;
    const blocked = new ScriptedRealizer([
      response([{ id: "block", name: "Block", arguments: { reason: "dependency missing", todo: "npm install package" } }]),
    ]);
    const aborted = new ScriptedRealizer([
      response([{ id: "abort", name: "Abort", arguments: { reason: "requirements contradict" } }]),
    ]);
    const context = { ...contextFor(data.root, data.outputDir), maxTurns: 1 };

    const blockedResult = await blocked.realize(symbol, context);
    expect(blockedResult).toMatchObject({ outcome: "blocked", todo: "npm install package" });
    const failedResult = await aborted.realize(symbol, context);
    expect(failedResult).toMatchObject({ outcome: "failed", reason: "requirements contradict" });
  });

  it("does not mistake the engine-owned ensure harness for an LLM-authored test", async () => {
    const data = fixture();
    const symbol = buildEstimatedRealizeOrder(extractImagineSpecs(data.source, data.sourceFile), data.source, data.sourceFile)[0]!;
    const implementation = join(data.outputDir, "implementations", "greet.ts");
    const ensure = join(data.outputDir, "tests", "test_greet.ensure.ts");
    mkdirSync(dirname(implementation), { recursive: true });
    mkdirSync(dirname(ensure), { recursive: true });
    writeFileSync(implementation, "export function greet(name: string): string { return name; }\n", "utf8");
    writeFileSync(ensure, "export {};\n", "utf8");
    const realizer = new ScriptedRealizer([
      response([{ id: "finish", name: "Finish", arguments: {} }]),
    ]);

    const result = await realizer.realize(symbol, {
      ...contextFor(data.root, data.outputDir),
      maxTurns: 1,
    });

    expect(result).toMatchObject({ outcome: "failed" });
    if (result.outcome !== "failed") throw new Error("expected failed");
    expect(result.reason).toContain("required autogen test file");
  });

  it("does not accept an arbitrarily named test that independent verification will ignore", async () => {
    const data = fixture();
    const symbol = buildEstimatedRealizeOrder(
      extractImagineSpecs(data.source, data.sourceFile),
      data.source,
      data.sourceFile,
    )[0]!;
    const implementation = join(data.outputDir, "implementations", "greet.ts");
    const noncanonicalTest = join(data.outputDir, "tests", "greet.test.ts");
    mkdirSync(dirname(implementation), { recursive: true });
    mkdirSync(dirname(noncanonicalTest), { recursive: true });
    writeFileSync(implementation, "export function greet(name: string): string { return name; }\n", "utf8");
    writeFileSync(noncanonicalTest, "export {};\n", "utf8");
    const realizer = new ScriptedRealizer([
      response([{ id: "finish", name: "Finish", arguments: {} }]),
    ]);

    const result = await realizer.realize(symbol, {
      ...contextFor(data.root, data.outputDir),
      maxTurns: 1,
    });

    expect(result).toMatchObject({ outcome: "failed" });
    if (result.outcome !== "failed") throw new Error("expected failed");
    expect(result.reason).toContain("tests/test_greet.autogen.ts");
  });
});

class RetryingEngineRealizer implements ChzRealizer {
  readonly name = "RetryingEngineRealizer";
  readonly supportedSymbolTypes = ["function"] as const;
  readonly contexts: ChzRealizeContext[] = [];

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    this.contexts.push(context);
    const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
    const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
    mkdirSync(dirname(implementation), { recursive: true });
    mkdirSync(dirname(test), { recursive: true });
    writeFileSync(implementation, `export function ${symbol.name}(name: string): string { return name; }\n`, "utf8");
    writeFileSync(test, "export {};\n", "utf8");
    return {
      outcome: "resolved",
      symbol,
      resolvedFile: implementation,
      resolvedTestFiles: [test],
      resolvedAt: new Date(),
      resolvedBy: "engine-model",
    };
  }
}

class CounterClassRealizer implements ChzRealizer {
  readonly name = "CounterClassRealizer";
  readonly supportedSymbolTypes = ["class"] as const;

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
      [
        "export class Counter {",
        "  private value = 0;",
        "  increment(by: number): number { this.value += by; return this.value; }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      test,
      [
        "// @ts-expect-error The engine-owned Vitest runner provides this module for the temporary fixture.",
        'import { describe, expect, it } from "vitest";',
        'import { Counter } from "../implementations/Counter.ts";',
        "describe('Counter', () => {",
        "  it('increments', () => {",
        "    const counter = new Counter();",
        "    const retval = counter.increment(2);",
        "    expect(retval).toBe(2);",
        "  });",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    return {
      outcome: "resolved",
      symbol,
      resolvedFile: implementation,
      resolvedTestFiles: [test],
      resolvedAt: new Date(),
      resolvedBy: "counter-test-model",
    };
  }
}

class SlugPairRealizer implements ChzRealizer {
  readonly name = "SlugPairRealizer";
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
      symbol.name === "slugify"
        ? "export function slugify(input: string): string { return input.toLowerCase(); }\n"
        : [
            'import { slugify } from "./slugify.ts";',
            "",
            "export function buildUniqueSlugs(titles: readonly string[]): string[] {",
            "  return titles.map((title) => slugify(title));",
            "}",
            "",
          ].join("\n"),
      "utf8",
    );
    writeFileSync(
      test,
      [
        "// @ts-expect-error The engine-owned Vitest runner provides this module for the temporary fixture.",
        'import { expect, it } from "vitest";',
        `import { ${symbol.name} } from "../implementations/${symbol.name}.ts";`,
        symbol.name === "slugify"
          ? "it('lowercases', () => { expect(slugify('AB')).toBe('ab'); });"
          : "it('maps every title', () => { expect(buildUniqueSlugs(['AB'])).toEqual(['ab']); });",
        "",
      ].join("\n"),
      "utf8",
    );
    return {
      outcome: "resolved",
      symbol,
      resolvedFile: implementation,
      resolvedTestFiles: [test],
      resolvedAt: new Date(),
      resolvedBy: "slug-pair-model",
    };
  }
}

describe("realize engine", () => {
  it("feeds independent verification failures into bounded retry sessions", async () => {
    const data = fixture();
    const realizer = new RetryingEngineRealizer();
    let verificationCalls = 0;
    const result = await realize(data.source, data.sourceFile, {
      realizers: [realizer],
      projectRoot: data.root,
      maxRetries: 1,
      verify: async () => {
        verificationCalls++;
        return verificationCalls === 1
          ? { passed: false, output: "TS2322 first attempt failed" }
          : { passed: true, output: "green" };
      },
      verifyRealization: async () => ({ passed: true, output: "green" }),
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(result.outcome).toBe("resolved");
    expect(realizer.contexts).toHaveLength(2);
    expect(realizer.contexts[1]!.verificationFeedback).toContain("TS2322");
    expect(result.files.map((file) => file.relPath)).toContain("implementation.ts");
    expect(result.files.map((file) => file.relPath)).toContain("implementations/__prologue__.ts");
    expect(result.files.map((file) => file.relPath)).toContain("implementations/__epilogue__.ts");
    expect(readFileSync(join(result.baseDir, "implementations", "greet.ts"), "utf8")).toContain(
      "realized by engine-model",
    );
  });

  it("realizes and independently verifies a class as one symbol", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-class-realize-"));
    roots.push(root);
    const sourceFile = join(root, "counter.chz.ts");
    const source = [
      "imagine class Counter {",
      "  requirements(`누적 카운터를 구현합니다.`);",
      "  imagine increment(by: number): number {",
      "    ensure('호출할 때마다 by만큼 누적됩니다.', () => {",
      "      const counter = new Counter();",
      "      assert(counter.increment(2) === 2);",
      "      assert(counter.increment(3) === 5);",
      "    });",
      "  }",
      "}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");

    const result = await realize(source, sourceFile, {
      realizers: [new CounterClassRealizer()],
      projectRoot: root,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    if (result.outcome !== "resolved") throw new Error(result.reason);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.symbol.type).toBe("class");
    expect(readFileSync(join(result.baseDir, "implementations", "Counter.ts"), "utf8"))
      .toContain("realization of `imagine class Counter`");
    expect(readFileSync(join(result.baseDir, "implementation.ts"), "utf8"))
      .toContain('export { Counter } from "./implementations/Counter.ts";');
  });

  it(
    "verifies each symbol in its own scope even when the epilogue wires a later symbol",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "chz-scope-realize-"));
      roots.push(root);
      const sourceFile = join(root, "slug.chz.ts");
      const source = [
        "imagine function slugify(input: string): string {",
        "  requirements(`입력을 소문자 슬러그로 만듭니다.`);",
        "  ensure(slugify('AB') === 'ab', '소문자로 변환합니다.');",
        "}",
        "",
        "imagine function buildUniqueSlugs(titles: readonly string[]): string[] {",
        "  requirements(`각 제목을 slugify로 변환한 목록을 만듭니다.`);",
        "  ensure('입력 순서를 보존합니다.', () => {",
        "    assert(buildUniqueSlugs(['AB']).length === 1);",
        "  });",
        "}",
        "",
        "console.log(buildUniqueSlugs(['Hello']));",
        "",
      ].join("\n");
      writeFileSync(sourceFile, source, "utf8");

      const result = await realize(source, sourceFile, {
        realizers: [new SlugPairRealizer()],
        projectRoot: root,
        now: () => new Date("2026-07-23T00:00:00.000Z"),
      });

      // Before scoped verification, the first symbol's session was failed by
      // the epilogue's import of the not-yet-realized second symbol.
      if (result.outcome !== "resolved") throw new Error(result.reason);
      expect(result.symbols.map((symbol) => symbol.name)).toEqual([
        "slugify",
        "buildUniqueSlugs",
      ]);
    },
    120_000,
  );

  it("realizes a dependency cycle as one warned session covering every member", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-cycle-realize-"));
    roots.push(root);
    const sourceFile = join(root, "parity.chz.ts");
    const source = [
      "imagine function isEven(n: number): boolean {",
      "  requirements(`0이면 참, 아니면 isOdd(n - 1)을 반환합니다.`);",
      "}",
      "",
      "imagine function isOdd(n: number): boolean {",
      "  requirements(`0이면 거짓, 아니면 isEven(n - 1)을 반환합니다.`);",
      "}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");

    const sessions: Array<{ symbol: string; scope: readonly string[]; cycle: string[] }> = [];
    const realizer: ChzRealizer = {
      name: "CycleRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        sessions.push({
          symbol: symbol.name,
          scope: context.scope?.symbolNames ?? [],
          cycle: symbol.circularDependencies.map((member) => member.name),
        });
        for (const member of ["isEven", "isOdd"]) {
          const implementation = join(context.outputDir, "implementations", `${member}.ts`);
          mkdirSync(dirname(implementation), { recursive: true });
          mkdirSync(join(context.outputDir, "tests"), { recursive: true });
          writeFileSync(implementation, `export function ${member}(n: number): boolean { return n >= 0; }\n`, "utf8");
          writeFileSync(join(context.outputDir, "tests", `test_${member}.autogen.ts`), "export {};\n", "utf8");
        }
        const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
        return {
          outcome: "resolved",
          symbol,
          resolvedFile: implementation,
          resolvedTestFiles: [join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`)],
          resolvedAt: new Date("2026-07-23T00:00:00.000Z"),
          resolvedBy: "cycle-model",
        };
      },
    };

    const warnings: string[] = [];
    const verifiedScopes: string[][] = [];
    const result = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      verify: async (input) => {
        verifiedScopes.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      verifyRealization: async () => ({ passed: true, output: "green" }),
      harness: { onEvent: (message) => warnings.push(message) },
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    if (result.outcome !== "resolved") throw new Error(result.reason);
    // One session realized the whole cycle.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.symbol).toBe("isEven");
    expect(sessions[0]!.scope).toEqual(["isEven", "isOdd"]);
    expect(sessions[0]!.cycle).toEqual(["isOdd"]);
    // Custom verifiers receive the whole group as their scope (docs/62:
    // the group is complete only when every member's tests are green).
    expect(verifiedScopes).toEqual([["isEven", "isOdd"]]);
    expect(warnings.some((message) => message.includes("Dependency cycle detected"))).toBe(true);
    // Both members resolved, with provenance stamped on each implementation.
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(["isEven", "isOdd"]);
    for (const member of ["isEven", "isOdd"]) {
      expect(readFileSync(join(result.baseDir, "implementations", `${member}.ts`), "utf8"))
        .toContain("realized by cycle-model");
    }
  });

  it("continues independent symbols after a failure and skips only dependents", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-partial-realize-"));
    roots.push(root);
    const sourceFile = join(root, "trio.chz.ts");
    const source = [
      "imagine function alpha(input: string): string {",
      "  requirements(`알파를 계산합니다.`);",
      "}",
      "",
      "imagine function beta(input: string): string {",
      "  requirements(`베타를 계산합니다.`);",
      "}",
      "",
      "imagine function gamma(input: string): string {",
      "  requirements(`alpha를 사용합니다.`);",
      "}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");

    const calls: string[] = [];
    const realizer: ChzRealizer = {
      name: "PartialRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        calls.push(symbol.name);
        if (symbol.name === "alpha") {
          return { outcome: "failed", symbol, reason: "synthetic alpha failure" };
        }
        const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
        const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
        mkdirSync(dirname(implementation), { recursive: true });
        mkdirSync(dirname(test), { recursive: true });
        writeFileSync(implementation, `export function ${symbol.name}(input: string): string { return input; }\n`, "utf8");
        writeFileSync(test, "export {};\n", "utf8");
        return {
          outcome: "resolved",
          symbol,
          resolvedFile: implementation,
          resolvedTestFiles: [test],
          resolvedAt: new Date("2026-07-23T00:00:00.000Z"),
          resolvedBy: "partial-model",
        };
      },
    };

    const result = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      verify: async () => ({ passed: true, output: "green" }),
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(result.outcome).toBe("failed");
    // gamma depends on the failed alpha and must never start a session.
    expect(calls).toEqual(["alpha", "beta"]);
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(["beta"]);
    expect(result.resolutions.map((resolution) => resolution.outcome)).toEqual([
      "failed",
      "resolved",
      "failed",
    ]);
    expect(result.reason).toContain("synthetic alpha failure");
    expect(result.reason).toContain("Skipped 'gamma'");
    // A partial realization must not pretend to have a complete entry point.
    expect(existsSync(join(result.baseDir, "implementation.ts"))).toBe(false);
  });

  it("keeps a blocked root cause blocked across skipped dependents", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-blocked-realize-"));
    roots.push(root);
    const sourceFile = join(root, "blocked.chz.ts");
    const source = [
      "imagine function alpha(input: string): string {",
      "  requirements(`알파를 계산합니다.`);",
      "}",
      "",
      "imagine function beta(input: string): string {",
      "  requirements(`alpha를 사용합니다.`);",
      "}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");

    const realizer: ChzRealizer = {
      name: "BlockingRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol) {
        return {
          outcome: "blocked",
          symbol,
          reason: "User input is required.",
          todo: "Answer the encoding question, then rerun chz realize.",
        };
      },
    };

    const result = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    // A blocked root must keep the run blocked — the human needs the TODO,
    // and nothing here is a defect a spec change could fix.
    expect(result.outcome).toBe("blocked");
    expect(result.resolutions.map((resolution) => resolution.outcome)).toEqual([
      "blocked",
      "blocked",
    ]);
    expect(result.todo).toContain("Answer the encoding question");
    expect(result.reason).toContain("Skipped 'beta'");
  });

  it("turns a missing cycle-member test file into a structured failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-missing-member-"));
    roots.push(root);
    const sourceFile = join(root, "parity.chz.ts");
    const source = [
      "imagine function isEven(n: number): boolean {",
      "  requirements(`isOdd를 사용합니다.`);",
      "}",
      "",
      "imagine function isOdd(n: number): boolean {",
      "  requirements(`isEven을 사용합니다.`);",
      "}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");

    // Writes both implementations but forgets isOdd's autogen tests — a
    // custom Realizer bug that must fail the group, not crash realize().
    const realizer: ChzRealizer = {
      name: "ForgetfulRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        mkdirSync(join(context.outputDir, "implementations"), { recursive: true });
        mkdirSync(join(context.outputDir, "tests"), { recursive: true });
        for (const member of ["isEven", "isOdd"]) {
          writeFileSync(
            join(context.outputDir, "implementations", `${member}.ts`),
            `export function ${member}(n: number): boolean { return n >= 0; }\n`,
            "utf8",
          );
        }
        const test = join(context.outputDir, "tests", "test_isEven.autogen.ts");
        writeFileSync(test, "export {};\n", "utf8");
        return {
          outcome: "resolved",
          symbol,
          resolvedFile: join(context.outputDir, "implementations", `${symbol.name}.ts`),
          resolvedTestFiles: [test],
          resolvedAt: new Date("2026-07-23T00:00:00.000Z"),
          resolvedBy: "forgetful-model",
        };
      },
    };

    const result = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("test_isOdd.autogen.ts");
  });

  it("fails fast when a cycle exceeds the configured size cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-cap-realize-"));
    roots.push(root);
    const sourceFile = join(root, "ring.chz.ts");
    const names = ["ringA", "ringB", "ringC", "ringD"];
    const source = names
      .map((name, index) => [
        `imagine function ${name}(input: string): string {`,
        `  requirements(\`${names[(index + 1) % names.length]}를 사용합니다.\`);`,
        "}",
        "",
      ].join("\n"))
      .join("\n");
    writeFileSync(sourceFile, source, "utf8");

    const calls: string[] = [];
    const realizer: ChzRealizer = {
      name: "NeverRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol) {
        calls.push(symbol.name);
        return { outcome: "failed", symbol, reason: "must not be called" };
      },
    };

    const result = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("maximum cycle size");
    expect(calls).toEqual([]);
  });
});

/** Two-symbol re-run fixture: buildUniqueSlugs depends on slugify. */
function makeSlugSource(slugifyRequirements: string, slugifyEnsure: string): string {
  return [
    "imagine function slugify(input: string): string {",
    `  requirements(\`${slugifyRequirements}\`);`,
    `  ${slugifyEnsure}`,
    "}",
    "",
    "imagine function buildUniqueSlugs(titles: readonly string[]): string[] {",
    "  requirements(`slugify를 사용합니다.`);",
    "}",
    "",
  ].join("\n");
}

class CountingSlugRealizer implements ChzRealizer {
  readonly name = "CountingSlugRealizer";
  readonly supportedSymbolTypes = ["function"] as const;
  readonly calls: string[] = [];
  readonly feedbacks: Array<string | undefined> = [];

  async realize(
    symbol: ChzImagineSymbol,
    context: ChzRealizeContext,
  ): Promise<ChzImagineSymbolResolution> {
    this.calls.push(symbol.name);
    this.feedbacks.push(context.verificationFeedback);
    const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
    const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
    mkdirSync(dirname(implementation), { recursive: true });
    mkdirSync(dirname(test), { recursive: true });
    writeFileSync(
      implementation,
      symbol.name === "slugify"
        ? "export function slugify(input: string): string { return input.toLowerCase(); }\n"
        : [
            'import { slugify } from "./slugify.ts";',
            "",
            "export function buildUniqueSlugs(titles: readonly string[]): string[] {",
            "  return titles.map((title) => slugify(title));",
            "}",
            "",
          ].join("\n"),
      "utf8",
    );
    writeFileSync(test, "export {};\n", "utf8");
    return {
      outcome: "resolved",
      symbol,
      resolvedFile: implementation,
      resolvedTestFiles: [test],
      resolvedAt: new Date("2026-07-23T00:00:00.000Z"),
      resolvedBy: "counting-model",
    };
  }
}

describe("realize re-runs (docs/62)", () => {
  const CHZ_VERSION = "test-version";
  const green = async () => ({ passed: true, output: "green" });

  async function firstRun(source: string, root: string, sourceFile: string) {
    const realizer = new CountingSlugRealizer();
    const result = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });
    if (result.outcome !== "resolved") throw new Error(result.reason);
    writeRealizationCache({
      result,
      source,
      chzVersion: CHZ_VERSION,
      realizedAt: "2026-07-23T00:00:00.000Z",
      testsPassed: true,
    });
    return result;
  }

  function fixtureRoot(): { root: string; sourceFile: string } {
    const root = mkdtempSync(join(tmpdir(), "chz-rerun-"));
    roots.push(root);
    return { root, sourceFile: join(root, "slugs.chz.ts") };
  }

  it("reuses every unchanged symbol without a session and keeps the cache byte-stable", async () => {
    const { root, sourceFile } = fixtureRoot();
    const source = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    writeFileSync(sourceFile, source, "utf8");
    const first = await firstRun(source, root, sourceFile);
    const firstCache = readFileSync(join(first.baseDir, "realization-cache.json"), "utf8");

    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async (input) => {
        retests.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual([]);
    expect(retests).toEqual([]);
    expect(second.symbols.map((symbol) => [symbol.name, symbol.reused])).toEqual([
      ["slugify", true],
      ["buildUniqueSlugs", true],
    ]);
    // Re-writing the cache changes nothing: provenance is preserved.
    const rewritten = buildRealizationCache({
      result: second,
      source,
      chzVersion: CHZ_VERSION,
      realizedAt: "2026-07-24T00:00:00.000Z",
      testsPassed: true,
    });
    expect(`${JSON.stringify(rewritten, null, 2)}\n`).toBe(firstCache);
  });

  it("re-realizes only an internally-changed symbol and retests its dependents", async () => {
    const { root, sourceFile } = fixtureRoot();
    const ensureLine = "ensure(slugify('AB') === 'ab', '소문자.');";
    const source = makeSlugSource("소문자로 만듭니다.", ensureLine);
    writeFileSync(sourceFile, source, "utf8");
    await firstRun(source, root, sourceFile);

    // Same signature, same ensure — only the requirements prose changes.
    const edited = makeSlugSource("소문자 슬러그로 만듭니다.", ensureLine);
    writeFileSync(sourceFile, edited, "utf8");
    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realize(edited, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async (input) => {
        retests.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual(["slugify"]);
    expect(retests).toEqual([["buildUniqueSlugs"]]);
    expect(second.symbols.map((symbol) => [symbol.name, symbol.reused])).toEqual([
      ["slugify", false],
      ["buildUniqueSlugs", true],
    ]);
  });

  it("invalidates dependents when a public surface changes", async () => {
    const { root, sourceFile } = fixtureRoot();
    const source = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    writeFileSync(sourceFile, source, "utf8");
    await firstRun(source, root, sourceFile);

    // The ensure contract is part of the public surface (docs/62).
    const edited = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('A-B') === 'a-b', '하이픈 보존.');");
    writeFileSync(sourceFile, edited, "utf8");
    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realize(edited, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async (input) => {
        retests.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual(["slugify", "buildUniqueSlugs"]);
    expect(retests).toEqual([]);
  });

  it("re-realizes a dependent whose safety-net tests go red, feeding the red output back", async () => {
    const { root, sourceFile } = fixtureRoot();
    const ensureLine = "ensure(slugify('AB') === 'ab', '소문자.');";
    const source = makeSlugSource("소문자로 만듭니다.", ensureLine);
    writeFileSync(sourceFile, source, "utf8");
    await firstRun(source, root, sourceFile);

    const edited = makeSlugSource("소문자 슬러그로 만듭니다.", ensureLine);
    writeFileSync(sourceFile, edited, "utf8");
    const realizer = new CountingSlugRealizer();
    const second = await realize(edited, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async () => ({ passed: false, output: "RETEST-RED: my-post now collides" }),
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual(["slugify", "buildUniqueSlugs"]);
    // The dependent's session starts from the red safety-net output.
    expect(realizer.feedbacks[1]).toContain("RETEST-RED");
    expect(second.symbols.every((symbol) => !symbol.reused)).toBe(true);
  });

  it("still reuses everything when an edit above the symbols shifts every line", async () => {
    const { root, sourceFile } = fixtureRoot();
    const source = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    writeFileSync(sourceFile, source, "utf8");
    await firstRun(source, root, sourceFile);

    // A leading comment keeps every specHash intact but shifts every ensure
    // to a new line; position-independent harnesses must keep reuse alive.
    // (The comment is also a human-layer change, so the retest net fires —
    // that is expected and must still end in reuse, not in a session.)
    const shifted = `// 상단 주석 한 줄 추가\n${source}`;
    writeFileSync(sourceFile, shifted, "utf8");
    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realize(shifted, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async (input) => {
        retests.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual([]);
    expect(retests).toEqual([["slugify"], ["buildUniqueSlugs"]]);
    expect(second.symbols.every((symbol) => symbol.reused)).toBe(true);
  });

  it("discards the whole cache when CONTEXTS.md was edited", async () => {
    const { root, sourceFile } = fixtureRoot();
    const source = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    writeFileSync(sourceFile, source, "utf8");
    const first = await firstRun(source, root, sourceFile);

    // Recorded decisions join the invalidation hash (docs/63): every cached
    // symbol may have been realized under answers that no longer hold.
    writeFileSync(
      join(first.baseDir, "CONTEXTS.md"),
      "## slugify\n\n- **Q**: 하이픈 정책?\n- **A**: 유지 (2026-07-24)\n",
      "utf8",
    );
    const realizer = new CountingSlugRealizer();
    const second = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual(["slugify", "buildUniqueSlugs"]);
    expect(second.symbols.some((symbol) => symbol.reused)).toBe(false);
  });

  it("routes every reused symbol through the retest net when human code changed", async () => {
    const { root, sourceFile } = fixtureRoot();
    const humanLine = 'console.log(buildUniqueSlugs(["Hello"]));';
    const base = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    const source = `${base}\n${humanLine}\n`;
    writeFileSync(sourceFile, source, "utf8");
    await firstRun(source, root, sourceFile);

    const edited = `${base}\nconsole.log(buildUniqueSlugs(["Hello", "World"]));\n`;
    writeFileSync(sourceFile, edited, "utf8");
    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realize(edited, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async (input) => {
        retests.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual([]);
    expect(retests).toEqual([["slugify"], ["buildUniqueSlugs"]]);
    expect(second.symbols.every((symbol) => symbol.reused)).toBe(true);
  });

  it("skips the retest safety net under --skip-tests", async () => {
    const { root, sourceFile } = fixtureRoot();
    const ensureLine = "ensure(slugify('AB') === 'ab', '소문자.');";
    const source = makeSlugSource("소문자로 만듭니다.", ensureLine);
    writeFileSync(sourceFile, source, "utf8");
    await firstRun(source, root, sourceFile);

    const edited = makeSlugSource("소문자 슬러그로 만듭니다.", ensureLine);
    writeFileSync(sourceFile, edited, "utf8");
    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realize(edited, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      skipVerification: true,
      retest: async (input) => {
        retests.push([...input.scope.symbolNames]);
        return { passed: false, output: "must not run" };
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual(["slugify"]);
    expect(retests).toEqual([]);
    expect(second.symbols.map((symbol) => [symbol.name, symbol.reused])).toEqual([
      ["slugify", false],
      ["buildUniqueSlugs", true],
    ]);
  });

  it("degrades a corrupted cache entry to a fresh realization instead of crashing", async () => {
    const { root, sourceFile } = fixtureRoot();
    const source = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    writeFileSync(sourceFile, source, "utf8");
    const first = await firstRun(source, root, sourceFile);

    const cachePath = join(first.baseDir, "realization-cache.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      symbols: Record<string, { realizedAt: string }>;
    };
    cache.symbols["slugify"]!.realizedAt = "not-a-timestamp";
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");

    const realizer = new CountingSlugRealizer();
    const second = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async () => ({ passed: true, output: "green" }),
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual(["slugify"]);
  });

  it("ignores a cache written by a different chz version", async () => {
    const { root, sourceFile } = fixtureRoot();
    const source = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    writeFileSync(sourceFile, source, "utf8");
    await firstRun(source, root, sourceFile);

    const realizer = new CountingSlugRealizer();
    const second = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: "another-version",
      verify: green,
      verifyRealization: green,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    expect(realizer.calls).toEqual(["slugify", "buildUniqueSlugs"]);
  });

  it("re-realizes a symbol whose committed artifact drifted from the cache", async () => {
    const { root, sourceFile } = fixtureRoot();
    const source = makeSlugSource("소문자로 만듭니다.", "ensure(slugify('AB') === 'ab', '소문자.');");
    writeFileSync(sourceFile, source, "utf8");
    const first = await firstRun(source, root, sourceFile);

    // Unauthorized manual edit of a realized file.
    const drifted = join(first.baseDir, "implementations", "slugify.ts");
    writeFileSync(drifted, `${readFileSync(drifted, "utf8")}// tampered\n`, "utf8");

    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realize(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      chzVersion: CHZ_VERSION,
      verify: green,
      verifyRealization: green,
      retest: async (input) => {
        retests.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (second.outcome !== "resolved") throw new Error(second.reason);
    // The drifted symbol is rebuilt; its spec (and surface) is unchanged, so
    // the dependent goes through the retest safety net and is then reused.
    expect(realizer.calls).toEqual(["slugify"]);
    expect(retests).toEqual([["buildUniqueSlugs"]]);
  });
});
