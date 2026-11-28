"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import {
  CheckCircle2, AlertTriangle, Clock, Upload, Loader2,
  ChevronRight, Zap, Target, RotateCcw, Award, LogIn,
} from "lucide-react";
import { createClient as createSharedBrowserClient } from "@/utils/supabase/client";
import { watchSessionEnd } from "@/utils/supabase/session-publication";
import { DRILL_HUB_UNAVAILABLE_COPY, type DrillHubLoader } from "@/lib/golfer-journey-read-state";
import {
  acquireDrillHubSession, createDrillHubSessionLoader, clientForDrillHubSession, readDrillVerifyResult,
  drillHubIdentityEnd, drillHubIdentityEndFromEvent, drillHubSessionUserId, drillUploadRefusal, drillVerifyRefusal,
  DRILL_VERIFY_COPY, DRILL_HUB_IDENTITY_COPY, DRILL_HUB_UNCONFIRMED_COPY, type DrillHubSessionResult,
  type DrillHubSession, type DrillHubIdentityEnd, type DrillVerifyMessage, type DrillVerifyResult,
} from "@/lib/drill-hub-session";

// ─── Session (AG-WEB-READY-01) ─────────────────────────────────────────────────
// The session comes from the shared browser client, which owns the session cookie (whole or chunked) and refreshes a
// session that is about to expire. This page never reads a cookie itself (see lib/drill-hub-session.ts).
function sharedClient() {
  return createSharedBrowserClient();
}

/** The page's listener for each acquisition's outcome (set while the page is mounted): an unconfirmed sign-in. */
let noteAcquisition: ((result: DrillHubSessionResult) => void) | null = null;

function currentSession() {
  return acquireDrillHubSession(sharedClient).then((result) => {
    noteAcquisition?.(result);
    return result;
  });
}

/**
 * A client bound to exactly one acquired session: its reads and the upload carry that access token, with no
 * anonymous fallback and no session storage or Auth client of its own.
 */
