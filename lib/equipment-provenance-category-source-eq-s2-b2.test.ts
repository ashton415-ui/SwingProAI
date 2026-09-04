/**
 * EQ-S2-B2 — the fourth equipment provenance class.
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * Provenance vocabulary, and nothing else. The slice widens one CHECK
 * constraint and one TypeScript union so that `official_category_page` becomes
 * legal alongside the three historical classes. It adds no catalog row, edits
 * no catalog artifact, and touches no application code — so most of what these
 * tests do is prove the absence of changes that would have been easy to make
 * accidentally.
 *
 * WHY THE MIGRATION IS ASSERTED AGAINST EXECUTABLE CONTENT
 * -------------------------------------------------------
 * The migration carries a long explanatory header that necessarily names the
 * very operations it must not perform. Scanning the raw file for words like
 * "delete" would therefore fail on its own prose. Line comments are stripped
 * first, so every prohibition below is asserted against statements that would
 * actually run.
 *
 * WHY THE DIGEST PIN IS CHECKED HERE TOO
 * --------------------------------------
 * lib/equipment-non-putter-catalog-schema.test.ts pins the SHA-256 of
 * types/database.ts precisely so that a change to the shared type surface
 * cannot pass unnoticed. This slice legitimately changes that file, so the pin
 * was deliberately updated — which is what its own comment prescribes. The
 * check below proves the pin was re-derived from the file rather than
 * loosened, and that no other pinned artifact moved.
 *
 * No database, no network, no Supabase client, no jsdom, no credential, and no
 * dependency on branch name, commit SHA or working-tree state.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

/** The digest semantics used by the existing anti-drift pin: UTF-8 string. */
function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATION_SUFFIX = "_equipment_model_source_category_provenance.sql";
const TYPES_FILE = "types/database.ts";
const DOCS_FILE = "docs/EQUIPMENT_INTELLIGENCE_ROLLOUT.md";
const PIN_TEST_FILE = "lib/equipment-non-putter-catalog-schema.test.ts";
const PUTTER_JSON = "data/equipment-catalog-putters-v1.json";
const NON_PUTTER_JSON = "data/equipment-catalog-non-putters-v1.json";
const PUTTER_GENERATOR = "scripts/generate-equipment-catalog-putters-v1.mjs";
const NON_PUTTER_GENERATOR = "scripts/generate-equipment-catalog-non-putters-v1.mjs";

const HISTORICAL_SOURCE_TYPES = [
  "official_product_page",
  "official_spec_pdf",
  "official_archive",
] as const;
const NEW_SOURCE_TYPE = "official_category_page";
const ALL_SOURCE_TYPES = [...HISTORICAL_SOURCE_TYPES, NEW_SOURCE_TYPE];

function migrationFilenames(): string[] {
  return readdirSync(path.join(repoRoot, MIGRATIONS_DIR))
    .filter((name) => name.endsWith(MIGRATION_SUFFIX))
    .sort();
}

function migrationSource(): string {
  const names = migrationFilenames();
  expect(names, `expected exactly one *${MIGRATION_SUFFIX} migration`).toHaveLength(1);
  return readSource(path.posix.join(MIGRATIONS_DIR, names[0]));
}

/** Statements only: everything from `--` to end of line is removed. */
function executableSql(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Group-1 captures for a global pattern, without iterator spread. */
function captures(source: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    found.push(match[1]);
    if (match.index === re.lastIndex) re.lastIndex += 1;
    match = re.exec(source);
  }
  return found;
}

function countOccurrences(haystack: string, needle: string): number {
  let total = 0;
  let cursor = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) return total;
    total += 1;
    cursor = idx + needle.length;
  }
}

