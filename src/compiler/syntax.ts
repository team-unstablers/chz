import type {
  CallExpression,
  Checker,
  ClassDeclaration,
  Expression,
  FunctionDeclaration,
  MethodDeclaration,
  NodeArray,
  ParameterDeclaration,
  Program,
  PropertyDeclaration,
  SourceFile,
  StringLiteralLikeNode,
  TypeNode,
} from "./ts-api.ts";

export interface SourceSpan {
  /** Inclusive UTF-16 code-unit offset in the original Cheese source. */
  start: number;
  /** Exclusive UTF-16 code-unit offset in the original Cheese source. */
  end: number;
}

export interface ChzProfileDirective {
  kind: "ProfileDirective";
  name: string;
  span: SourceSpan;
}

export interface ChzRequirements {
  kind: "Requirements";
  span: SourceSpan;
  call: CallExpression;
  /** TypeScript 7 names the concrete string/template union StringLiteralLikeNode. */
  value: StringLiteralLikeNode;
}

export interface ChzEnsure {
  kind: "assertion" | "scenario";
  span: SourceSpan;
  call: CallExpression;
  conditionOrScenario: Expression;
  /** See ChzRequirements.value for the TypeScript 7 unstable API naming. */
  message: StringLiteralLikeNode | null;
}

interface ChzImagineCallable {
  /** NodeArray retains the signature's canonical AST nodes and pos/end span. */
  parameters: NodeArray<ParameterDeclaration>;
  returnType: TypeNode | null;
  requirements: ChzRequirements | null;
  ensures: ChzEnsure[];
}

export interface ChzImagineFunction extends ChzImagineCallable {
  kind: "ImagineFunction";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  exported: boolean;
  declaration: FunctionDeclaration;
}

export interface ChzImagineMethod extends ChzImagineCallable {
  kind: "ImagineMethod";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  /**
   * Cheese member modifiers are retained separately because the semantic
   * projection neutralizes `async` inside an ambient class stub.
   */
  modifierTexts: readonly string[];
  declaration: MethodDeclaration;
}

export interface ChzImagineProperty {
  kind: "ImagineProperty";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  modifierTexts: readonly string[];
  declaration: PropertyDeclaration;
  returnType: TypeNode | null;
  requirements: ChzRequirements | null;
  ensures: ChzEnsure[];
}

export type ChzImagineClassMember = ChzImagineMethod | ChzImagineProperty;

export interface ChzImagineClass {
  kind: "ImagineClass";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  exported: boolean;
  declaration: ClassDeclaration;
  requirements: ChzRequirements | null;
  ensures: ChzEnsure[];
  members: ChzImagineClassMember[];
}

export type ChzImagineDeclaration = ChzImagineFunction | ChzImagineClass;

export type ProjectionIslandKind =
  | "class-contract-statement"
  | "callable-contract-body"
  | "property-contract-body";

export interface ProjectionIsland {
  kind: ProjectionIslandKind;
  original: SourceSpan;
  placeholder: SourceSpan;
  virtualFileName: string;
  owner: {
    declarationIndex: number;
    memberIndex: number | null;
  };
}

export interface TypeScriptProjection {
  projectedSource: string;
  scriptKind: "TS" | "TSX";
  islands: ProjectionIsland[];
}

export type ChzDiagnosticNamespace =
  | "grammar"
  | "typescript"
  | "contract"
  | "static-rule";

export interface ChzDiagnostic {
  code: string;
  namespace: ChzDiagnosticNamespace;
  message: string;
  file: string;
  /** UTF-16 code-unit offset in the original Cheese source. */
  offset: number;
  /** One-based original source position. */
  line: number;
  /** One-based original source position, counted in UTF-16 code units. */
  column: number;
}

export interface ChzSourceFile {
  fileName: string;
  source: string;
  profile: ChzProfileDirective | null;
  imagineDeclarations: ChzImagineDeclaration[];
  typescript: {
    projectedSource: string;
    sourceFile: SourceFile;
    program: Program;
    checker: Checker;
    /**
     * Origin-mapped island SourceFiles are part of the same Program. They are
     * exposed because class/property contract AST cannot coexist in the main
     * TypeScript AST even though every source offset is preserved.
     */
    islands: ReadonlyMap<string, SourceFile>;
  };
  /**
   * Missing member diagnostics promoted by "usage creates the contract".
   * No pipeline consumer exists yet; later obligation extraction owns that
   * hand-off rather than the analyzer mutating realization prompts.
   */
  obligations: ChzDiagnostic[];
  diagnostics: ChzDiagnostic[];
  /**
   * TypeScript 7's unstable AST nodes, Program, and Checker are backed by a
   * snapshot process. They remain valid only until this method is called.
   * Sources returned by analyzeChzSources share this method; batch callers
   * should dispose the ChzAnalysisBatch after every source consumer finishes.
   * This explicit lifetime is the only addition to the model sketched in
   * docs/idea-sketches/260726-00.
   */
  dispose(): void;
}
