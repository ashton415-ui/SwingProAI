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
  type AnalysisMode,
  type SubscriptionTier,
} from "@/lib/entitlements";

/**
 * SwingProAI — `/api/v1/me` data transfer object.
 *
 * The public shape is written out here in full rather than derived from
 * `types/database.ts`'s `User`. That type is a raw row: it carries
 * `stripe_customer_id`, `stripe_subscription_id` and `coach_profile_status`,
 * and re-using it would mean a column added to the table tomorrow becomes a
 * published API field today, silently. The duplication below is the point —
 * the exposed surface only changes when someone edits this file.
 *
 * Every entitlement answer is delegated to `lib/entitlements`. No tier list is
 * repeated here; a capability with no helper behind it is not published at all.
 */

/** Roles the API reports. Informational — this field authorizes nothing. */
export type MeRole = "golfer" | "coach" | "admin";

/** Billing states the API reports. */
export type MeSubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "none";

const ROLES: readonly MeRole[] = ["golfer", "coach", "admin"];
const TIERS: readonly SubscriptionTier[] = [
  "par",
  "birdie",
  "eagle",
  "coach_starter",
  "coach_pro",
  "none",
];
const STATUSES: readonly MeSubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "none",
];

/** Canonical site origin used when the deployment supplies none. */
export const CANONICAL_SITE_URL = "https://www.swingpro-ai.com";

/** The verified caller. Both fields come from Supabase Auth, never from a row. */
export interface VerifiedCallerIdentity {
  readonly userId: string;
  readonly email: string | null;
}

/**
 * The selected `public.users` columns, every one of them `unknown`.
 *
 * PostgREST output is JSON decided by the database, not by TypeScript: a
 * `numeric` column can arrive as a string, and a column can be absent from the
 * projection entirely. Typing the input honestly as `unknown` forces each field
 * through a guard below, which is what makes the published types true at
 * runtime instead of merely asserted.
 */
export interface MeProfileRow {
  readonly full_name?: unknown;
  readonly display_name?: unknown;
  readonly avatar_url?: unknown;
  readonly handicap_index?: unknown;
  readonly typical_shot_shape?: unknown;
  readonly prominent_miss?: unknown;
  readonly average_driver_carry?: unknown;
  readonly role?: unknown;
  readonly subscription_tier?: unknown;
  readonly subscription_status?: unknown;
  readonly created_at?: unknown;
}

export interface MeUserDto {
  readonly id: string;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly handicapIndex: number | null;
  readonly typicalShotShape: string | null;
  readonly prominentMiss: string | null;
  readonly averageDriverCarry: number | null;
  readonly role: MeRole;
  readonly createdAt: string | null;
}

/**
 * Capabilities, one per entitlement helper.
 *
 * There is no `analysisFullSwing` member. No helper gates full-swing analysis,
 * so publishing the field would mean inventing a rule at the API boundary and
 * calling it an entitlement.
 */
export interface MeCapabilitiesDto {
  readonly puttingAnalysis: boolean;
  readonly puttingRecommendations: boolean;
  readonly ultraDeepAnalysis: boolean;
  readonly frameComparison: boolean;
  readonly launchMonitor: boolean;
}

export interface MeLimitsDto {
  /** Saved swing analyses, or `null` for unlimited. */
  readonly savedSwings: number | null;
}

export interface MeEntitlementDto {
  readonly tier: SubscriptionTier;
  readonly tierDisplayName: string;
  readonly status: MeSubscriptionStatus;
  readonly analysisMode: AnalysisMode;
  readonly capabilities: MeCapabilitiesDto;
  readonly limits: MeLimitsDto;
  readonly upsellTier: SubscriptionTier | null;
  readonly upgradeUrl: string;
}

export interface MeServerDto {
  readonly time: string;
  readonly apiVersion: "v1";
}

export interface MeResponseDto {
  readonly user: MeUserDto;
  readonly entitlement: MeEntitlementDto;
  readonly server: MeServerDto;
}

/** Passes strings through untouched; everything else becomes null. An empty
 *  string is preserved rather than folded into null — the column's value is the
 *  column's value, and editorialising it here would hide it from the client. */
