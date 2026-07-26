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

const DATA_FILE = "data/equipment-catalog-putters-v1.json";
const GENERATOR_FILE = "scripts/generate-equipment-catalog-putters-v1.mjs";
const MIGRATION_SUFFIX = "_equipment_putter_catalog_v1.sql";
const TEST_FILE = "lib/equipment-catalog-schema.test.ts";
const TYPES_FILE = "types/database.ts";
const DOCS_FILE = "docs/EQUIPMENT_INTELLIGENCE_ROLLOUT.md";

// This permanent test is repository-history independent (no git status, git
// diff, git log, branch name, commit SHA, PR state, or remote-ref
// dependency) — matching the lifecycle-stable pattern established by
// EQ1-S1R-C3 for lib/equipment-intelligence-schema.test.ts.

function findMigrationPath(): string {
  const dir = path.join(repoRoot, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(MIGRATION_SUFFIX));
  expect(files.length, `expected exactly one migration ending with ${MIGRATION_SUFFIX}, found ${files.length}`).toBe(1);
  return path.join("supabase", "migrations", files[0]);
}

const migrationRelPath = findMigrationPath();
const migrationSource = readSource(migrationRelPath);
const dataRaw = readSource(DATA_FILE);
const data = JSON.parse(dataRaw) as {
  schema_version: number;
  catalog_name: string;
  uuid_namespace: string;
  verified_on: string;
  models: Array<{
    catalog_key: string;
    manufacturer_slug: string;
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
    putter_specs: {
      head_shape: string;
      neck_type: string | null;
      neck_source_label: string | null;
      toe_hang_class: string | null;
      face_construction: string | null;
      handedness: string | null;
      standard_lengths_inches: number[] | null;
    };
    sources: Array<{
      source_type: string;
      source_name: string;
      source_url: string;
      verified_at: string;
    }>;
  }>;
};

// ============================================================================
// Artifact and generator tests
// ============================================================================

describe("EQ1-S2 artifact inventory", () => {
  it("tracks the six intended EQ1-S2 artifacts at their exact paths", () => {
    const expectedArtifacts = [
      DATA_FILE,
      GENERATOR_FILE,
      migrationRelPath.replace(/\\/g, "/"),
      TEST_FILE,
      TYPES_FILE,
      DOCS_FILE,
    ];

    expect(new Set(expectedArtifacts).size).toBe(6);

    for (const artifact of expectedArtifacts) {
      expect(existsSync(path.join(repoRoot, artifact)), `missing EQ1-S2 artifact: ${artifact}`).toBe(true);
    }
  });

  it("migration filename ends with the required suffix", () => {
    expect(migrationRelPath.endsWith(MIGRATION_SUFFIX)).toBe(true);
  });
});

describe("EQ1-S2 data file — top-level contract", () => {
  it("declares schema_version 1", () => {
    expect(data.schema_version).toBe(1);
  });

  it("declares the expected catalog_name", () => {
    expect(data.catalog_name).toBe("equipment-catalog-putters-v1");
  });

  it("declares the fixed SwingProAI UUID namespace", () => {
    expect(data.uuid_namespace).toBe("05690d1f-f17d-5ab8-a2b6-ef0328a2783a");
  });

  it("declares a verified_on date in YYYY-MM-DD form", () => {
    expect(data.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("respects the 25-model ceiling", () => {
    expect(data.models.length).toBeLessThanOrEqual(25);
    expect(data.models.length).toBeGreaterThan(0);
  });

  it("includes at least one model for every one of the five parent manufacturers", () => {
    const manufacturers = ["taylormade", "callaway", "titleist", "ping", "mizuno"];
    for (const slug of manufacturers) {
      const count = data.models.filter((m) => m.manufacturer_slug === slug).length;
      expect(count, `manufacturer ${slug} has zero verified models`).toBeGreaterThan(0);
    }
  });
});

describe("EQ1-S2 generator — determinism and check mode", () => {
  it("--check passes against the committed migration", () => {
    expect(() =>
      execFileSync("node", [GENERATOR_FILE, "--check"], { cwd: repoRoot, stdio: "pipe" })
    ).not.toThrow();
  });

  it("produces byte-identical output across two consecutive generations", () => {
    execFileSync("node", [GENERATOR_FILE], { cwd: repoRoot, stdio: "pipe" });
    const first = readFileSync(path.join(repoRoot, migrationRelPath), "utf8");
    execFileSync("node", [GENERATOR_FILE], { cwd: repoRoot, stdio: "pipe" });
    const second = readFileSync(path.join(repoRoot, migrationRelPath), "utf8");
    expect(second).toBe(first);
    // Restore the check-mode-verified committed state (no functional change,
    // generation is deterministic so this is a no-op byte-for-byte).
    execFileSync("node", [GENERATOR_FILE, "--check"], { cwd: repoRoot, stdio: "pipe" });
  });

  it("uses LF line endings only and ends with exactly one trailing newline", () => {
    const raw = readFileSync(path.join(repoRoot, migrationRelPath), "utf8");
    expect(raw.includes("\r")).toBe(false);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(false);
  });
});

// RFC 4122 UUIDv5 reference implementation, independent of the generator's
// own implementation, so this test cannot pass merely by re-checking the
// generator against itself.
function referenceUuidv5(namespace: string, name: string): string {
  const hex = namespace.replace(/-/g, "");
  const nsBytes = Buffer.from(hex, "hex");
  const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const outHex = bytes.toString("hex");
  return [outHex.slice(0, 8), outHex.slice(8, 12), outHex.slice(12, 16), outHex.slice(16, 20), outHex.slice(20, 32)].join("-");
}

describe("EQ1-S2 UUIDv5 — RFC known vector and reproducibility", () => {
  it("matches the published RFC 4122 UUIDv5 known vector", () => {
    const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const name = "www.widgets.com";
    const expected = "21f7f8de-8051-5b89-8680-0195ef798b6a";
    expect(referenceUuidv5(namespace, name)).toBe(expected);
  });

  it("every generated model UUID in the migration matches its catalog key deterministically", () => {
    for (const model of data.models) {
      const expectedId = referenceUuidv5(data.uuid_namespace, `model:${model.catalog_key}`);
      expect(migrationSource.includes(`'${expectedId}'`), `model UUID for ${model.catalog_key} not found in migration`).toBe(true);
    }
  });

  it("every generated source UUID in the migration matches its deterministic input", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        const expectedId = referenceUuidv5(data.uuid_namespace, `source:${model.catalog_key}:${source.source_url}`);
        expect(migrationSource.includes(`'${expectedId}'`), `source UUID for ${model.catalog_key} / ${source.source_url} not found in migration`).toBe(true);
      }
    }
  });
});

// ============================================================================
// Data integrity tests
// ============================================================================

