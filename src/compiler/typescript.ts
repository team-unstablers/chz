import { resolve } from "node:path";

import {
  API,
  createVirtualFileSystem,
  type Checker,
  type Program,
  type Project,
  type Snapshot,
  type SourceFile,
} from "./ts-api.ts";
import type { ProjectedChzSource } from "./projection.ts";

const CONTRACT_GLOBALS = `
declare function requirements(value: string): void;
declare function ensure(...args: unknown[]): void;
declare function assert(condition: unknown): asserts condition;
`;

export interface TypeScriptProgramFile {
  absoluteFileName: string;
  sourceFile: SourceFile;
  project: Project;
  program: Program;
  checker: Checker;
  islandSourceFiles: ReadonlyMap<string, SourceFile>;
}

export interface TypeScriptProgramBatch {
  files: ReadonlyMap<string, TypeScriptProgramFile>;
  dispose(): void;
}

function sourceFileMap(
  program: Program,
  fileNames: Iterable<string>,
): ReadonlyMap<string, SourceFile> {
  const result = new Map<string, SourceFile>();
  for (const fileName of fileNames) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile !== undefined) result.set(fileName, sourceFile);
  }
  return result;
}

/**
 * Owns one API process and one snapshot for the complete input batch. Program,
 * Checker, main SourceFile, and island SourceFiles therefore share a single
 * compiler lifetime instead of being reparsed by each analysis stage.
 */
export function createTypeScriptProgramBatch(
  inputs: readonly ProjectedChzSource[],
): TypeScriptProgramBatch {
  if (inputs.length === 0) {
    throw new Error("A TypeScript Program batch requires at least one source.");
  }

  const virtualFiles: Record<string, string> = {};
  const openFiles: string[] = [];
  for (const input of inputs) {
    virtualFiles[input.absoluteFileName] =
      input.projection.projectedSource;
    openFiles.push(input.absoluteFileName);
    for (const [fileName, source] of input.islandSources) {
      virtualFiles[fileName] = source;
      openFiles.push(fileName);
    }
  }
  const ambientFileName = resolve(
    ".chz/compiler/__chz_contract_globals.d.ts",
  );
  virtualFiles[ambientFileName] = CONTRACT_GLOBALS;
  openFiles.push(ambientFileName);

  const api = new API({
    cwd: resolve("."),
    fs: createVirtualFileSystem(virtualFiles),
  });
  let snapshot: Snapshot | undefined;
  try {
    snapshot = api.updateSnapshot({ openFiles });
    const files = new Map<string, TypeScriptProgramFile>();
    for (const input of inputs) {
      const project = snapshot.getDefaultProjectForFile(
        input.absoluteFileName,
      );
      const sourceFile = project?.program.getSourceFile(
        input.absoluteFileName,
      );
      if (project === undefined || sourceFile === undefined) {
        throw new Error(
          `TypeScript could not parse '${input.fileName}'. Check the virtual file path and retry.`,
        );
      }
      files.set(input.absoluteFileName, {
        absoluteFileName: input.absoluteFileName,
        sourceFile,
        project,
        program: project.program,
        checker: project.checker,
        islandSourceFiles: sourceFileMap(
          project.program,
          input.islandSources.keys(),
        ),
      });
    }

    let disposed = false;
    return {
      files,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        snapshot?.dispose();
        api.close();
      },
    };
  } catch (error) {
    snapshot?.dispose();
    api.close();
    throw error;
  }
}
