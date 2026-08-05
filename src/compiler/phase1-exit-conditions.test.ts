import {
  copyFileSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeChzSource,
  analyzeChzSources,
  applyProjectionReplacements,
  scriptKindForFileName,
} from "./index.ts";
import {
  isIdentifier,
  type Program,
} from "./ts-api.ts";
import type { ProjectedChzSource } from "./projection.ts";
import { createTypeScriptProgramBatch } from "./typescript.ts";

interface ComparableDiagnostic {
  code: string;
  offset: number;
  message: string;
}

function comparableCheeseDiagnostics(
  diagnostics: readonly {
    code: string;
    offset: number;
    message: string;
  }[],
): ComparableDiagnostic[] {
  return diagnostics.map(({ code, offset, message }) => ({
    code,
    offset,
    message,
  }));
}

function syntacticDiagnosticCount(
  program: Program,
  files: Iterable<string>,
): number {
  let count = 0;
  for (const file of files) {
    count += program.getSyntacticDiagnostics(file).length;
  }
  return count;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Phase 1 compiler-core exit conditions", () => {
  it("exit condition 1: preflights every official examples/**/*.chz.ts file", () => {
    const files = globSync("examples/**/*.chz.ts").sort();
    expect(files.length).toBeGreaterThan(0);
    // The sources are analyzed from a copy holding nothing but the `.chz.ts`
    // files themselves. Running `chz realize` on an example leaves a sidecar
    // shim next to its source, and that shim would resolve an import this test
    // asserts is unresolved — so analyzing in place would answer differently
    // depending on whether the developer happened to realize the examples
    // locally. Copying only the sources keeps a checkout and a working tree
    // full of artifacts in agreement.
    const root = mkdtempSync(join(tmpdir(), "chz-official-examples-"));
    temporaryRoots.push(root);
    for (const file of files) {
      const destination = join(root, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file, destination);
    }

    const batch = analyzeChzSources(
      files.map((file) => ({
        source: readFileSync(file, "utf8"),
        fileName: join(root, file),
      })),
    );
    try {
      for (const [index, analysis] of batch.sourceFiles.entries()) {
        const file = files[index]!;
        if (file === "examples/chz-import/battle.chz.ts") {
          // A genuine missing-module error, not an obligation classification
          // failure. The example imports the ./stats sidecar shim, which is a
          // realize output and therefore not committed — realize emits it next
          // to the source (docs/20), as the shim tests in realize.test.ts pin.
          expect(analysis.diagnostics.map((diagnostic) => diagnostic.code))
            .toEqual(["TS2307"]);
          continue;
        }
        expect(analysis.diagnostics, file).toEqual([]);
        expect(analysis.imagineDeclarations.length, file).toBeGreaterThan(0);
      }
    } finally {
      batch.dispose();
    }
  });

  it("exit condition 2: parses syntax the removed scanner could not handle", () => {
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
      resolve("phase1-known-limitations.chz.ts"),
    );
    try {
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.imagineDeclarations.map((declaration) => declaration.name))
        .toEqual(["project"]);
      const declaration = analysis.imagineDeclarations[0]!;
      expect(declaration.exported).toBe(true);
      expect(declaration.kind).toBe("ImagineFunction");
      if (declaration.kind !== "ImagineFunction") {
        throw new Error("Expected the project declaration to be a function.");
      }
      expect(declaration.parameters[0]?.kind).toBeDefined();
      expect(declaration.returnType?.kind).toBeDefined();
      expect(declaration.ensures[0]?.conditionOrScenario.kind).toBeDefined();
      expect(analysis.typescript.projectedSource).toHaveLength(source.length);
    } finally {
      analysis.dispose();
    }
  });

  it("exit condition 3: diagnoses duplicate imagine at the second token", () => {
    const source =
      "imagine imagine imagine function x(): number { requirements('x'); }\n";
    const secondImagine = source.indexOf("imagine", "imagine".length);
    const analysis = analyzeChzSource(
      source,
      resolve("phase1-duplicate.chz.ts"),
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

    const inputs = fragments.map((source, index) => ({
      source,
      fileName: resolve(`phase1-parity-${index}.ts`),
    }));
    const directInputs: ProjectedChzSource[] = inputs.map(
      ({ source, fileName }) => ({
        fileName,
        absoluteFileName: fileName,
        projection: {
          projectedSource: source,
          scriptKind: "TS",
          islands: [],
        },
        islandSources: new Map(),
      }),
    );
    const cheeseBatch = analyzeChzSources(inputs);
    const directBatch = createTypeScriptProgramBatch(directInputs);
    try {
      for (const [index, analysis] of cheeseBatch.sourceFiles.entries()) {
        const fileName = inputs[index]!.fileName;
        const compiler = directBatch.files.get(fileName);
        if (compiler === undefined) {
          throw new Error(`TypeScript did not create a Program for ${fileName}.`);
        }
        const directDiagnostics = compiler.program
          .getSyntacticDiagnostics(fileName)
          .map((diagnostic) => ({
            code: `TS${diagnostic.code}`,
            offset: Math.max(0, diagnostic.pos),
            message: diagnostic.text,
          }));
        expect(
          comparableCheeseDiagnostics(analysis.diagnostics),
        ).toEqual(directDiagnostics);
      }
    } finally {
      directBatch.dispose();
      cheeseBatch.dispose();
    }
  });
});

