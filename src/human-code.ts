import { dirname, join, relative, resolve, sep } from "node:path";

import {
  SymbolFlags,
  SyntaxKind,
  isArrayBindingPattern,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceExport,
  isNamespaceImport,
  isObjectBindingPattern,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Checker,
  type Identifier,
  type Node,
  type SourceFile,
  type Statement,
  type TypeScriptSymbol,
} from "./compiler/ts-api.ts";
import {
  collectModuleReferences,
  isRelativeModuleSpecifier,
  type ChzSourceFile,
} from "./compiler/index.ts";

import {
  realizationBaseName,
  type ImagineSpec,
} from "./preprocessor.ts";

export interface HumanCodeSplit {
  prologue: string;
  epilogue: string;
  entryPoint: HumanEntryPointExports;
}

export type HumanCodeLayer = "prologue" | "epilogue";

export interface EntryPointNamedExport {
  source:
    | { kind: "layer"; layer: HumanCodeLayer }
    | { kind: "imagine"; name: string };
  importedName: string;
  exportedName: string;
  typeOnly: boolean;
}

export interface EntryPointDefaultExport {
  layer: HumanCodeLayer;
  typeOnly: boolean;
}

export interface HumanEntryPointExports {
  named: EntryPointNamedExport[];
  star: Array<{
    layer: HumanCodeLayer;
    rendered: string;
  }>;
  default: EntryPointDefaultExport | null;
}

interface HumanStatement {
  node: Statement;
  identifiers: Identifier[];
  content: string;
}

interface TopLevelBinding {
  name: string;
  typeOnly: boolean;
}

interface SourceReplacement {
  start: number;
  end: number;
  text: string;
}

interface OmittedSourceSpan {
  start: number;
  end: number;
}

/**
 * Split human-owned top-level statements around the realized symbol layer.
 * A statement moves to the epilogue when it references an imagine symbol, or
 * transitively references another human statement that had to move there.
 */
