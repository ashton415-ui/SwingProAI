"""
ai-backend/app/routers/fitting.py
AI Club Fitting endpoint.
Rules engine gates the recommendation; Gemini generates the prose narrative.
"""
from __future__ import annotations

import logging
import os
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException

from ..models.equipment import FittingResponse, ShaftRecommendation

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai-fitting", tags=["fitting"])

_INTERNAL_SECRET = os.environ.get("AI_BACKEND_SECRET", "")
_GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")


def _auth(x_internal_secret: str | None) -> None:
    if _INTERNAL_SECRET and x_internal_secret != _INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")


# ---------------------------------------------------------------------------
# Shaft flex rules engine
# ---------------------------------------------------------------------------

# (min_speed, max_speed, recommended_flex, weight_range, description)
_FLEX_RULES = [
    (0,   74,  "L",  "40-50g",  "Ladies flex — swing speed below 75 mph"),
    (75,  84,  "A",  "50-60g",  "Senior/Amateur flex — 75-84 mph"),
    (85,  95,  "R",  "55-65g",  "Regular flex — 85-95 mph"),
    (96,  104, "S",  "65-75g",  "Stiff flex — 96-104 mph"),
    (105, 115, "X",  "70-80g",  "Extra Stiff — 105-115 mph"),
    (116, 999, "X",  "75-90g",  "Tour X / Custom profile — 116+ mph"),
]

_FLEX_ORDER = ["L", "A", "R", "SR", "S", "X"]


def _recommend_flex(swing_speed_mph: float) -> tuple[str, str, str]:
    """Returns (recommended_flex, weight_range, rule_triggered)."""
    for min_s, max_s, flex, weight, desc in _FLEX_RULES:
        if min_s <= swing_speed_mph <= max_s:
            return flex, weight, desc
    return "X", "75-90g", "Tour X — extreme swing speed"


def _flex_mismatch_urgency(current: str | None, recommended: str) -> tuple[bool, str]:
    """Returns (needs_upgrade, urgency)."""
    if not current:
        return False, "none"
    try:
        curr_idx = _FLEX_ORDER.index(current)
        rec_idx = _FLEX_ORDER.index(recommended)
    except ValueError:
        return False, "none"

    diff = rec_idx - curr_idx
    if diff == 0:
        return False, "none"
    if abs(diff) >= 2:
        return True, "immediate"
    return True, "recommended"


# ---------------------------------------------------------------------------
# Gemini narrative generator
# ---------------------------------------------------------------------------

async def _generate_gemini_narrative(
    swing_speed: float,
    current_flex: str | None,
    recommended_flex: str,
    rule: str,
    club_type: str | None,
) -> str | None:
    """Call Gemini to generate a personalized shaft fitting narrative."""
    if not _GEMINI_API_KEY:
        return None

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=_GEMINI_API_KEY)

        prompt = f"""You are an expert golf club fitter with 20 years of experience on Tour.
        
A golfer has the following profile:
- Swing speed: {swing_speed:.1f} mph
- Current shaft flex: {current_flex or 'Unknown'}
- Recommended shaft flex: {recommended_flex}
- Club type: {club_type or 'Driver'}
- Fitting rule triggered: {rule}

Write a 3-4 sentence personalized shaft fitting explanation. Be specific about:
1. Why their swing speed maps to the recommended flex
2. What they're losing (or risking) with their current shaft if it differs
3. The energy transfer benefit of switching to the correct flex
4. A specific shaft model recommendation (brand and model name)

Write in a direct, expert tone. No fluff. Output plain text only, no markdown."""

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt],
            config=types.GenerateContentConfig(
                temperature=0.4,
                max_output_tokens=300,
            ),
        )
        return response.text.strip()
    except Exception as exc:
        logger.warning("Gemini narrative generation failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# GET /api/ai-fitting/analyze/{swing_id}
# ---------------------------------------------------------------------------

@router.get("/analyze/{swing_id}", response_model=FittingResponse)
async def analyze_fitting(
    swing_id: UUID,
    # Query params passed by the Next.js gateway (avoids extra DB call from Python)
    swing_speed_mph: Optional[float] = None,
    current_shaft_flex: Optional[str] = None,
    club_type: Optional[str] = None,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> FittingResponse:
    """
    Pull swing velocity data, evaluate shaft flex against rules engine,
    generate Gemini prose narrative, and return fitting recommendation.

    Query params are supplied by the Next.js gateway which already has
    the Supabase data — avoids a redundant DB round-trip from Python.
    """
    _auth(x_internal_secret)

    if swing_speed_mph is None:
        return FittingResponse(
            swing_id=swing_id,
            swing_speed_mph=None,
            current_shaft_flex=current_shaft_flex,
            current_club_type=club_type,
            shaft_recommendation=None,
            needs_upgrade=False,
            upgrade_urgency="none",
            summary="Insufficient swing speed data for fitting analysis.",
            tier_required="birdie",
        )

    recommended_flex, weight_range, rule = _recommend_flex(swing_speed_mph)
    needs_upgrade, urgency = _flex_mismatch_urgency(current_shaft_flex, recommended_flex)

    # Generate Gemini narrative
    narrative = await _generate_gemini_narrative(
        swing_speed=swing_speed_mph,
        current_flex=current_shaft_flex,
        recommended_flex=recommended_flex,
        rule=rule,
        club_type=club_type,
    )

    # Confidence based on data quality
    confidence = "high" if swing_speed_mph and current_shaft_flex else "medium"

    recommendation = ShaftRecommendation(
        recommended_flex=recommended_flex,  # type: ignore[arg-type]
        recommended_weight_range=weight_range,
        confidence=confidence,  # type: ignore[arg-type]
        rule_triggered=rule,
        gemini_narrative=narrative,
    )

    if needs_upgrade and urgency == "immediate":
        summary = (
            f"Immediate shaft change recommended: your {current_shaft_flex} flex "
            f"is significantly mismatched to your {swing_speed_mph:.0f} mph swing speed."
        )
    elif needs_upgrade:
        summary = (
            f"Shaft upgrade recommended: switch from {current_shaft_flex} to "
            f"{recommended_flex} flex for your {swing_speed_mph:.0f} mph swing speed."
        )
    else:
        summary = (
            f"Your {current_shaft_flex or recommended_flex} flex is well-matched "
            f"to your {swing_speed_mph:.0f} mph swing speed."
        )

    return FittingResponse(
        swing_id=swing_id,
        swing_speed_mph=swing_speed_mph,
        current_shaft_flex=current_shaft_flex,
        current_club_type=club_type,
        shaft_recommendation=recommendation,
        needs_upgrade=needs_upgrade,
        upgrade_urgency=urgency,  # type: ignore[arg-type]
        summary=summary,
        tier_required="birdie",
    )
