import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  analyzeChzSources,
  type ChzAnalysisBatch,
  type ChzSourceFile,
} from "./index.ts";

interface ExpectedDiagnostic {
  code: string;
  line: number;
  column: number;
}

interface FixtureExpectation {
  success: boolean;
  diagnostics: ExpectedDiagnostic[];
  declarations: string[];
  imagineMembers?: Record<string, string[]>;
  islands?: number;
}

interface FixtureEntry {
  file: string;
  logicalExtension?: ".chz.tsx";
  description: string;
  expect: FixtureExpectation;
}

interface FixtureManifest {
  fixtures: FixtureEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}

function readManifest(path: string): FixtureManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.fixtures)) {
    throw new Error("Fixture manifest must contain a fixtures array.");
  }
  return parsed as unknown as FixtureManifest;
}

function logicalFileName(
  root: string,
  fixture: FixtureEntry,
): string {
  const path = join(root, fixture.file);
  if (
    fixture.logicalExtension === ".chz.tsx" ||
    fixture.file.endsWith(".ts.fixture")
  ) {
    return path.slice(0, -".fixture".length);
  }
  return `${path.slice(0, -".fixture".length)}.ts`;
}

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);
const manifest = readManifest(join(fixtureRoot, "manifest.json"));
const analyses = new Map<string, ChzSourceFile>();
const batches: ChzAnalysisBatch[] = [];

beforeAll(() => {
  // These two fixtures deliberately declare the same global script bindings.
  // They remain separate projects so a test-only collision cannot become a
  // semantic diagnostic; every other fixture shares one Program/lib batch.
  const isolated = new Set([
    "positive-lexical.chz.fixture",
    "positive-unicode-escaped.chz.fixture",
  ]);
  const groups = [
    manifest.fixtures.filter((fixture) => !isolated.has(fixture.file)),
    ...manifest.fixtures
      .filter((fixture) => isolated.has(fixture.file))
      .map((fixture) => [fixture]),
  ];
  try {
    for (const group of groups) {
      const batch = analyzeChzSources(
        group.map((fixture) => ({
          source: readFileSync(join(fixtureRoot, fixture.file), "utf8"),
          fileName: logicalFileName(fixtureRoot, fixture),
        })),
      );
      batches.push(batch);
      for (const [index, analysis] of batch.sourceFiles.entries()) {
        analyses.set(group[index]!.file, analysis);
      }
    }
  } catch (error) {
    for (const batch of batches.splice(0)) batch.dispose();
    throw error;
  }
});

afterAll(() => {
  analyses.clear();
  for (const batch of batches.splice(0)) batch.dispose();
});

describe("compiler grammar fixture corpus", () => {
  for (const fixture of manifest.fixtures) {
    it(fixture.description, () => {
      const analysis = analyses.get(fixture.file);
      if (analysis === undefined) {
        throw new Error(`Fixture '${fixture.file}' was not analyzed.`);
      }
      expect(analysis.diagnostics.length === 0).toBe(
        fixture.expect.success,
      );
      expect(
        analysis.diagnostics.map(({ code, line, column }) => ({
          code,
          line,
          column,
        })),
      ).toEqual(fixture.expect.diagnostics);
      expect(
        analysis.imagineDeclarations.map(
          (declaration) => declaration.name,
        ),
      ).toEqual(fixture.expect.declarations);
      if (fixture.expect.imagineMembers !== undefined) {
        expect(
          Object.fromEntries(
            analysis.imagineDeclarations
              .filter(
                (declaration) =>
                  declaration.kind === "ImagineClass",
              )
              .map((declaration) => [
                declaration.name,
                declaration.kind === "ImagineClass"
                  ? declaration.members.map((member) => member.name)
                  : [],
              ]),
          ),
        ).toEqual(fixture.expect.imagineMembers);
      }
      for (
        const diagnostic of analysis.diagnostics.filter(
          ({ code }) => code === "CHZ1009",
        )
      ) {
        expect(diagnostic.message).toContain(
          "if the callable returns no value, write ': void'.",
        );
      }
      if (fixture.expect.islands !== undefined) {
        expect(analysis.typescript.islands).toHaveLength(
          fixture.expect.islands,
        );
      }
    });
  }
});
