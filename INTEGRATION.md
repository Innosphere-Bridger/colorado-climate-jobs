# 🗺️  Hillshade + Cities + PDF Export — Integration Guide
# ──────────────────────────────────────────────────────────────────────────────

## Files

  hillshade-cities-addon.js   ← drop this next to your index.html
  INTEGRATION.md              ← this file (optional, for reference)


## Step 1 — Add three script tags to index.html

Open index.html.  Find the closing </body> tag.  **Just before it**, add:

```html
  <!-- ── Hillshade + Cities + PDF addon ── -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script src="hillshade-cities-addon.js"></script>
</body>
```

That is the minimum required change.  The addon auto-runs on DOMContentLoaded.


## Step 2 — Expose your D3 projection (critical)

The hillshade and city markers both need to know **where to place pixels** on
your SVG.  Your existing code has a D3 projection variable — the addon needs
to find it.

**Option A (recommended) — one line change in your existing JS:**

  Wherever your D3 projection is defined, just assign it to a window property:

  ```js
  // Your existing code might look like:
  const projection = d3.geoAlbersUsa().fitSize([width, height], coloradoGeo);

  // Add this line right after:
  window.__coProjection = projection;
  ```

**Option B — edit the addon:**

  Open hillshade-cities-addon.js, find PROJECTION_CANDIDATES near the top,
  and add your variable's name as the first entry:

  ```js
  const PROJECTION_CANDIDATES = [
    "myActualProjectionVarName",   // ← add your name here
    "__coProjection",
    "projection",
    ...
  ];
  ```

If neither option works, open the browser console.  The addon logs:
  ✅  "[addon] Hillshade layer added → <url>"
  ✅  "[addon] City layer added — 15 cities."
  ⚠️  "[addon] Could not find a D3 projection …" ← means Step 2 is needed


## Step 3 — (Optional) Tune the PDF filename selectors

The PDF filename is built from the active hazard and scenario selections.
By default the addon probes for:

  Hazard:   #hazard-select  /  [data-hazard]  /  .hazard-label  /  select:first-of-type
  Scenario: #scenario-select / [data-scenario] / .scenario-label / select:nth-of-type(2)

If your dropdowns use different IDs/classes, open hillshade-cities-addon.js
and update HAZARD_SELECTORS / SCENARIO_SELECTORS near the top.

Example filename produced:
  Colorado_ClimateHazard_Heat_+2.0C_2025-04-23.pdf


## What you'll see

  🏔  Hillshade toggle     top-right floating panel
  📍  Cities toggle        top-right floating panel
  ⬇  Download Map PDF     bottom-right floating button

Both toggles are on by default.  They are excluded from the PDF screenshot.


## Hillshade source

  ESRI World Hillshade — public REST/WMS, no API key.
  Service:  https://services.arcgisonline.com/ArcGIS/services/Elevation/World_Hillshade/MapServer/WmsServer
  Blend:    mix-blend-mode: multiply  (shadows merge with county colours)
  Opacity:  0.38 (editable via HILLSHADE_OPACITY in the addon)


## Troubleshooting

| Symptom                           | Likely cause + fix                                                |
|-----------------------------------|-------------------------------------------------------------------|
| Hillshade is a grey rectangle     | CORS — browser blocks the WMS cross-origin image in html2canvas.  |
|                                   | Add `crossOrigin="anonymous"` attr to your SVG (already done).    |
|                                   | The hillshade still *displays* fine; it just won't appear in PDF. |
| Cities appear at wrong position   | Projection not found.  Do Step 2.                                 |
| PDF button does nothing           | Check console for jsPDF / html2canvas load errors.                |
| Hillshade not visible             | Toggle may be off, or WMS request timed out (check Network tab).  |
