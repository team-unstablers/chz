import {
  LanguageVariant,
  SyntaxKind,
  createScanner,
} from "./ts-api.ts";
import type { ChzKnownDiagnosticCode } from "./diagnostics.ts";
import type {
  ChzProfileDirective,
  ProjectionIslandKind,
  SourceSpan,
} from "./syntax.ts";

export interface ChzToken {
  kind: SyntaxKind;
  start: number;
  end: number;
  text: string;
  value: string;
  precedingLineBreak: boolean;
}

export interface PendingDiagnostic {
  code: ChzKnownDiagnosticCode;
  offset: number;
}

export interface ProjectionReplacement {
  span: SourceSpan;
  placeholder: "blank" | "declare" | "empty-class-element";
}

export interface ParsedImagineFunctionShell {
  kind: "ImagineFunction";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  exported: boolean;
}

export interface ParsedImagineMethodShell {
  kind: "ImagineMethod";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  modifierTexts: readonly string[];
}

export interface ParsedImaginePropertyShell {
  kind: "ImagineProperty";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  modifierTexts: readonly string[];
}

export type ParsedImagineClassMemberShell =
  | ParsedImagineMethodShell
  | ParsedImaginePropertyShell;

export interface ParsedImagineClassShell {
  kind: "ImagineClass";
  name: string;
  span: SourceSpan;
  imagineSpan: SourceSpan;
  bodySpan: SourceSpan;
  exported: boolean;
  members: ParsedImagineClassMemberShell[];
  /**
   * Starts that the Cheese extension pass did not consume as contracts or
   * imagined members. analyze.ts accepts them only when the TypeScript AST
   * places them inside a real ClassElement. Keeping the decision AST-backed
   * means new TypeScript member forms do not require a Cheese allowlist.
   */
  unclassifiedMemberOffsets: readonly number[];
}

export type ParsedImagineDeclarationShell =
  | ParsedImagineFunctionShell
  | ParsedImagineClassShell;

export interface ParsedProjectionIsland {
  kind: ProjectionIslandKind;
  original: SourceSpan;
  placeholder: SourceSpan;
  owner: {
    declarationIndex: number;
    memberIndex: number | null;
  };
}

export interface CheeseParseResult {
  profile: ChzProfileDirective | null;
  declarations: ParsedImagineDeclarationShell[];
  islands: ParsedProjectionIsland[];
  replacements: ProjectionReplacement[];
  diagnostics: PendingDiagnostic[];
}

interface TemplateFrame {
  interpolationBraceDepth: number;
}

interface PairMaps {
  closeForOpen: ReadonlyMap<number, number>;
}

interface LocatedBody {
  open: number;
  close: number;
}

const MEMBER_MODIFIERS = new Set<SyntaxKind>([
  SyntaxKind.StaticKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.AsyncKeyword,
  SyntaxKind.PublicKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
]);

/**
 * TypeScript's scanner deliberately leaves `/` ambiguous. Cheese only needs
 * enough expression context to keep regex contents out of the extension token
 * stream; the TypeScript Program remains the syntax authority.
 */
function canEndExpression(kind: SyntaxKind | undefined): boolean {
  if (kind === undefined) return false;
  return kind === SyntaxKind.Identifier ||
    kind === SyntaxKind.PrivateIdentifier ||
    kind === SyntaxKind.NumericLiteral ||
    kind === SyntaxKind.BigIntLiteral ||
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.RegularExpressionLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.TemplateTail ||
    kind === SyntaxKind.CloseParenToken ||
    kind === SyntaxKind.CloseBracketToken ||
    kind === SyntaxKind.CloseBraceToken ||
    kind === SyntaxKind.PlusPlusToken ||
    kind === SyntaxKind.MinusMinusToken ||
    kind === SyntaxKind.ThisKeyword ||
    kind === SyntaxKind.SuperKeyword ||
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NullKeyword;
}

