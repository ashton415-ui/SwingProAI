"""
ai-backend/schemas.py
Pydantic v2 schemas for the SwingProAI Gemini biomechanical analysis pipeline.
All fields use detailed string types to prevent Gemini response truncation.
"""

from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Sub-schemas â€” Arrays returned inside the main analysis
# ---------------------------------------------------------------------------

class HighlightItem(BaseModel):
    """Positive mechanical movement the golfer executed correctly."""
    checkpoint: str = Field(
        ...,
        description="Named swing position (e.g. 'P1 â€“ Address', 'P4 â€“ Top of Backswing')",
    )
    positive_movement: str = Field(
        ...,
        description=(
            "Detailed description of the correct biomechanical movement observed. "
            "Minimum 2 sentences. Reference specific joint angles, body segments, "
            "or kinematic sequence where applicable."
        ),
    )
    mechanical_benefit: str = Field(
        ...,
        description=(
            "Explanation of why this movement benefits ball-striking, power transfer, "
            "or consistency. Minimum 2 sentences with tour-level technical language."
        ),
    )


class DeficiencyItem(BaseModel):
    """A mechanical fault identified in the swing with corrective guidance."""
    checkpoint: str = Field(
        ...,
        description="Named swing position where the fault occurs.",
    )
    joint_coordinate: str = Field(
        ...,
        description=(
            "Specific anatomical reference â€” e.g. 'left hip internal rotation', "
            "'trail elbow plane', 'thoracic spine extension angle'."
        ),
    )
    fault_description: str = Field(
        ...,
        description=(
            "Exhaustive technical description of the fault: what the body segment is "
            "doing incorrectly, root cause, and ball-flight consequence. Minimum 3 sentences."
        ),
    )
    severity: Literal["minor", "major"] = Field(
        ...,
        description="'major' = directly causes mis-hits; 'minor' = efficiency loss only.",
    )
    corrective_drill_title: str = Field(
        ...,
        description=(
            "Name and one-sentence description of a specific, actionable practice drill "
            "that directly addresses this fault."
        ),
    )


class PuttAnalytics(BaseModel):
    """Putting-specific stroke analytics. Only populated when swing_category == 'putt'."""
    stroke_path_deviation: str = Field(
        ...,
        description=(
            "Description of the putter path relative to target line: "
            "in-to-out, out-to-in, straight, or arc deviation in degrees/cm."
        ),
    )
    face_angle_at_impact: str = Field(
        ...,
        description=(
            "Putter face angle at impact relative to path and target: "
            "open, closed, or square, with estimated degree deviation."
        ),
    )
    tempo_ratio_text: str = Field(
        ...,
        description=(
            "Backswing-to-through-stroke tempo ratio description. "
            "Ideal is approximately 2:1. Note any rushing or deceleration."
        ),
    )
    dynamic_loft: str = Field(
        ...,
        description=(
            "Estimated dynamic loft at impact. Positive loft launches ball into skid; "
            "negative loft drives ball into green. Ideal range is 1â€“4 degrees positive."
        ),
    )


class EquipmentFitting(BaseModel):
    """AI equipment fitting recommendations cross-referencing mechanics + launch data."""
    recommended_shaft_flex: str = Field(
        ...,
        description=(
            "Recommended shaft flex based on swing speed and tempo. "
            "Must reference the user's actual swing speed figure in reasoning."
        ),
    )
    shaft_reasoning: str = Field(
        ...,
        description=(
            "Detailed explanation (minimum 3 sentences) of why this flex/weight profile "
            "suits the golfer's measured swing speed, smash factor, and identified "
            "mechanical tendencies."
        ),
    )
    suggested_club_specs: str = Field(
        ...,
        description=(
            "Specific club head specs: loft, lie angle, head design (blade/cavity/game-improvement), "
            "and any offset recommendations. Reference the golfer's ball-flight tendencies."
        ),
    )
    compression_match_notes: str = Field(
        ...,
        description=(
            "Ball compression recommendation matched to swing speed. "
            "Reference specific compression range (e.g. 90â€“100 compression) and "
            "explain the energy transfer benefit for this player's speed profile."
        ),
    )



