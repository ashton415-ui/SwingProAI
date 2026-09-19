import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Verified session resolver — runtime behaviour
// ============================================================================
//
// These tests execute the real resolver. The two things it cannot own in a
// unit test — the request context and the Auth server's verdict — are mocked,
// and nothing else is. No network call is made and no real credential appears
// anywhere in this file.
//
// The point of almost every case below is the same claim stated from a
// different angle: the cookie is transport, not identity. A forged `user.id`,
// a forged `user.email` and a forged `expires_at` must all be inert, because
// the only field the resolver reads out of the envelope is the access token
// and the only thing that turns a token into a user is Supabase Auth.
//
// A smaller set of cases covers surfaces whose guarantee is structural rather
// than behavioural — what the Stripe route may reach for, and what the login
// flow may log. Those are asserted against source text, the way the existing
// auth suites in this repository already do it, because "this statement does
// not exist" is not something a runtime test can demonstrate.

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
  /** access token -> the user Auth would confirm for it */
  users: new Map<string, { id: string; email: string | undefined }>(),
  /** simulates a transport failure reaching Auth */
  networkFailure: false,
  /** simulates getUser() throwing outright */
  throwOnVerify: false,
  created: [] as { url: string; key: string; authorization: string | null }[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      state.cookies.has(name)
        ? { name, value: state.cookies.get(name) as string }
        : undefined,
  }),
  headers: async () => ({
    get: (name: string) => state.headers.get(name.toLowerCase()) ?? null,
  }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (
    url: string,
    key: string,
    options?: { global?: { headers?: Record<string, string> } },
  ) => {
    const authorization = options?.global?.headers?.Authorization ?? null;
    state.created.push({ url, key, authorization });
    return {
      auth: {
        getUser: async (jwt?: string) => {
          if (state.throwOnVerify) throw new Error("socket hang up");
          if (state.networkFailure) {
            return {
              data: { user: null },
              // auth-js reports transport failures with no HTTP status.
              error: { name: "AuthRetryableFetchError", message: "fetch failed" },
            };
          }
          const user = jwt ? state.users.get(jwt) : undefined;
          if (!user) {
            return {
              data: { user: null },
              error: { name: "AuthApiError", status: 401, message: "invalid claim" },
            };
          }
          return { data: { user }, error: null };
        },
      },
    };
  },
}));

import {
  authStorageKey,
  createClient,
  getServerSession,
  resolveRouteAuth,
  resolveVerifiedAuth,
  AuthVerificationUnavailableError,
  type AuthenticatedCaller,
  type VerifiedAuth,
} from "@/utils/supabase/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const TEST_URL = "https://teststagingref.supabase.co";
const TEST_ANON_KEY = "test-anon-key-not-a-secret";
const KEY = "sb-teststagingref-auth-token";

const VALID_TOKEN = "valid.access.token";
const REJECTED_TOKEN = "rejected.access.token";

/** A stored session envelope. Its `user` block is deliberately untrustworthy. */
function envelope(
  accessToken: string,
  overrides: { userId?: string; email?: string; expiresAt?: number } = {},
): string {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: "refresh-token-value",
    expires_at: overrides.expiresAt ?? 1,
    user: {
      id: overrides.userId ?? "envelope-claimed-id",
      email: overrides.email ?? "envelope-claimed@example.com",
      user_metadata: { role: "admin" },
    },
  });
}

function assertAuthenticated(auth: VerifiedAuth): asserts auth is AuthenticatedCaller {
  if (auth.status !== "authenticated") {
    throw new Error(`expected authenticated, received "${auth.status}"`);
  }
}

beforeEach(() => {
  state.cookies.clear();
  state.headers.clear();
  state.users.clear();
  state.networkFailure = false;
  state.throwOnVerify = false;
  state.created.length = 0;

  process.env.NEXT_PUBLIC_SUPABASE_URL = TEST_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = TEST_ANON_KEY;

  // Auth will confirm exactly one token, as exactly one user.
  state.users.set(VALID_TOKEN, { id: "verified-user-id", email: "verified@example.com" });
});

// ─── Cookie path ──────────────────────────────────────────────────────────────

