// ============================================================================
// AG-WEB-READY-10-P2 — M1 (20261127120000_analysis_jobs) against the real local database
// ============================================================================
//
// Privileges and the postflight, the admission precedence (the one rule shared with
// lib/analysis-attempt-precedence.ts), the job-claim trigger in both orders against the synchronous claim of the
// pinned claim library, limits under concurrency, and the delete/retention trigger. Database roles are reached by
// SET ROLE on the run's own disposable stack (analysis-jobs-harness.ts). Synthetic golfers, videos and units only.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { readFileSync } from "node:fs";
import path from "node:path";
import { claimAnalysisExecution } from "@/lib/analysis-execution-claim";
import { ADMISSION_DISPOSITIONS } from "@/lib/analysis-attempt-precedence";
import { admin, cleanupFixtures, createAnalysis, createGolfer, row, type Golfer } from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";
import {
  admitSql, ageClaim, analysisRow, callAs, callAsTry, drainQueue, jobsOf, ledgerOfAnalysis, lit, operator, psql, psqlAsync, psqlTry,
  queueMode, readStateAs, resetControl, setControl, someoneWaitsOnLock, until, workerRpc,
} from "./analysis-jobs-harness";

const MIGRATION = readFileSync(path.resolve(__dirname, "../../migrations/20261127120000_analysis_jobs.sql"), "utf8");
const WORKER_FUNCTIONS = [
  "acquire_analysis_job(text,text)", "mark_job_dispatched(uuid,uuid,text)", "heartbeat_analysis_job(uuid,uuid)",
  "requeue_undispatched_job(uuid,uuid,boolean)", "complete_analysis_job(uuid,uuid,jsonb)", "fail_analysis_job(uuid,uuid,text)",
  "mark_job_outcome_unknown(uuid,uuid)", "cancel_ineligible_job(uuid,uuid)", "classify_stalled_jobs()",
];

let golfer: Golfer;
let other: Golfer;
beforeAll(async () => {
  golfer = await createGolfer("birdie");
  other = await createGolfer("par");
});
beforeEach(() => {
  resetControl();
  drainQueue();
});
afterAll(async () => {
  resetControl();
  expect(await cleanupFixtures(), "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
});

const disposition = (r: Record<string, unknown>) => r.disposition as string;
const attemptId = (r: Record<string, unknown>) => (r.attempt as { id: string } | null)?.id ?? null;

/** Acquire + mark + complete/fail through the worker functions directly (no adapter). */
function acquire(adapter = "synthetic") {
  return callAs("analysis_worker", "acquire_analysis_job", { p_worker: "sql-test", p_adapter: adapter }) as Record<string, unknown> | null;
}
function mark(job: Record<string, unknown>, adapter = "synthetic") {
  return callAs("analysis_worker", "mark_job_dispatched", { p_job: job.jobId, p_claim: job.claimId, p_adapter: adapter }) as Record<string, unknown>;
}
function failJob(job: Record<string, unknown>, kind: string) {
  return callAs("analysis_worker", "fail_analysis_job", { p_job: job.jobId, p_claim: job.claimId, p_kind: kind });
}

// ── Privileges and postflight ────────────────────────────────────────────────

describe("M1 privileges (matrix 27, 28, 34)", () => {
  it("API roles cannot execute worker or operator functions or touch the tables; the worker cannot admit, read or reconcile", () => {
    const check = (role: string, fn: string) =>
      psql(`select has_function_privilege('${role}', 'public.${fn}', 'EXECUTE');`) === "t";
    for (const fn of WORKER_FUNCTIONS) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(check(role, fn), `${role} ${fn}`).toBe(false);
      expect(check("analysis_worker", fn), `worker ${fn}`).toBe(true);
    }
    for (const fn of ["admit_analysis_job(uuid,uuid,boolean,text,jsonb)", "read_analysis_job_state(uuid)", "read_analysis_job_states(uuid[])", "reconcile_analysis_job(uuid,text)"]) {
      expect(check("analysis_worker", fn), `worker ${fn}`).toBe(false);
    }
    expect(check("anon", "admit_analysis_job(uuid,uuid,boolean,text,jsonb)")).toBe(false);
    expect(check("authenticated", "admit_analysis_job(uuid,uuid,boolean,text,jsonb)")).toBe(false);
    expect(check("service_role", "admit_analysis_job(uuid,uuid,boolean,text,jsonb)")).toBe(true);
    for (const role of ["anon", "authenticated", "service_role", "analysis_worker", "analysis_jobs_owner"]) {
      expect(check(role, "reconcile_analysis_job(uuid,text)"), `${role} reconcile`).toBe(false);
    }
    for (const t of ["analysis_jobs", "analysis_admission_control", "analysis_spend_ledger"]) {
      for (const role of ["anon", "authenticated", "service_role", "analysis_worker"]) {
        expect(psql(`select has_table_privilege('${role}', 'public.${t}', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');`), `${role} ${t}`).toBe("f");
      }
    }
    // real attempts, not just catalog answers
    expect(callAsTry("service_role", "acquire_analysis_job", { p_worker: "x", p_adapter: "synthetic" }).ok).toBe(false);
    expect(callAsTry("authenticated", "complete_analysis_job", { p_job: crypto.randomUUID(), p_claim: crypto.randomUUID(), p_result: {} }).ok).toBe(false);
    expect(callAsTry("analysis_worker", "admit_analysis_job", { p_user: golfer.id, p_analysis: crypto.randomUUID(), p_declared: true }).ok).toBe(false);
    expect(psqlTry("begin; set local role service_role; select count(*) from public.analysis_jobs; commit;").code).not.toBe(0);
  });

  it("the postflight passes on this stack and fails closed on a second-grantor membership of the owner role (34)", () => {
    const block = MIGRATION.slice(MIGRATION.indexOf("do $postflight$"), MIGRATION.indexOf("$postflight$;") + "$postflight$;".length);
    expect(block.length).toBeGreaterThan(1000);
    const clean = psqlTry(`begin;\n${block}\nrollback;`, "postgres");
    expect(clean.code, clean.err).toBe(0);
    const tampered = psqlTry(`begin;\ngrant analysis_jobs_owner to service_role;\n${block}\nrollback;`);
    expect(tampered.code).not.toBe(0);
    expect(tampered.err).toContain("AJ-POST-2");
    expect(psql("select count(*) from pg_auth_members where roleid = 'analysis_jobs_owner'::regrole;")).toBe("1");
  });

  it("a session's override marker is unusable inside the definer functions (28): they refuse to run, and their owner is outside the guard's allow-list", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const marker = "select set_config('swingproai.execution_guard', 'operator_override:' || txid_current(), true);";
    const refused = psqlTry(`begin; set local role service_role; ${marker} select public.admit_analysis_job(${lit(golfer.id, "uuid")}, ${lit(id, "uuid")}, true); commit;`);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("AJ-OVERRIDE-1");
    // A test-only definer probe owned by analysis_jobs_owner: it reports who it runs as and tries a write only the
    // override could make (a claimed row's status changed without proof). The guard refuses it.
    queueMode();
    expect(disposition(admitSql(golfer.id, id))).toBe("created");
    const job = acquire()!;
    const probe = psqlTry(`
      create function public.zz_p2_override_probe(p uuid) returns text language plpgsql security definer set search_path = '' as $f$
      begin
        perform pg_catalog.set_config('swingproai.execution_guard', 'operator_override:' || pg_catalog.txid_current(), true);
        update public.swing_analysis set status = 'failed' where id = p;
        return current_user;
      end $f$;
      alter function public.zz_p2_override_probe(uuid) owner to analysis_jobs_owner;
      begin; select public.zz_p2_override_probe(${lit(id, "uuid")}); commit;`);
    psql("drop function if exists public.zz_p2_override_probe(uuid);");
    expect(probe.code).not.toBe(0);
    expect(probe.err).toContain("ENT1D-CLAIM-5");
    expect(analysisRow(id)).toMatchObject({ status: "processing", processing_claim_id: job.claimId });
  });

  it("status reads are owner-bound through the JWT subject; foreign, malformed, empty and oversized inputs give nothing (33)", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    expect(readStateAs(golfer.id, id)).toMatchObject({ analysisId: id, execution: "idle", attempt: null });
    expect(readStateAs(other.id, id)).toBeNull();
    for (const claims of ['{"sub":""}', '{"sub":"nope"}', "not json", "{}", '{"sub":null}']) {
      expect(callAs("authenticated", "read_analysis_job_state", { p_analysis: id }, claims), claims).toBeNull();
    }
    const many = Array.from({ length: 51 }, () => crypto.randomUUID());
    expect(callAs("authenticated", "read_analysis_job_states", { p_ids: [id, ...many] }, { sub: golfer.id })).toEqual([]);
    expect(callAs("authenticated", "read_analysis_job_states", { p_ids: [id, many[0]] }, { sub: golfer.id })).toEqual([
      { analysisId: id, execution: "idle", attempt: null },
    ]);
    // an internal failure kind is never returned
    queueMode();
    admitSql(golfer.id, id);
    const job = acquire()!;
    mark(job);
    expect(failJob(job, "provider_rejected")).toBe("failed");
    const state = readStateAs(golfer.id, id) as { execution: string; attempt: { failureKind: string; state: string } };
    expect(state.execution).toBe("failed");
    expect(state.attempt).toMatchObject({ state: "failed", failureKind: "not_finished" });
    expect(JSON.stringify(state)).not.toContain("provider_rejected");
    expect(JSON.stringify(state)).not.toContain(job.claimId as string);
  });
});

