import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVED_MIGRATIONS,
  EXPECTED_MIGRATION_COUNT,
  PI0_PRACTICE_INTELLIGENCE_FOUNDATION_FILENAME,
  PRICING1_BILLING_CHECKOUT_GUARD_FILENAME,
  migrationsAuthoredBefore,
  sortsAfterAll,
} from "./migration-inventory";

/**
 * PRICING-1 — billing checkout guard migration: source contract.
 *
 * Proves what the checked-in migration SAYS. It does not and cannot prove the
 * migration has been applied anywhere, nor exercise real row locks or
 * concurrent transactions: that belongs to the separately authorized staging
 * migration acceptance gate.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const raw = readFileSync(path.join(migrationsDir, PRICING1_BILLING_CHECKOUT_GUARD_FILENAME), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Executable SQL: comments removed, whitespace collapsed, lower-cased. */
const code = raw
  .replace(/--.*$/gm, "")
  .replace(/\s+/g, " ")
  .toLowerCase();

/** Statements outside function bodies and DO blocks: what the migration itself executes. */
const statements = code
  .replace(/\$function\$.*?\$function\$/g, "$function$$function$")
  .replace(/\$preflight\$.*?\$preflight\$/g, "$preflight$$preflight$")
  .replace(/\$postflight\$.*?\$postflight\$/g, "$postflight$$postflight$");

const FUNCTIONS = [
  "billing_begin_checkout",
  "billing_takeover_checkout",
  "billing_link_checkout_customer",
  "billing_attach_checkout_session",
  "billing_release_checkout",
  "billing_apply_subscription_state",
] as const;

const SIGNATURES: Record<(typeof FUNCTIONS)[number], string> = {
  billing_begin_checkout: "public.billing_begin_checkout(uuid, integer)",
  billing_takeover_checkout: "public.billing_takeover_checkout(uuid, uuid, text, integer)",
  billing_link_checkout_customer: "public.billing_link_checkout_customer(uuid, uuid, text)",
  billing_attach_checkout_session: "public.billing_attach_checkout_session(uuid, uuid, text)",
  billing_release_checkout: "public.billing_release_checkout(uuid, uuid)",
  billing_apply_subscription_state:
    "public.billing_apply_subscription_state(text, uuid, text, text, text, boolean, boolean)",
};

/** The whole CREATE FUNCTION statement for one function, header and body. */
function definition(name: string): string {
  const start = code.indexOf(`create function public.${name}(`);
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const bodyOpen = code.indexOf("$function$", start);
  const bodyClose = code.indexOf("$function$", bodyOpen + 1);
  return code.slice(start, bodyClose + "$function$".length);
}

/** The PL/pgSQL body only. */
function body(name: string): string {
  const def = definition(name);
  return def.slice(def.indexOf("$function$") + "$function$".length, def.lastIndexOf("$function$"));
}

function indexOfRequired(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  expect(at, `expected to contain: ${needle}`).toBeGreaterThanOrEqual(0);
  return at;
}

const USERS_LOCK = /from public\.users u where u\.(id|stripe_customer_id) = [a-z_]+ for update/;

// ─── Identity and inventory ───────────────────────────────────────────────────

