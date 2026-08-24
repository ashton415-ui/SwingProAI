/**
 * SwingProAI — Equipment Consumer Slice 2: shared saved-club query layer
 *
 * The ONE application query implementation for reading a golfer's SAVED
 * equipment (public.user_equipment) as selectable clubs. It is the foundation
 * the later desktop Analyze selector and mobile recording selector both consume.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A read-only, typed, deterministic reader over rows the golfer already owns.
 * It takes an already-constructed Supabase client, so the same implementation
 * serves whichever authenticated caller a later slice decides on; establishing
 * the session is the caller's job, not this module's.
 *
 * WHAT IT SELECTS
 * ---------------
 * An EXISTING public.user_equipment row — the value that eventually becomes
 * public.swing_analysis.club_id. It never selects a catalog model. Creating
 * equipment from the canonical catalog is a different concern, already owned by
 * the Add Club form.
 *
 * WHY IT NEVER READS THE CANONICAL CATALOG
 * ----------------------------------------
 * A saved row carries its own durable identity: canonical selections write a
 * readable brand/model snapshot alongside the catalog reference, legacy rows
 * carry free text, and Custom/Other rows carry custom text. All three are
 * legitimate saved equipment, so the selector needs none of
 * equipment_models, equipment_manufacturers, equipment_putter_model_specs or
 * equipment_model_sources. Two consequences follow, both deliberate: catalog
 * availability can never affect club selection, and there is no code path along
 * which a legacy row could be silently matched to a canonical record.
 *
 * WHY CANONICAL STATUS IS NOT EXPOSED
 * -----------------------------------
 * Whether a saved row currently carries a catalog reference has no bearing on
 * its validity as a selectable club, and the database derives analysis_family
 * from club_type alone. Reading or exporting that linkage purely to classify
 * rows would invite a badge or a filter with no product justification, so the
 * public shape stops at the four fields a selector actually needs.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * - It never constructs a client, and never reaches for the service-role admin
 *   client — RLS already scopes user_equipment to auth.uid().
 * - It performs no insert/update/upsert/delete/rpc. Reads only.
 * - It never falls back to a static catalog, and never calls an API route.
 * - It never fabricates manufacturer or model identity. Where a saved row has
 *   no usable text, the club type itself is shown — a presentation fallback,
 *   not invented data.
 */

import type { ClubType } from "@/types/database";

// ─── Injected client ──────────────────────────────────────────────────────────
//
// A structural subset of the Supabase client describing exactly the surface this
// module uses, mirroring the canonical catalog reader's approach so a real
// client and a test double satisfy the same contract.

/** Raw PostgREST response shape as returned by the awaited query builder. */
export interface SavedClubsPostgrestResponse {
  data: unknown;
  error: SavedClubsPostgrestError | null;
  status?: number;
}

/** Raw PostgREST error shape. `code` carries the PostgreSQL SQLSTATE when present. */
export interface SavedClubsPostgrestError {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** The filter/select chain this module builds. Thenable, like PostgREST builders. */
export interface SavedClubsQueryBuilder extends PromiseLike<SavedClubsPostgrestResponse> {
  select(columns: string): SavedClubsQueryBuilder;
  eq(column: string, value: unknown): SavedClubsQueryBuilder;
}

/** Minimum client contract required to read a golfer's saved clubs. */
export interface SavedClubsSupabaseClient {
  from(table: string): SavedClubsQueryBuilder;
}

// ─── Domain result types ──────────────────────────────────────────────────────

/**
 * One selectable saved club, reduced to the minimum a selector needs.
 *
 * `id` is the public.user_equipment.id a later consumer writes to
 * swing_analysis.club_id. Nothing about the row's raw identity columns, its
 * owner, its fitting values or its catalog linkage survives into this shape.
 */
export interface SelectableClub {
  id: string;
  clubType: ClubType;
  displayName: string;
  isPrimary: boolean;
}

/** Discriminated outcome. Every distinct real-world state stays distinguishable. */
export type SavedClubsResult =
  /** 1. Query succeeded and saved clubs were returned. */
  | { status: "ok"; clubs: SelectableClub[] }
  /** 2. Query succeeded and the golfer has no saved clubs. Not a failure. */
  | { status: "empty"; clubs: [] }
  /** 3. The caller's user id was unusable, or the session may not read the rows. */
  | { status: "auth_error"; clubs: [] }
  /** 4. The query itself failed. NEVER reported as an empty bag. */
  | { status: "database_error"; clubs: [] }
  /** 5. The query succeeded but a row violated the saved-club contract. */
  | { status: "malformed_data"; clubs: [] };

// ─── Table + column contract ──────────────────────────────────────────────────

export const SAVED_CLUBS_TABLE = "user_equipment";

/**
 * Explicit column list — never `*`.
 *
 * `user_id` is deliberately absent: it is used as a filter, never as payload.
 * `equipment_model_id`, `manufacturer_id`, the fitting columns and the
 * timestamps are absent because nothing in the selector contract needs them.
 */
export const SAVED_CLUBS_SELECT = [
  "id",
  "club_type",
  "brand",
  "model",
  "custom_club",
  "custom_brand",
  "custom_model",
  "is_primary",
].join(",");

/**
 * Bag order, mirroring public.club_type_enum's declaration order. Used as an
 * explicit ordering map so results never depend on database-default ordering.
 */
export const CLUB_TYPE_ORDER: readonly ClubType[] = [
  "Driver",
  "Wood",
  "Hybrid",
  "Iron",
  "Wedge",
  "Putter",
] as const;

// ─── Internals ────────────────────────────────────────────────────────────────

/** SQLSTATE 42501 is insufficient_privilege — an RLS/grant refusal, not an outage. */
const PERMISSION_DENIED_SQLSTATE = "42501";

/**
 * Canonical UUID form. Validating locally lets an unusable user id fail closed
 * before any client call, rather than spending a round trip to learn it.
 */
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUsableUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID_PATTERN.test(value);
}

