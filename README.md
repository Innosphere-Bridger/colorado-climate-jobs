# Colorado Climate Hazard × Jobs Dashboard

## Quick start — 3 steps

### 1. Install Python dependencies
```bash
pip install rasterio geopandas numpy shapely
```

### 2. Process your tiffs → JSON
```bash
python process_tiffs.py \
  --geojson path/to/counties.geojson \
  --tiffs   path/to/Climate_Projections \
  --out     data
```
This creates a `data/` folder with one JSON per hazard + a manifest. Run it once, or re-run whenever you add new tiffs.

### 3. Open the dashboard
For local use:
```bash
# Python's built-in server (required — browsers block file:// fetches)
python -m http.server 8000
# then open http://localhost:8000
```

---

## Deploy to GitHub Pages (shareable link)

```
your-repo/
├── index.html
├── data/
│   ├── manifest.json
│   ├── sectors.json
│   ├── wbgt.json
│   ├── tx90f.json
│   └── ...
└── process_tiffs.py   (optional, keep for reference)
```

1. Create a GitHub repo (can be private if you add collaborators, or public for open access)
2. Push your folder:
   ```bash
   git init
   git add .
   git commit -m "initial dashboard"
   git remote add origin https://github.com/YOUR_ORG/colorado-climate-jobs.git
   git push -u origin main
   ```
3. Go to **Settings → Pages → Source: main branch / root**
4. Your dashboard is live at `https://YOUR_ORG.github.io/colorado-climate-jobs/`

Anyone with the link can use it — no login, no server, completely free.

---

## Adding a new hazard layer

1. Add a new entry to `HAZARD_CATALOG` in `process_tiffs.py`
2. Re-run `process_tiffs.py` — it only regenerates changed hazards
3. Drop the new JSON into `data/`
4. `manifest.json` updates automatically — dashboard picks it up on next load

---

## Adjusting sector exposure weights

Edit `SECTOR_META` in `process_tiffs.py`. Each sector has:
- `outdoor_weight` — share of workers with meaningful outdoor/weather exposure (0.0–1.0)
- `hazards` — which hazard types affect this sector: `"heat"`, `"extreme_heat"`, `"wind"`, `"precip"`

Re-run the script to regenerate the JSON with updated scores.

---

## File size reference

| File | Approx. size |
|------|-------------|
| `manifest.json` | < 5 KB |
| `sectors.json` | < 10 KB |
| Per-hazard JSON (64 counties) | 50–150 KB |
| Total data folder | ~1 MB |

The full dashboard loads in under 1 second on a normal connection.
