// ============================================================================
// ENT-1D — owner-bound video sources against the real local stack
// ============================================================================
//
// Runs with the source guard (20261027120100) applied (ENT1D_GUARD=on).
// Real local Auth, PostgREST (grants, RLS, the insert/update guard), Storage
// (owner-folder policies, signing, download) and the actual analyze-swing route.
//
// SSRF negatives use two controlled loopback sentinel listeners started by
// this file: a counter, and a redirector that points at the counter. Rows that
// name them predate the guard (inserted with triggers disabled, as a
// historical row would be). The sentinels must receive zero requests. No
// other URL, private service or external host is contacted; the setup adapter
// additionally blocks every non-loopback fetch.
//
// Replaced, as in the route suite: GoogleGenerativeAI (deterministic answer),
// next/headers (request scope), server-only.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ calls: 0, requests: [] as unknown[] }));
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
        generateContent: async (req: unknown) => {
          provider.calls += 1;
          provider.requests.push(req);
          return { response: { text: () => JSON.stringify(PROVIDER_ANSWER) } };
        },
      };
    }
  }
  return { ...actual, GoogleGenerativeAI };
});

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/analyze-swing/route";
import { POST as uploadV1 } from "@/app/api/v1/upload/route";
import { getSignedUploadUrl, recordPendingAnalysis } from "@/app/(dashboard)/analyze/upload-actions";
import { canonicalUploadFileName, classifyFailedAnalysisVideo, loadOwnedSwingVideo, signOwnedSwingVideoPlayback } from "@/lib/swing-video-source";
import { admin, cleanupFixtures, createAnalysis, createGolfer, operatorSql, row, SYNTHETIC_VIDEO, type Golfer } from "./ent1d-fixtures";
import { outboundViolations } from "./ent1d-app-setup";
import { KEY_VECTORS, OTHER, OWNER } from "./ent1d-video-key-vectors";

const PROVIDER_ANSWER = {
  scoring_breakdown: "75 = 75", score: 75, executive_summary: "ENT1D video-source summary.", fault_tags: ["x"],
  spine_angle: 40, hip_rotation: 40, shoulder_rotation: 90, tempo_ratio: "3.0:1",
  highlights: [{ title: "t", description: "d" }], deficiencies: [{ title: "t", description: "d" }],
  drills: [{ name: "n", the_why: "w", the_how: "h", the_feel: "f" }],
  posture: { rating: "good", observation: "o", correction: "c" },
  swing_plane: { rating: "good", observation: "o", correction: "c" },
  impact: { rating: "good", observation: "o", correction: "c" },
  practice_focus: "p", pro_cue: "c",
};

// ── Sentinels ────────────────────────────────────────────────────────────────

const hits = { counter: 0, redirector: 0 };
let counter: Server;
let redirector: Server;
let counterUrl = "";
let redirectUrl = "";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let golfer: Golfer;
let stranger: Golfer;

