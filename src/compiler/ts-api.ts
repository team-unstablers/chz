/**
 * The single import boundary for TypeScript 7's unstable compiler API.
 *
 * Phase 0 intentionally leaves the two existing production consumers on their
 * current imports. New compiler work must import through this module so Phase 1
 * can move those consumers without spreading the unstable surface any further.
 */
export {
  LanguageVariant,
  ScriptKind,
  SyntaxKind,
  createScanner,
  isArrayBindingPattern,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isExpressionStatement,
  isExternalModuleReference,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportExpression,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
} from "typescript/unstable/ast";
export { createVirtualFileSystem } from "typescript/unstable/fs";
export {
  API,
  DiagnosticCategory,
} from "typescript/unstable/sync";

export type {
  Block,
  CallExpression,
  ClassDeclaration,
  Expression,
  ExpressionStatement,
  FunctionDeclaration,
  Identifier,
  MethodDeclaration,
  Node,
  PropertyDeclaration,
  Scanner,
  SourceFile,
  Statement,
} from "typescript/unstable/ast";
export type {
  Checker,
  Diagnostic as TypeScriptDiagnostic,
  Program,
  Project,
  Snapshot,
  Symbol as TypeScriptSymbol,
} from "typescript/unstable/sync";
