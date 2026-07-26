import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { analyzeChzSource } from "./index.ts";

interface ExpectedDiagnostic {
  code: string;
  line: number;
  column: number;
}

interface FixtureExpectation {
  success: boolean;
  diagnostics: ExpectedDiagnostic[];
  declarations: string[];
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(path: string): FixtureManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.fixtures)) {
    throw new Error("Fixture manifest must contain a fixtures array.");
  }
  return parsed as unknown as FixtureManifest;
}

function logicalFileName(root: string, fixture: FixtureEntry): string {
  const path = join(root, fixture.file);
  if (fixture.logicalExtension === ".chz.tsx" || fixture.file.endsWith(".ts.fixture")) {
    return path.slice(0, -".fixture".length);
  }
  return `${path.slice(0, -".fixture".length)}.ts`;
}

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const manifest = readManifest(join(fixtureRoot, "manifest.json"));

describe("Phase 0 grammar fixture corpus", () => {
  for (const fixture of manifest.fixtures) {
    it(fixture.description, () => {
      const source = readFileSync(join(fixtureRoot, fixture.file), "utf8");
      const analysis = analyzeChzSource(
        source,
        logicalFileName(fixtureRoot, fixture),
      );
      try {
        expect(analysis.diagnostics.length === 0).toBe(fixture.expect.success);
        expect(
          analysis.diagnostics.map(({ code, line, column }) => ({
            code,
            line,
            column,
          })),
        ).toEqual(fixture.expect.diagnostics);
        expect(
          analysis.imagineDeclarations.map((declaration) => declaration.name),
        ).toEqual(fixture.expect.declarations);
        if (fixture.expect.islands !== undefined) {
          expect(analysis.projection.islands).toHaveLength(fixture.expect.islands);
        }
      } finally {
        analysis.dispose();
      }
    });
  }
});