function clientForSession(session: DrillHubSession) {
  return clientForDrillHubSession(session, process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}

/** Attaches a read's cancellation signal (the client's own `.abortSignal`) without changing the query. */
function cancellable<Q extends { abortSignal(signal: AbortSignal): Q }>(query: Q, signal: AbortSignal): Q {
  return query.abortSignal(signal);
}

// ─── Types ──────────────────────────────────────────────────────────────────────
interface Drill {
  id: string;
  name: string;
  target_metric: string;
  the_why: string;
  the_how: string;
  the_feel: string;
}

interface UserDrill {
  drill_id: string;
  status: "pending" | "submitted" | "verified" | "needs_work";
  latest_ai_feedback: string | null;
}

// ─── Status helpers ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  verified:  { label: "Verified",    color: "text-golf-green",  bg: "bg-golf-green/10 border-golf-green/20",  icon: CheckCircle2 },
  needs_work:{ label: "Needs Work",  color: "text-amber-400",   bg: "bg-amber-400/10 border-amber-400/20",    icon: AlertTriangle },
  pending:   { label: "Pending",     color: "text-gray-500",    bg: "bg-white/5 border-white/10",             icon: Clock },
  submitted: { label: "Submitted",   color: "text-blue-400",    bg: "bg-blue-400/10 border-blue-400/20",      icon: Loader2 },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.pending;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-widest ${cfg.color} ${cfg.bg}`}>
      <Icon size={9} />
      {cfg.label}
    </span>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────────
export default function DrillsPage() {
  const [drills, setDrills]         = useState<Drill[]>([]);
  const [userDrills, setUserDrills] = useState<UserDrill[]>([]);
  // Catalog + progress read state. "unavailable" shows no drills, statuses or
  // counts: unknown progress is never presented as pending or zero verified.
  // "signed_out" / "account_changed" (R1): the browser's sign-in ended or now
  // belongs to another account; nothing of the previous golfer's is shown.
  const [hubPhase, setHubPhase]       = useState<"loading" | "ready" | "unavailable" | DrillHubIdentityEnd>("loading");
  const [failedLoads, setFailedLoads] = useState(0);
  const [retryRefused, setRetryRefused] = useState(false);
  const [notSent, setNotSent]         = useState(false);
  // The last session read was refused because the browser could not confirm its sign-in: say that signing in again helps
  const [unconfirmed, setUnconfirmed] = useState(false);
  const hubLoaderRef = useRef<DrillHubLoader | null>(null);
  const headingRef   = useRef<HTMLHeadingElement>(null);
  const endHeadingRef = useRef<HTMLHeadingElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Set once, synchronously, when the hub ends; read after every await so nothing started earlier shows afterwards.
  const identityEndRef = useRef<DrillHubIdentityEnd | null>(null);

  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [videoFile, setVideoFile]         = useState<File | null>(null);
  const [isVerifying, setIsVerifying]     = useState(false);
  const [uploadPhase, setUploadPhase]     = useState<"checking" | "uploading" | "analyzing" | null>(null);
  const [verifyResult, setVerifyResult]   = useState<DrillVerifyResult | null>(null);
  const [verifyError, setVerifyError]     = useState<string | null>(null);
  // Set synchronously: a second press before React re-renders the disabled button must not start a second submission.
  const verifyingRef = useRef(false);
  // The golfer whose drills and progress are shown (set by the first load that had a session, never changed after).
  // A session that belongs to anyone else ends the hub instead of mixing into this golfer's list.
  const hubUserRef = useRef<string | null>(null);
  // The golfer the browser was last seen signed in as (shared-client events and session checks), so a change that
  // happens before the first load finishes still ends the hub instead of letting that load show the old golfer.
  const seenUserRef = useRef<string | null>(null);
  // The drill on screen now, so a check that finishes after the golfer moved on is not shown under another drill.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // ── Sign-out or account change: clear everything at once, for good ────────
  // The load in flight is cancelled and can never publish; a submission still
  // running shows nothing when it finishes (it reads identityEndRef after every await).
  const endIdentity = useCallback((end: DrillHubIdentityEnd, videoNotSent = false) => {
    if (identityEndRef.current !== null) return;
    identityEndRef.current = end;
    hubLoaderRef.current?.dispose();
    hubLoaderRef.current = null;
    setDrills([]);
    setUserDrills([]);
    setSelectedId(null);
    setVideoFile(null);
    setVerifyResult(null);
    setVerifyError(null);
    setRetryRefused(false);
    setNotSent(videoNotSent);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setHubPhase(end);
  }, []);

  useEffect(() => {
    noteAcquisition = (result) => setUnconfirmed(result.status === "unavailable" && result.unconfirmed === true);
    return () => {
      noteAcquisition = null;
    };
  }, []);

  // ── Fetch data on mount; "Try again" reuses this loader (reads only) ───────
  useEffect(() => {
    const loader = createDrillHubSessionLoader<Drill, UserDrill>(
      // Progress belongs to a signed-in golfer. Both reads wait for one session
      // from the shared client and then carry exactly its access token. Without
      // a usable session neither read starts: an anonymous progress read would
      // return no rows — every drill "pending", 0 verified.
      currentSession,
      (session, readSignal) => {
        const supabase = clientForSession(session);
        // readSignal cancels a read once its companion has failed (or on unmount, or when the hub ends).
        return {
          catalog: () => cancellable(supabase.from("drills").select("id, name, target_metric, the_why, the_how, the_feel").eq("drill_family", "full_swing").order("name"), readSignal),
          progress: () => cancellable(supabase.from("user_drills").select("drill_id, status, latest_ai_feedback"), readSignal),
        };
      },
      () => hubUserRef.current ?? seenUserRef.current,
      (state) => {
        if (identityEndRef.current !== null) return; // an ended hub's loader is disposed; never restore anything
        if (state.phase === "signed_out" || state.phase === "account_changed") {
          endIdentity(state.phase);
          return;
        }
        if (state.phase === "ready") {
          hubUserRef.current = state.userId;
          setDrills(state.drills);
          setUserDrills(state.progress);
          if (state.drills.length > 0) {
            setSelectedId(state.drills[0].id);
          }
        } else if (state.phase === "unavailable") {
          setFailedLoads((count) => count + 1);
        } else {
          setRetryRefused(false);
        }
        setHubPhase(state.phase);
      },
    );
    hubLoaderRef.current = loader;
    loader.load();
    return () => {
      loader.dispose();
      hubLoaderRef.current = null;
    };
  }, [endIdentity]);

  // ── Notice a sign-out or account change made elsewhere ────────────────────
  // Events from the shared client (its own sign-outs, including one after a
  // refresh it could not complete, and other tabs' through the SDK), plus a
  // fresh session read whenever the golfer comes back to this tab (End Session
  // in another tab is a server sign-out that sends no event).
  useEffect(() => {
    const check = () => {
      if (identityEndRef.current !== null) return;
      void currentSession().then((observed) => {
        const end = drillHubIdentityEnd(hubUserRef.current ?? seenUserRef.current, observed);
        if (end !== null) endIdentity(end);
        else if (observed.status === "ready") seenUserRef.current = observed.session.userId;
      });
    };
    let unsubscribe = () => {};
    // A2: End Session of the session lineage this hub is signed in with (in this tab or another) ends the hub at once,
    // also when the SDK's SIGNED_OUT could not be announced (a removal whose lineage record did not land); the end of
    // any other lineage — a newer sign-in, even of the same golfer — changes nothing here.
    let stopWatch = () => {};
    const watchLineage = (session: unknown) => {
      if (session === null || session === undefined || identityEndRef.current !== null) return;
      stopWatch();
      stopWatch = watchSessionEnd(session, () => endIdentity("signed_out"));
    };
    try {
      const { data } = sharedClient().auth.onAuthStateChange((event, session) => {
        const end = drillHubIdentityEndFromEvent(hubUserRef.current ?? seenUserRef.current, event, session);
        if (end !== null) {
          endIdentity(end);
          return;
        }
        const seen = drillHubSessionUserId(session);
        if (seen !== null) seenUserRef.current = seen;
        watchLineage(session);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      // no shared client: the hub's own load reports that as unavailable
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      unsubscribe();
      stopWatch();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [endIdentity]);

  // After a successful retry the Try again button is gone, and when the hub
  // ends whatever had focus is gone; if focus went with it, put it on the
  // page heading, or on the ended panel's own heading (never pull focus from
  // where the golfer moved it).
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    if (hubPhase === "signed_out" || hubPhase === "account_changed") endHeadingRef.current?.focus();
    else if (hubPhase === "ready" && failedLoads > 0) headingRef.current?.focus();
  }, [hubPhase, failedLoads]);

  // "Submit Another Attempt" goes away with the verdict: once the picker shows its fresh label, keyboard focus goes
  // there (after the re-render, so the picker is announced with its new label, not the previous file's).
  const focusPickerRef = useRef(false);
  useEffect(() => {
    if (focusPickerRef.current && !verifyResult && !videoFile) {
      focusPickerRef.current = false;
      fileInputRef.current?.focus();
    }
  }, [verifyResult, videoFile]);

  function handleRetryLoad() {
    const started = hubLoaderRef.current?.load() ?? false;
    // While "unavailable" a refusal can only mean earlier cancelled reads are still finishing (bounded): say so.
    setRetryRefused(!started && hubPhase === "unavailable");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getUserDrillStatus(drillId: string): UserDrill["status"] {
    return userDrills.find((ud) => ud.drill_id === drillId)?.status ?? "pending";
  }

  function getUserDrillFeedback(drillId: string): string | null {
    return userDrills.find((ud) => ud.drill_id === drillId)?.latest_ai_feedback ?? null;
  }

  function handleSelectDrill(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    setVideoFile(null);
    setVerifyResult(null);
    setVerifyError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ── Submit video for AI verification ──────────────────────────────────────
  async function handleVerify() {
    if (!videoFile || !selectedId) return;
    if (verifyingRef.current || identityEndRef.current !== null) return;
    verifyingRef.current = true;
    const drillId = selectedId;
    // Nothing from this submission shows once the hub has ended (signed out, or another account), and an outcome
    // shows only while the submitted drill is still the one on screen.
    const show = (message: DrillVerifyMessage) => {
      if (identityEndRef.current === null && selectedIdRef.current === drillId) setVerifyError(DRILL_VERIFY_COPY[message]);
    };

    setIsVerifying(true);
    setUploadPhase("checking");
    setVerifyResult(null);
    setVerifyError(null);

    // Which step an unexpected failure interrupted decides the (fixed) message.
    let step: "session" | "upload" | "check" = "session";
    try {
      // The current session from the shared client, before anything is uploaded.
      const acquired = await currentSession();
      // The hub ended while the sign-in was being checked: nothing was sent, and the panel says so.
      if (identityEndRef.current !== null) {
        setNotSent(true);
        return;
      }
      if (acquired.status === "signed_out") {
        endIdentity("signed_out", true);
        return;
      }
      if (acquired.status !== "ready") {
        show("sessionUnavailable");
        return;
      }
      const { session } = acquired;
      // A session that now belongs to someone other than the golfer whose drills are shown ends the hub, unsent.
      if (session.userId !== hubUserRef.current) {
        endIdentity("account_changed", true);
        return;
      }

      // Phase 1 — upload directly to Supabase Storage (bypasses Vercel 4.5 MB limit)
      step = "upload";
      setUploadPhase("uploading");
      const supabase = clientForSession(session);
      const safeFilename = videoFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath  = `${session.userId}/${Date.now()}_${safeFilename}`;

      const { error: uploadErr } = await supabase.storage
        .from("drill_videos")
        .upload(storagePath, videoFile, { contentType: videoFile.type || "video/mp4", upsert: false });

      if (uploadErr) {
        // the size limit, an unsupported format and a permission refusal cannot be fixed by trying again
        show(drillUploadRefusal(uploadErr));
        return;
      }
      // The hub ended during the upload: send no verification request.
      if (identityEndRef.current !== null) return;

      // Phase 2 — send storage path to backend; backend downloads + calls Gemini File API
      step = "check";
      setUploadPhase("analyzing");

      const res = await fetch("/api/verify-drill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drillId, userId: session.userId, videoStoragePath: storagePath }),
      });
      const data: unknown = await res.json().catch(() => null);
      // Only a successful answer of the expected shape is shown; no answer text reaches the golfer otherwise.
      const result = res.ok ? readDrillVerifyResult(data) : null;
      if (!result) {
        // The endpoint refusing its caller may mean the sign-in changed meanwhile: look again before saying anything.
        if (res.status === 401 || res.status === 403) {
          const again = await currentSession();
          if (identityEndRef.current !== null) return;
          const end = drillHubIdentityEnd(hubUserRef.current, again);
          if (end !== null) {
            endIdentity(end);
            return;
          }
        }
        // no usable answer from a success means the page cannot know whether the check ran
        show(drillVerifyRefusal(res.ok ? null : res.status));
        return;
      }

      // A verdict that arrives after the hub ended restores nothing: no verdict, no badge.
      if (identityEndRef.current !== null) return;
      if (selectedIdRef.current === drillId) setVerifyResult(result);

      // Optimistically update local userDrills state so the submitted drill's badge refreshes
      setUserDrills((prev) => {
        const existing = prev.find((ud) => ud.drill_id === drillId);
        if (existing) {
          return prev.map((ud) =>
            ud.drill_id === drillId
              ? { ...ud, status: result.status, latest_ai_feedback: result.feedback }
              : ud
          );
        }
        return [...prev, { drill_id: drillId, status: result.status, latest_ai_feedback: result.feedback }];
      });
    } catch {
      // a check request that failed in transit may still have run: its outcome is unknown, not "try again"
      show(step === "session" ? "sessionUnavailable" : step === "upload" ? "uploadFailed" : drillVerifyRefusal(null));
    } finally {
      verifyingRef.current = false;
      setIsVerifying(false);
      setUploadPhase(null);
    }
  }

  const selectedDrill = drills.find((d) => d.id === selectedId) ?? null;
  const selectedStatus = selectedId ? getUserDrillStatus(selectedId) : "pending";
  const previousFeedback = selectedId ? getUserDrillFeedback(selectedId) : null;

  const verifiedCount  = drills.filter((d) => getUserDrillStatus(d.id) === "verified").length;
  const needsWorkCount = drills.filter((d) => getUserDrillStatus(d.id) === "needs_work").length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="text-4xl font-black italic tracking-tighter text-white uppercase focus:outline-none">
            Drill Verification Hub
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            Practice · Submit · Get Verified
          </p>
        </div>

        {/* Progress summary */}
        {hubPhase === "ready" && drills.length > 0 && (
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-golf-green/10 border border-golf-green/20 rounded-xl">
              <CheckCircle2 size={11} className="text-golf-green" />
              <span className="text-[10px] font-black text-golf-green uppercase tracking-widest">
                {verifiedCount}/{drills.length}
              </span>
            </div>
            {needsWorkCount > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-400/10 border border-amber-400/20 rounded-xl">
                <AlertTriangle size={11} className="text-amber-400" />
                <span className="text-[10px] font-black text-amber-400 uppercase tracking-widest">
                  {needsWorkCount} to fix
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Loading (first load; a retry keeps the error panel below with its button busy) */}
      {hubPhase === "loading" && failedLoads === 0 && (
        <div role="status" aria-live="polite" className="flex items-center justify-center py-24">
          <Loader2 size={22} className="animate-spin text-golf-green mr-3" aria-hidden="true" />
          <p className="text-sm text-gray-500 font-bold uppercase tracking-widest">Loading drills…</p>
        </div>
      )}

      {/* Load failure: no drills, statuses or counts — only what happened and Try again (reads only) */}
      {(hubPhase === "unavailable" || (hubPhase === "loading" && failedLoads > 0)) && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4">
          {/* keyed on the failure count so each new failure is announced again */}
          <div key={failedLoads} role="alert" className="flex items-start gap-3 flex-1 min-w-0">
            <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm font-black text-red-300">{DRILL_HUB_UNAVAILABLE_COPY.title}</h2>
              <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                {failedLoads > 1 ? DRILL_HUB_UNAVAILABLE_COPY.stillUnavailable : DRILL_HUB_UNAVAILABLE_COPY.body}
              </p>
              {retryRefused && hubPhase === "unavailable" && (
                <p role="status" className="text-xs text-gray-400 mt-1 leading-relaxed">{DRILL_HUB_UNAVAILABLE_COPY.stillFinishing}</p>
              )}
              {unconfirmed && (
                <p className="text-xs text-gray-300 mt-1 leading-relaxed">
                  {DRILL_HUB_UNCONFIRMED_COPY.body}{" "}
                  <Link
                    href="/login"
                    prefetch={false}
                    className="inline-flex items-center min-h-11 min-w-11 underline underline-offset-2 text-white font-bold rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-golf-green"
                  >
                    {DRILL_HUB_UNCONFIRMED_COPY.action}
                  </Link>
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleRetryLoad}
            aria-disabled={hubPhase === "loading"}
            className="shrink-0 inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-5 rounded-2xl border border-white/15 bg-white/5 text-white font-black text-[10px] uppercase tracking-widest transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-golf-green aria-disabled:cursor-wait aria-disabled:opacity-60"
          >
            {hubPhase === "loading" ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                {DRILL_HUB_UNAVAILABLE_COPY.retrying}
              </>
            ) : (
              <>
                <RotateCcw size={14} aria-hidden="true" />
                {DRILL_HUB_UNAVAILABLE_COPY.retry}
              </>
            )}
          </button>
        </div>
      )}

      {/* Signed out, or another account now (R1): none of the previous golfer's drills, progress or verdicts */}
      {(hubPhase === "signed_out" || hubPhase === "account_changed") && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 bg-white/5 border border-white/10 rounded-2xl px-5 py-4">
          <div role="alert" className="flex items-start gap-3 flex-1 min-w-0">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <h2 ref={endHeadingRef} tabIndex={-1} className="text-sm font-black text-white rounded focus:outline focus:outline-2 focus:outline-offset-4 focus:outline-golf-green">
                {DRILL_HUB_IDENTITY_COPY[hubPhase].title}
              </h2>
              <p className="text-xs text-gray-300 mt-1 leading-relaxed">{DRILL_HUB_IDENTITY_COPY[hubPhase].body}</p>
              {notSent && <p className="text-xs text-gray-400 mt-1 leading-relaxed">{DRILL_VERIFY_COPY.notSent}</p>}
            </div>
          </div>
          {hubPhase === "signed_out" ? (
            <Link
              href="/login"
              prefetch={false}
              className="shrink-0 inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-5 rounded-2xl bg-golf-green text-golf-dark font-black text-[10px] uppercase tracking-widest transition-colors hover:bg-[#22C55E] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-golf-green"
            >
              <LogIn size={14} aria-hidden="true" />
              {DRILL_HUB_IDENTITY_COPY.signed_out.action}
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="shrink-0 inline-flex items-center justify-center gap-2 min-h-11 min-w-11 px-5 rounded-2xl border border-white/15 bg-white/5 text-white font-black text-[10px] uppercase tracking-widest transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-golf-green"
            >
              <RotateCcw size={14} aria-hidden="true" />
              {DRILL_HUB_IDENTITY_COPY.account_changed.action}
            </button>
          )}
        </div>
      )}

      {/* Empty state (both reads succeeded and the catalog is genuinely empty) */}
      {hubPhase === "ready" && drills.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Award size={32} className="text-gray-700 mb-4" />
          <p className="text-white font-black uppercase tracking-widest text-sm mb-1">No Drills Available Yet</p>
          <p className="text-gray-600 text-xs">Drills will appear here once your coach adds them to your plan.</p>
        </div>
      )}

      {/* Main layout — drill list + detail */}
      {hubPhase === "ready" && drills.length > 0 && (
        <div className="flex flex-col lg:flex-row gap-4">

          {/* ── LEFT: Drill list ── */}
          <div className="w-full lg:w-72 shrink-0 space-y-2">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 px-1 mb-3">
              Assigned Drills
            </p>
            {drills.map((drill) => {
              const status = getUserDrillStatus(drill.id);
              const isActive = drill.id === selectedId;
              const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
              const Icon = cfg.icon;
              return (
                <button
                  key={drill.id}
                  onClick={() => handleSelectDrill(drill.id)}
                  className={`w-full text-left px-4 py-3.5 rounded-2xl border transition-all flex items-center gap-3 group ${
                    isActive
                      ? "bg-golf-green/10 border-golf-green/30"
                      : "bg-golf-surface border-white/5 hover:border-white/10 hover:bg-white/[0.03]"
                  }`}
                >
                  {/* Status dot */}
                  <div className={`shrink-0 w-7 h-7 rounded-xl flex items-center justify-center border ${cfg.bg}`}>
                    <Icon size={12} className={cfg.color} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-black uppercase tracking-wide truncate ${isActive ? "text-white" : "text-gray-300 group-hover:text-white"}`}>
                      {drill.name}
                    </p>
                    <p className="text-[9px] text-gray-600 uppercase tracking-widest mt-0.5">
                      {drill.target_metric.replace(/_/g, " ")}
                    </p>
                  </div>
                  <ChevronRight size={12} className={`shrink-0 transition-colors ${isActive ? "text-golf-green" : "text-gray-700"}`} />
                </button>
              );
            })}
          </div>

          {/* ── RIGHT: Drill detail + verification ── */}
          {selectedDrill ? (
            <div className="flex-1 min-w-0 space-y-4">

              {/* Drill header */}
              <div className="bg-golf-surface border border-white/5 rounded-4xl p-6">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-1 flex items-center gap-1.5">
                      <Target size={9} /> Drill
                    </p>
                    <h2 className="text-2xl font-black italic tracking-tighter text-white uppercase">
                      {selectedDrill.name}
                    </h2>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest mt-1">
                      Target: <span className="text-gray-400">{selectedDrill.target_metric.replace(/_/g, " ")}</span>
                    </p>
                  </div>
                  <StatusBadge status={selectedStatus} />
                </div>
              </div>

              {/* Coaching content */}
              <div className="grid sm:grid-cols-3 gap-3">
                {/* The Why */}
                <div className="bg-golf-surface border border-white/5 rounded-3xl p-5">
                  <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-3 flex items-center gap-1.5">
                    <Zap size={9} fill="currentColor" /> The Why
                  </p>
                  <p className="text-xs text-gray-300 leading-relaxed">{selectedDrill.the_why}</p>
                </div>

                {/* The How */}
                <div className="bg-golf-surface border border-white/5 rounded-3xl p-5">
                  <p className="text-[9px] font-black uppercase tracking-widest text-white mb-3 flex items-center gap-1.5">
                    <RotateCcw size={9} /> The How
                  </p>
                  <p className="text-xs text-gray-300 leading-relaxed">{selectedDrill.the_how}</p>
                </div>

                {/* The Feel */}
                <div className="bg-golf-surface border border-golf-green/10 rounded-3xl p-5">
                  <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-3 flex items-center gap-1.5">
                    <Award size={9} /> The Feel
                  </p>
                  <p className="text-xs text-gray-300 leading-relaxed italic">&ldquo;{selectedDrill.the_feel}&rdquo;</p>
                </div>
              </div>

              {/* Previous AI feedback (if any) */}
              {previousFeedback && !verifyResult && (
                <div className={`flex items-start gap-3 px-5 py-4 rounded-2xl border ${
                  selectedStatus === "verified"
                    ? "bg-golf-green/5 border-golf-green/20"
                    : "bg-amber-400/5 border-amber-400/20"
                }`}>
                  {selectedStatus === "verified"
                    ? <CheckCircle2 size={14} className="text-golf-green shrink-0 mt-0.5" />
                    : <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
                  }
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-1">
                      Last AI Feedback
                    </p>
                    <p className="text-xs text-gray-300 leading-relaxed">{previousFeedback}</p>
                  </div>
                </div>
              )}

              {/* Video upload area */}
              <div className="relative bg-golf-surface border border-white/5 rounded-4xl p-6">
                <p className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-4">
                  Submit Practice Video
                </p>

                {/* The file input stays in the tab order (visually hidden, not display:none): Tab reaches it and
                    Space or Enter opens the picker; the drop zone below shows its keyboard focus. */}
                <input
                  id="drill-video"
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/*"
                  className="peer sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setVideoFile(f);
                    setVerifyResult(null);
                    setVerifyError(null);
                  }}
                />

                {/* Drop zone */}
                <label
                  htmlFor="drill-video"
                  className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-2xl px-6 py-8 cursor-pointer transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-golf-green ${
                    videoFile
                      ? "border-golf-green/40 bg-golf-green/5"
                      : "border-white/10 hover:border-white/20 hover:bg-white/[0.02]"
                  }`}
                >
                  {videoFile ? (
                    <>
                      <CheckCircle2 size={22} className="text-golf-green" />
                      <div className="text-center">
                        <p className="text-xs font-black text-white">{videoFile.name}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5">
                          {(videoFile.size / 1_048_576).toFixed(1)} MB · tap to change
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <Upload size={22} className="text-gray-600" />
                      <div className="text-center">
                        <p className="text-xs font-bold text-gray-400">Tap to select video</p>
                        <p className="text-[10px] text-gray-600 mt-0.5">MP4 or MOV · max 50 MB</p>
                      </div>
                    </>
                  )}
                </label>

                {/* Submit button */}
                <button
                  onClick={handleVerify}
                  disabled={!videoFile || isVerifying}
                  className="mt-4 w-full min-h-11 flex items-center justify-center gap-2 px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-golf-green text-golf-dark hover:bg-[#22C55E] shadow-[0_0_20px_rgba(74,222,128,0.12)]"
                >
                  {isVerifying ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {uploadPhase === "checking" ? "Checking Sign-in…" : uploadPhase === "uploading" ? "Uploading Video…" : "AI Coach Analyzing…"}
                    </>
                  ) : (
                    <>
                      <Zap size={14} fill="currentColor" />
                      Verify with AI Coach
                    </>
                  )}
                </button>

                {/* Verification error */}
                {verifyError && (
                  <div role="alert" className="mt-3 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <AlertTriangle size={13} className="text-red-400 shrink-0" />
                    <p className="text-xs text-red-400">{verifyError}</p>
                  </div>
                )}
              </div>

              {/* AI Verification result */}
              {verifyResult && (
                <div role="status" className={`rounded-4xl border p-6 ${
                  verifyResult.pass
                    ? "bg-golf-green/5 border-golf-green/30"
                    : "bg-amber-400/5 border-amber-400/30"
                }`}>
                  {/* Pass / Fail banner */}
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                      verifyResult.pass ? "bg-golf-green/20" : "bg-amber-400/20"
                    }`}>
                      {verifyResult.pass
                        ? <CheckCircle2 size={20} className="text-golf-green" />
                        : <AlertTriangle size={20} className="text-amber-400" />
                      }
                    </div>
                    <div>
                      <p className={`text-lg font-black italic tracking-tighter uppercase ${
                        verifyResult.pass ? "text-golf-green" : "text-amber-400"
                      }`}>
                        {verifyResult.pass ? "Drill Verified!" : "Needs More Work"}
                      </p>
                      <p className="text-[9px] font-black uppercase tracking-widest text-gray-500">
                        AI Coach Verdict
                      </p>
                    </div>
                  </div>

                  {/* Feedback */}
                  <div className="flex items-start gap-2">
                    <Zap size={12} className={`shrink-0 mt-0.5 ${verifyResult.pass ? "text-golf-green" : "text-amber-400"}`} fill="currentColor" />
                    <p className="text-sm text-gray-200 leading-relaxed">{verifyResult.feedback}</p>
                  </div>

                  {/* Retry prompt for needs_work */}
                  {!verifyResult.pass && (
                    <button
                      type="button"
                      onClick={() => {
                        focusPickerRef.current = true; // this button goes away: focus moves to the picker after the re-render
                        setVerifyResult(null);
                        setVideoFile(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                      className="mt-4 -ml-4 inline-flex items-center gap-2 min-h-11 px-4 rounded-xl text-[10px] font-black uppercase tracking-widest text-amber-400 hover:text-amber-300 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                    >
                      <RotateCcw size={11} aria-hidden="true" /> Submit Another Attempt
                    </button>
                  )}
                </div>
              )}

            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