export function splitHumanCode(
  analysis: ChzSourceFile,
  specs: readonly ImagineSpec[],
): HumanCodeSplit {
  const { source } = analysis;
  const orderedSpecs = [...specs].sort((left, right) => left.start - right.start);
  const omittedSpans: OmittedSourceSpan[] = [
    ...orderedSpecs,
    ...(analysis.profile === null ? [] : [analysis.profile.span]),
  ].sort((left, right) => left.start - right.start);
  const sourceFile = analysis.typescript.sourceFile;
  const checker = analysis.typescript.checker;
  const baseDir = resolve(
    dirname(resolve(analysis.fileName)),
    "chz",
    "realization",
    realizationBaseName(analysis.fileName),
  );
  const implementationsDir = join(baseDir, "implementations");
  const moduleSpecifierRewrites = collectModuleSpecifierRewrites(
    analysis,
    join(implementationsDir, "__prologue__.ts"),
  );

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

  const imagineSymbols = collectImagineSymbols(
    [...placeholderStatements],
    placeholderSpec,
    checker,
  );
  const symbolsByStatement = humanStatements.map((statement) =>
    checker.getSymbolAtLocation(statement.identifiers)
      .map((symbol) => unaliasSymbol(checker, symbol)),
  );
  const ownersBySymbol = collectSymbolOwners(
    symbolsByStatement,
    humanStatements,
    sourceFile,
  );
  const epilogueStatements = classifyEpilogueStatements(
    symbolsByStatement,
    new Set(imagineSymbols.keys()),
    ownersBySymbol,
  );

  const standaloneTrivia = assignOriginalStatementContent(
    source,
    sourceFile,
    omittedSpans,
    placeholderStatements,
    humanStatements,
    humanIndex,
    moduleSpecifierRewrites,
  );

  const prologueStatements = humanStatements.filter((_, index) => !epilogueStatements.has(index));
  const epilogueBody = humanStatements
    .filter((_, index) => epilogueStatements.has(index))
    .map((statement) => statement.content)
    .join("");
  const prologueBody = standaloneTrivia + prologueStatements.map((statement) => statement.content).join("");
  const prologueBindings = collectTopLevelBindings(
    prologueStatements.map((statement) => statement.node),
  );
  const namedExports = collectNamedExports(prologueStatements.map((statement) => statement.node));
  const statementLayers = new Map<Statement, HumanCodeLayer>(
    humanStatements.map((statement, index) => [
      statement.node,
      epilogueStatements.has(index) ? "epilogue" : "prologue",
    ]),
  );

  return {
    prologue: renderPrologue(
      prologueBody,
      prologueBindings,
      namedExports,
    ),
    epilogue: renderEpilogue(
      epilogueBody,
      prologueBindings,
      orderedSpecs,
    ),
    entryPoint: collectEntryPointExports(
      analysis,
      humanStatements,
      statementLayers,
      imagineSymbols,
      join(baseDir, "implementation.ts"),
    ),
  };
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

function collectImagineSymbols(
  statements: readonly Statement[],
  specs: ReadonlyMap<Statement, ImagineSpec>,
  checker: Checker,
): Map<number, string> {
  const identifiers = statements.flatMap((statement) => {
    const spec = specs.get(statement);
    return (
      (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.name !== undefined &&
      statement.name.text === spec?.name
    )
      ? [{ identifier: statement.name, name: spec.name }]
      : [];
  });
  const symbols = checker.getSymbolAtLocation(
    identifiers.map(({ identifier }) => identifier),
  );
  const result = new Map<number, string>();
  symbols.forEach((symbol, index) => {
    if (symbol !== undefined) result.set(symbol.id, identifiers[index]!.name);
  });
  return result;
}

function collectSymbolOwners(
  symbolGroups: readonly (TypeScriptSymbol | undefined)[][],
  statements: readonly HumanStatement[],
  sourceFile: SourceFile,
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
      // Handles retain their canonical Project, so resolving them reuses the
      // analyzer snapshot without exposing or constructing another Program.
      const declaration = declarationHandle.resolve();
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

function rewrittenRelativeSpecifier(
  sourceFileName: string,
  destinationFileName: string,
  specifier: string,
): string {
  const target = resolve(dirname(resolve(sourceFileName)), specifier);
  let rewritten = relative(dirname(destinationFileName), target)
    .split(sep)
    .join("/");
  if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
  return rewritten;
}

function collectModuleSpecifierRewrites(
  analysis: ChzSourceFile,
  destinationFileName: string,
): SourceReplacement[] {
  return collectModuleReferences(
    analysis.typescript.sourceFile,
    analysis.typescript.checker,
  ).flatMap((reference) => {
    // docs §4.5 deliberately excludes CommonJS require calls from rewriting.
    // Their detection remains shared for graph/linter policy, but only native
    // TypeScript module syntax has a relocation contract.
    if (
      reference.specifier === null ||
      reference.kind === "require" ||
      !isRelativeModuleSpecifier(reference.text)
    ) {
      return [];
    }
    return [{
      start: reference.specifier.getStart(analysis.typescript.sourceFile),
      end: reference.specifier.end,
      text: JSON.stringify(
        rewrittenRelativeSpecifier(
          analysis.fileName,
          destinationFileName,
          reference.text,
        ),
      ),
    }];
  });
}

function sliceWithReplacements(
  source: string,
  start: number,
  end: number,
  replacements: readonly SourceReplacement[],
): string {
  let result = "";
  let cursor = start;
  for (const replacement of replacements) {
    if (replacement.end <= cursor || replacement.start >= end) continue;
    if (replacement.start < cursor || replacement.end > end) {
      throw new Error(
        "A module specifier rewrite crossed a human-code slice boundary; keep the AST node inside one top-level statement.",
      );
    }
    result += source.slice(cursor, replacement.start);
    result += replacement.text;
    cursor = replacement.end;
  }
  return result + source.slice(cursor, end);
}

function assignOriginalStatementContent(
  source: string,
  sourceFile: SourceFile,
  omittedSpans: readonly OmittedSourceSpan[],
  placeholderStatements: ReadonlySet<Statement>,
  humanStatements: HumanStatement[],
  humanIndex: ReadonlyMap<Statement, number>,
  replacements: readonly SourceReplacement[],
): string {
  let cursor = 0;
  let pendingTrivia = "";

  for (const statement of sourceFile.statements) {
    const start = statement.getStart(sourceFile);
    if (placeholderStatements.has(statement)) {
      pendingTrivia += sliceWithoutImagine(
        source,
        cursor,
        start,
        omittedSpans,
        replacements,
      );
      cursor = statement.end;
      continue;
    }

    const index = humanIndex.get(statement);
    if (index === undefined) continue;
    humanStatements[index]!.content = pendingTrivia + sliceWithoutImagine(
      source,
      cursor,
      statement.end,
      omittedSpans,
      replacements,
    );
    pendingTrivia = "";
    cursor = statement.end;
  }

  const tail = pendingTrivia + sliceWithoutImagine(
    source,
    cursor,
    source.length,
    omittedSpans,
    replacements,
  );
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
  omittedSpans: readonly OmittedSourceSpan[],
  replacements: readonly SourceReplacement[],
): string {
  let result = "";
  let cursor = start;
  for (const omitted of omittedSpans) {
    if (omitted.end <= cursor || omitted.start >= end) continue;
    result += sliceWithReplacements(
      source,
      cursor,
      Math.max(cursor, omitted.start),
      replacements,
    );
    cursor = Math.max(cursor, Math.min(end, omitted.end));
  }
  return result + sliceWithReplacements(
    source,
    cursor,
    end,
    replacements,
  );
}

function collectTopLevelBindings(
  statements: readonly Statement[],
): TopLevelBinding[] {
  const bindings = new Map<string, boolean>();
  const add = (name: string, typeOnly: boolean): void => {
    const previous = bindings.get(name);
    // A value binding can also be referenced in type positions. If both views
    // exist, the value import/export is the stronger and safer representation.
    bindings.set(name, previous === undefined ? typeOnly : previous && typeOnly);
  };
  const addBinding = (node: Node, typeOnly: boolean): void => {
    if (isIdentifier(node)) {
      add(node.text, typeOnly);
    } else if (isObjectBindingPattern(node) || isArrayBindingPattern(node)) {
      for (const element of node.elements) {
        if ("name" in element && element.name !== undefined) {
          addBinding(element.name, typeOnly);
        }
      }
    }
  };

  for (const statement of statements) {
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBinding(declaration.name, false);
      }
    } else if (
      isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isModuleDeclaration(statement)
    ) {
      if (statement.name !== undefined && isIdentifier(statement.name)) {
        add(statement.name.text, false);
      }
    } else if (
      isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement)
    ) {
      add(statement.name.text, true);
    } else if (isImportEqualsDeclaration(statement)) {
      add(statement.name.text, statement.isTypeOnly);
    } else if (isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const clauseTypeOnly = clause?.phaseModifier === SyntaxKind.TypeKeyword;
      if (clause?.name !== undefined) {
        add(clause.name.text, clauseTypeOnly);
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && isNamespaceImport(bindings)) {
        add(bindings.name.text, clauseTypeOnly);
      }
      if (bindings !== undefined && isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          add(element.name.text, clauseTypeOnly || element.isTypeOnly);
        }
      }
    }
  }
  return [...bindings].map(([name, typeOnly]) => ({ name, typeOnly }));
}

