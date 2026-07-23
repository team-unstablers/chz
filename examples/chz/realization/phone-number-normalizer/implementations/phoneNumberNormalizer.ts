/// phoneNumberNormalizer.ts
/// realization of `imagine function phoneNumberNormalizer(input: string)`
/// realized by x-ai/grok-4.5 (via chz-realize) on 2026-07-23T08:54:41.474Z
///
/// AUTO-GENERATED CODE - DO NOT EDIT (manual edits must be marked with @chz-realize-override)

/**
 * Korean mobile phone number normalizer.
 *
 * Accepts raw or partially punctuated input and, when the digits form a
 * valid Korean handset number, returns one of the two canonical forms:
 *   - 10 digits → 010-123-1234  (prefix + 3 + 4)
 *   - 11 digits → 010-1234-1234 (prefix + 4 + 4)
 * Invalid numbers are returned unchanged (not reformatted).
 */
export function phoneNumberNormalizer(input: string): string {
  // Extract digits only so "010-1234-1234", "010 1234 1234", and
  // "01012341234" are handled uniformly.
  const digits = input.replace(/\D/g, "");

  // ASSUMPTION: Korean mobile prefixes are the common 01X set
  // (010/011/016/017/018/019). Landlines and other patterns are treated
  // as invalid and left unformatted.
  const mobilePrefix = /^(010|011|016|017|018|019)/;
  if (!mobilePrefix.test(digits)) {
    return input;
  }

  // Two legal lengths only (requirements: 010-123-1234 / 010-1234-1234).
  // Anything shorter or longer (e.g. 010-1234-12345) is invalid → no format.
  if (digits.length === 10) {
    // prefix(3) + mid(3) + last(4) → 010-123-1234
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  if (digits.length === 11) {
    // prefix(3) + mid(4) + last(4) → 010-1234-1234
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }

  // Wrong digit count: leave the original string alone.
  return input;
}

/// END OF AUTO-GENERATED CODE
