'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import { ChevronLeft, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

const CLUB_TYPES = [
  'Driver',
  'Fairway Wood',
  'Hybrid',
  'Iron',
  'Wedge',
  'Putter',
];

const CLUB_NUMBERS: Record<string, string[]> = {
  'Fairway Wood': ['3-Wood', '5-Wood', '7-Wood'],
  Hybrid:  ['2-Hybrid', '3-Hybrid', '4-Hybrid', '5-Hybrid'],
  Iron:    ['2-Iron', '3-Iron', '4-Iron', '5-Iron', '6-Iron', '7-Iron', '8-Iron', '9-Iron'],
  Wedge:   ['PW', 'GW', 'SW', 'LW', '46°', '48°', '50°', '52°', '54°', '56°', '58°', '60°', '64°'],
};

const SHAFT_FLEXES = ['Extra Stiff', 'Stiff', 'Regular', 'Senior', 'Ladies'];

export default function AddClubPage() {
  const router = useRouter();
  const supabase = createClient();

  const [clubType, setClubType] = useState('Driver');
  const [clubNumber, setClubNumber] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [shaftFlex, setShaftFlex] = useState('Regular');
  const [loft, setLoft] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const numbers = CLUB_NUMBERS[clubType] ?? [];
  const displayName = clubNumber ? `${clubNumber}` : clubType;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('Not signed in.'); setSaving(false); return; }

      const { error: insertErr } = await supabase.from('user_equipment').insert({
        user_id: user.id,
        club_type: clubType,
        club_name: clubNumber || clubType,
        brand: brand || null,
        model: model || null,
        shaft_flex: shaftFlex,
        loft_degrees: loft ? parseFloat(loft) : null,
        notes: notes || null,
      });

      if (insertErr) { setError(insertErr.message); setSaving(false); return; }
      setDone(true);
      setTimeout(() => router.push('/bag'), 800);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unexpected error.';
      setError(msg);
      setSaving(false);
    }
  }

  if (done) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
          <p className="text-white font-semibold">Club added!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8 sm:px-6">
      <Link
        href="/bag"
        className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-400 transition-colors mb-6"
      >
        <ChevronLeft className="w-3.5 h-3.5" /> My Bag
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white tracking-tight">Add a Club</h1>
        <p className="text-sm text-slate-400 mt-1">Track specs for personalised AI recommendations.</p>
      </div>

      <div className="space-y-5">
        {/* Club type */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-2">Club type</label>
          <div className="flex flex-wrap gap-2">
            {CLUB_TYPES.map((ct) => (
              <button
                key={ct}
                onClick={() => { setClubType(ct); setClubNumber(''); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  clubType === ct
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-900 border border-white/10 text-slate-400 hover:text-white'
                }`}
              >
                {ct}
              </button>
            ))}
          </div>
        </div>

        {/* Specific number (if applicable) */}
        {numbers.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-2">Which {clubType.toLowerCase()}?</label>
            <div className="flex flex-wrap gap-2">
              {numbers.map((n) => (
                <button
                  key={n}
                  onClick={() => setClubNumber(n)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    clubNumber === n
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-900 border border-white/10 text-slate-400 hover:text-white'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Brand + Model */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Brand</label>
            <input
              type="text"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Callaway, TaylorMade…"
              className="w-full bg-slate-900 border border-white/10 focus:border-indigo-500/60 outline-none text-sm text-white placeholder-slate-600 rounded-xl px-3 py-2.5 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Paradym, Stealth…"
              className="w-full bg-slate-900 border border-white/10 focus:border-indigo-500/60 outline-none text-sm text-white placeholder-slate-600 rounded-xl px-3 py-2.5 transition-colors"
            />
          </div>
        </div>

        {/* Shaft flex + Loft */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Shaft flex</label>
            <select
              value={shaftFlex}
              onChange={(e) => setShaftFlex(e.target.value)}
              className="w-full bg-slate-900 border border-white/10 focus:border-indigo-500/60 outline-none text-sm text-white rounded-xl px-3 py-2.5 transition-colors"
            >
              {SHAFT_FLEXES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Loft (°)</label>
            <input
              type="number"
              value={loft}
              onChange={(e) => setLoft(e.target.value)}
              placeholder="9.5"
              step="0.5"
              min="0"
              max="70"
              className="w-full bg-slate-900 border border-white/10 focus:border-indigo-500/60 outline-none text-sm text-white placeholder-slate-600 rounded-xl px-3 py-2.5 transition-colors"
            />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Notes <span className="text-slate-600">(optional)</span></label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. graphite shaft, 1° upright, 2° strong…"
            rows={3}
            className="w-full bg-slate-900 border border-white/10 focus:border-indigo-500/60 outline-none text-sm text-white placeholder-slate-600 rounded-xl px-3 py-2.5 transition-colors resize-none"
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 px-4 py-3 bg-red-400/10 border border-red-400/20 rounded-xl text-sm text-red-400">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors"
        >
          {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : `Add ${displayName} to Bag`}
        </button>
      </div>
    </div>
  );
}
