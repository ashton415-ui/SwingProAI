import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "server-only" throws if imported outside a server context (e.g. Next.js's
// RSC/client-component boundary detection). Vitest runs in a plain Node
// environment with no such boundary, so the real package's module has no
// meaningful behavior to test here — it's mocked to a no-op so
// coach-marketplace-access.ts's own `import "server-only";` doesn't need
// special Vitest configuration. vi.mock calls are hoisted above the imports
// below by Vitest's transform, so this applies before coach-marketplace-access
// is loaded.
vi.mock("server-only", () => ({}));

import { requireCoachMarketplaceEnabled, CoachMarketplaceDisabledError } from "./coach-marketplace-access";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLAG_KEY = "COACH_MARKETPLACE_ENABLED";

describe("requireCoachMarketplaceEnabled", () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[FLAG_KEY];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[FLAG_KEY];
    } else {
      process.env[FLAG_KEY] = originalValue;
    }
  });

  it('does not throw for the exact value "true"', () => {
    process.env[FLAG_KEY] = "true";
    expect(() => requireCoachMarketplaceEnabled()).not.toThrow();
  });

  it("matches the underlying feature-flag helper's case/whitespace handling (uppercase, mixed case, surrounding whitespace)", () => {
    process.env[FLAG_KEY] = "TRUE";
    expect(() => requireCoachMarketplaceEnabled()).not.toThrow();
    process.env[FLAG_KEY] = "True";
    expect(() => requireCoachMarketplaceEnabled()).not.toThrow();
    process.env[FLAG_KEY] = "  true  ";
    expect(() => requireCoachMarketplaceEnabled()).not.toThrow();
    process.env[FLAG_KEY] = "\ttrue\n";
    expect(() => requireCoachMarketplaceEnabled()).not.toThrow();
  });

  it('throws CoachMarketplaceDisabledError for "false"', () => {
    process.env[FLAG_KEY] = "false";
    expect(() => requireCoachMarketplaceEnabled()).toThrow(CoachMarketplaceDisabledError);
  });

  it("throws when the variable is missing entirely", () => {
    delete process.env[FLAG_KEY];
    expect(() => requireCoachMarketplaceEnabled()).toThrow(CoachMarketplaceDisabledError);
  });

  it("throws for an empty string", () => {
    process.env[FLAG_KEY] = "";
    expect(() => requireCoachMarketplaceEnabled()).toThrow(CoachMarketplaceDisabledError);
  });

  it("throws for malformed/unrelated values", () => {
    const malformedValues = ["1", "yes", "on", "enabled", "TRUEISH", "true ish", "null", "undefined"];
    for (const value of malformedValues) {
      process.env[FLAG_KEY] = value;
      expect(() => requireCoachMarketplaceEnabled(), `expected "${value}" to throw`).toThrow(
        CoachMarketplaceDisabledError
      );
    }
  });

  it("thrown error message never reveals the raw environment value", () => {
    process.env[FLAG_KEY] = "some-unexpected-raw-secret-shaped-value-12345";
    try {
      requireCoachMarketplaceEnabled();
      throw new Error("expected requireCoachMarketplaceEnabled to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CoachMarketplaceDisabledError);
      const message = (err as Error).message;
      expect(message).not.toContain("some-unexpected-raw-secret-shaped-value-12345");
      expect(message).not.toContain(process.env[FLAG_KEY] as string);
    }
  });
});

describe("lib/coach-marketplace-access.ts — source-level guarantees", () => {
  const source = readFileSync(path.join(__dirname, "coach-marketplace-access.ts"), "utf8");

  it("contains no Supabase client construction, service-role key, or database operation", () => {
    const lower = source.toLowerCase();
    expect(lower).not.toMatch(/createclient/);
    expect(lower).not.toMatch(/createadminclient/);
    expect(lower).not.toMatch(/service_role/);
    expect(lower).not.toMatch(/supabase_service_role_key/);
    expect(lower).not.toMatch(/\.from\(/);
    expect(lower).not.toMatch(/\.rpc\(/);
  });

  it("contains no hardcoded secret-shaped string literal", () => {
    // A long base64/JWT-like literal would indicate an accidentally
    // hardcoded key rather than a reference to an environment variable.
    expect(source).not.toMatch(/['"]eyJ[A-Za-z0-9_-]{20,}['"]/);
    expect(source).not.toMatch(/['"]sb-[a-z0-9]{10,}['"]/);
  });

  it("reads the flag only through isCoachMarketplaceEnabled(), never process.env directly", () => {
    expect(source).toMatch(/isCoachMarketplaceEnabled/);
    expect(source).not.toMatch(/process\.env\.COACH_MARKETPLACE_ENABLED/);
  });

  it('imports "server-only" so an accidental client-component import fails the build', () => {
    expect(source).toMatch(/import\s+"server-only"\s*;/);
  });
});
