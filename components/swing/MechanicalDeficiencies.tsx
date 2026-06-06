/**
 * swingmaster-web/components/swing/MechanicalDeficiencies.tsx
 * Amber/Red "Mechanical Deficiencies" panel — faults + corrective drills.
 */

'use client';

import { useState } from 'react';
import type { DeficiencyItem } from '@/types/database';

interface Props {
  deficiencies: DeficiencyItem[];
}

export function MechanicalDeficiencies({ deficiencies }: Props) {
  const [expanded, setExpanded] = useState<number | null>(0);

  if (!deficiencies || deficiencies.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-700/40 bg-slate-800/20 p-6 text-center">
        <p className="text-sm text-slate-400">No significant deficiencies detected.</p>
      </section>
    );
  }

  const majorCount = deficiencies.filter((d) => d.severity === 'major').length;
  const minorCount = deficiencies.filter((d) => d.severity === 'minor').length;

  return (
    <section aria-labelledby="deficiencies-heading" className="rounded-2xl border border-rose-800/30 bg-rose-950/20 p-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/20 text-rose-400">
          <TargetIcon />
        </span>
        <div>
          <h2
            id="deficiencies-heading"
            className="font-display text-lg font-semibold tracking-tight text-rose-300"
          >
            Mechanical Deficiencies
          </h2>
          <p className="text-xs text-rose-500/70">
            Faults identified with corrective drills
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {majorCount > 0 && (
            <span className="rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-semibold text-rose-400 ring-1 ring-rose-500/30">
              {majorCount} major
            </span>
          )}
          {minorCount > 0 && (
            <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-400 ring-1 ring-amber-500/30">
              {minorCount} minor
            </span>
          )}
        </div>
      </div>

      {/* Accordion items */}
      <ol className="space-y-3">
        {deficiencies.map((item, idx) => {
          const isMajor = item.severity === 'major';
          const isOpen = expanded === idx;

          const borderColor = isMajor ? 'border-rose-700/40' : 'border-amber-700/30';
          const bgColor = isMajor ? 'bg-rose-900/25' : 'bg-amber-900/15';
          const badgeBg = isMajor
            ? 'bg-rose-500/15 text-rose-400 ring-rose-500/30'
            : 'bg-amber-500/15 text-amber-400 ring-amber-500/30';
          const checkpointColor = isMajor ? 'text-rose-300' : 'text-amber-300';

          return (
            <li
              key={idx}
              className={`rounded-xl border ${borderColor} ${bgColor} overflow-hidden transition-colors`}
            >
              {/* Accordion trigger */}
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : idx)}
                className="flex w-full items-start gap-3 p-4 text-left"
              >
                {/* Severity badge */}
                <span
                  className={`mt-0.5 flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ring-1 ${badgeBg}`}
                >
                  {item.severity}
                </span>

                <div className="min-w-0 flex-1">
                  <p className={`text-xs font-semibold uppercase tracking-widest ${checkpointColor}`}>
                    {item.checkpoint}
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-slate-200">
                    {typeof item.joint_coordinate === "string" ? item.joint_coordinate : item.joint_coordinate?.joint ?? ""}
                  </p>
                </div>

                {/* Chevron */}
                <span
                  className={`flex-shrink-0 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                >
                  <ChevronIcon />
                </span>
              </button>

              {/* Expanded content */}
              {isOpen && (
                <div className="border-t border-white/5 px-4 pb-4 pt-3">
                  {/* Fault description */}
                  <p className="mb-4 text-sm leading-relaxed text-slate-300">
                    {item.fault_description}
                  </p>

                  {/* Corrective drill */}
                  <div className="rounded-lg border border-sky-700/30 bg-sky-900/20 p-3">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-sky-400">
                        <DrillIcon />
                      </span>
                      <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
                        Corrective Drill
                      </span>
                    </div>
                    <p className="text-sm text-sky-100">{item.corrective_drill_title}</p>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TargetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DrillIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2v12M2 8h12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
