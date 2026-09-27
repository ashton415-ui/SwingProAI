import type { SubscriptionTier } from "@/lib/entitlements";

/**
 * SwingProAI — V1 analysis-request data transfer objects.
 *
 * Pure validation and response shaping for `POST /api/v1/analyses`. Nothing
 * here builds a Supabase client, reads a request or touches the database — the
 * route owns all of that, and keeping this module inert is what lets every rule
 * below be tested directly.
 *
 * The idea this module enforces: **the caller names a video and, optionally, a
 * club, and nothing else**. The owner, the analysis family, the equipment
 * snapshot, the analysis mode and the status are all decided server-side or by
 * the database, so no field that could carry them is accepted.
 */

/**
 * A canonical UUID of any version.
 *
 * Unlike the upload id, which a client mints and which is therefore held to
 * version 4, both identifiers accepted here were minted by the database. The
 * shape is checked; the version is not, so a legitimate row is never refused
 * over how its default happened to generate it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export interface AnalysisCreateRequest {
  readonly swingVideoId: string;
  readonly clubId: string | null;
}

/** Exactly the keys this endpoint accepts. Both must be present. */
const ALLOWED_REQUEST_KEYS = ["swingVideoId", "clubId"] as const;

/**
 * Parses an untrusted request body, or returns `null`.
 *
 * Unknown keys are refused rather than ignored, which is what keeps `userId`,
 * `status`, `analysisFamily`, `analysisMode`, `score`, `equipmentSnapshot` and
 * every other field a caller might hope to influence out of the request —
 * including ones nobody has thought of yet.
 *
 * `clubId` is required as a key and may be `null`. Requiring the key makes
 * "no club" an explicit statement rather than something inferred from an
 * omission, which a later version could otherwise reinterpret.
 */
export function parseAnalysisCreateRequest(body: unknown): AnalysisCreateRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(ALLOWED_REQUEST_KEYS as readonly string[]).includes(key)) return null;
  }
  for (const key of ALLOWED_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  }

  const { swingVideoId, clubId } = record;
  if (!isUuid(swingVideoId)) return null;
  if (clubId !== null && !isUuid(clubId)) return null;

  return { swingVideoId, clubId };
}

/** The only `swing_videos.status` from which an analysis may be requested. */
export const VIDEO_READY_STATUS = "uploaded";

/** The exact `swing_videos` columns readiness is decided from. */
export const VIDEO_READINESS_COLUMNS = "id, user_id, status, storage_path";

/**
 * Whether a stored object key sits inside the caller's own Storage folder.
 *
 * The first path segment is what the Storage owner-folder policy matches
 * against `auth.uid()`. Requiring it here means a row whose path points
 * anywhere else is refused before Storage is asked, rather than relying on the
 * policy to hide it.
 */
export function isOwnerStoragePath(path: unknown, userId: string): path is string {
  const prefix = `${userId}/`;
  return typeof path === "string" && path.startsWith(prefix) && path.length > prefix.length;
}

/** The exact `user_equipment` columns club validation reads. */
export const CLUB_VALIDATION_COLUMNS = "id, user_id, club_type, is_archived";

/**
 * The club type the database trigger maps to the putting family.
 *
 * Used only to decide, before anything is written, whether the putting
 * entitlement applies. The stored `analysis_family` is still written by the
 * trigger alone.
 */
export const PUTTER_CLUB_TYPE = "Putter";

/**
 * Tiers recognised by the entitlement layer, written out as a positive
 * allow-list. The value arrives from a database column, so an unknown one is
 * refused rather than defaulted — a default here could grant access.
 */
const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = [
  "par",
  "birdie",
  "eagle",
  "coach_starter",
  "coach_pro",
  "none",
];

export function toSubscriptionTier(value: unknown): SubscriptionTier | null {
  return typeof value === "string" && SUBSCRIPTION_TIERS.some((tier) => tier === value)
    ? (value as SubscriptionTier)
    : null;
}

/** The exact `swing_analysis` columns this endpoint reads back and publishes from. */
export const ANALYSIS_REQUEST_COLUMNS =
  "id, swing_video_id, user_id, club_id, status, analysis_family, created_at";

/** Postgres unique-violation code: someone else created the row first. */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * Postgres `raise_exception`. The only BEFORE INSERT trigger on
 * `swing_analysis` raises this when the club is no longer active or owned,
 * which is the archive race the club check above cannot close on its own.
 */
export const PG_RAISE_EXCEPTION = "P0001";

/** Whether a stored analysis was requested for the same club. `null` equals `null`. */
export function isSameClub(storedClubId: unknown, requestedClubId: string | null): boolean {
  return (storedClubId ?? null) === requestedClubId;
}

export type AnalysisFamilyDto = "full_swing" | "putting" | null;

export interface AnalysisRequestDto {
  readonly analysisId: string;
  readonly swingVideoId: string;
  readonly status: string;
  readonly analysisFamily: AnalysisFamilyDto;
  readonly clubId: string | null;
  readonly createdAt: string;
  readonly created: boolean;
}

/** The stored row, every column `unknown` because it arrives as JSON. */
export interface AnalysisRequestRow {
  readonly id?: unknown;
  readonly swing_video_id?: unknown;
  readonly club_id?: unknown;
  readonly status?: unknown;
  readonly analysis_family?: unknown;
  readonly created_at?: unknown;
}

function toIsoStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Builds the published answer from the stored row.
 *
 * `status` and `analysisFamily` are read back from the database rather than
 * assumed: a repeat may find a row that has since started or finished, and the
 * family is the trigger's decision, not this endpoint's.
 *
 * Returns `null` if the row violates the contract, so malformed data fails the
 * request closed instead of being published.
 */
export function toAnalysisRequestDto(
  row: AnalysisRequestRow,
  created: boolean,
): AnalysisRequestDto | null {
  const createdAt = toIsoStringOrNull(row.created_at);
  const family = row.analysis_family ?? null;

  if (
    typeof row.id !== "string" ||
    typeof row.swing_video_id !== "string" ||
    typeof row.status !== "string" ||
    row.status.length === 0 ||
    createdAt === null ||
    !(family === null || family === "full_swing" || family === "putting") ||
    !(row.club_id === null || row.club_id === undefined || typeof row.club_id === "string")
  ) {
    return null;
  }

  return {
    analysisId: row.id,
    swingVideoId: row.swing_video_id,
    status: row.status,
    analysisFamily: family,
    clubId: (row.club_id as string | null | undefined) ?? null,
    createdAt,
    created,
  };
}
