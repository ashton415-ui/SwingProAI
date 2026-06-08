"use client";

import { useState, useEffect, useRef } from "react";
import {
  CheckCircle2, AlertTriangle, Loader2, Zap, Target,
  ChevronDown, ChevronUp, RotateCcw, Play, Pause,
  TrendingUp, AlertCircle, Lightbulb, Dumbbell,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Pillar {
  rating: "excellent" | "good" | "needs_work" | "poor";
  observation: string;
  correction: string;
}

interface Highlight {
  checkpoint: string;
  positive_movement: string;
  mechanical_benefit: string;
}

interface Deficiency {
  checkpoint: string;
  joint_coordinate: { joint: string; x: number; y: number };
  fault_description: string;
  severity: "minor" | "major";
  corrective_drill_title: string;
  corrective_drill_detail?: string | null;
}

interface Metrics {
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
    video_url: string;
    storage_path: string | null;
    original_filename: string | null;
    club: string | null;
    created_at: string;
  } | null;
}

interface Props {
  analysis: AnalysisData;
  videoSignedUrl: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RATING_STYLE: Record<string, { label: string; bg: string; border: string; text: string }> = {
  excellent: { label: "Excellent",   bg: "bg-emerald-500/10", border: "border-emerald-500/25", text: "text-emerald-400" },
  good:      { label: "Good",        bg: "bg-golf-green/10",  border: "border-golf-green/25",  text: "text-golf-green"  },
  needs_work:{ label: "Needs Work",  bg: "bg-amber-500/10",   border: "border-amber-500/25",   text: "text-amber-400"   },
  poor:      { label: "Poor",        bg: "bg-red-500/10",     border: "border-red-500/25",      text: "text-red-400"    },
};

function scoreColor(s: number) {
  if (s >= 85) return "text-emerald-400";
  if (s >= 70) return "text-golf-green";
  if (s >= 55) return "text-amber-400";
  return "text-red-400";
}

function scoreLabel(s: number) {
  if (s >= 85) return "Elite";
  if (s >= 70) return "Solid";
  if (s >= 55) return "Building";
  return "Needs Work";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PillarCard({ title, pillar, openDefault }: { title: string; pillar: Pillar; openDefault?: boolean }) {
  const [open, setOpen] = useState(openDefault ?? false);
  const style = RATING_STYLE[pillar.rating] ?? RATING_STYLE.good;

  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-3">
          <p className="text-sm font-bold text-white">{title}</p>
          <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${style.bg} ${style.border} ${style.text}`}>
            {style.label}
          </span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-gray-600 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-600 shrink-0" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-white/[0.06] pt-4 space-y-4">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1.5">Observation</p>
            <p className="text-sm text-gray-300 leading-relaxed">{pillar.observation}</p>
          </div>
          <div className="flex items-start gap-3 bg-golf-green/[0.05] border border-golf-green/20 rounded-xl px-4 py-3">
            <Target className="w-4 h-4 text-golf-green shrink-0 mt-0.5" />
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-1">Correction</p>
              <p className="text-xs text-gray-300 leading-relaxed">{pillar.correction}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Processing state ──────────────────────────────────────────────────────────

function ProcessingState({ analysisId, onComplete }: { analysisId: string; onComplete: (data: AnalysisData) => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const triggered = useRef(false);

  const STEPS = [
    "Connecting to AI coach…",
    "Evaluating posture & setup…",
    "Analysing swing plane…",
    "Assessing impact position…",
    "Generating drill prescriptions…",
    "Finalising report…",
  ];

  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;

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

    fetch("/api/analyze-swing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId, ...(mediapipeMetrics ? { mediapipeMetrics } : {}) }),
    })
      .then((r) => r.json())
      .then((res) => {
        clearInterval(interval);
        if (res.error) {
          setError(res.error);
        } else {
          // Clean up sessionStorage entry now that the API has consumed it
          try { sessionStorage.removeItem(`mediapipe_${analysisId}`); } catch { /* ignore */ }
          onComplete(res.data as AnalysisData);
        }
      })
      .catch((e) => {
        clearInterval(interval);
        setError(e.message ?? "Analysis failed.");
      });

    return () => clearInterval(interval);
  }, [analysisId, onComplete]);

  if (error) {
    return (
      <div className="text-center py-16 max-w-sm mx-auto">
        <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="w-7 h-7 text-red-400" />
        </div>
        <p className="text-white font-bold mb-2">Analysis Failed</p>
        <p className="text-sm text-red-400 mb-6">{error}</p>
        <button
          onClick={() => { triggered.current = false; setError(null); setStep(0); }}
          className="flex items-center gap-2 mx-auto px-5 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Retry
        </button>
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
  const score = analysis.score ?? 0;
  const metrics = analysis.metrics ?? {};
  const highlights = analysis.swing_highlights ?? [];
  const deficiencies = analysis.mechanical_deficiencies ?? [];
  const [openDefIdx, setOpenDefIdx] = useState<number | null>(0);

  return (
    <div className="space-y-5">
      {/* Score + overall */}
      <div className="bg-golf-header border border-white/5 rounded-2xl p-6">
        <div className="flex items-start gap-5">
          {/* Score ring */}
          <div className="shrink-0 text-center">
            <div className={`text-5xl font-black italic tabular-nums ${scoreColor(score)}`}>
              {score}
            </div>
            <p className={`text-[9px] font-black uppercase tracking-widest mt-0.5 ${scoreColor(score)}`}>
              {scoreLabel(score)}
            </p>
          </div>

          <div className="flex-1 min-w-0 border-l border-white/[0.08] pl-5">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">
              AI Coach Assessment
            </p>
            <p className="text-sm text-gray-300 leading-relaxed">{analysis.feedback}</p>
          </div>
        </div>
      </div>

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
              return (
                <div
                  key={i}
                  className={`border rounded-2xl overflow-hidden ${
                    isMajor ? "border-red-500/20" : "border-amber-500/15"
                  }`}
                >
                  <button
                    onClick={() => setOpenDefIdx(isOpen ? null : i)}
                    className="w-full flex items-center justify-between px-5 py-4 text-left bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`shrink-0 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                        isMajor
                          ? "bg-red-500/10 border-red-500/25 text-red-400"
                          : "bg-amber-500/10 border-amber-500/25 text-amber-400"
                      }`}>
                        {isMajor ? "Major" : "Minor"}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-white">{d.joint_coordinate?.joint ?? d.checkpoint}</p>
                        <p className="text-[11px] text-gray-500 truncate">{d.fault_description}</p>
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

export default function AnalysisReport({ analysis: initialAnalysis, videoSignedUrl }: Props) {
  const [analysis, setAnalysis] = useState<AnalysisData>(initialAnalysis);
  // When true, force the ProcessingState even if the DB row is already "complete"
  const [forceReanalyze, setForceReanalyze] = useState(false);

  const isPending    = analysis.status === "pending";
  const isProcessing = analysis.status === "processing";
  const isComplete   = analysis.status === "complete";
  const isFailed     = analysis.status === "failed";

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
              {analysis.swing_video?.club ?? "Unknown"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-0.5">Status</p>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${
              isComplete ? "bg-golf-green/10 border-golf-green/25 text-golf-green" :
              isFailed   ? "bg-red-500/10 border-red-500/25 text-red-400"         :
                           "bg-amber-500/10 border-amber-500/25 text-amber-400"
            }`}>
              {analysis.status}
            </span>
          </div>
        </div>

        {/* Re-analyze button — lets the user force a fresh Gemini run on any complete row */}
        {isComplete && !forceReanalyze && (
          <button
            onClick={() => setForceReanalyze(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] text-xs font-bold text-gray-500 hover:text-white hover:bg-white/[0.06] hover:border-white/[0.14] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Re-analyze with AI
          </button>
        )}
      </div>

      {/* ── Right: report ── */}
      <div className="flex-1 min-w-0">
        {showProcessing && (
          <ProcessingState
            key={forceReanalyze ? "reanalyze" : "initial"}
            analysisId={analysis.id}
            onComplete={(data) => { setForceReanalyze(false); setAnalysis(data); }}
          />
        )}

        {isFailed && !showProcessing && (
          <div className="text-center py-16 max-w-sm mx-auto">
            <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <p className="text-white font-bold mb-2">Analysis Failed</p>
            <p className="text-sm text-gray-500">There was an error processing your swing. Please try uploading again.</p>
            <button
              onClick={() => setForceReanalyze(true)}
              className="mt-4 flex items-center gap-2 mx-auto px-5 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
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
