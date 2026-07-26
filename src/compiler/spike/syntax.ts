import type {
  ClassDeclaration,
  FunctionDeclaration,
  MethodDeclaration,
  PropertyDeclaration,
  SourceFile,
} from "../ts-api.ts";

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

export interface ChzContractStatement {
  kind: "requirements" | "ensure";
  span: SourceSpan;
}

export interface ChzImagineFunction {
  kind: "ImagineFunction";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  exported: boolean;
  declaration?: FunctionDeclaration;
  contracts: ChzContractStatement[];
}

export interface ChzImagineMethod {
  kind: "ImagineMethod";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  declaration?: MethodDeclaration;
  contracts: ChzContractStatement[];
}

export interface ChzImagineProperty {
  kind: "ImagineProperty";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  declaration?: PropertyDeclaration;
  contracts: ChzContractStatement[];
}

export type ChzImagineClassMember = ChzImagineMethod | ChzImagineProperty;

export interface ChzImagineClass {
  kind: "ImagineClass";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  exported: boolean;
  declaration?: ClassDeclaration;
  contracts: ChzContractStatement[];
  members: ChzImagineClassMember[];
}

export type ChzImagineDeclaration = ChzImagineFunction | ChzImagineClass;

export type IslandKind = "class-contract-body" | "property-contract-body";

export interface ProjectionIsland {
  kind: IslandKind;
  original: SourceSpan;
  placeholder: SourceSpan;
  virtualFileName: string;
  syntheticFileName: string;
}

export interface ProjectionCandidateMeasurement {
  candidate: "origin-mapped-virtual-source" | "synthetic-fragment";
  syntacticDiagnosticCount: number;
  preservesOriginalOffsets: boolean;
  checkerSymbolAccess: boolean;
}

export interface TypeScriptProjection {
  source: string;
  scriptKind: "TS" | "TSX";
  islands: ProjectionIsland[];
  measurements: ProjectionCandidateMeasurement[];
}

export interface SpikeAnalysis {
  fileName: string;
  source: string;
  sourceFile: SourceFile;
  profile: ChzProfileDirective | null;
  imagineDeclarations: ChzImagineDeclaration[];
  projection: TypeScriptProjection;
  diagnostics: ChzDiagnostic[];
  dispose(): void;
}

export type ChzDiagnosticNamespace = "grammar" | "typescript" | "contract";

export interface ChzDiagnostic {
  code: string;
  namespace: ChzDiagnosticNamespace;
  message: string;
  file: string;
  offset: number;
  line: number;
  column: number;
}
