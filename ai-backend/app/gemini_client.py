"""
SwingProAI â€” Gemini structured-analysis client (new google-genai SDK).

Uses `google.genai` (the unified SDK) with native Pydantic structured output:
the model is handed `SwingAnalysisResponse` as `response_schema` and returns a
parsed instance â€” no brittle JSON-string post-processing.

Env:
  GEMINI_API_KEY        required
  GEMINI_ULTRA_MODEL    default "gemini-2.5-pro"   (Eagle / Coach Pro)
  GEMINI_ADVANCED_MODEL default "gemini-2.5-flash" (Birdie / Coach Starter)
"""
from __future__ import annotations

import os
from functools import lru_cache

from google import genai
from google.genai import types

from .schemas import SwingAnalysisResponse
from .prompts import ELITE_SYSTEM_INSTRUCTION, depth_directive

# Inline data is fine for short clips; larger uploads go through the Files API.
INLINE_MAX_BYTES = 18 * 1024 * 1024  # ~18MB decoded, matches Gemini inline limit


@lru_cache(maxsize=1)
def get_client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    return genai.Client(api_key=api_key)


def model_for_mode(analysis_mode: str) -> str:
    if analysis_mode == "ultra":
        return os.environ.get("GEMINI_ULTRA_MODEL", "gemini-2.5-pro")
    # advanced (and any non-ultra paid mode)
    return os.environ.get("GEMINI_ADVANCED_MODEL", "gemini-2.5-flash")


def _video_part(client: genai.Client, video_bytes: bytes, mime_type: str):
    """Inline small clips; upload larger ones via the Files API and reference them."""
    if len(video_bytes) <= INLINE_MAX_BYTES:
        return types.Part.from_bytes(data=video_bytes, mime_type=mime_type)

    uploaded = client.files.upload(
        file=video_bytes,
        config=types.UploadFileConfig(mime_type=mime_type),
    )
    return uploaded


def analyze_swing(
    video_bytes: bytes,
    mime_type: str,
    analysis_mode: str = "ultra",
    user_context: str | None = None,
) -> SwingAnalysisResponse:
    """Run the elite biomechanical audit and return a parsed, validated response.

    Raises RuntimeError on a missing key and ValueError if the model returns
    something that can't be parsed against the schema.
    """
    client = get_client()
    model = model_for_mode(analysis_mode)

    instruction_parts = [depth_directive(analysis_mode)]
    if user_context:
        instruction_parts.append(f"GOLFER CONTEXT: {user_context}")
    instruction_parts.append(
        "Analyze the attached swing video and return the structured audit."
    )

    contents = [
        _video_part(client, video_bytes, mime_type),
        "\n".join(instruction_parts),
    ]

    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=ELITE_SYSTEM_INSTRUCTION,
            response_mime_type="application/json",
            response_schema=SwingAnalysisResponse,
            temperature=0.3,
            max_output_tokens=65535,
        ),
    )

    # `.parsed` is a SwingAnalysisResponse when schema parsing succeeds.
    result = response.parsed
    if not isinstance(result, SwingAnalysisResponse):
        # Fall back to validating the raw text, surfacing a clear error if malformed.
        raw = getattr(response, "text", "") or ""
        try:
            result = SwingAnalysisResponse.model_validate_json(raw)
        except Exception as exc:  # noqa: BLE001 - convert to a clean API error upstream
            raise ValueError(f"Model returned unparseable analysis: {exc}") from exc

    result.model_used = model
    result.analysis_mode = analysis_mode
    return result