function statementModifiers(statement: Statement): readonly Node[] {
  if (
    isVariableStatement(statement) ||
    isFunctionDeclaration(statement) ||
    isClassDeclaration(statement) ||
    isInterfaceDeclaration(statement) ||
    isTypeAliasDeclaration(statement) ||
    isEnumDeclaration(statement) ||
    isModuleDeclaration(statement) ||
    isImportDeclaration(statement) ||
    isImportEqualsDeclaration(statement) ||
    isExportAssignment(statement) ||
    isExportDeclaration(statement)
  ) {
    return statement.modifiers ?? [];
  }
  return [];
}

function hasStatementModifier(
  statement: Statement,
  kind: SyntaxKind,
): boolean {
  return statementModifiers(statement).some((modifier) =>
    modifier.kind === kind
  );
}

interface NamedExports {
  value: ReadonlySet<string>;
  type: ReadonlySet<string>;
}

function collectNamedExports(
  statements: readonly Statement[],
): NamedExports {
  const value = new Set<string>();
  const type = new Set<string>();
  const add = (name: string, typeOnly: boolean): void => {
    (typeOnly ? type : value).add(name);
  };
  for (const statement of statements) {
    if (
      hasStatementModifier(statement, SyntaxKind.ExportKeyword) &&
      !hasStatementModifier(statement, SyntaxKind.DefaultKeyword)
    ) {
      for (const binding of collectTopLevelBindings([statement])) {
        add(binding.name, binding.typeOnly);
      }
    }
    if (!isExportDeclaration(statement) || statement.exportClause === undefined) {
      continue;
    }
    if (isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        add(
          element.name.text,
          statement.isTypeOnly || element.isTypeOnly,
        );
      }
    } else if (isNamespaceExport(statement.exportClause)) {
      add(statement.exportClause.name.text, statement.isTypeOnly);
    }
  }
  return { value, type };
}