// ── Admission precedence ─────────────────────────────────────────────────────

describe("admission precedence (the shared rule)", () => {
  it("every disposition the database can return is one the shared module names", () => {
    const named = new Set<string>(ADMISSION_DISPOSITIONS);
    for (const m of Array.from(MIGRATION.matchAll(/'disposition', '([a-z_]+)'/g))) expect(named.has(m[1]), m[1]).toBe(true);
    for (const m of Array.from(MIGRATION.matchAll(/then '([a-z_]+)' else '([a-z_]+)' end/g))) {
      if (m[1] === "stalled") expect(named.has(m[2])).toBe(true);
    }
  });

  it("default mode is sync: no job, no reservation, the route runs today's synchronous path", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    expect(admitSql(golfer.id, id)).toEqual({ disposition: "sync_mode" });
    expect(admitSql(golfer.id, id, false)).toEqual({ disposition: "sync_mode" });
    expect(jobsOf(id)).toEqual([]);
    expect(ledgerOfAnalysis(id)).toEqual([]);
    expect((await row(id)).status).toBe("pending");
  });

  it("a missing control row pauses admission and acquisition (31)", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    psql("delete from public.analysis_admission_control;", "postgres");
    try {
      expect(admitSql(golfer.id, id)).toMatchObject({ disposition: "admission_paused", reason: "control_missing" });
      expect(acquire()).toBeNull();
      expect(readStateAs(golfer.id, id)).toMatchObject({ execution: "paused" });
    } finally {
      psql("insert into public.analysis_admission_control (id) values (true);", "postgres");
    }
    expect(jobsOf(id)).toEqual([]);
  });

  it("queue mode: an undeclared request creates nothing (26); a declared one creates g1 with one reservation; a replay names the same attempt (2)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    expect(admitSql(golfer.id, id, false)).toEqual({ disposition: "client_update_required" });
    expect(jobsOf(id)).toEqual([]);
    const first = admitSql(golfer.id, id);
    expect(disposition(first)).toBe("created");
    expect(first.attempt).toMatchObject({ generation: 1, state: "queued" });
    const again = admitSql(golfer.id, id);
    expect(disposition(again)).toBe("replayed");
    expect(attemptId(again)).toBe(attemptId(first));
    expect(admitSql(golfer.id, id, false)).toMatchObject({ disposition: "client_update_required" });
    expect(jobsOf(id)).toHaveLength(1);
    const ledger = ledgerOfAnalysis(id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ state: "reserved", units: 1, dispatched_at: null });
    expect((await row(id)).status).toBe("pending"); // admission never writes swing_analysis
  });

  it("two tabs pressing Analyze at once get one attempt (1)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const sql = `begin; set local role service_role; select public.admit_analysis_job(${lit(golfer.id, "uuid")}, ${lit(id, "uuid")}, true)::text; commit;`;
    const answers = await Promise.all([psqlAsync(sql), psqlAsync(sql), psqlAsync(sql)]);
    const parsed = answers.map((a) => JSON.parse(a.out.split(/\r?\n/).pop()!));
    expect(parsed.map(disposition).sort()).toEqual(["created", "replayed", "replayed"]);
    expect(new Set(parsed.map(attemptId)).size).toBe(1);
    expect(jobsOf(id)).toHaveLength(1);
    expect(ledgerOfAnalysis(id)).toHaveLength(1);
  });

  it("retries: one successor per failed attempt (4); a stale retry is superseded (5); an obsolete one cannot regress a complete report (3)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const g1 = attemptId(admitSql(golfer.id, id))!;
    let job = acquire()!;
    expect(failJob(job, "video_unusable")).toBe("failed");
    expect(admitSql(golfer.id, id)).toMatchObject({ disposition: "failed_observed", attempt: { id: g1, state: "failed", failureKind: "video_unusable" } });
    const sql = `begin; set local role service_role; select public.admit_analysis_job(${lit(golfer.id, "uuid")}, ${lit(id, "uuid")}, true, ${lit(g1, "text")})::text; commit;`;
    const two = (await Promise.all([psqlAsync(sql), psqlAsync(sql)])).map((a) => JSON.parse(a.out.split(/\r?\n/).pop()!));
    expect(two.map(disposition).sort()).toEqual(["created", "replayed"]);
    const g2 = attemptId(two[0])!;
    expect(attemptId(two[1])).toBe(g2);
    expect(jobsOf(id).map((j) => j.generation)).toEqual([1, 2]);
    // the delayed original Retry(g1) while g2 is open: replayed g2, no g3
    expect(admitSql(golfer.id, id, true, g1)).toMatchObject({ disposition: "replayed", attempt: { id: g2, generation: 2 } });
    job = acquire()!;
    expect(job.generation).toBe(2);
    expect(failJob(job, "response_unusable")).toBe("failed");
    expect(admitSql(golfer.id, id, true, g1)).toMatchObject({ disposition: "superseded", attempt: { id: g2 } });
    const g3 = attemptId(admitSql(golfer.id, id, true, g2))!;
    job = acquire()!;
    expect(mark(job)).toMatchObject({ reason: "dispatched", jobId: g3 });
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: job.jobId, p_claim: job.claimId, p_result: SYNTHETIC_STORED })).toBe("completed");
    // A1 (attempt identity): each request names the attempt its own intent was accepted as (the initial press g1, a
    // Retry naming X its one successor); the completed attempt it describes is `current` when that is another one.
    const own: Record<string, string> = { null: g1, [g1]: g2, [g2]: g3, [g3]: g3 };
    for (const stale of [g1, g2, g3, null]) {
      const r = admitSql(golfer.id, id, true, stale);
      expect(r, String(stale)).toMatchObject({ disposition: "complete", attempt: { id: own[String(stale)] } });
      if (own[String(stale)] === g3) expect(r.current, String(stale)).toBeUndefined();
      else expect(r.current, String(stale)).toMatchObject({ id: g3, state: "complete" });
    }
    expect(jobsOf(id).map((j) => [j.generation, j.state])).toEqual([[1, "failed_definite"], [2, "failed_definite"], [3, "succeeded"]]);
    expect(readStateAs(golfer.id, id)).toMatchObject({ execution: "complete", attempt: { id: g3 } });
  });

  it("foreign analyses and foreign or invented attempt references are not found (15, 35)", async () => {
    queueMode();
    const mine = await createAnalysis(golfer, "full_swing", { upload: true });
    const theirs = await createAnalysis(other, "full_swing", { upload: true });
    expect(admitSql(golfer.id, theirs)).toEqual({ disposition: "not_found" });
    const theirAttempt = attemptId(admitSql(other.id, theirs))!;
    for (const ref of [theirAttempt, crypto.randomUUID(), "legacy", "1; drop table x"]) {
      expect(admitSql(golfer.id, mine, true, ref), ref).toEqual({ disposition: "not_found" });
    }
    expect(jobsOf(mine)).toEqual([]);
    setControl({ admissions_enabled: false });
    expect(admitSql(golfer.id, mine)).toMatchObject({ disposition: "admission_paused" });
    expect(admitSql(other.id, theirs)).toMatchObject({ disposition: "replayed", attempt: { id: theirAttempt } }); // replay unaffected
  });

  it("rollback to sync keeps analyses with a job in admission: a Retry is paused while admissions are off (22)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    admitSql(golfer.id, id);
    const job = acquire()!;
    failJob(job, "video_unusable");
    setControl({ execution_mode_full_swing: "sync", admissions_enabled: false });
    expect(admitSql(golfer.id, id)).toMatchObject({ disposition: "failed_observed" });
    expect(admitSql(golfer.id, id, true, job.jobId as string)).toMatchObject({ disposition: "admission_paused" });
    expect(jobsOf(id)).toHaveLength(1);
    const fresh = await createAnalysis(golfer, "full_swing", { upload: true });
    expect(admitSql(golfer.id, fresh)).toEqual({ disposition: "sync_mode" }); // no job ever: the synchronous path
  });

  it("legacy failed rows (no job ever) are not admitted unless the owner enables the sentinel", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true, status: "failed" });
    expect(admitSql(golfer.id, id)).toEqual({ disposition: "failed_observed" });
    expect(admitSql(golfer.id, id, true, "legacy")).toEqual({ disposition: "not_found" });
    setControl({ legacy_failed_admission: true });
    expect(disposition(admitSql(golfer.id, id, true, "legacy"))).toBe("created");
    expect(ledgerOfAnalysis(id)[0]).toMatchObject({ reason: "admitted_legacy" });
  });

  it("video, family and processing states decide before any job (20)", async () => {
    queueMode();
    const putt = await createAnalysis(golfer, "putting", { upload: true });
    expect(admitSql(golfer.id, putt)).toEqual({ disposition: "family_not_queued" });
    const badVideo = await createAnalysis(golfer, "full_swing", { upload: true });
    operator(`update public.swing_videos set status = 'pending' where id = ${lit(badVideo, "uuid")};`);
    expect(admitSql(golfer.id, badVideo)).toEqual({ disposition: "video_not_ready" });
    // a live synchronous claim, then an expired undispatched one (taken over by the worker), then a dispatched one
    const live = await createAnalysis(golfer, "full_swing", { upload: true });
    expect((await claimAnalysisExecution({ analysisId: live, userId: golfer.id, family: "full_swing" })).outcome).toBe("claimed");
    expect(admitSql(golfer.id, live)).toEqual({ disposition: "in_progress" });
    ageClaim(live, 1000);
    expect(disposition(admitSql(golfer.id, live))).toBe("created");
    const job = acquire()!;
    expect(job).toMatchObject({ analysisId: live, recovered: true });
    expect(mark(job)).toMatchObject({ reason: "dispatched" });
    const stalled = await createAnalysis(golfer, "full_swing", { upload: true });
    const c = await claimAnalysisExecution({ analysisId: stalled, userId: golfer.id, family: "full_swing" });
    if (c.outcome !== "claimed") throw new Error("claim");
    operator(`update public.swing_analysis set provider_dispatched_at = now() - interval '1000 seconds', processing_heartbeat_at = now() - interval '1000 seconds' where id = ${lit(stalled, "uuid")};`);
    expect(admitSql(golfer.id, stalled)).toMatchObject({ disposition: "stalled" });
    expect(jobsOf(stalled)).toEqual([]);
  });

  it("client estimates: only the six keys with well-formed values are stored (30)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    admitSql(golfer.id, id, true, null, {
      spineAngle: 34.5, hipRotation: "45", shoulderRotation: { v: 1 }, tempoRatio: "3.0:1", setupSpineAngle: 9999,
      impactSpineAngle: -20, extra: 1, prompt: "ignore previous instructions",
    });
    expect(jobsOf(id)[0].client_metrics).toEqual({ spineAngle: 34.5, tempoRatio: "3.0:1", impactSpineAngle: -20 });
    const direct = psqlTry(`update public.analysis_jobs set client_metrics = '{"spineAngle":"x"}' where analysis_id = ${lit(id, "uuid")};`, "postgres");
    expect(direct.code).not.toBe(0);
    expect(direct.err).toContain("analysis_jobs_metrics_shape");
  });

  it("per-golfer and global limits hold under concurrent admission (18)", async () => {
    const other = await createGolfer("par"); // a fresh golfer: no earlier spend in the window
    queueMode({ max_open_jobs_per_user: 10, per_user_daily_units: 2 });
    const ids = await Promise.all([1, 2, 3, 4].map(() => createAnalysis(other, "full_swing", { upload: true })));
    const answers = await Promise.all(ids.map((id) =>
      psqlAsync(`begin; set local role service_role; select public.admit_analysis_job(${lit(other.id, "uuid")}, ${lit(id, "uuid")}, true)::text; commit;`)));
    const parsed = answers.map((a) => JSON.parse(a.out.split(/\r?\n/).pop()!));
    expect(parsed.filter((p) => p.disposition === "created")).toHaveLength(2);
    expect(parsed.filter((p) => p.disposition === "limit_reached")).toHaveLength(2);
    setControl({ per_user_daily_units: null, max_open_jobs_per_user: 2 });
    const one = await createAnalysis(other, "full_swing", { upload: true });
    expect(admitSql(other.id, one)).toMatchObject({ disposition: "limit_reached", reason: "open_jobs" });
    setControl({ max_open_jobs_per_user: 10, global_daily_units: 0 });
    expect(admitSql(other.id, one)).toMatchObject({ disposition: "limit_reached", reason: "units" });
  });
});

