// Deterministic generator for the EQ-S2-C non-putter canonical catalog
// expansion (v2).
//
// Reads data/equipment-catalog-non-putters-v2.json — the accepted 201-model
// additive delta — validates it against the locked EQ-S2-C contract, validates
// it against the two closed v1 catalogs it must never collide with, derives RFC
// 4122 UUIDv5 identities for every model and every provenance source, and
// renders the future append-only data migration entirely in memory.
//
// Usage:
//   node scripts/generate-equipment-catalog-non-putters-v2.mjs --validate-only
//   node scripts/generate-equipment-catalog-non-putters-v2.mjs --emit
//   node scripts/generate-equipment-catalog-non-putters-v2.mjs --check
//
// THIS GENERATOR NEVER WRITES A FILE.
//
// It has no fs write call of any kind. --validate-only prints a short report,
// --emit prints the exact candidate migration bytes and nothing else, and
// --check compares the rendered bytes with the single already-present v2
// migration. Materializing the migration is a separately authorized gate; until
// that gate runs, no v2 migration file exists and --check is expected to fail
// loudly rather than invent one.
//
// v2 is an ADDITIVE DELTA. It carries only the 201 new EQ-S2-C models. It does
// not restate the 30 rows of the closed non-putter v1 catalog and it carries no
// Putter row. The two v1 catalogs are read here only to establish the exact
// 51-model pre-deployment baseline, to prove four classes of collision are
// empty, and to render preconditions that preserve that baseline.
//
// Node built-ins only. No network access at any point.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const SOURCE_JSON = path.join(repoRoot, "data", "equipment-catalog-non-putters-v2.json");
const NON_PUTTER_V1_JSON = path.join(repoRoot, "data", "equipment-catalog-non-putters-v1.json");
const PUTTER_V1_JSON = path.join(repoRoot, "data", "equipment-catalog-putters-v1.json");
const MIGRATIONS_DIR = path.join(repoRoot, "supabase", "migrations");
const MIGRATION_SUFFIX = "_equipment_non_putter_catalog_v2.sql";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// RFC 4122 UUIDv5
//
// Reimplemented here rather than imported. The v1 generators are closed
// artifacts, and an identity function shared across gates is exactly the kind of
// dependency whose silent change would rewrite every derived id at once.
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
// Locked EQ-S2-C vocabulary, counts and limits
// ---------------------------------------------------------------------------

const UUID_NAMESPACE = "05690d1f-f17d-5ab8-a2b6-ef0328a2783a";
const CATALOG_NAME = "equipment-catalog-non-putters-v2";
const VERIFIED_ON = "2026-09-04";

const EXPECTED_V2_MODEL_COUNT = 201;
const EXPECTED_V2_SOURCE_COUNT = 201;

// The closed v1 baseline this delta lands on top of.
const EXPECTED_V1_NON_PUTTER_COUNT = 30;
const EXPECTED_V1_PUTTER_COUNT = 21;
const EXPECTED_EXISTING_MODEL_COUNT = 51;
const EXPECTED_COMBINED_MODEL_COUNT = 252;

const ALLOWED_MANUFACTURER_SLUGS = [
  "callaway",
  "cobra",
  "mizuno",
  "ping",
  "taylormade",
  "titleist",
];

// EQ-S2-C is non-putter only. Putter coverage is the closed EQ1-S2 artifact
// family and must not be touched here.
const ALLOWED_CLUB_TYPES = ["Driver", "Wood", "Hybrid", "Iron", "Wedge"];

const CLUB_TYPE_ENUM_VALUES = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"];

// Defence in depth only. The authoritative coverage contract is the exact
// 30-cell matrix below, not these ceilings.
const MAX_ROWS_PER_CELL = 26;
const MAX_TOTAL_MODELS = 201;

// THE PRIMARY COVERAGE CONTRACT.
//
// Every one of the 30 manufacturer x club-type cells is asserted for exact
// equality. There is deliberately NO universal "at least one row per cell"
// rule: two cells are legitimately zero in the current market — Titleist has no
// current-market wedge under its own model family in scope, and Mizuno has no
// current-market fairway wood in scope. A universal minimum would force those
// cells to be invented.
const EXPECTED_MATRIX = {
  taylormade: { Driver: 7, Wood: 6, Hybrid: 5, Iron: 10, Wedge: 5 },
  callaway: { Driver: 10, Wood: 18, Hybrid: 15, Iron: 26, Wedge: 8 },
  titleist: { Driver: 4, Wood: 4, Hybrid: 2, Iron: 6, Wedge: 0 },
  ping: { Driver: 9, Wood: 7, Hybrid: 3, Iron: 11, Wedge: 2 },
  mizuno: { Driver: 1, Wood: 0, Hybrid: 1, Iron: 8, Wedge: 1 },
  cobra: { Driver: 9, Wood: 8, Hybrid: 4, Iron: 10, Wedge: 1 },
};

const EXPECTED_CLUB_TYPE_TOTALS = { Driver: 40, Wood: 43, Hybrid: 30, Iron: 71, Wedge: 17 };

// Post-deployment totals across the whole catalog: the six v1 non-putter rows
// per club type, plus this delta, plus the untouched 21 putters.
const EXPECTED_POST_CLUB_TYPE_TOTALS = {
  Driver: 46,
  Wood: 49,
  Hybrid: 36,
  Iron: 77,
  Wedge: 23,
  Putter: 21,
};

const ALLOWED_SOURCE_TYPES = [
  "official_product_page",
  "official_spec_pdf",
  "official_archive",
  "official_category_page",
];

// Exact accepted provenance split for this delta. official_category_page is the
// lowest rung of the provenance ladder and is used exactly once, for the single
// model whose product page, specification PDF and archive were all exhausted.
const EXPECTED_SOURCE_TYPE_DISTRIBUTION = {
  official_product_page: 200,
  official_spec_pdf: 0,
  official_archive: 0,
  official_category_page: 1,
};

// ---------------------------------------------------------------------------
// EQ-S2-B2 live-database prerequisite
//
// official_category_page only became a nameable provenance class when the B2
// migration widened the source-type CHECK to four values. This delta inserts a
// row of that class, so applying it against a database that still carries the
// three-value rule would fail mid-INSERT with a constraint violation and no
// explanation. The generated migration therefore proves the live rule is
// exactly the deployed B2 shape BEFORE any INSERT, and proves it is still
// exactly that shape before COMMIT.
//
// The proof is exact-set / simple-membership, mirroring the discipline of the
// B2 migration itself: a substring test would pass against a rule that merely
// mentions the class while admitting something else entirely.
// ---------------------------------------------------------------------------

const B2_CONSTRAINT_NAME = "equipment_model_sources_type_check";

const B2_ADMITTED_SOURCE_TYPES = [
  "official_archive",
  "official_category_page",
  "official_product_page",
  "official_spec_pdf",
];

const B2_SIBLING_CONSTRAINTS = [
  "equipment_model_sources_url_https",
  "equipment_model_sources_verified_not_future",
  "equipment_model_sources_model_url_unique",
];

const SOLE_CATEGORY_PAGE_SOURCE = {
  canonical_name: "Mizuno ST-Max Hybrid",
  source_type: "official_category_page",
  source_name: "Mizuno ST-Max Hybrid official category page",
  source_url: "https://mizunogolf.com/us/hybrids/",
  verified_at: "2026-09-04",
};