function renderPrologue(
  body: string,
  bindings: readonly TopLevelBinding[],
  namedExports: NamedExports,
): string {
  const missingValueExports = bindings
    .filter((binding) =>
      !binding.typeOnly && !namedExports.value.has(binding.name)
    )
    .map((binding) => binding.name);
  const missingTypeExports = bindings
    .filter((binding) =>
      binding.typeOnly &&
      !namedExports.type.has(binding.name) &&
      !namedExports.value.has(binding.name)
    )
    .map((binding) => binding.name);
  let rendered = body.trim() === "" ? "" : body;
  if (missingValueExports.length > 0) {
    if (rendered !== "" && !rendered.endsWith("\n")) rendered += "\n";
    rendered += `\nexport { ${missingValueExports.join(", ")} };\n`;
  }
  if (missingTypeExports.length > 0) {
    if (rendered !== "" && !rendered.endsWith("\n")) rendered += "\n";
    rendered += `\nexport type { ${missingTypeExports.join(", ")} };\n`;
  }
  if (bindings.length === 0) {
    if (rendered !== "" && !rendered.endsWith("\n")) rendered += "\n";
    rendered += "export {};\n";
  }
  return rendered;
}

function renderEpilogue(
  body: string,
  prologueBindings: readonly TopLevelBinding[],
  specs: readonly ImagineSpec[],
): string {
  if (body.trim() === "") return "export {};\n";
  const prologueValues = prologueBindings
    .filter((binding) => !binding.typeOnly)
    .map((binding) => binding.name);
  const prologueTypes = prologueBindings
    .filter((binding) => binding.typeOnly)
    .map((binding) => binding.name);
  const imports = [
    ...(prologueValues.length === 0
      ? []
      : [`import { ${prologueValues.join(", ")} } from "./__prologue__.ts";`]),
    ...(prologueTypes.length === 0
      ? []
      : [`import type { ${prologueTypes.join(", ")} } from "./__prologue__.ts";`]),
    ...specs.map((spec) => `import { ${spec.name} } from "./${spec.name}.ts";`),
  ];
  return `${imports.join("\n")}\n\n${body.replace(/^\s+/, "")}`;
}

