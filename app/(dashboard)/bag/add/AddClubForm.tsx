"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import type { ClubType } from "@/components/swing/VirtualBag";
import type { ClubDesignation } from "@/types/database";
import {
  getClubDesignationOptions,
  isClubDesignationValidFor,
} from "@/lib/equipment/club-designation-options";

const CLUB_TYPES: ClubType[] = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"];
const SHAFT_FLEX_OPTIONS = ["Ladies", "Senior", "Regular", "Stiff", "X-Stiff"];

/**
 * The minimum canonical identity the selector needs, mapped server-side from
 * public.equipment_models + public.equipment_manufacturers. Nothing else about
 * a catalog row reaches the browser.
 */
export type CatalogOption = {
  clubType: ClubType;
  manufacturerId: string;
  manufacturerName: string;
  modelId: string;
  modelName: string;
};

/**
 * `unavailable` deliberately carries no message or code. A catalog query
 * failure must never be rendered as raw database text, and must never be
 * disguised as an empty catalog — those are different facts with different
 * user-facing copy.
 */
export type CatalogState =
  | { status: "ready"; options: CatalogOption[] }
  | { status: "empty" }
  | { status: "unavailable" };

interface AddClubFormProps {
  userId: string;
  catalog: CatalogState;
}

/**
 * Exactly the columns this form writes. Declaring it forces both payload
 * branches below to name every identity-bearing column, which is what makes
 * cross-mode leakage a compile error rather than a code-review question.
 */
type UserEquipmentInsert = {
  user_id: string;
  club_type: ClubType;
  /** The golfer's own club number. Never inferred — see the designation select below. */
  club_designation: ClubDesignation | null;
  equipment_model_id: string | null;
  manufacturer_id: string | null;
  brand: string | null;
  model: string | null;
  custom_club: boolean;
  custom_brand: string | null;
  custom_model: string | null;
  shaft_flex: string | null;
  shaft_weight: number | null;
  loft_deg: number | null;
  is_primary: boolean;
};

