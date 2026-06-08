'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { Video, Upload, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

type Stage = 'idle' | 'uploading' | 'saving' | 'done' | 'error';

const CLUBS = ['Driver', '3-Wood', '5-Wood', '3-Hybrid', '4-Iron', '5-Iron', '6-Iron', '7-Iron', '8-Iron', '9-Iron', 'PW', 'GW', 'SW', 'LW', 'Putter'];
const BUCKET = 'swing-videos';

export default function AnalyzePage() {
  const router = useRouter();
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [club, setClub] = useState('Driver');
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (picked) setFile(picked);
  }

  async function handleUpload() {
    if (!file) return;
    setError(null);
    setStage('uploading');
    setProgress(10);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setError('Not signed in.'); setStage('error'); return; }

    // Upload to Supabase Storage
    const ext = file.name.split('.').pop() ?? 'mp4';
    const storagePath = `${user.id}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file, { cacheControl: '3600', upsert: false });

    if (upErr) { setError(upErr.message); setStage('error'); return; }
    setProgress(55);

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const videoUrl = urlData.publicUrl;

    setStage('saving');
    setProgress(75);

    // Create swing_videos row
    const { data: videoRow, error: vidErr } = await supabase
      .from('swing_videos')
      .insert({
        user_id: user.id,
        club,
        video_url: videoUrl,
        storage_path: storagePath,
        original_filename: file.name,
        file_size: file.size,
        mime_type: file.type || 'video/mp4',
      })
      .select('id')
      .single();

    if (vidErr || !videoRow) { setError(vidErr?.message ?? 'Failed to save video.'); setStage('error'); return; }

    // Create swing_analysis row
    const { data: analysisRow, error: anaErr } = await supabase
      .from('swing_analysis')
      .insert({
        user_id: user.id,
        swing_video_id: videoRow.id,
        status: 'pending',
      })
      .select('id')
      .single();

    if (anaErr || !analysisRow) { setError(anaErr?.message ?? 'Failed to create analysis.'); setStage('error'); return; }

    setProgress(100);
    setStage('done');

    setTimeout(() => router.push(`/swings/${analysisRow.id}`), 600);
  }

  if (stage === 'done') {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
          <p className="text-white font-semibold">Upload complete — loading analysis…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8 sm:px-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Analyze a Swing</h1>
        <p className="text-sm text-slate-400 mt-1">Upload a video and get instant AI biomechanical coaching.</p>
      </div>

      {/* Club selector */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-2">Club used</label>
        <div className="flex flex-wrap gap-2">
          {CLUBS.map((c) => (
            <button
              key={c}
              onClick={() => setClub(c)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                club === c
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900 border border-white/10 text-slate-400 hover:text-white hover:border-white/20'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Drop zone */}
      <div
        onClick={() => fileRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 cursor-pointer transition-colors ${
          file
            ? 'border-indigo-500/50 bg-indigo-500/5'
            : 'border-white/10 bg-slate-900 hover:border-white/20 hover:bg-slate-800'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          onChange={handlePick}
          className="hidden"
        />
        {file ? (
          <>
            <CheckCircle2 className="w-8 h-8 text-indigo-400" />
            <p className="text-sm font-medium text-white text-center">{file.name}</p>
            <p className="text-xs text-slate-500">{(file.size / 1_048_576).toFixed(1)} MB · tap to change</p>
          </>
        ) : (
          <>
            <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center">
              <Video className="w-7 h-7 text-slate-500" />
            </div>
            <p className="text-sm font-medium text-slate-300">Tap to select video</p>
            <p className="text-xs text-slate-600">MP4, MOV, or WEBM · max 200 MB</p>
          </>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 px-4 py-3 bg-red-400/10 border border-red-400/20 rounded-xl text-sm text-red-400">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Progress bar */}
      {(stage === 'uploading' || stage === 'saving') && (
        <div>
          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-2 text-center">
            {stage === 'uploading' ? 'Uploading video…' : 'Saving to database…'}
          </p>
        </div>
      )}

      {/* Upload button */}
      <button
        onClick={handleUpload}
        disabled={!file || stage === 'uploading' || stage === 'saving'}
        className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors"
      >
        {(stage === 'uploading' || stage === 'saving') ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</>
        ) : (
          <><Upload className="w-4 h-4" /> Upload &amp; Analyze</>
        )}
      </button>
    </div>
  );
}
