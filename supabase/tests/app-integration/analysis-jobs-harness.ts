// AG-WEB-READY-10-P2 — test harness for the durable analysis jobs (DISPOSABLE LOCAL STACK ONLY).
//
// Database roles are reached the way ADR 10-P1 §11 prescribes for slice 1: `SET ROLE <role>` inside the run's own
// database container (psql over the container's local socket, as the stack's bootstrap superuser, which may assume
// any role). Nothing here is product code: the worker core receives `workerRpc()` as its injected transport, and the
// analyze route still reaches admit_analysis_job through the real service-role client.
//
// Time: the functions use the database clock. Where a lease or a window would otherwise make a test wait, the test
// moves the row's timestamps back instead (`ageClaim`, `ageJob`, `ageLedger`) — a fake clock with no product hook.

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { admin, setTier, type Golfer } from "./ent1d-fixtures";
import type { WorkerFunction, WorkerRpc } from "@/lib/analysis-job-worker";

let containerVerified = false;
function container(): string {
  const name = process.env.ENT1D_DB_CONTAINER;
  const label = process.env.ENT1D_EXPECTED_LABEL;
  if (!name || !label) throw new Error("ENT1D_DB_CONTAINER and ENT1D_EXPECTED_LABEL are required.");
  if (!containerVerified) {
    const actual = execFileSync("docker", ["inspect", "--format", '{{index .Config.Labels "com.supabase.cli.project"}}', name], { encoding: "utf8" }).trim();
    if (actual !== label) throw new Error(`TARGET_MISMATCH: ${name} is ${actual}`);
    containerVerified = true;
  }
  return name;
}

const psqlArgs = (user: string) => ["exec", "-i", container(), "psql", "-U", user, "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"];

/** Runs SQL in the run's database; returns psql's tuples-only output. Throws on error. */
export function psql(sql: string, user = "supabase_admin"): string {
  return execFileSync("docker", psqlArgs(user), { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** The same, without throwing: the exit code and both streams. */
export function psqlTry(sql: string, user = "supabase_admin"): { code: number; out: string; err: string } {
  try {
    return { code: 0, out: psql(sql, user), err: "" };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: String(x.stdout ?? "").trim(), err: String(x.stderr ?? "").trim() };
  }
}

/** Concurrent sessions: resolves when the psql process exits. */
export function psqlAsync(sql: string, user = "supabase_admin"): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile("docker", psqlArgs(user), { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() });
    });
    child.stdin?.end(sql);
  });
}

/** A typed SQL literal with a fresh dollar-quote tag (never present in the value). */
export function lit(value: unknown, type: string): string {
  if (value === null || value === undefined) return `null::${type}`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let tag: string;
  do tag = `$q${randomBytes(6).toString("hex")}$`; while (text.includes(tag));
  return `${tag}${text}${tag}::${type}`;
}

const ARG_TYPES: Readonly<Record<string, string>> = {
  p_user: "uuid", p_analysis: "uuid", p_declared: "boolean", p_retry_of: "text", p_client_metrics: "jsonb",
  p_worker: "text", p_adapter: "text", p_job: "uuid", p_claim: "uuid", p_policy: "boolean", p_result: "jsonb",
  p_kind: "text", p_ids: "uuid[]", p_outcome: "text",
};

function callSql(fn: string, args: Readonly<Record<string, unknown>>): string {
  const list = Object.entries(args).map(([k, v]) => {
    const type = ARG_TYPES[k];
    if (!type) throw new Error(`unknown argument ${k}`);
    if (type === "uuid[]") return `${k} => ${lit(`{${(v as string[]).join(",")}}`, "uuid[]")}`;
    return `${k} => ${lit(v, type)}`;
  });
  return `select 'R:' || coalesce(pg_catalog.to_jsonb(public.${fn}(${list.join(", ")}))::text, 'null');`;
}

/** Calls a function as `role` (optionally with request.jwt.claims set, as PostgREST would) and parses its JSON. */
export function callAs(role: string, fn: string, args: Readonly<Record<string, unknown>> = {}, claims?: unknown): unknown {
  const claimSql = claims === undefined ? "" : `select pg_catalog.set_config('request.jwt.claims', ${lit(typeof claims === "string" ? claims : JSON.stringify(claims), "text")}, true);\n`;
  const out = psql(`begin;\nset local role ${role};\n${claimSql}${callSql(fn, args)}\ncommit;`);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("R:"));
  if (line === undefined) throw new Error("no result line");
  return JSON.parse(line.slice(2));
}

/** Same as callAs, but returns the error text instead of throwing. */
export function callAsTry(role: string, fn: string, args: Readonly<Record<string, unknown>> = {}): { ok: true; data: unknown } | { ok: false; err: string } {
  try {
    return { ok: true, data: callAs(role, fn, args) };
  } catch (e) {
    return { ok: false, err: String((e as { stderr?: string }).stderr ?? e) };
  }
}

export interface RpcCall {
  readonly fn: WorkerFunction;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: "ok" | "error" | "dropped" | "lost_after_commit";
}

