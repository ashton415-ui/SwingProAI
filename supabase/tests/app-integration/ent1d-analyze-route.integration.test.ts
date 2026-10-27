// ============================================================================
// ENT-1D — app/api/analyze-swing/route.ts against the real local database
// ============================================================================
//
// The actual route handler (POST) and the actual V1 result read
// (app/api/v1/analyses/[id] GET) run in-process against the run's disposable
// local stack: real GoTrue verification of real access tokens, real PostgREST
// with the real column grants and RLS, real Storage signing of an object in
// the golfer's own folder, real loopback download of that object, and every
// database write the route makes.
//
// Replaced boundaries, and nothing else:
//   - `@google/generative-ai`: GoogleGenerativeAI only. The real
//     GoogleGenerativeAIFetchError, SchemaType and the rest of the SDK are
//     kept, so the route's own error classifier sees the real class. Each
//     test sets a deterministic provider behaviour; no request leaves the
//     process (the setup adapter also blocks any non-loopback fetch).
//   - `next/headers`: request-scope adapter. cookies() carries the golfer's
//     real access token in the auth-cookie envelope the app reads, headers()
//     carries an optional Authorization header. Vitest has no Next.js request
//     scope; identity is still decided by local Auth, not by the adapter.
//   - `server-only`: marker package that throws outside a Next.js server.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  calls: 0,
  requests: [] as unknown[],
  behave: (async () => {
    throw new Error("provider behaviour not set");
  }) as (request: unknown) => Promise<unknown>,
}));
const request = vi.hoisted(() => ({ cookie: null as string | null, authorization: null as string | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      request.cookie !== null && name === "sb-127-auth-token" ? { name, value: request.cookie } : undefined,
    getAll: () => [],
  }),
  headers: () => new Headers(request.authorization ? { authorization: request.authorization } : {}),
}));
vi.mock("@google/generative-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/generative-ai")>();
  class GoogleGenerativeAI {
    getGenerativeModel() {
      return {
        generateContent: async (req: unknown) => {
          provider.calls += 1;
          provider.requests.push(req);
          return provider.behave(req);
        },
      };
    }
  }
  return { ...actual, GoogleGenerativeAI };
});

import { NextRequest } from "next/server";
import { GoogleGenerativeAIFetchError } from "@google/generative-ai";
import { POST } from "@/app/api/analyze-swing/route";
import { GET as getResultV1 } from "@/app/api/v1/analyses/[id]/route";
import { ANALYSIS_LEASE_SECONDS, claimAnalysisExecution } from "@/lib/analysis-execution-claim";
import {
  admin,
  asOperator,
  cleanupFixtures,
  createAnalysis,
  createGolfer,
  row,
  setTier,
  SYNTHETIC_VIDEO,
  type Golfer,
} from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";

// ── Deterministic provider answers ───────────────────────────────────────────

const FULL_SWING_REPORT = {
  scoring_breakdown: "75 + 5 (Shoulders) - 3 (Early extension) = 77",
  score: 77,
  executive_summary: "ENT1D synthetic summary citing the measured 42 degree spine angle.",
  fault_tags: ["early_extension", "restricted_backswing"],
  spine_angle: 42,
  hip_rotation: 45,
  shoulder_rotation: 88,
  tempo_ratio: "3.0:1",
  highlights: [{ title: "Stable address posture", description: "Spine angle held near 42 degrees." }],
  deficiencies: [{ title: "Early extension", description: "Hips move toward the ball before impact." }],
  drills: [{ name: "Wall Hip Drill", the_why: "Keeps depth.", the_how: "Hips on the wall.", the_feel: "Seat stays back." }],
  posture: { rating: "good", observation: "Balanced.", correction: "Keep it." },
  swing_plane: { rating: "needs_work", observation: "Slightly steep.", correction: "Shallow the shaft." },
  impact: { rating: "good", observation: "Hands lead.", correction: "Maintain." },
  practice_focus: "Hip depth through impact.",
  pro_cue: "Butt to the wall.",
};

const PUTTING_REPORT = {
  summary: "The stroke is compact and repeatable, with a settled lower body throughout.",
  setup_alignment: { assessment: "sound", observation: "The eyes sit over the ball at address." },
  stroke_path: { assessment: "arc", observation: "The path appears to arc gently inside." },
  face_at_impact: { assessment: "appears_square", observation: "Face at impact appears square to the path." },
  tempo_rhythm: { assessment: "smooth", observation: "The rhythm looks smooth and unhurried." },
  stroke_symmetry: { assessment: "balanced", observation: "Backswing and through-stroke look evenly matched." },
  stability: { assessment: "stable", observation: "The head stays quiet from address to finish." },
  primary_finding: "Alignment and stability are the strengths of this stroke.",
  practice_focus: "Work on maintaining a quieter lower body throughout the stroke.",
};