function isAuthFailure(error: SavedClubsPostgrestError, status: number | undefined): boolean {
  if (status === 401 || status === 403) return true;
  return error.code === PERMISSION_DENIED_SQLSTATE;
}

/** Deterministic, locale-independent ordering. `localeCompare` would vary by ICU data. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isClubType(value: unknown): value is ClubType {
  return typeof value === "string" && (CLUB_TYPE_ORDER as readonly string[]).includes(value);
}

/**
 * Human-readable identity for one saved club.
 *
 * Custom rows prefer their custom text, then any legacy text, then the word
 * "Custom" so the row is still nameable. Non-custom rows — canonical and legacy
 * alike, since a canonical selection stores a readable snapshot — use the saved
 * brand/model. When that yields nothing, the club type is shown rather than an
 * invented manufacturer or model.
 */
function deriveDisplayName(
  clubType: ClubType,
  brand: string | null,
  model: string | null,
  customClub: boolean,
  customBrand: string | null,
  customModel: string | null
): string {
  if (customClub) {
    const brandPart = customBrand ?? brand ?? "Custom";
    const modelPart = customModel ?? model ?? "";
    return `${brandPart} ${modelPart}`.trim();
  }

  const name = `${brand ?? ""} ${model ?? ""}`.trim();
  return name.length > 0 ? name : clubType;
}

/**
 * Minimum runtime validation protecting saved-club identity. Deliberately
 * narrow: it guards the fields the selector keys on and the fields the display
 * name is built from, not every column of the row.
 */
function toSelectableClub(raw: unknown): SelectableClub | null {
  if (!isRecord(raw)) return null;

  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (!isClubType(raw.club_type)) return null;
  if (typeof raw.custom_club !== "boolean") return null;
  if (typeof raw.is_primary !== "boolean") return null;
  if (!isNullableString(raw.brand)) return null;
  if (!isNullableString(raw.model)) return null;
  if (!isNullableString(raw.custom_brand)) return null;
  if (!isNullableString(raw.custom_model)) return null;

  return {
    id: raw.id,
    clubType: raw.club_type,
    displayName: deriveDisplayName(
      raw.club_type,
      raw.brand,
      raw.model,
      raw.custom_club,
      raw.custom_brand,
      raw.custom_model
    ),
    isPrimary: raw.is_primary,
  };
}

/**
 * Total order: club type (bag order) → primary first → display name → id.
 * `id` is unique, so the final comparison guarantees a total — not merely
 * partial — ordering, independent of the order the database returned rows in.
 */
function compareClubs(a: SelectableClub, b: SelectableClub): number {
  const byClubType = CLUB_TYPE_ORDER.indexOf(a.clubType) - CLUB_TYPE_ORDER.indexOf(b.clubType);
  if (byClubType !== 0) return byClubType;

  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;

  const byName = compareStrings(a.displayName, b.displayName);
  if (byName !== 0) return byName;

  return compareStrings(a.id, b.id);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface QuerySavedClubsOptions {
  /**
   * The authenticated golfer's id. The caller owns session establishment; this
   * module applies the filter as defence in depth alongside RLS, which remains
   * authoritative.
   */
  userId: string;
}

/**
 * Read one golfer's saved clubs.
 *
 * Read-only. Returns a discriminated result; it never throws for an expected
 * database or permission condition, never converts a failure into an empty bag,
 * and never returns a partially accepted list.
 */
export async function querySavedClubs(
  supabase: SavedClubsSupabaseClient,
  options: QuerySavedClubsOptions
): Promise<SavedClubsResult> {
  const userId = options?.userId;

  // Fail closed before touching the client: an unusable id is an authorization
  // problem, and querying with it would be a pointless round trip.
  if (!isUsableUserId(userId)) {
    return { status: "auth_error", clubs: [] };
  }

  let response: SavedClubsPostgrestResponse;
  try {
    response = await supabase
      .from(SAVED_CLUBS_TABLE)
      .select(SAVED_CLUBS_SELECT)
      .eq("user_id", userId);
  } catch {
    // A transport-level throw is still a query failure, never an empty bag. The
    // thrown value is deliberately not inspected or surfaced.
    return { status: "database_error", clubs: [] };
  }

  const { data, error, status } = response;

  if (error) {
    // Only the classification crosses this boundary — never the message, code,
    // details or hint.
    return isAuthFailure(error, status)
      ? { status: "auth_error", clubs: [] }
      : { status: "database_error", clubs: [] };
  }

  if (!Array.isArray(data)) {
    return { status: "malformed_data", clubs: [] };
  }

  const clubs: SelectableClub[] = [];
  for (const row of data) {
    const club = toSelectableClub(row);
    if (club === null) {
      return { status: "malformed_data", clubs: [] };
    }
    clubs.push(club);
  }

  if (clubs.length === 0) {
    return { status: "empty", clubs: [] };
  }

  clubs.sort(compareClubs);
  return { status: "ok", clubs };
}
