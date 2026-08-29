"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import type { ClubDesignation, UserEquipment } from "@/types/database";
import {
  getClubDesignationOptions,
  isClubDesignationValidFor,
} from "@/lib/equipment/club-designation-options";

/**
 * Exactly the saved-club fields this route reads. Deriving it from the
 * authoritative UserEquipment type keeps the shape honest without declaring a
 * second, broader writable row type: club_type is present because it decides
 * which designations are legal, not because it can be changed.
 */
export type EditableClub = Pick<
  UserEquipment,
  "id" | "club_type" | "club_designation" | "loft_deg" | "shaft_flex" | "shaft_weight" | "is_primary"
>;

/**
 * Exactly the columns this form writes. Naming them in a declared type is what
 * makes an accidental identity write a compile error rather than a code-review
 * question — the same discipline the Add Club insert uses.
 */
type UserEquipmentUpdate = {
  club_designation: ClubDesignation | null;
  loft_deg: number | null;
  shaft_flex: string | null;
  shaft_weight: number | null;
  is_primary: boolean;
};

/**
 * The Add Club flex vocabulary, repeated here deliberately rather than shared.
 * Exporting it from AddClubForm would put a seventh file in this slice, so the
 * D3-S2 test pins these two lists against each other instead: the duplication
 * is contained and guarded, not licence for a second taxonomy.
 */
const SHAFT_FLEX_OPTIONS = ["Ladies", "Senior", "Regular", "Stiff", "X-Stiff"] as const;

type ShaftFlex = (typeof SHAFT_FLEX_OPTIONS)[number];

/**
 * Membership is derived from the option list itself, so there is exactly one
 * local source of the five values and a second validation list cannot drift
 * from the one the select renders.
 */
function isShaftFlex(value: string): value is ShaftFlex {
  return SHAFT_FLEX_OPTIONS.some((option) => option === value);
}

interface EditClubFormProps {
  club: EditableClub;
  /** Used only as an extra update filter beside RLS. Never written into the payload. */
  userId: string;
}