const sessionClient = (who: Golfer) =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${who.accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

const forOwner = (key: string) => key.split(OWNER).join(golfer.id).split(OTHER).join(stranger.id);

/** A swing_videos row that predates the source guard: inserted with triggers off. */
function historicalVideo(id: string, userId: string, storagePath: string, videoUrl: string): void {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  operatorSql(
    `begin;\nset local session_replication_role = replica;\n` +
      `insert into public.swing_videos (id, user_id, status, storage_path, video_url) values (${q(id)}, ${q(userId)}, 'uploaded', ${q(storagePath)}, ${q(videoUrl)});\n` +
      `commit;`,
  );
}

async function analysisFor(videoId: string, family: "full_swing" | "putting"): Promise<string> {
  const clubId = crypto.randomUUID();
  await admin.from("user_equipment").insert({
    id: clubId, user_id: golfer.id, club_type: family === "putting" ? "Putter" : "Driver", custom_club: true, custom_brand: "Synthetic", custom_model: "V1",
  });
  const r = await admin.from("swing_analysis").insert({ id: videoId, swing_video_id: videoId, user_id: golfer.id, club_id: clubId });
  if (r.error) throw new Error(`analysis insert: ${r.error.message}`);
  return videoId;
}

async function analyze(analysisId: string, body: Record<string, unknown> = {}) {
  request.cookie = encodeURIComponent(JSON.stringify({ access_token: golfer.accessToken }));
  const res = await POST(new NextRequest("http://localhost/api/analyze-swing", { method: "POST", body: JSON.stringify({ analysisId, ...body }) }));
  lastBody = (await res.json()) as Record<string, unknown>;
  return res.status;
}
let lastBody: Record<string, unknown> = {};

const VIDEO_UNUSABLE = {
  error: "We couldn't read a swing from this video, so it wasn't analysed and no score was saved. Please upload the swing again as an MP4, MOV or WebM video.",
  status: "video_unusable",
};

/** The database state a refused attempt must leave (ENT-1D D1): failed, unscored, lease cleared, never dispatched. */
async function expectRefusedUnscored(id: string): Promise<void> {
  expect(lastBody).toEqual(VIDEO_UNUSABLE);
  expect(await row(id)).toMatchObject({
    status: "failed",
    score: null,
    feedback: null,
    spine_angle: null,
    hip_rotation: null,
    shoulder_rotation: null,
    tempo_ratio: null,
    putting_score: null,
    processing_claim_id: null,
    processing_started_at: null,
    processing_heartbeat_at: null,
    provider_dispatched_at: null,
  });
  const payload = await admin.from("swing_analysis").select("metrics, putting_analysis").eq("id", id).single();
  expect(payload.data).toEqual({ metrics: null, putting_analysis: null });
}

const inlineVideoSent = () =>
  (provider.requests.at(-1) as { contents: { parts: { inlineData?: unknown }[] }[] } | undefined)?.contents[0].parts.some((p) => p.inlineData !== undefined) ?? false;

beforeAll(async () => {
  counter = createServer((_req, res) => {
    hits.counter += 1;
    res.writeHead(200, { "content-type": "video/mp4" }).end("SENTINEL");
  });
  counterUrl = await listen(counter);
  redirector = createServer((_req, res) => {
    hits.redirector += 1;
    res.writeHead(302, { location: `${counterUrl}/redirected.mp4` }).end();
  });
  redirectUrl = await listen(redirector);
  // Positive control: the sentinels do count. One direct request, and one
  // that follows the redirector to the counter; then the counts start at zero.
  await (await fetch(`${counterUrl}/control`)).text();
  await (await fetch(`${redirectUrl}/control`)).text();
  expect(hits, "sentinel positive control").toEqual({ counter: 2, redirector: 1 });
  hits.counter = 0;
  hits.redirector = 0;
  golfer = await createGolfer("birdie");
  stranger = await createGolfer("none");
});

beforeEach(() => {
  provider.calls = 0;
  provider.requests = [];
});

afterAll(async () => {
  await new Promise((r) => counter.close(r));
  await new Promise((r) => redirector.close(r));
  expect(await cleanupFixtures(), "fixture cleanup").toEqual([]);
  expect(outboundViolations, "no non-loopback request").toEqual([]);
  console.log(`SENTINEL_HITS counter=${hits.counter} redirector=${hits.redirector}`);
  expect(hits, "the loopback sentinels received nothing").toEqual({ counter: 0, redirector: 0 });
});

describe.skipIf(process.env.ENT1D_GUARD !== "on")("owner-bound video sources", () => {
  describe("insert guard: real browser and server insert shapes", () => {
    it("accepts every current upload shape through the golfer's own session", async () => {
      const client = sessionClient(golfer);
      const shapes = [
        `${golfer.id}/${crypto.randomUUID()}/my_swing.mp4`, // analyze page, v1 upload
        `${golfer.id}/${crypto.randomUUID().toUpperCase()}/source.mov`, // v1 finalize (upper-case id accepted)
        `${golfer.id}/${Date.now()}_legacy_clip.mov`, // legacy server action
      ];
      for (const key of shapes) {
        // The analyze page's exact insert: .insert({...}).select().single()
        const r = await client.from("swing_videos").insert({
          user_id: golfer.id, storage_path: key, video_url: key, original_filename: "x.mp4", file_size: 10,
          mime_type: "video/mp4", trim_start: 0, trim_end: 5, status: "uploaded",
        }).select().single();
        expect(r.error, key).toBeNull();
        expect((r.data as { storage_path: string }).storage_path).toBe(key);
      }
    });

    it("refuses every non-canonical key and any video_url that is not the key", async () => {
      const client = sessionClient(golfer);
      for (const vector of KEY_VECTORS.filter((v) => !v.ok)) {
        const key = forOwner(vector.key);
        const r = await client.from("swing_videos").insert({ user_id: golfer.id, storage_path: key, video_url: key, status: "uploaded" });
        expect(r.error, vector.why).not.toBeNull();
        if (!key.includes("\u0000")) {
          expect(r.error?.code, vector.why).toBe("23514");
          expect(r.error?.message, vector.why).toContain("ENT1D-VIDEO-1");
        }
      }
      const key = `${golfer.id}/${crypto.randomUUID()}/ok.mp4`;
      for (const videoUrl of [`${counterUrl}/x.mp4`, `https://example.invalid/${key}`, "", `${key} `]) {
        const r = await client.from("swing_videos").insert({ user_id: golfer.id, storage_path: key, video_url: videoUrl, status: "uploaded" });
        expect(r.error?.code, videoUrl).toBe("23514");
        expect(r.error?.message).toContain("ENT1D-VIDEO-2");
      }
    });

    it("a key in another golfer's folder is refused for both the owner and the folder's user", async () => {
      const client = sessionClient(golfer);
      const foreign = `${stranger.id}/${crypto.randomUUID()}/x.mp4`;
      const asOwnerRow = await client.from("swing_videos").insert({ user_id: golfer.id, storage_path: foreign, video_url: foreign, status: "uploaded" });
      expect(asOwnerRow.error?.message).toContain("ENT1D-VIDEO-1");
      const asOtherUser = await client.from("swing_videos").insert({ user_id: stranger.id, storage_path: foreign, video_url: foreign, status: "uploaded" });
      expect(asOtherUser.error?.code).toBe("42501"); // the row-level policy, unchanged
    });

    it("rows cannot later be changed into an unsafe source; unrelated updates of historical rows still work", async () => {
      const id = crypto.randomUUID();
      const key = `${golfer.id}/${id}/a.mp4`;
      expect((await admin.from("swing_videos").insert({ id, user_id: golfer.id, status: "uploaded", storage_path: key, video_url: key })).error).toBeNull();
      const browser = await sessionClient(golfer).from("swing_videos").update({ storage_path: `${golfer.id}/b.mp4` }).eq("id", id).select("id");
      expect(browser.error?.code).toBe("42501"); // the browser holds no UPDATE
      for (const patch of [
        { storage_path: `${stranger.id}/${id}/a.mp4`, video_url: `${stranger.id}/${id}/a.mp4` },
        { video_url: `${counterUrl}/x.mp4` },
        { user_id: stranger.id },
      ]) {
        const r = await admin.from("swing_videos").update(patch).eq("id", id).select("id");
        expect(r.error?.code, JSON.stringify(patch)).toBe("23514");
      }
      const histId = crypto.randomUUID();
      historicalVideo(histId, golfer.id, `${golfer.id}/legacy clip with spaces.mp4`, "https://legacy.invalid/public/clip.mp4");
      const unrelated = await admin.from("swing_videos").update({ title: "renamed" }).eq("id", histId).select("id");
      expect(unrelated.error).toBeNull();
      expect(operatorSql(`select storage_path || '|' || video_url from public.swing_videos where id = '${histId}';`))
        .toBe(`${golfer.id}/legacy clip with spaces.mp4|https://legacy.invalid/public/clip.mp4`); // nothing rewritten
    });

    it("SQL and TypeScript agree on every key vector", () => {
      const vectors = KEY_VECTORS.filter((v) => !v.key.includes("\u0000")); // PostgreSQL text cannot hold NUL
      const json = JSON.stringify(vectors.map((v) => ({ key: v.key })));
      const out = operatorSql(
        `select coalesce(string_agg(case when public.ent1d_is_canonical_swing_video_key(x.key, '${OWNER}') then '1' else '0' end, '' order by x.ord), '')` +
          ` from rows from (json_to_recordset($j$${json}$j$) as (key text)) with ordinality as x(key, ord);`,
      );
      expect(out).toBe(vectors.map((v) => (v.ok ? "1" : "0")).join(""));
    });
  });

  describe("real upload flows under the guard (actual server action and V1 route)", () => {
    const awkwardNames = ["x".repeat(300) + ".mp4", "..", "", "../../evil name.mov"];

    it("the legacy server action: signed upload, then its swing_videos insert is accepted for awkward names", async () => {
      request.cookie = encodeURIComponent(JSON.stringify({ access_token: golfer.accessToken }));
      for (const name of awkwardNames) {
        const signed = await getSignedUploadUrl(name, "video/mp4");
        expect(signed.error, name).toBeUndefined();
        const path = signed.path as string;
        expect(path.startsWith(`${golfer.id}/`)).toBe(true);
        expect(path.endsWith(`_${canonicalUploadFileName(name)}`)).toBe(true);
        const token = new URL(signed.signedUrl as string).searchParams.get("token") as string;
        const up = await sessionClient(golfer).storage.from("swing-videos").uploadToSignedUrl(path, token, SYNTHETIC_VIDEO, { contentType: "video/mp4" });
        expect(up.error, name).toBeNull();
        const recorded = await recordPendingAnalysis(path, name, SYNTHETIC_VIDEO.byteLength, "video/mp4");
        // Its swing_videos row is accepted; its swing_analysis insert was already
        // refused before ENT-1D (browser roles hold no INSERT there).
        const video = await admin.from("swing_videos").select("storage_path, video_url").eq("storage_path", path).single();
        expect(video.data, name).toEqual({ storage_path: path, video_url: path });
        expect(recorded.analysisId).toBeUndefined();
        await admin.storage.from("swing-videos").remove([path]);
      }
    });

    it("POST /api/v1/upload stores and records a canonical key for awkward names", async () => {
      request.cookie = encodeURIComponent(JSON.stringify({ access_token: golfer.accessToken }));
      for (const name of awkwardNames) {
        const form = new FormData();
        form.append("file", new File([SYNTHETIC_VIDEO], name, { type: "video/mp4" }));
        const res = await uploadV1(new NextRequest("http://localhost/api/v1/upload", { method: "POST", body: form }));
        const body = (await res.json()) as { data?: { storagePath: string; swingVideoId: string } };
        if (name === "") {
          // A multipart part with an empty filename arrives without a file type;
          // the route's existing MIME check refuses it before any upload.
          expect(res.status).toBe(422);
          const listed = await admin.storage.from("swing-videos").list(golfer.id);
          expect((listed.data ?? []).filter((o) => o.name === "video")).toEqual([]);
          continue;
        }
        expect(res.status, `${JSON.stringify(name.slice(0, 24))} -> ${JSON.stringify(body)}`).toBe(201);
        const key = body.data?.storagePath as string;
        expect(key).toBe(`${golfer.id}/${body.data?.swingVideoId}/${canonicalUploadFileName(name)}`);
        const video = await admin.from("swing_videos").select("video_url").eq("id", body.data?.swingVideoId).single();
        expect(video.data?.video_url).toBe(key);
        await admin.storage.from("swing-videos").remove([key]);
      }
    });
  });

  describe("analysis and playback read only the owner's canonical object", () => {
    it("a valid upload is signed, downloaded over the configured endpoint, and sent to the provider", async () => {
      const id = await createAnalysis(golfer, "full_swing", { upload: true });
      expect(await analyze(id)).toBe(200);
      expect(inlineVideoSent()).toBe(true);
      const parts = (provider.requests[0] as { contents: { parts: { inlineData?: { data: string } }[] }[] }).contents[0].parts;
      expect(parts[0].inlineData?.data).toBe(Buffer.from(SYNTHETIC_VIDEO).toString("base64"));
    });

    // ENT-1D D1. This case previously accepted a full swing "proceeding
    // without video" into a completed, scored analysis. That contradicts the
    // product constitution (no fabricated measurements), so both families now
    // refuse before the provider, whatever client metrics are sent.
    it("a deleted object: both families refuse before the provider; nothing is scored or fetched", async () => {
      const full = await createAnalysis(golfer, "full_swing", { upload: true });
      const putt = await createAnalysis(golfer, "putting", { upload: true });
      for (const id of [full, putt]) {
        const key = (await admin.from("swing_videos").select("storage_path").eq("id", id).single()).data?.storage_path as string;
        expect((await admin.storage.from("swing-videos").remove([key])).error).toBeNull();
      }
      const measured = { mediapipeMetrics: { spineAngle: 31.5, hipRotation: 40, shoulderRotation: 88, tempoRatio: "3.1:1" } };
      expect(await analyze(full, measured)).toBe(422);
      await expectRefusedUnscored(full);
      expect(await analyze(putt)).toBe(422);
      await expectRefusedUnscored(putt);
      expect(provider.calls).toBe(0);
    });

    it("an empty, tiny or non-video object in the owner's folder is refused before the provider", async () => {
      const bodies: [string, Uint8Array, string][] = [
        ["empty", new Uint8Array(0), "video/mp4"],
        ["tiny", SYNTHETIC_VIDEO.subarray(0, 512), "video/mp4"],
        ["text labelled as video", new TextEncoder().encode("not a video ".repeat(400)), "video/mp4"],
      ];
      for (const [label, bytes, contentType] of bodies) {
        for (const family of ["full_swing", "putting"] as const) {
          const id = await createAnalysis(golfer, family, { upload: true });
          const key = (await admin.from("swing_videos").select("storage_path").eq("id", id).single()).data?.storage_path as string;
          expect((await admin.storage.from("swing-videos").upload(key, bytes, { contentType, upsert: true })).error, label).toBeNull();
          expect(await analyze(id), `${family} ${label}`).toBe(422);
          await expectRefusedUnscored(id);
        }
      }
      expect(provider.calls).toBe(0);
    });

    it("a refused analysis is retryable: once the object is usable, exactly one provider call completes it", async () => {
      const id = await createAnalysis(golfer, "full_swing", { upload: true });
      const key = (await admin.from("swing_videos").select("storage_path").eq("id", id).single()).data?.storage_path as string;
      expect((await admin.storage.from("swing-videos").upload(key, new Uint8Array(0), { contentType: "video/mp4", upsert: true })).error).toBeNull();
      expect(await analyze(id)).toBe(422);
      expect(provider.calls).toBe(0);
      expect((await admin.storage.from("swing-videos").upload(key, SYNTHETIC_VIDEO, { contentType: "video/mp4", upsert: true })).error).toBeNull();
      expect(await analyze(id)).toBe(200);
      expect(provider.calls).toBe(1);
      expect(inlineVideoSent()).toBe(true);
      expect(await row(id)).toMatchObject({ status: "complete", score: 75 });
    });

    it("a revisited failed analysis is classified from real Storage: unusable objects say so, a usable one keeps its Retry", async () => {
      const cases: [string, Uint8Array | null, "video_unusable" | null][] = [
        ["usable video", SYNTHETIC_VIDEO, null],
        ["deleted object", null, "video_unusable"],
        ["empty object", new Uint8Array(0), "video_unusable"],
        ["tiny object", SYNTHETIC_VIDEO.subarray(0, 512), "video_unusable"],
        ["text labelled as video", new TextEncoder().encode("not a video ".repeat(400)), "video_unusable"],
      ];
      for (const [label, bytes, expected] of cases) {
        const id = await createAnalysis(golfer, "full_swing", { upload: true });
        const key = (await admin.from("swing_videos").select("storage_path").eq("id", id).single()).data?.storage_path as string;
        if (bytes === null) expect((await admin.storage.from("swing-videos").remove([key])).error).toBeNull();
        else expect((await admin.storage.from("swing-videos").upload(key, bytes, { contentType: "video/mp4", upsert: true })).error).toBeNull();
        // Signed on the golfer's own session, exactly as the report pages do.
        expect(await classifyFailedAnalysisVideo(sessionClient(golfer), key, golfer.id), label).toBe(expected);
        // And the route agrees on the same object.
        expect(await analyze(id), label).toBe(expected === null ? 200 : 422);
      }
      // Another golfer's object is never classified as theirs to use.
      const foreign = await createAnalysis(golfer, "full_swing", { upload: true });
      const foreignKey = (await admin.from("swing_videos").select("storage_path").eq("id", foreign).single()).data?.storage_path as string;
      expect(await classifyFailedAnalysisVideo(sessionClient(stranger), foreignKey, stranger.id)).toBe("video_unusable");
      expect(provider.calls).toBe(1);
    });

    it("a completed analysis whose object was later deleted is still served, unchanged, without a provider call", async () => {
      const id = await createAnalysis(golfer, "full_swing", { upload: true });
      expect(await analyze(id)).toBe(200);
      expect(provider.calls).toBe(1);
      const key = (await admin.from("swing_videos").select("storage_path").eq("id", id).single()).data?.storage_path as string;
      expect((await admin.storage.from("swing-videos").remove([key])).error).toBeNull();
      expect(await analyze(id)).toBe(200);
      expect(provider.calls).toBe(1);
      expect(await row(id)).toMatchObject({ status: "complete", score: 75 });
    });

    it("historical rows naming a sentinel URL or another golfer's object are never fetched, signed or played", async () => {
      // A foreign object that really exists, in the stranger's folder.
      const foreignKey = `${stranger.id}/${crypto.randomUUID()}/theirs.mp4`;
      expect((await admin.storage.from("swing-videos").upload(foreignKey, SYNTHETIC_VIDEO, { contentType: "video/mp4" })).error).toBeNull();
      const cases = [
        { path: `${golfer.id}/${crypto.randomUUID()}/gone.mp4`, url: `${counterUrl}/direct.mp4` }, // canonical, object missing
        { path: foreignKey, url: `${redirectUrl}/redirect.mp4` }, // another golfer's object
        { path: `${counterUrl}/as-path.mp4`, url: `${counterUrl}/as-url.mp4` }, // URL-shaped key
      ];
      for (const c of cases) {
        for (const family of ["full_swing", "putting"] as const) {
          const id = crypto.randomUUID();
          historicalVideo(id, golfer.id, c.path, c.url);
          await analysisFor(id, family);
          expect(await analyze(id)).toBe(422);
          await expectRefusedUnscored(id);
        }
        expect(await signOwnedSwingVideoPlayback(sessionClient(golfer), c.path, golfer.id)).toBeNull();
      }
      expect(provider.calls).toBe(0);
      expect((await admin.storage.from("swing-videos").remove([foreignKey])).error).toBeNull();
    });

    it("owner playback signing returns the configured Storage URL, which serves the owner's bytes", async () => {
      const id = await createAnalysis(golfer, "full_swing", { upload: true });
      const key = (await admin.from("swing_videos").select("storage_path").eq("id", id).single()).data?.storage_path as string;
      const url = await signOwnedSwingVideoPlayback(sessionClient(golfer), key, golfer.id);
      expect(url?.startsWith(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/sign/swing-videos/${key}?token=`)).toBe(true);
      const res = await fetch(url as string, { redirect: "error" });
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(SYNTHETIC_VIDEO);
      // The stranger cannot sign the golfer's key: refused before Storage, and
      // Storage's own folder policy would refuse it too.
      expect(await signOwnedSwingVideoPlayback(sessionClient(stranger), key, stranger.id)).toBeNull();
      const direct = await sessionClient(stranger).storage.from("swing-videos").createSignedUrl(key, 60);
      expect(direct.data).toBeNull();
      const load = await loadOwnedSwingVideo(sessionClient(stranger), key, stranger.id, 1024 * 1024);
      expect(load.status).toBe("invalid_path");
    });
  });

  it("the canonical-key function is not callable by anon through the API", async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/ent1d_is_canonical_swing_video_key`, {
      method: "POST",
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_key: `${golfer.id}/x.mp4`, p_owner: golfer.id }),
    });
    const body = (await res.json()) as { code?: string };
    expect(res.status).toBe(401);
    expect(body.code).toBe("42501");
  });

  // Runs last in file order: every request above that could have reached a
  // sentinel has completed (the afterAll hook checks again after cleanup).
  it("the loopback sentinels received no request from any path above", () => {
    expect(hits).toEqual({ counter: 0, redirector: 0 });
  });
});
