// ============================================================================
// ENT-1D R1b — the execution claim guard against the real local database
// ============================================================================
//
// Two phases on one disposable stack, selected by ENT1D_GUARD:
//   off  migrations through 20261026120100 (proof column inert): reproduces
//        both R1b variants with the exact old-app writes and the real claim
//        module.
//   on   after 20261027120000 is applied by the CLI runner: the same
//        sequences are prevented, every old-app write shape is checked, and
//        the database contract is exercised directly, with positive controls.
//
// New side: the actual lib/analysis-execution-claim.ts through supabase-js.
// Old side: ent1d-legacy-writes.ts (exact HEAD 168bd88 supabase-js shapes).
// Only `server-only` is replaced. No provider is involved.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import {
  ANALYSIS_LEASE_SECONDS,
  claimAnalysisExecution,
  heartbeatAnalysisClaim,
  markClaimOutcomeUnknown,
  markProviderDispatched,
  readExecutionState,
  releaseAnalysisClaimAsFailed,
  releaseUndispatchedClaimAsFailed,
} from "@/lib/analysis-execution-claim";
import { admin, asOperator, cleanupFixtures, createAnalysis, createGolfer, OPERATOR_OVERRIDE, operatorSql, row, type Family, type Golfer } from "./ent1d-fixtures";
import {
  mainFullSwingComplete,
  mainFullSwingFail,
  mainFullSwingProcessing,
  legacyFullSwingClaim,
  legacyFullSwingComplete,
  legacyFullSwingFail,
  legacyPuttingComplete,
  legacyPuttingFail,
  legacyPuttingProcessing,
  type LegacyResult,
} from "./ent1d-legacy-writes";
import { outboundViolations } from "./ent1d-app-setup";

const guardOn = process.env.ENT1D_GUARD === "on";
const later = () => new Date(Date.now() + (ANALYSIS_LEASE_SECONDS + 600) * 1000);

let golfer: Golfer;
beforeAll(async () => {
  golfer = await createGolfer("birdie");
});
afterAll(async () => {
  expect(await cleanupFixtures(), "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
});

const t = (id: string, family: Family) => ({ analysisId: id, userId: golfer.id, family });
const refusedWith = (r: LegacyResult, rule: string) => {
  expect(r.kind, JSON.stringify(r)).toBe("refused");
  if (r.kind === "refused") {
    expect(r.code).toBe("23514");
    expect(r.message).toContain(rule);
  }
};
const moved = (r: LegacyResult, rows: number) => expect(r, JSON.stringify(r)).toEqual({ kind: "rows", rows });

/** A barrier standing for a provider call that has started and not returned. */
function providerRunning() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { done, finish };
}

// ── Before the guard: both R1b variants reproduce ────────────────────────────