export function tokenizeTypeScript(source: string, jsx: boolean): ChzToken[] {
  const scanner = createScanner(
    true,
    jsx ? LanguageVariant.JSX : LanguageVariant.Standard,
    source,
  );
  const tokens: ChzToken[] = [];
  const templates: TemplateFrame[] = [];
  let previousKind: SyntaxKind | undefined;

  while (true) {
    let kind = scanner.scan();
    if (
      (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) &&
      !canEndExpression(previousKind)
    ) {
      kind = scanner.reScanSlashToken();
    }

    const activeTemplate = templates.at(-1);
    if (kind === SyntaxKind.TemplateHead) {
      templates.push({ interpolationBraceDepth: 0 });
    } else if (activeTemplate !== undefined) {
      if (kind === SyntaxKind.OpenBraceToken) {
        activeTemplate.interpolationBraceDepth += 1;
      } else if (kind === SyntaxKind.CloseBraceToken) {
        if (activeTemplate.interpolationBraceDepth > 0) {
          activeTemplate.interpolationBraceDepth -= 1;
        } else {
          kind = scanner.reScanTemplateToken(false);
          if (kind === SyntaxKind.TemplateTail) templates.pop();
        }
      }
    }

    tokens.push({
      kind,
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
      precedingLineBreak: scanner.hasPrecedingLineBreak(),
    });
    if (kind === SyntaxKind.EndOfFile) break;
    previousKind = kind;
  }

  return tokens;
}

/**
 * This is the closed blacklist frozen by the Phase 0 grammar corpus. Once a
 * declaration-position `imagine` is committed, parsing never falls back to
 * ordinary TypeScript.
 */
const COMMIT_CANCELING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.OpenParenToken,
  SyntaxKind.DotToken,
  SyntaxKind.QuestionDotToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,

  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,

  SyntaxKind.PlusToken,
  SyntaxKind.MinusToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.SlashToken,
  SyntaxKind.PercentToken,
  SyntaxKind.LessThanLessThanToken,
  SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.AmpersandToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.ColonToken,

  SyntaxKind.AsKeyword,
  SyntaxKind.SatisfiesKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.InKeyword,

  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ExclamationToken,

  SyntaxKind.SemicolonToken,
  SyntaxKind.CommaToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.EndOfFile,
]);

export function commitsImagine(next: ChzToken): boolean {
  return !next.precedingLineBreak && !COMMIT_CANCELING_KINDS.has(next.kind);
}

function isIdentifierToken(
  token: ChzToken | undefined,
): token is ChzToken & { kind: SyntaxKind.Identifier } {
  return token?.kind === SyntaxKind.Identifier;
}

function textIs(token: ChzToken | undefined, text: string): boolean {
  return token?.text === text && token.value === text;
}

