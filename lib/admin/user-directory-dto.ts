/**
 * SwingProAI — admin user directory DTO (ADMIN-OPS-0).
 *
 * Pure: no client, no request context, no clock unless one is passed in. The
 * directory service feeds raw Auth users and public.users rows in; this module
 * decides what an administrator is allowed to see and how it is ordered,
 * searched, filtered and paged.
 *
 * Output is an allow-list. Stripe identifiers, tokens, password material and
 * raw user/app metadata are never copied into a DTO, so they cannot reach the
 * page however the page renders it.
 */

// ─── Canonical vocabularies (public.users CHECK constraints) ─────────────────

export const DIRECTORY_ROLES = ["golfer", "coach", "admin"] as const;
export const DIRECTORY_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "canceled", "none"] as const;
export const DIRECTORY_SUBSCRIPTION_TIERS = ["par", "birdie", "eagle", "coach_starter", "coach_pro", "none"] as const;

export type DirectoryRole = (typeof DIRECTORY_ROLES)[number];
export type DirectorySubscriptionStatus = (typeof DIRECTORY_SUBSCRIPTION_STATUSES)[number];
export type DirectorySubscriptionTier = (typeof DIRECTORY_SUBSCRIPTION_TIERS)[number];

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_SEARCH_LENGTH = 100;

// ─── Raw inputs ──────────────────────────────────────────────────────────────

/** The public.users columns the service reads. Stripe columns are not among them. */
export const PROFILE_COLUMNS =
  "id, email, full_name, display_name, role, subscription_tier, subscription_status, coach_profile_status, created_at";

export interface RawProfileRow {
  id: string;
  email: string | null;
  full_name: string | null;
  display_name: string | null;
  role: string | null;
  subscription_tier: string | null;
  subscription_status: string | null;
  coach_profile_status: string | null;
  created_at: string | null;
}

/** The Auth user fields this module reads. Anything else on the object is ignored. */
export interface RawAuthUser {
  id: string;
  email?: string | null;
  created_at?: string | null;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
  is_sso_user?: boolean | null;
  app_metadata?: { providers?: unknown } | null;
}

// ─── Output DTO ──────────────────────────────────────────────────────────────

export type AdminDirectoryAuthState =
  | {
      present: true;
      emailConfirmed: boolean;
      /** Auth last sign-in. Not in-app activity. */
      lastSignInAt: string | null;
      banned: boolean;
      providers: string[];
      isSso: boolean;
    }
  | { present: false };