describe.skipIf(guardOn)("R1b BEFORE the guard (reproduction)", () => {
  it("undispatched variant: an old putting request overwrites a new holder; the new app later takes the row over while an old request runs", async () => {
    const id = await createAnalysis(golfer, "putting");
    const holder = await claimAnalysisExecution(t(id, "putting"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    moved(await legacyPuttingProcessing(id, golfer.id), 1); // old request A starts
    moved(await legacyPuttingFail(id, golfer.id), 1); // ...and fails, over the new holder
    const r = await row(id);
    expect(r).toMatchObject({ status: "failed", processing_claim_id: holder.claimId, provider_dispatched_at: null });
    const oldB = providerRunning();
    moved(await legacyPuttingProcessing(id, golfer.id), 1); // old request B claims and calls the provider
    const takeover = await claimAnalysisExecution(t(id, "putting"), later());
    console.log(`R1B_BEFORE undispatched: new_app_after_lease_while_old_request_runs=${takeover.outcome}`);
    expect(takeover.outcome, "hazard reproduced: the new app takes over while old request B runs").toBe("claimed");
    oldB.finish();
  });

  it("dispatched variant: an old putting failure lands on a dispatched new holder; the golfer's next request claims while the first provider call runs", async () => {
    const id = await createAnalysis(golfer, "putting");
    const holder = await claimAnalysisExecution(t(id, "putting"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    expect(await markProviderDispatched({ ...t(id, "putting"), claimId: holder.claimId })).toBe(true);
    const first = providerRunning(); // the new holder's provider call is in flight
    moved(await legacyPuttingFail(id, golfer.id), 1);
    expect(await row(id)).toMatchObject({ status: "failed", processing_claim_id: holder.claimId });
    const next = await claimAnalysisExecution(t(id, "putting"));
    console.log(`R1B_BEFORE dispatched: next_request_while_first_call_runs=${next.outcome}`);
    expect(next.outcome, "hazard reproduced: a second claim while the first provider call runs").toBe("claimed");
    first.finish();
  });
});

describe.skipIf(guardOn)("main-line route writes BEFORE the guard (reproduction)", () => {
  it("the main-line processing and completion writes overwrite a live ENT-1D claim and a completed result", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const holder = await claimAnalysisExecution(t(id, "full_swing"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    moved(await mainFullSwingProcessing(id, golfer.id), 1);
    moved(await mainFullSwingComplete(id, golfer.id), 1);
    expect(await row(id)).toMatchObject({ status: "complete", score: 66, processing_claim_id: holder.claimId });
    console.log("MAINLINE_BEFORE: processing and completion writes landed on a row held by an ENT-1D request");
  });
});

// ── With the guard ───────────────────────────────────────────────────────────

describe.skipIf(!guardOn)("R1b WITH the guard (prevented)", () => {
  it("undispatched variant: the old request's writes are refused and the new holder's claim is intact", async () => {
    const id = await createAnalysis(golfer, "putting");
    const holder = await claimAnalysisExecution(t(id, "putting"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    refusedWith(await legacyPuttingProcessing(id, golfer.id), "ENT1D-CLAIM-5");
    refusedWith(await legacyPuttingFail(id, golfer.id), "ENT1D-CLAIM-5");
    const r = await row(id);
    expect(r).toMatchObject({ status: "processing", processing_claim_id: holder.claimId, provider_dispatched_at: null });
    // The old route refuses to call the provider when its processing write
    // fails (HEAD :573-578), so no old request is running here.
    console.log("R1B_AFTER undispatched: old_processing_write=refused old_failure_write=refused new_claim_intact=true");
  });

  it("dispatched variant: the old failure is refused; the golfer's next request is answered in progress", async () => {
    const id = await createAnalysis(golfer, "putting");
    const holder = await claimAnalysisExecution(t(id, "putting"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    expect(await markProviderDispatched({ ...t(id, "putting"), claimId: holder.claimId })).toBe(true);
    const first = providerRunning();
    refusedWith(await legacyPuttingFail(id, golfer.id), "ENT1D-CLAIM-5");
    const next = await claimAnalysisExecution(t(id, "putting"));
    console.log(`R1B_AFTER dispatched: old_failure_write=refused next_request=${next.outcome}`);
    expect(next.outcome).toBe("not_claimed");
    expect(await readExecutionState(t(id, "putting"))).toBe("in_progress");
    first.finish();
  });
});

describe.skipIf(!guardOn).each(["full_swing", "putting"] as const)("old-app write shapes under the guard, family %s", (family) => {
  const legacyClaim = (id: string) => (family === "putting" ? legacyPuttingProcessing(id, golfer.id) : legacyFullSwingClaim(id, golfer.id));
  const legacyComplete = (id: string) => (family === "putting" ? legacyPuttingComplete(id, golfer.id) : legacyFullSwingComplete(id, golfer.id));
  const legacyFail = (id: string) => (family === "putting" ? legacyPuttingFail(id, golfer.id) : legacyFullSwingFail(id, golfer.id));

  it("a status-only claim of a pending or failed row is refused", async () => {
    const pending = await createAnalysis(golfer, family);
    refusedWith(await legacyClaim(pending), "ENT1D-CLAIM-11");
    const failed = await createAnalysis(golfer, family, { status: "failed" });
    refusedWith(await legacyClaim(failed), "ENT1D-CLAIM-11");
    expect((await row(pending)).status).toBe("pending");
    expect((await row(failed)).status).toBe("failed");
    // Positive control: the new application's claim of the same rows succeeds.
    expect((await claimAnalysisExecution(t(pending, family))).outcome).toBe("claimed");
    expect((await claimAnalysisExecution(t(failed, family))).outcome).toBe("claimed");
  });

  it("completion and failure on a row the new app holds are refused; the holder's own proved writes succeed", async () => {
    const id = await createAnalysis(golfer, family);
    const holder = await claimAnalysisExecution(t(id, family));
    if (holder.outcome !== "claimed") throw new Error("claim");
    refusedWith(await legacyComplete(id), "ENT1D-CLAIM-5");
    refusedWith(await legacyFail(id), "ENT1D-CLAIM-5");
    expect(await row(id)).toMatchObject({ status: "processing", processing_claim_id: holder.claimId, score: null });
    const held = { ...t(id, family), claimId: holder.claimId };
    expect(await heartbeatAnalysisClaim(held)).toBe(true);
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await releaseAnalysisClaimAsFailed(held)).toBe(true);
    expect(await row(id)).toMatchObject({ status: "failed", processing_claim_id: holder.claimId, processing_claim_proof: null });
  });

  it("an unknown provider outcome cannot be failed or completed by old code (nor released by the holder)", async () => {
    const id = await createAnalysis(golfer, family);
    const holder = await claimAnalysisExecution(t(id, family));
    if (holder.outcome !== "claimed") throw new Error("claim");
    const held = { ...t(id, family), claimId: holder.claimId };
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await markClaimOutcomeUnknown(held)).toBe(true);
    refusedWith(await legacyFail(id), "ENT1D-CLAIM-5");
    refusedWith(await legacyComplete(id), "ENT1D-CLAIM-5");
    const proved = await admin.from("swing_analysis").update({ status: "failed", processing_claim_proof: holder.claimId }).eq("id", id).select("id");
    expect(proved.error?.message).toContain("ENT1D-CLAIM-10");
    expect(await readExecutionState(t(id, family))).toBe("stalled");
  });

  it("a completed analysis keeps its status against old writes", async () => {
    const id = await createAnalysis(golfer, family);
    const holder = await claimAnalysisExecution(t(id, family));
    if (holder.outcome !== "claimed") throw new Error("claim");
    expect(await markProviderDispatched({ ...t(id, family), claimId: holder.claimId })).toBe(true);
    const done = await admin.from("swing_analysis").update({ status: "complete", processing_claim_proof: holder.claimId }).eq("id", id).select("id");
    expect(done.error).toBeNull();
    if (family === "putting") {
      // The old putting writes filter on neither status nor claim: refused.
      refusedWith(await legacyPuttingFail(id, golfer.id), "ENT1D-CLAIM-2");
      refusedWith(await legacyPuttingProcessing(id, golfer.id), "ENT1D-CLAIM-2");
    } else {
      // The old full-swing writes filter on status, so they match nothing here.
      moved(await legacyFullSwingFail(id, golfer.id), 0);
      moved(await legacyFullSwingClaim(id, golfer.id), 0);
    }
    expect((await row(id)).status).toBe("complete");
  });

  it("drain limit: a row claimed by old code BEFORE activation (no lease) may still be finished by that old request", async () => {
    const id = await createAnalysis(golfer, family);
    asOperator(`update public.swing_analysis set status = 'processing' where id = '${id}';`); // pre-activation status-only claim
    if (family === "putting") refusedWith(await legacyPuttingProcessing(id, golfer.id), "ENT1D-CLAIM-4");
    else moved(await legacyFullSwingClaim(id, golfer.id), 0); // its status filter excludes processing
    expect((await claimAnalysisExecution(t(id, family), later())).outcome).toBe("not_claimed");
    expect(await readExecutionState(t(id, family))).toBe("stalled");
    moved(await legacyComplete(id), 1);
    expect((await row(id)).status).toBe("complete");
  });
});

describe.skipIf(!guardOn)("database claim contract beyond the application's WHERE clauses", () => {
  it("a stale holder's write is refused by its proof even without a claim filter; the current holder's succeeds", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const dead = await claimAnalysisExecution(t(id, "full_swing"), new Date(Date.now() - (ANALYSIS_LEASE_SECONDS + 60) * 1000));
    if (dead.outcome !== "claimed") throw new Error("seed");
    const live = await claimAnalysisExecution(t(id, "full_swing"));
    if (live.outcome !== "claimed") throw new Error("takeover");
    expect(await markProviderDispatched({ ...t(id, "full_swing"), claimId: live.claimId })).toBe(true);
    const stale = await admin.from("swing_analysis").update({ status: "complete", score: 1, processing_claim_proof: dead.claimId }).eq("id", id).select("id");
    expect(stale.error?.message).toContain("ENT1D-CLAIM-5");
    const none = await admin.from("swing_analysis").update({ status: "complete", score: 1 }).eq("id", id).select("id");
    expect(none.error?.message).toContain("ENT1D-CLAIM-5");
    const ok = await admin.from("swing_analysis").update({ status: "complete", score: 2, processing_claim_proof: live.claimId }).eq("id", id).select("id");
    expect(ok.error).toBeNull();
    expect(await row(id)).toMatchObject({ status: "complete", score: 2, processing_claim_proof: null });
  });

  it("a dispatched claim is never taken over or cleared, even by a direct service-role write", async () => {
    const id = await createAnalysis(golfer, "putting");
    const holder = await claimAnalysisExecution(t(id, "putting"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    expect(await markProviderDispatched({ ...t(id, "putting"), claimId: holder.claimId })).toBe(true);
    const now = new Date().toISOString();
    const takeover = await admin.from("swing_analysis")
      .update({ processing_claim_id: crypto.randomUUID(), processing_started_at: now, processing_heartbeat_at: now, provider_dispatched_at: null })
      .eq("id", id).select("id");
    expect(takeover.error?.message).toContain("ENT1D-CLAIM-8");
    const clear = await admin.from("swing_analysis").update({ provider_dispatched_at: null, processing_claim_proof: holder.claimId }).eq("id", id).select("id");
    expect(clear.error?.message).toContain("ENT1D-CLAIM-6");
    // Positive control: the undispatched case is a permitted takeover.
    const other = await createAnalysis(golfer, "putting");
    const c = await claimAnalysisExecution(t(other, "putting"));
    if (c.outcome !== "claimed") throw new Error("claim");
    const permitted = await admin.from("swing_analysis")
      .update({ processing_claim_id: crypto.randomUUID(), processing_started_at: now, processing_heartbeat_at: now })
      .eq("id", other).select("id");
    expect(permitted.error).toBeNull();
  });

  it("rows are born unclaimed; completion comes only from processing; proofs are never stored", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const skip = await admin.from("swing_analysis").update({ status: "complete" }).eq("id", id).select("id");
    expect(skip.error?.message).toContain("ENT1D-CLAIM-3");
    const videoId = crypto.randomUUID();
    const key = `${golfer.id}/${videoId}/born.mp4`;
    const v = await admin.from("swing_videos").insert({ id: videoId, user_id: golfer.id, status: "uploaded", storage_path: key, video_url: key });
    expect(v.error).toBeNull();
    const born = await admin.from("swing_analysis").insert({ id: videoId, swing_video_id: videoId, user_id: golfer.id, status: "processing" });
    expect(born.error?.message).toContain("ENT1D-CLAIM-1");
    expect(operatorSql("select count(*) from public.swing_analysis where processing_claim_proof is not null;")).toBe("0");
  });

  it("the operator override works for an operator and is refused to every API role", async () => {
    const id = await createAnalysis(golfer, "putting");
    const holder = await claimAnalysisExecution(t(id, "putting"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    const held = { ...t(id, "putting"), claimId: holder.claimId };
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await markClaimOutcomeUnknown(held)).toBe(true);
    const refusal = (role: string): string => {
      try {
        operatorSql(`begin;\nset local role ${role};\n${OPERATOR_OVERRIDE}\nupdate public.swing_analysis set status = 'failed' where id = '${id}';\ncommit;`);
        return "ACCEPTED";
      } catch (error) {
        const e = error as { stderr?: unknown; message?: string };
        return String(e.stderr ?? e.message);
      }
    };
    // service_role holds UPDATE, so the guard itself is what refuses it: the
    // override is ignored for API roles, and an unproved write to a claimed row
    // is refused (ENT1D-CLAIM-5, checked before the outcome-unknown rule).
    expect(refusal("service_role")).toContain("ENT1D-CLAIM-5");
    // The browser roles hold no UPDATE at all; they are refused before the guard.
    for (const role of ["authenticated", "anon"]) expect(refusal(role)).toMatch(/permission denied/);
    // The owner role is refused too unless the value names ITS transaction: a
    // session-level setting, or one naming another transaction, never applies.
    const ownerRefusal = (sql: string): string => {
      try {
        operatorSql(sql);
        return "ACCEPTED";
      } catch (error) {
        const e = error as { stderr?: unknown; message?: string };
        return String(e.stderr ?? e.message);
      }
    };
    expect(ownerRefusal(`set swingproai.execution_guard = 'operator_override';\nupdate public.swing_analysis set status = 'failed' where id = '${id}';`)).toContain("ENT1D-CLAIM-5");
    expect(ownerRefusal(`select set_config('swingproai.execution_guard', 'operator_override:' || (txid_current() - 1), false);\nupdate public.swing_analysis set status = 'failed' where id = '${id}';`)).toContain("ENT1D-CLAIM-5");
    expect((await row(id)).status).toBe("processing");
    asOperator(`update public.swing_analysis set status = 'failed' where id = '${id}' and status = 'processing' and provider_dispatched_at is not null;`);
    expect((await row(id)).status).toBe("failed");
  });

  it("a proved holder cannot reopen a dispatched row or complete without a recorded dispatch", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const holder = await claimAnalysisExecution(t(id, "full_swing"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    const proof = holder.claimId;
    const early = await admin.from("swing_analysis").update({ status: "complete", processing_claim_proof: proof }).eq("id", id).select("id");
    expect(early.error?.message).toContain("ENT1D-CLAIM-14");
    expect(await markProviderDispatched({ ...t(id, "full_swing"), claimId: proof })).toBe(true);
    const reopen = await admin.from("swing_analysis").update({ status: "pending", processing_claim_proof: proof }).eq("id", id).select("id");
    expect(reopen.error?.message).toContain("ENT1D-CLAIM-13");
    const cleared = await admin.from("swing_analysis")
      .update({ status: "failed", processing_claim_id: null, processing_started_at: null, processing_heartbeat_at: null, provider_dispatched_at: null, processing_claim_proof: proof })
      .eq("id", id).select("id");
    expect(cleared.error?.message).toContain("ENT1D-CLAIM-6");
    // Positive control: the same holder completes once its dispatch is recorded.
    const done = await admin.from("swing_analysis").update({ status: "complete", processing_claim_proof: proof }).eq("id", id).select("id");
    expect(done.error).toBeNull();
  });

  it("a takeover must stay processing and undispatched; a claim needs an undispatched, complete lease", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const holder = await claimAnalysisExecution(t(id, "full_swing"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    const now = new Date().toISOString();
    for (const patch of [
      { status: "failed", processing_claim_id: crypto.randomUUID(), processing_started_at: now, processing_heartbeat_at: now },
      { processing_claim_id: crypto.randomUUID(), processing_started_at: now, processing_heartbeat_at: now, provider_dispatched_at: now },
    ]) {
      const r = await admin.from("swing_analysis").update(patch).eq("id", id).select("id");
      expect(r.error?.message, JSON.stringify(patch)).toContain("ENT1D-CLAIM-9");
    }
    const fresh = await createAnalysis(golfer, "full_swing");
    for (const patch of [
      { status: "processing", processing_claim_id: crypto.randomUUID(), processing_started_at: now, processing_heartbeat_at: now, provider_dispatched_at: now },
      { status: "processing", processing_claim_id: crypto.randomUUID(), processing_started_at: now, processing_heartbeat_at: null },
    ]) {
      const r = await admin.from("swing_analysis").update(patch).eq("id", fresh).select("id");
      expect(r.error?.message, JSON.stringify(patch)).toMatch(/ENT1D-CLAIM-11|swing_analysis_processing_claim_shape/);
    }
    // Outside processing, a lease is only kept or cleared.
    const failed = await createAnalysis(golfer, "full_swing", { status: "failed" });
    const invent = await admin.from("swing_analysis")
      .update({ processing_claim_id: crypto.randomUUID(), processing_started_at: now, processing_heartbeat_at: now })
      .eq("id", failed).select("id");
    expect(invent.error?.message).toContain("ENT1D-CLAIM-12");
  });

  it("a completed result is never rewritten, by any API-role write", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const holder = await claimAnalysisExecution(t(id, "full_swing"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    expect(await markProviderDispatched({ ...t(id, "full_swing"), claimId: holder.claimId })).toBe(true);
    expect((await admin.from("swing_analysis").update({ status: "complete", score: 81, processing_claim_proof: holder.claimId }).eq("id", id).select("id")).error).toBeNull();
    const overwrite = await admin.from("swing_analysis").update({ score: 1, feedback: "overwritten" }).eq("id", id).select("id");
    expect(overwrite.error?.message).toContain("ENT1D-CLAIM-2");
    // A direct foreign-key null-out is not a cascade either.
    const telemetry = crypto.randomUUID();
    asOperator(`insert into public.swing_telemetry (id, user_id) values ('${telemetry}', '${golfer.id}');
update public.swing_analysis set telemetry_id = '${telemetry}' where id = '${id}';`);
    const direct = await admin.from("swing_analysis").update({ telemetry_id: null }).eq("id", id).select("id");
    expect(direct.error?.message).toContain("ENT1D-CLAIM-2");
    expect((await admin.from("swing_telemetry").delete().eq("id", telemetry).select("id")).error).toBeNull(); // the cascade is admitted
    const proved = await admin.from("swing_analysis").update({ score: 1, processing_claim_proof: holder.claimId }).eq("id", id).select("id");
    expect(proved.error?.message).toContain("ENT1D-CLAIM-2");
    expect(await row(id)).toMatchObject({ status: "complete", score: 81 });
  });

  it("an ON DELETE SET NULL cascade is admitted even on a frozen, unknown-outcome row", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const telemetry = crypto.randomUUID();
    asOperator(`insert into public.swing_telemetry (id, user_id) values ('${telemetry}', '${golfer.id}');\nupdate public.swing_analysis set telemetry_id = '${telemetry}' where id = '${id}';`);
    const holder = await claimAnalysisExecution(t(id, "full_swing"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    const held = { ...t(id, "full_swing"), claimId: holder.claimId };
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await markClaimOutcomeUnknown(held)).toBe(true);
    // The same change written DIRECTLY is not a cascade: refused on this frozen
    // row, alone and together with any other column.
    const direct = await admin.from("swing_analysis").update({ telemetry_id: null }).eq("id", id).select("id");
    expect(direct.error?.message).toContain("ENT1D-CLAIM-5");
    const mixed = await admin.from("swing_analysis").update({ telemetry_id: null, status: "failed" }).eq("id", id).select("id");
    expect(mixed.error?.message).toContain("ENT1D-CLAIM-5");
    const del = await admin.from("swing_telemetry").delete().eq("id", telemetry).select("id");
    expect(del.error).toBeNull();
    expect(await row(id)).toMatchObject({ telemetry_id: null, status: "processing", processing_claim_id: holder.claimId });
    // A write that changes nothing gains nothing from the carve-out.
    refusedWith(await legacyPuttingProcessing(id, golfer.id), "ENT1D-CLAIM-5");
  });

  it("main-line route writes (likely the live build) are refused on claimed, pending and completed rows", async () => {
    const pending = await createAnalysis(golfer, "full_swing");
    refusedWith(await mainFullSwingProcessing(pending, golfer.id), "ENT1D-CLAIM-11");
    refusedWith(await mainFullSwingComplete(pending, golfer.id), "ENT1D-CLAIM-3");
    const held = await createAnalysis(golfer, "full_swing");
    const holder = await claimAnalysisExecution(t(held, "full_swing"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    refusedWith(await mainFullSwingProcessing(held, golfer.id), "ENT1D-CLAIM-5");
    refusedWith(await mainFullSwingComplete(held, golfer.id), "ENT1D-CLAIM-5");
    refusedWith(await mainFullSwingFail(held, golfer.id), "ENT1D-CLAIM-5");
    expect(await markProviderDispatched({ ...t(held, "full_swing"), claimId: holder.claimId })).toBe(true);
    expect((await admin.from("swing_analysis").update({ status: "complete", score: 90, processing_claim_proof: holder.claimId }).eq("id", held).select("id")).error).toBeNull();
    // The main-line route deliberately re-runs completed analyses: every one of
    // its writes to the completed row is refused, so the stored result stands.
    refusedWith(await mainFullSwingProcessing(held, golfer.id), "ENT1D-CLAIM-2");
    refusedWith(await mainFullSwingComplete(held, golfer.id), "ENT1D-CLAIM-2");
    refusedWith(await mainFullSwingFail(held, golfer.id), "ENT1D-CLAIM-2");
    expect(await row(held)).toMatchObject({ status: "complete", score: 90 });
    // LIMIT (source, main route.ts :840-844): a refused processing write is only
    // logged and the provider is called anyway. The guard protects the row,
    // not the spend; old instances must be retired before activation.
  });

  it("a release by the holder clears an undispatched lease; the guard refuses a cleared claim that stays processing", async () => {
    const id = await createAnalysis(golfer, "full_swing");
    const holder = await claimAnalysisExecution(t(id, "full_swing"));
    if (holder.outcome !== "claimed") throw new Error("claim");
    const keepProcessing = await admin.from("swing_analysis")
      .update({ processing_claim_id: null, processing_started_at: null, processing_heartbeat_at: null, processing_claim_proof: holder.claimId })
      .eq("id", id).select("id");
    expect(keepProcessing.error?.message).toContain("ENT1D-CLAIM-7");
    expect(await releaseUndispatchedClaimAsFailed({ ...t(id, "full_swing"), claimId: holder.claimId })).toBe(true);
    expect(await row(id)).toMatchObject({ status: "failed", processing_claim_id: null, provider_dispatched_at: null });
  });
});
