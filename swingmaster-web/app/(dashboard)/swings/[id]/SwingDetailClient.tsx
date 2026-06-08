'use client';

import { useState, useEffect, useRef } from 'react';
import {
  CheckCircle2, AlertTriangle, Loader2, Target, Lightbulb, Zap,
  TrendingUp, RotateCcw, AlertCircle, ChevronDown, ChevronUp, Dumbbell, Play, Pause,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Pillar {
  rating: 'excellent' | 'good' | 'needs_work' | 'poor';
  observation: string;
  correction: string;
}

interface Highlight {
  positive_movement: string;
  mechanical_benefit: string;
}

interface Deficiency {
  joint_coordinate: { joint: string };
  fault_description: string;
  severity: 'minor' | 'major';
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

interface Analysis {
  id: string;
  status: string;
  score: number | null;
  feedback: string | null;
  metrics: Metrics | null;
  swing_highlights: Highlight[] | null;
  mechanical_deficiencies: Deficiency[] | null;
  swing_video: { club?: string | null; original_filename?: string | null } | null;
}

interface Props {
  analysis: Analysis;
  videoSignedUrl: string | null;
  analysisId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RATING_STYLE = {
  excellent: { label: 'Excellent', cls: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' },
  good:      { label: 'Good',      cls: 'bg-indigo-500/10 border-indigo-500/25 text-indigo-400' },
  needs_work:{ label: 'Needs Work',cls: 'bg-amber-500/10 border-amber-500/25 text-amber-400' },
  poor:      { label: 'Poor',      cls: 'bg-red-500/10 border-red-500/25 text-red-400' },
} as const;

function scoreColor(s: number) {
  if (s >= 85) return 'text-emerald-400';
  if (s >= 70) return 'text-indigo-400';
  if (s >= 55) return 'text-amber-400';
  return 'text-red-400';
}

function scoreLabel(s: number) {
  if (s >= 85) return 'Elite';
  if (s >= 70) return 'Solid';
  if (s >= 55) return 'Building';
  return 'Needs Work';
}

// ── Pillar card ───────────────────────────────────────────────────────────────

function PillarCard({ title, pillar, open: initOpen }: { title: string; pillar: Pillar; open?: boolean }) {
  const [open, setOpen] = useState(initOpen ?? false);
  const style = RATING_STYLE[pillar.rating] ?? RATING_STYLE.good;

  return (
    <div className="bg-white/[0.03] border border-white/[0.07] rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-3">
          <p className="text-sm font-bold text-white">{title}</p>
          <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${style.cls}`}>
            {style.label}
          </span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-600" /> : <ChevronDown className="w-4 h-4 text-slate-600" />}
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-white/[0.06] pt-4 space-y-3">
          <p className="text-sm text-slate-300 leading-relaxed">{pillar.observation}</p>
          <div className="flex items-start gap-3 bg-indigo-500/[0.07] border border-indigo-500/20 rounded-xl px-4 py-3">
            <Target className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <p className="text-xs text-slate-300 leading-relaxed">{pillar.correction}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Processing state ──────────────────────────────────────────────────────────

function ProcessingState({
  analysisId, onComplete, forceKey,
}: {
  analysisId: string;
  onComplete: (data: Analysis) => void;
  forceKey: string;
}) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const triggered = useRef(false);

  const STEPS = [
    'Connecting to AI coach…',
    'Evaluating posture & setup…',
    'Analysing swing plane…',
    'Assessing impact position…',
    'Generating drill prescriptions…',
    'Finalising report…',
  ];

  useEffect(() => {
    triggered.current = false;
  }, [forceKey]);

  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;

    const interval = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 2200);

    let mediapipeMetrics: Record<string, unknown> | undefined;
    try {
      const raw = sessionStorage.getItem(`mediapipe_${analysisId}`);
      if (raw) mediapipeMetrics = JSON.parse(raw);
    } catch { /* ignore */ }

    fetch('/api/analyze-swing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysisId, ...(mediapipeMetrics ? { mediapipeMetrics } : {}) }),
    })
      .then((r) => r.json())
      .then((res) => {
        clearInterval(interval);
        if (res.error) setError(res.error);
        else {
          try { sessionStorage.removeItem(`mediapipe_${analysisId}`); } catch { /* ignore */ }
          onComplete(res.data as Analysis);
        }
      })
      .catch((e) => { clearInterval(interval); setError(e.message ?? 'Analysis failed.'); });

    return () => clearInterval(interval);
  }, [analysisId, onComplete, forceKey, STEPS.length]);

  if (error) {
    return (
      <div className="text-center py-16">
        <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-white font-semibold mb-1">Analysis Failed</p>
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="text-center py-16 max-w-xs mx-auto">
      <div className="relative w-14 h-14 mx-auto mb-5">
        <div className="absolute inset-0 rounded-full border-2 border-indigo-500/20" />
        <div className="absolute inset-0 rounded-full border-t-2 border-indigo-500 animate-spin" />
        <div className="absolute inset-0 flex items-center justify-center">
          <Zap className="w-5 h-5 text-indigo-400" />
        </div>
      </div>
      <p className="text-xs font-bold uppercase tracking-widest text-indigo-400 mb-1">AI Coach Active</p>
      <h3 className="text-base font-bold text-white mb-5">Analysing Your Swing</h3>
      <div className="space-y-2.5 text-left">
        {STEPS.map((s, i) => (
          <div key={i} className="flex items-center gap-3">
            {i < step
              ? <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              : i === step
              ? <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin shrink-0" />
              : <div className="w-3.5 h-3.5 rounded-full border border-white/10 shrink-0" />
            }
            <span className={`text-xs ${i <= step ? 'text-slate-300' : 'text-slate-700'}`}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Report ────────────────────────────────────────────────────────────────────

function CoachingReport({ analysis, onReanalyze }: { analysis: Analysis; onReanalyze: () => void }) {
  const score = analysis.score ?? 0;
  const metrics = analysis.metrics ?? {};
  const highlights = analysis.swing_highlights ?? [];
  const deficiencies = analysis.mechanical_deficiencies ?? [];
  const [openDefIdx, setOpenDefIdx] = useState<number | null>(0);

  return (
    <div className="space-y-5">
      {/* Score */}
      <div className="bg-slate-900 border border-white/10 rounded-2xl p-6">
        <div className="flex items-start gap-5">
          <div className="shrink-0 text-center">
            <div className={`text-5xl font-black tabular-nums ${scoreColor(score)}`}>{score}</div>
            <p className={`text-[9px] font-black uppercase tracking-widest mt-0.5 ${scoreColor(score)}`}>
              {scoreLabel(score)}
            </p>
          </div>
          <div className="flex-1 min-w-0 border-l border-white/[0.08] pl-5">
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-2">AI Assessment</p>
            <p className="text-sm text-slate-300 leading-relaxed">{analysis.feedback}</p>
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
        <div className="flex items-start gap-3 bg-indigo-500/[0.06] border border-indigo-500/20 rounded-2xl px-5 py-4">
          <Zap className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-indigo-400 mb-1.5">The Feel</p>
            <p className="text-sm text-slate-200 leading-relaxed italic">"{metrics.the_feel}"</p>
          </div>
        </div>
      )}

      {/* Pillars */}
      {(metrics.posture || metrics.swing_plane || metrics.impact) && (
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-3">Structural Breakdown</p>
          <div className="space-y-2">
            {metrics.posture && <PillarCard title="Posture & Setup" pillar={metrics.posture} open />}
            {metrics.swing_plane && <PillarCard title="Swing Plane" pillar={metrics.swing_plane} />}
            {metrics.impact && <PillarCard title="Impact Position" pillar={metrics.impact} />}
          </div>
        </div>
      )}

      {/* Highlights */}
      {highlights.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-600">What You're Doing Well</p>
          </div>
          <div className="space-y-2">
            {highlights.map((h, i) => (
              <div key={i} className="flex items-start gap-3 bg-emerald-500/[0.05] border border-emerald-500/15 rounded-xl px-4 py-3">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-white">{h.positive_movement}</p>
                  {h.mechanical_benefit && (
                    <p className="text-[11px] text-slate-500 mt-0.5">{h.mechanical_benefit}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deficiencies */}
      {deficiencies.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-600">Fault Diagnosis & Drills</p>
          </div>
          <div className="space-y-2">
            {deficiencies.map((d, i) => {
              const isOpen = openDefIdx === i;
              const isMajor = d.severity === 'major';
              return (
                <div key={i} className={`border rounded-2xl overflow-hidden ${isMajor ? 'border-red-500/20' : 'border-amber-500/15'}`}>
                  <button
                    onClick={() => setOpenDefIdx(isOpen ? null : i)}
                    className="w-full flex items-center justify-between px-5 py-4 text-left bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`shrink-0 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${isMajor ? 'bg-red-500/10 border-red-500/25 text-red-400' : 'bg-amber-500/10 border-amber-500/25 text-amber-400'}`}>
                        {isMajor ? 'Major' : 'Minor'}
                      </span>
                      <p className="text-sm font-semibold text-white truncate">{d.joint_coordinate?.joint ?? 'General'}</p>
                    </div>
                    {isOpen ? <ChevronUp className="w-4 h-4 text-slate-600 shrink-0 ml-2" /> : <ChevronDown className="w-4 h-4 text-slate-600 shrink-0 ml-2" />}
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 border-t border-white/[0.06] pt-4 space-y-3">
                      <p className="text-sm text-slate-300 leading-relaxed">{d.fault_description}</p>
                      {d.corrective_drill_title && (
                        <div className="flex items-start gap-3 bg-white/[0.03] border border-white/[0.07] rounded-xl px-4 py-3">
                          <Dumbbell className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-[9px] font-black uppercase tracking-widest text-indigo-400 mb-1">{d.corrective_drill_title}</p>
                            {d.corrective_drill_detail && (
                              <p className="text-xs text-slate-400 leading-relaxed">{d.corrective_drill_detail}</p>
                            )}
                          </div>
                        </div>
                      )}
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
        <div className="flex items-start gap-3 bg-slate-900 border border-white/[0.07] rounded-2xl px-5 py-4">
          <Target className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mb-1">This Week's Priority</p>
            <p className="text-sm text-slate-300">{metrics.practice_focus}</p>
          </div>
        </div>
      )}

      {/* Re-analyze */}
      <button
        onClick={onReanalyze}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] text-xs font-bold text-slate-500 hover:text-white hover:bg-white/[0.05] transition-colors"
      >
        <RotateCcw className="w-3.5 h-3.5" /> Re-analyze with AI
      </button>
    </div>
  );
}

// ── Video player ──────────────────────────────────────────────────────────────

function VideoPlayer({ src, label }: { src: string | null; label: string | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  if (!src) {
    return (
      <div className="aspect-video bg-black/40 rounded-2xl border border-white/5 flex items-center justify-center">
        <p className="text-xs text-slate-600">Video unavailable</p>
      </div>
    );
  }

  return (
    <div className="relative group rounded-2xl overflow-hidden bg-black border border-white/5">
      <video
        ref={ref}
        src={src}
        className="w-full aspect-video object-contain bg-black"
        playsInline
        loop
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <button
        onClick={() => { const v = ref.current; if (!v) return; v.paused ? v.play() : v.pause(); }}
        className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors"
      >
        <div className={`w-12 h-12 rounded-full bg-black/60 border border-white/20 flex items-center justify-center transition-opacity ${playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
          {playing ? <Pause className="w-5 h-5 text-white" /> : <Play className="w-5 h-5 text-white ml-0.5" />}
        </div>
      </button>
      {label && (
        <div className="absolute bottom-0 left-0 right-0 px-4 py-2 bg-gradient-to-t from-black/80 to-transparent">
          <p className="text-[10px] text-slate-400 truncate">{label}</p>
        </div>
      )}
    </div>
  );
}

// ── Root client component ─────────────────────────────────────────────────────

export default function SwingDetailClient({ analysis: init, videoSignedUrl, analysisId }: Props) {
  const [analysis, setAnalysis] = useState<Analysis>(init);
  const [forceReanalyze, setForceReanalyze] = useState(false);
  const [forceKey, setForceKey] = useState('initial');

  const isPending    = analysis.status === 'pending';
  const isProcessing = analysis.status === 'processing';
  const isComplete   = analysis.status === 'complete';
  const showProcessing = isPending || isProcessing || forceReanalyze;

  function handleReanalyze() {
    setForceReanalyze(true);
    setForceKey(`reanalyze-${Date.now()}`);
  }

  const videoLabel = analysis.swing_video?.original_filename ?? analysis.swing_video?.club ?? null;

  return (
    <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
      {/* Left: video */}
      <div className="w-full lg:w-[380px] lg:sticky lg:top-6 shrink-0 space-y-4">
        <VideoPlayer src={videoSignedUrl} label={videoLabel} />

        <div className="bg-slate-900 border border-white/10 rounded-2xl px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-600 mb-0.5">Club</p>
            <p className="text-sm font-bold text-white capitalize">{analysis.swing_video?.club ?? 'Unknown'}</p>
          </div>
          <div className="text-right">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-600 mb-0.5">Status</p>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${
              isComplete ? 'bg-indigo-500/10 border-indigo-500/25 text-indigo-400'
                         : 'bg-amber-500/10 border-amber-500/25 text-amber-400'
            }`}>
              {analysis.status}
            </span>
          </div>
        </div>
      </div>

      {/* Right: report */}
      <div className="flex-1 min-w-0">
        {showProcessing && (
          <ProcessingState
            key={forceKey}
            analysisId={analysisId}
            forceKey={forceKey}
            onComplete={(data) => { setForceReanalyze(false); setAnalysis(data); }}
          />
        )}
        {isComplete && !showProcessing && (
          <CoachingReport analysis={analysis} onReanalyze={handleReanalyze} />
        )}
        {analysis.status === 'failed' && !showProcessing && (
          <div className="text-center py-16">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-white font-semibold mb-4">Analysis Failed</p>
            <button
              onClick={handleReanalyze}
              className="flex items-center gap-2 mx-auto px-5 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