// ── The job-claim trigger, both orders ───────────────────────────────────────

describe("synchronous claims against analyses with a job (6, 7)", () => {
  it("the pinned claim library is refused on an analysis with any job, including after its attempt failed (6)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    admitSql(golfer.id, id);
    const before = await row(id);
    expect((await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" })).outcome).toBe("unavailable");
    expect(await row(id)).toEqual(before);
    const job = acquire()!;
    failJob(job, "video_unusable");
    expect((await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" })).outcome).toBe("unavailable");
    const direct = psqlTry(`begin; set local role service_role; update public.swing_analysis set status = 'processing', processing_claim_id = gen_random_uuid(),
      processing_started_at = now(), processing_heartbeat_at = now() where id = ${lit(id, "uuid")}; commit;`);
    expect(direct.err).toContain("JOB-CLAIM-1");
    expect((await row(id)).status).toBe("failed");
  });

  it("order A: a synchronous claim waiting on a committing admission sees the job and is refused (7)", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const admission = psqlAsync(`begin; set local role service_role;
      select public.admit_analysis_job(${lit(golfer.id, "uuid")}, ${lit(id, "uuid")}, true)::text; select pg_sleep(3); commit;`);
    await new Promise((r) => setTimeout(r, 700)); // admission holds the analysis row lock and sleeps
    const claim = claimAnalysisExecution({ analysisId: id, userId: golfer.id, family: "full_swing" });
    await until(() => someoneWaitsOnLock(), 2500);
    const [claimed, admitted] = await Promise.all([claim, admission]);
    expect(JSON.parse(admitted.out.split(/\r?\n/).find((l) => l.startsWith("{"))!).disposition).toBe("created");
    expect(claimed.outcome).toBe("unavailable");
    expect((await row(id)).status).toBe("pending");
    expect(jobsOf(id)).toHaveLength(1);
  });

  it("order B: an admission waiting on a committing synchronous claim answers in_progress and creates nothing", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const claim = psqlAsync(`begin; set local role service_role;
      update public.swing_analysis set status = 'processing', processing_claim_id = gen_random_uuid(), processing_started_at = now(),
        processing_heartbeat_at = now() where id = ${lit(id, "uuid")} and status = 'pending';
      select pg_sleep(3); commit;`);
    await new Promise((r) => setTimeout(r, 700));
    const admission = psqlAsync(`begin; set local role service_role;
      select public.admit_analysis_job(${lit(golfer.id, "uuid")}, ${lit(id, "uuid")}, true)::text; commit;`);
    await until(() => someoneWaitsOnLock(), 2500);
    const [c, a] = await Promise.all([claim, admission]);
    expect(c.code, c.err).toBe(0);
    expect(JSON.parse(a.out.split(/\r?\n/).pop()!)).toEqual({ disposition: "in_progress" });
    expect(jobsOf(id)).toEqual([]);
    expect((await row(id)).status).toBe("processing");
  });
});

// ── Retention ────────────────────────────────────────────────────────────────

describe("job retention (has-ever-had-a-job cannot be undone)", () => {
  it("a direct delete of the last job of a live analysis is refused; an earlier generation is kept as lineage; cascades are allowed", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    admitSql(golfer.id, id);
    let job = acquire()!;
    failJob(job, "video_unusable");
    const last = psqlTry(`delete from public.analysis_jobs where analysis_id = ${lit(id, "uuid")};`, "postgres");
    expect(last.err).toContain("JOB-RETAIN-1");
    admitSql(golfer.id, id, true, job.jobId as string);
    job = acquire()!;
    failJob(job, "video_unusable");
    const earlier = psqlTry(`delete from public.analysis_jobs where analysis_id = ${lit(id, "uuid")} and generation = 1;`, "postgres");
    expect(earlier.err).toContain("analysis_jobs_retry_of_job_id_fkey"); // lineage is retained
    expect(jobsOf(id).map((j) => j.generation)).toEqual([1, 2]);
    expect(ledgerOfAnalysis(id)).toHaveLength(2);
    const del = await admin.from("swing_analysis").delete().eq("id", id);
    expect(del.error).toBeNull();
    expect(jobsOf(id)).toEqual([]);
    expect(ledgerOfAnalysis(id).map((l) => l.state)).toEqual(["released", "released"]);
  });
});

