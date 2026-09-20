import type { CanonicalCatalogEntry } from "@/lib/equipment/catalog";
import { getClubDisplayName } from "@/lib/equipment/club-display-name";
import type { ClubDesignation, ClubType } from "@/types/database";

/**
 * SwingProAI — V1 equipment data transfer objects.
 *
 * The public shape of the Native equipment read surface, written out in full
 * rather than derived from the row types. `EquipmentModel` carries
 * `normalized_name`, `specifications`, `is_active` and timestamps; `UserEquipment`
 * carries `user_id`, `is_archived` and `custom_notes`. Re-using either as a DTO
 * would publish whatever a future migration adds to those tables. The
 * duplication below is the point: the exposed surface changes only when someone
 * edits this file.
 *
 * Mapping is pure. Every function here takes already-fetched rows and returns
 * either a complete DTO or `null`; the route turns `null` into a single opaque
 * INTERNAL_ERROR. Nothing here reads a request, builds a client, or touches the
 * database — and no Supabase or Postgres text can reach a caller through it.
 */

/** The club-type vocabulary this API version publishes, in bag order. */
export const V1_CLUB_TYPES = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"] as const;

export type V1ClubType = (typeof V1_CLUB_TYPES)[number];

/**
 * Narrows a database value to the published vocabulary.
 *
 * `club_type` is a Postgres enum and is typed in TypeScript, but it still
 * arrives as JSON from PostgREST, so an unrecognised value can reach this
 * boundary. It is refused rather than passed through: publishing an unknown
 * club type would hand clients a category they cannot render, and coercing it
 * to a known one would be a lie about the golfer's bag.
 */
