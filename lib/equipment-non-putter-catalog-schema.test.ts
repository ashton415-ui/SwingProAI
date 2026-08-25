import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Like the EQ1-S2 putter test, this permanent test is repository-history
// independent: no git status, git diff, git log, branch name, commit SHA, PR
// state or remote-ref dependency. It also performs NO network access — every
// provenance URL is validated structurally, never fetched.

const DATA_FILE = "data/equipment-catalog-non-putters-v1.json";
const GENERATOR_FILE = "scripts/generate-equipment-catalog-non-putters-v1.mjs";
const MIGRATION_SUFFIX = "_equipment_non_putter_catalog_v1.sql";
const TEST_FILE = "lib/equipment-non-putter-catalog-schema.test.ts";
const QUERY_LAYER_FILE = "lib/equipment/catalog.ts";
const DOCS_FILE = "docs/EQUIPMENT_INTELLIGENCE_ROLLOUT.md";

// Closed EQ1-S2 putter artifacts plus the shared type surface. Slice 2 must not
// touch any of them. If a later authorized slice legitimately changes one, that
// slice updates the digest here deliberately — silent drift is the failure mode
// these pins exist to prevent.
const PROTECTED_DIGESTS: Record<string, string> = {
  "data/equipment-catalog-putters-v1.json":
    "0a73e9460d1f416b8af04838dc983df5bcb40ea9f4fa169b9975e50a2b502029",
  "scripts/generate-equipment-catalog-putters-v1.mjs":
    "89b40a7a23c80b4377019eb1548395086d5ea9d36584ad6cbd8ec3226184d287",
  "supabase/migrations/20260725174239_equipment_putter_catalog_v1.sql":
    "f133d266395879e208ad3bc615a77f8b6d394f98608263e22011d07b82df9ed4",
  "lib/equipment-catalog-schema.test.ts":
    "7fff61c8005d0517b942344180cbd68a12e640767132213c942dc6101cca59d9",
  "types/database.ts":
    "c47715be3d9217c0983fbad66c0f49fd313a0b1f2ec11a46f2a89c2e95b92b53",
};

// Slice 2 is permitted exactly one change to the Slice-1 query layer: the stale
// "currently putter-only" coverage note. Stripping comments and collapsing
// whitespace leaves only executable content, whose digest must still match the
// value the layer shipped with.
const QUERY_LAYER_RUNTIME_DIGEST =
  "837a932641dcd485eb916c0a75d101a47cd552ce3713fb814bf30e47390273cb";

