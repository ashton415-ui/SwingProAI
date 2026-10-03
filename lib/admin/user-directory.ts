import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { isAdminCaller, type AdminCaller } from "@/lib/admin/admin-authority";
import {
  PROFILE_COLUMNS,
  mergeDirectory,
  pageDirectory,
  type AdminUserDirectoryEntry,
  type DirectoryPage,
  type DirectoryQuery,
  type RawAuthUser,
  type RawProfileRow,
} from "@/lib/admin/user-directory-dto";

/**
 * SwingProAI — admin user directory service (ADMIN-OPS-0).
 *
 * Server-only, enforced: the `server-only` import above makes Next.js fail the
 * build if this module is ever pulled into a client bundle. This is the one
 * place the admin pages reach the
 * service-role client, and it does so only for a caller that already holds an
 * AdminCaller proof minted by resolveAdminAuthority(). It reads; it never
 * writes, and it never calls an Auth admin mutation.
 *
 * Completeness is the contract. The page is called "All Users", so the
 * service either proves it has every Auth account and every public.users
 * profile, or it says it does not. A subset is never returned as a directory.
 *
 * Proof of completeness:
 *
 *   Auth      pages of AUTH_PAGE_SIZE are read from page 1 until a short page
 *             arrives. A short page is the only end-of-list signal trusted:
 *             auth-js derives nextPage/total from the Link header by reading
 *             only the first digit of the page number, and leaves both unset
 *             when no Link header is sent. When a total is reported it must
 *             equal what was read. Duplicates mean the pages shifted.
 *   Profiles  pages of PROFILE_PAGE_SIZE ordered by id, with an exact count
 *             that must not change between pages and must equal what was read.
 *
 * Either source hitting MAX_PAGES is a safety cap: the result is
 * "incomplete", never a truncated list.
 */

export const AUTH_PAGE_SIZE = 1000;
export const PROFILE_PAGE_SIZE = 1000;
/** Safety cap per source: MAX_PAGES × page size accounts (10,000). */
export const MAX_PAGES = 10;

export type DirectoryFailureReason =
  | "privileged_client_unavailable"
  | "auth_list_failed"
  | "auth_list_malformed"
  | "auth_pagination_inconsistent"
  | "auth_total_mismatch"
  | "auth_safety_cap_reached"
  | "profile_read_failed"
  | "profile_read_malformed"
  | "profile_pagination_inconsistent"
  | "profile_total_mismatch"
  | "profile_safety_cap_reached"
  | "unexpected";

export type DirectoryFailure =
  | { readonly status: "incomplete"; readonly reason: DirectoryFailureReason }
  | { readonly status: "unavailable"; readonly reason: DirectoryFailureReason };

export type DirectorySnapshot =
  | {
      readonly status: "complete";
      readonly entries: AdminUserDirectoryEntry[];
      readonly profilesById: ReadonlyMap<string, RawProfileRow>;
    }
  | DirectoryFailure;

const incomplete = (reason: DirectoryFailureReason): DirectoryFailure => ({ status: "incomplete", reason });
const unavailable = (reason: DirectoryFailureReason): DirectoryFailure => ({ status: "unavailable", reason });

type AdminClient = ReturnType<typeof createAdminClient>;

async function readAllAuthUsers(admin: AdminClient): Promise<{ ok: true; users: RawAuthUser[] } | DirectoryFailure> {
  const users: RawAuthUser[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    let result: Awaited<ReturnType<AdminClient["auth"]["admin"]["listUsers"]>>;
    try {
      result = await admin.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    } catch {
      return unavailable("auth_list_failed");
    }
    if (result.error) return unavailable("auth_list_failed");

    const batch: unknown = result.data?.users;
    if (!Array.isArray(batch)) return unavailable("auth_list_malformed");
    if (batch.length > AUTH_PAGE_SIZE) return incomplete("auth_pagination_inconsistent");

    for (const user of batch) {
      if (typeof user !== "object" || user === null || typeof (user as { id?: unknown }).id !== "string") {
        return unavailable("auth_list_malformed");
      }
      const id = (user as RawAuthUser).id;
      if (seen.has(id)) return incomplete("auth_pagination_inconsistent");
      seen.add(id);
      users.push(user as RawAuthUser);
    }

    if (batch.length < AUTH_PAGE_SIZE) {
      const total = (result.data as { total?: unknown }).total;
      if (typeof total === "number" && Number.isFinite(total) && total > 0 && total !== users.length) {
        return incomplete("auth_total_mismatch");
      }
      return { ok: true, users };
    }
  }

  return incomplete("auth_safety_cap_reached");
}

