"use client";

import Link from "next/link";
import { Lock, Activity, Zap, Info } from "lucide-react";
import type {
  PersistedPuttingAnalysisV1,
  PuttingSection,
} from "@/lib/putting-analysis-contract";

// ─── Presentation contract (EQ5C-A) ───────────────────────────────────────────
//
// This component renders one server-decided state and nothing else. It holds no
// tier, performs no entitlement calculation, and reads no putting column: the
// swing-detail Server Component decides entitlement and validity, and only the
// "ready" state carries a payload.
//
// That split is the security boundary, not a stylistic one. Props crossing a
// Server -> Client boundary are serialized into the RSC flight payload and are
// readable in the browser whatever the component renders, so an unentitled
// golfer must never be handed the narrative to hide. "locked" and "unavailable"
// carry no analysis at all.
//
// The payload type is imported with `import type` so this client bundle never
// pulls in the contract module's Gemini SDK dependency.

export type PuttingResultState =
  | { status: "locked" }
  | { status: "unavailable" }
  | { status: "ready"; analysis: PersistedPuttingAnalysisV1 };

interface PuttingAnalysisPanelProps {
  state: PuttingResultState;
}

// ─── Labels ───────────────────────────────────────────────────────────────────

/** Display order. Typed against the contract, so the Records below stop
 *  compiling if the canonical section set ever changes. */
const SECTION_ORDER: readonly PuttingSection[] = [
  "setup_alignment",
  "stroke_path",
  "face_at_impact",
  "tempo_rhythm",
  "stroke_symmetry",
  "stability",
] as const;

const SECTION_TITLES: Record<PuttingSection, string> = {
  setup_alignment: "Setup & Alignment",
  stroke_path: "Stroke Path",
  face_at_impact: "Face at Impact",
  tempo_rhythm: "Tempo & Rhythm",
  stroke_symmetry: "Stroke Symmetry",
  stability: "Stability",
};

/**
 * Every assessment value in the canonical vocabulary, mapped to golfer-facing
 * copy. Two rules govern this table and neither is cosmetic:
 *
 *   1. The "appears_*" hedge survives into the label. The camera is
 *      uncalibrated, so "Appears Open" is what the evidence supports and
 *      "Open" is not.
 *   2. "unclear" and "unavailable" are honest answers, not failures. They read
 *      as "Unclear" and "Not Assessable" everywhere.
 */
const ASSESSMENT_LABELS: Record<PuttingSection, Readonly<Record<string, string>>> = {
  setup_alignment: {
    sound: "Sound",
    needs_attention: "Needs Attention",
    unclear: "Unclear",
    unavailable: "Not Assessable",
  },
  stroke_path: {
    straight: "Straight",
    in_to_out: "In-to-Out",
    out_to_in: "Out-to-In",
    arc: "Arcing",
    unclear: "Unclear",
    unavailable: "Not Assessable",
  },
  face_at_impact: {
    appears_square: "Appears Square",
    appears_open: "Appears Open",
    appears_closed: "Appears Closed",
    unclear: "Unclear",
    unavailable: "Not Assessable",
  },
  tempo_rhythm: {
    smooth: "Smooth",
    rushed: "Rushed",
    decelerating: "Decelerating",
    uneven: "Uneven",
    unclear: "Unclear",
    unavailable: "Not Assessable",
  },
  stroke_symmetry: {
    balanced: "Balanced",
    backswing_dominant: "Backswing-Dominant",
    through_stroke_dominant: "Through-Stroke-Dominant",
    uneven: "Uneven",
    unclear: "Unclear",
    unavailable: "Not Assessable",
  },
  stability: {
    stable: "Stable",
    head_motion: "Head Motion",
    lower_body_motion: "Lower-Body Motion",
    mixed_motion: "Mixed Motion",
    unclear: "Unclear",
    unavailable: "Not Assessable",
  },
};

/** Fixed copy for a section the video could not support. The absence of an
 *  observation is reported as itself — never filled with substitute analysis. */
const NOT_ASSESSABLE_NOTE = "This section could not be assessed from the video.";

/**
 * The evidence basis in product language. The stored token is an internal
 * value and is deliberately not surfaced; what a golfer needs is the meaning.
 * It is context, not an error.
 */
const EVIDENCE_NOTE = "Qualitative observations from video — not calibrated measurements.";

/** What the qualitative contract actually delivers. Nothing here promises a
 *  measurement, a green read or a prescribed drill, because none is produced. */