function buildPairMaps(tokens: readonly ChzToken[]): PairMaps {
  const closeForOpen = new Map<number, number>();
  const stacks = new Map<SyntaxKind, number[]>([
    [SyntaxKind.OpenBraceToken, []],
    [SyntaxKind.OpenParenToken, []],
    [SyntaxKind.OpenBracketToken, []],
  ]);
  const openerForCloser = new Map<SyntaxKind, SyntaxKind>([
    [SyntaxKind.CloseBraceToken, SyntaxKind.OpenBraceToken],
    [SyntaxKind.CloseParenToken, SyntaxKind.OpenParenToken],
    [SyntaxKind.CloseBracketToken, SyntaxKind.OpenBracketToken],
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const stack = stacks.get(token.kind);
    if (stack !== undefined) {
      stack.push(index);
      continue;
    }
    const opener = openerForCloser.get(token.kind);
    if (opener === undefined) continue;
    const openIndex = stacks.get(opener)?.pop();
    if (openIndex !== undefined) closeForOpen.set(openIndex, index);
  }

  return { closeForOpen };
}

/**
 * The extension pass cannot parse a TypeScript return type. It therefore uses
 * the token following each balanced brace to distinguish signature/type braces
 * from the declaration body. analyze.ts later binds the recovered shell to a
 * TypeScript declaration node and treats that AST node as canonical. This
 * recovery locator is intentionally not used for parameters, return types, or
 * contract expressions.
 */
const SIGNATURE_CONTINUATION_AFTER_BRACE = new Set<SyntaxKind>([
  SyntaxKind.OpenBraceToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.CommaToken,
  SyntaxKind.DotToken,
  SyntaxKind.QuestionDotToken,
  SyntaxKind.BarToken,
  SyntaxKind.AmpersandToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.ColonToken,
  SyntaxKind.ExtendsKeyword,
  SyntaxKind.EqualsGreaterThanToken,
]);

function locateBodyForRecovery(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  fromIndex: number,
  limitIndex: number,
): LocatedBody | undefined {
  let index = fromIndex;
  while (index < limitIndex) {
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      const close = pairs.closeForOpen.get(index);
      if (close === undefined) return undefined;
      const following = tokens[close + 1];
      if (
        following !== undefined &&
        SIGNATURE_CONTINUATION_AFTER_BRACE.has(following.kind)
      ) {
        index = close + 1;
        continue;
      }
      return { open: index, close };
    }
    index += 1;
  }
  return undefined;
}

function declarationName(
  tokens: readonly ChzToken[],
  index: number,
): { name: string; index: number } | undefined {
  const token = tokens[index];
  if (!isIdentifierToken(token)) return undefined;
  return { name: token.value, index };
}

function endOfLine(source: string, offset: number): number {
  let cursor = offset;
  while (
    cursor < source.length &&
    source[cursor] !== "\n" &&
    source[cursor] !== "\r"
  ) {
    cursor += 1;
  }
  return cursor;
}

function scanProfile(
  source: string,
  tokens: readonly ChzToken[],
  index: number,
): ChzProfileDirective | undefined {
  const profileToken = tokens[index + 1];
  const nameToken = tokens[index + 2];
  if (
    tokens[index]?.kind !== SyntaxKind.AtToken ||
    !textIs(profileToken, "profile") ||
    !isIdentifierToken(nameToken)
  ) {
    return undefined;
  }
  return {
    kind: "ProfileDirective",
    name: nameToken.value,
    span: {
      start: tokens[index]!.start,
      end: endOfLine(source, nameToken.end),
    },
  };
}

