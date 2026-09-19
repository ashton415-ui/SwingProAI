import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUEST_ID_PATTERN,
  V1_CACHE_CONTROL,
  resolveRequestId,
  v1AuthErrorResponse,
  v1Error,
  v1Success,
} from "@/lib/api/v1-response";
import {
  CANONICAL_SITE_URL,
  resolveUpgradeUrl,
  toMeResponse,
  type MeProfileRow,
} from "@/lib/api/me-dto";
import {
  canUseFrameComparison,
  canUseLaunchMonitor,
  canUsePuttingAnalysis,
  canUsePuttingRecommendations,
  canUseUltraDeepAnalysis,
  getAnalysisModeForTier,
  getSwingLimitForTier,
  getTierDisplayName,
  getUpsellTier,
  type SubscriptionTier,
} from "@/lib/entitlements";
import type { VerifiedAuth } from "@/utils/supabase/server";

/**
 * NATIVE API FOUNDATION — contract coverage.
 *
 * Two kinds of assertion live here, and the difference matters:
 *
 *   RUNTIME — `lib/api/v1-response.ts` and `lib/api/me-dto.ts` are pure and are
 *   executed for real. Envelope shape, headers, status codes, request-ID
 *   bounds, numeric normalisation and sensitive-field exclusion are therefore
 *   proven, not asserted about source text.
 *
 *   SOURCE-CONTRACT — `app/api/v1/me/route.ts` is a Next route handler, and
 *   this repository has never executed one under Vitest. Rather than invent a
 *   route-handler harness inside a foundation slice, the route's safety
 *   properties are pinned structurally. A passing run here means the route
 *   still reads its own caller's row through the caller-scoped client; it is
 *   not a live proof that RLS rejected somebody else's id.
 *
 * Resolver behaviour itself — cookie/Bearer precedence, the absence of any
 * fallback, token verification — is proven by `lib/verified-auth-resolver.test.ts`
 * and is deliberately not restated here.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function sha256Of(relativePath: string): string {
  return createHash("sha256").update(readFileSync(path.join(repoRoot, relativePath))).digest("hex");
}

const ME_ROUTE = "app/api/v1/me/route.ts";
const routeSource = readSource(ME_ROUTE);

/** Columns that must never appear in the `/me` projection or its output. */
const SENSITIVE_COLUMNS = [
  "stripe_customer_id",
  "stripe_subscription_id",
  "coach_invite_code",
  "coach_profile_status",
] as const;

const ALL_TIERS: readonly SubscriptionTier[] = [
  "par",
  "birdie",
  "eagle",
  "coach_starter",
  "coach_pro",
  "none",
];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function headersWith(value: string | null): { get(name: string): string | null } {
  return { get: (name) => (name.toLowerCase() === "x-request-id" ? value : null) };
}

function authState(status: "absent" | "invalid" | "verification_unavailable"): VerifiedAuth {
  return { status } as VerifiedAuth;
}

/** An authenticated state whose client is never dereferenced by the code under
 *  test — `v1AuthErrorResponse` only reads `status`. */
function authenticatedState(): VerifiedAuth {
  return {
    status: "authenticated",
    userId: "11111111-2222-4333-8444-555555555555",
    email: "golfer@example.com",
    accessToken: "not-a-real-token",
    client: {},
    source: "cookie",
  } as unknown as VerifiedAuth;
}

const CALLER = { userId: "11111111-2222-4333-8444-555555555555", email: "verified@example.com" };

function profileRow(overrides: Record<string, unknown> = {}): MeProfileRow {
  return {
    full_name: "Sam Golfer",
    display_name: "Sam",
    avatar_url: "https://cdn.example.com/a.png",
    handicap_index: 12.4,
    typical_shot_shape: "draw",
    prominent_miss: "hook",
    average_driver_carry: 255,
    role: "golfer",
    subscription_tier: "birdie",
    subscription_status: "active",
    created_at: "2026-06-02T00:22:28.278Z",
    ...overrides,
  } as MeProfileRow;
}

// ─── A. Request identifiers ───────────────────────────────────────────────────

