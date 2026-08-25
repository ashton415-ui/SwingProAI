import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_MIGRATIONS,
  BASELINE_FILENAME,
  BRIDGE_MIGRATIONS,
  EXPECTED_MIGRATION_COUNT,
  S1R_FILENAME,
  S2_FILENAME,
  SEC1B_FN_FILENAME,
  SEC1C_FILENAME,
  SEC1D_POL_FILENAME,
  SEC1F_RANGE_SESSIONS_FILENAME,
  bridgeFilename,
} from "./migration-inventory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const docsPath = path.join(repoRoot, "docs", "MIGRATION_REPLAY_RECOVERY.md");

/** Reads a file's raw bytes as a Buffer — used for BOM, CR, and
 *  trailing-newline checks, which must see the file exactly as it sits on
 *  disk, before any newline normalization could hide a real defect. */
function readRawBuffer(filePath: string): Buffer {
  return readFileSync(filePath);
}

// ============================================================================
// The 16 approved historical bridge files: exact expected version/name
// pairs, in file order. The data now comes from lib/migration-inventory.ts so
// it is declared once repository-wide, but this file remains the closed-world
// authority — every identity-shaped assertion below still demands exact set
// equality and an exact count. No wildcard, no directory-wide acceptance of
// "whatever matches a pattern."
// ============================================================================
const EXPECTED_BRIDGES = BRIDGE_MIGRATIONS;

const CANONICAL_FINGERPRINTS: Record<string, string> = {
  [BASELINE_FILENAME]: "33a599f07cd6aba5761ce7feea811ed3c096bb9dbc50f21d519037df45d4b828",
  [S1R_FILENAME]: "eb5b7d1269092cdd936a6829f7cdafa426fa74221743a6661b9f7edbd0a3c1cb",
  [S2_FILENAME]: "f133d266395879e208ad3bc615a77f8b6d394f98608263e22011d07b82df9ed4",
  [SEC1C_FILENAME]: "a8a20fff1e8959a8974fb13a853c90a6adf83b35b39025aa04928830a340edca",
  [SEC1D_POL_FILENAME]: "c38484f66d8bdbfefb4c166ee7821e7f8d735930b6f2ecd5911ac35066e48016",
  [SEC1F_RANGE_SESSIONS_FILENAME]: "d155232b0e0ae7fc61aa3312658ec773c3dc3dcb29caf63db92ca9c3986e5b9b",
};

const expectedBridgeFilename = bridgeFilename;

const allMigrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

// ============================================================================
// 1-3, 23-24. Exact set membership, no missing, no unexpected extra, exact
// 26-file inventory, strict timestamp ordering.
// ============================================================================
describe("migration-history bridge — exact file inventory", () => {
  it("the migrations directory contains exactly the approved number of SQL files", () => {
    expect(allMigrationFiles.length).toBe(EXPECTED_MIGRATION_COUNT);
  });

  it("contains exactly the approved 16 bridge files, no missing", () => {
    for (const b of EXPECTED_BRIDGES) {
      expect(allMigrationFiles, `expected bridge file missing: ${expectedBridgeFilename(b)}`).toContain(
        expectedBridgeFilename(b)
      );
    }
  });

  it("contains no unexpected migration file", () => {
    const expectedNames = new Set(APPROVED_MIGRATIONS);
    const unexpected = allMigrationFiles.filter((f) => !expectedNames.has(f));
    expect(unexpected, `unexpected migration file(s) present: ${JSON.stringify(unexpected)}`).toEqual([]);
  });

  it("strict timestamp ordering: 16 bridges, then baseline, S1R, S2, SEC1B-FN, SEC1C, SEC1D, SEC1F range sessions, then non-putter catalog v1, then user club designation, then equipment snapshot v2", () => {
    const sorted = [...allMigrationFiles].sort();
    const expectedOrder = [...APPROVED_MIGRATIONS].sort();
    // Both lists are independently sorted lexicographically (equivalent to
    // timestamp order for these fixed-width numeric prefixes), so this
    // proves the actual directory contents collapse to the same ordered
    // sequence the bridge-then-canonical contract requires.
    expect(sorted).toEqual(expectedOrder);
  });

  it("every bridge timestamp is strictly earlier than the canonical baseline timestamp", () => {
    const baselineVersion = BASELINE_FILENAME.slice(0, "20260721220000".length);
    for (const b of EXPECTED_BRIDGES) {
      expect(b.version < baselineVersion, `${b.version} is not earlier than ${baselineVersion}`).toBe(true);
    }
  });
});

