/**
 * chz — declaration-level preprocessor.
 *
 * chz is a TypeScript superset: almost all valid TS is valid chz, and chz adds
 * a handful of declaration-level extensions on top (`imagine` / `requirements`
 * / `ensure`). Because those extensions live only at declaration level, we can
 * compile without a full parser — a brace-depth scanner that understands
 * strings, comments and template literals is enough to find the `imagine`
 * blocks, lift them into spec objects, and strip them back down to plain TS.
 *
 * This module is deliberately zero-dependency (only the `node:path` builtin)
 * and never touches the TypeScript compiler API. It handles exactly the v0
 * grammar and nothing else:
 *
 *   imagine function <name>(<params>): <returnType> {
 *     requirements(`...`);           // 0..1
 *     ensure((args, retval) => ...); // 0..n  -> "predicate"
 *     ensure(`...`);                 // 0..n  -> "natural"
 *   }
 *
 * Known limitations of the scanner (out of scope for v0), see the exported
 * doc comments and the README of Step 2:
 *   - regular-expression literals are NOT tracked; a top-level regex containing
 *     unbalanced braces can confuse depth tracking;
 *   - object-type / generic return types that contain `{` (e.g. `: { x: number }`
 *     or `: Promise<{...}>`) are not supported — the first `{` after the
 *     parameter list is taken to open the function body;
 *   - generic type parameters on the function (`imagine function f<T>(...)`) are
 *     not supported;
 *   - `export` / `default` modifiers in front of `imagine` are not supported.
 */

import { basename } from "node:path";

/** How an `ensure(...)` contract is verified. */
export type EnsureKind = "predicate" | "natural";

/** A single `ensure(...)` contract lifted from an imagine block. */
export interface EnsureContract {
  /**
   * `"predicate"` when the argument is a machine-checked function (run as a
   * test against the realized code), `"natural"` when it is a template-literal
   * natural-language contract (the LLM must convert it into an autogen test).
   */
  kind: EnsureKind;
  /** The first argument exactly as written in the source (raw text, trimmed). */
  source: string;
}

/** The extracted specification of one top-level `imagine function`. */
export interface ImagineSpec {
  /** Function name; may be a Unicode identifier (e.g. `충돌판정_2D`). */
  name: string;
  /** Parameter list text between the parentheses, trimmed. `""` when empty. */
  parameters: string;
  /** Return-type text after the `:`, trimmed. `""` when there is no annotation. */
  returnType: string;
  /** The `requirements(...)` content string, or `null` when absent. */
  requirements: string | null;
  /** The `ensure(...)` contracts, in source order. */
  ensures: EnsureContract[];
  /**
   * The whole imagine block verbatim — from the `imagine` keyword through the
   * closing brace. This is what later feeds the realize prompt.
   */
  originalText: string;
  /** Byte offset (inclusive) where the block starts in `source`. */
  start: number;
  /** Byte offset (exclusive) where the block ends in `source`. */
  end: number;
}

/** Result of a full preprocess pass: the lifted specs plus the plain-TS code. */
export interface PreprocessResult {
  specs: ImagineSpec[];
  code: string;
}

/**
 * A syntax error in a `.chz.ts` file. The message is prefixed with
 * `<file>:<line>:<column>:` so failures point straight at the source.
 */
export class ChzSyntaxError extends Error {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;

  constructor(fileName: string, line: number, column: number, detail: string) {
    super(`${fileName}:${line}:${column}: ${detail}`);
    this.name = "ChzSyntaxError";
    this.fileName = fileName;
    this.line = line;
    this.column = column;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find every top-level `imagine function` declaration in `source` and lift it
 * into an {@link ImagineSpec}. `fileName` is used only for error messages.
 *
 * Only declarations at statement top level (brace/paren/bracket depth 0) are
 * recognised; `imagine`, braces, `requirements` and `ensure` appearing inside
 * strings, comments or template literals are ignored.
 *
 * @throws {ChzSyntaxError} on malformed input (unclosed block, a second
 *   `requirements(...)`, an unsupported `imagine class/var/resource`, etc.).
 */
export function extractImagineSpecs(source: string, fileName: string): ImagineSpec[] {
  const specs: ImagineSpec[] = [];
  let i = 0;
  let depth = 0;
  // The most recent significant (non-whitespace, non-comment) character, used
  // to distinguish a real `imagine` statement from a `foo.imagine` member.
  let prev = "";

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, fileName);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipString(source, i, ch, fileName);
      prev = ch;
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i, fileName);
      prev = "`";
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      prev = ch;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      prev = ch;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const id = readIdentifier(source, i)!;
      if (depth === 0 && prev !== "." && id.value === "imagine") {
        const spec = tryParseImagine(source, i, id.end, fileName);
        if (spec !== null) {
          specs.push(spec);
          i = spec.end;
          prev = "}";
          continue;
        }
      }
      i = id.end;
      prev = source[id.end - 1]!;
      continue;
    }

    if (!isWhitespace(ch)) prev = ch;
    i++;
  }

  return specs;
}