export type RpcFault = (fn: WorkerFunction, args: Readonly<Record<string, unknown>>) =>
  | "pass" | "drop" | "lose_after_commit" | { readonly replace: unknown } | { readonly respond: unknown };

/**
 * The worker's injected transport: each call is one transaction as analysis_worker. `fault` simulates a transport
 * that never reaches the database (`drop`), one whose answer is lost after the database committed
 * (`lose_after_commit`), a reply of another shape after the call ran (`replace`), or a reply without running the
 * call at all (`respond`).
 */
export function workerRpc(fault?: RpcFault): WorkerRpc & { readonly log: RpcCall[] } {
  const log: RpcCall[] = [];
  return {
    log,
    async call(fn, args) {
      const f = fault ? fault(fn, args) : "pass";
      if (f === "drop") {
        log.push({ fn, args, result: "dropped" });
        return { ok: false };
      }
      if (typeof f === "object" && "respond" in f) {
        log.push({ fn, args, result: "dropped" });
        return { ok: true, data: f.respond };
      }
      const r = callAsTry("analysis_worker", fn, args);
      if (f === "lose_after_commit") {
        log.push({ fn, args, result: "lost_after_commit" });
        return { ok: false };
      }
      log.push({ fn, args, result: r.ok ? "ok" : "error" });
      if (!r.ok) return { ok: false };
      if (typeof f === "object" && "replace" in f) return { ok: true, data: f.replace };
      return { ok: true, data: r.data };
    },
  };
}

/** The ENT-1D operator override, bound to this transaction (postgres). */
export function operator(statements: string): string {
  return psql(`begin;\nselect pg_catalog.set_config('swingproai.execution_guard', 'operator_override:' || pg_catalog.txid_current(), true);\n${statements}\ncommit;`, "postgres");
}

/** Sets control-row columns as the operator (postgres). Pass `null` to set a column to NULL. */
export function setControl(patch: Readonly<Record<string, string | number | boolean | null>>): void {
  const sets = Object.entries(patch).map(([k, v]) => `${k} = ${v === null ? "null" : typeof v === "string" ? lit(v, "text") : String(v)}`);
  psql(`update public.analysis_admission_control set ${sets.join(", ")}, updated_at = now() where id;`, "postgres");
}

export const DEFAULT_CONTROL = {
  execution_mode_full_swing: "sync", admissions_enabled: false, dispatch_enabled: false, provider_mode: "none",
  legacy_failed_admission: false, max_open_jobs_per_user: 3, max_concurrent_dispatch: 1, max_requeues: 5,
  units_full_swing: 1, per_user_daily_units: null, global_daily_units: null,
} as const;

/** The synthetic test configuration: queue mode, admissions and dispatch on, synthetic provider, cap 1. */
export function queueMode(extra: Readonly<Record<string, string | number | boolean | null>> = {}): void {
  setControl({ ...DEFAULT_CONTROL, execution_mode_full_swing: "queue", admissions_enabled: true, dispatch_enabled: true, provider_mode: "synthetic", ...extra });
}

export function resetControl(): void {
  setControl({ ...DEFAULT_CONTROL });
}

