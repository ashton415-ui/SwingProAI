// EQ1-S2 — deterministic generator for the curated putter catalog migration.
//
// Reads data/equipment-catalog-putters-v1.json, validates it strictly, computes
// RFC 4122 UUIDv5 identifiers for every model and source, and emits the exact
// SQL migration body at supabase/migrations/<timestamp>_equipment_putter_catalog_v1.sql.
//
// Node built-ins only. No network access. No dependencies.
//
// Usage:
//   node scripts/generate-equipment-catalog-putters-v1.mjs
//   node scripts/generate-equipment-catalog-putters-v1.mjs --check

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const dataPath = path.join(repoRoot, "data", "equipment-catalog-putters-v1.json");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const MIGRATION_SUFFIX = "_equipment_putter_catalog_v1.sql";

const CHECK_MODE = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// RFC 4122 UUIDv5
// ---------------------------------------------------------------------------

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`invalid UUID: ${uuid}`);
  }
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function uuidv5(namespaceUuid, name) {
  const namespaceBytes = uuidToBytes(namespaceUuid);
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(namespaceBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

// Known-vector self-check, run unconditionally at import/execution time.
function verifyKnownVector() {
  const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const name = "www.widgets.com";
  const expected = "21f7f8de-8051-5b89-8680-0195ef798b6a";
  const actual = uuidv5(namespace, name);
  if (actual !== expected) {
    throw new Error(
      `UUIDv5 known-vector check failed: expected ${expected}, got ${actual}`
    );
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const APPROVED_MANUFACTURERS = ["taylormade", "callaway", "titleist", "ping", "mizuno"];
const MAX_MODELS = 25;

const HEAD_SHAPES = ["blade", "mid_mallet", "mallet"];
const NECK_TYPES = [
  "plumbers_neck", "slant_neck", "flow_neck", "long_neck",
  "single_bend", "double_bend", "center_shaft", "broomstick_center_shaft",
];
const TOE_HANG_CLASSES = ["face_balanced", "slight", "moderate", "strong", "toe_down"];
const FACE_CONSTRUCTIONS = ["milled", "insert", "hybrid"];
const HANDEDNESS_VALUES = ["right", "left", "both"];

const SOURCE_TYPES = ["official_product_page", "official_spec_pdf", "official_archive"];
const ALLOWED_SOURCE_DOMAINS = [
  "taylormadegolf.com",
  "www.taylormadegolf.com",
  "callawaygolf.com",
  "www.callawaygolf.com",
  "odysseygolf.com",
  "www.odysseygolf.com",
  "odyssey.callawaygolf.com",
  "titleist.com",
  "www.titleist.com",
  "scottycameron.com",
  "www.scottycameron.com",
  "ping.com",
  "www.ping.com",
  "mizunogolf.com",
  "www.mizunogolf.com",
];

const TRACKING_QUERY_PARAM_PATTERN = /(?:^|[?&])(utm_[a-z]+|aff|affid|affiliate|ref|clickid|gclid|fbclid|irclickid)=/i;

const PROHIBITED_FIELD_NAMES = new Set([
  "price", "retail_price", "inventory", "stock",
  "affiliate", "affiliate_url", "tracking", "tracking_url",
  "sponsorship", "sponsor", "ranking", "tour_usage",
  "endorsement", "player_recommendation", "marketing_copy", "description",
  "image", "image_url", "logo", "logo_url",
  "ai_score", "recommended_player", "fitting_conclusion",
]);

const TOP_LEVEL_FIELDS = new Set([
  "schema_version", "catalog_name", "uuid_namespace", "verified_on", "models",
]);

const MODEL_FIELDS = new Set([
  "catalog_key", "manufacturer_slug", "brand_line", "brand_line_slug",
  "model_family", "model_family_slug", "canonical_name", "slug", "normalized_name",
  "model_year", "release_year", "is_active", "putter_specs", "sources",
]);

const PUTTER_SPECS_FIELDS = new Set([
  "head_shape", "neck_type", "neck_source_label", "toe_hang_class",
  "face_construction", "handedness", "standard_lengths_inches",
]);

const SOURCE_FIELDS = new Set(["source_type", "source_name", "source_url", "verified_at"]);

const CATALOG_KEY_PATTERN = /^[a-z0-9]+(\/[a-z0-9-]+)+$/;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoUnknownFields(obj, allowed, context) {
  for (const key of Object.keys(obj)) {
    assert(allowed.has(key), `${context}: unknown field "${key}"`);
    assert(!PROHIBITED_FIELD_NAMES.has(key), `${context}: prohibited field "${key}"`);
  }
}

function normalizeQueryCheck(url) {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return;
  const query = url.slice(queryIndex);
  assert(
    !TRACKING_QUERY_PARAM_PATTERN.test(query),
    `source_url contains a tracking/affiliate query parameter: ${url}`
  );
}

function validateSource(source, context) {
  assertNoUnknownFields(source, SOURCE_FIELDS, context);
  assert(SOURCE_TYPES.includes(source.source_type), `${context}: invalid source_type "${source.source_type}"`);
  assert(
    typeof source.source_name === "string" && source.source_name.trim().length > 0,
    `${context}: source_name must be nonblank`
  );
  assert(typeof source.source_url === "string", `${context}: source_url required`);
  assert(source.source_url.startsWith("https://"), `${context}: source_url must be HTTPS`);
  let hostname;
  try {
    hostname = new URL(source.source_url).hostname;
  } catch {
    throw new Error(`${context}: source_url is not a valid URL`);
  }
  assert(
    ALLOWED_SOURCE_DOMAINS.includes(hostname),
    `${context}: source_url domain "${hostname}" is not on the official-domain allowlist`
  );
  normalizeQueryCheck(source.source_url);
  if (source.source_type === "official_spec_pdf") {
    const pathname = new URL(source.source_url).pathname;
    assert(
      pathname.toLowerCase().endsWith(".pdf"),
      `${context}: source_type is official_spec_pdf but the URL pathname does not end in .pdf`
    );
  }
  assert(DATE_PATTERN.test(source.verified_at), `${context}: verified_at must be YYYY-MM-DD`);
  const verifiedDate = new Date(source.verified_at + "T00:00:00Z");
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  assert(verifiedDate.getTime() <= todayUtc.getTime(), `${context}: verified_at is in the future`);
}

function validatePutterSpecs(specs, context) {
  assertNoUnknownFields(specs, PUTTER_SPECS_FIELDS, context);
  assert(HEAD_SHAPES.includes(specs.head_shape), `${context}: invalid or missing head_shape "${specs.head_shape}"`);

  if (specs.neck_type !== null && specs.neck_type !== undefined) {
    assert(NECK_TYPES.includes(specs.neck_type), `${context}: invalid neck_type "${specs.neck_type}"`);
  }
  if (specs.neck_source_label !== null && specs.neck_source_label !== undefined) {
    assert(
      typeof specs.neck_source_label === "string" && specs.neck_source_label.trim().length > 0,
      `${context}: neck_source_label must be nonblank when populated`
    );
  }
  if (specs.toe_hang_class !== null && specs.toe_hang_class !== undefined) {
    assert(TOE_HANG_CLASSES.includes(specs.toe_hang_class), `${context}: invalid toe_hang_class "${specs.toe_hang_class}"`);
  }
  if (specs.face_construction !== null && specs.face_construction !== undefined) {
    assert(FACE_CONSTRUCTIONS.includes(specs.face_construction), `${context}: invalid face_construction "${specs.face_construction}"`);
  }
  if (specs.handedness !== null && specs.handedness !== undefined) {
    assert(HANDEDNESS_VALUES.includes(specs.handedness), `${context}: invalid handedness "${specs.handedness}"`);
  }
  if (specs.standard_lengths_inches !== null && specs.standard_lengths_inches !== undefined) {
    const lengths = specs.standard_lengths_inches;
    assert(Array.isArray(lengths) && lengths.length > 0, `${context}: standard_lengths_inches must be a nonempty array when populated`);
    for (const value of lengths) {
      assert(typeof value === "number", `${context}: standard_lengths_inches values must be numbers`);
      assert(value >= 20 && value <= 60, `${context}: standard_lengths_inches value ${value} out of bounds [20,60]`);
    }
    const sorted = [...lengths].sort((a, b) => a - b);
    assert(JSON.stringify(sorted) === JSON.stringify(lengths), `${context}: standard_lengths_inches must be sorted ascending`);
    assert(new Set(lengths).size === lengths.length, `${context}: standard_lengths_inches values must be unique`);
  }
}

function validateAndLoad() {
  const raw = readFileSync(dataPath, "utf8");
  const data = JSON.parse(raw);

  assertNoUnknownFields(data, TOP_LEVEL_FIELDS, "root");
  assert(data.schema_version === 1, `root: schema_version must be 1`);
  assert(data.catalog_name === "equipment-catalog-putters-v1", `root: catalog_name mismatch`);
  assert(data.uuid_namespace === "05690d1f-f17d-5ab8-a2b6-ef0328a2783a", `root: uuid_namespace mismatch`);
  assert(DATE_PATTERN.test(data.verified_on), `root: verified_on must be YYYY-MM-DD`);
  assert(Array.isArray(data.models), `root: models must be an array`);
  assert(data.models.length <= MAX_MODELS, `root: model count ${data.models.length} exceeds ceiling of ${MAX_MODELS}`);
  assert(data.models.length > 0, `root: at least one model is required`);

  const seenCatalogKeys = new Set();
  const seenSlugs = new Set();
  const seenIdentity = new Set();
  const manufacturersSeen = new Set();

  for (const [index, model] of data.models.entries()) {
    const context = `models[${index}] (${model && model.catalog_key})`;
    assertNoUnknownFields(model, MODEL_FIELDS, context);

    assert(typeof model.catalog_key === "string", `${context}: catalog_key required`);
    assert(CATALOG_KEY_PATTERN.test(model.catalog_key), `${context}: catalog_key format invalid`);
    assert(!seenCatalogKeys.has(model.catalog_key), `${context}: duplicate catalog_key`);
    seenCatalogKeys.add(model.catalog_key);

    assert(APPROVED_MANUFACTURERS.includes(model.manufacturer_slug), `${context}: invalid manufacturer_slug "${model.manufacturer_slug}"`);
    manufacturersSeen.add(model.manufacturer_slug);

    const brandLinePairOk =
      (model.brand_line === null && model.brand_line_slug === null) ||
      (typeof model.brand_line === "string" && model.brand_line.trim().length > 0 &&
        typeof model.brand_line_slug === "string" && SLUG_PATTERN.test(model.brand_line_slug));
    assert(brandLinePairOk, `${context}: brand_line/brand_line_slug must both be null or both populated with a valid slug`);

    const modelFamilyPairOk =
      (model.model_family === null && model.model_family_slug === null) ||
      (typeof model.model_family === "string" && model.model_family.trim().length > 0 &&
        typeof model.model_family_slug === "string" && SLUG_PATTERN.test(model.model_family_slug));
    assert(modelFamilyPairOk, `${context}: model_family/model_family_slug must both be null or both populated with a valid slug`);

    assert(typeof model.canonical_name === "string" && model.canonical_name.trim().length > 0, `${context}: canonical_name required nonblank`);
    assert(typeof model.slug === "string" && SLUG_PATTERN.test(model.slug), `${context}: slug required and must be slug-formatted`);
    assert(!seenSlugs.has(model.slug), `${context}: duplicate slug`);
    seenSlugs.add(model.slug);

    assert(typeof model.normalized_name === "string" && model.normalized_name.trim().length > 0, `${context}: normalized_name required nonblank`);

    if (model.model_year !== null && model.model_year !== undefined) {
      assert(Number.isInteger(model.model_year) && model.model_year >= 1900 && model.model_year <= 2100, `${context}: model_year out of range`);
    }
    if (model.release_year !== null && model.release_year !== undefined) {
      assert(Number.isInteger(model.release_year) && model.release_year >= 1900 && model.release_year <= 2100, `${context}: release_year out of range`);
    }

    assert(model.is_active === true, `${context}: is_active must be true for all seeded v1 models`);

    const identityKey = `${model.manufacturer_slug}::${model.canonical_name.toLowerCase()}::${model.model_year ?? "null"}`;
    assert(!seenIdentity.has(identityKey), `${context}: duplicate manufacturer_slug+canonical_name+model_year identity`);
    seenIdentity.add(identityKey);

    assert(model.putter_specs && typeof model.putter_specs === "object", `${context}: putter_specs required`);
    validatePutterSpecs(model.putter_specs, `${context}.putter_specs`);

    assert(Array.isArray(model.sources) && model.sources.length >= 1, `${context}: at least one source is required`);
    model.sources.forEach((source, sourceIndex) => {
      validateSource(source, `${context}.sources[${sourceIndex}]`);
    });
  }

  for (const manufacturer of APPROVED_MANUFACTURERS) {
    assert(manufacturersSeen.has(manufacturer), `root: manufacturer "${manufacturer}" has zero verified models`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlStringOrNull(value) {
  return value === null || value === undefined ? "null" : sqlString(value);
}

function sqlIntOrNull(value) {
  return value === null || value === undefined ? "null" : String(value);
}

function sqlNumericArrayOrNull(values) {
  if (!values || values.length === 0) return "null";
  return `array[${values.map((v) => v.toString()).join(", ")}]::numeric[]`;
}

function findMigrationPath() {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(MIGRATION_SUFFIX));
  assert(files.length === 1, `expected exactly one migration file ending with "${MIGRATION_SUFFIX}", found ${files.length}: ${files.join(", ")}`);
  return path.join(migrationsDir, files[0]);
}

function buildSql(data) {
  const sortedModels = [...data.models].sort((a, b) => (a.catalog_key < b.catalog_key ? -1 : a.catalog_key > b.catalog_key ? 1 : 0));

  const modelRows = [];
  const specRows = [];
  const sourceRows = [];
  const modelCount = sortedModels.length;
  let sourceCount = 0;

  for (const model of sortedModels) {
    const modelId = uuidv5(data.uuid_namespace, `model:${model.catalog_key}`);
    const specs = model.putter_specs;

    modelRows.push(
      `  (${sqlString(modelId)}, (select id from public.equipment_manufacturers where slug = ${sqlString(model.manufacturer_slug)}), ` +
        `'Putter'::public.club_type_enum, ${sqlString(model.canonical_name)}, ${sqlString(model.slug)}, ${sqlString(model.normalized_name)}, ` +
        `${sqlIntOrNull(model.model_year)}, '{}'::jsonb, true, ` +
        `${sqlString(model.catalog_key)}, ${sqlStringOrNull(model.brand_line)}, ${sqlStringOrNull(model.brand_line_slug)}, ` +
        `${sqlStringOrNull(model.model_family)}, ${sqlStringOrNull(model.model_family_slug)}, ${sqlIntOrNull(model.release_year)})`
    );

    specRows.push(
      `  (${sqlString(modelId)}, ${sqlString(specs.head_shape)}, ${sqlStringOrNull(specs.neck_type)}, ${sqlStringOrNull(specs.neck_source_label)}, ` +
        `${sqlStringOrNull(specs.toe_hang_class)}, ${sqlStringOrNull(specs.face_construction)}, ${sqlStringOrNull(specs.handedness)}, ` +
        `${sqlNumericArrayOrNull(specs.standard_lengths_inches)})`
    );

    const sortedSources = [...model.sources].sort((a, b) => (a.source_url < b.source_url ? -1 : a.source_url > b.source_url ? 1 : 0));
    for (const source of sortedSources) {
      const sourceId = uuidv5(data.uuid_namespace, `source:${model.catalog_key}:${source.source_url}`);
      sourceRows.push(
        `  (${sqlString(sourceId)}, ${sqlString(modelId)}, ${sqlString(source.source_type)}, ${sqlString(source.source_name)}, ` +
          `${sqlString(source.source_url)}, ${sqlString(source.verified_at)}::date)`
      );
      sourceCount += 1;
    }
  }

  const sql = `-- ============================================================================
-- SwingProAI — EQ1-S2 Curated Putter Equipment Catalog v1 (Canonical Source Artifact)
-- ============================================================================
--
-- PRODUCTION STATE VERIFIED PRESENT. This migration remains the canonical
-- reproducible source artifact. Historical application mechanism/date and
-- staging application status are not asserted here.
--
-- Generated deterministically by scripts/generate-equipment-catalog-putters-v1.mjs
-- from data/equipment-catalog-putters-v1.json. Do not hand-edit this file —
-- edit the JSON source and regenerate.
--
-- Adds putter-specific fitting metadata (public.equipment_putter_model_specs)
-- and isolated, non-browser-readable source provenance
-- (public.equipment_model_sources) on top of the EQ1-S1R equipment catalog
-- foundation, then seeds ${modelCount} officially verified, currently marketed
-- putter models across all five existing parent manufacturers (TaylorMade,
-- Callaway, Titleist, PING, Mizuno). Consumer-facing sub-brands (e.g. Odyssey
-- under Callaway, Scotty Cameron under Titleist) are represented via the new
-- nullable brand_line/brand_line_slug columns on equipment_models, never as
-- additional parent manufacturer rows.
--
-- Model identity is anchored to an immutable catalog_key per model, and every
-- model/source UUID is a deterministic UUIDv5 derived from that key so display
-- names, slugs, and metadata remain freely correctable without ever changing
-- a model's identity.
--
-- SCOPE BOUNDARY
-- ---------------
-- This migration does NOT modify public.user_equipment, public.swing_analysis,
-- public.user_bags, or public.user_clubs. It performs zero backfill, zero
-- fuzzy matching, and zero alias-table creation. It does NOT alter
-- equipment_snapshot schema_version (remains 1) or either EQ1-S1R trigger
-- function. This file is the canonical source artifact for that schema and
-- asserts no application history of its own.
--
-- ============================================================================

begin;

-- ============================================================================
-- PREFLIGHT
-- ============================================================================
do $$
declare
  v_manufacturer_slugs text[] := array['taylormade','callaway','titleist','ping','mizuno'];
  v_slug text;
  v_count int;
begin
  if to_regclass('public.equipment_manufacturers') is null then
    raise exception 'EQ1S2-PRE-1: public.equipment_manufacturers does not exist.';
  end if;
  if to_regclass('public.equipment_models') is null then
    raise exception 'EQ1S2-PRE-2: public.equipment_models does not exist.';
  end if;
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) then
    raise exception 'EQ1S2-PRE-3: public.club_type_enum does not exist.';
  end if;

  foreach v_slug in array v_manufacturer_slugs loop
    select count(*) into v_count from public.equipment_manufacturers where slug = v_slug;
    if v_count <> 1 then
      raise exception 'EQ1S2-PRE-4: expected exactly one manufacturer with slug %, found %.', v_slug, v_count;
    end if;
  end loop;

  select count(*) into v_count from public.equipment_models;
  if v_count <> 0 then
    raise exception 'EQ1S2-PRE-5: public.equipment_models must contain zero rows before this migration, found %.', v_count;
  end if;

  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'catalog_key') then
    raise exception 'EQ1S2-PRE-6: public.equipment_models.catalog_key already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'brand_line') then
    raise exception 'EQ1S2-PRE-7: public.equipment_models.brand_line already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'model_family') then
    raise exception 'EQ1S2-PRE-8: public.equipment_models.model_family already exists.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'equipment_models' and column_name = 'release_year') then
    raise exception 'EQ1S2-PRE-9: public.equipment_models.release_year already exists.';
  end if;

  if to_regclass('public.equipment_putter_model_specs') is not null then
    raise exception 'EQ1S2-PRE-10: public.equipment_putter_model_specs already exists.';
  end if;
  if to_regclass('public.equipment_model_sources') is not null then
    raise exception 'EQ1S2-PRE-11: public.equipment_model_sources already exists.';
  end if;

  if exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and con.conname = 'equipment_models_slug_unique'
  ) or exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'equipment_models_slug_unique'
  ) then
    raise exception 'EQ1S2-PRE-16: equipment_models_slug_unique already exists.';
  end if;

  if (
    select array_agg(e.enumlabel::text order by e.enumsortorder)
    from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'club_type_enum'
  ) is distinct from array['Driver','Wood','Hybrid','Iron','Wedge','Putter'] then
    raise exception 'EQ1S2-PRE-12: public.club_type_enum values have changed from the expected six values.';
  end if;

  if not has_schema_privilege(current_user, 'public', 'CREATE') then
    raise exception 'EQ1S2-PRE-13: current role % lacks CREATE privilege on schema public.', current_user;
  end if;

  if current_setting('server_version_num')::int < 140000 then
    raise exception 'EQ1S2-PRE-14: PostgreSQL server_version_num % is below the minimum supported 140000.', current_setting('server_version_num');
  end if;

  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;
  if v_count <> 0 then
    raise exception 'EQ1S2-PRE-15: expected zero user_equipment rows referencing an equipment_model, found %.', v_count;
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_valid_putter_standard_lengths'
  ) then
    raise exception 'EQ1S2-PRE-17: public.is_valid_putter_standard_lengths already exists.';
  end if;

  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and con.conname = 'equipment_putter_model_specs_lengths_valid'
  ) then
    raise exception 'EQ1S2-PRE-18: equipment_putter_model_specs_lengths_valid already exists.';
  end if;

  raise notice 'EQ1S2-PRE-OK: reconciled schema matched, no conflicting objects found — proceeding.';
end $$;

-- ============================================================================
-- equipment_models additions
-- ============================================================================

alter table public.equipment_models
  add column catalog_key text not null default '',
  add column brand_line text,
  add column brand_line_slug text,
  add column model_family text,
  add column model_family_slug text,
  add column release_year smallint;

alter table public.equipment_models
  alter column catalog_key drop default;

alter table public.equipment_models
  add constraint equipment_models_catalog_key_nonblank check (btrim(catalog_key) <> ''),
  add constraint equipment_models_catalog_key_format check (catalog_key ~ '^[a-z0-9]+(/[a-z0-9-]+)+$'),
  add constraint equipment_models_catalog_key_unique unique (catalog_key),
  add constraint equipment_models_brand_line_pair check (
    (brand_line is null and brand_line_slug is null) or (brand_line is not null and brand_line_slug is not null)
  ),
  add constraint equipment_models_brand_line_slug_format check (
    brand_line_slug is null or brand_line_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  add constraint equipment_models_model_family_pair check (
    (model_family is null and model_family_slug is null) or (model_family is not null and model_family_slug is not null)
  ),
  add constraint equipment_models_model_family_slug_format check (
    model_family_slug is null or model_family_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  add constraint equipment_models_release_year_range check (
    release_year is null or release_year between 1900 and 2100
  );

-- Global slug uniqueness, in addition to (and not replacing) the existing
-- equipment_models_manufacturer_type_name_year_uidx compound identity index.
-- Safe to add here because EQ1S2-PRE-5 already requires zero existing rows.
alter table public.equipment_models
  add constraint equipment_models_slug_unique unique (slug);

-- ============================================================================
-- Database-level standard-length validation (EQ1-S2-A1-C2)
--
-- The generator already rejects a nonempty/sorted/unique/[20,60]-bounded
-- violation at authoring time (validateAndLoad), but that check-time-only
-- guarantee is not a substitute for a live database constraint. This
-- function is the single source of truth for what a valid populated
-- standard_lengths_inches array looks like at the database layer.
-- ============================================================================

create function public.is_valid_putter_standard_lengths(
  p_lengths numeric[]
)
returns boolean
language sql
immutable
strict
security invoker
set search_path to ''
as $function$
  select
    pg_catalog.array_ndims(p_lengths) = 1
    and pg_catalog.cardinality(p_lengths) > 0
    and not exists (
      select 1
      from pg_catalog.generate_subscripts(p_lengths, 1) as s(i)
      where p_lengths[s.i] is null
         or p_lengths[s.i] < 20
         or p_lengths[s.i] > 60
         or (
           s.i > pg_catalog.array_lower(p_lengths, 1)
           and p_lengths[s.i] <= p_lengths[s.i - 1]
         )
    );
$function$;

revoke all on function public.is_valid_putter_standard_lengths(numeric[]) from public;
revoke all on function public.is_valid_putter_standard_lengths(numeric[]) from anon;
revoke all on function public.is_valid_putter_standard_lengths(numeric[]) from authenticated;
grant execute on function public.is_valid_putter_standard_lengths(numeric[]) to service_role;

-- ============================================================================
-- public.equipment_putter_model_specs
-- ============================================================================

create table public.equipment_putter_model_specs (
  equipment_model_id uuid not null,
  head_shape text not null,
  neck_type text,
  neck_source_label text,
  toe_hang_class text,
  face_construction text,
  handedness text,
  standard_lengths_inches numeric[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_putter_model_specs_pkey primary key (equipment_model_id),
  constraint equipment_putter_model_specs_model_fkey foreign key (equipment_model_id)
    references public.equipment_models (id) on delete cascade,
  constraint equipment_putter_model_specs_head_shape_check check (
    head_shape in ('blade','mid_mallet','mallet')
  ),
  constraint equipment_putter_model_specs_neck_type_check check (
    neck_type is null or neck_type in (
      'plumbers_neck','slant_neck','flow_neck','long_neck',
      'single_bend','double_bend','center_shaft','broomstick_center_shaft'
    )
  ),
  constraint equipment_putter_model_specs_neck_source_label_nonblank check (
    neck_source_label is null or btrim(neck_source_label) <> ''
  ),
  constraint equipment_putter_model_specs_toe_hang_class_check check (
    toe_hang_class is null or toe_hang_class in ('face_balanced','slight','moderate','strong','toe_down')
  ),
  constraint equipment_putter_model_specs_face_construction_check check (
    face_construction is null or face_construction in ('milled','insert','hybrid')
  ),
  constraint equipment_putter_model_specs_handedness_check check (
    handedness is null or handedness in ('right','left','both')
  ),
  constraint equipment_putter_model_specs_lengths_nonempty check (
    standard_lengths_inches is null or cardinality(standard_lengths_inches) > 0
  ),
  constraint equipment_putter_model_specs_lengths_valid check (
    standard_lengths_inches is null
    or public.is_valid_putter_standard_lengths(
      standard_lengths_inches
    )
  )
);

create trigger equipment_putter_model_specs_set_updated_at
  before update on public.equipment_putter_model_specs
  for each row execute function public.handle_updated_at();

-- Database-enforced rule: only Putter-club-type models may have a specs row.
create function public.guard_putter_model_specs_club_type()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_club_type public.club_type_enum;
begin
  select club_type into v_club_type from public.equipment_models where equipment_models.id = new.equipment_model_id;

  if not found then
    raise exception 'EQ1S2: equipment_model_id % does not reference an existing equipment model.', new.equipment_model_id;
  end if;

  if v_club_type is distinct from 'Putter'::public.club_type_enum then
    raise exception 'EQ1S2: equipment_putter_model_specs rows are only permitted for club_type = Putter models.';
  end if;

  return new;
end;
$function$;

create trigger equipment_putter_model_specs_guard_club_type
  before insert or update of equipment_model_id
  on public.equipment_putter_model_specs
  for each row execute function public.guard_putter_model_specs_club_type();

revoke all on function public.guard_putter_model_specs_club_type() from public;
revoke all on function public.guard_putter_model_specs_club_type() from anon;
revoke all on function public.guard_putter_model_specs_club_type() from authenticated;

-- ============================================================================
-- public.equipment_model_sources — isolated, never browser-readable
-- ============================================================================

create table public.equipment_model_sources (
  id uuid not null,
  equipment_model_id uuid not null,
  source_type text not null,
  source_name text not null,
  source_url text not null,
  verified_at date not null,
  created_at timestamptz not null default now(),
  constraint equipment_model_sources_pkey primary key (id),
  constraint equipment_model_sources_model_fkey foreign key (equipment_model_id)
    references public.equipment_models (id) on delete cascade,
  constraint equipment_model_sources_type_check check (
    source_type in ('official_product_page','official_spec_pdf','official_archive')
  ),
  constraint equipment_model_sources_name_nonblank check (btrim(source_name) <> ''),
  constraint equipment_model_sources_url_https check (source_url ~ '^https://'),
  constraint equipment_model_sources_verified_not_future check (verified_at <= current_date),
  constraint equipment_model_sources_model_url_unique unique (equipment_model_id, source_url)
);

-- ============================================================================
-- RLS and grants
-- ============================================================================

alter table public.equipment_putter_model_specs enable row level security;
alter table public.equipment_model_sources enable row level security;

-- Postgres/Supabase default privileges automatically grant new public tables
-- full CRUD to authenticated (and anon) at CREATE TABLE time; each must be
-- explicitly revoked before any intended grant is applied.
revoke all on public.equipment_putter_model_specs from public;
revoke all on public.equipment_putter_model_specs from anon;
revoke all on public.equipment_putter_model_specs from authenticated;
revoke all on public.equipment_model_sources from public;
revoke all on public.equipment_model_sources from anon;
revoke all on public.equipment_model_sources from authenticated;

grant select on public.equipment_putter_model_specs to authenticated;
grant select, insert, update, delete on public.equipment_putter_model_specs to service_role;

-- equipment_model_sources: service_role only. No authenticated grant at all —
-- provenance must never be reachable through the browser Data API.
grant select, insert, update, delete on public.equipment_model_sources to service_role;

create policy equipment_putter_model_specs_select_active_model
  on public.equipment_putter_model_specs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.equipment_models
      where equipment_models.id = equipment_putter_model_specs.equipment_model_id
        and equipment_models.is_active
    )
  );

-- ============================================================================
-- Seed data (generated — do not hand-edit)
-- ============================================================================

insert into public.equipment_models (
  id, manufacturer_id, club_type, canonical_name, slug, normalized_name,
  model_year, specifications, is_active,
  catalog_key, brand_line, brand_line_slug, model_family, model_family_slug, release_year
)
values
${modelRows.join(",\n")};

insert into public.equipment_putter_model_specs (
  equipment_model_id, head_shape, neck_type, neck_source_label,
  toe_hang_class, face_construction, handedness, standard_lengths_inches
)
values
${specRows.join(",\n")};

insert into public.equipment_model_sources (
  id, equipment_model_id, source_type, source_name, source_url, verified_at
)
values
${sourceRows.join(",\n")};

-- ============================================================================
-- POSTFLIGHT
-- ============================================================================
do $$
declare
  v_count int;
  v_model_count int;
  v_spec_count int;
  v_source_count int;
  v_manufacturer_count int;
  v_fn record;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_putter_model_specs' and c.relkind = 'r') then
    raise exception 'EQ1S2-POST-1: public.equipment_putter_model_specs was not created.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_model_sources' and c.relkind = 'r') then
    raise exception 'EQ1S2-POST-2: public.equipment_model_sources was not created.';
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'equipment_models'
      and column_name in ('catalog_key','brand_line','brand_line_slug','model_family','model_family_slug','release_year');
  if v_count <> 6 then
    raise exception 'EQ1S2-POST-3: public.equipment_models is missing one or more required new columns (found %).', v_count;
  end if;

  select count(*) into v_model_count from public.equipment_models;
  if v_model_count <> ${modelCount} then
    raise exception 'EQ1S2-POST-4: expected exactly ${modelCount} equipment_models rows, found %.', v_model_count;
  end if;

  if not exists (
    select 1 from pg_constraint con join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_models'
      and con.conname = 'equipment_models_slug_unique' and con.contype = 'u'
  ) then
    raise exception 'EQ1S2-POST-29: equipment_models_slug_unique is missing or is not a unique constraint.';
  end if;

  if (
    select array_agg(a.attname::text order by a.attname)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join unnest(con.conkey) as k(attnum) on true
    join pg_attribute a on a.attrelid = rel.oid and a.attnum = k.attnum
    where rel.relname = 'equipment_models' and con.conname = 'equipment_models_slug_unique'
  ) is distinct from array['slug'] then
    raise exception 'EQ1S2-POST-30: equipment_models_slug_unique is not scoped to exactly the slug column.';
  end if;

  -- Live proof that a duplicate slug is actually rejected by PostgreSQL, not
  -- merely declared. The nested exception block acts as an implicit
  -- savepoint: on unique_violation the failed insert is undone and the
  -- outer transaction (this migration) is otherwise unaffected.
  declare
    v_existing_manufacturer_id uuid;
    v_existing_slug text;
  begin
    select manufacturer_id, slug into v_existing_manufacturer_id, v_existing_slug
      from public.equipment_models order by slug limit 1;
    begin
      insert into public.equipment_models (
        id, manufacturer_id, club_type, canonical_name, slug, normalized_name, catalog_key
      ) values (
        gen_random_uuid(), v_existing_manufacturer_id, 'Putter'::public.club_type_enum,
        'EQ1S2-POST-31-duplicate-slug-probe', v_existing_slug, 'eq1s2post31probe',
        'eq1s2post31/duplicate-slug-probe/v1'
      );
      raise exception 'EQ1S2-POST-31: a duplicate equipment_models.slug was unexpectedly accepted.';
    exception when unique_violation then
      null; -- expected: proves equipment_models_slug_unique is enforced live.
    end;
  end;

  select count(*) into v_count from public.equipment_models where canonical_name = 'EQ1S2-POST-31-duplicate-slug-probe';
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-32: the duplicate-slug probe row was unexpectedly persisted (rollback failed).';
  end if;

  -- Live proof that an explicit empty numeric array is actually rejected by
  -- PostgreSQL, not merely declared. Same implicit-savepoint pattern as the
  -- duplicate-slug proof above: on check_violation the failed update is
  -- undone and the outer transaction (this migration) is otherwise
  -- unaffected.
  declare
    v_length_probe_model_id uuid;
    v_original_lengths numeric[];
    v_lengths_after_probe numeric[];
  begin
    select equipment_model_id, standard_lengths_inches
      into v_length_probe_model_id, v_original_lengths
    from public.equipment_putter_model_specs
    where standard_lengths_inches is not null
    order by equipment_model_id
    limit 1;

    if v_length_probe_model_id is null then
      raise exception 'EQ1S2-POST-33: no seeded non-null standard_lengths_inches row exists for the empty-array live probe.';
    end if;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = '{}'::numeric[]
      where equipment_model_id = v_length_probe_model_id;

      raise exception 'EQ1S2-POST-33: an empty standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null; -- expected: proves equipment_putter_model_specs_lengths_nonempty is enforced live.
    end;

    select standard_lengths_inches into v_lengths_after_probe
      from public.equipment_putter_model_specs
      where equipment_model_id = v_length_probe_model_id;

    if v_lengths_after_probe is distinct from v_original_lengths then
      raise exception 'EQ1S2-POST-34: the rejected empty-array probe did not restore the original standard_lengths_inches.';
    end if;
  end;

  -- EQ1-S2-A1-C2: database-level standard-length integrity (function
  -- contract, constraint wiring, privilege boundary, live invalid-array
  -- rejection proofs).
  declare
    v_length_fn_lang name;
    v_length_fn_volatile "char";
    v_length_fn_strict boolean;
    v_length_fn_secdef boolean;
    v_length_fn_def text;
    v_length_fn_args text;
    v_length_fn_ret text;
    v_length_con_def text;
    v_length_valid_probe_model_id uuid;
    v_length_valid_probe_original numeric[];
    v_length_valid_probe_after numeric[];
    v_invalid_row_count integer;
  begin
    select l.lanname, p.provolatile, p.proisstrict, p.prosecdef, pg_catalog.pg_get_functiondef(p.oid),
           pg_catalog.pg_get_function_arguments(p.oid), pg_catalog.pg_get_function_result(p.oid)
      into v_length_fn_lang, v_length_fn_volatile, v_length_fn_strict, v_length_fn_secdef, v_length_fn_def,
           v_length_fn_args, v_length_fn_ret
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.proname = 'is_valid_putter_standard_lengths';

    if v_length_fn_lang is null then
      raise exception 'EQ1S2-POST-35: public.is_valid_putter_standard_lengths does not exist.';
    end if;
    if v_length_fn_lang <> 'sql' then
      raise exception 'EQ1S2-POST-35: expected language sql for is_valid_putter_standard_lengths, found %.', v_length_fn_lang;
    end if;
    if v_length_fn_volatile <> 'i' then
      raise exception 'EQ1S2-POST-35: expected IMMUTABLE volatility, found %.', v_length_fn_volatile;
    end if;
    if not v_length_fn_strict then
      raise exception 'EQ1S2-POST-35: expected STRICT, function is not strict.';
    end if;
    if v_length_fn_secdef then
      raise exception 'EQ1S2-POST-35: expected SECURITY INVOKER, found SECURITY DEFINER.';
    end if;
    if v_length_fn_def not ilike '%set search_path to %''%' then
      raise exception 'EQ1S2-POST-35: is_valid_putter_standard_lengths does not set an empty search_path.';
    end if;
    if v_length_fn_args <> 'p_lengths numeric[]' then
      raise exception 'EQ1S2-POST-35: expected argument p_lengths numeric[], found %.', v_length_fn_args;
    end if;
    if v_length_fn_ret <> 'boolean' then
      raise exception 'EQ1S2-POST-35: expected boolean return type, found %.', v_length_fn_ret;
    end if;

    select pg_catalog.pg_get_constraintdef(con.oid) into v_length_con_def
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'equipment_putter_model_specs'
      and con.conname = 'equipment_putter_model_specs_lengths_valid' and con.contype = 'c';

    if v_length_con_def is null then
      raise exception 'EQ1S2-POST-36: equipment_putter_model_specs_lengths_valid is missing or is not a CHECK constraint.';
    end if;
    if v_length_con_def not ilike '%is_valid_putter_standard_lengths(standard_lengths_inches)%' then
      raise exception 'EQ1S2-POST-36: equipment_putter_model_specs_lengths_valid does not call is_valid_putter_standard_lengths(standard_lengths_inches).';
    end if;

    if exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'is_valid_putter_standard_lengths'
        and grantee in ('PUBLIC','anon','authenticated')
    ) then
      raise exception 'EQ1S2-POST-37: is_valid_putter_standard_lengths remains executable by PUBLIC, anon, or authenticated.';
    end if;

    if not exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = 'is_valid_putter_standard_lengths'
        and grantee = 'service_role' and privilege_type = 'EXECUTE'
    ) then
      raise exception 'EQ1S2-POST-38: service_role is missing EXECUTE on is_valid_putter_standard_lengths.';
    end if;

    select equipment_model_id, standard_lengths_inches
      into v_length_valid_probe_model_id, v_length_valid_probe_original
    from public.equipment_putter_model_specs
    where standard_lengths_inches is not null
    order by equipment_model_id
    limit 1;

    if v_length_valid_probe_model_id is null then
      raise exception 'EQ1S2-POST-39: no seeded non-null standard_lengths_inches row exists for the invalid-array live probes.';
    end if;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[35,34]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-39: an unsorted standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[34,34]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-40: a duplicate-value standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[19]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-41: a below-range standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[61]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-42: an above-range standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[34,null]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-43: a NULL-containing standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    begin
      update public.equipment_putter_model_specs
      set standard_lengths_inches = array[[34,35],[36,37]]::numeric[]
      where equipment_model_id = v_length_valid_probe_model_id;
      raise exception 'EQ1S2-POST-44: a multidimensional standard_lengths_inches array was unexpectedly accepted.';
    exception when check_violation then
      null;
    end;

    select standard_lengths_inches into v_length_valid_probe_after
    from public.equipment_putter_model_specs
    where equipment_model_id = v_length_valid_probe_model_id;

    if v_length_valid_probe_after is distinct from v_length_valid_probe_original then
      raise exception 'EQ1S2-POST-45: the rejected invalid-array probes did not restore the original standard_lengths_inches.';
    end if;

    select count(*) into v_invalid_row_count
    from public.equipment_putter_model_specs
    where standard_lengths_inches is not null
      and not public.is_valid_putter_standard_lengths(standard_lengths_inches);

    if v_invalid_row_count <> 0 then
      raise exception 'EQ1S2-POST-46: % persisted equipment_putter_model_specs row(s) have an invalid standard_lengths_inches value.', v_invalid_row_count;
    end if;
  end;

  select count(*) into v_spec_count from public.equipment_putter_model_specs;
  if v_spec_count <> v_model_count then
    raise exception 'EQ1S2-POST-5: expected % equipment_putter_model_specs rows (one per model), found %.', v_model_count, v_spec_count;
  end if;

  select count(*) into v_source_count from public.equipment_model_sources;
  if v_source_count <> ${sourceCount} then
    raise exception 'EQ1S2-POST-6: expected exactly ${sourceCount} equipment_model_sources rows, found %.', v_source_count;
  end if;

  select count(*) into v_manufacturer_count from public.equipment_manufacturers;
  if v_manufacturer_count <> 5 then
    raise exception 'EQ1S2-POST-7: expected exactly 5 parent manufacturers to remain, found %.', v_manufacturer_count;
  end if;

  if exists (
    select 1 from public.equipment_models m
    where not exists (select 1 from public.equipment_manufacturers mf where mf.id = m.manufacturer_id)
  ) then
    raise exception 'EQ1S2-POST-8: one or more equipment_models rows reference a nonexistent manufacturer.';
  end if;

  select count(*) into v_count from public.equipment_models where club_type <> 'Putter';
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-9: expected every seeded model to have club_type = Putter, found % exceptions.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models m
    where not exists (select 1 from public.equipment_putter_model_specs s where s.equipment_model_id = m.id);
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-10: % model(s) are missing a putter specs row.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models m
    where not exists (select 1 from public.equipment_model_sources s where s.equipment_model_id = m.id);
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-11: % model(s) are missing at least one source row.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where specifications <> '{}'::jsonb;
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-12: % seeded model(s) unexpectedly have a non-empty specifications jsonb.', v_count;
  end if;

  select count(*) into v_count from public.equipment_models where is_active is distinct from true;
  if v_count <> 0 then
    raise exception 'EQ1S2-POST-13: % seeded model(s) are not is_active = true.', v_count;
  end if;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_putter_model_specs' and c.relrowsecurity) then
    raise exception 'EQ1S2-POST-14: RLS is not enabled on public.equipment_putter_model_specs.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'equipment_model_sources' and c.relrowsecurity) then
    raise exception 'EQ1S2-POST-15: RLS is not enabled on public.equipment_model_sources.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('equipment_putter_model_specs','equipment_model_sources') and grantee = 'anon'
  ) then
    raise exception 'EQ1S2-POST-16: anon has an unexpected grant on one of the new tables.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'equipment_putter_model_specs' and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'EQ1S2-POST-17: authenticated has an unexpected write grant on equipment_putter_model_specs.';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'equipment_model_sources' and grantee = 'authenticated'
  ) then
    raise exception 'EQ1S2-POST-18: authenticated unexpectedly has any grant on equipment_model_sources.';
  end if;

  if not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_putter_model_specs' and grantee = 'authenticated' and privilege_type = 'SELECT') then
    raise exception 'EQ1S2-POST-19: authenticated is missing the required SELECT grant on equipment_putter_model_specs.';
  end if;

  if not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_putter_model_specs' and grantee = 'service_role')
     or not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'equipment_model_sources' and grantee = 'service_role') then
    raise exception 'EQ1S2-POST-20: service_role is missing access on one or both new tables.';
  end if;

  for v_fn in
    select p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_putter_model_specs_club_type'
  loop
    if v_fn.def ilike '%security definer%' then
      raise exception 'EQ1S2-POST-21: function % is unexpectedly SECURITY DEFINER.', v_fn.proname;
    end if;
    if v_fn.def not ilike '%set search_path to %''%' then
      raise exception 'EQ1S2-POST-22: function % does not set an empty search_path.', v_fn.proname;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'guard_putter_model_specs_club_type'
      and grantee in ('PUBLIC','anon','authenticated')
  ) then
    raise exception 'EQ1S2-POST-23: guard_putter_model_specs_club_type remains executable by PUBLIC, anon, or authenticated.';
  end if;

  if to_regclass('public.equipment_manufacturer_aliases') is not null or to_regclass('public.equipment_model_aliases') is not null then
    raise exception 'EQ1S2-POST-24: an alias table exists but was not authorized for EQ1-S2.';
  end if;

  select count(*) into v_count from public.user_equipment where updated_at > (select min(created_at) from public.user_equipment);
  -- informational only; no user_equipment row is touched by this migration, verified structurally below.

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name in ('user_equipment','swing_analysis','user_bags','user_clubs')
      and column_name in ('catalog_key','brand_line','model_family','release_year')
  ) then
    raise exception 'EQ1S2-POST-25: a user-owned table unexpectedly gained an EQ1-S2 column.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'swing_analysis' and column_name = 'equipment_snapshot'
  ) then
    raise exception 'EQ1S2-POST-26: swing_analysis.equipment_snapshot is unexpectedly missing.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'apply_swing_analysis_equipment_snapshot',
      'guard_swing_analysis_equipment_immutability',
      'validate_user_equipment_catalog_reference'
    )
  ) then
    raise exception 'EQ1S2-POST-27: one or more EQ1-S1R trigger functions are unexpectedly missing.';
  end if;

  select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'swing_analysis' and column_name = 'analysis_mode' and data_type = 'text';
  if v_count <> 1 then
    raise exception 'EQ1S2-POST-28: swing_analysis.analysis_mode changed unexpectedly during this migration.';
  end if;

  raise notice 'EQ1S2-POST-OK: putter catalog v1 verified (% models, % specs, % sources, 5 manufacturers).', v_model_count, v_spec_count, v_source_count;
end $$;

commit;
`;

  return sql.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  verifyKnownVector();
  const data = validateAndLoad();
  const sql = buildSql(data);
  const migrationPath = findMigrationPath();

  if (CHECK_MODE) {
    let existing;
    try {
      existing = readFileSync(migrationPath, "utf8");
    } catch {
      console.error(`CHECK FAILED: migration file not found at ${migrationPath}`);
      process.exit(1);
    }
    if (existing !== sql) {
      console.error(`CHECK FAILED: generated SQL drifted from ${migrationPath}`);
      process.exit(1);
    }
    console.log(`CHECK OK: ${migrationPath} matches the generator output exactly.`);
    return;
  }

  writeFileSync(migrationPath, sql, { encoding: "utf8" });
  console.log(`Generated ${migrationPath} (${data.models.length} models).`);
}

main();
