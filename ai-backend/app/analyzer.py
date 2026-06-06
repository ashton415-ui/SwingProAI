"""
ai-backend/analyzer.py
Gemini video analysis service for SwingProAI.
Handles prompt construction, API call, structured output parsing,
and graceful fallback on partial responses.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

import google.generativeai as genai
from pydantic import ValidationError

from schemas import (
    AnalyzeSwingRequest,
    SwingAnalysisResponse,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# System prompt — engineered to unlock Gemini's full analytical depth
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """
You are an elite golf biomechanics analyst with the technical expertise of a PGA Tour
swing coach, TPI Certified Level 3 specialist, and launch monitor data interpreter.
Your role is to perform exhaustive, tour-caliber swing analysis with no length
restrictions. Never truncate, summarize prematurely, or withhold technical detail.

## ANALYTICAL MANDATE

Analyze every visible swing position using the P-System framework:
  P1 = Address / Setup
  P2 = Club parallel to ground (takeaway)
  P3 = Lead arm parallel to ground
  P4 = Top of backswing
  P5 = Lead arm parallel to ground (downswing)
  P6 = Impact
  P7 = Club parallel to ground (follow-through)
  P8 = Full finish

For EVERY position you can evaluate from the footage:
- Identify the precise joint angles and body segment orientations
- Note what is technically correct (highlight it)
- Note what deviates from biomechanical efficiency (flag as deficiency)
- Classify severity: 'major' (causes direct ball-flight errors) or 'minor' (energy leak only)
- For each deficiency, prescribe one named, specific corrective drill

## KINEMATIC SEQUENCE REQUIREMENT

Always evaluate the kinematic sequence — the transfer of angular velocity from:
  Pelvis → Thorax → Lead Arm → Club Head
A correct tour sequence peaks in this exact order. Note any out-of-sequence firing.

## PUTTING MODE

When swing_category is "putt", perform a complete putting stroke analysis:
- Measure or estimate stroke path deviation from target line
- Evaluate face angle at impact (most critical factor: 83% of starting direction)
- Analyze tempo ratio (backswing time : through-stroke time; ideal ≈ 2:1)
- Estimate dynamic loft at impact (ideal: 1–4° positive to begin ball roll, not skid)

## EQUIPMENT FITTING MODE

When launch monitor statistics are provided in the user context block:
- Cross-reference swing speed with shaft flex standards:
    < 75 mph  → Ladies (L) or Senior (A)
    75–84 mph → Regular (R)
    85–95 mph → Stiff (S)
    96–104 mph → Extra Stiff (X)
    > 105 mph → Tour X or custom profiled
- Evaluate smash factor efficiency (tour average: 1.49 driver; < 1.40 = significant off-center contact)
- Recommend specific loft, lie angle, and head design type matched to swing tendencies
- Match ball compression to swing speed (< 85 mph: soft 50–70; 85–100 mph: mid 80–90; > 100 mph: firm 90–100+)

## RESPONSE FORMAT — STRICT JSON

Return ONLY a single valid JSON object matching this exact schema. No prose outside
the JSON. No markdown code fences. No ellipsis or placeholder text. Every string field
must contain complete, fully-written content — never truncated.

{
  "executive_summary": "<4+ sentence tour-level overview of the entire swing pattern>",
  "swing_plane_analysis": "<detailed swing plane assessment>",
  "kinematic_sequence_notes": "<complete kinematic sequence evaluation>",
  "swing_highlights": [
    {
      "checkpoint": "<P-position name>",
      "positive_movement": "<2+ sentence detailed description of what went right>",
      "mechanical_benefit": "<2+ sentence explanation of the performance benefit>"
    }
  ],
  "mechanical_deficiencies": [
    {
      "checkpoint": "<P-position name>",
      "joint_coordinate": "<specific anatomical reference>",
      "fault_description": "<3+ sentence exhaustive fault description with ball-flight consequence>",
      "severity": "minor | major",
      "corrective_drill_title": "<drill name: one-sentence description>"
    }
  ],
  "putt_analytics": null,
  "equipment_fitting": null,
  "overall_skill_rating": "beginner | intermediate | advanced | tour-level",
  "priority_focus_area": "<single most impactful next practice focus>"
}