/**
 * Strip the imagine blocks out of `source` and prepend a single realization
 * import for their symbols, producing plain TS. All non-imagine code is kept
 * byte-for-byte so that the diff stays reviewable.
 *
 * For `example.chz.ts` the import is emitted as
 * `import { ... } from "./chz/realization/example/implementation.ts";`.
 *
 * `specs` may be passed in to avoid re-scanning; it must have been produced
 * from the same `source`.
 */
export function transformToPlainTs(
  source: string,
  fileName: string,
  specs: ImagineSpec[] = extractImagineSpecs(source, fileName),
): string {
  if (specs.length === 0) return source;

  const names = specs.map((spec) => spec.name);
  const importLine = `import { ${names.join(", ")} } from "${realizationImportSpecifier(fileName)}";\n`;

  const ordered = [...specs].sort((a, b) => a.start - b.start);
  let body = "";
  let cursor = 0;
  for (const spec of ordered) {
    body += source.slice(cursor, spec.start);
    cursor = spec.end;
  }
  body += source.slice(cursor);

  return importLine + body;
}

/** Convenience: extract specs and transform in one call. */
export function preprocess(source: string, fileName: string): PreprocessResult {
  const specs = extractImagineSpecs(source, fileName);
  return { specs, code: transformToPlainTs(source, fileName, specs) };
}

/** The realization directory base name for a source file: `example.chz.ts` -> `example`. */
export function realizationBaseName(fileName: string): string {
  const base = basename(fileName);
  if (base.endsWith(".chz.ts")) return base.slice(0, -".chz.ts".length);
  if (base.endsWith(".ts")) return base.slice(0, -".ts".length);
  return base;
}

/** The import specifier for a file's realized implementation entry point. */
export function realizationImportSpecifier(fileName: string): string {
  return `./chz/realization/${realizationBaseName(fileName)}/implementation.ts`;
}

// ---------------------------------------------------------------------------
// imagine declaration parsing
// ---------------------------------------------------------------------------

/**
 * Called with `declStart` at the `imagine` keyword and `afterImagine` just past
 * it. Returns the parsed spec when this is an `imagine function`, or `null`
 * when `imagine` is merely an ordinary identifier here (so the caller keeps
 * scanning). Throws for the recognised-but-unsupported `imagine class/var/
 * resource` forms.
 */
function tryParseImagine(
  source: string,
  declStart: number,
  afterImagine: number,
  fileName: string,
): ImagineSpec | null {
  const kw = readIdentifier(source, skipTrivia(source, afterImagine, fileName));
  if (kw === null) return null;

  if (kw.value === "class" || kw.value === "var" || kw.value === "resource") {
    throw syntaxError(
      fileName,
      source,
      declStart,
      `'imagine ${kw.value}' is not supported in v0 (only 'imagine function')`,
    );
  }
  if (kw.value !== "function") return null;

  return parseImagineFunction(source, declStart, kw.end, fileName);
}

