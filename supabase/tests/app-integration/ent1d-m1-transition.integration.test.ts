// ============================================================================
// ENT-1D — the NEW application's claim module on rows that crossed M1
// ============================================================================
//
// Runs only in the transition phase (ENT1D_PHASE=transition), after
// ent1d_m1_transition.sh has seeded rows before M1, applied M1, replayed the
// old application's writes in the M1-before-new-app window, and applied M2.
// The real lib/analysis-execution-claim.ts then decides each row; only
// `server-only` is replaced (see ent1d-claim-module.integration.test.ts).
//
// This shows how the new code treats each kind of pre-existing row. It does
// not prove the hosted deployment order.

import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import {
  ANALYSIS_LEASE_SECONDS,
  claimAnalysisExecution,
  readExecutionState,
} from "@/lib/analysis-execution-claim";
import { admin } from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";

const U = "0a000000-0000-4000-8000-0000000000f1";
const r = (n: number) => `0b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const later = () => new Date(Date.now() + (ANALYSIS_LEASE_SECONDS + 600) * 1000);
const t = (n: number, family: "full_swing" | "putting") => ({ analysisId: r(n), userId: U, family });

afterAll(() => {
  expect(outboundViolations).toEqual([]);
});

describe.skipIf(process.env.ENT1D_PHASE !== "transition")("new claim module on rows that crossed M1", () => {
  it("completed results stay complete and cannot be claimed (T3 full swing, T5 historical putt, T8 finished by the old app)", async () => {
    for (const [n, fam] of [[3, "full_swing"], [5, "putting"], [8, "full_swing"]] as const) {
      expect(await readExecutionState(t(n, fam)), `T${n}`).toBe("complete");
      expect((await claimAnalysisExecution(t(n, fam))).outcome, `T${n}`).toBe("not_claimed");
    }
  });

  it("legacy processing rows (T4, T6) were backfilled as dispatched: in progress, then stalled, never re-run", async () => {
    for (const [n, fam] of [[4, "full_swing"], [6, "putting"]] as const) {
      expect(await readExecutionState(t(n, fam)), `T${n} now`).toBe("in_progress");
      expect(await readExecutionState(t(n, fam), later()), `T${n} after the lease`).toBe("stalled");
      expect((await claimAnalysisExecution(t(n, fam), later())).outcome, `T${n}`).toBe("not_claimed");
    }
  });

  it("rows the OLD app claimed in the window (T1 full swing, T7 putt; no lease) are stalled at once and never re-run", async () => {
    for (const [n, fam] of [[1, "full_swing"], [7, "putting"]] as const) {
      expect(await readExecutionState(t(n, fam)), `T${n}`).toBe("stalled");
      expect((await claimAnalysisExecution(t(n, fam), later())).outcome, `T${n}`).toBe("not_claimed");
    }
  });

  it("a row the old app failed (T2) and a legacy null-family row (T9) are claimable by the new app", async () => {
    const t2 = await claimAnalysisExecution(t(2, "full_swing"));
    expect(t2).toMatchObject({ outcome: "claimed", recovered: false });
    const t9 = await claimAnalysisExecution(t(9, "full_swing"));
    expect(t9).toMatchObject({ outcome: "claimed", recovered: false });
    expect((await claimAnalysisExecution(t(9, "putting"))).outcome).toBe("not_claimed");
    const { data } = await admin.from("swing_analysis").select("id, analysis_family").eq("id", r(9)).single();
    expect(data?.analysis_family ?? null).toBeNull();
  });
});
