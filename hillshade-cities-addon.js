/**
 * hillshade-cities-addon.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Adds three things to the Colorado Climate Hazard × Jobs dashboard:
 *
 *   1. ESRI World Hillshade layer rendered as an <image> inside the existing
 *      D3 SVG map, sitting below the county fills.
 *
 *   2. City markers + labels for 15 Colorado cities (from cities_of_interest.shp).
 *
 *   3. A floating "Download Map PDF" button.  The PDF filename encodes the
 *      currently selected hazard, warming scenario, and the date.
 *
 * HOW TO INSTALL
 * ──────────────
 * 1. Copy this file next to your index.html.
 *
 * 2. Add these three <script> tags at the bottom of <body>, AFTER your
 *    existing scripts:
 *
 *      <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
 *      <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
 *      <script src="hillshade-cities-addon.js"></script>
 *
 * 3. Make sure your D3 projection variable is accessible.  The script tries
 *    several common names (projection, proj, mapProjection, geoProjection).
 *    If yours is different, set window.__coProjection = <yourVar> anywhere
 *    in your existing code, or edit PROJECTION_CANDIDATES below.
 *
 * CONFIGURATION
 * ─────────────
 * Tweak the constants at the top of each section to adjust appearance.
 */

(function () {
  "use strict";

  /* ══════════════════════════════════════════════════════════════════════════
   * 0.  CONFIGURATION
   * ══════════════════════════════════════════════════════════════════════════ */

  // Names the script will probe on `window` to find the D3 projection.
  const PROJECTION_CANDIDATES = [
    "__coProjection",   // explicit override — set window.__coProjection = ... if needed
    "projection",
    "proj",
    "mapProjection",
    "geoProjection",
    "coProjection",
  ];

  // Colorado bounding box, WGS84.
  const BBOX = { lonMin: -109.05, latMin: 36.99, lonMax: -102.04, latMax: 41.01 };

  // ESRI World Hillshade — public, no API key required, CORS enabled.
  const HILLSHADE_WMS =
    "https://services.arcgisonline.com/ArcGIS/services/Elevation/World_Hillshade/MapServer/WmsServer";

  // Hillshade opacity layered over the county choropleth (0 = invisible, 1 = opaque).
  const HILLSHADE_OPACITY = 0.38;

  // City points — row order matches cities_of_interest.shp.
  const CITIES = [
    { name: "Aurora",            lon: -104.7275, lat: 39.7084 },
    { name: "Boulder",           lon: -105.2515, lat: 40.0273 },
    { name: "Colorado Springs",  lon: -104.7606, lat: 38.8674 },
    { name: "Craig",             lon: -107.5557, lat: 40.5170 },
    { name: "Denver",            lon: -104.9893, lat: 39.7627 },
    { name: "Durango",           lon: -107.8703, lat: 37.2750 },
    { name: "Fort Collins",      lon: -105.0657, lat: 40.5478 },
    { name: "Glenwood Springs",  lon: -107.3344, lat: 39.5454 },
    { name: "Grand Junction",    lon: -108.5675, lat: 39.0878 },
    { name: "Greeley",           lon: -104.7707, lat: 40.4149 },
    { name: "Gunnison",          lon: -106.9246, lat: 38.5490 },
    { name: "Lamar",             lon: -102.6152, lat: 38.0737 },
    { name: "Montrose",          lon: -107.8594, lat: 38.4688 },
    { name: "Pueblo",            lon: -104.6131, lat: 38.2706 },
    { name: "Trinidad",          lon: -104.4908, lat: 37.1749 },
  ];

  // PDF selector heuristics — the script will try these in order to read
  // the active hazard / scenario labels for the filename.
  const HAZARD_SELECTORS   = ["#hazard-select", "[data-hazard]", ".hazard-label", "select:first-of-type"];
  const SCENARIO_SELECTORS = ["#scenario-select", "[data-scenario]", ".scenario-label", "select:nth-of-type(2)"];

  /* ══════════════════════════════════════════════════════════════════════════
   * 1.  UTILITIES
   * ══════════════════════════════════════════════════════════════════════════ */

  /** Dynamically load an external script and resolve when done. */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  /** Try each selector in order; return the first matching element. */
  function findFirst(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * Read a label from an element: <select> → selectedOptions text,
   * otherwise innerText / textContent.
   */
  function readLabel(el) {
    if (!el) return null;
    if (el.tagName === "SELECT" && el.selectedOptions.length) {
      return el.selectedOptions[0].text.trim();
    }
    return (el.innerText || el.textContent || "").trim().split(/\s+/).slice(0, 4).join("_");
  }

  /** Slugify a string for use in a filename. */
  function slug(s) {
    return (s || "unknown")
      .replace(/[°+.]/g, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  }

  /**
   * Poll until the main SVG contains enough county paths.
   * Colorado has 64 counties; we wait until at least 60 <path> elements exist.
   */
  function waitForMap(minPaths = 60, intervalMs = 250, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      (function check() {
        const svgs = document.querySelectorAll("svg");
        for (const svg of svgs) {
          if (svg.querySelectorAll("path[d]").length >= minPaths) {
            return resolve(svg);
          }
        }
        if (Date.now() > deadline) return reject(new Error("Map SVG not found in time."));
        setTimeout(check, intervalMs);
      })();
    });
  }

  /** Probe window for a D3 projection function. */
  function findProjection() {
    for (const name of PROJECTION_CANDIDATES) {
      if (typeof window[name] === "function") return window[name];
    }
    return null;
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 2.  HILLSHADE LAYER
   * ══════════════════════════════════════════════════════════════════════════ */

  /**
   * Build a WMS GetMap URL for the ESRI World Hillshade service covering
   * Colorado at the resolution of the rendered SVG element.
   */
  function buildWmsUrl(proj, svgEl) {
    // Project the four bbox corners to SVG coordinates.
    const corners = [
      proj([BBOX.lonMin, BBOX.latMin]),
      proj([BBOX.lonMin, BBOX.latMax]),
      proj([BBOX.lonMax, BBOX.latMin]),
      proj([BBOX.lonMax, BBOX.latMax]),
    ].filter(Boolean);

    if (!corners.length) return null;

    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);

    // Pixel dimensions at screen resolution (capped to avoid huge requests).
    const viewW = svgEl.clientWidth  || svgEl.getBoundingClientRect().width  || 800;
    const viewH = svgEl.clientHeight || svgEl.getBoundingClientRect().height || 600;

    const svgVB  = svgEl.viewBox.baseVal;
    const vbW    = svgVB.width  || viewW;
    const vbH    = svgVB.height || viewH;

    // Fraction of the SVG occupied by the Colorado bbox.
    const fracW  = (x1 - x0) / vbW;
    const fracH  = (y1 - y0) / vbH;
    const pxW    = Math.round(Math.min(viewW * fracW * 2, 1200));
    const pxH    = Math.round(Math.min(viewH * fracH * 2, 900));

    const params = new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.1.1",
      REQUEST: "GetMap",
      LAYERS: "0",
      STYLES: "",
      SRS: "EPSG:4326",
      BBOX: `${BBOX.lonMin},${BBOX.latMin},${BBOX.lonMax},${BBOX.latMax}`,
      WIDTH:  pxW,
      HEIGHT: pxH,
      FORMAT: "image/png",
      TRANSPARENT: "TRUE",
    });

    return { url: `${HILLSHADE_WMS}?${params}`, x0, y0, x1, y1 };
  }

  function addHillshadeLayer(svg, proj) {
    const info = buildWmsUrl(proj, svg);
    if (!info) { console.warn("[addon] Could not compute hillshade bbox."); return; }

    const { url, x0, y0, x1, y1 } = info;

    const NS = "http://www.w3.org/2000/svg";
    const img = document.createElementNS(NS, "image");
    img.setAttribute("id", "hs-layer");
    img.setAttribute("x", x0);
    img.setAttribute("y", y0);
    img.setAttribute("width",  x1 - x0);
    img.setAttribute("height", y1 - y0);
    img.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
    img.setAttribute("href", url);           // modern + legacy
    img.setAttribute("opacity", HILLSHADE_OPACITY);
    img.setAttribute("preserveAspectRatio", "none");
    img.setAttribute("crossOrigin", "anonymous");

    // Mix-blend-mode: multiply blends shadows into the choropleth nicely.
    img.style.mixBlendMode = "multiply";
    img.style.pointerEvents = "none";

    // Insert as the FIRST child of the SVG so it sits behind everything.
    svg.insertBefore(img, svg.firstChild);

    img.addEventListener("error", () => {
      console.warn("[addon] Hillshade WMS request failed — the image may be blocked by CORS or the service is unavailable.");
    });

    console.log("[addon] Hillshade layer added →", url);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 3.  CITY MARKERS + LABELS
   * ══════════════════════════════════════════════════════════════════════════ */

  function addCityLayer(svg, proj) {
    const NS = "http://www.w3.org/2000/svg";

    const g = document.createElementNS(NS, "g");
    g.setAttribute("id", "cities-layer");
    g.style.pointerEvents = "none";

    CITIES.forEach(city => {
      const pt = proj([city.lon, city.lat]);
      if (!pt) return;               // outside projection clip
      const [cx, cy] = pt;

      // ── drop-shadow filter (one per SVG; reuse if already defined) ──
      let defs = svg.querySelector("defs");
      if (!defs) {
        defs = document.createElementNS(NS, "defs");
        svg.insertBefore(defs, svg.firstChild);
      }
      if (!defs.querySelector("#city-shadow")) {
        defs.innerHTML += `
          <filter id="city-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.5"/>
          </filter>`;
      }

      // ── circle marker ──
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.setAttribute("r", 5.5);
      dot.setAttribute("fill", "#dc143c");
      dot.setAttribute("stroke", "#ffffff");
      dot.setAttribute("stroke-width", "1.8");
      dot.setAttribute("filter", "url(#city-shadow)");
      g.appendChild(dot);

      // ── label with white knockout stroke ──
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", cx + 8);
      label.setAttribute("y", cy + 4);
      label.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
      label.setAttribute("font-size", "11");
      label.setAttribute("font-weight", "700");
      label.setAttribute("fill", "#111111");
      label.setAttribute("stroke", "rgba(255,255,255,0.9)");
      label.setAttribute("stroke-width", "3");
      label.setAttribute("paint-order", "stroke");
      label.setAttribute("stroke-linejoin", "round");
      label.textContent = city.name;
      g.appendChild(label);
    });

    // Append on top of the existing SVG children.
    svg.appendChild(g);
    console.log("[addon] City layer added — " + CITIES.length + " cities.");
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 4.  VISIBILITY TOGGLE CONTROLS
   * ══════════════════════════════════════════════════════════════════════════ */

  function addLayerToggles() {
    const bar = document.createElement("div");
    bar.id = "addon-toggles";
    Object.assign(bar.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "8000",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      background: "rgba(15,23,42,0.82)",
      backdropFilter: "blur(6px)",
      borderRadius: "10px",
      padding: "10px 14px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
      fontSize: "12px",
      color: "#e2e8f0",
      fontFamily: "system-ui, sans-serif",
    });

    function makeToggle(labelText, targetId, defaultOn) {
      const row = document.createElement("label");
      Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" });

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = defaultOn;
      cb.style.accentColor = "#60a5fa";
      cb.addEventListener("change", () => {
        const el = document.getElementById(targetId);
        if (el) el.style.display = cb.checked ? "" : "none";
      });

      row.appendChild(cb);
      row.appendChild(document.createTextNode(labelText));
      return row;
    }

    bar.appendChild(makeToggle("🏔  Hillshade",  "hs-layer",     true));
    bar.appendChild(makeToggle("📍  Cities",     "cities-layer", true));

    document.body.appendChild(bar);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 5.  PDF DOWNLOAD BUTTON
   * ══════════════════════════════════════════════════════════════════════════ */

  function buildFilename() {
    const hazardEl   = findFirst(HAZARD_SELECTORS);
    const scenarioEl = findFirst(SCENARIO_SELECTORS);

    const hazard   = slug(readLabel(hazardEl))   || "hazard";
    const scenario = slug(readLabel(scenarioEl)) || "scenario";
    const date     = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD

    return `Colorado_ClimateHazard_${hazard}_${scenario}_${date}.pdf`;
  }

  function addPdfButton() {
    const btn = document.createElement("button");
    btn.id = "pdf-dl-btn";
    btn.innerHTML = `
      <span class="pdf-icon">⬇</span>
      <span class="pdf-text">Download Map PDF</span>`;

    const style = document.createElement("style");
    style.textContent = `
      #pdf-dl-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9000;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 11px 20px;
        background: linear-gradient(135deg, #1e40af, #2563eb);
        color: #fff;
        border: none;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 700;
        font-family: system-ui, sans-serif;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(37,99,235,0.45);
        transition: opacity .15s, transform .15s, box-shadow .15s;
        letter-spacing: .02em;
      }
      #pdf-dl-btn:hover  { opacity: .9; transform: translateY(-2px); box-shadow: 0 8px 24px rgba(37,99,235,0.5); }
      #pdf-dl-btn:active { transform: translateY(0); }
      #pdf-dl-btn:disabled { opacity: .55; cursor: wait; transform: none; }
      .pdf-icon { font-size: 16px; }
    `;
    document.head.appendChild(style);

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.querySelector(".pdf-text").textContent = "Generating PDF…";

      try {
        const filename = buildFilename();

        // Snapshot the full page.
        const canvas = await html2canvas(document.documentElement, {
          useCORS: true,
          allowTaint: false,
          scale: 1.5,
          scrollX: 0,
          scrollY: -window.scrollY,
          windowWidth:  document.documentElement.scrollWidth,
          windowHeight: document.documentElement.scrollHeight,
          ignoreElements: el => el.id === "pdf-dl-btn" || el.id === "addon-toggles",
        });

        const { jsPDF } = window.jspdf;
        const landscape  = canvas.width > canvas.height;
        const pdf = new jsPDF({
          orientation: landscape ? "landscape" : "portrait",
          unit: "pt",
          format: landscape
            ? [canvas.height / 1.5, canvas.width / 1.5]   // scale back from html2canvas 1.5×
            : [canvas.width  / 1.5, canvas.height / 1.5],
        });

        const pageW = pdf.internal.pageSize.getWidth();
        const pageH = pdf.internal.pageSize.getHeight();

        // Add the map snapshot.
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pageW, pageH);

        // Add a metadata footer.
        pdf.setFontSize(7);
        pdf.setTextColor(100);
        pdf.text(
          `Colorado Climate Hazard × Jobs  |  Generated ${new Date().toLocaleString()}  |  innosphere-bridger.github.io/colorado-climate-jobs`,
          pageW / 2, pageH - 6,
          { align: "center" }
        );

        pdf.save(filename);
        console.log("[addon] PDF saved as:", filename);
      } catch (err) {
        console.error("[addon] PDF export error:", err);
        alert("PDF export failed — check the browser console for details.\n\n" + err.message);
      } finally {
        btn.disabled = false;
        btn.querySelector(".pdf-text").textContent = "Download Map PDF";
      }
    });

    document.body.appendChild(btn);
    console.log("[addon] PDF download button added.");
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 6.  BOOTSTRAP
   * ══════════════════════════════════════════════════════════════════════════ */

  async function main() {
    // Step 1: load PDF libraries if not already present.
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");

    // Step 2: wait for the D3 SVG map to be rendered.
    let svg;
    try {
      svg = await waitForMap();
    } catch (e) {
      console.error("[addon] " + e.message);
      addPdfButton();   // still add the PDF button even if the map wasn't found
      return;
    }

    // Step 3: locate the D3 projection.
    const proj = findProjection();
    if (!proj) {
      console.warn(
        "[addon] Could not find a D3 projection on window. " +
        "Set window.__coProjection = <yourProjectionVar> in your map code, " +
        "or add its variable name to PROJECTION_CANDIDATES at the top of hillshade-cities-addon.js."
      );
    }

    // Step 4: add layers.
    if (proj) {
      addHillshadeLayer(svg, proj);
      addCityLayer(svg, proj);
    }

    // Step 5: toggle controls + PDF button (always added).
    addLayerToggles();
    addPdfButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