const answer = (body: unknown) => async () => ({ response: { text: () => JSON.stringify(body) } });

// ── Request helpers ──────────────────────────────────────────────────────────

function as(golfer: Golfer | null) {
  request.cookie = golfer ? encodeURIComponent(JSON.stringify({ access_token: golfer.accessToken })) : null;
  request.authorization = null;
}

async function analyze(golfer: Golfer | null, analysisId: string, extra: Record<string, unknown> = {}) {
  as(golfer);
  const res = await POST(
    new NextRequest("http://localhost/api/analyze-swing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ analysisId, ...extra }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function readResultV1(golfer: Golfer, analysisId: string) {
  request.cookie = null;
  request.authorization = `Bearer ${golfer.accessToken}`;
  const res = await getResultV1(new Request(`http://localhost/api/v1/analyses/${analysisId}`), { params: { id: analysisId } });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: unknown } };
}

const CLIENT_METRICS = { spineAngle: 42, hipRotation: 45, shoulderRotation: 88, tempoRatio: "3.0:1" };
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

// ── Suite ────────────────────────────────────────────────────────────────────

let owner: Golfer;
let stranger: Golfer;

beforeAll(async () => {
  owner = await createGolfer("none");
  stranger = await createGolfer("none");
});

beforeEach(() => {
  provider.calls = 0;
  provider.requests = [];
});