/** Rows as JSON, read as postgres (the operator role). */
export function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)::text from (${sql}) x;`, "postgres");
  return JSON.parse(out) as T[];
}

export const jobsOf = (analysisId: string) =>
  rows<Record<string, unknown>>(`select * from public.analysis_jobs where analysis_id = ${lit(analysisId, "uuid")} order by generation`);
export const ledgerOfAnalysis = (analysisId: string) =>
  rows<Record<string, unknown>>(`select * from public.analysis_spend_ledger where analysis_id = ${lit(analysisId, "uuid")} order by reserved_at`);
export const ledgerOfJob = (jobId: string) =>
  rows<Record<string, unknown>>(`select * from public.analysis_spend_ledger where job_id = ${lit(jobId, "uuid")}`)[0] ?? null;
export const analysisRow = (analysisId: string) =>
  rows<Record<string, unknown>>(`select id, status, processing_claim_id, processing_started_at, processing_heartbeat_at, provider_dispatched_at, score, feedback from public.swing_analysis where id = ${lit(analysisId, "uuid")}`)[0] ?? null;
export const liveSlots = (): number =>
  Number(psql("begin; set local role analysis_jobs_owner; select public.analysis_jobs_live_slots(); commit;").split(/\r?\n/).find((l) => /^\d+$/.test(l)));

/** Moves an analysis's claim timestamps back by `seconds` (operator override), as if the clock moved forward. */
export function ageClaim(analysisId: string, seconds: number): void {
  operator(`update public.swing_analysis set processing_started_at = processing_started_at - interval '${seconds} seconds',
    processing_heartbeat_at = case when processing_heartbeat_at = '1970-01-01 00:00:00+00' then processing_heartbeat_at
                                   else processing_heartbeat_at - interval '${seconds} seconds' end,
    provider_dispatched_at = provider_dispatched_at - interval '${seconds} seconds'
    where id = ${lit(analysisId, "uuid")} and processing_claim_id is not null;`);
}

/** Moves a job's times back (available_at for backoff, dispatched_at), as postgres. */
export function ageJob(jobId: string, seconds: number): void {
  psql(`update public.analysis_jobs set available_at = available_at - interval '${seconds} seconds',
          created_at = created_at - interval '${seconds} seconds',
          dispatched_at = dispatched_at - interval '${seconds} seconds' where id = ${lit(jobId, "uuid")};`, "postgres");
}

/** Moves a ledger row's reservation and dispatch times back, as postgres (the rolling window). */
export function ageLedger(jobId: string, seconds: number): void {
  psql(`update public.analysis_spend_ledger set reserved_at = reserved_at - interval '${seconds} seconds',
          dispatched_at = dispatched_at - interval '${seconds} seconds' where job_id = ${lit(jobId, "uuid")};`, "postgres");
}

/** admit_analysis_job as the route calls it (service_role). */
export function admitSql(userId: string, analysisId: string, declared = true, retryOf: string | null = null, metrics: unknown = null): Record<string, unknown> {
  return callAs("service_role", "admit_analysis_job", {
    p_user: userId, p_analysis: analysisId, p_declared: declared, p_retry_of: retryOf, p_client_metrics: metrics,
  }) as Record<string, unknown>;
}

/** read_analysis_job_state as the golfer (authenticated, claims as PostgREST sets them). */
export function readStateAs(userId: string, analysisId: string): Record<string, unknown> | null {
  return callAs("authenticated", "read_analysis_job_state", { p_analysis: analysisId }, { sub: userId, role: "authenticated" }) as Record<string, unknown> | null;
}

/** Waits until `predicate` holds (polling a database fact), at most `ms`. */
export async function until(predicate: () => boolean, ms = 15_000, step = 150): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error("condition not reached in time");
}

/** pg_stat_activity: is a session waiting on a lock right now (used to order concurrent steps)? */
export function someoneWaitsOnLock(): boolean {
  return psql("select count(*) from pg_catalog.pg_stat_activity where wait_event_type = 'Lock';") !== "0";
}

/**
 * Test isolation: every open job left by an earlier test is closed (superseded) and every unsettled ledger row is
 * released, as the operator, so the next test starts with no open job and no occupied dispatch slot. Analyses are left
 * as they are (they belong to finished tests).
 */
export function drainQueue(): void {
  psql(`update public.analysis_jobs set state = 'superseded', failure_kind = 'superseded_state', worker_claim_id = null,
          outcome_unknown_source = null, outcome_unknown_at = null, finished_at = now()
         where state in ('queued','claimed','dispatched','outcome_unknown');
        update public.analysis_spend_ledger set state = 'released', reason = 'test_reset', settled_at = now()
         where state in ('reserved','dispatched','held');`, "postgres");
}

const untracked: string[] = [];

/**
 * A synthetic golfer for tests that delete the account themselves (ent1d-fixtures' own cleanup would then report the
 * missing account). Removed by cleanupUntracked(), which tolerates an account that is already gone.
 */
export async function createUntrackedGolfer(tier = "par"): Promise<Golfer> {
  const email = `p2-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  untracked.push(data.user.id);
  await setTier(data.user.id, tier);
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn failed: ${signIn.error?.message}`);
  return { id: data.user.id, accessToken: signIn.data.session.access_token };
}

export async function cleanupUntracked(): Promise<string[]> {
  const errors: string[] = [];
  for (const id of untracked) {
    const still = psql(`select count(*) from auth.users where id = ${lit(id, "uuid")};`);
    if (still === "0") continue;
    for (const table of ["swing_analysis", "swing_videos", "user_equipment"]) {
      const d = await admin.from(table).delete().eq("user_id", id);
      if (d.error) errors.push(`${table}: ${d.error.message}`);
    }
    const u = await admin.auth.admin.deleteUser(id);
    if (u.error) errors.push(`auth: ${u.error.message}`);
  }
  untracked.length = 0;
  return errors;
}

/** Moves a job's outcome_unknown_at back by `seconds` (the classifier grace), as postgres. */
export function ageUnknown(jobId: string, seconds: number): void {
  psql(`update public.analysis_jobs set outcome_unknown_at = outcome_unknown_at - interval '${seconds} seconds' where id = ${lit(jobId, "uuid")};`, "postgres");
}

/** True once the psql session named `name` is inside pg_sleep (so every lock it took before the sleep is held). */
export function sessionSleeping(name: string): boolean {
  return psql(`select count(*) from pg_catalog.pg_stat_activity where application_name = ${lit(name, "text")} and wait_event = 'PgSleep';`) === "1";
}
/** True while the psql session named `name` waits on a lock. */
export function sessionWaitsOnLock(name: string): boolean {
  return psql(`select count(*) from pg_catalog.pg_stat_activity where application_name = ${lit(name, "text")} and wait_event_type = 'Lock';`) === "1";
}
