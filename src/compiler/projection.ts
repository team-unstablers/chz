import { resolve } from "node:path";

import { ScriptKind } from "./ts-api.ts";
import type {
  CheeseParseResult,
  ProjectionReplacement,
} from "./parser.ts";
import type {
  ProjectionIsland,
  TypeScriptProjection,
} from "./syntax.ts";

export interface ProjectedChzSource {
  fileName: string;
  absoluteFileName: string;
  projection: TypeScriptProjection;
  islandSources: ReadonlyMap<string, string>;
}

export function scriptKindForFileName(fileName: string): ScriptKind {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith(".tsx") || normalized.endsWith(".chz.tsx")) {
    return ScriptKind.TSX;
  }
  return ScriptKind.TS;
}

function blankPreservingLines(source: string): string {
  return source.replace(/[^\r\n]/g, " ");
}

function replacementText(
  source: string,
  replacement: ProjectionReplacement,
): string {
  const original = source.slice(
    replacement.span.start,
    replacement.span.end,
  );
  const blank = blankPreservingLines(original);
  if (replacement.placeholder === "blank") return blank;
  if (replacement.placeholder === "declare") {
    if (original.length !== "declare".length) {
      throw new Error(
        "The imagine-to-declare projection must preserve UTF-16 length.",
      );
    }
    return "declare";
  }

  const firstCodeUnit = blank.search(/[^\r\n]/);
  if (firstCodeUnit < 0) return blank;
  return `${blank.slice(0, firstCodeUnit)};${blank.slice(firstCodeUnit + 1)}`;
}

export function applyProjectionReplacements(
  source: string,
  replacements: readonly ProjectionReplacement[],
): string {
  const ordered = [...replacements].sort(
    (left, right) => left.span.start - right.span.start,
  );
  let result = "";
  let cursor = 0;
  for (const replacement of ordered) {
    if (
      replacement.span.start < cursor ||
      replacement.span.end < replacement.span.start ||
      replacement.span.end > source.length
    ) {
      throw new Error(
        "Projection replacements overlap or exceed the source; fix the Cheese extension parser before retrying.",
      );
    }
    result += source.slice(cursor, replacement.span.start);
    result += replacementText(source, replacement);
    cursor = replacement.span.end;
  }
  result += source.slice(cursor);

  // JavaScript string length is a UTF-16 code-unit count. This assertion and
  // the unchanged CR/LF code units make main-source positions identity-mapped.
  if (result.length !== source.length) {
    throw new Error(
      "Projection changed the source UTF-16 length; use an origin-mapped island placeholder instead.",
    );
  }
  return result;
}

function originMappedIslandSource(
  source: string,
  island: ProjectionIsland,
): string {
  // split("") iterates UTF-16 code units. Code-point iteration would collapse
  // surrogate pairs and shift every later diagnostic and AST span.
  const codeUnits = blankPreservingLines(source).split("");
  const copyStart =
    island.kind === "property-contract-body" ||
      island.kind === "callable-contract-body"
      ? island.original.start + 1
      : island.original.start;
  const copyEnd =
    island.kind === "property-contract-body" ||
      island.kind === "callable-contract-body"
      ? island.original.end - 1
      : island.original.end;
  for (let index = copyStart; index < copyEnd; index += 1) {
    codeUnits[index] = source[index]!;
  }
  return codeUnits.join("");
}

export function createTypeScriptProjection(
  source: string,
  fileName: string,
  parsed: CheeseParseResult,
): ProjectedChzSource {
  const absoluteFileName = resolve(fileName);
  const islands: ProjectionIsland[] = parsed.islands.map((island, index) => ({
    ...island,
    virtualFileName: `${absoluteFileName}.__chz_island_${index}.ts`,
  }));
  const islandSources = new Map<string, string>();
  for (const island of islands) {
    islandSources.set(
      island.virtualFileName,
      originMappedIslandSource(source, island),
    );
  }

  return {
    fileName,
    absoluteFileName,
    projection: {
      projectedSource: applyProjectionReplacements(
        source,
        parsed.replacements,
      ),
      scriptKind:
        scriptKindForFileName(fileName) === ScriptKind.TSX ? "TSX" : "TS",
      islands,
    },
    islandSources,
  };
}
