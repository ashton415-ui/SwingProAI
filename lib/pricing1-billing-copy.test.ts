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

const OLD_UPGRADE_TRIAL =
  "All plans include a 7-day free trial. A card is required at checkout; billing starts when your trial ends.";
const NEW_UPGRADE_TRIAL =
  "Eligible first-time subscribers receive a 7-day free trial. A card is required at checkout; billing starts when the trial ends.";
const NEW_SIGNUP_TRIAL = "7-day free trial for eligible first-time subscribers · Card required at checkout";

describe("PRICING-1 billing copy", () => {
  it("signup promises no card-free trial and names where the trial starts", () => {
    expect(SIGNUP).not.toContain("No Credit Card Required");
    expect(SIGNUP).toContain(NEW_SIGNUP_TRIAL);
  });

  it("signup no longer promises a trial on every paid plan", () => {
    expect(SIGNUP).not.toContain("7-day trial on paid plans");
    expect(SIGNUP.match(/7-day/g)).toHaveLength(1);
  });

  it("the homepage CTA no longer claims signup starts a trial", () => {
    expect(HOME).not.toContain("Start Free Trial");
    expect(HOME).toMatch(/href="\/signup"[^>]*>\s*Get Started\s*</);
  });

  it("the upgrade page states the card and billing terms without unbacked promises", () => {
    expect(UPGRADE).not.toContain("Cancel anytime");
    expect(UPGRADE).not.toContain("No hidden fees");
    expect(UPGRADE).toContain(NEW_UPGRADE_TRIAL);
    expect(UPGRADE).toContain("Secured by Stripe");
  });

  it("the broad all-plans trial promise is gone from every surface", () => {
    for (const source of [SIGNUP, HOME, UPGRADE]) {
      expect(source).not.toContain(OLD_UPGRADE_TRIAL);
      expect(source).not.toContain("All plans include a 7-day free trial");
    }
    expect(UPGRADE.match(/7-day free trial/g)).toHaveLength(1);
  });

  it("launch prices are unchanged and there is no annual plan", () => {
    expect(UPGRADE).toContain('price: "$7.99"');
    expect(UPGRADE).toContain('price: "$14.99"');
    expect(UPGRADE).toContain('price: "$24.99"');
    expect(UPGRADE).not.toMatch(/annual|\/ year|per year/i);
  });

  it("checkout grants the 7-day trial only to the eligible and still collects a card", () => {
    expect(CHECKOUT).toContain("...(trialEligible ? { trial_period_days: 7 } : {})");
    expect(CHECKOUT).toContain("const trialEligible = !claim.trialUsed && !priorTrial;");
    expect(CHECKOUT.match(/trial_period_days/g)).toHaveLength(1);
    expect(CHECKOUT).toContain('payment_method_types: ["card"]');
    expect(CHECKOUT).not.toContain("payment_method_collection:");
  });
});