/** Parse an `imagine function` whose `function` keyword ends at `afterFunction`. */
function parseImagineFunction(
  source: string,
  declStart: number,
  afterFunction: number,
  fileName: string,
): ImagineSpec {
  let p = skipTrivia(source, afterFunction, fileName);
  const nameTok = readIdentifier(source, p);
  if (nameTok === null) {
    throw syntaxError(fileName, source, p, "expected a function name after 'imagine function'");
  }
  const name = nameTok.value;

  p = skipTrivia(source, nameTok.end, fileName);
  if (source[p] !== "(") {
    throw syntaxError(fileName, source, p, `expected '(' after function name '${name}'`);
  }
  const paramsOpen = p;
  const paramsEnd = skipBalanced(source, paramsOpen, fileName);
  const parameters = source.slice(paramsOpen + 1, paramsEnd - 1).trim();

  const bodyOpen = findBodyBrace(source, paramsEnd, name, fileName);
  const returnRegion = source.slice(paramsEnd, bodyOpen).trim();
  const returnType = returnRegion.startsWith(":") ? returnRegion.slice(1).trim() : returnRegion;

  const bodyEnd = skipBalanced(source, bodyOpen, fileName);
  const originalText = source.slice(declStart, bodyEnd);
  const { requirements, ensures } = parseImagineBody(source, bodyOpen, bodyEnd, fileName);

  return { name, parameters, returnType, requirements, ensures, originalText, start: declStart, end: bodyEnd };
}

/** Locate the `{` that opens the function body, scanning past the return type. */
function findBodyBrace(source: string, from: number, name: string, fileName: string): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, fileName);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipString(source, i, ch, fileName);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i, fileName);
      continue;
    }
    if (ch === "{") return i;
    if (ch === ";") {
      throw syntaxError(fileName, source, i, `imagine function '${name}' must have a body`);
    }
    i++;
  }
  throw syntaxError(fileName, source, from, `unterminated imagine function '${name}': missing '{'`);
}

/**
 * Scan the body of an imagine block for `requirements(...)` and `ensure(...)`
 * calls at statement position (body depth 0). Everything else in the body is
 * ignored.
 */
function parseImagineBody(
  source: string,
  bodyOpen: number,
  bodyEnd: number,
  fileName: string,
): { requirements: string | null; ensures: EnsureContract[] } {
  let requirements: string | null = null;
  let requirementsCount = 0;
  const ensures: EnsureContract[] = [];

  let i = bodyOpen + 1;
  const end = bodyEnd - 1;
  let depth = 0;
  let prev = "";

  while (i < end) {
    const ch = source[i]!;

    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, fileName);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipString(source, i, ch, fileName);
      prev = ch;
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i, fileName);
      prev = "`";
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      prev = ch;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      prev = ch;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const id = readIdentifier(source, i)!;
      const isCallHead =
        depth === 0 && prev !== "." && (id.value === "requirements" || id.value === "ensure");
      if (isCallHead) {
        const afterId = skipTrivia(source, id.end, fileName);
        if (source[afterId] === "(") {
          const call = scanCall(source, afterId, fileName);
          if (id.value === "requirements") {
            requirementsCount++;
            if (requirementsCount > 1) {
              throw syntaxError(
                fileName,
                source,
                i,
                "requirements() may appear at most once in an imagine function",
              );
            }
            requirements = literalContent(call.firstArg);
          } else {
            ensures.push({
              kind: isTemplateLiteral(call.firstArg) ? "natural" : "predicate",
              source: call.firstArg,
            });
          }
          i = call.end;
          prev = ")";
          continue;
        }
      }
      i = id.end;
      prev = source[id.end - 1]!;
      continue;
    }

    if (!isWhitespace(ch)) prev = ch;
    i++;
  }

  return { requirements, ensures };
}

/**
 * Scan a call argument list whose `(` is at `openParen`. Returns the trimmed
 * raw text of the first argument and the index just past the closing `)`.
 */
function scanCall(source: string, openParen: number, fileName: string): { firstArg: string; end: number } {
  const argStart = openParen + 1;
  let firstArgEnd = -1;
  let depth = 0;
  let i = argStart;

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, fileName);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipString(source, i, ch, fileName);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i, fileName);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        if (firstArgEnd === -1) firstArgEnd = i;
        return { firstArg: source.slice(argStart, firstArgEnd).trim(), end: i + 1 };
      }
      depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 0 && firstArgEnd === -1) {
      firstArgEnd = i;
      i++;
      continue;
    }
    i++;
  }

  throw syntaxError(fileName, source, openParen, "unterminated call: missing ')'");
}

