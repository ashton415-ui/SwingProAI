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

const NETWORK_FAILURE_COPY = "We couldn't reach SwingProAI. Check your connection, then check this swing's status before trying again.";
const SERVICE_FAILURE_COPY = "Analysis is temporarily unavailable. Please try again shortly.";
// F1 (AG-WEB-READY-04): an answer that is not the route's JSON (a gateway page, a cut-off body) says nothing about the
// analysis itself: its outcome is unknown, so the page says so and keeps the status it last knew.
const UNKNOWN_OUTCOME_COPY = "We couldn't confirm what happened with this request. Your swing is saved. Check its current status before trying again.";
// F1 review (QA B1 / security F-6): the route answers a readable 500 (and, to this page's request, a 400) after an attempt
// that may have recorded the analysis as failed (a provider or save failure) — or before anything was recorded (a read
// error). The page cannot tell which, so it claims neither: the stored status is shown as unconfirmed until a reload.
const ATTEMPT_COPY = "This attempt didn't complete, so its result isn't confirmed. Your swing is saved. Check this analysis's current status before trying again.";
// F1 review (QA S2): a 401 means this request's sign-in was not accepted; nothing was analyzed.
const SIGN_IN_AGAIN_COPY = "We couldn't confirm your sign-in for this request, so nothing was analyzed. Sign in again, then retry.";
// F1-A1 (R2): a refusal whose answer carries no readable message of its own.
const REFUSED_COPY = "This request wasn't accepted. Your swing is saved.";
// F1-A1 (R1): after a 503, an unreachable server or an unreadable answer the page cannot know whether the saved status
// changed (the route sends the same 503 body before a claim and after an undispatched claim was released as failed, by
// design without saying which). It keeps showing the status it last knew, labelled as such, and invents nothing.
const LAST_KNOWN_LABEL = "Last known status";
const LAST_KNOWN_NOTE = "Not confirmed since this request. Check status to read it.";

/**
 * F1-A1: what the page knows about the saved status after this page's latest request. `null`: what the server rendered
 * or a completed answer returned. "last_known": the request may or may not have changed it (shown with its label).
 * "unconfirmed": the request may have recorded a failure (a readable 500, or a 400 to this page's request).
 */
export type StatusNote = "last_known" | "unconfirmed";

/**
 * F1 (AG-WEB-READY-04): what the latest request of this page ended with, kept apart from the analysis's stored status.
 * Only "unusable" is the server reporting the stored analysis as failed (its video cannot be read); every other kind
 * describes this request alone: a refused or unavailable request, an unreachable server or an unreadable answer never
 * turns a pending analysis into a failed one on this page.
 */
type RequestProblem = "identity" | "signin" | "unavailable" | "network" | "unknown" | "refused" | "attempt" | "unusable";
const PROBLEM_HEADING: Readonly<Record<RequestProblem, string>> = {
  identity: "Sign-in not confirmed",
  signin: "Sign-in not confirmed",
  unavailable: "Analysis unavailable right now",
  network: "Couldn't reach SwingProAI",
  unknown: "Result not confirmed",
  refused: "Request not accepted",
  attempt: "This attempt didn't complete",
  unusable: "Analysis Failed",
};

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

// 09-P1: what the report says before any request of its own, and while one is out. Nothing here claims progress the
// page cannot know: a saved "processing" status is only what was last recorded.
const PENDING_COPY = "Your swing is saved. It's analyzed only when you choose to start.";
const STORED_FAILURE_COPY = "There was an error processing your swing. You can retry the analysis.";
const PROCESSING_COPY =
  "This swing's analysis was started, but no result has been saved yet. This page doesn't start or follow the analysis: check its status to read the latest saved result. If it still shows processing after several minutes, the analysis may have stopped and need recovery.";
const OTHER_STATUS_COPY = "Check its status to read the latest saved result.";
// 09-P1-A1: shown from the press on, through the owner (sign-in) confirmation and the request itself; it describes both
// phases and claims neither that the request was sent nor that the analysis is running
const SENDING_HEADING = "Starting Your Analysis";
const SENDING_COPY = "We're confirming your sign-in and starting this swing's analysis. It can take a minute: keep this page open to see the result here.";
// review (security note): an earlier view may have been left before its request was sent, so this claims no request
const SENT_EARLIER_COPY = "An analysis started for this swing from an earlier view in this browser tab hasn't finished yet. Check its status to read the latest saved result.";
const CHECK_STATUS_LABEL = "Check status";

