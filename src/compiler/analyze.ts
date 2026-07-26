import {
  ScriptKind,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isPropertyDeclaration,
  isPropertyAccessExpression,
  isStringLiteralLikeNode,
  type CallExpression,
  type Expression,
  type ElementAccessExpression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  type Statement,
  type StringLiteralLikeNode,
  type TypeScriptDiagnostic,
  type TypeScriptSymbol,
  type TypeScriptType,
} from "./ts-api.ts";
import {
  createChzDiagnostic,
  createHumanTypeScriptDiagnostic,
  createTypeScriptDiagnostic,
} from "./diagnostics.ts";
import { collectModuleReferences } from "./module-specifiers.ts";
import {
  parseCheeseExtensions,
  type CheeseParseResult,
  type ParsedImagineClassMemberShell,
  type ParsedImagineClassShell,
  type ParsedImagineDeclarationShell,
  type ParsedImagineFunctionShell,
} from "./parser.ts";
import {
  createTypeScriptProjection,
  scriptKindForFileName,
  type ProjectedChzSource,
} from "./projection.ts";
import type {
  ChzDiagnostic,
  ChzEnsure,
  ChzImagineClass,
  ChzImagineClassMember,
  ChzImagineDeclaration,
  ChzImagineFunction,
  ChzImagineMethod,
  ChzImagineProperty,
  ChzRequirements,
  ChzSourceFile,
  SourceSpan,
} from "./syntax.ts";
import {
  createTypeScriptProgramBatch,
  type TypeScriptProgramBatch,
  type TypeScriptProgramFile,
} from "./typescript.ts";

export interface ChzSourceInput {
  source: string;
  fileName: string;
}

export interface ChzAnalysisBatch {
  sourceFiles: readonly ChzSourceFile[];
  /**
   * Releases the one snapshot shared by every source file in this batch.
   * Batch callers own this lifetime and must not dispose an individual source
   * while another source still needs its Program or Checker.
   */
  dispose(): void;
}

interface ParsedInput {
  input: ChzSourceInput;
  parsed: CheeseParseResult;
  projected: ProjectedChzSource;
}

interface ContractState {
  requirements: ChzRequirements | null;
  ensures: ChzEnsure[];
}

interface BoundClass {
  declaration: ChzImagineClass;
  members: ReadonlyMap<number, ChzImagineClassMember>;
}

interface HumanClassElement {
  declarationIndex: number;
  node: Node;
  candidateOffset: number;
}

interface ClassBodyClassification {
  humanElements: readonly HumanClassElement[];
  invalidCandidates: readonly {
    declarationIndex: number;
    offset: number;
  }[];
}

type BoundDeclaration =
  | { kind: "function"; declaration: ChzImagineFunction }
  | { kind: "class"; bound: BoundClass };

function sourceSpan(node: { getStart(sourceFile?: SourceFile): number; end: number }, sourceFile: SourceFile): SourceSpan {
  return {
    start: node.getStart(sourceFile),
    end: node.end,
  };
}

function declarationContains(
  declaration: ParsedImagineDeclarationShell,
  offset: number,
): boolean {
  return offset >= declaration.span.start && offset < declaration.span.end;
}

function contractCall(statement: Statement): CallExpression | undefined {
  // Relocation is a Cheese emit rule. Plain .ts parity fixtures must retain
  // TypeScript's native allowance for computed dynamic imports.
  if (
    !isExpressionStatement(statement) ||
    !isCallExpression(statement.expression)
  ) {
    return undefined;
  }
  return statement.expression;
}

function contractName(
  call: CallExpression,
): "requirements" | "ensure" | undefined {
  if (!isIdentifier(call.expression)) return undefined;
  if (
    call.expression.text === "requirements" ||
    call.expression.text === "ensure"
  ) {
    return call.expression.text;
  }
  return undefined;
}

function staticString(
  expression: Expression | undefined,
): StringLiteralLikeNode | undefined {
  return expression !== undefined && isStringLiteralLikeNode(expression)
    ? expression
    : undefined;
}

