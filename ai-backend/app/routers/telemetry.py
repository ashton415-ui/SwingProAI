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
    BagClubInput,
    BagSessionInput,
    BagSessionResponse,
    ClubSessionSummary,
    LaunchMonitorInput,
    TelemetryResponse,
    VideoTelemetryInput,
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


# ---------------------------------------------------------------------------
# POST /api/telemetry/batch
# ---------------------------------------------------------------------------

@router.post("/batch", response_model=list[TelemetryResponse])
async def submit_batch(
    payload: list[LaunchMonitorInput],
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> list[TelemetryResponse]:
    """
    Process multiple launch monitor readings in a single request.
    Each item is validated and enriched identically to /launch-monitor.
    Returns one TelemetryResponse per input, preserving order.
    Intended for bulk imports (TrackMan CSV uploads, Arcados syncs, etc.).
    """
    _auth(x_internal_secret)

    if not payload:
        raise HTTPException(status_code=400, detail="batch payload must not be empty")
    if len(payload) > 100:
        raise HTTPException(status_code=400, detail="batch limit is 100 readings per request")

    from uuid import uuid4
    results: list[TelemetryResponse] = []
    for item in payload:
        results.append(
            _build_response(
                row_id=uuid4(),
                swing_speed=item.swing_speed_mph,
                ball_speed=item.ball_speed_mph,
                launch_angle=item.launch_angle_deg,
                spin_rate=item.spin_rate_rpm,
                carry=item.carry_yards,
                source="launch_monitor",
                club_id=item.club_id,
            )
        )

    logger.info("Batch telemetry: processed %d readings", len(results))
    return results


# ---------------------------------------------------------------------------
# POST /api/telemetry/bag-session
# ---------------------------------------------------------------------------

def _safe_avg(values: list[float]) -> float | None:
    filtered = [v for v in values if v is not None]
    return round(sum(filtered) / len(filtered), 3) if filtered else None


@router.post("/bag-session", response_model=BagSessionResponse)
async def submit_bag_session(
    payload: BagSessionInput,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> BagSessionResponse:
    """
    Process a full virtual bag session — one or more readings per club.
    Aggregates per-club averages, computes smash factor and speed categories,
    and identifies the best-smash and longest-carry clubs in the session.

    The Next.js gateway persists individual readings to Supabase separately;
    this endpoint handles the aggregation and labelling only.
    """
    _auth(x_internal_secret)

    summaries: list[ClubSessionSummary] = []
    for club in payload.clubs:
        smash = _compute_smash_factor(club.ball_speed_mph, club.swing_speed_mph)
        summary = ClubSessionSummary(
            club_id=club.club_id,
            club_type=club.club_type,
            reading_count=1,
            avg_swing_speed_mph=club.swing_speed_mph,
            avg_ball_speed_mph=club.ball_speed_mph,
            avg_smash_factor=smash,
            avg_carry_yards=float(club.carry_yards) if club.carry_yards is not None else None,
        )
        summaries.append(summary)

    # Identify stand-out clubs
    best_smash_club: UUID | None = None
    best_smash_val = -1.0
    longest_carry_club: UUID | None = None
    longest_carry_val = -1

    for s in summaries:
        if s.avg_smash_factor is not None and s.avg_smash_factor > best_smash_val:
            best_smash_val = s.avg_smash_factor
            best_smash_club = s.club_id
        if s.avg_carry_yards is not None and s.avg_carry_yards > longest_carry_val:
            longest_carry_val = int(s.avg_carry_yards)
            longest_carry_club = s.club_id

    all_speeds = [s.avg_swing_speed_mph for s in summaries if s.avg_swing_speed_mph is not None]
    bag_avg_speed = _safe_avg(all_speeds)  # type: ignore[arg-type]

    logger.info(
        "Bag session '%s': %d clubs, bag avg swing speed=%.1f mph",
        payload.session_label or "unnamed",
        len(summaries),
        bag_avg_speed or 0,
    )

    return BagSessionResponse(
        session_label=payload.session_label,
        total_clubs=len(summaries),
        club_summaries=summaries,
        best_smash_club_id=best_smash_club,
        longest_carry_club_id=longest_carry_club,
        bag_avg_swing_speed_mph=bag_avg_speed,
    )