function scanClassMembers(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  openIndex: number,
  closeIndex: number,
  declarationIndex: number,
  islands: ParsedProjectionIsland[],
  replacements: ProjectionReplacement[],
  diagnostics: PendingDiagnostic[],
): {
  members: ParsedImagineClassMemberShell[];
  unclassifiedMemberOffsets: number[];
} {
  const members: ParsedImagineClassMemberShell[] = [];
  const unclassifiedMemberOffsets: number[] = [];
  let index = openIndex + 1;
  let memberStart = true;

  while (index < closeIndex) {
    const token = tokens[index]!;
    if (token.kind === SyntaxKind.SemicolonToken) {
      memberStart = true;
      index += 1;
      continue;
    }

    if (
      memberStart &&
      (textIs(token, "requirements") || textIs(token, "ensure")) &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
    ) {
      const closeParen = pairs.closeForOpen.get(index + 1);
      if (closeParen === undefined) {
        diagnostics.push({ code: "CHZ1007", offset: token.start });
        break;
      }
      const semicolonIndex =
        tokens[closeParen + 1]?.kind === SyntaxKind.SemicolonToken
          ? closeParen + 1
          : closeParen;
      const span = {
        start: token.start,
        end: tokens[semicolonIndex]!.end,
      };
      islands.push({
        kind: "class-contract-statement",
        original: span,
        placeholder: span,
        owner: { declarationIndex, memberIndex: null },
      });
      replacements.push({ span, placeholder: "empty-class-element" });
      index = semicolonIndex + 1;
      memberStart = true;
      continue;
    }

    if (memberStart && textIs(token, "imagine")) {
      const next = tokens[index + 1];
      if (next === undefined || !commitsImagine(next)) {
        unclassifiedMemberOffsets.push(token.start);
        memberStart = false;
        index += 1;
        continue;
      }

      replacements.push({
        span: { start: token.start, end: token.end },
        placeholder: "blank",
      });

      let cursor = index + 1;
      const modifierTexts: string[] = [];
      while (
        MEMBER_MODIFIERS.has(tokens[cursor]?.kind ?? SyntaxKind.Unknown)
      ) {
        const modifier = tokens[cursor]!;
        modifierTexts.push(modifier.value);
        // Ambient class stubs preserve every signature modifier except async:
        // TypeScript rejects async in an ambient context with TS1040.
        if (modifier.kind === SyntaxKind.AsyncKeyword) {
          replacements.push({
            span: { start: modifier.start, end: modifier.end },
            placeholder: "blank",
          });
        }
        cursor += 1;
      }
      const nameToken = tokens[cursor];
      if (textIs(nameToken, "resource")) {
        diagnostics.push({ code: "CHZ1008", offset: nameToken!.start });
        index = cursor + 1;
        memberStart = false;
        continue;
      }
      if (!isIdentifierToken(nameToken)) {
        diagnostics.push({
          code: "CHZ1001",
          offset: nameToken?.start ?? token.end,
        });
        index = cursor + 1;
        memberStart = false;
        continue;
      }

      const afterName = tokens[cursor + 1];
      const isMethod =
        afterName?.kind === SyntaxKind.OpenParenToken ||
        afterName?.kind === SyntaxKind.LessThanToken;
      const body = locateBodyForRecovery(
        tokens,
        pairs,
        cursor + 1,
        closeIndex,
      );
      if (body === undefined) {
        diagnostics.push({ code: "CHZ1007", offset: nameToken.end });
        break;
      }
      const bodySpan = {
        start: tokens[body.open]!.start,
        end: tokens[body.close]!.end,
      };
      const memberIndex = members.length;

      if (isMethod) {
        islands.push({
          kind: "callable-contract-body",
          original: bodySpan,
          placeholder: bodySpan,
          owner: { declarationIndex, memberIndex },
        });
        replacements.push({
          span: bodySpan,
          placeholder: "empty-class-element",
        });
        members.push({
          kind: "ImagineMethod",
          name: nameToken.value,
          span: { start: token.start, end: bodySpan.end },
          imagineSpan: { start: token.start, end: token.end },
          bodySpan,
          modifierTexts,
        });
      } else {
        islands.push({
          kind: "property-contract-body",
          original: bodySpan,
          placeholder: bodySpan,
          owner: { declarationIndex, memberIndex },
        });
        replacements.push({
          span: bodySpan,
          placeholder: "empty-class-element",
        });
        members.push({
          kind: "ImagineProperty",
          name: nameToken.value,
          span: { start: token.start, end: bodySpan.end },
          imagineSpan: { start: token.start, end: token.end },
          bodySpan,
          modifierTexts,
        });
      }

      index = body.close + 1;
      memberStart = true;
      continue;
    }

    if (memberStart) {
      unclassifiedMemberOffsets.push(token.start);
    }
    if (token.kind === SyntaxKind.OpenBraceToken) {
      const nestedClose = pairs.closeForOpen.get(index);
      if (nestedClose !== undefined) {
        index = nestedClose + 1;
        memberStart = true;
        continue;
      }
    }
    memberStart = false;
    index += 1;
  }

  return { members, unclassifiedMemberOffsets };
}