describe("verified cookie resolution", () => {
  it("1. authenticates a valid single-cookie session", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const auth = await resolveVerifiedAuth();

    assertAuthenticated(auth);
    expect(auth.userId).toBe("verified-user-id");
    expect(auth.email).toBe("verified@example.com");
    expect(auth.source).toBe("cookie");
  });

  it("2. reconstructs and authenticates a chunked session", async () => {
    const raw = envelope(VALID_TOKEN);
    const third = Math.ceil(raw.length / 3);
    state.cookies.set(`${KEY}.0`, raw.slice(0, third));
    state.cookies.set(`${KEY}.1`, raw.slice(third, third * 2));
    state.cookies.set(`${KEY}.2`, raw.slice(third * 2));

    const auth = await resolveVerifiedAuth();

    assertAuthenticated(auth);
    expect(auth.userId).toBe("verified-user-id");
  });

  it("3. refuses a malformed cookie", async () => {
    state.cookies.set(KEY, "{ this is not json");

    expect((await resolveVerifiedAuth()).status).toBe("invalid");
  });

  it("4. fails closed when a chunk is missing from the middle", async () => {
    const raw = envelope(VALID_TOKEN);
    const half = Math.ceil(raw.length / 2);
    state.cookies.set(`${KEY}.0`, raw.slice(0, half));
    // `.1` is absent; `.2` exists but is unreachable past the gap.
    state.cookies.set(`${KEY}.2`, raw.slice(half));

    expect((await resolveVerifiedAuth()).status).toBe("invalid");
  });

  it("5. ignores a tampered user id in the envelope", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN, { userId: "attacker-chosen-id" }));

    const auth = await resolveVerifiedAuth();

    assertAuthenticated(auth);
    expect(auth.userId).toBe("verified-user-id");
    expect(auth.userId).not.toBe("attacker-chosen-id");
  });

  it("6. ignores a tampered email in the envelope", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN, { email: "attacker@example.com" }));

    const auth = await resolveVerifiedAuth();

    assertAuthenticated(auth);
    expect(auth.email).toBe("verified@example.com");
    expect(auth.email).not.toBe("attacker@example.com");
  });

  it("7. a forged expires_at neither extends nor curtails token validity", async () => {
    // Far-future expiry on a token Auth rejects: still refused.
    state.cookies.set(KEY, envelope(REJECTED_TOKEN, { expiresAt: 99_999_999_999 }));
    expect((await resolveVerifiedAuth()).status).toBe("invalid");

    // Long-past expiry on a token Auth accepts: still admitted, because the
    // envelope's clock claim is never consulted in either direction.
    state.cookies.set(KEY, envelope(VALID_TOKEN, { expiresAt: 1 }));
    expect((await resolveVerifiedAuth()).status).toBe("authenticated");
  });

  it("8. refuses a token the Auth server rejects", async () => {
    state.cookies.set(KEY, envelope(REJECTED_TOKEN));

    expect((await resolveVerifiedAuth()).status).toBe("invalid");
  });

  it("9. reports absent when no session cookie exists", async () => {
    expect((await resolveVerifiedAuth()).status).toBe("absent");
  });

  it("10. a populated bare cookie short-circuits the chunk scan", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));
    state.cookies.set(`${KEY}.0`, "{ garbage that must never be read");

    const auth = await resolveVerifiedAuth();

    assertAuthenticated(auth);
    expect(auth.userId).toBe("verified-user-id");
  });

  it("11. joins contiguous chunks byte-exactly", async () => {
    const raw = envelope(VALID_TOKEN);
    state.cookies.set(`${KEY}.0`, raw.slice(0, 10));
    state.cookies.set(`${KEY}.1`, raw.slice(10, 25));
    state.cookies.set(`${KEY}.2`, raw.slice(25));

    expect(raw.slice(0, 10) + raw.slice(10, 25) + raw.slice(25)).toBe(raw);
    expect((await resolveVerifiedAuth()).status).toBe("authenticated");
  });

  it("12. ignores a stale numbered chunk left beside a valid bare cookie", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));
    state.cookies.set(`${KEY}.0`, envelope(REJECTED_TOKEN));

    const auth = await resolveVerifiedAuth();

    assertAuthenticated(auth);
    expect(auth.accessToken).toBe(VALID_TOKEN);
  });
});

// ─── Bearer path ──────────────────────────────────────────────────────────────