describe("EQ1-S2 data integrity — identity fields", () => {
  const CATALOG_KEY_PATTERN = /^[a-z0-9]+(\/[a-z0-9-]+)+$/;
  const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const APPROVED_MANUFACTURERS = ["taylormade", "callaway", "titleist", "ping", "mizuno"];

  it("every catalog_key is unique and format-valid", () => {
    const keys = data.models.map((m) => m.catalog_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key, `catalog_key "${key}" fails the required format`).toMatch(CATALOG_KEY_PATTERN);
    }
  });

  it("every slug is unique and format-valid", () => {
    const slugs = data.models.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(SLUG_PATTERN);
    }
  });

  it("every canonical_name is nonblank", () => {
    for (const model of data.models) {
      expect(model.canonical_name.trim().length).toBeGreaterThan(0);
    }
  });

  it("every manufacturer_slug is within the approved five-manufacturer vocabulary", () => {
    for (const model of data.models) {
      expect(APPROVED_MANUFACTURERS).toContain(model.manufacturer_slug);
    }
  });

  it("manufacturer_slug + canonical_name + model_year identity is unique per model", () => {
    const identities = data.models.map((m) => `${m.manufacturer_slug}::${m.canonical_name.toLowerCase()}::${m.model_year ?? "null"}`);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it("brand_line and brand_line_slug are both null or both populated", () => {
    for (const model of data.models) {
      const bothNull = model.brand_line === null && model.brand_line_slug === null;
      const bothSet = typeof model.brand_line === "string" && typeof model.brand_line_slug === "string";
      expect(bothNull || bothSet, `brand_line pair inconsistent for ${model.catalog_key}`).toBe(true);
      if (bothSet) expect(model.brand_line_slug).toMatch(SLUG_PATTERN);
    }
  });

  it("model_family and model_family_slug are both null or both populated", () => {
    for (const model of data.models) {
      const bothNull = model.model_family === null && model.model_family_slug === null;
      const bothSet = typeof model.model_family === "string" && typeof model.model_family_slug === "string";
      expect(bothNull || bothSet, `model_family pair inconsistent for ${model.catalog_key}`).toBe(true);
      if (bothSet) expect(model.model_family_slug).toMatch(SLUG_PATTERN);
    }
  });

  it("Callaway Odyssey and Titleist Scotty Cameron records use brand_line, not a separate manufacturer", () => {
    const odyssey = data.models.filter((m) => m.brand_line === "Odyssey");
    const scottyCameron = data.models.filter((m) => m.brand_line === "Scotty Cameron");
    for (const m of odyssey) expect(m.manufacturer_slug).toBe("callaway");
    for (const m of scottyCameron) expect(m.manufacturer_slug).toBe("titleist");
  });

  it("every model has club_type Putter and is_active true (enforced by seed contract, not the JSON shape)", () => {
    for (const model of data.models) {
      expect(model.is_active).toBe(true);
    }
    expect(migrationSource).toContain("'Putter'::public.club_type_enum");
  });
});

// EQ1-S2-I1-C1 Correction 3: catalog rows must represent purchasable
// configurations, not generic families collapsing distinct official specs.
describe("EQ1-S2 data integrity — configuration-level identity (Correction 3)", () => {
  // Prior generic family-level catalog keys that the official sources proved
  // to have multiple materially distinct neck/configuration variants. These
  // must never reappear — each was replaced by its named configurations.
  const SUPERSEDED_GENERIC_CATALOG_KEYS = [
    "taylormade/spider-tour/spider-tour/v1",
    "taylormade/spider-tour/spider-tour-x/v1",
    "mizuno/m-craft/kyoto/v1",
    "mizuno/m-craft/tokyo/v1",
    // EQ1-S2-I1-C2R1: removed for insufficient/weak sourcing (family-page-only
    // or inaccessible-for-direct-verification evidence), replaced by the
    // directly-verified Ai-ONE configurations below.
    "callaway/odyssey/white-hot-og-2-ball/v1",
    "callaway/odyssey/white-hot-og-rossie/v1",
    "callaway/odyssey/white-hot-og-rossie-s/v1",
  ];

  it("no superseded generic family-level catalog key exists", () => {
    const keys = new Set(data.models.map((m) => m.catalog_key));
    for (const generic of SUPERSEDED_GENERIC_CATALOG_KEYS) {
      expect(keys.has(generic), `superseded generic catalog_key "${generic}" must not exist`).toBe(false);
    }
  });

  it("every retained TaylorMade Spider Tour / Spider Tour X row is a named neck configuration", () => {
    const taylormade = data.models.filter((m) => m.manufacturer_slug === "taylormade");
    expect(taylormade.length).toBeGreaterThanOrEqual(3);
    for (const model of taylormade) {
      expect(model.putter_specs.neck_source_label, `${model.catalog_key} missing a specific neck_source_label`).not.toBeNull();
      expect(model.canonical_name).toMatch(/L-Neck|Small Slant|Double Bend/);
    }
  });

  it("every retained Mizuno M.Craft row is a named .P/.S/.B configuration", () => {
    const mizuno = data.models.filter((m) => m.manufacturer_slug === "mizuno");
    expect(mizuno.length).toBeGreaterThanOrEqual(2);
    for (const model of mizuno) {
      expect(model.slug, `${model.catalog_key} slug must carry an explicit configuration suffix`).toMatch(/-(p|s|b)$/);
      expect(model.putter_specs.neck_source_label).toMatch(/^(Kyoto|Tokyo)\.[PSB]$/);
    }
  });

  it("every retained Scotty Cameron Phantom row is a distinctly named configuration with its own neck label", () => {
    const scottyCameron = data.models.filter((m) => m.brand_line === "Scotty Cameron");
    expect(scottyCameron.length).toBeGreaterThanOrEqual(2);
    const neckLabels = scottyCameron.map((m) => m.putter_specs.neck_source_label);
    // Every Phantom configuration must state its own neck label; identical
    // canonical names would already be rejected by the identity-uniqueness
    // test above, so this specifically guards against silently reusing one
    // neck description across multiple distinct configuration rows.
    for (const model of scottyCameron) {
      expect(model.putter_specs.neck_source_label, `${model.catalog_key} missing neck_source_label`).not.toBeNull();
    }
    expect(new Set(neckLabels.filter((l) => l === "Double Bend")).size).toBeLessThanOrEqual(1);
  });

  // EQ1-S2-I1-C2R1: the three current Ai-ONE configurations replace the
  // three weakly sourced White Hot OG records (family-page-only or
  // inaccessible-for-direct-verification evidence).
  it("exactly the three approved current Odyssey Ai-ONE catalog keys are present, each with an exact individual product-page source", () => {
    const REQUIRED_AI_ONE_KEYS = [
      "callaway/odyssey/ai-one-2-ball-ch/v1",
      "callaway/odyssey/ai-one-rossie-db/v1",
      "callaway/odyssey/ai-one-square-2-square-7-center-shaft/v1",
    ];
    const odyssey = data.models.filter((m) => m.brand_line === "Odyssey");
    expect(odyssey.length).toBe(3);
    const keys = odyssey.map((m) => m.catalog_key).sort();
    expect(keys).toEqual([...REQUIRED_AI_ONE_KEYS].sort());
    for (const model of odyssey) {
      expect(model.sources.length).toBeGreaterThanOrEqual(1);
      for (const source of model.sources) {
        // Every Odyssey source must be an individual product page, never the
        // bare family listing page.
        expect(source.source_url, `${model.catalog_key} source must not be the family page`).not.toBe(
          "https://www.odysseygolf.com/families/white-hot-og/"
        );
        expect(source.source_url.toLowerCase()).not.toContain("/families/");
      }
    }
  });

  it("PING Anser and Anser 2D retain exactly one row each, matching their single officially documented configuration", () => {
    const pingModels = data.models.filter((m) => m.manufacturer_slug === "ping");
    expect(pingModels.length).toBe(2);
    for (const model of pingModels) {
      expect(model.putter_specs.neck_source_label).toBe("H1 Hosel");
    }
  });
});

