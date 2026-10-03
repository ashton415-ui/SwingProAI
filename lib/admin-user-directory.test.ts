import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// ADMIN-OPS-0 — secure admin user directory
// ============================================================================
//
// The verified-auth resolver, the service-role client factory and Next's
// redirect are mocked; everything else is the real code. No network call is
// made and no live Supabase data is touched. Structural guarantees ("this page
// no longer queries users itself", "no client component imports the service
// role helper") are asserted against source text, as the existing auth suites
// in this repository do.

const state = vi.hoisted(() => ({
  auth: { status: "absent" } as Record<string, unknown>,
  roleResult: { data: null, error: null } as { data: unknown; error: unknown },
  roleThrows: false,
  roleLookups: [] as { table: string; column: string; value: unknown }[],
  adminConstructed: 0,
  adminThrows: false,
  adminClient: null as unknown,
}));

// `server-only` throws outside a Next.js server context; Vitest is not one.
vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock("@/utils/supabase/server", () => ({
  resolveVerifiedAuth: async () => state.auth,
}));

vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminConstructed++;
    if (state.adminThrows) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return state.adminClient;
  },
}));

import {
  AdminAuthorityUnavailableError,
  isAdminCaller,
  requireAdminForPage,
  resolveAdminAuthority,
  type AdminCaller,
} from "@/lib/admin/admin-authority";
import {
  AUTH_PAGE_SIZE,
  MAX_PAGES,
  PROFILE_PAGE_SIZE,
  getAdminDirectoryCounts,
  getAdminUserDirectoryPage,
  loadAdminUserDirectory,
} from "@/lib/admin/user-directory";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  PROFILE_COLUMNS,
  deriveAuthState,
  extractProviders,
  mergeDirectory,
  pageDirectory,
  parseDirectoryQuery,
  type AdminUserDirectoryEntry,
  type RawAuthUser,
  type RawProfileRow,
} from "@/lib/admin/user-directory-dto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments removed, so prose about a forbidden thing is not mistaken for a use of it. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-03T12:00:00Z");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function callerClient() {
  return {
    from: (table: string) => ({
      select: (column: string) => ({
        eq: (_col: string, value: unknown) => ({
          maybeSingle: async () => {
            state.roleLookups.push({ table, column, value });
            if (state.roleThrows) throw new Error("socket hang up");
            return state.roleResult;
          },
        }),
      }),
    }),
  };
}

function signedIn(role: string | null) {
  state.auth = { status: "authenticated", userId: ADMIN_ID, email: "admin@example.test", accessToken: "t", client: callerClient(), source: "cookie" };
  state.roleResult = { data: role === null ? null : { role }, error: null };
}

async function adminProof(): Promise<AdminCaller> {
  signedIn("admin");
  const authority = await resolveAdminAuthority();
  if (authority.status !== "admin") throw new Error("fixture: expected admin");
  return authority;
}

function authUser(id: string, overrides: Partial<RawAuthUser> & Record<string, unknown> = {}): RawAuthUser {
  return {
    id,
    email: `${id.slice(0, 4)}@example.test`,
    created_at: "2026-09-01T00:00:00Z",
    email_confirmed_at: "2026-09-01T00:05:00Z",
    last_sign_in_at: "2026-09-20T00:00:00Z",
    app_metadata: { provider: "email", providers: ["email"] },
    ...overrides,
  } as RawAuthUser;
}

