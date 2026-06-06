"""
SwingProAI — AI biomechanics FastAPI service.

Called server-side ONLY by the Next.js gateway (never from the client). The
gateway resolves the user's tier → analysis_mode and forwards the video; this
service runs the Gemini structured audit and returns SwingAnalysisResponse.

Run: uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import base64
import os
from typing import Literal, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .schemas import SwingAnalysisResponse
from .gemini_client import analyze_swing

app = FastAPI(title="SwingProAI AI Biomechanics", version="1.0.0")

AnalysisMode = Literal["basic", "advanced", "ultra"]

# Shared secret the Next.js gateway sends; keeps this service private.
_INTERNAL_SECRET = os.environ.get("AI_BACKEND_SECRET", "")


class AnalyzeRequest(BaseModel):
    """Gateway → FastAPI contract. Video is base64 (matches the existing Next route)."""

    video_base64: str = Field(..., description="Base64-encoded video bytes.")
    mime_type: str = Field("video/mp4")
    analysis_mode: AnalysisMode = "ultra"
    user_context: Optional[str] = Field(
        None, description="Optional golfer notes (handicap, club, known issues)."
    )


class AnalyzeEnvelope(BaseModel):
    message: str
    data: SwingAnalysisResponse


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/v1/analyze", response_model=AnalyzeEnvelope)
def analyze(
    req: AnalyzeRequest,
    x_internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
) -> AnalyzeEnvelope:
    # Service-to-service auth: only the gateway may call this.
    if _INTERNAL_SECRET and x_internal_secret != _INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="unauthorized")

    if req.analysis_mode == "basic":
        # Basic tier never hits the paid model — the gateway handles the mock.
        raise HTTPException(status_code=400, detail="basic mode is handled by the gateway")

    try:
        video_bytes = base64.b64decode(req.video_base64, validate=True)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="video_base64 is not valid base64")

    if not video_bytes:
        raise HTTPException(status_code=400, detail="empty video payload")

    try:
        result = analyze_swing(
            video_bytes=video_bytes,
            mime_type=req.mime_type,
            analysis_mode=req.analysis_mode,
            user_context=req.user_context,
        )
    except RuntimeError as exc:  # config error (e.g. missing key)
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:  # unparseable model output
        raise HTTPException(status_code=502, detail=str(exc))

    return AnalyzeEnvelope(message="analysis complete", data=result)
