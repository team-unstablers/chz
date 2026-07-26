/**
 * Natural-language requirements prose needs a boundary-tolerant text matcher.
 * This is an explicit analysis stage, not a substitute for TypeScript AST or
 * Checker analysis of signatures and executable ensure expressions.
 */

/**
 * True when the character continues an ASCII identifier. Non-ASCII
 * characters deliberately remain valid boundaries because Korean particles
 * attach directly to symbol names (`크리티컬_판정을`, `크리티컬_판정이`).
 */
function isAsciiIdentifierPart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

/** Match one known symbol at a prose identifier boundary. */
export function mentionsSymbol(text: string, name: string): boolean {
  if (name.length === 0) return false;
  for (let from = 0; ; ) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = at > 0 ? text[at - 1]! : "";
    const after = at + name.length < text.length
      ? text[at + name.length]!
      : "";
    if (
      (before === "" || !isAsciiIdentifierPart(before)) &&
      (after === "" || !isAsciiIdentifierPart(after))
    ) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Blank boundary-tolerant occurrences of longer names before matching a
 * shorter known name. This keeps `판정기` from also becoming `판정`.
 */
export function maskOccurrences(
  text: string,
  names: readonly string[],
): string {
  let masked = text;
  for (const name of names) {
    if (name.length === 0) continue;
    let result = "";
    let from = 0;
    for (;;) {
      const at = masked.indexOf(name, from);
      if (at < 0) {
        result += masked.slice(from);
        break;
      }
      const before = at > 0 ? masked[at - 1]! : "";
      const after = at + name.length < masked.length
        ? masked[at + name.length]!
        : "";
      const bounded =
        (before === "" || !isAsciiIdentifierPart(before)) &&
        (after === "" || !isAsciiIdentifierPart(after));
      result += masked.slice(from, at) +
        (bounded ? " ".repeat(name.length) : name);
      from = at + name.length;
    }
    masked = result;
  }
  return masked;
}

/** Return known symbols mentioned by requirements prose, in input order. */
export function mentionedSymbols(
  text: string,
  names: readonly string[],
): string[] {
  return names.filter((name) => {
    const shadowing = names
      .filter((other) =>
        other !== name &&
        other.length > name.length &&
        other.includes(name)
      )
      .sort((left, right) => right.length - left.length);
    return mentionsSymbol(maskOccurrences(text, shadowing), name);
  });
}
