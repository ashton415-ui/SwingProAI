import "server-only";
import { redirect } from "next/navigation";
import { resolveVerifiedAuth } from "@/utils/supabase/server";

/**
 * SwingProAI — admin authority (ADMIN-OPS-0).
 *
 * Server-only, enforced: the `server-only` import above makes Next.js fail the
 * build if this module is ever pulled into a client bundle. It never
 * constructs the service-role client.
 *
 * Who is an admin is decided in exactly one way: the verified caller's OWN
 * public.users row, read on the caller-scoped client, says role = 'admin'.
 * That row is server-authoritative because anon and authenticated hold no
 * INSERT or UPDATE on public.users (entitlement_write_authority), so a caller
 * cannot promote themselves. Nothing else counts: not user_metadata, not
 * app_metadata, not a query string, not anything the browser sends.
 *
 * The result keeps four outcomes apart:
 *
 *   admin            verified caller whose own row says 'admin'
 *   unauthenticated  no credential, or a credential Auth rejected
 *   forbidden        verified caller who is not an admin (or has no profile)
 *   unavailable      Auth could not verify, or the role could not be read
 *
 * `unavailable` is never folded into `unauthenticated` or `forbidden`: an
 * outage is not a statement about the caller, and it is never `admin` either.
 */

/** Proof that admin authority was established for one verified caller. */
export interface AdminCaller {
  readonly status: "admin";
  readonly userId: string;
}

export type AdminAuthority =
  | AdminCaller
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable"; readonly reason: "auth" | "profile" };

/**
 * Every AdminCaller handed out by this module. The directory service accepts
 * only objects found here, so a hand-built `{ status: "admin" }` literal is not
 * a proof.
 */
const minted = new WeakSet<object>();

/** True only for a proof minted by resolveAdminAuthority in this process. */
export function isAdminCaller(value: unknown): value is AdminCaller {
  return typeof value === "object" && value !== null && minted.has(value);
}

export async function resolveAdminAuthority(): Promise<AdminAuthority> {
  const auth = await resolveVerifiedAuth();

  switch (auth.status) {
    case "absent":
    case "invalid":
      return { status: "unauthenticated" };
    case "verification_unavailable":
      return { status: "unavailable", reason: "auth" };
    case "authenticated":
      break;
    default:
      // A resolver state added later fails closed.
      return { status: "unavailable", reason: "auth" };
  }

  let row: { role?: unknown } | null;
  try {
    const { data, error } = await auth.client
      .from("users")
      .select("role")
      .eq("id", auth.userId)
      .maybeSingle();
    if (error) return { status: "unavailable", reason: "profile" };
    row = data as { role?: unknown } | null;
  } catch {
    return { status: "unavailable", reason: "profile" };
  }

  if (!row || row.role !== "admin") return { status: "forbidden" };

  const proof: AdminCaller = Object.freeze({ status: "admin", userId: auth.userId });
  minted.add(proof);
  return proof;
}

/** Thrown when admin authority cannot be decided; renders the error boundary. */
export class AdminAuthorityUnavailableError extends Error {
  constructor() {
    super("Admin authorization is temporarily unavailable.");
    this.name = "AdminAuthorityUnavailableError";
  }
}

/**
 * The admin pages' entry point. Keeps the existing UX: no session → /login,
 * not an admin → /dashboard. An outage throws instead of redirecting, so it is
 * never presented as a logout or as a missing permission.
 */
export async function requireAdminForPage(): Promise<AdminCaller> {
  const authority = await resolveAdminAuthority();
  switch (authority.status) {
    case "admin":
      return authority;
    case "unauthenticated":
      return redirect("/login");
    case "forbidden":
      return redirect("/dashboard");
    default:
      throw new AdminAuthorityUnavailableError();
  }
}
