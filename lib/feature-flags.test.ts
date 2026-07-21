import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isCoachMarketplaceEnabled } from "./feature-flags";

const FLAG_KEY = "COACH_MARKETPLACE_ENABLED";
const NEXT_PUBLIC_FLAG_KEY = "NEXT_PUBLIC_COACH_MARKETPLACE_ENABLED";

describe("isCoachMarketplaceEnabled", () => {
  let originalValue: string | undefined;
  let originalNextPublicValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[FLAG_KEY];
    originalNextPublicValue = process.env[NEXT_PUBLIC_FLAG_KEY];
  });

  afterEach(() => {
    // Restore the original process environment after every test, exactly
    // as it was before this test ran (including "was never set at all").
    if (originalValue === undefined) {
      delete process.env[FLAG_KEY];
    } else {
      process.env[FLAG_KEY] = originalValue;
    }
    if (originalNextPublicValue === undefined) {
      delete process.env[NEXT_PUBLIC_FLAG_KEY];
    } else {
      process.env[NEXT_PUBLIC_FLAG_KEY] = originalNextPublicValue;
    }
  });

  it("returns false when the variable is undefined (never set)", () => {
    delete process.env[FLAG_KEY];
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it("returns false for an empty string", () => {
    process.env[FLAG_KEY] = "";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it('returns false for "false"', () => {
    process.env[FLAG_KEY] = "false";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it('returns false for "0"', () => {
    process.env[FLAG_KEY] = "0";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it('returns false for "1" (not accepted, only the literal word "true" is)', () => {
    process.env[FLAG_KEY] = "1";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it('returns false for "yes"', () => {
    process.env[FLAG_KEY] = "yes";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it('returns false for "on"', () => {
    process.env[FLAG_KEY] = "on";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it('returns false for "enabled"', () => {
    process.env[FLAG_KEY] = "enabled";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it('returns true for "true"', () => {
    process.env[FLAG_KEY] = "true";
    expect(isCoachMarketplaceEnabled()).toBe(true);
  });

  it('returns true for "TRUE" (case-insensitive)', () => {
    process.env[FLAG_KEY] = "TRUE";
    expect(isCoachMarketplaceEnabled()).toBe(true);
  });

  it('returns true for "True" (mixed case)', () => {
    process.env[FLAG_KEY] = "True";
    expect(isCoachMarketplaceEnabled()).toBe(true);
  });

  it("returns true for \"true\" with surrounding whitespace (spaces, tabs, newlines)", () => {
    process.env[FLAG_KEY] = "  true  ";
    expect(isCoachMarketplaceEnabled()).toBe(true);
    process.env[FLAG_KEY] = "\ttrue\n";
    expect(isCoachMarketplaceEnabled()).toBe(true);
  });

  it('returns false for surrounding whitespace around an otherwise-false value', () => {
    process.env[FLAG_KEY] = "  yes  ";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it("returns false for unrelated malformed values", () => {
    const malformedValues = [
      "TRUEISH",
      "true ish",
      "truee",
      " tru e ",
      "null",
      "undefined",
      "NaN",
      "[object Object]",
      "true;drop table coach_bookings;",
      "🙂",
    ];
    for (const value of malformedValues) {
      process.env[FLAG_KEY] = value;
      expect(isCoachMarketplaceEnabled(), `expected "${value}" to be false`).toBe(false);
    }
  });

  it("never reads a NEXT_PUBLIC_ variable — only the server-only COACH_MARKETPLACE_ENABLED key is consulted", () => {
    delete process.env[FLAG_KEY];
    process.env[NEXT_PUBLIC_FLAG_KEY] = "true";
    expect(isCoachMarketplaceEnabled()).toBe(false);
  });

  it("does not expose the raw environment value (returns a strict boolean, not the string)", () => {
    process.env[FLAG_KEY] = "true";
    const result = isCoachMarketplaceEnabled();
    expect(typeof result).toBe("boolean");
    expect(result).toBe(true);
  });
});