// ---------------------------------------------------------------------------
// Lexical scanning primitives (string / comment / template / bracket aware)
// ---------------------------------------------------------------------------

/** Skip whitespace and comments starting at `pos`; return the next index. */
function skipTrivia(source: string, pos: number, fileName: string): number {
  let i = pos;
  while (i < source.length) {
    const ch = source[i]!;
    if (isWhitespace(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, fileName);
      continue;
    }
    break;
  }
  return i;
}

/** `pos` is at `//`; return the index of the terminating newline (or EOF). */
function skipLineComment(source: string, pos: number): number {
  let i = pos + 2;
  while (i < source.length && source[i] !== "\n") i++;
  return i;
}

/** `pos` is at the opening delimiter of a `/* ... *\/` comment. */
function skipBlockComment(source: string, pos: number, fileName: string): number {
  let i = pos + 2;
  while (i < source.length) {
    if (source[i] === "*" && source[i + 1] === "/") return i + 2;
    i++;
  }
  throw syntaxError(fileName, source, pos, "unterminated block comment");
}

/** `pos` is at the opening `quote`; return the index just past the closing quote. */
function skipString(source: string, pos: number, quote: string, fileName: string): number {
  let i = pos + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n") break;
    i++;
  }
  throw syntaxError(fileName, source, pos, "unterminated string literal");
}

/**
 * `pos` is at the opening backtick. Handles escapes and `${ ... }`
 * interpolations (which may themselves nest templates / strings / braces).
 */
function skipTemplate(source: string, pos: number, fileName: string): number {
  let i = pos + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && source[i + 1] === "{") {
      // The `{` at i+1 opens a balanced interpolation expression.
      i = skipBalanced(source, i + 1, fileName);
      continue;
    }
    i++;
  }
  throw syntaxError(fileName, source, pos, "unterminated template literal");
}

/**
 * `pos` is at an opening bracket (`(`, `[` or `{`). Return the index just past
 * the matching close, respecting strings, comments, templates and nesting.
 * Brackets are assumed to be well-formed (as in valid TS).
 */
function skipBalanced(source: string, pos: number, fileName: string): number {
  let depth = 0;
  let i = pos;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = skipBlockComment(source, i, fileName);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipString(source, i, ch, fileName);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i, fileName);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  throw syntaxError(fileName, source, pos, "unterminated bracket: missing closing delimiter");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/**
 * Practical identifier-start test. Not a faithful reproduction of the ECMAScript
 * `IdentifierStart` grammar — we allow ASCII letters, `_`, `$`, and any
 * non-ASCII code unit so that Korean and other Unicode identifiers work.
 */
function isIdentifierStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "$" ||
    ch.charCodeAt(0) >= 0x80
  );
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= "0" && ch <= "9");
}

/** Read a maximal identifier at `pos`, or `null` when none starts there. */
function readIdentifier(source: string, pos: number): { value: string; end: number } | null {
  if (pos >= source.length || !isIdentifierStart(source[pos]!)) return null;
  let i = pos + 1;
  while (i < source.length && isIdentifierPart(source[i]!)) i++;
  return { value: source.slice(pos, i), end: i };
}

/** True when a trimmed argument is a template literal. */
function isTemplateLiteral(arg: string): boolean {
  return arg.startsWith("`");
}

/** Unwrap a string/template literal to its inner text; pass anything else through. */
function literalContent(arg: string): string {
  if (arg.length >= 2) {
    const first = arg[0]!;
    const last = arg[arg.length - 1]!;
    if (
      (first === "`" && last === "`") ||
      (first === "'" && last === "'") ||
      (first === '"' && last === '"')
    ) {
      return arg.slice(1, -1);
    }
  }
  return arg;
}

/** Build a {@link ChzSyntaxError} pointing at `offset` in `source`. */
function syntaxError(fileName: string, source: string, offset: number, detail: string): ChzSyntaxError {
  const { line, column } = lineColumn(source, offset);
  return new ChzSyntaxError(fileName, line, column, detail);
}

/** 1-based line/column for a byte offset. */
function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const bound = Math.min(offset, source.length);
  for (let i = 0; i < bound; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