function zeroArgumentFunction(expression: Expression | undefined): boolean {
  return expression !== undefined &&
    (isArrowFunction(expression) || isFunctionExpression(expression)) &&
    expression.parameters.length === 0;
}

function createEnsure(
  call: CallExpression,
  statement: Statement,
  statementSourceFile: SourceFile,
  mainSourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): ChzEnsure | undefined {
  const first = call.arguments[0];
  const second = call.arguments[1];
  const offset = statement.getStart(statementSourceFile);
  if (first === undefined) {
    diagnostics.push(
      createChzDiagnostic("CHZ2003", fileName, offset, mainSourceFile),
    );
    return undefined;
  }

  const firstMessage = staticString(first);
  if (firstMessage !== undefined) {
    if (call.arguments.length === 1) {
      diagnostics.push(
        createChzDiagnostic("CHZ2004", fileName, offset, mainSourceFile),
      );
      return undefined;
    }
    if (
      call.arguments.length !== 2 ||
      !zeroArgumentFunction(second)
    ) {
      diagnostics.push(
        createChzDiagnostic(
          "CHZ2006",
          fileName,
          second?.getStart(statementSourceFile) ?? offset,
          mainSourceFile,
        ),
      );
      return undefined;
    }
    return {
      kind: "scenario",
      span: sourceSpan(statement, statementSourceFile),
      call,
      conditionOrScenario: second!,
      message: firstMessage,
    };
  }

  if (isArrowFunction(first) || isFunctionExpression(first)) {
    diagnostics.push(
      createChzDiagnostic("CHZ2005", fileName, offset, mainSourceFile),
    );
    return undefined;
  }
  if (call.arguments.length > 2) {
    diagnostics.push(
      createChzDiagnostic("CHZ2007", fileName, offset, mainSourceFile),
    );
    return undefined;
  }

  const message = staticString(second);
  if (second !== undefined && message === undefined) {
    diagnostics.push(
      createChzDiagnostic(
        "CHZ2008",
        fileName,
        second.getStart(statementSourceFile),
        mainSourceFile,
      ),
    );
    return undefined;
  }
  return {
    kind: "assertion",
    span: sourceSpan(statement, statementSourceFile),
    call,
    conditionOrScenario: first,
    message: message ?? null,
  };
}

function validateContractStatements(
  statements: readonly Statement[],
  statementSourceFile: SourceFile,
  mainSourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
  initial?: ContractState,
): ContractState {
  const state: ContractState = initial ?? {
    requirements: null,
    ensures: [],
  };

  for (const statement of statements) {
    const call = contractCall(statement);
    const name = call === undefined ? undefined : contractName(call);
    const offset = statement.getStart(statementSourceFile);
    if (call === undefined || name === undefined) {
      diagnostics.push(
        createChzDiagnostic("CHZ1004", fileName, offset, mainSourceFile),
      );
      continue;
    }

    if (name === "ensure") {
      const ensure = createEnsure(
        call,
        statement,
        statementSourceFile,
        mainSourceFile,
        fileName,
        diagnostics,
      );
      if (ensure !== undefined) state.ensures.push(ensure);
      continue;
    }

    const argument = call.arguments[0];
    const value = staticString(argument);
    if (call.arguments.length !== 1 || value === undefined) {
      diagnostics.push(
        createChzDiagnostic(
          "CHZ2001",
          fileName,
          argument?.getStart(statementSourceFile) ?? call.expression.end,
          mainSourceFile,
        ),
      );
      continue;
    }
    if (state.requirements !== null) {
      diagnostics.push(
        createChzDiagnostic("CHZ2002", fileName, offset, mainSourceFile),
      );
      continue;
    }
    state.requirements = {
      kind: "Requirements",
      span: sourceSpan(statement, statementSourceFile),
      call,
      value,
    };
  }

  return state;
}

function emptyContractState(): ContractState {
  return { requirements: null, ensures: [] };
}

function findFunctionNode(
  shell: ParsedImagineFunctionShell,
  sourceFile: SourceFile,
) {
  return sourceFile.statements.find(
    (statement) =>
      isFunctionDeclaration(statement) &&
      statement.name?.text === shell.name &&
      statement.getStart(sourceFile) >= shell.span.start &&
      statement.getStart(sourceFile) < shell.span.end,
  );
}

