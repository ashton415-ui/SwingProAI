"use client";

import { useState, useEffect, useRef } from "react";
import {
  CheckCircle2, AlertTriangle, Loader2, Zap, Target,
  ChevronDown, ChevronUp, RotateCcw, Play, Pause,
  TrendingUp, AlertCircle, Lightbulb, Dumbbell,
} from "lucide-react";
import { VIDEO_UNUSABLE_COPY, VIDEO_UNUSABLE_STATUS } from "@/lib/swing-video-source";
import {
  ASSESSMENT_LABEL,
  EVIDENCE_LIMITS_LABEL,
  SCORE_BASIS,
  UNSCORED_COPY,
  UNSCORED_LABEL,
  presentScore,
} from "@/lib/swing-metric-presentation";
import { createClient } from "@/utils/supabase/client";
import { watchLineageEnd, type OwnerRefusal } from "@/utils/supabase/session-publication";
import { confirmOwnerSession, drillHubIdentityEndFromEvent, ownerBearer } from "@/lib/drill-hub-session";
import { useRenderedSession } from "@/components/navigation/SessionKeeper";

const NETWORK_FAILURE_COPY = "We couldn't reach SwingProAI. Check your connection, then tap Retry.";
const SERVICE_FAILURE_COPY = "Analysis is temporarily unavailable. Please try again shortly.";

// A4 (C1). This report's analysis call is sent only as the account the dashboard layout rendered the page for: with that
// account's token, confirmed immediately before the request (lib/drill-hub-session.ts confirmOwnerSession; never a
// session the browser adopted first, never anonymous) as a Bearer, and with no cookie (`credentials: "omit"`): the route
// verifies the Bearer itself (utils/supabase/server.ts resolveRouteAuth). When that account cannot be confirmed now,
// nothing is sent and the golfer gets fixed copy. An answer that arrives after the report was left, or after this
// browser's sign-in changed, changes nothing here (it belongs to the earlier sign-in).
const OWNER_REFUSAL_COPY: Readonly<Record<OwnerRefusal, string>> = {
  signed_out: "Your session has expired. Please sign in again.",
  ended: "This sign-in was ended, so this analysis wasn't started. Sign in again to continue.",
  unconfirmed: "We couldn't confirm which account is signed in on this device, so this analysis wasn't started. Try again, or sign in again.",
  unavailable: "We couldn't check your sign-in just now, so this analysis wasn't started. Try again in a moment.",
  account_changed: "This browser is now signed in to a different account, so this analysis wasn't started. Refresh the page to continue with the account that's signed in now.",
};
const IDENTITY_CHANGED_COPY =
  "This browser's sign-in changed while your swing was being analyzed, so the result isn't shown here. Refresh the page to continue with the account that's signed in now.";
/** The request's session read is given this long before it is reported as unavailable (as on the Analyze page). */
const SESSION_READ_DEADLINE_MS = 12_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Pillar {
  /** S6-R1 adds "insufficient_evidence"; an unknown stored value shows no rating. */
  rating: string;
  observation: string;
  correction: string;
}

interface Highlight {
  /** S6-R1A: null when not assessed; this report does not display it. */
  checkpoint: string | null;
  positive_movement: string;
  mechanical_benefit: string;
}

/**
 * S6-R1A: checkpoint, joint and severity are null when not assessed (the read
 * authority maps the producer's old constants to null). Only assessed values
 * are shown; the coaching text and drill are always kept.
 */
interface Deficiency {
  checkpoint: string | null;
  joint_coordinate: { joint: string } | string | null;
  fault_description: string;
  severity: "minor" | "major" | null;
  corrective_drill_title: string;
  corrective_drill_detail?: string | null;
}

interface Metrics {
  scoring_breakdown?: string;
  evidence_limits?: string;
  posture?: Pillar;
  swing_plane?: Pillar;
  impact?: Pillar;
  practice_focus?: string;
  pro_cue?: string;
  the_feel?: string;
}

export interface AnalysisData {
  id: string;
  status: string;
  score: number | null;
  feedback: string | null;
  swing_highlights: Highlight[] | null;
  mechanical_deficiencies: Deficiency[] | null;
  metrics: Metrics | null;
  swing_video: {
    id: string;
    storage_path: string | null;
    original_filename: string | null;
    club: string | null;
    created_at: string;
  } | null;
}

