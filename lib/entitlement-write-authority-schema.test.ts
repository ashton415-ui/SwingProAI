import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  ANALYSIS_REQUEST_AUTHORITY_FILENAME,
  APPROVED_MIGRATIONS,
  ENTITLEMENT_WRITE_AUTHORITY_FILENAME,
  EXPECTED_MIGRATION_COUNT,
  PUTTING_SCORE_EQ5F_E_FILENAME,
  migrationsAuthoredBefore,
} from "./migration-inventory";

/**
 * SERVER-AUTHORITATIVE ENTITLEMENT WRITE BOUNDARY — source contract.
 *
 * Proves what the checked-in migration and the checkout route SAY. It does not
 * and cannot prove the migration has been applied anywhere: remote proof
 * belongs to the separate staging gate.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

const raw = readFileSync(path.join(migrationsDir, ENTITLEMENT_WRITE_AUTHORITY_FILENAME), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Executable SQL: comments removed, whitespace collapsed, lower-cased. */
const code = raw
  .replace(/--.*$/gm, "")
  .replace(/\s+/g, " ")
  .toLowerCase();

/** Statements only: string literals (the raise messages) blanked as well. */
const statements = code.replace(/'[^']*'/g, "''");

function indexOfRequired(needle: string): number {
  const at = code.indexOf(needle);
  expect(at, `expected migration to contain: ${needle}`).toBeGreaterThanOrEqual(0);
  return at;
}

describe("entitlement-write-authority — identity and inventory", () => {
  it("carries the CLI-generated filename", () => {
    expect(ENTITLEMENT_WRITE_AUTHORITY_FILENAME).toBe("20260926200538_entitlement_write_authority.sql");
    expect(ENTITLEMENT_WRITE_AUTHORITY_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("is registered in APPROVED_MIGRATIONS exactly once and exists on disk exactly once", () => {
    expect(APPROVED_MIGRATIONS.filter((m) => m === ENTITLEMENT_WRITE_AUTHORITY_FILENAME)).toHaveLength(1);
    const onDisk = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(onDisk.filter((f) => f.endsWith("_entitlement_write_authority.sql"))).toEqual([
      ENTITLEMENT_WRITE_AUTHORITY_FILENAME,
    ]);
  });

  it("holds every historical position: 33, 34 and 35 predecessors", () => {
    expect(migrationsAuthoredBefore(PUTTING_SCORE_EQ5F_E_FILENAME)).toHaveLength(33);
    expect(migrationsAuthoredBefore(ANALYSIS_REQUEST_AUTHORITY_FILENAME)).toHaveLength(34);
    const earlier = migrationsAuthoredBefore(ENTITLEMENT_WRITE_AUTHORITY_FILENAME);
    expect(earlier).toHaveLength(35);
    expect(earlier).toContain(ANALYSIS_REQUEST_AUTHORITY_FILENAME);
    expect(APPROVED_MIGRATIONS.indexOf(ENTITLEMENT_WRITE_AUTHORITY_FILENAME)).toBe(35);
  });

  // The current total is the inventory's to state, not this historical test's:
  // pinning it here would expire the moment a later migration lands.
  it("leaves the closed-world inventory derived from the approved migration list", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(onDisk);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
  });
});

describe("entitlement-write-authority — client writes on public.users are closed", () => {
  it("revokes INSERT and UPDATE from anon and authenticated", () => {
    indexOfRequired("revoke insert, update on table public.users from anon, authenticated;");
  });

  it("grants nothing back, at table or column level", () => {
    expect(statements).not.toMatch(/\bgrant\b/);
  });

  it("revokes nothing else: SELECT, DELETE and service_role are untouched", () => {
    const revokes = statements.match(/\brevoke\b[^;]*;/g) ?? [];
    expect(revokes).toEqual(["revoke insert, update on table public.users from anon, authenticated;"]);
    expect(statements).not.toMatch(/revoke[^;]*service_role/);
  });

  it("fails closed on an explicit column-level INSERT/UPDATE grant before revoking", () => {
    const check = indexOfRequired("aclexplode(a.attacl)");
    const revoke = indexOfRequired("revoke insert, update on table public.users");
    expect(check).toBeLessThan(revoke);
    indexOfRequired("x.privilege_type in ('insert', 'update')");
    indexOfRequired("raise exception 'ewa-pre-3:");
  });

  it("proves the closure in its postflight at table and column level, for both roles", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["insert", "update"]) {
        indexOfRequired(`has_table_privilege('${role}', 'public.users', '${priv}')`);
        indexOfRequired(`has_any_column_privilege('${role}', 'public.users', '${priv}')`);
      }
    }
  });

  it("proves the privileges that must remain", () => {
    indexOfRequired("has_table_privilege('authenticated', 'public.users', 'select')");
    indexOfRequired("has_table_privilege('authenticated', 'public.users', 'delete')");
    for (const priv of ["select", "insert", "update", "delete"]) {
      indexOfRequired(`has_table_privilege('service_role', 'public.users', '${priv}')`);
    }
  });
});

