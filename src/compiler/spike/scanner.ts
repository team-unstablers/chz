import { SyntaxKind } from "../ts-api.ts";
import type {
  ChzImagineClass,
  ChzImagineClassMember,
  ChzImagineDeclaration,
  ChzImagineFunction,
  ChzProfileDirective,
  ProjectionIsland,
  SourceSpan,
} from "./syntax.ts";
import {
  commitsImagine,
  isIdentifierToken,
  type ChzToken,
} from "./tokens.ts";

export interface PendingDiagnostic {
  code:
    | "CHZ1001"
    | "CHZ1002"
    | "CHZ1004"
    | "CHZ1005"
    | "CHZ1007"
    | "CHZ1008";
  offset: number;
}

export interface ProjectionReplacement {
  span: SourceSpan;
  placeholder: "blank" | "empty-class-element";
}

export interface CheeseScanResult {
  profile: ChzProfileDirective | null;
  declarations: ChzImagineDeclaration[];
  islands: ProjectionIsland[];
  replacements: ProjectionReplacement[];
  diagnostics: PendingDiagnostic[];
}

interface PairMaps {
  closeForOpen: ReadonlyMap<number, number>;
}

const MEMBER_MODIFIERS = new Set<SyntaxKind>([
  SyntaxKind.StaticKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.AsyncKeyword,
  SyntaxKind.PublicKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
]);

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

function textIs(token: ChzToken | undefined, text: string): boolean {
  return token?.text === text && token.value === text;
}

