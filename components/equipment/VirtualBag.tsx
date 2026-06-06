'use client';

/**
 * swingmaster-web/components/equipment/VirtualBag.tsx
 * Virtual Golf Bag — multi-club management dashboard.
 * Cascading Brand → Model dropdowns with Custom Club toggle.
 * Tier-gated: Par users see read-only; Birdie/Eagle can manage full bag.
 */

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Star, Settings, Lock } from 'lucide-react';
import type { SubscriptionTier } from '@/types/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const CLUB_TYPES = ['Driver', 'Wood', 'Hybrid', 'Iron', 'Wedge', 'Putter'] as const;
type ClubType = typeof CLUB_TYPES[number];

const SHAFT_FLEX_OPTIONS = ['L', 'A', 'R', 'SR', 'S', 'X'] as const;

interface ClubModel {
  model: string;
  loft_options: number[];
  shaft_flex_options: string[];
  notes: string;
}

interface CatalogData {
  brands: string[];
  models_by_brand_and_type: Record<string, Record<string, ClubModel[]>>;
}

interface Equipment {
  id: string;
  club_type: ClubType;
  brand: string | null;
  model: string | null;
  shaft_flex: string | null;
  shaft_weight: number | null;
  loft_deg: number | null;
  custom_club: boolean;
  custom_brand: string | null;
  custom_model: string | null;
  custom_notes: string | null;
  is_primary: boolean;
}

interface Props {
  tier: SubscriptionTier;
}

const PREMIUM_TIERS: SubscriptionTier[] = ['birdie', 'eagle', 'coach_starter', 'coach_pro'];

// ---------------------------------------------------------------------------
// Catalog (static import — no API call needed)
// ---------------------------------------------------------------------------