afterAll(async () => {
  const errors = await cleanupFixtures();
  expect(errors, "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
});

describe("analyze-swing route, full swing", () => {
  it("rejects an unauthenticated caller and a forged token without touching the row", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    expect((await analyze(null, id)).status).toBe(401);
    request.cookie = encodeURIComponent(JSON.stringify({ access_token: "not-a-real-token" }));
    const res = await POST(new NextRequest("http://localhost/api/analyze-swing", { method: "POST", body: JSON.stringify({ analysisId: id }) }));
    expect(res.status).toBe(401);
    expect((await row(id)).status).toBe("pending");
    expect(provider.calls).toBe(0);
  });

  it("refuses another golfer's analysis (ownership) without touching the row", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    provider.behave = answer(FULL_SWING_REPORT);
    expect((await analyze(stranger, id)).status).toBe(404);
    const r = await row(id);
    expect(r.status).toBe("pending");
    expect(r.processing_claim_id).toBeNull();
    expect(provider.calls).toBe(0);
  });

  it("success persists the complete payload; the V1 result path returns it; replay never re-calls the provider", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    provider.behave = answer(FULL_SWING_REPORT);
    const res = await analyze(owner, id, { mediapipeMetrics: CLIENT_METRICS });
    expect(res.status).toBe(200);
    expect(provider.calls).toBe(1);

    // The provider received the real stored video, signed by Storage on the
    // golfer's own session and fetched over loopback.
    const parts = (provider.requests[0] as { contents: { parts: { inlineData?: { data: string } }[] }[] }).contents[0].parts;
    expect(parts[0].inlineData?.data).toBe(base64(SYNTHETIC_VIDEO));

    const r = await row(id);
    expect(r.status).toBe("complete");
    expect(r.score).toBe(77);
    expect(r.feedback).toBe(FULL_SWING_REPORT.executive_summary);
    expect(r.spine_angle).toBe(42);
    expect(r.hip_rotation).toBe(45);
    expect(r.shoulder_rotation).toBe(88);
    expect(Number(r.tempo_ratio)).toBe(3);
    const metrics = r.metrics as Record<string, unknown>;
    expect(metrics.scoring_breakdown).toBe(FULL_SWING_REPORT.scoring_breakdown);
    expect(metrics.fault_tags).toEqual(FULL_SWING_REPORT.fault_tags);
    expect(metrics.drills).toEqual([{ name: "Wall Hip Drill", the_why: "Keeps depth.", the_how: "Hips on the wall.", the_feel: "Seat stays back." }]);
    expect(metrics.posture).toEqual(FULL_SWING_REPORT.posture);
    expect(metrics.swing_plane).toEqual(FULL_SWING_REPORT.swing_plane);
    expect(metrics.impact).toEqual(FULL_SWING_REPORT.impact);
    expect(metrics.practice_focus).toBe(FULL_SWING_REPORT.practice_focus);
    expect(metrics.pro_cue).toBe(FULL_SWING_REPORT.pro_cue);
    expect(r.swing_highlights).toEqual([{ checkpoint: "impact", positive_movement: "Stable address posture", mechanical_benefit: "Spine angle held near 42 degrees." }]);
    expect((r.mechanical_deficiencies as unknown[])[0]).toMatchObject({ fault_description: "Early extension" });
    expect(r.processing_claim_id).not.toBeNull();
    expect(r.provider_dispatched_at).not.toBeNull();

    // The route's response is the authorized view, never the raw row.
    const data = res.body.data as Record<string, unknown>;
    expect(data.score).toBe(77);
    for (const key of ["processing_claim_id", "provider_dispatched_at", "processing_heartbeat_at"]) {
      expect(data, key).not.toHaveProperty(key);
    }

    // The application's own result path for web and native clients.
    const v1 = await readResultV1(owner, id);
    expect(v1.status).toBe(200);
    expect(v1.body.data).toMatchObject({ analysisId: id, status: "complete", score: 77, feedback: FULL_SWING_REPORT.executive_summary });
    const coaching = v1.body.data?.coaching as Record<string, unknown>;
    expect(coaching.scoringBreakdown).toBe(FULL_SWING_REPORT.scoring_breakdown);
    expect(coaching.drills).toEqual([{ name: "Wall Hip Drill", why: "Keeps depth.", how: "Hips on the wall.", feel: "Seat stays back." }]);
    expect(JSON.stringify(v1.body)).not.toContain("processing_claim_id");
    expect((await readResultV1(stranger, id)).status).toBe(404);

    // Replay: answered from the stored row; the provider is not called again.
    const replay = await analyze(owner, id);
    expect(replay.status).toBe(200);
    expect(provider.calls).toBe(1);
    expect((replay.body.data as Record<string, unknown>).score).toBe(77);
    expect((await row(id)).processing_claim_id).toBe(r.processing_claim_id);
  });

  it("concurrent requests: one provider call, one completion, the other answered in progress", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    provider.behave = async () => {
      await gate;
      return answer(FULL_SWING_REPORT)();
    };
    const first = analyze(owner, id);
    // Wait until the first request has dispatched before the second arrives.
    for (let i = 0; i < 200 && provider.calls === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(provider.calls).toBe(1);
    const second = await analyze(owner, id);
    expect(second.status).toBe(409);
    expect(second.body.status).toBe("processing");
    release();
    expect((await first).status).toBe(200);
    expect(provider.calls).toBe(1);
    expect((await row(id)).status).toBe("complete");
  });

  it("definite provider rejection (401) releases as failed; a later request retries and completes", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    provider.behave = async () => {
      throw new GoogleGenerativeAIFetchError("synthetic", 401, "Unauthorized");
    };
    const res = await analyze(owner, id);
    expect(res.status).toBe(500);
    const failed = await row(id);
    expect(failed.status).toBe("failed");
    expect(failed.provider_dispatched_at).not.toBeNull();

    provider.behave = answer(FULL_SWING_REPORT);
    const retry = await analyze(owner, id);
    expect(retry.status).toBe(200);
    const done = await row(id);
    expect(done.status).toBe("complete");
    expect(done.processing_claim_id).not.toBe(failed.processing_claim_id);
    expect(provider.calls).toBe(2);
  });

  it("an unusable provider response (not JSON) is a definite failure", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    provider.behave = async () => ({ response: { text: () => "not json" } });
    expect((await analyze(owner, id)).status).toBe(500);
    expect((await row(id)).status).toBe("failed");
  });

  it.each([
    ["HTTP 503", () => new GoogleGenerativeAIFetchError("synthetic", 503, "Unavailable")],
    ["HTTP 429", () => new GoogleGenerativeAIFetchError("synthetic", 429, "Too Many Requests")],
    ["transport error", () => new TypeError("fetch failed")],
  ])("uncertain outcome (%s) stalls the analysis and is never re-run", async (_label, makeError) => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    provider.behave = async () => {
      throw makeError();
    };
    const res = await analyze(owner, id);
    expect(res.status).toBe(409);
    expect(res.body.status).toBe("stalled");
    const r = await row(id);
    expect(r.status).toBe("processing");
    expect(r.provider_dispatched_at).not.toBeNull();
    expect(new Date(String(r.processing_heartbeat_at)).getTime()).toBe(0);

    provider.behave = answer(FULL_SWING_REPORT);
    const again = await analyze(owner, id);
    expect(again.status).toBe(409);
    expect(again.body.status).toBe("stalled");
    expect(provider.calls).toBe(1);
    expect((await row(id)).processing_claim_id).toBe(r.processing_claim_id);
  });

  it("an expired undispatched claim is recovered by the next request", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    const old = new Date(Date.now() - (ANALYSIS_LEASE_SECONDS + 120) * 1000).toISOString();
    const deadClaim = crypto.randomUUID();
    await admin.from("swing_analysis").update({
      status: "processing", processing_claim_id: deadClaim, processing_started_at: old, processing_heartbeat_at: old,
    }).eq("id", id);
    provider.behave = answer(FULL_SWING_REPORT);
    expect((await analyze(owner, id)).status).toBe(200);
    const r = await row(id);
    expect(r.status).toBe("complete");
    expect(r.processing_claim_id).not.toBe(deadClaim);
  });

  it("stale completion: if the claim is superseded during the provider call, nothing is written", async () => {
    const id = await createAnalysis(owner, "full_swing", { upload: true });
    let newerClaim = "";
    provider.behave = async () => {
      // While the provider runs: an explicit operator release (the guard admits
      // it only under the operator override), then a new request's real claim.
      asOperator(`update public.swing_analysis set status = 'failed' where id = '${id}';`);
      const claim = await claimAnalysisExecution({ analysisId: id, userId: owner.id, family: "full_swing" });
      if (claim.outcome !== "claimed") throw new Error("newer claim");
      newerClaim = claim.claimId;
      return answer(FULL_SWING_REPORT)();
    };
    const res = await analyze(owner, id);
    expect(res.status).toBe(400);
    const r = await row(id);
    expect(r).toMatchObject({ status: "processing", processing_claim_id: newerClaim, score: null, feedback: null });
    expect(r.metrics).toBeNull();
  });
});