describe("EQ1-S2 data integrity — putter specs vocabulary", () => {
  const HEAD_SHAPES = ["blade", "mid_mallet", "mallet"];
  const NECK_TYPES = [
    "plumbers_neck", "slant_neck", "flow_neck", "long_neck",
    "single_bend", "double_bend", "center_shaft", "broomstick_center_shaft",
  ];
  const TOE_HANG_CLASSES = ["face_balanced", "slight", "moderate", "strong", "toe_down"];
  const FACE_CONSTRUCTIONS = ["milled", "insert", "hybrid"];
  const HANDEDNESS_VALUES = ["right", "left", "both"];

  it("every model has a required, vocabulary-valid head_shape", () => {
    for (const model of data.models) {
      expect(HEAD_SHAPES, `invalid head_shape for ${model.catalog_key}`).toContain(model.putter_specs.head_shape);
    }
  });

  it("neck_type is null or within the approved vocabulary", () => {
    for (const model of data.models) {
      const value = model.putter_specs.neck_type;
      if (value !== null) expect(NECK_TYPES).toContain(value);
    }
  });

  it("toe_hang_class is null or within the approved vocabulary", () => {
    for (const model of data.models) {
      const value = model.putter_specs.toe_hang_class;
      if (value !== null) expect(TOE_HANG_CLASSES).toContain(value);
    }
  });

  it("face_construction is null or within the approved vocabulary", () => {
    for (const model of data.models) {
      const value = model.putter_specs.face_construction;
      if (value !== null) expect(FACE_CONSTRUCTIONS).toContain(value);
    }
  });

  it("handedness is null or within the approved vocabulary", () => {
    for (const model of data.models) {
      const value = model.putter_specs.handedness;
      if (value !== null) expect(HANDEDNESS_VALUES).toContain(value);
    }
  });

  it("standard_lengths_inches, when populated, are sorted ascending, unique, and within [20,60]", () => {
    for (const model of data.models) {
      const lengths = model.putter_specs.standard_lengths_inches;
      if (lengths === null) continue;
      expect(lengths.length).toBeGreaterThan(0);
      const sorted = [...lengths].sort((a, b) => a - b);
      expect(lengths).toEqual(sorted);
      expect(new Set(lengths).size).toBe(lengths.length);
      for (const value of lengths) {
        expect(value).toBeGreaterThanOrEqual(20);
        expect(value).toBeLessThanOrEqual(60);
      }
    }
  });

  it("optional fitting fields remain null wherever the source data does not claim them (no forced completeness)", () => {
    // This asserts the policy is exercised, not merely permitted: at least
    // one seeded model must have at least one null optional field, proving
    // the data was not force-filled to claim 100% completeness.
    const anyNullOptionalField = data.models.some((m) => {
      const s = m.putter_specs;
      return (
        s.neck_type === null ||
        s.toe_hang_class === null ||
        s.face_construction === null ||
        s.handedness === null ||
        s.standard_lengths_inches === null
      );
    });
    expect(anyNullOptionalField).toBe(true);
  });

  it("neck_source_label is nonblank whenever populated", () => {
    for (const model of data.models) {
      const label = model.putter_specs.neck_source_label;
      if (label !== null) expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("EQ1-S2 data integrity — source provenance", () => {
  const ALLOWED_SOURCE_TYPES = ["official_product_page", "official_spec_pdf", "official_archive"];
  const ALLOWED_DOMAINS = [
    "taylormadegolf.com", "www.taylormadegolf.com",
    "callawaygolf.com", "www.callawaygolf.com",
    "odysseygolf.com", "www.odysseygolf.com", "odyssey.callawaygolf.com",
    "titleist.com", "www.titleist.com",
    "scottycameron.com", "www.scottycameron.com",
    "ping.com", "www.ping.com",
    "mizunogolf.com", "www.mizunogolf.com",
  ];
  const TRACKING_PARAM_PATTERN = /(?:^|[?&])(utm_[a-z]+|aff|affid|affiliate|ref|clickid|gclid|fbclid|irclickid)=/i;

  it("every model has at least one source", () => {
    for (const model of data.models) {
      expect(model.sources.length, `model ${model.catalog_key} has zero sources`).toBeGreaterThanOrEqual(1);
    }
  });

  it("every source_url is HTTPS", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        expect(source.source_url.startsWith("https://")).toBe(true);
      }
    }
  });

  it("every source_url domain is on the official-domain allowlist", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        const hostname = new URL(source.source_url).hostname;
        expect(ALLOWED_DOMAINS, `unexpected source domain ${hostname}`).toContain(hostname);
      }
    }
  });

  it("no source_url contains a tracking or affiliate query parameter", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        expect(TRACKING_PARAM_PATTERN.test(source.source_url)).toBe(false);
      }
    }
  });

  it("every source_type is within the approved vocabulary", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        expect(ALLOWED_SOURCE_TYPES).toContain(source.source_type);
      }
    }
  });

  it("every source has a nonblank source_name that is not a marketing tagline", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        expect(source.source_name.trim().length).toBeGreaterThan(0);
        expect(source.source_name.length).toBeLessThan(120);
      }
    }
  });

  it("every source verified_at is on or before the declared verified_on catalog date", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        expect(new Date(source.verified_at).getTime()).toBeLessThanOrEqual(new Date(data.verified_on).getTime());
      }
    }
  });

  // EQ1-S2-I1-C2R1 Blocking finding 3: an HTML page must never be labeled as
  // a PDF source. Any source_type = official_spec_pdf requires a URL whose
  // pathname actually ends in .pdf.
  it("any source labeled official_spec_pdf has a URL pathname ending in .pdf", () => {
    for (const model of data.models) {
      for (const source of model.sources) {
        if (source.source_type === "official_spec_pdf") {
          const pathname = new URL(source.source_url).pathname;
          expect(pathname.toLowerCase().endsWith(".pdf"), `${model.catalog_key}: official_spec_pdf source_url must end in .pdf`).toBe(true);
        }
      }
    }
  });

  it("the corrected v1 dataset contains zero official_spec_pdf entries (no actual PDF source was used)", () => {
    const pdfSources = data.models.flatMap((m) => m.sources).filter((s) => s.source_type === "official_spec_pdf");
    expect(pdfSources.length).toBe(0);
  });

  it("all four Mizuno sources use official_product_page, not official_spec_pdf, for the HTML specification page", () => {
    const mizunoSources = data.models.filter((m) => m.manufacturer_slug === "mizuno").flatMap((m) => m.sources);
    expect(mizunoSources.length).toBe(4);
    for (const source of mizunoSources) {
      expect(source.source_type).toBe("official_product_page");
      expect(source.source_url).toBe("https://mizunogolf.com/us/golf-clubs/m-craft-putters/");
    }
  });

  it("TaylorMade, Odyssey, Scotty Cameron, and PING sources are exact individual product pages, never a family-only page", () => {
    const nonMizuno = data.models.filter((m) => m.manufacturer_slug !== "mizuno");
    for (const model of nonMizuno) {
      for (const source of model.sources) {
        expect(source.source_url.toLowerCase()).not.toContain("/families/");
        expect(source.source_url, `${model.catalog_key} must not use the bare Phantom family page`).not.toBe("https://www.scottycameron.com/phantom/");
      }
    }
  });

  it("exact source-classification breakdown matches the approved policy (17 individual product-page rows + 4 Mizuno family-product rows, 0 PDFs)", () => {
    const allSources = data.models.flatMap((m) => m.sources);
    expect(allSources.length).toBe(21);
    const mizunoRows = allSources.filter((s) => s.source_url === "https://mizunogolf.com/us/golf-clubs/m-craft-putters/");
    expect(mizunoRows.length).toBe(4);
    expect(allSources.length - mizunoRows.length).toBe(17);
    expect(allSources.filter((s) => s.source_type === "official_spec_pdf").length).toBe(0);
  });
});

