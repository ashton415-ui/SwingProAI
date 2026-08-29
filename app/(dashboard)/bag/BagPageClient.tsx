"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import VirtualBag, { type ClubRecord, type TelemetryStat } from "@/components/swing/VirtualBag";
import { createClient } from "@/utils/supabase/client";

interface BagPageClientProps {
  initialClubs: ClubRecord[];
  initialTelemetry: Record<string, TelemetryStat>;
  /**
   * The authenticated golfer, supplied by the server page. Used only as an extra
   * archive filter beside RLS — this component establishes no second session
   * authority of its own, and never writes the value into a payload.
   */
  userId: string;
}

export default function BagPageClient({
  initialClubs,
  initialTelemetry,
  userId,
}: BagPageClientProps) {
  const router = useRouter();
  const [clubs, setClubs] = useState<ClubRecord[]>(initialClubs);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const supabase = createClient();

  /**
   * Removing a club from the bag archives it; it is not deleted.
   *
   * public.swing_analysis.club_id references this row with ON DELETE SET NULL
   * behind a trigger that rejects any post-insert change to club_id, and
   * public.swing_telemetry.club_id carries the same referential action with no
   * such guard. A hard delete would therefore either fail outright or silently
   * discard historical per-club attribution. Flipping is_archived preserves the
   * row, its identity columns, its fitting values, its is_primary flag and every
   * historical relationship, while taking it out of the active bag.
   */
  async function handleRemoveClub(clubId: string) {
    // A fresh attempt must not inherit the previous attempt's failure.
    setRemoveError(null);
    setRemoving(clubId);

    try {
      // The owner predicate is defence in depth beside the owner RLS policy, and
      // is_archived=false makes a second concurrent removal a no-op rather than
      // a silent success. Selecting the id back means a zero-row update cannot
      // be read as a completed removal.
      const { data, error } = await supabase
        .from("user_equipment")
        .update({ is_archived: true })
        .eq("id", clubId)
        .eq("user_id", userId)
        .eq("is_archived", false)
        .select("id")
        .maybeSingle();

      if (error || !data) {
        // Raw PostgREST/Postgres text — policy detail, constraint names — must
        // never reach the page. The console keeps it available for diagnosis.
        console.error("Failed to remove club:", error?.message ?? "no row was archived");
        setRemoveError("Could not remove this club from your bag. Please try again.");
        return;
      }

      // Only a positively confirmed archived row leaves the visible bag.
      setClubs((prev) => prev.filter((c) => c.id !== clubId));
    } catch (thrown) {
      // A transport-level throw is still a failed removal, never a success.
      console.error("Failed to remove club:", thrown);
      setRemoveError("Could not remove this club from your bag. Please try again.");
    } finally {
      // Released on every path, so a failure can never leave the bag inert.
      setRemoving(null);
    }
  }

  function handleAddClub() {
    router.push("/bag/add");
  }

  function handleEditClub(clubId: string) {
    router.push(`/bag/${clubId}/edit`);
  }

  function handleGetFitting(clubId: string) {
    router.push(`/analyze?club_id=${clubId}`);
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white tracking-tight">My Bag</h1>
          <p className="text-sm text-gray-400 mt-1">
            Track per-club telemetry and get AI shaft fitting recommendations.
          </p>
        </div>

        {removeError && (
          <p
            role="alert"
            className="mb-4 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3"
          >
            {removeError}
          </p>
        )}

        <div className={removing ? "opacity-75 pointer-events-none transition-opacity" : ""}>
          <VirtualBag
            clubs={clubs}
            telemetry={initialTelemetry}
            onAddClub={handleAddClub}
            onEditClub={handleEditClub}
            onRemoveClub={handleRemoveClub}
            onGetFitting={handleGetFitting}
          />
        </div>
      </div>
    </div>
  );
}