// source_name is derived, never free text. Any drift here is a data defect.
const SOURCE_NAME_SUFFIX = {
  official_product_page: "official product page",
  official_spec_pdf: "official specification PDF",
  official_archive: "official archive",
  official_category_page: "official category page",
};

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

function effectiveIdentity(model) {
  return [
    model.manufacturer_slug,
    model.club_type,
    model.normalized_name,
    model.model_year ?? 0,
  ].join("|");
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

function validateVerifiedAt(value, context) {
  assert(ISO_DATE_PATTERN.test(value), `${context}: expected an ISO date, got "${value}"`);
  assert(
    value === VERIFIED_ON,
    `${context}: verified_at "${value}" is not the locked EQ-S2-C verification date ${VERIFIED_ON}`
  );
}

// ---------------------------------------------------------------------------
// The closed v1 baseline
//
// Both files are read and never written. They are the authority for the exact
// 51 catalog keys, slugs, effective identities and canonical names that must
// already exist and must survive this delta untouched.
// ---------------------------------------------------------------------------

function loadExistingBaseline() {
  const nonPutters = JSON.parse(fs.readFileSync(NON_PUTTER_V1_JSON, "utf8"));
  const putters = JSON.parse(fs.readFileSync(PUTTER_V1_JSON, "utf8"));

  assert(
    nonPutters.models.length === EXPECTED_V1_NON_PUTTER_COUNT,
    `non-putter v1 catalog: expected ${EXPECTED_V1_NON_PUTTER_COUNT} models, found ${nonPutters.models.length}`
  );
  assert(
    putters.models.length === EXPECTED_V1_PUTTER_COUNT,
    `putter v1 catalog: expected ${EXPECTED_V1_PUTTER_COUNT} models, found ${putters.models.length}`
  );

  // The closed EQ1-S2 putter artifact predates club_type in the catalog JSON:
  // every one of its rows is a Putter by construction, and its migration
  // inserts them as such. Club type is supplied here for identity comparison
  // only; the protected file is never rewritten.
  assert(
    putters.models.every((m) => !("club_type" in m)),
    "existing baseline: the putter v1 catalog shape has changed — it now declares club_type"
  );
  const putterModels = putters.models.map((m) => ({ ...m, club_type: "Putter" }));

  const models = [...nonPutters.models, ...putterModels];
  assert(
    models.length === EXPECTED_EXISTING_MODEL_COUNT,
    `existing baseline: expected ${EXPECTED_EXISTING_MODEL_COUNT} models, found ${models.length}`
  );

  const catalogKeys = new Set(models.map((m) => m.catalog_key));
  const slugs = new Set(models.map((m) => m.slug));
  const identities = new Set(models.map(effectiveIdentity));
  const canonicalNames = new Set(models.map((m) => m.canonical_name));

  assert(catalogKeys.size === EXPECTED_EXISTING_MODEL_COUNT, "existing baseline: catalog keys are not unique");
  assert(slugs.size === EXPECTED_EXISTING_MODEL_COUNT, "existing baseline: slugs are not unique");
  assert(identities.size === EXPECTED_EXISTING_MODEL_COUNT, "existing baseline: effective identities are not unique");
  assert(canonicalNames.size === EXPECTED_EXISTING_MODEL_COUNT, "existing baseline: canonical names are not unique");

  const putterKeys = putterModels.map((m) => m.catalog_key);
  assert(
    nonPutters.models.every((m) => m.club_type !== "Putter"),
    "existing baseline: the non-putter v1 catalog contains a Putter row"
  );

  const clubTypeCounts = new Map();
  for (const model of models) {
    clubTypeCounts.set(model.club_type, (clubTypeCounts.get(model.club_type) ?? 0) + 1);
  }

  return {
    models,
    catalogKeys,
    slugs,
    identities,
    canonicalNames,
    putterKeys,
    clubTypeCounts,
    rows: models
      .map((m) => ({
        catalog_key: m.catalog_key,
        slug: m.slug,
        normalized_name: m.normalized_name,
      }))
      .sort((a, b) => (a.catalog_key < b.catalog_key ? -1 : 1)),
  };
}

// ---------------------------------------------------------------------------
// Load and validate the v2 delta
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

  // v2 introduces no parent manufacturer: all six already exist canonically.
  assert(Array.isArray(data.manufacturers), "root: manufacturers must be an array");
  assert(
    data.manufacturers.length === 0,
    `root: v2 introduces no new manufacturer, found ${data.manufacturers.length}`
  );

  assert(Array.isArray(data.models), "root: models must be an array");
  assert(
    data.models.length === EXPECTED_V2_MODEL_COUNT,
    `root: this v2 delta must contain exactly ${EXPECTED_V2_MODEL_COUNT} models, found ${data.models.length}`
  );
  assert(
    data.models.length <= MAX_TOTAL_MODELS,
    `root: model count exceeds the ${MAX_TOTAL_MODELS}-row ceiling`
  );

  const catalogKeys = new Set();
  const slugs = new Set();
  const identities = new Set();
  const canonicalNames = new Set();
  const cellCounts = new Map();
  const sourceTypeCounts = new Map();
  let sourceCount = 0;
  let categoryPageModel = null;

  for (const model of data.models) {
    const context = `model ${model.catalog_key ?? "(unknown)"}`;
    rejectUnknownFields(model, MODEL_FIELDS, context);

    assert(CATALOG_KEY_PATTERN.test(model.catalog_key), `${context}: catalog_key format`);
    // The /v1 suffix is the MODEL IDENTITY version, not the artifact release
    // version. A first-generation canonical identity carries /v1 whichever
    // catalog artifact introduces it.
    assert(
      model.catalog_key.endsWith("/v1"),
      `${context}: catalog_key must end with the /v1 model-identity suffix`
    );
    assert(!catalogKeys.has(model.catalog_key), `${context}: duplicate catalog_key`);
    catalogKeys.add(model.catalog_key);

    assert(
      ALLOWED_MANUFACTURER_SLUGS.includes(model.manufacturer_slug),
      `${context}: manufacturer_slug "${model.manufacturer_slug}" is outside the locked six-manufacturer vocabulary`
    );
    assert(
      model.catalog_key.startsWith(`${model.manufacturer_slug}/`),
      `${context}: catalog_key must be namespaced by its manufacturer slug`
    );

    assert(
      ALLOWED_CLUB_TYPES.includes(model.club_type),
      `${context}: club_type "${model.club_type}" is not an EQ-S2-C non-putter club type`
    );
    assert(model.club_type !== "Putter", `${context}: EQ-S2-C must not contain Putter rows`);

    assert(SLUG_PATTERN.test(model.slug), `${context}: slug format`);
    assert(!slugs.has(model.slug), `${context}: duplicate slug "${model.slug}"`);
    slugs.add(model.slug);

    assert(
      typeof model.canonical_name === "string" && model.canonical_name.trim() !== "",
      `${context}: canonical_name must be a non-blank string`
    );
    assert(!canonicalNames.has(model.canonical_name), `${context}: duplicate canonical_name`);
    canonicalNames.add(model.canonical_name);

    assert(
      model.normalized_name === normalizeName(model.canonical_name),
      `${context}: normalized_name is not the deterministic normalization of canonical_name`
    );

    // brand_line / model_family are value+slug pairs: both present or both null.
    if (model.brand_line === null) {
      assert(model.brand_line_slug === null, `${context}: brand_line_slug must be null when brand_line is null`);
    } else {
      assert(
        typeof model.brand_line === "string" && model.brand_line.trim() !== "",
        `${context}: brand_line must be a non-blank string`
      );
      assert(SLUG_PATTERN.test(model.brand_line_slug ?? ""), `${context}: brand_line_slug format`);
    }
    if (model.model_family === null) {
      assert(model.model_family_slug === null, `${context}: model_family_slug must be null when model_family is null`);
    } else {
      assert(
        typeof model.model_family === "string" && model.model_family.trim() !== "",
        `${context}: model_family must be a non-blank string`
      );
      assert(SLUG_PATTERN.test(model.model_family_slug ?? ""), `${context}: model_family_slug format`);
    }

    // EQ-S2-C carries identity only. Years are catalog metadata the official
    // identity sources do not establish, so they stay null.
    assert(model.model_year === null, `${context}: model_year must be null in this v2 delta`);
    assert(model.release_year === null, `${context}: release_year must be null in this v2 delta`);
    assert(model.is_active === true, `${context}: is_active must be true`);

    assert(
      model.specifications !== null &&
        typeof model.specifications === "object" &&
        !Array.isArray(model.specifications) &&
        Object.keys(model.specifications).length === 0,
      `${context}: specifications must be an empty object in this v2 delta`
    );

    const identity = effectiveIdentity(model);
    assert(!identities.has(identity), `${context}: duplicate manufacturer/club_type/name/year identity`);
    identities.add(identity);

    const cell = `${model.manufacturer_slug}|${model.club_type}`;
    cellCounts.set(cell, (cellCounts.get(cell) ?? 0) + 1);

    // -- sources -------------------------------------------------------------
    assert(Array.isArray(model.sources), `${context}: sources must be an array`);
    assert(
      model.sources.length === 1,
      `${context}: EQ-S2-C requires exactly one official source per model, found ${model.sources.length}`
    );
    for (const source of model.sources) {
      rejectUnknownFields(source, SOURCE_FIELDS, `${context} source`);
      assert(
        ALLOWED_SOURCE_TYPES.includes(source.source_type),
        `${context}: source_type "${source.source_type}" is not an accepted official source class`
      );
      assert(
        typeof source.source_name === "string" && source.source_name.trim() !== "",
        `${context}: source_name must be a non-blank string`
      );
      assert(
        source.source_name === `${model.canonical_name} ${SOURCE_NAME_SUFFIX[source.source_type]}`,
        `${context}: source_name is not the deterministic name for its source_type`
      );
      const parsed = validateSourceUrl(source.source_url, context);
      if (source.source_type === "official_spec_pdf") {
        assert(
          parsed.pathname.toLowerCase().endsWith(".pdf"),
          `${context}: official_spec_pdf requires a URL pathname ending in .pdf`
        );
      }
      validateVerifiedAt(source.verified_at, `${context} source`);

      sourceTypeCounts.set(source.source_type, (sourceTypeCounts.get(source.source_type) ?? 0) + 1);
      sourceCount += 1;

      if (source.source_type === "official_category_page") {
        assert(
          categoryPageModel === null,
          `${context}: more than one model uses the official_category_page fallback`
        );
        categoryPageModel = { model, source };
      }
    }
  }

  assert(
    sourceCount === EXPECTED_V2_SOURCE_COUNT,
    `root: expected exactly ${EXPECTED_V2_SOURCE_COUNT} provenance sources, found ${sourceCount}`
  );
  assert(catalogKeys.size === EXPECTED_V2_MODEL_COUNT, "root: v2 catalog keys are not unique");
  assert(slugs.size === EXPECTED_V2_MODEL_COUNT, "root: v2 slugs are not unique");
  assert(identities.size === EXPECTED_V2_MODEL_COUNT, "root: v2 effective identities are not unique");
  assert(canonicalNames.size === EXPECTED_V2_MODEL_COUNT, "root: v2 canonical names are not unique");

  // -- the exact 30-cell coverage matrix -------------------------------------
  for (const manufacturerSlug of ALLOWED_MANUFACTURER_SLUGS) {
    for (const clubType of ALLOWED_CLUB_TYPES) {
      const expected = EXPECTED_MATRIX[manufacturerSlug][clubType];
      const actual = cellCounts.get(`${manufacturerSlug}|${clubType}`) ?? 0;
      assert(
        actual === expected,
        `coverage: ${manufacturerSlug} / ${clubType} must hold exactly ${expected} rows, found ${actual}`
      );
      assert(
        actual <= MAX_ROWS_PER_CELL,
        `coverage: ${manufacturerSlug} / ${clubType} exceeds the ${MAX_ROWS_PER_CELL}-row per-cell ceiling`
      );
    }
  }
  // No cell outside the locked matrix may exist at all.
  for (const cell of cellCounts.keys()) {
    const [manufacturerSlug, clubType] = cell.split("|");
    assert(
      Object.prototype.hasOwnProperty.call(EXPECTED_MATRIX, manufacturerSlug) &&
        Object.prototype.hasOwnProperty.call(EXPECTED_MATRIX[manufacturerSlug], clubType),
      `coverage: unexpected cell ${cell}`
    );
  }

  for (const clubType of ALLOWED_CLUB_TYPES) {
    const expected = EXPECTED_CLUB_TYPE_TOTALS[clubType];
    const actual = data.models.filter((m) => m.club_type === clubType).length;
    assert(
      actual === expected,
      `coverage: expected exactly ${expected} ${clubType} rows, found ${actual}`
    );
  }

  // -- the exact provenance split --------------------------------------------
  for (const sourceType of ALLOWED_SOURCE_TYPES) {
    const expected = EXPECTED_SOURCE_TYPE_DISTRIBUTION[sourceType];
    const actual = sourceTypeCounts.get(sourceType) ?? 0;
    assert(
      actual === expected,
      `provenance: expected exactly ${expected} ${sourceType} sources, found ${actual}`
    );
  }

  assert(categoryPageModel !== null, "provenance: the single official_category_page source is missing");
  assert(
    categoryPageModel.model.canonical_name === SOLE_CATEGORY_PAGE_SOURCE.canonical_name,
    `provenance: official_category_page is only accepted for ${SOLE_CATEGORY_PAGE_SOURCE.canonical_name}`
  );
  assert(
    categoryPageModel.source.source_name === SOLE_CATEGORY_PAGE_SOURCE.source_name,
    "provenance: the category-page source_name does not match the locked value"
  );
  assert(
    categoryPageModel.source.source_url === SOLE_CATEGORY_PAGE_SOURCE.source_url,
    "provenance: the category-page source_url does not match the locked value"
  );
  assert(
    categoryPageModel.source.verified_at === SOLE_CATEGORY_PAGE_SOURCE.verified_at,
    "provenance: the category-page verified_at does not match the locked value"
  );

  return {
    data,
    catalogKeys,
    slugs,
    identities,
    canonicalNames,
    cellCounts,
    sourceTypeCounts,
  };
}

