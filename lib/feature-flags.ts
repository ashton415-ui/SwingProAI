/**
 * SwingProAI — Server-Only Feature Flags
 *
 * Centralized, server-only feature-flag layer. Flags gate unfinished or
 * unreleased product surfaces and must never be readable from the client —
 * only NEXT_PUBLIC_-prefixed environment variables are ever sent to the
 * browser by Next.js, so every flag here deliberately reads a plain
 * (non-NEXT_PUBLIC_) environment variable instead.
 *
 * This file never imports the `server-only` package: it is not a dependency
 * of this repository (see package.json), and this file does not add one —
 * CM1's allowed file scope does not include package.json. Every export
 * below is still safe to import only from server components, server
 * actions, or route handlers, by convention, the same way lib/entitlements.ts
 * is used elsewhere in this codebase.
 */

/** Normalizes a raw flag value: trims whitespace, lowercases. */
function normalizeFlagValue(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Whether the Coach Marketplace foundation is enabled.
 *
 * Reads ONLY process.env.COACH_MARKETPLACE_ENABLED — never a
 * NEXT_PUBLIC_-prefixed variable. Absent, empty, or any value other than
 * the exact normalized string "true" returns false. In particular "1",
 * "yes", "on", and "enabled" are NOT accepted — only the literal word
 * "true" (in any casing, with any surrounding whitespace) turns this on.
 *
 * The raw environment value is never returned or logged by this function —
 * only the resulting boolean.
 */
export function isCoachMarketplaceEnabled(): boolean {
  return normalizeFlagValue(process.env.COACH_MARKETPLACE_ENABLED) === "true";
}

/**
 * Whether Practice Intelligence (PI-0) is enabled.
 *
 * Reads ONLY process.env.PRACTICE_INTELLIGENCE_ENABLED, with exactly the same
 * rule as isCoachMarketplaceEnabled: only the normalized string "true" turns
 * it on, and absent, empty or any other value leaves it off. Every
 * /api/v1/practice route checks this before authenticating or touching the
 * database, so with the flag off the surface answers as if it did not exist.
 */
export function isPracticeIntelligenceEnabled(): boolean {
  return normalizeFlagValue(process.env.PRACTICE_INTELLIGENCE_ENABLED) === "true";
}
