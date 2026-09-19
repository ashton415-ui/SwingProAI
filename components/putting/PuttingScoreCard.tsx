import { Info, Target } from "lucide-react";
import type { PuttingScorePresentationState } from "@/lib/putting-score-presentation-eq5f-f";

// ─── Presentation contract (EQ5F-F) ───────────────────────────────────────────
//
// A Server Component, deliberately. There is nothing to interact with here —
// one number, one fraction and one sentence — so a client bundle would buy
// nothing and would move premium data across a serialization boundary for the
// privilege. It holds no tier, performs no entitlement calculation, reads no
// column and computes no score: the swing-detail Server Component decides
// whether a score may be shown and hands over the three primitives below.
//
// What the number means is the hard part of this component, and the copy is the
// contract:
//
//   * it is an INDEX, not a percentage. "92" is rendered bare, and no "%" glyph
//     appears anywhere in this file. A percent sign would turn a coaching index
//     into a claim about how many putts a golfer holes, which nothing in the
//     pipeline measured.
//   * coverage is reported beside it, never folded into it. "6 of 6 sections"
//     and the index are two different facts, and a single number would present
//     a stroke read from one section exactly like a stroke read from six.
//   * there are no bands. Elite / Excellent / Good / Average / Poor would be a
//     vocabulary this product has never defined, invented at the last possible
//     moment in the render layer.

const TITLE = "Putting Stroke Index";

/** What the index is, in the words a golfer needs, every time it is shown. */
const BASIS_NOTE = "Qualitative coaching index from video. Not a calibrated measurement.";

/** The honest answer when a valid envelope says nothing was readable. */
const UNAVAILABLE_NOTE = "Not enough of this stroke was readable to calculate the index.";

function CardHeading() {
  return (
    <div className="flex items-center gap-2">
      <Target size={16} className="text-golf-green" />
      <p className="text-[10px] font-black uppercase tracking-widest text-white">{TITLE}</p>
    </div>
  );
}

function Coverage({ scorable, total }: { scorable: number; total: number }) {
  return (
    <div>
      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1">Coverage</p>
      <p className="text-xs font-bold text-gray-300">
        {scorable} of {total} sections
      </p>
    </div>
  );
}

export function PuttingScoreCard({ state }: { state: PuttingScorePresentationState }) {
  return (
    <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 space-y-5">
      <CardHeading />

      {state.status === "ready" ? (
        <div className="flex flex-wrap items-end justify-between gap-6">
          {/* The bare index. No unit, no suffix, no glyph — the label above it
              is what gives the number its meaning. */}
          <p className="text-5xl font-mono font-black italic tracking-tighter text-golf-green leading-none">
            {state.score}
          </p>
          <Coverage scorable={state.scorableSections} total={state.totalSections} />
        </div>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-6">
          {/* Never a zero. Zero would report a stroke assessed and found
              faultless-in-reverse, when it was not assessed at all. */}
          <p className="text-lg font-bold text-gray-400 leading-none">Score unavailable</p>
          <Coverage scorable={state.scorableSections} total={state.totalSections} />
        </div>
      )}

      {state.status === "unavailable" && (
        <p className="text-xs text-gray-500 leading-relaxed">{UNAVAILABLE_NOTE}</p>
      )}

      <div className="flex items-start gap-2">
        <Info size={12} className="text-gray-700 shrink-0 mt-0.5" />
        <p className="text-[10px] text-gray-600 leading-relaxed">{BASIS_NOTE}</p>
      </div>
    </div>
  );
}
