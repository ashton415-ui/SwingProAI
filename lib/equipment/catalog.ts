/**
 * SwingProAI — Equipment Integration Slice 1: Canonical Catalog Query Layer
 *
 * The ONE application query implementation for reading SwingProAI's canonical,
 * database-backed equipment catalog (public.equipment_manufacturers and
 * public.equipment_models, plus the optional one-to-one
 * public.equipment_putter_model_specs).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A read-only, typed, deterministic reader. It takes an already-constructed
 * Supabase client so the same implementation serves an authenticated server
 * component (utils/supabase/server) and an authenticated browser component
 * (utils/supabase/client). Both are legitimate: the catalog tables grant SELECT
 * to `authenticated` and carry active-only RLS policies.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * - It never constructs a client, and never uses the service-role admin client
 *   (utils/supabase/admin) — RLS already permits the reads it performs, so
 *   bypassing RLS would be an unnecessary privilege escalation.
 * - It never queries public.equipment_model_sources. That table has no
 *   `authenticated` grant and no `authenticated` policy: provenance is
 *   service_role-only and must never be reachable from application code here.
 * - It performs no insert/update/upsert/delete/rpc. Reads only.
 * - It adds no caching. Freshness policy belongs to consumers, not to the
 *   reader.
 * - It never emits a "Custom"/"Other"/"Unknown" sentinel. Every row it returns
 *   is a real catalog row with a real id and catalog_key. The Custom/Other
 *   fallback is a selector concern for a later slice, and inventing a fake
 *   canonical row here would corrupt catalog identity.
 * - It never falls back to the legacy static catalogs (e.g. the inline table in
 *   app/api/equipment/route.ts) when the canonical query fails. A canonical
 *   failure is reported as a failure, never disguised as "no clubs".
 *
 * COVERAGE HONESTY
 * ----------------
 * The canonical catalog is currently putter-only. Asking for a non-putter club
 * type is a legitimate question with a legitimate answer — "no canonical
 * coverage" — which is reported distinctly from both an empty catalog and a
 * query error, so a caller can offer a Custom/Other path without ever being
 * misled into thinking the database failed.
 *
 * Loft, shaft flex and shaft weight are deliberately absent: they do not exist
 * in the catalog schema at all. They are per-golfer customizations stored on
 * public.user_equipment, not catalog identity, and are never fabricated here.
 */

import type {
  ClubType,
  EquipmentManufacturer,
  EquipmentModel,
  EquipmentPutterModelSpecs,
} from "@/types/database";

// ─── Injected client ──────────────────────────────────────────────────────────
//
// A structural subset of the Supabase client, describing exactly the surface
// this module uses. The real SupabaseClient satisfies it, and a test double can
// satisfy it without pulling in the full generic client type.

/** Raw PostgREST response shape as returned by the awaited query builder. */
export interface CatalogPostgrestResponse {
  data: unknown;
  error: CatalogPostgrestError | null;
  status?: number;
}

