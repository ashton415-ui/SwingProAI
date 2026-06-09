"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Upload, Target, CheckCircle2, AlertCircle, Loader2,
  Play, Info, Maximize2, X, Activity, Zap, Trophy,
  Lock, BarChart2, FileUp,
} from "lucide-react";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  canUseLaunchMonitor,
  getAnalysisModeForTier,
  getTierDisplayName,
  getUpsellTier,
  type SubscriptionTier,
} from "@/lib/entitlements";
import type { DeficiencyItem, HighlightItem } from "@/types/database";

/** Read the tier injected by the server layout */
function getUserTier(): SubscriptionTier {
  if (typeof document === "undefined") return "par";
  const el = document.getElementById("__swingpro_tier");
  return (el?.dataset?.tier as SubscriptionTier) ?? "par";
}

// ─── Auth helper (reads session cookie set by our login flow) ──────────────────
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

// ─── Types ─────────────────────────────────────────────────────────────────────
interface SwingDrill { name: string; why: string; how: string; feel: string; videoUrl: string; }
interface OverlayMetric { feedback: string; overlay: { x1: number; y1: number; x2: number; y2: number }; }
interface AnalysisResult {
  feedback: string; score: number; weakSpots: string[];
  drills: SwingDrill[];
  metrics: {
    swingSpeed: number; ballSpeed: number; launchAngle: number; smashFactor: number;
    wristHinge?: OverlayMetric; hipRotation?: OverlayMetric;
    shoulderRotation?: OverlayMetric; headStability?: OverlayMetric;
    [key: string]: unknown;
  };
  // v4 granular telemetry (persisted into swing_analysis)
  swing_highlights?: HighlightItem[];
  mechanical_deficiencies?: DeficiencyItem[];
  detailed_summary_html?: string | null;
  tempo_ratio?: number | null;
  swing_speed_mph?: number | null;
  // Server-injected routing fields
  _tier?: string;
  _mode?: "basic" | "advanced" | "ultra";
  _model?: string;
  _upgradeMessage?: string;
}

const BUCKET = "swing-videos";
const MAX_FILE_MB = 250;
const MAX_SEGMENT_SECONDS = 15;

function formatYt(url: string) {
  if (!url) return "";
  if (url.includes("watch?v=")) return url.replace("watch?v=", "embed/");
  if (url.includes("youtu.be/")) return `https://www.youtube.com/embed/${url.split("youtu.be/")[1]}`;
  return url;
}

