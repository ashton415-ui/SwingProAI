import Link from "next/link";
import { Info, Lock, Target } from "lucide-react";
import type {
  HydratedPuttingDrillRecommendationV1,
  PuttingRecommendationResultV1,
} from "@/lib/putting-recommendation-authority-eq5e-c";

// ─── Presentation contract (EQ5E-D) ───────────────────────────────────────────
//
// This component renders one result the recommendation authority has already
// decided, and nothing else. Entitlement, ownership, analysis family,
// completion, payload validity, catalog agreement, which drills and in what
// order were all settled on the server before this file is reached. What is
// left here is choosing words for the answer it was handed.
//
// It is a Server Component on purpose. It holds no state and needs no browser,
// so unlike the analysis panel beside it there is no reason for it to enter the
// client bundle, and the result it renders never crosses into the browser as a
// serialized prop. The authority module is named only through `import type`,
// which the compiler erases, so nothing here depends on that module at runtime.
//
// A suggestion is not an assignment. Nothing below saves, schedules, tracks or
// checks a drill, and no copy may imply that a coach chose it, that the golfer
// has begun it, or that anything about it was measured. The catalog's
// instructional text is shown verbatim, and nothing is added to it.
//
// Internal identifiers stay internal. The rule-set provenance carried on each
// recommendation exists for auditability, not for display; the golfer sees the
// analysis section it came from, in the same words the analysis panel uses.

interface PuttingRecommendationsPanelProps {
  readonly result: PuttingRecommendationResultV1;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

const HEADING = "Putting Practice Suggestions";

const LOCKED_COPY = "Upgrade to see practice suggestions for this stroke.";

/** The analysis may still be valid and on screen; only the suggestions are missing. */
const UNAVAILABLE_COPY = "Practice suggestions aren't available for this analysis.";

/**
 * Deliberately different from the copy above. An unavailable analysis is an
 * ordinary answer; a catalog that no longer agrees with the rule set is a
 * fault, and rendering the two identically would hide it. Neither blames the
 * golfer or suggests their analysis failed.
 */
const CATALOG_UNAVAILABLE_COPY = "Practice suggestions are temporarily unavailable.";

/**
 * Zero suggestions covers two different situations — a stroke whose observed
 * sections gave the rule set nothing to act on, and a stroke the video could
 * not support a judgement about. This copy is true of both, so it neither
 * praises the stroke nor implies a problem.
 */
const NO_SUGGESTION_COPY =
  "No specific putting drill is indicated by the available video observations.";

const EVIDENCE_NOTE =
  "Suggested from qualitative video observations — not calibrated measurements.";

/**
 * Golfer-facing titles for the analysis sections a suggestion can come from,
 * matching the analysis panel's wording. Keyed by the authority's own
 * source-section type, so adding or removing a section there stops this from
 * compiling until the table is updated.
 */
const SOURCE_SECTION_TITLES: Record<HydratedPuttingDrillRecommendationV1["source_section"], string> = {
  setup_alignment: "Setup & Alignment",
  face_at_impact: "Face at Impact",
  stroke_path: "Stroke Path",
  tempo_rhythm: "Tempo & Rhythm",
};

/** Nullable catalog text is shown only when there is something to show. */
function hasCopy(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

// ─── Shared chrome ────────────────────────────────────────────────────────────

function SectionHeading() {
  return (
    <div className="flex items-center gap-2">
      <Target size={16} className="text-golf-green" aria-hidden="true" />
      <h2 className="text-[10px] font-black uppercase tracking-widest text-white">{HEADING}</h2>
    </div>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <section className="bg-golf-surface border border-white/5 rounded-4xl p-6">
      <div className="mb-4">
        <SectionHeading />
      </div>
      <div className="flex items-start gap-3">
        <Info size={16} className="text-gray-600 shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-xs text-gray-500 leading-relaxed">{message}</p>
      </div>
    </section>
  );
}

function CatalogCopy({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1">{label}</p>
      <p className="text-xs text-gray-400 leading-relaxed whitespace-pre-line">{text}</p>
    </div>
  );
}

// ─── States ───────────────────────────────────────────────────────────────────

/** No recommendation data exists in a locked result, so there is none to show. */
function LockedNotice() {
  return (
    <section className="bg-golf-surface border border-white/5 rounded-4xl p-6">
      <div className="mb-4">
        <SectionHeading />
      </div>
      <div className="flex items-start gap-3 mb-5">
        <Lock size={16} className="text-golf-green shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-xs text-gray-500 leading-relaxed">{LOCKED_COPY}</p>
      </div>
      <Link
        href="/upgrade"
        className="inline-flex items-center min-h-[44px] px-6 bg-golf-green text-golf-dark font-black uppercase tracking-widest rounded-2xl text-[10px] hover:bg-[#22C55E] transition-all"
      >
        View Plans
      </Link>
    </section>
  );
}

function SuggestionCard({ suggestion }: { suggestion: HydratedPuttingDrillRecommendationV1 }) {
  return (
    <li className="bg-black/30 border border-white/5 rounded-2xl p-4 space-y-3">
      <div>
        <p className="text-[9px] font-black uppercase tracking-widest text-gray-600 mb-1">
          Based on: {SOURCE_SECTION_TITLES[suggestion.source_section]}
        </p>
        <h3 className="text-sm font-bold text-white">{suggestion.name}</h3>
      </div>
      {hasCopy(suggestion.the_why) && <CatalogCopy label="Why It Helps" text={suggestion.the_why} />}
      {hasCopy(suggestion.the_how) && <CatalogCopy label="How To Do It" text={suggestion.the_how} />}
      {hasCopy(suggestion.the_feel) && <CatalogCopy label="The Feel" text={suggestion.the_feel} />}
    </li>
  );
}

/** The order is the authority's. It is rendered as received — never re-ordered. */
function ReadySuggestions({
  suggestions,
}: {
  suggestions: readonly HydratedPuttingDrillRecommendationV1[];
}) {
  return (
    <section className="bg-golf-surface border border-white/5 rounded-4xl p-6 space-y-5">
      <SectionHeading />

      {suggestions.length === 0 ? (
        <p className="text-sm text-gray-400 leading-relaxed">{NO_SUGGESTION_COPY}</p>
      ) : (
        <ol className="space-y-3">
          {suggestions.map((suggestion, position) => (
            <SuggestionCard key={position} suggestion={suggestion} />
          ))}
        </ol>
      )}

      <div className="flex items-start gap-2">
        <Info size={12} className="text-gray-700 shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-[10px] text-gray-600 leading-relaxed">{EVIDENCE_NOTE}</p>
      </div>
    </section>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PuttingRecommendationsPanel({ result }: PuttingRecommendationsPanelProps) {
  switch (result.status) {
    case "locked":
      return <LockedNotice />;
    case "unavailable":
      return <Notice message={UNAVAILABLE_COPY} />;
    case "catalog_unavailable":
      return <Notice message={CATALOG_UNAVAILABLE_COPY} />;
    case "ready":
      return <ReadySuggestions suggestions={result.recommendations} />;
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}
