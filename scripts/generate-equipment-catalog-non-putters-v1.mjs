// Deterministic generator for the EQ Slice-2 non-putter canonical catalog.
//
// Reads data/equipment-catalog-non-putters-v1.json, validates it against the
// locked Slice-2 contract, derives RFC 4122 UUIDv5 identifiers for the new
// manufacturer, every model and every provenance source, and emits the exact
// append-only data migration.
//
// Usage:
//   node scripts/generate-equipment-catalog-non-putters-v1.mjs
//   node scripts/generate-equipment-catalog-non-putters-v1.mjs --check
//
// --check re-derives the migration and compares it byte-for-byte with the file
// on disk. It never writes.
//
// This generator is intentionally standalone. The putter generator
// (scripts/generate-equipment-catalog-putters-v1.mjs) is a closed artifact:
// duplicating a handful of small deterministic validators here is safer than
// reopening it to share code.
//
// Node built-ins only. No network access at any point.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const SOURCE_JSON = path.join(repoRoot, "data", "equipment-catalog-non-putters-v1.json");
const PUTTER_JSON = path.join(repoRoot, "data", "equipment-catalog-putters-v1.json");
const MIGRATION_PATH = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20260820132900_equipment_non_putter_catalog_v1.sql"
);

const CHECK_MODE = process.argv.includes("--check");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// RFC 4122 UUIDv5
// ---------------------------------------------------------------------------

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  assert(/^[0-9a-f]{32}$/.test(hex), `not a uuid: ${uuid}`);
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

// Known-vector self-check, run unconditionally at execution time. If the UUIDv5
// implementation ever drifts, every generated identity would silently change.
(function selfCheckUuidv5() {
  const dnsNamespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const expected = "886313e1-3b8a-5372-9b90-0c9aee199e5d";
  const actual = uuidv5(dnsNamespace, "python.org");
  assert(
    actual === expected,
    `UUIDv5 known-vector check failed: expected ${expected}, got ${actual}`
  );
})();

// ---------------------------------------------------------------------------
// Locked Slice-2 vocabulary and limits
// ---------------------------------------------------------------------------

const UUID_NAMESPACE = "05690d1f-f17d-5ab8-a2b6-ef0328a2783a";
const CATALOG_NAME = "equipment-catalog-non-putters-v1";
const VERIFIED_ON = "2026-08-20";

// The six locked Slice-2 parent manufacturers. Five already exist canonically;
// Cobra is introduced by this slice.
const ALLOWED_MANUFACTURER_SLUGS = [
  "callaway",
  "cobra",
  "mizuno",
  "ping",
  "taylormade",
  "titleist",
];

const INCUMBENT_MANUFACTURER_SLUGS = [
  "callaway",
  "mizuno",
  "ping",
  "taylormade",
  "titleist",
];

const NEW_MANUFACTURER_SLUG = "cobra";

// Slice 2 is non-putter only. Putter is deliberately absent: putter coverage is
// the closed EQ1-S2 artifact family and must not be touched here.
const ALLOWED_CLUB_TYPES = ["Driver", "Wood", "Hybrid", "Iron", "Wedge"];

const CLUB_TYPE_ENUM_VALUES = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"];

// Coverage rule: every manufacturer x club-type cell carries at least one and at
// most four rows, under a hard overall ceiling. This v1 artifact implements the
// minimum valid catalog: exactly one row per cell.
const MIN_ROWS_PER_CELL = 1;
const MAX_ROWS_PER_CELL = 4;
const MAX_TOTAL_MODELS = 90;
const EXPECTED_V1_MODEL_COUNT = 30;

const ALLOWED_SOURCE_TYPES = ["official_product_page", "official_spec_pdf", "official_archive"];

// Official manufacturer / official sub-brand domains only. Retailers,
// marketplaces, review sites, forums, search pages and affiliate hosts are never
// acceptable provenance. Anti-bot/CDN/challenge hosts are infrastructure, never
// provenance, and are deliberately absent.
const ALLOWED_SOURCE_DOMAINS = [
  "taylormadegolf.com",
  "www.taylormadegolf.com",
  "callawaygolf.com",
  "www.callawaygolf.com",
  "titleist.com",
  "www.titleist.com",
  "ping.com",
  "www.ping.com",
  "mizunogolf.com",
  "www.mizunogolf.com",
  "cobragolf.com",
  "www.cobragolf.com",
];