function bindFunction(
  shell: ParsedImagineFunctionShell,
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
  validateTypeAnnotation: boolean,
): ChzImagineFunction | undefined {
  const node = findFunctionNode(shell, sourceFile);
  if (node === undefined || !isFunctionDeclaration(node)) return undefined;
  if (validateTypeAnnotation && node.type === undefined) {
    diagnostics.push(
      createChzDiagnostic(
        "CHZ1009",
        fileName,
        node.parameters.end + 1,
        sourceFile,
      ),
    );
  }
  const contracts = node.body === undefined
    ? emptyContractState()
    : validateContractStatements(
      node.body.statements,
      sourceFile,
      sourceFile,
      fileName,
      diagnostics,
    );
  return {
    ...shell,
    span: shell.span,
    bodySpan: shell.bodySpan,
    declaration: node,
    parameters: node.parameters,
    returnType: node.type ?? null,
    requirements: contracts.requirements,
    ensures: contracts.ensures,
  };
}

function findClassNode(
  shell: ParsedImagineClassShell,
  sourceFile: SourceFile,
): ChzImagineClass["declaration"] | undefined {
  const node = sourceFile.statements.find(
    (statement) =>
      isClassDeclaration(statement) &&
      statement.name?.text === shell.name &&
      statement.getStart(sourceFile) >= shell.span.start &&
      statement.getStart(sourceFile) < shell.span.end,
  );
  return node !== undefined && isClassDeclaration(node) ? node : undefined;
}

function classifyClassBodyCandidates(
  parsed: CheeseParseResult,
  sourceFile: SourceFile,
): ClassBodyClassification {
  const humanElements: HumanClassElement[] = [];
  const invalidCandidates: {
    declarationIndex: number;
    offset: number;
  }[] = [];

  for (const [declarationIndex, shell] of parsed.declarations.entries()) {
    if (shell.kind !== "ImagineClass") continue;
    const classNode = findClassNode(shell, sourceFile);
    for (const offset of shell.unclassifiedMemberOffsets) {
      const node = classNode?.members.find((candidate) => {
        const start = candidate.getStart(sourceFile);
        return offset >= start && offset < candidate.end;
      });
      if (node === undefined) {
        invalidCandidates.push({ declarationIndex, offset });
        continue;
      }

      // The scanner can encounter another apparent member boundary inside a
      // TypeScript type or initializer. Collapse those offsets by AST span:
      // the compiler's ClassElement, not a Cheese syntax allowlist, owns the
      // complete human member and automatically covers future TS member forms.
      const existing = humanElements.find(
        (candidate) =>
          candidate.declarationIndex === declarationIndex &&
          candidate.node.getStart(sourceFile) === node.getStart(sourceFile) &&
          candidate.node.end === node.end,
      );
      if (existing === undefined) {
        humanElements.push({
          declarationIndex,
          node,
          candidateOffset: offset,
        });
      } else if (offset < existing.candidateOffset) {
        existing.candidateOffset = offset;
      }
    }
  }

  return { humanElements, invalidCandidates };
}

function humanClassElementAt(
  classification: ClassBodyClassification,
  sourceFile: SourceFile,
  offset: number,
): HumanClassElement | undefined {
  return classification.humanElements.find(({ node }) => {
    const start = node.getStart(sourceFile);
    return offset >= start && offset < node.end;
  });
}

function memberName(
  member: { name: Node },
): string | undefined {
  return isIdentifier(member.name) ? member.name.text : undefined;
}

function findClassMemberNode(
  shell: ParsedImagineClassMemberShell,
  classNode: ChzImagineClass["declaration"],
  sourceFile: SourceFile,
) {
  return classNode.members.find((candidate) => {
    if (
      !(isMethodDeclaration(candidate) || isPropertyDeclaration(candidate))
    ) {
      return false;
    }
    return memberName(candidate) === shell.name &&
      candidate.getStart(sourceFile) >= shell.span.start &&
      candidate.getStart(sourceFile) < shell.span.end;
  });
}