function directTokens(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  openIndex: number,
  closeIndex: number,
): number[] {
  const result: number[] = [];
  let index = openIndex + 1;
  while (index < closeIndex) {
    result.push(index);
    const token = tokens[index]!;
    if (
      token.kind === SyntaxKind.OpenBraceToken ||
      token.kind === SyntaxKind.OpenParenToken ||
      token.kind === SyntaxKind.OpenBracketToken
    ) {
      const close = pairs.closeForOpen.get(index);
      if (close !== undefined) {
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
  return result;
}

function looksLikeContractBody(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  openIndex: number,
  closeIndex: number,
): boolean {
  const firstIndex = directTokens(tokens, pairs, openIndex, closeIndex)[0];
  if (firstIndex === undefined) return true;
  const first = tokens[firstIndex]!;
  return textIs(first, "requirements") ||
    textIs(first, "ensure") ||
    textIs(first, "requirments") ||
    first.kind === SyntaxKind.ConstKeyword ||
    first.kind === SyntaxKind.LetKeyword ||
    first.kind === SyntaxKind.VarKeyword ||
    first.kind === SyntaxKind.ReturnKeyword ||
    first.kind === SyntaxKind.ThrowKeyword;
}

/**
 * A function signature can contain object/mapped/conditional type braces. We
 * skip each balanced brace as a unit and accept the first candidate whose
 * top-level content has statement shape. The TypeScript parse remains the
 * authority: this only locates the Cheese-owned body shell.
 */
function findContractBody(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  fromIndex: number,
  limitIndex: number,
): { open: number; close: number } | undefined {
  let index = fromIndex;
  while (index < limitIndex) {
    if (tokens[index]?.kind === SyntaxKind.OpenBraceToken) {
      const close = pairs.closeForOpen.get(index);
      if (close === undefined) return undefined;
      if (looksLikeContractBody(tokens, pairs, index, close)) {
        return { open: index, close };
      }
      index = close + 1;
      continue;
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
  while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
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
    span: { start: tokens[index]!.start, end: endOfLine(source, nameToken.end) },
  };
}

interface ClassScan {
  declaration: ChzImagineClass;
  nextIndex: number;
}

function scanClassMembers(
  fileName: string,
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  openIndex: number,
  closeIndex: number,
  islands: ProjectionIsland[],
  replacements: ProjectionReplacement[],
  diagnostics: PendingDiagnostic[],
): { contracts: ChzImagineClass["contracts"]; members: ChzImagineClassMember[] } {
  const contracts: ChzImagineClass["contracts"] = [];
  const members: ChzImagineClassMember[] = [];
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
      const semicolonIndex = tokens[closeParen + 1]?.kind === SyntaxKind.SemicolonToken
        ? closeParen + 1
        : closeParen;
      const span = { start: token.start, end: tokens[semicolonIndex]!.end };
      const islandIndex = islands.length;
      islands.push({
        kind: "class-contract-body",
        original: span,
        placeholder: span,
        virtualFileName: `${fileName}.__chz_island_${islandIndex}.ts`,
        syntheticFileName: `${fileName}.__chz_synthetic_${islandIndex}.ts`,
      });
      replacements.push({ span, placeholder: "empty-class-element" });
      contracts.push({
        kind: textIs(token, "requirements") ? "requirements" : "ensure",
        span,
      });
      index = semicolonIndex + 1;
      memberStart = true;
      continue;
    }

    if (memberStart && textIs(token, "imagine")) {
      const next = tokens[index + 1];
      if (next === undefined || !commitsImagine(next)) {
        memberStart = false;
        index += 1;
        continue;
      }

      replacements.push({
        span: { start: token.start, end: token.end },
        placeholder: "blank",
      });

      let cursor = index + 1;
      while (MEMBER_MODIFIERS.has(tokens[cursor]?.kind ?? SyntaxKind.Unknown)) {
        cursor += 1;
      }
      const nameToken = tokens[cursor];
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
      const isMethod = afterName?.kind === SyntaxKind.OpenParenToken ||
        afterName?.kind === SyntaxKind.LessThanToken;
      const body = findContractBody(tokens, pairs, cursor + 1, closeIndex);
      if (body === undefined) {
        diagnostics.push({ code: "CHZ1007", offset: nameToken.end });
        break;
      }
      const bodySpan = {
        start: tokens[body.open]!.start,
        end: tokens[body.close]!.end,
      };

      if (isMethod) {
        members.push({
          kind: "ImagineMethod",
          name: nameToken.value,
          span: { start: token.start, end: bodySpan.end },
          imagineSpan: { start: token.start, end: token.end },
          bodySpan,
          contracts: [],
        });
      } else {
        const islandIndex = islands.length;
        islands.push({
          kind: "property-contract-body",
          original: bodySpan,
          placeholder: bodySpan,
          virtualFileName: `${fileName}.__chz_island_${islandIndex}.ts`,
          syntheticFileName: `${fileName}.__chz_synthetic_${islandIndex}.ts`,
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
          contracts: [],
        });
      }

      index = body.close + 1;
      memberStart = true;
      continue;
    }

    if (memberStart) {
      diagnostics.push({ code: "CHZ1004", offset: token.start });
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

  return { contracts, members };
}

function scanClass(
  fileName: string,
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  declarationStart: number,
  imagineIndex: number,
  kindIndex: number,
  exported: boolean,
  islands: ProjectionIsland[],
  replacements: ProjectionReplacement[],
  diagnostics: PendingDiagnostic[],
): ClassScan | undefined {
  const name = declarationName(tokens, kindIndex + 1);
  if (name === undefined) {
    diagnostics.push({
      code: "CHZ1002",
      offset: tokens[kindIndex + 1]?.start ?? tokens[kindIndex]!.end,
    });
    return undefined;
  }
  const body = findContractBody(tokens, pairs, name.index + 1, tokens.length);
  if (body === undefined) {
    diagnostics.push({ code: "CHZ1007", offset: tokens[name.index]!.end });
    return undefined;
  }
  const scanned = scanClassMembers(
    fileName,
    tokens,
    pairs,
    body.open,
    body.close,
    islands,
    replacements,
    diagnostics,
  );
  const declaration: ChzImagineClass = {
    kind: "ImagineClass",
    name: name.name,
    span: {
      start: tokens[declarationStart]!.start,
      end: tokens[body.close]!.end,
    },
    imagineSpan: {
      start: tokens[imagineIndex]!.start,
      end: tokens[imagineIndex]!.end,
    },
    bodySpan: {
      start: tokens[body.open]!.start,
      end: tokens[body.close]!.end,
    },
    exported,
    contracts: scanned.contracts,
    members: scanned.members,
  };
  return { declaration, nextIndex: body.close + 1 };
}

function scanFunction(
  tokens: readonly ChzToken[],
  pairs: PairMaps,
  declarationStart: number,
  imagineIndex: number,
  kindIndex: number,
  exported: boolean,
  diagnostics: PendingDiagnostic[],
): { declaration: ChzImagineFunction; nextIndex: number } | undefined {
  const name = declarationName(tokens, kindIndex + 1);
  if (name === undefined) {
    diagnostics.push({
      code: "CHZ1002",
      offset: tokens[kindIndex + 1]?.start ?? tokens[kindIndex]!.end,
    });
    return undefined;
  }
  const body = findContractBody(tokens, pairs, name.index + 1, tokens.length);
  if (body === undefined) {
    diagnostics.push({ code: "CHZ1007", offset: tokens[name.index]!.end });
    return undefined;
  }
  return {
    declaration: {
      kind: "ImagineFunction",
      name: name.name,
      span: {
        start: tokens[declarationStart]!.start,
        end: tokens[body.close]!.end,
      },
      imagineSpan: {
        start: tokens[imagineIndex]!.start,
        end: tokens[imagineIndex]!.end,
      },
      bodySpan: {
        start: tokens[body.open]!.start,
        end: tokens[body.close]!.end,
      },
      exported,
      contracts: [],
    },
    nextIndex: body.close + 1,
  };
}

/**
 * Scan only Cheese's declaration shell. TypeScript signatures and expressions
 * remain opaque balanced-token regions and are bound to real AST nodes later.
 */
export function scanCheeseExtensions(
  source: string,
  fileName: string,
  tokens: readonly ChzToken[],
): CheeseScanResult {
  const pairs = buildPairMaps(tokens);
  const declarations: ChzImagineDeclaration[] = [];
  const islands: ProjectionIsland[] = [];
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

    let declarationStart = index;
    let imagineIndex = index;
    let exported = false;

    if (statementStart && token.kind === SyntaxKind.ExportKeyword) {
      if (tokens[index + 1]?.kind === SyntaxKind.DefaultKeyword && textIs(tokens[index + 2], "imagine")) {
        diagnostics.push({ code: "CHZ1005", offset: tokens[index + 1]!.start });
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
      (token.kind === SyntaxKind.DeclareKeyword || token.kind === SyntaxKind.AbstractKeyword) &&
      textIs(tokens[index + 1], "imagine")
    ) {
      diagnostics.push({ code: "CHZ1005", offset: token.start });
      imagineIndex = index + 1;
    } else if (!(statementStart && textIs(token, "imagine"))) {
      if (token.kind === SyntaxKind.SemicolonToken) statementStart = true;
      else if (token.kind === SyntaxKind.OpenBraceToken) {
        const close = pairs.closeForOpen.get(index);
        if (close !== undefined) {
          index = close + 1;
          statementStart = true;
          continue;
        }
      }
      else if (token.kind !== SyntaxKind.EndOfFile) statementStart = false;
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

    replacements.push({
      span: { start: imagineToken.start, end: imagineToken.end },
      placeholder: "blank",
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
    if (textIs(kindToken, "resource") || kindToken.kind === SyntaxKind.VarKeyword) {
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
        diagnostics,
      );
      if (scanned === undefined) break;
      declarations.push(scanned.declaration);
      index = scanned.nextIndex;
      statementStart = true;
      continue;
    }

    const scanned = scanClass(
      fileName,
      tokens,
      pairs,
      declarationStart,
      imagineIndex,
      kindIndex,
      exported,
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
