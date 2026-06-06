'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import VirtualBag, { type ClubRecord, type TelemetryStat } from '@/components/swing/VirtualBag';
import { createClient } from '@/utils/supabase/client';

interface BagPageClientProps {
  initialClubs: ClubRecord[];
  initialTelemetry: Record<string, TelemetryStat>;
}

export default function BagPageClient({ initialClubs, initialTelemetry }: BagPageClientProps) {
  const router = useRouter();
  const [clubs, setClubs] = useState<ClubRecord[]>(initialClubs);
  const [removing, setRemoving] = useState<string | null>(null);
  const supabase = createClient();

  async function handleRemoveClub(clubId: string) {
    setRemoving(clubId);
    const { error } = await supabase
      .from('user_equipment')
      .delete()
      .eq('id', clubId);

    if (error) {
      console.error('Failed to remove club:', error.message);
    } else {
      setClubs((prev) => prev.filter((c) => c.id !== clubId));
    }
    setRemoving(null);
  }

  function handleAddClub() {
    router.push('/bag/add');
  }

  function handleGetFitting(clubId: string) {
    router.push(`/analyze?club_id=${clubId}`);
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">My Bag</h1>
          <p className="text-sm text-slate-400 mt-1">
            Track per-club telemetry and get AI shaft fitting recommendations.
          </p>
        </div>

        {/* VirtualBag */}
        <div className={removing ? 'opacity-75 pointer-events-none transition-opacity' : ''}>
          <VirtualBag
            clubs={clubs}
            telemetry={initialTelemetry}
            onAddClub={handleAddClub}
            onRemoveClub={handleRemoveClub}
            onGetFitting={handleGetFitting}
          />
        </div>
      </div>
    </div>
  );
}
