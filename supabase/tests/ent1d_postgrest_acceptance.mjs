// ============================================================================
// ENT-1D — local Auth + PostgREST acceptance (DISPOSABLE LOCAL STACK ONLY)
// ============================================================================
//
// Usage: node ent1d_postgrest_acceptance.mjs <status.json> <expected-api-url>
//
// <status.json> is `supabase status -o json` of the run's own local stack.
// Only loopback URLs are accepted. No token, key or password is printed.
// A denial counts only when PostgREST reports PostgreSQL code 42501; HTTP
// status is recorded separately. Response bodies are checked for the
// sentinel stored in restricted columns.

import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

const [statusPath, expectedApi] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(statusPath, "utf8"));
const API = creds.API_URL;
if (API !== expectedApi || !/^http:\/\/127\.0\.0\.1:\d+$/.test(API)) {
  console.log(`TARGET_MISMATCH: refusing to run against ${API}`);
  process.exit(2);
}
const REST = `${API}/rest/v1`;
const ANON = creds.ANON_KEY;
const SERVICE = creds.SERVICE_ROLE_KEY;
const SENTINEL = "ENT1D-RESTRICTED-SENTINEL";

let failures = 0;
const results = [];
const info = [];
const record = (name, ok, detail) => {
  if (!ok) failures += 1;
  results.push(`${ok ? "PASS" : "FAIL"} | ${name} | ${detail}`);
};

async function call(method, path, { token, apikey = ANON, body, prefer, accept, anonymous } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token ?? apikey}`, "Content-Type": "application/json" };
  if (anonymous) headers.Authorization = `Bearer ${ANON}`;
  if (prefer) headers.Prefer = prefer;
  if (accept) headers.Accept = accept;
  const res = await fetch(`${REST}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const denied = (name, r) =>
  record(name, r.json?.code === "42501" && !r.text.includes(SENTINEL), `HTTP ${r.status} code ${r.json?.code ?? "-"}`);