export interface AdminUserDirectoryEntry {
  id: string;
  /** Auth email when an Auth account exists, otherwise the profile email. */
  email: string | null;
  displayName: string | null;
  /** Null when there is no public.users profile. */
  role: DirectoryRole | null;
  subscriptionTier: DirectorySubscriptionTier | null;
  subscriptionStatus: DirectorySubscriptionStatus | null;
  coachProfileStatus: string | null;
  /** Profile created_at; the Auth created_at only when no profile exists. */
  joinedAt: string | null;
  auth: AdminDirectoryAuthState;
  drift: {
    /** A profile exists with no Auth account. */
    authMissing: boolean;
    /** An Auth account exists with no public.users profile. */
    profileMissing: boolean;
    /** Both emails exist and differ (case-insensitive). */
    emailMismatch: boolean;
  };
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

function canonical<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

const PROVIDER_PATTERN = /^[a-z0-9_.-]{1,40}$/i;

/** The provider names only — never the rest of app_metadata. */
export function extractProviders(appMetadata: unknown): string[] {
  if (typeof appMetadata !== "object" || appMetadata === null) return [];
  const providers = (appMetadata as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  const names = providers
    .filter((p): p is string => typeof p === "string" && PROVIDER_PATTERN.test(p))
    .map((p) => p.toLowerCase());
  return Array.from(new Set(names)).sort();
}

export function deriveAuthState(user: RawAuthUser, now: Date): AdminDirectoryAuthState {
  const bannedUntil = timestamp(user.banned_until);
  return {
    present: true,
    emailConfirmed: timestamp(user.email_confirmed_at) !== null,
    lastSignInAt: timestamp(user.last_sign_in_at),
    banned: bannedUntil !== null && Date.parse(bannedUntil) > now.getTime(),
    providers: extractProviders(user.app_metadata),
    isSso: user.is_sso_user === true,
  };
}

function sameEmail(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** One entry from whichever of the two records exist for an id. */
export function toDirectoryEntry(
  authUser: RawAuthUser | null,
  profile: RawProfileRow | null,
  now: Date,
): AdminUserDirectoryEntry {
  const id = (profile?.id ?? authUser?.id) as string;
  const authEmail = nonEmpty(authUser?.email);
  const profileEmail = nonEmpty(profile?.email);

  return {
    id,
    email: authEmail ?? profileEmail,
    displayName: profile ? nonEmpty(profile.display_name) ?? nonEmpty(profile.full_name) : null,
    role: profile ? canonical(profile.role, DIRECTORY_ROLES) : null,
    subscriptionTier: profile ? canonical(profile.subscription_tier, DIRECTORY_SUBSCRIPTION_TIERS) : null,
    subscriptionStatus: profile ? canonical(profile.subscription_status, DIRECTORY_SUBSCRIPTION_STATUSES) : null,
    coachProfileStatus: profile ? nonEmpty(profile.coach_profile_status) : null,
    joinedAt: timestamp(profile?.created_at) ?? timestamp(authUser?.created_at),
    auth: authUser ? deriveAuthState(authUser, now) : { present: false },
    drift: {
      authMissing: authUser === null,
      profileMissing: profile === null,
      emailMismatch: authUser !== null && profile !== null && !sameEmail(authEmail, profileEmail),
    },
  };
}

/** joinedAt descending, then id descending. Entries without a time sort last. */
export function compareEntries(a: AdminUserDirectoryEntry, b: AdminUserDirectoryEntry): number {
  const ta = a.joinedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(a.joinedAt);
  const tb = b.joinedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(b.joinedAt);
  if (ta !== tb) return tb > ta ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Merges the two complete populations by id. The caller guarantees both lists
 * are complete; this function only joins and orders them.
 */
export function mergeDirectory(
  authUsers: readonly RawAuthUser[],
  profiles: readonly RawProfileRow[],
  now: Date,
): AdminUserDirectoryEntry[] {
  const authById = new Map(authUsers.map((u) => [u.id, u]));
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const ids = new Set<string>(Array.from(authById.keys()).concat(Array.from(profileById.keys())));
  return Array.from(ids, (id) => toDirectoryEntry(authById.get(id) ?? null, profileById.get(id) ?? null, now)).sort(
    compareEntries,
  );
}

// ─── Query ───────────────────────────────────────────────────────────────────

export interface DirectoryQuery {
  page: number;
  pageSize: number;
  search: string | null;
  role: DirectoryRole | null;
  subscriptionStatus: DirectorySubscriptionStatus | null;
  subscriptionTier: DirectorySubscriptionTier | null;
  /** Parameters that were present but not valid, and were therefore ignored. */
  ignored: string[];
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

function single(params: RawSearchParams, key: string, ignored: string[]): string | null {
  const value = params[key];
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    ignored.push(key);
    return null;
  }
  return value;
}

function positiveInt(raw: string | null): number | null {
  if (raw === null || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

/**
 * URL query → directory query. Never throws: an invalid value is ignored (and
 * recorded in `ignored`), so the page always renders a deterministic result.
 * Empty values ("") mean "not set" and are not recorded as ignored.
 */
export function parseDirectoryQuery(params: RawSearchParams): DirectoryQuery {
  const ignored: string[] = [];

  const pageRaw = single(params, "page", ignored);
  const page = positiveInt(pageRaw);
  if (pageRaw !== null && pageRaw !== "" && page === null) ignored.push("page");

  const sizeRaw = single(params, "pageSize", ignored);
  const size = positiveInt(sizeRaw);
  if (sizeRaw !== null && sizeRaw !== "" && size === null) ignored.push("pageSize");

  const filter = <T extends string>(key: string, allowed: readonly T[]): T | null => {
    const raw = single(params, key, ignored);
    if (raw === null || raw === "") return null;
    const value = canonical(raw, allowed);
    if (value === null) ignored.push(key);
    return value;
  };

  const searchRaw = single(params, "q", ignored);
  const search = searchRaw === null ? null : Array.from(searchRaw.trim()).slice(0, MAX_SEARCH_LENGTH).join("").trim();

  return {
    page: page ?? 1,
    pageSize: Math.min(size ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    search: search ? search : null,
    role: filter("role", DIRECTORY_ROLES),
    subscriptionStatus: filter("status", DIRECTORY_SUBSCRIPTION_STATUSES),
    subscriptionTier: filter("tier", DIRECTORY_SUBSCRIPTION_TIERS),
    ignored,
  };
}

/**
 * Literal, case-insensitive substring match on email, display name and full
 * name. The search text is never interpreted: "%" and "_" match themselves.
 */
export function matchesSearch(entry: AdminUserDirectoryEntry, profile: RawProfileRow | null, search: string): boolean {
  const needle = search.toLowerCase();
  const fields = [entry.email, entry.displayName, profile?.full_name ?? null, profile?.display_name ?? null, profile?.email ?? null];
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(needle));
}

export interface DirectoryPage {
  entries: AdminUserDirectoryEntry[];
  page: number;
  pageSize: number;
  lastPage: number;
  /** Exact number of users matching the query. */
  total: number;
  /** Exact number of users in the whole directory. */
  directoryTotal: number;
  hasMore: boolean;
}

/**
 * Filters, searches and pages a complete, already-ordered directory. A page
 * past the end is clamped to the last page.
 */
export function pageDirectory(
  entries: readonly AdminUserDirectoryEntry[],
  profilesById: ReadonlyMap<string, RawProfileRow>,
  query: DirectoryQuery,
): DirectoryPage {
  const matching = entries.filter(
    (e) =>
      (query.role === null || e.role === query.role) &&
      (query.subscriptionStatus === null || e.subscriptionStatus === query.subscriptionStatus) &&
      (query.subscriptionTier === null || e.subscriptionTier === query.subscriptionTier) &&
      (query.search === null || matchesSearch(e, profilesById.get(e.id) ?? null, query.search)),
  );
  const total = matching.length;
  const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, lastPage);
  const start = (page - 1) * query.pageSize;
  return {
    entries: matching.slice(start, start + query.pageSize),
    page,
    pageSize: query.pageSize,
    lastPage,
    total,
    directoryTotal: entries.length,
    hasMore: page < lastPage,
  };
}
