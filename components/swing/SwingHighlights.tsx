/**
 * swingmaster-web/components/swing/SwingHighlights.tsx
 * Green "Swing Highlights" panel — displays what the golfer did correctly.
 */

'use client';

import type { HighlightItem } from '@/lib/types/swing';

interface Props {
  highlights: HighlightItem[];
}

export function SwingHighlights({ highlights }: Props) {
  if (!highlights || highlights.length === 0) return null;

  return (
    <section aria-labelledby="highlights-heading" className="rounded-2xl border border-emerald-800/40 bg-emerald-950/30 p-6">
      {/* Header */}
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
          <CheckIcon />
        </span>
        <div>
          <h2
            id="highlights-heading"
            className="font-display text-lg font-semibold tracking-tight text-emerald-300"
          >
            Swing Highlights
          </h2>
          <p className="text-xs text-emerald-500/70">
            Mechanics you executed correctly
          </p>
        </div>
        <span className="ml-auto rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/20">
          {highlights.length} found
        </span>
      </div>

      {/* Items */}
      <ol className="space-y-4">
        {highlights.map((item, idx) => (
          <li
            key={idx}
            className="relative rounded-xl border border-emerald-800/30 bg-emerald-900/20 p-4 transition-colors hover:bg-emerald-900/30"
          >
            {/* Checkpoint badge */}
            <span className="mb-2 inline-block rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-emerald-400">
              {item.checkpoint}
            </span>

            {/* Positive movement */}
            <p className="mb-1 text-sm font-medium leading-relaxed text-emerald-100">
              {item.positive_movement}
            </p>

            {/* Mechanical benefit — slightly muted */}
            <div className="mt-2 flex gap-2">
              <span className="mt-0.5 flex-shrink-0 text-emerald-500">
                <BoltIcon />
              </span>
              <p className="text-xs leading-relaxed text-emerald-400/80">
                <span className="font-semibold text-emerald-400">Performance benefit: </span>
                {item.mechanical_benefit}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Inline SVG icons — zero dependency
function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.5L6.5 12 13 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9 2L3 9h5l-1 5 6-7H8l1-5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