interface Props {
  analysis: AnalysisData;
  videoSignedUrl: string | null;
  /**
   * EQ5F-A. The historical club name, already resolved on the server from the
   * immutable equipment snapshot. This component does not read the snapshot
   * itself: the authority for what a swing was taken with is server-side, and a
   * client component re-deriving it would be a second opinion.
   */
  clubDisplayName: string | null;
  /**
   * ENT-1D. Set by the server for a failed analysis whose stored video cannot
   * be analysed (classifyFailedAnalysisVideo); null for any other failure.
   */
  failedReason?: typeof VIDEO_UNUSABLE_STATUS | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RATING_STYLE: Record<string, { label: string; bg: string; border: string; text: string }> = {
  excellent: { label: "Excellent",   bg: "bg-emerald-500/10", border: "border-emerald-500/25", text: "text-emerald-400" },
  good:      { label: "Good",        bg: "bg-golf-green/10",  border: "border-golf-green/25",  text: "text-golf-green"  },
  needs_work:{ label: "Needs Work",  bg: "bg-amber-500/10",   border: "border-amber-500/25",   text: "text-amber-400"   },
  poor:      { label: "Poor",        bg: "bg-red-500/10",     border: "border-red-500/25",      text: "text-red-400"    },
  insufficient_evidence: { label: "Not enough evidence", bg: "bg-white/5", border: "border-white/10", text: "text-gray-400" },
};

/** Where a fault was assessed (checkpoint · joint), or null when neither was. */
function assessedLocation(d: Deficiency): string | null {
  const joint = typeof d.joint_coordinate === "string" ? d.joint_coordinate : d.joint_coordinate?.joint ?? null;
  return [d.checkpoint, joint].filter((part): part is string => Boolean(part)).join(" · ") || null;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PillarCard({ title, pillar, openDefault }: { title: string; pillar: Pillar; openDefault?: boolean }) {
  const [open, setOpen] = useState(openDefault ?? false);
  // An unrecognised rating shows no chip rather than borrowing a positive one.
  const style = RATING_STYLE[pillar.rating] ?? null;

  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-3">
          <p className="text-sm font-bold text-white">{title}</p>
          {style && (
            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${style.bg} ${style.border} ${style.text}`}>
              {style.label}
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-gray-600 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-600 shrink-0" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-white/[0.06] pt-4 space-y-4">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1.5">Observation</p>
            <p className="text-sm text-gray-300 leading-relaxed">{pillar.observation}</p>
          </div>
          {pillar.correction && (
            <div className="flex items-start gap-3 bg-golf-green/[0.05] border border-golf-green/20 rounded-xl px-4 py-3">
              <Target className="w-4 h-4 text-golf-green shrink-0 mt-0.5" />
              <div>
                <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-1">Correction</p>
                <p className="text-xs text-gray-300 leading-relaxed">{pillar.correction}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Processing state ──────────────────────────────────────────────────────────

function ProcessingState({
  analysisId,
  ownerId,
  lineage,
  renderedOwner,
  onComplete,
  onStalled,
  onFailed,
}: {
  analysisId: string;
  /** A4: the account this report was rendered for (taken once), or null outside the dashboard layout: nothing is sent */
  ownerId: string | null;
  /** A4: the session lineage the report was rendered for; its End Session ends this report's view */
  lineage: string | null;
  /** A4: the account the enclosing layout is rendered for now (a re-render for another account ends this view) */
  renderedOwner: string | null;
  onComplete: (data: AnalysisData) => void;
  onStalled?: () => void;
  // Set while the failure panel is shown, cleared on Retry, so the status pill
  // agrees with the body (it otherwise still showed the initial "pending").
  onFailed?: (failed: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // A4 (C1). Shown instead of an answer that arrived after this browser's sign-in changed.
  const [identityNotice, setIdentityNotice] = useState(false);
  // A4 (C1). False once the report has been left: an answer arriving afterwards changes nothing.
  const mountedRef = useRef(true);
  // A4 (C1). Set once this browser's sign-in is no longer the one the report was rendered for (a sign-out, another
  // account's session, or End Session of the rendered sign-in, here or in another tab), with why: nothing more is sent
  // and no later answer is shown.
  const identityEndedRef = useRef<null | "signed_out" | "account_changed">(null);
  // ENT-1C. A 409 "already in progress" is not a failure: another request holds
  // this analysis, and the server will not start a second model call for it.
  const [inProgressNotice, setInProgressNotice] = useState<string | null>(null);
  // ENT-1D. The analysis reached the AI and then stopped reporting; it is not
  // re-run automatically, so retrying here cannot help.
  const [stalledNotice, setStalledNotice] = useState<string | null>(null);
  // ENT-1D D1. The stored video could not be read, so nothing was analysed and
  // retrying the same video cannot help: the way forward is a new upload.
  const [videoUnusable, setVideoUnusable] = useState(false);
  // Each Retry / Check again bumps the attempt, which is what re-runs the effect.
  const [attempt, setAttempt] = useState(0);
  const triggeredFor = useRef<number | null>(null);

  const STEPS = [
    "Connecting to AI coach…",
    "Evaluating posture & setup…",
    "Analysing swing plane…",
    "Assessing impact position…",
    "Generating drill prescriptions…",
    "Finalising report…",
  ];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A4 (C1). Watches for this browser's sign-in to stop being the one the report was rendered for: the managed client's
  // identity events (which also bring other tabs' sign-ins and sign-outs) and End Session of the rendered lineage.
  useEffect(() => {
    const end = (why: "signed_out" | "account_changed") => {
      identityEndedRef.current ??= why;
    };
    if (renderedOwner !== ownerId) end("account_changed"); // the layout was rendered again for another account
    let unsubscribe = () => {};
    try {
      const { data } = createClient().auth.onAuthStateChange((event, session) => {
        const why = drillHubIdentityEndFromEvent(ownerId, event, session);
        if (why !== null) end(why);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      // no events: the confirmation before each request still decides
    }
    const stopLineageWatch = watchLineageEnd(lineage, () => end("signed_out"));
    return () => {
      unsubscribe();
      stopLineageWatch();
    };
  }, [ownerId, lineage, renderedOwner]);

  useEffect(() => {
    if (triggeredFor.current === attempt) return;
    triggeredFor.current = attempt;

    // Advance label every ~2s for UX — actual processing can take 10-20s
    const interval = setInterval(() => {
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }, 2200);

    // Pick up any client-side MediaPipe metrics stored by SwingUploader
    let mediapipeMetrics: Record<string, unknown> | undefined;
    try {
      const raw = sessionStorage.getItem(`mediapipe_${analysisId}`);
      if (raw) mediapipeMetrics = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // sessionStorage unavailable — proceed without metrics
    }

    // A4 (C1). An answer is acted on only while the report is still shown and still belongs to this browser's sign-in.
    const obsolete = (): boolean => {
      if (!mountedRef.current) return true;
      if (identityEndedRef.current === null) return false;
      clearInterval(interval);
      setIdentityNotice(true);
      return true;
    };

    void (async () => {
      // A4 (C1). The token of the account the report was rendered for, confirmed now — or nothing is sent.
      let confirmed: Awaited<ReturnType<typeof confirmOwnerSession>>;
      try {
        const managed = createClient();
        confirmed = await confirmOwnerSession(() => managed, ownerId, SESSION_READ_DEADLINE_MS);
      } catch {
        confirmed = { status: "unavailable" };
      }
      if (!mountedRef.current) return;
      // the browser's sign-in already ended or changed before anything was sent: nothing is sent, and the refusal says so
      const ended = identityEndedRef.current;
      if (ended !== null && confirmed.status === "ready") confirmed = { status: ended };
      if (confirmed.status !== "ready") {
        clearInterval(interval);
        setError(OWNER_REFUSAL_COPY[confirmed.status]);
        onFailed?.(true);
        return;
      }
      await fetch("/api/analyze-swing", {
        method: "POST",
        // the Bearer alone identifies the request; no cookie (possibly another sign-in's) goes with it
        credentials: "omit",
        headers: { "Content-Type": "application/json", ...ownerBearer(confirmed.session) },
        body: JSON.stringify({ analysisId, ...(mediapipeMetrics ? { mediapipeMetrics } : {}) }),
      })
      // A response that is not JSON (a gateway error page) is the service's
      // failure, not the golfer's connection.
      .then(async (r) => ({
        httpStatus: r.status,
        res: await r.json().catch(() => ({ error: SERVICE_FAILURE_COPY })),
      }))
      .then(({ httpStatus, res }) => {
        // A4 (C1): checked after the whole answer has been read
        if (obsolete()) return;
        clearInterval(interval);
        if (httpStatus === 409 && res.status === "processing") {
          setInProgressNotice(res.error ?? "This analysis is already in progress.");
        } else if (httpStatus === 409 && res.status === "stalled") {
          setStalledNotice(res.error ?? "This analysis was interrupted and can't be finished.");
          onStalled?.();
        } else if (res.error) {
          setVideoUnusable(res.status === VIDEO_UNUSABLE_STATUS);
          setError(res.error);
          onFailed?.(true);
        } else {
          // Clean up sessionStorage entry now that the API has consumed it
          try { sessionStorage.removeItem(`mediapipe_${analysisId}`); } catch { /* ignore */ }
          onComplete(res.data as AnalysisData);
        }
      })
      .catch(() => {
        if (obsolete()) return;
        clearInterval(interval);
        // A network failure surfaces as the browser's own text ("Failed to
        // fetch"), which tells a golfer nothing; the copy says what to do.
        setError(NETWORK_FAILURE_COPY);
        onFailed?.(true);
      });
    })();

    return () => clearInterval(interval);
  }, [analysisId, ownerId, onComplete, onStalled, onFailed, attempt]);

  if (identityNotice) {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-7 h-7 text-amber-400" />
        </div>
        <p className="text-white font-bold mb-2">Your sign-in changed</p>
        <p className="text-sm text-gray-400 mb-6" role="status">{IDENTITY_CHANGED_COPY}</p>
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-2 mx-auto px-5 py-2.5 min-h-[44px] rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Refresh page
        </button>
      </div>
    );
  }

  if (stalledNotice) {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-7 h-7 text-amber-400" />
        </div>
        <p className="text-white font-bold mb-2">Analysis Interrupted</p>
        <p className="text-sm text-gray-400 mb-6">{stalledNotice}</p>
        <a
          href="/analyze"
          className="inline-flex items-center justify-center gap-2 mx-auto px-5 py-2.5 min-h-[44px] rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          Record a new swing
        </a>
      </div>
    );
  }

  if (inProgressNotice) {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
          <Loader2 className="w-7 h-7 text-amber-400 animate-spin" />
        </div>
        <p className="text-white font-bold mb-2">Still Analysing</p>
        <p className="text-sm text-gray-400 mb-6">{inProgressNotice}</p>
        <button
          onClick={() => { setInProgressNotice(null); setStep(0); setAttempt((a) => a + 1); }}
          className="flex items-center gap-2 mx-auto px-5 py-2.5 min-h-[44px] rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Check again
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-7 h-7 text-red-400" />
        </div>
        <p className="text-white font-bold mb-2">Analysis Failed</p>
        <p className="text-sm text-red-400 mb-6">{error}</p>
        {videoUnusable ? (
          <a
            href="/analyze"
            className="inline-flex items-center justify-center gap-2 mx-auto px-5 py-2.5 min-h-[44px] rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            Upload a new video
          </a>
        ) : (
        <button
          onClick={() => { setError(null); onFailed?.(false); setStep(0); setAttempt((a) => a + 1); }}
          className="flex items-center gap-2 mx-auto px-5 py-2.5 min-h-[44px] rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Retry
        </button>
        )}
      </div>
    );
  }

  return (
    <div className="text-center py-16 max-w-sm mx-auto">
      <div className="relative w-16 h-16 mx-auto mb-6">
        <div className="absolute inset-0 rounded-full border-2 border-golf-green/20" />
        <div className="absolute inset-0 rounded-full border-t-2 border-golf-green animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <Zap className="w-6 h-6 text-golf-green" />
        </div>
      </div>

      <p className="text-[10px] font-black uppercase tracking-widest text-golf-green mb-2">
        AI Coach Active
      </p>
      <h3 className="text-lg font-black italic tracking-tighter uppercase text-white mb-6">
        Analysing Your Swing
      </h3>

      <div className="space-y-2.5 text-left">
        {STEPS.map((s, i) => (
          <div key={i} className="flex items-center gap-3">
            {i < step ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-golf-green shrink-0" />
            ) : i === step ? (
              <Loader2 className="w-3.5 h-3.5 text-golf-green animate-spin shrink-0" />
            ) : (
              <div className="w-3.5 h-3.5 rounded-full border border-white/[0.12] shrink-0" />
            )}
            <span className={`text-xs transition-colors ${i <= step ? "text-gray-300" : "text-gray-700"}`}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main report ───────────────────────────────────────────────────────────────

function CoachingReport({ analysis }: { analysis: AnalysisData }) {
  // S6-R1: a missing score is "not scored", never 0, and no ability label is
  // derived from a score that is an uncalibrated AI rubric estimate.
  const score = presentScore(analysis.score);
  const metrics = analysis.metrics ?? {};
  const highlights = analysis.swing_highlights ?? [];
  const deficiencies = analysis.mechanical_deficiencies ?? [];
  const [openDefIdx, setOpenDefIdx] = useState<number | null>(0);

  return (
    <div className="space-y-5">
      {/* Score + overall */}
      <div className="bg-golf-header border border-white/5 rounded-2xl p-6">
        <div className="flex items-start gap-5">
          {/* Score, with its basis */}
          <div className="shrink-0 text-center max-w-[7rem]">
            {score.scored ? (
              <div className="text-5xl font-black italic tabular-nums text-white">{score.value}</div>
            ) : (
              <div className="text-lg font-black uppercase tracking-widest text-gray-400">{UNSCORED_LABEL}</div>
            )}
          </div>

          <div className="flex-1 min-w-0 border-l border-white/[0.08] pl-5">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">
              {ASSESSMENT_LABEL}
            </p>
            <p className="text-sm text-gray-300 leading-relaxed">{analysis.feedback}</p>
          </div>
        </div>
        <p className="text-[10px] text-gray-500 leading-relaxed mt-4">
          {score.scored ? SCORE_BASIS : UNSCORED_COPY}
        </p>
        {metrics.scoring_breakdown && (
          <p className="text-[10px] text-gray-500 leading-relaxed mt-1">
            <span className="font-black uppercase tracking-widest text-gray-600">Scoring: </span>
            {metrics.scoring_breakdown}
          </p>
        )}
      </div>

      {/* What the video could not show (S6-R1) */}
      {metrics.evidence_limits && (
        <div className="bg-golf-header border border-white/5 rounded-2xl px-5 py-4">
          <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1">{EVIDENCE_LIMITS_LABEL}</p>
          <p className="text-sm text-gray-400 leading-relaxed">{metrics.evidence_limits}</p>
        </div>
      )}

      {/* Pro cue */}
      {metrics.pro_cue && (
        <div className="flex items-center gap-3 bg-amber-500/[0.06] border border-amber-500/20 rounded-2xl px-5 py-3.5">
          <Lightbulb className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-amber-400 mb-0.5">Pro Cue</p>
            <p className="text-sm font-semibold text-white italic">"{metrics.pro_cue}"</p>
          </div>
        </div>
      )}

      {/* The Feel */}
      {metrics.the_feel && (
        <div className="flex items-start gap-3 bg-golf-green/[0.05] border border-golf-green/20 rounded-2xl px-5 py-4">
          <Zap className="w-4 h-4 text-golf-green shrink-0 mt-0.5" />
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-1.5">The Feel</p>
            <p className="text-sm text-gray-200 leading-relaxed italic">"{metrics.the_feel}"</p>
          </div>
        </div>
      )}

      {/* Three pillars */}
      <div>
        <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-3">
          Structural Breakdown
        </p>
        <div className="space-y-2">
          {metrics.posture && (
            <PillarCard title="Posture & Setup" pillar={metrics.posture} openDefault />
          )}
          {metrics.swing_plane && (
            <PillarCard title="Swing Plane" pillar={metrics.swing_plane} />
          )}
          {metrics.impact && (
            <PillarCard title="Impact Position" pillar={metrics.impact} />
          )}
        </div>
      </div>

      {/* Highlights */}
      {highlights.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-3.5 h-3.5 text-golf-green" />
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600">
              What You're Doing Well
            </p>
          </div>
          <div className="space-y-2">
            {highlights.map((h, i) => (
              <div key={i} className="flex items-start gap-3 bg-golf-green/[0.05] border border-golf-green/15 rounded-xl px-4 py-3">
                <CheckCircle2 className="w-3.5 h-3.5 text-golf-green shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-white">{h.positive_movement}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">{h.mechanical_benefit}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deficiencies + drills */}
      {deficiencies.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600">
              Fault Diagnosis & Corrective Drills
            </p>
          </div>
          <div className="space-y-2">
            {deficiencies.map((d, i) => {
              const isOpen = openDefIdx === i;
              const isMajor = d.severity === "major";
              const location = assessedLocation(d);
              return (
                <div
                  key={i}
                  className={`border rounded-2xl overflow-hidden ${
                    isMajor ? "border-red-500/20" : d.severity === "minor" ? "border-amber-500/15" : "border-white/10"
                  }`}
                >
                  <button
                    onClick={() => setOpenDefIdx(isOpen ? null : i)}
                    className="w-full flex items-center justify-between px-5 py-4 text-left bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {d.severity !== null && (
                        <span className={`shrink-0 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                          isMajor
                            ? "bg-red-500/10 border-red-500/25 text-red-400"
                            : "bg-amber-500/10 border-amber-500/25 text-amber-400"
                        }`}>
                          {isMajor ? "Major" : "Minor"}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-white">{d.fault_description}</p>
                        {location && <p className="text-[11px] text-gray-500 truncate">{location}</p>}
                      </div>
                    </div>
                    {isOpen
                      ? <ChevronUp className="w-4 h-4 text-gray-600 shrink-0 ml-2" />
                      : <ChevronDown className="w-4 h-4 text-gray-600 shrink-0 ml-2" />
                    }
                  </button>

                  {isOpen && (
                    <div className="px-5 pb-5 border-t border-white/[0.06] pt-4 space-y-4">
                      <p className="text-sm text-gray-300 leading-relaxed">{d.fault_description}</p>
                      <div className="flex items-start gap-3 bg-white/[0.03] border border-white/[0.07] rounded-xl px-4 py-3">
                        <Dumbbell className="w-4 h-4 text-golf-green shrink-0 mt-0.5" />
                        <div>
                          <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-1">
                            {d.corrective_drill_title}
                          </p>
                          <p className="text-xs text-gray-400 leading-relaxed">
                            {d.corrective_drill_detail}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Practice focus */}
      {metrics.practice_focus && (
        <div className="flex items-start gap-3 bg-golf-header border border-white/5 rounded-2xl px-5 py-4">
          <Target className="w-4 h-4 text-golf-green shrink-0 mt-0.5" />
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1">
              This Week's Priority
            </p>
            <p className="text-sm text-gray-300">{metrics.practice_focus}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Video player ──────────────────────────────────────────────────────────────

function VideoPlayer({ signedUrl, filename }: { signedUrl: string | null; filename: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  };

  if (!signedUrl) {
    return (
      <div className="aspect-video bg-black/40 rounded-2xl border border-white/5 flex items-center justify-center">
        <p className="text-xs text-gray-600">Video unavailable</p>
      </div>
    );
  }

  return (
    <div className="relative group rounded-2xl overflow-hidden bg-black border border-white/5">
      <video
        ref={videoRef}
        src={signedUrl}
        className="w-full aspect-video object-contain bg-black"
        playsInline
        loop
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {/* Play/Pause overlay */}
      <button
        onClick={toggle}
        className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors"
        aria-label={playing ? "Pause" : "Play"}
      >
        <div className={`w-12 h-12 rounded-full bg-black/60 border border-white/20 flex items-center justify-center transition-opacity ${playing ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}>
          {playing
            ? <Pause className="w-5 h-5 text-white" />
            : <Play className="w-5 h-5 text-white ml-0.5" />
          }
        </div>
      </button>
      {filename && (
        <div className="absolute bottom-0 left-0 right-0 px-4 py-2 bg-gradient-to-t from-black/80 to-transparent">
          <p className="text-[10px] text-gray-400 truncate">{filename}</p>
        </div>
      )}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function AnalysisReport({ analysis: initialAnalysis, videoSignedUrl, clubDisplayName, failedReason = null }: Props) {
  const [analysis, setAnalysis] = useState<AnalysisData>(initialAnalysis);
  // A4 (C1). The account (and session lineage) this report was rendered for, as the dashboard layout verified it —
  // taken once, when the report first renders, and never replaced by a session the browser holds
  // (components/navigation/SessionKeeper.tsx RenderedSessionProvider). No account: nothing is sent.
  const rendered = useRenderedSession();
  const ownerRef = useRef<string | null>(rendered?.ownerId ?? null);
  const lineageRef = useRef<string | null>(rendered?.lineage ?? null);
  // When true, force the ProcessingState even if the DB row is already "complete"
  const [forceReanalyze, setForceReanalyze] = useState(false);

  const isPending    = analysis.status === "pending";
  const isProcessing = analysis.status === "processing";
  const isComplete   = analysis.status === "complete";
  const isFailed     = analysis.status === "failed";
  // ENT-1D. Set when the server reports the analysis stalled, so the status
  // pill agrees with the body.
  const [isStalled, setIsStalled] = useState(false);
  // Set while this page's own request is showing a failure.
  const [failedNow, setFailedNow] = useState(false);

  const showProcessing = isPending || isProcessing || forceReanalyze;

  return (
    <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
      {/* ── Left: video + metadata ── */}
      <div className="w-full lg:w-[420px] lg:sticky lg:top-6 shrink-0 space-y-4">
        <VideoPlayer
          signedUrl={videoSignedUrl}
          filename={analysis.swing_video?.original_filename ?? null}
        />

        {/* Metadata pill */}
        <div className="bg-golf-header border border-white/5 rounded-2xl px-5 py-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-0.5">Club</p>
            <p className="text-sm font-bold text-white capitalize">
              {clubDisplayName ?? "Unknown"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-0.5">Status</p>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${
              isComplete ? "bg-golf-green/10 border-golf-green/25 text-golf-green" :
              isFailed || (failedNow && !isStalled) ? "bg-red-500/10 border-red-500/25 text-red-400" :
                           "bg-amber-500/10 border-amber-500/25 text-amber-400"
            }`}>
              {isStalled ? "interrupted" : failedNow ? "failed" : analysis.status}
            </span>
          </div>
        </div>

        {/* ENT-1A/1C: a completed analysis is never re-run by the server, so no
            re-analyze action is offered for one. */}
      </div>

      {/* ── Right: report ── */}
      <div className="flex-1 min-w-0">
        {showProcessing && (
          <ProcessingState
            key={forceReanalyze ? "reanalyze" : "initial"}
            analysisId={analysis.id}
            ownerId={ownerRef.current}
            lineage={lineageRef.current}
            renderedOwner={rendered?.ownerId ?? null}
            onComplete={(data) => { setForceReanalyze(false); setFailedNow(false); setAnalysis(data); }}
            onStalled={() => setIsStalled(true)}
            onFailed={setFailedNow}
          />
        )}

        {isFailed && !showProcessing && failedReason === VIDEO_UNUSABLE_STATUS && (
          <div className="text-center py-16 max-w-sm mx-auto">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <p className="text-white font-bold mb-2">Analysis Failed</p>
            <p className="text-sm text-red-400 mb-6">{VIDEO_UNUSABLE_COPY}</p>
            <a
              href="/analyze"
              className="inline-flex items-center justify-center gap-2 mx-auto px-5 py-2.5 min-h-[44px] rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              Upload a new video
            </a>
          </div>
        )}

        {isFailed && !showProcessing && failedReason !== VIDEO_UNUSABLE_STATUS && (
          <div className="text-center py-16 max-w-sm mx-auto">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <p className="text-white font-bold mb-2">Analysis Failed</p>
            <p className="text-sm text-gray-500">There was an error processing your swing. Tap Retry to try again.</p>
            <button
              onClick={() => setForceReanalyze(true)}
              className="mt-4 flex items-center gap-2 mx-auto px-5 py-2.5 min-h-[44px] rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        )}

        {isComplete && !showProcessing && <CoachingReport analysis={analysis} />}
      </div>
    </div>
  );
}
