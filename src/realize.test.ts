import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeChzSource } from "./compiler/index.ts";
import { API } from "./compiler/ts-api.ts";
import { splitHumanCode } from "./human-code.ts";
import {
  imagineSpecsFromChzSource,
} from "./preprocessor.ts";
import {
  buildRealizationCache,
  writeRealizationCache,
  type RealizationCache,
} from "./verify.ts";
import {
  CHZ_HARNESS_TOOLS,
  CHZ_REALIZER_SYSTEM,
  ChzRealizerBase,
  buildEstimatedRealizeOrder,
  buildSessionBaseline,
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

async function realizeSource(
  source: string,
  fileName: string,
  options: Parameters<typeof realize>[1],
): Promise<Awaited<ReturnType<typeof realize>>> {
  const analysis = analyzeChzSource(source, fileName);
  try {
    return await realize(analysis, options);
  } finally {
    analysis.dispose();
  }
}

function symbolsOf(source: string, fileName: string): ChzImagineSymbol[] {
  const analysis = analyzeChzSource(source, fileName);
  try {
    expect(analysis.diagnostics).toEqual([]);
    return buildEstimatedRealizeOrder(analysis);
  } finally {
    analysis.dispose();
  }
}

function firstSpecAndSymbol(
  source: string,
  fileName: string,
) {
  const analysis = analyzeChzSource(source, fileName);
  try {
    expect(analysis.diagnostics).toEqual([]);
    return {
      spec: imagineSpecsFromChzSource(analysis)[0]!,
      symbol: buildEstimatedRealizeOrder(analysis)[0]!,
    };
  } finally {
    analysis.dispose();
  }
}

function typeCheckProject(configPath: string, projectRoot: string): string[] {
  const api = new API({ cwd: projectRoot });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project =
      snapshot.getProject(configPath) ?? snapshot.getProjects()[0];
    if (project === undefined) return ["TypeScript did not create a project."];
    return [
      ...project.program.getConfigFileParsingDiagnostics(),
      ...project.program.getProgramDiagnostics(),
      ...project.program.getGlobalDiagnostics(),
      ...project.program.getSyntacticDiagnostics(),
      ...project.program.getBindDiagnostics(),
      ...project.program.getSemanticDiagnostics(),
    ].map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`);
  } finally {
    snapshot?.dispose();
    api.close();
  }
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
    const { spec, symbol } = firstSpecAndSymbol(
      data.source,
      data.sourceFile,
    );
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

  it("omits the output-language and blocked-path lines when neither is configured", () => {
    const data = fixture();
    const { symbol } = firstSpecAndSymbol(data.source, data.sourceFile);
    const baseline = buildSessionBaseline(symbol, contextFor(data.root, data.outputDir), "gpt-test");

    expect(baseline).not.toContain("Output language");
    expect(baseline).not.toContain("Blocked paths");
  });

  it("declares the configured output language and blocked paths in the baseline", () => {
    const data = fixture();
    const { symbol } = firstSpecAndSymbol(data.source, data.sourceFile);
    const baseline = buildSessionBaseline(symbol, {
      ...contextFor(data.root, data.outputDir),
      outputLanguage: "ko",
      blockedPaths: ["infra/**", "**/*.snapshot.json"],
    }, "gpt-test");

    // The tag is resolved to an English display name: a model follows
    // "Korean (ko)" more reliably than a bare two-letter code.
    expect(baseline).toContain("Output language: Korean (ko)");
    expect(baseline).toContain("# Output language");
    expect(baseline).toContain("Write the prose you author in Korean (ko).");
    expect(baseline).toContain("Identifiers, type names, and file names.");
    // Name-sorted, like every other list in the baseline, so the prompt stays
    // deterministic across runs.
    expect(baseline).toContain(
      "Blocked paths (never readable or writable): **/*.snapshot.json, infra/**",
    );
    // <env> governs everything after it, so the language rule follows it
    // immediately and precedes the symbol specification (docs/64).
    expect(baseline.indexOf("# Output language")).toBeLessThan(
      baseline.indexOf("# Symbol to realize"),
    );
  });

  it("uses dependency surfaces before falling back to dependency file reads", () => {
    const data = fixture();
    const { symbol } = firstSpecAndSymbol(data.source, data.sourceFile);
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
      "imagine function parentNode(): number { requirements(`Use leaf to calculate.`); }",
    ].join("\n");
    const order = symbolsOf(source, "graph.chz.ts");
    expect(order.map((symbol) => symbol.name)).toEqual(["leaf", "parentNode"]);
    expect(order[1]!.dependencies.map((symbol) => symbol.name)).toEqual(["leaf"]);
  });

  it("renders ensure harnesses independent of file position and checkout path", () => {
    const data = fixture();
    const shifted = `// a comment moving every symbol down one line\n\n${data.source}`;
    const originAnalysis = analyzeChzSource(data.source, data.sourceFile);
    const shiftedAnalysis = analyzeChzSource(
      shifted,
      "/entirely/other/path/sample.chz.ts",
    );
    try {
      const specAtOrigin = imagineSpecsFromChzSource(originAnalysis)[0]!;
      const specShifted = imagineSpecsFromChzSource(shiftedAnalysis)[0]!;

      expect(specShifted.ensures[0]!.line).not.toBe(
        specAtOrigin.ensures[0]!.line,
      );
      // Identical harness bytes: cache reuse must not break when an edit
      // elsewhere shifts the block, or when the repo lives at another path.
      expect(
        renderEnsureHarness(shiftedAnalysis, specShifted, [specShifted]),
      ).toBe(
        renderEnsureHarness(originAnalysis, specAtOrigin, [specAtOrigin]),
      );
    } finally {
      originAnalysis.dispose();
      shiftedAnalysis.dispose();
    }
  });

  it("imports external signature types into the engine-owned ensure harness", () => {
    const source = [
      "interface Widget {}",
      "type Result = unknown;",
      "imagine function inspect(value: Widget): Result { ensure(inspect({} as Widget) !== undefined); }",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(source, "types.chz.ts");
    try {
      const spec = imagineSpecsFromChzSource(analysis)[0]!;
      const harness = renderEnsureHarness(analysis, spec);
      expect(harness).toContain(
        'import type { Result, Widget } from "../implementations/__prologue__.ts";',
      );
    } finally {
      analysis.dispose();
    }
  });

  it("collects lowercase, Unicode and imported prologue types under their local names", () => {
    const root = mkdtempSync(join(tmpdir(), "chz-external-types-"));
    roots.push(root);
    const fileName = join(root, "types.chz.ts");
    writeFileSync(
      join(root, "external.ts"),
      "export interface ImportedType { external: boolean }\n",
      "utf8",
    );
    const source = [
      'import type { ImportedType as importedAlias } from "./external.ts";',
      "type lowercase = { value: number };",
      "interface 유니코드타입 { ok: boolean }",
      "imagine function inspect(",
      "  value: lowercase,",
      "  imported: importedAlias,",
      "): Promise<유니코드타입> {",
      "  ensure('type references remain available', () => {",
      "    const local: lowercase = { value: 1 };",
      "    const unicode = { ok: true } as 유니코드타입;",
      "    const external = { external: true } as importedAlias;",
      "    assert(local.value === 1 && unicode.ok && external.external);",
      "  });",
      "}",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(source, fileName);
    try {
      expect(analysis.diagnostics).toEqual([]);
      const spec = imagineSpecsFromChzSource(analysis)[0]!;
      const harness = renderEnsureHarness(analysis, spec);

      // The imported type is included: the prologue re-exports it, and the
      // ensure body annotates a local with it, so omitting it is a type error
      // in an engine-owned file the realizer is not allowed to fix. It appears
      // under the local alias, which is the name both the prologue export and
      // the copied ensure body use.
      expect(
        harness.split("\n").find((line) => line.startsWith("import type")),
      ).toBe(
        'import type { importedAlias, lowercase, 유니코드타입 } from "../implementations/__prologue__.ts";',
      );
      expect(harness).not.toContain("Promise } from");
    } finally {
      analysis.dispose();
    }
  });

  it("keeps a type imported from another module resolvable in the ensure harness", () => {
    const root = mkdtempSync(join(tmpdir(), "chz-cross-module-ensure-"));
    roots.push(root);
    // Stands in for a realized Cheese module's shim (docs/20): the dependent
    // file imports it exactly the way a human would.
    writeFileSync(
      join(root, "stats.ts"),
      [
        "export interface CombatStats { attack: number; luck: number }",
        "export function 크리티컬_판정(attacker: CombatStats): boolean { return attacker.luck > 0; }",
        "",
      ].join("\n"),
      "utf8",
    );
    const fileName = join(root, "battle.chz.ts");
    const source = [
      'import { 크리티컬_판정, type CombatStats } from "./stats.ts";',
      "",
      "imagine function 데미지_계산(attacker: CombatStats): number {",
      "  requirements(`공격력과 크리티컬 여부로 데미지를 계산합니다.`);",
      "  ensure('데미지는 음수가 아닙니다.', () => {",
      "    const 공격자: CombatStats = { attack: 10, luck: 0 };",
      "    assert(데미지_계산(공격자) >= 0);",
      "  });",
      "}",
      "",
    ].join("\n");
    writeFileSync(fileName, source, "utf8");

    const analysis = analyzeChzSource(source, fileName);
    try {
      expect(analysis.diagnostics).toEqual([]);
      const spec = imagineSpecsFromChzSource(analysis)[0]!;
      const humanCode = splitHumanCode(analysis);
      const harness = renderEnsureHarness(analysis, spec);

      expect(
        harness.split("\n").find((line) => line.startsWith("import type")),
      ).toBe(
        'import type { CombatStats } from "../implementations/__prologue__.ts";',
      );

      // The import line is only half the claim. This gap first surfaced as a
      // typecheck failure in an engine-owned file the realizer may not edit,
      // so the harness is compiled where it actually lands.
      const baseDir = join(root, "chz", "realization", "battle");
      const implementations = join(baseDir, "implementations");
      const tests = join(baseDir, "tests");
      mkdirSync(implementations, { recursive: true });
      mkdirSync(tests, { recursive: true });
      writeFileSync(join(implementations, "__prologue__.ts"), humanCode.prologue, "utf8");
      writeFileSync(join(implementations, "__epilogue__.ts"), humanCode.epilogue, "utf8");
      writeFileSync(
        join(implementations, "데미지_계산.ts"),
        [
          'import { 크리티컬_판정, type CombatStats } from "./__prologue__.ts";',
          "export function 데미지_계산(attacker: CombatStats): number {",
          "  return 크리티컬_판정(attacker) ? attacker.attack * 2 : attacker.attack;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(join(tests, "test_데미지_계산.ensure.ts"), harness, "utf8");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ type: "module" }),
        "utf8",
      );
      const configPath = join(root, "tsconfig.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            allowImportingTsExtensions: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            target: "ES2022",
            verbatimModuleSyntax: true,
          },
          files: [join(tests, "test_데미지_계산.ensure.ts")],
        }),
        "utf8",
      );

      expect(typeCheckProject(configPath, root)).toEqual([]);
    } finally {
      analysis.dispose();
    }
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
    const analysis = analyzeChzSource(source, "counter.chz.ts");
    try {
      const spec = imagineSpecsFromChzSource(analysis)[0]!;
      const symbol = buildEstimatedRealizeOrder(analysis)[0]!;
      const harness = renderEnsureHarness(analysis, spec);

      expect(symbol.type).toBe("class");
      expect(symbol.definition).toContain("imagine increment");
      expect(harness).toContain(
        'import { Counter } from "../implementations/Counter.ts";',
      );
      expect(harness).toContain("it('increment는 number를 반환합니다.'");
      expect(harness).toContain(
        "typeof counter.increment(1) === 'number'",
      );
      expect(harness).not.toContain("assertEnsures");
    } finally {
      analysis.dispose();
    }
  });

  it("connects prologue, realized symbols, and epilogue in entry-point order", () => {
    const source =
      "export imagine function greet(): string { ensure(greet() === '안녕'); }\n";
    const analysis = analyzeChzSource(source, "example.chz.ts");
    try {
      const specs = imagineSpecsFromChzSource(analysis);
      const entry = renderEntryPoint(
        analysis,
        splitHumanCode(analysis),
        specs,
      );

      expect(entry.indexOf('import "./implementations/__prologue__.ts";'))
        .toBeLessThan(entry.indexOf('export { greet } from "./implementations/greet.ts";'));
      expect(entry.indexOf('export { greet } from "./implementations/greet.ts";'))
        .toBeLessThan(entry.indexOf('import "./implementations/__epilogue__.ts";'));
    } finally {
      analysis.dispose();
    }
  });

  it("forwards exactly the source exports with value/type separation", () => {
    const root = mkdtempSync(join(tmpdir(), "chz-entrypoint-exports-"));
    roots.push(root);
    const sourceFile = join(root, "exports.chz.ts");
    const source = [
      "interface PrivateType { hidden: true; }",
      "const privateValue = 1;",
      "export interface PublicType { value: number; }",
      "export type PublicAlias = PublicType;",
      "export const publicValue = 2;",
      "imagine function hiddenImagine(): number {}",
      "export imagine function publicImagine(): PublicType {}",
      "export { hiddenImagine as exposedImagine };",
      "const result = hiddenImagine();",
      "export { result };",
      "export default publicImagine;",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");
    const analysis = analyzeChzSource(source, sourceFile);
    try {
      expect(analysis.diagnostics).toEqual([]);
      const specs = imagineSpecsFromChzSource(analysis);
      const humanCode = splitHumanCode(analysis);
      const entryPoint = renderEntryPoint(analysis, humanCode, specs);

      expect(entryPoint).toContain(
        'export { publicValue } from "./implementations/__prologue__.ts";',
      );
      expect(entryPoint).toContain(
        'export type { PublicType, PublicAlias } from "./implementations/__prologue__.ts";',
      );
      expect(entryPoint).toContain(
        'export { hiddenImagine as exposedImagine } from "./implementations/hiddenImagine.ts";',
      );
      expect(entryPoint).toContain(
        'export { publicImagine } from "./implementations/publicImagine.ts";',
      );
      expect(entryPoint).toContain(
        'export { result } from "./implementations/__epilogue__.ts";',
      );
      expect(entryPoint).toContain(
        'export { default } from "./implementations/__epilogue__.ts";',
      );
      expect(entryPoint).not.toContain("PrivateType");
      expect(entryPoint).not.toContain("privateValue");
      expect(entryPoint).not.toContain(
        'export * from "./implementations/__prologue__.ts"',
      );

      const baseDir = join(root, "chz", "realization", "exports");
      const implementations = join(baseDir, "implementations");
      mkdirSync(implementations, { recursive: true });
      writeFileSync(
        join(implementations, "__prologue__.ts"),
        humanCode.prologue,
        "utf8",
      );
      writeFileSync(
        join(implementations, "__epilogue__.ts"),
        humanCode.epilogue,
        "utf8",
      );
      writeFileSync(
        join(implementations, "hiddenImagine.ts"),
        "export function hiddenImagine(): number { return 1; }\n",
        "utf8",
      );
      writeFileSync(
        join(implementations, "publicImagine.ts"),
        [
          'import type { PublicType } from "./__prologue__.ts";',
          "export function publicImagine(): PublicType { return { value: 1 }; }",
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(baseDir, "implementation.ts"),
        entryPoint,
        "utf8",
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ type: "module" }),
        "utf8",
      );
      const configPath = join(root, "tsconfig.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            allowImportingTsExtensions: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            target: "ES2022",
            verbatimModuleSyntax: true,
          },
          files: [join(baseDir, "implementation.ts")],
        }),
        "utf8",
      );

      expect(typeCheckProject(configPath, root)).toEqual([]);
    } finally {
      analysis.dispose();
    }
  });

  it("keeps the official non-export collision symbol private and epilogue-wired", () => {
    const fileName = resolve("examples/simple-cases/collision.chz.ts");
    const source = readFileSync(fileName, "utf8");
    const analysis = analyzeChzSource(source, fileName);
    try {
      expect(analysis.diagnostics).toEqual([]);
      const specs = imagineSpecsFromChzSource(analysis);
      const humanCode = splitHumanCode(analysis);
      const entryPoint = renderEntryPoint(analysis, humanCode, specs);

      expect(humanCode.epilogue).toContain(
        'import { checkCollision2D } from "./checkCollision2D.ts";',
      );
      expect(entryPoint).toContain(
        'import "./implementations/checkCollision2D.ts";',
      );
      expect(entryPoint).not.toContain(
        'export { checkCollision2D } from "./implementations/checkCollision2D.ts";',
      );
    } finally {
      analysis.dispose();
    }
  });
});

