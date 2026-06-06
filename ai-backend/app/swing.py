"""
ai-backend/routers/swing.py
FastAPI router — swing analysis endpoint.
Authenticates via Supabase JWT, runs Gemini analysis, persists result.
"""

from __future__ import annotations

import os
import logging
from uuid import UUID

import google.generativeai as genai
from fastapi import APIRouter, Depends, HTTPException, Header, status
from supabase import create_client, Client

from schemas import AnalyzeSwingRequest, SwingAnalysisResponse
from analyzer import analyze_swing

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["swing"])


# ---------------------------------------------------------------------------
# Supabase client (service role — bypasses RLS for server-side writes)
# ---------------------------------------------------------------------------

def get_supabase() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


# ---------------------------------------------------------------------------
# JWT auth dependency — validates Supabase Bearer token
# ---------------------------------------------------------------------------

async def get_current_user_id(
    authorization: str = Header(..., description="Bearer <supabase_jwt>"),
    supabase: Client = Depends(get_supabase),
) -> UUID:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid auth header")

    token = authorization.removeprefix("Bearer ").strip()

    try:
        user_response = supabase.auth.get_user(token)
        if not user_response.user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return UUID(user_response.user.id)
    except Exception as exc:
        logger.warning("Auth failure: %s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Auth failed") from exc


# ---------------------------------------------------------------------------
# POST /api/analyze-swing
# ---------------------------------------------------------------------------

@router.post(
    "/analyze-swing",
    response_model=SwingAnalysisResponse,
    summary="Run full Gemini biomechanical analysis on a golf swing video",
)
async def analyze_swing_endpoint(
    req: AnalyzeSwingRequest,
    user_id: UUID = Depends(get_current_user_id),
    supabase: Client = Depends(get_supabase),
) -> SwingAnalysisResponse:
    # Configure Gemini key (idempotent; safe to call per-request)
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])

    try:
        result = await analyze_swing(req)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini parsing error: {exc}",
        ) from exc

    # Persist to swing_analyses
    try:
        supabase.table("swing_analyses").insert({
            "user_id": str(user_id),
            "video_url": req.video_url,
            "swing_category": req.swing_category,
            "analysis_v2": result.model_dump(),
        }).execute()
    except Exception as exc:
        # Non-fatal — return the result even if persistence fails
        logger.error("Failed to persist swing analysis: %s", exc)

    return result
