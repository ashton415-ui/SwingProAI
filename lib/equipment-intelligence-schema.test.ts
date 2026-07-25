import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

/** Reads a repo-relative source file, normalized to LF so checks don't
 *  depend on whether this checkout has CRLF or LF line endings. */
function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const MIGRATION_FILE = "supabase/migrations/20260725020835_equipment_intelligence_putting_foundation.sql";
const TYPES_FILE = "types/database.ts";
const DOCS_FILE = "docs/EQUIPMENT_INTELLIGENCE_ROLLOUT.md";
const THIS_TEST_FILE = "lib/equipment-intelligence-schema.test.ts";
// Authorized by EQ1-S1R-C1: the canonical baseline-migration selection
// guard, corrected to select the baseline by exact filename instead of by
// "the only .sql file present" so it keeps validating the right migration
// now that this EQ1-S1R migration coexists alongside it.
const BASELINE_TEST_FILE = "lib/migration-replay-baseline.test.ts";

/** Isolates a `create function public.<name>() ... $function$;` block from
 *  the migration source by its unique start/end markers, so assertions stay
 *  scoped to one function's body rather than matching anywhere in the file. */
function extractFunctionBody(source: string, functionName: string): string {
  const startMarker = `create function public.${functionName}()`;
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `${MIGRATION_FILE}: could not locate "${startMarker}"`).toBeGreaterThanOrEqual(0);

  const endIdx = source.indexOf("$function$;", startIdx);
  expect(endIdx, `${MIGRATION_FILE}: could not find the closing "$function$;" for ${functionName}`).toBeGreaterThan(startIdx);

  return source.slice(startIdx, endIdx + "$function$;".length);
}

describe("EQ1-S1R migration — file exists and is source-only", () => {
  it("the generated migration file exists", () => {
    expect(existsSync(path.join(repoRoot, MIGRATION_FILE)), `missing file: ${MIGRATION_FILE}`).toBe(true);
  });

  it("the filename ends with the expected suffix", () => {
    expect(MIGRATION_FILE.endsWith("_equipment_intelligence_putting_foundation.sql")).toBe(true);
  });
});

describe("EQ1-S1R migration — transaction, preflight, postflight", () => {
  const source = readSource(MIGRATION_FILE);

  it("wraps the whole migration in a single transaction", () => {
    expect(source).toMatch(/^\s*begin;/m);
    expect(source).toMatch(/\ncommit;\s*$/);
  });

  it("contains a fail-loud preflight section with numbered exceptions", () => {
    expect(source).toContain("PREFLIGHT");
    const preflightExceptions = (source.match(/EQ1S1R-PRE-\d+/g) ?? []).length;
    expect(preflightExceptions, "expected multiple distinct EQ1S1R-PRE-N preflight checks").toBeGreaterThanOrEqual(15);
  });

  it("contains a fail-loud postflight section with numbered exceptions", () => {
    expect(source).toContain("POSTFLIGHT");
    const postflightExceptions = (source.match(/EQ1S1R-POST-\d+/g) ?? []).length;
    expect(postflightExceptions, "expected multiple distinct EQ1S1R-POST-N postflight checks").toBeGreaterThanOrEqual(20);
  });

  it("does not use IF EXISTS / IF NOT EXISTS to hide schema drift on DDL statements", () => {
    const lower = source.toLowerCase();
    const forbidden = [
      "table if not exists", "index if not exists", "type if not exists",
      "policy if not exists", "trigger if not exists", "function if not exists",
      "column if not exists", "constraint if not exists",
      "drop table if exists", "drop function if exists", "drop trigger if exists",
      "drop policy if exists", "drop index if exists", "drop constraint if exists",
      "drop column if exists",
    ];
    for (const phrase of forbidden) {
      expect(lower, `${MIGRATION_FILE}: unexpectedly contains DDL-suppressing "${phrase}"`).not.toContain(phrase);
    }
  });
});