class MetricSummary(BaseModel):
    swing_speed_mph: Optional[float] = Field(default=None)
    ball_speed_mph: Optional[float] = Field(default=None)
    smash_factor: Optional[float] = Field(default=None)
    launch_angle_deg: Optional[float] = Field(default=None)
    tempo_ratio: Optional[float] = Field(default=None)
    spine_angle_deg: Optional[float] = Field(default=None)
    hip_rotation_deg: Optional[float] = Field(default=None)
    shoulder_rotation_deg: Optional[float] = Field(default=None)
    x_factor_deg: Optional[float] = Field(default=None)
    wrist_hinge_deg: Optional[float] = Field(default=None)

# ---------------------------------------------------------------------------
# Root response schema
# ---------------------------------------------------------------------------

class SwingAnalysisResponse(BaseModel):
    """
    Complete v2 biomechanical analysis returned by the Gemini pipeline.
    Stored verbatim as JSONB in swing_analyses.analysis_v2.
    """

    # --- Narrative prose (full-length, no truncation) ---
    executive_summary: str = Field(
        ...,
        description=(
            "Tour-level technical summary of the entire swing. Minimum 4 sentences. "
            "Cover kinematic sequence, energy transfer, and overall pattern."
        ),
    )
    swing_plane_analysis: str = Field(
        ...,
        description=(
            "Detailed description of the golfer's swing plane: one-plane vs two-plane, "
            "steepness/shallowness tendencies, and effect on attack angle."
        ),
    )
    kinematic_sequence_notes: str = Field(
        ...,
        description=(
            "Description of the kinematic sequence â€” the order in which body segments "
            "generate and transfer speed: pelvis â†’ thorax â†’ lead arm â†’ club. "
            "Note any sequence breakdowns."
        ),
    )

    # --- Structured arrays ---
    swing_highlights: list[HighlightItem] = Field(
        default_factory=list,
        description="Array of positive mechanical movements. Minimum 2 items.",
    )
    mechanical_deficiencies: list[DeficiencyItem] = Field(
        default_factory=list,
        description="Array of identified faults. Return empty list if none found.",
    )

    # --- Conditional sections ---
    putt_analytics: Optional[PuttAnalytics] = Field(
        default=None,
        description="Populated only when swing_category is 'putt'. Null otherwise.",
    )
    equipment_fitting: Optional[EquipmentFitting] = Field(
        default=None,
        description=(
            "Populated when launch monitor stats are available in context. "
            "Null if insufficient data."
        ),
    )

    # --- Metadata ---
    overall_skill_rating: Literal["beginner", "intermediate", "advanced", "tour-level"] = Field(
        ...,
        description="Holistic skill assessment based on the full swing evaluation.",
    )
    priority_focus_area: str = Field(
        ...,
        description=(
            "Single most impactful area for the golfer to practice next. "
            "One concise sentence referencing the highest-severity deficiency."
        ),
    )
    metric_summary: Optional[MetricSummary] = Field(default=None)

    # --- Runtime metadata (set by gemini_client, not by the model) ---
    model_used: Optional[str] = Field(default=None)
    analysis_mode: Optional[str] = Field(default=None)


# ---------------------------------------------------------------------------
# Request body schemas
# ---------------------------------------------------------------------------

class AnalyzeSwingRequest(BaseModel):
    """Incoming request to the /analyze-swing endpoint."""
    video_url: str = Field(..., description="Publicly accessible URL of the swing video.")
    swing_category: Literal["full_swing", "putt", "chip", "pitch", "bunker"] = Field(
        default="full_swing",
    )
    # Optional launch monitor context â€” if present, triggers equipment fitting
    swing_speed_mph: Optional[float] = None
    ball_speed_mph: Optional[float] = None
    smash_factor: Optional[float] = None
    spin_rate_rpm: Optional[int] = None
    launch_angle_deg: Optional[float] = None
    carry_yards: Optional[int] = None