function scanFunction(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  declarationStart: number,
  imagineIndex: number,
  kindIndex: number,
  exported: boolean,
  declarationIndex: number,
  islands: ParsedProjectionIsland[],
  replacements: ProjectionReplacement[],
  diagnostics: PendingDiagnostic[],
): { declaration: ParsedImagineFunctionShell; nextIndex: number } | undefined {
  const name = declarationName(tokens, kindIndex + 1);
  if (name === undefined) {
    diagnostics.push({
      code: "CHZ1002",
      offset: tokens[kindIndex + 1]?.start ?? tokens[kindIndex]!.end,
    });
    return undefined;
  }
  const body = locateBodyForRecovery(
    tokens,
    pairs,
    name.index + 1,
    tokens.length,
  );
  if (body === undefined) {
    diagnostics.push({ code: "CHZ1007", offset: tokens[name.index]!.end });
    return undefined;
  }
  const bodySpan = {
    start: tokens[body.open]!.start,
    end: tokens[body.close]!.end,
  };
  islands.push({
    kind: "callable-contract-body",
    original: bodySpan,
    placeholder: bodySpan,
    owner: { declarationIndex, memberIndex: null },
  });
  replacements.push({
    span: bodySpan,
    placeholder: "empty-class-element",
  });
  return {
    declaration: {
      kind: "ImagineFunction",
      name: name.name,
      span: {
        start: tokens[declarationStart]!.start,
        end: bodySpan.end,
      },
      imagineSpan: {
        start: tokens[imagineIndex]!.start,
        end: tokens[imagineIndex]!.end,
      },
      bodySpan,
      exported,
    },
    nextIndex: body.close + 1,
  };
}

function scanClass(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  declarationStart: number,
  imagineIndex: number,
  kindIndex: number,
  exported: boolean,
  declarationIndex: number,
  islands: ParsedProjectionIsland[],
  replacements: ProjectionReplacement[],
  diagnostics: PendingDiagnostic[],
): { declaration: ParsedImagineClassShell; nextIndex: number } | undefined {
  const name = declarationName(tokens, kindIndex + 1);
  if (name === undefined) {
    diagnostics.push({
      code: "CHZ1002",
      offset: tokens[kindIndex + 1]?.start ?? tokens[kindIndex]!.end,
    });
    return undefined;
  }
  const body = locateBodyForRecovery(
    tokens,
    pairs,
    name.index + 1,
    tokens.length,
  );
  if (body === undefined) {
    diagnostics.push({ code: "CHZ1007", offset: tokens[name.index]!.end });
    return undefined;
  }
  const scannedMembers = scanClassMembers(
    tokens,
    pairs,
    body.open,
    body.close,
    declarationIndex,
    islands,
    replacements,
    diagnostics,
  );
  const bodySpan = {
    start: tokens[body.open]!.start,
    end: tokens[body.close]!.end,
  };
  return {
    declaration: {
      kind: "ImagineClass",
      name: name.name,
      span: {
        start: tokens[declarationStart]!.start,
        end: bodySpan.end,
      },
      imagineSpan: {
        start: tokens[imagineIndex]!.start,
        end: tokens[imagineIndex]!.end,
      },
      bodySpan,
      exported,
      members: scannedMembers.members,
      unclassifiedMemberOffsets:
        scannedMembers.unclassifiedMemberOffsets,
    },
    nextIndex: body.close + 1,
  };
}

function emptyParseResult(): CheeseParseResult {
  return {
    profile: null,
    declarations: [],
    islands: [],
    replacements: [],
    diagnostics: [],
  };
}