describe("V1 request identifiers", () => {
  it("1. reuses a well-formed incoming request ID", () => {
    const incoming = "client-abc_123.ID";
    expect(REQUEST_ID_PATTERN.test(incoming)).toBe(true);
    expect(resolveRequestId(headersWith(incoming))).toBe(incoming);
  });

  it("2. rejects an incoming ID shorter than eight characters", () => {
    const tooShort = "abc1234";
    expect(tooShort).toHaveLength(7);
    const resolved = resolveRequestId(headersWith(tooShort));
    expect(resolved).not.toBe(tooShort);
    expect(resolved).toMatch(UUID_V4);
  });

  it("3. rejects an incoming ID containing characters outside the allowed set", () => {
    for (const illegal of ["has space", "semi;colon", "new\nline", "sla/sh", "quote\"mark"]) {
      const resolved = resolveRequestId(headersWith(illegal));
      expect(resolved).not.toBe(illegal);
      expect(resolved).toMatch(UUID_V4);
    }
  });

  it("4. rejects an incoming ID longer than 128 characters", () => {
    const tooLong = "a".repeat(129);
    const resolved = resolveRequestId(headersWith(tooLong));
    expect(resolved).not.toBe(tooLong);
    expect(resolved).toMatch(UUID_V4);
  });

  it("5. generates a UUID when no usable ID was supplied", () => {
    const first = resolveRequestId(headersWith(null));
    const second = resolveRequestId(headersWith(null));
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it("5b. accepts exactly the boundary lengths", () => {
    expect(resolveRequestId(headersWith("a".repeat(8)))).toBe("a".repeat(8));
    expect(resolveRequestId(headersWith("a".repeat(128)))).toBe("a".repeat(128));
  });
});

// ─── B. Success / error envelopes ─────────────────────────────────────────────

describe("V1 response envelopes", () => {
  it("6. wraps success payloads in exactly { data }", async () => {
    const response = v1Success({ hello: "world" }, "req-00000001");
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["data"]);
    expect(body.data).toEqual({ hello: "world" });
    expect(response.status).toBe(200);
  });

  it("7. gives errors exactly code, message and requestId", async () => {
    const response = v1Error("INTERNAL_ERROR", "The request could not be completed.", "req-00000002", 500);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "requestId"]);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.requestId).toBe("req-00000002");
    expect(typeof body.error.message).toBe("string");
  });

  it("8. echoes the request ID in the X-Request-Id header on success and error", () => {
    expect(v1Success({}, "req-00000003").headers.get("X-Request-Id")).toBe("req-00000003");
    expect(v1Error("AUTH_REQUIRED", "m", "req-00000004", 401).headers.get("X-Request-Id")).toBe(
      "req-00000004",
    );
  });

  it("9. marks every response private and uncacheable", () => {
    expect(V1_CACHE_CONTROL).toBe("private, no-store");
    expect(v1Success({}, "req-00000005").headers.get("Cache-Control")).toBe("private, no-store");
    expect(v1Error("AUTH_INVALID", "m", "req-00000006", 401).headers.get("Cache-Control")).toBe(
      "private, no-store",
    );
  });

  it("10. preserves the HTTP status it was given", () => {
    expect(v1Error("AUTH_REQUIRED", "m", "req-00000007", 401).status).toBe(401);
    expect(v1Error("SERVER_TEMPORARILY_UNAVAILABLE", "m", "req-00000008", 503).status).toBe(503);
    expect(v1Success({}, "req-00000009", { status: 201 }).status).toBe(201);
  });

  it("10b. sends JSON content type", () => {
    expect(v1Success({}, "req-00000010").headers.get("Content-Type")).toBe("application/json");
  });
});

// ─── C. Auth-state mapping ────────────────────────────────────────────────────