// The stored result of the synthetic adapter (unscored), as the worker would send it.
const SYNTHETIC_STORED = {
  score: null,
  feedback: "SYNTHETIC TEST RESULT: test fixture.",
  spine_angle: null, hip_rotation: null, shoulder_rotation: null, tempo_ratio: null,
  metrics: { scoring_breakdown: "SYNTHETIC TEST RESULT: no swing was analysed." },
  swing_highlights: [],
  mechanical_deficiencies: [],
};

describe("reviews 1: limits, pause, identity, postflight tamper, acquire binding, sync mode", () => {
  it("the global limit holds under concurrent admission by different golfers (18)", async () => {
    const golfers = await Promise.all([1, 2, 3, 4].map(() => createGolfer("par")));
    const used = Number(psql(`select coalesce(sum(units), 0) from public.analysis_spend_ledger where state = 'reserved'
      or (state in ('dispatched','held','charged') and dispatched_at > now() - interval '24 hours');`, "postgres"));
    queueMode({ global_daily_units: used + 2 }); // room for exactly two more units in the window
    const ids = await Promise.all(golfers.map((g) => createAnalysis(g, "full_swing", { upload: true })));
    const answers = await Promise.all(golfers.map((g, i) =>
      psqlAsync(`begin; set local role service_role; select public.admit_analysis_job(${lit(g.id, "uuid")}, ${lit(ids[i], "uuid")}, true)::text; commit;`)));
    const parsed = answers.map((a) => JSON.parse(a.out.split(/\r?\n/).pop()!));
    expect(parsed.filter((p) => p.disposition === "created")).toHaveLength(2);
    expect(parsed.filter((p) => p.disposition === "limit_reached")).toHaveLength(2);
  });

  it("a foreign analysis is not found while admissions are paused (35)", async () => {
    queueMode({ admissions_enabled: false });
    const theirs = await createAnalysis(other, "full_swing", { upload: true });
    expect(admitSql(golfer.id, theirs)).toEqual({ disposition: "not_found" });
  });

  it("the read path has one identity source: a JWT without `sub` reads nothing even if request.jwt.claim.sub is set", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const out = psql(`begin; set local role authenticated;
      select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
      select set_config('request.jwt.claim.sub', ${lit(golfer.id, "text")}, true);
      select 'R:' || coalesce(public.read_analysis_job_state(${lit(id, "uuid")})::text, 'null'); commit;`);
    expect(out.split(/\r?\n/).find((l) => l.startsWith("R:"))).toBe("R:null");
  });

  it("the postflight fails closed on a privilege given to any other role (security 1)", () => {
    const block = MIGRATION.slice(MIGRATION.indexOf("do $postflight$"), MIGRATION.indexOf("$postflight$;") + "$postflight$;".length);
    const fn = psqlTry(`begin; create role zz_p2_scratch nologin; grant execute on function public.admit_analysis_job(uuid,uuid,boolean,text,jsonb) to zz_p2_scratch;\n${block}\nrollback;`);
    expect(fn.code).not.toBe(0);
    expect(fn.err).toContain("AJ-POST-22");
    const tbl = psqlTry(`begin; create role zz_p2_scratch nologin; grant select on public.analysis_spend_ledger to zz_p2_scratch;\n${block}\nrollback;`);
    expect(tbl.err).toContain("AJ-POST-23");
    // security 2 SHOULD-A: a grant option is never designed
    const grantable = psqlTry(`begin; grant execute on function public.admit_analysis_job(uuid,uuid,boolean,text,jsonb) to service_role with grant option;\n${block}\nrollback;`);
    expect(grantable.code).not.toBe(0);
    expect(grantable.err).toContain("AJ-POST-22");
    const grantableTbl = psqlTry(`begin; grant select on public.analysis_spend_ledger to postgres with grant option;\n${block}\nrollback;`);
    expect(grantableTbl.err).toContain("AJ-POST-23");
    const col = psqlTry(`begin; grant select (email) on public.users to analysis_jobs_owner;\n${block}\nrollback;`);
    expect(col.err).toMatch(/AJ-POST-(16|24)/);
    expect(psql("select count(*) from pg_roles where rolname = 'zz_p2_scratch';")).toBe("0");
  });

  it("acquire re-checks the video binding and never hands out a path that is no longer the owner's uploaded object (security 2)", async () => {
    queueMode();
    // the video row stops being uploaded; its key stops being canonical; it is owned by someone else (the last two
    // only with the guard bypassed, as a historical row could be)
    const breakers = [
      (id: string) => operator(`update public.swing_videos set status = 'pending' where id = ${lit(id, "uuid")};`),
      (id: string) => psql(`begin; set local session_replication_role = replica; update public.swing_videos set storage_path = 'elsewhere/' || id || '.mp4' where id = ${lit(id, "uuid")}; commit;`),
      (id: string) => psql(`begin; set local session_replication_role = replica; update public.swing_videos set user_id = ${lit(other.id, "uuid")} where id = ${lit(id, "uuid")}; commit;`),
    ];
    for (const breakVideo of breakers) {
      drainQueue();
      const id = await createAnalysis(golfer, "full_swing", { upload: true });
      const job = attemptId(admitSql(golfer.id, id))!;
      breakVideo(id);
      expect(acquire()).toBeNull();
      expect(jobsOf(id)[0]).toMatchObject({ id: job, state: "superseded", failure_kind: "video_unusable" });
      expect(ledgerOfAnalysis(id)[0]).toMatchObject({ state: "released", reason: "video_unusable" });
      // the golfer is asked to upload again, not offered a Retry that would answer video_not_ready
      expect((readStateAs(golfer.id, id) as { attempt: { failureKind: string } }).attempt.failureKind).toBe("video_unusable");
    }
  });

  it("sync mode: an analysis that never had a job reaches today's synchronous path whatever its video row says", async () => {
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    operator(`update public.swing_videos set status = 'pending' where id = ${lit(id, "uuid")};`);
    expect(admitSql(golfer.id, id)).toEqual({ disposition: "sync_mode" });
    queueMode();
    expect(admitSql(golfer.id, id)).toEqual({ disposition: "video_not_ready" });
  });
});