export function parseCheeseExtensions(
  source: string,
  fileName: string,
): CheeseParseResult {
  if (fileName.toLowerCase().endsWith(".tsx")) return emptyParseResult();

  const tokens = tokenizeTypeScript(source, false);
  const pairs = buildPairMaps(tokens);
  const declarations: ParsedImagineDeclarationShell[] = [];
  const islands: ParsedProjectionIsland[] = [];
  const replacements: ProjectionReplacement[] = [];
  const diagnostics: PendingDiagnostic[] = [];
  let profile: ChzProfileDirective | null = null;
  let index = 0;
  let statementStart = true;

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (statementStart && token.kind === SyntaxKind.AtToken) {
      const directive = scanProfile(source, tokens, index);
      if (directive !== undefined) {
        profile ??= directive;
        replacements.push({ span: directive.span, placeholder: "blank" });
        index += 3;
        statementStart = true;
        continue;
      }
    }

    const declarationStart = index;
    let imagineIndex = index;
    let exported = false;
    let forbiddenModifierOffset: number | null = null;

    if (statementStart && token.kind === SyntaxKind.ExportKeyword) {
      if (
        tokens[index + 1]?.kind === SyntaxKind.DefaultKeyword &&
        textIs(tokens[index + 2], "imagine")
      ) {
        forbiddenModifierOffset = tokens[index + 1]!.start;
        imagineIndex = index + 2;
      } else if (textIs(tokens[index + 1], "imagine")) {
        imagineIndex = index + 1;
        exported = true;
      } else {
        statementStart = false;
        index += 1;
        continue;
      }
    } else if (
      statementStart &&
      (
        token.kind === SyntaxKind.DeclareKeyword ||
        token.kind === SyntaxKind.AbstractKeyword
      ) &&
      textIs(tokens[index + 1], "imagine")
    ) {
      forbiddenModifierOffset = token.start;
      imagineIndex = index + 1;
    } else if (!(statementStart && textIs(token, "imagine"))) {
      if (token.kind === SyntaxKind.SemicolonToken) {
        statementStart = true;
      } else if (token.kind === SyntaxKind.OpenBraceToken) {
        const close = pairs.closeForOpen.get(index);
        if (close !== undefined) {
          index = close + 1;
          statementStart = true;
          continue;
        }
      } else if (token.kind !== SyntaxKind.EndOfFile) {
        statementStart = false;
      }
      index += 1;
      continue;
    }

    const imagineToken = tokens[imagineIndex]!;
    const next = tokens[imagineIndex + 1];
    if (next === undefined || !commitsImagine(next)) {
      statementStart = false;
      index = imagineIndex + 1;
      continue;
    }
    if (forbiddenModifierOffset !== null) {
      diagnostics.push({
        code: "CHZ1005",
        offset: forbiddenModifierOffset,
      });
    }

    replacements.push({
      span: { start: imagineToken.start, end: imagineToken.end },
      placeholder: "declare",
    });

    const kindIndex = imagineIndex + 1;
    const kindToken = tokens[kindIndex]!;
    if (
      kindToken.kind !== SyntaxKind.FunctionKeyword &&
      kindToken.kind !== SyntaxKind.ClassKeyword &&
      !textIs(kindToken, "resource") &&
      kindToken.kind !== SyntaxKind.VarKeyword
    ) {
      diagnostics.push({ code: "CHZ1001", offset: kindToken.start });
      index = kindIndex + 1;
      statementStart = false;
      continue;
    }
    if (
      textIs(kindToken, "resource") ||
      kindToken.kind === SyntaxKind.VarKeyword
    ) {
      diagnostics.push({ code: "CHZ1008", offset: kindToken.start });
      index = kindIndex + 1;
      statementStart = false;
      continue;
    }

    if (kindToken.kind === SyntaxKind.FunctionKeyword) {
      const scanned = scanFunction(
        tokens,
        pairs,
        declarationStart,
        imagineIndex,
        kindIndex,
        exported,
        declarations.length,
        islands,
        replacements,
        diagnostics,
      );
      if (scanned === undefined) break;
      declarations.push(scanned.declaration);
      index = scanned.nextIndex;
      statementStart = true;
      continue;
    }

    const scanned = scanClass(
      tokens,
      pairs,
      declarationStart,
      imagineIndex,
      kindIndex,
      exported,
      declarations.length,
      islands,
      replacements,
      diagnostics,
    );
    if (scanned === undefined) break;
    declarations.push(scanned.declaration);
    index = scanned.nextIndex;
    statementStart = true;
  }

  return {
    profile,
    declarations,
    islands,
    replacements,
    diagnostics,
  };
}
