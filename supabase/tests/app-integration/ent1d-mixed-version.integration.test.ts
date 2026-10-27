// ============================================================================
// ENT-1D R1 — mixed old/new application versions against the real local DB
// ============================================================================
//
// R1: the new application releases an UNDISPATCHED claim as failed; an OLD
// application instance (still serving during a deploy overlap or after a
// rollback) then claims the row with a status-only write and starts its own
// provider call; the new application must not take that row over.
//
// New side: the actual lib/analysis-execution-claim.ts exports and the actual
// route, through supabase-js. Old side: the previous route's exact supabase-js
// write shapes (git HEAD 168bd88, app/api/analyze-swing/route.ts), issued with
// the same service-role writer the old route used. An old worker "still
// executing" is a barrier: its claim has been written and its completion has
// not. Only `server-only`, `next/headers` and the GoogleGenerativeAI class are
// replaced (see ent1d-analyze-route.integration.test.ts); no provider call
// leaves the process.
//
// Phase: this suite describes the window BEFORE the execution claim guard
// (20261027120000) exists, and runs only when ENT1D_GUARD=off. With the guard
// active, the old writes it exercises are refused outright; that behaviour is
// ent1d-claim-guard.integration.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ calls: 0 }));
const request = vi.hoisted(() => ({ cookie: null as string | null }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (request.cookie !== null && name === "sb-127-auth-token" ? { name, value: request.cookie } : undefined),
    getAll: () => [],
  }),
  headers: () => new Headers(),
}));
vi.mock("@google/generative-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/generative-ai")>();
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          provider.calls += 1;
          throw new Error("ENT1D: the provider must not be called in the mixed-version suite");
        },
      };
    }
  }
  return { ...actual, GoogleGenerativeAI };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/analyze-swing/route";
import {
  ANALYSIS_LEASE_SECONDS,
  claimAnalysisExecution,
  markClaimOutcomeUnknown,
  markProviderDispatched,
  readExecutionState,
  releaseAnalysisClaimAsFailed,
  releaseUndispatchedClaimAsFailed,
} from "@/lib/analysis-execution-claim";
import { admin, cleanupFixtures, createAnalysis, createGolfer, row, setTier, type Family, type Golfer } from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";

const later = () => new Date(Date.now() + (ANALYSIS_LEASE_SECONDS + 600) * 1000);
const LEASE_COLUMNS = ["processing_claim_id", "processing_started_at", "processing_heartbeat_at", "provider_dispatched_at"] as const;

// ── The OLD application's writes (HEAD 168bd88 app/api/analyze-swing/route.ts) ──

/** Full-swing claim, HEAD :898-905. Status only; the lease columns are untouched. */
async function oldFullSwingClaim(id: string, userId: string): Promise<number> {
  const { data, error } = await admin
    .from("swing_analysis")
    .update({ status: "processing" })
    .eq("id", id)
    .eq("user_id", userId)
    .or("analysis_family.is.null,analysis_family.eq.full_swing")
    .in("status", ["pending", "failed"])
    .select("id");
  if (error) throw new Error(`old claim: ${error.message}`);
  return data.length;
}

/** Putting "processing" write, HEAD :562-566. No status filter at all. */
async function oldPuttingProcessing(id: string, userId: string): Promise<number> {
  const { data, error } = await admin.from("swing_analysis").update({ status: "processing" }).eq("id", id).eq("user_id", userId).select("id");
  if (error) throw new Error(`old putting processing: ${error.message}`);
  return data.length;
}

const oldClaim = (family: Family, id: string, userId: string) =>
  family === "putting" ? oldPuttingProcessing(id, userId) : oldFullSwingClaim(id, userId);

/** Full-swing completion, HEAD :1222-1227. */
async function oldFullSwingComplete(id: string, userId: string): Promise<number> {
  const { data, error } = await admin
    .from("swing_analysis")
    .update({ status: "complete", score: 70, feedback: "old app result", metrics: { drills: [] }, swing_highlights: [], mechanical_deficiencies: [] })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("status", "processing")
    .select();
  if (error) throw new Error(`old completion: ${error.message}`);
  return data.length;
}

