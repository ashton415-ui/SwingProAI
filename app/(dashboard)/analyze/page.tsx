"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { Upload, Video, X, CheckCircle, AlertCircle, Zap, Scissors, Play, Pause } from "lucide-react";

const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_SIZE_MB = 500;
const BUCKET = "swing-videos";

const CLUBS = [
  "Driver", "3-Wood", "5-Wood", "2-Iron", "3-Iron", "4-Iron",
  "5-Iron", "6-Iron", "7-Iron", "8-Iron", "9-Iron",
  "Pitching Wedge", "Gap Wedge", "Sand Wedge", "Lob Wedge", "Putter",
];

type UploadState = "idle" | "preview" | "uploading" | "success" | "error";

function getAccessTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const cookieName = "sb-atlmnqispyzhsahahpjy-auth-token";
    const match = document.cookie.split("; ").find((c) => c.startsWith(`${cookieName}=`));
    if (!match) return null;
    const raw = match.split("=").slice(1).join("=");
    const session = JSON.parse(decodeURIComponent(raw));
    return session?.access_token ?? null;
  } catch { return null; }
}

function getAuthenticatedClient(accessToken: string) {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

export default function AnalyzePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);

  const [club, setClub] = useState("");
  const [title, setTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Create object URL for preview
  useEffect(() => {
    if (!file) { setVideoUrl(null); return; }
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Sync video playhead with trim range
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      setCurrentTime(video.currentTime);
      if (video.currentTime >= trimEnd && trimEnd > 0) {
        video.pause();
        video.currentTime = trimStart;
        setIsPlaying(false);
      }
    };
    const onLoaded = () => {
      setDuration(video.duration);
      setTrimStart(0);
      setTrimEnd(video.duration);
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("pause", () => setIsPlaying(false));
    video.addEventListener("play", () => setIsPlaying(true));
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [trimEnd, trimStart]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
    } else {
      if (video.currentTime >= trimEnd || video.currentTime < trimStart) {
        video.currentTime = trimStart;
      }
      video.play();
    }
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    setCurrentTime(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  };

  const handleTrimStart = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Math.min(parseFloat(e.target.value), trimEnd - 0.5);
    setTrimStart(val);
    if (videoRef.current) videoRef.current.currentTime = val;
  };

  const handleTrimEnd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Math.max(parseFloat(e.target.value), trimStart + 0.5);
    setTrimEnd(val);
  };

  const validateFile = (f: File): string | null => {
    if (!ALLOWED_TYPES.includes(f.type)) return "Invalid file type. Use .mp4, .mov, or .webm.";
    if (f.size > MAX_SIZE_MB * 1024 * 1024) return `File too large. Max ${MAX_SIZE_MB}MB.`;
    return null;
  };

  const handleFile = useCallback((f: File) => {
    const err = validateFile(f);
    if (err) { setErrorMsg(err); setFile(null); return; }
    setErrorMsg(null);
    setFile(f);
    setUploadState("preview");
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const handleUpload = async () => {
    if (!file) return;
    setUploadState("uploading");
    setProgress(0);
    setErrorMsg(null);

    const accessToken = getAccessTokenFromCookie();
    if (!accessToken) {
      setErrorMsg("Session expired. Please log in again.");
      setUploadState("error");
      return;
    }

    const supabase = getAuthenticatedClient(accessToken);
    const videoId = crypto.randomUUID();
    const userId = (() => {
      try { return JSON.parse(atob(accessToken.split(".")[1])).sub; }
      catch { return "unknown"; }
    })();
    const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${userId}/${videoId}/${safeFilename}`;

    const progressInterval = setInterval(() => {
      setProgress((p) => Math.min(p + 3, 85));
    }, 500);

    try {
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { contentType: file.type, upsert: false });

      clearInterval(progressInterval);
      if (uploadError) throw new Error(uploadError.message);

      setProgress(95);

      const res = await fetch("/api/v1/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath,
          originalFilename: safeFilename,
          fileSize: file.size,
          mimeType: file.type,
          club: club.toLowerCase().replace(/\s+/g, "-") || null,
          title: title || null,
          trimStart: Math.round(trimStart * 1000) / 1000,
          trimEnd: Math.round(trimEnd * 1000) / 1000,
        }),
      });

      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save");
      setProgress(100);
      setUploadState("success");
    } catch (err) {
      clearInterval(progressInterval);
      setUploadState("error");
      setErrorMsg(err instanceof Error ? err.message : "Upload failed.");
    }
  };

  const reset = () => {
    setFile(null); setVideoUrl(null); setClub(""); setTitle("");
    setUploadState("idle"); setProgress(0); setErrorMsg(null);
    setTrimStart(0); setTrimEnd(0); setDuration(0); setCurrentTime(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const trimDuration = trimEnd - trimStart;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-10">
        <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase">Analyze Swing</h1>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
          Upload · Trim · Submit for AI Analysis
        </p>
      </div>

      {/* Success */}
      {uploadState === "success" && (
        <div className="bg-golf-green/10 border border-golf-green/30 rounded-5xl p-8 text-center">
          <CheckCircle size={40} className="text-golf-green mx-auto mb-4" />
          <h3 className="text-xl font-black italic tracking-tighter text-white uppercase mb-2">Upload Complete</h3>
          <p className="text-sm text-gray-400 mb-6">Your swing video is queued for AI analysis.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button onClick={() => router.push("/dashboard")}
              className="px-6 py-3 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] transition-all text-[10px]">
              View Dashboard
            </button>
            <button onClick={reset}
              className="px-6 py-3 bg-white/5 border border-white/10 text-white font-black uppercase tracking-widest rounded-2xl hover:bg-white/10 transition-all text-[10px]">
              Upload Another
            </button>
          </div>
        </div>
      )}

      {/* Drop zone (idle) */}
      {uploadState === "idle" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-5xl p-12 text-center cursor-pointer transition-all ${
            dragOver ? "border-golf-green bg-golf-green/10" : "border-white/10 bg-golf-surface hover:border-golf-green/30"
          }`}
        >
          <input ref={fileInputRef} type="file" accept=".mp4,.mov,.webm"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} className="hidden" />
          <div className="w-14 h-14 bg-white/5 border border-white/10 rounded-3xl flex items-center justify-center mx-auto mb-4">
            <Upload size={22} className="text-gray-500" />
          </div>
          <p className="text-sm font-bold text-white mb-1">Drop your swing video here</p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600">
            MP4 · MOV · WEBM · Max {MAX_SIZE_MB}MB
          </p>
        </div>
      )}

      {/* Video preview + trim (preview state) */}
      {uploadState === "preview" && videoUrl && (
        <div className="space-y-6">
          {/* Video player */}
          <div className="bg-black rounded-4xl overflow-hidden border border-white/10 relative">
            <video
              ref={videoRef}
              src={videoUrl}
              className="w-full max-h-64 object-contain bg-black"
              preload="metadata"
            />

            {/* Play/pause overlay */}
            <button
              onClick={togglePlay}
              className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors"
            >
              <div className="w-12 h-12 bg-black/60 border border-white/20 rounded-full flex items-center justify-center">
                {isPlaying
                  ? <Pause size={20} className="text-white" />
                  : <Play size={20} className="text-white ml-1" />
                }
              </div>
            </button>
          </div>

          {/* Trim controls */}
          {duration > 0 && (
            <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 space-y-5">
              <div className="flex items-center gap-2 mb-2">
                <Scissors size={14} className="text-golf-green" />
                <p className="text-[10px] font-black uppercase tracking-widest text-golf-green">Trim Swing Segment</p>
                <span className="ml-auto text-[10px] font-mono text-gray-400">
                  {formatTime(trimStart)} → {formatTime(trimEnd)}
                  <span className="text-golf-green ml-2">({formatTime(trimDuration)})</span>
                </span>
              </div>

              {/* Scrub timeline */}
              <div>
                <label className="block text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">Scrub</label>
                <input
                  type="range" min={0} max={duration} step={0.033}
                  value={currentTime}
                  onChange={handleScrub}
                  className="w-full h-1 appearance-none bg-white/10 rounded-full outline-none"
                  style={{
                    background: `linear-gradient(to right, #4ADE80 ${(currentTime / duration) * 100}%, rgba(255,255,255,0.1) ${(currentTime / duration) * 100}%)`
                  }}
                />
                <div className="flex justify-between text-[9px] font-mono text-gray-600 mt-1">
                  <span>{formatTime(0)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

              {/* Trim start */}
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-[9px] font-black uppercase tracking-widest text-gray-600">Trim Start</label>
                  <span className="text-[9px] font-mono text-golf-green">{formatTime(trimStart)}</span>
                </div>
                <input
                  type="range" min={0} max={duration} step={0.033}
                  value={trimStart}
                  onChange={handleTrimStart}
                  className="w-full h-1 appearance-none rounded-full outline-none"
                  style={{
                    background: `linear-gradient(to right, rgba(255,255,255,0.1) ${(trimStart / duration) * 100}%, #4ADE80 ${(trimStart / duration) * 100}%, #4ADE80 ${(trimEnd / duration) * 100}%, rgba(255,255,255,0.1) ${(trimEnd / duration) * 100}%)`
                  }}
                />
              </div>

              {/* Trim end */}
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-[9px] font-black uppercase tracking-widest text-gray-600">Trim End</label>
                  <span className="text-[9px] font-mono text-golf-green">{formatTime(trimEnd)}</span>
                </div>
                <input
                  type="range" min={0} max={duration} step={0.033}
                  value={trimEnd}
                  onChange={handleTrimEnd}
                  className="w-full h-1 appearance-none rounded-full outline-none"
                  style={{
                    background: `linear-gradient(to right, rgba(255,255,255,0.1) ${(trimStart / duration) * 100}%, #4ADE80 ${(trimStart / duration) * 100}%, #4ADE80 ${(trimEnd / duration) * 100}%, rgba(255,255,255,0.1) ${(trimEnd / duration) * 100}%)`
                  }}
                />
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 space-y-5">
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">Club Used (optional)</label>
              <select value={club} onChange={(e) => setClub(e.target.value)}
                className="w-full px-4 py-3 bg-black/40 border border-white/10 rounded-2xl text-white focus:outline-none text-sm appearance-none">
                <option value="">Select club...</option>
                {CLUBS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">Session Title (optional)</label>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Range session — working on tempo"
                className="w-full px-4 py-3 bg-black/40 border border-white/10 rounded-2xl text-white placeholder-gray-600 focus:outline-none text-sm" />
            </div>
          </div>

          {/* File info + change */}
          <div className="flex items-center gap-3 px-4 py-3 bg-golf-surface border border-white/5 rounded-2xl">
            <Video size={14} className="text-golf-green shrink-0" />
            <p className="text-sm font-bold text-gray-300 truncate flex-1">{file?.name}</p>
            <button onClick={reset} className="text-gray-600 hover:text-white text-[10px] font-black uppercase tracking-widest shrink-0">
              Change
            </button>
          </div>

          {errorMsg && (
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs font-bold text-red-400">{errorMsg}</p>
            </div>
          )}

          <button onClick={handleUpload}
            className="w-full py-4 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] transition-all flex items-center justify-center gap-2 text-sm shadow-[0_0_20px_rgba(74,222,128,0.15)]">
            <Zap size={16} />
            Submit {duration > 0 ? `${formatTime(trimDuration)} Segment` : "for AI Analysis"}
          </button>
        </div>
      )}

      {/* Uploading */}
      {uploadState === "uploading" && (
        <div className="space-y-6">
          <div className="bg-golf-surface border border-white/5 rounded-4xl p-8 text-center">
            <div className="w-16 h-16 bg-golf-green/10 border border-golf-green/20 rounded-3xl flex items-center justify-center mx-auto mb-6">
              <Zap size={24} className="text-golf-green" />
            </div>
            <p className="text-[10px] font-black uppercase tracking-widest text-white mb-6">Uploading Telemetry</p>
            <div className="w-full bg-white/5 h-2 rounded-full overflow-hidden mb-2">
              <div className="h-full bg-golf-green rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-[10px] font-mono text-golf-green">{Math.round(progress)}%</p>
          </div>
        </div>
      )}

      {/* Error */}
      {uploadState === "error" && errorMsg && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-4xl px-6 py-5">
            <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
            <p className="text-sm font-bold text-red-400">{errorMsg}</p>
          </div>
          <button onClick={reset}
            className="w-full py-3 bg-white/5 border border-white/10 text-white font-black uppercase tracking-widest rounded-2xl hover:bg-white/10 transition-all text-[10px]">
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
