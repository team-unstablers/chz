import {
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isPropertyDeclaration,
  isStringLiteral,
  type Block,
  type CallExpression,
  type SourceFile,
  type Statement,
} from "../ts-api.ts";
import {
  createChzDiagnostic,
  createTypeScriptDiagnostic,
} from "./diagnostics.ts";
import {
  createProjectionSession,
  scriptKindForFileName,
  type ProjectionSession,
} from "./projection.ts";
import {
  scanCheeseExtensions,
  type CheeseScanResult,
} from "./scanner.ts";
import type {
  ChzContractStatement,
  ChzDiagnostic,
  ChzImagineClass,
  ChzImagineClassMember,
  ChzImagineDeclaration,
  SpikeAnalysis,
} from "./syntax.ts";
import { tokenizeTypeScript } from "./tokens.ts";
import { ScriptKind } from "../ts-api.ts";

function emptyScan(): CheeseScanResult {
  return {
    profile: null,
    declarations: [],
    islands: [],
    replacements: [],
    diagnostics: [],
  };
}

function declarationContains(
  declaration: ChzImagineDeclaration,
  offset: number,
): boolean {
  return offset >= declaration.span.start && offset < declaration.span.end;
}

function contractCall(statement: Statement): CallExpression | undefined {
  if (!isExpressionStatement(statement) || !isCallExpression(statement.expression)) {
    return undefined;
  }
  return statement.expression;
}

function contractName(call: CallExpression): "requirements" | "ensure" | undefined {
  if (!isIdentifier(call.expression)) return undefined;
  if (call.expression.text === "requirements" || call.expression.text === "ensure") {
    return call.expression.text;
  }
  return undefined;
}

function validateStatements(
  statements: readonly Statement[],
  sourceFile: SourceFile,
  mainSourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): ChzContractStatement[] {
  const contracts: ChzContractStatement[] = [];

  for (const statement of statements) {
    const call = contractCall(statement);
    const name = call === undefined ? undefined : contractName(call);
    const offset = statement.getStart(sourceFile);
    if (call === undefined || name === undefined) {
      diagnostics.push(
        createChzDiagnostic("CHZ1004", fileName, offset, mainSourceFile),
      );
      continue;
    }

    contracts.push({
      kind: name,
      span: { start: offset, end: statement.end },
    });
    if (name !== "requirements") continue;

    const argument = call.arguments[0];
    const validArgument = call.arguments.length === 1 &&
      argument !== undefined &&
      (isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument));
    if (!validArgument) {
      diagnostics.push(
        createChzDiagnostic(
          "CHZ2001",
          fileName,
          argument?.getStart(sourceFile) ?? call.expression.end,
          mainSourceFile,
        ),
      );
    }
  }

  return contracts;
}

function validateBlock(
  block: Block | undefined,
  mainSourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): ChzContractStatement[] {
  if (block === undefined) return [];
  return validateStatements(
    block.statements,
    mainSourceFile,
    mainSourceFile,
    fileName,
    diagnostics,
  );
}

function bindFunction(
  declaration: ChzImagineDeclaration,
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  if (declaration.kind !== "ImagineFunction") return;
  const node = sourceFile.statements.find(
    (statement) =>
      isFunctionDeclaration(statement) &&
      statement.name?.text === declaration.name &&
      statement.getStart(sourceFile) >= declaration.span.start &&
      statement.getStart(sourceFile) < declaration.span.end,
  );
  if (node === undefined || !isFunctionDeclaration(node)) return;
  declaration.declaration = node;
  declaration.contracts = validateBlock(node.body, sourceFile, fileName, diagnostics);
}

function bindClassMember(
  member: ChzImagineClassMember,
  declaration: ChzImagineClass,
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  const classNode = declaration.declaration;
  if (classNode === undefined) return;
  const node = classNode.members.find((candidate) => {
    if (!(isMethodDeclaration(candidate) || isPropertyDeclaration(candidate))) return false;
    return isIdentifier(candidate.name) &&
      candidate.name.text === member.name &&
      candidate.getStart(sourceFile) >= member.span.start &&
      candidate.getStart(sourceFile) < member.span.end;
  });
  if (node === undefined) return;

  if (member.kind === "ImagineMethod" && isMethodDeclaration(node)) {
    member.declaration = node;
    member.contracts = validateBlock(node.body, sourceFile, fileName, diagnostics);
  } else if (member.kind === "ImagineProperty" && isPropertyDeclaration(node)) {
    member.declaration = node;
  }
}

function bindClass(
  declaration: ChzImagineDeclaration,
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  if (declaration.kind !== "ImagineClass") return;
  const node = sourceFile.statements.find(
    (statement) =>
      isClassDeclaration(statement) &&
      statement.name?.text === declaration.name &&
      statement.getStart(sourceFile) >= declaration.span.start &&
      statement.getStart(sourceFile) < declaration.span.end,
  );
  if (node === undefined || !isClassDeclaration(node)) return;
  declaration.declaration = node;
  for (const member of declaration.members) {
    bindClassMember(member, declaration, sourceFile, fileName, diagnostics);
  }
}