// ─── Component ─────────────────────────────────────────────────────────────────
export default function AnalyzePage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isTrimming, setIsTrimming] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAdvanced, setIsAdvanced] = useState(false);
  const [showProUpgrade, setShowProUpgrade] = useState(false);
  const [activeDrillVideo, setActiveDrillVideo] = useState<string | null>(null);
  const [activeOverlay, setActiveOverlay] = useState<string | null>(null);
  const [lmFile, setLmFile] = useState<File | null>(null);
  const [userTier, setUserTier] = useState<SubscriptionTier>("par");

  useEffect(() => {
    setUserTier(getUserTier());
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const applyMeta = () => {
      if (video.duration && isFinite(video.duration)) {
        setDuration(video.duration);
        setTrimEnd(video.duration);
        setVideoAspect(video.videoWidth / video.videoHeight);
      }
    };

    const onTime = () => setCurrentTime(video.currentTime);

    video.addEventListener("loadedmetadata", applyMeta);
    video.addEventListener("durationchange", applyMeta);
    video.addEventListener("timeupdate", onTime);

    // Blob URLs load instantly — metadata may already be available
    if (video.readyState >= 1) applyMeta();

    return () => {
      video.removeEventListener("loadedmetadata", applyMeta);
      video.removeEventListener("durationchange", applyMeta);
      video.removeEventListener("timeupdate", onTime);
    };
  }, [previewUrl]);

  const handleFile = useCallback((f: File) => {
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`Video too large (max ${MAX_FILE_MB}MB).`);
      return;
    }
    setFile(f); setPreviewUrl(URL.createObjectURL(f));
    setResult(null); setError(null); setVideoAspect(null);
    setTrimStart(0); setTrimEnd(0); setDuration(0);
  }, []);

  // ── Browser-side trim + compress (Canvas + MediaRecorder) ──────────────────
  const getTrimmedBlob = async (): Promise<Blob> => {
    const video = videoRef.current;
    if (!video || !file) throw new Error("No video loaded");

    // Skip transcode if already small and no trim needed
    if (trimStart === 0 && Math.abs(trimEnd - duration) < 0.1 && file.size < 18 * 1024 * 1024) {
      return file;
    }

    setIsTrimming(true);

    return new Promise((resolve) => {
      try {
        const aspect = video.videoWidth / video.videoHeight;
        let w = aspect < 1 ? Math.round(848 * aspect) : 848;
        let h = aspect < 1 ? 848 : Math.round(848 / aspect);
        if (w % 2 !== 0) w--;
        if (h % 2 !== 0) h--;

        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) { setIsTrimming(false); resolve(file); return; }

        const stream = (canvas as any).captureStream?.(30);
        if (!stream) { setIsTrimming(false); resolve(file); return; }

        const recorder = new MediaRecorder(stream, {
          mimeType: "video/webm",
          videoBitsPerSecond: 800_000,
        });
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

        let timeout: ReturnType<typeof setTimeout>;
        let raf: number;

        recorder.onstop = () => {
          clearTimeout(timeout);
          cancelAnimationFrame(raf);
          setIsTrimming(false);
          if (videoRef.current) { videoRef.current.playbackRate = 1; videoRef.current.currentTime = trimStart; }
          resolve(new Blob(chunks, { type: "video/webm" }));
        };

        const drawFrame = () => {
          if (video.paused || video.ended || video.currentTime > trimEnd) return;
          ctx.drawImage(video, 0, 0, w, h);
          raf = requestAnimationFrame(drawFrame);
        };

        video.currentTime = trimStart;
        video.playbackRate = 2.0;
        video.muted = true;

        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          video.play().then(() => {
            recorder.start(100);
            drawFrame();
            const check = setInterval(() => {
              if (video.currentTime >= trimEnd || video.ended) {
                clearInterval(check); video.pause();
                if (recorder.state !== "inactive") recorder.stop();
              }
            }, 50);
            timeout = setTimeout(() => {
              clearInterval(check);
              if (recorder.state !== "inactive") recorder.stop();
            }, ((trimEnd - trimStart) / 2.0) * 3000 + 4000);
          }).catch(() => { setIsTrimming(false); resolve(file); });
        };
        video.addEventListener("seeked", onSeeked);
      } catch { setIsTrimming(false); resolve(file); }
    });
  };

  // ── Map the DB row returned by /api/analyze-swing to the AnalysisResult shape ──
  function dbRowToResult(row: Record<string, unknown>): AnalysisResult {
    const m = (row.metrics as Record<string, unknown>) ?? {};
    const defs = (row.mechanical_deficiencies as DeficiencyItem[]) ?? [];
    const rawDrills = (Array.isArray(m.drills) ? m.drills : []) as Record<string, string>[];
    const mode = (() => {
      if (userTier === "eagle" || userTier === "coach_pro") return "ultra" as const;
      if (userTier === "birdie" || userTier === "coach_starter") return "advanced" as const;
      return "basic" as const;
    })();
    return {
      feedback:   String(row.feedback ?? ""),
      score:      typeof row.score === "number" ? row.score : 0,
      weakSpots:  defs.slice(0, 4).map((d) => d.fault_description ?? "").filter(Boolean),
      drills:     rawDrills.map((d) => ({
        name:     d.name     ?? "",
        why:      d.the_why  ?? "",
        how:      d.the_how  ?? "",
        feel:     d.the_feel ?? "",
        videoUrl: "",
      })),
      // Launch monitor data is not available in this flow — render shows "Not Connected"
      metrics: { swingSpeed: 0, ballSpeed: 0, launchAngle: 0, smashFactor: 0 },
      swing_highlights:       (row.swing_highlights as HighlightItem[]) ?? [],
      mechanical_deficiencies: defs,
      detailed_summary_html:  null,
      tempo_ratio:            typeof row.tempo_ratio === "number" ? row.tempo_ratio : null,
      swing_speed_mph:        null,
      _mode:                  mode,
    };
  }

  // ── Analysis flow ──────────────────────────────────────────────────────────
  const startAnalysis = async () => {
    if (!file) return;
    if (trimEnd - trimStart > MAX_SEGMENT_SECONDS) {
      setError(`Trim your segment to under ${MAX_SEGMENT_SECONDS}s for best results.`);
      return;
    }
    setIsAnalyzing(true); setError(null);

    try {
      const blob = await getTrimmedBlob();

      // Auth is required upfront — we need to upload the video before calling the API
      const session = getSessionFromCookie();
      if (!session) throw new Error("Not authenticated. Please sign in and try again.");
      const supabase = getAuthClient();

      // 1. Upload video to Supabase Storage
      const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storagePath = `${session.user_id}/${crypto.randomUUID()}/${safeFilename}`;
      const { error: uploadErr } = await supabase.storage
        .from(BUCKET).upload(storagePath, blob, { contentType: blob.type, upsert: false });
      if (uploadErr) throw new Error(`Video upload failed: ${uploadErr.message}`);

      // 2. Create the swing_videos record
      const { data: videoRow, error: videoErr } = await supabase
        .from("swing_videos").insert({
          user_id:           session.user_id,
          storage_path:      storagePath,
          video_url:         storagePath,
          original_filename: safeFilename,
          file_size:         blob.size,
          mime_type:         blob.type,
          trim_start:        trimStart,
          trim_end:          trimEnd,
          status:            "uploaded",
        }).select().single();
      if (videoErr || !videoRow) throw new Error(`Failed to register video: ${videoErr?.message}`);

      // 3. Create a pending swing_analysis row so the API route has an ID to work with
      const { data: analysisRow, error: analysisErr } = await supabase
        .from("swing_analysis").insert({
          swing_video_id: videoRow.id,
          user_id:        session.user_id,
          status:         "pending",
        }).select("id").single();
      if (analysisErr || !analysisRow) throw new Error(`Failed to create analysis record: ${analysisErr?.message}`);

      // 4. Call the direct Gemini pipeline — it fetches the video from Storage itself
      const analysisRes = await fetch("/api/analyze-swing", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ analysisId: analysisRow.id }),
      });

      if (!analysisRes.ok) {
        const err = await analysisRes.json().catch(() => ({}));
        throw new Error(err.error ?? `Analysis failed (${analysisRes.status})`);
      }

      const { data: updatedRow } = await analysisRes.json() as { data: Record<string, unknown> };
      setResult(dbRowToResult(updatedRow));

    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const setTime = (t: number) => { if (videoRef.current) videoRef.current.currentTime = t; };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-[calc(100vh-0px)] flex flex-col md:flex-row overflow-hidden">

      {/* ── LEFT: Video workspace ── */}
      <div className="w-full md:w-[600px] flex flex-col border-r border-white/10 bg-black flex-shrink-0 relative">

        {!previewUrl ? (
          <label className="flex-1 flex flex-col items-center justify-center cursor-pointer hover:bg-white/5 transition-colors group p-8 text-center">
            <input type="file" accept="video/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            <div className="w-20 h-20 bg-white/5 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-golf-green/10 transition-colors">
              <Upload className="w-10 h-10 text-gray-500 group-hover:text-golf-green transition-colors" />
            </div>
            <h3 className="text-xl font-black italic tracking-tighter text-white uppercase mb-2">Import Swing Video</h3>
            <p className="text-gray-500 text-sm max-w-xs mb-4">Up to {MAX_FILE_MB}MB — MP4, MOV, or WEBM</p>
            <div className="px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-left max-w-xs">
              <p className="text-[9px] text-golf-green font-black uppercase tracking-widest mb-1">Pro Tip</p>
              <p className="text-[10px] text-gray-500">Use the trim handles in the timeline to isolate just the swing segment before analyzing.</p>
            </div>
          </label>
        ) : (
          <div className="flex-1 relative bg-[#050505] flex flex-col items-center justify-center overflow-hidden">
            <div className="relative max-h-[75%] max-w-full flex items-center justify-center"
              style={{ aspectRatio: videoAspect ?? "auto" }}>
              <video ref={videoRef} src={previewUrl} className="max-h-full max-w-full object-contain" playsInline />

              {/* Biomechanics overlay */}
              {result && activeOverlay && (result.metrics as Record<string, OverlayMetric | number>)[activeOverlay] && (() => {
                const m = (result.metrics as unknown as Record<string, OverlayMetric>)[activeOverlay];
                if (!m?.overlay) return null;
                return (
                  <svg className="absolute inset-0 w-full h-full pointer-events-none z-10" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1={m.overlay.x1} y1={m.overlay.y1} x2={m.overlay.x2} y2={m.overlay.y2}
                      stroke="#fbbf24" strokeWidth="0.8" strokeDasharray="2,1" opacity="0.9" />
                  </svg>
                );
              })()}
            </div>

            {/* HUD telemetry overlay */}
            {result && (() => {
              const hasLaunchData = result.metrics.swingSpeed > 0 || result.metrics.ballSpeed > 0;
              const hudItems = [
                ...(result.metrics.swingSpeed > 0 ? [{ label: "Swing Speed", value: `${result.metrics.swingSpeed}`, unit: "MPH", color: "text-white" }] : []),
                ...(result.metrics.ballSpeed > 0  ? [{ label: "Ball Speed",  value: `${result.metrics.ballSpeed}`,  unit: "MPH", color: "text-golf-green" }] : []),
                { label: "Smash", value: result.metrics.smashFactor.toFixed(2), unit: "", color: "text-amber-400" },
              ];
              return (
                <div className="absolute top-4 left-4 z-30">
                  <div className="bg-black/70 backdrop-blur-md border border-white/10 px-5 py-3 rounded-2xl flex items-center gap-5 shadow-2xl">
                    {hasLaunchData ? hudItems.map((m, i) => (
                      <div key={i} className="text-center">
                        <p className="text-[8px] text-gray-500 font-black uppercase tracking-widest mb-0.5">{m.label}</p>
                        <p className={`text-lg font-black italic ${m.color}`}>{m.value}<span className="text-[9px] text-gray-600 ml-0.5">{m.unit}</span></p>
                      </div>
                    )) : (
                      <span className="text-[9px] font-black uppercase tracking-widest text-gray-600">No Launch Monitor</span>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Pro toggle */}
            <div className="absolute top-4 right-4 z-40">
              <button onClick={() => isAdvanced ? setIsAdvanced(false) : setShowProUpgrade(true)}
                className={`px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 ${
                  isAdvanced ? "bg-amber-400 text-black" : "bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10"
                }`}>
                <Zap size={12} />
                {isAdvanced ? "PRO ACTIVE" : "GET PRO"}
              </button>
            </div>

            {/* Error banner */}
            {error && (
              <div className="absolute top-16 left-4 right-4 z-50">
                <div className="bg-red-500/10 border border-red-500/40 backdrop-blur-xl p-4 rounded-xl flex items-start gap-3">
                  <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-sm text-white">{error}</p>
                  <button onClick={() => setError(null)} className="ml-auto text-gray-500 hover:text-white">
                    <X size={16} />
                  </button>
                </div>
              </div>
            )}

            {/* Loading overlay */}
            {(isAnalyzing || isTrimming) && (
              <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex flex-col items-center justify-center text-white z-50">
                <Loader2 className="w-14 h-14 animate-spin text-golf-green mb-6" />
                <h3 className="text-2xl font-black italic tracking-tighter uppercase mb-2">
                  {isTrimming ? "COMPRESSING CLIP" : "ANALYZING SWING"}
                </h3>
                <p className="text-gray-500 text-sm max-w-xs text-center">
                  {isTrimming ? "Trimming and compressing video in-browser..." : "Gemini AI computing launch telemetry and biomechanics..."}
                </p>
              </div>
            )}

            {/* Action bar */}
            {!isAnalyzing && !isTrimming && (
              <div className="absolute bottom-4 left-4 right-4 z-40">
                {!result ? (
                  <button onClick={startAnalysis}
                    className="w-full py-4 bg-golf-green text-golf-dark rounded-2xl font-black uppercase tracking-widest hover:bg-[#22C55E] transition-all flex items-center justify-center gap-3 shadow-[0_0_30px_rgba(74,222,128,0.3)]">
                    <Target size={18} />RUN ANALYZER
                  </button>
                ) : (
                  <div className="bg-black/80 backdrop-blur-md border border-white/10 p-4 rounded-2xl flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 size={20} className="text-golf-green" />
                      <div>
                        <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest">Status</p>
                        <p className="text-sm text-white font-bold">Analysis Complete</p>
                      </div>
                    </div>
                    <button onClick={() => { setFile(null); setPreviewUrl(null); setResult(null); }}
                      className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold text-white">
                      NEW VIDEO
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Timeline Scrubber ── */}
        <div className="h-28 bg-golf-header border-t border-white/10 px-6 flex flex-col justify-center">
          {previewUrl && duration > 0 ? (
            <>
              <div className="flex justify-between text-[10px] font-mono font-black text-gray-500 mb-2">
                <span>{trimStart.toFixed(2)}s</span>
                <span className="text-golf-green">{(trimEnd - trimStart).toFixed(2)}s Selected</span>
                <span>{trimEnd.toFixed(2)}s</span>
              </div>
              <div className="relative h-10 bg-gray-900 rounded-lg border border-white/5 flex items-center">
                {/* Selected region */}
                <div className="absolute h-full bg-golf-green/10 border-x-2 border-golf-green rounded-sm"
                  style={{ left: `${(trimStart / duration) * 100}%`, width: `${((trimEnd - trimStart) / duration) * 100}%` }} />
                {/* Playhead */}
                <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)] z-20 pointer-events-none"
                  style={{ left: `${(currentTime / duration) * 100}%` }} />
                {/* Trim start slider */}
                <input type="range" min={0} max={duration} step={0.01}
                  value={trimStart} disabled={isAnalyzing || isTrimming}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (v < trimEnd - 0.2) { setTrimStart(v); setTime(v); } }}
                  className="trim-slider absolute inset-0 w-full z-10" />
                {/* Trim end slider */}
                <input type="range" min={0} max={duration} step={0.01}
                  value={trimEnd} disabled={isAnalyzing || isTrimming}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (v > trimStart + 0.2) { setTrimEnd(v); setTime(v); } }}
                  className="trim-slider absolute inset-0 w-full z-10" />
              </div>
            </>
          ) : (
            <p className="text-center text-[10px] text-gray-700 font-black uppercase tracking-widest">Timeline Scrubber Idle</p>
          )}
        </div>
      </div>

      {/* ── RIGHT: Results deck ── */}
      <div className="flex-1 bg-[#12140F] overflow-y-auto">

        {/* ── Launch Monitor Panel ── */}
        <div className="border-b border-white/5 p-4">
          {canUseLaunchMonitor(userTier) ? (
            <div className="bg-golf-surface border border-white/5 rounded-3xl p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 bg-blue-500/10 rounded-xl flex items-center justify-center shrink-0">
                  <BarChart2 size={16} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-blue-400">Launch Monitor Data</p>
                  <p className="text-[10px] text-gray-600">CSV or JSON — TrackMan, Garmin, FlightScope, Rapsodo</p>
                </div>
                {lmFile && (
                  <button onClick={() => setLmFile(null)} className="ml-auto text-gray-600 hover:text-white">
                    <X size={14} />
                  </button>
                )}
              </div>
              {lmFile ? (
                <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl px-3 py-2">
                  <FileUp size={14} className="text-blue-400 shrink-0" />
                  <p className="text-xs text-blue-300 truncate">{lmFile.name}</p>
                  <span className="text-[9px] font-mono text-blue-500 ml-auto">
                    {(lmFile.size / 1024).toFixed(0)} KB
                  </span>
                </div>
              ) : (
                <label className="flex items-center gap-2 border border-dashed border-white/10 rounded-xl px-4 py-3 cursor-pointer hover:border-blue-500/30 transition-colors">
                  <Upload size={14} className="text-gray-600" />
                  <span className="text-[10px] text-gray-600 font-bold uppercase tracking-widest">
                    Attach launch data (optional)
                  </span>
                  <input type="file" accept=".csv,.json" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) setLmFile(f); }} />
                </label>
              )}
            </div>
          ) : (
            /* Par locked preview */
            <div className="bg-black/40 border border-white/5 rounded-3xl p-5 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent" />
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-3">
                  <Lock size={14} className="text-gray-500" />
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                    Launch Monitor Upload — Locked
                  </p>
                  <span className="ml-auto text-[9px] font-black uppercase tracking-widest text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
                    Birdie+
                  </span>
                </div>
                <p className="text-xs text-gray-600 mb-4 leading-relaxed">
                  Connect TrackMan, Garmin, FlightScope, or Rapsodo data.
                  AI fuses your launch metrics with video biomechanics for precision coaching.
                </p>
                <div className="grid grid-cols-2 gap-1.5 mb-4">
                  {["Club Speed","Ball Speed","Launch Angle","Spin Rate","Club Path","Face Angle","Attack Angle","Carry Yards"].map((m) => (
                    <div key={m} className="flex items-center gap-1.5 opacity-40">
                      <div className="w-1 h-1 rounded-full bg-blue-400" />
                      <span className="text-[9px] text-gray-500 font-bold">{m}</span>
                    </div>
                  ))}
                </div>
                <Link href="/upgrade"
                  className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-blue-400 hover:bg-blue-500/20 transition-colors">
                  <Zap size={12} />
                  Upgrade to Birdie to Unlock
                </Link>
              </div>
            </div>
          )}
        </div>

        {!result ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-12">
            <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center mb-6">
              <Activity size={28} className="text-gray-600" />
            </div>
            <h3 className="text-xl font-black italic tracking-tighter text-white uppercase mb-2">Awaiting Session</h3>
            <p className="text-gray-600 text-sm max-w-xs">Upload your swing video, trim to the impact zone, then hit Run Analyzer.</p>
          </div>
        ) : (
          <div className="p-6 space-y-6 pb-16">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em]">Live Mechanics Report</p>
              <div className="flex items-center gap-2">
                {result._mode && (
                  <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                    result._mode === "ultra" ? "text-amber-400 bg-amber-400/10 border-amber-400/20" :
                    result._mode === "advanced" ? "text-blue-400 bg-blue-500/10 border-blue-500/20" :
                    "text-gray-500 bg-white/5 border-white/10"
                  }`}>
                    {result._mode === "ultra" ? "Eagle Deep" : result._mode === "advanced" ? "Birdie AI" : "Par Basic"}
                  </span>
                )}
              </div>
            </div>

            {/* Par upsell banner */}
            {result._mode === "basic" && (
              <div className="bg-gradient-to-r from-golf-green/5 to-blue-500/5 border border-white/10 rounded-2xl p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-golf-green mb-1">Unlock Full AI Analysis</p>
                  <p className="text-xs text-gray-500">Get advanced biomechanics, launch monitor fusion, and unlimited swings with Birdie.</p>
                </div>
                <Link href="/upgrade"
                  className="shrink-0 px-4 py-2 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-xl text-[9px] hover:bg-[#22C55E] transition-all whitespace-nowrap">
                  Upgrade
                </Link>
              </div>
            )}

            {/* Score + status */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-golf-surface p-6 rounded-2xl border border-golf-green/20">
                <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest mb-2">Swing Score</p>
                <p className={`text-5xl font-black italic ${result.score >= 80 ? "text-golf-green" : result.score >= 60 ? "text-amber-400" : "text-red-400"}`}>
                  {result.score}
                </p>
              </div>
              <div className="bg-golf-surface p-6 rounded-2xl border border-white/5">
                <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest mb-2">Fault Tags</p>
                <div className="space-y-1">
                  {result.weakSpots.slice(0, 3).map((w, i) => (
                    <p key={i} className="text-[10px] text-gray-400 font-bold">· {w}</p>
                  ))}
                </div>
              </div>
            </div>

            {/* AI feedback */}
            <div className="p-5 bg-golf-green/5 border border-golf-green/20 rounded-2xl">
              <div className="flex items-center gap-2 mb-3">
                <Info size={14} className="text-golf-green" />
                <span className="text-[9px] font-black text-golf-green uppercase tracking-widest">AI Biomechanical Evaluation</span>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">{result.feedback}</p>
            </div>

            {/* Launch telemetry */}
            <div>
              <p className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em] mb-3">Launch Telemetry</p>
              {result.metrics.swingSpeed === 0 && result.metrics.ballSpeed === 0 ? (
                <div className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <Activity size={14} className="text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-gray-600">Launch Monitor Data Not Connected</p>
                    <p className="text-[10px] text-gray-700 mt-0.5">Connect a TrackMan, FlightScope, or compatible device to capture velocity and launch data.</p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ...(result.metrics.swingSpeed > 0 ? [{ label: "Swing Velocity", value: result.metrics.swingSpeed, unit: "MPH", color: "text-white" }] : []),
                    ...(result.metrics.ballSpeed  > 0 ? [{ label: "Ball Velocity",  value: result.metrics.ballSpeed,  unit: "MPH", color: "text-golf-green" }] : []),
                    { label: "Launch Angle",  value: `${result.metrics.launchAngle}°`,       unit: "", color: "text-blue-400" },
                    { label: "Smash Factor",  value: result.metrics.smashFactor.toFixed(2),  unit: "", color: "text-amber-400" },
                  ].map((m, i) => (
                    <div key={i} className="bg-golf-surface p-4 rounded-xl border border-white/5">
                      <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest mb-1">{m.label}</p>
                      <p className={`text-2xl font-black italic ${m.color}`}>{m.value}<span className="text-[10px] text-gray-600 ml-1">{m.unit}</span></p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pro advanced metrics */}
            {isAdvanced && (
              <div>
                <p className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em] mb-3">Pro Biomechanics</p>
                <div className="space-y-2">
                  {(["wristHinge", "hipRotation", "shoulderRotation", "headStability"] as const).map((key) => {
                    const m = result.metrics[key];
                    if (!m) return null;
                    return (
                      <button key={key} onClick={() => setActiveOverlay(activeOverlay === key ? null : key)}
                        className={`w-full p-4 rounded-xl border flex items-center justify-between text-left transition-all ${
                          activeOverlay === key ? "border-amber-400/50 bg-amber-400/5" : "border-white/5 bg-golf-surface hover:border-white/10"
                        }`}>
                        <div>
                          <p className="text-[9px] text-gray-500 font-black uppercase tracking-widest mb-1 group-hover:text-amber-400">
                            {key.replace(/([A-Z])/g, " $1")}
                          </p>
                          <p className="text-xs text-gray-300 line-clamp-1">{m.feedback}</p>
                        </div>
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ml-3 shrink-0 ${
                          activeOverlay === key ? "bg-amber-400 text-black" : "bg-white/5 text-gray-500"
                        }`}>
                          <Zap size={12} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Drills */}
            <div>
              <p className="text-[10px] font-black text-gray-600 uppercase tracking-[0.2em] mb-3">Prescribed Corrective Drills</p>
              <div className="space-y-4">
                {result.drills.map((drill, i) => (
                  <div key={i} className="p-5 bg-golf-surface rounded-2xl border border-white/5 hover:border-golf-green/30 transition-all">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-golf-green/10 rounded-xl flex items-center justify-center text-golf-green">
                          <Play size={16} />
                        </div>
                        <h4 className="font-black text-white">{drill.name}</h4>
                      </div>
                      <button onClick={() => setActiveDrillVideo(drill.videoUrl)}
                        className="p-1.5 hover:bg-white/5 rounded-lg text-gray-500 hover:text-white">
                        <Maximize2 size={14} />
                      </button>
                    </div>
                    {drill.videoUrl && (
                      <div className="aspect-video rounded-xl overflow-hidden bg-black/40 mb-4 border border-white/5">
                        <iframe src={`${formatYt(drill.videoUrl)}?rel=0`} className="w-full h-full" allowFullScreen />
                      </div>
                    )}
                    <div className="space-y-3">
                      <div><p className="text-[9px] font-black text-golf-green uppercase tracking-widest mb-0.5">The Why</p><p className="text-xs text-gray-400">{drill.why}</p></div>
                      <div><p className="text-[9px] font-black text-blue-400 uppercase tracking-widest mb-0.5">The How</p><p className="text-xs text-gray-300">{drill.how}</p></div>
                      <div><p className="text-[9px] font-black text-amber-400 uppercase tracking-widest mb-0.5">The Feel</p><p className="text-xs text-gray-300 italic">"{drill.feel}"</p></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Drill video modal */}
      {activeDrillVideo && (
        <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4">
          <button onClick={() => setActiveDrillVideo(null)}
            className="absolute top-6 right-6 w-10 h-10 bg-white/10 rounded-full flex items-center justify-center text-white hover:bg-white/20">
            <X size={20} />
          </button>
          <div className="w-full max-w-4xl aspect-video bg-black rounded-3xl overflow-hidden border border-white/10">
            <iframe src={`${formatYt(activeDrillVideo)}?autoplay=1`} className="w-full h-full" allowFullScreen />
          </div>
        </div>
      )}

      {/* Pro upgrade modal */}
      {showProUpgrade && (
        <div className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-xl flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-golf-surface border border-amber-400/30 rounded-[2.5rem] p-10 text-center">
            <div className="w-16 h-16 bg-amber-400/10 rounded-3xl flex items-center justify-center mx-auto mb-6">
              <Trophy size={32} className="text-amber-400" />
            </div>
            <h3 className="text-3xl font-black italic tracking-tighter text-white uppercase mb-3">Unlock Pro Metrics</h3>
            <p className="text-gray-400 text-sm mb-8">Forensic posture vectors, hinge separation, and hip rotation overlays.</p>
            <button onClick={() => { setIsAdvanced(true); setShowProUpgrade(false); }}
              className="w-full py-4 bg-amber-400 text-black rounded-2xl font-black uppercase tracking-widest mb-3 hover:bg-amber-300 transition-colors">
              Activate Pro Mode
            </button>
            <button onClick={() => setShowProUpgrade(false)}
              className="w-full py-3 text-[10px] text-gray-500 font-black uppercase tracking-widest">
              Continue with Basic
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