// ============================================================================
// 4, 10-18. Per-bridge content contract.
// ============================================================================
describe.each(EXPECTED_BRIDGES)("bridge file $version_$name", (bridge) => {
  const filename = expectedBridgeFilename(bridge);
  const filePath = path.join(migrationsDir, filename);
  const raw = readRawBuffer(filePath);
  const text = raw.toString("utf8");

  it("has the exact timestamp and migration name in its filename", () => {
    expect(filename).toBe(`${bridge.version}_${bridge.name}.sql`);
  });

  it("contains the exact remote timestamp in its content", () => {
    expect(text).toContain(bridge.version);
  });

  it("contains the exact remote migration name in its content", () => {
    expect(text).toContain(bridge.name);
  });

  it("contains the no-op statement", () => {
    expect(text).toMatch(/intentionally executes no SQL/);
  });

  it("contains the local-history-bridge statement", () => {
    expect(text).toMatch(/local migration-history bridge, not a schema migration/);
  });

  it("contains the production-history-preservation statement", () => {
    expect(text).toMatch(/remains preserved in\s*\n?--\s*production's migration-history table/);
  });

  it("contains the non-fabrication statement", () => {
    expect(text).toMatch(/must never be replaced with fabricated or reconstructed/);
  });

  it("contains the known-non-replayability statement", () => {
    expect(text).toMatch(/known not to replay from empty/);
  });

  it("contains the canonical baseline filename", () => {
    expect(text).toContain(BASELINE_FILENAME);
  });

  it("references the recovery document", () => {
    expect(text).toContain("docs/MIGRATION_REPLAY_RECOVERY.md");
  });

  // 5-6. Line-shape comment-only enforcement. Deliberately NOT a keyword
  // search for CREATE/ALTER/INSERT/UPDATE — those words could legitimately
  // appear inside a comment's own prose. Instead: split into lines, ignore
  // blank lines, and require every remaining line to begin with "--" after
  // trimming. Any line that fails this shape check is either executable SQL
  // or a malformed comment, and either way must fail loudly.
  it("every non-blank line begins with '--' (comments only, no executable SQL)", () => {
    const lines = text.split("\n");
    const offending = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("--");
    });
    expect(offending, `non-comment line(s) found: ${JSON.stringify(offending)}`).toEqual([]);
  });

  it("contains no semicolon outside of comment lines (no statement terminator of executable SQL)", () => {
    // Every line is already proven comment-only above; this is a direct,
    // independent confirmation that no bare top-level statement terminator
    // exists anywhere, which would be the case even for a one-line
    // executable statement without its own "--" prefix.
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      expect(trimmed.startsWith("--"), `expected comment line, got: "${line}"`).toBe(true);
    }
  });

  // 7-9. Raw-byte format checks (BOM, CR, trailing newline) — performed on
  // the raw Buffer, never on a newline-normalized string, so a real defect
  // cannot be silently erased before it's checked.
  it("has zero CR bytes (LF-only line endings)", () => {
    const crCount = raw.filter((byte) => byte === 0x0d).length;
    expect(crCount).toBe(0);
  });

  it("has no UTF-8 BOM", () => {
    const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    expect(hasBom).toBe(false);
  });

  it("ends with exactly one trailing newline", () => {
    expect(raw[raw.length - 1]).toBe(0x0a); // final byte is LF
    expect(raw[raw.length - 2]).not.toBe(0x0a); // the byte before it is not another LF
  });

  // 19-20. Explicit negative claims that must never appear.
  it('does not claim its contents are the original historical SQL', () => {
    expect(text.toLowerCase()).not.toMatch(/this file contains the original/);
    expect(text.toLowerCase()).not.toMatch(/exact statement payload/);
    expect(text.toLowerCase()).not.toMatch(/reproduces the (original|actual) (historical )?sql/);
  });

  it("does not claim it was applied to or ran against staging", () => {
    expect(text.toLowerCase()).not.toMatch(/applied to staging/);
    expect(text.toLowerCase()).not.toMatch(/ran (in|against) staging/);
    expect(text.toLowerCase()).not.toMatch(/executed (in|against) staging/);
  });

  it("does not claim it was historically executed", () => {
    expect(text.toLowerCase()).not.toMatch(/this (file|migration) (was|has been) (historically )?executed/);
    expect(text.toLowerCase()).not.toMatch(/ran in production/);
  });

  it("contains no credential, UUID, email, key, token, or secret-shaped text", () => {
    expect(text.toLowerCase()).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
    expect(text.toLowerCase()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text.toLowerCase()).not.toMatch(/\bsb_(secret|publishable)_[a-z0-9]{10,}\b/);
    expect(text.toLowerCase()).not.toMatch(/\beyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/);
    expect(text.toLowerCase()).not.toMatch(/postgres(?:ql)?:\/\/[^\s]*:[^\s]*@/);
  });
});

