import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ChzSyntaxError,
  extractImagineSpecs,
  preprocess,
  realizationImportSpecifier,
  transformToPlainTs,
} from "./preprocessor.ts";

describe("extractImagineSpecs", () => {
  it("parses the Gomoku class example as one class realization", () => {
    const source = readFileSync(new URL("../examples/gomoku.chz.ts", import.meta.url), "utf8");
    const specs = extractImagineSpecs(source, "examples/gomoku.chz.ts");

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: "class", name: "GomokuGame" });
    expect(specs[0]!.members.map((member) => member.name)).toEqual(["start", "cleanup"]);
    expect(specs[0]!.members.every((member) => member.modifiers.includes("async"))).toBe(true);
  });

  it("① extracts a Korean-named function with mixed predicate/natural ensures", () => {
    const source = [
      "imagine function 충돌판정_2D(ax: number, ay: number, bx: number, by: number): boolean {",
      "  requirements(`두 도형 간 충돌 판정을 수행합니다.`);",
      "  ensure((args, retval) => typeof retval === 'boolean');",
      "  ensure(`겹치는 두 도형에 대해서는 true 를 반환해야 합니다.`);",
      "}",
    ].join("\n");

    const specs = extractImagineSpecs(source, "collide.chz.ts");
    expect(specs).toHaveLength(1);

    const spec = specs[0]!;
    expect(spec.type).toBe("function");
    expect(spec.members).toEqual([]);
    expect(spec.name).toBe("충돌판정_2D");
    expect(spec.parameters).toBe("ax: number, ay: number, bx: number, by: number");
    expect(spec.returnType).toBe("boolean");
    expect(spec.requirements).toBe("두 도형 간 충돌 판정을 수행합니다.");
    expect(spec.ensures).toEqual([
      { kind: "predicate", source: "(args, retval) => typeof retval === 'boolean'" },
      { kind: "natural", source: "`겹치는 두 도형에 대해서는 true 를 반환해야 합니다.`" },
    ]);
    expect(spec.originalText.startsWith("imagine function 충돌판정_2D")).toBe(true);
    expect(spec.originalText.endsWith("}")).toBe(true);
    expect(source.slice(spec.start, spec.end)).toBe(spec.originalText);
  });

  it("② handles an imagine function without requirements", () => {
    const source = "imagine function ping(): void {\n  ensure((a, r) => r === undefined);\n}\n";
    const specs = extractImagineSpecs(source, "ping.chz.ts");
    expect(specs).toHaveLength(1);
    expect(specs[0]!.requirements).toBeNull();
    expect(specs[0]!.returnType).toBe("void");
    expect(specs[0]!.ensures).toHaveLength(1);
    expect(specs[0]!.ensures[0]!.kind).toBe("predicate");
  });

  it("③ returns no specs for a file without imagine blocks", () => {
    const source = "const a = 1;\nfunction greet(n: string) { return `hi ${n}`; }\nexport { greet };\n";
    const specs = extractImagineSpecs(source, "plain.chz.ts");
    expect(specs).toEqual([]);
    // And transform is a byte-for-byte identity here.
    expect(transformToPlainTs(source, "plain.chz.ts", specs)).toBe(source);
  });

  it("④ ignores fake imagine blocks inside comments, strings and templates", () => {
    const source = [
      "// imagine function commented(): void { requirements(`x`); }",
      "/* imagine function blockCommented(): void {} */",
      'const s = "imagine function inString(): void {}";',
      "const t = `imagine function inTemplate(): void { ${ensure(`nope`)} }`;",
      "const u = `nested ${ `imagine function deeper() {}` }`;",
    ].join("\n");
    const specs = extractImagineSpecs(source, "fakes.chz.ts");
    expect(specs).toEqual([]);
  });

  it("⑤ balances nested braces inside a predicate body", () => {
    const source = [
      "imagine function classify(x: number): string {",
      "  ensure((args, retval) => {",
      "    if (retval === 'a') { return true; }",
      "    const map = { k: { deep: [1, 2, 3] } };",
      "    return typeof retval === 'string' && Object.keys(map).length > 0;",
      "  });",
      "}",
    ].join("\n");
    const specs = extractImagineSpecs(source, "classify.chz.ts");
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.ensures).toHaveLength(1);
    expect(spec.ensures[0]!.kind).toBe("predicate");
    // The whole arrow function, nested braces and all, is captured as one arg.
    expect(spec.ensures[0]!.source).toContain("{ k: { deep: [1, 2, 3] } }");
    expect(spec.requirements).toBeNull();
  });

  it("finds multiple top-level imagine functions while preserving order", () => {
    const source = [
      "const before = 1;",
      "imagine function first(): number { requirements(`첫 번째`); }",
      "const between = 2;",
      "imagine function second(a: string): string { ensure(`두 번째`); }",
      "const after = 3;",
    ].join("\n");
    const specs = extractImagineSpecs(source, "multi.chz.ts");
    expect(specs.map((s) => s.name)).toEqual(["first", "second"]);
  });

  it("does not mistake a `foo.imagine` member or an `imagine` variable for a declaration", () => {
    const source = "const imagine = 1;\nobj.imagine.function;\nlet x = imagine + 2;\n";
    expect(extractImagineSpecs(source, "ident.chz.ts")).toEqual([]);
  });

  it("extracts an imagine class and its imagined async methods and properties", () => {
    const source = [
      "imagine class GameSession {",
      "  requirements(`게임 세션을 관리합니다.`);",
      "  imagine readonly score: number {",
      "    requirements(`현재 점수입니다.`);",
      "  }",
      "  imagine static async create(name: string): Promise<GameSession> {",
      "    ensure((args, retval) => retval !== undefined);",
      "  }",
      "  imagine async cleanup() {",
      "    requirements(`리소스를 정리합니다.`);",
      "  }",
      "}",
    ].join("\n");

    const [spec] = extractImagineSpecs(source, "game.chz.ts");
    expect(spec).toMatchObject({
      type: "class",
      name: "GameSession",
      parameters: "",
      returnType: "",
      requirements: "게임 세션을 관리합니다.",
    });
    expect(spec!.members.map((member) => ({
      type: member.type,
      name: member.name,
      modifiers: member.modifiers,
      parameters: member.parameters,
      returnType: member.returnType,
    }))).toEqual([
      { type: "property", name: "score", modifiers: ["readonly"], parameters: "", returnType: "number" },
      {
        type: "method",
        name: "create",
        modifiers: ["static", "async"],
        parameters: "name: string",
        returnType: "Promise<GameSession>",
      },
      { type: "method", name: "cleanup", modifiers: ["async"], parameters: "", returnType: "" },
    ]);
    expect(spec!.members[0]!.requirements).toBe("현재 점수입니다.");
    expect(spec!.members[1]!.ensures).toEqual([
      { kind: "predicate", source: "(args, retval) => retval !== undefined" },
    ]);
    expect(spec!.members[2]!.requirements).toBe("리소스를 정리합니다.");
  });
});

