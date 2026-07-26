/**
 * AST-backed compatibility and final-emission boundary.
 *
 * Cheese syntax is parsed only by `src/compiler/`. This module does not scan
 * source structure: it slices the compiler-owned AST spans into the legacy
 * string-shaped `ImagineSpec` consumed by prompts, deterministic emitters, and
 * realization-cache hashing. Plain-TypeScript stripping likewise runs only on
 * a diagnostic-free `ChzSourceFile`.
 */
import { basename } from "node:path";

import {
  renderChzDiagnostics,
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
  return member.modifierTexts.filter((modifier) =>
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

/**
 * Build the legacy string model from a diagnostic-free AST-backed analysis.
 * Callers own preflight and the analysis snapshot lifetime.
 */
export function imagineSpecsFromChzSource(
  analysis: ChzSourceFile,
): ImagineSpec[] {
  return analysis.imagineDeclarations.map((declaration) =>
    adaptDeclaration(
      analysis.source,
      declaration,
      analysis.typescript.sourceFile,
    )
  );
}

function emitPlainTypeScript(
  analysis: ChzSourceFile,
): string {
  const declarations = analysis.imagineDeclarations;
  if (declarations.length === 0) return analysis.source;

  const names = declarations.map((declaration) => declaration.name);
  const importLine =
    `import { ${names.join(", ")} } from "${realizationImportSpecifier(analysis.fileName)}";\n`;
  const ordered = [...declarations].sort(
    (left, right) => left.span.start - right.span.start,
  );
  let body = "";
  let cursor = 0;
  for (const declaration of ordered) {
    body += analysis.source.slice(cursor, declaration.span.start);
    cursor = declaration.span.end;
  }
  body += analysis.source.slice(cursor);
  return importLine + body;
}

/**
 * Final strip/emit stage. It accepts an already analyzed source and refuses to
 * emit until every shared diagnostic is green.
 */
export function stripAnalyzedSource(
  analysis: ChzSourceFile,
): string {
  if (analysis.diagnostics.length > 0) {
    throw new Error(
      renderChzDiagnostics(analysis.diagnostics, "human").join("\n"),
    );
  }
  return emitPlainTypeScript(analysis);
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
