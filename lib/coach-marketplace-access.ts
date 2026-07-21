/**
 * SwingProAI — Coach Marketplace: Server-Only Access Guard
 *
 * Authoritative, single boundary for "is the Coach Marketplace turned on
 * right now." Every CM2 server-side data function (the future coach
 * profile-editor mutation, the future public directory read) must call
 * requireCoachMarketplaceEnabled() as its first line, before constructing
 * any Supabase client or issuing any query — this is defense in depth so a
 * future route can't forget the flag: even if the calling route also fails
 * to call notFound() on its own, no marketplace query can execute past
 * this guard while the flag is off.
 *
 * `server-only` (npm package) is imported below and enforced by the
 * bundler: any accidental import of this module from a client component
 * fails the Next.js build, unlike lib/feature-flags.ts's/
 * lib/entitlements.ts's older documented-but-unenforced convention.
 *
 * This file never imports a Supabase client, never reads a service-role
 * key, and never performs a database operation of any kind — it is a pure
 * guard function.
 */

import "server-only";

import { isCoachMarketplaceEnabled } from "./feature-flags";

/**
 * Thrown by requireCoachMarketplaceEnabled() when the Coach Marketplace is
 * disabled. Its message never includes the raw environment value — only
 * the fact that the feature is off.
 */
export class CoachMarketplaceDisabledError extends Error {
  constructor() {
    super("Coach Marketplace is disabled");
    this.name = "CoachMarketplaceDisabledError";
  }
}

/**
 * Throws CoachMarketplaceDisabledError when COACH_MARKETPLACE_ENABLED is
 * not exactly "true" (per lib/feature-flags.ts's normalization rules).
 * Returns normally (void) when enabled. Callers should invoke this before
 * constructing any Supabase client or running any marketplace query, and
 * routes should additionally call Next.js notFound() so a disabled feature
 * presents as a nonexistent route rather than a thrown-error page.
 */
export function requireCoachMarketplaceEnabled(): void {
  if (!isCoachMarketplaceEnabled()) {
    throw new CoachMarketplaceDisabledError();
  }
}