/** Full-swing failure, HEAD :508-513. */
async function oldFullSwingFail(id: string, userId: string): Promise<number> {
  const { data, error } = await admin.from("swing_analysis").update({ status: "failed" }).eq("id", id).eq("status", "processing").eq("user_id", userId).select("id");
  if (error) throw new Error(`old failure: ${error.message}`);
  return data.length;
}

const PUTT_SCORE = { basis: "qualitative_classification_index", coverage: { percent: 100, scorable_sections: 6, total_sections: 6 }, score: 80, score_version: 1, source_classification_version: 1 };

/** Putting completion, HEAD :679-690. No status filter. */
async function oldPuttingComplete(id: string, userId: string): Promise<number> {
  const { data, error } = await admin
    .from("swing_analysis")
    .update({ status: "complete", putting_analysis: { note: "old app putt" }, putting_score: PUTT_SCORE })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("analysis_family", "putting")
    .is("putting_score", null)
    .select();
  if (error) throw new Error(`old putting completion: ${error.message}`);
  return data.length;
}

/** Putting failure, HEAD :540-545. No status and no claim filter. */
async function oldPuttingFail(id: string, userId: string): Promise<number> {
  const { data, error } = await admin.from("swing_analysis").update({ status: "failed" }).eq("id", id).eq("user_id", userId).select("id");
  if (error) throw new Error(`old putting failure: ${error.message}`);
  return data.length;
}

const oldComplete = (family: Family, id: string, userId: string) =>
  family === "putting" ? oldPuttingComplete(id, userId) : oldFullSwingComplete(id, userId);

/** A barrier standing for an old worker that has claimed and has not finished. */
function oldWorker() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { done, finish };
}

// ── Suite ────────────────────────────────────────────────────────────────────

let golfer: Golfer;