function bindMethod(
  shell: ParsedImagineClassMemberShell,
  classNode: ChzImagineClass["declaration"],
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
  validateTypeAnnotation: boolean,
): ChzImagineMethod | undefined {
  if (shell.kind !== "ImagineMethod") return undefined;
  const node = findClassMemberNode(shell, classNode, sourceFile);
  if (node === undefined || !isMethodDeclaration(node)) return undefined;
  if (validateTypeAnnotation && node.type === undefined) {
    diagnostics.push(
      createChzDiagnostic(
        "CHZ1009",
        fileName,
        node.parameters.end + 1,
        sourceFile,
      ),
    );
  }
  const contracts = node.body === undefined
    ? emptyContractState()
    : validateContractStatements(
      node.body.statements,
      sourceFile,
      sourceFile,
      fileName,
      diagnostics,
    );
  return {
    ...shell,
    span: shell.span,
    bodySpan: shell.bodySpan,
    declaration: node,
    parameters: node.parameters,
    returnType: node.type ?? null,
    requirements: contracts.requirements,
    ensures: contracts.ensures,
  };
}

function bindProperty(
  shell: ParsedImagineClassMemberShell,
  classNode: ChzImagineClass["declaration"],
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
  validateTypeAnnotation: boolean,
): ChzImagineProperty | undefined {
  if (shell.kind !== "ImagineProperty") return undefined;
  const node = findClassMemberNode(shell, classNode, sourceFile);
  if (node === undefined || !isPropertyDeclaration(node)) return undefined;
  if (validateTypeAnnotation && node.type === undefined) {
    diagnostics.push(
      createChzDiagnostic(
        "CHZ1009",
        fileName,
        node.name.end,
        sourceFile,
      ),
    );
  }
  return {
    ...shell,
    declaration: node,
    returnType: node.type ?? null,
    requirements: null,
    ensures: [],
  };
}

function bindClass(
  shell: ParsedImagineClassShell,
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
  validateTypeAnnotations: boolean,
): BoundClass | undefined {
  const node = findClassNode(shell, sourceFile);
  if (node === undefined || !isClassDeclaration(node)) return undefined;
  const members = new Map<number, ChzImagineClassMember>();
  for (const [index, memberShell] of shell.members.entries()) {
    const member =
      bindMethod(
        memberShell,
        node,
        sourceFile,
        fileName,
        diagnostics,
        validateTypeAnnotations,
      ) ??
      bindProperty(
        memberShell,
        node,
        sourceFile,
        fileName,
        diagnostics,
        validateTypeAnnotations,
      );
    if (member !== undefined) members.set(index, member);
  }
  return {
    declaration: {
      kind: "ImagineClass",
      name: shell.name,
      span: { start: shell.span.start, end: node.end },
      imagineSpan: shell.imagineSpan,
      bodySpan: shell.bodySpan,
      exported: shell.exported,
      declaration: node,
      requirements: null,
      ensures: [],
      members: [...members.values()],
    },
    members,
  };
}

function bindDeclarations(
  parsed: CheeseParseResult,
  sourceFile: SourceFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
  malformedDeclarations: ReadonlySet<number>,
): ReadonlyMap<number, BoundDeclaration> {
  const bound = new Map<number, BoundDeclaration>();
  for (const [index, shell] of parsed.declarations.entries()) {
    if (shell.kind === "ImagineFunction") {
      const declaration = bindFunction(
        shell,
        sourceFile,
        fileName,
        diagnostics,
        !malformedDeclarations.has(index),
      );
      if (declaration !== undefined) {
        bound.set(index, { kind: "function", declaration });
      }
    } else {
      const classDeclaration = bindClass(
        shell,
        sourceFile,
        fileName,
        diagnostics,
        !malformedDeclarations.has(index),
      );
      if (classDeclaration !== undefined) {
        bound.set(index, { kind: "class", bound: classDeclaration });
      }
    }
  }
  return bound;
}