const BRANDS = [
  'TaylorMade', 'Callaway', 'Titleist', 'Ping', 'Cobra', 'Mizuno',
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VirtualBag({ tier }: Props) {
  const isLocked = !PREMIUM_TIERS.includes(tier);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [activeType, setActiveType] = useState<ClubType>('Driver');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState({
    brand: '',
    model: '',
    shaft_flex: '',
    shaft_weight: '',
    loft_deg: '',
    custom_club: false,
    custom_brand: '',
    custom_model: '',
    custom_notes: '',
    is_primary: false,
  });

  const [availableModels, setAvailableModels] = useState<ClubModel[]>([]);

  // Load equipment
  const loadEquipment = useCallback(async () => {
    try {
      const res = await fetch('/api/equipment');
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setEquipment(data.equipment ?? []);
    } catch {
      setError('Failed to load equipment.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadEquipment(); }, [loadEquipment]);

  // Load models when brand + type changes
  useEffect(() => {
    if (!form.brand || form.custom_club) {
      setAvailableModels([]);
      return;
    }
    fetch(`/api/equipment/catalog?brand=${encodeURIComponent(form.brand)}&club_type=${encodeURIComponent(activeType)}`)
      .then(r => r.json())
      .then(d => setAvailableModels(d.models ?? []))
      .catch(() => setAvailableModels([]));
  }, [form.brand, activeType, form.custom_club]);

  const resetForm = () => {
    setForm({ brand: '', model: '', shaft_flex: '', shaft_weight: '', loft_deg: '', custom_club: false, custom_brand: '', custom_model: '', custom_notes: '', is_primary: false });
    setAvailableModels([]);
    setAdding(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        club_type: activeType,
        brand: form.custom_club ? null : form.brand || null,
        model: form.custom_club ? null : form.model || null,
        shaft_flex: form.shaft_flex || null,
        shaft_weight: form.shaft_weight ? parseInt(form.shaft_weight) : null,
        loft_deg: form.loft_deg ? parseFloat(form.loft_deg) : null,
        custom_club: form.custom_club,
        custom_brand: form.custom_club ? form.custom_brand || null : null,
        custom_model: form.custom_club ? form.custom_model || null : null,
        custom_notes: form.custom_club ? form.custom_notes || null : null,
        is_primary: form.is_primary,
      };
      const res = await fetch('/api/equipment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      await loadEquipment();
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/equipment/${id}`, { method: 'DELETE' });
      setEquipment(prev => prev.filter(e => e.id !== id));
    } catch {
      setError('Delete failed.');
    }
  };

  const clubsOfType = equipment.filter(e => e.club_type === activeType);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-golf-green/15 text-golf-green">
          <Settings size={18} />
        </div>
        <div>
          <h1 className="font-black text-xl italic tracking-tighter text-white uppercase">Virtual Bag</h1>
          <p className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Manage your equipment</p>
        </div>
        {isLocked && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-amber-500/10 px-3 py-1 text-[9px] font-black uppercase tracking-widest text-amber-400">
            <Lock size={10} /> Birdie+
          </span>
        )}
      </div>

      {/* Club type tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {CLUB_TYPES.map(type => (
          <button
            key={type}
            onClick={() => { setActiveType(type); setAdding(false); }}
            className={`flex-shrink-0 rounded-full px-3 py-1.5 text-[9px] font-black uppercase tracking-widest transition-colors ${
              activeType === type
                ? 'bg-golf-green text-black'
                : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Club list for active type */}
      {loading ? (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-golf-green border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-3">
          {clubsOfType.length === 0 && !adding && (
            <div className="rounded-4xl border border-white/5 bg-golf-surface p-6 text-center">
              <p className="text-xs text-gray-600 uppercase tracking-widest">No {activeType} in bag</p>
            </div>
          )}

          {clubsOfType.map(club => (
            <ClubCard key={club.id} club={club} onDelete={handleDelete} isLocked={isLocked} />
          ))}

          {/* Add form */}
          {adding && !isLocked && (
            <div className="rounded-4xl border border-golf-green/20 bg-golf-surface p-5 space-y-4">
              <p className="text-[9px] font-black uppercase tracking-widest text-golf-green">Add {activeType}</p>

              {/* Custom club toggle */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, custom_club: !f.custom_club }))}
                  className={`relative h-5 w-9 rounded-full transition-colors ${form.custom_club ? 'bg-golf-green' : 'bg-white/10'}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${form.custom_club ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
                <span className="text-xs text-gray-400">Custom club</span>
              </div>

              {form.custom_club ? (
                /* Custom club fields */
                <div className="grid grid-cols-2 gap-3">
                  <BagInput label="Brand" value={form.custom_brand} onChange={v => setForm(f => ({ ...f, custom_brand: v }))} placeholder="e.g. Custom Forge" />
                  <BagInput label="Model" value={form.custom_model} onChange={v => setForm(f => ({ ...f, custom_model: v }))} placeholder="e.g. Proto #3" />
                  <BagInput label="Notes" value={form.custom_notes} onChange={v => setForm(f => ({ ...f, custom_notes: v }))} placeholder="Any details" className="col-span-2" />
                </div>
              ) : (
                /* Cascading dropdowns */
                <div className="grid grid-cols-2 gap-3">
                  <BagSelect
                    label="Brand"
                    value={form.brand}
                    onChange={v => setForm(f => ({ ...f, brand: v, model: '' }))}
                    options={BRANDS.map(b => ({ value: b, label: b }))}
                    placeholder="Select brand"
                  />
                  <BagSelect
                    label="Model"
                    value={form.model}
                    onChange={v => setForm(f => ({ ...f, model: v }))}
                    options={availableModels.map(m => ({ value: m.model, label: m.model }))}
                    placeholder={form.brand ? 'Select model' : 'Select brand first'}
                    disabled={!form.brand}
                  />
                </div>
              )}

              {/* Shaft + loft */}
              <div className="grid grid-cols-3 gap-3">
                <BagSelect
                  label="Shaft Flex"
                  value={form.shaft_flex}
                  onChange={v => setForm(f => ({ ...f, shaft_flex: v }))}
                  options={SHAFT_FLEX_OPTIONS.map(f => ({ value: f, label: f }))}
                  placeholder="Flex"
                />
                <BagInput label="Shaft Weight (g)" value={form.shaft_weight} onChange={v => setForm(f => ({ ...f, shaft_weight: v }))} placeholder="65" type="number" />
                <BagInput label="Loft (°)" value={form.loft_deg} onChange={v => setForm(f => ({ ...f, loft_deg: v }))} placeholder="10.5" type="number" />
              </div>

              {/* Primary toggle */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, is_primary: !f.is_primary }))}
                  className={`relative h-5 w-9 rounded-full transition-colors ${form.is_primary ? 'bg-amber-400' : 'bg-white/10'}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${form.is_primary ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
                <span className="text-xs text-gray-400">Set as primary {activeType}</span>
              </div>

              {error && <p className="text-xs text-red-400">{error}</p>}

              <div className="flex gap-2">
                <button onClick={handleSave} disabled={saving} className="flex-1 rounded-full bg-golf-green py-2 text-[9px] font-black uppercase tracking-widest text-black disabled:opacity-50">
                  {saving ? 'Saving…' : 'Save Club'}
                </button>
                <button onClick={resetForm} className="rounded-full bg-white/5 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-gray-400">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Add button */}
          {!adding && !isLocked && (
            <button
              onClick={() => setAdding(true)}
              className="flex w-full items-center justify-center gap-2 rounded-4xl border border-dashed border-white/10 py-3 text-[9px] font-black uppercase tracking-widest text-gray-500 transition-colors hover:border-golf-green/30 hover:text-golf-green"
            >
              <Plus size={12} /> Add {activeType}
            </button>
          )}

          {isLocked && (
            <div className="flex items-center justify-center gap-2 rounded-4xl border border-amber-500/20 bg-amber-500/5 py-4">
              <Lock size={12} className="text-amber-400" />
              <p className="text-[9px] font-black uppercase tracking-widest text-amber-400">
                Upgrade to Birdie to manage your bag
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ClubCard({ club, onDelete, isLocked }: { club: Equipment; onDelete: (id: string) => void; isLocked: boolean }) {
  const displayName = club.custom_club
    ? `${club.custom_brand || club.brand || 'Custom'} ${club.custom_model || club.model || ''}`
    : `${club.brand || ''} ${club.model || ''}`.trim();

  return (
    <div className="flex items-center gap-3 rounded-4xl border border-white/5 bg-golf-surface px-4 py-3">
      {club.is_primary && <Star size={12} className="flex-shrink-0 text-amber-400" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-white">{displayName || 'Unnamed club'}</p>
        <div className="flex gap-2 mt-0.5">
          {club.shaft_flex && <span className="text-[9px] text-gray-500 uppercase">{club.shaft_flex} flex</span>}
          {club.loft_deg && <span className="text-[9px] text-gray-500">{club.loft_deg}°</span>}
          {club.custom_club && <span className="text-[9px] text-golf-green uppercase">Custom</span>}
        </div>
      </div>
      {!isLocked && (
        <button onClick={() => onDelete(club.id)} className="flex-shrink-0 text-gray-600 transition-colors hover:text-red-400">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function BagInput({ label, value, onChange, placeholder, type = 'text', className = '' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[9px] font-black uppercase tracking-widest text-gray-500">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-golf-green/50 focus:outline-none"
      />
    </div>
  );
}

function BagSelect({ label, value, onChange, options, placeholder, disabled = false }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; placeholder?: string; disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-[9px] font-black uppercase tracking-widest text-gray-500">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-2xl border border-white/10 bg-black px-3 py-2 text-sm text-white focus:border-golf-green/50 focus:outline-none disabled:opacity-40"
      >
        <option value="">{placeholder || 'Select…'}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