describe("transformToPlainTs", () => {
  it("⑥ strips imagine blocks, inserts one import, and preserves the rest byte-for-byte", () => {
    const source = [
      "const header = 1;",
      "imagine function 충돌판정_2D(a: number, b: number): boolean {",
      "  requirements(`판정`);",
      "  ensure((args, retval) => typeof retval === 'boolean');",
      "}",
      "const middle = 2;",
      "imagine function greet(name: string): string {",
      "  ensure(`인사`);",
      "}",
      "const footer = 3;",
      "",
    ].join("\n");

    const output = transformToPlainTs(source, "example.chz.ts");

    // A single consolidated import at the very top.
    expect(output.startsWith(
      'import { 충돌판정_2D, greet } from "./chz/realization/example/implementation.ts";\n',
    )).toBe(true);
    // The imagine blocks are gone.
    expect(output).not.toContain("imagine function");
    expect(output).not.toContain("requirements(");
    expect(output).not.toContain("ensure(");
    // Every non-imagine line survives verbatim.
    expect(output).toContain("const header = 1;");
    expect(output).toContain("const middle = 2;");
    expect(output).toContain("const footer = 3;");
  });

  it("derives the realization import specifier from the file's base name", () => {
    expect(realizationImportSpecifier("example.chz.ts")).toBe(
      "./chz/realization/example/implementation.ts",
    );
    expect(realizationImportSpecifier("/abs/path/충돌.chz.ts")).toBe(
      "./chz/realization/충돌/implementation.ts",
    );
  });

  it("preprocess() returns both the specs and the transformed code", () => {
    const source = "imagine function f(): void { requirements(`r`); }\nconst tail = 0;\n";
    const { specs, code } = preprocess(source, "f.chz.ts");
    expect(specs).toHaveLength(1);
    expect(code).toContain('import { f } from "./chz/realization/f/implementation.ts";');
    expect(code).toContain("const tail = 0;");
    expect(code).not.toContain("imagine");
  });

  it("replaces an imagine class with a realization import", () => {
    const source = [
      "imagine class Counter {",
      "  imagine increment(): number { requirements(`증가합니다.`); }",
      "}",
      "const counter = new Counter();",
      "counter.increment();",
      "",
    ].join("\n");

    const output = transformToPlainTs(source, "counter.chz.ts");
    expect(output).toContain(
      'import { Counter } from "./chz/realization/counter/implementation.ts";',
    );
    expect(output).not.toContain("imagine class");
    expect(output).toContain("const counter = new Counter();");
  });
});

describe("error handling", () => {
  it("⑦ throws a ChzSyntaxError with file/line info for a second requirements()", () => {
    const source = [
      "imagine function bad(): void {",
      "  requirements(`first`);",
      "  requirements(`second`);",
      "}",
    ].join("\n");
    let caught: unknown;
    try {
      extractImagineSpecs(source, "bad.chz.ts");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChzSyntaxError);
    const err = caught as ChzSyntaxError;
    expect(err.fileName).toBe("bad.chz.ts");
    expect(err.line).toBe(3);
    expect(err.message).toContain("bad.chz.ts:3:");
    expect(err.message).toContain("requirements() may appear at most once");
  });

  it("throws for an unterminated imagine block", () => {
    const source = "imagine function oops(): void {\n  requirements(`x`);\n";
    expect(() => extractImagineSpecs(source, "oops.chz.ts")).toThrow(ChzSyntaxError);
  });

  it("keeps imagine resource explicitly deferred at top level and inside classes", () => {
    const topLevel = "imagine resource sprite: ImageAsset { requirements(`sprite`); }\n";
    const member = [
      "imagine class Game {",
      "  imagine resource sprite: ImageAsset { requirements(`sprite`); }",
      "}",
    ].join("\n");
    expect(() => extractImagineSpecs(topLevel, "sprite.chz.ts")).toThrow(/intentionally deferred/);
    expect(() => extractImagineSpecs(member, "game.chz.ts")).toThrow(/intentionally deferred/);
  });
});