describe("EQ-S2-B2 migration — exactly one, transactional, scoped to one constraint", () => {
  it("ships exactly one category-provenance migration", () => {
    expect(migrationFilenames()).toHaveLength(1);
  });

  it("is wrapped in a single explicit transaction", () => {
    const sql = executableSql(migrationSource());
    expect(countOccurrences(sql, "\nbegin;")).toBe(1);
    expect(countOccurrences(sql, "\ncommit;")).toBe(1);
    expect(sql).not.toContain("rollback;");
  });

  it("names public.equipment_model_sources as its only mutation target", () => {
    const sql = executableSql(migrationSource());
    const alterTargets = captures(sql, /alter\s+table\s+([a-z_.]+)/gi);
    expect(alterTargets.length).toBeGreaterThan(0);
    for (const target of alterTargets) {
      expect(target, `unexpected alter target: ${target}`).toBe("public.equipment_model_sources");
    }
  });

  it("operates on the existing constraint name rather than introducing a rival", () => {
    const sql = executableSql(migrationSource());
    expect(sql).toContain("equipment_model_sources_type_check");
    expect(sql).toContain("drop constraint equipment_model_sources_type_check");
    expect(sql).toContain("add constraint equipment_model_sources_type_check");
    // Exactly one drop and one add of the source-type rule.
    expect(countOccurrences(sql, "drop constraint equipment_model_sources_type_check")).toBe(1);
    expect(countOccurrences(sql, "add constraint equipment_model_sources_type_check")).toBe(1);
  });
});

describe("EQ-S2-B2 migration — the admitted vocabulary", () => {
  function admittedList(): string {
    const sql = executableSql(migrationSource());
    const startIdx = sql.indexOf("add constraint equipment_model_sources_type_check");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const endIdx = sql.indexOf(";", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    return sql.slice(startIdx, endIdx);
  }

  it("keeps every historical source class", () => {
    const list = admittedList();
    for (const value of HISTORICAL_SOURCE_TYPES) {
      expect(list, `missing historical source type ${value}`).toContain(`'${value}'`);
    }
  });

  it("adds official_category_page", () => {
    expect(admittedList()).toContain(`'${NEW_SOURCE_TYPE}'`);
  });

  it("admits exactly four values and no fifth", () => {
    const list = admittedList();
    const quoted = captures(list, /'([a-z_]+)'/g);
    expect(quoted.sort()).toEqual([...ALL_SOURCE_TYPES].sort());
  });
});

describe("EQ-S2-B2 migration — everything it must not do", () => {
  const sql = executableSql(migrationSource()).toLowerCase();

  it("writes no rows", () => {
    expect(sql).not.toMatch(/\binsert\s+into\b/);
    expect(sql).not.toMatch(/\bupdate\s+public\./);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
  });

  it("creates and drops no table", () => {
    expect(sql).not.toMatch(/\bcreate\s+table\b/);
    expect(sql).not.toMatch(/\bdrop\s+table\b/);
  });

  it("changes no row-level security or policy", () => {
    expect(sql).not.toMatch(/\benable\s+row\s+level\s+security\b/);
    expect(sql).not.toMatch(/\bdisable\s+row\s+level\s+security\b/);
    expect(sql).not.toMatch(/\bcreate\s+policy\b/);
    expect(sql).not.toMatch(/\balter\s+policy\b/);
    expect(sql).not.toMatch(/\bdrop\s+policy\b/);
  });

  it("changes no privileges", () => {
    expect(sql).not.toMatch(/\bgrant\b/);
    expect(sql).not.toMatch(/\brevoke\b/);
  });

  it("defines no routine or trigger", () => {
    expect(sql).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function\b/);
    expect(sql).not.toMatch(/\bdrop\s+function\b/);
    expect(sql).not.toMatch(/\bcreate\s+trigger\b/);
    expect(sql).not.toMatch(/\bdrop\s+trigger\b/);
  });

  it("mutates no column definition", () => {
    expect(sql).not.toMatch(/\badd\s+column\b/);
    expect(sql).not.toMatch(/\bdrop\s+column\b/);
    expect(sql).not.toMatch(/\balter\s+column\b/);
    expect(sql).not.toMatch(/\bset\s+default\b/);
    expect(sql).not.toMatch(/\bdrop\s+default\b/);
  });

  it("leaves the sibling constraints alone", () => {
    for (const sibling of [
      "equipment_model_sources_model_fkey",
      "equipment_model_sources_url_https",
      "equipment_model_sources_verified_not_future",
      "equipment_model_sources_model_url_unique",
    ]) {
      expect(sql, `${sibling} must not be dropped`).not.toContain(`drop constraint ${sibling}`);
      expect(sql, `${sibling} must not be re-added`).not.toContain(`add constraint ${sibling}`);
    }
  });
});

