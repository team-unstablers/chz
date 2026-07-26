export {
  analyzeChzSource,
  analyzeChzSources,
  type ChzAnalysisBatch,
  type ChzSourceInput,
} from "./analyze.ts";
export {
  DIAGNOSTIC_DEFINITIONS,
  createChzDiagnostic,
  createHumanTypeScriptDiagnostic,
  createTypeScriptDiagnostic,
  renderChzDiagnostic,
  renderChzDiagnostics,
  type ChzDiagnosticRenderFormat,
  type ChzKnownDiagnosticCode,
} from "./diagnostics.ts";
export {
  commitsImagine,
  parseCheeseExtensions,
  tokenizeTypeScript,
  type CheeseParseResult,
  type ChzToken,
} from "./parser.ts";
export {
  collectModuleReferences,
  collectModuleSpecifiersFromSource,
  isRelativeModuleSpecifier,
  moduleReferenceForNode,
  type ModuleReference,
  type ModuleReferenceKind,
  type NonStaticDynamicImport,
  type StaticModuleReference,
} from "./module-specifiers.ts";
export {
  applyProjectionReplacements,
  createTypeScriptProjection,
  scriptKindForFileName,
} from "./projection.ts";
export {
  collectSymbolReferences,
  collectTypeSymbolReferences,
  declarationEnsureScopes,
  resolveReferenceSymbol,
  symbolComesOnlyFromTypeScriptLib,
  unaliasSymbol,
  type ChzEnsureScope,
  type SymbolReference,
} from "./symbol-references.ts";
export type {
  ChzDiagnostic,
  ChzEnsure,
  ChzImagineClass,
  ChzImagineClassMember,
  ChzImagineDeclaration,
  ChzImagineFunction,
  ChzImagineMethod,
  ChzImagineProperty,
  ChzProfileDirective,
  ChzRequirements,
  ChzSourceFile,
  ProjectionIsland,
  SourceSpan,
  TypeScriptProjection,
} from "./syntax.ts";
