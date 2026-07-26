import { basename } from "node:path";

import {
  SymbolFlags,
  isIdentifier,
  isPropertyAccessExpression,
  isQualifiedName,
  isTypeNode,
  type Checker,
  type Identifier,
  type Node,
  type TypeScriptSymbol,
} from "./ts-api.ts";
import type {
  ChzEnsure,
  ChzImagineDeclaration,
  ChzSourceFile,
} from "./syntax.ts";

const REFERENCE_MEANING =
  SymbolFlags.Value |
  SymbolFlags.Type |
  SymbolFlags.Namespace;

export interface ChzEnsureScope {
  ensure: ChzEnsure;
  /**
   * The declaration whose lexical scope the origin-mapped island represents.
   * Island-local bindings are resolved in the island first; only genuinely
   * free identifiers fall back to this main-source scope.
   */
  owner: Node;
}

export interface SymbolReference {
  node: Identifier;
  symbol: TypeScriptSymbol;
}

/** Follow TypeScript import/export aliases to their declaration identity. */
export function unaliasSymbol(
  checker: Checker,
  symbol: TypeScriptSymbol | undefined,
): TypeScriptSymbol | undefined {
  if (symbol === undefined) return undefined;
  return (symbol.flags & SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function isMemberNameWithoutReferenceMeaning(node: Identifier): boolean {
  const parent = node.parent;
  return (
    isPropertyAccessExpression(parent) && parent.name === node
  ) || (
    isQualifiedName(parent) && parent.right === node
  );
}

/**
 * Resolve one identifier from a main projection or an origin-mapped contract
 * island. The island is a separate virtual SourceFile, so a free identifier
 * in an exported Cheese module can lack a direct symbol even though it is in
 * scope at the owning imagine declaration. Local bindings and property-name
 * symbols must win before that fallback, or shadowing would create false
 * imagine edges.
 */
export function resolveReferenceSymbol(
  analysis: ChzSourceFile,
  node: Identifier,
  owner: Node,
): TypeScriptSymbol | undefined {
  const checker = analysis.typescript.checker;
  const direct = checker.getSymbolAtLocation(node);
  if (
    direct !== undefined &&
    direct.declarations.length > 0
  ) {
    return unaliasSymbol(checker, direct);
  }
  if (isMemberNameWithoutReferenceMeaning(node)) {
    return unaliasSymbol(checker, direct);
  }
  return unaliasSymbol(
    checker,
    checker.resolveName(node.text, REFERENCE_MEANING, owner, false),
  ) ?? unaliasSymbol(checker, direct);
}

/** Collect identifier references below `root`, deduplicated by symbol identity. */
export function collectSymbolReferences(
  analysis: ChzSourceFile,
  root: Node,
  owner: Node,
): SymbolReference[] {
  const references = new Map<number, SymbolReference>();
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      const symbol = resolveReferenceSymbol(analysis, node, owner);
      if (symbol !== undefined && !references.has(symbol.id)) {
        references.set(symbol.id, { node, symbol });
      }
    }
    node.forEachChild(visit);
  };
  visit(root);
  return [...references.values()];
}

/**
 * Collect only references that occur inside TypeScript TypeNodes. This is the
 * canonical "free type reference" traversal used by signature dependencies
 * and ensure-harness type imports; expression/value identifiers are excluded.
 */
export function collectTypeSymbolReferences(
  analysis: ChzSourceFile,
  root: Node,
  owner: Node,
): SymbolReference[] {
  const references = new Map<number, SymbolReference>();
  const visitType = (node: Node): void => {
    if (isIdentifier(node)) {
      const symbol = resolveReferenceSymbol(analysis, node, owner);
      if (symbol !== undefined && !references.has(symbol.id)) {
        references.set(symbol.id, { node, symbol });
      }
    }
    node.forEachChild(visitType);
  };
  const visit = (node: Node): void => {
    if (isTypeNode(node)) {
      visitType(node);
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return [...references.values()];
}

/** Pair every ensure AST with the main declaration scope represented by it. */
export function declarationEnsureScopes(
  declaration: ChzImagineDeclaration,
): ChzEnsureScope[] {
  if (declaration.kind === "ImagineFunction") {
    return declaration.ensures.map((ensure) => ({
      ensure,
      owner: declaration.declaration,
    }));
  }
  return [
    ...declaration.ensures.map((ensure) => ({
      ensure,
      owner: declaration.declaration,
    })),
    ...declaration.members.flatMap((member) =>
      member.ensures.map((ensure) => ({
        ensure,
        owner: member.declaration,
      }))
    ),
  ];
}

/**
 * Checker-backed builtin classification. A symbol is a TypeScript builtin
 * only when all of its declarations come from compiler `lib.*.d.ts` files.
 * A human declaration that merges with a lib symbol therefore remains human.
 */
export function symbolComesOnlyFromTypeScriptLib(
  symbol: TypeScriptSymbol,
): boolean {
  const declarations = symbol.declarations
    .map((handle) => handle.resolve())
    .filter((declaration) => declaration !== undefined);
  return declarations.length > 0 &&
    declarations.every((declaration) => {
      const sourceFile = declaration.getSourceFile();
      const file = basename(sourceFile.fileName);
      return sourceFile.isDeclarationFile &&
        file.startsWith("lib.") &&
        file.endsWith(".d.ts");
    });
}
