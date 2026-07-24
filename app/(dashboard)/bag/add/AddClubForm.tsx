"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import type { ClubType } from "@/components/swing/VirtualBag";

const CLUB_TYPES: ClubType[] = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"];
const SHAFT_FLEX_OPTIONS = ["Ladies", "Senior", "Regular", "Stiff", "X-Stiff"];

export default function AddClubForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    club_type: "Driver" as ClubType,
    brand: "",
    model: "",
    shaft_flex: "",
    shaft_weight: "",
    loft_deg: "",
    is_primary: false,
    custom_club: false,
    custom_brand: "",
    custom_model: "",
  });

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: err } = await supabase.from("user_equipment").insert({
      user_id: userId,
      club_type: form.club_type,
      brand: form.brand || null,
      model: form.model || null,
      shaft_flex: form.shaft_flex || null,
      shaft_weight: form.shaft_weight ? parseFloat(form.shaft_weight) : null,
      loft_deg: form.loft_deg ? parseFloat(form.loft_deg) : null,
      is_primary: form.is_primary,
      custom_club: form.custom_club,
      custom_brand: form.custom_club ? form.custom_brand || null : null,
      custom_model: form.custom_club ? form.custom_model || null : null,
    });

    if (err) {
      setError(err.message);
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
      {/* Club type */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">Club Type *</label>
        <select
          value={form.club_type}
          onChange={(e) => set({ club_type: e.target.value as ClubType })}
          className={inputCls}
        >
          {CLUB_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Custom club toggle */}
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="custom_club"
          checked={form.custom_club}
          onChange={(e) => set({ custom_club: e.target.checked })}
          className="w-4 h-4 rounded border-white/20 bg-slate-800 accent-indigo-500"
        />
        <label htmlFor="custom_club" className="text-sm text-gray-300">
          Custom / aftermarket club
        </label>
      </div>

      {/* Brand + Model */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            {form.custom_club ? "Custom Brand" : "Brand"}
          </label>
          <input
            type="text"
            placeholder={form.custom_club ? "e.g. KBS" : "e.g. TaylorMade"}
            value={form.custom_club ? form.custom_brand : form.brand}
            onChange={(e) =>
              form.custom_club
                ? set({ custom_brand: e.target.value })
                : set({ brand: e.target.value })
            }
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            {form.custom_club ? "Custom Model" : "Model"}
          </label>
          <input
            type="text"
            placeholder={form.custom_club ? "e.g. Tour 90" : "e.g. Stealth 2"}
            value={form.custom_club ? form.custom_model : form.model}
            onChange={(e) =>
              form.custom_club
                ? set({ custom_model: e.target.value })
                : set({ model: e.target.value })
            }
            className={inputCls}
          />
        </div>
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
          onClick={() => router.back()}
          className="flex-1 px-4 py-2.5 rounded-xl border border-white/10 text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex-1 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-semibold text-white transition-colors"
        >
          {loading ? "Adding…" : "Add to Bag"}
        </button>
      </div>
    </form>
  );
}
