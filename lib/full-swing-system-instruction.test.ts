import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PILLAR_RATINGS } from "@/lib/full-swing-analysis-contract";
import { PUTTING_SYSTEM_INSTRUCTION } from "@/lib/putting-analysis-contract";
import {
  DETAIL_VISIBILITY,
  FINDING_STATUSES,
  POSITION_VISIBILITY,
  SWING_DETAILS,
  SWING_POSITIONS,
} from "@/lib/full-swing-scoring-rubric";

// ============================================================================
// ENT-1D S6 content candidate: full-swing SYSTEM_INSTRUCTION evidence discipline
// ============================================================================
//
// Text-level coverage of the full-swing system instruction in
// app/api/analyze-swing/route.ts. The instruction is a module-private constant,
// so it is read from the committed source exactly as the template literal
// defines it. These tests show what the instruction says; they cannot show
// how any model responds to it.

const ROUTE = readFileSync(join(__dirname, "..", "app/api/analyze-swing/route.ts"), "utf8").replace(/\r\n/g, "\n");
const OPEN = "const SYSTEM_INSTRUCTION = `";
const CLOSE = "`.trim();";

function instructionLiteral(): string {
  const start = ROUTE.indexOf(OPEN);
  expect(start).toBeGreaterThan(-1);
  expect(ROUTE.indexOf(OPEN, start + 1)).toBe(-1);
  const end = ROUTE.indexOf(CLOSE, start);
  expect(end).toBeGreaterThan(start);
  return ROUTE.slice(start + OPEN.length, end);
}

const RAW = instructionLiteral();
// With no substitutions, escapes or backticks the literal's value is its source text.
const SYSTEM = RAW.trim();

describe("the literal is plain text", () => {
  it("has no substitutions, escapes or nested backticks", () => {
    expect(RAW).not.toContain("${");
    expect(RAW).not.toContain("\\");
    expect(RAW).not.toContain("`");
  });
});

describe("visible body regions are distinguished from detailed anatomy", () => {
  it("states that a region in view is not its joints, lines or landmarks, estimates or assessability", () => {
    expect(SYSTEM).toContain("A body region in view is not the same as its detailed anatomy.");
    expect(SYSTEM).toContain("shoulders or pelvis are visible when that part of the body is in view and can be told apart.");
    expect(SYSTEM).toContain(
      "Seeing a region does not, on its own, show the joints, lines or landmarks needed to judge an angle, an alignment or an amount of turn, and it does not on its own support an estimate or make a turn assessable.",
    );
    expect(SYSTEM).toContain("do not name or judge a joint, angle or alignment the video does not show.");
  });

  it("missing numeric or anatomical evidence does not downgrade a visible region's declaration", () => {
    expect(SYSTEM).toContain("When a region is visible but those landmarks are not clear");
    expect(SYSTEM).toContain(
      "keep its detail_visibility as visible; show the missing detail where it applies instead: a null estimate, assessable false, a not_assessable rubric item and an observation that says what is missing.",
    );
    expect(DETAIL_VISIBILITY).toContain("visible");
    expect(FINDING_STATUSES).toContain("not_assessable");
    // The rev0 wording that pushed a visible region to unclear/not_visible is gone.
    expect(SYSTEM).not.toContain("mark the detail unclear or not_visible");
    expect(SYSTEM).not.toContain("Mark a detail visible only when the landmarks it needs can be followed clearly");
  });

  it("asks for a joint to be named only when the video shows it", () => {
    expect(SYSTEM).toContain("name a joint only when the video shows it clearly.");
    expect(SYSTEM).not.toContain("Name the joints and positions you describe");
  });
});