// ---------------------------------------------------------------------------
// Global collision validation
//
// Runs before any SQL is rendered. A collision in any of the four identity
// classes would be rejected by a unique constraint mid-migration; catching it
// here means it is never rendered in the first place.
// ---------------------------------------------------------------------------

function validateGlobalCollisions(candidate, existing) {
  const classes = [
    ["catalog_key", candidate.catalogKeys, existing.catalogKeys],
    ["slug", candidate.slugs, existing.slugs],
    ["effective identity", candidate.identities, existing.identities],
    ["canonical_name", candidate.canonicalNames, existing.canonicalNames],
  ];

  for (const [label, candidateSet, existingSet] of classes) {
    const collisions = [...candidateSet].filter((value) => existingSet.has(value));
    assert(
      collisions.length === 0,
      `collision: ${collisions.length} ${label} value(s) already exist in the closed v1 catalogs: ${collisions
        .slice(0, 5)
        .join(", ")}`
    );
    const combined = new Set([...existingSet, ...candidateSet]);
    assert(
      combined.size === EXPECTED_COMBINED_MODEL_COUNT,
      `collision: combined ${label} count must be ${EXPECTED_COMBINED_MODEL_COUNT}, found ${combined.size}`
    );
  }

  // The projected post-deployment club-type totals must equal the locked
  // expectation exactly, derived rather than asserted from thin air.
  for (const clubType of CLUB_TYPE_ENUM_VALUES) {
    const existingCount = existing.clubTypeCounts.get(clubType) ?? 0;
    const candidateCount = candidate.data.models.filter((m) => m.club_type === clubType).length;
    const projected = existingCount + candidateCount;
    assert(
      projected === EXPECTED_POST_CLUB_TYPE_TOTALS[clubType],
      `projection: expected ${EXPECTED_POST_CLUB_TYPE_TOTALS[clubType]} ${clubType} models after deployment, projected ${projected}`
    );
  }
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
  // All six manufacturer ids predate this delta. Five were created under the
  // pre-existing gen_random_uuid() default and Cobra under a deterministic v1
  // identity; none of them are stable across environments as a literal here.
  // Every model therefore resolves its parent by canonical slug.
  return `(select id from public.equipment_manufacturers where slug = ${sqlString(slug)})`;
}