// ── AG-WEB-READY-10-P2-A1 ────────────────────────────────────────────────────

describe("A1: every accepted intent keeps its own attempt (attempt identity)", () => {
  it("attempt 1 fails and a Retry creates attempt 2: the initial press replayed while 2 is open and after it completes names attempt 1; repeats of the Retry name its one successor; stale requests create nothing and never move the state back", async () => {
    queueMode();
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const first = admitSql(golfer.id, id);
    expect(first).toMatchObject({ disposition: "created", attempt: { generation: 1, state: "queued" } });
    const g1 = attemptId(first)!;
    let job = acquire()!;
    expect(mark(job)).toMatchObject({ reason: "dispatched", jobId: g1 });
    expect(failJob(job, "response_unusable")).toBe("failed");
    // the Retry and a repeat of it, at once: one successor, named by both
    const retrySql = `begin; set local role service_role; select public.admit_analysis_job(${lit(golfer.id, "uuid")}, ${lit(id, "uuid")}, true, ${lit(g1, "text")})::text; commit;`;
    const retries = (await Promise.all([psqlAsync(retrySql), psqlAsync(retrySql)])).map((a) => JSON.parse(a.out.split(/\r?\n/).pop()!));
    expect(retries.map(disposition).sort()).toEqual(["created", "replayed"]);
    const g2 = attemptId(retries[0])!;
    expect(attemptId(retries[1])).toBe(g2);
    expect(retries.map((r) => r.current)).toEqual([undefined, undefined]);
    // the delayed initial press, twice at once, while attempt 2 is open: attempt 1, and attempt 2 as the current status
    const initialSql = `begin; set local role service_role; select public.admit_analysis_job(${lit(golfer.id, "uuid")}, ${lit(id, "uuid")}, true)::text; commit;`;
    const whileOpen = (await Promise.all([psqlAsync(initialSql), psqlAsync(initialSql)])).map((a) => JSON.parse(a.out.split(/\r?\n/).pop()!));
    for (const r of whileOpen) {
      expect(r).toMatchObject({ disposition: "replayed", attempt: { id: g1, generation: 1, state: "failed" }, current: { id: g2, generation: 2, state: "queued" } });
    }
    expect(admitSql(golfer.id, id, true, g1)).toMatchObject({ disposition: "replayed", attempt: { id: g2 } });
    expect(jobsOf(id).map((j) => j.generation)).toEqual([1, 2]);
    // attempt 2 runs and completes
    job = acquire()!;
    expect(job).toMatchObject({ jobId: g2, generation: 2 });
    expect(mark(job)).toMatchObject({ reason: "dispatched", jobId: g2 });
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: g2, p_claim: job.claimId, p_result: SYNTHETIC_STORED })).toBe("completed");
    const settled = readStateAs(golfer.id, id);
    expect(settled).toMatchObject({ execution: "complete", attempt: { id: g2, state: "complete" } });
    const jobsBefore = jobsOf(id);
    const ledgerBefore = ledgerOfAnalysis(id);
    const rowBefore = analysisRow(id);
    // after completion: the initial press still names attempt 1 (attempt 2 is current); the Retry names attempt 2
    expect(admitSql(golfer.id, id)).toMatchObject({ disposition: "complete", attempt: { id: g1, state: "failed" }, current: { id: g2, state: "complete" } });
    for (let i = 0; i < 2; i++) {
      const r = admitSql(golfer.id, id, true, g1);
      expect(r).toMatchObject({ disposition: "complete", attempt: { id: g2, state: "complete" } });
      expect(r.current).toBeUndefined();
    }
    // a stale Retry naming attempt 2 (it has no successor, and the analysis is complete): no third job
    expect(admitSql(golfer.id, id, true, g2)).toMatchObject({ disposition: "complete", attempt: { id: g2 } });
    expect(jobsOf(id)).toEqual(jobsBefore);
    expect(ledgerOfAnalysis(id)).toEqual(ledgerBefore);
    expect(analysisRow(id)).toEqual(rowBefore);
    expect(readStateAs(golfer.id, id)).toEqual(settled);
    // two attempts, two reservations, two dispatch marks (each charged once: both reached the synthetic dispatch)
    expect(jobsOf(id).map((j) => [j.generation, j.state, j.dispatched_at !== null])).toEqual([[1, "failed_definite", true], [2, "succeeded", true]]);
    expect(ledgerOfAnalysis(id).map((l) => [l.state, l.units, l.dispatched_at !== null])).toEqual([["charged", 1, true], ["charged", 1, true]]);
    console.log(`A1_IDENTITY attempts ${jobsOf(id).length}, reservations ${ledgerOfAnalysis(id).length}, dispatch marks ${jobsOf(id).filter((j) => j.dispatched_at !== null).length}`);
  });

  it("a repeat of an accepted legacy press names the attempt it created and creates nothing", async () => {
    queueMode({ legacy_failed_admission: true });
    const id = await createAnalysis(golfer, "full_swing", { upload: true, status: "failed" });
    const created = admitSql(golfer.id, id, true, "legacy");
    expect(created).toMatchObject({ disposition: "created", attempt: { generation: 1 } });
    const g1 = attemptId(created)!;
    expect(admitSql(golfer.id, id, true, "legacy")).toMatchObject({ disposition: "replayed", attempt: { id: g1 } });
    setControl({ legacy_failed_admission: false });
    expect(admitSql(golfer.id, id, true, "legacy")).toMatchObject({ disposition: "replayed", attempt: { id: g1 } });
    expect(admitSql(golfer.id, id)).toMatchObject({ disposition: "replayed", attempt: { id: g1 } });
    expect(jobsOf(id)).toHaveLength(1);
    expect(ledgerOfAnalysis(id)).toHaveLength(1);
    // review: another golfer naming this analysis (with the legacy sentinel or not) learns nothing and creates nothing
    for (const ref of ["legacy", null, g1]) {
      expect(admitSql(other.id, id, true, ref), String(ref)).toEqual({ disposition: "not_found" });
    }
    expect(jobsOf(id)).toHaveLength(1);
  });
});

