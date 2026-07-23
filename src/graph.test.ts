import { describe, expect, it } from "vitest";

import {
  ChzCycleError,
  buildDependencyGraph,
  buildEstimatedRealizeOrder,
  extractConfirmedDependencies,
  extractModuleSpecifiers,
  mentionedSymbols,
  mentionsSymbol,
} from "./graph.ts";
import { extractImagineSpecs } from "./preprocessor.ts";

function specsOf(source: string) {
  return extractImagineSpecs(source, "graph-test.chz.ts");
}

function imagineFunction(name: string, requirements: string): string {
  return [
    `imagine function ${name}(input: string): string {`,
    `  requirements(\`${requirements}\`);`,
    "}",
    "",
  ].join("\n");
}

describe("mentionsSymbol", () => {
  it("never matches inside a longer ASCII identifier", () => {
    expect(mentionsSymbol("slugify('x')", "slug")).toBe(false);
    expect(mentionsSymbol("slugify('x')", "slugify")).toBe(true);
    expect(mentionsSymbol("buildUniqueSlugs(titles)", "Slugs")).toBe(false);
    expect(mentionsSymbol("const a = deslug;", "slug")).toBe(false);
  });

  it("matches Korean names even with an attached particle", () => {
    expect(mentionsSymbol("크리티컬_판정을 사용하여 판정하십시오.", "크리티컬_판정")).toBe(true);
    expect(mentionsSymbol("`크리티컬_판정`을 사용하십시오.", "크리티컬_판정")).toBe(true);
  });

  it("matches at text boundaries and after punctuation", () => {
    expect(mentionsSymbol("slugify", "slugify")).toBe(true);
    expect(mentionsSymbol("(slugify)", "slugify")).toBe(true);
    expect(mentionsSymbol("", "slugify")).toBe(false);
  });
});

describe("mentionedSymbols", () => {
  it("never counts a longer known name as a mention of its substring", () => {
    expect(mentionedSymbols("판정기를 사용하십시오.", ["판정", "판정기"])).toEqual(["판정기"]);
    expect(mentionedSymbols("판정을 사용하십시오.", ["판정", "판정기"])).toEqual(["판정"]);
    expect(mentionedSymbols("판정기와 판정을 모두 사용합니다.", ["판정", "판정기"])).toEqual([
      "판정",
      "판정기",
    ]);
  });
});

describe("buildDependencyGraph", () => {
  it("orders groups dependencies-first from requirements mentions", () => {
    const source = [
      imagineFunction("전투_시뮬레이션", "데미지_계산을 반복 호출합니다."),
      imagineFunction("데미지_계산", "크리티컬_판정을 사용합니다."),
      imagineFunction("크리티컬_판정", "운에 따라 판정합니다."),
    ].join("\n");
    const graph = buildDependencyGraph(specsOf(source), source, "graph-test.chz.ts");

    expect(graph.groups.map((group) => group.symbols.map((symbol) => symbol.name))).toEqual([
      ["크리티컬_판정"],
      ["데미지_계산"],
      ["전투_시뮬레이션"],
    ]);
    expect(graph.warnings).toEqual([]);
    const 데미지 = graph.symbols.find((symbol) => symbol.name === "데미지_계산")!;
    expect(데미지.dependencies.map((dependency) => dependency.name)).toEqual(["크리티컬_판정"]);
    expect(데미지.circularDependencies).toEqual([]);
  });

  it("does not invent an edge from an ASCII identifier prefix", () => {
    const source = [
      imagineFunction("slug", "한 단어를 정규화합니다."),
      imagineFunction("slugify", "문자열 전체를 슬러그로 만듭니다."),
    ].join("\n");
    const graph = buildDependencyGraph(specsOf(source), source, "graph-test.chz.ts");

    for (const symbol of graph.symbols) {
      expect(symbol.dependencies).toEqual([]);
    }
    expect(graph.groups.map((group) => group.symbols[0]!.name)).toEqual(["slug", "slugify"]);
  });

  it("does not manufacture a cycle from a symbol's own declaration header", () => {
    // 판정기's own header contains 판정 as a prefix; without longer-name
    // shadowing this produced a phantom 판정기 → 판정 edge and a false cycle.
    const source = [
      imagineFunction("판정", "판정기를 사용해 결과를 집계합니다."),
      imagineFunction("판정기", "단일 입력을 판별합니다."),
    ].join("\n");
    const graph = buildDependencyGraph(specsOf(source), source, "graph-test.chz.ts");

    const 판정 = graph.symbols.find((symbol) => symbol.name === "판정")!;
    const 판정기 = graph.symbols.find((symbol) => symbol.name === "판정기")!;
    expect(판정.dependencies.map((dependency) => dependency.name)).toEqual(["판정기"]);
    expect(판정기.dependencies).toEqual([]);
    expect(graph.warnings).toEqual([]);
    expect(graph.groups.map((group) => group.symbols[0]!.name)).toEqual(["판정기", "판정"]);
  });

  it("groups a dependency cycle into one warned session unit", () => {
    const source = [
      imagineFunction("짝수_판정", "0이면 참, 아니면 홀수_판정(n - 1)을 반환합니다."),
      imagineFunction("홀수_판정", "0이면 거짓, 아니면 짝수_판정(n - 1)을 반환합니다."),
    ].join("\n");
    const graph = buildDependencyGraph(specsOf(source), source, "graph-test.chz.ts");

    expect(graph.groups).toHaveLength(1);
    const [group] = graph.groups;
    expect(group!.circular).toBe(true);
    expect(group!.symbols.map((symbol) => symbol.name)).toEqual(["짝수_판정", "홀수_판정"]);
    expect(group!.symbols[0]!.circularDependencies.map((symbol) => symbol.name)).toEqual([
      "홀수_판정",
    ]);
    expect(graph.warnings).toHaveLength(1);
    expect(graph.warnings[0]).toContain("짝수_판정");
    expect(graph.warnings[0]).toContain("홀수_판정");
  });

  it("fails a cycle larger than the configured cap with a recovery hint", () => {
    const names = ["a단계", "b단계", "c단계", "d단계"];
    const source = names
      .map((name, index) =>
        imagineFunction(name, `${names[(index + 1) % names.length]}를 사용합니다.`),
      )
      .join("\n");

    expect(() => buildDependencyGraph(specsOf(source), source, "graph-test.chz.ts")).toThrow(
      ChzCycleError,
    );
    expect(() => buildDependencyGraph(specsOf(source), source, "graph-test.chz.ts")).toThrow(
      "human-owned interface",
    );
    const graph = buildDependencyGraph(specsOf(source), source, "graph-test.chz.ts", {
      maxCycleSize: 4,
    });
    expect(graph.groups).toHaveLength(1);
    expect(graph.groups[0]!.symbols).toHaveLength(4);
  });

  it("keeps buildEstimatedRealizeOrder flat and tolerant of any cycle size", () => {
    const names = ["a단계", "b단계", "c단계", "d단계"];
    const source = names
      .map((name, index) =>
        imagineFunction(name, `${names[(index + 1) % names.length]}를 사용합니다.`),
      )
      .join("\n");

    const order = buildEstimatedRealizeOrder(specsOf(source), source, "graph-test.chz.ts");
    expect(order.map((symbol) => symbol.name)).toEqual(names);
  });
});

