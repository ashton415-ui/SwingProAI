import { createClient, getServerSession } from "@/utils/supabase/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle, AlertTriangle, Zap, Clock } from "lucide-react";
import {
  PuttingAnalysisPanel,
  type PuttingResultState,
} from "@/components/putting/PuttingAnalysisPanel";
import { PuttingRecommendationsPanel } from "@/components/putting/PuttingRecommendationsPanel";
import { PuttingScoreCard } from "@/components/putting/PuttingScoreCard";
import { SwingHighlightsPanel } from "@/components/swing/SwingHighlightsPanel";
import { MechanicalDeficienciesPanel } from "@/components/swing/MechanicalDeficienciesPanel";
import { EquipmentRecommendations } from "@/components/swing/EquipmentRecommendations";
import { canUsePuttingAnalysis } from "@/lib/entitlements";
import {
  authorizeOwnedAnalysisRow,
  readOwnedAnalysisPayloads,
} from "@/lib/analysis-result-read-authority";
import { readExecutionState } from "@/lib/analysis-execution-claim";
import {
  classifyFailedAnalysisVideo,
  signOwnedSwingVideoPlayback,
  VIDEO_UNUSABLE_COPY,
  VIDEO_UNUSABLE_STATUS,
} from "@/lib/swing-video-source";
import { isPersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";
import { getHistoricalEquipmentDisplayName } from "@/lib/equipment/historical-equipment-display-name";
import { resolvePuttingDrillRecommendations } from "@/lib/putting-recommendation-authority-eq5e-c";
import { resolvePuttingScorePresentation } from "@/lib/putting-score-presentation-eq5f-f";
import type { SubscriptionTier, DeficiencyItem, HighlightItem } from "@/types/database";
import type { EquipmentFitting } from "@/lib/types/swing";

/** The swing_videos columns this page joins. */
interface SwingVideoJoin {
  club?: string | null;
  title?: string | null;
  original_filename?: string | null;
  storage_path?: string | null;
}

export default async function SwingDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = await createClient();
  const session = await getServerSession();

  if (!session) redirect("/login");
  const user = session.user;

  const { data: profile } = await supabase
    .from("users")
    .select("subscription_tier")
    .eq("id", user.id)
    .single();

  const tier = (profile?.subscription_tier ?? "par") as SubscriptionTier;

  // ENT-1C. This session read proves ownership (id AND user_id) and carries
  // identity and core columns only. The result payload is read and serialized
  // by the unified result-read authority, so no raw row reaches anything below.
  const { data: ownedRow } = await supabase
    .from("swing_analysis")
    .select("id, user_id, status, analysis_family, equipment_snapshot, created_at, score, feedback, tempo_ratio, swing_speed_mph, swing_video:swing_videos(club, title, recorded_at, created_at, status, original_filename, storage_path)")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  const authorized = ownedRow
    ? await authorizeOwnedAnalysisRow({ client: supabase, userId: user.id }, ownedRow)
    : null;
  const joined = (ownedRow?.swing_video ?? null) as unknown as SwingVideoJoin | SwingVideoJoin[] | null;
  const swing = authorized
    ? {
        ...authorized.result,
        created_at: authorized.result.created_at ?? "",
        swing_video: Array.isArray(joined) ? (joined[0] ?? null) : joined,
      }
    : null;

  // An owned row whose payload cannot be read also ends here: EQ5F-B keeps
  // this page free of thrown errors, so an outage presents as not-found.
  if (!swing) notFound();
  const access = authorized!.access;

  // ── EQ5F-B analysis video replay — resolved here, on the server ─────────────
  //
  // Everything above is the permission to be here: the row was filtered by both
  // id and user_id, and notFound() has already run, so private playback access
  // is never minted for a row this golfer does not own. The bucket stays
  // private and the browser receives only a time-limited signed URL — never a
  // credential, and never the storage path itself.
  //
  // storage_path is the only source: the golfer's own canonical object in the
  // private bucket, re-validated before signing (lib/swing-video-source.ts).
  // Browser-written video_url is never played back, and a row whose key is not
  // canonical has no replay.
  //
  // A signing failure is not an analysis failure. It resolves to null, the
  // replay simply does not render, and the result below is untouched.
  const joinedVideo = swing.swing_video as
    | { storage_path?: string | null }
    | { storage_path?: string | null }[]
    | null;
  const videoRow = Array.isArray(joinedVideo) ? (joinedVideo[0] ?? null) : joinedVideo;

  const playbackUrl = await signOwnedSwingVideoPlayback(supabase, videoRow?.storage_path, user.id);

  // ENT-1D. A failed analysis says why when the reason is its video: decided
  // from the stored object (no stored reason, no provider call). Any other
  // failure gets the family-neutral banner below.
  const failedReason =
    swing.status === "failed"
      ? await classifyFailedAnalysisVideo(supabase, videoRow?.storage_path, user.id)
      : null;

  // Extract individual metrics from the authorized core metrics
  const metrics = swing.metrics as Record<string, unknown> | null;
  const scoringBreakdown = typeof metrics?.scoring_breakdown === "string" ? metrics.scoring_breakdown : null;

  const metricCards = [
    { label: "Swing Score", value: swing.score, unit: " pts", ideal: "80–100 pts" },
    { label: "Tempo Ratio", value: swing.tempo_ratio, unit: ":1", ideal: "3.0 : 1" },
    { label: "Swing Speed", value: swing.swing_speed_mph, unit: " mph", ideal: "90–110 mph" },
    { label: "Spine Angle", value: typeof metrics?.spine_angle_deg === "number" ? metrics.spine_angle_deg : null, unit: "°", ideal: "28–35°" },
    { label: "Hip Rotation", value: typeof metrics?.hip_rotation_deg === "number" ? metrics.hip_rotation_deg : null, unit: "°", ideal: "45–55°" },
    { label: "Shoulder Rotation", value: typeof metrics?.shoulder_rotation_deg === "number" ? metrics.shoulder_rotation_deg : null, unit: "°", ideal: "90–110°" },
  ];

  const suggestions = Array.isArray(metrics?.suggestions) ? (metrics.suggestions as string[]) : null;

  // v4 granular telemetry arrays — core improvement feedback for every golfer
  // (ENT-1C), already item-level allow-listed by the authority.
  const highlights = swing.swing_highlights as HighlightItem[];
  const deficiencies = swing.mechanical_deficiencies as DeficiencyItem[];

  // No stored column carries a deep prose summary or an equipment fitting
  // (detailed_summary_html and analysis_v2 exist in no migration), so the
  // authorized view has neither and these stay empty until a producer and a
  // contract exist.
  const detailedHtml = null as string | null;
  const equipmentFitting = null as EquipmentFitting | null;

  // Equipment fitting is its own paid capability, with a paying status.
  const hasEquipmentFitting = access.equipmentFitting;

  // EQ5F-A. The club this analysis was taken with, read from the immutable
  // equipment snapshot the database wrote at insert. The legacy
  // swing_videos.club string stays as the fallback beneath it: it is still the
  // only identity older rows have, but where a snapshot exists it is the
  // historical record and the video string is not.
  const historicalClubName = getHistoricalEquipmentDisplayName(swing.equipment_snapshot);

  // Database-owned analysis family for putting results
  const isPutt = swing.analysis_family === "putting";

  const isAwaitingResult = swing.status === "processing" || swing.status === "pending";

  // ENT-1D. A processing row whose holder reached the AI and then stopped
  // reporting (or that was taken by pre-lease code) will not finish and is not
  // re-run automatically. It is told apart from live work on the server; no
  // claim detail reaches the page.
  const isStalled =
    swing.status === "processing" &&
    (await readExecutionState({
      analysisId: swing.id,
      userId: user.id,
      family: isPutt ? "putting" : "full_swing",
    })) === "stalled";

  // ── EQ5C-A putting result state — decided here, on the server ───────────────
  //
  // Entitlement and validity are both settled before any prop is built, because
  // a prop handed to a Client Component is serialized into the RSC payload and
  // reaches the browser whatever the component chooses to render. Hiding a
  // premium narrative client-side would ship it anyway, so an unentitled tier is
  // never given one: "locked" carries no analysis, and neither does
  // "unavailable".
  //
  // The stored jsonb is untrusted transport. It is read as
  // Record<string, unknown> | null and only becomes a typed contract by passing
  // isPersistedPuttingAnalysisV1 — the same predicate the analysis pipeline uses
  // for its cache, so a payload written by an older or looser validator can
  // never be displayed. A ready state is unreachable without both checks.
  //
  // While the row is still processing or queued, no panel is rendered at all:
  // the shared status banner already says so, and calling an unfinished
  // analysis "unavailable" would be wrong rather than merely unhelpful.
  //
  // Success is then required positively. status is unconstrained text on
  // swing_analysis -- there is no CHECK constraint and the TypeScript type is a
  // bare string -- so "not processing and not pending" is a deny-list over a
  // column that can hold anything, and every value nobody thought to exclude
  // would fall through to a rendered result. It only takes "complete". A stored
  // payload is never cleared when a later run fails, so a failed row can still
  // carry a valid envelope; presenting that as a finished report would tell the
  // golfer their analysis succeeded when it did not.
  const rawPuttingAnalysis = (swing.putting_analysis ?? null) as Record<string, unknown> | null;

  const puttingState: PuttingResultState | null = (() => {
    if (!canUsePuttingAnalysis(tier)) return { status: "locked" };
    if (isAwaitingResult) return null;
    if (swing.status !== "complete") return { status: "unavailable" };
    if (isPersistedPuttingAnalysisV1(rawPuttingAnalysis)) {
      return { status: "ready", analysis: rawPuttingAnalysis };
    }
    return { status: "unavailable" };
  })();

  // ── EQ5E-D putting practice suggestions — resolved here, on the server ──────
  //
  // The resolver above decided what this golfer may see of the analysis. This
  // asks a second, separate question — what the rule set suggests practising —
  // and asks it only when the analysis itself resolved to a payload the page is
  // already showing. `"analysis" in puttingState` is that test: it is the one
  // variant of the union carrying a validated envelope, so the check reuses the
  // union's own discriminator instead of restating the readiness rule.
  //
  // Everything else belongs to the authority. It re-reads the row it was asked
  // about, re-proves ownership, family, completion and payload validity, asks
  // its own entitlement question before any read, and reconciles every
  // candidate against the canonical catalog. Nothing here re-validates,
  // re-ranks, filters or reshapes what comes back: the result is handed to the
  // presentation component exactly as received, and a refusal is one of its
  // states rather than an exception to survive.
  const puttingRecommendationResult =
    isPutt && puttingState !== null && "analysis" in puttingState
      ? await resolvePuttingDrillRecommendations(supabase, {
          userId: user.id,
          tier,
          sourceAnalysisId: swing.id,
          // ENT-1D: the envelope is read on the server, bounded by the owned
          // id and this golfer, never through the session.
          readEnvelope: async (analysisId, ownerId) => {
            const payloads = await readOwnedAnalysisPayloads([analysisId], ownerId);
            return payloads?.get(analysisId)?.putting_analysis;
          },
        })
      : null;

  // ── EQ5F-F putting stroke index — resolved here, on the server ──────────────
  //
  // The score is read, never derived. EQ5F-E wrote it once from validated
  // evidence and shipped with no backfill, so a row recorded before that
  // release carries NULL and must keep carrying it: recomputing one here would
  // undo that decision for every historical analysis at read time, silently and
  // all at once. Nothing below consumes putting_analysis.
  //
  // Readiness is borrowed rather than restated. `"analysis" in puttingState` is
  // the union's own discriminator for the one variant that survived entitlement,
  // completion and payload validation above, so the index cannot appear for a
  // locked golfer, an unfinished row or a payload the page would not otherwise
  // display. A second readiness rule here would be a second way to be wrong.
  //
  // The stored jsonb is untrusted transport, exactly as the analysis payload is.
  // It becomes a typed contract only by passing the strict v1 validator, and a
  // malformed or future envelope resolves to null — no card, rather than a
  // number whose meaning this page cannot vouch for. Only three primitives cross
  // into the component; the stored object never does.
  const rawPuttingScore = (swing.putting_score ?? null) as Record<string, unknown> | null;

  // The readiness test is written in its own order rather than copied verbatim
  // from the recommendation gate above. Both ask the same question, but the
  // published EQ5E-D and EQ5F-B suites break their gates by replacing that exact
  // expression once; a second identical copy on this page would silently absorb
  // the mutation and leave those guards proving nothing.
  const puttingScoreState =
    puttingState !== null && "analysis" in puttingState && isPutt
      ? resolvePuttingScorePresentation(rawPuttingScore)
      : null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Link
        href="/dashboard"
        className="flex items-center gap-2 text-gray-600 hover:text-white mb-8 transition-colors text-[10px] font-black uppercase tracking-widest"
      >
        <ArrowLeft size={14} />
        Back to Hub
      </Link>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl md:text-5xl font-black italic tracking-tighter text-white uppercase capitalize">
          {historicalClubName ?? swing.swing_video?.club ?? swing.swing_video?.title ?? "Swing"} Analysis
        </h1>
        <div className="flex items-center gap-3 mt-2">
          <Clock size={12} className="text-gray-600" />
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500">
            {new Date(swing.created_at).toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric", year: "numeric",
            })}
          </p>
          {swing.swing_video?.original_filename && (
            <span className="text-[9px] font-mono text-gray-700 bg-white/5 px-2 py-0.5 rounded-full">
              {swing.swing_video.original_filename}
            </span>
          )}
        </div>
      </div>

      {/* ANALYSIS VIDEO REGION — family-neutral, and deliberately above the
          split below. One replay serves a putt and a full swing alike, so
          neither result contract owns a player, and nothing here reads the
          family, the tier or the analysis payload. Rendered only when a
          playback URL survived signing: an absent video is silent rather than
          advertised, because a golfer cannot act on a permanent placeholder. */}
      {playbackUrl && (
        <section aria-label="Analysis video" className="mb-8">
          <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-3">
            Analysis Video
          </p>
          <video
            src={playbackUrl}
            controls
            playsInline
            preload="metadata"
            className="w-full max-h-[70vh] aspect-video object-contain bg-black rounded-4xl border border-white/5"
          />
        </section>
      )}

      {isPutt ? (
        /* PUTTING RESULT REGION — the whole report for a putting row. The
           full-swing report below is not rendered at all for this family: its
           score, tempo, speed and biomechanics were never measured on a putt,
           so showing those cards as dashes under full-swing ideal ranges would
           claim six attempted measurements that do not exist. */
        <>
          {puttingScoreState && (
            <div className="mb-6">
              <PuttingScoreCard state={puttingScoreState} />
            </div>
          )}

          {puttingState && (
            <div className="mb-6">
              <PuttingAnalysisPanel state={puttingState} />
            </div>
          )}

          {puttingRecommendationResult !== null && (
            <div className="mb-6">
              <PuttingRecommendationsPanel result={puttingRecommendationResult} />
            </div>
          )}
        </>
      ) : (
        /* FULL SWING REPORT REGION — unchanged. Reached by analysis_family
           "full_swing" and by a null family, which remains the established
           full-swing compatibility path. */
        <>
          {/* Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
            {metricCards.map((m) => (
              <div key={m.label} className="bg-golf-surface border border-white/5 rounded-4xl p-6">
                <p className="text-[9px] font-black text-gray-600 uppercase tracking-widest mb-3">{m.label}</p>
                <p className={`text-3xl font-mono font-black italic tracking-tighter ${
                  m.label === "Swing Score"
                    ? (m.value ?? 0) >= 80
                      ? "text-golf-green"
                      : (m.value ?? 0) >= 60
                      ? "text-yellow-400"
                      : "text-red-400"
                    : "text-white"
                }`}>
                  {m.value != null ? `${m.value}${m.unit}` : "—"}
                </p>
                <p className="text-[9px] text-golf-green font-bold uppercase mt-2 tracking-widest">
                  Ideal: {m.ideal}
                </p>
              </div>
            ))}
          </div>

          {/* Scoring Math — chain-of-thought breakdown from the AI */}
          {scoringBreakdown && (
            <div className="bg-golf-surface border border-white/5 rounded-4xl px-6 py-4 mb-6">
              <p className="text-[9px] font-black text-gray-600 uppercase tracking-widest mb-1">Scoring Math</p>
              <p className="text-xs text-gray-400 font-mono leading-relaxed">{scoringBreakdown}</p>
            </div>
          )}

          {/* AI Feedback */}
          {swing.feedback && (
            <div className="bg-black/40 border border-golf-green/20 rounded-5xl p-8 mb-6 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-6 opacity-5">
                <Zap className="w-20 h-20 text-golf-green" />
              </div>
              <h3 className="text-[10px] font-black text-golf-green uppercase tracking-[0.2em] mb-5 flex items-center gap-2">
                <Zap size={12} />
                AI Coach Feedback
              </h3>
              <p className="text-gray-300 leading-relaxed text-sm">{swing.feedback}</p>
            </div>
          )}

          {/* Deep prose summary */}
          {detailedHtml && (
            <div className="bg-golf-surface border border-white/5 rounded-5xl p-8 mb-6">
              <h3 className="text-[10px] font-black text-white uppercase tracking-widest mb-5 flex items-center gap-2">
                <Zap size={12} className="text-golf-green" />
                Deep Biomechanical Audit
              </h3>
              <div
                className="prose-swing text-sm text-gray-300 leading-relaxed space-y-3 [&_h4]:text-white [&_h4]:font-black [&_h4]:uppercase [&_h4]:tracking-widest [&_h4]:text-[11px] [&_h4]:mt-4 [&_strong]:text-white [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1"
                dangerouslySetInnerHTML={{ __html: detailedHtml }}
              />
            </div>
          )}

          {/* v4: Swing Highlights */}
          <div className="mb-6">
            <SwingHighlightsPanel highlights={highlights} />
          </div>

          {/* v4: Mechanical Deficiencies */}
          <div className="mb-6">
            <MechanicalDeficienciesPanel deficiencies={deficiencies} />
          </div>

          {/* v5: Equipment Recommendations — Birdie/Eagle gated */}
          <div className="mb-6">
            <EquipmentRecommendations
              fitting={hasEquipmentFitting ? equipmentFitting : null}
              tier={hasEquipmentFitting ? tier : "par"}
            />
          </div>

          {/* Suggestions */}
          {suggestions && suggestions.length > 0 && (
            <div className="bg-golf-surface border border-white/5 rounded-5xl p-8 mb-6">
              <h3 className="text-[10px] font-black text-white uppercase tracking-widest mb-6">
                Improvement Protocols
              </h3>
              <ul className="space-y-4">
                {suggestions.map((tip: string, i: number) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-gray-300">
                    <CheckCircle size={16} className="text-golf-green mt-0.5 shrink-0" />
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Raw metrics dump */}
          {metrics && Object.keys(metrics).length > 0 && !suggestions && (
            <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 mb-6">
              <h3 className="text-[9px] font-black text-gray-600 uppercase tracking-widest mb-4">
                Raw Telemetry
              </h3>
              <pre className="text-[10px] font-mono text-gray-500 overflow-x-auto">
                {JSON.stringify(metrics, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}

      {/* SHARED STATUS REGION — family-neutral, and identical for both. */}
      {swing.status === "processing" && !isStalled && (
        <div className="flex items-center gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-4xl p-6 mb-6">
          <AlertTriangle size={18} className="text-yellow-400 shrink-0" />
          <p className="text-yellow-300 text-xs font-bold uppercase tracking-wide">
            AI analysis in progress — full results incoming shortly.
          </p>
        </div>
      )}

      {isStalled && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-4xl p-6 mb-6">
          <AlertTriangle size={18} className="text-amber-400 shrink-0" />
          <p className="text-amber-200 text-xs font-bold leading-relaxed">
            This analysis was interrupted and won&apos;t finish. Record the swing again for a new analysis.
          </p>
          <Link
            href="/analyze"
            className="sm:ml-auto inline-flex items-center justify-center min-h-[44px] px-4 rounded-2xl border border-white/10 text-[10px] font-black uppercase tracking-widest text-white hover:bg-white/5"
          >
            Record again
          </Link>
        </div>
      )}

      {swing.status === "failed" && failedReason === VIDEO_UNUSABLE_STATUS && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-red-500/10 border border-red-500/20 rounded-4xl p-6 mb-6">
          <AlertTriangle size={18} className="text-red-400 shrink-0" />
          <p className="text-red-200 text-xs font-bold leading-relaxed">{VIDEO_UNUSABLE_COPY}</p>
          <Link
            href="/analyze"
            className="sm:ml-auto inline-flex items-center justify-center min-h-[44px] px-4 rounded-2xl border border-white/10 text-[10px] font-black uppercase tracking-widest text-white hover:bg-white/5"
          >
            Upload a new video
          </Link>
        </div>
      )}

      {swing.status === "failed" && failedReason !== VIDEO_UNUSABLE_STATUS && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-red-500/10 border border-red-500/20 rounded-4xl p-6 mb-6">
          <AlertTriangle size={18} className="text-red-400 shrink-0" />
          <p className="text-red-200 text-xs font-bold leading-relaxed">
            This analysis didn&apos;t finish. Recording the swing again starts a new analysis.
          </p>
          <Link
            href="/analyze"
            className="sm:ml-auto inline-flex items-center justify-center min-h-[44px] px-4 rounded-2xl border border-white/10 text-[10px] font-black uppercase tracking-widest text-white hover:bg-white/5"
          >
            Record again
          </Link>
        </div>
      )}

      {swing.status === "pending" && (
        <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-4xl p-6">
          <AlertTriangle size={18} className="text-gray-500 shrink-0" />
          <p className="text-gray-500 text-xs font-bold uppercase tracking-wide">
            Analysis queued — awaiting AI processing.
          </p>
        </div>
      )}
    </div>
  );
}
