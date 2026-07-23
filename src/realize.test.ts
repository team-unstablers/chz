import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractImagineSpecs } from "./preprocessor.ts";
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
});