// Renders one read-only EQ-S2-B2 proof block. Called twice: as a precondition
// before any INSERT, and as a preservation assertion before COMMIT. The two
// emissions are byte-identical apart from their error-code prefix and headline,
// so the preservation proof cannot drift away from the prerequisite it mirrors.
function renderB2Guard(w, code, headline, rationale) {
  w("-- ----------------------------------------------------------------------------");
  w(`-- ${headline}`);
  w("--");
  for (const line of rationale) w(`-- ${line}`);
  w("--");
  w("-- Read-only catalog introspection. This migration never rewrites the rule: it");
  w("-- refuses to proceed unless the rule is already exactly the deployed B2 shape.");
  w("-- ----------------------------------------------------------------------------");
  w();
  w("do $$");
  w("declare");
  w("  v_def       text;");
  w("  v_norm      text;");
  w("  v_blank     text;");
  w("  v_found     text[];");
  w("  v_literals  int;");
  w("  v_col       text;");
  w("  v_expected  text[] := array[");
  B2_ADMITTED_SOURCE_TYPES.forEach((value, index) => {
    const comma = index === B2_ADMITTED_SOURCE_TYPES.length - 1 ? "" : ",";
    w(`    ${sqlString(value)}${comma}`);
  });
  w("  ];");
  w("begin");
  w("  -- A. The provenance table exists as an ordinary table.");
  w("  if not exists (");
  w("    select 1 from pg_class rel");
  w("      join pg_namespace nsp on nsp.oid = rel.relnamespace");
  w("     where nsp.nspname = 'public'");
  w("       and rel.relname = 'equipment_model_sources'");
  w("       and rel.relkind = 'r'");
  w("  ) then");
  w(`    raise exception '${code}-A: public.equipment_model_sources is missing or is not an ordinary table.';`);
  w("  end if;");
  w();
  w("  -- B. Exactly one CHECK constraint governs source_type.");
  w("  if (");
  w("    select count(*)");
  w("      from pg_constraint con");
  w("      join pg_class rel on rel.oid = con.conrelid");
  w("      join pg_namespace nsp on nsp.oid = rel.relnamespace");
  w("     where nsp.nspname = 'public'");
  w("       and rel.relname = 'equipment_model_sources'");
  w("       and con.contype = 'c'");
  w("       and pg_get_constraintdef(con.oid, false) ~ '\\msource_type\\M'");
  w("  ) <> 1 then");
  w(`    raise exception '${code}-B: public.equipment_model_sources does not have exactly one source_type CHECK constraint.';`);
  w("  end if;");
  w();
  w("  -- C. That rule carries the exact expected name.");
  w("  select pg_get_constraintdef(con.oid, false)");
  w("    into v_def");
  w("    from pg_constraint con");
  w("    join pg_class rel on rel.oid = con.conrelid");
  w("    join pg_namespace nsp on nsp.oid = rel.relnamespace");
  w("   where nsp.nspname = 'public'");
  w("     and rel.relname = 'equipment_model_sources'");
  w("     and con.contype = 'c'");
  w(`     and con.conname = ${sqlString(B2_CONSTRAINT_NAME)};`);
  w();
  w("  if v_def is null then");
  w(`    raise exception '${code}-C: constraint ${B2_CONSTRAINT_NAME} is missing. EQ-S2-B2 is not deployed on this database.';`);
  w("  end if;");
  w();
  w("  v_norm := btrim(regexp_replace(v_def, '\\s+', ' ', 'g'));");
  w();
  w("  -- D. It is a CHECK expression.");
  w("  if v_norm !~ '^CHECK ' then");
  w(`    raise exception '${code}-D: the source_type rule is not a CHECK expression. Definition: %', v_norm;`);
  w("  end if;");
  w();
  w("  -- E. It is a simple membership predicate.");
  w("  if v_norm !~ '= ANY' and v_norm !~ '\\mIN\\M' then");
  w(`    raise exception '${code}-E: the source_type rule is not a simple membership predicate. Definition: %', v_norm;`);
  w("  end if;");
  w();
  w("  v_blank := upper(regexp_replace(v_norm, '''[^'']*''', ' ', 'g'));");
  w();
  w("  -- F. Once the quoted literals are blanked, no further logic remains.");
  w("  if v_blank ~ '\\mOR\\M'");
  w("     or v_blank ~ '\\mAND\\M'");
  w("     or v_blank ~ '\\mNOT\\M'");
  w("     or v_blank ~ '\\mIS\\M'");
  w("     or v_blank ~ '\\mLIKE\\M'");
  w("     or v_blank ~ '\\mILIKE\\M'");
  w("     or v_blank ~ '\\mSIMILAR\\M'");
  w("     or v_blank ~ '[<>]'");
  w("     or v_blank ~ '!='");
  w("     or v_blank ~ '~' then");
  w(`    raise exception '${code}-F: the source_type rule carries extra logic beyond simple membership. Definition: %', v_norm;`);
  w("  end if;");
  w();
  w("  -- G. source_type is named exactly once, as the governed column.");
  w("  if (select count(*) from regexp_matches(v_blank, '\\mSOURCE_TYPE\\M', 'g')) <> 1 then");
  w(`    raise exception '${code}-G: the source_type rule does not reference source_type exactly once. Definition: %', v_norm;`);
  w("  end if;");
  w();
  w("  -- H. No second column of the table participates in the rule.");
  w("  for v_col in");
  w("    select att.attname");
  w("      from pg_attribute att");
  w("      join pg_class rel on rel.oid = att.attrelid");
  w("      join pg_namespace nsp on nsp.oid = rel.relnamespace");
  w("     where nsp.nspname = 'public'");
  w("       and rel.relname = 'equipment_model_sources'");
  w("       and att.attnum > 0");
  w("       and not att.attisdropped");
  w("       and att.attname <> 'source_type'");
  w("  loop");
  w("    if v_blank ~ ('\\m' || upper(v_col) || '\\M') then");
  w(`      raise exception '${code}-H: the source_type rule also references column %. Definition: %', v_col, v_norm;`);
  w("    end if;");
  w("  end loop;");
  w();
  w("  -- I. Exactly four admitted literals are named.");
  w("  select count(*) into v_literals");
  w("    from regexp_matches(v_norm, '''([^'']*)''', 'g');");
  w();
  w("  if v_literals <> array_length(v_expected, 1) then");
  w(`    raise exception '${code}-I: the source_type rule names % literals, expected %. Definition: %',`);
  w("      v_literals, array_length(v_expected, 1), v_norm;");
  w("  end if;");
  w();
  w("  select coalesce(array_agg(distinct m[1] order by m[1]), array[]::text[])");
  w("    into v_found");
  w("    from regexp_matches(v_norm, '''([^'']*)''', 'g') as m;");
  w();
  w("  -- J. No admitted literal is repeated.");
  w("  if array_length(v_found, 1) is distinct from v_literals then");
  w(`    raise exception '${code}-J: the source_type rule repeats an admitted literal. Definition: %', v_norm;`);
  w("  end if;");
  w();
  w("  -- K. The admitted set is exactly the four authorized provenance classes.");
  w("  if v_found is distinct from (select array_agg(x order by x) from unnest(v_expected) as x) then");
  w(`    raise exception '${code}-K: the source_type rule admits % but exactly % was expected. Definition: %',`);
  w("      v_found, v_expected, v_norm;");
  w("  end if;");
  w();
  w("  -- L. The sibling provenance rules are present.");
  B2_SIBLING_CONSTRAINTS.forEach((conname, index) => {
    w(`  ${index === 0 ? "if not exists (" : ") or not exists ("}`);
    w("    select 1 from pg_constraint con");
    w("      join pg_class rel on rel.oid = con.conrelid");
    w("      join pg_namespace nsp on nsp.oid = rel.relnamespace");
    w("     where nsp.nspname = 'public' and rel.relname = 'equipment_model_sources'");
    w(`       and con.conname = ${sqlString(conname)}`);
  });
  w("  ) then");
  w(`    raise exception '${code}-L: a sibling constraint on public.equipment_model_sources is missing.';`);
  w("  end if;");
  w("end $$;");
  w();
}