describe("EQ1-S1R migration — trigger function security posture", () => {
  const source = readSource(MIGRATION_FILE);
  const functionNames = [
    "validate_user_equipment_catalog_reference",
    "apply_swing_analysis_equipment_snapshot",
    "guard_swing_analysis_equipment_immutability",
  ];

  it("none of the three new trigger functions use SECURITY DEFINER", () => {
    for (const name of functionNames) {
      const body = extractFunctionBody(source, name);
      expect(body.toLowerCase(), `${name}: unexpectedly SECURITY DEFINER`).not.toContain("security definer");
      expect(body.toLowerCase(), `${name}: missing explicit SECURITY INVOKER`).toContain("security invoker");
    }
  });

  it("all three new trigger functions set an empty search_path", () => {
    for (const name of functionNames) {
      const body = extractFunctionBody(source, name);
      expect(body.toLowerCase(), `${name}: missing "set search_path to ''"`).toMatch(/set search_path to ''/);
    }
  });

  it("all three new trigger functions schema-qualify every FROM/JOIN relation reference", () => {
    // Column references like "equipment_manufacturers.id" after a qualified
    // "from public.equipment_manufacturers" are normal, valid SQL and do not
    // need re-qualification — only the clause that actually introduces the
    // relation (FROM/JOIN) must resolve correctly under an empty
    // search_path, so only those clauses are checked here.
    const tables = ["user_equipment", "equipment_manufacturers", "equipment_models"];
    for (const name of functionNames) {
      const body = extractFunctionBody(source, name);
      for (const table of tables) {
        const unqualifiedFrom = new RegExp(`\\bfrom\\s+${table}\\b`, "i");
        const unqualifiedJoin = new RegExp(`\\bjoin\\s+${table}\\b`, "i");
        expect(unqualifiedFrom.test(body), `${name}: found an unqualified "from ${table}" (missing "public." prefix)`).toBe(false);
        expect(unqualifiedJoin.test(body), `${name}: found an unqualified "join ${table}" (missing "public." prefix)`).toBe(false);
      }
    }
  });

  it("revokes PUBLIC/anon/authenticated execute on all three new trigger functions", () => {
    for (const name of functionNames) {
      expect(source, `missing "revoke all on function public.${name}() from public"`).toContain(`revoke all on function public.${name}() from public;`);
      expect(source, `missing "revoke all on function public.${name}() from anon"`).toContain(`revoke all on function public.${name}() from anon;`);
      expect(source, `missing "revoke all on function public.${name}() from authenticated"`).toContain(`revoke all on function public.${name}() from authenticated;`);
    }
  });
});

describe("EQ1-S1R migration — catalog RLS and grants", () => {
  const source = readSource(MIGRATION_FILE);

  it("enables RLS on both new catalog tables", () => {
    expect(source).toContain("alter table public.equipment_manufacturers enable row level security;");
    expect(source).toContain("alter table public.equipment_models enable row level security;");
  });

  it("grants no access to anon on either catalog table", () => {
    expect(source).toContain("revoke all on public.equipment_manufacturers from anon;");
    expect(source).toContain("revoke all on public.equipment_models from anon;");
    expect(source).not.toMatch(/grant\s+[^;]*\bto\s+anon\b[^;]*equipment_(manufacturers|models)/i);
    expect(source).not.toMatch(/grant\s+[^;]*equipment_(manufacturers|models)[^;]*\bto\s+anon\b/i);
  });

  it("grants only SELECT to authenticated on either catalog table (no browser writes)", () => {
    expect(source).toContain("grant select on public.equipment_manufacturers to authenticated;");
    expect(source).toContain("grant select on public.equipment_models to authenticated;");
    expect(source).not.toMatch(/grant\s+[^;]*(insert|update|delete)[^;]*equipment_(manufacturers|models)[^;]*to\s+authenticated/i);
  });

  it("grants service_role full access to both catalog tables", () => {
    expect(source).toMatch(/grant select, insert, update, delete on public\.equipment_manufacturers to service_role;/);
    expect(source).toMatch(/grant select, insert, update, delete on public\.equipment_models to service_role;/);
  });

  it("creates exactly one authenticated, active-only SELECT policy per catalog table", () => {
    expect(source).toMatch(/create policy equipment_manufacturers_select_active\s+on public\.equipment_manufacturers\s+for select\s+to authenticated\s+using \(is_active\);/);
    expect(source).toMatch(/create policy equipment_models_select_active\s+on public\.equipment_models\s+for select\s+to authenticated\s+using \(is_active\);/);
  });

  it("does not use auth.role() for authorization anywhere in the migration", () => {
    expect(source).not.toContain("auth.role()");
  });

  it("does not modify any existing user_equipment or swing_analysis policy", () => {
    expect(source).not.toMatch(/drop policy[^;]*user_equipment/i);
    expect(source).not.toMatch(/drop policy[^;]*swing_analysis/i);
    expect(source).not.toMatch(/alter policy/i);
  });
});