describe("V1 auth-state mapping", () => {
  it("11. maps absent to 401 AUTH_REQUIRED", async () => {
    const response = v1AuthErrorResponse(authState("absent"), "req-00000011");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect((await response!.json()).error.code).toBe("AUTH_REQUIRED");
  });

  it("12. maps invalid to 401 AUTH_INVALID", async () => {
    const response = v1AuthErrorResponse(authState("invalid"), "req-00000012");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    expect((await response!.json()).error.code).toBe("AUTH_INVALID");
  });

  it("13. maps verification_unavailable to 503, never to a logout", async () => {
    const response = v1AuthErrorResponse(authState("verification_unavailable"), "req-00000013");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect((await response!.json()).error.code).toBe("SERVER_TEMPORARILY_UNAVAILABLE");
  });

  it("14. returns no error for an authenticated caller", () => {
    expect(v1AuthErrorResponse(authenticatedState(), "req-00000014")).toBeNull();
  });

  it("14b. never leaks credential or infrastructure detail in an auth error body", async () => {
    for (const status of ["absent", "invalid", "verification_unavailable"] as const) {
      const body = await v1AuthErrorResponse(authState(status), "req-00000015")!.json();
      const text = JSON.stringify(body).toLowerCase();
      for (const forbidden of ["token", "cookie", "jwt", "supabase", "claim", "stack"]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });
});

// ─── D. /me DTO ───────────────────────────────────────────────────────────────

describe("/me DTO mapping", () => {
  it("15. reports the verified caller's email, not the profile row's", () => {
    const dto = toMeResponse(CALLER, profileRow({ email: "stale-row@example.com" }));
    expect(dto.user.email).toBe("verified@example.com");
    expect(JSON.stringify(dto)).not.toContain("stale-row@example.com");
  });

  it("15b. carries a null verified email through as null", () => {
    const dto = toMeResponse({ userId: CALLER.userId, email: null }, profileRow());
    expect(dto.user.email).toBeNull();
  });

  it("15c. takes the user id from verified identity", () => {
    const dto = toMeResponse(CALLER, profileRow());
    expect(dto.user.id).toBe(CALLER.userId);
  });

  it("16. maps every safe profile column to its camelCase field", () => {
    const dto = toMeResponse(CALLER, profileRow());
    expect(dto.user).toEqual({
      id: CALLER.userId,
      email: "verified@example.com",
      fullName: "Sam Golfer",
      displayName: "Sam",
      avatarUrl: "https://cdn.example.com/a.png",
      handicapIndex: 12.4,
      typicalShotShape: "draw",
      prominentMiss: "hook",
      averageDriverCarry: 255,
      role: "golfer",
      createdAt: "2026-06-02T00:22:28.278Z",
    });
  });

  it("17. preserves nulls rather than coercing them to empty or zero", () => {
    const dto = toMeResponse(
      CALLER,
      profileRow({
        full_name: null,
        display_name: null,
        avatar_url: null,
        handicap_index: null,
        typical_shot_shape: null,
        prominent_miss: null,
        average_driver_carry: null,
      }),
    );
    expect(dto.user.fullName).toBeNull();
    expect(dto.user.displayName).toBeNull();
    expect(dto.user.avatarUrl).toBeNull();
    expect(dto.user.handicapIndex).toBeNull();
    expect(dto.user.typicalShotShape).toBeNull();
    expect(dto.user.prominentMiss).toBeNull();
    expect(dto.user.averageDriverCarry).toBeNull();
  });

  it("18. normalises the numeric handicap, including a PostgREST string", () => {
    expect(toMeResponse(CALLER, profileRow({ handicap_index: 8 })).user.handicapIndex).toBe(8);
    expect(toMeResponse(CALLER, profileRow({ handicap_index: "8.40" })).user.handicapIndex).toBe(8.4);
    expect(toMeResponse(CALLER, profileRow({ handicap_index: -2.1 })).user.handicapIndex).toBe(-2.1);
    expect(toMeResponse(CALLER, profileRow({ handicap_index: 0 })).user.handicapIndex).toBe(0);
  });

  it("19. normalises the driver carry the same way", () => {
    expect(toMeResponse(CALLER, profileRow({ average_driver_carry: 240 })).user.averageDriverCarry).toBe(240);
    expect(toMeResponse(CALLER, profileRow({ average_driver_carry: "240" })).user.averageDriverCarry).toBe(240);
  });

  it("20. never lets an unusable numeric value escape as a string", () => {
    for (const bad of ["", "   ", "not-a-number", "12abc", true, false, {}, [], NaN, Infinity, undefined, null]) {
      const dto = toMeResponse(
        CALLER,
        profileRow({ handicap_index: bad, average_driver_carry: bad }),
      );
      expect(dto.user.handicapIndex === null || typeof dto.user.handicapIndex === "number").toBe(true);
      expect(typeof dto.user.handicapIndex).not.toBe("string");
      expect(typeof dto.user.averageDriverCarry).not.toBe("string");
      if (typeof dto.user.handicapIndex === "number") {
        expect(Number.isFinite(dto.user.handicapIndex)).toBe(true);
      }
    }
    expect(toMeResponse(CALLER, profileRow({ handicap_index: "not-a-number" })).user.handicapIndex).toBeNull();
  });

  it("21. keeps role independent of tier", () => {
    const dto = toMeResponse(CALLER, profileRow({ role: "coach", subscription_tier: "none" }));
    expect(dto.user.role).toBe("coach");
    expect(dto.entitlement.tier).toBe("none");
  });

  it("22. leaves coach tiers uncollapsed", () => {
    expect(toMeResponse(CALLER, profileRow({ subscription_tier: "coach_starter" })).entitlement.tier).toBe("coach_starter");
    expect(toMeResponse(CALLER, profileRow({ subscription_tier: "coach_pro" })).entitlement.tier).toBe("coach_pro");
  });

  it("23. leaves the admin role uncollapsed", () => {
    expect(toMeResponse(CALLER, profileRow({ role: "admin" })).user.role).toBe("admin");
  });

  it("23b. falls back to the least-privileged vocabulary member for unknown values", () => {
    const dto = toMeResponse(
      CALLER,
      profileRow({ role: "superuser", subscription_tier: "platinum", subscription_status: "??" }),
    );
    expect(dto.user.role).toBe("golfer");
    expect(dto.entitlement.tier).toBe("none");
    expect(dto.entitlement.status).toBe("none");
  });

  it("24. publishes exactly the five backed capabilities for every tier", () => {
    for (const tier of ALL_TIERS) {
      const dto = toMeResponse(CALLER, profileRow({ subscription_tier: tier }));
      expect(Object.keys(dto.entitlement.capabilities).sort()).toEqual([
        "frameComparison",
        "launchMonitor",
        "puttingAnalysis",
        "puttingRecommendations",
        "ultraDeepAnalysis",
      ]);
      expect(dto.entitlement.capabilities).toEqual({
        puttingAnalysis: canUsePuttingAnalysis(tier),
        puttingRecommendations: canUsePuttingRecommendations(tier),
        ultraDeepAnalysis: canUseUltraDeepAnalysis(tier),
        frameComparison: canUseFrameComparison(tier),
        launchMonitor: canUseLaunchMonitor(tier),
      });
    }
  });

  it("25. does not publish analysisFullSwing, which no helper backs", () => {
    for (const tier of ALL_TIERS) {
      const dto = toMeResponse(CALLER, profileRow({ subscription_tier: tier }));
      expect(Object.keys(dto.entitlement.capabilities)).not.toContain("analysisFullSwing");
      expect(JSON.stringify(dto)).not.toContain("analysisFullSwing");
    }
  });

  it("26. takes the saved-swing limit from the entitlement helper", () => {
    for (const tier of ALL_TIERS) {
      const dto = toMeResponse(CALLER, profileRow({ subscription_tier: tier }));
      expect(dto.entitlement.limits.savedSwings).toBe(getSwingLimitForTier(tier));
    }
    expect(toMeResponse(CALLER, profileRow({ subscription_tier: "eagle" })).entitlement.limits.savedSwings).toBeNull();
    expect(toMeResponse(CALLER, profileRow({ subscription_tier: "par" })).entitlement.limits.savedSwings).toBe(10);
  });

  it("27. takes the display name from the entitlement helper", () => {
    for (const tier of ALL_TIERS) {
      const dto = toMeResponse(CALLER, profileRow({ subscription_tier: tier }));
      expect(dto.entitlement.tierDisplayName).toBe(getTierDisplayName(tier));
    }
  });

  it("28. takes the upsell target from the entitlement helper", () => {
    for (const tier of ALL_TIERS) {
      const dto = toMeResponse(CALLER, profileRow({ subscription_tier: tier }));
      expect(dto.entitlement.upsellTier).toBe(getUpsellTier(tier));
    }
  });

  it("29. takes the analysis mode from the entitlement helper", () => {
    for (const tier of ALL_TIERS) {
      const dto = toMeResponse(CALLER, profileRow({ subscription_tier: tier }));
      expect(dto.entitlement.analysisMode).toBe(getAnalysisModeForTier(tier));
    }
  });

  it("32. states the API version as exactly v1", () => {
    expect(toMeResponse(CALLER, profileRow()).server.apiVersion).toBe("v1");
  });

  it("33. emits a valid ISO-8601 server time", () => {
    const fixed = new Date("2026-09-19T20:00:00.000Z");
    expect(toMeResponse(CALLER, profileRow(), fixed).server.time).toBe("2026-09-19T20:00:00.000Z");
    const live = toMeResponse(CALLER, profileRow()).server.time;
    expect(live).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(new Date(live).getTime())).toBe(false);
  });

  it("33b. normalises createdAt to ISO-8601 and nulls an unusable value", () => {
    expect(toMeResponse(CALLER, profileRow({ created_at: "2026-06-02T00:22:28.278+00:00" })).user.createdAt)
      .toBe("2026-06-02T00:22:28.278Z");
    expect(toMeResponse(CALLER, profileRow({ created_at: "not-a-date" })).user.createdAt).toBeNull();
  });
});

// ─── Upgrade URL ──────────────────────────────────────────────────────────────

describe("/me upgrade URL", () => {
  const original = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = original;
  });

  it("30. falls back to the canonical production origin when none is configured", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(CANONICAL_SITE_URL).toBe("https://www.swingpro-ai.com");
    expect(resolveUpgradeUrl()).toBe("https://www.swingpro-ai.com/upgrade");
    expect(toMeResponse(CALLER, profileRow()).entitlement.upgradeUrl).toBe(
      "https://www.swingpro-ai.com/upgrade",
    );
  });

  it("31. never produces a doubled slash, however the origin is written", () => {
    expect(resolveUpgradeUrl("https://example.test")).toBe("https://example.test/upgrade");
    expect(resolveUpgradeUrl("https://example.test/")).toBe("https://example.test/upgrade");
    expect(resolveUpgradeUrl("https://example.test///")).toBe("https://example.test/upgrade");
    expect(resolveUpgradeUrl("  https://example.test/  ")).toBe("https://example.test/upgrade");
    expect(resolveUpgradeUrl("")).toBe("https://www.swingpro-ai.com/upgrade");
  });

  it("31b. uses the configured origin when one is present", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://staging.example.test/";
    expect(toMeResponse(CALLER, profileRow()).entitlement.upgradeUrl).toBe(
      "https://staging.example.test/upgrade",
    );
  });
});