const TRACKING_QUERY_PARAM_PATTERN =
  /(?:^|[?&])(utm_[a-z]+|aff|affid|affiliate|ref|clickid|gclid|fbclid|irclickid)=/i;

// Commercial / editorial fields that must never enter canonical catalog data.
const PROHIBITED_FIELD_NAMES = new Set([
  "price", "retail_price", "inventory", "stock",
  "affiliate", "affiliate_url", "tracking", "tracking_url",
  "sponsorship", "sponsor", "ranking", "tour_usage",
  "endorsement", "player_recommendation", "marketing_copy", "description",
  "image", "image_url", "logo", "logo_url",
  "ai_score", "recommended_player", "fitting_conclusion",
  // Fitting parameters are golfer customization on user_equipment, never
  // catalog identity.
  "loft", "lofts", "loft_options", "shaft", "shafts", "shaft_flex",
  "shaft_flex_options", "shaft_weight", "club_number", "sku", "grind", "grinds",
  "bounce", "putter_specs",
]);

const TOP_LEVEL_FIELDS = new Set([
  "schema_version", "catalog_name", "uuid_namespace", "verified_on",
  "manufacturers", "models",
]);

const MANUFACTURER_FIELDS = new Set(["canonical_name", "slug", "normalized_name"]);

const MODEL_FIELDS = new Set([
  "catalog_key", "manufacturer_slug", "club_type", "brand_line", "brand_line_slug",
  "model_family", "model_family_slug", "canonical_name", "slug", "normalized_name",
  "model_year", "release_year", "is_active", "specifications", "sources",
]);

const SOURCE_FIELDS = new Set(["source_type", "source_name", "source_url", "verified_at"]);

const CATALOG_KEY_PATTERN = /^[a-z0-9]+(\/[a-z0-9-]+)+$/;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function rejectUnknownFields(object, allowed, context) {
  for (const key of Object.keys(object)) {
    assert(!PROHIBITED_FIELD_NAMES.has(key), `${context}: prohibited field "${key}"`);
    assert(allowed.has(key), `${context}: unknown field "${key}"`);
  }
  for (const key of allowed) {
    assert(key in object, `${context}: missing field "${key}"`);
  }
}

