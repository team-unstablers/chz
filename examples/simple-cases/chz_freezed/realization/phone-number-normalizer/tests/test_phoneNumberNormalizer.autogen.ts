/// test_phoneNumberNormalizer.autogen.ts
/// AUTO-GENERATED tests for `imagine function phoneNumberNormalizer`, authored by x-ai/grok-4.5
/// (via chz-realize) on 2026-07-23T21:50:03.572Z.

/**
 * Autogen tests for phoneNumberNormalizer.
 *
 * Covers:
 *   - 11-digit normalization to 010-XXXX-XXXX
 *   - 10-digit normalization to 010-XXX-XXXX
 *   - separator stripping
 *   - optional +82 country-code rewrite
 *   - pass-through of invalid inputs (do not format)
 */

import { describe, it, expect } from "vitest";
import { phoneNumberNormalizer } from "../implementations/phoneNumberNormalizer";

describe("phoneNumberNormalizer", () => {
  // ---------------------------------------------------------------------------
  // Valid 11-digit inputs → 010-XXXX-XXXX
  // ---------------------------------------------------------------------------

  it("normalizes a plain 11-digit string: 01012341234 → 010-1234-1234", () => {
    expect(phoneNumberNormalizer("01012341234")).toBe("010-1234-1234");
  });

  it("normalizes 010-1234-1234 (already in target 3-4-4 format)", () => {
    expect(phoneNumberNormalizer("010-1234-1234")).toBe("010-1234-1234");
  });

  it("normalizes 010.1234.5678 (dots as separators)", () => {
    expect(phoneNumberNormalizer("010.1234.5678")).toBe("010-1234-5678");
  });

  it("normalizes 010 1234 5678 (spaces as separators)", () => {
    expect(phoneNumberNormalizer("010 1234 5678")).toBe("010-1234-5678");
  });

  it("normalizes 010-1234-5678 (standard case)", () => {
    expect(phoneNumberNormalizer("010-1234-5678")).toBe("010-1234-5678");
  });

  it("normalizes 01011112222", () => {
    expect(phoneNumberNormalizer("01011112222")).toBe("010-1111-2222");
  });

  it("normalizes 010-0000-0000 (all zeros after prefix)", () => {
    expect(phoneNumberNormalizer("010-0000-0000")).toBe("010-0000-0000");
  });

  // ---------------------------------------------------------------------------
  // Valid 10-digit inputs → 010-XXX-XXXX (supported alternate grouping)
  // ---------------------------------------------------------------------------

  it("normalizes 010-123-1234 (3-3-4 format) without zero-padding the middle", () => {
    // Requirements explicitly support 010-123-1234; digits are 10, not 11.
    expect(phoneNumberNormalizer("010-123-1234")).toBe("010-123-1234");
  });

  it("normalizes plain 10-digit 0101231234 → 010-123-1234", () => {
    expect(phoneNumberNormalizer("0101231234")).toBe("010-123-1234");
  });

  // ---------------------------------------------------------------------------
  // International writing of the same domestic mobile number
  // ---------------------------------------------------------------------------

  it("normalizes +82-10-1234-5678 (international prefix) to domestic form", () => {
    expect(phoneNumberNormalizer("+82-10-1234-5678")).toBe("010-1234-5678");
  });

  it("normalizes 821012345678 without plus sign", () => {
    expect(phoneNumberNormalizer("821012345678")).toBe("010-1234-5678");
  });

  // ---------------------------------------------------------------------------
  // Invalid inputs — must NOT be reformatted (return original unchanged)
  // ---------------------------------------------------------------------------

  it("does not format 010-1234-12345 (one extra digit → 12 digits)", () => {
    expect(phoneNumberNormalizer("010-1234-12345")).toBe("010-1234-12345");
  });

  it("does not format plain 12-digit 010123412345", () => {
    expect(phoneNumberNormalizer("010123412345")).toBe("010123412345");
  });

  it("does not format 9-digit 010123123", () => {
    expect(phoneNumberNormalizer("010123123")).toBe("010123123");
  });

  it("does not format non-010 mobile-looking 011-1234-1234", () => {
    expect(phoneNumberNormalizer("011-1234-1234")).toBe("011-1234-1234");
  });

  it("does not format empty string", () => {
    expect(phoneNumberNormalizer("")).toBe("");
  });

  it("does not format pure non-digit input", () => {
    expect(phoneNumberNormalizer("abc-defg-hijk")).toBe("abc-defg-hijk");
  });

  it("does not format too-short 010-123-456", () => {
    expect(phoneNumberNormalizer("010-123-456")).toBe("010-123-456");
  });

  it("does not format landline-like 02-1234-5678", () => {
    expect(phoneNumberNormalizer("02-1234-5678")).toBe("02-1234-5678");
  });
});