describe("analyze-swing route, putting", () => {
  it("entitlement: an unentitled golfer is refused before anything runs", async () => {
    const id = await createAnalysis(owner, "putting", { upload: true });
    provider.behave = answer(PUTTING_REPORT);
    expect((await analyze(owner, id)).status).toBe(403);
    expect((await row(id)).status).toBe("pending");
    expect(provider.calls).toBe(0);
  });

  it("success persists putting_analysis and putting_score; replay is a cache hit; V1 returns it", async () => {
    await setTier(owner.id, "birdie");
    try {
      const id = await createAnalysis(owner, "putting", { upload: true });
      provider.behave = answer(PUTTING_REPORT);
      const res = await analyze(owner, id);
      expect(res.status).toBe(200);
      expect(provider.calls).toBe(1);
      const r = await row(id);
      expect(r.status).toBe("complete");
      expect((r.putting_analysis as Record<string, unknown>).summary).toBe(PUTTING_REPORT.summary);
      expect(r.putting_score).not.toBeNull();
      expect(r.provider_dispatched_at).not.toBeNull();

      expect((await analyze(owner, id)).status).toBe(200);
      expect(provider.calls).toBe(1);

      const v1 = await readResultV1(owner, id);
      expect(v1.status).toBe(200);
      const putting = v1.body.data?.putting as Record<string, unknown>;
      expect(putting.access).toBe("available");
      expect((putting.analysis as Record<string, unknown>).summary).toBe(PUTTING_REPORT.summary);
      expect(putting.strokeIndex).not.toBeNull();
    } finally {
      await setTier(owner.id, "none");
    }
  });

  it("uncertain putting outcome stalls; definite rejection releases as failed", async () => {
    await setTier(owner.id, "eagle");
    try {
      const stalledId = await createAnalysis(owner, "putting", { upload: true });
      provider.behave = async () => {
        throw new GoogleGenerativeAIFetchError("synthetic", 500, "Internal");
      };
      const s = await analyze(owner, stalledId);
      expect(s.status).toBe(409);
      expect(s.body.status).toBe("stalled");
      expect((await row(stalledId)).putting_score).toBeNull();
      provider.behave = answer(PUTTING_REPORT);
      expect((await analyze(owner, stalledId)).status).toBe(409);
      expect(provider.calls).toBe(1);

      const failedId = await createAnalysis(owner, "putting", { upload: true });
      provider.behave = async () => {
        throw new GoogleGenerativeAIFetchError("synthetic", 403, "Forbidden");
      };
      expect((await analyze(owner, failedId)).status).toBe(500);
      expect((await row(failedId)).status).toBe("failed");
    } finally {
      await setTier(owner.id, "none");
    }
  });
});