beforeAll(async () => {
  golfer = await createGolfer("birdie");
});
beforeEach(() => {
  provider.calls = 0;
});
afterAll(async () => {
  expect(await cleanupFixtures(), "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
});

const guardOff = process.env.ENT1D_GUARD === "off";

describe.skipIf(!guardOff).each(["full_swing", "putting"] as const)("R1 mixed versions, family %s", (family) => {
  const t = (id: string) => ({ analysisId: id, userId: golfer.id, family });

  it("R1 behaviour: while an old worker executes, the new app never claims the row (outcome only)", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(t(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    expect(await releaseUndispatchedClaimAsFailed({ ...t(id), claimId: claim.claimId })).toBe(true);
    const old = oldWorker();
    expect(await oldClaim(family, id, golfer.id)).toBe(1);
    const takeover = await claimAnalysisExecution(t(id), later());
    console.log(`R1_REPRO family=${family} new_claim_after_lease_while_old_worker_runs=${takeover.outcome}${takeover.outcome === "claimed" ? ` recovered=${takeover.recovered}` : ""}`);
    old.finish();
    expect(takeover.outcome).toBe("not_claimed");
  });

  it.each([
    ["releaseUndispatchedClaimAsFailed", releaseUndispatchedClaimAsFailed],
    ["releaseAnalysisClaimAsFailed (before dispatch)", releaseAnalysisClaimAsFailed],
  ] as const)("new undispatched release (%s) -> old status-only claim -> new app refuses to run", async (_label, release) => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(t(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    expect(await release({ ...t(id), claimId: claim.claimId })).toBe(true);

    const released = await row(id);
    expect(released.status).toBe("failed");
    for (const col of LEASE_COLUMNS) expect(released[col], `${col} cleared on an undispatched release`).toBeNull();

    // The old worker claims and starts executing.
    const old = oldWorker();
    expect(await oldClaim(family, id, golfer.id)).toBe(1);

    // Now, and after any lease would have expired, the new app neither claims nor takes over.
    for (const when of [new Date(), later()]) {
      expect((await claimAnalysisExecution(t(id), when)).outcome).toBe("not_claimed");
      expect(await readExecutionState(t(id), when)).toBe("stalled");
    }
    const during = await row(id);
    expect(during.status).toBe("processing");
    for (const col of LEASE_COLUMNS) expect(during[col]).toBeNull();

    // The old worker finishes with its own completion shape.
    old.finish();
    await old.done;
    expect(await oldComplete(family, id, golfer.id)).toBe(1);
    expect(await readExecutionState(t(id))).toBe("complete");
  });

  // No uploaded object: the route's pre-dispatch failure path. Since ENT-1D D1
  // both families refuse a missing video before the provider, so this runs for
  // both (full swing previously proceeded without video and was skipped here).
  it("route: a pre-dispatch failure then an old claim; the new route refuses after the lease (no provider call)", async () => {
    const id = await createAnalysis(golfer, family, { upload: false });
    request.cookie = encodeURIComponent(JSON.stringify({ access_token: golfer.accessToken }));
    const first = await POST(new NextRequest("http://localhost/api/analyze-swing", { method: "POST", body: JSON.stringify({ analysisId: id }) }));
    expect(first.status).toBe(422);
    const failed = await row(id);
    expect(failed.status).toBe("failed");
    expect(failed.provider_dispatched_at).toBeNull();
    for (const col of LEASE_COLUMNS) expect(failed[col], `${col} after the route's pre-dispatch failure`).toBeNull();

    const old = oldWorker();
    expect(await oldClaim(family, id, golfer.id)).toBe(1);
    // Simulate the lease having expired, for whatever lease the row carries.
    const past = new Date(Date.now() - (ANALYSIS_LEASE_SECONDS + 600) * 1000).toISOString();
    await admin.from("swing_analysis").update({ processing_started_at: past, processing_heartbeat_at: past }).eq("id", id).not("processing_claim_id", "is", null);

    const second = await POST(new NextRequest("http://localhost/api/analyze-swing", { method: "POST", body: JSON.stringify({ analysisId: id }) }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { status?: string }).status).toBe("stalled");
    expect(provider.calls).toBe(0);
    old.finish();
  });

  it("a persisted-but-unacknowledged dispatch cannot be cleared or released", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(t(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    const held = { ...t(id), claimId: claim.claimId };
    // The dispatch write lands; the caller never sees the acknowledgement.
    await markProviderDispatched(held);
    expect(await releaseUndispatchedClaimAsFailed(held)).toBe(false);
    const r = await row(id);
    expect(r.status).toBe("processing");
    expect(r.processing_claim_id).toBe(claim.claimId);
    expect(r.provider_dispatched_at).not.toBeNull();
    expect(await oldClaim(family, id, golfer.id)).toBe(family === "putting" ? 1 : 0);
    expect((await claimAnalysisExecution(t(id), later())).outcome).toBe("not_claimed");
    expect(await readExecutionState(t(id), later())).toBe("stalled");
  });

  it("a dispatched definite failure keeps its lease; an old claim cannot make it re-runnable by the new app", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(t(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    const held = { ...t(id), claimId: claim.claimId };
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await releaseAnalysisClaimAsFailed(held)).toBe(true);
    const r = await row(id);
    expect(r).toMatchObject({ status: "failed", processing_claim_id: claim.claimId });
    expect(r.provider_dispatched_at).not.toBeNull();

    expect(await oldClaim(family, id, golfer.id)).toBe(1);
    expect((await claimAnalysisExecution(t(id), later())).outcome).toBe("not_claimed");
    expect(await readExecutionState(t(id), later())).toBe("stalled");
    // Old completion still lands on it (CHECK accepts the retained lease).
    expect(await oldComplete(family, id, golfer.id)).toBe(1);
  });

  it("an unknown outcome stays protected from both release paths and from the old claim", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(t(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    const held = { ...t(id), claimId: claim.claimId };
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await markClaimOutcomeUnknown(held)).toBe(true);
    expect(await releaseUndispatchedClaimAsFailed(held)).toBe(false);
    expect(await releaseAnalysisClaimAsFailed(held), "the dispatched release refuses an unknown outcome").toBe(false);
    if (family === "full_swing") expect(await oldFullSwingClaim(id, golfer.id)).toBe(0);
    const r = await row(id);
    expect(r.status).toBe("processing");
    expect(r.provider_dispatched_at).not.toBeNull();
    expect(new Date(String(r.processing_heartbeat_at)).getTime()).toBe(0);
    expect(await readExecutionState(t(id))).toBe("stalled");
  });

  it("a release by a superseded holder cannot erase the newer claim", async () => {
    const id = await createAnalysis(golfer, family);
    const dead = await claimAnalysisExecution(t(id), new Date(Date.now() - (ANALYSIS_LEASE_SECONDS + 60) * 1000));
    if (dead.outcome !== "claimed") throw new Error("seed");
    const taker = await claimAnalysisExecution(t(id));
    if (taker.outcome !== "claimed") throw new Error("takeover");
    const stale = { ...t(id), claimId: dead.claimId };
    expect(await releaseUndispatchedClaimAsFailed(stale)).toBe(false);
    expect(await releaseAnalysisClaimAsFailed(stale)).toBe(false);
    const r = await row(id);
    expect(r).toMatchObject({ status: "processing", processing_claim_id: taker.claimId });
    expect(r.processing_started_at).not.toBeNull();
  });

  it("normal new-app retries still work after both release kinds", async () => {
    const id = await createAnalysis(golfer, family);
    const a = await claimAnalysisExecution(t(id));
    if (a.outcome !== "claimed") throw new Error("a");
    expect(await releaseUndispatchedClaimAsFailed({ ...t(id), claimId: a.claimId })).toBe(true);
    const b = await claimAnalysisExecution(t(id));
    expect(b).toMatchObject({ outcome: "claimed", recovered: false });
    if (b.outcome !== "claimed") return;
    expect(await markProviderDispatched({ ...t(id), claimId: b.claimId })).toBe(true);
    expect(await releaseAnalysisClaimAsFailed({ ...t(id), claimId: b.claimId })).toBe(true);
    const c = await claimAnalysisExecution(t(id));
    expect(c).toMatchObject({ outcome: "claimed", recovered: false });
    const r = await row(id);
    expect(r.provider_dispatched_at).toBeNull();
    expect(r.processing_claim_id).toBe(c.outcome === "claimed" ? c.claimId : "");
  });

  it("old-app failure and completion shapes remain accepted on new-app rows", async () => {
    // A row the old app claimed (no lease) and then failed or completed.
    const failId = await createAnalysis(golfer, family);
    expect(await oldClaim(family, failId, golfer.id)).toBe(1);
    expect(family === "putting" ? await oldPuttingFail(failId, golfer.id) : await oldFullSwingFail(failId, golfer.id)).toBe(1);
    const failed = await row(failId);
    expect(failed.status).toBe("failed");
    for (const col of LEASE_COLUMNS) expect(failed[col]).toBeNull();
    expect((await claimAnalysisExecution(t(failId))).outcome, "new app retries an old failure").toBe("claimed");

    const doneId = await createAnalysis(golfer, family);
    expect(await oldClaim(family, doneId, golfer.id)).toBe(1);
    expect(await oldComplete(family, doneId, golfer.id)).toBe(1);
    expect(await readExecutionState(t(doneId))).toBe("complete");
  });
});

describe.skipIf(!guardOff)("R1b (disclosed residual before the guard): the OLD putting failure write has no status or claim filter", () => {
  it("an old putting failure on a row the NEW app holds leaves that holder's undispatched lease on a failed row", async () => {
    await setTier(golfer.id, "birdie");
    const id = await createAnalysis(golfer, "putting");
    const t = { analysisId: id, userId: golfer.id, family: "putting" as const };
    const claim = await claimAnalysisExecution(t);
    if (claim.outcome !== "claimed") throw new Error("claim");
    // An overlapping OLD putting request writes processing (no filter) and then
    // fails (no filter), while the new holder has not dispatched.
    expect(await oldPuttingProcessing(id, golfer.id)).toBe(1);
    expect(await oldPuttingFail(id, golfer.id)).toBe(1);
    // The new holder is fenced out (status is no longer processing).
    expect(await markProviderDispatched({ ...t, claimId: claim.claimId })).toBe(false);
    expect(await releaseUndispatchedClaimAsFailed({ ...t, claimId: claim.claimId })).toBe(false);
    const r = await row(id);
    // Recorded, not asserted as safe: the residual the app-level fix cannot reach.
    console.log(`R1B_OBSERVED status=${String(r.status)} lease_kept=${r.processing_claim_id !== null} dispatched=${r.provider_dispatched_at !== null}`);
    expect(await oldPuttingProcessing(id, golfer.id)).toBe(1);
    const takeover = await claimAnalysisExecution(t, later());
    console.log(`R1B_OBSERVED new_takeover_after_lease=${takeover.outcome}`);
    expect(["claimed", "not_claimed"]).toContain(takeover.outcome);
  });
});