/** Raw PostgREST error shape. `code` carries the PostgreSQL SQLSTATE when present. */
export interface CatalogPostgrestError {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** The filter/select chain this module builds. Thenable, like PostgREST builders. */
export interface CatalogQueryBuilder extends PromiseLike<CatalogPostgrestResponse> {
  select(columns: string): CatalogQueryBuilder;
  eq(column: string, value: unknown): CatalogQueryBuilder;
}

/** Minimum client contract required to read the canonical catalog. */
export interface CatalogSupabaseClient {
  from(table: string): CatalogQueryBuilder;
}

// ─── Domain result types ──────────────────────────────────────────────────────

/**
 * One canonical catalog model with its required parent manufacturer and its
 * optional putter fitting metadata resolved. Built from the existing generated
 * row types — no duplicated database schema.
 */
export interface CanonicalCatalogEntry
  extends Omit<EquipmentModel, "manufacturer" | "putter_specs"> {
  manufacturer: EquipmentManufacturer;
  putter_specs: EquipmentPutterModelSpecs | null;
}

/** Discriminated outcome. Every distinct real-world state stays distinguishable. */
export type CanonicalCatalogResult =
  /** 1. Query succeeded and canonical rows were returned. */
  | { status: "ok"; entries: CanonicalCatalogEntry[] }
  /** 2. Query succeeded, zero rows, and no specific club type was requested. */
  | { status: "empty"; entries: [] }
  /** 3. Query succeeded, but the requested (valid) club type has no canonical coverage yet. */
  | { status: "missing_coverage"; clubType: ClubType; entries: [] }
  /** 4. The caller's session is missing or not permitted to read the catalog. */
  | { status: "auth_error"; message: string; code: string | null }
  /** 5. The catalog query itself failed. NEVER reported as an empty catalog. */
  | { status: "database_error"; message: string; code: string | null }
  /** 6. The query succeeded but a row violated the canonical identity contract. */
  | { status: "malformed_data"; message: string };

// ─── Table + column contract ──────────────────────────────────────────────────

export const EQUIPMENT_MODELS_TABLE = "equipment_models";

/**
 * Explicit column list. `manufacturer` uses `!inner`, which is the load-bearing
 * part of this query: with an inner embed, filtering on the manufacturer's
 * is_active removes the BASE MODEL ROW rather than merely nulling the embedded
 * object. A model row is active-checked in its own right by RLS, but RLS on
 * equipment_models does not consider the parent, so an active model beneath a
 * deactivated manufacturer would otherwise survive.
 *
 * equipment_model_sources is deliberately absent — service_role only.
 */
export const CANONICAL_CATALOG_SELECT = [
  "id",
  "manufacturer_id",
  "club_type",
  "canonical_name",
  "slug",
  "normalized_name",
  "model_year",
  "specifications",
  "is_active",
  "created_at",
  "updated_at",
  "catalog_key",
  "brand_line",
  "brand_line_slug",
  "model_family",
  "model_family_slug",
  "release_year",
  "manufacturer:equipment_manufacturers!inner(" +
    "id,canonical_name,slug,normalized_name,is_active,created_at,updated_at" +
    ")",
  "putter_specs:equipment_putter_model_specs(" +
    "equipment_model_id,head_shape,neck_type,neck_source_label,toe_hang_class," +
    "face_construction,handedness,standard_lengths_inches,created_at,updated_at" +
    ")",
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

function isAuthFailure(error: CatalogPostgrestError, status: number | undefined): boolean {
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isClubType(value: unknown): value is ClubType {
  return typeof value === "string" && (CLUB_TYPE_ORDER as readonly string[]).includes(value);
}

/**
 * Resolve the embedded putter-spec relationship. PostgREST returns a to-one
 * embed as an object (or null); it is accepted as a single-element array too,
 * since embed cardinality detection is a database-introspection detail this
 * module should not be brittle about. Anything else is malformed.
 */
function readPutterSpecs(raw: unknown): EquipmentPutterModelSpecs | null | "invalid" {
  if (raw === null || raw === undefined) return null;

  const candidate = Array.isArray(raw) ? (raw.length === 0 ? null : raw.length === 1 ? raw[0] : "invalid") : raw;
  if (candidate === null) return null;
  if (candidate === "invalid" || !isRecord(candidate)) return "invalid";

  if (!nonEmptyString(candidate.equipment_model_id)) return "invalid";
  if (!nonEmptyString(candidate.head_shape)) return "invalid";

  return candidate as unknown as EquipmentPutterModelSpecs;
}

/**
 * Minimum runtime validation protecting canonical identity and the relational
 * contract. Deliberately narrow: it guards the fields consumers will key on,
 * not every column.
 */
function toCanonicalEntry(raw: unknown): CanonicalCatalogEntry | null {
  if (!isRecord(raw)) return null;

  if (
    !nonEmptyString(raw.id) ||
    !nonEmptyString(raw.catalog_key) ||
    !nonEmptyString(raw.slug) ||
    !nonEmptyString(raw.canonical_name) ||
    !isClubType(raw.club_type)
  ) {
    return null;
  }

  const manufacturerRaw = Array.isArray(raw.manufacturer) ? raw.manufacturer[0] : raw.manufacturer;
  if (!isRecord(manufacturerRaw)) return null;
  if (
    !nonEmptyString(manufacturerRaw.id) ||
    !nonEmptyString(manufacturerRaw.slug) ||
    !nonEmptyString(manufacturerRaw.canonical_name)
  ) {
    return null;
  }

  const putterSpecs = readPutterSpecs(raw.putter_specs);
  if (putterSpecs === "invalid") return null;

  const { manufacturer: _m, putter_specs: _p, ...model } = raw;

  return {
    ...(model as unknown as EquipmentModel),
    manufacturer: manufacturerRaw as unknown as EquipmentManufacturer,
    putter_specs: putterSpecs,
  };
}

/**
 * Total order: club type (bag order) → manufacturer canonical_name → model
 * canonical_name → catalog_key. catalog_key is globally unique, so the final
 * comparison guarantees a total — not merely partial — ordering.
 */
function compareEntries(a: CanonicalCatalogEntry, b: CanonicalCatalogEntry): number {
  const byClubType =
    CLUB_TYPE_ORDER.indexOf(a.club_type) - CLUB_TYPE_ORDER.indexOf(b.club_type);
  if (byClubType !== 0) return byClubType;

  const byManufacturer = compareStrings(a.manufacturer.canonical_name, b.manufacturer.canonical_name);
  if (byManufacturer !== 0) return byManufacturer;

  const byModel = compareStrings(a.canonical_name, b.canonical_name);
  if (byModel !== 0) return byModel;

  return compareStrings(a.catalog_key, b.catalog_key);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface QueryCanonicalEquipmentCatalogOptions {
  /**
   * Restrict to one club type. When supplied and the catalog holds no rows for
   * it, the result is `missing_coverage` rather than `empty` — the caller can
   * then offer a Custom/Other path knowing the database answered correctly.
   */
  clubType?: ClubType;
}

/**
 * Read the canonical equipment catalog.
 *
 * Read-only. Returns a discriminated result; it never throws for an expected
 * database or permission condition, and never converts a failure into an empty
 * catalog.
 */
export async function queryCanonicalEquipmentCatalog(
  supabase: CatalogSupabaseClient,
  options: QueryCanonicalEquipmentCatalogOptions = {}
): Promise<CanonicalCatalogResult> {
  const { clubType } = options;

  let builder = supabase
    .from(EQUIPMENT_MODELS_TABLE)
    .select(CANONICAL_CATALOG_SELECT)
    // The model must be active in its own right...
    .eq("is_active", true)
    // ...and so must its parent. Combined with the `!inner` embed above, this
    // drops the model row entirely rather than nulling the manufacturer.
    .eq("manufacturer.is_active", true);

  if (clubType !== undefined) {
    builder = builder.eq("club_type", clubType);
  }

  let response: CatalogPostgrestResponse;
  try {
    response = await builder;
  } catch (thrown) {
    // A transport-level throw is still a database failure, never empty coverage.
    return {
      status: "database_error",
      message: thrown instanceof Error ? thrown.message : "Unknown catalog query failure.",
      code: null,
    };
  }

  const { data, error, status } = response;

  if (error) {
    const message = error.message ?? "Canonical equipment catalog query failed.";
    const code = error.code ?? null;
    return isAuthFailure(error, status)
      ? { status: "auth_error", message, code }
      : { status: "database_error", message, code };
  }

  if (!Array.isArray(data)) {
    return {
      status: "malformed_data",
      message: "Canonical equipment catalog query returned a non-array payload.",
    };
  }

  const entries: CanonicalCatalogEntry[] = [];
  for (const row of data) {
    const entry = toCanonicalEntry(row);
    if (entry === null) {
      return {
        status: "malformed_data",
        message: "Canonical equipment catalog row violated the canonical identity contract.",
      };
    }
    entries.push(entry);
  }

  if (entries.length === 0) {
    return clubType !== undefined
      ? { status: "missing_coverage", clubType, entries: [] }
      : { status: "empty", entries: [] };
  }

  entries.sort(compareEntries);
  return { status: "ok", entries };
}