describe("route handler Authorization precedence", () => {
  it("13. authenticates a valid Bearer credential", async () => {
    state.headers.set("authorization", `Bearer ${VALID_TOKEN}`);

    const auth = await resolveRouteAuth();

    assertAuthenticated(auth);
    expect(auth.userId).toBe("verified-user-id");
    expect(auth.source).toBe("bearer");
  });

  it("14. refuses an invalid Bearer credential", async () => {
    state.headers.set("authorization", `Bearer ${REJECTED_TOKEN}`);

    expect((await resolveRouteAuth()).status).toBe("invalid");
  });

  it("15. refuses an expired Bearer credential", async () => {
    // Expiry is the Auth server's verdict, which this token does not pass.
    state.headers.set("authorization", "Bearer expired.access.token");

    expect((await resolveRouteAuth()).status).toBe("invalid");
  });

  it("16. refuses a Bearer header carrying no token", async () => {
    for (const header of ["Bearer", "Bearer ", "   "]) {
      state.headers.set("authorization", header);
      expect((await resolveRouteAuth()).status).toBe("invalid");
    }
  });

  it("17. refuses an unsupported authentication scheme", async () => {
    for (const header of ["Basic dXNlcjpwYXNz", "Token abc", "Digest xyz"]) {
      state.headers.set("authorization", header);
      expect((await resolveRouteAuth()).status).toBe("invalid");
    }
  });

  it("18. an explicitly invalid Bearer never falls back to a valid cookie", async () => {
    state.headers.set("authorization", `Bearer ${REJECTED_TOKEN}`);
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const auth = await resolveRouteAuth();

    // Had the cookie been consulted, this would have authenticated.
    expect(auth.status).toBe("invalid");
  });

  it("19. a valid Bearer wins and the cookie is ignored, not compared", async () => {
    state.users.set("other.user.token", { id: "other-user-id", email: "other@example.com" });
    state.headers.set("authorization", "Bearer other.user.token");
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const auth = await resolveRouteAuth();

    assertAuthenticated(auth);
    // An unrelated browser cookie belonging to someone else is not an error.
    expect(auth.userId).toBe("other-user-id");
    expect(auth.source).toBe("bearer");
  });

  it("20. a Bearer caller needs no browser cookie at all", async () => {
    state.headers.set("authorization", `Bearer ${VALID_TOKEN}`);
    expect(state.cookies.size).toBe(0);

    expect((await resolveRouteAuth()).status).toBe("authenticated");
  });

  it("21. refuses an ambiguous comma-joined Authorization value", async () => {
    state.headers.set("authorization", `Bearer ${VALID_TOKEN}, Bearer ${REJECTED_TOKEN}`);
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    expect((await resolveRouteAuth()).status).toBe("invalid");
  });

  it("falls through to the cookie path when no Authorization header is sent", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const auth = await resolveRouteAuth();

    assertAuthenticated(auth);
    expect(auth.source).toBe("cookie");
  });
});

// ─── Caller-scoped client ─────────────────────────────────────────────────────

describe("caller-scoped client", () => {
  it("22. builds the client with the same verified access token", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const auth = await resolveVerifiedAuth();
    assertAuthenticated(auth);

    // The verification client carries no Authorization header — the token is
    // passed as an argument — and the caller-scoped client carries exactly it.
    expect(state.created[0].authorization).toBeNull();
    const scoped = state.created[state.created.length - 1];
    expect(scoped.authorization).toBe(`Bearer ${VALID_TOKEN}`);
    expect(auth.accessToken).toBe(VALID_TOKEN);
  });

  it("23. never introduces a service-role credential or a refresh token", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const auth = await resolveVerifiedAuth();
    assertAuthenticated(auth);

    for (const created of state.created) {
      expect(created.key).toBe(TEST_ANON_KEY);
      expect(created.url).toBe(TEST_URL);
    }
    expect(Object.keys(auth)).not.toContain("refreshToken");
    expect(Object.keys(auth)).not.toContain("refresh_token");
    expect(JSON.stringify(Object.keys(auth))).not.toMatch(/service/i);

    const source = readSource("utils/supabase/server.ts");
    expect(source).not.toContain("SERVICE_ROLE");
    expect(source).not.toContain("createAdminClient");
  });
});

// ─── Environment neutrality ───────────────────────────────────────────────────

describe("environment-derived storage key", () => {
  it("24. derives the cookie name from a non-production Supabase URL", () => {
    expect(authStorageKey()).toBe("sb-teststagingref-auth-token");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://vyusdgvongfdzoteqyxz.supabase.co";
    expect(authStorageKey()).toBe("sb-vyusdgvongfdzoteqyxz-auth-token");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    expect(authStorageKey()).toBe("sb-127-auth-token");
  });

  it("25. hard-codes no project ref in the shared resolver or the drills client", () => {
    expect(readSource("utils/supabase/server.ts")).not.toContain("atlmnqispyzhsahahpjy");
    expect(readSource("app/(dashboard)/drills/page.tsx")).not.toContain("atlmnqispyzhsahahpjy");
    expect(readSource("app/(dashboard)/drills/page.tsx")).toContain(
      "NEXT_PUBLIC_SUPABASE_URL",
    );
  });
});

// ─── Stripe checkout trust closure ────────────────────────────────────────────