describe("entitlement-write-authority — scope", () => {
  it("adds no SECURITY DEFINER, function, trigger or policy", () => {
    expect(statements).not.toContain("security definer");
    expect(statements).not.toMatch(/create (or replace )?function/);
    expect(statements).not.toMatch(/create trigger/);
    expect(statements).not.toMatch(/(create|alter|drop) policy/);
  });

  it("manipulates no data and changes no column definition", () => {
    expect(statements).not.toMatch(/\binsert into\b/);
    expect(statements).not.toMatch(/\bupdate public\.[a-z_]+ set\b/);
    expect(statements).not.toMatch(/\bdelete from\b/);
    expect(statements).not.toMatch(/\bmerge into\b/);
    expect(statements).not.toMatch(/\btruncate\b/);
    expect(statements).not.toMatch(/\balter table\b/);
  });

  it("is transactional and touches only public.users", () => {
    expect(statements.trim().startsWith("begin;")).toBe(true);
    expect(statements.trim().endsWith("commit;")).toBe(true);
    const tables = new Set(statements.match(/public\.[a-z_]+/g) ?? []);
    expect(Array.from(tables)).toEqual(["public.users"]);
  });
});

// ─── Checkout trust boundary ──────────────────────────────────────────────────

const CHECKOUT = "app/api/stripe/checkout/route.ts";
const WEBHOOK = "app/api/webhooks/stripe/route.ts";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
}

describe("entitlement-write-authority — checkout customer link is a trusted write", () => {
  const checkout = stripComments(readSource(CHECKOUT));

  it("keeps caller identity on the verified session", () => {
    expect(checkout).toContain("await resolveVerifiedAuth()");
    expect(checkout).toContain("const supabase = auth.client;");
    // The profile read stays on the golfer's own session.
    const read = checkout.indexOf('.select("stripe_customer_id, full_name")');
    expect(read).toBeGreaterThan(-1);
    expect(checkout.slice(checkout.lastIndexOf("await supabase", read), read)).toContain('.from("users")');
  });

  it("constructs the elevated client once, after authentication, only for the link write", () => {
    expect((checkout.match(/createAdminClient\(\)/g) ?? []).length).toBe(1);
    const auth = checkout.indexOf("await resolveVerifiedAuth()");
    const admin = checkout.indexOf("createAdminClient()");
    const profileRead = checkout.indexOf('.select("stripe_customer_id, full_name")');
    expect(admin).toBeGreaterThan(auth);
    expect(admin).toBeGreaterThan(profileRead);
    const block = checkout.slice(admin, checkout.indexOf('.select("id")', admin));
    expect(block).toContain('.from("users")');
    expect(block).toContain(".update({ stripe_customer_id: customer.id })");
    expect(block).toContain('.eq("id", auth.userId)');
    expect(block).toContain('.is("stripe_customer_id", null)');
    for (const banned of ["subscription_tier", "subscription_status", "role"]) {
      expect(block, `the trusted link write must not touch ${banned}`).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
  });

  it("requires exactly one linked row before any checkout session", () => {
    const guard = checkout.indexOf("linkedRows.length !== 1");
    const failure = checkout.indexOf("account-link-failed");
    const session = checkout.indexOf("stripe.checkout.sessions.create");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(failure);
    expect(failure).toBeLessThan(session);
  });

  it("never writes public.users through the caller's session", () => {
    expect(checkout).not.toMatch(/supabase\s*\.from\("users"\)\s*\.(update|insert|upsert)\(/);
  });

  it("takes the user id only from the verified session", () => {
    expect(checkout).not.toMatch(/searchParams\.get\("(userId|user_id|id)"\)/);
    expect(checkout).not.toContain("req.json()");
  });

  it("never exposes service-role material", () => {
    for (const source of [checkout, stripComments(readSource("app/(dashboard)/upgrade/page.tsx"))]) {
      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
    expect(stripComments(readSource("app/(dashboard)/upgrade/page.tsx"))).not.toContain("createAdminClient");
  });

  it("leaves the Stripe webhook's trusted writer as it was", () => {
    const webhook = stripComments(readSource(WEBHOOK));
    expect(webhook).toContain("createAdminClient");
    expect(webhook).toContain('.eq("stripe_customer_id"');
  });
});

// ─── Live writer scan ─────────────────────────────────────────────────────────

describe("entitlement-write-authority — every live public.users writer is trusted", () => {
  it("finds public.users writes only in the webhook and the checkout link", () => {
    const tracked = execFileSync("git", ["ls-files", "app", "lib", "utils", "components"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));

    const writers: string[] = [];
    for (const file of tracked) {
      const source = stripComments(readSource(file));
      if (/\.from\((["'])users\1\)\s*\.(update|insert|upsert)\(/.test(source)) writers.push(file);
    }
    expect(writers.sort()).toEqual([CHECKOUT, WEBHOOK].sort());
    // Both through the server-only elevated client, never the caller's session.
    expect(stripComments(readSource(CHECKOUT))).toMatch(/await admin\s*\.from\("users"\)\s*\.update\(/);
    expect(stripComments(readSource(WEBHOOK))).toContain("createAdminClient");
  });
});