describe("compiler lexical false-positive guard", () => {
  const cases = [
    ["line comment", "// imagine function fake(): void {}\nconst value = 1;\n"],
    ["block comment", "/* imagine class Fake {} */\nconst value = 1;\n"],
    ["string", "const value = 'imagine function fake(): void {}';\n"],
    [
      "template",
      "const value = `imagine class Fake ${`imagine function nested() {}`}`;\n",
    ],
    ["regex", "const value = /imagine function fake\\(\\) \\{\\}/u;\n"],
    [
      "default-exported identifier",
      "const imagine = 1;\nexport default imagine;\n",
    ],
  ] as const;

  it.each(cases)(
    "does not commit imagine text inside a %s",
    (_label, source) => {
      const fileName = resolve("phase1-false-positive.ts");
      const analysis = analyzeChzSource(source, fileName);
      try {
        expect(analysis.imagineDeclarations).toEqual([]);
        expect(analysis.diagnostics).toEqual([]);
        expect(analysis.typescript.projectedSource).toBe(source);
      } finally {
        analysis.dispose();
      }
    },
  );
});

describe("origin-mapped island projection", () => {
  it("preserves exact offsets and main-program Checker symbol access", () => {
    const fixture = resolve(
      "src/compiler/__fixtures__/positive-class-islands.chz.fixture",
    );
    const source = readFileSync(fixture, "utf8");
    const analysis = analyzeChzSource(
      source,
      fixture.slice(0, -".fixture".length) + ".ts",
    );
    try {
      expect(analysis.typescript.projectedSource).toHaveLength(source.length);
      expect(
        analysis.typescript.projectedSource.match(/\r\n|\r|\n/g),
      ).toEqual(source.match(/\r\n|\r|\n/g));
      // The callable body joins the existing class/property contract islands
      // now that the main projection is a semantic declaration stub.
      expect(analysis.typescript.islands).toHaveLength(4);
      expect(
        syntacticDiagnosticCount(
          analysis.typescript.program,
          analysis.typescript.islands.keys(),
        ),
      ).toBe(0);

      const declaration = analysis.imagineDeclarations[0];
      expect(declaration?.kind).toBe("ImagineClass");
      if (declaration?.kind !== "ImagineClass") {
        throw new Error("Expected Counter to bind as an imagine class.");
      }
      const property = declaration.members.find(
        (member) => member.kind === "ImagineProperty",
      );
      expect(property?.kind).toBe("ImagineProperty");
      if (
        property?.kind !== "ImagineProperty" ||
        !isIdentifier(property.declaration.name)
      ) {
        throw new Error("Expected the imagined score property to bind.");
      }
      expect(
        analysis.typescript.checker.getSymbolAtLocation(
          property.declaration.name,
        ),
      ).toBeDefined();
      expect(property.requirements?.call.getStart(
        property.requirements.call.getSourceFile(),
      )).toBe(source.indexOf("requirements(`Expose"));
    } finally {
      analysis.dispose();
    }
  });

  it("hard-fails overlapping replacements instead of hiding a parser bug", () => {
    expect(() =>
      applyProjectionReplacements("abcdef", [
        {
          span: { start: 1, end: 4 },
          placeholder: "blank",
        },
        {
          span: { start: 3, end: 5 },
          placeholder: "blank",
        },
      ])
    ).toThrow(/overlap/);
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
      expect(analysis.typescript.sourceFile.scriptKind).toBe(
        scriptKindForFileName("view.chz.tsx"),
      );
      expect(analysis.diagnostics.map((diagnostic) => diagnostic.code))
        .toEqual(["CHZ1006"]);
    } finally {
      analysis.dispose();
    }
  });
});

describe("batch Program lifecycle and recoverable diagnostics", () => {
  it("binds a file batch through one Program and Checker lifecycle", () => {
    const batch = analyzeChzSources([
      {
        fileName: resolve("batch-a.chz.ts"),
        source: "imagine function a(): void {}\n",
      },
      {
        fileName: resolve("batch-b.chz.ts"),
        source: "imagine function b(): void {}\n",
      },
    ]);
    try {
      expect(batch.sourceFiles).toHaveLength(2);
      expect(batch.sourceFiles[0]!.typescript.program).toBe(
        batch.sourceFiles[1]!.typescript.program,
      );
      expect(batch.sourceFiles[0]!.typescript.checker).toBe(
        batch.sourceFiles[1]!.typescript.checker,
      );
    } finally {
      batch.dispose();
    }
  });

  it("returns multiple recoverable contract diagnostics in one analysis", () => {
    const source = [
      "imagine function broken(): void {",
      "  console.log('implementation');",
      "  return;",
      "}",
    ].join("\n");
    const analysis = analyzeChzSource(
      source,
      resolve("recoverable-contract-errors.chz.ts"),
    );
    try {
      expect(analysis.diagnostics.map((diagnostic) => diagnostic.code))
        .toEqual(["CHZ1004", "CHZ1004"]);
      expect(analysis.diagnostics.map((diagnostic) => diagnostic.line))
        .toEqual([2, 3]);
    } finally {
      analysis.dispose();
    }
  });
});