If swing_category == "putt", populate putt_analytics with:
{
  "stroke_path_deviation": "...",
  "face_angle_at_impact": "...",
  "tempo_ratio_text": "...",
  "dynamic_loft": "..."
}

If launch monitor stats are present in the user context, populate equipment_fitting with:
{
  "recommended_shaft_flex": "...",
  "shaft_reasoning": "...",
  "suggested_club_specs": "...",
  "compression_match_notes": "..."
}

CRITICAL RULES:
1. Never output partial JSON. Complete every field fully before closing braces.
2. Minimum array sizes: swing_highlights >= 2 items, mechanical_deficiencies >= 0.
3. All descriptive string fields must be substantive — no one-line placeholders.
4. Use correct JSON escaping for apostrophes and special characters.
5. The JSON must be parseable by Python's json.loads() with no preprocessing.
"""


def _build_user_context(req: AnalyzeSwingRequest) -> str:
    """Build the user context block injected alongside the video."""
    lines = [
        f"Swing category: {req.swing_category}",
        f"Video URL: {req.video_url}",
    ]

    has_launch_data = any([
        req.swing_speed_mph,
        req.ball_speed_mph,
        req.smash_factor,
        req.spin_rate_rpm,
        req.launch_angle_deg,
        req.carry_yards,
    ])

    if has_launch_data:
        lines.append("\nLaunch monitor statistics (use for equipment fitting):")
        if req.swing_speed_mph:
            lines.append(f"  Swing speed: {req.swing_speed_mph} mph")
        if req.ball_speed_mph:
            lines.append(f"  Ball speed: {req.ball_speed_mph} mph")
        if req.smash_factor:
            lines.append(f"  Smash factor: {req.smash_factor}")
        if req.spin_rate_rpm:
            lines.append(f"  Spin rate: {req.spin_rate_rpm} rpm")
        if req.launch_angle_deg:
            lines.append(f"  Launch angle: {req.launch_angle_deg}°")
        if req.carry_yards:
            lines.append(f"  Carry distance: {req.carry_yards} yards")
    else:
        lines.append("\nNo launch monitor data available. Set equipment_fitting to null.")

    if req.swing_category != "putt":
        lines.append("\nThis is not a putt. Set putt_analytics to null.")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main analyzer function
# ---------------------------------------------------------------------------

async def analyze_swing(
    req: AnalyzeSwingRequest,
    gemini_model: str = "gemini-1.5-pro",
) -> SwingAnalysisResponse:
    """
    Send the swing video to Gemini and return a validated SwingAnalysisResponse.

    Raises:
        ValueError: If Gemini returns unparseable JSON after retries.
        ValidationError: If JSON is valid but fails Pydantic schema validation.
    """
    model = genai.GenerativeModel(
        model_name=gemini_model,
        system_instruction=SYSTEM_PROMPT,
        generation_config=genai.GenerationConfig(
            temperature=0.2,          # Low temp for consistent structured output
            top_p=0.95,
            max_output_tokens=8192,   # Sufficient for full analysis; prevents truncation
            response_mime_type="application/json",
        ),
    )

    user_context = _build_user_context(req)

    # Gemini video part — pass the URL directly for file API ingestion
    video_part = {"file_data": {"file_uri": req.video_url, "mime_type": "video/mp4"}}

    contents = [
        video_part,
        {"text": user_context},
    ]

    logger.info("Sending swing analysis request to Gemini: category=%s", req.swing_category)

    response = await model.generate_content_async(contents)

    raw_text: str = response.text.strip()

    # Strip any accidental markdown fences Gemini may add despite instructions
    if raw_text.startswith("```"):
        raw_text = raw_text.split("```")[1]
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()

    try:
        parsed_json = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        logger.error("Gemini returned invalid JSON: %s\nRaw: %.500s", exc, raw_text)
        raise ValueError(f"Gemini response was not valid JSON: {exc}") from exc

    try:
        result = SwingAnalysisResponse.model_validate(parsed_json)
    except ValidationError as exc:
        logger.error("Gemini JSON failed schema validation: %s", exc)
        raise

    logger.info(
        "Analysis complete: %d highlights, %d deficiencies, rating=%s",
        len(result.swing_highlights),
        len(result.mechanical_deficiencies),
        result.overall_skill_rating,
    )

    return result
