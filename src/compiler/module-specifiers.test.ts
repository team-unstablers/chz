import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  analyzeChzSource,
  collectModuleReferences,
  collectModuleSpecifiersFromSource,
} from "./index.ts";

function referencesOf(source: string) {
  const analysis = analyzeChzSource(
    source,
    resolve("module-specifiers-test.ts"),
  );
  try {
    return collectModuleReferences(
      analysis.typescript.sourceFile,
      analysis.typescript.checker,
    ).map((reference) => ({
      kind: reference.kind,
      text: reference.specifier?.text ?? null,
    }));
  } finally {
    analysis.dispose();
  }
}

describe("shared TypeScript module-specifier traversal", () => {
  it("collects every supported module form and preserves source order", () => {
    const source = [
      'import type { Stats as ImportedStats } from "./types.ts";',
      'import { value as aliasedValue } from "./value.ts";',
      'import "./side-effect.ts";',
      'export { helper as exportedHelper } from "./helper.ts";',
      'import legacy = require("./legacy.ts");',
      'void import("./lazy.ts");',
      "void import(`./static-template.ts`);",
      'const commonJs = require("./common-js.ts");',
      "void ImportedStats;",
      "void aliasedValue;",
      "void commonJs;",
      "",
    ].join("\n");

    expect(referencesOf(source)).toEqual([
      { kind: "import", text: "./types.ts" },
      { kind: "import", text: "./value.ts" },
      { kind: "import", text: "./side-effect.ts" },
      { kind: "export", text: "./helper.ts" },
      { kind: "import-equals", text: "./legacy.ts" },
      { kind: "dynamic-import", text: "./lazy.ts" },
      { kind: "dynamic-import", text: "./static-template.ts" },
      { kind: "require", text: "./common-js.ts" },
    ]);
  });

  it("ignores shadowed require, member calls, and matching property strings", () => {
    const source = [
      'const real = require("./real.ts");',
      "function load(require: (name: string) => unknown): unknown {",
      '  return require("./shadowed.ts");',
      "}",
      'const member = loader.require("./member.ts");',
      'const record = { from: "./property.ts", import: "./also-property.ts" };',
      "void real;",
      "void load;",
      "void member;",
      "void record;",
      "",
    ].join("\n");

    expect(collectModuleSpecifiersFromSource(source)).toEqual([
      "./real.ts",
    ]);
  });
});

describe("Phase 3a static diagnostics and profile AST", () => {
  it("diagnoses a non-static dynamic import with CHZ3001", () => {
    const source = [
      'const moduleName = "./lazy.ts";',
      "void import(moduleName);",
      "imagine function value(): number {}",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("dynamic-import-diagnostic.chz.ts"),
    );
    try {
      expect(analysis.diagnostics).toMatchObject([
        {
          code: "CHZ3001",
          namespace: "static-rule",
          line: 2,
          column: 13,
        },
      ]);
      expect(analysis.diagnostics[0]?.message).toContain(
        "string literal or a template literal without substitutions",
      );
    } finally {
      analysis.dispose();
    }
  });

  it("diagnoses a non-static dynamic import inside an origin-mapped ensure island", () => {
    const source = [
      "imagine function value(): Promise<number> {",
      '  ensure("loads", async () => {',
      '    const moduleName = "./lazy.ts";',
      "    await import(moduleName);",
      "  });",
      "}",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("dynamic-import-island.chz.ts"),
    );
    try {
      expect(analysis.diagnostics).toMatchObject([
        {
          code: "CHZ3001",
          line: 4,
          column: 18,
        },
      ]);
    } finally {
      analysis.dispose();
    }
  });

  it("ignores fake @profile text in comments, strings, templates, and regex", () => {
    const source = [
      "// @profile comment",
      'const text = "@profile string";',
      "const template = `@profile template`;",
      "const regex = /@profile\\s+regex/u;",
      "@profile server",
      "imagine function value(): number {}",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("profile-false-positive.chz.ts"),
    );
    try {
      expect(analysis.profile?.name).toBe("server");
      expect(analysis.profile?.span.start).toBe(source.indexOf("@profile server"));
    } finally {
      analysis.dispose();
    }
  });

  it("does not invent a profile when every occurrence is lexical trivia", () => {
    const source = [
      "// @profile comment",
      'const text = "@profile string";',
      "imagine function value(): number {}",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("profile-none.chz.ts"),
    );
    try {
      expect(analysis.profile).toBeNull();
    } finally {
      analysis.dispose();
    }
  });
});