function normalizeName(canonicalName) {
  return canonicalName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function validateSourceUrl(url, context) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${context}: source_url is not a valid URL: ${url}`);
  }
  assert(parsed.protocol === "https:", `${context}: source_url must be HTTPS: ${url}`);
  assert(
    ALLOWED_SOURCE_DOMAINS.includes(parsed.hostname),
    `${context}: source_url domain "${parsed.hostname}" is not on the official-domain allowlist`
  );
  assert(
    !TRACKING_QUERY_PARAM_PATTERN.test(parsed.search),
    `${context}: source_url contains a tracking/affiliate query parameter: ${url}`
  );
  assert(parsed.hash === "", `${context}: source_url must not contain a fragment: ${url}`);
  return parsed;
}

function validateDateNotFuture(value, context) {
  assert(ISO_DATE_PATTERN.test(value), `${context}: expected an ISO date, got "${value}"`);
  assert(
    value <= VERIFIED_ON,
    `${context}: verified_at "${value}" is later than the catalog verification date ${VERIFIED_ON}`
  );
}

// ---------------------------------------------------------------------------
// Load and validate the catalog source
// ---------------------------------------------------------------------------

function loadCatalog() {
  const raw = fs.readFileSync(SOURCE_JSON, "utf8");
  assert(!raw.includes("\r"), "source JSON must use LF line endings");
  const data = JSON.parse(raw);

  rejectUnknownFields(data, TOP_LEVEL_FIELDS, "root");
  assert(data.schema_version === 1, "root: schema_version must be 1");
  assert(data.catalog_name === CATALOG_NAME, `root: catalog_name must be ${CATALOG_NAME}`);
  assert(data.uuid_namespace === UUID_NAMESPACE, "root: uuid_namespace mismatch");
  assert(data.verified_on === VERIFIED_ON, `root: verified_on must be ${VERIFIED_ON}`);

  // -- manufacturers ---------------------------------------------------------
  assert(Array.isArray(data.manufacturers), "root: manufacturers must be an array");
  assert(
    data.manufacturers.length === 1,
    `root: expected exactly one new manufacturer, found ${data.manufacturers.length}`
  );
  const manufacturer = data.manufacturers[0];
  rejectUnknownFields(manufacturer, MANUFACTURER_FIELDS, "manufacturer");
  assert(
    manufacturer.slug === NEW_MANUFACTURER_SLUG,
    `manufacturer: the only new parent manufacturer must be "${NEW_MANUFACTURER_SLUG}"`
  );
  assert(SLUG_PATTERN.test(manufacturer.slug), "manufacturer: slug format");
  assert(manufacturer.canonical_name.trim() !== "", "manufacturer: canonical_name must be non-blank");
  assert(
    manufacturer.normalized_name === normalizeName(manufacturer.canonical_name),
    "manufacturer: normalized_name is not the deterministic normalization of canonical_name"
  );

  // -- models ----------------------------------------------------------------
  assert(Array.isArray(data.models), "root: models must be an array");
  assert(
    data.models.length === EXPECTED_V1_MODEL_COUNT,
    `root: this v1 artifact must contain exactly ${EXPECTED_V1_MODEL_COUNT} models, found ${data.models.length}`
  );
  assert(
    data.models.length <= MAX_TOTAL_MODELS,
    `root: model count exceeds the ${MAX_TOTAL_MODELS}-row ceiling`
  );

  const catalogKeys = new Set();
  const slugs = new Set();
  const identities = new Set();
  const cellCounts = new Map();

  for (const model of data.models) {
    const context = `model ${model.catalog_key ?? "(unknown)"}`;
    rejectUnknownFields(model, MODEL_FIELDS, context);

    assert(CATALOG_KEY_PATTERN.test(model.catalog_key), `${context}: catalog_key format`);
    assert(!catalogKeys.has(model.catalog_key), `${context}: duplicate catalog_key`);
    catalogKeys.add(model.catalog_key);

    assert(
      ALLOWED_MANUFACTURER_SLUGS.includes(model.manufacturer_slug),
      `${context}: manufacturer_slug "${model.manufacturer_slug}" is outside the locked six-manufacturer vocabulary`
    );

    assert(
      ALLOWED_CLUB_TYPES.includes(model.club_type),
      `${context}: club_type "${model.club_type}" is not a Slice-2 non-putter club type`
    );
    assert(model.club_type !== "Putter", `${context}: Slice 2 must not contain Putter rows`);

    assert(SLUG_PATTERN.test(model.slug), `${context}: slug format`);
    assert(!slugs.has(model.slug), `${context}: duplicate slug "${model.slug}"`);
    slugs.add(model.slug);

    assert(model.canonical_name.trim() !== "", `${context}: canonical_name must be non-blank`);
    assert(
      model.normalized_name === normalizeName(model.canonical_name),
      `${context}: normalized_name is not the deterministic normalization of canonical_name`
    );

    // brand_line / model_family are value+slug pairs: both present or both null.
    if (model.brand_line === null) {
      assert(model.brand_line_slug === null, `${context}: brand_line_slug must be null when brand_line is null`);
    } else {
      assert(typeof model.brand_line === "string" && model.brand_line.trim() !== "", `${context}: brand_line must be a non-blank string`);
      assert(SLUG_PATTERN.test(model.brand_line_slug ?? ""), `${context}: brand_line_slug format`);
    }
    if (model.model_family === null) {
      assert(model.model_family_slug === null, `${context}: model_family_slug must be null when model_family is null`);
    } else {
      assert(typeof model.model_family === "string" && model.model_family.trim() !== "", `${context}: model_family must be a non-blank string`);
      assert(SLUG_PATTERN.test(model.model_family_slug ?? ""), `${context}: model_family_slug format`);
    }

    // Slice-2 v1 carries identity only. Years are catalog metadata that the
    // official identity sources do not establish, so they stay null.
    assert(model.model_year === null, `${context}: model_year must be null in this v1 artifact`);
    assert(model.release_year === null, `${context}: release_year must be null in this v1 artifact`);
    assert(model.is_active === true, `${context}: is_active must be true`);

    assert(
      model.specifications !== null &&
        typeof model.specifications === "object" &&
        !Array.isArray(model.specifications) &&
        Object.keys(model.specifications).length === 0,
      `${context}: specifications must be an empty object in this v1 artifact`
    );

    const identity = [
      model.manufacturer_slug,
      model.club_type,
      model.normalized_name,
      model.model_year ?? 0,
    ].join("|");
    assert(!identities.has(identity), `${context}: duplicate manufacturer/club_type/name/year identity`);
    identities.add(identity);

    const cell = `${model.manufacturer_slug}|${model.club_type}`;
    cellCounts.set(cell, (cellCounts.get(cell) ?? 0) + 1);

    // -- sources -------------------------------------------------------------
    assert(Array.isArray(model.sources), `${context}: sources must be an array`);
    assert(
      model.sources.length === 1,
      `${context}: this v1 artifact requires exactly one official source per model, found ${model.sources.length}`
    );
    for (const source of model.sources) {
      rejectUnknownFields(source, SOURCE_FIELDS, `${context} source`);
      assert(
        ALLOWED_SOURCE_TYPES.includes(source.source_type),
        `${context}: source_type "${source.source_type}" is not an accepted official source class`
      );
      assert(source.source_name.trim() !== "", `${context}: source_name must be non-blank`);
      const parsed = validateSourceUrl(source.source_url, context);
      if (source.source_type === "official_spec_pdf") {
        assert(
          parsed.pathname.toLowerCase().endsWith(".pdf"),
          `${context}: official_spec_pdf requires a URL pathname ending in .pdf`
        );
      }
      validateDateNotFuture(source.verified_at, `${context} source`);
    }
  }

  // -- coverage matrix -------------------------------------------------------
  const expectedCells = ALLOWED_MANUFACTURER_SLUGS.length * ALLOWED_CLUB_TYPES.length;
  assert(
    cellCounts.size === expectedCells,
    `coverage: expected ${expectedCells} populated manufacturer/club-type cells, found ${cellCounts.size}`
  );
  for (const manufacturerSlug of ALLOWED_MANUFACTURER_SLUGS) {
    for (const clubType of ALLOWED_CLUB_TYPES) {
      const count = cellCounts.get(`${manufacturerSlug}|${clubType}`) ?? 0;
      assert(
        count >= MIN_ROWS_PER_CELL,
        `coverage: ${manufacturerSlug} / ${clubType} has no canonical model`
      );
      assert(
        count <= MAX_ROWS_PER_CELL,
        `coverage: ${manufacturerSlug} / ${clubType} exceeds the ${MAX_ROWS_PER_CELL}-row per-cell ceiling`
      );
    }
  }

  return data;
}

// The protected putter artifact is the authority for the 21 catalog keys that
// must already be present. It is read here and never written.
function loadExistingPutterCatalogKeys() {
  const putters = JSON.parse(fs.readFileSync(PUTTER_JSON, "utf8"));
  const keys = putters.models.map((model) => model.catalog_key).sort();
  assert(keys.length === 21, `putter catalog: expected 21 models, found ${keys.length}`);
  return keys;
}

// ---------------------------------------------------------------------------
// SQL rendering
// ---------------------------------------------------------------------------

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlLiteralOrNull(value) {
  return value === null || value === undefined ? "null" : sqlString(value);
}

function manufacturerIdExpression(slug) {
  // Incumbent manufacturer ids were created under the pre-existing
  // gen_random_uuid() default and are not deterministic across environments.
  // Every model therefore resolves its parent by canonical slug — including
  // Cobra, whose own row is inserted with a deterministic id above.
  return `(select id from public.equipment_manufacturers where slug = ${sqlString(slug)})`;
}

function buildMigration(data, putterCatalogKeys) {
  const manufacturer = data.manufacturers[0];
  const manufacturerId = uuidv5(UUID_NAMESPACE, `manufacturer:${manufacturer.slug}`);

  const models = [...data.models].sort((a, b) => (a.catalog_key < b.catalog_key ? -1 : 1));
  const modelRows = models.map((model) => ({
    ...model,
    id: uuidv5(UUID_NAMESPACE, `model:${model.catalog_key}`),
  }));

  const sourceRows = [];
  for (const model of modelRows) {
    for (const source of model.sources) {
      sourceRows.push({
        id: uuidv5(UUID_NAMESPACE, `source:${model.catalog_key}:${source.source_url}`),
        modelId: model.id,
        catalogKey: model.catalog_key,
        ...source,
      });
    }
  }
  sourceRows.sort((a, b) =>
    a.catalogKey === b.catalogKey
      ? a.source_url < b.source_url
        ? -1
        : 1
      : a.catalogKey < b.catalogKey
        ? -1
        : 1
  );

  const clubTypeCounts = new Map();
  for (const model of modelRows) {
    clubTypeCounts.set(model.club_type, (clubTypeCounts.get(model.club_type) ?? 0) + 1);
  }

  const L = [];
  const w = (line = "") => L.push(line);

  w("-- ============================================================================");
  w("-- EQ Slice 2 — non-putter canonical equipment catalog v1");
  w("--");
  w("-- GENERATED FILE — DO NOT HAND-EDIT.");
  w("-- Source of truth : data/equipment-catalog-non-putters-v1.json");
  w("-- Generator       : scripts/generate-equipment-catalog-non-putters-v1.mjs");
  w("--");
  w("-- This migration is DATA-ONLY, transactional, append-only and fail-loud. It");
  w("-- creates no schema object, alters nothing, and deletes nothing. It inserts:");
  w("--");
  w(`--   1  new parent manufacturer  (${manufacturer.canonical_name})`);
  w(`--   ${modelRows.length} non-putter equipment_models`);
  w(`--   ${sourceRows.length} equipment_model_sources`);
  w("--");
  w("-- Identity is deterministic. Every model and source id is an RFC 4122 UUIDv5");
  w(`-- derived from namespace ${UUID_NAMESPACE}`);
  w("-- over \"model:<catalog_key>\" and \"source:<catalog_key>:<source_url>\". The new");
  w("-- manufacturer id derives from \"manufacturer:<slug>\". The five incumbent");
  w("-- manufacturer ids were created under the pre-existing gen_random_uuid()");
  w("-- default, are NOT deterministic across environments, and are never rewritten");
  w("-- here: models resolve their parent by canonical slug instead.");
  w("--");
  w("-- Loft, shaft flex, shaft weight, club number and retail SKU are golfer-level");
  w("-- customization on public.user_equipment. They are never canonical identity and");
  w("-- appear nowhere in this migration.");
  w("--");
  w("-- Putter coverage is the closed EQ1-S2 artifact family. This migration adds no");
  w("-- Putter row and touches no existing putter row or putter-spec row.");
  w("-- ============================================================================");
  w();
  w("begin;");
  w();

  // -- preconditions ---------------------------------------------------------
  w("-- ----------------------------------------------------------------------------");
  w("-- Preconditions — refuse to apply against anything but the exact intended");
  w("-- foundation.");
  w("-- ----------------------------------------------------------------------------");
  w();
  w("do $$");
  w("declare");
  w("  v_count bigint;");
  w("  v_slugs text[];");
  w("  v_expected_putter_keys text[] := array[");
  putterCatalogKeys.forEach((key, index) => {
    const comma = index === putterCatalogKeys.length - 1 ? "" : ",";
    w(`    ${sqlString(key)}${comma}`);
  });
  w("  ];");
  w("  v_actual_putter_keys text[];");
  w("  v_enum text[];");
  w("begin");
  w("  -- Required tables.");
  for (const table of [
    "equipment_manufacturers",
    "equipment_models",
    "equipment_putter_model_specs",
    "equipment_model_sources",
    "user_equipment",
  ]) {
    w(`  if to_regclass('public.${table}') is null then`);
    w(`    raise exception 'EQ2S2-PRE-1: public.${table} does not exist.';`);
    w("  end if;");
  }
  w();
  w("  -- club_type_enum still carries exactly the six expected values, in order.");
  w("  select array_agg(e.enumlabel::text order by e.enumsortorder) into v_enum");
  w("    from pg_enum e");
  w("    join pg_type t on t.oid = e.enumtypid");
  w("    join pg_namespace n on n.oid = t.typnamespace");
  w("   where n.nspname = 'public' and t.typname = 'club_type_enum';");
  w(`  if v_enum is distinct from array[${CLUB_TYPE_ENUM_VALUES.map(sqlString).join(", ")}]::text[] then`);
  w("    raise exception 'EQ2S2-PRE-2: public.club_type_enum values have changed from the expected six values.';");
  w("  end if;");
  w();
  w("  -- Required identity constraints/indexes still exist.");
  for (const conname of [
    "equipment_models_catalog_key_unique",
    "equipment_models_slug_unique",
  ]) {
    w(`  if not exists (`);
    w(`    select 1 from pg_constraint c`);
    w(`    join pg_class rel on rel.oid = c.conrelid`);
    w(`    join pg_namespace nsp on nsp.oid = rel.relnamespace`);
    w(`    where nsp.nspname = 'public' and rel.relname = 'equipment_models' and c.conname = '${conname}'`);
    w(`  ) then`);
    w(`    raise exception 'EQ2S2-PRE-3: constraint ${conname} is missing.';`);
    w("  end if;");
  }
  w("  if not exists (");
  w("    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace");
  w("    where n.nspname = 'public' and c.relname = 'equipment_models_manufacturer_type_name_year_uidx'");
  w("  ) then");
  w("    raise exception 'EQ2S2-PRE-4: index equipment_models_manufacturer_type_name_year_uidx is missing.';");
  w("  end if;");
  w();
  w("  -- Exactly the five incumbent manufacturers, and no Cobra yet.");
  w("  select array_agg(slug order by slug) into v_slugs from public.equipment_manufacturers;");
  w(`  if v_slugs is distinct from array[${INCUMBENT_MANUFACTURER_SLUGS.map(sqlString).join(", ")}]::text[] then`);
  w("    raise exception 'EQ2S2-PRE-5: expected exactly the five incumbent manufacturer slugs, found %.', v_slugs;");
  w("  end if;");
  w();
  w(`  select count(*) into v_count from public.equipment_manufacturers where slug = ${sqlString(NEW_MANUFACTURER_SLUG)};`);
  w("  if v_count <> 0 then");
  w(`    raise exception 'EQ2S2-PRE-6: manufacturer ${NEW_MANUFACTURER_SLUG} already exists; this migration inserts it and must not be re-applied.';`);
  w("  end if;");
  w();
  w("  -- Exactly the 21 existing putter models, and nothing else.");
  w("  select count(*) into v_count from public.equipment_models;");
  w("  if v_count <> 21 then");
  w("    raise exception 'EQ2S2-PRE-7: expected exactly 21 existing equipment_models rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2S2-PRE-8: expected zero non-Putter equipment_models rows before this migration, found %.', v_count;");
  w("  end if;");
  w();
  w("  select array_agg(catalog_key order by catalog_key) into v_actual_putter_keys from public.equipment_models;");
  w("  if v_actual_putter_keys is distinct from v_expected_putter_keys then");
  w("    raise exception 'EQ2S2-PRE-9: the existing 21 putter catalog_key set does not match the expected putter catalog artifact.';");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_putter_model_specs;");
  w("  if v_count <> 21 then");
  w("    raise exception 'EQ2S2-PRE-10: expected exactly 21 equipment_putter_model_specs rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_model_sources;");
  w("  if v_count <> 21 then");
  w("    raise exception 'EQ2S2-PRE-11: expected exactly 21 equipment_model_sources rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  -- User-equipment guard. Deliberately scoped to canonical model references");
  w("  -- only: staging holds zero user_equipment rows while production holds real");
  w("  -- rows, so a total row-count assertion would make this file environment-");
  w("  -- specific. manufacturer_id may legitimately be populated already.");
  w("  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2S2-PRE-12: expected zero user_equipment rows referencing an equipment_model, found %.', v_count;");
  w("  end if;");
  w("end $$;");
  w();

  // -- manufacturer insert ---------------------------------------------------
  w("-- ----------------------------------------------------------------------------");
  w("-- 1. New parent manufacturer (deterministic UUIDv5 identity)");
  w("-- ----------------------------------------------------------------------------");
  w();
  w("insert into public.equipment_manufacturers (id, canonical_name, slug, normalized_name)");
  w("values");
  w(
    `  (${sqlString(manufacturerId)}, ${sqlString(manufacturer.canonical_name)}, ` +
      `${sqlString(manufacturer.slug)}, ${sqlString(manufacturer.normalized_name)});`
  );
  w();

  // -- model insert ----------------------------------------------------------
  w("-- ----------------------------------------------------------------------------");
  w(`-- 2. Non-putter equipment models (${modelRows.length} rows, generated — do not hand-edit)`);
  w("-- ----------------------------------------------------------------------------");
  w();
  w("insert into public.equipment_models (");
  w("  id, manufacturer_id, club_type, canonical_name, slug, normalized_name,");
  w("  model_year, specifications, is_active,");
  w("  catalog_key, brand_line, brand_line_slug, model_family, model_family_slug, release_year");
  w(")");
  w("values");
  modelRows.forEach((model, index) => {
    const terminator = index === modelRows.length - 1 ? ";" : ",";
    w(
      `  (${sqlString(model.id)}, ${manufacturerIdExpression(model.manufacturer_slug)}, ` +
        `${sqlString(model.club_type)}::public.club_type_enum, ${sqlString(model.canonical_name)}, ` +
        `${sqlString(model.slug)}, ${sqlString(model.normalized_name)}, ` +
        `${model.model_year === null ? "null" : model.model_year}, '{}'::jsonb, ${model.is_active}, ` +
        `${sqlString(model.catalog_key)}, ${sqlLiteralOrNull(model.brand_line)}, ` +
        `${sqlLiteralOrNull(model.brand_line_slug)}, ${sqlLiteralOrNull(model.model_family)}, ` +
        `${sqlLiteralOrNull(model.model_family_slug)}, ` +
        `${model.release_year === null ? "null" : model.release_year})${terminator}`
    );
  });
  w();

  // -- source insert ---------------------------------------------------------
  w("-- ----------------------------------------------------------------------------");
  w(`-- 3. Official identity provenance (${sourceRows.length} rows, one per model)`);
  w("--");
  w("-- Every row cites a directly observed official manufacturer resource that");
  w("-- establishes the product's identity. No performance claim, loft, shaft option,");
  w("-- price or marketing statement is imported from any of them.");
  w("-- ----------------------------------------------------------------------------");
  w();
  w("insert into public.equipment_model_sources (");
  w("  id, equipment_model_id, source_type, source_name, source_url, verified_at");
  w(")");
  w("values");
  sourceRows.forEach((source, index) => {
    const terminator = index === sourceRows.length - 1 ? ";" : ",";
    w(
      `  (${sqlString(source.id)}, ${sqlString(source.modelId)}, ${sqlString(source.source_type)}, ` +
        `${sqlString(source.source_name)}, ${sqlString(source.source_url)}, ` +
        `${sqlString(source.verified_at)}::date)${terminator}`
    );
  });
  w();

  // -- postconditions --------------------------------------------------------
  w("-- ----------------------------------------------------------------------------");
  w("-- Postconditions — prove the exact intended row set landed and nothing else");
  w("-- moved. Stated as canonical identity / expected row-set preservation, never as");
  w("-- a claim about physical PostgreSQL row storage.");
  w("-- ----------------------------------------------------------------------------");
  w();
  w("do $$");
  w("declare");
  w("  v_count bigint;");
  w("  v_expected_putter_keys text[] := array[");
  putterCatalogKeys.forEach((key, index) => {
    const comma = index === putterCatalogKeys.length - 1 ? "" : ",";
    w(`    ${sqlString(key)}${comma}`);
  });
  w("  ];");
  w("  v_actual_putter_keys text[];");
  w("begin");
  w("  select count(*) into v_count from public.equipment_manufacturers;");
  w("  if v_count <> 6 then");
  w("    raise exception 'EQ2S2-POST-1: expected exactly 6 equipment_manufacturers rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_manufacturers");
  w(`   where id = ${sqlString(manufacturerId)}`);
  w(`     and canonical_name = ${sqlString(manufacturer.canonical_name)}`);
  w(`     and slug = ${sqlString(manufacturer.slug)}`);
  w(`     and normalized_name = ${sqlString(manufacturer.normalized_name)};`);
  w("  if v_count <> 1 then");
  w("    raise exception 'EQ2S2-POST-2: the new manufacturer row is missing or does not match its deterministic identity.';");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models;");
  w("  if v_count <> 51 then");
  w("    raise exception 'EQ2S2-POST-3: expected exactly 51 equipment_models rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models where club_type = 'Putter'::public.club_type_enum;");
  w("  if v_count <> 21 then");
  w("    raise exception 'EQ2S2-POST-4: expected exactly 21 Putter models, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;");
  w(`  if v_count <> ${modelRows.length} then`);
  w(`    raise exception 'EQ2S2-POST-5: expected exactly ${modelRows.length} non-Putter models, found %.', v_count;`);
  w("  end if;");
  w();
  for (const clubType of ALLOWED_CLUB_TYPES) {
    const expected = clubTypeCounts.get(clubType) ?? 0;
    w(`  select count(*) into v_count from public.equipment_models where club_type = ${sqlString(clubType)}::public.club_type_enum;`);
    w(`  if v_count <> ${expected} then`);
    w(`    raise exception 'EQ2S2-POST-6: expected exactly ${expected} ${clubType} models, found %.', v_count;`);
    w("  end if;");
  }
  w();
  w("  -- Every locked manufacturer/club-type cell carries exactly one non-putter row.");
  w("  select count(*) into v_count from (");
  w("    select m.manufacturer_id, m.club_type");
  w("      from public.equipment_models m");
  w("     where m.club_type <> 'Putter'::public.club_type_enum");
  w("     group by m.manufacturer_id, m.club_type");
  w("    having count(*) <> 1");
  w("  ) as offending_cells;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2S2-POST-7: % manufacturer/club-type cells do not hold exactly one non-putter model.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_putter_model_specs;");
  w("  if v_count <> 21 then");
  w("    raise exception 'EQ2S2-POST-8: expected exactly 21 equipment_putter_model_specs rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_model_sources;");
  w("  if v_count <> 51 then");
  w("    raise exception 'EQ2S2-POST-9: expected exactly 51 equipment_model_sources rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  -- Each new model resolves to its expected deterministic identity, and carries");
  w("  -- exactly one provenance row with the expected deterministic source id.");
  modelRows.forEach((model) => {
    w(`  select count(*) into v_count from public.equipment_models`);
    w(`   where id = ${sqlString(model.id)} and catalog_key = ${sqlString(model.catalog_key)}`);
    w(`     and club_type = ${sqlString(model.club_type)}::public.club_type_enum`);
    w(`     and canonical_name = ${sqlString(model.canonical_name)};`);
    w("  if v_count <> 1 then");
    w(`    raise exception 'EQ2S2-POST-10: expected model ${model.catalog_key} at its deterministic identity.';`);
    w("  end if;");
  });
  w();
  sourceRows.forEach((source) => {
    w(`  select count(*) into v_count from public.equipment_model_sources`);
    w(`   where id = ${sqlString(source.id)} and equipment_model_id = ${sqlString(source.modelId)}`);
    w(`     and source_url = ${sqlString(source.source_url)};`);
    w("  if v_count <> 1 then");
    w(`    raise exception 'EQ2S2-POST-11: expected the deterministic provenance row for ${source.catalogKey}.';`);
    w("  end if;");
  });
  w();
  w("  select count(*) into v_count from (");
  w("    select s.equipment_model_id");
  w("      from public.equipment_model_sources s");
  w("      join public.equipment_models m on m.id = s.equipment_model_id");
  w("     where m.club_type <> 'Putter'::public.club_type_enum");
  w("     group by s.equipment_model_id");
  w("    having count(*) <> 1");
  w("  ) as offending_sources;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2S2-POST-12: % non-putter models do not have exactly one provenance row.', v_count;");
  w("  end if;");
  w();
  w("  -- The original 21 putter identities remain present and unmodified in identity.");
  w("  select array_agg(catalog_key order by catalog_key) into v_actual_putter_keys");
  w("    from public.equipment_models where club_type = 'Putter'::public.club_type_enum;");
  w("  if v_actual_putter_keys is distinct from v_expected_putter_keys then");
  w("    raise exception 'EQ2S2-POST-13: the original 21 putter catalog_key set is no longer intact.';");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_putter_model_specs s");
  w("    join public.equipment_models m on m.id = s.equipment_model_id");
  w("   where m.club_type = 'Putter'::public.club_type_enum;");
  w("  if v_count <> 21 then");
  w("    raise exception 'EQ2S2-POST-14: expected all 21 putter-spec relationships to remain intact, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2S2-POST-15: this migration must not link any user_equipment row to a catalog model, found %.', v_count;");
  w("  end if;");
  w("end $$;");
  w();
  w("commit;");

  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const data = loadCatalog();
  const putterCatalogKeys = loadExistingPutterCatalogKeys();
  const migration = buildMigration(data, putterCatalogKeys);

  assert(!migration.includes("\r"), "generated migration must use LF line endings");
  assert(migration.endsWith("\n"), "generated migration must end with a newline");
  assert(!migration.endsWith("\n\n"), "generated migration must end with exactly one newline");

  if (CHECK_MODE) {
    assert(
      fs.existsSync(MIGRATION_PATH),
      `--check: ${path.relative(repoRoot, MIGRATION_PATH)} does not exist`
    );
    const onDisk = fs.readFileSync(MIGRATION_PATH, "utf8");
    if (onDisk !== migration) {
      throw new Error(
        `--check: ${path.relative(repoRoot, MIGRATION_PATH)} is out of date. Re-run the generator without --check.`
      );
    }
    process.stdout.write(
      `OK  ${path.relative(repoRoot, MIGRATION_PATH)} matches the generated output byte-for-byte.\n`
    );
    return;
  }

  fs.writeFileSync(MIGRATION_PATH, migration, "utf8");
  process.stdout.write(
    `Wrote ${path.relative(repoRoot, MIGRATION_PATH)} (${Buffer.byteLength(migration, "utf8")} bytes).\n`
  );
}

main();