function profile(id: string, overrides: Partial<RawProfileRow> = {}): RawProfileRow {
  return {
    id,
    email: `${id.slice(0, 4)}@example.test`,
    full_name: `Name ${id.slice(0, 4)}`,
    display_name: null,
    role: "golfer",
    subscription_tier: "none",
    subscription_status: "none",
    coach_profile_status: null,
    created_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

interface FakeAdminOptions {
  authPages?: (page: number, perPage: number) => { users: unknown[]; total?: number } | "error" | "throw";
  profileRows?: RawProfileRow[];
  profileError?: boolean;
  profileCount?: (page: number) => number;
}

function fakeAdmin(opts: FakeAdminOptions) {
  const calls = { listUsers: [] as { page?: number; perPage?: number }[], profileRanges: [] as [number, number][] };
  const rows = opts.profileRows ?? [];
  const client = {
    auth: {
      admin: {
        listUsers: async (params: { page?: number; perPage?: number }) => {
          calls.listUsers.push(params);
          const res = opts.authPages ? opts.authPages(params.page ?? 1, params.perPage ?? 50) : { users: [] };
          if (res === "throw") throw new Error("fetch failed");
          if (res === "error") return { data: { users: [] }, error: { name: "AuthApiError", status: 500, message: "boom" } };
          return { data: { users: res.users, aud: "authenticated", nextPage: null, lastPage: 0, total: res.total ?? 0 }, error: null };
        },
      },
    },
    from: (table: string) => {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      return {
        select: (cols: string, options: { count?: string }) => {
          expect(cols).toBe(PROFILE_COLUMNS);
          expect(options).toEqual({ count: "exact" });
          return {
            order: (col: string, o: { ascending: boolean }) => {
              expect(col).toBe("id");
              expect(o).toEqual({ ascending: true });
              return {
                range: async (from: number, to: number) => {
                  calls.profileRanges.push([from, to]);
                  if (opts.profileError) return { data: null, error: { message: "permission denied" }, count: null };
                  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
                  const page = from / PROFILE_PAGE_SIZE;
                  return {
                    data: sorted.slice(from, to + 1),
                    error: null,
                    count: opts.profileCount ? opts.profileCount(page) : rows.length,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

/** Pages a fixed list of Auth users the way GoTrue does. */
function authFrom(users: unknown[], total: number | undefined = users.length) {
  return (page: number, perPage: number) => ({ users: users.slice((page - 1) * perPage, page * perPage), total });
}

const uid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

beforeEach(() => {
  state.auth = { status: "absent" };
  state.roleResult = { data: null, error: null };
  state.roleThrows = false;
  state.roleLookups = [];
  state.adminConstructed = 0;
  state.adminThrows = false;
  state.adminClient = fakeAdmin({}).client;
});

// ─── Authority ───────────────────────────────────────────────────────────────

describe("admin authority", () => {
  it("an absent credential is unauthenticated, never admin", async () => {
    state.auth = { status: "absent" };
    expect(await resolveAdminAuthority()).toEqual({ status: "unauthenticated" });
  });

  it("an invalid credential is unauthenticated", async () => {
    state.auth = { status: "invalid" };
    expect(await resolveAdminAuthority()).toEqual({ status: "unauthenticated" });
  });

  it("an Auth verification outage fails closed as unavailable", async () => {
    state.auth = { status: "verification_unavailable" };
    expect(await resolveAdminAuthority()).toEqual({ status: "unavailable", reason: "auth" });
  });

  it("an unknown resolver state fails closed", async () => {
    state.auth = { status: "something_new" };
    expect((await resolveAdminAuthority()).status).toBe("unavailable");
  });

  it("a verified non-admin is forbidden", async () => {
    for (const role of ["golfer", "coach", "ADMIN", " admin"]) {
      signedIn(role);
      expect(await resolveAdminAuthority()).toEqual({ status: "forbidden" });
    }
  });

  it("a verified caller with no profile row is forbidden", async () => {
    signedIn(null);
    expect(await resolveAdminAuthority()).toEqual({ status: "forbidden" });
  });

  it("a role read error or throw is unavailable, never forbidden or admin", async () => {
    signedIn("admin");
    state.roleResult = { data: null, error: { message: "timeout" } };
    expect(await resolveAdminAuthority()).toEqual({ status: "unavailable", reason: "profile" });
    state.roleThrows = true;
    expect(await resolveAdminAuthority()).toEqual({ status: "unavailable", reason: "profile" });
  });

  it("a verified admin succeeds with a minted proof", async () => {
    const proof = await adminProof();
    expect(proof).toEqual({ status: "admin", userId: ADMIN_ID });
    expect(isAdminCaller(proof)).toBe(true);
  });

  it("the role comes only from the caller's own public.users row on the caller-scoped client", async () => {
    await adminProof();
    expect(state.roleLookups).toEqual([{ table: "users", column: "role", value: ADMIN_ID }]);
    expect(state.adminConstructed).toBe(0);
    const src = code("lib/admin/admin-authority.ts");
    expect(src).not.toMatch(/app_metadata|user_metadata|createAdminClient|searchParams/);
  });

  it("deciding authority never constructs the privileged client, for any outcome", async () => {
    for (const setup of [
      () => (state.auth = { status: "absent" }),
      () => (state.auth = { status: "invalid" }),
      () => (state.auth = { status: "verification_unavailable" }),
      () => signedIn("golfer"),
      () => signedIn(null),
      () => signedIn("admin"),
    ]) {
      setup();
      await resolveAdminAuthority();
    }
    expect(state.adminConstructed).toBe(0);
  });

  it("requireAdminForPage keeps the existing redirects and throws on an outage", async () => {
    state.auth = { status: "absent" };
    await expect(requireAdminForPage()).rejects.toThrow("REDIRECT:/login");
    signedIn("golfer");
    await expect(requireAdminForPage()).rejects.toThrow("REDIRECT:/dashboard");
    state.auth = { status: "verification_unavailable" };
    await expect(requireAdminForPage()).rejects.toBeInstanceOf(AdminAuthorityUnavailableError);
    const proof = await (async () => { signedIn("admin"); return requireAdminForPage(); })();
    expect(isAdminCaller(proof)).toBe(true);
  });
});

// ─── Directory security ──────────────────────────────────────────────────────

describe("directory security", () => {
  it("refuses a forged proof before constructing the privileged client", async () => {
    const forged = { status: "admin", userId: ADMIN_ID } as AdminCaller;
    await expect(loadAdminUserDirectory(forged)).rejects.toThrow(/verified admin caller/);
    await expect(getAdminDirectoryCounts(forged)).rejects.toThrow();
    expect(state.adminConstructed).toBe(0);
  });

  it("constructs the privileged client only after the admin proof", async () => {
    const proof = await adminProof();
    expect(state.adminConstructed).toBe(0);
    await loadAdminUserDirectory(proof, NOW);
    expect(state.adminConstructed).toBe(1);
  });

  it("a missing service-role configuration is unavailable, not an empty directory", async () => {
    const proof = await adminProof();
    state.adminThrows = true;
    expect(await loadAdminUserDirectory(proof, NOW)).toEqual({ status: "unavailable", reason: "privileged_client_unavailable" });
  });

  it("the profile read never selects Stripe identifiers", () => {
    expect(PROFILE_COLUMNS).not.toMatch(/stripe/);
  });

  it("DTO output is an allow-list: no Stripe, token, password or raw metadata reaches it", () => {
    const raw = authUser(uid(1), {
      encrypted_password: "$2a$hash",
      confirmation_token: "ct",
      recovery_token: "rt",
      email_change_token_new: "et",
      phone_change_token: "pt",
      raw_user_meta_data: { secret: "x" },
      user_metadata: { secret: "x" },
      app_metadata: { providers: ["email", "google"], role: "admin", provider_secret: "s" } as RawAuthUser["app_metadata"],
      identities: [{ identity_data: { sub: "x" } }],
    });
    const row = { ...profile(uid(1)), stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123" } as RawProfileRow;
    const [entry] = mergeDirectory([raw], [row], NOW);

    expect(Object.keys(entry).sort()).toEqual(
      ["auth", "coachProfileStatus", "displayName", "drift", "email", "id", "joinedAt", "role", "subscriptionStatus", "subscriptionTier"].sort(),
    );
    expect(Object.keys(entry.auth).sort()).toEqual(["banned", "emailConfirmed", "isSso", "lastSignInAt", "present", "providers"].sort());
    expect(Object.keys(entry.drift).sort()).toEqual(["authMissing", "emailMismatch", "profileMissing"]);
    const json = JSON.stringify(entry);
    for (const forbidden of ["cus_123", "sub_123", "stripe", "$2a$hash", "token", "password", "secret", "metadata", "identity", "\"ct\"", "\"rt\""]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

// ─── Completeness ────────────────────────────────────────────────────────────

describe("directory completeness", () => {
  it("merges Auth + profile, Auth-only, profile-only and email mismatch", () => {
    const both = uid(1), authOnly = uid(2), profileOnly = uid(3), mismatch = uid(4);
    const entries = mergeDirectory(
      [authUser(both), authUser(authOnly, { created_at: "2026-09-05T00:00:00Z" }), authUser(mismatch, { email: "New@Example.test" })],
      [profile(both), profile(profileOnly), profile(mismatch, { email: "old@example.test" })],
      NOW,
    );
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(entries).toHaveLength(4);

    expect(byId.get(both)!.drift).toEqual({ authMissing: false, profileMissing: false, emailMismatch: false });

    const a = byId.get(authOnly)!;
    expect(a.drift).toEqual({ authMissing: false, profileMissing: true, emailMismatch: false });
    expect(a.role).toBeNull();
    expect(a.joinedAt).toBe("2026-09-05T00:00:00Z");

    const p = byId.get(profileOnly)!;
    expect(p.drift).toEqual({ authMissing: true, profileMissing: false, emailMismatch: false });
    expect(p.auth).toEqual({ present: false });

    const m = byId.get(mismatch)!;
    expect(m.drift.emailMismatch).toBe(true);
    // Deterministic: the Auth email (the one used to sign in) is shown.
    expect(m.email).toBe("New@Example.test");
  });

  it("email comparison ignores case and surrounding whitespace", () => {
    const [e] = mergeDirectory([authUser(uid(1), { email: "Golfer@Example.test" })], [profile(uid(1), { email: " golfer@example.test " })], NOW);
    expect(e.drift.emailMismatch).toBe(false);
  });

  it("returns a complete directory when both sources are exhausted", async () => {
    const proof = await adminProof();
    const ids = Array.from({ length: 13 }, (_, i) => uid(i + 1));
    const { client, calls } = fakeAdmin({ authPages: authFrom(ids.map((id) => authUser(id))), profileRows: ids.map((id) => profile(id)) });
    state.adminClient = client;
    const snapshot = await loadAdminUserDirectory(proof, NOW);
    expect(snapshot.status).toBe("complete");
    if (snapshot.status === "complete") expect(snapshot.entries).toHaveLength(13);
    expect(calls.listUsers).toEqual([{ page: 1, perPage: AUTH_PAGE_SIZE }]);
    expect(calls.profileRanges).toEqual([[0, PROFILE_PAGE_SIZE - 1]]);
  });

  it("follows Auth pages until a short page, across a full first page", async () => {
    const proof = await adminProof();
    const users = Array.from({ length: AUTH_PAGE_SIZE + 5 }, (_, i) => authUser(uid(i + 1)));
    const { client, calls } = fakeAdmin({ authPages: authFrom(users), profileRows: users.map((u) => profile(u.id)) });
    state.adminClient = client;
    const snapshot = await loadAdminUserDirectory(proof, NOW);
    expect(snapshot.status).toBe("complete");
    if (snapshot.status === "complete") expect(snapshot.entries).toHaveLength(AUTH_PAGE_SIZE + 5);
    expect(calls.listUsers.map((c) => c.page)).toEqual([1, 2]);
  });

  it("an Auth-only account is listed with profileMissing", async () => {
    const proof = await adminProof();
    const { client } = fakeAdmin({ authPages: authFrom([authUser(uid(1)), authUser(uid(2))]), profileRows: [profile(uid(1))] });
    state.adminClient = client;
    const snapshot = await loadAdminUserDirectory(proof, NOW);
    expect(snapshot.status).toBe("complete");
    if (snapshot.status === "complete") {
      expect(snapshot.entries.find((e) => e.id === uid(2))!.drift.profileMissing).toBe(true);
    }
  });

  const failures: [string, FakeAdminOptions, { status: string; reason: string }][] = [
    ["Auth listing error", { authPages: () => "error" }, { status: "unavailable", reason: "auth_list_failed" }],
    ["Auth listing throw", { authPages: () => "throw" }, { status: "unavailable", reason: "auth_list_failed" }],
    ["Auth malformed page", { authPages: () => ({ users: [{ email: "no-id" }] }) }, { status: "unavailable", reason: "auth_list_malformed" }],
    ["Auth total disagrees with what was read", { authPages: authFrom([authUser(uid(1))], 2) }, { status: "incomplete", reason: "auth_total_mismatch" }],
    [
      "Auth pages overlap (duplicate id)",
      { authPages: (page) => ({ users: page === 1 ? Array.from({ length: AUTH_PAGE_SIZE }, (_, i) => authUser(uid(i + 1))) : [authUser(uid(1))] }) },
      { status: "incomplete", reason: "auth_pagination_inconsistent" },
    ],
    [
      "Auth safety cap reached",
      { authPages: (page) => ({ users: Array.from({ length: AUTH_PAGE_SIZE }, (_, i) => authUser(uid(page * AUTH_PAGE_SIZE + i))) }) },
      { status: "incomplete", reason: "auth_safety_cap_reached" },
    ],
    ["profile read error", { authPages: authFrom([authUser(uid(1))]), profileError: true }, { status: "unavailable", reason: "profile_read_failed" }],
    [
      "profile count disagrees with rows read",
      { authPages: authFrom([authUser(uid(1))]), profileRows: [profile(uid(1))], profileCount: () => 2 },
      { status: "incomplete", reason: "profile_total_mismatch" },
    ],
  ];

  for (const [label, opts, expected] of failures) {
    it(`${label} is never presented as a complete directory`, async () => {
      const proof = await adminProof();
      state.adminClient = fakeAdmin(opts).client;
      expect(await loadAdminUserDirectory(proof, NOW)).toEqual(expected);
      // The page and counts surface the same failure instead of a subset or zero.
      const page = await getAdminUserDirectoryPage(proof, parseDirectoryQuery({}));
      expect(page).toEqual(expected);
      const counts = await getAdminDirectoryCounts(proof);
      expect(counts).toEqual(expected);
    });
  }

  // Profile enumeration: the source's own consistency checks, exercised
  // through the real paging loop (the Auth side completes in one short page).
  const profileIds = (n: number, start = 1) => Array.from({ length: n }, (_, i) => uid(start + i));

  it("a profile ID seen twice across pages is incomplete, not complete", async () => {
    const proof = await adminProof();
    // Sorted by id, the duplicated last id lands at index 999 (page 1) and 1000 (page 2).
    const ids = profileIds(PROFILE_PAGE_SIZE);
    const rows = ids.map((id) => profile(id)).concat(profile(ids[ids.length - 1]));
    const { client, calls } = fakeAdmin({ authPages: authFrom([authUser(uid(1))]), profileRows: rows });
    state.adminClient = client;
    expect(await loadAdminUserDirectory(proof, NOW)).toEqual({ status: "incomplete", reason: "profile_pagination_inconsistent" });
    expect(calls.profileRanges).toEqual([[0, PROFILE_PAGE_SIZE - 1], [PROFILE_PAGE_SIZE, 2 * PROFILE_PAGE_SIZE - 1]]);
  });

  it("an exact profile count that changes between pages is incomplete", async () => {
    const proof = await adminProof();
    const rows = profileIds(PROFILE_PAGE_SIZE + 1).map((id) => profile(id));
    const { client, calls } = fakeAdmin({
      authPages: authFrom([authUser(uid(1))]),
      profileRows: rows,
      profileCount: (page) => (page === 0 ? rows.length : rows.length + 1),
    });
    state.adminClient = client;
    expect(await loadAdminUserDirectory(proof, NOW)).toEqual({ status: "incomplete", reason: "profile_pagination_inconsistent" });
    expect(calls.profileRanges).toHaveLength(2);
  });

  it("the profile safety cap fails closed after MAX_PAGES full pages", async () => {
    const proof = await adminProof();
    // Exactly MAX_PAGES full pages: no short page ever arrives, so exhaustion is never proven.
    const rows = profileIds(MAX_PAGES * PROFILE_PAGE_SIZE).map((id) => profile(id));
    const { client, calls } = fakeAdmin({ authPages: authFrom([authUser(uid(1))]), profileRows: rows });
    state.adminClient = client;
    expect(await loadAdminUserDirectory(proof, NOW)).toEqual({ status: "incomplete", reason: "profile_safety_cap_reached" });
    expect(calls.profileRanges).toHaveLength(MAX_PAGES);
  });

  it("a malformed profile row makes the directory unavailable instead of entering it", async () => {
    const proof = await adminProof();
    const malformed = { ...profile(uid(9)), id: 42 } as unknown as RawProfileRow;
    const { client } = fakeAdmin({ authPages: authFrom([authUser(uid(1))]), profileRows: [profile(uid(1)), malformed] });
    state.adminClient = client;
    expect(await loadAdminUserDirectory(proof, NOW)).toEqual({ status: "unavailable", reason: "profile_read_malformed" });
    expect(await getAdminDirectoryCounts(proof)).toEqual({ status: "unavailable", reason: "profile_read_malformed" });
  });

  it("the safety cap is bounded at MAX_PAGES requests", async () => {
    const proof = await adminProof();
    const { client, calls } = fakeAdmin({
      authPages: (page) => ({ users: Array.from({ length: AUTH_PAGE_SIZE }, (_, i) => authUser(uid(page * AUTH_PAGE_SIZE + i))) }),
    });
    state.adminClient = client;
    await loadAdminUserDirectory(proof, NOW);
    expect(calls.listUsers).toHaveLength(MAX_PAGES);
  });

  it("counts are exact totals from the complete directory", async () => {
    const proof = await adminProof();
    const rows = [profile(uid(1)), profile(uid(2), { role: "coach" }), profile(uid(3), { role: "coach" }), profile(uid(4), { role: "admin" })];
    state.adminClient = fakeAdmin({ authPages: authFrom(rows.map((r) => authUser(r.id)).concat(authUser(uid(5)))), profileRows: rows }).client;
    expect(await getAdminDirectoryCounts(proof)).toEqual({ status: "ok", totalUsers: 5, coaches: 2 });
  });
});

// ─── Pagination ──────────────────────────────────────────────────────────────

function entries(n: number): AdminUserDirectoryEntry[] {
  const auth = Array.from({ length: n }, (_, i) => authUser(uid(i + 1)));
  const rows = auth.map((u, i) => profile(u.id, { created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
  return mergeDirectory(auth, rows, NOW);
}

describe("pagination", () => {
  it("orders by joined time descending, then id descending", () => {
    const same = "2026-09-01T00:00:00Z";
    const list = mergeDirectory(
      [authUser(uid(1)), authUser(uid(2)), authUser(uid(3))],
      [profile(uid(1), { created_at: same }), profile(uid(2), { created_at: same }), profile(uid(3), { created_at: "2026-09-02T00:00:00Z" })],
      NOW,
    );
    expect(list.map((e) => e.id)).toEqual([uid(3), uid(2), uid(1)]);
  });

  it("defaults to page 1 and 25 per page", () => {
    const q = parseDirectoryQuery({});
    expect(q).toMatchObject({ page: 1, pageSize: DEFAULT_PAGE_SIZE, search: null, role: null, subscriptionStatus: null, subscriptionTier: null, ignored: [] });
    expect(DEFAULT_PAGE_SIZE).toBe(25);
  });

  it("caps pageSize at 100 and rejects malformed numbers deterministically", () => {
    expect(parseDirectoryQuery({ pageSize: "500" }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(parseDirectoryQuery({ pageSize: "0" })).toMatchObject({ pageSize: 25, ignored: ["pageSize"] });
    expect(parseDirectoryQuery({ page: "-1" })).toMatchObject({ page: 1, ignored: ["page"] });
    expect(parseDirectoryQuery({ page: "2.5" })).toMatchObject({ page: 1, ignored: ["page"] });
    expect(parseDirectoryQuery({ page: ["2", "3"] })).toMatchObject({ page: 1, ignored: ["page"] });
  });

  it("reports an exact total and hasMore", () => {
    const all = entries(30);
    const first = pageDirectory(all, new Map(), parseDirectoryQuery({}));
    expect(first).toMatchObject({ page: 1, total: 30, directoryTotal: 30, lastPage: 2, hasMore: true });
    expect(first.entries).toHaveLength(25);
    const second = pageDirectory(all, new Map(), parseDirectoryQuery({ page: "2" }));
    expect(second).toMatchObject({ page: 2, hasMore: false });
    expect(second.entries).toHaveLength(5);
    expect(second.entries[0].id).toBe(all[25].id);
  });

  it("clamps a page past the end to the last page", () => {
    expect(pageDirectory(entries(3), new Map(), parseDirectoryQuery({ page: "9" }))).toMatchObject({ page: 1, lastPage: 1, total: 3 });
  });
});

// ─── Search ──────────────────────────────────────────────────────────────────

describe("search", () => {
  const rows = [
    profile(uid(1), { full_name: "Rory Mac", email: "rory@example.test" }),
    profile(uid(2), { full_name: "Tiger", display_name: "TW", email: "tiger@example.test" }),
    profile(uid(3), { full_name: "100% Golfer_x", email: "pct@example.test" }),
  ];
  const all = mergeDirectory(rows.map((r) => authUser(r.id, { email: r.email })), rows, NOW);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = (q: Record<string, string>) => pageDirectory(all, byId, parseDirectoryQuery(q)).entries.map((e) => e.id);

  it("is trimmed and case-insensitive across email, display name and full name", () => {
    expect(ids({ q: "  RORY  " })).toEqual([uid(1)]);
    expect(ids({ q: "tw" })).toEqual([uid(2)]);
    expect(ids({ q: "TIGER@EXAMPLE" })).toEqual([uid(2)]);
    expect(parseDirectoryQuery({ q: "   " }).search).toBeNull();
  });

  it("is bounded in length", () => {
    expect(parseDirectoryQuery({ q: "x".repeat(500) }).search).toHaveLength(MAX_SEARCH_LENGTH);
  });

  it("treats wildcard characters literally", () => {
    expect(ids({ q: "%" })).toEqual([uid(3)]);
    expect(ids({ q: "_" })).toEqual([uid(3)]);
    expect(ids({ q: "r_ry" })).toEqual([]);
  });

  it("treats a backslash literally: kept, not syntax, matched only where present", () => {
    const bsRows = [
      profile(uid(1), { full_name: "Plain Name", email: "plain@example.test" }),
      profile(uid(2), { full_name: "Back\\Slash", email: "bs@example.test" }),
    ];
    const bsAll = mergeDirectory(bsRows.map((r) => authUser(r.id, { email: r.email })), bsRows, NOW);
    const bsById = new Map(bsRows.map((r) => [r.id, r]));
    const find = (q: string) => pageDirectory(bsAll, bsById, parseDirectoryQuery({ q })).entries.map((e) => e.id);

    // Not discarded by parsing.
    expect(parseDirectoryQuery({ q: "  \\  " }).search).toBe("\\");
    // A lone backslash matches only the value that contains one.
    expect(find("\\")).toEqual([uid(2)]);
    // Case-insensitive literal substring across the backslash.
    expect(find("K\\s")).toEqual([uid(2)]);
    // Not an escape: "\\%" and "\\_" are literal sequences no value contains.
    expect(find("\\%")).toEqual([]);
    expect(find("\\_")).toEqual([]);
    // Two backslashes are two characters, not one escaped backslash.
    expect(find("\\\\")).toEqual([]);
  });
});

// ─── Filters ─────────────────────────────────────────────────────────────────

describe("filters", () => {
  const rows = [
    profile(uid(1), { role: "coach", subscription_tier: "coach_pro", subscription_status: "active" }),
    profile(uid(2), { role: "golfer", subscription_tier: "birdie", subscription_status: "past_due" }),
    profile(uid(3), { role: "admin" }),
  ];
  const all = mergeDirectory(rows.map((r) => authUser(r.id)), rows, NOW);
  const ids = (q: Record<string, string | string[]>) => pageDirectory(all, new Map(), parseDirectoryQuery(q)).entries.map((e) => e.id);

  it("filters by canonical role, subscription status and tier", () => {
    expect(ids({ role: "coach" })).toEqual([uid(1)]);
    expect(ids({ status: "past_due" })).toEqual([uid(2)]);
    expect(ids({ tier: "birdie" })).toEqual([uid(2)]);
    expect(ids({ role: "coach", status: "active", tier: "coach_pro" })).toEqual([uid(1)]);
  });

  it("ignores unknown or repeated filter values deterministically and records them", () => {
    const q = parseDirectoryQuery({ role: "superuser", status: "ACTIVE", tier: "platinum' or 1=1", page: "1" });
    expect(q).toMatchObject({ role: null, subscriptionStatus: null, subscriptionTier: null });
    expect(q.ignored.sort()).toEqual(["role", "status", "tier"]);
    expect(ids({ role: "superuser" })).toHaveLength(3);
    expect(parseDirectoryQuery({ role: ["coach", "admin"] })).toMatchObject({ role: null, ignored: ["role"] });
    expect(parseDirectoryQuery({ role: "" })).toMatchObject({ role: null, ignored: [] });
  });
});

// ─── Status derivation ───────────────────────────────────────────────────────

describe("status derivation", () => {
  it("confirmed and unconfirmed come from email_confirmed_at", () => {
    expect(deriveAuthState(authUser(uid(1)), NOW)).toMatchObject({ emailConfirmed: true });
    expect(deriveAuthState(authUser(uid(1), { email_confirmed_at: null }), NOW)).toMatchObject({ emailConfirmed: false });
  });

  it("banned only while banned_until is in the future", () => {
    expect(deriveAuthState(authUser(uid(1), { banned_until: "2099-01-01T00:00:00Z" }), NOW)).toMatchObject({ banned: true });
    expect(deriveAuthState(authUser(uid(1), { banned_until: "2020-01-01T00:00:00Z" }), NOW)).toMatchObject({ banned: false });
    expect(deriveAuthState(authUser(uid(1), { banned_until: "none" }), NOW)).toMatchObject({ banned: false });
  });

  it("never signed in is a null last sign-in, labelled as sign-in, not activity", () => {
    expect(deriveAuthState(authUser(uid(1), { last_sign_in_at: null }), NOW)).toMatchObject({ lastSignInAt: null });
    expect(deriveAuthState(authUser(uid(1)), NOW)).toMatchObject({ lastSignInAt: "2026-09-20T00:00:00Z" });
  });

  it("SSO and providers are extracted without the rest of app_metadata", () => {
    expect(deriveAuthState(authUser(uid(1), { is_sso_user: true }), NOW)).toMatchObject({ isSso: true });
    expect(extractProviders({ providers: ["google", "email", "Google", 42, "bad provider!", "x".repeat(60)], role: "admin" })).toEqual(["email", "google"]);
    expect(extractProviders(null)).toEqual([]);
    expect(extractProviders({ providers: "email" })).toEqual([]);
  });

  it("invents no onboarding or last-activity state", () => {
    const [entry] = mergeDirectory([authUser(uid(1))], [profile(uid(1))], NOW);
    const json = JSON.stringify(entry).toLowerCase();
    expect(json).not.toMatch(/onboard|lastactive|last_active|activity/);
  });
});

// ─── Page / contract static checks ───────────────────────────────────────────

describe("page and boundary contracts", () => {
  const usersPage = code("app/(dashboard)/admin/users/page.tsx");
  const adminPage = code("app/(dashboard)/admin/page.tsx");
  const coachesPage = code("app/(dashboard)/admin/coaches/page.tsx");

  it("all three admin pages authorize through requireAdminForPage", () => {
    for (const src of [usersPage, adminPage, coachesPage]) {
      expect(src).toContain('from "@/lib/admin/admin-authority"');
      expect(src).toMatch(/await requireAdminForPage\(\)/);
      expect(src).not.toContain("getServerSession");
    }
  });

  it("no admin page queries public.users itself any more", () => {
    for (const src of [usersPage, adminPage, coachesPage]) {
      expect(src).not.toMatch(/\.from\(\s*["']users["']\s*\)/);
      expect(src).not.toContain("@/utils/supabase/admin");
      expect(src).not.toContain("createAdminClient");
    }
  });

  it("the users and coaches pages read through the directory service", () => {
    expect(usersPage).toMatch(/getAdminUserDirectoryPage\(caller, query\)/);
    expect(coachesPage).toMatch(/getAdminUserDirectoryPage\(caller,/);
    expect(coachesPage).toMatch(/role: "coach"/);
  });

  it("the command center counts Total Users and Coaches from the directory service", () => {
    expect(adminPage).toMatch(/getAdminDirectoryCounts\(caller\)/);
    expect(adminPage).toMatch(/directory\.totalUsers/);
    expect(adminPage).toMatch(/directory\.coaches/);
    // A failure renders as "—" with a note, never as 0.
    expect(adminPage).toMatch(/directory\.status === "ok" \? directory\.totalUsers : "—"/);
    expect(adminPage).toMatch(/directory\.status === "ok" \? directory\.coaches : "—"/);
  });

  it("pages render an explicit unavailable / incomplete state", () => {
    expect(usersPage).toContain("User directory unavailable");
    expect(usersPage).toContain("User directory incomplete");
    expect(coachesPage).toContain("Coach directory unavailable");
  });

  it("admin pages are dynamic and uncached", () => {
    for (const src of [usersPage, adminPage, coachesPage]) {
      expect(src).toContain('export const dynamic = "force-dynamic"');
      expect(src).toContain("export const revalidate = 0");
    }
  });

  it("both privileged admin modules enforce the server-only boundary", () => {
    for (const rel of ["lib/admin/admin-authority.ts", "lib/admin/user-directory.ts"]) {
      const src = code(rel);
      expect(src, `${rel} must import "server-only"`).toMatch(/^import ["']server-only["'];?\s*$/m);
      // It must be the module's first import, ahead of anything privileged.
      expect(src.trimStart().startsWith('import "server-only"'), `${rel}: "server-only" must be the first import`).toBe(true);
      expect(read(rel)).not.toMatch(/by convention|does not depend on the\s+`?server-only/);
    }
  });

  it("within lib/admin only the directory service touches the service-role helper", () => {
    expect(code("lib/admin/user-directory.ts")).toContain('from "@/utils/supabase/admin"');
    expect(code("lib/admin/admin-authority.ts")).not.toContain("@/utils/supabase/admin");
    expect(code("lib/admin/user-directory-dto.ts")).not.toMatch(/@\/utils\/supabase|createAdminClient|createClient/);
  });

  it("no client component imports the service-role helper or the admin modules", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(t|j)sx?$/.test(name)) {
          const text = readFileSync(full, "utf8");
          if (/^\s*["']use client["']/m.test(text) && /@\/utils\/supabase\/admin|@\/lib\/admin\/|SUPABASE_SERVICE_ROLE_KEY/.test(text)) {
            offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    for (const dir of ["app", "components", "lib", "hooks", "utils"]) walk(path.join(ROOT, dir));
    expect(offenders).toEqual([]);
  });

  it("the directory service performs no writes or Auth admin mutations", () => {
    const src = code("lib/admin/user-directory.ts");
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(src).not.toMatch(/admin\.(createUser|updateUserById|deleteUser|inviteUserByEmail|generateLink|signOut)/);
  });
});
