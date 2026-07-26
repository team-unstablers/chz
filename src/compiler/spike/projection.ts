import { extname, resolve } from "node:path";

import {
  API,
  ScriptKind,
  createVirtualFileSystem,
  isClassDeclaration,
  isIdentifier,
  isPropertyDeclaration,
  type Project,
  type Snapshot,
  type SourceFile,
} from "../ts-api.ts";
import type {
  CheeseScanResult,
  ProjectionReplacement,
} from "./scanner.ts";
import type {
  ProjectionCandidateMeasurement,
  ProjectionIsland,
  TypeScriptProjection,
} from "./syntax.ts";

const CONTRACT_GLOBALS = `
declare function requirements(value: string): void;
declare function ensure(...args: unknown[]): void;
declare function assert(condition: unknown): asserts condition;
`;

export interface ProjectionSession {
  api: API;
  snapshot: Snapshot;
  project: Project;
  sourceFile: SourceFile;
  projection: TypeScriptProjection;
  originIslandFiles: ReadonlyMap<string, SourceFile>;
  syntheticIslandFiles: ReadonlyMap<string, SourceFile>;
  absoluteFileName: string;
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

function replacementText(source: string, replacement: ProjectionReplacement): string {
  const original = source.slice(replacement.span.start, replacement.span.end);
  const blank = blankPreservingLines(original);
  if (replacement.placeholder === "blank") return blank;

  const firstContent = blank.search(/[^\r\n]/);
  if (firstContent < 0) return blank;
  return `${blank.slice(0, firstContent)};${blank.slice(firstContent + 1)}`;
}

export function applyProjectionReplacements(
  source: string,
  replacements: readonly ProjectionReplacement[],
): string {
  const ordered = [...replacements].sort((left, right) => left.span.start - right.span.start);
  let result = "";
  let cursor = 0;
  for (const replacement of ordered) {
    if (replacement.span.start < cursor) {
      throw new Error("Projection replacements overlap; fix the Cheese shell scanner before retrying.");
    }
    result += source.slice(cursor, replacement.span.start);
    result += replacementText(source, replacement);
    cursor = replacement.span.end;
  }
  result += source.slice(cursor);

  // UTF-16 offsets and CR/LF sequences are the mapping contract.
  if (result.length !== source.length) {
    throw new Error("Projection changed the source UTF-16 length; use a mapped island placeholder instead.");
  }
  return result;
}

function originMappedIslandSource(source: string, island: ProjectionIsland): string {
  // split("") works in UTF-16 code units. Code-point iteration would collapse
  // surrogate pairs and silently shift every following source position.
  const chars = blankPreservingLines(source).split("");
  const copyStart = island.kind === "property-contract-body"
    ? island.original.start + 1
    : island.original.start;
  const copyEnd = island.kind === "property-contract-body"
    ? island.original.end - 1
    : island.original.end;
  for (let index = copyStart; index < copyEnd; index += 1) {
    chars[index] = source[index]!;
  }
  return chars.join("");
}

function syntheticIslandSource(source: string, island: ProjectionIsland): string {
  const original = source.slice(island.original.start, island.original.end);
  const body = island.kind === "property-contract-body" ? original : `{${original}}`;
  return `function __chz_synthetic_island__() ${body}\n`;
}

function sourceFileMap(
  project: Project,
  fileNames: readonly string[],
): ReadonlyMap<string, SourceFile> {
  const result = new Map<string, SourceFile>();
  for (const fileName of fileNames) {
    const sourceFile = project.program.getSourceFile(fileName);
    if (sourceFile !== undefined) result.set(fileName, sourceFile);
  }
  return result;
}

function syntacticDiagnosticCount(project: Project, fileNames: readonly string[]): number {
  return fileNames.reduce(
    (count, fileName) => count + project.program.getSyntacticDiagnostics(fileName).length,
    0,
  );
}

function canAccessImaginedPropertySymbol(
  project: Project,
  sourceFile: SourceFile,
  scan: CheeseScanResult,
): boolean {
  const names = new Set(
    scan.declarations.flatMap((declaration) =>
      declaration.kind === "ImagineClass"
        ? declaration.members.flatMap((member) =>
          member.kind === "ImagineProperty" ? [member.name] : []
        )
        : []
    ),
  );
  if (names.size === 0) return false;
  for (const statement of sourceFile.statements) {
    if (!isClassDeclaration(statement)) continue;
    for (const member of statement.members) {
      if (
        isPropertyDeclaration(member) &&
        isIdentifier(member.name) &&
        names.has(member.name.text) &&
        project.checker.getSymbolAtLocation(member.name) !== undefined
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Builds both feasibility candidates in one TypeScript Program so their
 * diagnostics are measured against the same compiler version and options.
 */
export function createProjectionSession(
  source: string,
  fileName: string,
  scan: CheeseScanResult,
): ProjectionSession {
  const absoluteFileName = resolve(fileName);
  const projectedSource = applyProjectionReplacements(source, scan.replacements);
  const virtualFiles: Record<string, string> = {
    [absoluteFileName]: projectedSource,
  };
  const originNames: string[] = [];
  const syntheticNames: string[] = [];

  for (const island of scan.islands) {
    const originName = resolve(island.virtualFileName);
    const syntheticName = resolve(island.syntheticFileName);
    originNames.push(originName);
    syntheticNames.push(syntheticName);
    virtualFiles[originName] = originMappedIslandSource(source, island);
    virtualFiles[syntheticName] = syntheticIslandSource(source, island);
  }

  const ambientName = resolve(
    fileName.slice(0, fileName.length - extname(fileName).length) +
      ".__chz_contract_globals.d.ts",
  );
  virtualFiles[ambientName] = CONTRACT_GLOBALS;

  const api = new API({
    cwd: resolve("."),
    fs: createVirtualFileSystem(virtualFiles),
  });
  let snapshot: Snapshot | undefined;
  try {
    snapshot = api.updateSnapshot({
      openFiles: [absoluteFileName, ...originNames, ...syntheticNames, ambientName],
    });
    const project = snapshot.getDefaultProjectForFile(absoluteFileName);
    const sourceFile = project?.program.getSourceFile(absoluteFileName);
    if (project === undefined || sourceFile === undefined) {
      throw new Error(`TypeScript could not parse '${fileName}'. Check the virtual file path and retry.`);
    }

    const originIslandFiles = sourceFileMap(project, originNames);
    const syntheticIslandFiles = sourceFileMap(project, syntheticNames);
    const originCheckerSymbolAccess = canAccessImaginedPropertySymbol(
      project,
      sourceFile,
      scan,
    );
    const measurements: ProjectionCandidateMeasurement[] = [
      {
        candidate: "origin-mapped-virtual-source",
        syntacticDiagnosticCount: syntacticDiagnosticCount(project, originNames),
        preservesOriginalOffsets: true,
        // The main origin-mapped projection retains the property declaration and
        // therefore gives the Checker a symbol to bind its name and type.
        checkerSymbolAccess: originCheckerSymbolAccess,
      },
      {
        candidate: "synthetic-fragment",
        syntacticDiagnosticCount: syntacticDiagnosticCount(project, syntheticNames),
        preservesOriginalOffsets: false,
        // A body-only wrapper has no declaration node for the imagined property.
        checkerSymbolAccess: false,
      },
    ];

    return {
      api,
      snapshot,
      project,
      sourceFile,
      projection: {
        source: projectedSource,
        scriptKind: scriptKindForFileName(fileName) === ScriptKind.TSX ? "TSX" : "TS",
        islands: scan.islands.map((island, index) => ({
          ...island,
          virtualFileName: originNames[index]!,
          syntheticFileName: syntheticNames[index]!,
        })),
        measurements,
      },
      originIslandFiles,
      syntheticIslandFiles,
      absoluteFileName,
    };
  } catch (error) {
    snapshot?.dispose();
    api.close();
    throw error;
  }
}