function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The numeric contract: a JSON number or null, never a string.
 *
 * `handicap_index` is a Postgres `numeric`, which PostgREST may serialise as a
 * string to preserve precision, so a string that denotes a finite number is
 * normalised. Anything else — a non-numeric string, a boolean, an object,
 * NaN, Infinity, null, a missing key — becomes null rather than being coerced,
 * because a golfer with no recorded handicap is not a golfer with a handicap
 * of zero.
 */
function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalises an enumerated column against a positive allow-list.
 *
 * The column is typed in TypeScript but originates in the database, so an
 * unrecognised value can genuinely arrive here. Each caller supplies the
 * least-privileged fallback for its own vocabulary, so an unknown value can
 * only ever narrow what the client is told, never widen it.
 */
function toEnumOrFallback<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** ISO-8601 in UTC, or null when the column holds nothing a date can be read
 *  from. Normalising here means clients get one timestamp shape regardless of
 *  how PostgREST spelled the offset. */
function toIsoStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Where a client should send a golfer who wants a higher tier.
 *
 * Derived from configuration rather than hard-coded so that local, preview and
 * production each point at themselves, with the production host as the
 * fallback. The trailing slash is trimmed so a base URL written either way
 * cannot produce `//upgrade`.
 */
export function resolveUpgradeUrl(
  siteUrl: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  const configured = typeof siteUrl === "string" ? siteUrl.trim() : "";
  const base = configured.length > 0 ? configured : CANONICAL_SITE_URL;
  return `${base.replace(/\/+$/, "")}/upgrade`;
}

/**
 * Builds the `/me` payload from a verified caller and their own profile row.
 *
 * `id` and `email` are taken from the caller, not the row. The row's `email` is
 * a copy seeded by the `handle_new_user` trigger and is nullable; if the two
 * ever diverge, the verified one is the true one, and having a single rule here
 * means the response can never report an address Supabase Auth would not
 * recognise.
 */
export function toMeResponse(
  caller: VerifiedCallerIdentity,
  profile: MeProfileRow,
  now: Date = new Date(),
): MeResponseDto {
  const tier = toEnumOrFallback(profile.subscription_tier, TIERS, "none");

  return {
    user: {
      id: caller.userId,
      email: caller.email,
      fullName: toNullableString(profile.full_name),
      displayName: toNullableString(profile.display_name),
      avatarUrl: toNullableString(profile.avatar_url),
      handicapIndex: toFiniteNumberOrNull(profile.handicap_index),
      typicalShotShape: toNullableString(profile.typical_shot_shape),
      prominentMiss: toNullableString(profile.prominent_miss),
      averageDriverCarry: toFiniteNumberOrNull(profile.average_driver_carry),
      // Role is reported from its own column and is never inferred from tier: a
      // coach on no plan is still a coach, and an admin is not a purchase.
      role: toEnumOrFallback(profile.role, ROLES, "golfer"),
      createdAt: toIsoStringOrNull(profile.created_at),
    },
    entitlement: {
      // Reported verbatim. Collapsing coach_starter/coach_pro into the golfer
      // tiers would destroy the distinction before any client could act on it.
      tier,
      tierDisplayName: getTierDisplayName(tier),
      status: toEnumOrFallback(profile.subscription_status, STATUSES, "none"),
      analysisMode: getAnalysisModeForTier(tier),
      capabilities: {
        puttingAnalysis: canUsePuttingAnalysis(tier),
        puttingRecommendations: canUsePuttingRecommendations(tier),
        ultraDeepAnalysis: canUseUltraDeepAnalysis(tier),
        frameComparison: canUseFrameComparison(tier),
        launchMonitor: canUseLaunchMonitor(tier),
      },
      limits: {
        savedSwings: getSwingLimitForTier(tier),
      },
      upsellTier: getUpsellTier(tier),
      upgradeUrl: resolveUpgradeUrl(),
    },
    server: {
      time: now.toISOString(),
      apiVersion: "v1",
    },
  };
}
