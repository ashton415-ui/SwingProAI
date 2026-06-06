"""
ai-backend/app/routers/telemetry.py
Telemetry endpoints — manual launch monitor input and video-based analysis.
"""
from __future__ import annotations

import logging
import os
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException

from ..models.equipment import (
    LaunchMonitorInput,
    VideoTelemetryInput,
    TelemetryResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])

_INTERNAL_SECRET = os.environ.get("AI_BACKEND_SECRET", "")


def _auth(x_internal_secret: str | None) -> None:
    if _INTERNAL_SECRET and x_internal_secret != _INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")


def _compute_smash_factor(ball_speed: float | None, swing_speed: float | None) -> float | None:
    if ball_speed and swing_speed and swing_speed > 0:
        return round(ball_speed / swing_speed, 3)
    return None


def _build_response(
    row_id: UUID,
    swing_speed: float | None,
    ball_speed: float | None,
    launch_angle: float | None,
    spin_rate: int | None,
    carry: int | None,
    source: str,
    club_id: UUID | None,
) -> TelemetryResponse:
    smash = _compute_smash_factor(ball_speed, swing_speed)
    resp = TelemetryResponse(
        id=row_id,
        swing_speed_mph=swing_speed,
        ball_speed_mph=ball_speed,
        smash_factor=smash,
        launch_angle_deg=launch_angle,
        spin_rate_rpm=spin_rate,
        carry_yards=carry,
        telemetry_source=source,
        club_id=club_id,
    )
    return resp


# ---------------------------------------------------------------------------
# POST /api/telemetry/launch-monitor
# ---------------------------------------------------------------------------

@router.post("/launch-monitor", response_model=TelemetryResponse)
async def submit_launch_monitor(
    payload: LaunchMonitorInput,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> TelemetryResponse:
    """
    Accept manual launch monitor inputs (swing_speed, ball_speed, etc.),
    compute smash_factor automatically, persist to swing_telemetry, and return metrics.
    DB write is handled by the Next.js gateway using the Supabase client;
    this endpoint computes and validates only.
    """
    _auth(x_internal_secret)

    smash = _compute_smash_factor(payload.ball_speed_mph, payload.swing_speed_mph)

    logger.info(
        "Launch monitor input: swing=%.1f mph, ball=%.1f mph, smash=%.3f",
        payload.swing_speed_mph,
        payload.ball_speed_mph,
        smash or 0,
    )

    # Return computed metrics — the Next.js gateway persists to Supabase
    from uuid import uuid4
    return _build_response(
        row_id=uuid4(),  # Ephemeral ID; gateway uses the real Supabase-generated ID
        swing_speed=payload.swing_speed_mph,
        ball_speed=payload.ball_speed_mph,
        launch_angle=payload.launch_angle_deg,
        spin_rate=payload.spin_rate_rpm,
        carry=payload.carry_yards,
        source="launch_monitor",
        club_id=payload.club_id,
    )


# ---------------------------------------------------------------------------
# POST /api/telemetry/video-analysis
# ---------------------------------------------------------------------------

@router.post("/video-analysis", response_model=TelemetryResponse)
async def submit_video_analysis(
    payload: VideoTelemetryInput,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> TelemetryResponse:
    """
    Accept video-extracted telemetry (populated by the Gemini analysis pipeline
    via metric_summary). Computes smash_factor and returns enriched metrics.

    OpenCV pixel-to-MPH velocity tracking integration point:
    When the CV pipeline is ready, inject swing_speed_mph and ball_speed_mph
    here from the optical flow analysis result before calling _build_response.
    """
    _auth(x_internal_secret)

    # ── OpenCV / optical-flow integration placeholder ──────────────────────
    # Future: replace these with actual CV-extracted values
    # from the SwingCaptureController pipeline.
    #
    # cv_result = await run_optical_flow_analysis(payload.video_bytes)
    # swing_speed = cv_result.clubhead_speed_mph
    # ball_speed = cv_result.ball_speed_mph
    # ───────────────────────────────────────────────────────────────────────

    swing_speed = payload.swing_speed_mph   # Populated by Gemini metric_summary
    ball_speed = payload.ball_speed_mph

    smash = _compute_smash_factor(ball_speed, swing_speed)

    logger.info(
        "Video telemetry: swing=%s mph, ball=%s mph, smash=%s",
        swing_speed, ball_speed, smash,
    )

    from uuid import uuid4
    return _build_response(
        row_id=uuid4(),
        swing_speed=swing_speed,
        ball_speed=ball_speed,
        launch_angle=payload.launch_angle_deg,
        spin_rate=payload.spin_rate_rpm,
        carry=payload.carry_yards,
        source="video_ai",
        club_id=payload.club_id,
    )
