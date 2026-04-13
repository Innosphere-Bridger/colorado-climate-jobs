#!/usr/bin/env python3
"""
Colorado Climate Hazard × Jobs — Data Processing Script
========================================================
Generates two outputs per hazard:
  {hazard}.json         — per-county zonal stats + job exposure scores
  {hazard}_raster.json  — raw pixel array for true raster overlay in browser

Requirements:
    pip install rasterio geopandas numpy shapely

Usage:
    python process_tiffs.py \
        --geojson path/to/counties.geojson \
        --tiffs   path/to/Climate_Projections \
        --out     path/to/dashboard/data
"""

import argparse, json, sys
from pathlib import Path
import geopandas as gpd
import numpy as np
import rasterio
from rasterio.mask import mask

SECTOR_META = {
    "11.0_Agriculture_Forestry_Fishing_and_Hunting": {
        "label":"Agriculture, Forestry & Hunting","short":"Agriculture",
        "outdoor_weight":0.92,"hazards":["heat","extreme_heat","wind","precip"],"color":"#3B6D11"},
    "21.0_Mining_Quarrying_and_Oil_and_Gas_Extraction": {
        "label":"Mining, Quarrying & Oil/Gas","short":"Mining & Oil/Gas",
        "outdoor_weight":0.80,"hazards":["heat","extreme_heat","wind"],"color":"#854F0B"},
    "23.0_Construction": {
        "label":"Construction","short":"Construction",
        "outdoor_weight":0.78,"hazards":["heat","extreme_heat","wind","precip"],"color":"#D85A30"},
    "48-49_Transportation_and_Warehousing": {
        "label":"Transportation & Warehousing","short":"Transportation",
        "outdoor_weight":0.55,"hazards":["heat","wind","precip"],"color":"#185FA5"},
    "22.0_Utilities": {
        "label":"Utilities","short":"Utilities",
        "outdoor_weight":0.50,"hazards":["heat","extreme_heat","wind"],"color":"#533AB7"},
    "31-33_Manufacturing": {
        "label":"Manufacturing","short":"Manufacturing",
        "outdoor_weight":0.30,"hazards":["heat","extreme_heat"],"color":"#0F6E56"},
    "72.0_Accommodation_and_Food_Services": {
        "label":"Accommodation & Food Services","short":"Food & Hospitality",
        "outdoor_weight":0.22,"hazards":["heat","precip"],"color":"#BA7517"},
    "71.0_Arts_Entertainment_and_Recreation": {
        "label":"Arts, Entertainment & Recreation","short":"Arts & Recreation",
        "outdoor_weight":0.45,"hazards":["heat","extreme_heat","wind","precip"],"color":"#993556"},
    "44-45_Retail_Trade": {
        "label":"Retail Trade","short":"Retail",
        "outdoor_weight":0.15,"hazards":["heat"],"color":"#2563EB"},
    "62.0_Health_Care_and_Social_Assistance": {
        "label":"Health Care & Social Assistance","short":"Health Care",
        "outdoor_weight":0.08,"hazards":["heat"],"color":"#7C3AED"},
    "61.0_Educational_Services": {
        "label":"Educational Services","short":"Education",
        "outdoor_weight":0.10,"hazards":["heat","wind"],"color":"#0891B2"},
    "54.0_Professional_Scientific_and_Technical_Services": {
        "label":"Professional, Scientific & Technical","short":"Professional Services",
        "outdoor_weight":0.08,"hazards":[],"color":"#6B7280"},
    "56.0_Administrative_and_Support_and_Waste_Management_and_Remediation_Services": {
        "label":"Admin, Support & Waste Management","short":"Admin & Waste Mgmt",
        "outdoor_weight":0.25,"hazards":["heat","wind"],"color":"#9CA3AF"},
    "42.0_Wholesale_Trade": {
        "label":"Wholesale Trade","short":"Wholesale",
        "outdoor_weight":0.20,"hazards":["heat","wind"],"color":"#A78BFA"},
    "52.0_Finance_and_Insurance": {
        "label":"Finance & Insurance","short":"Finance",
        "outdoor_weight":0.03,"hazards":[],"color":"#6B7280"},
    "53.0_Real_Estate_and_Rental_and_Leasing": {
        "label":"Real Estate & Rental","short":"Real Estate",
        "outdoor_weight":0.12,"hazards":[],"color":"#6B7280"},
    "51.0_Information": {
        "label":"Information","short":"Information",
        "outdoor_weight":0.05,"hazards":[],"color":"#6B7280"},
    "1.0_Federal_Government": {
        "label":"Federal Government","short":"Federal Gov.",
        "outdoor_weight":0.25,"hazards":["heat","wind"],"color":"#374151"},
    "2.0_State_Government": {
        "label":"State Government","short":"State Gov.",
        "outdoor_weight":0.20,"hazards":["heat","wind"],"color":"#4B5563"},
    "3.0_Local_Government": {
        "label":"Local Government","short":"Local Gov.",
        "outdoor_weight":0.30,"hazards":["heat","wind","precip"],"color":"#6B7280"},
}