function bindAndValidateDeclarations(
  declarations: readonly ChzImagineDeclaration[],
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  for (const declaration of declarations) {
    bindFunction(declaration, sourceFile, fileName, diagnostics);
    bindClass(declaration, sourceFile, fileName, diagnostics);
  }
}

function ownerForIsland(
  declarations: readonly ChzImagineDeclaration[],
  start: number,
): ChzImagineClass | ChzImagineClassMember | undefined {
  for (const declaration of declarations) {
    if (declaration.kind !== "ImagineClass") continue;
    const member = declaration.members.find(
      (candidate) =>
        candidate.kind === "ImagineProperty" &&
        candidate.bodySpan.start === start,
    );
    if (member !== undefined) return member;
    if (declarationContains(declaration, start)) return declaration;
  }
  return undefined;
}

function validateOriginIslands(
  scan: CheeseScanResult,
  session: ProjectionSession,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  for (let index = 0; index < scan.islands.length; index += 1) {
    const projectedIsland = session.projection.islands[index];
    if (projectedIsland === undefined) continue;
    const sourceFile = session.originIslandFiles.get(projectedIsland.virtualFileName);
    if (sourceFile === undefined) continue;
    const contracts = validateStatements(
      sourceFile.statements,
      sourceFile,
      session.sourceFile,
      fileName,
      diagnostics,
    );
    const owner = ownerForIsland(scan.declarations, scan.islands[index]!.original.start);
    if (owner === undefined) continue;
    if (owner.kind === "ImagineClass") {
      // Each direct class contract is its own island, so append in source order.
      owner.contracts = [...owner.contracts.filter(
        (contract) => contract.span.start !== scan.islands[index]!.original.start,
      ), ...contracts].sort((left, right) => left.span.start - right.span.start);
    } else {
      owner.contracts = contracts;
    }
  }
}

function collectTypeScriptDiagnostics(
  scan: CheeseScanResult,
  session: ProjectionSession,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  // A failed committed Cheese production already has the authoritative error
  // location. Parsing the intentionally half-neutralized remainder would only
  // add cascading TS parser noise (for example, two TS1434s after CHZ1001).
  if (scan.diagnostics.length > 0) return;

  const malformedDeclarations = new Set<ChzImagineDeclaration>();
  for (const diagnostic of session.project.program.getSyntacticDiagnostics(session.absoluteFileName)) {
    const offset = Math.max(0, diagnostic.pos);
    const declaration = scan.declarations.find(
      (candidate) =>
        declarationContains(candidate, offset) ||
        (
          offset >= candidate.span.end &&
          session.sourceFile.text.slice(candidate.span.end, offset).trim() === ""
        ),
    );
    if (declaration !== undefined) {
      if (malformedDeclarations.has(declaration)) continue;
      malformedDeclarations.add(declaration);
      diagnostics.push(
        createChzDiagnostic("CHZ1003", fileName, offset, session.sourceFile),
      );
    } else {
      diagnostics.push(
        createTypeScriptDiagnostic(
          diagnostic.code,
          diagnostic.text,
          fileName,
          offset,
          session.sourceFile,
        ),
      );
    }
  }

  for (const island of session.projection.islands) {
    for (const diagnostic of session.project.program.getSyntacticDiagnostics(island.virtualFileName)) {
      diagnostics.push(
        createChzDiagnostic(
          "CHZ1003",
          fileName,
          Math.max(0, diagnostic.pos),
          session.sourceFile,
        ),
      );
    }
  }
}

function deduplicateDiagnostics(diagnostics: readonly ChzDiagnostic[]): ChzDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.offset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.offset - right.offset || left.code.localeCompare(right.code));
}

/**
 * Feasibility entry point. It owns a TypeScript snapshot until dispose() so
 * callers can inspect bound AST nodes and Checker-backed projection evidence.
 */
export function analyzeChzSource(source: string, fileName: string): SpikeAnalysis {
  const scriptKind = scriptKindForFileName(fileName);
  const tsxUnsupported = scriptKind === ScriptKind.TSX;
  const scan = tsxUnsupported
    ? emptyScan()
    : scanCheeseExtensions(
      source,
      fileName,
      tokenizeTypeScript(source, false),
    );
  const session = createProjectionSession(source, fileName, scan);
  const diagnostics: ChzDiagnostic[] = scan.diagnostics.map((diagnostic) =>
    createChzDiagnostic(
      diagnostic.code,
      fileName,
      diagnostic.offset,
      session.sourceFile,
    )
  );

  if (tsxUnsupported) {
    diagnostics.push(
      createChzDiagnostic("CHZ1006", fileName, 0, session.sourceFile),
    );
  } else {
    collectTypeScriptDiagnostics(scan, session, fileName, diagnostics);
    bindAndValidateDeclarations(
      scan.declarations,
      session.sourceFile,
      fileName,
      diagnostics,
    );
    validateOriginIslands(scan, session, fileName, diagnostics);
  }

  return {
    fileName,
    source,
    sourceFile: session.sourceFile,
    profile: scan.profile,
    imagineDeclarations: scan.declarations,
    projection: session.projection,
    diagnostics: deduplicateDiagnostics(diagnostics),
    dispose(): void {
      session.snapshot.dispose();
      session.api.close();
    },
  };
}