function validateIslands(
  projected: ProjectedChzSource,
  compiler: TypeScriptProgramFile,
  bound: ReadonlyMap<number, BoundDeclaration>,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  for (const island of projected.projection.islands) {
    const sourceFile = compiler.islandSourceFiles.get(
      island.virtualFileName,
    );
    if (sourceFile === undefined) continue;
    const declaration = bound.get(island.owner.declarationIndex);
    if (declaration === undefined) continue;

    if (
      island.kind === "callable-contract-body" &&
      declaration.kind === "function"
    ) {
      const target = declaration.declaration;
      const state = validateContractStatements(
        sourceFile.statements,
        sourceFile,
        compiler.sourceFile,
        fileName,
        diagnostics,
      );
      target.requirements = state.requirements;
      target.ensures = state.ensures;
      continue;
    }

    if (declaration.kind !== "class") continue;

    if (island.kind === "class-contract-statement") {
      const target = declaration.bound.declaration;
      const state = validateContractStatements(
        sourceFile.statements,
        sourceFile,
        compiler.sourceFile,
        fileName,
        diagnostics,
        {
          requirements: target.requirements,
          ensures: target.ensures,
        },
      );
      target.requirements = state.requirements;
      target.ensures = state.ensures;
      continue;
    }

    if (island.owner.memberIndex === null) continue;
    const member = declaration.bound.members.get(island.owner.memberIndex);
    if (member === undefined) continue;
    const state = validateContractStatements(
      sourceFile.statements,
      sourceFile,
      compiler.sourceFile,
      fileName,
      diagnostics,
    );
    member.requirements = state.requirements;
    member.ensures = state.ensures;
  }
}

type DiagnosticMemberAccess =
  | PropertyAccessExpression
  | ElementAccessExpression;

const OBLIGATION_DIAGNOSTIC_CODES = new Set([2339, 2551]);