describe("numbers, moments and times need visible support", () => {
  const bullet = (start: string): string => {
    const line = SYSTEM.split("\n").find((l) => l.startsWith(start));
    expect(line, start).toBeDefined();
    return line as string;
  };

  it("landmark requirements are limited to the geometric estimates", () => {
    const geometric = bullet("• spine_angle, hip_rotation and shoulder_rotation are geometric estimates.");
    expect(geometric).toContain("Give one only when you can name the visible landmarks it is measured from at the moment it refers to.");
    expect(geometric).toContain("A turn amount also needs the same body line to be visible both before and after the turn.");
    expect(geometric).toContain("Seeing a body region never supports a geometric estimate on its own.");
    expect(geometric).not.toContain("tempo_ratio");
    // Landmarks are required only in that bullet and the region bullet, never for timing.
    const landmarkLines = SYSTEM.split("\n").filter((l) => /landmark/i.test(l));
    for (const line of landmarkLines) expect(line).not.toContain("tempo_ratio");
    expect(SYSTEM).not.toContain("Give an estimate only when you can name the visible landmarks");
  });

  it("tempo_ratio has its own timing guidance: identifiable moments, supported times, no invented precision", () => {
    const tempo = bullet("• tempo_ratio is a timing estimate, not a geometric one.");
    expect(tempo).toContain("Give it only when takeaway_start, top_of_backswing and impact are each identifiable in the video and the times you gave them are supported by where you see those moments.");
    expect(tempo).toContain("Never derive it from a typical rhythm, invent or adjust a time to produce it, or give it more precision than those times support; otherwise use null.");
    expect(tempo).not.toMatch(/landmark/i);
  });

  it("a resembling pose is not a moment, and presence without placement is unclear", () => {
    expect(SYSTEM).toContain("A moment is yes only when the video shows the club and body passing through or holding that position as part of the swing.");
    expect(SYSTEM).toContain("A pose that resembles a swing position is not, on its own, evidence that the swing reached that moment.");
    expect(SYSTEM).toContain("If you can tell that a moment occurs but not where in the video it is, mark it unclear.");
  });

  it("times come from where the moment is seen, never from rhythm or other moments", () => {
    expect(SYSTEM).toContain("A time is where in this video you see the moment, no more precise than the video lets you place it.");
    expect(SYSTEM).toContain("Never work out a time from a typical swing rhythm, from the times of other moments or from the frame rate alone.");
  });
});

describe("static pose observations are separated from dynamic swing claims", () => {
  it("a still pose supports static comments only; movement claims need movement", () => {
    expect(SYSTEM).toContain("a single position, a held pose or a video without clear club motion supports static comments only");
    expect(SYSTEM).toContain("need the video to show that movement between the moments involved.");
    expect(SYSTEM).toContain("Never describe motion you inferred from a still position.");
  });

  it("view-limited comments are allowed without ratings that need unseen depth", () => {
    expect(SYSTEM).toContain("say that the comment is view-limited; do not rate or describe anything that needs depth or an angle this view does not show.");
  });
});