function stripCommentsAndWhitespace(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const UUID_NAMESPACE = "05690d1f-f17d-5ab8-a2b6-ef0328a2783a";
const VERIFIED_ON = "2026-08-20";
const EXPECTED_MODEL_COUNT = 30;
const EXPECTED_SOURCE_COUNT = 30;
const MAX_TOTAL_MODELS = 90;
const MIN_ROWS_PER_CELL = 1;
const MAX_ROWS_PER_CELL = 4;

const EXPECTED_MANUFACTURERS = [
  "callaway",
  "cobra",
  "mizuno",
  "ping",
  "taylormade",
  "titleist",
];
const EXPECTED_CLUB_TYPES = ["Driver", "Hybrid", "Iron", "Wedge", "Wood"];
const EXPECTED_COBRA_ID = "4f88964a-be63-543e-bbfa-d5451b6faab6";

const ALLOWED_SOURCE_TYPES = ["official_product_page", "official_spec_pdf", "official_archive"];

const ALLOWED_SOURCE_HOSTNAMES = [
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

// The ten rows whose provenance required the separately gated recovery round.
// Their source URLs are approved input and must be transcribed exactly.
const RECOVERED_PROVENANCE: Record<string, string> = {
  "taylormade/qi35/qi35-driver/v1":
    "https://www.taylormadegolf.com/on/demandware.static/-/Sites-TMaG-Library/en_US/v1736272938439/docs/productspecs/2025/Qi35-Core-Driver.pdf",
  "taylormade/qi35/qi35-fairway/v1":
    "https://www.taylormadegolf.com/Qi35-Fairway/DW-TC373.html",
  "taylormade/qi35/qi35-rescue/v1":
    "https://www.taylormadegolf.com/Qi35-3-Rescue/M1465109.html",
  "taylormade/p790/p790-irons/v1":
    "https://www.taylormadegolf.com/P%E2%88%99790-Irons/DW-TC635.html",
  "taylormade/mg5/mg5-wedge/v1":
    "https://www.taylormadegolf.com/MG5-Wedge/DW-TC647.html",
  "titleist/gt2/gt2-driver/v1": "https://www.titleist.com/golf-clubs/drivers/gt2",
  "titleist/gt2/gt2-fairway/v1": "https://www.titleist.com/golf-clubs/fairways/gt2",
  "titleist/gt2/gt2-hybrid/v1": "https://www.titleist.com/product/gt2-hybrid/675C.html",
  "titleist/t250/t250-irons/v1": "https://www.titleist.com/product/t250/561C.html",
  "titleist/vokey-design/vokey-sm11-wedge/v1":
    "https://www.titleist.com/product/vokey-sm11/MASTER-SM11.html",
};

// Fitting parameters and commercial fields that must never become catalog data.
const PROHIBITED_DATA_KEYS = [
  "loft", "lofts", "loft_options", "shaft", "shaft_flex", "shaft_flex_options",
  "shaft_weight", "club_number", "sku", "grind", "grinds", "bounce", "price",
  "retail_price", "inventory", "stock", "affiliate", "tracking", "ranking",
  "tour_usage", "marketing_copy", "description", "image", "image_url",
  "ai_score", "recommended_player", "fitting_conclusion", "putter_specs",
];

// ---------------------------------------------------------------------------
// Load artifacts
// ---------------------------------------------------------------------------

function findMigrationPath(): string {
  const dir = path.join(repoRoot, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(MIGRATION_SUFFIX));
  expect(
    files.length,
    `expected exactly one migration ending with ${MIGRATION_SUFFIX}, found ${files.length}`
  ).toBe(1);
  return path.join("supabase", "migrations", files[0]);
}

interface CatalogSource {
  source_type: string;
  source_name: string;
  source_url: string;
  verified_at: string;
}

interface CatalogModel {
  catalog_key: string;
  manufacturer_slug: string;
  club_type: string;
  brand_line: string | null;
  brand_line_slug: string | null;
  model_family: string | null;
  model_family_slug: string | null;
  canonical_name: string;
  slug: string;
  normalized_name: string;
  model_year: number | null;
  release_year: number | null;
  is_active: boolean;
  specifications: Record<string, unknown>;
  sources: CatalogSource[];
}

interface CatalogRoot {
  schema_version: number;
  catalog_name: string;
  uuid_namespace: string;
  verified_on: string;
  manufacturers: Array<{ canonical_name: string; slug: string; normalized_name: string }>;
  models: CatalogModel[];
}

const migrationRelPath = findMigrationPath();
const migrationSource = readSource(migrationRelPath);
const generatorSource = readSource(GENERATOR_FILE);
const dataRaw = readSource(DATA_FILE);
const data = JSON.parse(dataRaw) as CatalogRoot;
const allSources = data.models.flatMap((m) => m.sources);

// Independent RFC 4122 UUIDv5, implemented here so the test never trusts the
// generator's own arithmetic.
function uuidv5(namespaceUuid: string, name: string): string {
  const hex = namespaceUuid.replace(/-/g, "");
  const namespaceBytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) {
    namespaceBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const hash = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const out = Array.from(bytes, (b: number) => b.toString(16).padStart(2, "0")).join("");
  return [
    out.slice(0, 8),
    out.slice(8, 12),
    out.slice(12, 16),
    out.slice(16, 20),
    out.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------

describe("EQ Slice 2 — artifact scope", () => {
  it("ships exactly the four new Slice-2 artifacts", () => {
    for (const file of [DATA_FILE, GENERATOR_FILE, migrationRelPath, TEST_FILE]) {
      expect(existsSync(path.join(repoRoot, file)), `${file} must exist`).toBe(true);
    }
  });

  it("carries exactly one Slice-2 migration, at the locked filename", () => {
    expect(path.basename(migrationRelPath)).toBe(
      "20260820132900_equipment_non_putter_catalog_v1.sql"
    );
  });

  it("leaves the closed putter artifacts and the shared types byte-unchanged", () => {
    for (const [file, digest] of Object.entries(PROTECTED_DIGESTS)) {
      const actual = sha256(readFileSync(path.join(repoRoot, file), "utf8"));
      expect(actual, `${file} must not be modified by Slice 2`).toBe(digest);
    }
  });
});

describe("EQ Slice 2 — catalog JSON", () => {
  it("declares the locked root contract", () => {
    expect(data.schema_version).toBe(1);
    expect(data.catalog_name).toBe("equipment-catalog-non-putters-v1");
    expect(data.uuid_namespace).toBe(UUID_NAMESPACE);
    expect(data.verified_on).toBe(VERIFIED_ON);
  });

  it("introduces Cobra as the only new parent manufacturer", () => {
    expect(data.manufacturers).toHaveLength(1);
    expect(data.manufacturers[0]).toEqual({
      canonical_name: "Cobra",
      slug: "cobra",
      normalized_name: "cobra",
    });
  });

  it("contains exactly 30 models and 30 provenance sources", () => {
    expect(data.models).toHaveLength(EXPECTED_MODEL_COUNT);
    expect(allSources).toHaveLength(EXPECTED_SOURCE_COUNT);
    expect(data.models.every((m) => m.sources.length === 1)).toBe(true);
    expect(data.models.length).toBeLessThanOrEqual(MAX_TOTAL_MODELS);
  });

  it("uses exactly the six locked manufacturers and five non-putter club types", () => {
    expect(Array.from(new Set(data.models.map((m) => m.manufacturer_slug))).sort()).toEqual(
      EXPECTED_MANUFACTURERS
    );
    expect(Array.from(new Set(data.models.map((m) => m.club_type))).sort()).toEqual(
      EXPECTED_CLUB_TYPES
    );
  });

  it("contains no Putter row", () => {
    expect(data.models.filter((m) => m.club_type === "Putter")).toHaveLength(0);
    expect(dataRaw).not.toContain("Putter");
  });

  it("populates every manufacturer/club-type cell exactly once, within the cell ceiling", () => {
    const counts = new Map<string, number>();
    for (const model of data.models) {
      const key = `${model.manufacturer_slug}|${model.club_type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(EXPECTED_MANUFACTURERS.length * EXPECTED_CLUB_TYPES.length);
    for (const manufacturer of EXPECTED_MANUFACTURERS) {
      for (const clubType of EXPECTED_CLUB_TYPES) {
        const count = counts.get(`${manufacturer}|${clubType}`) ?? 0;
        expect(count, `${manufacturer}/${clubType}`).toBeGreaterThanOrEqual(MIN_ROWS_PER_CELL);
        expect(count, `${manufacturer}/${clubType}`).toBeLessThanOrEqual(MAX_ROWS_PER_CELL);
        expect(count, `${manufacturer}/${clubType} in this v1 artifact`).toBe(1);
      }
    }
  });

  it("uses LF line endings and exactly one trailing newline", () => {
    const raw = readFileSync(path.join(repoRoot, DATA_FILE), "utf8");
    expect(raw.includes("\r")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
  });
});

describe("EQ Slice 2 — deterministic identity", () => {
  it("reproduces the RFC 4122 UUIDv5 reference vector", () => {
    expect(uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d"
    );
  });

  it("derives the Cobra manufacturer id deterministically", () => {
    const computed = uuidv5(UUID_NAMESPACE, "manufacturer:cobra");
    expect(computed).toBe(EXPECTED_COBRA_ID);
    expect(migrationSource).toContain(`'${EXPECTED_COBRA_ID}', 'Cobra', 'cobra', 'cobra'`);
  });

  it("emits every model id as uuidv5(namespace, \"model:<catalog_key>\")", () => {
    for (const model of data.models) {
      const id = uuidv5(UUID_NAMESPACE, `model:${model.catalog_key}`);
      expect(migrationSource, `${model.catalog_key} model id`).toContain(
        `'${id}', (select id from public.equipment_manufacturers where slug = '${model.manufacturer_slug}')`
      );
    }
  });

  it("emits every source id as uuidv5(namespace, \"source:<catalog_key>:<source_url>\")", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        const modelId = uuidv5(UUID_NAMESPACE, `model:${model.catalog_key}`);
        const sourceId = uuidv5(
          UUID_NAMESPACE,
          `source:${model.catalog_key}:${source.source_url}`
        );
        expect(migrationSource, `${model.catalog_key} source id`).toContain(
          `'${sourceId}', '${modelId}', '${source.source_type}'`
        );
      }
    }
  });

  it("keeps catalog keys, slugs and canonical identities unique", () => {
    expect(new Set(data.models.map((m) => m.catalog_key)).size).toBe(EXPECTED_MODEL_COUNT);
    expect(new Set(data.models.map((m) => m.slug)).size).toBe(EXPECTED_MODEL_COUNT);
    const identities = data.models.map((m) =>
      [m.manufacturer_slug, m.club_type, m.normalized_name, m.model_year ?? 0].join("|")
    );
    expect(new Set(identities).size).toBe(EXPECTED_MODEL_COUNT);
  });

  it("derives normalized_name deterministically from canonical_name", () => {
    for (const model of data.models) {
      expect(model.normalized_name, model.canonical_name).toBe(
        model.canonical_name.toLowerCase().replace(/[^a-z0-9]/g, "")
      );
    }
  });

  it("pairs brand_line and model_family with their slugs", () => {
    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const model of data.models) {
      if (model.brand_line === null) {
        expect(model.brand_line_slug, model.catalog_key).toBeNull();
      } else {
        expect(model.brand_line.trim()).not.toBe("");
        expect(slugPattern.test(model.brand_line_slug ?? "")).toBe(true);
      }
      if (model.model_family === null) {
        expect(model.model_family_slug, model.catalog_key).toBeNull();
      } else {
        expect(model.model_family.trim()).not.toBe("");
        expect(slugPattern.test(model.model_family_slug ?? "")).toBe(true);
      }
    }
  });
});

describe("EQ Slice 2 — data boundary", () => {
  it("leaves model_year and release_year null across the v1 artifact", () => {
    for (const model of data.models) {
      expect(model.model_year, model.catalog_key).toBeNull();
      expect(model.release_year, model.catalog_key).toBeNull();
    }
  });

  it("keeps specifications an empty object and every model active", () => {
    for (const model of data.models) {
      expect(model.specifications, model.catalog_key).toEqual({});
      expect(model.is_active, model.catalog_key).toBe(true);
    }
  });

  it("never promotes loft, shaft, club number or SKU into catalog data", () => {
    const jsonKeys = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          jsonKeys.add(key.toLowerCase());
          walk(value);
        }
      }
    };
    walk(data);
    for (const prohibited of PROHIBITED_DATA_KEYS) {
      expect(jsonKeys.has(prohibited), `prohibited key "${prohibited}" in catalog JSON`).toBe(false);
    }
  });

  it("carries no putter-spec payload", () => {
    expect(dataRaw).not.toContain("putter_specs");
  });
});

describe("EQ Slice 2 — official provenance", () => {
  it("uses only accepted official source classes", () => {
    for (const source of allSources) {
      expect(ALLOWED_SOURCE_TYPES).toContain(source.source_type);
    }
  });

  it("uses HTTPS on official manufacturer hostnames only, with no URI scheme in the host", () => {
    for (const source of allSources) {
      const url = new URL(source.source_url);
      expect(url.protocol, source.source_url).toBe("https:");
      expect(ALLOWED_SOURCE_HOSTNAMES, source.source_url).toContain(url.hostname);
      expect(url.hostname).not.toContain(":");
      expect(url.hostname).not.toContain("/");
    }
  });

  it("carries no tracking or affiliate parameters and no fragments", () => {
    const tracking = /(?:^|[?&])(utm_[a-z]+|aff|affid|affiliate|ref|clickid|gclid|fbclid|irclickid)=/i;
    for (const source of allSources) {
      const url = new URL(source.source_url);
      expect(tracking.test(url.search), source.source_url).toBe(false);
      expect(url.hash, source.source_url).toBe("");
    }
  });

  it("requires a .pdf pathname for every official_spec_pdf source", () => {
    for (const source of allSources) {
      if (source.source_type === "official_spec_pdf") {
        expect(new URL(source.source_url).pathname.toLowerCase().endsWith(".pdf")).toBe(true);
      }
    }
  });

  it("stamps every source with the locked verification date", () => {
    for (const source of allSources) {
      expect(source.verified_at, source.source_url).toBe(VERIFIED_ON);
    }
  });

  it("transcribes the ten recovered provenance URLs exactly", () => {
    for (const [catalogKey, expectedUrl] of Object.entries(RECOVERED_PROVENANCE)) {
      const model = data.models.find((m) => m.catalog_key === catalogKey);
      expect(model, `${catalogKey} must be present`).toBeDefined();
      expect(model!.sources[0].source_url, catalogKey).toBe(expectedUrl);
    }
  });

  it("never cites a retailer, review site, marketplace or search page", () => {
    const forbidden = [
      "amazon", "ebay", "golfgalaxy", "pgatoursuperstore", "2ndswing", "carlsgolfland",
      "golfdiscount", "worldwidegolfshops", "wikipedia", "google.", "bing.",
      "pluggedingolf", "golfwrx", "mygolfspy", "fairwayjockey", "golfio",
    ];
    for (const source of allSources) {
      const lower = source.source_url.toLowerCase();
      for (const host of forbidden) {
        expect(lower.includes(host), `${source.source_url} cites ${host}`).toBe(false);
      }
    }
  });

  it("performs no network access of its own", () => {
    // Scan import statements only. A whole-file scan would match this test's own
    // assertion literals and always fail.
    const importLines = readSource(TEST_FILE)
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");
    expect(importLines).not.toMatch(/node:https?/);
    expect(importLines).not.toMatch(/undici|node-fetch/);
    expect(readSource(TEST_FILE)).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("EQ Slice 2 — generator", () => {
  it("passes --check against the committed migration", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, GENERATOR_FILE), "--check"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(output).toContain("matches the generated output byte-for-byte");
  });

  it("declares no runtime network dependency", () => {
    expect(generatorSource).not.toContain("node:http");
    expect(generatorSource).not.toContain("node:https");
    expect(generatorSource).not.toMatch(/\bfetch\s*\(/);
    expect(generatorSource).not.toContain("undici");
  });

  it("pins the SwingProAI UUID namespace and runs a known-vector self-check", () => {
    expect(generatorSource).toContain(UUID_NAMESPACE);
    expect(generatorSource).toContain("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("emits LF with exactly one trailing newline", () => {
    const raw = readFileSync(path.join(repoRoot, migrationRelPath), "utf8");
    expect(raw.includes("\r")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
  });
});

describe("EQ Slice 2 — migration safety", () => {
  const statements = migrationSource
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("is transactional", () => {
    expect(migrationSource).toContain("\nbegin;\n");
    expect(migrationSource.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("is append-only: no UPDATE, DELETE or TRUNCATE", () => {
    expect(statements).not.toMatch(/\bupdate\s+public\./i);
    expect(statements).not.toMatch(/\bdelete\s+from\b/i);
    expect(statements).not.toMatch(/\btruncate\b/i);
  });

  it("contains no DDL, RLS or grant change", () => {
    for (const forbidden of [
      /\balter\s+table\b/i,
      /\bcreate\s+table\b/i,
      /\bdrop\s+table\b/i,
      /\bcreate\s+policy\b/i,
      /\balter\s+policy\b/i,
      /\bdrop\s+policy\b/i,
      /\bcreate\s+index\b/i,
      /\bcreate\s+trigger\b/i,
      /\bcreate\s+(or\s+replace\s+)?function\b/i,
      /\bgrant\b/i,
      /\brevoke\b/i,
      /\brow\s+level\s+security\b/i,
    ]) {
      expect(forbidden.test(statements), `migration must not contain ${forbidden}`).toBe(false);
    }
  });

  it("inserts into exactly the three intended tables", () => {
    const inserts: string[] = [];
    const insertPattern = /insert\s+into\s+(public\.[a-z_]+)/gi;
    let insertMatch: RegExpExecArray | null = insertPattern.exec(statements);
    while (insertMatch !== null) {
      inserts.push(insertMatch[1].toLowerCase());
      insertMatch = insertPattern.exec(statements);
    }
    expect(inserts.sort()).toEqual([
      "public.equipment_manufacturers",
      "public.equipment_model_sources",
      "public.equipment_models",
    ]);
  });

  it("never inserts putter specs and never mutates user or swing tables", () => {
    expect(statements).not.toMatch(/insert\s+into\s+public\.equipment_putter_model_specs/i);
    for (const table of ["user_equipment", "swing_analysis", "swing_videos", "swing_telemetry"]) {
      expect(
        new RegExp(`insert\\s+into\\s+public\\.${table}`, "i").test(statements),
        `must not insert into ${table}`
      ).toBe(false);
      expect(
        new RegExp(`update\\s+public\\.${table}`, "i").test(statements),
        `must not update ${table}`
      ).toBe(false);
    }
    expect(statements).not.toMatch(/swing_analysis|swing_videos|swing_telemetry/i);
  });

  it("inserts exactly 1 manufacturer, 30 models and 30 sources", () => {
    const modelBlock = statements
      .split("insert into public.equipment_models (")[1]
      .split(";")[0];
    const sourceBlock = statements
      .split("insert into public.equipment_model_sources (")[1]
      .split(";")[0];
    expect((modelBlock.match(/^ {2}\(/gm) ?? []).length).toBe(EXPECTED_MODEL_COUNT);
    expect((sourceBlock.match(/^ {2}\(/gm) ?? []).length).toBe(EXPECTED_SOURCE_COUNT);
    const manufacturerBlock = statements
      .split("insert into public.equipment_manufacturers (")[1]
      .split(";")[0];
    expect((manufacturerBlock.match(/^ {2}\(/gm) ?? []).length).toBe(1);
  });

  it("resolves every parent manufacturer by canonical slug, never by a hard-coded incumbent id", () => {
    for (const manufacturer of EXPECTED_MANUFACTURERS) {
      expect(migrationSource).toContain(
        `(select id from public.equipment_manufacturers where slug = '${manufacturer}')`
      );
    }
  });

  it("guards user_equipment on non-null equipment_model_id only, never on total row count", () => {
    expect(migrationSource).toContain(
      "from public.user_equipment where equipment_model_id is not null"
    );
    expect(statements).not.toMatch(/count\(\*\)[^;]*from public\.user_equipment\s*;/i);
  });

  it("asserts the locked preconditions", () => {
    for (const marker of [
      "EQ2S2-PRE-2", // club_type_enum unchanged
      "EQ2S2-PRE-5", // exactly the five incumbent manufacturers
      "EQ2S2-PRE-6", // cobra absent
      "EQ2S2-PRE-7", // exactly 21 existing models
      "EQ2S2-PRE-8", // zero non-putter models
      "EQ2S2-PRE-9", // exact 21 putter catalog_key set
      "EQ2S2-PRE-10", // 21 putter specs
      "EQ2S2-PRE-11", // 21 sources
      "EQ2S2-PRE-12", // user_equipment guard
    ]) {
      expect(migrationSource, `${marker} precondition`).toContain(marker);
    }
  });

  it("asserts the locked postconditions and expected totals", () => {
    for (const marker of [
      "EQ2S2-POST-1", "EQ2S2-POST-2", "EQ2S2-POST-3", "EQ2S2-POST-4", "EQ2S2-POST-5",
      "EQ2S2-POST-7", "EQ2S2-POST-8", "EQ2S2-POST-9", "EQ2S2-POST-12", "EQ2S2-POST-13",
      "EQ2S2-POST-14", "EQ2S2-POST-15",
    ]) {
      expect(migrationSource, `${marker} postcondition`).toContain(marker);
    }
    expect(migrationSource).toContain("if v_count <> 6 then");
    expect(migrationSource).toContain("if v_count <> 51 then");
    expect(migrationSource).toContain("if v_count <> 21 then");
  });

  it("states preservation as canonical identity, not as a physical-storage claim", () => {
    const lower = migrationSource.toLowerCase();
    // The forbidden thing is an affirmative claim about PostgreSQL's on-disk
    // representation; the file's own disclaimer of such a claim is expected.
    expect(lower).not.toContain("row bytes unchanged");
    expect(lower).not.toContain("bytes are unchanged");
    expect(lower).not.toContain("physically unchanged");
    expect(lower).toContain("expected row-set preservation");
  });
});

describe("EQ Slice 2 — Slice-1 query layer preservation", () => {
  it("leaves the query layer's executable content unchanged", () => {
    const runtime = stripCommentsAndWhitespace(readSource(QUERY_LAYER_FILE));
    expect(sha256(runtime)).toBe(QUERY_LAYER_RUNTIME_DIGEST);
  });

  it("keeps missing_coverage a first-class result and drops the stale putter-only claim", () => {
    const source = readSource(QUERY_LAYER_FILE);
    expect(source).toContain("missing_coverage");
    expect(source).not.toContain("canonical catalog is currently putter-only");
  });
});

describe("EQ Slice 2 — rollout documentation truth", () => {
  const docs = readSource(DOCS_FILE);

  it("records the non-putter expansion and its scope", () => {
    expect(docs).toContain("non-putter");
    expect(docs).toContain("Cobra");
  });

  it("records verified staging and production deployment for the non-putter catalog", () => {
    expect(docs).toContain("equipment_non_putter_catalog_v1");
    expect(docs).toContain("20260823035942");
    expect(docs).toContain("20260823042455");
    // The pre-application claim is now false and must not survive anywhere in
    // the document; this pin is what stops it being reintroduced.
    expect(docs).not.toContain("HAS NOT BEEN APPLIED TO STAGING OR PRODUCTION");
  });

  it("keeps the user-equipment and consumer boundaries the deployment did not cross", () => {
    expect(docs).toContain("No user-equipment backfill");
    expect(docs).toContain(
      "catalog-backed equipment selection is not yet wired"
    );
    expect(docs).toContain(
      "Consumer migration (My Bag, Analyze, Telemetry) is not part of"
    );
  });
});