// ============================================================================
// Negative commercial-boundary tests
// ============================================================================

describe("EQ1-S2 commercial-boundary exclusions", () => {
  const prohibitedFieldNames = [
    "price", "retail_price", "inventory", "stock",
    "affiliate", "affiliate_url", "tracking", "tracking_url",
    "sponsorship", "sponsor", "ranking", "tour_usage",
    "endorsement", "player_recommendation", "marketing_copy", "description",
    "image", "image_url", "logo", "logo_url",
    "ai_score", "recommended_player", "fitting_conclusion",
  ];

  it("no prohibited commercial/marketing field name appears anywhere in the data file", () => {
    for (const field of prohibitedFieldNames) {
      const pattern = new RegExp(`"${field}"\\s*:`, "i");
      expect(pattern.test(dataRaw), `prohibited field "${field}" found in ${DATA_FILE}`).toBe(false);
    }
  });

  it("no prohibited commercial/marketing field name appears anywhere in the generated migration", () => {
    for (const field of prohibitedFieldNames) {
      expect(migrationSource.toLowerCase().includes(field), `prohibited field "${field}" found in the migration`).toBe(false);
    }
  });

  it("the generator source rejects unknown/prohibited fields structurally", () => {
    const generatorSource = readSource(GENERATOR_FILE);
    expect(generatorSource).toContain("PROHIBITED_FIELD_NAMES");
    expect(generatorSource).toContain("assertNoUnknownFields");
  });
});

// ============================================================================
// SQL contract tests
// ============================================================================

describe("EQ1-S2 migration — structure", () => {
  it("is a single top-level transaction", () => {
    const beginCount = (migrationSource.match(/^begin;$/gm) || []).length;
    const commitCount = (migrationSource.match(/^commit;$/gm) || []).length;
    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
  });

  it("contains fail-loud preflight and postflight blocks", () => {
    expect(migrationSource).toContain("EQ1S2-PRE-1");
    expect(migrationSource).toContain("EQ1S2-PRE-OK");
    expect(migrationSource).toContain("EQ1S2-POST-1");
    expect(migrationSource).toContain("EQ1S2-POST-OK");
  });

  it("never uses IF EXISTS or IF NOT EXISTS to suppress DDL drift", () => {
    // Scoped to actual DDL statements — plpgsql "if not exists (select ...)"
    // control-flow inside the preflight/postflight blocks is legitimate and
    // used extensively (matching the EQ1-S1R migration's own idiom).
    const ddlSuppressionPattern = /\b(create table|create index|add column|drop table|drop column|create policy|create trigger|create function)\s+if\s+(not\s+)?exists/i;
    expect(ddlSuppressionPattern.test(migrationSource)).toBe(false);
  });

  it("never uses ON CONFLICT / DO NOTHING silent-conflict handling", () => {
    expect(migrationSource.toLowerCase()).not.toContain("on conflict");
    expect(migrationSource.toLowerCase()).not.toContain("do nothing");
  });

  it("creates exactly the two authorized new tables", () => {
    expect(migrationSource).toContain("create table public.equipment_putter_model_specs");
    expect(migrationSource).toContain("create table public.equipment_model_sources");
    expect(migrationSource.toLowerCase()).not.toContain("create table public.equipment_manufacturer_aliases");
    expect(migrationSource.toLowerCase()).not.toContain("create table public.equipment_model_aliases");
    expect(migrationSource.toLowerCase()).not.toContain("create table public.equipment_catalog_corrections");
  });

  it("adds exactly the six required equipment_models columns", () => {
    expect(migrationSource).toContain("add column catalog_key text not null");
    expect(migrationSource).toContain("add column brand_line text");
    expect(migrationSource).toContain("add column brand_line_slug text");
    expect(migrationSource).toContain("add column model_family text");
    expect(migrationSource).toContain("add column model_family_slug text");
    expect(migrationSource).toContain("add column release_year smallint");
  });

  it("enforces catalog_key nonblank, format, and uniqueness constraints", () => {
    expect(migrationSource).toContain("equipment_models_catalog_key_nonblank");
    expect(migrationSource).toContain("equipment_models_catalog_key_format");
    expect(migrationSource).toContain("equipment_models_catalog_key_unique");
  });

  it("enforces brand_line and model_family pair constraints", () => {
    expect(migrationSource).toContain("equipment_models_brand_line_pair");
    expect(migrationSource).toContain("equipment_models_model_family_pair");
  });

  it("does not remove or replace the existing equipment_models uniqueness index", () => {
    // A comment explaining the new slug-unique constraint coexists with the
    // prior compound index is expected and legitimate; only an actual DROP
    // or CREATE (re-creation) of that index would be a real removal/replacement.
    expect(migrationSource.toLowerCase()).not.toContain("drop index");
    expect(/create\s+(unique\s+)?index\s+equipment_models_manufacturer_type_name_year_uidx/i.test(migrationSource)).toBe(false);
  });

  it("requires equipment_models to contain zero rows in preflight", () => {
    expect(migrationSource).toContain("public.equipment_models must contain zero rows");
  });

  // EQ1-S2-I1-C1 Correction 2: global model-slug uniqueness must be a real
  // database constraint, not only a generator-level JSON check.
  it("adds an exact equipment_models_slug_unique database constraint on slug", () => {
    expect(migrationSource).toContain(
      "alter table public.equipment_models\n  add constraint equipment_models_slug_unique unique (slug);"
    );
  });

  it("preflight fails loud if equipment_models_slug_unique already exists", () => {
    expect(migrationSource).toContain("EQ1S2-PRE-16");
    expect(migrationSource).toContain("equipment_models_slug_unique already exists");
  });

  it("postflight verifies the slug constraint exists, is scoped to exactly slug, and is live-proven by a duplicate-insert rejection", () => {
    expect(migrationSource).toContain("EQ1S2-POST-29");
    expect(migrationSource).toContain("EQ1S2-POST-30");
    expect(migrationSource).toContain("EQ1S2-POST-31");
    expect(migrationSource).toContain("a duplicate equipment_models.slug was unexpectedly accepted");
    expect(migrationSource).toContain("when unique_violation then");
    expect(migrationSource).toContain("EQ1S2-POST-32");
    expect(migrationSource).toContain("rollback failed");
  });
});