describe("ChzRealizerBase", () => {
  it("owns the tool loop and resolves files after Finish", async () => {
    const data = fixture();
    const events: string[] = [];
    const symbol = symbolsOf(data.source, data.sourceFile)[0]!;
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
      harness: { onEvent: (event) => events.push(event.text) },
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
    const symbol = symbolsOf(data.source, data.sourceFile)[0]!;
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
        onEvent: (event) => events.push(event.text),
        runTypeCheck: async () => ({ passed: false, output: "private compiler diagnostic" }),
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(events).toContainEqual(expect.stringMatching(/^\[ScriptedRealizer\] RunTypeCheck → failed · \d+ms$/));
    expect(events.join("\n")).not.toContain("private compiler diagnostic");
  });

  it("retries provider failures in the base class", async () => {
    const data = fixture();
    const symbol = symbolsOf(data.source, data.sourceFile)[0]!;
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
    const symbol = symbolsOf(data.source, data.sourceFile)[0]!;
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
    const symbol = symbolsOf(data.source, data.sourceFile)[0]!;
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
    const symbol = symbolsOf(data.source, data.sourceFile)[0]!;
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
  it("uses the analyzer profile directive instead of comment or string text", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-profile-realize-"));
    roots.push(root);
    const sourceFile = join(root, "profile.chz.ts");
    const source = [
      "// @profile fake_comment",
      'const fake = "@profile fake_string";',
      "@profile server",
      "export imagine function value(): number {}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");
    const seenProfiles: string[] = [];
    const realizer: ChzRealizer = {
      name: "ProfileCaptureRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        seenProfiles.push(context.activeProfile);
        const implementation = join(
          context.outputDir,
          "implementations",
          `${symbol.name}.ts`,
        );
        const test = join(
          context.outputDir,
          "tests",
          `test_${symbol.name}.autogen.ts`,
        );
        mkdirSync(dirname(implementation), { recursive: true });
        mkdirSync(dirname(test), { recursive: true });
        writeFileSync(
          implementation,
          "export function value(): number { return 1; }\n",
          "utf8",
        );
        writeFileSync(test, "export {};\n", "utf8");
        return {
          outcome: "resolved",
          symbol,
          resolvedFile: implementation,
          resolvedTestFiles: [test],
          resolvedAt: new Date("2026-07-27T00:00:00.000Z"),
          resolvedBy: "profile-capture",
        };
      },
    };

    const result = await realizeSource(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      skipVerification: true,
    });

    expect(result.outcome).toBe("resolved");
    expect(seenProfiles).toEqual(["server"]);
    expect(
      readFileSync(
        join(result.baseDir, "implementations", "__prologue__.ts"),
        "utf8",
      ),
    ).not.toContain("@profile server");
  });

  it("folds a multi-line signature into the provenance header", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-provenance-fold-"));
    roots.push(root);
    const sourceFile = join(root, "wide.chz.ts");
    const source = [
      "imagine function greet(",
      "  name: string,",
      "  greeting: string,",
      "): string {",
      "  requirements(`인사말을 만듭니다.`);",
      "}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");

    const result = await realizeSource(source, sourceFile, {
      realizers: [new RetryingEngineRealizer()],
      projectRoot: root,
      skipVerification: true,
    });

    expect(result.outcome).toBe("resolved");
    const artifact = readFileSync(
      join(result.baseDir, "implementations", "greet.ts"),
      "utf8",
    );
    // The signature keeps the source's line breaks, but the header is a run of
    // `///` lines: an unfolded parameter list puts its tail outside the comment
    // and the artifact stops parsing as TypeScript.
    const header = artifact.split("\n").slice(0, 5);
    expect(header.every((line) => line.startsWith("///"))).toBe(true);
    expect(artifact).toContain(
      "/// realization of `imagine function greet(name: string, greeting: string): string`",
    );
  });

  it("feeds independent verification failures into bounded retry sessions", async () => {
    const data = fixture();
    const realizer = new RetryingEngineRealizer();
    let verificationCalls = 0;
    const result = await realizeSource(data.source, data.sourceFile, {
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

    const result = await realizeSource(source, sourceFile, {
      realizers: [new CounterClassRealizer()],
      projectRoot: root,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    if (result.outcome !== "resolved") throw new Error(result.reason);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.symbol.type).toBe("class");
    expect(readFileSync(join(result.baseDir, "implementations", "Counter.ts"), "utf8"))
      .toContain("realization of `imagine class Counter`");
    const entryPoint = readFileSync(
      join(result.baseDir, "implementation.ts"),
      "utf8",
    );
    expect(entryPoint)
      .toContain('import "./implementations/Counter.ts";');
    expect(entryPoint)
      .not.toContain('export { Counter } from "./implementations/Counter.ts";');
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

      const result = await realizeSource(source, sourceFile, {
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
    const result = await realizeSource(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      verify: async (input) => {
        verifiedScopes.push([...input.scope.symbolNames]);
        return { passed: true, output: "green" };
      },
      verifyRealization: async () => ({ passed: true, output: "green" }),
      harness: { onEvent: (event) => warnings.push(event.text) },
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

    const result = await realizeSource(source, sourceFile, {
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

    const result = await realizeSource(source, sourceFile, {
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

    const result = await realizeSource(source, sourceFile, {
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

    const result = await realizeSource(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("maximum cycle size");
    expect(calls).toEqual([]);
  });
});

describe("sidecar shim (docs/20)", () => {
  it("writes the shim next to the source, re-exporting without a file extension", async () => {
    const data = fixture();
    const result = await realizeSource(data.source, data.sourceFile, {
      realizers: [new RetryingEngineRealizer()],
      projectRoot: data.root,
      skipVerification: true,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.shim).toBe(join(data.root, "sample.ts"));
    const shim = readFileSync(result.shim!, "utf8");
    // The one realize output a plain TypeScript consumer imports directly, so
    // the specifier must resolve without allowImportingTsExtensions.
    expect(shim).toContain('export * from "./chz/realization/sample/implementation";');
    expect(shim).not.toContain("implementation.ts");
    // It is a sibling of the source, never part of the realization directory.
    expect(result.files.map((file) => file.relPath)).not.toContain("../sample.ts");
  });

  it("refuses the run before any session when a human file holds the shim slot", async () => {
    const data = fixture();
    writeFileSync(join(data.root, "sample.ts"), "export const mine = 1;\n", "utf8");
    let calls = 0;
    const realizer: ChzRealizer = {
      name: "NeverCalledRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol) {
        calls += 1;
        return { outcome: "failed", symbol, reason: "must not be called" };
      },
    };

    await expect(
      realizeSource(data.source, data.sourceFile, {
        realizers: [realizer],
        projectRoot: data.root,
        skipVerification: true,
      }),
    ).rejects.toThrow(/human-written file already occupies/);

    expect(calls).toBe(0);
    // A taken slot costs no directory creation either.
    expect(existsSync(data.outputDir)).toBe(false);
    expect(readFileSync(join(data.root, "sample.ts"), "utf8")).toBe("export const mine = 1;\n");
  });

  it("rejects a source whose own name is the shim slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-shim-self-"));
    roots.push(root);
    const sourceFile = join(root, "plain.ts");
    const source = [
      "imagine function greet(name: string): string {",
      "  requirements(`인사말을 만듭니다.`);",
      "}",
      "",
    ].join("\n");
    writeFileSync(sourceFile, source, "utf8");

    await expect(
      realizeSource(source, sourceFile, {
        realizers: [new RetryingEngineRealizer()],
        projectRoot: root,
        skipVerification: true,
      }),
    ).rejects.toThrow(/overwrite the source file itself/);
  });

  it("makes a dependent file analyzable once its dependency is realized", async () => {
    const root = mkdtempSync(join(tmpdir(), "chz-shim-cross-file-"));
    roots.push(root);
    const statsFile = join(root, "stats.chz.ts");
    const battleFile = join(root, "battle.chz.ts");
    const stats = [
      "export const 기본값 = 3;",
      "",
      "export imagine function 두배(n: number): number {",
      "  requirements(`숫자를 두 배로 만듭니다.`);",
      "  ensure(두배(2) === 4, '2는 4가 됩니다.');",
      "}",
      "",
    ].join("\n");
    const battle = [
      'import { 두배, 기본값 } from "./stats";',
      "",
      "export imagine function 세배(n: number): number {",
      "  requirements(`\\`두배\\`와 기본값으로 계산합니다.`);",
      "  ensure(세배(1) >= 기본값, '기본값 이상입니다.');",
      "}",
      "",
    ].join("\n");
    writeFileSync(statsFile, stats, "utf8");
    writeFileSync(battleFile, battle, "utf8");

    const analyzeBattle = (): readonly unknown[] => {
      const analysis = analyzeChzSource(battle, battleFile);
      try {
        return analysis.diagnostics;
      } finally {
        analysis.dispose();
      }
    };

    // Before the dependency is realized the shim does not exist yet — the
    // documented first-realize gap (docs/20 NOTE).
    expect(analyzeBattle()).toEqual([
      expect.objectContaining({ code: "TS2307" }),
    ]);

    const doubler: ChzRealizer = {
      name: "DoublerRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        const implementation = join(context.outputDir, "implementations", `${symbol.name}.ts`);
        const test = join(context.outputDir, "tests", `test_${symbol.name}.autogen.ts`);
        mkdirSync(dirname(implementation), { recursive: true });
        mkdirSync(dirname(test), { recursive: true });
        writeFileSync(
          implementation,
          `export function ${symbol.name}(n: number): number { return n * 2; }\n`,
          "utf8",
        );
        writeFileSync(test, "export {};\n", "utf8");
        return {
          outcome: "resolved",
          symbol,
          resolvedFile: implementation,
          resolvedTestFiles: [test],
          resolvedAt: new Date(),
          resolvedBy: "doubler-model",
        };
      },
    };

    const result = await realizeSource(stats, statsFile, {
      realizers: [doubler],
      projectRoot: root,
      skipVerification: true,
    });
    expect(result.outcome).toBe("resolved");

    // The shim closes the gap: `./stats` now resolves through standard
    // TypeScript rules, exposing the human constant and the realized symbol
    // alike (docs/20).
    expect(analyzeBattle()).toEqual([]);
  });

  it("overwrites a shim it wrote itself", async () => {
    const data = fixture();
    writeFileSync(
      join(data.root, "sample.ts"),
      "/// stale — AUTO-GENERATED by chz realize. Do not edit.\nexport * from './nowhere';\n",
      "utf8",
    );

    const result = await realizeSource(data.source, data.sourceFile, {
      realizers: [new RetryingEngineRealizer()],
      projectRoot: data.root,
      skipVerification: true,
    });

    expect(result.outcome).toBe("resolved");
    expect(readFileSync(join(data.root, "sample.ts"), "utf8")).toContain(
      './chz/realization/sample/implementation"',
    );
  });
});

describe("parallel realize (-j)", () => {
  const green = async () => ({ passed: true, output: "green" });
  const wait = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

  function trioFixture(gammaRequirements: string): { root: string; sourceFile: string; source: string } {
    const root = mkdtempSync(join(tmpdir(), "chz-parallel-"));
    roots.push(root);
    const sourceFile = join(root, "trio.chz.ts");
    const source = ["alpha", "beta", "gamma"]
      .map((name) => [
        `imagine function ${name}(input: string): string {`,
        `  requirements(\`${name === "gamma" ? gammaRequirements : `${name}를 계산합니다.`}\`);`,
        "}",
        "",
      ].join("\n"))
      .join("\n");
    writeFileSync(sourceFile, source, "utf8");
    return { root, sourceFile, source };
  }

  function writingRealizer(onSession: (name: string) => Promise<void>): ChzRealizer {
    return {
      name: "ParallelProbeRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        await onSession(symbol.name);
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
          resolvedAt: new Date("2026-07-24T00:00:00.000Z"),
          resolvedBy: "parallel-model",
        };
      },
    };
  }

  it("runs independent groups concurrently within the jobs budget, keeping stable output order", async () => {
    const { root, sourceFile, source } = trioFixture("감마를 계산합니다.");
    let active = 0;
    let maxActive = 0;
    const realizer = writingRealizer(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await wait(25);
      active--;
    });

    const result = await realizeSource(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      jobs: 2,
      verify: green,
      verifyRealization: green,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (result.outcome !== "resolved") throw new Error(result.reason);
    expect(maxActive).toBe(2);
    // Completion order is racy; the reported order must stay source order.
    expect(result.symbols.map((symbol) => symbol.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.resolutions.map((resolution) => resolution.symbol.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("starts a dependent only after its dependency settled, even with spare workers", async () => {
    const { root, sourceFile, source } = trioFixture("alpha를 사용합니다.");
    const events: string[] = [];
    const realizer = writingRealizer(async (name) => {
      events.push(`start:${name}`);
      await wait(name === "alpha" ? 30 : 5);
      events.push(`end:${name}`);
    });

    const result = await realizeSource(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      jobs: 4,
      verify: green,
      verifyRealization: green,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (result.outcome !== "resolved") throw new Error(result.reason);
    expect(events.indexOf("end:alpha")).toBeLessThan(events.indexOf("start:gamma"));
  });

  it("serializes concurrent AskUser batches so the human answers one at a time", async () => {
    const { root, sourceFile, source } = trioFixture("감마를 계산합니다.");
    let answering = 0;
    let maxAnswering = 0;
    const askUser = async (questions: readonly { question: string }[]) => {
      answering++;
      maxAnswering = Math.max(maxAnswering, answering);
      await wait(15);
      answering--;
      return questions.map(() => ["첫 번째 선택"]);
    };

    const realizer: ChzRealizer = {
      name: "AskingRealizer",
      supportedSymbolTypes: ["function"],
      async realize(symbol, context) {
        const answers = await context.askUser?.([
          {
            question: `${symbol.name}의 정책은?`,
            header: "정책",
            options: [
              { label: "첫 번째 선택", description: "기본" },
              { label: "두 번째 선택", description: "대안" },
            ],
          },
        ]);
        expect(answers).toEqual([["첫 번째 선택"]]);
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
          resolvedAt: new Date("2026-07-24T00:00:00.000Z"),
          resolvedBy: "asking-model",
        };
      },
    };

    const result = await realizeSource(source, sourceFile, {
      realizers: [realizer],
      projectRoot: root,
      jobs: 3,
      askUser,
      verify: green,
      verifyRealization: green,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    if (result.outcome !== "resolved") throw new Error(result.reason);
    // Three sessions asked concurrently; the human saw one batch at a time.
    expect(maxAnswering).toBe(1);
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
    const result = await realizeSource(source, sourceFile, {
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
    const firstCacheData = JSON.parse(firstCache) as RealizationCache;

    const realizer = new CountingSlugRealizer();
    const retests: string[][] = [];
    const second = await realizeSource(source, sourceFile, {
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
    expect(rewritten.symbols.slugify?.publicSurfaceHash)
      .toBe(firstCacheData.symbols.slugify?.publicSurfaceHash);
    expect(rewritten.symbols.buildUniqueSlugs?.publicSurfaceHash)
      .toBe(firstCacheData.symbols.buildUniqueSlugs?.publicSurfaceHash);
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
    const second = await realizeSource(edited, sourceFile, {
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
    const second = await realizeSource(edited, sourceFile, {
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
    const second = await realizeSource(edited, sourceFile, {
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
    const second = await realizeSource(shifted, sourceFile, {
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
    const second = await realizeSource(source, sourceFile, {
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
    const second = await realizeSource(edited, sourceFile, {
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
    const second = await realizeSource(edited, sourceFile, {
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
    const second = await realizeSource(source, sourceFile, {
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
    const second = await realizeSource(source, sourceFile, {
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
    const second = await realizeSource(source, sourceFile, {
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