function sqlTextArray(values, indent) {
  const lines = [];
  values.forEach((value, index) => {
    const comma = index === values.length - 1 ? "" : ",";
    lines.push(`${indent}${sqlString(value)}${comma}`);
  });
  return lines;
}

function buildMigration(catalog, existing) {
  const models = [...catalog.data.models].sort((a, b) => (a.catalog_key < b.catalog_key ? -1 : 1));
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

  const modelIds = new Set(modelRows.map((m) => m.id));
  assert(modelIds.size === modelRows.length, "identity: derived model ids are not unique");
  const sourceIds = new Set(sourceRows.map((s) => s.id));
  assert(sourceIds.size === sourceRows.length, "identity: derived source ids are not unique");

  const existingKeys = [...existing.catalogKeys].sort();
  const existingSlugs = [...existing.slugs].sort();
  const existingNormalized = existing.rows.map((r) => r.normalized_name);
  const existingRowKeys = existing.rows.map((r) => r.catalog_key);

  const L = [];
  const w = (line = "") => L.push(line);

  w("-- ============================================================================");
  w("-- EQ-S2-C — non-putter canonical equipment catalog expansion v2");
  w("--");
  w("-- GENERATED FILE — DO NOT HAND-EDIT.");
  w("-- Source of truth : data/equipment-catalog-non-putters-v2.json");
  w("-- Generator       : scripts/generate-equipment-catalog-non-putters-v2.mjs");
  w("--");
  w("-- This migration is DATA-ONLY, transactional, append-only and fail-loud. It");
  w("-- defines no schema object, changes no existing row and removes nothing. It");
  w("-- inserts:");
  w("--");
  w("--   0   equipment_manufacturers  (all six parents already exist)");
  w(`--   ${modelRows.length} non-putter equipment_models`);
  w(`--   ${sourceRows.length} equipment_model_sources`);
  w("--");
  w("-- v2 is an ADDITIVE DELTA. The 30 rows of the closed non-putter v1 catalog are");
  w("-- already present and are not restated here. The catalog goes from 51 models");
  w("-- to 252: 231 non-putters and the untouched 21 putters.");
  w("--");
  w("-- Identity is deterministic. Every model and source id is an RFC 4122 UUIDv5");
  w(`-- derived from namespace ${UUID_NAMESPACE}`);
  w('-- over "model:<catalog_key>" and "source:<catalog_key>:<source_url>". No');
  w("-- manufacturer id is ever written as a literal: every model resolves its parent");
  w("-- by canonical slug.");
  w("--");
  w("-- Loft, shaft flex, shaft weight, club number and retail SKU are golfer-level");
  w("-- customization on public.user_equipment. They are never canonical identity and");
  w("-- appear nowhere in this migration.");
  w("--");
  w("-- Putter coverage is the closed EQ1-S2 artifact family. This migration adds no");
  w("-- Putter row and touches no existing putter row or putter-spec row. It links no");
  w("-- user_equipment row to a catalog model.");
  w("--");
  w("-- EQ-S2-B2 IS A HARD PREREQUISITE. One provenance row uses the");
  w("-- official_category_page class, which only exists once B2 has widened the");
  w("-- source-type rule to four values. The exact deployed rule is proven before any");
  w("-- INSERT and proven again before COMMIT. Neither proof changes it.");
  w("-- ============================================================================");
  w();
  w("begin;");
  w();

  // -- EQ-S2-B2 live prerequisite, before anything is inserted ----------------
  renderB2Guard(
    w,
    "EQ2SC-B2PRE",
    "EQ-S2-B2 prerequisite — the live source-type rule must already admit all four provenance classes",
    [
      "This delta inserts one official_category_page provenance row. That class only",
      "became nameable when EQ-S2-B2 widened the source-type CHECK from three values",
      "to four. Against a database still carrying the three-value rule the INSERT",
      "would fail on a constraint violation with nothing to explain why, so the exact",
      "deployed rule is proven here, before any row is written.",
    ]
  );

  // -- preconditions ---------------------------------------------------------
  w("-- ----------------------------------------------------------------------------");
  w("-- Preconditions — refuse to apply against anything but the exact intended");
  w("-- post-v1 / post-B2 foundation.");
  w("-- ----------------------------------------------------------------------------");
  w();
  w("do $$");
  w("declare");
  w("  v_count bigint;");
  w("  v_slugs text[];");
  w("  v_enum text[];");
  w("  v_i int;");
  w("  v_expected_keys text[] := array[");
  sqlTextArray(existingKeys, "    ").forEach(w);
  w("  ];");
  w("  v_expected_slugs text[] := array[");
  sqlTextArray(existingSlugs, "    ").forEach(w);
  w("  ];");
  w("  v_identity_keys text[] := array[");
  sqlTextArray(existingRowKeys, "    ").forEach(w);
  w("  ];");
  w("  v_identity_normalized text[] := array[");
  sqlTextArray(existingNormalized, "    ").forEach(w);
  w("  ];");
  w("  v_actual_keys text[];");
  w("  v_actual_slugs text[];");
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
    w(`    raise exception 'EQ2SC-PRE-1: public.${table} does not exist.';`);
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
  w("    raise exception 'EQ2SC-PRE-2: public.club_type_enum values have changed from the expected six values.';");
  w("  end if;");
  w();
  w("  -- Required identity constraints/indexes still exist.");
  for (const conname of ["equipment_models_catalog_key_unique", "equipment_models_slug_unique"]) {
    w("  if not exists (");
    w("    select 1 from pg_constraint c");
    w("    join pg_class rel on rel.oid = c.conrelid");
    w("    join pg_namespace nsp on nsp.oid = rel.relnamespace");
    w(`    where nsp.nspname = 'public' and rel.relname = 'equipment_models' and c.conname = '${conname}'`);
    w("  ) then");
    w(`    raise exception 'EQ2SC-PRE-3: constraint ${conname} is missing.';`);
    w("  end if;");
  }
  w("  if not exists (");
  w("    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace");
  w("    where n.nspname = 'public' and c.relname = 'equipment_models_manufacturer_type_name_year_uidx'");
  w("  ) then");
  w("    raise exception 'EQ2SC-PRE-4: index equipment_models_manufacturer_type_name_year_uidx is missing.';");
  w("  end if;");
  w();
  w("  -- Exactly the six locked manufacturers, and nothing else.");
  w("  select array_agg(slug order by slug) into v_slugs from public.equipment_manufacturers;");
  w(`  if v_slugs is distinct from array[${ALLOWED_MANUFACTURER_SLUGS.map(sqlString).join(", ")}]::text[] then`);
  w("    raise exception 'EQ2SC-PRE-5: expected exactly the six locked manufacturer slugs, found %.', v_slugs;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_manufacturers;");
  w("  if v_count <> 6 then");
  w("    raise exception 'EQ2SC-PRE-6: expected exactly 6 equipment_manufacturers rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  -- Exactly the 51 existing models: 30 non-putters and 21 putters.");
  w("  select count(*) into v_count from public.equipment_models;");
  w(`  if v_count <> ${EXPECTED_EXISTING_MODEL_COUNT} then`);
  w(`    raise exception 'EQ2SC-PRE-7: expected exactly ${EXPECTED_EXISTING_MODEL_COUNT} existing equipment_models rows, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;");
  w(`  if v_count <> ${EXPECTED_V1_NON_PUTTER_COUNT} then`);
  w(`    raise exception 'EQ2SC-PRE-8: expected exactly ${EXPECTED_V1_NON_PUTTER_COUNT} existing non-Putter models, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models where club_type = 'Putter'::public.club_type_enum;");
  w(`  if v_count <> ${EXPECTED_V1_PUTTER_COUNT} then`);
  w(`    raise exception 'EQ2SC-PRE-9: expected exactly ${EXPECTED_V1_PUTTER_COUNT} existing Putter models, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_model_sources;");
  w(`  if v_count <> ${EXPECTED_EXISTING_MODEL_COUNT} then`);
  w(`    raise exception 'EQ2SC-PRE-10: expected exactly ${EXPECTED_EXISTING_MODEL_COUNT} existing equipment_model_sources rows, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_putter_model_specs;");
  w(`  if v_count <> ${EXPECTED_V1_PUTTER_COUNT} then`);
  w(`    raise exception 'EQ2SC-PRE-11: expected exactly ${EXPECTED_V1_PUTTER_COUNT} equipment_putter_model_specs rows, found %.', v_count;`);
  w("  end if;");
  w();
  w("  -- The existing 51 catalog keys and slugs are exactly the two protected v1");
  w("  -- catalogs, so this delta is landing on the foundation it was reconciled");
  w("  -- against and on no other.");
  w("  select array_agg(catalog_key order by catalog_key) into v_actual_keys from public.equipment_models;");
  w("  if v_actual_keys is distinct from v_expected_keys then");
  w("    raise exception 'EQ2SC-PRE-12: the existing 51 catalog_key set does not match the protected v1 catalogs.';");
  w("  end if;");
  w();
  w("  select array_agg(slug order by slug) into v_actual_slugs from public.equipment_models;");
  w("  if v_actual_slugs is distinct from v_expected_slugs then");
  w("    raise exception 'EQ2SC-PRE-13: the existing 51 slug set does not match the protected v1 catalogs.';");
  w("  end if;");
  w();
  w("  -- Each existing canonical identity is present under its own catalog key.");
  w("  for v_i in 1..array_length(v_identity_keys, 1) loop");
  w("    select count(*) into v_count from public.equipment_models");
  w("     where catalog_key = v_identity_keys[v_i]");
  w("       and normalized_name = v_identity_normalized[v_i];");
  w("    if v_count <> 1 then");
  w("      raise exception 'EQ2SC-PRE-14: existing canonical identity for % is missing or has changed.', v_identity_keys[v_i];");
  w("    end if;");
  w("  end loop;");
  w();
  w("  -- User-equipment guard. Deliberately scoped to canonical model references");
  w("  -- only: staging holds zero user_equipment rows while production holds real");
  w("  -- rows, so a total row-count assertion would make this file environment-");
  w("  -- specific.");
  w("  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2SC-PRE-15: expected zero user_equipment rows referencing an equipment_model, found %.', v_count;");
  w("  end if;");
  w("end $$;");
  w();

  // -- model insert ----------------------------------------------------------
  w("-- ----------------------------------------------------------------------------");
  w(`-- 1. Non-putter equipment models (${modelRows.length} rows, generated — do not hand-edit)`);
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
  w(`-- 2. Official identity provenance (${sourceRows.length} rows, one per model)`);
  w("--");
  w("-- Every row cites a directly observed official manufacturer resource that");
  w("-- establishes the product's identity. No performance claim, loft, shaft option,");
  w("-- price or marketing statement is imported from any of them. Exactly one row");
  w("-- uses the official_category_page class, for the single model whose product");
  w("-- page, specification PDF and archive were all exhausted.");
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
  w("  v_i int;");
  w("  v_expected_keys text[] := array[");
  sqlTextArray(existingKeys, "    ").forEach(w);
  w("  ];");
  w("  v_expected_slugs text[] := array[");
  sqlTextArray(existingSlugs, "    ").forEach(w);
  w("  ];");
  w("  v_model_ids text[] := array[");
  sqlTextArray(modelRows.map((m) => m.id), "    ").forEach(w);
  w("  ];");
  w("  v_model_keys text[] := array[");
  sqlTextArray(modelRows.map((m) => m.catalog_key), "    ").forEach(w);
  w("  ];");
  w("  v_source_ids text[] := array[");
  sqlTextArray(sourceRows.map((s) => s.id), "    ").forEach(w);
  w("  ];");
  w("  v_source_model_ids text[] := array[");
  sqlTextArray(sourceRows.map((s) => s.modelId), "    ").forEach(w);
  w("  ];");
  w("  v_source_urls text[] := array[");
  sqlTextArray(sourceRows.map((s) => s.source_url), "    ").forEach(w);
  w("  ];");
  w("  v_surviving text[];");
  w("begin");
  w("  select count(*) into v_count from public.equipment_manufacturers;");
  w("  if v_count <> 6 then");
  w("    raise exception 'EQ2SC-POST-1: expected exactly 6 equipment_manufacturers rows, found %.', v_count;");
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models;");
  w(`  if v_count <> ${EXPECTED_COMBINED_MODEL_COUNT} then`);
  w(`    raise exception 'EQ2SC-POST-2: expected exactly ${EXPECTED_COMBINED_MODEL_COUNT} equipment_models rows, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models where club_type = 'Putter'::public.club_type_enum;");
  w(`  if v_count <> ${EXPECTED_V1_PUTTER_COUNT} then`);
  w(`    raise exception 'EQ2SC-POST-3: expected exactly ${EXPECTED_V1_PUTTER_COUNT} Putter models, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_models where club_type <> 'Putter'::public.club_type_enum;");
  w(`  if v_count <> ${EXPECTED_COMBINED_MODEL_COUNT - EXPECTED_V1_PUTTER_COUNT} then`);
  w(`    raise exception 'EQ2SC-POST-4: expected exactly ${EXPECTED_COMBINED_MODEL_COUNT - EXPECTED_V1_PUTTER_COUNT} non-Putter models, found %.', v_count;`);
  w("  end if;");
  w();
  for (const clubType of CLUB_TYPE_ENUM_VALUES) {
    const expected = EXPECTED_POST_CLUB_TYPE_TOTALS[clubType];
    w(`  select count(*) into v_count from public.equipment_models where club_type = ${sqlString(clubType)}::public.club_type_enum;`);
    w(`  if v_count <> ${expected} then`);
    w(`    raise exception 'EQ2SC-POST-5: expected exactly ${expected} ${clubType} models, found %.', v_count;`);
    w("  end if;");
  }
  w();
  w("  select count(*) into v_count from public.equipment_model_sources;");
  w(`  if v_count <> ${EXPECTED_COMBINED_MODEL_COUNT} then`);
  w(`    raise exception 'EQ2SC-POST-6: expected exactly ${EXPECTED_COMBINED_MODEL_COUNT} equipment_model_sources rows, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_putter_model_specs;");
  w(`  if v_count <> ${EXPECTED_V1_PUTTER_COUNT} then`);
  w(`    raise exception 'EQ2SC-POST-7: expected exactly ${EXPECTED_V1_PUTTER_COUNT} equipment_putter_model_specs rows, found %.', v_count;`);
  w("  end if;");
  w();
  w("  -- Every new model resolves to its expected deterministic identity.");
  w("  for v_i in 1..array_length(v_model_ids, 1) loop");
  w("    select count(*) into v_count from public.equipment_models");
  w("     where id = v_model_ids[v_i]::uuid and catalog_key = v_model_keys[v_i];");
  w("    if v_count <> 1 then");
  w("      raise exception 'EQ2SC-POST-8: expected model % at its deterministic identity %.', v_model_keys[v_i], v_model_ids[v_i];");
  w("    end if;");
  w("  end loop;");
  w();
  w("  -- Every new provenance row resolves to its expected deterministic identity.");
  w("  for v_i in 1..array_length(v_source_ids, 1) loop");
  w("    select count(*) into v_count from public.equipment_model_sources");
  w("     where id = v_source_ids[v_i]::uuid");
  w("       and equipment_model_id = v_source_model_ids[v_i]::uuid");
  w("       and source_url = v_source_urls[v_i];");
  w("    if v_count <> 1 then");
  w("      raise exception 'EQ2SC-POST-9: expected the deterministic provenance row for %.', v_source_urls[v_i];");
  w("    end if;");
  w("  end loop;");
  w();
  w("  -- Each new model carries exactly one provenance row.");
  w("  select count(*) into v_count from (");
  w("    select s.equipment_model_id");
  w("      from public.equipment_model_sources s");
  w("     where s.equipment_model_id = any(v_model_ids::uuid[])");
  w("     group by s.equipment_model_id");
  w("    having count(*) <> 1");
  w("  ) as offending_sources;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2SC-POST-10: % new models do not have exactly one provenance row.', v_count;");
  w("  end if;");
  w();
  w("  -- The original 51 catalog keys and slugs remain present.");
  w("  select array_agg(catalog_key order by catalog_key) into v_surviving");
  w("    from public.equipment_models where catalog_key = any(v_expected_keys);");
  w("  if v_surviving is distinct from v_expected_keys then");
  w("    raise exception 'EQ2SC-POST-11: the original 51 catalog_key set is no longer intact.';");
  w("  end if;");
  w();
  w("  select array_agg(slug order by slug) into v_surviving");
  w("    from public.equipment_models where slug = any(v_expected_slugs);");
  w("  if v_surviving is distinct from v_expected_slugs then");
  w("    raise exception 'EQ2SC-POST-12: the original 51 slug set is no longer intact.';");
  w("  end if;");
  w();
  w("  -- All 201 new catalog keys are present.");
  w("  select count(*) into v_count from public.equipment_models where catalog_key = any(v_model_keys);");
  w(`  if v_count <> ${modelRows.length} then`);
  w(`    raise exception 'EQ2SC-POST-13: expected all ${modelRows.length} v2 catalog keys to be present, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.equipment_putter_model_specs s");
  w("    join public.equipment_models m on m.id = s.equipment_model_id");
  w("   where m.club_type = 'Putter'::public.club_type_enum;");
  w(`  if v_count <> ${EXPECTED_V1_PUTTER_COUNT} then`);
  w(`    raise exception 'EQ2SC-POST-14: expected all ${EXPECTED_V1_PUTTER_COUNT} putter-spec relationships to remain intact, found %.', v_count;`);
  w("  end if;");
  w();
  w("  select count(*) into v_count from public.user_equipment where equipment_model_id is not null;");
  w("  if v_count <> 0 then");
  w("    raise exception 'EQ2SC-POST-15: this migration must not link any user_equipment row to a catalog model, found %.', v_count;");
  w("  end if;");
  w("end $$;");
  w();

  // -- EQ-S2-B2 preservation, after insertion and before commit ---------------
  renderB2Guard(
    w,
    "EQ2SC-B2POST",
    "EQ-S2-B2 preservation — the source-type rule is still exactly the four deployed classes",
    [
      "The identical proof, re-run after the 201 provenance rows have been written.",
      "This migration performs no schema change, so the rule must come out of the",
      "transaction exactly as it went in; anything else means something outside this",
      "file moved it, and the transaction must not be allowed to commit.",
    ]
  );

  w("commit;");

  return { sql: `${L.join("\n")}\n`, modelRows, sourceRows };
}

// ---------------------------------------------------------------------------
// Serialization safety
// ---------------------------------------------------------------------------

function validateSerialization(sql) {
  assert(sql.length > 0, "generated migration is empty");
  assert(!sql.includes("\r"), "generated migration must use LF line endings");
  assert(sql.endsWith("\n"), "generated migration must end with a newline");
  assert(!sql.endsWith("\n\n"), "generated migration must end with exactly one newline");
  assert(sql.charCodeAt(0) !== 0xfeff, "generated migration must not carry a byte-order mark");
  assert(sql.trimEnd().endsWith("commit;"), "generated migration must end with commit;");
  assert(sql.includes("\nbegin;\n"), "generated migration must open a transaction");

  const lowered = sql.toLowerCase();
  for (const forbidden of [
    "alter table",
    "create table",
    "create index",
    "drop ",
    "truncate",
    "update ",
    "delete from",
    "grant ",
    "revoke ",
    "create policy",
    "security definer",
    "insert into public.equipment_manufacturers",
    "insert into public.user_equipment",
    "insert into public.equipment_putter_model_specs",
  ]) {
    assert(
      !lowered.includes(forbidden),
      `generated migration must not contain "${forbidden.trim()}"`
    );
  }

  const insertStatements = (sql.match(/^insert into /gm) ?? []).length;
  assert(insertStatements === 2, `generated migration must contain exactly 2 INSERT statements, found ${insertStatements}`);

  // -- EQ-S2-B2 guard placement ----------------------------------------------
  // Position is the whole point of the prerequisite: a proof that runs after the
  // INSERT it protects is not a guard, it is a post-mortem.
  const firstModelInsert = sql.indexOf("\ninsert into public.equipment_models (");
  const sourceInsert = sql.indexOf("\ninsert into public.equipment_model_sources (");
  const preGuard = sql.indexOf("EQ2SC-B2PRE-A:");
  const postGuard = sql.indexOf("EQ2SC-B2POST-A:");
  const commitAt = sql.lastIndexOf("\ncommit;");

  assert(firstModelInsert > -1, "generated migration is missing the equipment_models INSERT");
  assert(sourceInsert > -1, "generated migration is missing the equipment_model_sources INSERT");
  assert(preGuard > -1, "generated migration is missing the EQ-S2-B2 prerequisite guard");
  assert(postGuard > -1, "generated migration is missing the EQ-S2-B2 preservation guard");
  assert(
    preGuard < firstModelInsert,
    "the EQ-S2-B2 prerequisite guard must precede the first INSERT"
  );
  assert(
    postGuard > sourceInsert && postGuard < commitAt,
    "the EQ-S2-B2 preservation guard must follow the provenance INSERT and precede commit"
  );

  // Both guards must be complete: every lettered check A..L, in each copy.
  for (const code of ["EQ2SC-B2PRE", "EQ2SC-B2POST"]) {
    for (const letter of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]) {
      assert(
        sql.includes(`${code}-${letter}:`),
        `generated migration is missing the ${code}-${letter} EQ-S2-B2 check`
      );
    }
  }

  // The four admitted literals appear in each guard's expected-set array.
  for (const admitted of B2_ADMITTED_SOURCE_TYPES) {
    const occurrences = (sql.match(new RegExp(`'${admitted}'`, "g")) ?? []).length;
    assert(
      occurrences >= 2,
      `each EQ-S2-B2 guard must name the admitted class ${admitted}; found ${occurrences} occurrence(s)`
    );
  }
  for (const conname of [B2_CONSTRAINT_NAME, ...B2_SIBLING_CONSTRAINTS]) {
    assert(sql.includes(conname), `generated migration must name the B2 constraint ${conname}`);
  }

  // The guards are read-only: no form of constraint mutation may appear.
  for (const forbidden of ["drop constraint", "add constraint", "alter constraint", "validate constraint"]) {
    assert(
      !sql.toLowerCase().includes(forbidden),
      `generated migration must not contain "${forbidden}" — the B2 rule is proven, never changed`
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const MODES = ["--validate-only", "--emit", "--check"];

function resolveMode(argv) {
  const args = argv.slice(2);
  for (const arg of args) {
    assert(
      MODES.includes(arg),
      `unknown argument "${arg}".\nUsage: node scripts/generate-equipment-catalog-non-putters-v2.mjs [--validate-only | --emit | --check]`
    );
  }
  const requested = [...new Set(args)];
  assert(
    requested.length !== 0,
    "no mode selected. This generator never writes a file and requires an explicit mode.\n" +
      "Usage: node scripts/generate-equipment-catalog-non-putters-v2.mjs [--validate-only | --emit | --check]"
  );
  assert(
    requested.length === 1,
    `exactly one mode may be selected, found ${requested.length}: ${requested.join(", ")}`
  );
  return requested[0];
}

function locateExistingMigration() {
  const entries = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(MIGRATION_SUFFIX))
    .sort();
  assert(
    entries.length === 1,
    `--check: expected exactly one supabase/migrations file ending in ${MIGRATION_SUFFIX}, found ${entries.length}`
  );
  return path.join(MIGRATIONS_DIR, entries[0]);
}

function main() {
  const mode = resolveMode(process.argv);

  // The JSON-level provenance vocabulary and the database-level admitted set are
  // two statements of the same contract. If they ever diverge, the generator
  // would validate data the live constraint refuses.
  assert(
    JSON.stringify([...ALLOWED_SOURCE_TYPES].sort()) ===
      JSON.stringify([...B2_ADMITTED_SOURCE_TYPES].sort()),
    "vocabulary: ALLOWED_SOURCE_TYPES and the EQ-S2-B2 admitted set have diverged"
  );

  const existing = loadExistingBaseline();
  const catalog = loadCatalog();
  validateGlobalCollisions(catalog, existing);

  const { sql, modelRows, sourceRows } = buildMigration(catalog, existing);
  validateSerialization(sql);

  if (mode === "--emit") {
    // Exact byte payload only. No prefix, no suffix, no diagnostics.
    process.stdout.write(sql);
    return;
  }

  if (mode === "--check") {
    const migrationPath = locateExistingMigration();
    const onDisk = fs.readFileSync(migrationPath, "utf8");
    assert(
      onDisk === sql,
      `--check: ${path.relative(repoRoot, migrationPath)} is out of date with the generator.`
    );
    process.stdout.write(
      `OK  ${path.relative(repoRoot, migrationPath)} matches the generated output byte-for-byte.\n`
    );
    return;
  }

  const bytes = Buffer.byteLength(sql, "utf8");
  const digest = createHash("sha256").update(sql, "utf8").digest("hex");
  const cells = ALLOWED_MANUFACTURER_SLUGS.length * ALLOWED_CLUB_TYPES.length;
  process.stdout.write(
    [
      "EQ-S2-C-V2-VALIDATE-OK",
      `  models                 : ${modelRows.length}`,
      `  sources                : ${sourceRows.length}`,
      `  matrix cells exact     : ${cells}/${cells}`,
      `  existing baseline      : ${existing.models.length}`,
      `  collisions (key/slug/identity/name) : 0/0/0/0`,
      `  projected catalog      : ${EXPECTED_COMBINED_MODEL_COUNT}`,
      `  candidate migration    : ${bytes} bytes, sha256 ${digest}`,
      "  files written          : 0",
      "",
    ].join("\n")
  );
}

main();
