#!/usr/bin/env python3
"""
Colorado Climate Hazard × Jobs — Data Processing Script
========================================================
Run this once (or whenever you add new tiffs) to generate the JSON
files that the dashboard loads.

Requirements:
    pip install rasterio geopandas numpy shapely

Usage:
    python process_tiffs.py \
        --geojson path/to/counties.geojson \
        --tiffs   path/to/Climate_Projections \
        --out     path/to/dashboard/data
"""

import argparse
import json
import re
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.mask import mask

# ---------------------------------------------------------------------------
# Sector outdoor-exposure weights
# Share of workers in each sector that have meaningful outdoor or
# heat/weather-sensitive exposure.  Adjust these to match your own
# research / literature review.
# ---------------------------------------------------------------------------
SECTOR_META = {
    "11.0_Agriculture_Forestry_Fishing_and_Hunting": {
        "label": "Agriculture, Forestry & Hunting",
        "short": "Agriculture",
        "outdoor_weight": 0.92,
        "hazards": ["heat", "extreme_heat", "wind", "precip"],
        "color": "#3B6D11",
    },
    "21.0_Mining_Quarrying_and_Oil_and_Gas_Extraction": {
        "label": "Mining, Quarrying & Oil/Gas",
        "short": "Mining & Oil/Gas",
        "outdoor_weight": 0.80,
        "hazards": ["heat", "extreme_heat", "wind"],
        "color": "#854F0B",
    },
    "23.0_Construction": {
        "label": "Construction",
        "short": "Construction",
        "outdoor_weight": 0.78,
        "hazards": ["heat", "extreme_heat", "wind", "precip"],
        "color": "#D85A30",
    },
    "48-49_Transportation_and_Warehousing": {
        "label": "Transportation & Warehousing",
        "short": "Transportation",
        "outdoor_weight": 0.55,
        "hazards": ["heat", "wind", "precip"],
        "color": "#185FA5",
    },
    "22.0_Utilities": {
        "label": "Utilities",
        "short": "Utilities",
        "outdoor_weight": 0.50,
        "hazards": ["heat", "extreme_heat", "wind"],
        "color": "#533AB7",
    },
    "31-33_Manufacturing": {
        "label": "Manufacturing",
        "short": "Manufacturing",
        "outdoor_weight": 0.30,
        "hazards": ["heat", "extreme_heat"],
        "color": "#0F6E56",
    },
    "72.0_Accommodation_and_Food_Services": {
        "label": "Accommodation & Food Services",
        "short": "Food & Hospitality",
        "outdoor_weight": 0.22,
        "hazards": ["heat", "wind", "precip"],
        "color": "#BA7517",
    },
    "71.0_Arts_Entertainment_and_Recreation": {
        "label": "Arts, Entertainment & Recreation",
        "short": "Arts & Recreation",
        "outdoor_weight": 0.45,
        "hazards": ["heat", "extreme_heat", "wind", "precip"],
        "color": "#993556",
    },
    "44-45_Retail_Trade": {
        "label": "Retail Trade",
        "short": "Retail",
        "outdoor_weight": 0.15,
        "hazards": ["heat"],
        "color": "#2563EB",
    },
    "62.0_Health_Care_and_Social_Assistance": {
        "label": "Health Care & Social Assistance",
        "short": "Health Care",
        "outdoor_weight": 0.08,
        "hazards": ["heat"],
        "color": "#7C3AED",
    },
    "61.0_Educational_Services": {
        "label": "Educational Services",
        "short": "Education",
        "outdoor_weight": 0.10,
        "hazards": ["heat", "wind"],
        "color": "#0891B2",
    },
    "54.0_Professional_Scientific_and_Technical_Services": {
        "label": "Professional, Scientific & Technical",
        "short": "Professional Services",
        "outdoor_weight": 0.08,
        "hazards": [],
        "color": "#6B7280",
    },
    "56.0_Administrative_and_Support_and_Waste_Management_and_Remediation_Services": {
        "label": "Admin, Support & Waste Management",
        "short": "Admin & Waste Mgmt",
        "outdoor_weight": 0.25,
        "hazards": ["heat", "wind"],
        "color": "#9CA3AF",
    },
    "42.0_Wholesale_Trade": {
        "label": "Wholesale Trade",
        "short": "Wholesale",
        "outdoor_weight": 0.20,
        "hazards": ["heat", "wind"],
        "color": "#A78BFA",
    },
    "52.0_Finance_and_Insurance": {
        "label": "Finance & Insurance",
        "short": "Finance",
        "outdoor_weight": 0.03,
        "hazards": [],
        "color": "#6B7280",
    },
    "53.0_Real_Estate_and_Rental_and_Leasing": {
        "label": "Real Estate & Rental",
        "short": "Real Estate",
        "outdoor_weight": 0.12,
        "hazards": [],
        "color": "#6B7280",
    },
    "51.0_Information": {
        "label": "Information",
        "short": "Information",
        "outdoor_weight": 0.05,
        "hazards": [],
        "color": "#6B7280",
    },
    "1.0_Federal_Government": {
        "label": "Federal Government",
        "short": "Federal Gov.",
        "outdoor_weight": 0.25,
        "hazards": ["heat", "wind"],
        "color": "#374151",
    },
    "2.0_State_Government": {
        "label": "State Government",
        "short": "State Gov.",
        "outdoor_weight": 0.20,
        "hazards": ["heat", "wind"],
        "color": "#4B5563",
    },
    "3.0_Local_Government": {
        "label": "Local Government",
        "short": "Local Gov.",
        "outdoor_weight": 0.30,
        "hazards": ["heat", "wind", "precip"],
        "color": "#6B7280",
    },
}

