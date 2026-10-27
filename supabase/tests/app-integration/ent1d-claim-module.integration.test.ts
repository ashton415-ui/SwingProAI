// ============================================================================
// ENT-1D — lib/analysis-execution-claim.ts against the real local database
// ============================================================================
//
// The module's actual exports run through supabase-js (its own
// createAdminClient, the real query builder) against the run's disposable
// local Supabase stack. Nothing in the module or the client is mocked; the
// only replacement is `server-only`, a marker package that throws outside a
// Next.js server build (Vitest is not one). Clock-dependent behaviour uses the
// module's own `now` parameter, never a patched clock.

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
import { cleanupFixtures, createAnalysis, createGolfer, row, type Family, type Golfer } from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";

const LEASE_MS = ANALYSIS_LEASE_SECONDS * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

let golfer: Golfer;
let other: Golfer;

beforeAll(async () => {
  golfer = await createGolfer();
  other = await createGolfer();
});

afterAll(async () => {
  const errors = await cleanupFixtures();
  expect(errors, "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
});

const FAMILIES: Family[] = ["full_swing", "putting"];

describe.each(FAMILIES)("claim module, family %s", (family) => {
  const target = (analysisId: string, userId = golfer.id, fam: Family = family) => ({ analysisId, userId, family: fam });

  it("fresh claim from pending records a complete lease", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(target(id));
    expect(claim).toMatchObject({ outcome: "claimed", recovered: false });
    const r = await row(id);
    expect(r.status).toBe("processing");
    expect(r.processing_claim_id).toBe(claim.outcome === "claimed" ? claim.claimId : "");
    expect(r.processing_started_at).not.toBeNull();
    expect(r.processing_heartbeat_at).not.toBeNull();
    expect(r.provider_dispatched_at).toBeNull();
    expect(await readExecutionState(target(id))).toBe("in_progress");
  });

  it("a failed row can be retried with a new claim", async () => {
    const id = await createAnalysis(golfer, family);
    const first = await claimAnalysisExecution(target(id));
    if (first.outcome !== "claimed") throw new Error("first claim");
    expect(await markProviderDispatched({ ...target(id), claimId: first.claimId })).toBe(true);
    expect(await releaseAnalysisClaimAsFailed({ ...target(id), claimId: first.claimId })).toBe(true);
    expect((await row(id)).status).toBe("failed");
    expect(await readExecutionState(target(id))).toBe("not_startable");

    const retry = await claimAnalysisExecution(target(id));
    expect(retry).toMatchObject({ outcome: "claimed", recovered: false });
    const r = await row(id);
    expect(r.processing_claim_id).not.toBe(first.claimId);
    expect(r.provider_dispatched_at, "a retry starts undispatched").toBeNull();
    // The superseded first holder is fenced out of every write.
    expect(await heartbeatAnalysisClaim({ ...target(id), claimId: first.claimId })).toBe(false);
  });

  it("concurrent claims: exactly one of eight succeeds", async () => {
    const id = await createAnalysis(golfer, family);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => claimAnalysisExecution(target(id))));
    const won = outcomes.filter((o) => o.outcome === "claimed");
    expect(won).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "not_claimed")).toHaveLength(7);
    expect((await row(id)).processing_claim_id).toBe(won[0].outcome === "claimed" ? won[0].claimId : "");
  });

  it("concurrent takeovers of one expired undispatched claim: exactly one succeeds", async () => {
    const id = await createAnalysis(golfer, family);
    const dead = await claimAnalysisExecution(target(id), ago(LEASE_MS + 60_000));
    if (dead.outcome !== "claimed") throw new Error("seed claim");
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => claimAnalysisExecution(target(id))));
    const won = outcomes.filter((o) => o.outcome === "claimed");
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ recovered: true });
  });

  it("undispatched takeover; then every stale-holder write is fenced", async () => {
    const id = await createAnalysis(golfer, family);
    const dead = await claimAnalysisExecution(target(id), ago(LEASE_MS + 60_000));
    if (dead.outcome !== "claimed") throw new Error("seed claim");
    // Not yet: a live lease is not taken over.
    const early = await claimAnalysisExecution(target(id), ago(LEASE_MS + 60_000 - 1000));
    expect(early.outcome).toBe("not_claimed");

    const taker = await claimAnalysisExecution(target(id));
    expect(taker).toMatchObject({ outcome: "claimed", recovered: true });
    if (taker.outcome !== "claimed") return;
    const stale = { ...target(id), claimId: dead.claimId };
    expect(await markProviderDispatched(stale)).toBe(false);
    expect(await heartbeatAnalysisClaim(stale)).toBe(false);
    expect(await releaseAnalysisClaimAsFailed(stale)).toBe(false);
    expect(await releaseUndispatchedClaimAsFailed(stale)).toBe(false);
    expect(await markClaimOutcomeUnknown(stale)).toBe(false);
    const r = await row(id);
    expect(r).toMatchObject({ status: "processing", processing_claim_id: taker.claimId, provider_dispatched_at: null });
  });

  it("confirmed dispatch is never taken over, even long after the lease", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(target(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    const held = { ...target(id), claimId: claim.claimId };
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await markProviderDispatched(held), "dispatch is recorded once").toBe(false);
    expect(await releaseUndispatchedClaimAsFailed(held), "a dispatched claim is not released as undispatched").toBe(false);
    expect(await heartbeatAnalysisClaim(held)).toBe(true);

    const later = ahead(LEASE_MS * 4);
    expect((await claimAnalysisExecution(target(id), later)).outcome).toBe("not_claimed");
    expect(await readExecutionState(target(id), later)).toBe("stalled");
    expect(await readExecutionState(target(id))).toBe("in_progress");
    expect((await row(id)).processing_claim_id).toBe(claim.claimId);
  });

  it("unknown provider outcome is preserved: stalled, dispatched, never claimable", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(target(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    const held = { ...target(id), claimId: claim.claimId };
    expect(await markProviderDispatched(held)).toBe(true);
    expect(await markClaimOutcomeUnknown(held)).toBe(true);

    expect(await readExecutionState(target(id))).toBe("stalled");
    expect((await claimAnalysisExecution(target(id))).outcome).toBe("not_claimed");
    expect((await claimAnalysisExecution(target(id), ahead(LEASE_MS * 10))).outcome).toBe("not_claimed");
    const r = await row(id);
    expect(r.status).toBe("processing");
    expect(r.processing_claim_id).toBe(claim.claimId);
    expect(r.provider_dispatched_at).not.toBeNull();
    expect(new Date(String(r.processing_heartbeat_at)).getTime()).toBe(0);
  });

  it("claims are bound to owner and family", async () => {
    const id = await createAnalysis(golfer, family);
    const wrongFamily: Family = family === "putting" ? "full_swing" : "putting";
    expect((await claimAnalysisExecution(target(id, golfer.id, wrongFamily))).outcome).toBe("not_claimed");
    expect((await claimAnalysisExecution(target(id, other.id))).outcome).toBe("not_claimed");
    expect(await readExecutionState(target(id, golfer.id, wrongFamily))).toBe("not_found");
    expect(await readExecutionState(target(id, other.id))).toBe("not_found");
    expect((await row(id)).status).toBe("pending");
    expect((await row(id)).processing_claim_id).toBeNull();
  });

  it("a completed analysis is reported complete and cannot be claimed or failed", async () => {
    const id = await createAnalysis(golfer, family);
    const claim = await claimAnalysisExecution(target(id));
    if (claim.outcome !== "claimed") throw new Error("claim");
    // Completion is the route's write (same shape: fenced on the claim, with
    // the claim proof the database guard requires); the module is checked around it.
    const { admin } = await import("./ent1d-fixtures");
    expect(await markProviderDispatched({ ...target(id), claimId: claim.claimId })).toBe(true);
    const done = await admin
      .from("swing_analysis")
      .update({ status: "complete", processing_claim_proof: claim.claimId })
      .eq("id", id)
      .eq("processing_claim_id", claim.claimId)
      .select("id");
    expect(done.error).toBeNull();
    expect(done.data).toHaveLength(1);
    expect(await readExecutionState(target(id))).toBe("complete");
    expect((await claimAnalysisExecution(target(id))).outcome).toBe("not_claimed");
    expect(await releaseAnalysisClaimAsFailed({ ...target(id), claimId: claim.claimId })).toBe(false);
    expect((await row(id)).status).toBe("complete");
  });
});