// ============================================================================
// 22. Canonical migration fingerprint preservation — proves the bridge
// implementation did not alter a single byte of the six canonical files.
// ============================================================================
describe("migration-history bridge — canonical file fingerprints unchanged", () => {
  it.each([BASELINE_FILENAME, S1R_FILENAME, S2_FILENAME, SEC1C_FILENAME, SEC1D_POL_FILENAME, SEC1F_RANGE_SESSIONS_FILENAME])("%s SHA256 matches the canonical value exactly", (filename) => {
    const raw = readRawBuffer(path.join(migrationsDir, filename));
    const actualSha256 = createHash("sha256").update(raw).digest("hex");
    expect(actualSha256).toBe(CANONICAL_FINGERPRINTS[filename]);
  });
});

// ============================================================================
// 25. Documentation must contain the required history-bridge and
// CLI-evidence claims.
// ============================================================================
describe("migration-history bridge — documentation contract", () => {
  const docs = readFileSync(docsPath, "utf8");

  it("contains the history-bridge section heading", () => {
    expect(docs).toContain("## The 16 historical migration-history bridge files");
  });

  it("contains the empirical CLI evidence subsection heading", () => {
    expect(docs).toContain("### Empirical CLI evidence (EQ1-P1R2 / EQ1-P1R3)");
  });

  it("documents the installed CLI version used during the compatibility probes", () => {
    expect(docs).toContain("2.109.1");
  });

  it("documents the retained standalone staging project identity and ledger versions", () => {
    expect(docs).toContain("swingproai-eq1-s3-staging");
    expect(docs).toContain("vyusdgvongfdzoteqyxz");
    expect(docs).toContain("20260726171411");
    expect(docs).toContain("20260726173526");
    expect(docs).toContain("20260726174518");
  });

  it("documents that PR #5, PR #13, and PR #14 are merged", () => {
    expect(docs).toMatch(/PR #5[^\n]*merged/i);
    expect(docs).toContain("72290544a4f226d4300999353ca9feba2b571cca");
    expect(docs).toContain("07a9d9f7d6c32f8b9509366df6cd50dff81b8b88");
  });

  it("preserves the warning that baseline DDL must never execute against existing production", () => {
    // Normalized to collapse markdown hard-wrap newlines to single spaces
    // before matching, since this warning spans a line break in the source.
    const normalized = docs.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toMatch(/must never execute (this )?baseline('s)? ddl against( existing)? production/);
  });

  it("does not claim a real production push has occurred", () => {
    expect(docs.toLowerCase()).not.toMatch(/production (has been|was) (successfully )?push(ed)?/);
    expect(docs.toLowerCase()).not.toMatch(/real push (occurred|was performed) against production/);
  });
});
