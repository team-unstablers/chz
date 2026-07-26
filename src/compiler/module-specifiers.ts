import { dirname, resolve } from "node:path";

import {
  API,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportExpression,
  isStringLiteralLikeNode,
  type CallExpression,
  type Checker,
  type Node,
  type SourceFile,
  type StringLiteralLikeNode,
} from "./ts-api.ts";

export type ModuleReferenceKind =
  | "import"
  | "export"
  | "dynamic-import"
  | "import-equals"
  | "require";

export interface StaticModuleReference {
  kind: ModuleReferenceKind;
  node: Node;
  specifier: StringLiteralLikeNode;
  text: string;
}

export interface NonStaticDynamicImport {
  kind: "dynamic-import";
  node: CallExpression;
  specifier: null;
}

export type ModuleReference =
  | StaticModuleReference
  | NonStaticDynamicImport;

function staticReference(
  kind: ModuleReferenceKind,
  node: Node,
  candidate: Node | undefined,
): StaticModuleReference | undefined {
  if (candidate === undefined || !isStringLiteralLikeNode(candidate)) {
    return undefined;
  }
  return {
    kind,
    node,
    specifier: candidate,
    text: candidate.text,
  };
}

/**
 * A bare `require(...)` is a module reference only while `require` resolves
 * outside the current source file (normally the Node ambient declaration) or
 * remains unresolved. A parameter, import, or local declaration named
 * `require` shadows the CommonJS loader and must not manufacture a dependency.
 */
function isUnshadowedRequire(
  expression: Node,
  checker: Checker | undefined,
): boolean {
  if (!isIdentifier(expression) || expression.text !== "require") return false;
  if (checker === undefined) return true;
  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined) return true;
  const sourceFileName = expression.getSourceFile().fileName;
  return symbol.declarations.every((handle) => {
    const declaration = handle.resolve();
    return declaration === undefined ||
      declaration.getSourceFile().fileName !== sourceFileName;
  });
}

/**
 * Classify one AST node using the canonical module-reference rules shared by
 * the dependency graph, restricted-subset linter, and human-code rewriter.
 */
export function moduleReferenceForNode(
  node: Node,
  checker?: Checker,
): ModuleReference | undefined {
  if (isImportDeclaration(node)) {
    return staticReference("import", node, node.moduleSpecifier);
  }
  if (isExportDeclaration(node)) {
    return staticReference("export", node, node.moduleSpecifier);
  }
  if (
    isImportEqualsDeclaration(node) &&
    isExternalModuleReference(node.moduleReference)
  ) {
    return staticReference(
      "import-equals",
      node,
      node.moduleReference.expression,
    );
  }
  if (isCallExpression(node) && isImportExpression(node.expression)) {
    return staticReference(
      "dynamic-import",
      node,
      node.arguments[0],
    ) ?? {
      kind: "dynamic-import",
      node,
      specifier: null,
    };
  }
  if (
    isCallExpression(node) &&
    isUnshadowedRequire(node.expression, checker)
  ) {
    return staticReference("require", node, node.arguments[0]);
  }
  return undefined;
}

/** Collect module references in source order without re-reading source text. */
export function collectModuleReferences(
  sourceFile: SourceFile,
  checker?: Checker,
): ModuleReference[] {
  const references: ModuleReference[] = [];
  const visit = (node: Node): void => {
    const reference = moduleReferenceForNode(node, checker);
    if (reference !== undefined) references.push(reference);
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return references.sort(
    (left, right) =>
      left.node.getStart(sourceFile) - right.node.getStart(sourceFile),
  );
}

function virtualSourceFileSystem(
  fileName: string,
  source: string,
) {
  const directories = new Set<string>();
  let directory = dirname(fileName);
  for (;;) {
    directories.add(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return {
    readFile: (candidate: string) =>
      candidate === fileName ? source : undefined,
    fileExists: (candidate: string) =>
      candidate === fileName ? true : undefined,
    directoryExists: (candidate: string) =>
      directories.has(candidate) ? true : undefined,
    realpath: (candidate: string) =>
      candidate === fileName || directories.has(candidate)
        ? candidate
        : undefined,
  };
}

/**
 * Parse an already-realized TypeScript artifact through the compiler API and
 * immediately lower its AST references to plain data. The snapshot never
 * escapes this function, so graph consumers cannot retain invalid AST nodes.
 */
export function collectModuleSpecifiersFromSource(
  source: string,
  fileName = resolve(".chz/compiler/__chz_module_scan.ts"),
): string[] {
  const absoluteFileName = resolve(fileName);
  const api = new API({
    cwd: resolve("."),
    fs: virtualSourceFileSystem(absoluteFileName, source),
  });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openFiles: [absoluteFileName] });
    const project = snapshot.getDefaultProjectForFile(absoluteFileName);
    const sourceFile = project?.program.getSourceFile(absoluteFileName);
    if (project === undefined || sourceFile === undefined) {
      throw new Error(
        `TypeScript could not parse '${fileName}' while collecting module specifiers.`,
      );
    }
    return collectModuleReferences(sourceFile, project.checker)
      .flatMap((reference) =>
        reference.specifier === null ? [] : [reference.text]
      );
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

export function isRelativeModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}