// 09-P1: every control here is a labelled, keyboard-operable button or link with a visible focus outline and a 44x44 px
// minimum target.
const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
const SECONDARY_ACTION = `flex items-center justify-center gap-2 mx-auto px-5 py-2.5 min-h-11 min-w-11 rounded-xl border border-white/10 text-sm font-bold text-gray-300 hover:text-white hover:bg-white/5 transition-colors ${FOCUS_RING} focus-visible:outline-golf-green`;
const SECONDARY_LINK = `inline-flex items-center justify-center gap-2 mx-auto px-5 py-2.5 min-h-11 min-w-11 rounded-xl border border-white/10 text-sm font-bold text-gray-300 hover:text-white hover:bg-white/5 transition-colors ${FOCUS_RING} focus-visible:outline-golf-green`;
const PRIMARY_ACTION = `flex items-center justify-center gap-2 mx-auto px-6 py-2.5 min-h-11 min-w-11 rounded-xl bg-golf-green text-golf-dark text-sm font-black uppercase tracking-widest hover:bg-[#22C55E] transition-colors ${FOCUS_RING} focus-visible:outline-white`;

/**
 * 09-P1: analyses with a deliberate request from this browser tab still unanswered. Module scope, so neither a re-render
 * nor a remount of the report (leaving it and opening it again while the request runs) can send a second one; an entry
 * is removed when its request settles. A guarantee of this tab only: durable deduplication across clients and any
 * spend limit belong to the server.
 */
const requestsInFlight = new Set<string>();

/**
 * 09-P1: a fresh, owner-authorized read of the saved status: the report page's own server read
 * (app/(dashboard)/analyze/[id]/page.tsx: the signed-in owner's row, its entitlement-checked result), by a normal reload.
 * Never an analysis request.
 */
function checkSavedStatus() {
  window.location.reload();
}

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

/**
 * F1-A1 (R2): the completed analysis an answer carries, only when it is exactly that: an object for the analysis this
 * page asked about, completed, with the containers this view renders in their expected form (each may be null). Any other
 * body (empty, `{error: ""}`, missing/null/array data, another analysis, a status other than complete) replaces nothing.
 * The fields this view renders as text must be text when present (an object there could not be rendered); nothing
 * else is validated: the server returns its own sanitised record (lib/analysis-result-read-authority.ts), which passes.
 */
function completedAnalysis(data: unknown, analysisId: string): AnalysisData | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.id !== analysisId || d.status !== "complete") return null;
  const absent = (v: unknown) => v === null || v === undefined;
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const text = (o: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => absent(o[k]) || typeof o[k] === "string");
  const listOf = (v: unknown, ok: (item: Record<string, unknown>) => boolean) => absent(v) || (Array.isArray(v) && v.every((item) => record(item) && ok(item)));
  const highlightOk = (h: Record<string, unknown>) => text(h, ["checkpoint", "positive_movement", "mechanical_benefit"]);
  // a location is direct text, or an object whose joint is text (or absent / null): its label is joined as text
  const jointOk = (v: unknown) => absent(v) || typeof v === "string" || (record(v) && text(v, ["joint"]));
  // the severity chip shows "Major" for "major" and "Minor" for anything else that is not null: only the server's own
  // values (assessedSeverity: "minor", "major" or null) may reach it, so no severity is invented
  const severityOk = (v: unknown) => v === null || v === "minor" || v === "major";
  const deficiencyOk = (f: Record<string, unknown>) =>
    text(f, ["checkpoint", "fault_description", "corrective_drill_title", "corrective_drill_detail"])
    && severityOk(f.severity)
    && jointOk(f.joint_coordinate);
  const pillarOk = (v: unknown) => absent(v) || (record(v) && text(v, ["rating", "observation", "correction"]));
  const metricsOk = (v: unknown) => absent(v) || (record(v)
    && text(v, ["scoring_breakdown", "evidence_limits", "practice_focus", "pro_cue", "the_feel"])
    && pillarOk(v.posture) && pillarOk(v.swing_plane) && pillarOk(v.impact));
  if (!listOf(d.swing_highlights, highlightOk) || !listOf(d.mechanical_deficiencies, deficiencyOk) || !metricsOk(d.metrics)) return null;
  // the player renders the video's filename as text (absent / null: none shown)
  if (!absent(d.swing_video) && !(record(d.swing_video) && text(d.swing_video, ["original_filename"]))) return null;
  if (!absent(d.feedback) && typeof d.feedback !== "string") return null;
  return d as unknown as AnalysisData;
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

