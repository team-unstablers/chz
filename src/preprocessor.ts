import { basename } from "node:path";

import {
  analyzeChzSource,
  renderChzDiagnostic,
  type ChzDiagnostic,
  type ChzEnsure,
  type ChzImagineClassMember,
  type ChzImagineDeclaration,
  type ChzRequirements,
  type ChzSourceFile,
} from "./compiler/index.ts";
import type {
  Node,
  NodeArray,
  ParameterDeclaration,
  SourceFile,
  TypeNode,
} from "./compiler/ts-api.ts";

/** The executable shape of a human-authored `ensure(...)` contract. */
export type EnsureKind = "assertion" | "scenario";

/** A single `ensure(...)` contract lifted from an imagine block. */
export interface EnsureContract {
  kind: EnsureKind;
  source: string;
  messageSource: string | null;
  line: number;
  column: number;
}

export type ImagineDeclarationType = "function" | "class";

/** A required method or property declared inside an `imagine class`. */
export interface ImagineClassMemberSpec {
  type: "method" | "property";
  name: string;
  modifiers: string[];
  parameters: string;
  returnType: string;
  requirements: string | null;
  ensures: EnsureContract[];
  originalText: string;
  start: number;
  end: number;
}

/** The compatibility view consumed by the current realization pipeline. */
export interface ImagineSpec {
  type: ImagineDeclarationType;
  name: string;
  parameters: string;
  returnType: string;
  members: ImagineClassMemberSpec[];
  requirements: string | null;
  ensures: EnsureContract[];
  originalText: string;
  start: number;
  end: number;
}

export interface PreprocessResult {
  specs: ImagineSpec[];
  code: string;
}

/**
 * Compatibility error for callers that still expect one thrown diagnostic.
 * The diagnostic itself comes from the shared compiler model; analysis APIs
 * retain all recoverable diagnostics instead of throwing at the first one.
 */
export class ChzSyntaxError extends Error {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly diagnostic: ChzDiagnostic;

  constructor(diagnostic: ChzDiagnostic) {
    const deferredResource =
      diagnostic.code === "CHZ1008"
        ? " 'imagine resource' is intentionally deferred to a future language version."
        : "";
    super(`${renderChzDiagnostic(diagnostic)}${deferredResource}`);
    this.name = "ChzSyntaxError";
    this.fileName = diagnostic.file;
    this.line = diagnostic.line;
    this.column = diagnostic.column;
    this.diagnostic = diagnostic;
  }
}

function throwFirstDiagnostic(analysis: ChzSourceFile): void {
  const diagnostic = analysis.diagnostics[0];
  if (diagnostic !== undefined) throw new ChzSyntaxError(diagnostic);
}

function nodeText(source: string, node: Node): string {
  const sourceFile = node.getSourceFile();
  return source.slice(node.getStart(sourceFile), node.end);
}

function nodeArrayText(
  source: string,
  parameters: NodeArray<ParameterDeclaration>,
): string {
  return source.slice(parameters.pos, parameters.end).trim();
}

function typeNodeText(source: string, type: TypeNode | null): string {
  return type === null ? "" : nodeText(source, type).trim();
}

function literalContent(source: string, requirement: ChzRequirements | null): string | null {
  if (requirement === null) return null;
  const literal = nodeText(source, requirement.value);
  if (literal.length < 2) return "";
  return literal.slice(1, -1);
}