function unaliasSymbol(
  checker: Checker,
  symbol: TypeScriptSymbol | undefined,
): TypeScriptSymbol | undefined {
  if (symbol === undefined) return undefined;
  return (symbol.flags & SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function resolvedSymbol(
  checker: Checker,
  node: Node,
): TypeScriptSymbol | undefined {
  return unaliasSymbol(checker, checker.getSymbolAtLocation(node));
}

function symbolIsTypeOnly(symbol: TypeScriptSymbol | undefined): boolean {
  return symbol !== undefined && (symbol.flags & SymbolFlags.Value) === 0;
}

function declarationIsTypeOnly(statement: Statement): boolean {
  return isInterfaceDeclaration(statement) ||
    isTypeAliasDeclaration(statement);
}

function collectEntryPointExports(
  analysis: ChzSourceFile,
  humanStatements: readonly HumanStatement[],
  statementLayers: ReadonlyMap<Statement, HumanCodeLayer>,
  imagineSymbols: ReadonlyMap<number, string>,
  entryPointFileName: string,
): HumanEntryPointExports {
  const named: EntryPointNamedExport[] = [];
  const star: HumanEntryPointExports["star"] = [];
  let defaultExport: EntryPointDefaultExport | null = null;
  const checker = analysis.typescript.checker;
  const sourceFile = analysis.typescript.sourceFile;

  const addLayerExport = (
    layer: HumanCodeLayer,
    name: string,
    typeOnly: boolean,
  ): void => {
    named.push({
      source: { kind: "layer", layer },
      importedName: name,
      exportedName: name,
      typeOnly,
    });
  };

  for (const { node: statement } of humanStatements) {
    const layer = statementLayers.get(statement);
    if (layer === undefined) continue;

    if (
      hasStatementModifier(statement, SyntaxKind.ExportKeyword) &&
      !hasStatementModifier(statement, SyntaxKind.DefaultKeyword)
    ) {
      for (const binding of collectTopLevelBindings([statement])) {
        addLayerExport(layer, binding.name, binding.typeOnly);
      }
    }
    if (
      hasStatementModifier(statement, SyntaxKind.ExportKeyword) &&
      hasStatementModifier(statement, SyntaxKind.DefaultKeyword)
    ) {
      defaultExport = {
        layer,
        typeOnly: declarationIsTypeOnly(statement),
      };
    }

    if (isExportAssignment(statement) && !statement.isExportEquals) {
      defaultExport = { layer, typeOnly: false };
      continue;
    }
    if (!isExportDeclaration(statement)) continue;

    const clause = statement.exportClause;
    if (clause === undefined) {
      const rewrites = collectModuleSpecifierRewrites(
        analysis,
        entryPointFileName,
      );
      star.push({
        layer,
        rendered: sliceWithReplacements(
          analysis.source,
          statement.getStart(sourceFile),
          statement.end,
          rewrites,
        ),
      });
      continue;
    }
    if (isNamespaceExport(clause)) {
      addLayerExport(layer, clause.name.text, statement.isTypeOnly);
      continue;
    }
    if (!isNamedExports(clause)) continue;

    for (const element of clause.elements) {
      const localNode = element.propertyName ?? element.name;
      const target = resolvedSymbol(checker, localNode);
      const imagineName =
        statement.moduleSpecifier !== undefined || target === undefined
          ? undefined
          : imagineSymbols.get(target.id);
      const typeOnly =
        statement.isTypeOnly ||
        element.isTypeOnly ||
        symbolIsTypeOnly(target);
      if (imagineName !== undefined) {
        named.push({
          source: { kind: "imagine", name: imagineName },
          importedName: imagineName,
          exportedName: element.name.text,
          typeOnly,
        });
      } else {
        addLayerExport(layer, element.name.text, typeOnly);
      }
    }
  }

  const seenNamed = new Set<string>();
  return {
    named: named.filter((item) => {
      const source = item.source.kind === "layer"
        ? `${item.source.kind}:${item.source.layer}`
        : `${item.source.kind}:${item.source.name}`;
      const key =
        `${source}:${item.importedName}:${item.exportedName}:${item.typeOnly}`;
      if (seenNamed.has(key)) return false;
      seenNamed.add(key);
      return true;
    }),
    star,
    default: defaultExport,
  };
}
