import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeChzSource } from "./index.ts";

const roots: string[] = [];

function moduleFixture(type: "module" | "commonjs"): {
  fileName: string;
  source: string;
} {
  const root = mkdtempSync(join(tmpdir(), `chz-module-${type}-`));
  roots.push(root);
  const fileName = join(root, "game.chz.ts");
  const source = [
    "imagine class Game {}",
    "const game = new Game();",
    "await game.start();",
    "",
  ].join("\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type }),
    "utf8",
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["*.ts"],
    }),
    "utf8",
  );
  writeFileSync(fileName, source, "utf8");
  return { fileName, source };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("semantic human-error preflight", () => {
  it("uses owner identity to separate imagine and human TS2339 in one file", () => {
    const source = [
      "imagine class Game {}",
      "const game = new Game();",
      "game.start();",
      "const human = { value: 1 };",
      "human.missing();",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("semantic-owner.chz.ts"),
    );
    try {
      expect(analysis.obligations).toMatchObject([
        {
          code: "TS2339",
          line: 3,
          column: 6,
        },
      ]);
      expect(analysis.diagnostics).toMatchObject([
        {
          code: "TS2339",
          line: 5,
          column: 7,
        },
      ]);
      expect(analysis.diagnostics[0]?.message).toContain(
        "This .chz.ts file is human-owned",
      );
    } finally {
      analysis.dispose();
    }
  });

  it("promotes the TS2551 spelling-suggestion variant only for an imagine owner", () => {
    const source = [
      "imagine class Game {",
      "  imagine start(): void {}",
      "}",
      "const game = new Game();",
      "game.strat();",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("semantic-owner-suggestion.chz.ts"),
    );
    try {
      expect(analysis.obligations.map((diagnostic) => diagnostic.code))
        .toEqual(["TS2551"]);
      expect(analysis.diagnostics).toEqual([]);
    } finally {
      analysis.dispose();
    }
  });

  it("keeps TS2304 as a human error because an unbound name has no owner", () => {
    const source = [
      "imagine class Game {}",
      "missingName();",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("semantic-unbound-name.chz.ts"),
    );
    try {
      expect(analysis.obligations).toEqual([]);
      expect(analysis.diagnostics).toMatchObject([
        {
          code: "TS2304",
          line: 2,
          column: 1,
        },
      ]);
    } finally {
      analysis.dispose();
    }
  });

  it("reports a human miscall against an imagine signature before realization", () => {
    const source = [
      "imagine function acceptsNumber(value: number): void {}",
      "acceptsNumber('not a number');",
      "",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("semantic-signature-miscall.chz.ts"),
    );
    try {
      expect(analysis.obligations).toEqual([]);
      expect(analysis.diagnostics).toMatchObject([
        {
          code: "TS2345",
          line: 2,
          column: 15,
        },
      ]);
    } finally {
      analysis.dispose();
    }
  });

  it("uses the visible package.json for NodeNext ESM/CJS top-level await", () => {
    const esm = moduleFixture("module");
    const cjs = moduleFixture("commonjs");
    const esmAnalysis = analyzeChzSource(esm.source, esm.fileName);
    const cjsAnalysis = analyzeChzSource(cjs.source, cjs.fileName);
    try {
      expect(esmAnalysis.obligations.map((diagnostic) => diagnostic.code))
        .toEqual(["TS2339"]);
      expect(esmAnalysis.diagnostics).toEqual([]);
      expect(cjsAnalysis.obligations.map((diagnostic) => diagnostic.code))
        .toEqual(["TS2339"]);
      expect(cjsAnalysis.diagnostics.map((diagnostic) => diagnostic.code))
        .toContain("TS1309");
      expect(cjsAnalysis.diagnostics[0]?.line).toBe(3);
      expect(cjsAnalysis.diagnostics[0]?.column).toBe(1);
    } finally {
      esmAnalysis.dispose();
      cjsAnalysis.dispose();
    }
  });
});