describe("stripe checkout identity", () => {
  const CHECKOUT = "app/api/stripe/checkout/route.ts";

  it("26. uses verified identity for the customer record", () => {
    const source = readSource(CHECKOUT);
    expect(source).toContain("resolveVerifiedAuth");
    expect(source).toContain("metadata: { supabase_user_id: auth.userId }");
    expect(source).toContain("email: auth.email ?? undefined");
  });

  it("27. no parsed cookie user field can reach Stripe customer creation", () => {
    const source = readSource(CHECKOUT);
    expect(source).not.toContain("session.user.email");
    expect(source).not.toContain("session.user.id");
    expect(source).not.toContain("getServerSession");
  });

  it("28. stops before checkout when the customer link cannot be persisted", () => {
    const source = readSource(CHECKOUT);
    expect(source).toContain("error: linkError");
    expect(source).toContain("error: profileError");

    const linkGuard = source.indexOf("account-link-failed");
    const profileGuard = source.indexOf("account-unavailable");
    const checkout = source.indexOf("stripe.checkout.sessions.create");
    expect(linkGuard).toBeGreaterThan(-1);
    expect(profileGuard).toBeGreaterThan(-1);
    expect(linkGuard).toBeLessThan(checkout);
    expect(profileGuard).toBeLessThan(checkout);
  });

  it("remains a cookie-only web commerce surface", () => {
    const source = readSource(CHECKOUT);
    expect(source).not.toContain("resolveRouteAuth");
    expect(source).toContain('trial_period_days: 7');
    expect(source).toContain("${SITE_URL}/dashboard?upgraded=true");
    expect(source).toContain("${SITE_URL}/upgrade");
  });
});

// ─── Credential logging ───────────────────────────────────────────────────────

describe("credential logging", () => {
  it("29. the login page logs no cookie or auth-storage diagnostic", () => {
    const source = readSource("app/(auth)/login/page.tsx");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("Object.keys(localStorage)");
    expect(source).not.toContain("Cookies after server action");
  });

  it("30. the login server action logs no access-token diagnostic", () => {
    const source = readSource("app/(auth)/login/actions.ts");
    expect(source).not.toContain("access_token.length");
    expect(source).not.toContain("console.log");
  });
});

// ─── Web compatibility ────────────────────────────────────────────────────────

describe("existing web behaviour", () => {
  it("31. an ordinary unchunked web session still authenticates", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const session = await getServerSession();

    expect(session).not.toBeNull();
    expect(session?.user.id).toBe("verified-user-id");
  });

  it("32. a chunked web session still authenticates", async () => {
    const raw = envelope(VALID_TOKEN);
    const half = Math.ceil(raw.length / 2);
    state.cookies.set(`${KEY}.0`, raw.slice(0, half));
    state.cookies.set(`${KEY}.1`, raw.slice(half));

    const session = await getServerSession();

    expect(session?.user.id).toBe("verified-user-id");
  });

  it("33. preserves the consumer-compatible success shape and nothing more", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));

    const session = await getServerSession();

    expect(session).toEqual({
      access_token: VALID_TOKEN,
      user: { id: "verified-user-id", email: "verified@example.com" },
    });
    expect(Object.keys(session ?? {}).sort()).toEqual(["access_token", "user"]);
    expect(Object.keys(session?.user ?? {}).sort()).toEqual(["email", "id"]);
  });

  it("returns null — not a throw — for absent and rejected credentials", async () => {
    expect(await getServerSession()).toBeNull();

    state.cookies.set(KEY, envelope(REJECTED_TOKEN));
    expect(await getServerSession()).toBeNull();
  });

  it("keeps createClient usable before authentication exists", async () => {
    // Signup and the PKCE callback build a client with no session at all.
    await createClient();
    expect(state.created[0].authorization).toBeNull();
    expect(state.created[0].key).toBe(TEST_ANON_KEY);

    state.created.length = 0;
    state.cookies.set(KEY, envelope(VALID_TOKEN));
    await createClient();
    expect(state.created[0].authorization).toBe(`Bearer ${VALID_TOKEN}`);
  });
});

// ─── Failure classification ───────────────────────────────────────────────────

describe("verification failure classification", () => {
  it("34. distinguishes an Auth outage from an invalid credential", async () => {
    state.cookies.set(KEY, envelope(VALID_TOKEN));
    state.networkFailure = true;

    expect((await resolveVerifiedAuth()).status).toBe("verification_unavailable");

    state.throwOnVerify = true;
    expect((await resolveVerifiedAuth()).status).toBe("verification_unavailable");

    // And the same condition is never silently rendered as "signed out".
    await expect(getServerSession()).rejects.toBeInstanceOf(
      AuthVerificationUnavailableError,
    );

    state.networkFailure = false;
    state.throwOnVerify = false;
    state.cookies.set(KEY, envelope(REJECTED_TOKEN));
    expect((await resolveVerifiedAuth()).status).toBe("invalid");
    expect(await getServerSession()).toBeNull();
  });

  it("classifies an outage on the Bearer path the same way", async () => {
    state.headers.set("authorization", `Bearer ${VALID_TOKEN}`);
    state.networkFailure = true;

    expect((await resolveRouteAuth()).status).toBe("verification_unavailable");
  });
});