// ─── E. Sensitive-field exclusion ─────────────────────────────────────────────

describe("/me sensitive-field exclusion", () => {
  /** A row deliberately over-supplied with everything the DTO must refuse to
   *  publish, so the assertion fails if the mapper ever spreads its input. */
  const contaminated = profileRow({
    email: "row@example.com",
    stripe_customer_id: "cus_LEAKED",
    stripe_subscription_id: "sub_LEAKED",
    coach_invite_code: "INVITE_LEAKED",
    coach_profile_status: "pending",
    user_metadata: { provider: "google", sub: "LEAKED" },
    app_metadata: { role: "admin" },
    access_token: "TOKEN_LEAKED",
  });

  it("34-37. omits every billing and coach column", () => {
    const serialized = JSON.stringify(toMeResponse(CALLER, contaminated));
    for (const column of SENSITIVE_COLUMNS) {
      expect(serialized).not.toContain(column);
    }
    expect(serialized).not.toContain("cus_LEAKED");
    expect(serialized).not.toContain("sub_LEAKED");
    expect(serialized).not.toContain("INVITE_LEAKED");
  });

  it("38. omits user_metadata and every other unlisted key", () => {
    const dto = toMeResponse(CALLER, contaminated);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("user_metadata");
    expect(serialized).not.toContain("app_metadata");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("TOKEN_LEAKED");
    expect(Object.keys(dto).sort()).toEqual(["entitlement", "server", "user"]);
    expect(Object.keys(dto.user)).not.toContain("user_metadata");
  });

  it("38b. publishes exactly the agreed user and entitlement keys", () => {
    const dto = toMeResponse(CALLER, contaminated);
    expect(Object.keys(dto.user).sort()).toEqual([
      "avatarUrl",
      "averageDriverCarry",
      "createdAt",
      "displayName",
      "email",
      "fullName",
      "handicapIndex",
      "id",
      "prominentMiss",
      "role",
      "typicalShotShape",
    ]);
    expect(Object.keys(dto.entitlement).sort()).toEqual([
      "analysisMode",
      "capabilities",
      "limits",
      "status",
      "tier",
      "tierDisplayName",
      "upgradeUrl",
      "upsellTier",
    ]);
  });
});