async function signUp(email) {
  const password = randomBytes(18).toString("base64url");
  const res = await fetch(`${API}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (res.status !== 200 || !json.access_token || !json.user?.id) throw new Error(`signup failed: HTTP ${res.status}`);
  return { id: json.user.id, token: json.access_token };
}

const created = { users: [], videos: [], analyses: [], clubs: [] };

try {
  // ── Synthetic users via local Auth ────────────────────────────────────────
  const tag = randomBytes(4).toString("hex");
  const A = await signUp(`ent1d-a-${tag}@example.test`);
  const B = await signUp(`ent1d-b-${tag}@example.test`);
  created.users.push(A.id, B.id);
  record("auth: two distinct synthetic users with access tokens", A.id !== B.id && A.token !== B.token, "HTTP 200 x2 (tokens not printed)");

  // ── Upload metadata: owner-bound insert through PostgREST ─────────────────
  // Same column set and request shape as app/(dashboard)/analyze/page.tsx:
  // .insert({...}).select().single() -> POST ?select=* with return=representation
  // and the single-object Accept header.
  const uploadPath = `${A.id}/${randomUUID()}.mp4`;
  let r = await call("POST", "/swing_videos?select=*", {
    token: A.token,
    prefer: "return=representation",
    accept: "application/vnd.pgrst.object+json",
    body: {
      user_id: A.id, storage_path: uploadPath, video_url: uploadPath, original_filename: "ent1d-clip.mp4",
      file_size: 1024, mime_type: "video/mp4", trim_start: 0, trim_end: 5, status: "uploaded",
    },
  });
  const videoA = r.json?.id;
  if (videoA) created.videos.push(videoA);
  record("owner upload insert (page.tsx shape, .select().single()) returns the row",
    r.status === 201 && typeof videoA === "string" && r.json.user_id === A.id && r.json.storage_path === uploadPath,
    `HTTP ${r.status}`);
  if (!videoA) throw new Error("upload insert returned no row");

  r = await call("POST", "/swing_videos", {
    token: A.token,
    prefer: "return=minimal",
    body: { id: randomUUID(), user_id: B.id, status: "uploaded", storage_path: `${B.id}/x.mp4`, video_url: `${B.id}/x.mp4` },
  });
  denied("owner cannot insert a video for another user (RLS)", r);

  // ENT-1D source guard (20261027120100): a storage_path naming another
  // user's folder is refused, as is a video_url that is not the key.
  const foreignPath = randomUUID();
  r = await call("POST", "/swing_videos", {
    token: A.token, prefer: "return=minimal",
    body: { id: foreignPath, user_id: A.id, status: "uploaded", storage_path: `${B.id}/foreign.mp4`, video_url: `${B.id}/foreign.mp4` },
  });
  if (r.status === 201) created.videos.push(foreignPath);
  record("insert with storage_path in another user's folder is refused (source guard)", r.json?.code === "23514" && String(r.json?.message).includes("ENT1D-VIDEO-1"), `HTTP ${r.status} code ${r.json?.code ?? "-"}`);
  r = await call("POST", "/swing_videos", {
    token: A.token, prefer: "return=minimal",
    body: { id: randomUUID(), user_id: A.id, status: "uploaded", storage_path: `${A.id}/u.mp4`, video_url: "http://127.0.0.1:9/u.mp4" },
  });
  record("insert with a video_url other than the key is refused (source guard)", r.json?.code === "23514" && String(r.json?.message).includes("ENT1D-VIDEO-2"), `HTTP ${r.status} code ${r.json?.code ?? "-"}`);

  // ── Server-side fixtures (service role): club, analysis with payload ──────
  const clubA = randomUUID();
  r = await call("POST", "/user_equipment", {
    apikey: SERVICE, prefer: "return=minimal",
    body: { id: clubA, user_id: A.id, club_type: "Driver", custom_club: true, custom_brand: "Synthetic", custom_model: "D1" },
  });
  record("service creates synthetic club", r.status === 201, `HTTP ${r.status}`);
  created.clubs.push(clubA);

  r = await call("POST", "/swing_analysis", {
    apikey: SERVICE, prefer: "return=minimal",
    body: { id: videoA, swing_video_id: videoA, user_id: A.id, club_id: clubA },
  });
  record("service inserts pending analysis", r.status === 201, `HTTP ${r.status}`);
  created.analyses.push(videoA);

  r = await call("PATCH", `/swing_analysis?id=eq.${videoA}`, {
    apikey: SERVICE, prefer: "return=minimal",
    body: {
      score: 72, feedback: "core summary",
      metrics: { drills: [{ name: SENTINEL }] },
      swing_highlights: [{ positive_movement: SENTINEL }],
      launch_monitor_summary: { note: SENTINEL },
      mechanical_deficiencies: [{ issue: SENTINEL }],
      putting_analysis: { note: SENTINEL },
    },
  });
  record("service writes result payload", r.status === 204, `HTTP ${r.status}`);

  // ── Owner reads ───────────────────────────────────────────────────────────
  r = await call("GET", `/swing_analysis?select=id,score,feedback,status,analysis_family,equipment_snapshot`, { token: A.token });
  record("owner reads core columns", r.status === 200 && r.json?.length === 1 && r.json[0].score === 72 && r.json[0].equipment_snapshot && !r.text.includes(SENTINEL), `HTTP ${r.status} rows ${r.json?.length}`);

  r = await call("GET", `/swing_videos?select=id,status,analyses:swing_analysis(equipment_snapshot)`, { token: A.token });
  record("owner approved embed swing_videos -> swing_analysis(equipment_snapshot)", r.status === 200 && r.json?.[0]?.analyses?.length === 1 && !r.text.includes(SENTINEL), `HTTP ${r.status}`);

  denied("owner select=* on swing_analysis", await call("GET", `/swing_analysis?select=*`, { token: A.token }));
  denied("owner select=metrics", await call("GET", `/swing_analysis?select=metrics`, { token: A.token }));
  denied("owner select=swing_highlights", await call("GET", `/swing_analysis?select=swing_highlights`, { token: A.token }));
  denied("owner select=launch_monitor_summary", await call("GET", `/swing_analysis?select=launch_monitor_summary`, { token: A.token }));
  denied("owner select=mechanical_deficiencies", await call("GET", `/swing_analysis?select=mechanical_deficiencies`, { token: A.token }));
  denied("owner select=putting_analysis", await call("GET", `/swing_analysis?select=putting_analysis`, { token: A.token }));
  denied("owner select=provider_dispatched_at (lease)", await call("GET", `/swing_analysis?select=provider_dispatched_at`, { token: A.token }));
  denied("owner select=processing_claim_id (lease)", await call("GET", `/swing_analysis?select=processing_claim_id`, { token: A.token }));
  denied("owner filter on restricted column (metrics=not.is.null)", await call("GET", `/swing_analysis?select=id&metrics=not.is.null`, { token: A.token }));
  denied("owner order by lease column", await call("GET", `/swing_analysis?select=id&order=provider_dispatched_at`, { token: A.token }));
  denied("owner embed swing_analysis(*)", await call("GET", `/swing_videos?select=id,swing_analysis(*)`, { token: A.token }));
  denied("owner embed swing_analysis(metrics)", await call("GET", `/swing_videos?select=id,swing_analysis(metrics)`, { token: A.token }));
  denied("owner PATCH swing_analysis", await call("PATCH", `/swing_analysis?id=eq.${videoA}`, { token: A.token, body: { score: 99 } }));
  denied("owner POST swing_analysis", await call("POST", `/swing_analysis`, { token: A.token, body: { id: randomUUID(), swing_video_id: videoA, user_id: A.id } }));
  denied("owner DELETE swing_analysis", await call("DELETE", `/swing_analysis?id=eq.${videoA}`, { token: A.token }));
  denied("owner PATCH swing_videos", await call("PATCH", `/swing_videos?id=eq.${videoA}`, { token: A.token, body: { status: "pending" } }));
  denied("owner DELETE swing_videos", await call("DELETE", `/swing_videos?id=eq.${videoA}`, { token: A.token }));

  // ── Cross-user ────────────────────────────────────────────────────────────
  r = await call("GET", `/swing_analysis?select=id,score`, { token: B.token });
  record("other user sees no analyses", r.status === 200 && r.json?.length === 0, `HTTP ${r.status} rows ${r.json?.length}`);
  r = await call("GET", `/swing_videos?select=id`, { token: B.token });
  record("other user sees no videos", r.status === 200 && r.json?.length === 0, `HTTP ${r.status} rows ${r.json?.length}`);
  denied("other user PATCH A's swing_videos", await call("PATCH", `/swing_videos?id=eq.${videoA}`, { token: B.token, body: { status: "pending" } }));
  denied("other user DELETE A's swing_videos", await call("DELETE", `/swing_videos?id=eq.${videoA}`, { token: B.token }));
  denied("other user PATCH A's swing_analysis", await call("PATCH", `/swing_analysis?id=eq.${videoA}`, { token: B.token, body: { score: 1 } }));

  // ── Anonymous ─────────────────────────────────────────────────────────────
  denied("anon select swing_analysis", await call("GET", `/swing_analysis?select=id`));
  denied("anon select swing_videos", await call("GET", `/swing_videos?select=id`));
  denied("anon POST swing_videos", await call("POST", `/swing_videos`, { anonymous: true, body: { user_id: A.id, status: "uploaded", storage_path: `${A.id}/anon.mp4`, video_url: `${A.id}/anon.mp4` } }));
  denied("anon PATCH swing_videos", await call("PATCH", `/swing_videos?id=eq.${videoA}`, { anonymous: true, body: { status: "pending" } }));
  denied("anon DELETE swing_videos", await call("DELETE", `/swing_videos?id=eq.${videoA}`, { anonymous: true }));
  denied("anon POST swing_analysis", await call("POST", `/swing_analysis`, { anonymous: true, body: { swing_video_id: videoA, user_id: A.id } }));

  // ── Service role: the application's claim, dispatch and guarded writes ───
  const famFilter = "or=(analysis_family.is.null,analysis_family.eq.full_swing)";
  const claim = randomUUID();
  const now = new Date().toISOString();
  const claimPatch = { status: "processing", processing_claim_id: claim, processing_started_at: now, processing_heartbeat_at: now, provider_dispatched_at: null };
  const rows = (x) => (Array.isArray(x.json) ? x.json.length : -1);

  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoA}&user_id=eq.${A.id}&${famFilter}&status=in.(pending,failed)`, { apikey: SERVICE, prefer: "return=representation", body: claimPatch });
  record("service fresh claim takes the row", r.status === 200 && rows(r) === 1, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoA}&user_id=eq.${A.id}&${famFilter}&status=in.(pending,failed)`, { apikey: SERVICE, prefer: "return=representation", body: { ...claimPatch, processing_claim_id: randomUUID() } });
  record("service second fresh claim: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);

  const dispatchPath = `/swing_analysis?select=id&id=eq.${videoA}&user_id=eq.${A.id}&status=eq.processing&processing_claim_id=eq.${claim}&provider_dispatched_at=is.null`;
  r = await call("PATCH", dispatchPath, { apikey: SERVICE, prefer: "return=representation", body: { provider_dispatched_at: now, processing_heartbeat_at: now, processing_claim_proof: claim } });
  record("service dispatch by holder", r.status === 200 && rows(r) === 1, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("PATCH", dispatchPath, { apikey: SERVICE, prefer: "return=representation", body: { provider_dispatched_at: now, processing_claim_proof: claim } });
  record("service second dispatch: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);

  const stale = randomUUID();
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoA}&user_id=eq.${A.id}&status=eq.processing&processing_claim_id=eq.${stale}`, { apikey: SERVICE, prefer: "return=representation", body: { status: "complete", score: 1 } });
  record("service stale-claim completion: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoA}&user_id=eq.${A.id}&status=eq.processing&processing_claim_id=eq.${claim}`, { apikey: SERVICE, prefer: "return=representation", body: { status: "complete", score: 80, processing_claim_proof: claim } });
  record("service holder completion", r.status === 200 && rows(r) === 1, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoA}&user_id=eq.${A.id}&status=eq.processing&processing_claim_id=eq.${claim}`, { apikey: SERVICE, prefer: "return=representation", body: { status: "failed", processing_claim_proof: claim } });
  record("service failure write after success: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);

  r = await call("GET", `/swing_analysis?select=status,score,metrics&id=eq.${videoA}`, { apikey: SERVICE });
  record("service reads payload; final state complete/80", r.status === 200 && r.json?.[0]?.status === "complete" && r.json?.[0]?.score === 80 && r.text.includes(SENTINEL), `HTTP ${r.status}`);

  // Execution read as the claim module does it: the lease columns, maybeSingle.
  const execCols = "id,user_id,status,processing_claim_id,processing_heartbeat_at,provider_dispatched_at";
  r = await call("GET", `/swing_analysis?select=${execCols}&id=eq.${videoA}&user_id=eq.${A.id}&${famFilter}`, { apikey: SERVICE, accept: "application/vnd.pgrst.object+json" });
  record("service execution read (maybeSingle shape) returns the lease", r.status === 200 && r.json?.processing_claim_id === claim && r.json?.provider_dispatched_at !== null, `HTTP ${r.status}`);

  // Takeover through PostgREST with the application's clock cutoff.
  const videoT = randomUUID();
  r = await call("POST", "/swing_videos", { token: A.token, prefer: "return=minimal", body: { id: videoT, user_id: A.id, status: "uploaded", storage_path: `${A.id}/t.mp4`, video_url: `${A.id}/t.mp4` } });
  if (r.status === 201) created.videos.push(videoT);
  r = await call("POST", "/swing_analysis", { apikey: SERVICE, prefer: "return=minimal", body: { id: videoT, swing_video_id: videoT, user_id: A.id, club_id: clubA } });
  if (r.status === 201) created.analyses.push(videoT);
  const old = new Date(Date.now() - 1200 * 1000).toISOString();
  const deadClaim = randomUUID();
  r = await call("PATCH", `/swing_analysis?id=eq.${videoT}`, { apikey: SERVICE, prefer: "return=minimal", body: { status: "processing", processing_claim_id: deadClaim, processing_started_at: old, processing_heartbeat_at: old, provider_dispatched_at: null } });
  record("service seeds an expired undispatched lease", r.status === 204, `HTTP ${r.status}`);
  const takeoverPath = () => {
    const cutoff = new Date(Date.now() - 900 * 1000).toISOString();
    return `/swing_analysis?select=id&id=eq.${videoT}&user_id=eq.${A.id}&${famFilter}&status=eq.processing&provider_dispatched_at=is.null&processing_heartbeat_at=lt.${encodeURIComponent(cutoff)}`;
  };
  const tNow = () => new Date().toISOString();
  const takeClaim = randomUUID();
  let t = tNow();
  r = await call("PATCH", takeoverPath(), { apikey: SERVICE, prefer: "return=representation", body: { status: "processing", processing_claim_id: takeClaim, processing_started_at: t, processing_heartbeat_at: t, provider_dispatched_at: null } });
  record("service takeover of expired undispatched lease (lt cutoff)", r.status === 200 && rows(r) === 1, `HTTP ${r.status} rows ${rows(r)}`);
  t = tNow();
  r = await call("PATCH", takeoverPath(), { apikey: SERVICE, prefer: "return=representation", body: { status: "processing", processing_claim_id: randomUUID(), processing_started_at: t, processing_heartbeat_at: t, provider_dispatched_at: null } });
  record("service second takeover of a fresh lease: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoT}&user_id=eq.${A.id}&status=eq.processing&processing_claim_id=eq.${deadClaim}`, { apikey: SERVICE, prefer: "return=representation", body: { processing_heartbeat_at: tNow() } });
  record("service stale holder heartbeat after takeover: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);
  // Wrong family and wrong user on the claim predicate affect nothing.
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoT}&user_id=eq.${A.id}&analysis_family=eq.putting&status=eq.processing&provider_dispatched_at=is.null&processing_heartbeat_at=lt.${encodeURIComponent(tNow())}`, { apikey: SERVICE, prefer: "return=representation", body: { processing_claim_id: randomUUID() } });
  record("service wrong-family takeover: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoT}&user_id=eq.${B.id}&${famFilter}&status=eq.processing&provider_dispatched_at=is.null&processing_heartbeat_at=lt.${encodeURIComponent(tNow())}`, { apikey: SERVICE, prefer: "return=representation", body: { processing_claim_id: randomUUID() } });
  record("service mismatched-user takeover: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("GET", `/swing_analysis?select=processing_claim_id&id=eq.${videoT}`, { apikey: SERVICE, accept: "application/vnd.pgrst.object+json" });
  record("takeover row still held by the taker", r.status === 200 && r.json?.processing_claim_id === takeClaim, `HTTP ${r.status}`);

  // Putting family: claim and score-fenced completion through PostgREST.
  const putter = randomUUID();
  r = await call("POST", "/user_equipment", { apikey: SERVICE, prefer: "return=minimal", body: { id: putter, user_id: A.id, club_type: "Putter", custom_club: true, custom_brand: "Synthetic", custom_model: "P1" } });
  if (r.status === 201) created.clubs.push(putter);
  const videoP = randomUUID();
  r = await call("POST", "/swing_videos", { token: A.token, prefer: "return=minimal", body: { id: videoP, user_id: A.id, status: "uploaded", storage_path: `${A.id}/p.mp4`, video_url: `${A.id}/p.mp4` } });
  if (r.status === 201) created.videos.push(videoP);
  r = await call("POST", "/swing_analysis?select=analysis_family", { apikey: SERVICE, prefer: "return=representation", accept: "application/vnd.pgrst.object+json", body: { id: videoP, swing_video_id: videoP, user_id: A.id, club_id: putter } });
  if (r.status === 201) created.analyses.push(videoP);
  record("service putting analysis derives family putting", r.status === 201 && r.json?.analysis_family === "putting", `HTTP ${r.status}`);
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoP}&user_id=eq.${A.id}&${famFilter}&status=in.(pending,failed)`, { apikey: SERVICE, prefer: "return=representation", body: { ...claimPatch, processing_claim_id: randomUUID() } });
  record("service full-swing claim on a putting row: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);
  const putClaim = randomUUID();
  t = tNow();
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoP}&user_id=eq.${A.id}&analysis_family=eq.putting&status=in.(pending,failed)`, { apikey: SERVICE, prefer: "return=representation", body: { status: "processing", processing_claim_id: putClaim, processing_started_at: t, processing_heartbeat_at: t, provider_dispatched_at: null } });
  record("service putting claim", r.status === 200 && rows(r) === 1, `HTTP ${r.status} rows ${rows(r)}`);
  // The holder records its dispatch before completing (execution guard).
  r = await call("PATCH", `/swing_analysis?select=id&id=eq.${videoP}&user_id=eq.${A.id}&status=eq.processing&processing_claim_id=eq.${putClaim}&provider_dispatched_at=is.null`, { apikey: SERVICE, prefer: "return=representation", body: { provider_dispatched_at: tNow(), processing_heartbeat_at: tNow(), processing_claim_proof: putClaim } });
  record("service putting dispatch by holder", r.status === 200 && rows(r) === 1, `HTTP ${r.status} rows ${rows(r)}`);
  const putDone = `/swing_analysis?select=id&id=eq.${videoP}&user_id=eq.${A.id}&analysis_family=eq.putting&status=eq.processing&processing_claim_id=eq.${putClaim}&putting_score=is.null`;
  const PUTT_SCORE = { basis: "qualitative_classification_index", coverage: { percent: 100, scorable_sections: 6, total_sections: 6 }, score: 80, score_version: 1, source_classification_version: 1 };
  r = await call("PATCH", putDone, { apikey: SERVICE, prefer: "return=representation", body: { status: "complete", putting_analysis: { note: SENTINEL }, putting_score: PUTT_SCORE, processing_claim_proof: putClaim } });
  record("service putting completion (putting_score is null fence)", r.status === 200 && rows(r) === 1, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("PATCH", putDone, { apikey: SERVICE, prefer: "return=representation", body: { status: "complete", putting_score: PUTT_SCORE, processing_claim_proof: putClaim } });
  record("service duplicate putting completion: zero rows", r.status === 200 && rows(r) === 0, `HTTP ${r.status} rows ${rows(r)}`);
  r = await call("GET", `/swing_analysis?select=id,status,analysis_family&id=eq.${videoP}`, { token: A.token });
  record("owner reads completed putt core columns without payload", r.status === 200 && r.json?.[0]?.status === "complete" && !r.text.includes(SENTINEL), `HTTP ${r.status}`);
} catch (error) {
  record("harness", false, `error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // Remove only what this script created.
  let cleanupErrors = 0;
  const del = async (path) => {
    try {
      const x = await call("DELETE", path, { apikey: SERVICE });
      if (x.status !== 204) { cleanupErrors += 1; console.log(`CLEANUP_ERROR | DELETE ${path.split("?")[0]} | HTTP ${x.status}`); }
    } catch (e) { cleanupErrors += 1; console.log(`CLEANUP_ERROR | ${path.split("?")[0]} | ${e instanceof Error ? e.message : e}`); }
  };
  for (const id of created.analyses) await del(`/swing_analysis?id=eq.${id}`);
  for (const id of created.videos) await del(`/swing_videos?id=eq.${id}`);
  for (const id of created.clubs) await del(`/user_equipment?id=eq.${id}`);
  for (const id of created.users) {
    try {
      const x = await fetch(`${API}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
      if (x.status !== 200) { cleanupErrors += 1; console.log(`CLEANUP_ERROR | auth admin delete | HTTP ${x.status}`); }
    } catch (e) { cleanupErrors += 1; console.log(`CLEANUP_ERROR | auth admin delete | ${e instanceof Error ? e.message : e}`); }
  }
  record("cleanup: every created resource removed", cleanupErrors === 0, `${cleanupErrors} errors`);
  for (const line of results) console.log(line);
  for (const line of info) console.log(line);
  console.log(`POSTGREST_RESULT=${failures === 0 ? "PASS" : "FAIL"} (${results.length} checks, ${failures} failed)`);
  process.exit(failures === 0 ? 0 : 1);
}