describe("PRICING-1 guard migration — identity and inventory", () => {
  it("carries the CLI-generated filename", () => {
    expect(PRICING1_BILLING_CHECKOUT_GUARD_FILENAME).toBe("20261009020646_pricing1_billing_checkout_guard.sql");
    expect(PRICING1_BILLING_CHECKOUT_GUARD_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("is registered exactly once and exists on disk exactly once", () => {
    expect(APPROVED_MIGRATIONS.filter((m) => m === PRICING1_BILLING_CHECKOUT_GUARD_FILENAME)).toHaveLength(1);
    const onDisk = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(onDisk.filter((f) => f.endsWith("_pricing1_billing_checkout_guard.sql"))).toEqual([
      PRICING1_BILLING_CHECKOUT_GUARD_FILENAME,
    ]);
  });

  it("sorts after every migration that existed when it was authored, PI-0 last among them", () => {
    const earlier = migrationsAuthoredBefore(PRICING1_BILLING_CHECKOUT_GUARD_FILENAME);
    expect(earlier).toHaveLength(38);
    expect(earlier[earlier.length - 1]).toBe(PI0_PRACTICE_INTELLIGENCE_FOUNDATION_FILENAME);
    expect(sortsAfterAll(PRICING1_BILLING_CHECKOUT_GUARD_FILENAME, earlier)).toBe(true);
    expect(APPROVED_MIGRATIONS.indexOf(PRICING1_BILLING_CHECKOUT_GUARD_FILENAME)).toBe(38);
  });

  it("keeps the closed-world inventory equal to the files on disk", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(onDisk);
    expect(EXPECTED_MIGRATION_COUNT).toBe(APPROVED_MIGRATIONS.length);
    expect(APPROVED_MIGRATIONS.slice().sort()).toEqual(APPROVED_MIGRATIONS);
  });

  it("is transactional with fail-closed pre- and postflight blocks", () => {
    expect(statements.trim().startsWith("begin;")).toBe(true);
    expect(statements.trim().endsWith("commit;")).toBe(true);
    for (const n of [1, 2, 3, 4, 5, 6]) indexOfRequired(code, `raise exception 'pricing1-pre-${n}:`);
    for (let n = 1; n <= 12; n++) indexOfRequired(code, `raise exception 'pricing1-post-${n}:`);
    expect(code.indexOf("$preflight$")).toBeLessThan(code.indexOf("create table public.billing_checkout_guard"));
    expect(code.lastIndexOf("$postflight$")).toBeGreaterThan(code.lastIndexOf("grant execute"));
  });

  it("refuses to adapt to a pre-existing guard relation, function or duplicate subscription binding", () => {
    indexOfRequired(code, "c.relname in ('billing_checkout_guard', 'users_stripe_subscription_id_key')");
    indexOfRequired(code, "p.proname like 'billing\\_%'");
    indexOfRequired(code, "group by u.stripe_subscription_id having count(*) > 1");
    indexOfRequired(code, "r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = 'service_role'");
  });
});

// ─── Guard table ──────────────────────────────────────────────────────────────

describe("PRICING-1 guard migration — billing_checkout_guard table", () => {
  const table = code.slice(
    code.indexOf("create table public.billing_checkout_guard ("),
    code.indexOf(");", code.indexOf("constraint billing_checkout_guard_trial_subscription_check")) + 2,
  );

  it("has exactly the frozen columns and types", () => {
    const columns = Array.from(table.matchAll(/(?:\( |, )([a-z_]+) (uuid|timestamptz|text)\b/g), (m) => `${m[1]} ${m[2]}`);
    expect(columns).toEqual([
      "user_id uuid",
      "trial_used_at timestamptz",
      "trial_subscription_id text",
      "claim_token uuid",
      "claim_acquired_at timestamptz",
      "claim_expires_at timestamptz",
      "claim_session_id text",
      "updated_at timestamptz",
    ]);
    indexOfRequired(table, "updated_at timestamptz not null default now()");
  });

  it("keys the row to the profile with ON DELETE CASCADE", () => {
    indexOfRequired(table, "user_id uuid not null constraint billing_checkout_guard_pkey primary key");
    indexOfRequired(table, "references public.users (id) on delete cascade");
  });

  it("stores no price, tier, email, name or browser state", () => {
    for (const banned of ["price", "tier", "email", "name", "cookie", "browser", "status"]) {
      expect(table, banned).not.toMatch(new RegExp(`\\b[a-z_]*${banned}[a-z_]* (text|uuid|timestamptz|jsonb|integer)\\b`));
    }
  });

  it("enforces the all-or-nothing claim shape with expiry strictly after acquisition", () => {
    indexOfRequired(
      table,
      "(claim_token is null and claim_acquired_at is null and claim_expires_at is null and claim_session_id is null) or (claim_token is not null and claim_acquired_at is not null and claim_expires_at is not null and claim_expires_at > claim_acquired_at)",
    );
    indexOfRequired(table, "claim_session_id is null or length(claim_session_id) > 0");
  });

  it("requires a trial time whenever a trial subscription is recorded", () => {
    indexOfRequired(table, "check ( trial_subscription_id is null or trial_used_at is not null )");
  });

  it("enables RLS and creates no policy of any kind", () => {
    indexOfRequired(statements, "alter table public.billing_checkout_guard enable row level security;");
    expect(code).not.toMatch(/create policy|alter policy/);
  });

  it("revokes every table privilege from PUBLIC, anon, authenticated and service_role explicitly", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      indexOfRequired(statements, `revoke all on table public.billing_checkout_guard from ${role};`);
    }
  });

  it("grants service_role only SELECT, INSERT and UPDATE, and nothing to any browser role", () => {
    const grants = statements.match(/grant [^;]* on table [^;]*;/g) ?? [];
    expect(grants).toEqual(["grant select, insert, update on table public.billing_checkout_guard to service_role;"]);
  });

  it("proves the resulting table privileges in its postflight", () => {
    indexOfRequired(code, "array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']");
    indexOfRequired(code, "pg_catalog.has_table_privilege(browser, 'public.billing_checkout_guard', priv)");
    indexOfRequired(code, "pg_catalog.has_any_column_privilege(browser, 'public.billing_checkout_guard', priv)");
    indexOfRequired(code, "foreach priv in array array['delete', 'truncate', 'references', 'trigger'] loop");
    indexOfRequired(code, "p.polrelid = 'public.billing_checkout_guard'::regclass");
  });
});

// ─── Current-subscription index ───────────────────────────────────────────────

describe("PRICING-1 guard migration — current subscription identity", () => {
  it("adds the partial unique stripe_subscription_id index", () => {
    indexOfRequired(
      statements,
      "create unique index users_stripe_subscription_id_key on public.users (stripe_subscription_id) where stripe_subscription_id is not null;",
    );
    indexOfRequired(code, "i.indisunique and i.indpred is not null");
  });

  it("adds no users column and changes no users privilege, policy or constraint", () => {
    expect(statements).not.toMatch(/alter table public\.users/);
    expect(statements).not.toMatch(/(grant|revoke)[^;]*on (table )?public\.users\b/);
    expect(statements).not.toMatch(/drop (constraint|index|column|policy|table)/);
  });

  it("does not include the separate public.users DELETE/TRUNCATE hardening", () => {
    expect(statements).not.toMatch(/revoke[^;]*(delete|truncate)[^;]*public\.users/);
    expect(code).not.toMatch(/revoke [^;]*truncate/);
    expect(code).not.toMatch(/revoke delete/);
  });

  it("rewrites no row as part of the migration itself", () => {
    expect(statements).not.toMatch(/\binsert into\b/);
    expect(statements).not.toMatch(/\bupdate public\.[a-z_]+ /);
    expect(statements).not.toMatch(/\bdelete from\b/);
    expect(statements).not.toMatch(/\btruncate\b/);
  });
});

// ─── RPC security contract ────────────────────────────────────────────────────

describe("PRICING-1 guard migration — RPC security contract", () => {
  it("creates exactly the six billing functions", () => {
    const created = Array.from(code.matchAll(/create (?:or replace )?function public\.([a-z_]+)\(/g), (m) => m[1]);
    expect(created).toEqual([...FUNCTIONS]);
    expect(created).toHaveLength(6);
    indexOfRequired(code, "p.proname like 'billing\\_%') <> 6");
    indexOfRequired(code, "raise exception 'pricing1-post-8: exactly six public billing_ functions must exist.'");
    expect(code).not.toContain("<> 5 then");
  });

  it("the postflight proves all six signatures", () => {
    const listed = Array.from(code.matchAll(/'(public\.billing_[a-z_]+\([^)]*\))'::regprocedure/g), (m) => m[1]);
    expect(listed).toEqual(FUNCTIONS.map((name) => SIGNATURES[name]));
  });

  for (const name of FUNCTIONS) {
    it(`${name} is SECURITY INVOKER with an empty search_path, never DEFINER`, () => {
      const def = definition(name);
      const header = def.slice(0, def.indexOf("$function$"));
      expect(header).toContain("language plpgsql security invoker set search_path = '' as");
      expect(def).not.toContain("security definer");
    });

    it(`${name} EXECUTE is revoked from PUBLIC, anon and authenticated and granted to service_role only`, () => {
      const signature = SIGNATURES[name];
      indexOfRequired(statements, `revoke execute on function ${signature} from public, anon, authenticated;`);
      indexOfRequired(statements, `grant execute on function ${signature} to service_role;`);
      const grants = (statements.match(/grant execute on function [^;]*;/g) ?? []).filter((g) => g.includes(`.${name}(`));
      expect(grants).toEqual([`grant execute on function ${signature} to service_role;`]);
      indexOfRequired(code, `'${signature}'::regprocedure`);
    });

    it(`${name} locks public.users before it touches billing_checkout_guard`, () => {
      const fn = body(name);
      const users = fn.search(USERS_LOCK);
      const guard = fn.indexOf("public.billing_checkout_guard");
      expect(users, `${name} must lock users FOR UPDATE`).toBeGreaterThan(-1);
      expect(guard, `${name} must use the guard`).toBeGreaterThan(-1);
      expect(users).toBeLessThan(guard);
    });

    it(`${name} fully qualifies every application relation`, () => {
      const fn = body(name);
      const relations = fn.match(/\b(from|update|into|join)\s+([a-z_.]+)/g) ?? [];
      for (const r of relations) {
        const target = r.split(/\s+/)[1];
        // Variables and parameters (IS DISTINCT FROM p_x, SELECT ... INTO v_x) are not relations.
        if (/^(p|v)_[a-z_]+$/.test(target)) continue;
        expect(target, r).toMatch(/^(public|pg_catalog)\./);
      }
    });
  }

  it("contains no SECURITY DEFINER anywhere", () => {
    expect(statements).not.toContain("security definer");
    expect(code.match(/security definer/g)).toBeNull();
  });

  it("proves invoker, empty search_path and execute privileges in its postflight", () => {
    indexOfRequired(code, "p.prosecdef or p.proconfig is distinct from array['search_path=\"\"']::text[]");
    indexOfRequired(code, "pg_catalog.has_function_privilege('anon', fn, 'execute')");
    indexOfRequired(code, "pg_catalog.has_function_privilege('authenticated', fn, 'execute')");
    indexOfRequired(code, "x.grantee = 0");
    indexOfRequired(code, "pg_catalog.has_function_privilege('service_role', fn, 'execute')");
  });
});

// ─── billing_begin_checkout ───────────────────────────────────────────────────

describe("PRICING-1 guard migration — billing_begin_checkout", () => {
  const fn = body("billing_begin_checkout");

  it("bounds the claim ttl to 1800..3600 seconds", () => {
    indexOfRequired(fn, "p_ttl_seconds is null or p_ttl_seconds < 1800 or p_ttl_seconds > 3600");
  });

  it("decides local eligibility under the users lock: unbound and none/canceled only", () => {
    const lock = indexOfRequired(fn, "from public.users u where u.id = p_user_id for update;");
    const rule = indexOfRequired(
      fn,
      "if v_subscription_id is not null or v_status is null or v_status not in ('none', 'canceled') then return pg_catalog.jsonb_build_object('outcome', 'blocked');",
    );
    expect(lock).toBeLessThan(rule);
    // Blocked returns before any guard access, so it creates no claim.
    expect(rule).toBeLessThan(fn.indexOf("public.billing_checkout_guard"));
  });

  it("reports not_found for a missing profile", () => {
    indexOfRequired(fn, "if not found then return pg_catalog.jsonb_build_object('outcome', 'not_found');");
  });

  it("never overwrites an existing claim, expired or not: it returns it as held", () => {
    const held = indexOfRequired(fn, "if v_token is not null then return pg_catalog.jsonb_build_object( 'outcome', 'held',");
    const write = fn.indexOf("update public.billing_checkout_guard");
    expect(held).toBeLessThan(write);
    const heldBranch = fn.slice(held, fn.indexOf("end if;", held));
    expect(heldBranch).not.toContain("update ");
    expect(heldBranch).not.toContain("claim_expires_at <");
    for (const field of ["'claim_token', v_token", "'claim_acquired_at', v_acquired", "'claim_expires_at', v_expires", "'held_session_id', v_session", "'trial_used', v_trial_used is not null"]) {
      expect(heldBranch).toContain(field);
    }
  });

  it("measures claim age from claim_acquired_at, never updated_at", () => {
    indexOfRequired(fn, "'claim_age_seconds', extract(epoch from (v_now - v_acquired))");
    expect(fn).not.toMatch(/updated_at\s*[<>]|-\s*g?\.?updated_at|updated_at\s*-/);
  });

  it("creates a fresh random token with acquisition now and expiry now + ttl", () => {
    indexOfRequired(fn, "v_token := pg_catalog.gen_random_uuid();");
    indexOfRequired(fn, "v_expires := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);");
    indexOfRequired(fn, "'outcome', 'claimed',");
  });
});

// ─── billing_takeover_checkout ────────────────────────────────────────────────

describe("PRICING-1 guard migration — billing_takeover_checkout", () => {
  const fn = body("billing_takeover_checkout");

  it("re-checks local eligibility under the users lock", () => {
    indexOfRequired(fn, "if v_subscription_id is not null or v_status is null or v_status not in ('none', 'canceled') then");
  });

  it("is a compare-and-swap on the exact old token and NULL-safe expected Session", () => {
    indexOfRequired(fn, "or v_token is distinct from p_old_claim_token or v_session is distinct from p_expected_session_id then return pg_catalog.jsonb_build_object('outcome', 'lost');");
    indexOfRequired(fn, "where g.user_id = p_user_id and g.claim_token = p_old_claim_token;");
  });

  it("refuses an unattached claim younger than 180 seconds by claim_acquired_at", () => {
    indexOfRequired(fn, "if p_expected_session_id is null and v_now - v_acquired < interval '180 seconds' then");
    indexOfRequired(fn, "select g.claim_token, g.claim_acquired_at, g.claim_session_id, g.trial_used_at");
    expect(fn).not.toContain("g.updated_at");
  });

  it("issues a new token, resets acquisition, sets expiry and detaches the Session", () => {
    indexOfRequired(fn, "v_new_token := pg_catalog.gen_random_uuid();");
    indexOfRequired(fn, "set claim_token = v_new_token, claim_acquired_at = v_now, claim_expires_at = v_expires, claim_session_id = null,");
    expect(fn).not.toMatch(/claim_token = p_old_claim_token,/);
  });

  it("bounds the ttl and requires the old token", () => {
    indexOfRequired(fn, "if p_user_id is null or p_old_claim_token is null then");
    indexOfRequired(fn, "p_ttl_seconds < 1800 or p_ttl_seconds > 3600");
  });
});

// ─── billing_attach_checkout_session / billing_release_checkout ───────────────

describe("PRICING-1 guard migration — attach and release", () => {
  const attach = body("billing_attach_checkout_session");
  const release = body("billing_release_checkout");

  it("attach returns boolean and rejects missing or empty arguments", () => {
    indexOfRequired(definition("billing_attach_checkout_session"), ") returns boolean language plpgsql");
    indexOfRequired(attach, "if p_user_id is null or p_claim_token is null or p_session_id is null or length(p_session_id) = 0 then return false;");
  });

  it("attach re-checks local eligibility before touching the guard", () => {
    const rule = indexOfRequired(attach, "or v_subscription_id is not null or v_status is null or v_status not in ('none', 'canceled') then return false;");
    expect(rule).toBeLessThan(attach.indexOf("public.billing_checkout_guard"));
  });

  it("attach binds only the exact current, unattached, unexpired claim", () => {
    indexOfRequired(
      attach,
      "where g.user_id = p_user_id and g.claim_token = p_claim_token and g.claim_session_id is null and g.claim_expires_at > pg_catalog.now();",
    );
    indexOfRequired(attach, "return found;");
  });

  it("release requires a token and clears only an exact token match", () => {
    indexOfRequired(definition("billing_release_checkout"), ") returns boolean language plpgsql");
    indexOfRequired(release, "if p_user_id is null or p_claim_token is null then return false;");
    indexOfRequired(release, "where g.user_id = p_user_id and g.claim_token = p_claim_token;");
    expect(release).not.toMatch(/where g\.user_id = p_user_id;/);
  });

  it("release clears every claim field and never trial history", () => {
    indexOfRequired(release, "set claim_token = null, claim_acquired_at = null, claim_expires_at = null, claim_session_id = null,");
    expect(release).not.toContain("trial_");
  });
});

// ─── billing_apply_subscription_state ─────────────────────────────────────────

describe("PRICING-1 guard migration — atomic webhook writer", () => {
  const fn = body("billing_apply_subscription_state");

  it("returns text and only the five frozen outcomes", () => {
    indexOfRequired(definition("billing_apply_subscription_state"), ") returns text language plpgsql");
    const outcomes = Array.from(fn.matchAll(/return '([a-z_]+)';/g), (m) => m[1]);
    expect(Array.from(new Set(outcomes)).sort()).toEqual(
      ["applied", "conflict", "not_found", "stale_terminal", "unbound_terminal_recheck"].sort(),
    );
  });

  it("validates status and tier against server vocabularies", () => {
    indexOfRequired(fn, "p_subscription_status not in ('active', 'trialing', 'past_due', 'canceled', 'none')");
    indexOfRequired(fn, "p_subscription_tier not in ('par', 'birdie', 'eagle', 'none')");
    expect(fn).not.toMatch(/coach_starter|coach_pro/);
  });

  it("locks exactly the profile matched by stripe_customer_id before anything else", () => {
    const lock = indexOfRequired(fn, "from public.users u where u.stripe_customer_id = p_stripe_customer_id for update;");
    expect(lock).toBeLessThan(fn.indexOf("update public.users"));
    indexOfRequired(fn, "if not found then return 'not_found';");
  });

  it("nonterminal: a different bound subscription is a conflict with no write", () => {
    const branch = indexOfRequired(fn, "if p_subscription_status <> 'canceled' then if v_bound is not null and v_bound <> p_subscription_id then return 'conflict';");
    expect(branch).toBeLessThan(fn.indexOf("update public.users"));
  });

  it("nonterminal: unbound or same id binds and writes status and tier", () => {
    indexOfRequired(
      fn,
      "update public.users u set subscription_status = p_subscription_status, subscription_tier = p_subscription_tier, stripe_subscription_id = p_subscription_id where u.id = v_user_id;",
    );
  });

  it("terminal: a different bound subscription is stale and writes nothing", () => {
    const stale = indexOfRequired(fn, "else if v_bound is not null and v_bound <> p_subscription_id then return 'stale_terminal';");
    expect(stale).toBeLessThan(fn.lastIndexOf("update public.users"));
  });

  it("terminal: an unbound row is canceled only with the explicit allowance", () => {
    const recheck = indexOfRequired(fn, "if v_bound is null and not p_allow_unbound_terminal then return 'unbound_terminal_recheck';");
    const write = indexOfRequired(
      fn,
      "update public.users u set subscription_status = 'canceled', subscription_tier = 'none', stripe_subscription_id = null where u.id = v_user_id;",
    );
    expect(recheck).toBeLessThan(write);
  });

  it("ensures and locks the guard only after the users row, in the same transaction", () => {
    const users = fn.search(USERS_LOCK);
    const ensure = indexOfRequired(fn, "insert into public.billing_checkout_guard (user_id) values (v_user_id) on conflict (user_id) do nothing;");
    const lock = indexOfRequired(fn, "from public.billing_checkout_guard g where g.user_id = v_user_id for update;");
    expect(users).toBeLessThan(ensure);
    expect(ensure).toBeLessThan(lock);
  });

  it("records trial usage monotonically: coalesce, never cleared, first subscription sticks", () => {
    indexOfRequired(fn, "if p_trial_received then update public.billing_checkout_guard g set trial_used_at = coalesce(g.trial_used_at, v_now), trial_subscription_id = coalesce(g.trial_subscription_id, p_subscription_id),");
    expect(code).not.toMatch(/trial_used_at = null|trial_subscription_id = null/);
  });

  it("a NULL claim token never clears a claim; a non-NULL one clears only its own", () => {
    indexOfRequired(
      fn,
      "if p_claim_token is not null then update public.billing_checkout_guard g set claim_token = null, claim_acquired_at = null, claim_expires_at = null, claim_session_id = null, updated_at = v_now where g.user_id = v_user_id and g.claim_token = p_claim_token;",
    );
    expect(fn.match(/claim_token = null/g)).toHaveLength(1);
  });

  it("the conflict and stale exits precede every guard write, so neither releases a claim", () => {
    const firstGuard = fn.indexOf("public.billing_checkout_guard");
    expect(fn.indexOf("return 'conflict';")).toBeLessThan(firstGuard);
    expect(fn.indexOf("return 'stale_terminal';")).toBeLessThan(firstGuard);
    expect(fn.indexOf("return 'unbound_terminal_recheck';")).toBeLessThan(firstGuard);
  });
});

// ─── Backward compatibility ───────────────────────────────────────────────────

describe("PRICING-1 guard migration — backward compatible with the deployed application", () => {
  it("removes, renames and weakens nothing existing", () => {
    expect(statements).not.toMatch(/\bdrop\b/);
    expect(statements).not.toMatch(/\brename\b/);
    expect(statements).not.toMatch(/alter (table|function|index) (?!public\.billing_checkout_guard enable row level security)/);
    expect(statements).not.toContain("create or replace");
  });

  it("only the new guard relation and the users index are created", () => {
    expect(statements.match(/create (unique )?(table|index) [a-z_.]+/g)).toEqual([
      "create table public.billing_checkout_guard",
      "create unique index users_stripe_subscription_id_key",
    ]);
  });
});


// ─── billing_link_checkout_customer (stale-owner remediation) ─────────────────

describe("PRICING-1 guard migration — billing_link_checkout_customer", () => {
  const fn = body("billing_link_checkout_customer");
  const def = definition("billing_link_checkout_customer");

  it("has the exact signature and returns text", () => {
    indexOfRequired(
      def,
      "create function public.billing_link_checkout_customer( p_user_id uuid, p_claim_token uuid, p_stripe_customer_id text ) returns text language plpgsql security invoker set search_path = '' as",
    );
  });

  it("refuses a missing or empty customer with SQLSTATE 22023 before any lock", () => {
    const check = indexOfRequired(
      fn,
      "if p_stripe_customer_id is null or length(p_stripe_customer_id) = 0 then raise exception 'pricing1-link-1: a stripe customer is required.' using errcode = '22023';",
    );
    expect(check).toBeLessThan(fn.search(USERS_LOCK));
  });

  it("locks the profile first, reading the stored customer under that lock", () => {
    indexOfRequired(
      fn,
      "select u.stripe_subscription_id, u.subscription_status, u.stripe_customer_id into v_subscription_id, v_status, v_customer_id from public.users u where u.id = p_user_id for update;",
    );
    indexOfRequired(fn, "if not found then return 'not_found';");
  });

  it("blocks an ineligible profile before touching the guard", () => {
    const blocked = indexOfRequired(
      fn,
      "if v_subscription_id is not null or v_status is null or v_status not in ('none', 'canceled') then return 'blocked';",
    );
    expect(blocked).toBeLessThan(fn.indexOf("public.billing_checkout_guard"));
  });

  it("locks the guard second and requires the exact, unexpired, unattached current claim", () => {
    indexOfRequired(
      fn,
      "select g.claim_token, g.claim_expires_at, g.claim_session_id into v_token, v_expires, v_session from public.billing_checkout_guard g where g.user_id = p_user_id for update;",
    );
    indexOfRequired(
      fn,
      "if not found or p_claim_token is null or v_token is distinct from p_claim_token or v_expires is null or v_expires <= pg_catalog.now() or v_session is not null then return 'lost';",
    );
  });

  it("does not treat claim age as ownership loss", () => {
    expect(fn).not.toMatch(/180|claim_acquired_at|interval/);
  });

  it("proves ownership before it looks at the customer, so a stale token never sees already_linked_same", () => {
    const lost = fn.indexOf("return 'lost';");
    for (const later of ["return 'linked';", "return 'already_linked_same';", "return 'customer_conflict';", "update public.users"]) {
      expect(fn.indexOf(later), later).toBeGreaterThan(lost);
    }
  });

  it("writes the customer only when none is linked, on the locked row", () => {
    indexOfRequired(
      fn,
      "if v_customer_id is null then update public.users u set stripe_customer_id = p_stripe_customer_id where u.id = p_user_id; return 'linked';",
    );
    expect(fn.match(/update public\.users/g)).toHaveLength(1);
  });

  it("the same customer is an idempotent no-write success; a different one is a conflict, never overwritten", () => {
    indexOfRequired(fn, "if v_customer_id = p_stripe_customer_id then return 'already_linked_same';");
    const conflict = indexOfRequired(fn, "return 'customer_conflict'; end;");
    expect(fn.slice(fn.indexOf("return 'already_linked_same';"), conflict)).not.toContain("update ");
  });

  it("answers exactly the six frozen outcomes", () => {
    const outcomes = Array.from(fn.matchAll(/return '([a-z_]+)';/g), (m) => m[1]);
    expect(Array.from(new Set(outcomes)).sort()).toEqual(
      ["already_linked_same", "blocked", "customer_conflict", "linked", "lost", "not_found"].sort(),
    );
  });

  it("does not swallow a unique violation: no exception handler", () => {
    expect(fn).not.toMatch(/\bexception\s+when\b/);
    expect(fn).not.toContain("unique_violation");
    expect(fn).not.toContain("on conflict");
  });

  it("never writes the guard, a subscription, a tier or trial history", () => {
    expect(fn).not.toMatch(/update public\.billing_checkout_guard|insert into/);
    expect(fn).not.toMatch(/subscription_tier|stripe_subscription_id =|trial_/);
  });

  it("relies on the existing unique stripe_customer_id constraint, which this migration does not touch", () => {
    expect(statements).not.toMatch(/users_stripe_customer_id_key/);
    expect(statements).not.toMatch(/(drop|alter) [^;]*stripe_customer_id/);
  });
});

describe("PRICING-1 guard migration — claims carry the durable customer", () => {
  it("begin reads the customer under the users lock and returns it only on a claimed answer", () => {
    const fn = body("billing_begin_checkout");
    indexOfRequired(
      fn,
      "select u.stripe_subscription_id, u.subscription_status, u.stripe_customer_id into v_subscription_id, v_status, v_customer_id from public.users u where u.id = p_user_id for update;",
    );
    const claimed = fn.lastIndexOf("'outcome', 'claimed',");
    expect(fn.indexOf("'stripe_customer_id', v_customer_id")).toBeGreaterThan(claimed);
    const held = fn.slice(fn.indexOf("'outcome', 'held',"), fn.indexOf("end if;", fn.indexOf("'outcome', 'held',")));
    expect(held).not.toContain("stripe_customer_id");
    expect(fn.match(/'stripe_customer_id'/g)).toHaveLength(1);
  });

  it("takeover reads the customer under the users lock and returns it on the new claim", () => {
    const fn = body("billing_takeover_checkout");
    indexOfRequired(
      fn,
      "select u.stripe_subscription_id, u.subscription_status, u.stripe_customer_id into v_subscription_id, v_status, v_customer_id from public.users u where u.id = p_user_id for update;",
    );
    expect(fn.indexOf("'stripe_customer_id', v_customer_id")).toBeGreaterThan(fn.lastIndexOf("'outcome', 'claimed',"));
    expect(fn.match(/'stripe_customer_id'/g)).toHaveLength(1);
  });

  it("neither begin nor takeover writes the customer", () => {
    for (const name of ["billing_begin_checkout", "billing_takeover_checkout"]) {
      expect(body(name)).not.toMatch(/set[^;]*stripe_customer_id/);
    }
  });
});
