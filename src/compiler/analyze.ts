import {
  ScriptKind,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isPropertyDeclaration,
  isStringLiteralLikeNode,
  type CallExpression,
  type Expression,
  type Node,
  type SourceFile,
  type Statement,
  type StringLiteralLikeNode,
} from "./ts-api.ts";
import {
  createChzDiagnostic,
  createTypeScriptDiagnostic,
} from "./diagnostics.ts";
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
): ChzImagineFunction | undefined {
  const node = findFunctionNode(shell, sourceFile);
  if (node === undefined || !isFunctionDeclaration(node)) return undefined;
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
    span: {
      start: shell.span.start,
      end: node.end,
    },
    bodySpan: node.body === undefined
      ? shell.bodySpan
      : sourceSpan(node.body, sourceFile),
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
) {
  return sourceFile.statements.find(
    (statement) =>
      isClassDeclaration(statement) &&
      statement.name?.text === shell.name &&
      statement.getStart(sourceFile) >= shell.span.start &&
      statement.getStart(sourceFile) < shell.span.end,
  );
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
): ChzImagineMethod | undefined {
  if (shell.kind !== "ImagineMethod") return undefined;
  const node = findClassMemberNode(shell, classNode, sourceFile);
  if (node === undefined || !isMethodDeclaration(node)) return undefined;
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
    span: { start: shell.span.start, end: node.end },
    bodySpan: node.body === undefined
      ? shell.bodySpan
      : sourceSpan(node.body, sourceFile),
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
): ChzImagineProperty | undefined {
  if (shell.kind !== "ImagineProperty") return undefined;
  const node = findClassMemberNode(shell, classNode, sourceFile);
  if (node === undefined || !isPropertyDeclaration(node)) return undefined;
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
): BoundClass | undefined {
  const node = findClassNode(shell, sourceFile);
  if (node === undefined || !isClassDeclaration(node)) return undefined;
  const members = new Map<number, ChzImagineClassMember>();
  for (const [index, memberShell] of shell.members.entries()) {
    const member =
      bindMethod(memberShell, node, sourceFile, fileName, diagnostics) ??
      bindProperty(memberShell, node, sourceFile);
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
): ReadonlyMap<number, BoundDeclaration> {
  const bound = new Map<number, BoundDeclaration>();
  for (const [index, shell] of parsed.declarations.entries()) {
    if (shell.kind === "ImagineFunction") {
      const declaration = bindFunction(
        shell,
        sourceFile,
        fileName,
        diagnostics,
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
    if (declaration?.kind !== "class") continue;

    if (island.owner.memberIndex === null) {
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

    const member = declaration.bound.members.get(
      island.owner.memberIndex,
    );
    if (member?.kind !== "ImagineProperty") continue;
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

function collectTypeScriptDiagnostics(
  parsed: CheeseParseResult,
  projected: ProjectedChzSource,
  compiler: TypeScriptProgramFile,
  fileName: string,
  diagnostics: ChzDiagnostic[],
): void {
  // A committed Cheese failure has the authoritative recovery location. The
  // partially neutralized source is still parsed to obtain one batch lifetime,
  // but its cascading TS parser noise is not surfaced.
  if (parsed.diagnostics.length > 0) return;

  const malformed = new Set<ParsedImagineDeclarationShell>();
  for (
    const diagnostic of compiler.program.getSyntacticDiagnostics(
      compiler.absoluteFileName,
    )
  ) {
    const offset = Math.max(0, diagnostic.pos);
    const declaration = parsed.declarations.find(
      (candidate) =>
        declarationContains(candidate, offset) ||
        (
          offset >= candidate.span.end &&
          compiler.sourceFile.text
            .slice(candidate.span.end, offset)
            .trim() === ""
        ),
    );
    if (declaration !== undefined) {
      if (malformed.has(declaration)) continue;
      malformed.add(declaration);
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
    collectTypeScriptDiagnostics(
      parsed,
      projected,
      compiler,
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