function ensurePosition(
  ensure: ChzEnsure,
  mainSourceFile: SourceFile,
): { line: number; column: number } {
  const offset = ensure.call.getStart(ensure.call.getSourceFile());
  const position = mainSourceFile.getLineAndCharacterOfPosition(offset);
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function adaptEnsure(
  source: string,
  ensure: ChzEnsure,
  mainSourceFile: SourceFile,
): EnsureContract {
  return {
    kind: ensure.kind,
    source: nodeText(source, ensure.conditionOrScenario),
    messageSource:
      ensure.message === null ? null : nodeText(source, ensure.message),
    ...ensurePosition(ensure, mainSourceFile),
  };
}

function compatibilityModifiers(
  member: ChzImagineClassMember,
): string[] {
  const sourceFile = member.declaration.getSourceFile();
  const modifiers = member.declaration.modifiers ?? [];
  return modifiers
    .map((modifier) => modifier.getText(sourceFile))
    .filter((modifier) =>
      modifier === "async" ||
      modifier === "static" ||
      modifier === "readonly"
    );
}

function adaptClassMember(
  source: string,
  member: ChzImagineClassMember,
  mainSourceFile: SourceFile,
): ImagineClassMemberSpec {
  return {
    type: member.kind === "ImagineMethod" ? "method" : "property",
    name: member.name,
    modifiers: compatibilityModifiers(member),
    parameters:
      member.kind === "ImagineMethod"
        ? nodeArrayText(source, member.parameters)
        : "",
    returnType: typeNodeText(source, member.returnType),
    requirements: literalContent(source, member.requirements),
    ensures: member.ensures.map((ensure) =>
      adaptEnsure(source, ensure, mainSourceFile)
    ),
    originalText: source.slice(member.span.start, member.span.end),
    start: member.span.start,
    end: member.span.end,
  };
}

function adaptDeclaration(
  source: string,
  declaration: ChzImagineDeclaration,
  mainSourceFile: SourceFile,
): ImagineSpec {
  if (declaration.kind === "ImagineFunction") {
    return {
      type: "function",
      name: declaration.name,
      parameters: nodeArrayText(source, declaration.parameters),
      returnType: typeNodeText(source, declaration.returnType),
      members: [],
      requirements: literalContent(source, declaration.requirements),
      ensures: declaration.ensures.map((ensure) =>
        adaptEnsure(source, ensure, mainSourceFile)
      ),
      originalText: source.slice(declaration.span.start, declaration.span.end),
      start: declaration.span.start,
      end: declaration.span.end,
    };
  }

  return {
    type: "class",
    name: declaration.name,
    parameters: "",
    returnType: "",
    members: declaration.members.map((member) =>
      adaptClassMember(source, member, mainSourceFile)
    ),
    requirements: literalContent(source, declaration.requirements),
    ensures: declaration.ensures.map((ensure) =>
      adaptEnsure(source, ensure, mainSourceFile)
    ),
    originalText: source.slice(declaration.span.start, declaration.span.end),
    start: declaration.span.start,
    end: declaration.span.end,
  };
}

/** Build the legacy string model from the AST-backed source analysis. */
export function imagineSpecsFromChzSource(
  analysis: ChzSourceFile,
): ImagineSpec[] {
  throwFirstDiagnostic(analysis);
  return analysis.imagineDeclarations.map((declaration) =>
    adaptDeclaration(
      analysis.source,
      declaration,
      analysis.typescript.sourceFile,
    )
  );
}

/**
 * Compatibility entry point. Every signature and contract string is sliced
 * from an AST node; no source structure is reparsed here.
 */
export function extractImagineSpecs(
  source: string,
  fileName: string,
): ImagineSpec[] {
  const analysis = analyzeChzSource(source, fileName);
  try {
    return imagineSpecsFromChzSource(analysis);
  } finally {
    analysis.dispose();
  }
}

function emitPlainTypeScript(
  source: string,
  fileName: string,
  specs: readonly ImagineSpec[],
): string {
  if (specs.length === 0) return source;

  const names = specs.map((spec) => spec.name);
  const importLine =
    `import { ${names.join(", ")} } from "${realizationImportSpecifier(fileName)}";\n`;
  const ordered = [...specs].sort((left, right) => left.start - right.start);
  let body = "";
  let cursor = 0;
  for (const spec of ordered) {
    body += source.slice(cursor, spec.start);
    cursor = spec.end;
  }
  body += source.slice(cursor);
  return importLine + body;
}

/**
 * Final strip/emit stage. It accepts an already analyzed source and refuses to
 * emit until every shared diagnostic is green.
 */
export function stripAnalyzedSource(
  analysis: ChzSourceFile,
  specs: ImagineSpec[] = imagineSpecsFromChzSource(analysis),
): string {
  throwFirstDiagnostic(analysis);
  return emitPlainTypeScript(analysis.source, analysis.fileName, specs);
}

/** Compatibility wrapper around the separate analyze → final emit stages. */
export function transformToPlainTs(
  source: string,
  fileName: string,
  specs?: ImagineSpec[],
): string {
  const analysis = analyzeChzSource(source, fileName);
  try {
    const compatibleSpecs = specs ?? imagineSpecsFromChzSource(analysis);
    return stripAnalyzedSource(analysis, compatibleSpecs);
  } finally {
    analysis.dispose();
  }
}

export function preprocess(
  source: string,
  fileName: string,
): PreprocessResult {
  const analysis = analyzeChzSource(source, fileName);
  try {
    const specs = imagineSpecsFromChzSource(analysis);
    return {
      specs,
      code: stripAnalyzedSource(analysis, specs),
    };
  } finally {
    analysis.dispose();
  }
}

export function publicSurfaceText(spec: ImagineSpec): string {
  const lines: string[] = [];
  if (spec.type === "function") {
    lines.push(`function ${spec.name}(${spec.parameters}): ${spec.returnType}`);
  } else {
    lines.push(`class ${spec.name}`);
    for (const member of spec.members) {
      const modifiers =
        member.modifiers.length === 0
          ? ""
          : `${member.modifiers.join(" ")} `;
      lines.push(
        member.type === "method"
          ? `method ${modifiers}${spec.name}.${member.name}(${member.parameters}): ${member.returnType}`
          : `property ${modifiers}${spec.name}.${member.name}: ${member.returnType}`,
      );
    }
  }
  const contracts = [
    ...spec.ensures.map((ensure) => ({ scope: spec.name, ensure })),
    ...spec.members.flatMap((member) =>
      member.ensures.map((ensure) => ({
        scope: `${spec.name}.${member.name}`,
        ensure,
      }))
    ),
  ];
  for (const { scope, ensure } of contracts) {
    lines.push(`ensure ${scope} ${ensure.kind} ${ensure.source}`);
  }
  return lines.join("\n");
}

export function realizationBaseName(fileName: string): string {
  const base = basename(fileName);
  if (base.endsWith(".chz.ts")) {
    return base.slice(0, -".chz.ts".length);
  }
  if (base.endsWith(".ts")) return base.slice(0, -".ts".length);
  return base;
}

export function realizationImportSpecifier(fileName: string): string {
  return `./chz/realization/${realizationBaseName(fileName)}/implementation.ts`;
}