describe("uncertainty and source-supported unscored explanations", () => {
  // Each field's uncertain answer must come from that field's own enum, and from no other field's.
  const FIELD_VALUES: Record<string, readonly string[]> = {
    "In positions": POSITION_VISIBILITY,
    "In detail_visibility": DETAIL_VISIBILITY,
    "In rubric_findings": FINDING_STATUSES,
    "For a pillar": PILLAR_RATINGS,
  };
  // Values that are also plain English words (yes, no, good, poor, visible, observed) cannot be told apart in
  // prose, so the scan uses the unambiguous ones: every snake_case value plus "unclear".
  const ALL_VALUES = Array.from(new Set<string>([...POSITION_VISIBILITY, ...DETAIL_VISIBILITY, ...FINDING_STATUSES, ...PILLAR_RATINGS]))
    .filter((v) => v.includes("_") || v === "unclear");
  const valuesIn = (sentence: string) => ALL_VALUES.filter((v) => new RegExp(`(^|[^a-z_])${v}([^a-z_]|$)`).test(sentence));

  it("uncertainty uses each field's own declaration value", () => {
    const line = SYSTEM.split("\n").find((l) => l.startsWith("• When you are unsure, use the uncertain answer of the field concerned."));
    expect(line).toBeDefined();
    const sentences = (line as string).split(/(?<=\.) /);
    const expected: Record<string, string> = {
      "In positions": "unclear",
      "In detail_visibility": "unclear",
      "In rubric_findings": "not_assessable",
      "For a pillar": "insufficient_evidence",
    };
    for (const [lead, value] of Object.entries(expected)) {
      const sentence = sentences.find((s) => s.startsWith(lead));
      expect(sentence, lead).toBeDefined();
      expect(FIELD_VALUES[lead], lead).toContain(value);
      expect(valuesIn(sentence as string), lead).toEqual([value]);
    }
    expect(line).toContain("a moment you are unsure of is unclear, with no time.");
    expect(line).toContain("An estimate you cannot support is null, and a turn you cannot assess has assessable false.");
    expect(line).toContain("Low confidence is neither a sighting nor an absence.");
  });

  it("no field is pointed at another field's value", () => {
    // The rev0 combined wording is gone.
    expect(SYSTEM).not.toContain("use unclear or not_assessable");
    // Declaration fields never receive a finding status or a pillar rating; findings never receive a declaration value.
    expect(SYSTEM).not.toMatch(/(positions|detail_visibility)[^.\n]{0,60}\b(not_assessable|insufficient_evidence)\b/);
    expect(SYSTEM).not.toMatch(/rubric[^.\n]{0,40}\b(unclear|not_visible|insufficient_evidence)\b/);
    expect(SYSTEM).not.toMatch(/\bpillar\b[^.\n]{0,40}\b(not_assessable|not_visible)\b/);
    // Value sets are disjoint where the instruction relies on it.
    expect(POSITION_VISIBILITY).not.toContain("not_assessable");
    expect(DETAIL_VISIBILITY).not.toContain("not_assessable");
    expect(FINDING_STATUSES).not.toContain("unclear");
    expect(PILLAR_RATINGS).not.toContain("not_assessable");
  });

  it("an explained unscored result is valid, specific to this video and never a way to avoid judging", () => {
    expect(SYSTEM).toContain("An unscored result is a valid answer even when the listed requirements appear to be met");
    expect(SYSTEM).toContain("unscored_reason names the specific moment, view or detail of this video that prevented scoring and agrees with what you reported in positions and detail_visibility.");
    expect(SYSTEM).toContain("Never give a generic or invented reason, and never leave a swing unscored just to avoid judging what the video does show.");
  });
});

describe("a partly assessable swing keeps its supported observations", () => {
  it("rates a pillar only with its moment and enough evidence for that rating; otherwise an observation and insufficient_evidence", () => {
    expect(SYSTEM).toContain("When only part of the swing or body can be assessed, keep what is supported.");
    expect(SYSTEM).toContain(
      "Rate a pillar only when its moment is visible and the video gives enough evidence for that particular rating; otherwise keep a supported observation and use insufficient_evidence.",
    );
    expect(PILLAR_RATINGS).toContain("insufficient_evidence");
    expect(SYSTEM).not.toContain("rate each pillar whose moment is visible");
  });

  it("reports what is supported and names what could not be judged", () => {
    expect(SYSTEM).toContain("Report the observations, strengths and faults the visible part supports, and say in the summary what could not be judged.");
    expect(SYSTEM).toContain("An unscored result still describes what the video shows.");
    expect(SYSTEM).toContain("Never pad it with general advice the video does not support.");
  });
});

