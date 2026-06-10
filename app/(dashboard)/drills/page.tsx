"use client";

import { useState, useEffect, useRef } from "react";
import {
  CheckCircle2, AlertTriangle, Clock, Upload, Loader2,
  ChevronRight, Zap, Target, RotateCcw, Award,
} from "lucide-react";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// ─── Auth helpers (match analyze/page.tsx pattern) ─────────────────────────────
function getSessionFromCookie(): { access_token: string; user_id: string } | null {
  if (typeof document === "undefined") return null;
  try {
    const name = "sb-atlmnqispyzhsahahpjy-auth-token";
    const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
    if (!match) return null;
    const parsed = JSON.parse(decodeURIComponent(match.split("=").slice(1).join("=")));
    return { access_token: parsed.access_token, user_id: parsed.user?.id };
  } catch { return null; }
}

function getAuthClient() {
  const s = getSessionFromCookie();
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: s ? { Authorization: `Bearer ${s.access_token}` } : {} },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
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

interface VerifyResult {
  pass: boolean;
  status: "verified" | "needs_work";
  feedback: string;
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
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [selectedId, setSelectedId]       = useState<string | null>(null);
  const [videoFile, setVideoFile]         = useState<File | null>(null);
  const [isVerifying, setIsVerifying]     = useState(false);
  const [verifyResult, setVerifyResult]   = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError]     = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Fetch data on mount ────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const supabase = getAuthClient();

      const [drillsRes, userDrillsRes] = await Promise.all([
        supabase.from("drills").select("id, name, target_metric, the_why, the_how, the_feel").order("name"),
        supabase.from("user_drills").select("drill_id, status, latest_ai_feedback"),
      ]);

      if (drillsRes.error) {
        setFetchError(drillsRes.error.message);
      } else {
        setDrills((drillsRes.data ?? []) as Drill[]);
        if (drillsRes.data && drillsRes.data.length > 0) {
          setSelectedId(drillsRes.data[0].id);
        }
      }

      setUserDrills((userDrillsRes.data ?? []) as UserDrill[]);
      setLoading(false);
    }

    load();
  }, []);

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

    const session = getSessionFromCookie();
    if (!session) { setVerifyError("Not authenticated. Please sign in."); return; }

    setIsVerifying(true);
    setVerifyResult(null);
    setVerifyError(null);

    try {
      const fd = new FormData();
      fd.append("drillId", selectedId);
      fd.append("userId",  session.user_id);
      fd.append("video",   videoFile);

      const res = await fetch("/api/verify-drill", { method: "POST", body: fd });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error ?? `Verification failed (${res.status})`);

      const result = data as VerifyResult;
      setVerifyResult(result);

      // Optimistically update local userDrills state so the list badge refreshes
      setUserDrills((prev) => {
        const existing = prev.find((ud) => ud.drill_id === selectedId);
        if (existing) {
          return prev.map((ud) =>
            ud.drill_id === selectedId
              ? { ...ud, status: result.status, latest_ai_feedback: result.feedback }
              : ud
          );
        }
        return [...prev, { drill_id: selectedId, status: result.status, latest_ai_feedback: result.feedback }];
      });
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setIsVerifying(false);
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
          <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase">
            Drill Verification Hub
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
            Practice · Submit · Get Verified
          </p>
        </div>

        {/* Progress summary */}
        {!loading && drills.length > 0 && (
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

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={22} className="animate-spin text-golf-green mr-3" />
          <p className="text-sm text-gray-500 font-bold uppercase tracking-widest">Loading drills…</p>
        </div>
      )}

      {/* Fetch error */}
      {fetchError && (
        <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4">
          <AlertTriangle size={16} className="text-red-400 shrink-0" />
          <p className="text-sm text-red-400">{fetchError}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !fetchError && drills.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Award size={32} className="text-gray-700 mb-4" />
          <p className="text-white font-black uppercase tracking-widest text-sm mb-1">No Drills Available Yet</p>
          <p className="text-gray-600 text-xs">Drills will appear here once your coach adds them to your plan.</p>
        </div>
      )}

      {/* Main layout — drill list + detail */}
      {!loading && drills.length > 0 && (
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
              <div className="bg-golf-surface border border-white/5 rounded-4xl p-6">
                <p className="text-[9px] font-black uppercase tracking-widest text-gray-500 mb-4">
                  Submit Practice Video
                </p>

                {/* Drop zone */}
                <label
                  htmlFor="drill-video"
                  className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-2xl px-6 py-8 cursor-pointer transition-colors ${
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
                <input
                  id="drill-video"
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setVideoFile(f);
                    setVerifyResult(null);
                    setVerifyError(null);
                  }}
                />

                {/* Submit button */}
                <button
                  onClick={handleVerify}
                  disabled={!videoFile || isVerifying}
                  className="mt-4 w-full flex items-center justify-center gap-2 px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-golf-green text-golf-dark hover:bg-[#22C55E] shadow-[0_0_20px_rgba(74,222,128,0.12)]"
                >
                  {isVerifying ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      AI Coach Analyzing…
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
                  <div className="mt-3 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <AlertTriangle size={13} className="text-red-400 shrink-0" />
                    <p className="text-xs text-red-400">{verifyError}</p>
                  </div>
                )}
              </div>

              {/* AI Verification result */}
              {verifyResult && (
                <div className={`rounded-4xl border p-6 ${
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
                      onClick={() => {
                        setVerifyResult(null);
                        setVideoFile(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                      className="mt-4 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      <RotateCcw size={11} /> Submit Another Attempt
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
