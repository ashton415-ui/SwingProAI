"""
ai-backend/app/routers/equipment.py
Equipment catalog API — brand/model dropdowns and full catalog access.
Read-only; no auth required (catalog data is public).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..data.equipment_catalog import (
    CLUB_TYPES,
    get_all_brands,
    get_models_for_brand_and_type,
    EQUIPMENT_CATALOG,
)

router = APIRouter(prefix="/api/equipment", tags=["equipment"])


@router.get("/catalog/brands", response_model=list[str])
def list_brands() -> list[str]:
    """Return all supported manufacturer brands in display order."""
    return get_all_brands()


@router.get("/catalog/club-types", response_model=list[str])
def list_club_types() -> list[str]:
    """Return all club types in bag order (Driver → Putter)."""
    return CLUB_TYPES


@router.get("/catalog/models")
def list_models(
    brand: str = Query(..., description="Manufacturer brand, e.g. 'TaylorMade'"),
    club_type: str = Query(..., description="Club type, e.g. 'Driver'"),
) -> list[dict]:
    """
    Return available models for a brand + club type combination.
    Used by the VirtualBag add-club form to populate cascading dropdowns.
    """
    if brand not in EQUIPMENT_CATALOG:
        raise HTTPException(status_code=404, detail=f"Brand '{brand}' not found in catalog")
    if club_type not in CLUB_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid club_type '{club_type}'. Must be one of: {', '.join(CLUB_TYPES)}",
        )
    return get_models_for_brand_and_type(brand, club_type)


@router.get("/catalog")
def full_catalog() -> dict:
    """
    Return the complete equipment catalog keyed by brand → club_type → models.
    Useful for client-side caching; response is ~50 KB.
    """
    return EQUIPMENT_CATALOG