describe("EQ1-S1R migration — manufacturer and model table contracts", () => {
  const source = readSource(MIGRATION_FILE);

  it("requires nonblank canonical_name/normalized_name and a strict slug format on both tables", () => {
    for (const table of ["equipment_manufacturers", "equipment_models"]) {
      expect(source).toContain(`${table}_canonical_name_nonblank`);
      expect(source).toContain(`${table}_normalized_name_nonblank`);
      expect(source).toContain(`${table}_slug_format`);
    }
    expect(source).toContain("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'");
  });

  it("requires unique slug and unique normalized_name on equipment_manufacturers", () => {
    expect(source).toContain("equipment_manufacturers_slug_unique unique (slug)");
    expect(source).toContain("equipment_manufacturers_normalized_name_unique unique (normalized_name)");
  });

  it("enforces manufacturer/club_type/normalized_name/model_year uniqueness with a null-safe expression index", () => {
    expect(source).toContain("equipment_models_manufacturer_type_name_year_uidx");
    expect(source).toContain("coalesce(model_year, 0)");
  });

  it("requires equipment_models.specifications to be a JSON object", () => {
    expect(source).toContain("equipment_models_specifications_is_object");
    expect(source).toContain("jsonb_typeof(specifications) = 'object'");
  });

  it("requires manufacturer_id -> equipment_manufacturers.id ON DELETE RESTRICT", () => {
    expect(source).toMatch(/equipment_models_manufacturer_id_fkey foreign key \(manufacturer_id\)\s+references public\.equipment_manufacturers \(id\) on delete restrict/);
  });

  it("adds a swing_analysis.club_id index", () => {
    expect(source).toContain("create index swing_analysis_club_id_idx on public.swing_analysis (club_id);");
  });

  it("never adds swing_videos.user_equipment_id and never ALTERs swing_videos at all", () => {
    // The preflight legitimately checks for and documents the absence of
    // this forbidden column by name — what must never appear is an actual
    // ALTER TABLE against swing_videos (there is none in this migration).
    expect(source.toLowerCase()).not.toMatch(/alter table public\.swing_videos/);
    expect(source).not.toMatch(/add column user_equipment_id/i);
  });
});

describe("EQ1-S1R migration — user_equipment extension", () => {
  const source = readSource(MIGRATION_FILE);

  it("adds nullable manufacturer_id and equipment_model_id with ON DELETE SET NULL", () => {
    expect(source).toContain("add column manufacturer_id uuid,");
    expect(source).toContain("add column equipment_model_id uuid;");
    expect(source).toMatch(/user_equipment_manufacturer_id_fkey foreign key \(manufacturer_id\)\s+references public\.equipment_manufacturers \(id\) on delete set null/);
    expect(source).toMatch(/user_equipment_equipment_model_id_fkey foreign key \(equipment_model_id\)\s+references public\.equipment_models \(id\) on delete set null/);
  });

  it("indexes both new foreign-key columns", () => {
    expect(source).toContain("create index user_equipment_manufacturer_id_idx on public.user_equipment (manufacturer_id);");
    expect(source).toContain("create index user_equipment_equipment_model_id_idx on public.user_equipment (equipment_model_id);");
  });

  it("never drops, renames, or removes brand/model/custom_* legacy columns", () => {
    expect(source.toLowerCase()).not.toMatch(/drop column (brand|model|custom_brand|custom_model|custom_club|custom_notes)/);
    expect(source.toLowerCase()).not.toMatch(/rename column (brand|model|custom_brand|custom_model|custom_club|custom_notes)/);
  });
});

