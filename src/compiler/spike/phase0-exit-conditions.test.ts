import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  API,
  createVirtualFileSystem,
} from "../ts-api.ts";
import {
  analyzeChzSource,
  scriptKindForFileName,
} from "./index.ts";

interface ComparableDiagnostic {
  code: string;
  offset: number;
  message: string;
}

function directTypeScriptDiagnostics(
  source: string,
  fileName: string,
): ComparableDiagnostic[] {
  const absoluteFileName = resolve(fileName);
  const api = new API({
    cwd: resolve("."),
    fs: createVirtualFileSystem({ [absoluteFileName]: source }),
  });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openFiles: [absoluteFileName] });
    const project = snapshot.getDefaultProjectForFile(absoluteFileName);
    if (project === undefined) {
      throw new Error(`TypeScript did not create a project for ${fileName}.`);
    }
    return project.program.getSyntacticDiagnostics(absoluteFileName).map(
      (diagnostic) => ({
        code: `TS${diagnostic.code}`,
        offset: Math.max(0, diagnostic.pos),
        message: diagnostic.text,
      }),
    );
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

function cheeseTypeScriptDiagnostics(
  source: string,
  fileName: string,
): ComparableDiagnostic[] {
  const analysis = analyzeChzSource(source, fileName);
  try {
    return analysis.diagnostics.map(({ code, offset, message }) => ({
      code,
      offset,
      message,
    }));
  } finally {
    analysis.dispose();
  }
}

describe("Phase 0 explicit exit conditions", () => {
  it("exit condition 1: parses every official examples/**/*.chz.ts file", () => {
    const files = globSync("examples/**/*.chz.ts").sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const analysis = analyzeChzSource(readFileSync(file, "utf8"), file);
      try {
        expect(analysis.diagnostics, file).toEqual([]);
        expect(analysis.imagineDeclarations.length, file).toBeGreaterThan(0);
      } finally {
        analysis.dispose();
      }
    }
  });

  it("exit condition 2: parses every legacy preprocessor known limitation", () => {
    const source = String.raw`
const regex = /[{}] imagine function ghost\(\): void \{\}/u;
const division = 20 / 4;

export imagine function project<T extends { id: string }>(
  value: T,
): Promise<{ value: T; nested: { ok: boolean } }> {
  requirements("Project the generic object.");
  ensure(regex.test(String(division)) === false);
}
`;
    const analysis = analyzeChzSource(
      source,
      resolve("phase0-known-limitations.chz.ts"),
    );
    try {
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.imagineDeclarations.map((declaration) => declaration.name))
        .toEqual(["project"]);
      expect(analysis.imagineDeclarations[0]?.exported).toBe(true);
      expect(analysis.projection.source).toHaveLength(source.length);
    } finally {
      analysis.dispose();
    }
  });

  it("exit condition 3: diagnoses duplicate imagine at the second token", () => {
    const source = "imagine imagine imagine function x(): number { requirements('x'); }\n";
    const secondImagine = source.indexOf("imagine", "imagine".length);
    const analysis = analyzeChzSource(
      source,
      resolve("phase0-duplicate.chz.ts"),
    );
    try {
      expect(analysis.diagnostics).toHaveLength(1);
      expect(analysis.diagnostics[0]).toMatchObject({
        code: "CHZ1001",
        offset: secondImagine,
        line: 1,
        column: 9,
      });
    } finally {
      analysis.dispose();
    }
  });

  it("exit condition 4: exactly preserves TypeScript diagnostics for plain TS", () => {
    const fragments = [
      "const valid: { value: number } = { value: 1 };\n",
      "function generic<T>(value: T): T { return value; }\n",
      "const broken: = 1;\n",
      "const regex = /imagine function fake\\(\\) \\{\\}/u; const n = 8 / 2;\n",
      "const nested = `outer ${`inner ${1 + 1}`}`;\n",
      "void import('./data.json', { with: { type: 'json' } });\n",
    ];

    for (const [index, source] of fragments.entries()) {
      const fileName = resolve(`phase0-parity-${index}.ts`);
      expect(cheeseTypeScriptDiagnostics(source, fileName)).toEqual(
        directTypeScriptDiagnostics(source, fileName),
      );
    }
  });
});

describe("Phase 0 lexical false-positive guard", () => {
  const cases = [
    ["line comment", "// imagine function fake(): void {}\nconst value = 1;\n"],
    ["block comment", "/* imagine class Fake {} */\nconst value = 1;\n"],
    ["string", "const value = 'imagine function fake(): void {}';\n"],
    ["template", "const value = `imagine class Fake ${`imagine function nested() {}`}`;\n"],
    ["regex", "const value = /imagine function fake\\(\\) \\{\\}/u;\n"],
  ] as const;

  it.each(cases)(
    "does not commit imagine text inside a %s",
    (_label, source) => {
      const fileName = resolve("phase0-false-positive.ts");
      const analysis = analyzeChzSource(source, fileName);
      try {
        expect(analysis.imagineDeclarations).toEqual([]);
        expect(analysis.diagnostics).toEqual([]);
        expect(analysis.projection.source).toBe(source);
      } finally {
        analysis.dispose();
      }
    },
  );
});

describe("Phase 0 island projection feasibility", () => {
  it("chooses exact-offset origin-mapped islands with Checker symbol access", () => {
    const fixture = resolve(
      "src/compiler/__fixtures__/positive-class-islands.chz.fixture",
    );
    const source = readFileSync(fixture, "utf8");
    const analysis = analyzeChzSource(
      source,
      fixture.slice(0, -".fixture".length) + ".ts",
    );
    try {
      expect(analysis.projection.source).toHaveLength(source.length);
      expect(analysis.projection.source.match(/\r\n|\r|\n/g)).toEqual(
        source.match(/\r\n|\r|\n/g),
      );
      expect(analysis.projection.measurements).toEqual([
        {
          candidate: "origin-mapped-virtual-source",
          syntacticDiagnosticCount: 0,
          preservesOriginalOffsets: true,
          checkerSymbolAccess: true,
        },
        {
          candidate: "synthetic-fragment",
          syntacticDiagnosticCount: 0,
          preservesOriginalOffsets: false,
          checkerSymbolAccess: false,
        },
      ]);
      expect(analysis.projection.islands).toHaveLength(3);
    } finally {
      analysis.dispose();
    }
  });

  it("selects TS/TSX ScriptKind by extension but blocks .chz.tsx", () => {
    expect(scriptKindForFileName("view.chz.tsx")).not.toBe(
      scriptKindForFileName("view.chz.ts"),
    );
    const analysis = analyzeChzSource(
      "const view = <div />;\n",
      resolve("view.chz.tsx"),
    );
    try {
      expect(analysis.projection.scriptKind).toBe("TSX");
      expect(analysis.diagnostics.map((diagnostic) => diagnostic.code))
        .toEqual(["CHZ1006"]);
    } finally {
      analysis.dispose();
    }
  });
});