/** Byte comparison, so ordering never varies with the browser's ICU data. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export default function AddClubForm({ userId, catalog }: AddClubFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = catalog.status === "ready" ? catalog.options : [];

  const [form, setForm] = useState({
    club_type: "Driver" as ClubType,
    // "" is the absence of a stated designation, never a sentinel token. It is
    // resolved to database NULL at submit time.
    club_designation: "" as ClubDesignation | "",
    // Canonical selection starts empty in both dimensions. Nothing is ever
    // auto-selected — a golfer's equipment identity must be chosen, not guessed.
    selectedManufacturerId: "",
    selectedModelId: "",
    shaft_flex: "",
    shaft_weight: "",
    loft_deg: "",
    is_primary: false,
    // `custom_club` doubles as the mode: false = canonical catalog selection.
    // It defaults on only when there is no canonical catalog to select from.
    custom_club: options.length === 0,
    custom_brand: "",
    custom_model: "",
  });

  const set = (patch: Partial<typeof form>) => setForm((prev) => ({ ...prev, ...patch }));

  // ── Derived catalog choices ─────────────────────────────────────────────────

  const manufacturers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const option of options) {
      if (option.clubType !== form.club_type) continue;
      if (!byId.has(option.manufacturerId)) byId.set(option.manufacturerId, option.manufacturerName);
    }
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) =>
      compareStrings(a.name, b.name)
    );
  }, [options, form.club_type]);

  const models = useMemo(() => {
    if (form.selectedManufacturerId === "") return [];
    return options
      .filter(
        (option) =>
          option.clubType === form.club_type &&
          option.manufacturerId === form.selectedManufacturerId
      )
      .sort((a, b) => compareStrings(a.modelName, b.modelName));
  }, [options, form.club_type, form.selectedManufacturerId]);

  /**
   * Every identity dimension must agree. A model id left over from a previous
   * club type or manufacturer resolves to null here rather than being accepted,
   * so a stale selection can never reach the payload.
   */
  const selectedEntry = useMemo(
    () =>
      options.find(
        (option) =>
          option.modelId === form.selectedModelId &&
          option.clubType === form.club_type &&
          option.manufacturerId === form.selectedManufacturerId
      ) ?? null,
    [options, form.selectedModelId, form.club_type, form.selectedManufacturerId]
  );

  /**
   * The designations the database will accept for the currently selected club
   * type. Driver and Putter yield none, so the control is replaced by a note
   * rather than an empty list.
   */
  const designationOptions = useMemo(
    () => getClubDesignationOptions(form.club_type),
    [form.club_type]
  );

  /** Why canonical selection cannot be offered right now, if it cannot. */
  const catalogNotice =
    catalog.status === "unavailable"
      ? "Canonical equipment selection is temporarily unavailable. You can still add this club using Custom / Other."
      : catalog.status === "empty"
        ? "The canonical equipment catalog is empty. You can still add this club using Custom / Other."
        : manufacturers.length === 0
          ? `No canonical ${form.club_type} models are available yet. Use Custom / Other to add this club.`
          : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Two disjoint literals. Neither spreads `form`, and each names every
    // identity-bearing column, so a value belonging to the other mode cannot
    // survive a mode switch no matter what the UI state still holds.
    let payload: UserEquipmentInsert;

    // Resolved against the CURRENT club type, so a designation left over from a
    // previous type (Iron 7I, then switched to Wood) cannot reach the database,
    // and Driver/Putter always resolve to null. Blank is null, never "".
    const clubDesignation: ClubDesignation | null = isClubDesignationValidFor(
      form.club_type,
      form.club_designation
    )
      ? form.club_designation
      : null;

    if (form.custom_club) {
      payload = {
        user_id: userId,
        club_type: form.club_type,
        club_designation: clubDesignation,
        equipment_model_id: null,
        manufacturer_id: null,
        brand: null,
        model: null,
        custom_club: true,
        custom_brand: form.custom_brand || null,
        custom_model: form.custom_model || null,
        shaft_flex: form.shaft_flex || null,
        shaft_weight: form.shaft_weight ? parseFloat(form.shaft_weight) : null,
        loft_deg: form.loft_deg ? parseFloat(form.loft_deg) : null,
        is_primary: form.is_primary,
      };
    } else {
      if (!selectedEntry) {
        setError("Choose a manufacturer and model, or switch to Custom / Other.");
        return;
      }
      payload = {
        user_id: userId,
        club_type: form.club_type,
        club_designation: clubDesignation,
        equipment_model_id: selectedEntry.modelId,
        // Left null on purpose. The database trigger derives manufacturer_id
        // from equipment_model_id and rejects a conflicting pair, so client
        // state is never trusted to author the manufacturer relationship.
        manufacturer_id: null,
        // Readable snapshot, taken from the selected catalog entry only — never
        // from free text. It coexists with the canonical id and is what keeps a
        // row legible if the model is ever deactivated.
        brand: selectedEntry.manufacturerName,
        model: selectedEntry.modelName,
        custom_club: false,
        custom_brand: null,
        custom_model: null,
        shaft_flex: form.shaft_flex || null,
        shaft_weight: form.shaft_weight ? parseFloat(form.shaft_weight) : null,
        loft_deg: form.loft_deg ? parseFloat(form.loft_deg) : null,
        is_primary: form.is_primary,
      };
    }

    setLoading(true);

    const supabase = createClient();
    const { error: err } = await supabase.from("user_equipment").insert(payload);

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

  const noticeCls =
    "text-sm text-amber-200/90 bg-amber-400/10 border border-amber-400/20 rounded-xl px-4 py-3";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Club type — changing it invalidates any canonical selection below. */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">Club Type *</label>
        <select
          value={form.club_type}
          onChange={(e) =>
            set({
              club_type: e.target.value as ClubType,
              club_designation: "",
              selectedManufacturerId: "",
              selectedModelId: "",
            })
          }
          className={inputCls}
        >
          {CLUB_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Club Number / Designation — the golfer's own club number, never
          derived from the model, loft or catalog. Options come only from the
          helper, which mirrors the D1 club-type compatibility constraint. */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Club Number / Designation
        </label>
        {designationOptions.length === 0 ? (
          // Neutral copy, not noticeCls: for a driver or putter this is the
          // ordinary, correct state — nothing is unavailable and nothing is
          // wrong — so it must not borrow the amber treatment the genuine
          // catalog warnings use.
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

      {/* Custom club toggle */}
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="custom_club"
          checked={form.custom_club}
          onChange={(e) =>
            set({
              custom_club: e.target.checked,
              selectedManufacturerId: "",
              selectedModelId: "",
              custom_brand: "",
              custom_model: "",
            })
          }
          className="w-4 h-4 rounded border-white/20 bg-slate-800 accent-indigo-500"
        />
        <label htmlFor="custom_club" className="text-sm text-gray-300">
          Custom / aftermarket club
        </label>
      </div>

      {/* Equipment identity — canonical catalog selection, or the Custom escape. */}
      {form.custom_club ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-300 mb-2">Custom Brand</label>
            <input
              type="text"
              placeholder="e.g. KBS"
              value={form.custom_brand}
              onChange={(e) => set({ custom_brand: e.target.value })}
              className={inputCls}
            />
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-300 mb-2">Custom Model</label>
            <input
              type="text"
              placeholder="e.g. Tour 90"
              value={form.custom_model}
              onChange={(e) => set({ custom_model: e.target.value })}
              className={inputCls}
            />
          </div>
        </div>
      ) : catalogNotice !== null ? (
        <p className={noticeCls}>{catalogNotice}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-300 mb-2">Manufacturer</label>
            <select
              value={form.selectedManufacturerId}
              onChange={(e) =>
                set({ selectedManufacturerId: e.target.value, selectedModelId: "" })
              }
              className={inputCls}
            >
              <option value="">— Select Manufacturer —</option>
              {manufacturers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label className="block text-sm font-medium text-gray-300 mb-2">Model</label>
            <select
              value={form.selectedModelId}
              onChange={(e) => set({ selectedModelId: e.target.value })}
              disabled={form.selectedManufacturerId === ""}
              className={inputCls}
            >
              <option value="">— Select Model —</option>
              {models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.modelName}
                </option>
              ))}
            </select>
            {form.selectedManufacturerId !== "" && models.length === 0 && (
              <p className={`${noticeCls} mt-2`}>
                No canonical models for this manufacturer and club type. Use Custom / Other.
              </p>
            )}
          </div>
        </div>
      )}

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