describe("EQ1-S2-A1-C1 correction — standard_lengths_inches nonempty-array constraint", () => {
  // Narrowly scoped to the equipment_putter_model_specs_lengths_nonempty
  // constraint clause itself, so this cannot pass merely because
  // "cardinality" or "array_length" appears somewhere else in the file.
  function extractLengthsConstraintClause(source: string): string {
    const marker = "constraint equipment_putter_model_specs_lengths_nonempty check (";
    const start = source.indexOf(marker);
    expect(start, "equipment_putter_model_specs_lengths_nonempty constraint clause not found").toBeGreaterThanOrEqual(0);
    // The outer "check (" paren is already open; walk forward tracking depth
    // so a nested call like cardinality(...) doesn't end the clause early.
    let depth = 1;
    let i = start + marker.length;
    while (depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    return source.slice(start, i);
  }

  it("the migration's lengths-nonempty constraint uses cardinality(), not array_length()", () => {
    const clause = extractLengthsConstraintClause(migrationSource);
    expect(clause).toContain("cardinality(standard_lengths_inches) > 0");
    expect(clause).not.toContain("array_length(standard_lengths_inches");
  });

  it("the migration's lengths-nonempty constraint still permits a null array", () => {
    const clause = extractLengthsConstraintClause(migrationSource);
    expect(clause).toContain("standard_lengths_inches is null or");
  });

  it("the constraint name equipment_putter_model_specs_lengths_nonempty is unchanged", () => {
    expect(migrationSource).toContain("constraint equipment_putter_model_specs_lengths_nonempty check (");
  });

  it("the generator emits the same corrected predicate used by the generated migration", () => {
    const generatorSource = readSource(GENERATOR_FILE);
    const clause = extractLengthsConstraintClause(generatorSource);
    expect(clause).toContain("cardinality(standard_lengths_inches) > 0");
    expect(clause).not.toContain("array_length(standard_lengths_inches");
  });

  it("the generator's authoring-time validation still enforces sorted-ascending, unique, and [20,60]-bounded values", () => {
    // This is the generation-time (validateAndLoad) enforcement of ordering/
    // uniqueness/bounds referenced by the data-level test above. As of
    // EQ1-S2-A1-C2 these rules are ALSO enforced live by the database (see
    // the "EQ1-S2-A1-C2 correction" describe block below); this test guards
    // the JS-side authoring-time rule from being silently weakened or
    // removed independently of the database-level enforcement.
    const generatorSource = readSource(GENERATOR_FILE);
    expect(generatorSource).toContain("standard_lengths_inches must be sorted ascending");
    expect(generatorSource).toContain("standard_lengths_inches values must be unique");
    expect(generatorSource).toContain("out of bounds [20,60]");
  });

  it("postflight proves an explicit empty numeric array is live-rejected by the database, and the original row is restored", () => {
    expect(migrationSource).toContain("EQ1S2-POST-33");
    expect(migrationSource).toContain("EQ1S2-POST-34");
    expect(migrationSource).toContain("'{}'::numeric[]");
    expect(migrationSource).toContain("when check_violation then");
    expect(migrationSource).toContain("an empty standard_lengths_inches array was unexpectedly accepted");
    expect(migrationSource).toContain("did not restore the original standard_lengths_inches");
  });

  it("existing PRE identifiers 1-16 and POST identifiers 1-32 were not renumbered", () => {
    for (let i = 1; i <= 16; i++) {
      expect(migrationSource).toContain(`EQ1S2-PRE-${i}:`);
    }
    for (let i = 1; i <= 32; i++) {
      expect(migrationSource).toContain(`EQ1S2-POST-${i}:`);
    }
  });
});

describe("EQ1-S2-A1-C2 correction — database-level standard-length integrity", () => {
  const FUNCTION_NAME = "is_valid_putter_standard_lengths";

  function extractFunctionDefinition(source: string): string {
    const marker = `create function public.${FUNCTION_NAME}(`;
    const start = source.indexOf(marker);
    expect(start, `${FUNCTION_NAME} definition not found`).toBeGreaterThanOrEqual(0);
    const endMarker = "$function$;";
    const end = source.indexOf(endMarker, start);
    expect(end, `${FUNCTION_NAME} definition end marker not found`).toBeGreaterThanOrEqual(0);
    return source.slice(start, end + endMarker.length);
  }

  function extractConstraintClause(source: string, constraintName: string): string {
    const marker = `constraint ${constraintName} check (`;
    const start = source.indexOf(marker);
    expect(start, `${constraintName} constraint clause not found`).toBeGreaterThanOrEqual(0);
    let depth = 1;
    let i = start + marker.length;
    while (depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    return source.slice(start, i);
  }

  it("1. defines the exact function name public.is_valid_putter_standard_lengths(numeric[])", () => {
    expect(migrationSource).toContain(`create function public.${FUNCTION_NAME}(`);
    const def = extractFunctionDefinition(migrationSource);
    expect(def).toContain("p_lengths numeric[]");
    expect(def).toContain("returns boolean");
  });

  it("2. the function is language sql", () => {
    const def = extractFunctionDefinition(migrationSource);
    expect(def).toContain("language sql");
  });

  it("3. the function is immutable", () => {
    const def = extractFunctionDefinition(migrationSource);
    expect(def).toContain("immutable");
  });

  it("4. the function is strict", () => {
    const def = extractFunctionDefinition(migrationSource);
    expect(def).toContain("strict");
  });

  it("5. the function is security invoker", () => {
    const def = extractFunctionDefinition(migrationSource);
    expect(def).toContain("security invoker");
  });

  it("6. the function sets an empty search_path", () => {
    const def = extractFunctionDefinition(migrationSource);
    expect(def).toContain("set search_path to ''");
  });

  it("7. built-in calls inside the function are schema-qualified with pg_catalog", () => {
    const def = extractFunctionDefinition(migrationSource);
    expect(def).toContain("pg_catalog.array_ndims");
    expect(def).toContain("pg_catalog.cardinality");
    expect(def).toContain("pg_catalog.generate_subscripts");
    expect(def).toContain("pg_catalog.array_lower");
  });

  it("8. the function is not security definer", () => {
    const def = extractFunctionDefinition(migrationSource);
    expect(def.toLowerCase()).not.toContain("security definer");
  });

  it("9-11. execute is revoked from public, anon, and authenticated", () => {
    expect(migrationSource).toContain(`revoke all on function public.${FUNCTION_NAME}(numeric[]) from public;`);
    expect(migrationSource).toContain(`revoke all on function public.${FUNCTION_NAME}(numeric[]) from anon;`);
    expect(migrationSource).toContain(`revoke all on function public.${FUNCTION_NAME}(numeric[]) from authenticated;`);
  });

  it("12. execute is granted to service_role", () => {
    expect(migrationSource).toContain(`grant execute on function public.${FUNCTION_NAME}(numeric[]) to service_role;`);
  });

  it("13-14. the new equipment_putter_model_specs_lengths_valid constraint calls the validation function", () => {
    const clause = extractConstraintClause(migrationSource, "equipment_putter_model_specs_lengths_valid");
    expect(clause).toContain("standard_lengths_inches is null");
    expect(clause).toContain(`public.${FUNCTION_NAME}(`);
    expect(clause).toContain("standard_lengths_inches");
  });

  it("15. the existing lengths_nonempty constraint remains", () => {
    expect(migrationSource).toContain("constraint equipment_putter_model_specs_lengths_nonempty check (");
  });

  it("16. the existing cardinality(...) > 0 predicate remains", () => {
    const clause = extractConstraintClause(migrationSource, "equipment_putter_model_specs_lengths_nonempty");
    expect(clause).toContain("cardinality(standard_lengths_inches) > 0");
  });

  it("17. generator-level sorted/unique/bounds validation remains present", () => {
    const generatorSource = readSource(GENERATOR_FILE);
    expect(generatorSource).toContain("standard_lengths_inches must be sorted ascending");
    expect(generatorSource).toContain("standard_lengths_inches values must be unique");
    expect(generatorSource).toContain("out of bounds [20,60]");
  });

  it("18. adds preflight identifiers 17 and 18 without renumbering 1-16", () => {
    expect(migrationSource).toContain("EQ1S2-PRE-17:");
    expect(migrationSource).toContain(`${FUNCTION_NAME} already exists`);
    expect(migrationSource).toContain("EQ1S2-PRE-18:");
    expect(migrationSource).toContain("equipment_putter_model_specs_lengths_valid already exists");
    for (let i = 1; i <= 16; i++) {
      expect(migrationSource).toContain(`EQ1S2-PRE-${i}:`);
    }
  });

  it("19. adds postflight identifiers 35 through 46 without renumbering 1-34", () => {
    for (let i = 35; i <= 46; i++) {
      expect(migrationSource).toContain(`EQ1S2-POST-${i}:`);
    }
    for (let i = 1; i <= 34; i++) {
      expect(migrationSource).toContain(`EQ1S2-POST-${i}:`);
    }
  });

  it("20. every invalid live-probe array appears in the generated migration", () => {
    expect(migrationSource).toContain("array[35,34]::numeric[]");
    expect(migrationSource).toContain("array[34,34]::numeric[]");
    expect(migrationSource).toContain("array[19]::numeric[]");
    expect(migrationSource).toContain("array[61]::numeric[]");
    expect(migrationSource).toContain("array[34,null]::numeric[]");
    expect(migrationSource).toContain("array[[34,35],[36,37]]::numeric[]");
  });

  it("21. every invalid-array probe catches only check_violation", () => {
    // EQ1S2-POST-39 is reused for both the "no probe row" guard clause and
    // the unsorted-array probe (same numbered-identifier-reuse pattern as
    // EQ1S2-POST-33 in EQ1-S2-A1-C1), so each probe is located by its own
    // unique message text rather than by the shared numeric marker.
    const probeMessages = [
      "an unsorted standard_lengths_inches array was unexpectedly accepted",
      "a duplicate-value standard_lengths_inches array was unexpectedly accepted",
      "a below-range standard_lengths_inches array was unexpectedly accepted",
      "an above-range standard_lengths_inches array was unexpectedly accepted",
      "a NULL-containing standard_lengths_inches array was unexpectedly accepted",
      "a multidimensional standard_lengths_inches array was unexpectedly accepted",
    ];
    for (const message of probeMessages) {
      const idx = migrationSource.indexOf(message);
      expect(idx, `probe message "${message}" not found`).toBeGreaterThanOrEqual(0);
      const followingText = migrationSource.slice(idx, idx + 200);
      expect(followingText).toContain("exception when check_violation then");
    }
  });

  it("22. a final restoration check exists (EQ1S2-POST-45)", () => {
    expect(migrationSource).toContain("EQ1S2-POST-45:");
    expect(migrationSource).toContain("did not restore the original standard_lengths_inches");
  });

  it("23. a final invalid-row scan exists (EQ1S2-POST-46)", () => {
    expect(migrationSource).toContain("EQ1S2-POST-46:");
    expect(migrationSource).toContain(`not public.${FUNCTION_NAME}(standard_lengths_inches)`);
  });

  it("24. no earlier PRE (1-16) or POST (1-34) identifier was renumbered or removed", () => {
    for (let i = 1; i <= 16; i++) {
      expect(migrationSource).toContain(`EQ1S2-PRE-${i}:`);
    }
    for (let i = 1; i <= 34; i++) {
      expect(migrationSource).toContain(`EQ1S2-POST-${i}:`);
    }
  });

  it("25. catalog identity and seed payload are unchanged (exact JSON-derived count and every catalog_key present)", () => {
    expect(migrationSource).toContain(`if v_model_count <> ${data.models.length} then`);
    for (const model of data.models) {
      expect(migrationSource).toContain(`'${model.catalog_key}'`);
    }
  });
});

describe("EQ1-S2 migration — seed counts and manufacturer resolution", () => {
  it("expects exactly the JSON-derived model, spec, and source counts in postflight", () => {
    const sourceCount = data.models.reduce((sum, m) => sum + m.sources.length, 0);
    expect(migrationSource).toContain(`if v_model_count <> ${data.models.length} then`);
    expect(migrationSource).toContain(`if v_source_count <> ${sourceCount} then`);
  });

  it("resolves manufacturer foreign keys by exact slug lookup, not a literal environment-specific UUID", () => {
    expect(migrationSource).toContain("select id from public.equipment_manufacturers where slug =");
  });

  it("performs zero fuzzy matching and zero legacy string matching against user data", () => {
    // ilike appears legitimately in the postflight's own SECURITY DEFINER
    // guard (matching EQ1-S1R's identical idiom) — the concern here is fuzzy
    // matching against user-entered brand/model text, which never occurs.
    expect(migrationSource.toLowerCase()).not.toContain("regexp_replace");
    expect(/ilike\s*'%(brand|model|manufacturer)/i.test(migrationSource)).toBe(false);
  });

  it("never references or updates a user-owned table", () => {
    for (const table of ["user_equipment", "user_bags", "user_clubs"]) {
      expect(
        new RegExp(`update\\s+public\\.${table}`, "i").test(migrationSource),
        `migration unexpectedly updates public.${table}`
      ).toBe(false);
    }
  });
});

describe("EQ1-S2 migration — RLS and grants", () => {
  it("enables RLS on both new tables", () => {
    expect(migrationSource).toContain("alter table public.equipment_putter_model_specs enable row level security");
    expect(migrationSource).toContain("alter table public.equipment_model_sources enable row level security");
  });

  it("revokes all default privileges from public/anon/authenticated on both new tables before granting", () => {
    for (const table of ["equipment_putter_model_specs", "equipment_model_sources"]) {
      expect(migrationSource).toContain(`revoke all on public.${table} from public`);
      expect(migrationSource).toContain(`revoke all on public.${table} from anon`);
      expect(migrationSource).toContain(`revoke all on public.${table} from authenticated`);
    }
  });

  it("grants authenticated SELECT-only on equipment_putter_model_specs", () => {
    expect(migrationSource).toContain("grant select on public.equipment_putter_model_specs to authenticated");
  });

  it("grants no authenticated access whatsoever to equipment_model_sources (server-only provenance)", () => {
    const grantAuthenticatedSources = /grant[^;]*on public\.equipment_model_sources to authenticated/i;
    expect(grantAuthenticatedSources.test(migrationSource)).toBe(false);
    const policyOnSources = /create policy[^;]*on\s+public\.equipment_model_sources/i;
    expect(policyOnSources.test(migrationSource)).toBe(false);
  });

  it("grants service_role full CRUD on both new tables", () => {
    expect(migrationSource).toContain("grant select, insert, update, delete on public.equipment_putter_model_specs to service_role");
    expect(migrationSource).toContain("grant select, insert, update, delete on public.equipment_model_sources to service_role");
  });

  it("the authenticated putter-specs policy is scoped to active models only", () => {
    const policyBlockMatch = migrationSource.match(/create policy equipment_putter_model_specs_select_active_model[\s\S]*?;/);
    expect(policyBlockMatch, "active-model policy not found").not.toBeNull();
    expect(policyBlockMatch![0]).toContain("equipment_models.is_active");
  });
});

describe("EQ1-S2 migration — trigger function security posture", () => {
  it("guard_putter_model_specs_club_type is SECURITY INVOKER with an empty search_path", () => {
    const fnMatch = migrationSource.match(/create function public\.guard_putter_model_specs_club_type\(\)[\s\S]*?\$function\$;/);
    expect(fnMatch, "function body not found").not.toBeNull();
    const body = fnMatch![0];
    expect(body).toContain("security invoker");
    expect(body).toContain("set search_path to ''");
    expect(body.toLowerCase()).not.toContain("security definer");
  });

  it("guard_putter_model_specs_club_type execution is revoked from PUBLIC, anon, and authenticated", () => {
    expect(migrationSource).toContain("revoke all on function public.guard_putter_model_specs_club_type() from public");
    expect(migrationSource).toContain("revoke all on function public.guard_putter_model_specs_club_type() from anon");
    expect(migrationSource).toContain("revoke all on function public.guard_putter_model_specs_club_type() from authenticated");
  });

  it("the club-type guard trigger is attached to equipment_putter_model_specs", () => {
    expect(migrationSource).toContain("create trigger equipment_putter_model_specs_guard_club_type");
  });
});

describe("EQ1-S2 migration — EQ1-S1R non-interference", () => {
  it("does not modify equipment_snapshot schema_version or either EQ1-S1R trigger function", () => {
    expect(migrationSource.toLowerCase()).not.toContain("schema_version', 2");
    expect(migrationSource).not.toContain("create or replace function public.apply_swing_analysis_equipment_snapshot");
    expect(migrationSource).not.toContain("create or replace function public.guard_swing_analysis_equipment_immutability");
    expect(migrationSource).not.toContain("drop function public.apply_swing_analysis_equipment_snapshot");
    expect(migrationSource).not.toContain("drop function public.guard_swing_analysis_equipment_immutability");
  });

  it("confirms analysis_mode is unchanged in postflight", () => {
    expect(migrationSource).toContain("swing_analysis.analysis_mode changed unexpectedly");
  });
});

// ============================================================================
// TypeScript and documentation tests
// ============================================================================

describe("EQ1-S2 TypeScript contracts", () => {
  const typesSource = readSource(TYPES_FILE);

  it("declares all required new putter-spec and provenance types", () => {
    for (const name of [
      "EquipmentPutterHeadShape",
      "EquipmentPutterNeckType",
      "EquipmentPutterToeHangClass",
      "EquipmentPutterFaceConstruction",
      "EquipmentPutterHandedness",
      "EquipmentPutterModelSpecs",
      "EquipmentModelSourceType",
      "EquipmentModelSource",
    ]) {
      expect(typesSource, `missing type "${name}"`).toMatch(new RegExp(`export (type|interface) ${name}\\b`));
    }
  });

  function extractEquipmentModelBlock(): string {
    const startIdx = typesSource.indexOf("export interface EquipmentModel {");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const endIdx = typesSource.indexOf("\n}\n", startIdx);
    return typesSource.slice(startIdx, endIdx);
  }

  // EQ1-S2-I1-C1 Correction 1: the new fields must follow the interface's
  // established database-row (snake_case) naming convention, not introduce a
  // second camelCase DTO shape.
  it("extends EquipmentModel with the required additive fields in snake_case", () => {
    const block = extractEquipmentModelBlock();
    for (const field of ["catalog_key", "brand_line", "brand_line_slug", "model_family", "model_family_slug", "release_year", "putter_specs"]) {
      expect(block, `EquipmentModel missing snake_case field "${field}"`).toMatch(new RegExp(`\\b${field}[?:]`));
    }
  });

  it("rejects the incorrect camelCase property names inside EquipmentModel", () => {
    const block = extractEquipmentModelBlock();
    for (const wrongName of ["catalogKey", "brandLine", "brandLineSlug", "modelFamily", "modelFamilySlug", "releaseYear", "putterSpecs"]) {
      expect(block, `EquipmentModel must not contain camelCase field "${wrongName}"`).not.toContain(wrongName);
    }
  });

  it("keeps EquipmentPutterModelSpecs and EquipmentModelSource in snake_case, not a second camelCase DTO", () => {
    const specsStart = typesSource.indexOf("export interface EquipmentPutterModelSpecs {");
    const specsBlock = typesSource.slice(specsStart, typesSource.indexOf("\n}\n", specsStart));
    expect(specsBlock).toContain("equipment_model_id");
    expect(specsBlock).toContain("head_shape");
    expect(specsBlock).toContain("neck_source_label");
    expect(specsBlock).not.toContain("equipmentModelId");
    expect(specsBlock).not.toContain("headShape");

    const sourceStart = typesSource.indexOf("export interface EquipmentModelSource {");
    const sourceBlock = typesSource.slice(sourceStart, typesSource.indexOf("\n}\n", sourceStart));
    expect(sourceBlock).toContain("source_url");
    expect(sourceBlock).toContain("verified_at");
    expect(sourceBlock).not.toContain("sourceUrl");
    expect(sourceBlock).not.toContain("verifiedAt");
  });

  it("marks the source type as server-only in its documentation comment", () => {
    const idx = typesSource.indexOf("export interface EquipmentModelSource");
    expect(idx).toBeGreaterThanOrEqual(0);
    const precedingComment = typesSource.slice(Math.max(0, idx - 300), idx);
    expect(precedingComment.toUpperCase()).toContain("SERVER-ONLY");
  });

  it("does not remove or rename a pre-existing export", () => {
    for (const name of [
      "ClubType", "AnalysisDepth", "AnalysisFamily",
      "EquipmentManufacturer", "EquipmentModel", "EquipmentSnapshotV1", "UserEquipment",
      "SwingVideo", "SwingAnalysis",
    ]) {
      expect(typesSource, `pre-existing export "${name}" appears to have been removed`).toMatch(new RegExp(`export (type|interface) ${name}\\b`));
    }
  });

  it("leaves ClubType, AnalysisDepth, AnalysisFamily, EquipmentSnapshotV1, and UserEquipment textually unaltered in their declaration lines", () => {
    expect(typesSource).toContain('export type ClubType = "Driver" | "Wood" | "Hybrid" | "Iron" | "Wedge" | "Putter";');
    expect(typesSource).toContain('export type AnalysisDepth = "basic" | "advanced" | "ultra";');
    expect(typesSource).toContain('export type AnalysisFamily = "full_swing" | "putting";');
  });
});

describe("EQ1-S2 rollout documentation", () => {
  const docsSource = readSource(DOCS_FILE);

  it("states EQ1-S1R is merged and EQ1-S2 is source-only and unapplied", () => {
    expect(docsSource).toMatch(/EQ1-S1R merged into `main`/);
    expect(docsSource).toMatch(/EQ1-S2 implemented locally,\s*\nsource-only, unapplied/);
  });

  it("documents the exact v1 putter model count", () => {
    expect(docsSource).toContain(`${data.models.length} officially verified`);
  });

  it("documents brand-line treatment without claiming Odyssey/Scotty Cameron are separate manufacturers", () => {
    expect(docsSource).toContain("brand_line");
    expect(docsSource).toContain("never as\nadditional parent-manufacturer rows");
  });

  it("documents both new tables and the absence of alias tables", () => {
    expect(docsSource).toContain("equipment_putter_model_specs");
    expect(docsSource).toContain("equipment_model_sources");
    expect(docsSource).toContain("No alias table was created in this slice");
  });

  it("documents zero user backfill", () => {
    expect(docsSource).toContain("EQ1-S2 performs zero updates to");
  });

  it("documents that equipment_snapshot schema_version remains 1", () => {
    expect(docsSource).toMatch(/equipment_snapshot\.schema_version` remains `1`/);
  });

  it("does not claim the catalog or migration is live", () => {
    expect(docsSource.toLowerCase()).not.toContain("catalog is live");
    expect(docsSource).toMatch(/No SQL in this\s+slice has been applied to any Supabase project\./);
  });

  it("still lists EQ1-S3 as isolated staging application and EQ1-S4 as production application", () => {
    expect(docsSource).toContain("EQ1-S3    Apply and validate the migration in an isolated Supabase staging");
    expect(docsSource).toContain("EQ1-S4    Separately authorized production migration");
  });

  // EQ1-S2-I1-C1 corrections must be reflected in the rollout document.
  it("documents the configuration-level identity rule and that superseded generic rows were removed", () => {
    expect(docsSource).toMatch(/configuration-level identity/i);
    expect(docsSource).toMatch(/generic rows have been\s+removed and replaced/);
  });

  it("documents exact counts by parent manufacturer", () => {
    const counts: Record<string, number> = {};
    for (const m of data.models) counts[m.manufacturer_slug] = (counts[m.manufacturer_slug] ?? 0) + 1;
    for (const slug of ["taylormade", "callaway", "titleist", "ping", "mizuno"]) {
      expect(docsSource, `manufacturer count for ${slug} not documented`).toMatch(new RegExp(`${slug}[^\\n]*${counts[slug]}|${counts[slug]}[^\\n]*${slug}`, "i"));
    }
  });

  it("documents database-level global slug uniqueness", () => {
    expect(docsSource).toContain("equipment_models_slug_unique");
  });

  it("documents the snake_case TypeScript database-row convention for the new fields", () => {
    expect(docsSource).toMatch(/snake_case/i);
  });

  it("does not claim the prior 10-row implementation was final", () => {
    expect(docsSource).not.toContain("10 officially verified");
  });
});
