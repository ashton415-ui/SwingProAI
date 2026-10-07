import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// PRICING-1 — launch billing copy stays truthful
// ============================================================================
//
// Signup only creates an account; the 7-day trial starts at Stripe Checkout,
// which collects a card by default. These checks keep the misleading copy from
// returning and pin the checkout condition that makes the card claim true.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const SIGNUP = read("app/(auth)/signup/page.tsx");
const HOME = read("app/page.tsx");
const UPGRADE = read("app/(dashboard)/upgrade/page.tsx");
const CHECKOUT = read("app/api/stripe/checkout/route.ts");

describe("PRICING-1 billing copy", () => {
  it("signup promises no card-free trial and names where the trial starts", () => {
    expect(SIGNUP).not.toContain("No Credit Card Required");
    expect(SIGNUP).toContain("7-day trial on paid plans · Card required at checkout");
  });

  it("the homepage CTA no longer claims signup starts a trial", () => {
    expect(HOME).not.toContain("Start Free Trial");
    expect(HOME).toMatch(/href="\/signup"[^>]*>\s*Get Started\s*</);
  });

  it("the upgrade page states the card and billing terms without unbacked promises", () => {
    expect(UPGRADE).not.toContain("Cancel anytime");
    expect(UPGRADE).not.toContain("No hidden fees");
    expect(UPGRADE).toContain(
      "All plans include a 7-day free trial. A card is required at checkout; billing starts when your trial ends.",
    );
    expect(UPGRADE).toContain("Secured by Stripe");
  });

  it("checkout still grants a 7-day trial and collects a card, so the copy stays true", () => {
    expect(CHECKOUT).toContain("trial_period_days: 7");
    expect(CHECKOUT).toContain('payment_method_types: ["card"]');
    expect(CHECKOUT).not.toContain("payment_method_collection:");
  });
});
