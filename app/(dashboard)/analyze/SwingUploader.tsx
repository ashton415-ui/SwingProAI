"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  Video,
  X,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Zap,
  FileVideo,
  RotateCcw,
} from "lucide-react";
import { getSignedUploadUrl, recordPendingAnalysis } from "./upload-actions";

// ── Constants ─────────────────────────────────────────────────────────────────

const ACCEPTED_EXTENSIONS = [".mp4", ".mov"];
const ACCEPTED_MIME = ["video/mp4", "video/quicktime"];
const MAX_MB = 250;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

function isAccepted(f: File): boolean {
  const ext = "." + f.name.split(".").pop()?.toLowerCase();
  return (
    ACCEPTED_MIME.includes(f.type) ||
    ACCEPTED_EXTENSIONS.includes(ext)
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Stage =
  | "idle"        // no file selected
  | "ready"       // file selected, waiting for upload click
  | "signing"     // calling server action to get signed URL
  | "uploading"   // XHR to Supabase Storage in progress
  | "saving"      // calling server action to insert DB rows
  | "processing"  // upload complete, analysis pending
  | "error";

// ── Component ─────────────────────────────────────────────────────────────────

export default function SwingUploader() {
  const router = useRouter();
  const [file, setFile]           = useState<File | null>(null);
  const [stage, setStage]         = useState<Stage>("idle");
  const [progress, setProgress]   = useState(0);
  const [error, setError]         = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef   = useRef<XMLHttpRequest | null>(null);

  // ── File selection ─────────────────────────────────────────────────────────

  const pickFile = useCallback((f: File) => {
    if (!isAccepted(f)) {
      setError("Please select an MP4 or MOV file.");
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`File too large — maximum ${MAX_MB} MB.`);
      return;
    }
    setFile(f);
    setError(null);
    setStage("ready");
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) pickFile(f);
  };

  // ── Upload flow ────────────────────────────────────────────────────────────

  const startUpload = async () => {
    if (!file) return;
    setError(null);
    setProgress(0);

    // Step 1 — get signed URL from server
    setStage("signing");
    const { signedUrl, path, error: urlError } = await getSignedUploadUrl(
      file.name,
      file.type || "video/mp4"
    );

    if (urlError || !signedUrl || !path) {
      setError(urlError ?? "Failed to prepare upload. Please try again.");
      setStage("error");
      return;
    }

    // Step 2 — XHR upload directly to Supabase Storage (real progress events)
    setStage("uploading");

    const uploadOk = await new Promise<boolean>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;

      xhr.open("PUT", signedUrl, true);
      xhr.setRequestHeader("Content-Type", file.type || "video/mp4");

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        xhrRef.current = null;
        resolve(xhr.status >= 200 && xhr.status < 300);
      };

      xhr.onerror = () => {
        xhrRef.current = null;
        resolve(false);
      };

      xhr.send(file);
    });

    if (!uploadOk) {
      setError("Upload failed. Please check your connection and try again.");
      setStage("error");
      return;
    }

    setProgress(100);

    // Step 3 — record in DB via server action
    setStage("saving");
    const { analysisId: id, error: dbError } = await recordPendingAnalysis(
      path,
      file.name,
      file.size,
      file.type || "video/mp4"
    );

    if (dbError) {
      setError(dbError);
      setStage("error");
      return;
    }

    setAnalysisId(id ?? null);
    setStage("processing");

    // Redirect to result page after a brief moment so the user sees the
    // "processing" state before the page navigates.
    if (id) {
      setTimeout(() => router.push(`/analyze/${id}`), 1200);
    }
  };

  const reset = () => {
    xhrRef.current?.abort();
    setFile(null);
    setStage("idle");
    setProgress(0);
    setError(null);
    setAnalysisId(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  // ── Render: processing complete ────────────────────────────────────────────

  if (stage === "processing") {
    return (
      <div className="bg-golf-header border border-white/5 rounded-2xl p-8 text-center">
        {/* Pulsing status dot */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-50" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-400" />
          </span>
          <span className="text-[10px] font-black uppercase tracking-widest text-amber-400">
            AI Analysis · Pending
          </span>
        </div>

        <div className="w-14 h-14 rounded-2xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-7 h-7 text-golf-green" />
        </div>

        <h3 className="text-lg font-black italic tracking-tighter uppercase text-white mb-2">
          Upload Complete
        </h3>
        <p className="text-sm text-gray-400 mb-1 truncate max-w-xs mx-auto">
          {file?.name}
        </p>
        <p className="text-xs text-gray-600 mb-6">
          Your swing is queued. The AI engine will process it shortly.
        </p>

        {analysisId && (
          <p className="text-[10px] font-mono text-gray-700 mb-5">
            Analysis ID: {analysisId}
          </p>
        )}

        {/* Fake progress steps */}
        <div className="space-y-2 mb-7 text-left max-w-xs mx-auto">
          {[
            { label: "Video uploaded to storage", done: true },
            { label: "Analysis record created",   done: true },
            { label: "AI engine processing",       done: false, active: true },
          ].map((step) => (
            <div key={step.label} className="flex items-center gap-3">
              {step.done ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-golf-green shrink-0" />
              ) : step.active ? (
                <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border border-white/10 shrink-0" />
              )}
              <span className={`text-xs ${step.done ? "text-gray-400" : step.active ? "text-amber-400" : "text-gray-700"}`}>
                {step.label}
              </span>
            </div>
          ))}
        </div>

        <button
          onClick={reset}
          className="flex items-center justify-center gap-2 mx-auto px-5 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Upload Another
        </button>
      </div>
    );
  }

  // ── Render: upload in progress ─────────────────────────────────────────────

  if (stage === "signing" || stage === "uploading" || stage === "saving") {
    const label =
      stage === "signing"   ? "Preparing upload…" :
      stage === "saving"    ? "Saving record…"    :
      `Uploading… ${progress}%`;

    const barWidth =
      stage === "signing" ? 4 :
      stage === "saving"  ? 100 :
      progress;

    return (
      <div className="bg-golf-header border border-white/5 rounded-2xl p-6">
        {/* File info row */}
        <div className="flex items-center gap-4 mb-5">
          <div className="w-10 h-10 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center shrink-0">
            <FileVideo className="w-5 h-5 text-golf-green" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white truncate">{file?.name}</p>
            <p className="text-[11px] text-gray-600">{formatBytes(file?.size ?? 0)}</p>
          </div>
          {stage === "uploading" && (
            <span className="text-xs font-mono font-black text-golf-green shrink-0">
              {progress}%
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden mb-2">
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${
              stage === "saving" ? "bg-golf-green" : "bg-golf-green"
            } ${stage === "signing" ? "animate-pulse" : ""}`}
            style={{ width: `${barWidth}%` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600">
            {label}
          </p>
          {stage === "uploading" && (
            <button
              onClick={reset}
              className="text-[10px] text-gray-700 hover:text-gray-400 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Render: idle / ready / error ──────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => stage !== "ready" && inputRef.current?.click()}
        className={`relative bg-golf-header border rounded-2xl transition-all ${
          stage === "ready"
            ? "border-golf-green/30 cursor-default"
            : isDragging
            ? "border-golf-green/50 bg-golf-green/[0.04] cursor-copy"
            : "border-white/[0.08] hover:border-white/20 cursor-pointer"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,video/mp4,video/quicktime"
          className="hidden"
          onChange={handleInputChange}
        />

        {stage !== "ready" ? (
          /* ── Empty state ── */
          <div className="flex flex-col items-center justify-center py-14 px-8 text-center">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-5 transition-all ${
              isDragging
                ? "bg-golf-green/15 border border-golf-green/30"
                : "bg-white/[0.03] border border-white/[0.08]"
            }`}>
              <Upload className={`w-7 h-7 transition-colors ${isDragging ? "text-golf-green" : "text-gray-600"}`} />
            </div>
            <p className="text-sm font-bold text-white mb-1.5">
              {isDragging ? "Drop to upload" : "Drag & drop your swing video"}
            </p>
            <p className="text-[11px] text-gray-600 mb-5">
              MP4 or MOV &nbsp;·&nbsp; Up to {MAX_MB} MB
            </p>
            <span className="text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-gray-500 hover:text-gray-300 transition-colors">
              Browse Files
            </span>
          </div>
        ) : (
          /* ── File selected ── */
          <div className="flex items-center gap-4 p-5">
            <div className="w-10 h-10 rounded-xl bg-golf-green/10 border border-golf-green/20 flex items-center justify-center shrink-0">
              <Video className="w-5 h-5 text-golf-green" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white truncate">{file!.name}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">{formatBytes(file!.size)}</p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); reset(); }}
              className="p-1.5 rounded-lg text-gray-600 hover:text-white hover:bg-white/10 transition-colors shrink-0"
              aria-label="Remove file"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 px-4 py-3 bg-red-400/10 border border-red-400/20 rounded-xl">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-300 leading-relaxed">{error}</p>
        </div>
      )}

      {/* Primary action */}
      {stage === "ready" && (
        <button
          onClick={startUpload}
          className="w-full flex items-center justify-center gap-2.5 py-3.5 rounded-xl bg-golf-green hover:bg-golf-green/90 active:scale-[0.99] text-sm font-black uppercase tracking-widest text-white transition-all shadow-[0_0_20px_rgba(74,222,128,0.12)]"
        >
          <Zap className="w-4 h-4" />
          Upload &amp; Analyse
        </button>
      )}

      {stage === "error" && (
        <button
          onClick={reset}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-white/10 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Try Again
        </button>
      )}
    </div>
  );
}