async function readAllProfiles(admin: AdminClient): Promise<{ ok: true; profiles: RawProfileRow[] } | DirectoryFailure> {
  const profiles: RawProfileRow[] = [];
  const seen = new Set<string>();
  let expected: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PROFILE_PAGE_SIZE;
    let result: { data: unknown; error: unknown; count: number | null };
    try {
      result = await admin
        .from("users")
        .select(PROFILE_COLUMNS, { count: "exact" })
        .order("id", { ascending: true })
        .range(from, from + PROFILE_PAGE_SIZE - 1);
    } catch {
      return unavailable("profile_read_failed");
    }
    if (result.error) return unavailable("profile_read_failed");
    if (!Array.isArray(result.data) || typeof result.count !== "number") return unavailable("profile_read_malformed");
    if (expected === null) expected = result.count;
    else if (result.count !== expected) return incomplete("profile_pagination_inconsistent");
    if (result.data.length > PROFILE_PAGE_SIZE) return incomplete("profile_pagination_inconsistent");

    for (const row of result.data) {
      if (typeof row !== "object" || row === null || typeof (row as { id?: unknown }).id !== "string") {
        return unavailable("profile_read_malformed");
      }
      const id = (row as RawProfileRow).id;
      if (seen.has(id)) return incomplete("profile_pagination_inconsistent");
      seen.add(id);
      profiles.push(row as RawProfileRow);
    }

    if (result.data.length < PROFILE_PAGE_SIZE) {
      return profiles.length === expected ? { ok: true, profiles } : incomplete("profile_total_mismatch");
    }
  }

  return incomplete("profile_safety_cap_reached");
}

/**
 * The complete directory, or an explicit failure. Throws only when called
 * without an admin proof — and does so before the service-role client exists.
 */
export async function loadAdminUserDirectory(caller: AdminCaller, now: Date = new Date()): Promise<DirectorySnapshot> {
  if (!isAdminCaller(caller)) {
    throw new Error("The admin user directory requires a verified admin caller.");
  }

  let admin: AdminClient;
  try {
    admin = createAdminClient();
  } catch {
    return unavailable("privileged_client_unavailable");
  }

  try {
    const auth = await readAllAuthUsers(admin);
    if (!("ok" in auth)) return auth;
    const profiles = await readAllProfiles(admin);
    if (!("ok" in profiles)) return profiles;

    return {
      status: "complete",
      entries: mergeDirectory(auth.users, profiles.profiles, now),
      profilesById: new Map(profiles.profiles.map((p) => [p.id, p])),
    };
  } catch {
    return unavailable("unexpected");
  }
}

export type DirectoryPageResult = { readonly status: "ok"; readonly page: DirectoryPage } | DirectoryFailure;

/** One page of the complete directory for the given query. */
export async function getAdminUserDirectoryPage(caller: AdminCaller, query: DirectoryQuery): Promise<DirectoryPageResult> {
  const snapshot = await loadAdminUserDirectory(caller);
  if (snapshot.status !== "complete") return snapshot;
  return { status: "ok", page: pageDirectory(snapshot.entries, snapshot.profilesById, query) };
}

export type DirectoryCountsResult =
  | { readonly status: "ok"; readonly totalUsers: number; readonly coaches: number }
  | DirectoryFailure;

/** Exact Total Users and Coaches counts for the command center. */
export async function getAdminDirectoryCounts(caller: AdminCaller): Promise<DirectoryCountsResult> {
  const snapshot = await loadAdminUserDirectory(caller);
  if (snapshot.status !== "complete") return snapshot;
  return {
    status: "ok",
    totalUsers: snapshot.entries.length,
    coaches: snapshot.entries.filter((e) => e.role === "coach").length,
  };
}
