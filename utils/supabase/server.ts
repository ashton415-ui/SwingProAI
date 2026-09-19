import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";

// ============================================================================
// Verified server authentication
// ============================================================================
//
// The browser session cookie is written by @supabase/ssr and is, from this
// side of the wire, entirely caller-controlled: anyone can set a cookie in
// their own browser. So the parsed contents of that cookie are treated as a
// transport envelope and nothing more. Exactly one field is read out of it —
// `access_token` — and that token is handed to Supabase Auth to be verified
// before any identity exists. `user.id`, `user.email`, `expires_at` and
// `user_metadata` are never read as authority; a forged value for any of them
// changes nothing, because the identity returned below comes from the Auth
// server's answer about the token, not from the envelope that carried it.
//
// Expiry is deliberately not checked locally. `expires_at` is a number the
// caller supplies, so testing it would only ask an attacker whether they would
// like to be let in. Supabase's verdict on the token is the expiry check.
//
// Two ingress shapes are supported, and they never mix:
//
//   cookie   the web application, unchanged.
//   bearer   `Authorization: Bearer <access token>`, for future native
//            clients, opted into per route handler.
//
// Header presence selects header mode. There is no fallback in any branch: an
// explicitly supplied bad credential is an error, never an invitation to be
// authenticated as whoever the browser cookie happens to belong to. A valid
// Bearer is authoritative and the cookie is not read, parsed or compared —
// reconciling an incidental browser cookie would be credential confusion
// dressed up as a safety check.

function supabaseUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL!;
}

function supabaseAnonKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
}

/**
 * The auth cookie name for whichever Supabase project this deployment points
 * at, derived exactly as supabase-js derives its own default storage key:
 *
 *   `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`
 *
 * Deriving it is what lets local, staging and production share one source
 * file. A hard-coded project ref would silently read the wrong cookie — that
 * is, read nothing and log everyone out — anywhere but the one environment it
 * was written for.
 */
export function authStorageKey(): string {
  return `sb-${new URL(supabaseUrl()).hostname.split(".")[0]}-auth-token`;
}

/**
 * A client on the public anon key. With a token it is caller-scoped: PostgREST
 * runs as `authenticated` and the existing `auth.uid() = user_id` policies are
 * the authority. Without one it is an ordinary anonymous client, which is what
 * pre-authentication flows such as signup and the PKCE callback need.
 *
 * The service-role key is never reachable from here.
 */
function clientForToken(accessToken: string | null) {
  return createSupabaseClient(supabaseUrl(), supabaseAnonKey(), {
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * The client shape this module hands out.
 *
 * Derived from an actual call rather than from `typeof createSupabaseClient`.
 * Instantiating that generic from its declaration resolves the schema type
 * parameter without a call site, which collapses every `.from(...)` row type
 * to `never` for every consumer in the repository — the client still works at
 * runtime, but nothing that reads a column type-checks.
 */
type CallerScopedClient = ReturnType<typeof clientForToken>;

/**
 * Reassembles the stored session cookie, mirroring @supabase/ssr's own
 * `combineChunks` semantics exactly:
 *
 *   1. the bare key wins outright when it holds a value;
 *   2. otherwise `<key>.0`, `<key>.1`, … are read in ascending order;
 *   3. the scan stops at the first absent or empty chunk;
 *   4. whatever was collected is joined with no separator.
 *
 * A legitimate chunked session — which is simply what the library writes once
 * the encoded value passes 3180 characters — must authenticate normally, so
 * chunking is never itself a rejection. A truncated join produces bytes that
 * fail to parse or fail verification, and fails closed there instead.
 */
async function readStoredSessionValue(): Promise<string | null> {
  const cookieStore = await cookies();
  const key = authStorageKey();

  const bare = cookieStore.get(key)?.value;
  if (bare) return bare;

  const chunks: string[] = [];
  for (let index = 0; ; index++) {
    const chunk = cookieStore.get(`${key}.${index}`)?.value;
    if (!chunk) break;
    chunks.push(chunk);
  }

  return chunks.length > 0 ? chunks.join("") : null;
}

/**
 * Pulls the access token out of the stored envelope and nothing else.
 *
 * Parsing here is a transport concern. No other field survives this function,
 * which is what makes a tampered `user.id` or `user.email` inert rather than
 * dangerous: there is no code path by which either could become identity.
 */
function extractAccessToken(rawCookieValue: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(rawCookieValue);
    } catch {
      return rawCookieValue;
    }
  })();

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const token = (parsed as { access_token?: unknown }).access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** A verified caller. Carries only what a consumer actually needs. */
export interface AuthenticatedCaller {
  readonly status: "authenticated";
  readonly userId: string;
  readonly email: string | null;
  readonly accessToken: string;
  readonly client: CallerScopedClient;
  readonly source: "cookie" | "bearer";
}

/**
 * `absent` and `invalid` both become 401 at an API boundary, but they stay
 * distinct here because only one of them describes a credential that was
 * presented and rejected.
 *
 * `verification_unavailable` exists so that an Auth outage can never be
 * mistaken for a signed-out golfer. Collapsing the two would turn a transient
 * infrastructure failure into a site-wide logout.
 */
export type VerifiedAuth =
  | AuthenticatedCaller
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "verification_unavailable" };

/**
 * Distinguishes "Auth answered, and the answer was no" from "Auth did not
 * answer". auth-js reports a rejected token as an API error carrying an HTTP
 * status; a transport failure arrives as a retryable fetch error with no
 * status. Anything unrecognisable is treated as an outage, because guessing
 * "invalid" would sign out a valid golfer on a network blip.
 */
function isVerificationInfrastructureFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const candidate = error as { name?: unknown; status?: unknown };
  if (candidate.name === "AuthRetryableFetchError") return true;
  return typeof candidate.status !== "number";
}

async function verifyAccessToken(
  accessToken: string,
  source: "cookie" | "bearer",
): Promise<VerifiedAuth> {
  try {
    // The token is passed explicitly. This client holds no session of its own,
    // so a bare getUser() would have nothing to verify.
    const { data, error } = await clientForToken(null).auth.getUser(accessToken);

    if (error) {
      return {
        status: isVerificationInfrastructureFailure(error)
          ? "verification_unavailable"
          : "invalid",
      };
    }

    const user = data?.user;
    if (!user?.id) return { status: "invalid" };

    return {
      status: "authenticated",
      userId: user.id,
      email: user.email ?? null,
      accessToken,
      client: clientForToken(accessToken),
      source,
    };
  } catch {
    return { status: "verification_unavailable" };
  }
}

/** Verified identity from the browser session cookie. */
export async function resolveVerifiedAuth(): Promise<VerifiedAuth> {
  const raw = await readStoredSessionValue();
  if (!raw) return { status: "absent" };

  const accessToken = extractAccessToken(raw);
  if (!accessToken) return { status: "invalid" };

  return verifyAccessToken(accessToken, "cookie");
}

type ParsedAuthorization =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "bearer"; readonly token: string };

/**
 * Accepts exactly one well-formed Bearer credential.
 *
 * Note the comma rule. Undici joins repeated Authorization headers into one
 * comma-separated string, and the Headers API exposes no way to see the
 * originals, so a genuinely ambiguous header and a malformed one are
 * indistinguishable at this layer. Both are refused, which is the safe
 * reading of an ambiguous credential rather than a guess at which half to
 * honour.
 */
function parseAuthorizationHeader(rawHeader: string | null): ParsedAuthorization {
  if (rawHeader === null) return { kind: "absent" };

  const value = rawHeader.trim();
  if (value.length === 0) return { kind: "invalid" };
  if (value.includes(",")) return { kind: "invalid" };

  const parts = value.split(/\s+/);
  if (parts.length !== 2) return { kind: "invalid" };
  if (parts[0].toLowerCase() !== "bearer") return { kind: "invalid" };
  if (parts[1].length === 0) return { kind: "invalid" };

  return { kind: "bearer", token: parts[1] };
}

/**
 * Route-handler ingress: cookie for the web app, Bearer for native clients.
 *
 * Opt-in per route. This is deliberately not wired into createClient(): doing
 * so would turn every route that happens to build a client into a Bearer
 * endpoint, which is a far larger security surface than any one slice should
 * open.
 */
export async function resolveRouteAuth(): Promise<VerifiedAuth> {
  const headerList = await headers();
  const parsed = parseAuthorizationHeader(headerList.get("authorization"));

  if (parsed.kind === "invalid") return { status: "invalid" };
  if (parsed.kind === "bearer") return verifyAccessToken(parsed.token, "bearer");

  return resolveVerifiedAuth();
}

/**
 * Thrown when Supabase Auth could not be reached to verify a credential.
 *
 * Callers that redirect unauthenticated golfers to /login must not catch this
 * and do the same: the golfer's credential was never judged, and treating an
 * outage as a logout would be a lie about what happened.
 */
export class AuthVerificationUnavailableError extends Error {
  constructor() {
    super("Supabase Auth verification is unavailable.");
    this.name = "AuthVerificationUnavailableError";
  }
}

/**
 * The shape existing consumers already use. Every field below is now verified:
 * `user.id` and `user.email` come from Supabase Auth's answer about the token,
 * never from the cookie envelope.
 *
 * `refresh_token`, `expires_at` and `user_metadata` are gone. No consumer read
 * them, and a refresh token is credential material that server code has no
 * reason to hold.
 */
export interface VerifiedServerSession {
  readonly access_token: string;
  readonly user: {
    readonly id: string;
    readonly email: string | null;
  };
}

/**
 * Verified browser session, or null when there is no usable credential.
 *
 * Returns null for both "no cookie" and "cookie rejected" — callers redirect
 * to /login either way. An Auth outage throws instead, so it cannot be
 * silently rendered as a signed-out golfer.
 */
export async function getServerSession(): Promise<VerifiedServerSession | null> {
  const auth = await resolveVerifiedAuth();

  if (auth.status === "authenticated") {
    return {
      access_token: auth.accessToken,
      user: { id: auth.userId, email: auth.email },
    };
  }

  if (auth.status === "verification_unavailable") {
    throw new AuthVerificationUnavailableError();
  }

  return null;
}

/**
 * A Supabase client scoped to whatever credential the browser presented.
 *
 * This constructs a client; it does not authenticate. RLS is what decides
 * whether the attached token may read or write anything, and an unusable token
 * simply reaches a database that refuses it. Authentication authority is
 * getServerSession() / resolveVerifiedAuth(), never client construction — and
 * keeping it that way is what allows signup and the PKCE callback, which have
 * no session yet, to keep working with an ordinary anonymous client.
 */
export async function createClient() {
  const raw = await readStoredSessionValue();
  const accessToken = raw ? extractAccessToken(raw) : null;
  return clientForToken(accessToken);
}
