import { dirname, resolve } from "node:path";

import {
  isArrayBindingPattern,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isObjectBindingPattern,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
  type Project,
  type SourceFile,
  type Statement,
  type TypeScriptSymbol,
} from "./compiler/ts-api.ts";
import {
  API,
  createVirtualFileSystem,
} from "./compiler/ts-api.ts";

import type { ImagineSpec } from "./preprocessor.ts";

export interface HumanCodeSplit {
  prologue: string;
  epilogue: string;
}

interface HumanStatement {
  node: Statement;
  identifiers: Identifier[];
  content: string;
}

/**
 * Split human-owned top-level statements around the realized symbol layer.
 * A statement moves to the epilogue when it references an imagine symbol, or
 * transitively references another human statement that had to move there.
 */
export function splitHumanCode(
  source: string,
  fileName: string,
  specs: readonly ImagineSpec[],
): HumanCodeSplit {
  const orderedSpecs = [...specs].sort((left, right) => left.start - right.start);
  const parseableSource = replaceImagineDeclarations(source, orderedSpecs);
  const absoluteFile = resolve(fileName);
  const api = new API({
    cwd: dirname(absoluteFile),
    fs: createVirtualFileSystem({ [absoluteFile]: parseableSource }),
  });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;

  try {
    snapshot = api.updateSnapshot({ openFiles: [absoluteFile] });
    const project = snapshot.getDefaultProjectForFile(absoluteFile);
    const sourceFile = project?.program.getSourceFile(absoluteFile);
    if (project === undefined || sourceFile === undefined) {
      throw new Error(`Could not parse human-owned code from ${fileName}.`);
    }

    const placeholderStatements = new Set<Statement>();
    const placeholderSpec = new Map<Statement, ImagineSpec>();
    const humanStatements: HumanStatement[] = [];
    const humanIndex = new Map<Statement, number>();

    for (const statement of sourceFile.statements) {
      const start = statement.getStart(sourceFile);
      const spec = orderedSpecs.find((candidate) => start >= candidate.start && start < candidate.end);
      if (spec !== undefined) {
        placeholderStatements.add(statement);
        placeholderSpec.set(statement, spec);
        continue;
      }
      humanIndex.set(statement, humanStatements.length);
      humanStatements.push({ node: statement, identifiers: collectIdentifiers(statement), content: "" });
    }

    const imagineSymbolIds = collectImagineSymbolIds(
      [...placeholderStatements],
      placeholderSpec,
      project,
    );
    const symbolsByStatement = humanStatements.map((statement) =>
      project.checker.getSymbolAtLocation(statement.identifiers),
    );
    const ownersBySymbol = collectSymbolOwners(symbolsByStatement, humanStatements, sourceFile, project);
    const epilogueStatements = classifyEpilogueStatements(
      symbolsByStatement,
      imagineSymbolIds,
      ownersBySymbol,
    );

    const standaloneTrivia = assignOriginalStatementContent(
      source,
      sourceFile,
      orderedSpecs,
      placeholderStatements,
      humanStatements,
      humanIndex,
    );

    const prologueStatements = humanStatements.filter((_, index) => !epilogueStatements.has(index));
    const epilogueBody = humanStatements
      .filter((_, index) => epilogueStatements.has(index))
      .map((statement) => statement.content)
      .join("");
    const prologueBody = standaloneTrivia + prologueStatements.map((statement) => statement.content).join("");
    const prologueNames = collectTopLevelNames(prologueStatements.map((statement) => statement.node));
    const namedExports = collectNamedExports(prologueStatements.map((statement) => statement.node));

    return {
      prologue: renderPrologue(prologueBody, prologueNames, namedExports),
      epilogue: renderEpilogue(epilogueBody, prologueNames, orderedSpecs),
    };
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

function replaceImagineDeclarations(source: string, specs: readonly ImagineSpec[]): string {
  let result = "";
  let cursor = 0;
  for (const spec of specs) {
    const declaration = renderImaginePlaceholder(spec);
    if (declaration.length > spec.originalText.length) {
      throw new Error(`Could not create a parser placeholder for imagine symbol '${spec.name}'.`);
    }
    const blanked = spec.originalText.replace(/[^\r\n]/g, " ");
    result += source.slice(cursor, spec.start);
    result += declaration + blanked.slice(declaration.length);
    cursor = spec.end;
  }
  return result + source.slice(cursor);
}

function renderImaginePlaceholder(spec: ImagineSpec): string {
  if (spec.type === "function") {
    return `declare function ${spec.name}(${spec.parameters})${spec.returnType === "" ? "" : `: ${spec.returnType}`};`;
  }

  const members = spec.members.map((member) => {
    const staticModifier = member.modifiers.includes("static") ? "static " : "";
    if (member.type === "property") {
      const readonlyModifier = member.modifiers.includes("readonly") ? "readonly " : "";
      return `  ${staticModifier}${readonlyModifier}${member.name}: ${member.returnType};`;
    }
    const returnType = member.returnType || (member.modifiers.includes("async") ? "Promise<void>" : "void");
    if (member.name === "constructor") return `  constructor(${member.parameters});`;
    return `  ${staticModifier}${member.name}(${member.parameters}): ${returnType};`;
  });
  return members.length === 0
    ? `declare class ${spec.name} {}`
    : `declare class ${spec.name} {\n${members.join("\n")}\n}`;
}

function collectIdentifiers(root: Node): Identifier[] {
  const identifiers: Identifier[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) identifiers.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return identifiers;
}

function collectImagineSymbolIds(
  statements: readonly Statement[],
  specs: ReadonlyMap<Statement, ImagineSpec>,
  project: Project,
): Set<number> {
  const identifiers = statements.flatMap((statement) => {
    const spec = specs.get(statement);
    return (
      (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.name !== undefined &&
      statement.name.text === spec?.name
    )
      ? [statement.name]
      : [];
  });
  return new Set(
    project.checker.getSymbolAtLocation(identifiers)
      .flatMap((symbol) => symbol === undefined ? [] : [symbol.id]),
  );
}

function collectSymbolOwners(
  symbolGroups: readonly (TypeScriptSymbol | undefined)[][],
  statements: readonly HumanStatement[],
  sourceFile: SourceFile,
  project: Project,
): Map<number, Set<number>> {
  const owners = new Map<number, Set<number>>();
  const symbols = new Map<number, TypeScriptSymbol>();
  for (const group of symbolGroups) {
    for (const symbol of group) {
      if (symbol !== undefined) symbols.set(symbol.id, symbol);
    }
  }

  for (const symbol of symbols.values()) {
    for (const declarationHandle of symbol.declarations) {
      const declaration = declarationHandle.resolve(project);
      if (declaration === undefined || declaration.getSourceFile().fileName !== sourceFile.fileName) continue;
      const position = declaration.getStart(sourceFile);
      const owner = statements.findIndex(
        (statement) => position >= statement.node.getStart(sourceFile) && position < statement.node.end,
      );
      if (owner < 0) continue;
      const symbolOwners = owners.get(symbol.id) ?? new Set<number>();
      symbolOwners.add(owner);
      owners.set(symbol.id, symbolOwners);
    }
  }
  return owners;
}

function classifyEpilogueStatements(
  symbolGroups: readonly (TypeScriptSymbol | undefined)[][],
  imagineSymbolIds: ReadonlySet<number>,
  ownersBySymbol: ReadonlyMap<number, ReadonlySet<number>>,
): Set<number> {
  const epilogue = new Set<number>();
  const dependencies = symbolGroups.map(() => new Set<number>());

  symbolGroups.forEach((symbols, statementIndex) => {
    for (const symbol of symbols) {
      if (symbol === undefined) continue;
      if (imagineSymbolIds.has(symbol.id)) epilogue.add(statementIndex);
      for (const owner of ownersBySymbol.get(symbol.id) ?? []) {
        if (owner !== statementIndex) dependencies[statementIndex]!.add(owner);
      }
    }
  });

  for (const symbolOwners of ownersBySymbol.values()) {
    for (const owner of symbolOwners) {
      for (const sibling of symbolOwners) {
        if (owner !== sibling) dependencies[owner]!.add(sibling);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    dependencies.forEach((statementDependencies, statementIndex) => {
      if (epilogue.has(statementIndex)) return;
      if ([...statementDependencies].some((dependency) => epilogue.has(dependency))) {
        epilogue.add(statementIndex);
        changed = true;
      }
    });
  }
  return epilogue;
}

function assignOriginalStatementContent(
  source: string,
  sourceFile: SourceFile,
  specs: readonly ImagineSpec[],
  placeholderStatements: ReadonlySet<Statement>,
  humanStatements: HumanStatement[],
  humanIndex: ReadonlyMap<Statement, number>,
): string {
  let cursor = 0;
  let pendingTrivia = "";

  for (const statement of sourceFile.statements) {
    const start = statement.getStart(sourceFile);
    if (placeholderStatements.has(statement)) {
      pendingTrivia += sliceWithoutImagine(source, cursor, start, specs);
      cursor = statement.end;
      continue;
    }

    const index = humanIndex.get(statement);
    if (index === undefined) continue;
    humanStatements[index]!.content = pendingTrivia + sliceWithoutImagine(source, cursor, statement.end, specs);
    pendingTrivia = "";
    cursor = statement.end;
  }

  const tail = pendingTrivia + sliceWithoutImagine(source, cursor, source.length, specs);
  if (humanStatements.length === 0) {
    return tail;
  }
  humanStatements.at(-1)!.content += tail;
  return "";
}

function sliceWithoutImagine(
  source: string,
  start: number,
  end: number,
  specs: readonly ImagineSpec[],
): string {
  let result = "";
  let cursor = start;
  for (const spec of specs) {
    if (spec.end <= cursor || spec.start >= end) continue;
    result += source.slice(cursor, Math.max(cursor, spec.start));
    cursor = Math.max(cursor, Math.min(end, spec.end));
  }
  return result + source.slice(cursor, end);
}

function collectTopLevelNames(statements: readonly Statement[]): string[] {
  const names: string[] = [];
  const add = (name: string): void => {
    if (!names.includes(name)) names.push(name);
  };
  const addBinding = (node: Node): void => {
    if (isIdentifier(node)) {
      add(node.text);
    } else if (isObjectBindingPattern(node) || isArrayBindingPattern(node)) {
      for (const element of node.elements) {
        if ("name" in element && element.name !== undefined) addBinding(element.name);
      }
    }
  };

  for (const statement of statements) {
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBinding(declaration.name);
    } else if (
      isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isModuleDeclaration(statement)
    ) {
      if (statement.name !== undefined && isIdentifier(statement.name)) add(statement.name.text);
    } else if (isImportEqualsDeclaration(statement)) {
      add(statement.name.text);
    } else if (isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && isNamespaceImport(bindings)) add(bindings.name.text);
      if (bindings !== undefined && isNamedImports(bindings)) {
        for (const element of bindings.elements) add(element.name.text);
      }
    }
  }
  return names;
}

function collectNamedExports(statements: readonly Statement[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (/^export\s+(?!default\b)/u.test(statement.getText())) {
      for (const name of collectTopLevelNames([statement])) names.add(name);
    }
    if (
      isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
  }
  return names;
}

function renderPrologue(body: string, names: readonly string[], namedExports: ReadonlySet<string>): string {
  const missingExports = names.filter((name) => !namedExports.has(name));
  let rendered = body.trim() === "" ? "" : body;
  if (missingExports.length > 0) {
    if (rendered !== "" && !rendered.endsWith("\n")) rendered += "\n";
    rendered += `\nexport { ${missingExports.join(", ")} };\n`;
  }
  if (names.length === 0) {
    if (rendered !== "" && !rendered.endsWith("\n")) rendered += "\n";
    rendered += "export {};\n";
  }
  return rendered;
}

function renderEpilogue(body: string, prologueNames: readonly string[], specs: readonly ImagineSpec[]): string {
  if (body.trim() === "") return "export {};\n";
  const imports = [
    ...(prologueNames.length === 0
      ? []
      : [`import { ${prologueNames.join(", ")} } from "./__prologue__.ts";`]),
    ...specs.map((spec) => `import { ${spec.name} } from "./${spec.name}.ts";`),
  ];
  return `${imports.join("\n")}\n\n${body.replace(/^\s+/, "")}`;
}