// ─── F. Route source contract ─────────────────────────────────────────────────

describe("/me route source contract", () => {
  it("39. delegates identity to the verified resolver", () => {
    expect(routeSource).toContain("resolveRouteAuth");
    expect(routeSource).toContain('from "@/utils/supabase/server"');
    expect(routeSource).toContain("await resolveRouteAuth()");
  });

  it("39b. does not reimplement token or cookie parsing", () => {
    // Deliberately code-level markers rather than words: the route's own
    // comment explains cookie and Bearer ingress, and a test that forbade the
    // prose would only be teaching future authors not to document the thing.
    for (const forbidden of [
      "cookies()",
      'get("authorization")',
      "getUser(",
      "getSession(",
      "JSON.parse(",
      "decodeURIComponent(",
      "authStorageKey(",
    ]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });

  it("40. never reaches for an elevated client", () => {
    expect(routeSource).not.toContain("createAdminClient");
    expect(routeSource).not.toContain("admin");
  });

  it("41. never references a service key", () => {
    expect(routeSource).not.toContain("SERVICE_ROLE");
    expect(routeSource).not.toContain("service_role");
    expect(routeSource).not.toContain("SERVICE_KEY");
  });

  it("42. never selects every column", () => {
    expect(routeSource).not.toContain('select("*")');
    expect(routeSource).not.toContain("select('*')");
    expect(routeSource).not.toContain("select()");
    expect(routeSource).toContain(".select(PROFILE_COLUMNS)");
  });

  it("43. projects only the agreed columns", () => {
    const projection = routeSource.match(/const PROFILE_COLUMNS\s*=\s*\n?\s*"([^"]+)"/);
    expect(projection).not.toBeNull();
    const columns = projection![1].split(",").map((c) => c.trim());
    expect(columns).toEqual([
      "id",
      "full_name",
      "display_name",
      "avatar_url",
      "handicap_index",
      "typical_shot_shape",
      "prominent_miss",
      "average_driver_carry",
      "role",
      "subscription_tier",
      "subscription_status",
      "created_at",
    ]);
    for (const sensitive of SENSITIVE_COLUMNS) {
      expect(columns).not.toContain(sensitive);
    }
  });

  it("44. constrains the read to the verified caller's own id", () => {
    expect(routeSource).toContain('.eq("id", auth.userId)');
    expect(routeSource).toContain(".maybeSingle()");
    expect(routeSource).toContain("auth.client");
  });

  it("45. reads no request body", () => {
    for (const forbidden of ["req.json()", "request.json()", ".formData(", ".text()", "NextRequest"]) {
      expect(routeSource).not.toContain(forbidden);
    }
    expect(routeSource).toContain("export async function GET()");
  });

  it("46. accepts no caller-supplied identifier", () => {
    for (const forbidden of ["searchParams", "params.", "userId =", "body."]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });

  it("47. answers only through the V1 helpers", () => {
    expect(routeSource).toContain("v1Success(");
    expect(routeSource).toContain("v1Error(");
    expect(routeSource).toContain("v1AuthErrorResponse(");
    expect(routeSource).not.toContain("NextResponse");
    expect(routeSource).not.toContain("new Response(");
  });

  it("48. neither logs nor returns raw database errors", () => {
    expect(routeSource).not.toContain("console.");
    expect(routeSource).not.toMatch(/error\s*\.\s*message/);
    expect(routeSource).not.toMatch(/JSON\.stringify\(\s*error/);
  });

  it("48b. exposes only GET in this slice", () => {
    for (const method of ["export async function POST", "export async function PATCH", "export async function DELETE", "export async function PUT"]) {
      expect(routeSource).not.toContain(method);
    }
  });
});

// ─── G. Frozen dependency integrity ───────────────────────────────────────────

describe("frozen read-only dependencies", () => {
  /**
   * Hashes captured before this slice was written. The foundation is allowed to
   * consume these files and nothing else; if a future change to one of them is
   * what makes this suite pass, that is a scope decision someone must make
   * deliberately rather than discover afterwards.
   */
  const FROZEN: Array<[string, string]> = [
    ["app/api/v1/swing-data/route.ts", "fc6b3a5c6d2834d8c3ac58666e6f00159b29ab4eb0454d8d87e521bcf5daa135"],
    ["utils/supabase/server.ts", "43e341460fa254d92bcd041774c6b085ab99931c9dc4cf631d6959d9c921fe74"],
    ["lib/entitlements.ts", "a0ad96e69b3774b4562efe5f25526a9920dfa5646640db3f3df979565a3b962f"],
    ["types/database.ts", "661d2f072f7e3b0531352350b67b80c3c9432e86dab1c0850d44a349f28f577e"],
  ];

  it.each(FROZEN)("49-52. %s is byte-identical", (relativePath, expected) => {
    expect(sha256Of(relativePath)).toBe(expected);
  });
});
