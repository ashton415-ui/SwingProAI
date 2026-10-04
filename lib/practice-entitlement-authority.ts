import "server-only";
import { canUsePracticeIntelligence } from "@/lib/entitlements";
import { v1Error } from "@/lib/api/v1-response";
import type { AuthenticatedCaller } from "@/utils/supabase/server";

/**
 * SwingProAI — Practice Intelligence access authority (PI-1A).
 *
 * The one place a practice route learns whether the verified caller may use
 * Practice Intelligence. Every handler calls it after the feature flag and
 * after authentication, and before it reads a path, a body or a practice row.
 *
 * Authority comes from the caller's OWN public.users row, read on the
 * caller-scoped client (RLS restricts it to that row, and the `.eq` restates
 * it). anon and authenticated hold no INSERT or UPDATE on public.users, so a
 * caller cannot grant themselves a tier or a status. The decision itself is
 * lib/entitlements' canUsePracticeIntelligence; no tier or status is named
 * here or in any route. Role is not consulted: a coach or an admin is not a
 * membership.
 *
 *   allowed      the row exists and passes the entitlement helper
 *   denied       the row exists and does not → 403 ENTITLEMENT_REQUIRED
 *   unavailable  the row could not be read, or is missing → 503
 *
 * A missing row is an invariant failure (handle_new_user creates it with the
 * auth user), not a statement about membership, so it is never folded into
 * `denied`. Nothing here writes, and no elevated client exists on this path.
 */

/** The exact projection: the two columns the decision needs, nothing else. */
export const PRACTICE_ACCESS_COLUMNS = "subscription_tier, subscription_status";

export const PRACTICE_ENTITLEMENT_MESSAGE = "Practice Intelligence isn't available with your current membership.";
export const PRACTICE_ACCESS_UNAVAILABLE_MESSAGE = "Practice access is temporarily unavailable. Please retry.";

export type PracticeAccess =
  | { readonly status: "allowed" }
  | { readonly status: "denied" }
  | { readonly status: "unavailable" };

type PracticeCaller = Pick<AuthenticatedCaller, "userId" | "client">;

export async function resolvePracticeAccess(caller: PracticeCaller): Promise<PracticeAccess> {
  try {
    const { data, error } = await caller.client
      .from("users")
      .select(PRACTICE_ACCESS_COLUMNS)
      .eq("id", caller.userId)
      .maybeSingle();
    if (error || !data) return { status: "unavailable" };
    const row = data as { subscription_tier?: unknown; subscription_status?: unknown };
    return canUsePracticeIntelligence(row.subscription_tier, row.subscription_status)
      ? { status: "allowed" }
      : { status: "denied" };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * The route-facing form: `null` when the caller may continue, otherwise the
 * fixed V1 answer. The messages say nothing about tier or status.
 */
export async function requirePracticeAccess(caller: PracticeCaller, requestId: string): Promise<Response | null> {
  const access = await resolvePracticeAccess(caller);
  switch (access.status) {
    case "allowed":
      return null;
    case "denied":
      return v1Error("ENTITLEMENT_REQUIRED", PRACTICE_ENTITLEMENT_MESSAGE, requestId, 403);
    default:
      return v1Error("SERVER_TEMPORARILY_UNAVAILABLE", PRACTICE_ACCESS_UNAVAILABLE_MESSAGE, requestId, 503);
  }
}