describe("EQ1-S1R migration — analysis_mode is preserved, analysis_family is new and correct", () => {
  const source = readSource(MIGRATION_FILE);

  it("never alters, drops, or renames analysis_mode anywhere", () => {
    expect(source.toLowerCase()).not.toMatch(/alter column analysis_mode/);
    expect(source.toLowerCase()).not.toMatch(/drop column analysis_mode/);
    expect(source.toLowerCase()).not.toMatch(/rename column analysis_mode/);
  });

  it("preflight and postflight both re-verify the swing_videos basic/advanced/ultra contract verbatim", () => {
    const exact = "CHECK ((analysis_mode = ANY (ARRAY[''basic''::text, ''advanced''::text, ''ultra''::text])))";
    const occurrences = (source.match(new RegExp(exact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    expect(occurrences, "expected the exact basic/advanced/ultra check text in both preflight and postflight").toBeGreaterThanOrEqual(2);
  });

  it("adds analysis_family as a new, separate, nullable column", () => {
    expect(source).toContain("add column analysis_family text,");
  });

  it("constrains analysis_family to exactly full_swing and putting", () => {
    expect(source).toMatch(/swing_analysis_analysis_family_check\s+check \(analysis_family is null or analysis_family in \('full_swing', 'putting'\)\)/);
  });
});

describe("EQ1-S1R migration — database-authoritative analysis_family and snapshot derivation", () => {
  const source = readSource(MIGRATION_FILE);
  const snapshotFn = extractFunctionBody(source, "apply_swing_analysis_equipment_snapshot");

  it("unconditionally overwrites analysis_family and equipment_snapshot (never trusts a client-supplied value)", () => {
    expect(snapshotFn).toContain("new.analysis_family :=");
    expect(snapshotFn).toContain("new.equipment_snapshot :=");
    expect(snapshotFn).not.toMatch(/if new\.analysis_family is null/i);
    expect(snapshotFn).not.toMatch(/if new\.equipment_snapshot is null/i);
  });

  it("derives putting for Putter and full_swing for every other club type", () => {
    expect(snapshotFn).toMatch(/v_equipment\.club_type = 'Putter'/);
    expect(snapshotFn).toContain("new.analysis_family := 'putting';");
    expect(snapshotFn).toContain("new.analysis_family := 'full_swing';");
  });

  it("sets both context fields to null when no club is selected", () => {
    expect(snapshotFn).toMatch(/if new\.club_id is null then\s+new\.analysis_family := null;\s+new\.equipment_snapshot := null;/);
  });

  it("validates that the referenced equipment belongs to the analysis user", () => {
    expect(snapshotFn).toContain("v_equipment.user_id is distinct from new.user_id");
    expect(snapshotFn).toMatch(/raise exception/);
  });

  it("does not leak equipment details (brand/model/custom fields) in its exception messages", () => {
    const exceptionLines = snapshotFn.match(/raise exception '[^']*'/g) ?? [];
    for (const line of exceptionLines) {
      expect(line).not.toMatch(/%\s*,\s*(v_equipment\.brand|v_equipment\.model|v_equipment\.custom_brand|v_equipment\.custom_model)/);
    }
  });
});

describe("EQ1-S1R migration — snapshot content boundaries", () => {
  const source = readSource(MIGRATION_FILE);
  const snapshotFn = extractFunctionBody(source, "apply_swing_analysis_equipment_snapshot");

  it("the snapshot is schema_version 1 and includes only the documented keys", () => {
    const objectStart = snapshotFn.indexOf("jsonb_build_object(");
    const objectEnd = snapshotFn.indexOf(");", objectStart);
    const snapshotObject = snapshotFn.slice(objectStart, objectEnd);

    expect(snapshotObject).toContain("'schema_version', 1");
    for (const key of [
      "captured_at", "equipment_id", "club_type", "manufacturer", "model",
      "entered_brand", "entered_model", "custom_club", "custom_brand", "custom_model",
      "shaft_flex", "shaft_weight_grams", "loft_deg",
    ]) {
      expect(snapshotObject, `snapshot object missing key "${key}"`).toContain(`'${key}'`);
    }
  });

  it("never includes identity, secret, or location-shaped fields in the snapshot object", () => {
    const objectStart = snapshotFn.indexOf("jsonb_build_object(");
    const objectEnd = snapshotFn.indexOf(");", objectStart);
    const snapshotObject = snapshotFn.slice(objectStart, objectEnd);

    for (const forbidden of [
      "'user_id'", "'email'", "'display_name'", "'video_url'", "'storage_path'",
      "'stripe", "'subscription_id'", "'ip_", "'location'", "'custom_notes'",
    ]) {
      expect(snapshotObject.toLowerCase(), `snapshot object unexpectedly contains "${forbidden}"`).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("EQ1-S1R migration — snapshot and reference immutability", () => {
  const source = readSource(MIGRATION_FILE);
  const guardFn = extractFunctionBody(source, "guard_swing_analysis_equipment_immutability");

  it("rejects any post-insert change to club_id, analysis_family, or equipment_snapshot", () => {
    expect(guardFn).toContain("new.club_id is distinct from old.club_id");
    expect(guardFn).toContain("new.analysis_family is distinct from old.analysis_family");
    expect(guardFn).toContain("new.equipment_snapshot is distinct from old.equipment_snapshot");
    const exceptionCount = (guardFn.match(/raise exception/g) ?? []).length;
    expect(exceptionCount).toBeGreaterThanOrEqual(3);
  });

  it("the guard trigger is scoped to only those three columns, so normal status/result updates are unaffected", () => {
    expect(source).toMatch(/before update of club_id, analysis_family, equipment_snapshot\s+on public\.swing_analysis/);
  });

  it("adds the equipment-context consistency constraint with both required branches", () => {
    expect(source).toContain("swing_analysis_equipment_context_consistency");
    expect(source).toMatch(/club_id is null and analysis_family is null and equipment_snapshot is null/);
    expect(source).toMatch(/club_id is not null and analysis_family is not null and jsonb_typeof\(equipment_snapshot\) = 'object'/);
  });
});

describe("EQ1-S1R migration — manufacturer/model consistency validation", () => {
  const source = readSource(MIGRATION_FILE);
  const validateFn = extractFunctionBody(source, "validate_user_equipment_catalog_reference");

  it("requires the model to exist and be active, and its club_type to match", () => {
    expect(validateFn).toContain("equipment_models.is_active");
    expect(validateFn).toContain("v_model.club_type is distinct from new.club_type");
  });

  it("derives manufacturer_id from the model when unset, and rejects a conflicting explicit value", () => {
    expect(validateFn).toContain("new.manufacturer_id := v_model.manufacturer_id;");
    expect(validateFn).toContain("new.manufacturer_id is distinct from v_model.manufacturer_id");
  });

  it("validates a manufacturer-only reference against active manufacturers", () => {
    expect(validateFn).toContain("equipment_manufacturers.is_active");
  });

  it("fires before insert and before update of exactly manufacturer_id, equipment_model_id, club_type", () => {
    expect(source).toMatch(/before insert or update of manufacturer_id, equipment_model_id, club_type\s+on public\.user_equipment/);
  });
});

describe("EQ1-S1R migration — conservative manufacturer backfill", () => {
  const source = readSource(MIGRATION_FILE);
  const backfillStart = source.indexOf("EQ1S1R-BACKFILL");
  const backfillSection = source.slice(Math.max(0, source.lastIndexOf("do $$", backfillStart)), backfillStart + 200);

  it("uses exact equality against normalized_name, never fuzzy or wildcard matching", () => {
    expect(backfillSection).toContain("= v_manufacturer.normalized_name");
    expect(backfillSection).not.toContain("similarity(");
    expect(backfillSection).not.toContain("levenshtein(");
    expect(backfillSection).not.toMatch(/ilike\s+'%/);
  });

  it("never assigns equipment_model_id anywhere in the migration", () => {
    expect(source).not.toMatch(/set equipment_model_id\s*=/);
  });

  it("never rewrites the original brand or custom_brand text", () => {
    expect(source).not.toMatch(/set\s+brand\s*=/);
    expect(source).not.toMatch(/set\s+custom_brand\s*=/);
  });

  it("reports only an aggregate, per-manufacturer count — never an individual user or equipment id", () => {
    expect(source).toContain("EQ1S1R-BACKFILL: % row(s) mapped to manufacturer");
    expect(source).not.toMatch(/EQ1S1R-BACKFILL[^']*user_id/);
  });
});

describe("EQ1-S1R migration — no destructive changes and no scope creep", () => {
  const source = readSource(MIGRATION_FILE);

  it("contains no DROP TABLE and no DROP COLUMN anywhere", () => {
    expect(source.toLowerCase()).not.toMatch(/drop table/);
    expect(source.toLowerCase()).not.toMatch(/drop column/);
  });

  it("does not insert any equipment_models rows", () => {
    expect(source).not.toMatch(/insert into public\.equipment_models/);
  });

  it("seeds exactly the five expected manufacturers with no extra columns", () => {
    expect(source).toMatch(/insert into public\.equipment_manufacturers \(canonical_name, slug, normalized_name\)/);
    for (const [canonical, slug] of [
      ["TaylorMade", "taylormade"], ["Callaway", "callaway"], ["Titleist", "titleist"],
      ["PING", "ping"], ["Mizuno", "mizuno"],
    ]) {
      expect(source).toContain(`('${canonical}', '${slug}', '${slug}')`);
    }
  });

  it("the seed statement itself contains no advertising, sponsorship, or ranking data", () => {
    const seedStart = source.indexOf("insert into public.equipment_manufacturers");
    const seedEnd = source.indexOf(";", seedStart);
    const seedStatement = source.slice(seedStart, seedEnd);
    expect(seedStatement).not.toMatch(/sponsor|advertis|affiliate|tracking_url|ranking/i);
  });
});

describe("EQ1-S1R rollout documentation", () => {
  const doc = readSource(DOCS_FILE);

  it("the rollout document exists", () => {
    expect(existsSync(path.join(repoRoot, DOCS_FILE)), `missing file: ${DOCS_FILE}`).toBe(true);
  });

  it("documents the existing putting foundation being extended, not duplicated", () => {
    expect(doc).toMatch(/putt_tempo_ratio/);
    expect(doc).toMatch(/PuttingAnalysisPanel/);
    expect(doc).toMatch(/swing_category\s*=\s*putt/);
  });

  it("documents the automatic routing contract for Putter vs. non-putter", () => {
    expect(doc).toContain("analysis_family = putting");
    expect(doc).toContain("analysis_family = full_swing");
  });

  it("documents the premium putting tiers Par, Birdie, and Eagle", () => {
    expect(doc).toMatch(/###\s*Par/);
    expect(doc).toMatch(/###\s*Birdie/);
    expect(doc).toMatch(/###\s*Eagle/);
  });

  it("documents the advertising firewall", () => {
    expect(doc).toMatch(/Advertising firewall/i);
    expect(doc).toMatch(/Sponsorship can never affect/);
  });

  it("documents privacy boundaries", () => {
    expect(doc).toMatch(/## Privacy/);
    expect(doc).toMatch(/aggregated/i);
    expect(doc).toMatch(/consent/i);
  });

  it("documents the full future rollout roadmap through EQ8", () => {
    for (const phase of ["EQ1-S1R", "EQ1-S2", "EQ1-S3", "EQ1-S4", "EQ2", "EQ3", "EQ4", "EQ5A", "EQ5B", "EQ5C", "EQ5D", "EQ6", "EQ7", "EQ8"]) {
      expect(doc, `roadmap missing ${phase}`).toContain(phase);
    }
  });
});

describe("EQ1-S1R TypeScript contracts", () => {
  const types = readSource(TYPES_FILE);

  it("defines ClubType with exactly the six live club_type_enum values", () => {
    expect(types).toMatch(/export type ClubType =\s*\n?\s*\|?\s*"Driver"/);
    for (const value of ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"]) {
      expect(types).toContain(`"${value}"`);
    }
  });

  it("defines AnalysisDepth as basic/advanced/ultra", () => {
    expect(types).toMatch(/export type AnalysisDepth =/);
    expect(types).toContain('"basic"');
    expect(types).toContain('"advanced"');
    expect(types).toContain('"ultra"');
  });

  it("defines AnalysisFamily as full_swing/putting", () => {
    expect(types).toMatch(/export type AnalysisFamily =\s*\n?\s*\|?\s*"full_swing"\s*\n?\s*\|\s*"putting"/);
  });

  it("explicitly documents the semantic distinction between analysis_mode and analysis_family", () => {
    expect(types).toMatch(/AI depth/);
    expect(types).toMatch(/mechanical.*pipeline|pipeline.*mechanical/i);
  });

  it("defines EquipmentManufacturer, EquipmentModel, UserEquipment, and EquipmentSnapshotV1", () => {
    expect(types).toMatch(/export interface EquipmentManufacturer\s*{/);
    expect(types).toMatch(/export interface EquipmentModel\s*{/);
    expect(types).toMatch(/export interface UserEquipment\s*{/);
    expect(types).toMatch(/export interface EquipmentSnapshotV1\s*{/);
  });

  it("UserEquipment includes both nullable catalog reference columns and preserves legacy/custom fields", () => {
    const start = types.indexOf("export interface UserEquipment");
    const end = types.indexOf("\n}", start);
    const block = types.slice(start, end);
    for (const field of [
      "manufacturer_id", "equipment_model_id", "brand", "model",
      "custom_club", "custom_brand", "custom_model", "custom_notes",
    ]) {
      expect(block, `UserEquipment missing "${field}"`).toContain(field);
    }
  });

  it("EquipmentSnapshotV1 models the database-owned snapshot structure", () => {
    const start = types.indexOf("export interface EquipmentSnapshotV1");
    const end = types.indexOf("\n}", start);
    const block = types.slice(start, end);
    expect(block).toContain("schema_version: 1");
    for (const field of [
      "captured_at", "equipment_id", "club_type", "manufacturer", "model",
      "entered_brand", "entered_model", "custom_club", "custom_brand", "custom_model",
      "shaft_flex", "shaft_weight_grams", "loft_deg",
    ]) {
      expect(block, `EquipmentSnapshotV1 missing "${field}"`).toContain(field);
    }
  });

  it("SwingVideo reflects its existing live depth-routing fields", () => {
    const start = types.indexOf("export interface SwingVideo");
    const end = types.indexOf("\n}", start);
    const block = types.slice(start, end);
    for (const field of ["analysis_mode", "requested_model", "launch_monitor_attached", "priority"]) {
      expect(block, `SwingVideo missing "${field}"`).toContain(field);
    }
  });

  it("SwingAnalysis includes the relevant live and new equipment/putting fields", () => {
    const start = types.indexOf("export interface SwingAnalysis");
    const end = types.indexOf("\n}", start);
    const block = types.slice(start, end);
    for (const field of [
      "analysis_mode", "analysis_family", "model_used", "club_id", "telemetry_id",
      "equipment_snapshot", "putt_tempo_ratio", "face_angle_at_impact_deg", "path_deviation_mm",
      "putt_analytics", "putting_analysis", "ai_equipment_recommendations",
      "spine_angle", "hip_rotation", "shoulder_rotation", "launch_monitor_summary", "fusion_notes",
    ]) {
      expect(block, `SwingAnalysis missing "${field}"`).toContain(field);
    }
  });

  it("does not remove any pre-existing exported type or interface", () => {
    for (const name of [
      "UserRole", "SubscriptionTier", "SubscriptionStatus", "SwingVideoStatus",
      "User", "CoachProfile", "CoachGolferRelationship", "SwingVideo", "SwingAnalysis",
      "CoachFeedback", "LessonPlan", "SwingTelemetryPayload", "CoachService",
      "CoachLocation", "CoachAvailabilityRule", "CoachAvailabilityException",
      "CoachBooking", "CoachReview", "CoachRatingSummary",
    ]) {
      expect(types, `pre-existing export "${name}" appears to have been removed`).toMatch(new RegExp(`export (type|interface) ${name}\\b`));
    }
  });
});

// Changed-file scope is a pull-request/workflow invariant verified by Git
// and PR audits. Permanent tests verify the source artifacts themselves and
// must not depend on transient repository state.
describe("EQ1-S1R artifact inventory", () => {
  it("tracks the five intended EQ1-S1R artifacts at their exact paths", () => {
    // EQ1-S1R-C2: the final authorized slice is exactly five files — the
    // fifth (BASELINE_TEST_FILE) was authorized by EQ1-S1R-C1 to correct the
    // canonical baseline-migration selection guard. This list is intentionally
    // explicit (no wildcard, no directory-wide acceptance, no arbitrary file
    // under lib/ or supabase/migrations/).
    const expectedArtifacts = [
      MIGRATION_FILE,
      TYPES_FILE,
      THIS_TEST_FILE,
      DOCS_FILE,
      BASELINE_TEST_FILE,
    ];

    expect(expectedArtifacts).toEqual([
      "supabase/migrations/20260725020835_equipment_intelligence_putting_foundation.sql",
      "types/database.ts",
      "lib/equipment-intelligence-schema.test.ts",
      "docs/EQUIPMENT_INTELLIGENCE_ROLLOUT.md",
      "lib/migration-replay-baseline.test.ts",
    ]);

    expect(new Set(expectedArtifacts).size).toBe(5);

    for (const artifact of expectedArtifacts) {
      expect(
        existsSync(path.join(repoRoot, artifact)),
        `missing EQ1-S1R artifact: ${artifact}`
      ).toBe(true);
    }
  });
});
