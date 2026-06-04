"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { Upload, Video, X, CheckCircle, AlertCircle, Zap } from "lucide-react";

const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_SIZE_MB = 500;
const BUCKET = "swing-videos";

const CLUBS = [
  "Driver", "3-Wood", "5-Wood", "2-Iron", "3-Iron", "4-Iron",
  "5-Iron", "6-Iron", "7-Iron", "8-Iron", "9-Iron",
  "Pitching Wedge", "Gap Wedge", "Sand Wedge", "Lob Wedge", "Putter",
];

type UploadState = "idle" | "uploading" | "success" | "error";

/** Get access token from the session cookie set by our login flow */
function getAccessTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const cookieName = "sb-atlmnqispyzhsahahpjy-auth-token";
    const match = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${cookieName}=`));
    if (!match) return null;
    const raw = match.split("=").slice(1).join("=");
    const decoded = decodeURIComponent(raw);
    const session = JSON.parse(decoded);
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Create a Supabase client authenticated with the user's access token */
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

export default function AnalyzePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [club, setClub] = useState("");
  const [title, setTitle] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const validateFile = (f: File): string | null => {
    if (!ALLOWED_TYPES.includes(f.type))
      return "Invalid file type. Please upload .mp4, .mov, or .webm.";
    if (f.size > MAX_SIZE_MB * 1024 * 1024)
      return `File too large. Max ${MAX_SIZE_MB}MB.`;
    return null;
  };

  const handleFile = useCallback((f: File) => {
    const err = validateFile(f);
    if (err) { setErrorMsg(err); setFile(null); return; }
    setErrorMsg(null);
    setFile(f);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) handleFile(dropped);
  }, [handleFile]);

  const formatSize = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

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

    // Generate storage path: userId/videoId/filename
    const videoId = crypto.randomUUID();
    const userId = (() => {
      try {
        const payload = accessToken.split(".")[1];
        return JSON.parse(atob(payload)).sub;
      } catch { return "unknown"; }
    })();
    const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${userId}/${videoId}/${safeFilename}`;

    // Simulate progress
    const progressInterval = setInterval(() => {
      setProgress((p) => Math.min(p + 3, 85));
    }, 500);

    try {
      // Upload directly to Supabase Storage from the browser
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { contentType: file.type, upsert: false });

      clearInterval(progressInterval);

      if (uploadError) throw new Error(uploadError.message);

      setProgress(95);

      // Notify our API to create the DB record
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
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to save record");
      }

      setProgress(100);
      setUploadState("success");
    } catch (err) {
      clearInterval(progressInterval);
      setUploadState("error");
      setErrorMsg(err instanceof Error ? err.message : "Upload failed.");
    }
  };

  const reset = () => {
    setFile(null); setClub(""); setTitle("");
    setUploadState("idle"); setProgress(0); setErrorMsg(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <div className="mb-10">
        <h1 className="text-4xl font-black italic tracking-tighter text-white uppercase">
          Analyze Swing
        </h1>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gray-500 mt-1">
          Upload a video to begin AI telemetry processing
        </p>
      </div>

      {uploadState === "success" && (
        <div className="bg-golf-green/10 border border-golf-green/30 rounded-5xl p-8 text-center">
          <CheckCircle size={40} className="text-golf-green mx-auto mb-4" />
          <h3 className="text-xl font-black italic tracking-tighter text-white uppercase mb-2">
            Upload Complete
          </h3>
          <p className="text-sm text-gray-400 mb-6">
            Your swing video is queued for AI analysis.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              onClick={() => router.push("/dashboard")}
              className="px-6 py-3 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] transition-all text-[10px]"
            >
              View Dashboard
            </button>
            <button
              onClick={reset}
              className="px-6 py-3 bg-white/5 border border-white/10 text-white font-black uppercase tracking-widest rounded-2xl hover:bg-white/10 transition-all text-[10px]"
            >
              Upload Another
            </button>
          </div>
        </div>
      )}

      {uploadState !== "success" && (
        <div className="space-y-6">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => !file && fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-5xl p-10 text-center transition-all cursor-pointer ${
              dragOver ? "border-golf-green bg-golf-green/10"
              : file ? "border-golf-green/40 bg-golf-green/5 cursor-default"
              : "border-white/10 bg-golf-surface hover:border-golf-green/30"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".mp4,.mov,.webm"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              className="hidden"
            />
            {file ? (
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-golf-green/10 border border-golf-green/20 rounded-2xl flex items-center justify-center shrink-0">
                  <Video size={20} className="text-golf-green" />
                </div>
                <div className="flex-1 text-left min-w-0">
                  <p className="text-sm font-bold text-white truncate">{file.name}</p>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mt-0.5">
                    {formatSize(file.size)} · {file.type.split("/")[1].toUpperCase()}
                  </p>
                </div>
                <button onClick={(e) => { e.stopPropagation(); reset(); }} className="p-2 text-gray-600 hover:text-white">
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div>
                <div className="w-14 h-14 bg-white/5 border border-white/10 rounded-3xl flex items-center justify-center mx-auto mb-4">
                  <Upload size={22} className="text-gray-500" />
                </div>
                <p className="text-sm font-bold text-white mb-1">Drop your swing video here</p>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600">
                  or click to browse · MP4, MOV, WEBM · Max {MAX_SIZE_MB}MB
                </p>
              </div>
            )}
          </div>

          {errorMsg && (
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-2xl px-5 py-4">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs font-bold text-red-400">{errorMsg}</p>
            </div>
          )}

          {file && uploadState === "idle" && (
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
          )}

          {uploadState === "uploading" && (
            <div className="bg-golf-surface border border-white/5 rounded-4xl p-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Uploading telemetry...</p>
                <p className="text-[10px] font-mono font-black text-golf-green">{Math.round(progress)}%</p>
              </div>
              <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden">
                <div className="h-full bg-golf-green rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {file && uploadState === "idle" && (
            <button onClick={handleUpload}
              className="w-full py-4 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl hover:bg-[#22C55E] transition-all flex items-center justify-center gap-2 text-sm shadow-[0_0_20px_rgba(74,222,128,0.15)]">
              <Zap size={16} />Submit for AI Analysis
            </button>
          )}

          {uploadState === "uploading" && (
            <button disabled className="w-full py-4 bg-golf-green/40 text-golf-dark font-black uppercase tracking-widest rounded-2xl text-sm opacity-60 cursor-not-allowed">
              Uploading...
            </button>
          )}
        </div>
      )}
    </div>
  );
}
