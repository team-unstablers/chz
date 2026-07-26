import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeChzSource } from "./compiler/index.ts";
import { splitHumanCode } from "./human-code.ts";
import { imagineSpecsFromChzSource } from "./preprocessor.ts";
import { renderEntryPoint } from "./realize.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function split(source: string) {
  const fileName = "/project/example.chz.ts";
  const analysis = analyzeChzSource(source, fileName);
  try {
    return splitHumanCode(analysis, imagineSpecsFromChzSource(analysis));
  } finally {
    analysis.dispose();
  }
}

function relativeSpecifier(fromFile: string, target: string): string {
  let value = relative(dirname(fromFile), target).split(sep).join("/");
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

describe("splitHumanCode", () => {
  it("splits direct and transitive imagine references into the epilogue", () => {
    const source = [
      'const prefix = "Ahoy";',
      "function decorate(name: string): string { return `${prefix}, ${name}!`; }",
      "imagine function greet(name: string): string {",
      "  requirements(`이름을 반환합니다.`);",
      "}",
      'const message = greet("Cheese");',
      "console.log(decorate(message));",
      "",
    ].join("\n");

    const result = split(source);

    expect(result.prologue).toContain('const prefix = "Ahoy";');
    expect(result.prologue).toContain("function decorate");
    expect(result.prologue).toContain("export { prefix, decorate };");
    expect(result.prologue).not.toContain("const message");
    expect(result.epilogue).toContain(
      'import { prefix, decorate } from "./__prologue__.ts";',
    );
    expect(result.epilogue).toContain('import { greet } from "./greet.ts";');
    expect(result.epilogue).toContain('const message = greet("Cheese");');
    expect(result.epilogue).toContain("console.log(decorate(message));");
    expect(result.epilogue).not.toContain("imagine function");
  });

  it("does not mistake strings, property names, or shadowed parameters for imagine references", () => {
    const source = [
      'const label = "greet";',
      'const object = { greet: "property" };',
      "function shadow(greet: string): string { return greet; }",
      "imagine function greet(name: string): string { requirements(`인사합니다.`); }",
      "console.log(label, object.greet, shadow(label));",
      "",
    ].join("\n");

    const result = split(source);

    expect(result.prologue).toContain("console.log(label, object.greet, shadow(label));");
    expect(result.epilogue).toBe("export {};\n");
  });

  it("keeps existing named exports without emitting a conflicting duplicate export", () => {
    const source = [
      'export const prefix = "Hi";',
      "imagine function greet(): string { requirements(`인사합니다.`); }",
      "console.log(prefix, greet());",
      "",
    ].join("\n");

    const result = split(source);

    expect(result.prologue).toContain('export const prefix = "Hi";');
    expect(result.prologue).not.toContain("export { prefix };");
    expect(result.epilogue).toContain('import { prefix } from "./__prologue__.ts";');
  });

  it("emits valid empty modules when the source contains only imagine declarations", () => {
    const source = "imagine function greet(): string { requirements(`인사합니다.`); }\n";

    expect(split(source)).toEqual({
      prologue: "export {};\n",
      epilogue: "export {};\n",
      entryPoint: {
        named: [],
        star: [],
        default: null,
      },
      humanSymbolLayers: new Map(),
    });
  });

  it("keeps standalone comments while still marking the prologue as a module", () => {
    const source = [
      "// Human-owned source documentation.",
      "imagine function greet(): string { requirements(`인사합니다.`); }",
      "",
    ].join("\n");

    expect(split(source).prologue).toBe(
      "// Human-owned source documentation.\n\nexport {};\n",
    );
  });

  it("moves construction and imagined class method calls into the epilogue", () => {
    const source = [
      'const label = "counter";',
      "imagine class Counter {",
      "  imagine async increment(by: number): Promise<number> {",
      "    requirements(`값을 증가시킵니다.`);",
      "  }",
      "}",
      "const counter = new Counter();",
      "void counter.increment(2);",
      "console.log(label, counter);",
      "",
    ].join("\n");

    const result = split(source);

    expect(result.prologue).toContain('const label = "counter";');
    expect(result.prologue).not.toContain("new Counter");
    expect(result.epilogue).toContain('import { Counter } from "./Counter.ts";');
    expect(result.epilogue).toContain("const counter = new Counter();");
    expect(result.epilogue).toContain("void counter.increment(2);");
    expect(result.epilogue).not.toContain("imagine class");
  });

  it("rewrites only relative TypeScript module specifiers in both human layers", () => {
    const root = mkdtempSync(join(tmpdir(), "chz-human-rewrite-"));
    roots.push(root);
    const fileName = join(root, "nested", "sample.chz.ts");
    const target = join(root, "nested", "dependency.ts");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "export const dependency = 1;\n", "utf8");
    const source = [
      'import type { Dependency } from "./dependency.ts";',
      'import { dependency as aliased } from "./dependency.ts";',
      'import "./dependency.ts";',
      'export { dependency as forwarded } from "./dependency.ts";',
      'import legacy = require("./dependency.ts");',
      'void import(`./dependency.ts`);',
      'const commonJs = require("./dependency.ts");',
      'void import("@app/dependency");',
      'void import("/absolute/dependency.ts");',
      'void import("bare-package");',
      "",
    ].join("\n");
    const analysis = analyzeChzSource(source, fileName);
    try {
      const result = splitHumanCode(analysis, []);
      const prologueFile = join(
        root,
        "nested",
        "chz",
        "realization",
        "sample",
        "implementations",
        "__prologue__.ts",
      );
      const rewritten = relativeSpecifier(prologueFile, target);

      expect(result.prologue).toContain(`from ${JSON.stringify(rewritten)}`);
      expect(result.prologue).toContain(`import ${JSON.stringify(rewritten)};`);
      expect(result.prologue).toContain(`require(${JSON.stringify(rewritten)})`);
      expect(result.prologue).toContain(`import(${JSON.stringify(rewritten)})`);
      // A bare CommonJS require is detected by the shared traversal for graph
      // and lint policy, but §4.5 does not give it a relocation contract.
      expect(result.prologue).toContain(
        'const commonJs = require("./dependency.ts");',
      );
      expect(result.prologue).toContain('import("@app/dependency")');
      expect(result.prologue).toContain('import("/absolute/dependency.ts")');
      expect(result.prologue).toContain('import("bare-package")');
    } finally {
      analysis.dispose();
    }
  });

  it("resolves the rewritten cross-file example to the original shim target", () => {
    const root = mkdtempSync(join(tmpdir(), "chz-cross-file-rewrite-"));
    roots.push(root);
    const sourceFile = join(root, "battle.chz.ts");
    const shimFile = join(root, "stats.ts");
    const source = readFileSync(
      resolve("examples/chz-import/battle.chz.ts"),
      "utf8",
    );
    writeFileSync(sourceFile, source, "utf8");
    writeFileSync(
      shimFile,
      [
        "export interface CombatStats { attack: number; defense: number; luck: number; }",
        "export function 크리티컬_판정(_stats: CombatStats): boolean { return false; }",
        "",
      ].join("\n"),
      "utf8",
    );
    const analysis = analyzeChzSource(source, sourceFile);
    try {
      expect(analysis.diagnostics).toEqual([]);
      const result = splitHumanCode(
        analysis,
        imagineSpecsFromChzSource(analysis),
      );
      const prologueFile = join(
        root,
        "chz",
        "realization",
        "battle",
        "implementations",
        "__prologue__.ts",
      );
      const rewritten = relativeSpecifier(
        prologueFile,
        join(root, "stats"),
      );

      expect(result.prologue).toContain(`from ${JSON.stringify(rewritten)}`);
      expect(resolve(dirname(prologueFile), rewritten)).toBe(
        resolve(dirname(sourceFile), "./stats"),
      );
    } finally {
      analysis.dispose();
    }
  });

  it("rewrites a relative dynamic import after its statement moves to the epilogue", () => {
    const root = mkdtempSync(join(tmpdir(), "chz-epilogue-rewrite-"));
    roots.push(root);
    const fileName = join(root, "sample.chz.ts");
    const target = join(root, "dependency.ts");
    writeFileSync(target, "export const dependency = 1;\n", "utf8");
    const source = [
      "imagine function greet(): string {}",
      'void import("./dependency.ts").then(() => greet());',
      "",
    ].join("\n");
    const analysis = analyzeChzSource(source, fileName);
    try {
      const result = splitHumanCode(
        analysis,
        imagineSpecsFromChzSource(analysis),
      );
      const epilogueFile = join(
        root,
        "chz",
        "realization",
        "sample",
        "implementations",
        "__epilogue__.ts",
      );
      const rewritten = relativeSpecifier(epilogueFile, target);

      expect(result.epilogue).toContain(
        `import(${JSON.stringify(rewritten)})`,
      );
      expect(resolve(dirname(epilogueFile), rewritten)).toBe(target);
    } finally {
      analysis.dispose();
    }
  });

  it("classifies every export form without exposing internal bridge exports", () => {
    const root = mkdtempSync(join(tmpdir(), "chz-human-exports-"));
    roots.push(root);
    const fileName = join(root, "exports.chz.ts");
    writeFileSync(
      join(root, "dependency.ts"),
      [
        "export interface ExternalType {}",
        "export const externalValue = 1;",
        "",
      ].join("\n"),
      "utf8",
    );
    const source = [
      "interface PrivateType {}",
      "interface PublicType {}",
      "const privateValue = 1;",
      "const publicValue = 2;",
      "export { publicValue };",
      "export { publicValue as aliasedValue };",
      "export type { PublicType };",
      'export * from "./dependency.ts";',
      'export * as dependencyNamespace from "./dependency.ts";',
      "export default publicValue;",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(source, fileName);
    try {
      const result = splitHumanCode(analysis, []);
      expect(result.entryPoint.named).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importedName: "publicValue",
            exportedName: "publicValue",
            typeOnly: false,
          }),
          expect.objectContaining({
            importedName: "aliasedValue",
            exportedName: "aliasedValue",
            typeOnly: false,
          }),
          expect.objectContaining({
            importedName: "PublicType",
            exportedName: "PublicType",
            typeOnly: true,
          }),
          expect.objectContaining({
            importedName: "dependencyNamespace",
            exportedName: "dependencyNamespace",
            typeOnly: false,
          }),
        ]),
      );
      expect(result.entryPoint.star).toHaveLength(1);
      expect(result.entryPoint.star[0]?.rendered).toContain("export * from");
      expect(result.entryPoint.default).toEqual({
        layer: "prologue",
        typeOnly: false,
      });
      expect(
        result.entryPoint.named.some((item) =>
          item.exportedName === "privateValue" ||
          item.exportedName === "PrivateType"
        ),
      ).toBe(false);
      // Internal bridge exports remain in the prologue for realized code, but
      // are intentionally absent from the entrypoint metadata.
      expect(result.prologue).toContain("privateValue");
      expect(result.prologue).toContain("PrivateType");

      const entryPoint = renderEntryPoint(analysis, result, []);
      const entryPointFile = join(
        root,
        "chz",
        "realization",
        "exports",
        "implementation.ts",
      );
      const rewritten = relativeSpecifier(
        entryPointFile,
        join(root, "dependency.ts"),
      );
      expect(entryPoint).toContain(
        `export * from ${JSON.stringify(rewritten)}`,
      );
      expect(entryPoint).toContain(
        'export { publicValue, aliasedValue, dependencyNamespace } from "./implementations/__prologue__.ts";',
      );
      expect(entryPoint).toContain(
        'export type { PublicType } from "./implementations/__prologue__.ts";',
      );
      expect(entryPoint).toContain(
        'export { default } from "./implementations/__prologue__.ts";',
      );
      expect(entryPoint).not.toContain(
        'export * from "./implementations/__prologue__.ts"',
      );
    } finally {
      analysis.dispose();
    }
  });

  it("forwards an export-default declaration without exposing its local name", () => {
    const source = [
      "export default function internalDefault(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const fileName = "/project/default-export.chz.ts";
    const analysis = analyzeChzSource(source, fileName);
    try {
      const result = splitHumanCode(analysis, []);
      const entryPoint = renderEntryPoint(analysis, result, []);

      expect(result.prologue).toContain(
        "export default function internalDefault()",
      );
      expect(result.prologue).toContain("export { internalDefault };");
      expect(entryPoint).toContain(
        'export { default } from "./implementations/__prologue__.ts";',
      );
      expect(entryPoint).not.toContain("internalDefault");
    } finally {
      analysis.dispose();
    }
  });
});