# ---------------------------------------------------------------------------
# Hazard catalogue — maps folder/filename patterns → metadata
# ---------------------------------------------------------------------------
HAZARD_CATALOG = [
    # WBGT (Wet Bulb Globe Temperature) — heat stress index °F
    {
        "id": "wbgt",
        "label": "Heat Stress (WBGT >80°F)",
        "unit": "additional days/yr",
        "description": "Change in days per year where Wet Bulb Globe Temperature exceeds 80°F. Directly affects outdoor workers.",
        "hazard_type": "heat",
        "affects": ["heat"],
        "scenarios": [
            {"gwl": "1.1", "file_pattern": "WBGTx80F/WBGTx80F_GWL11C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "1.5", "file_pattern": "WBGTx80F/WBGTx80F_GWL15C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.0", "file_pattern": "WBGTx80F/WBGTx80F_GWL20C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.5", "file_pattern": "WBGTx80F/WBGTx80F_GWL25C_minus_REF_absoule_change_v2.tif"},
        ],
        "reference": "WBGTx80F/WBGTx80F_REF_v2.tif",
    },
    # TX90F — days above 90°F
    {
        "id": "tx90f",
        "label": "Extreme Heat Days (>90°F)",
        "unit": "additional days/yr",
        "description": "Change in days per year with max temperature above 90°F.",
        "hazard_type": "extreme_heat",
        "affects": ["heat", "extreme_heat"],
        "scenarios": [
            {"gwl": "1.1", "file_pattern": "TX90F/TX90F_GWL11C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "1.5", "file_pattern": "TX90F/TX90F_GWL15C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.0", "file_pattern": "TX90F/TX90F_GWL20C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.5", "file_pattern": "TX90F/TX90F_GWL25C_minus_REF_absoule_change_v2.tif"},
        ],
        "reference": "TX90F/TX90F_REF_v2.tif",
    },
    # TX95F — days above 95°F
    {
        "id": "tx95f",
        "label": "Severe Heat Days (>95°F)",
        "unit": "additional days/yr",
        "description": "Change in days per year with max temperature above 95°F.",
        "hazard_type": "extreme_heat",
        "affects": ["heat", "extreme_heat"],
        "scenarios": [
            {"gwl": "1.1", "file_pattern": "TX95F/TX95F_GWL11C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "1.5", "file_pattern": "TX95F/TX95F_GWL15C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.0", "file_pattern": "TX95F/TX95F_GWL20C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.5", "file_pattern": "TX95F/TX95F_GWL25C_minus_REF_absoule_change_v2.tif"},
        ],
        "reference": "TX95F/TX95F_REF_v2.tif",
    },
    # TxN65F — nights above 65°F (warm nights)
    {
        "id": "txn65f",
        "label": "Warm Nights (>65°F)",
        "unit": "additional nights/yr",
        "description": "Change in nights per year where minimum temperature stays above 65°F. Affects worker recovery and sleep.",
        "hazard_type": "heat",
        "affects": ["heat"],
        "scenarios": [
            {"gwl": "1.1", "file_pattern": "TxN65F/TxN65F_GWL11C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "1.5", "file_pattern": "TxN65F/TxN65F_GWL15C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.0", "file_pattern": "TxN65F/TxN65F_GWL20C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.5", "file_pattern": "TxN65F/TxN65F_GWL25C_minus_REF_absoule_change_v2.tif"},
        ],
        "reference": "TxN65F/TxN65F_REF_v2.tif",
    },
    # Rx1day — max 1-day precipitation
    {
        "id": "rx1day",
        "label": "Extreme Precipitation (1-day max)",
        "unit": "mm change",
        "description": "Change in maximum 1-day precipitation. Affects flooding, infrastructure, and outdoor work disruption.",
        "hazard_type": "precip",
        "affects": ["precip"],
        "scenarios": [
            {"gwl": "1.1", "file_pattern": "Rx1day/Rx1day_GWL11C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "1.5", "file_pattern": "Rx1day/Rx1day_GWL15C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.0", "file_pattern": "Rx1day/Rx1day_GWL20C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.5", "file_pattern": "Rx1day/Rx1day_GWL25C_minus_REF_absoule_change_v2.tif"},
        ],
        "reference": "Rx1day/Rx1day_Reference_period_v2.tif",
    },
    # Rx5day — max 5-day precipitation
    {
        "id": "rx5day",
        "label": "Extreme Precipitation (5-day max)",
        "unit": "mm change",
        "description": "Change in maximum 5-day cumulative precipitation. Indicator for sustained flooding risk.",
        "hazard_type": "precip",
        "affects": ["precip"],
        "scenarios": [
            {"gwl": "1.1", "file_pattern": "Rx5day/Rx5day_GWL11C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "1.5", "file_pattern": "Rx5day/Rx5day_GWL15C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.0", "file_pattern": "Rx5day/Rx5day_GWL20C_minus_REF_absoule_change_v2.tif"},
            {"gwl": "2.5", "file_pattern": "Rx5day/Rx5day_GWL25C_minus_REF_absoule_change_v2.tif"},
        ],
        "reference": "Rx5day/Rx5day_Reference_period_v2.tif",
    },
    # Wind — 95th percentile wind speed, annual + seasonal
    {
        "id": "wind_ann",
        "label": "Extreme Wind (Annual 95th pct.)",
        "unit": "m/s",
        "description": "95th percentile annual maximum 10m wind speed. Affects outdoor operations, construction, and utilities.",
        "hazard_type": "wind",
        "affects": ["wind"],
        "scenarios": [
            {"gwl": "1.1", "file_pattern": "wspd10max_p95/95th_wind_+1.1_ANN_wspd10max_p95.tif"},
            {"gwl": "1.5", "file_pattern": "wspd10max_p95/95th_wind_+1.5_ANN_wspd10max_p95.tif"},
            {"gwl": "2.0", "file_pattern": "wspd10max_p95/95th_wind_+2_ANN_wspd10max_p95.tif"},
            {"gwl": "2.5", "file_pattern": "wspd10max_p95/95th_wind_+2.5_ANN_wspd10max_p95.tif"},
        ],
        "reference": "wspd10max_p95/95th_wind_hist_ANN_wspd10max_p95.tif",
    },
    # Hail
    {
        "id": "hail",
        "label": "Hail Days (MAMJJAS season)",
        "unit": "days/yr",
        "description": "Total hail days during MAMJJAS season. Affects agriculture, construction, and outdoor infrastructure.",
        "hazard_type": "wind",
        "affects": ["wind", "precip"],
        "scenarios": [
            {"gwl": "CTL",  "file_pattern": "HaildaysG_total/HaildaysG_total_CTL_MAMJJAS.tif"},
            {"gwl": "PGW",  "file_pattern": "HaildaysG_total/HaildaysG_total_PGW_MAMJJAS.tif"},
        ],
        "reference": "HaildaysG_total/HaildaysG_total_CTL_MAMJJAS.tif",
    },
]


# ---------------------------------------------------------------------------
# Zonal statistics helper
# ---------------------------------------------------------------------------
def zonal_mean(tif_path: Path, geometry) -> float | None:
    """Return the mean raster value within a geometry, or None if unavailable."""
    if not tif_path.exists():
        return None
    try:
        with rasterio.open(tif_path) as src:
            out, _ = mask(src, [geometry], crop=True, all_touched=True, nodata=np.nan)
            data = out.astype(float)
            nodata = src.nodata
            if nodata is not None:
                data[data == nodata] = np.nan
            valid = data[~np.isnan(data)]
            if valid.size == 0:
                return None
            return float(np.mean(valid))
    except Exception as exc:
        print(f"  Warning: could not read {tif_path.name}: {exc}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Main processing
# ---------------------------------------------------------------------------
def process(geojson_path: Path, tiff_root: Path, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading GeoJSON: {geojson_path}")
    gdf = gpd.read_file(geojson_path).to_crs("EPSG:4326")
    print(f"  {len(gdf)} features loaded")

    # ------------------------------------------------------------------
    # 1.  Build sector metadata file (one-time, static)
    # ------------------------------------------------------------------
    sector_out = []
    for key, meta in SECTOR_META.items():
        sector_out.append({"key": key, **meta})
    with open(out_dir / "sectors.json", "w") as f:
        json.dump(sector_out, f, indent=2)
    print("Wrote sectors.json")

    # ------------------------------------------------------------------
    # 2.  For each hazard, compute per-county zonal stats across all GWLs
    # ------------------------------------------------------------------
    manifest = []

    for hazard in HAZARD_CATALOG:
        hid = hazard["id"]
        print(f"\nProcessing hazard: {hid}")

        # reference period
        ref_path = tiff_root / hazard["reference"]
        ref_means = {}
        for _, row in gdf.iterrows():
            fips = str(row.get("FIPS", row.get("fips", "")))
            ref_means[fips] = zonal_mean(ref_path, row.geometry)

        # per-scenario
        scenarios_data = {}
        for sc in hazard["scenarios"]:
            gwl = sc["gwl"]
            tif_path = tiff_root / sc["file_pattern"]
            print(f"  GWL {gwl}: {tif_path.name}")
            vals = {}
            for _, row in gdf.iterrows():
                fips = str(row.get("FIPS", row.get("fips", "")))
                vals[fips] = zonal_mean(tif_path, row.geometry)
            scenarios_data[gwl] = vals

        # ------------------------------------------------------------------
        # 3.  Build per-county records with job exposure scores
        # ------------------------------------------------------------------
        counties = []
        for _, row in gdf.iterrows():
            props = row.to_dict()
            fips  = str(props.get("FIPS", props.get("fips", "")))
            name  = props.get("NAME", fips)

            # scenario values
            sc_vals = {gwl: (scenarios_data[gwl].get(fips)) for gwl in scenarios_data}

            # pick the 1.1°C (or CTL) value as "current"
            first_gwl = hazard["scenarios"][0]["gwl"]
            current_val = sc_vals.get(first_gwl)
            ref_val     = ref_means.get(fips)

            # job sector exposure scores
            sector_scores = {}
            for sec_key, sec_meta in SECTOR_META.items():
                jobs = props.get(sec_key)
                if jobs is None or (isinstance(jobs, float) and np.isnan(jobs)):
                    jobs = 0
                else:
                    jobs = float(jobs)

                # only score sectors that care about this hazard type
                relevant = hazard["hazard_type"] in sec_meta["hazards"]
                weight   = sec_meta["outdoor_weight"] if relevant else 0.0
                exposed  = jobs * weight
                score    = exposed * abs(current_val or 0)

                sector_scores[sec_key] = {
                    "jobs":     int(jobs),
                    "exposed":  round(exposed, 1),
                    "score":    round(score, 2),
                    "relevant": relevant,
                }

            total_jobs = props.get("10.0_Total_All_Sectors")
            if total_jobs is None or (isinstance(total_jobs, float) and np.isnan(total_jobs)):
                total_jobs = 0

            counties.append({
                "fips":        fips,
                "name":        name,
                "population":  props.get("POPULATION", 0),
                "total_jobs":  int(total_jobs),
                "ref_value":   round(ref_val, 3)     if ref_val     is not None else None,
                "current":     round(current_val, 3) if current_val is not None else None,
                "scenarios":   {gwl: (round(v, 3) if v is not None else None)
                                for gwl, v in sc_vals.items()},
                "sectors":     sector_scores,
            })

        # write hazard file
        payload = {
            "id":          hid,
            "label":       hazard["label"],
            "unit":        hazard["unit"],
            "description": hazard["description"],
            "hazard_type": hazard["hazard_type"],
            "gwl_labels": {sc["gwl"]: f"+{sc['gwl']}°C warming"
                           for sc in hazard["scenarios"]},
            "counties":    counties,
        }
        out_path = out_dir / f"{hid}.json"
        with open(out_path, "w") as f:
            json.dump(payload, f, separators=(",", ":"))
        kb = out_path.stat().st_size / 1024
        print(f"  Wrote {out_path.name}  ({kb:.0f} KB,  {len(counties)} counties)")
        manifest.append({
            "id":          hid,
            "label":       hazard["label"],
            "unit":        hazard["unit"],
            "description": hazard["description"],
            "hazard_type": hazard["hazard_type"],
            "file":        f"data/{hid}.json",
            "gwls":        [sc["gwl"] for sc in hazard["scenarios"]],
        })

    # ------------------------------------------------------------------
    # 4.  Write manifest
    # ------------------------------------------------------------------
    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nWrote manifest.json  ({len(manifest)} hazards)")
    print("\nDone! Drop the data/ folder next to index.html and open in a browser.")


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process climate tiffs → dashboard JSON")
    parser.add_argument("--geojson", required=True, help="Path to counties GeoJSON")
    parser.add_argument("--tiffs",   required=True, help="Root of Climate_Projections folder")
    parser.add_argument("--out",     default="data", help="Output directory (default: ./data)")
    args = parser.parse_args()

    process(
        geojson_path=Path(args.geojson),
        tiff_root=Path(args.tiffs),
        out_dir=Path(args.out),
    )
