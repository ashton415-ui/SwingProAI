import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/server';
import {
  ChevronLeft, CheckCircle2, AlertTriangle, Target, Lightbulb, Zap, TrendingUp,
} from 'lucide-react';
import SwingDetailClient from './SwingDetailClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { id: string } }) {
  return { title: `Swing Analysis — SwingMaster` };
}

export default async function SwingDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: row, error } = await supabase
    .from('swing_analysis')
    .select(`
      id, status, score, feedback, metrics,
      swing_highlights, mechanical_deficiencies,
      swing_video:swing_videos(id, video_url, storage_path, club, original_filename, created_at)
    `)
    .eq('id', params.id)
    .eq('user_id', user.id)
    .single();

  if (error || !row) notFound();

  const videoRow = Array.isArray(row.swing_video) ? row.swing_video[0] : row.swing_video;

  let videoSignedUrl: string | null = null;
  if (videoRow?.storage_path) {
    const { data: signed } = await supabase.storage
      .from('swing-videos')
      .createSignedUrl(videoRow.storage_path, 3600);
    videoSignedUrl = signed?.signedUrl ?? videoRow?.video_url ?? null;
  } else {
    videoSignedUrl = videoRow?.video_url ?? null;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <Link
          href="/swings"
          className="p-1.5 rounded-lg text-slate-600 hover:text-white hover:bg-white/5 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">
            {videoRow?.club ?? 'Swing'} Analysis
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {videoRow?.created_at
              ? new Date(videoRow.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
              : ''}
          </p>
        </div>
      </div>

      <SwingDetailClient
        analysis={row as Parameters<typeof SwingDetailClient>[0]['analysis']}
        videoSignedUrl={videoSignedUrl}
        analysisId={params.id}
      />
    </div>
  );
}
