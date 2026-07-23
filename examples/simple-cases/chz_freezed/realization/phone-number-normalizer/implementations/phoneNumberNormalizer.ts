/// phoneNumberNormalizer.ts
/// realization of `imagine function phoneNumberNormalizer(input: string)`
/// realized by x-ai/grok-4.5 (via chz-realize) on 2026-07-23T21:50:03.572Z
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

/**
 * phoneNumberNormalizer — normalize South Korean mobile phone numbers.
 *
 * Requirements:
 *   - Normalize 01012341234 → 010-1234-1234
 *   - Follow South Korean mobile phone conventions
 *   - Support both 010-123-1234 (10-digit / 3-3-4) and 010-1234-1234 (11-digit / 3-4-4)
 *   - Do NOT format invalid numbers (e.g. 010-1234-12345 stays unformatted)
 *
 * ASSUMPTION: "Do not format invalid numbers" means return the original input
 * string unchanged when the value cannot be parsed as a valid KR mobile number.
 * That avoids inventing a partial format and matches a simple pass-through API.
 *
 * ASSUMPTION: Only the modern dominant mobile prefix `010` is accepted. Other
 * historical prefixes (011/016/017/018/019) are treated as invalid here because
 * every requirement example uses 010.
 *
 * ASSUMPTION: Leading country code `+82` / `82` with a following `10…` national
 * mobile subscriber number is rewritten to domestic `010…` before formatting,
 * since `+82-10-1234-5678` is a common way to write the same number.
 */

/**
 * Normalize a South Korean mobile phone number to hyphenated form.
 *
 * @param input - Raw phone number string (digits and optional separators).
 * @returns Normalized `010-XXX-XXXX` or `010-XXXX-XXXX`, or `input` unchanged if invalid.
 */
export function phoneNumberNormalizer(input: string): string {
  // Collapse separators/punctuation so "010-1234-1234" and "01012341234" match.
  let digits = input.replace(/\D/g, "");

  // International form: +82 10 XXXX XXXX → domestic 010 XXXX XXXX
  // 82 + 10 + 8 subscriber digits = 12 digits total.
  if (digits.startsWith("8210") && digits.length === 12) {
    digits = "0" + digits.slice(2); // "8210…" → "010…"
  }

  // Must be exactly the 010 mobile prefix after any country-code rewrite.
  if (!digits.startsWith("010")) {
    return input;
  }

  // 10 digits → older 3-3-4 grouping: 010-123-1234
  if (digits.length === 10) {
    const prefix = digits.slice(0, 3);
    const mid = digits.slice(3, 6);
    const last = digits.slice(6, 10);
    return `${prefix}-${mid}-${last}`;
  }

  // 11 digits → current 3-4-4 grouping: 010-1234-1234
  if (digits.length === 11) {
    const prefix = digits.slice(0, 3);
    const mid = digits.slice(3, 7);
    const last = digits.slice(7, 11);
    return `${prefix}-${mid}-${last}`;
  }

  // Any other length (too short, too long, extra digit like …12345) is invalid.
  return input;
}

/// END OF AUTO-GENERATED CODE
