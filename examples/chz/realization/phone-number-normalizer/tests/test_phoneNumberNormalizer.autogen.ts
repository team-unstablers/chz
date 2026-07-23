/// test_phoneNumberNormalizer.autogen.ts
/// AUTO-GENERATED tests for `imagine function phoneNumberNormalizer`, authored by x-ai/grok-4.5
/// (via chz-realize) on 2026-07-23T08:54:41.474Z.

import { describe, expect, it } from "vitest";
import { phoneNumberNormalizer } from "../implementations/phoneNumberNormalizer";

describe("phoneNumberNormalizer", () => {
  describe("11-digit mobile numbers → 010-1234-1234", () => {
    it("normalizes plain 11-digit 010 number", () => {
      expect(phoneNumberNormalizer("01012341234")).toBe("010-1234-1234");
    });

    it("normalizes the sample from the source file", () => {
      expect(phoneNumberNormalizer("01012349999")).toBe("010-1234-9999");
    });

    it("normalizes already-hyphenated 11-digit input", () => {
      expect(phoneNumberNormalizer("010-1234-1234")).toBe("010-1234-1234");
    });

    it("normalizes spaced 11-digit input", () => {
      expect(phoneNumberNormalizer("010 1234 5678")).toBe("010-1234-5678");
    });

    it("normalizes other mobile prefixes (011)", () => {
      expect(phoneNumberNormalizer("01112345678")).toBe("011-1234-5678");
    });
  });

  describe("10-digit mobile numbers → 010-123-1234", () => {
    it("normalizes plain 10-digit 010 number", () => {
      expect(phoneNumberNormalizer("0101231234")).toBe("010-123-1234");
    });

    it("normalizes the 10-digit sample from the source file", () => {
      expect(phoneNumberNormalizer("0101239999")).toBe("010-123-9999");
    });

    it("normalizes already-hyphenated 10-digit input", () => {
      expect(phoneNumberNormalizer("010-123-1234")).toBe("010-123-1234");
    });
  });

  describe("invalid numbers are not formatted", () => {
    it("does not format too-long digit sequences", () => {
      expect(phoneNumberNormalizer("01012399991239812")).toBe(
        "01012399991239812",
      );
    });

    it("does not format 010-1234-12345 style overflow", () => {
      expect(phoneNumberNormalizer("010-1234-12345")).toBe("010-1234-12345");
    });

    it("does not format too-short digit sequences", () => {
      expect(phoneNumberNormalizer("0101234")).toBe("0101234");
    });

    it("does not format non-mobile prefixes", () => {
      expect(phoneNumberNormalizer("0212345678")).toBe("0212345678");
    });

    it("does not format empty input", () => {
      expect(phoneNumberNormalizer("")).toBe("");
    });

    it("does not format non-numeric junk", () => {
      expect(phoneNumberNormalizer("not-a-number")).toBe("not-a-number");
    });
  });
});
