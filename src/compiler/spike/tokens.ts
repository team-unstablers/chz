import {
  LanguageVariant,
  SyntaxKind,
  createScanner,
} from "../ts-api.ts";

export interface ChzToken {
  kind: SyntaxKind;
  start: number;
  end: number;
  text: string;
  value: string;
  precedingLineBreak: boolean;
}

interface TemplateFrame {
  interpolationBraceDepth: number;
}

/**
 * TypeScript's scanner deliberately leaves `/` ambiguous for the parser. The
 * Cheese shell only needs enough parser context to prevent regex contents from
 * becoming contextual-keyword candidates. This follows the same "can an
 * expression end here?" split used by JavaScript parsers; division is selected
 * only after a token that can end an expression.
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

    const token: ChzToken = {
      kind,
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
      precedingLineBreak: scanner.hasPrecedingLineBreak(),
    };
    tokens.push(token);

    if (kind === SyntaxKind.EndOfFile) break;
    previousKind = kind;
  }

  return tokens;
}

const COMMIT_CANCELING_KINDS = new Set<SyntaxKind>([
  // Calls, property/element access, generic calls/comparisons, and tags.
  SyntaxKind.OpenParenToken,
  SyntaxKind.DotToken,
  SyntaxKind.QuestionDotToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,

  // Assignment.
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

  // Binary, comparison, logical, and conditional operators.
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

  // Type-related operators.
  SyntaxKind.AsKeyword,
  SyntaxKind.SatisfiesKeyword,
  SyntaxKind.InstanceOfKeyword,
  SyntaxKind.InKeyword,

  // Postfix and non-null assertion.
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ExclamationToken,

  // Statement boundaries.
  SyntaxKind.SemicolonToken,
  SyntaxKind.CommaToken,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.EndOfFile,
]);

/**
 * §4.3 is intentionally a blacklist. Once this returns true, the parser owns
 * the production and must report a CHZ diagnostic instead of falling back to
 * plain TypeScript.
 */
export function commitsImagine(next: ChzToken): boolean {
  return !next.precedingLineBreak && !COMMIT_CANCELING_KINDS.has(next.kind);
}

export function isIdentifierToken(token: ChzToken | undefined): boolean {
  return token?.kind === SyntaxKind.Identifier;
}
