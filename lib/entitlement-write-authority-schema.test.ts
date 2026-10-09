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
    // The profile read stays on the golfer's own session, and is presentation
    // only: it no longer selects the customer, which comes from the claim.
    const read = checkout.indexOf('.select("full_name")');
    expect(read).toBeGreaterThan(-1);
    expect(checkout.slice(checkout.lastIndexOf("await supabase", read), read)).toContain('.from("users")');
    expect(checkout).not.toContain('.select("stripe_customer_id, full_name")');
    expect(checkout).not.toMatch(/profile\??\.stripe_customer_id/);
  });

  it("constructs the elevated client once, after authentication, and links the customer only through its RPC", () => {
    expect((checkout.match(/createAdminClient\(\)/g) ?? []).length).toBe(1);
    const auth = checkout.indexOf("await resolveVerifiedAuth()");
    const admin = checkout.indexOf("createAdminClient()");
    const profileRead = checkout.indexOf('.select("full_name")');
    expect(admin).toBeGreaterThan(auth);
    expect(admin).toBeGreaterThan(profileRead);
    // The link carries only server-held values: the verified user, the
    // current claim token and the customer Stripe returned.
    expect(checkout).toContain('admin.rpc("billing_link_checkout_customer", {');
    expect(checkout).toContain("p_user_id: userId,");
    expect(checkout).toContain("p_claim_token: token,");
    expect(checkout).toContain("p_stripe_customer_id: customerId,");
    expect(checkout).toContain("await linkCustomer(admin, userId, claim.token, customer.id);");
    expect(checkout).toContain("const userId = auth.userId;");
  });

  it("requires a confirmed customer link before any checkout session", () => {
    const guard = checkout.indexOf('if (linked !== "linked" && linked !== "already_linked_same") return unavailable();');
    const session = checkout.indexOf("stripe.checkout.sessions.create");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(session);
    expect(checkout.indexOf('if (linked === "lost") return inProgress();')).toBeLessThan(guard);
  });

  it("has no direct public.users customer write left in checkout", () => {
    expect(checkout).not.toMatch(/\.from\("users"\)\s*\.update\(/);
    expect(checkout).not.toMatch(/\.update\(\{\s*stripe_customer_id/);
    expect(checkout).not.toContain('.is("stripe_customer_id", null)');
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

// ─── Stripe webhook: fail-closed trusted billing writer (BILL-STATUS1) ────────

describe("entitlement-write-authority — the Stripe webhook writes fail closed", () => {
  const webhook = stripComments(readSource(WEBHOOK));

  it("writes only through the server-only elevated client, bound to stripe_customer_id", () => {
    expect(webhook).toContain('import { createAdminClient } from "@/utils/supabase/admin";');
    expect(webhook).toContain('rpc("billing_apply_subscription_state", {');
    expect(webhook).toContain("p_stripe_customer_id: customerId,");
    expect(webhook).not.toMatch(/searchParams|req\.json\(|userId/);
    // The only profile id the webhook ever names comes from the customer mapping.
    expect(webhook.match(/p_user_id:[^,\n]+/g)).toEqual(["p_user_id: profileId"]);
    expect(webhook).toContain('.select("id").eq("stripe_customer_id", customerId)');
  });

  it("accepts only a known writer outcome and reads public.users without writing it", () => {
    expect(webhook).toContain("!APPLY_OUTCOMES.includes(result.data)");
    expect((webhook.match(/\.from\("users"\)/g) ?? []).length).toBe(1);
    expect(webhook).not.toMatch(/\.from\("users"\)\s*\.(update|insert|upsert|delete)\(/);
    expect(webhook).toContain("rows.length !== 1");
  });

  it("cannot acknowledge a failed write as received", () => {
    expect(webhook).toContain('{ error: "Webhook processing failed" }, { status: 500 }');
    expect((webhook.match(/received: true/g) ?? []).length).toBe(1);
    expect(webhook.lastIndexOf("return failed();")).toBeLessThan(webhook.indexOf("received: true"));
  });

  it("never persists a raw Stripe status", () => {
    expect(webhook).not.toMatch(/subscription_status:\s*(sub|subscription)\.status/);
    expect(webhook).toContain("normalizeStripeSubscriptionStatus(");
  });

  it("logs no customer or subscription identifier", () => {
    expect(webhook).not.toMatch(/console\.(log|error|warn|info|debug)\([^)]*(customer|subscription|\$\{)/i);
  });
});

// ─── Stripe price-to-tier authority (BILL-TIER1) ──────────────────────────────

describe("entitlement-write-authority — tier is bound to the price paid", () => {
  const checkout = stripComments(readSource(CHECKOUT));
  const webhook = stripComments(readSource(WEBHOOK));

  it("checkout takes a plan selector only; price and tier come from the server", () => {
    expect(checkout).toContain("await resolveVerifiedAuth()");
    expect(checkout).toContain('selector = (await req.formData()).get("plan");');
    expect(checkout).toContain("const plan = resolveStripePlan(selector);");
    expect(checkout.match(/\.get\("[a-z_]+"\)/gi)).toEqual(['.get("origin")', '.get("plan")']);
    expect(checkout).not.toMatch(/searchParams/);
    expect(checkout).toContain("line_items: [{ price: plan.priceId, quantity: 1 }]");
    expect(checkout).toContain("metadata: { tier: plan.tier, supabase_user_id: auth.userId }");
  });

  it("checkout resolves the plan before any customer, link or session side effect", () => {
    const resolve = checkout.indexOf("resolveStripePlan(");
    expect(resolve).toBeGreaterThan(-1);
    for (const effect of ["stripe.customers.create", "createAdminClient()", "stripe.checkout.sessions.create"]) {
      expect(checkout.indexOf(effect), effect).toBeGreaterThan(resolve);
    }
  });

  it("checkout still writes only the customer link, never entitlement", () => {
    expect(checkout).toContain('admin.rpc("billing_link_checkout_customer", {');
    expect(checkout).not.toMatch(/subscription_tier|subscription_status/);
    expect(checkout).not.toContain("billing_apply_subscription_state");
  });

  it("the webhook derives tier from the server price authority, never metadata", () => {
    expect(webhook).toContain('import { tierForStripePriceId } from "@/lib/billing/stripe-plan-authority";');
    expect(webhook).not.toMatch(/metadata/);
    expect(webhook).toContain("p_subscription_tier: state.subscription_tier,");
    expect(webhook).toContain('subscription_tier: status === "canceled" ? "none" : tierOf(subscription),');
    expect(webhook).not.toMatch(/searchParams|req\.json\(|userId/);
  });
});

// ─── Live writer scan ─────────────────────────────────────────────────────────

describe("entitlement-write-authority — every live public.users writer is trusted", () => {
  it("finds no direct public.users write; checkout and the webhook write through their RPCs", () => {
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
    expect(writers).toEqual([]);
    // Both through the server-only elevated client, never the caller's session:
    // the customer link authority and the billing state authority.
    expect(stripComments(readSource(CHECKOUT))).toContain('rpc("billing_link_checkout_customer"');
    expect(stripComments(readSource(CHECKOUT))).toContain("createAdminClient");
    expect(stripComments(readSource(WEBHOOK))).toContain("createAdminClient");
    expect(stripComments(readSource(WEBHOOK))).toContain('rpc("billing_apply_subscription_state"');
  });

  it("PRICING-1. the billing RPCs are called only from the two trusted server routes", () => {
    const tracked = execFileSync("git", ["ls-files", "app", "lib", "utils", "components"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
    const callers = tracked.filter((file) => /rpc\(\s*"billing_/.test(stripComments(readSource(file))));
    expect(callers.sort()).toEqual([CHECKOUT, WEBHOOK].sort());
    for (const file of callers) expect(stripComments(readSource(file))).toContain("createAdminClient");
    // Each authority stays with its own route.
    const checkoutSource = stripComments(readSource(CHECKOUT));
    const webhookSource = stripComments(readSource(WEBHOOK));
    expect(checkoutSource).not.toContain("billing_apply_subscription_state");
    expect(webhookSource).not.toContain("billing_link_checkout_customer");
  });
});
