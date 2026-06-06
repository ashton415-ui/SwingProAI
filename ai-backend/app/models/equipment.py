"""
ai-backend/app/models/equipment.py
Pydantic v2 models for equipment CRUD and telemetry input.
"""
from __future__ import annotations
from typing import Literal, Optional
from uuid import UUID
from pydantic import BaseModel, Field, model_validator


ClubType = Literal["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"]
ShaftFlex = Literal["L", "A", "R", "SR", "S", "X", "Putter"]
TelemetrySource = Literal["video_ai", "launch_monitor"]


# ---------------------------------------------------------------------------
# Equipment models
# ---------------------------------------------------------------------------

class EquipmentCreate(BaseModel):
    club_type: ClubType
    brand: Optional[str] = None
    model: Optional[str] = None
    shaft_flex: Optional[ShaftFlex] = None
    shaft_weight: Optional[int] = Field(default=None, ge=40, le=150)
    loft_deg: Optional[float] = Field(default=None, ge=0, le=70)
    custom_club: bool = False
    custom_brand: Optional[str] = None
    custom_model: Optional[str] = None
    custom_notes: Optional[str] = None
    is_primary: bool = False

    @model_validator(mode="after")
    def validate_custom_fields(self) -> "EquipmentCreate":
        if self.custom_club:
            if not self.custom_brand and not self.brand:
                raise ValueError("custom_club requires custom_brand or brand")
        return self


class EquipmentUpdate(BaseModel):
    club_type: Optional[ClubType] = None
    brand: Optional[str] = None
    model: Optional[str] = None
    shaft_flex: Optional[ShaftFlex] = None
    shaft_weight: Optional[int] = Field(default=None, ge=40, le=150)
    loft_deg: Optional[float] = Field(default=None, ge=0, le=70)
    custom_club: Optional[bool] = None
    custom_brand: Optional[str] = None
    custom_model: Optional[str] = None
    custom_notes: Optional[str] = None
    is_primary: Optional[bool] = None


class EquipmentResponse(BaseModel):
    id: UUID
    user_id: UUID
    club_type: str
    brand: Optional[str]
    model: Optional[str]
    shaft_flex: Optional[str]
    shaft_weight: Optional[int]
    loft_deg: Optional[float]
    custom_club: bool
    custom_brand: Optional[str]
    custom_model: Optional[str]
    custom_notes: Optional[str]
    is_primary: bool
    created_at: str
    updated_at: str

    @property
    def display_name(self) -> str:
        if self.custom_club:
            return f"{self.custom_brand or self.brand or 'Custom'} {self.custom_model or self.model or ''} ({self.club_type})"
        return f"{self.brand or ''} {self.model or ''} ({self.club_type})".strip()


# ---------------------------------------------------------------------------
# Telemetry models
# ---------------------------------------------------------------------------

class LaunchMonitorInput(BaseModel):
    """Manual launch monitor data entry."""
    swing_video_id: Optional[UUID] = None
    club_id: Optional[UUID] = None
    swing_speed_mph: float = Field(..., ge=20, le=200, description="Measured swing speed in mph")
    ball_speed_mph: float = Field(..., ge=20, le=250, description="Measured ball speed in mph")
    launch_angle_deg: Optional[float] = Field(default=None, ge=-10, le=60)
    spin_rate_rpm: Optional[int] = Field(default=None, ge=0, le=15000)
    carry_yards: Optional[int] = Field(default=None, ge=0, le=400)


class VideoTelemetryInput(BaseModel):
    """Video-based telemetry input — video processed separately."""
    swing_video_id: Optional[UUID] = None
    club_id: Optional[UUID] = None
    # These are populated by the video analysis pipeline
    swing_speed_mph: Optional[float] = Field(default=None, ge=20, le=200)
    ball_speed_mph: Optional[float] = Field(default=None, ge=20, le=250)
    launch_angle_deg: Optional[float] = Field(default=None, ge=-10, le=60)
    spin_rate_rpm: Optional[int] = Field(default=None, ge=0, le=15000)
    carry_yards: Optional[int] = Field(default=None, ge=0, le=400)


class TelemetryResponse(BaseModel):
    """Computed telemetry metrics returned to the client."""
    id: UUID
    swing_speed_mph: Optional[float]
    ball_speed_mph: Optional[float]
    smash_factor: Optional[float]
    launch_angle_deg: Optional[float]
    spin_rate_rpm: Optional[int]
    carry_yards: Optional[int]
    telemetry_source: str
    club_id: Optional[UUID]

    # Contextual labels
    smash_factor_rating: str = ""       # 'excellent', 'good', 'average', 'poor'
    swing_speed_category: str = ""      # 'tour', 'advanced', 'average', 'beginner'

    def model_post_init(self, __context) -> None:
        if self.smash_factor is not None:
            if self.smash_factor >= 1.48:
                self.smash_factor_rating = "excellent"
            elif self.smash_factor >= 1.44:
                self.smash_factor_rating = "good"
            elif self.smash_factor >= 1.38:
                self.smash_factor_rating = "average"
            else:
                self.smash_factor_rating = "poor"

        if self.swing_speed_mph is not None:
            if self.swing_speed_mph >= 110:
                self.swing_speed_category = "tour"
            elif self.swing_speed_mph >= 95:
                self.swing_speed_category = "advanced"
            elif self.swing_speed_mph >= 80:
                self.swing_speed_category = "average"
            else:
                self.swing_speed_category = "beginner"


# ---------------------------------------------------------------------------
# Fitting models
# ---------------------------------------------------------------------------

class ShaftRecommendation(BaseModel):
    recommended_flex: ShaftFlex
    recommended_weight_range: str          # e.g. "65-75g"
    confidence: Literal["high", "medium", "low"]
    rule_triggered: str                    # human-readable rule that fired
    gemini_narrative: Optional[str] = None # Gemini prose explanation


class FittingResponse(BaseModel):
    swing_id: UUID
    swing_speed_mph: Optional[float]
    current_shaft_flex: Optional[str]
    current_club_type: Optional[str]
    shaft_recommendation: Optional[ShaftRecommendation]
    needs_upgrade: bool                    # True if current flex is wrong
    upgrade_urgency: Literal["immediate", "recommended", "optional", "none"]
    summary: str                           # One-line summary for UI
    tier_required: Literal["birdie", "eagle"]  # Min tier to see full details
