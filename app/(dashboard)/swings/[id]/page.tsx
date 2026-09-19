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
import { isPersistedPuttingAnalysisV1 } from "@/lib/putting-analysis-contract";
import { getHistoricalEquipmentDisplayName } from "@/lib/equipment/historical-equipment-display-name";
import { resolvePuttingDrillRecommendations } from "@/lib/putting-recommendation-authority-eq5e-c";
import { resolvePuttingScorePresentation } from "@/lib/putting-score-presentation-eq5f-f";
import type { SubscriptionTier, DeficiencyItem, HighlightItem } from "@/types/database";
import type { EquipmentFitting } from "@/lib/types/swing";

/** The private bucket every swing video is uploaded to. Never made public. */
const VIDEO_BUCKET = "swing-videos";

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

  const { data: swing } = await supabase
    .from("swing_analysis")
    .select("*, swing_video:swing_videos(club, title, recorded_at, created_at, status, original_filename, storage_path, video_url)")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .single();

  if (!swing) notFound();

  // ── EQ5F-B analysis video replay — resolved here, on the server ─────────────
  //
  // Everything above is the permission to be here: the row was filtered by both
  // id and user_id, and notFound() has already run, so private playback access
  // is never minted for a row this golfer does not own. The bucket stays
  // private and the browser receives only a time-limited signed URL — never a
  // credential, and never the storage path itself.
  //
  // storage_path leads because it names the durable private object this
  // analysis actually read. video_url stays beneath it as the compatibility
  // fallback for rows recorded before signed playback existed; promoting it
  // would prefer a stale URL over the object of record.
  //
  // A signing failure is not an analysis failure. It resolves to null, the
  // replay simply does not render, and the result below is untouched.
  const joinedVideo = swing.swing_video as
    | { storage_path?: string | null; video_url?: string | null }
    | { storage_path?: string | null; video_url?: string | null }[]
    | null;
  const videoRow = Array.isArray(joinedVideo) ? (joinedVideo[0] ?? null) : joinedVideo;

  let playbackUrl: string | null = null;

  if (typeof videoRow?.storage_path === "string" && videoRow.storage_path.trim().length > 0) {
    const { data: signed } = await supabase.storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(videoRow.storage_path, 3600);
    playbackUrl = signed?.signedUrl ?? null;
  }

  if (playbackUrl === null && typeof videoRow?.video_url === "string" && videoRow.video_url.trim().length > 0) {
    playbackUrl = videoRow.video_url;
  }

  // Extract individual metrics from the jsonb metrics field
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

  // v4 granular telemetry arrays
  const highlights = (swing.swing_highlights ?? []) as HighlightItem[];
  const deficiencies = (swing.mechanical_deficiencies ?? []) as DeficiencyItem[];
  const detailedHtml = (swing.detailed_summary_html ?? null) as string | null;

  // v5 equipment fitting — from analysis_v2 jsonb if present
  const analysisV2 = swing.analysis_v2 as Record<string, unknown> | null;
  const equipmentFitting = (analysisV2?.equipment_fitting ?? null) as EquipmentFitting | null;

  // Entitlement check for equipment fitting
  const hasEquipmentFitting = tier === "birdie" || tier === "eagle";

  // EQ5F-A. The club this analysis was taken with, read from the immutable
  // equipment snapshot the database wrote at insert. The legacy
  // swing_videos.club string stays as the fallback beneath it: it is still the
  // only identity older rows have, but where a snapshot exists it is the
  // historical record and the video string is not.
  const historicalClubName = getHistoricalEquipmentDisplayName(swing.equipment_snapshot);

  // Database-owned analysis family for putting results
  const isPutt = swing.analysis_family === "putting";

  const isAwaitingResult = swing.status === "processing" || swing.status === "pending";

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
            <SwingHighlightsPanel tier={tier} highlights={highlights} />
          </div>

          {/* v4: Mechanical Deficiencies */}
          <div className="mb-6">
            <MechanicalDeficienciesPanel tier={tier} deficiencies={deficiencies} />
          </div>

          {/* v5: Equipment Recommendations — Birdie/Eagle gated */}
          <div className="mb-6">
            <EquipmentRecommendations
              fitting={hasEquipmentFitting ? equipmentFitting : null}
              tier={tier === "coach_starter" || tier === "coach_pro" ? "birdie" : tier === "none" ? "par" : tier}
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
      {swing.status === "processing" && (
        <div className="flex items-center gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-4xl p-6 mb-6">
          <AlertTriangle size={18} className="text-yellow-400 shrink-0" />
          <p className="text-yellow-300 text-xs font-bold uppercase tracking-wide">
            AI analysis in progress — full results incoming shortly.
          </p>
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