export function isV1ClubType(value: unknown): value is V1ClubType {
  return typeof value === "string" && (V1_CLUB_TYPES as readonly string[]).includes(value);
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export interface CatalogManufacturerDto {
  readonly id: string;
  readonly name: string;
}

export interface CatalogModelDto {
  readonly id: string;
  readonly catalogKey: string;
  readonly manufacturerId: string;
  readonly clubType: V1ClubType;
  readonly name: string;
  readonly brandLine: string | null;
  readonly modelFamily: string | null;
}

export interface EquipmentCatalogDto {
  readonly clubTypes: readonly V1ClubType[];
  readonly manufacturers: readonly CatalogManufacturerDto[];
  readonly models: readonly CatalogModelDto[];
}

// ─── Bag ──────────────────────────────────────────────────────────────────────

export interface BagClubDto {
  readonly id: string;
  readonly clubType: V1ClubType;
  readonly clubDesignation: string | null;
  readonly displayName: string;
  readonly brand: string | null;
  readonly model: string | null;
  readonly customClub: boolean;
  readonly customBrand: string | null;
  readonly customModel: string | null;
  readonly shaftFlex: string | null;
  readonly shaftWeight: number | null;
  readonly loftDeg: number | null;
  readonly isPrimary: boolean;
  readonly createdAt: string;
}

export interface BagDto {
  readonly clubs: readonly BagClubDto[];
}

/**
 * The selected `public.user_equipment` columns, every one of them `unknown`.
 *
 * PostgREST output is JSON decided by the database, not by TypeScript. Typing
 * the input honestly as `unknown` forces each field through a guard below,
 * which is what makes the published types true at runtime rather than merely
 * asserted.
 */
export interface BagRow {
  readonly id?: unknown;
  readonly club_type?: unknown;
  readonly club_designation?: unknown;
  readonly brand?: unknown;
  readonly model?: unknown;
  readonly custom_club?: unknown;
  readonly custom_brand?: unknown;
  readonly custom_model?: unknown;
  readonly shaft_flex?: unknown;
  readonly shaft_weight?: unknown;
  readonly loft_deg?: unknown;
  readonly is_primary?: unknown;
  readonly created_at?: unknown;
}

// ─── Guards ───────────────────────────────────────────────────────────────────

/** Passes strings through untouched; everything else becomes null. */
function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Booleans are NOT NULL in the schema; anything else is a contract violation. */
function toRequiredBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The numeric contract: a JSON number or null, never a string.
 *
 * `loft_deg` is `numeric(4,1)`, which PostgREST may serialise as a string to
 * preserve precision, so a string denoting a finite number is normalised.
 * Anything else — a non-numeric string, a boolean, an object, NaN, Infinity, a
 * missing key — becomes null rather than being coerced, because a club with no
 * recorded loft is not a club lofted at zero degrees.
 *
 * Deliberately a local copy of the Foundation's guard rather than a shared
 * import: sharing it would mean editing a production-accepted Foundation module
 * to serve this slice.
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
 * ISO-8601 in UTC, or `null` when the column holds nothing a date can be read
 * from. `created_at` is NOT NULL in the schema, so the caller treats `null`
 * here as a failed mapping rather than inventing a nullable field.
 */
function toIsoStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Deterministic, locale-independent ordering; `localeCompare` varies by ICU data. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ─── Catalog mapping ──────────────────────────────────────────────────────────

/**
 * Builds the catalog payload from the canonical reader's entries.
 *
 * Model order is the reader's own total order (club type → manufacturer name →
 * model name → catalog_key) and is preserved exactly; re-sorting here would
 * create a second ordering authority that could drift from the one the web
 * surfaces already rely on.
 *
 * Manufacturers are emitted once, keyed by UUID, and referenced from each model
 * by `manufacturerId` — repeating the manufacturer object inside all 252 models
 * would bloat the payload for no benefit. Deduplication is by id, never by
 * name: two manufacturers may legitimately share a display string, and names
 * are not identity.
 *
 * Returns `null` if any entry violates the published contract, so a malformed
 * row fails the whole request closed instead of yielding a partial catalog.
 */
export function toEquipmentCatalogDto(
  entries: readonly CanonicalCatalogEntry[],
): EquipmentCatalogDto | null {
  const manufacturersById = new Map<string, CatalogManufacturerDto>();
  const models: CatalogModelDto[] = [];

  for (const entry of entries) {
    const id = toRequiredString(entry.id);
    const catalogKey = toRequiredString(entry.catalog_key);
    const name = toRequiredString(entry.canonical_name);
    const manufacturerId = toRequiredString(entry.manufacturer?.id);
    const manufacturerName = toRequiredString(entry.manufacturer?.canonical_name);

    if (
      id === null ||
      catalogKey === null ||
      name === null ||
      manufacturerId === null ||
      manufacturerName === null ||
      !isV1ClubType(entry.club_type)
    ) {
      return null;
    }

    if (!manufacturersById.has(manufacturerId)) {
      manufacturersById.set(manufacturerId, { id: manufacturerId, name: manufacturerName });
    }

    models.push({
      id,
      catalogKey,
      manufacturerId,
      clubType: entry.club_type,
      name,
      brandLine: toNullableString(entry.brand_line),
      modelFamily: toNullableString(entry.model_family),
    });
  }

  const manufacturers = Array.from(manufacturersById.values()).sort((a, b) =>
    compareStrings(a.name, b.name) || compareStrings(a.id, b.id),
  );

  return { clubTypes: V1_CLUB_TYPES, manufacturers, models };
}

// ─── Bag mapping ──────────────────────────────────────────────────────────────

/**
 * Builds the bag payload from the caller's own `user_equipment` rows.
 *
 * Row order is the query's order (`created_at ASC, id ASC`) and is preserved;
 * the API does not group by club type, leaving that presentation choice to the
 * client.
 *
 * `displayName` is delegated to `getClubDisplayName`, the single production
 * implementation of designation-first naming, so a native client and the web
 * bag can never disagree about what a club is called. The designation is passed
 * through as stored: that helper independently validates it against the club
 * type and drops an illegal prefix, so a bad value degrades to the plain
 * identity name rather than being repaired or guessed at here.
 *
 * Returns `null` when a NOT NULL column is missing or unusable — an unknown
 * club type, an unparseable timestamp, a non-boolean flag — so malformed data
 * fails closed instead of being published.
 */
export function toBagDto(rows: readonly BagRow[]): BagDto | null {
  const clubs: BagClubDto[] = [];

  for (const row of rows) {
    const id = toRequiredString(row.id);
    const createdAt = toIsoStringOrNull(row.created_at);
    const customClub = toRequiredBoolean(row.custom_club);
    const isPrimary = toRequiredBoolean(row.is_primary);

    if (
      id === null ||
      createdAt === null ||
      customClub === null ||
      isPrimary === null ||
      !isV1ClubType(row.club_type)
    ) {
      return null;
    }

    const clubDesignation = toNullableString(row.club_designation);
    const brand = toNullableString(row.brand);
    const model = toNullableString(row.model);
    const customBrand = toNullableString(row.custom_brand);
    const customModel = toNullableString(row.custom_model);

    const displayName = getClubDisplayName({
      club_type: row.club_type as ClubType,
      club_designation: clubDesignation as ClubDesignation | null,
      brand,
      model,
      custom_club: customClub,
      custom_brand: customBrand,
      custom_model: customModel,
    });

    clubs.push({
      id,
      clubType: row.club_type,
      clubDesignation,
      displayName,
      brand,
      model,
      customClub,
      customBrand,
      customModel,
      shaftFlex: toNullableString(row.shaft_flex),
      shaftWeight: toFiniteNumberOrNull(row.shaft_weight),
      loftDeg: toFiniteNumberOrNull(row.loft_deg),
      isPrimary,
      createdAt,
    });
  }

  return { clubs };
}
