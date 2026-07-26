import type { SourceFile } from "../ts-api.ts";
import type {
  ChzDiagnostic,
  ChzDiagnosticNamespace,
} from "./syntax.ts";

export interface DiagnosticDefinition {
  namespace: ChzDiagnosticNamespace;
  message: string;
  recovery: string;
}

/**
 * Phase 0 freezes these codes and messages as grammar-corpus data. Every
 * message includes a concrete next action, matching the harness diagnostic
 * principle in docs/63.
 */
export const DIAGNOSTIC_DEFINITIONS = {
  CHZ1001: {
    namespace: "grammar",
    message: "A committed 'imagine' must be followed by a supported declaration.",
    recovery: "Write 'imagine function' or 'imagine class'; in a class, write a member name after optional member modifiers.",
  },
  CHZ1002: {
    namespace: "grammar",
    message: "An imagine declaration must have a name.",
    recovery: "Add a valid TypeScript identifier before the declaration signature.",
  },
  CHZ1003: {
    namespace: "grammar",
    message: "The TypeScript signature or body shell of this imagine declaration is malformed.",
    recovery: "Fix the highlighted TypeScript syntax while keeping requirements and ensure calls inside the declaration body.",
  },
  CHZ1004: {
    namespace: "grammar",
    message: "Only requirements(...) and ensure(...) are allowed at the top level of an imagine contract body.",
    recovery: "Move implementation statements to human TypeScript or into an ensure scenario callback.",
  },
  CHZ1005: {
    namespace: "grammar",
    message: "This modifier is not supported on an imagine declaration.",
    recovery: "Use a named 'export imagine' declaration; if a default export is needed, add 'export default Name;' in human code.",
  },
  CHZ1006: {
    namespace: "grammar",
    message: "Cheese TSX input is not supported in Phase 0.",
    recovery: "Move JSX to a plain .tsx module and keep the Cheese declaration in a .chz.ts file.",
  },
  CHZ1007: {
    namespace: "grammar",
    message: "The imagine declaration or contract body is not terminated.",
    recovery: "Add the missing closing delimiter and retry parsing.",
  },
  CHZ1008: {
    namespace: "grammar",
    message: "This imagine declaration kind is reserved but not supported by the Phase 0 grammar.",
    recovery: "Use 'imagine function' or 'imagine class' for this spike.",
  },
  CHZ2001: {
    namespace: "contract",
    message: "requirements(...) must receive exactly one static string.",
    recovery: "Pass one string literal or one template literal without ${...} substitutions.",
  },
} as const satisfies Record<string, DiagnosticDefinition>;

export type ChzKnownDiagnosticCode = keyof typeof DIAGNOSTIC_DEFINITIONS;

export function createChzDiagnostic(
  code: ChzKnownDiagnosticCode,
  file: string,
  offset: number,
  sourceFile: SourceFile,
): ChzDiagnostic {
  const definition = DIAGNOSTIC_DEFINITIONS[code];
  const position = sourceFile.getLineAndCharacterOfPosition(
    Math.max(0, Math.min(offset, sourceFile.text.length)),
  );
  return {
    code,
    namespace: definition.namespace,
    message: `${definition.message} ${definition.recovery}`,
    file,
    offset,
    line: position.line + 1,
    column: position.character + 1,
  };
}

export function createTypeScriptDiagnostic(
  code: number,
  text: string,
  file: string,
  offset: number,
  sourceFile: SourceFile,
): ChzDiagnostic {
  const position = sourceFile.getLineAndCharacterOfPosition(
    Math.max(0, Math.min(offset, sourceFile.text.length)),
  );
  return {
    code: `TS${code}`,
    namespace: "typescript",
    message: text,
    file,
    offset,
    line: position.line + 1,
    column: position.character + 1,
  };
}