function diagnosticNode(
  diagnostic: TypeScriptDiagnostic,
  sourceFile: SourceFile,
): Node | undefined {
  const start = Math.max(0, diagnostic.pos);
  const end = Math.max(start, diagnostic.end);
  let deepest: Node | undefined;
  const visit = (node: Node): void => {
    const nodeStart = node.getStart(sourceFile);
    if (start < nodeStart || end > node.end) return;
    deepest = node;
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return deepest;
}

function diagnosticMemberAccess(
  diagnostic: TypeScriptDiagnostic,
  sourceFile: SourceFile,
): DiagnosticMemberAccess | undefined {
  let node = diagnosticNode(diagnostic, sourceFile);
  while (node !== undefined && node !== sourceFile) {
    if (isPropertyAccessExpression(node)) return node;
    if (
      isElementAccessExpression(node) &&
      isStringLiteralLikeNode(node.argumentExpression)
    ) {
      return node;
    }
    node = node.parent;
  }
  return undefined;
}

function imagineSymbols(
  declarations: readonly ChzImagineDeclaration[],
  compiler: TypeScriptProgramFile,
): {
  ids: ReadonlySet<number>;
  declarationKeys: ReadonlySet<string>;
} {
  const ids = new Set<number>();
  const declarationKeys = new Set<string>();
  for (const declaration of declarations) {
    const name = declaration.declaration.name;
    if (name !== undefined) {
      const symbol = compiler.checker.getSymbolAtLocation(name);
      if (symbol !== undefined) ids.add(symbol.id);
    }
    declarationKeys.add(
      `${compiler.absoluteFileName}:${declaration.declaration.getStart(compiler.sourceFile)}`,
    );
  }
  return { ids, declarationKeys };
}

function symbolOwnedByImagine(
  symbol: TypeScriptSymbol,
  owners: ReturnType<typeof imagineSymbols>,
): boolean {
  if (owners.ids.has(symbol.id)) return true;
  for (const handle of symbol.declarations) {
    const declaration = handle.resolve();
    if (declaration === undefined) continue;
    const key =
      `${declaration.getSourceFile().fileName}:${declaration.getStart(declaration.getSourceFile())}`;
    if (owners.declarationKeys.has(key)) return true;
  }
  return false;
}

function typeOwnedByImagine(
  type: TypeScriptType,
  checker: TypeScriptProgramFile["checker"],
  owners: ReturnType<typeof imagineSymbols>,
  visited = new Set<number>(),
): boolean {
  if (visited.has(type.id)) return false;
  visited.add(type.id);

  // A union/intersection is only imagine-owned when every branch is. Treating
  // one nested imagine type as ownership would leak human-object TS2339 errors
  // into the obligation list.
  if (type.isUnionType() || type.isIntersectionType()) {
    const branches = type.getTypes();
    return branches.length > 0 &&
      branches.every((branch) =>
        typeOwnedByImagine(branch, checker, owners, visited)
      );
  }

  const symbol = type.getSymbol();
  if (symbol !== undefined && symbolOwnedByImagine(symbol, owners)) {
    return true;
  }
  const alias = type.getAliasSymbol();
  if (alias !== undefined && symbolOwnedByImagine(alias, owners)) {
    return true;
  }

  if (type.isTypeReference()) {
    const target = type.getTarget();
    if (
      target.id !== type.id &&
      typeOwnedByImagine(target, checker, owners, visited)
    ) {
      return true;
    }
  }

  for (const base of type.getBaseTypes() ?? []) {
    if (typeOwnedByImagine(base, checker, owners, visited)) return true;
  }

  const apparent = checker.getApparentType(type);
  return apparent !== undefined &&
    apparent.id !== type.id &&
    typeOwnedByImagine(apparent, checker, owners, visited);
}

function isImagineObligation(
  diagnostic: TypeScriptDiagnostic,
  compiler: TypeScriptProgramFile,
  owners: ReturnType<typeof imagineSymbols>,
): boolean {
  if (!OBLIGATION_DIAGNOSTIC_CODES.has(diagnostic.code)) return false;
  const access = diagnosticMemberAccess(diagnostic, compiler.sourceFile);
  if (access === undefined) return false;
  const objectType = compiler.checker.getTypeAtLocation(access.expression);
  if (objectType === undefined) return false;

  // Ownership, not TS2339/TS2551 alone, is the contract boundary. A code-only
  // allowlist would silently hand an ordinary human object typo to the LLM.
  // Explicit `required imagine func/var` declarations do not use this path:
  // v0 has no such grammar yet, and a future implementation must collect those
  // obligations directly from their declarations because their stubs diagnose
  // no missing name or member.
  return typeOwnedByImagine(objectType, compiler.checker, owners);
}

function collectSemanticDiagnostics(
  compiler: TypeScriptProgramFile,
  declarations: readonly ChzImagineDeclaration[],
  classBody: ClassBodyClassification,
  fileName: string,
): {
  obligations: ChzDiagnostic[];
  humanErrors: ChzDiagnostic[];
} {
  const obligations: ChzDiagnostic[] = [];
  const humanErrors: ChzDiagnostic[] = [];
  const owners = imagineSymbols(declarations, compiler);
  for (
    const diagnostic of compiler.program.getSemanticDiagnostics(
      compiler.absoluteFileName,
    )
  ) {
    const offset = Math.max(0, diagnostic.pos);
    const humanElement = humanClassElementAt(
      classBody,
      compiler.sourceFile,
      offset,
    );
    if (
      humanElement !== undefined &&
      (
        diagnostic.code === 1036 ||
        diagnostic.code === 1039 ||
        diagnostic.code === 1040 ||
        diagnostic.code === 1183
      )
    ) {
      // The production projection intentionally turns the owning imagine
      // class into an ambient `declare class`. Human implementations remain
      // in the AST so the prompt can retain them; these four diagnostics are
      // artifacts of that projection, while ordinary type errors in the same
      // bodies continue through the normal TypeScript diagnostic path.
      continue;
    }
    if (isImagineObligation(diagnostic, compiler, owners)) {
      obligations.push(
        createTypeScriptDiagnostic(
          diagnostic.code,
          diagnostic.text,
          fileName,
          offset,
          compiler.sourceFile,
        ),
      );
      continue;
    }
    humanErrors.push(
      createHumanTypeScriptDiagnostic(
        diagnostic.code,
        diagnostic.text,
        fileName,
        offset,
        compiler.sourceFile,
      ),
    );
  }
  return { obligations, humanErrors };
}

function collectStaticRuleDiagnostics(
  compiler: TypeScriptProgramFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  const sourceFiles = [
    compiler.sourceFile,
    ...compiler.islandSourceFiles.values(),
  ];
  for (const sourceFile of sourceFiles) {
    for (
      const reference of collectModuleReferences(
        sourceFile,
        compiler.checker,
      )
    ) {
      if (reference.specifier !== null) continue;
      const argument = reference.node.arguments[0];
      diagnostics.push(
        createChzDiagnostic(
          "CHZ3001",
          fileName,
          argument?.getStart(sourceFile) ??
            reference.node.getStart(sourceFile),
          compiler.sourceFile,
        ),
      );
    }
  }
}

function collectTypeScriptDiagnostics(
  parsed: CheeseParseResult,
  projected: ProjectedChzSource,
  compiler: TypeScriptProgramFile,
  classBody: ClassBodyClassification,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): ReadonlySet<number> {
  const malformed = new Set<number>();
  // A committed Cheese failure has the authoritative recovery location. The
  // partially neutralized source is still parsed to obtain one batch lifetime,
  // but its cascading TS parser noise is not surfaced.
  if (parsed.diagnostics.length > 0) {
    for (const index of parsed.declarations.keys()) malformed.add(index);
    return malformed;
  }

  for (const candidate of classBody.invalidCandidates) {
    malformed.add(candidate.declarationIndex);
    diagnostics.push(
      createChzDiagnostic(
        "CHZ1004",
        fileName,
        candidate.offset,
        compiler.sourceFile,
      ),
    );
  }

  for (
    const diagnostic of compiler.program.getSemanticDiagnostics(
      compiler.absoluteFileName,
    )
  ) {
    if (diagnostic.code !== 1248) continue;
    const humanElement = humanClassElementAt(
      classBody,
      compiler.sourceFile,
      Math.max(0, diagnostic.pos),
    );
    if (humanElement === undefined) continue;

    // TypeScript error recovery represents `const x = ...` in a class body as
    // a PropertyDeclaration even though TS1248 says it is not a legal class
    // member. Treat that statement-shaped recovery node as CHZ1004 before the
    // ordinary semantic pass, matching other invalid class-body candidates.
    malformed.add(humanElement.declarationIndex);
    diagnostics.push(
      createChzDiagnostic(
        "CHZ1004",
        fileName,
        humanElement.candidateOffset,
        compiler.sourceFile,
      ),
    );
  }

  for (
    const diagnostic of compiler.program.getSyntacticDiagnostics(
      compiler.absoluteFileName,
    )
  ) {
    const offset = Math.max(0, diagnostic.pos);
    const declarationIndex = parsed.declarations.findIndex(
      (candidate) =>
        declarationContains(candidate, offset) ||
        (
          offset >= candidate.span.end &&
          compiler.sourceFile.text
            .slice(candidate.span.end, offset)
            .trim() === ""
        ),
    );
    if (declarationIndex >= 0) {
      if (malformed.has(declarationIndex)) continue;
      malformed.add(declarationIndex);
      diagnostics.push(
        createChzDiagnostic(
          "CHZ1003",
          fileName,
          offset,
          compiler.sourceFile,
        ),
      );
    } else {
      diagnostics.push(
        createTypeScriptDiagnostic(
          diagnostic.code,
          diagnostic.text,
          fileName,
          offset,
          compiler.sourceFile,
        ),
      );
    }
  }

  for (const island of projected.projection.islands) {
    for (
      const diagnostic of compiler.program.getSyntacticDiagnostics(
        island.virtualFileName,
      )
    ) {
      malformed.add(island.owner.declarationIndex);
      diagnostics.push(
        createChzDiagnostic(
          "CHZ1003",
          fileName,
          Math.max(0, diagnostic.pos),
          compiler.sourceFile,
        ),
      );
    }
  }
  return malformed;
}

function deduplicateDiagnostics(
  diagnostics: readonly ChzDiagnostic[],
): ChzDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics
    .filter((diagnostic) => {
      const key = `${diagnostic.code}:${diagnostic.offset}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        left.offset - right.offset ||
        left.code.localeCompare(right.code),
    );
}

function analyzeParsedInput(
  parsedInput: ParsedInput,
  compiler: TypeScriptProgramFile,
  dispose: () => void,
): ChzSourceFile {
  const { input, parsed, projected } = parsedInput;
  const diagnostics = parsed.diagnostics.map((diagnostic) =>
    createChzDiagnostic(
      diagnostic.code,
      input.fileName,
      diagnostic.offset,
      compiler.sourceFile,
    )
  );
  const tsxUnsupported =
    scriptKindForFileName(input.fileName) === ScriptKind.TSX;
  const classBody = classifyClassBodyCandidates(
    parsed,
    compiler.sourceFile,
  );
  let malformedDeclarations: ReadonlySet<number> = new Set();
  if (tsxUnsupported) {
    diagnostics.push(
      createChzDiagnostic(
        "CHZ1006",
        input.fileName,
        0,
        compiler.sourceFile,
      ),
    );
  } else {
    malformedDeclarations = collectTypeScriptDiagnostics(
      parsed,
      projected,
      compiler,
      classBody,
      input.fileName,
      diagnostics,
    );
  }

  const bound = tsxUnsupported
    ? new Map<number, BoundDeclaration>()
    : bindDeclarations(
      parsed,
      compiler.sourceFile,
      input.fileName,
      diagnostics,
      malformedDeclarations,
    );
  if (!tsxUnsupported) {
    validateIslands(
      projected,
      compiler,
      bound,
      input.fileName,
      diagnostics,
    );
  }

  const imagineDeclarations: ChzImagineDeclaration[] = [];
  for (const declaration of bound.values()) {
    imagineDeclarations.push(
      declaration.kind === "function"
        ? declaration.declaration
        : declaration.bound.declaration,
    );
  }

  if (
    diagnostics.length === 0 &&
    input.fileName.toLowerCase().endsWith(".chz.ts")
  ) {
    collectStaticRuleDiagnostics(
      compiler,
      input.fileName,
      diagnostics,
    );
  }

  let obligations: ChzDiagnostic[] = [];
  if (diagnostics.length === 0 && imagineDeclarations.length > 0) {
    const semantic = collectSemanticDiagnostics(
      compiler,
      imagineDeclarations,
      classBody,
      input.fileName,
    );
    obligations = deduplicateDiagnostics(semantic.obligations);
    diagnostics.push(...semantic.humanErrors);
  }

  return {
    fileName: input.fileName,
    source: input.source,
    profile: parsed.profile,
    imagineDeclarations,
    typescript: {
      projectedSource: projected.projection.projectedSource,
      sourceFile: compiler.sourceFile,
      program: compiler.program,
      checker: compiler.checker,
      islands: compiler.islandSourceFiles,
    },
    obligations,
    diagnostics: deduplicateDiagnostics(diagnostics),
    dispose,
  };
}

export function analyzeChzSources(
  inputs: readonly ChzSourceInput[],
): ChzAnalysisBatch {
  if (inputs.length === 0) {
    throw new Error("Cheese analysis requires at least one source.");
  }
  const parsedInputs: ParsedInput[] = inputs.map((input) => {
    const parsed = parseCheeseExtensions(input.source, input.fileName);
    return {
      input,
      parsed,
      projected: createTypeScriptProjection(
        input.source,
        input.fileName,
        parsed,
      ),
    };
  });

  let compilerBatch: TypeScriptProgramBatch | undefined =
    createTypeScriptProgramBatch(
      parsedInputs.map((input) => input.projected),
    );
  const dispose = (): void => {
    compilerBatch?.dispose();
    compilerBatch = undefined;
  };

  try {
    const sourceFiles = parsedInputs.map((parsedInput) => {
      const compiler = compilerBatch?.files.get(
        parsedInput.projected.absoluteFileName,
      );
      if (compiler === undefined) {
        throw new Error(
          `TypeScript batch lost '${parsedInput.input.fileName}' before AST binding.`,
        );
      }
      return analyzeParsedInput(parsedInput, compiler, dispose);
    });
    return { sourceFiles, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export function analyzeChzSource(
  source: string,
  fileName: string,
): ChzSourceFile {
  return analyzeChzSources([{ source, fileName }]).sourceFiles[0]!;
}