// ── Status and analysis request ───────────────────────────────────────────────

/**
 * 09-P1. What the report offers for an analysis that is not complete. Opening, refreshing or returning to the report never
 * sends an analysis request: the page shows the status the server read and saved, and only the golfer's deliberate press
 * sends one ("Analyze swing" for a pending swing, "Retry analysis" for a stored failure), confirmed as the rendered owner
 * first (A4 C1). Checking progress is a fresh owner-authorized read of the saved status (the report page's own server
 * read, by a normal reload), never an analysis request. A stored "processing" row is shown as exactly that: it does not
 * prove the analysis is still running (its lease may have expired), so nothing here claims progress.
 */
function ProcessingState({
  analysisId,
  storedStatus,
  ownerId,
  lineage,
  renderedOwner,
  onComplete,
  onStalled,
  onStoredFailure,
  onStatusNote,
}: {
  analysisId: string;
  /** 09-P1: the analysis's saved status as this page last read it (the server render, or a completed answer) */
  storedStatus: string;
  /** A4: the account this report was rendered for (taken once), or null outside the dashboard layout: nothing is sent */
  ownerId: string | null;
  /** A4: the session lineage the report was rendered for; its End Session ends this report's view */
  lineage: string | null;
  /** A4: the account the enclosing layout is rendered for now (a re-render for another account ends this view) */
  renderedOwner: string | null;
  onComplete: (data: AnalysisData) => void;
  onStalled?: () => void;
  // F1: called only when the server reports the stored analysis failed (its video cannot be read), so the status pill
  // shows "failed" for that and nothing else; a request that was refused, unavailable or unanswered leaves the pill on
  // the status the page last knew.
  onStoredFailure?: () => void;
  /** F1-A1: what this request leaves known about the saved status (see StatusNote) */
  onStatusNote?: (note: StatusNote) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  // F1: what kind of outcome `error` describes (its heading and recovery action); never a stored status by itself.
  const [problem, setProblem] = useState<RequestProblem>("attempt");
  // 09-P1: the way forward after `error`. "retry" only when the outcome is certain and nothing was analyzed (the request
  // was never sent, its sign-in was not accepted, or it was refused outright); after any outcome that may have changed
  // the saved status the page offers a fresh status read first, and an eligible status then offers its own action.
  const [recovery, setRecovery] = useState<"retry" | "check">("retry");
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
  // 09-P1: a deliberate request of this view is out. The ref is the guard (set before anything is awaited, so a second
  // activation in the same tick sends nothing); the state only shows it.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  // 09-P1: a request for this analysis sent by an earlier view in this tab (left and opened again while it runs) is
  // still out: this view sends none and offers a status read.
  const [sentEarlier] = useState(() => requestsInFlight.has(analysisId));

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

  /**
   * 09-P1: the golfer's deliberate analysis request — the only way this report sends one. At most one request per
   * accepted press: a second activation while one is out (a double press, a re-render, or this analysis's report opened
   * again in this tab) sends nothing. This is a guarantee of this page in this tab only; the server's execution claim
   * (lib/analysis-execution-claim.ts) is what keeps simultaneous requests from running the analysis twice.
   */
  const requestAnalysis = () => {
    if (sendingRef.current || requestsInFlight.has(analysisId)) return;
    sendingRef.current = true;
    requestsInFlight.add(analysisId);
    setError(null);
    setInProgressNotice(null);
    setSending(true);

    // Pick up any client-side MediaPipe metrics stored for this analysis before it was opened
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
      setIdentityNotice(true);
      return true;
    };

    void (async () => {
      try {
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
          setProblem("identity"); // nothing was sent: the analysis is exactly as it was
          setRecovery("retry");
          setError(OWNER_REFUSAL_COPY[confirmed.status]);
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
        .then(async (r) => {
          let readable = true;
          let res = await r.json().catch(() => {
            readable = false;
            return { error: SERVICE_FAILURE_COPY };
          });
          // valid JSON that is not the route's answer (null, a list, an error that is not text) is not read as one
          if (res === null || typeof res !== "object" || Array.isArray(res) || ("error" in res && typeof res.error !== "string")) {
            readable = false;
            res = { error: SERVICE_FAILURE_COPY };
          }
          // F1-A1: the route reports a stored, unusable video only with 422; the same field with any other status is not that
          if (r.status !== 422 && res.status === VIDEO_UNUSABLE_STATUS) res = { ...res, status: null };
          return { httpStatus: r.status, res, readable };
        })
        .then(({ httpStatus, res, readable }) => {
          // A4 (C1): checked after the whole answer has been read
          if (obsolete()) return;
          if (httpStatus === 409 && res.status === "processing") {
            setInProgressNotice(res.error ?? "This analysis is already in progress.");
            onStatusNote?.("last_known"); // the server reports work in progress: the pending shown is only what the page last knew
          } else if (httpStatus === 409 && res.status === "stalled") {
            setStalledNotice(res.error ?? "This analysis was interrupted and can't be finished.");
            onStalled?.();
          } else if (!(httpStatus >= 200 && httpStatus < 300) || !readable || "error" in res) {
            // an error answer, an unreadable one, or a 2xx that carries an error: never a completion (R2)
            setVideoUnusable(res.status === VIDEO_UNUSABLE_STATUS);
            const unusable = res.status === VIDEO_UNUSABLE_STATUS;
            // F1: the kind of outcome decides the heading and action; only the server's video-unusable answer reports
            // the stored analysis as failed.
            // F1 review: a readable 500 (other than 503) or 400 may follow a recorded failure — the stored status is then
            // unconfirmed (never asserted pending, never invented failed). A 503 is shown as unavailable and keeps the last
            // known status (the work order's rule for 503): most 503s refuse before the claim, but two answered after a
            // claim that could not be dispatched also record the analysis failed (route.ts, undispatched release) — the
            // status shown can then lag until the golfer checks it.
            const kind: RequestProblem =
              unusable ? "unusable"
              : !readable || (httpStatus >= 200 && httpStatus < 300) ? "unknown"
              : httpStatus === 503 ? "unavailable"
              : httpStatus === 401 ? "signin"
              : httpStatus >= 500 || httpStatus === 400 ? "attempt"
              : "refused";
            // the route's own message only when it is one (an empty or missing error is never shown as text)
            const routeCopy = typeof res.error === "string" && res.error.trim() !== "" ? res.error : null;
            setProblem(kind);
            // 09-P1: only an outcome that changed nothing offers a new attempt here; any other offers a status read first
            setRecovery(kind === "signin" || (kind === "refused" && httpStatus !== 404 && httpStatus !== 409) ? "retry" : "check");
            setError(
              kind === "unknown" ? UNKNOWN_OUTCOME_COPY
              : kind === "attempt" ? ATTEMPT_COPY
              : kind === "signin" ? SIGN_IN_AGAIN_COPY
              : kind === "unavailable" ? routeCopy ?? SERVICE_FAILURE_COPY
              : routeCopy ?? REFUSED_COPY,
            );
            if (unusable) onStoredFailure?.();
            else if (kind === "attempt") onStatusNote?.("unconfirmed");
            else if (kind === "unavailable" || kind === "unknown" || (kind === "refused" && (httpStatus === 404 || httpStatus === 409))) onStatusNote?.("last_known");
          } else {
            // F1-A1 (R2): only the completed analysis this page asked about replaces it
            const completed = completedAnalysis((res as { data?: unknown }).data, analysisId);
            if (completed === null) {
              setProblem("unknown");
              setRecovery("check");
              setError(UNKNOWN_OUTCOME_COPY);
              onStatusNote?.("last_known");
              return;
            }
            // Clean up sessionStorage entry now that the API has consumed it
            try { sessionStorage.removeItem(`mediapipe_${analysisId}`); } catch { /* ignore */ }
            onComplete(completed);
          }
        })
        .catch(() => {
          if (obsolete()) return;
          // A network failure surfaces as the browser's own text ("Failed to
          // fetch"), which tells a golfer nothing; the copy says what to do.
          setProblem("network"); // the request may or may not have arrived: the page shows the status it last knew, as such
          setRecovery("check");
          setError(NETWORK_FAILURE_COPY);
          onStatusNote?.("last_known");
        });
      } finally {
        requestsInFlight.delete(analysisId);
        sendingRef.current = false;
        if (mountedRef.current) setSending(false);
      }
    })();
  };

  if (identityNotice) {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-7 h-7 text-amber-400" />
        </div>
        <p className="text-white font-bold mb-2">Your sign-in changed</p>
        <p className="text-sm text-gray-400 mb-6" role="status">{IDENTITY_CHANGED_COPY}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={SECONDARY_ACTION}
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Refresh page
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
          className={SECONDARY_LINK}
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
        <p className="text-sm text-gray-400 mb-6" role="status">{inProgressNotice}</p>
        {/* 09-P1: a fresh read of the saved status, never another analysis request */}
        <button
          type="button"
          onClick={checkSavedStatus}
          className={SECONDARY_ACTION}
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Check again
        </button>
      </div>
    );
  }

  if (error) {
    const stored = problem === "unusable";
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 ${stored ? "bg-red-500/10 border border-red-500/20" : "bg-amber-500/10 border border-amber-500/20"}`}>
          <AlertCircle className={`w-7 h-7 ${stored ? "text-red-400" : "text-amber-400"}`} />
        </div>
        <p className="text-white font-bold mb-2">{PROBLEM_HEADING[problem]}</p>
        <p role={stored ? undefined : "status"} className={`text-sm mb-6 ${stored ? "text-red-400" : "text-gray-300"}`}>{error}</p>
        {videoUnusable ? (
          <a
            href="/analyze"
            className={SECONDARY_LINK}
          >
            Upload a new video
          </a>
        ) : (
        <button
          type="button"
          onClick={recovery === "check" ? checkSavedStatus : requestAnalysis}
          className={SECONDARY_ACTION}
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> {recovery === "check" ? CHECK_STATUS_LABEL : "Retry"}
        </button>
        )}
        {problem === "signin" && (
          <a
            href="/login"
            className={`mt-3 ${SECONDARY_LINK}`}
          >
            Sign in
          </a>
        )}
      </div>
    );
  }

  if (sending) {
    // 09-P1 / A1: from the golfer's press until its answer (the sign-in check, then the request). No progress stages are
    // invented: the page knows only that it is confirming the sign-in or waiting for the request.
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mx-auto mb-4">
          <Loader2 className="w-7 h-7 text-golf-green animate-spin" />
        </div>
        <h3 className="text-lg font-black italic tracking-tighter uppercase text-white mb-2">
          {SENDING_HEADING}
        </h3>
        <p className="text-sm text-gray-400" role="status">{SENDING_COPY}</p>
      </div>
    );
  }

  if (sentEarlier) {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-7 h-7 text-amber-400" />
        </div>
        <p className="text-white font-bold mb-2">Earlier request not finished</p>
        <p className="text-sm text-gray-400 mb-6" role="status">{SENT_EARLIER_COPY}</p>
        <button type="button" onClick={checkSavedStatus} className={SECONDARY_ACTION}>
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> {CHECK_STATUS_LABEL}
        </button>
      </div>
    );
  }

  // 09-P1: no request from this view yet: the saved status as read, and the one action that fits it.
  if (storedStatus === "pending") {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mx-auto mb-4">
          <Zap className="w-7 h-7 text-golf-green" />
        </div>
        <p className="text-white font-bold mb-2">Not analyzed yet</p>
        <p className="text-sm text-gray-400 mb-6">{PENDING_COPY}</p>
        <button type="button" onClick={requestAnalysis} className={PRIMARY_ACTION}>
          <Zap className="w-3.5 h-3.5" aria-hidden="true" /> Analyze swing
        </button>
      </div>
    );
  }

  if (storedStatus === "failed") {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-7 h-7 text-red-400" />
        </div>
        <p className="text-white font-bold mb-2">Analysis Failed</p>
        <p className="text-sm text-gray-500 mb-6">{STORED_FAILURE_COPY}</p>
        <button type="button" onClick={requestAnalysis} className={SECONDARY_ACTION}>
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Retry analysis
        </button>
      </div>
    );
  }

  // "processing", or a status this page does not know: shown as saved, with a fresh read of it
  return (
    <div className="text-center py-16 max-w-sm mx-auto">
      <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
        <AlertCircle className="w-7 h-7 text-amber-400" />
      </div>
      <p className="text-white font-bold mb-2">{storedStatus === "processing" ? "Analysis not finished" : "Analysis not complete"}</p>
      <p className="text-sm text-gray-400 mb-6">{storedStatus === "processing" ? PROCESSING_COPY : OTHER_STATUS_COPY}</p>
      <button type="button" onClick={checkSavedStatus} className={SECONDARY_ACTION}>
        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> {CHECK_STATUS_LABEL}
      </button>
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

  const isComplete   = analysis.status === "complete";
  const isFailed     = analysis.status === "failed";
  // ENT-1D. Set when the server reports the analysis stalled, so the status
  // pill agrees with the body.
  const [isStalled, setIsStalled] = useState(false);
  // F1: set only when this page's request was answered that the stored analysis failed (its video cannot be read). A
  // refused, unavailable, unreachable or unreadable request never changes the status the page shows.
  const [storedFailedNow, setStoredFailedNow] = useState(false);
  // F1-A1: what this page's requests leave known about the saved status (StatusNote); cleared only by completed data.
  // "unconfirmed" (a failure may have been recorded) is not weakened by a later "last_known" answer.
  const [statusNote, setStatusNote] = useState<StatusNote | null>(null);
  const lastKnown = statusNote === "last_known" && !storedFailedNow && !isStalled;

  // 09-P1: every analysis that is not complete gets the status panel (its saved status and, where eligible, the golfer's
  // explicit analysis action); a stored failure whose video cannot be analysed gets the upload-again guidance instead.
  // Showing either sends nothing.
  const showProcessing = !isComplete && !(isFailed && failedReason === VIDEO_UNUSABLE_STATUS);

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
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-0.5">{lastKnown ? LAST_KNOWN_LABEL : "Status"}</p>
            <span aria-describedby={lastKnown ? "report-status-note" : undefined} className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${
              isComplete ? "bg-golf-green/10 border-golf-green/25 text-golf-green" :
              statusNote === "unconfirmed" && !storedFailedNow && !isStalled ? "bg-amber-500/10 border-amber-500/25 text-amber-400" :
              isFailed || (storedFailedNow && !isStalled) ? "bg-red-500/10 border-red-500/25 text-red-400" :
                           "bg-amber-500/10 border-amber-500/25 text-amber-400"
            }`}>
              {isStalled ? "interrupted" : storedFailedNow ? "failed" : statusNote === "unconfirmed" ? "unconfirmed" : analysis.status}
            </span>
            {lastKnown && <p id="report-status-note" className="mt-1.5 text-xs text-gray-300 max-w-[11rem] ml-auto">{LAST_KNOWN_NOTE}</p>}
          </div>
        </div>

        {/* ENT-1A/1C: a completed analysis is never re-run by the server, so no
            re-analyze action is offered for one. */}
      </div>

      {/* ── Right: report ── */}
      <div className="flex-1 min-w-0">
        {showProcessing && (
          <ProcessingState
            analysisId={analysis.id}
            storedStatus={analysis.status}
            ownerId={ownerRef.current}
            lineage={lineageRef.current}
            renderedOwner={rendered?.ownerId ?? null}
            onComplete={(data) => { setStoredFailedNow(false); setStatusNote(null); setAnalysis(data); }}
            onStalled={() => setIsStalled(true)}
            onStoredFailure={() => setStoredFailedNow(true)}
            onStatusNote={(note) => setStatusNote((known) => (known === "unconfirmed" ? known : note))}
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
              className={SECONDARY_LINK}
            >
              Upload a new video
            </a>
          </div>
        )}

        {isComplete && !showProcessing && <CoachingReport analysis={analysis} />}
      </div>
    </div>
  );
}