describe("EQ-S2-B2 shared type surface", () => {
  const types = readSource(TYPES_FILE);

  function unionBlock(): string {
    const startIdx = types.indexOf("export type EquipmentModelSourceType");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const endIdx = types.indexOf(";", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    return types.slice(startIdx, endIdx);
  }

  it("declares exactly the four allowed source strings", () => {
    const block = unionBlock();
    const quoted = captures(block, /"([a-z_]+)"/g);
    expect(quoted.sort()).toEqual([...ALL_SOURCE_TYPES].sort());
  });

  it("keeps EquipmentModelSource.source_type typed by the union", () => {
    expect(types).toContain("source_type: EquipmentModelSourceType;");
  });

  it("keeps the server-only provenance commentary", () => {
    expect(types).toContain(
      "SERVER-ONLY. The backing table (public.equipment_model_sources) has no"
    );
    expect(types).toContain("only by service_role. Never query this from browser code.");
  });
});

describe("EQ-S2-B2 leaves the closed v1 catalog artifacts alone", () => {
  it("adds no category-page source to the putter v1 dataset", () => {
    expect(readSource(PUTTER_JSON)).not.toContain(NEW_SOURCE_TYPE);
  });

  it("adds no category-page source to the non-putter v1 dataset", () => {
    expect(readSource(NON_PUTTER_JSON)).not.toContain(NEW_SOURCE_TYPE);
  });

  it("keeps the putter generator on its historical three-class artifact contract", () => {
    const generator = readSource(PUTTER_GENERATOR);
    expect(generator).toContain(
      'const SOURCE_TYPES = ["official_product_page", "official_spec_pdf", "official_archive"];'
    );
    expect(generator).not.toContain(NEW_SOURCE_TYPE);
  });

  it("keeps the non-putter generator on its historical three-class artifact contract", () => {
    const generator = readSource(NON_PUTTER_GENERATOR);
    expect(generator).toContain(
      'const ALLOWED_SOURCE_TYPES = ["official_product_page", "official_spec_pdf", "official_archive"];'
    );
    expect(generator).not.toContain(NEW_SOURCE_TYPE);
  });
});

describe("EQ-S2-B2 anti-drift digest pin", () => {
  const pinTest = readSource(PIN_TEST_FILE);

  /** Reads one PROTECTED_DIGESTS entry out of the pinning test's source. */
  function pinnedDigest(file: string): string {
    const key = `"${file}":`;
    const keyIdx = pinTest.indexOf(key);
    expect(keyIdx, `no pinned digest found for ${file}`).toBeGreaterThanOrEqual(0);
    const openIdx = pinTest.indexOf('"', keyIdx + key.length);
    expect(openIdx).toBeGreaterThan(keyIdx);
    const closeIdx = pinTest.indexOf('"', openIdx + 1);
    expect(closeIdx).toBeGreaterThan(openIdx);
    const digest = pinTest.slice(openIdx + 1, closeIdx);
    expect(digest, `malformed digest literal for ${file}`).toHaveLength(64);
    return digest;
  }

  it("still pins types/database.ts rather than dropping the guard", () => {
    expect(pinTest).toContain("const PROTECTED_DIGESTS: Record<string, string> = {");
    expect(pinTest).toContain('"types/database.ts":');
    expect(pinTest).toContain("expect(actual, `${file} must not be modified by Slice 2`).toBe(digest);");
  });

  it("pins the digest that types/database.ts actually has", () => {
    expect(pinnedDigest(TYPES_FILE)).toBe(sha256Utf8(readFileSync(path.join(repoRoot, TYPES_FILE), "utf8")));
  });

  it("leaves every other pinned artifact at its original digest", () => {
    const untouched: Record<string, string> = {
      "data/equipment-catalog-putters-v1.json":
        "0a73e9460d1f416b8af04838dc983df5bcb40ea9f4fa169b9975e50a2b502029",
      "scripts/generate-equipment-catalog-putters-v1.mjs":
        "89b40a7a23c80b4377019eb1548395086d5ea9d36584ad6cbd8ec3226184d287",
      "supabase/migrations/20260725174239_equipment_putter_catalog_v1.sql":
        "f133d266395879e208ad3bc615a77f8b6d394f98608263e22011d07b82df9ed4",
      "lib/equipment-catalog-schema.test.ts":
        "7fff61c8005d0517b942344180cbd68a12e640767132213c942dc6101cca59d9",
    };
    for (const [file, digest] of Object.entries(untouched)) {
      expect(pinnedDigest(file), `${file} pin was altered by EQ-S2-B2`).toBe(digest);
      expect(
        sha256Utf8(readFileSync(path.join(repoRoot, file), "utf8")),
        `${file} itself was modified by EQ-S2-B2`
      ).toBe(digest);
    }
  });
});

describe("EQ-S2-B2 rollout documentation", () => {
  const docs = readSource(DOCS_FILE);
  /** Prose wraps across lines, so join them before matching whole sentences. */
  const prose = docs.split("\n").join(" ");

  it("introduces the section and the new class", () => {
    expect(docs).toContain("## EQ-S2-B2 — Official category provenance support");
    expect(docs).toContain(NEW_SOURCE_TYPE);
  });

  it("defines the class as fallback only and preserves the priority order", () => {
    expect(docs).toContain("### Fallback only");
    expect(docs).toContain("`official_category_page` — fallback only");
    for (const value of HISTORICAL_SOURCE_TYPES) {
      expect(docs, `priority list is missing ${value}`).toContain(`\`${value}\``);
    }
  });

  it("prohibits search, retailer, marketplace and review evidence", () => {
    expect(docs).toContain("search result or search snippet");
    expect(docs).toContain("retailer");
    expect(docs).toContain("marketplace");
    expect(docs).toContain("review or listicle");
  });

  it("prohibits inference beyond what the cited page states", () => {
    expect(prose).toContain("never supports a technical specification the cited page does not state");
    expect(prose).toContain("not permission to infer missing numbers");
  });

  it("states that the slice adds no catalog rows", () => {
    expect(docs).toContain("adds, removes and edits zero equipment");
  });

  it("states that EQ-S2-C remains separate", () => {
    expect(docs).toContain("EQ-S2-C remains a separate follow-on slice");
  });

  it("states local-candidate, not-deployed status", () => {
    expect(docs).toContain("LOCAL CANDIDATE ONLY — NOT APPLIED TO STAGING OR PRODUCTION");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXACT-STATE ENFORCEMENT
//
// An earlier draft of the migration asked only whether each expected label
// appeared somewhere in the live rule. A rule admitting the three historical
// classes *plus* an unexpected fourth satisfied that check, so the replacement
// would have silently erased a newer contract. The guards below therefore
// assert set equality and predicate shape, not mere presence.
//
// `validateMembershipRule` mirrors the SQL guard in TypeScript so the rejection
// behaviour can be exercised against adversarial definitions without a
// database. It is a model of the plpgsql, not the plpgsql itself: the static
// assertions immediately above it pin the SQL's own expected arrays and guard
// tokens, so the two are checked to agree on inputs and on structure.
// ─────────────────────────────────────────────────────────────────────────────

/** Columns of public.equipment_model_sources other than source_type. */
const OTHER_COLUMN_PATTERNS = [
  /\bID\b/,
  /\bEQUIPMENT_MODEL_ID\b/,
  /\bSOURCE_NAME\b/,
  /\bSOURCE_URL\b/,
  /\bVERIFIED_AT\b/,
  /\bCREATED_AT\b/,
];

const EXTRA_LOGIC_PATTERNS = [
  /\bOR\b/,
  /\bAND\b/,
  /\bNOT\b/,
  /\bIS\b/,
  /\bLIKE\b/,
  /\bILIKE\b/,
  /\bSIMILAR\b/,
  /[<>]/,
  /!=/,
  /~/,
];

type RuleVerdict = { ok: true } | { ok: false; reason: string };

function validateMembershipRule(def: string, expected: string[]): RuleVerdict {
  const norm = def.replace(/\s+/g, " ").trim();
  if (!/^CHECK /.test(norm)) return { ok: false, reason: "not-a-check" };
  if (!/= ANY/.test(norm) && !/\bIN\b/.test(norm)) return { ok: false, reason: "not-membership" };

  const blank = norm.replace(/'[^']*'/g, " ").toUpperCase();
  for (const pattern of EXTRA_LOGIC_PATTERNS) {
    if (pattern.test(blank)) return { ok: false, reason: "extra-logic" };
  }
  const mentions = blank.match(/\bSOURCE_TYPE\b/g) ?? [];
  if (mentions.length !== 1) return { ok: false, reason: "column-mentions" };
  for (const pattern of OTHER_COLUMN_PATTERNS) {
    if (pattern.test(blank)) return { ok: false, reason: "other-column" };
  }

  const literals = (norm.match(/'[^']*'/g) ?? []).map((quoted) => quoted.slice(1, -1));
  if (literals.length !== expected.length) return { ok: false, reason: "literal-count" };
  const found = Array.from(new Set(literals)).sort();
  const want = [...expected].sort();
  if (found.length !== want.length) return { ok: false, reason: "set-mismatch" };
  for (let i = 0; i < found.length; i += 1) {
    if (found[i] !== want[i]) return { ok: false, reason: "set-mismatch" };
  }
  return { ok: true };
}

/** Canonical non-pretty rendering Postgres produces for a text IN-list. */
function renderMembership(values: string[]): string {
  const items = values.map((v) => `'${v}'::text`).join(", ");
  return `CHECK ((source_type = ANY (ARRAY[${items}])))`;
}

describe("EQ-S2-B2 migration — the guards assert an exact set, not mere presence", () => {
  const sql = executableSql(migrationSource());

  it("declares the expected PRE set as an explicit three-member array", () => {
    expect(sql).toContain("'official_archive',\n    'official_product_page',\n    'official_spec_pdf'\n  ];");
  });

  it("declares the expected POST set as an explicit four-member array", () => {
    expect(sql).toContain(
      "'official_archive',\n    'official_category_page',\n    'official_product_page',\n    'official_spec_pdf'\n  ];"
    );
  });

  it("compares the complete extracted set rather than testing labels one by one", () => {
    // Both guards aggregate every quoted literal and compare the sorted set.
    expect(countOccurrences(sql, "array_agg(distinct m[1] order by m[1])")).toBe(2);
    expect(countOccurrences(sql, "v_found is distinct from")).toBe(2);
    // And neither guard may fall back to substring presence tests.
    expect(sql).not.toContain("like '%official_product_page%'");
    expect(sql).not.toContain("like '%official_spec_pdf%'");
    expect(sql).not.toContain("like '%official_archive%'");
    expect(sql).not.toContain("like '%official_category_page%'");
  });

  it("counts literals so a duplicated label cannot hide behind set equality", () => {
    expect(countOccurrences(sql, "v_literals <> array_length(v_expected, 1)")).toBe(2);
  });

  it("requires a simple membership predicate in both guards", () => {
    expect(countOccurrences(sql, "= ANY")).toBe(2);
    // Eleven token probes per guard — ten forbidden constructs plus the
    // other-column sweep — and a named failure path in each guard.
    expect(countOccurrences(sql, "v_blank ~ ")).toBe(22);
    expect(countOccurrences(sql, "v_norm !~ ")).toBe(6);
    expect(sql).toContain("EQS2B2-PRE-D3");
    expect(sql).toContain("EQS2B2-POST-3C");
  });

  it("rejects a second column participating in either rule", () => {
    expect(countOccurrences(sql, "att.attname <> 'source_type'")).toBe(2);
  });

  it("uses the canonical non-pretty constraint rendering", () => {
    expect(countOccurrences(sql, "pg_get_constraintdef(con.oid, false)")).toBe(4);
    expect(sql).not.toContain("pg_get_constraintdef(con.oid)");
  });

  it("still ends with an ADD CONSTRAINT naming exactly the four approved values", () => {
    const startIdx = sql.indexOf("add constraint equipment_model_sources_type_check");
    const endIdx = sql.indexOf(";", startIdx);
    const clause = sql.slice(startIdx, endIdx);
    const quoted = captures(clause, /'([a-z_]+)'/g);
    expect(quoted.sort()).toEqual([...ALL_SOURCE_TYPES].sort());
  });
});

describe("EQ-S2-B2 exact-state guard — adversarial PRE definitions", () => {
  const PRE_EXPECTED = [...HISTORICAL_SOURCE_TYPES];

  it("CASE 1 — exactly the three historical classes is accepted", () => {
    expect(validateMembershipRule(renderMembership([...PRE_EXPECTED]), PRE_EXPECTED)).toEqual({ ok: true });
  });

  it("CASE 2 — an extra unexpected class is rejected before any replacement", () => {
    const drifted = renderMembership([...PRE_EXPECTED, "official_press_release"]);
    expect(validateMembershipRule(drifted, PRE_EXPECTED)).toEqual({ ok: false, reason: "literal-count" });
  });

  it("CASE 3 — a rule already admitting official_category_page is rejected", () => {
    const ahead = renderMembership([...PRE_EXPECTED, NEW_SOURCE_TYPE]);
    expect(validateMembershipRule(ahead, PRE_EXPECTED)).toEqual({ ok: false, reason: "literal-count" });
  });

  it("CASE 4 — a missing historical class is rejected", () => {
    const short = renderMembership(["official_product_page", "official_spec_pdf"]);
    expect(validateMembershipRule(short, PRE_EXPECTED)).toEqual({ ok: false, reason: "literal-count" });
  });

  it("CASE 5 — extra boolean logic is rejected", () => {
    const withOr =
      "CHECK (((source_type = ANY (ARRAY['official_product_page'::text, 'official_spec_pdf'::text, " +
      "'official_archive'::text])) OR (source_type ~~ 'official_%'::text)))";
    expect(validateMembershipRule(withOr, PRE_EXPECTED)).toEqual({ ok: false, reason: "extra-logic" });
  });

  it("CASE 6 — a predicate on another column is rejected", () => {
    const withColumn =
      "CHECK (((source_type = ANY (ARRAY['official_product_page'::text, 'official_spec_pdf'::text, " +
      "'official_archive'::text])) AND (equipment_model_id IS NOT NULL)))";
    expect(validateMembershipRule(withColumn, PRE_EXPECTED)).toEqual({ ok: false, reason: "extra-logic" });
  });

  it("a duplicated label is rejected rather than collapsed into the expected set", () => {
    const duplicated = renderMembership([...PRE_EXPECTED, "official_archive"]);
    expect(validateMembershipRule(duplicated, PRE_EXPECTED)).toEqual({ ok: false, reason: "literal-count" });
  });

  it("a same-size set with a substituted label is rejected", () => {
    const swapped = renderMembership(["official_product_page", "official_spec_pdf", "official_press_release"]);
    expect(validateMembershipRule(swapped, PRE_EXPECTED)).toEqual({ ok: false, reason: "set-mismatch" });
  });
});

describe("EQ-S2-B2 exact-state guard — adversarial POST definitions", () => {
  const POST_EXPECTED = [...ALL_SOURCE_TYPES];

  it("exactly the four authorized classes is accepted", () => {
    expect(validateMembershipRule(renderMembership([...POST_EXPECTED]), POST_EXPECTED)).toEqual({ ok: true });
  });

  it("a fifth class is rejected", () => {
    const drifted = renderMembership([...POST_EXPECTED, "official_press_release"]);
    expect(validateMembershipRule(drifted, POST_EXPECTED)).toEqual({ ok: false, reason: "literal-count" });
  });

  it("an arbitrary boolean predicate is rejected", () => {
    const withOr =
      "CHECK (((source_type = ANY (ARRAY['official_product_page'::text, 'official_spec_pdf'::text, " +
      "'official_archive'::text, 'official_category_page'::text])) OR (source_type ~~ 'official_%'::text)))";
    expect(validateMembershipRule(withOr, POST_EXPECTED)).toEqual({ ok: false, reason: "extra-logic" });
  });

  it("a predicate on another column is rejected", () => {
    const withColumn =
      "CHECK (((source_type = ANY (ARRAY['official_product_page'::text, 'official_spec_pdf'::text, " +
      "'official_archive'::text, 'official_category_page'::text])) AND (created_at IS NOT NULL)))";
    expect(validateMembershipRule(withColumn, POST_EXPECTED)).toEqual({ ok: false, reason: "extra-logic" });
  });

  it("a non-CHECK expression is rejected", () => {
    expect(validateMembershipRule("FOREIGN KEY (equipment_model_id) REFERENCES x(id)", POST_EXPECTED)).toEqual({
      ok: false,
      reason: "not-a-check",
    });
  });
});
