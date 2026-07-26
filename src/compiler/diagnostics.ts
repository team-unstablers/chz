import type { SourceFile } from "./ts-api.ts";
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
 * CHZ1001-CHZ1008 and CHZ2001 are frozen by the Phase 0 fixture corpus.
 * Later entries preserve pre-AST contract validation that the public adapter
 * still guarantees.
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
    message: "Cheese TSX input is not supported yet.",
    recovery: "Move JSX to a plain .tsx module and keep the Cheese declaration in a .chz.ts file.",
  },
  CHZ1007: {
    namespace: "grammar",
    message: "The imagine declaration or contract body is not terminated.",
    recovery: "Add the missing closing delimiter and retry parsing.",
  },
  CHZ1008: {
    namespace: "grammar",
    message: "This imagine declaration kind is reserved but not supported yet.",
    recovery: "Use 'imagine function' or 'imagine class' instead.",
  },
  CHZ2001: {
    namespace: "contract",
    message: "requirements(...) must receive exactly one static string.",
    recovery: "Pass one string literal or one template literal without ${...} substitutions.",
  },
  CHZ2002: {
    namespace: "contract",
    message: "requirements() may appear at most once in an imagine contract body.",
    recovery: "Merge the requirements prose into one static requirements(...) call.",
  },
  CHZ2003: {
    namespace: "contract",
    message: "ensure() requires either a boolean condition or a message plus a zero-argument scenario.",
    recovery: "Pass ensure(condition, message?) or ensure(message, () => { assert(...); }).",
  },
  CHZ2004: {
    namespace: "contract",
    message: "natural-language ensure() contracts are no longer supported.",
    recovery: "Put prose in requirements() and provide an executable assertion.",
  },
  CHZ2005: {
    namespace: "contract",
    message: "predicate ensure() contracts are no longer supported.",
    recovery: "Provide concrete inputs in ensure(condition) or ensure(message, () => { assert(...); }).",
  },
  CHZ2006: {
    namespace: "contract",
    message: "scenario ensure() must contain a static message and a zero-argument function.",
    recovery: "Use ensure(\"message\", () => { assert(...); }).",
  },
  CHZ2007: {
    namespace: "contract",
    message: "Assertion ensure() accepts only a condition and an optional static message.",
    recovery: "Remove extra arguments and keep at most one static message.",
  },
  CHZ2008: {
    namespace: "contract",
    message: "The optional assertion message passed to ensure() must be a static string literal.",
    recovery: "Replace the message with a string literal or a template literal without substitutions.",
  },
} as const satisfies Record<string, DiagnosticDefinition>;

export type ChzKnownDiagnosticCode = keyof typeof DIAGNOSTIC_DEFINITIONS;

function originalPosition(sourceFile: SourceFile, offset: number): {
  line: number;
  column: number;
} {
  const bounded = Math.max(0, Math.min(offset, sourceFile.text.length));
  const position = sourceFile.getLineAndCharacterOfPosition(bounded);
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

export function createChzDiagnostic(
  code: ChzKnownDiagnosticCode,
  file: string,
  offset: number,
  sourceFile: SourceFile,
): ChzDiagnostic {
  const definition = DIAGNOSTIC_DEFINITIONS[code];
  return {
    code,
    namespace: definition.namespace,
    message: `${definition.message} ${definition.recovery}`,
    file,
    offset,
    ...originalPosition(sourceFile, offset),
  };
}

export function createTypeScriptDiagnostic(
  code: number,
  text: string,
  file: string,
  offset: number,
  sourceFile: SourceFile,
): ChzDiagnostic {
  return {
    code: `TS${code}`,
    namespace: "typescript",
    message: text,
    file,
    offset,
    ...originalPosition(sourceFile, offset),
  };
}

export function renderChzDiagnostic(diagnostic: ChzDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`;
}