describe("existing rules are kept", () => {
  it("keeps the evidence, numbers, scoring and coaching rules the candidate does not revise", () => {
    for (const kept of [
      "Base every statement on what the attached video shows",
      "Never fill a gap with a typical fault, a template or another golfer's pattern.",
      "never state a ball-flight result as fact",
      "Never invent a strength or a fault to fill a list.",
      "takeaway_start (the moment the club starts back; not address)",
      "The moments happen in this order: address, takeaway_start, top_of_backswing, early_downswing, impact.",
      "Never change a time, add precision or claim a moment is visible just to keep the order.",
      "Never guess a number to fill a field, and never copy a client-supplied estimate into these fields.",
      "never apply a diagnosis or scoring adjustment on a client-supplied estimate alone.",
      "You do not write a score.",
      "You do not compare any estimate with a cutoff.",
      "An estimate you made is not, on its own, evidence of a fault.",
      "Never mark something not_observed because you cannot see it.",
      "Full coverage alone does not require true.",
      "Each drill addresses one listed deficiency, in the same order; no drill without a deficiency.",
      "rate posture only when address is visible, swing_plane only when top_of_backswing is visible, and impact only when impact is visible.",
    ]) expect(SYSTEM, kept).toContain(kept);
  });

  it("the new section sits between what the video shows and the numbers", () => {
    const sections = ["EVIDENCE RULES", "WHAT THE VIDEO SHOWS", "WHAT COUNTS AS SEEN", "NUMBERS", "CLIENT-SUPPLIED ESTIMATES", "SWING POSITIONS", "SCORING", "COACHING"];
    const at = sections.map((s) => SYSTEM.search(new RegExp(`\\n${s}( — [A-Z ]+)?\\n`)));
    sections.forEach((s, i) => expect(at[i], s).toBeGreaterThan(-1));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("every position and detail it names belongs to the committed contract", () => {
    for (const name of [...SWING_POSITIONS, ...SWING_DETAILS]) expect(SYSTEM, name).toContain(name);
  });
});

describe("no fixture rules, numeric targets, blanket nulls or canned coaching", () => {
  it("contains no digits beyond the time format and a rubric id, no degree signs and no cutoff wording", () => {
    const TIME_RANGE = "seconds 00 to 59";
    expect(SYSTEM).toContain(TIME_RANGE);
    expect(SYSTEM).toContain("laid_off_p4");
    expect(SYSTEM.split(TIME_RANGE).join("").split("laid_off_p4").join("")).not.toMatch(/[0-9]/);
    for (const banned of ["°", "pts", "≥", "≤", "X-Factor", "clamp", "scoring_breakdown", "fault_tags"]) expect(SYSTEM, banned).not.toContain(banned);
  });

  it("names no evaluation fixture, reviewer, policy record or reference label", () => {
    expect(SYSTEM).not.toMatch(/V-FS|\bAC-?\d|\bAC[12]\b|OPPREG|POL-|S6-|\bMax\b|cartoon|synthetic|fixture|reference label|questionnaire/i);
    expect(SYSTEM).not.toMatch(/coach answer|coach's answer|the coach said/i);
  });

  it("never asks for a blanket null, unclear or unscored answer", () => {
    expect(SYSTEM).not.toMatch(/\balways\b[^.\n]{0,40}\b(null|unclear|not_assessable|insufficient_evidence|unscored|scorable (is |to )?false)\b/i);
    expect(SYSTEM).not.toMatch(/\b(set|mark)\b[^.\n]{0,20}\b(every|all)\b[^.\n]{0,40}\b(null|unclear|not_assessable|insufficient_evidence)\b/i);
  });

  it("never supplies fallback coaching text to reuse", () => {
    expect(SYSTEM).not.toMatch(/\b(use|write|say) (this|the following)\b/i);
    expect(SYSTEM).not.toMatch(/\bdefault (drill|advice|tip|summary|coaching)\b/i);
  });
});

describe("the putting instruction is separate and unchanged in kind", () => {
  it("putting text carries none of the full-swing candidate's new section", () => {
    expect(PUTTING_SYSTEM_INSTRUCTION).not.toContain("WHAT COUNTS AS SEEN");
    expect(ROUTE).toContain("systemInstruction: PUTTING_SYSTEM_INSTRUCTION,");
    expect(ROUTE).toContain("systemInstruction: SYSTEM_INSTRUCTION,");
  });
});
