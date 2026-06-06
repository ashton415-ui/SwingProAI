import { redirect } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import BagPageClient from './BagPageClient';
import type { ClubRecord, TelemetryStat } from '@/components/swing/VirtualBag';

function computeRatings(row: Record<string, unknown>): TelemetryStat {
  const swingSpeed = row.swing_speed_mph as number | null;
  const smash = row.smash_factor as number | null;

  let smashRating: TelemetryStat['smash_factor_rating'] =
    (row.smash_factor_rating as TelemetryStat['smash_factor_rating']) || '';
  let speedCategory: TelemetryStat['swing_speed_category'] =
    (row.swing_speed_category as TelemetryStat['swing_speed_category']) || '';

  if (!smashRating && smash != null) {
    if (smash >= 1.48) smashRating = 'excellent';
    else if (smash >= 1.44) smashRating = 'good';
    else if (smash >= 1.38) smashRating = 'average';
    else smashRating = 'poor';
  }

  if (!speedCategory && swingSpeed != null) {
    if (swingSpeed >= 110) speedCategory = 'tour';
    else if (swingSpeed >= 95) speedCategory = 'advanced';
    else if (swingSpeed >= 80) speedCategory = 'average';
    else speedCategory = 'beginner';
  }

  return {
    swing_speed_mph: swingSpeed,
    ball_speed_mph: row.ball_speed_mph as number | null,
    smash_factor: smash,
    launch_angle_deg: row.launch_angle_deg as number | null,
    carry_yards: row.carry_yards as number | null,
    smash_factor_rating: smashRating,
    swing_speed_category: speedCategory,
  };
}

export const metadata = { title: 'My Bag — SwingProAI' };

export default async function BagPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const [{ data: equipmentRows }, { data: telemetryRows }] = await Promise.all([
    supabase
      .from('user_equipment')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true }),
    supabase
      .from('swing_telemetry')
      .select('*')
      .eq('user_id', user.id)
      .not('club_id', 'is', null)
      .order('created_at', { ascending: false }),
  ]);

  const clubs: ClubRecord[] = (equipmentRows ?? []) as ClubRecord[];

  // Latest telemetry row per club (rows are newest-first)
  const telemetry: Record<string, TelemetryStat> = {};
  for (const row of telemetryRows ?? []) {
    const id = row.club_id as string;
    if (id && !telemetry[id]) {
      telemetry[id] = computeRatings(row as Record<string, unknown>);
    }
  }

  return <BagPageClient initialClubs={clubs} initialTelemetry={telemetry} />;
}