export default function EditClubForm({ club, userId }: EditClubFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * A stored designation is only shown when it is still legal for this row's
   * immutable club type. Anything else starts blank, so unexpected legacy data
   * is never silently re-persisted and never quietly "corrected" to a guess.
   */
  const [form, setForm] = useState({
    club_designation: (isClubDesignationValidFor(club.club_type, club.club_designation ?? "")
      ? club.club_designation
      : "") as ClubDesignation | "",
    loft_deg: club.loft_deg == null ? "" : String(club.loft_deg),
    // Same fail-closed rule as the designation: a stored value outside the
    // five supported flexes starts blank rather than being carried forward,
    // so this form can never write back a value it does not support.
    shaft_flex: isShaftFlex(club.shaft_flex ?? "") ? (club.shaft_flex as ShaftFlex) : "",
    shaft_weight: club.shaft_weight == null ? "" : String(club.shaft_weight),
    is_primary: club.is_primary,
  });

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  const designationOptions = useMemo(
    () => getClubDesignationOptions(club.club_type),
    [club.club_type]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Blank means "not stated" and becomes NULL. A value that is not legal for
    // this club type also becomes NULL rather than being sent and rejected.
    const clubDesignation: ClubDesignation | null = isClubDesignationValidFor(
      club.club_type,
      form.club_designation
    )
      ? form.club_designation
      : null;

    let loftDeg: number | null = null;
    if (form.loft_deg !== "") {
      const parsed = Number(form.loft_deg);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Enter a loft of 0 or more, or leave it blank.");
        return;
      }
      loftDeg = parsed;
    }

    // Grams, and an integer column — so a fractional entry is rejected here
    // rather than being silently truncated by the database.
    let shaftWeight: number | null = null;
    if (form.shaft_weight !== "") {
      const parsed = Number(form.shaft_weight);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError("Enter a whole shaft weight in grams of 0 or more, or leave it blank.");
        return;
      }
      shaftWeight = parsed;
    }

    // A second fail-closed guard: even if form state were somehow set to an
    // unsupported flex, only one of the five approved values reaches the row.
    const shaftFlex: ShaftFlex | null = isShaftFlex(form.shaft_flex) ? form.shaft_flex : null;

    // Exactly the five writable columns. No spread of the fetched row, and no
    // identity column carried along "unchanged" — a column absent from this
    // literal cannot be rewritten by this route at all.
    const payload: UserEquipmentUpdate = {
      club_designation: clubDesignation,
      loft_deg: loftDeg,
      shaft_flex: shaftFlex,
      shaft_weight: shaftWeight,
      is_primary: form.is_primary,
    };

    setLoading(true);

    const supabase = createClient();
    // The user_id predicate is defence in depth beside the owner RLS policy, and
    // selecting the id back means a zero-row update cannot be read as success.
    //
    // is_archived=false closes the race where this form was opened on an active
    // club that was then removed from the bag elsewhere: the stale Save affects
    // zero rows and takes the existing generic failure path rather than writing
    // fitting values back onto an archived row.
    const { data, error: err } = await supabase
      .from("user_equipment")
      .update(payload)
      .eq("id", club.id)
      .eq("user_id", userId)
      .eq("is_archived", false)
      .select("id")
      .maybeSingle();

    if (err || !data) {
      // Raw PostgREST/Postgres text — constraint names, policy detail — must
      // never reach the page. The console keeps it available for diagnosis.
      console.error("Failed to update club:", err?.message ?? "no row was updated");
      setError("Could not update this club. Please try again.");
      setLoading(false);
      return;
    }

    router.push("/bag");
    router.refresh();
  }

  const inputCls =
    "w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-2.5 text-white text-base lg:text-sm placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Club Number / Designation — chosen by the golfer, never inferred. The
          options come only from the shared helper, narrowed by the immutable
          club type. */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Club Number / Designation
        </label>
        {designationOptions.length === 0 ? (
          // Neutral copy: for a driver or putter this is the ordinary, correct
          // state, so it must not be dressed as a warning.
          <p className="text-sm text-gray-400">
            No separate club designation is recorded for this club type.
          </p>
        ) : (
          <select
            value={form.club_designation}
            onChange={(e) =>
              set({ club_designation: e.target.value as ClubDesignation | "" })
            }
            className={inputCls}
          >
            <option value="">— None —</option>
            {designationOptions.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Shaft flex + weight */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Shaft Flex</label>
          <select
            value={form.shaft_flex}
            onChange={(e) => set({ shaft_flex: e.target.value })}
            className={inputCls}
          >
            <option value="">— Select —</option>
            {SHAFT_FLEX_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Shaft Weight (g)
          </label>
          <input
            type="number"
            min="0"
            step="1"
            placeholder="e.g. 60"
            value={form.shaft_weight}
            onChange={(e) => set({ shaft_weight: e.target.value })}
            className={inputCls}
          />
        </div>
      </div>

      {/* Loft + primary */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">Loft (°)</label>
          <input
            type="number"
            step="0.5"
            min="0"
            placeholder="e.g. 10.5"
            value={form.loft_deg}
            onChange={(e) => set({ loft_deg: e.target.value })}
            className={inputCls}
          />
        </div>
        <div className="flex items-end pb-3">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="is_primary"
              checked={form.is_primary}
              onChange={(e) => set({ is_primary: e.target.checked })}
              className="w-4 h-4 rounded border-white/20 bg-slate-800 accent-indigo-500"
            />
            <label htmlFor="is_primary" className="text-sm text-gray-300">
              Primary club
            </label>
          </div>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
          {error}
        </p>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.push("/bag")}
          className="flex-1 px-4 py-2.5 rounded-xl border border-white/10 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex-1 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-semibold text-white transition-colors"
        >
          {loading ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </form>
  );
}