HAZARD_CATALOG = [
    {"id":"wbgt","label":"Heat Stress (WBGT >80°F)","unit":"additional days/yr",
     "description":"Change in days per year where Wet Bulb Globe Temperature exceeds 80°F. Directly affects outdoor workers.",
     "hazard_type":"heat","affects":["heat"],
     "scenarios":[
         {"gwl":"1.1","file_pattern":"WBGTx80F/WBGTx80F_GWL11C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"1.5","file_pattern":"WBGTx80F/WBGTx80F_GWL15C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.0","file_pattern":"WBGTx80F/WBGTx80F_GWL20C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.5","file_pattern":"WBGTx80F/WBGTx80F_GWL25C_minus_REF_absoule_change_v2.tif"},
     ],"reference":"WBGTx80F/WBGTx80F_REF_v2.tif"},
    {"id":"tx90f","label":"Extreme Heat Days (>90°F)","unit":"additional days/yr",
     "description":"Change in days per year with max temperature above 90°F.",
     "hazard_type":"extreme_heat","affects":["heat","extreme_heat"],
     "scenarios":[
         {"gwl":"1.1","file_pattern":"TX90F/TX90F_GWL11C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"1.5","file_pattern":"TX90F/TX90F_GWL15C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.0","file_pattern":"TX90F/TX90F_GWL20C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.5","file_pattern":"TX90F/TX90F_GWL25C_minus_REF_absoule_change_v2.tif"},
     ],"reference":"TX90F/TX90F_REF_v2.tif"},
    {"id":"tx95f","label":"Severe Heat Days (>95°F)","unit":"additional days/yr",
     "description":"Change in days per year with max temperature above 95°F.",
     "hazard_type":"extreme_heat","affects":["heat","extreme_heat"],
     "scenarios":[
         {"gwl":"1.1","file_pattern":"TX95F/TX95F_GWL11C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"1.5","file_pattern":"TX95F/TX95F_GWL15C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.0","file_pattern":"TX95F/TX95F_GWL20C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.5","file_pattern":"TX95F/TX95F_GWL25C_minus_REF_absoule_change_v2.tif"},
     ],"reference":"TX95F/TX95F_REF_v2.tif"},
    {"id":"txn65f","label":"Warm Nights (>65°F)","unit":"additional nights/yr",
     "description":"Change in nights per year where minimum temperature stays above 65°F.",
     "hazard_type":"heat","affects":["heat"],
     "scenarios":[
         {"gwl":"1.1","file_pattern":"TxN65F/TxN65F_GWL11C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"1.5","file_pattern":"TxN65F/TxN65F_GWL15C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.0","file_pattern":"TxN65F/TxN65F_GWL20C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.5","file_pattern":"TxN65F/TxN65F_GWL25C_minus_REF_absoule_change_v2.tif"},
     ],"reference":"TxN65F/TxN65F_REF_v2.tif"},
    {"id":"rx1day","label":"Extreme Precipitation (1-day max)","unit":"mm change",
     "description":"Change in maximum 1-day precipitation. Affects flooding and outdoor work disruption.",
     "hazard_type":"precip","affects":["precip"],
     "scenarios":[
         {"gwl":"1.1","file_pattern":"Rx1day/Rx1day_GWL11C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"1.5","file_pattern":"Rx1day/Rx1day_GWL15C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.0","file_pattern":"Rx1day/Rx1day_GWL20C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.5","file_pattern":"Rx1day/Rx1day_GWL25C_minus_REF_absoule_change_v2.tif"},
     ],"reference":"Rx1day/Rx1day_Reference_period_v2.tif"},
    {"id":"rx5day","label":"Extreme Precipitation (5-day max)","unit":"mm change",
     "description":"Change in maximum 5-day cumulative precipitation. Indicator for sustained flooding risk.",
     "hazard_type":"precip","affects":["precip"],
     "scenarios":[
         {"gwl":"1.1","file_pattern":"Rx5day/Rx5day_GWL11C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"1.5","file_pattern":"Rx5day/Rx5day_GWL15C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.0","file_pattern":"Rx5day/Rx5day_GWL20C_minus_REF_absoule_change_v2.tif"},
         {"gwl":"2.5","file_pattern":"Rx5day/Rx5day_GWL25C_minus_REF_absoule_change_v2.tif"},
     ],"reference":"Rx5day/Rx5day_Reference_period_v2.tif"},
    {"id":"wind_ann","label":"Extreme Wind (Annual 95th pct.)","unit":"m/s",
     "description":"95th percentile annual maximum 10m wind speed.",
     "hazard_type":"wind","affects":["wind"],
     "scenarios":[
         {"gwl":"1.1","file_pattern":"wspd10max_p95/95th_wind_+1.1_ANN_wspd10max_p95.tif"},
         {"gwl":"1.5","file_pattern":"wspd10max_p95/95th_wind_+1.5_ANN_wspd10max_p95.tif"},
         {"gwl":"2.0","file_pattern":"wspd10max_p95/95th_wind_+2_ANN_wspd10max_p95.tif"},
         {"gwl":"2.5","file_pattern":"wspd10max_p95/95th_wind_+2.5_ANN_wspd10max_p95.tif"},
     ],"reference":"wspd10max_p95/95th_wind_hist_ANN_wspd10max_p95.tif"},
    {"id":"hail","label":"Hail Days (MAMJJAS season)","unit":"days/yr",
     "description":"Total hail days during MAMJJAS season. Affects agriculture, construction, and outdoor infrastructure.",
     "hazard_type":"wind","affects":["wind","precip"],
     "scenarios":[
         {"gwl":"CTL","file_pattern":"HaildaysG_total/HaildaysG_total_CTL_MAMJJAS.tif"},
         {"gwl":"PGW","file_pattern":"HaildaysG_total/HaildaysG_total_PGW_MAMJJAS.tif"},
     ],"reference":"HaildaysG_total/HaildaysG_total_CTL_MAMJJAS.tif"},
]


def zonal_mean(tif_path, geometry):
    if not tif_path.exists():
        return None
    try:
        with rasterio.open(tif_path) as src:
            out, _ = mask(src, [geometry], crop=True, all_touched=True, nodata=np.nan)
            data = out.astype(float)
            if src.nodata is not None:
                data[data == src.nodata] = np.nan
            valid = data[~np.isnan(data)]
            return float(np.mean(valid)) if valid.size > 0 else None
    except Exception as exc:
        print(f"  Warning: {tif_path.name}: {exc}", file=sys.stderr)
        return None


def extract_pixels(tif_path, min_value=-999):
    """
    Extract ALL valid (non-NaN, non-nodata) raster pixels for browser rendering.
    min_value=-999 means include zeros and near-zeros — no holes in the overlay.
    Use a higher min_value only if you want to mask out no-change areas.

    Browser reconstructs the top-left corner of each pixel as:
      lon0 = origin[0] + col * col_step
      lat0 = origin[1] + row * row_step       <- row_step sign determines direction

    Normal tiff (t.e < 0):  row 0 is north edge, rows go south  -> lat0 decreases
    Inverted tiff (t.e > 0): row 0 is south edge, rows go north -> lat0 increases
    """
    if not tif_path.exists():
        print(f"  Skipping missing: {tif_path}", file=sys.stderr)
        return None
    with rasterio.open(tif_path) as src:
        data = src.read(1).astype(float)
        t = src.transform
        nodata = src.nodata
        if nodata is not None:
            data[data == nodata] = np.nan

    nrows, ncols = data.shape
    pixels, valid_vals = [], []
    for r in range(nrows):
        for c in range(ncols):
            v = data[r, c]
            if np.isnan(v) or v < min_value:
                continue
            pixels.append([c, r, round(float(v), 4)])
            valid_vals.append(float(v))

    if not pixels:
        return None

    return {
        "origin":   [round(t.c, 6), round(t.f, 6)],  # [left_lon, row-0 lat edge]
        "col_step": round(t.a, 6),                    # degrees per column (always +)
        "row_step": round(t.e, 6),                    # degrees per row (sign matters!)
        "rows": nrows, "cols": ncols,
        "pixels": pixels,
        "extent": [round(min(valid_vals), 4), round(max(valid_vals), 4)],
    }


def process(geojson_path, tiff_root, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Loading GeoJSON: {geojson_path}")
    gdf = gpd.read_file(geojson_path).to_crs("EPSG:4326")
    print(f"  {len(gdf)} features")

    with open(out_dir / "sectors.json", "w") as f:
        json.dump([{"key": k, **v} for k, v in SECTOR_META.items()], f, indent=2)
    print("Wrote sectors.json")

    manifest = []

    for hazard in HAZARD_CATALOG:
        hid = hazard["id"]
        print(f"\n── {hid} ──────────────────────")

        # Zonal stats
        ref_path = tiff_root / hazard["reference"]
        ref_means = {str(row.get("FIPS", row.get("fips",""))): zonal_mean(ref_path, row.geometry)
                     for _, row in gdf.iterrows()}

        scenarios_data = {}
        for sc in hazard["scenarios"]:
            gwl = sc["gwl"]
            tif_path = tiff_root / sc["file_pattern"]
            print(f"  zonal {gwl} …", end=" ", flush=True)
            scenarios_data[gwl] = {str(row.get("FIPS", row.get("fips",""))): zonal_mean(tif_path, row.geometry)
                                   for _, row in gdf.iterrows()}
            print("done")

        # County records
        counties = []
        for _, row in gdf.iterrows():
            props = row.to_dict()
            fips = str(props.get("FIPS", props.get("fips","")))
            sc_vals = {gwl: scenarios_data[gwl].get(fips) for gwl in scenarios_data}
            first_gwl = hazard["scenarios"][0]["gwl"]
            current_val = sc_vals.get(first_gwl)

            sector_scores = {}
            for sec_key, sec_meta in SECTOR_META.items():
                jobs = props.get(sec_key)
                if jobs is None or (isinstance(jobs, float) and np.isnan(jobs)):
                    jobs = 0
                else:
                    jobs = float(jobs)
                relevant = hazard["hazard_type"] in sec_meta["hazards"]
                weight = sec_meta["outdoor_weight"] if relevant else 0.0
                exposed = jobs * weight
                sector_scores[sec_key] = {
                    "jobs": int(jobs), "exposed": round(exposed, 1),
                    "score": round(exposed * abs(current_val or 0), 2),
                    "relevant": relevant,
                }

            total_jobs = props.get("10.0_Total_All_Sectors") or 0
            if isinstance(total_jobs, float) and np.isnan(total_jobs):
                total_jobs = 0

            counties.append({
                "fips": fips, "name": props.get("NAME", fips),
                "population": props.get("POPULATION", 0),
                "total_jobs": int(total_jobs),
                "ref_value": round(ref_means[fips], 3) if ref_means.get(fips) is not None else None,
                "current": round(current_val, 3) if current_val is not None else None,
                "scenarios": {gwl: (round(v, 3) if v is not None else None) for gwl, v in sc_vals.items()},
                "sectors": sector_scores,
            })

        county_path = out_dir / f"{hid}.json"
        with open(county_path, "w") as f:
            json.dump({"id":hid,"label":hazard["label"],"unit":hazard["unit"],
                       "description":hazard["description"],"hazard_type":hazard["hazard_type"],
                       "gwl_labels":{sc["gwl"]:f"+{sc['gwl']}°C" for sc in hazard["scenarios"]},
                       "counties":counties}, f, separators=(",",":"))
        print(f"  Wrote {county_path.name} ({county_path.stat().st_size//1024} KB)")

        # ── Raw pixel extraction for tiff overlay ──────────────────────────
        print(f"  Extracting raster pixels …")
        raster_scenarios = {}
        for sc in hazard["scenarios"]:
            gwl = sc["gwl"]
            pdata = extract_pixels(tiff_root / sc["file_pattern"], min_value=-999)
            if pdata:
                raster_scenarios[gwl] = pdata
                print(f"    {gwl}: {len(pdata['pixels'])} pixels  "
                      f"range {pdata['extent'][0]:.2f}–{pdata['extent'][1]:.2f}")

        raster_path = out_dir / f"{hid}_raster.json"
        with open(raster_path, "w") as f:
            json.dump({"id":hid,"unit":hazard["unit"],"hazard_type":hazard["hazard_type"],
                       "scenarios":raster_scenarios}, f, separators=(",",":"))
        print(f"  Wrote {raster_path.name} ({raster_path.stat().st_size//1024} KB)")

        manifest.append({
            "id": hid, "label": hazard["label"], "unit": hazard["unit"],
            "description": hazard["description"], "hazard_type": hazard["hazard_type"],
            "file": f"data/{hid}.json",
            "raster_file": f"data/{hid}_raster.json",
            "gwls": [sc["gwl"] for sc in hazard["scenarios"]],
        })

    with open(out_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nWrote manifest.json ({len(manifest)} hazards)")
    print("Done — push data/ to GitHub.")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--geojson", required=True)
    p.add_argument("--tiffs",   required=True)
    p.add_argument("--out",     default="data")
    args = p.parse_args()
    process(Path(args.geojson), Path(args.tiffs), Path(args.out))
