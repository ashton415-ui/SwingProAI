"""
ai-backend/app/data/equipment_catalog.py
Pre-loaded equipment catalog for cascading Brand → Model dropdowns.
Covers top 6 manufacturers × 6 club types × 3 popular models each.
Used by the frontend dropdown API and the fitting engine for spec lookups.
"""

from __future__ import annotations
from typing import TypedDict


class ClubModel(TypedDict):
    model: str
    loft_options: list[float]          # Common loft configurations
    shaft_flex_options: list[str]      # Available flex options
    notes: str                         # Brief descriptor


EQUIPMENT_CATALOG: dict[str, dict[str, list[ClubModel]]] = {
    "TaylorMade": {
        "Driver": [
            {"model": "Qi10 LS", "loft_options": [8.0, 9.0, 10.5], "shaft_flex_options": ["R", "S", "X"], "notes": "Low spin, tour-preferred"},
            {"model": "Qi10", "loft_options": [9.0, 10.5, 12.0], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Max forgiveness, high MOI"},
            {"model": "Stealth 2 HD", "loft_options": [9.0, 10.5, 12.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Draw bias, carbon face"},
        ],
        "Wood": [
            {"model": "Qi10 Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["R", "S", "X"], "notes": "High launch fairway"},
            {"model": "Stealth 2 Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Carbon face, easy launch"},
            {"model": "Stealth 2 HD Fairway", "loft_options": [16.0, 19.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Draw-biased fairway"},
        ],
        "Hybrid": [
            {"model": "Qi10 Rescue", "loft_options": [19.0, 22.0, 25.0, 28.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Ultra-forgiving rescue"},
            {"model": "Stealth 2 Rescue", "loft_options": [19.0, 22.0, 25.0, 28.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Carbon crown hybrid"},
            {"model": "SIM2 Max Rescue", "loft_options": [20.0, 23.0, 26.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Max forgiveness hybrid"},
        ],
        "Iron": [
            {"model": "Qi10 Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Cap-back design, 4-PW"},
            {"model": "Stealth 2 HD Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S"], "notes": "Draw-biased, super game improvement"},
            {"model": "P790 Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Players distance, forged feel"},
        ],
        "Wedge": [
            {"model": "MG4 Wedge", "loft_options": [46.0, 50.0, 52.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Raw face, SpinFace technology"},
            {"model": "Hi-Toe 4 Wedge", "loft_options": [58.0, 60.0, 64.0], "shaft_flex_options": ["S"], "notes": "Open-face versatility"},
            {"model": "Milled Grind 4 Wedge", "loft_options": [50.0, 52.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Tour-milled grooves"},
        ],
        "Putter": [
            {"model": "Spider Tour X", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Mallet, high MOI"},
            {"model": "TP Hydro Blast Dupage", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Blade, plumber's neck"},
            {"model": "Truss TB1", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Center-shafted stability"},
        ],
    },

    "Callaway": {
        "Driver": [
            {"model": "Paradym Ai Smoke MAX", "loft_options": [9.0, 10.5, 12.0], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "AI-designed face, max forgiveness"},
            {"model": "Paradym Ai Smoke Triple Diamond", "loft_options": [8.0, 9.0, 10.5], "shaft_flex_options": ["S", "X"], "notes": "Low spin, tour preferred"},
            {"model": "Paradym Ai Smoke MAX D", "loft_options": [9.0, 10.5], "shaft_flex_options": ["A", "R", "S"], "notes": "Draw bias, Ai face"},
        ],
        "Wood": [
            {"model": "Paradym Ai Smoke Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["R", "S", "X"], "notes": "Ai-designed face fairway"},
            {"model": "Paradym Triple Diamond Fairway", "loft_options": [15.0, 18.0], "shaft_flex_options": ["S", "X"], "notes": "Low spin fairway"},
            {"model": "Rogue ST Max Fairway", "loft_options": [16.0, 19.0, 22.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Jailbreak technology"},
        ],
        "Hybrid": [
            {"model": "Paradym Ai Smoke Hybrid", "loft_options": [19.0, 22.0, 25.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Ai face hybrid"},
            {"model": "Apex Pro Hybrid", "loft_options": [20.0, 23.0, 26.0], "shaft_flex_options": ["R", "S", "X"], "notes": "Players hybrid, forged"},
            {"model": "Rogue ST Max OS Hybrid", "loft_options": [19.0, 22.0, 25.0, 28.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Oversized, super-forgiving"},
        ],
        "Iron": [
            {"model": "Paradym Ai Smoke Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Ai face insert, 4-PW"},
            {"model": "Apex CB 24 Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Cavity-back players iron"},
            {"model": "Rogue ST MAX OS Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S"], "notes": "Oversized, game improvement"},
        ],
        "Wedge": [
            {"model": "Jaws Raw Wedge", "loft_options": [48.0, 50.0, 52.0, 54.0, 56.0, 58.0, 60.0, 64.0], "shaft_flex_options": ["S", "X"], "notes": "Raw face, aggressive grooves"},
            {"model": "PM Grind 4 Wedge", "loft_options": [60.0, 64.0], "shaft_flex_options": ["S"], "notes": "Phil Mickelson design, hi-toe"},
            {"model": "Mack Daddy CB Wedge", "loft_options": [48.0, 52.0, 56.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Cavity-back wedge, forgiving"},
        ],
        "Putter": [
            {"model": "Odyssey Ai-ONE Milled Eight", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Ai-milled face mallet"},
            {"model": "Odyssey White Hot OG #7", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Classic mallet, White Hot insert"},
            {"model": "Odyssey Tri-Hot 5K One", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Blade, heel-toe weighted"},
        ],
    },

    "Titleist": {
        "Driver": [
            {"model": "GT2 Driver", "loft_options": [8.0, 9.0, 10.0, 11.0], "shaft_flex_options": ["R", "S", "X"], "notes": "Balanced spin and forgiveness"},
            {"model": "GT3 Driver", "loft_options": [8.0, 9.0, 10.0], "shaft_flex_options": ["S", "X"], "notes": "Low spin, tour shape"},
            {"model": "GT4 Driver", "loft_options": [8.0, 9.0], "shaft_flex_options": ["X"], "notes": "Ultra-low spin, tour only"},
        ],
        "Wood": [
            {"model": "GT2 Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["R", "S", "X"], "notes": "High launch, versatile"},
            {"model": "GT3 Fairway", "loft_options": [15.0, 18.0], "shaft_flex_options": ["S", "X"], "notes": "Low spin fairway, tour"},
            {"model": "TSR2 Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Previous gen, proven performer"},
        ],
        "Hybrid": [
            {"model": "GT2 Hybrid", "loft_options": [17.0, 20.0, 23.0, 26.0], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "High launch, forgiving"},
            {"model": "TSR2 Hybrid", "loft_options": [18.0, 21.0, 24.0, 27.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Speed and forgiveness"},
            {"model": "818 H1 Hybrid", "loft_options": [19.0, 22.0, 25.0], "shaft_flex_options": ["R", "S"], "notes": "Adjustable, proven design"},
        ],
        "Iron": [
            {"model": "T150 Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Players iron, compact blade"},
            {"model": "T200 Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Players distance iron"},
            {"model": "T350 Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S"], "notes": "Game improvement, max distance"},
        ],
        "Wedge": [
            {"model": "Vokey SM10 Wedge", "loft_options": [46.0, 48.0, 50.0, 52.0, 54.0, 56.0, 58.0, 60.0, 62.0], "shaft_flex_options": ["S", "X"], "notes": "Tour standard, multiple grinds"},
            {"model": "Vokey WedgeWorks SM10", "loft_options": [54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Custom shop, raw finish"},
            {"model": "Vokey SM9 Wedge", "loft_options": [46.0, 50.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Previous gen, still tour-used"},
        ],
        "Putter": [
            {"model": "Scotty Cameron Special Select Newport 2", "loft_options": [3.5], "shaft_flex_options": ["Putter"], "notes": "Iconic blade, milled 303SS"},
            {"model": "Scotty Cameron Phantom X 5.5", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Mallet, high MOI"},
            {"model": "Scotty Cameron Super Select GoLo 5", "loft_options": [3.5], "shaft_flex_options": ["Putter"], "notes": "Mid-mallet, face-balanced"},
        ],
    },

    "Ping": {
        "Driver": [
            {"model": "G430 MAX 10K", "loft_options": [9.0, 10.5], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Highest MOI driver ever made"},
            {"model": "G430 LST", "loft_options": [9.0, 10.5], "shaft_flex_options": ["S", "X"], "notes": "Low spin, tour preferred"},
            {"model": "G430 SFT", "loft_options": [10.5], "shaft_flex_options": ["A", "R", "S"], "notes": "Straight flight, draw bias"},
        ],
        "Wood": [
            {"model": "G430 MAX Fairway", "loft_options": [14.5, 17.5, 20.5], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Max forgiveness fairway"},
            {"model": "G430 LST Fairway", "loft_options": [14.5, 17.5], "shaft_flex_options": ["S", "X"], "notes": "Low spin fairway"},
            {"model": "G430 SFT Fairway", "loft_options": [16.0, 19.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Straight flight fairway"},
        ],
        "Hybrid": [
            {"model": "G430 Hybrid", "loft_options": [17.0, 19.0, 22.0, 26.0, 30.0, 34.0], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "6 loft options, ultra-versatile"},
            {"model": "G425 Hybrid", "loft_options": [17.0, 19.0, 22.0, 26.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Proven performance hybrid"},
            {"model": "G410 Hybrid", "loft_options": [17.0, 19.0, 22.0, 26.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Classic Ping hybrid design"},
        ],
        "Iron": [
            {"model": "G430 Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Game improvement, Arccos ready"},
            {"model": "i530 Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Players distance, forged feel"},
            {"model": "Blueprint S Irons", "loft_options": [], "shaft_flex_options": ["S", "X"], "notes": "Tour blade, full forged"},
        ],
        "Wedge": [
            {"model": "Glide 4.0 Wedge", "loft_options": [46.0, 50.0, 52.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Face-forward design, versatile"},
            {"model": "ChipR", "loft_options": [38.0], "shaft_flex_options": ["R", "S"], "notes": "Specialty chipper, confidence around greens"},
            {"model": "Glide Forged Pro Wedge", "loft_options": [50.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Tour-level forged wedge"},
        ],
        "Putter": [
            {"model": "PLD Milled Anser", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Precision milled blade, heritage design"},
            {"model": "PLD Milled DS72", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Double-bend mallet"},
            {"model": "Sigma 2 Tyne 4", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Adjustable length, mallet"},
        ],
    },

    "Cobra": {
        "Driver": [
            {"model": "Darkspeed X", "loft_options": [9.0, 10.5, 12.0], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "PWR-COR technology, max speed"},
            {"model": "Darkspeed LS", "loft_options": [8.0, 9.0, 10.5], "shaft_flex_options": ["S", "X"], "notes": "Low spin, tour shape"},
            {"model": "Darkspeed MAX", "loft_options": [9.0, 10.5, 12.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Max forgiveness, high launch"},
        ],
        "Wood": [
            {"model": "Darkspeed X Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["R", "S", "X"], "notes": "PWR-COR fairway"},
            {"model": "Aerojet Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Aerodynamic fairway"},
            {"model": "King LTDx Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["A", "R", "S"], "notes": "H.O.T. face technology"},
        ],
        "Hybrid": [
            {"model": "Darkspeed X Hybrid", "loft_options": [19.0, 22.0, 25.0, 28.0"], "shaft_flex_options": ["A", "R", "S"], "notes": "PWR-COR hybrid"},
            {"model": "Aerojet Hybrid", "loft_options": [19.0, 22.0, 25.0, 28.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Aerodynamic, easy launch"},
            {"model": "King LTDx Hybrid", "loft_options": [20.0, 23.0, 26.0], "shaft_flex_options": ["A", "R", "S"], "notes": "H.O.T. face hybrid"},
        ],
        "Iron": [
            {"model": "Darkspeed X Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "PWR-COR technology irons"},
            {"model": "King Forged TEC Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Forged players distance"},
            {"model": "Air X Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S"], "notes": "Ultra-lightweight, senior friendly"},
        ],
        "Wedge": [
            {"model": "King MIM Wedge", "loft_options": [50.0, 52.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Metal injection moulded, precise"},
            {"model": "King Cobra Snakebite Wedge", "lolt_options": [50.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S"], "notes": "Snakebite groove pattern"},
            {"model": "King Forged TEC Wedge", "loft_options": [48.0, 52.0, 56.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Forged precision wedge"},
        ],
        "Putter": [
            {"model": "King 3D Printed Grandsport-35", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "3D printed lattice, mallet"},
            {"model": "King Vintage MB Putter", "loft_options": [3.5], "shaft_flex_options": ["Putter"], "notes": "Classic blade, milled"},
            {"model": "King Agera Putter", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "High MOI mallet"},
        ],
    },

    "Mizuno": {
        "Driver": [
            {"model": "ST-Z 230 Driver", "loft_options": [8.5, 9.5, 10.5], "shaft_flex_options": ["R", "S", "X"], "notes": "Wave sole, low spin"},
            {"model": "ST-X 230 Driver", "loft_options": [9.5, 10.5", 12.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Max forgiveness, high launch"},
            {"model": "ST-G 220 Driver", "loft_options": [9.5, 10.5], "shaft_flex_options": ["R", "S"], "notes": "Adjustable, balanced performance"},
        ],
        "Wood": [
            {"model": "ST-Z 230 Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["R", "S", "X"], "notes": "Wave sole fairway"},
            {"model": "ST-X 230 Fairway", "loft_options": [15.0, 18.0, 21.0"], "shaft_flex_options": ["A", "R", "S"], "notes": "High launch fairway"},
            {"model": "ST-G 220 Fairway", "loft_options": [15.0, 18.0, 21.0], "shaft_flex_options": ["R", "S"], "notes": "Adjustable fairway"},
        ],
        "Hybrid": [
            {"model": "CLK Hybrid", "loft_options": [16.0, 19.0, 22.0, 25.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Smooth launch, forgiving"},
            {"model": "ST-Z 230 Hybrid", "loft_options": [20.0, 23.0", 26.0], "shaft_flex_options": ["R", "S"], "notes": "Low spin hybrid"},
            {"model": "JPX 923 Hybrid", "loft_options": [20.0, 23.0, 26.0], "shaft_flex_options": ["A", "R", "S"], "notes": "Grain Flow Forged feel"},
        ],
        "Iron": [
            {"model": "JPX 923 Forged Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Grain Flow Forged, buttery feel"},
            {"model": "JPX 923 Hot Metal Irons", "loft_options": [], "shaft_flex_options": ["A", "R", "S", "X"], "notes": "Chromoly, maximum distance"},
            {"model": "MP-225 Irons", "loft_options": [], "shaft_flex_options": ["R", "S", "X"], "notes": "Muscle-back players iron"},
        ],
        "Wedge": [
            {"model": "T24 Wedge", "loft_options": [46.0, 48.0, 50.0, 52.0, 54.0, 56.0, 58.0, 60.0, 62.0], "shaft_flex_options": ["S", "X"], "notes": "Grain Flow Forged, precision grooves"},
            {"model": "S23 Wedge", "loft_options": [50.0, 52.0, 54.0, 56.0, 58.0, 60.0], "shaft_flex_options": ["S", "X"], "notes": "Copper underlay, raw face"},
            {"model": "ES21 Wedge", "loft_options": [50.0, 54.0, 58.0], "shaft_flex_options": ["R", "S"], "notes": "Expeller groove, consistent spin"},
        ],
        "Putter": [
            {"model": "M-Craft OMOI 02 Putter", "loft_options": [3.5], "shaft_flex_options": ["Putter"], "notes": "Tungsten weighted blade"},
            {"model": "M-Craft OMOI 05 Putter", "loft_options": [3.0], "shaft_flex_options": ["Putter"], "notes": "Mallet, high MOI"},
            {"model": "M-Craft Type I Putter", "loft_options": [3.5], "shaft_flex_options": ["Putter"], "notes": "Classic blade, pure milled"},
        ],
    },
}

# Flat list of brands for dropdown
BRANDS = list(EQUIPMENT_CATALOG.keys())

# Club types in display order
CLUB_TYPES = ["Driver", "Wood", "Hybrid", "Iron", "Wedge", "Putter"]


def get_models_for_brand_and_type(brand: str, club_type: str) -> list[ClubModel]:
    """Return models for a given brand and club type."""
    return EQUIPMENT_CATALOG.get(brand, {}).get(club_type, [])


def get_all_brands() -> list[str]:
    return BRANDS


def get_club_types() -> list[str]:
    return CLUB_TYPES