const LOCKED_CAPABILITIES: readonly string[] = [
  "AI putting stroke analysis",
  "Setup & alignment observations",
  "Stroke-path tendencies",
  "Face appearance at impact",
  "Tempo & rhythm",
  "Stroke symmetry",
  "Stability",
  "Primary finding",
  "Practice focus",
] as const;

// ─── Shared chrome ────────────────────────────────────────────────────────────

function PanelHeading() {
  return (
    <div className="flex items-center gap-2">
      <Activity size={16} className="text-golf-green" />
      <p className="text-[10px] font-black uppercase tracking-widest text-white">
        Putting Analysis
      </p>
    </div>
  );
}

function SectionCard({
  section,
  value,
}: {
  section: PuttingSection;
  value: { assessment: string; observation: string };
}) {
  const label = ASSESSMENT_LABELS[section][value.assessment] ?? "Not Assessable";
  const observation = value.observation.trim();

  return (
    <div className="bg-black/30 border border-white/5 rounded-2xl p-4">
      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">
        {SECTION_TITLES[section]}
      </p>
      <p className="text-sm font-bold text-white mb-2">{label}</p>
      <p className="text-xs text-gray-400 leading-relaxed">
        {observation.length > 0 ? observation : NOT_ASSESSABLE_NOTE}
      </p>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PuttingAnalysisPanel({ state }: PuttingAnalysisPanelProps) {
  // ── Locked: no analysis reaches this branch at all ──
  if (state.status === "locked") {
    return (
      <div className="bg-golf-surface border border-white/5 rounded-4xl p-6">
        <div className="flex flex-col items-center text-center">
          <div className="w-12 h-12 bg-golf-green/10 border border-golf-green/20 rounded-2xl flex items-center justify-center mb-4">
            <Lock size={20} className="text-golf-green" />
          </div>
          <p className="font-black italic tracking-tighter text-white uppercase text-lg mb-1">
            Putting Analysis
          </p>
          <p className="text-xs text-gray-500 max-w-xs leading-relaxed mb-5">
            Upgrade your plan to read the AI review of this putting stroke.
          </p>
          <div className="space-y-1.5 mb-6 w-full max-w-xs">
            {LOCKED_CAPABILITIES.map((capability) => (
              <div key={capability} className="flex items-center gap-2 text-left">
                <Zap size={10} className="text-golf-green shrink-0" fill="currentColor" />
                <span className="text-[10px] text-gray-400">{capability}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-600 max-w-xs leading-relaxed mb-5">
            {EVIDENCE_NOTE}
          </p>
          <Link
            href="/upgrade"
            className="px-6 py-3 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl text-[10px] hover:bg-[#22C55E] transition-all"
          >
            View Plans
          </Link>
        </div>
      </div>
    );
  }

  // ── Unavailable: entitled, but there is no result this panel may trust ──
  if (state.status === "unavailable") {
    return (
      <div className="bg-golf-surface border border-white/5 rounded-4xl p-6">
        <div className="mb-4">
          <PanelHeading />
        </div>
        <div className="flex items-start gap-3">
          <Info size={16} className="text-gray-600 shrink-0 mt-0.5" />
          <p className="text-xs text-gray-500 leading-relaxed">
            This putting analysis isn&apos;t available to display. Record the stroke again to
            get a fresh review.
          </p>
        </div>
      </div>
    );
  }

  // ── Ready: a validated canonical payload ──
  const { analysis } = state;

  return (
    <div className="bg-golf-surface border border-white/5 rounded-4xl p-6 space-y-5">
      <PanelHeading />

      <p className="text-sm text-gray-300 leading-relaxed">{analysis.summary}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SECTION_ORDER.map((section) => (
          <SectionCard key={section} section={section} value={analysis[section]} />
        ))}
      </div>

      <div className="bg-black/30 border border-white/5 rounded-2xl p-4">
        <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-2">
          Primary Finding
        </p>
        <p className="text-sm text-gray-300 leading-relaxed">{analysis.primary_finding}</p>
      </div>

      <div className="bg-black/30 border border-golf-green/20 rounded-2xl p-4">
        <p className="text-[9px] font-black uppercase tracking-widest text-golf-green mb-2">
          Practice Focus
        </p>
        <p className="text-sm text-gray-300 leading-relaxed">{analysis.practice_focus}</p>
      </div>

      <div className="flex items-start gap-2">
        <Info size={12} className="text-gray-700 shrink-0 mt-0.5" />
        <p className="text-[10px] text-gray-600 leading-relaxed">{EVIDENCE_NOTE}</p>
      </div>
    </div>
  );
}