describe("A1: a status read and a press agree (admission/read agreement)", () => {
  type Mode = "sync" | "queue" | "queue_paused";
  const setMode = (mode: Mode) => {
    resetControl();
    if (mode === "queue") queueMode();
    if (mode === "queue_paused") queueMode({ admissions_enabled: false });
  };
  async function syncClaim(family: "full_swing" | "putting" = "full_swing"): Promise<string> {
    const id = await createAnalysis(golfer, family, { upload: true });
    const c = await claimAnalysisExecution({ analysisId: id, userId: golfer.id, family });
    if (c.outcome !== "claimed") throw new Error(`claim ${c.outcome}`);
    return id;
  }
  const dispatchNow = (id: string) =>
    operator(`update public.swing_analysis set provider_dispatched_at = now(), processing_heartbeat_at = now() where id = ${lit(id, "uuid")};`);
  const cases: ReadonlyArray<{ name: string; mode: Mode; setup: () => Promise<string>; read: string; admit: string; createsJob: boolean }> = [
    { name: "fresh synchronous claim, not yet dispatched", mode: "queue", setup: () => syncClaim(), read: "processing", admit: "in_progress", createsJob: false },
    { name: "fresh synchronous claim, recently dispatched", mode: "queue",
      setup: async () => { const id = await syncClaim(); dispatchNow(id); return id; }, read: "processing", admit: "in_progress", createsJob: false },
    { name: "expired synchronous claim that never dispatched (taken over by the next press)", mode: "queue",
      setup: async () => { const id = await syncClaim(); ageClaim(id, 1000); return id; }, read: "idle", admit: "created", createsJob: true },
    { name: "expired synchronous claim that never dispatched, admissions paused", mode: "queue_paused",
      setup: async () => { const id = await syncClaim(); ageClaim(id, 1000); return id; }, read: "paused", admit: "admission_paused", createsJob: false },
    { name: "expired unresolved synchronous dispatch", mode: "queue",
      setup: async () => { const id = await syncClaim(); dispatchNow(id); ageClaim(id, 1000); return id; }, read: "interrupted", admit: "stalled", createsJob: false },
    { name: "paused full swing (pending, no job)", mode: "queue_paused",
      setup: () => createAnalysis(golfer, "full_swing", { upload: true }), read: "paused", admit: "admission_paused", createsJob: false },
    { name: "pending full swing, queue mode", mode: "queue",
      setup: () => createAnalysis(golfer, "full_swing", { upload: true }), read: "idle", admit: "created", createsJob: true },
    { name: "pending full swing, sync mode", mode: "sync",
      setup: () => createAnalysis(golfer, "full_swing", { upload: true }), read: "idle", admit: "sync_mode", createsJob: false },
    { name: "pending putting, full swing paused", mode: "queue_paused",
      setup: () => createAnalysis(golfer, "putting", { upload: true }), read: "idle", admit: "family_not_queued", createsJob: false },
    { name: "pending putting, full swing queued", mode: "queue",
      setup: () => createAnalysis(golfer, "putting", { upload: true }), read: "idle", admit: "family_not_queued", createsJob: false },
    { name: "pending putting, sync mode", mode: "sync",
      setup: () => createAnalysis(golfer, "putting", { upload: true }), read: "idle", admit: "family_not_queued", createsJob: false },
    // review: putting with an expired claim that never dispatched reads startable and keeps its own path
    { name: "putting with an expired undispatched claim, full swing paused", mode: "queue_paused",
      setup: async () => { const id = await syncClaim("putting"); ageClaim(id, 1000); return id; }, read: "idle", admit: "family_not_queued", createsJob: false },
    // review: the job-bearing pairs
    { name: "an open (queued) attempt", mode: "queue",
      setup: async () => { const id = await createAnalysis(golfer, "full_swing", { upload: true }); admitSql(golfer.id, id); return id; }, read: "queued", admit: "replayed", createsJob: false },
    { name: "a failed attempt", mode: "queue",
      setup: async () => { const id = await createAnalysis(golfer, "full_swing", { upload: true }); admitSql(golfer.id, id); failJob(acquire()!, "response_unusable"); return id; }, read: "failed", admit: "failed_observed", createsJob: false },
    { name: "a completed attempt", mode: "queue",
      setup: async () => {
        const id = await createAnalysis(golfer, "full_swing", { upload: true }); admitSql(golfer.id, id);
        const j = acquire()!; mark(j);
        callAs("analysis_worker", "complete_analysis_job", { p_job: j.jobId, p_claim: j.claimId, p_result: SYNTHETIC_STORED });
        return id;
      }, read: "complete", admit: "complete", createsJob: false },
  ];
  // What a press does for each read (the golfer-facing pairing every surface relies on).
  const AGREES: Readonly<Record<string, readonly string[]>> = {
    idle: ["created", "sync_mode", "family_not_queued"],
    paused: ["admission_paused"],
    processing: ["in_progress", "replayed"],
    interrupted: ["stalled"],
    queued: ["replayed"],
    failed: ["failed_observed"],
    complete: ["complete"],
  };

  for (const c of cases) {
    it(c.name, async () => {
      setMode(c.mode);
      const id = await c.setup();
      const rowBefore = analysisRow(id);
      const jobsBefore = jobsOf(id).length;
      const ledgerBefore = ledgerOfAnalysis(id).length;
      const read = readStateAs(golfer.id, id) as { execution: string; attempt: unknown };
      expect(read.execution, "read").toBe(c.read);
      expect(readStateAs(golfer.id, id), "a second read").toEqual(read);
      const admitted = admitSql(golfer.id, id);
      expect(disposition(admitted), "press").toBe(c.admit);
      expect(AGREES[c.read], `${c.read} / ${c.admit}`).toContain(c.admit);
      expect(jobsOf(id).length, "jobs").toBe(jobsBefore + (c.createsJob ? 1 : 0));
      expect(ledgerOfAnalysis(id).length, "reservations").toBe(ledgerBefore + (c.createsJob ? 1 : 0));
      expect(analysisRow(id), "admission never writes swing_analysis").toEqual(rowBefore);
      if (c.createsJob) expect((readStateAs(golfer.id, id) as { execution: string }).execution).toBe("queued");
      console.log(`A1_AGREEMENT ${c.name} | mode ${c.mode} | read ${read.execution} | press ${disposition(admitted)}`);
      drainQueue();
    });
  }

  it("an expired unresolved dispatch of a job (classified outcome unknown): read interrupted and the press stalled name the same attempt; a late result still settles, exactly once", async () => {
    setMode("queue");
    const id = await createAnalysis(golfer, "full_swing", { upload: true });
    const g1 = attemptId(admitSql(golfer.id, id))!;
    const job = acquire()!;
    expect(mark(job)).toMatchObject({ reason: "dispatched", jobId: g1 });
    // the holder stops heartbeating past the 900 s lease; the classifier marks the outcome unknown (its slot is kept)
    ageClaim(id, 2000);
    expect(Number(callAs("analysis_worker", "classify_stalled_jobs"))).toBe(1);
    expect(jobsOf(id)[0]).toMatchObject({ state: "outcome_unknown", outcome_unknown_source: "classifier" });
    const read = readStateAs(golfer.id, id);
    expect(read).toMatchObject({ execution: "interrupted", attempt: { id: g1, state: "interrupted" } });
    expect(admitSql(golfer.id, id)).toMatchObject({ disposition: "stalled", attempt: { id: g1, state: "interrupted" } });
    expect(admitSql(golfer.id, id, true, g1)).toMatchObject({ disposition: "stalled", attempt: { id: g1 } });
    expect(jobsOf(id)).toHaveLength(1);
    expect(ledgerOfAnalysis(id).map((l) => l.state)).toEqual(["held"]);
    // the late result
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: g1, p_claim: job.claimId, p_result: SYNTHETIC_STORED })).toBe("completed");
    const done = readStateAs(golfer.id, id);
    expect(done).toMatchObject({ execution: "complete", attempt: { id: g1, state: "complete" } });
    const ledgerOnce = ledgerOfAnalysis(id);
    expect(ledgerOnce.map((l) => [l.state, l.units])).toEqual([["charged", 1]]);
    // a repeated report of the same result settles nothing more
    expect(callAs("analysis_worker", "complete_analysis_job", { p_job: g1, p_claim: job.claimId, p_result: SYNTHETIC_STORED })).toBe("completed");
    expect(ledgerOfAnalysis(id)).toEqual(ledgerOnce);
    expect(readStateAs(golfer.id, id)).toEqual(done);
    expect(admitSql(golfer.id, id)).toMatchObject({ disposition: "complete", attempt: { id: g1, state: "complete" } });
    console.log(`A1_AGREEMENT unresolved job dispatch | read interrupted | press stalled | late result settled once (ledger ${ledgerOnce.map((l) => l.state).join(",")})`);
  });
});