describe("extractModuleSpecifiers", () => {
  it("collects every static, side-effect, dynamic, and require specifier", () => {
    const source = [
      'import { slugify } from "./slugify.ts";',
      'import type { Title } from "./__prologue__.ts";',
      'import "./side-effect.ts";',
      'export { helper } from "../implementations/helper.ts";',
      'const lazy = await import("./lazy.ts");',
      'const legacy = require("./legacy.ts");',
      "",
    ].join("\n");

    expect(extractModuleSpecifiers(source)).toEqual([
      "./slugify.ts",
      "./__prologue__.ts",
      "./side-effect.ts",
      "../implementations/helper.ts",
      "./lazy.ts",
      "./legacy.ts",
    ]);
  });

  it("stays synchronized across regex literals containing quotes", () => {
    const source = [
      'const stripped = title.replace(/["\']/g, "");',
      "const QUOTE = /\"/;",
      "const half = total / 2;",
      "const ratio = 4 / count;",
      'const helper = require("./helper.ts");',
      "",
    ].join("\n");

    expect(extractModuleSpecifiers(source)).toEqual(["./helper.ts"]);
  });

  it("ignores commented-out imports and import-like strings", () => {
    const source = [
      '// import { gone } from "./gone.ts";',
      '/* import { gone } from "./also-gone.ts"; */',
      "const text = 'import { fake } from \"./fake.ts\"';",
      "const template = `import { fake } from \"./fake-template.ts\"`;",
      'const member = config.import("./member.ts");',
      "",
    ].join("\n");

    expect(extractModuleSpecifiers(source)).toEqual([]);
  });
});

describe("extractConfirmedDependencies", () => {
  it("maps sibling imports to known symbols and drops everything else", () => {
    const source = [
      "/// buildUniqueSlugs.ts — realized implementation.",
      'import { slugify } from "./slugify.ts";',
      'import type { Title } from "./__prologue__.ts";',
      'import { unknown } from "./unknown.ts";',
      'import { assert } from "node:assert";',
      "",
      "export function buildUniqueSlugs(titles: readonly string[]): string[] {",
      "  return titles.map((title) => slugify(title));",
      "}",
      "",
    ].join("\n");

    expect(
      extractConfirmedDependencies(source, "buildUniqueSlugs", ["slugify", "buildUniqueSlugs"]),
    ).toEqual(["slugify"]);
  });

  it("never maps a nested helper path to a symbol by basename", () => {
    const source = 'import { slugHelpers } from "./helpers/slugify.ts";\n';
    expect(
      extractConfirmedDependencies(source, "buildUniqueSlugs", ["slugify", "buildUniqueSlugs"]),
    ).toEqual([]);
  });

  it("excludes self-imports and sorts the confirmed edges", () => {
    const source = [
      'import { b } from "./b.ts";',
      'import { a } from "./a.ts";',
      'import { c } from "./c.ts";',
      "",
    ].join("\n");

    expect(extractConfirmedDependencies(source, "c", ["a", "b", "c"])).toEqual(["a", "b"]);
  });
});
