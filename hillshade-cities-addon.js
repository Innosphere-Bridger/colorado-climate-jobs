/**
 * hillshade-cities-addon.js  (v6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Works with the original d3.geoAlbers() projection in initMap().
 *
 * FIXES vs previous versions:
 *   - Hillshade is appended as the LAST child of #center, not inserted between
 *     SVGs. Inserting between SVGs displaced the TIFF canvas and hid raw data.
 *     Appending last keeps the TIFF canvas undisturbed; pointer-events:none
 *     lets all clicks pass through to #click-svg beneath.
 *   - Cities appended after hillshade (topmost layer).
 *   - PNG export: legend elements are excluded; hillshade is hidden during the
 *     html2canvas pass then re-composited with ctx.globalCompositeOperation =
 *     "multiply" so the exported image matches the screen (html2canvas does not
 *     support mix-blend-mode).
 *
 * INSTALL
 * ───────
 * 1. Drop next to index.html.
 * 2. Add before </body>:
 *      <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
 *      <script src="hillshade-cities-addon.js"></script>
 * 3. In initMap(), add after the .fitSize() line — BOTH in the initial block
 *    AND inside the resize handler:
 *      window.__coProjection = STATE.projection;
 * 4. Optional: at the very end of the resize handler for instant refresh:
 *      window.__addonUpdate?.();
 *
 * LEGEND EXCLUSION
 * ────────────────
 * If your legend still appears in the PNG, right-click it in DevTools, copy
 * its id or class, and add it to EXCLUDE_SELECTORS below.
 */

(function () {
  "use strict";

  /* ══════════════════════════════════════════════════════════════════════════
   * CONFIG
   * ══════════════════════════════════════════════════════════════════════════ */

  // Colorado bounding box — WGS-84
  const BBOX = { lonMin: -109.05, latMin: 36.99, lonMax: -102.04, latMax: 41.01 };

  // ESRI World Hillshade (public, no API key needed)
  const HILLSHADE_REST =
    "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/export";

  const HILLSHADE_PX      = 1200;   // request resolution (longer axis)
  const HILLSHADE_OPACITY = 0.45;   // 0 = invisible, 1 = full terrain shadow

  const CITY_DOT_RADIUS   = 5;
  const CITY_DOT_COLOR    = "#dc143c";
  const CITY_LABEL_SIZE   = 11;
  const CITY_LABEL_OFFSET = [8, 4]; // [dx, dy] in SVG user-units

  const MAP_CONTAINER_ID  = "center";

  // Elements hidden during PNG export. Add your legend's selector here.
  const EXCLUDE_SELECTORS = [
    "#png-dl-btn",
    "#addon-toggles",
    "#legend", ".legend",
    "[id*='legend']", "[class*='legend']",
    "#color-scale", ".color-scale",
    "#colorbar", ".colorbar",
    ".map-legend", "#map-legend",
    ".scale-bar", "#scale-bar",
    "[id*='color-scale']", "[class*='color-scale']",
  ];

  const HAZARD_SEL   = ["#hazard-select",   "[data-hazard]",   ".hazard-label",   "select:first-of-type"];
  const SCENARIO_SEL = ["#scenario-select", "[data-scenario]", ".scenario-label", "select:nth-of-type(2)"];

  /* ══════════════════════════════════════════════════════════════════════════
   * CITY DATA  (matches cities_of_interest.shp row order)
   * ══════════════════════════════════════════════════════════════════════════ */

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

  /* ══════════════════════════════════════════════════════════════════════════
   * UTILITIES
   * ══════════════════════════════════════════════════════════════════════════ */

  function findFirst(sels) {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function readLabel(el) {
    if (!el) return null;
    if (el.tagName === "SELECT" && el.selectedOptions.length)
      return el.selectedOptions[0].text.trim();
    return (el.innerText || el.textContent || "").trim().split(/\s+/).slice(0, 5).join(" ");
  }

  function slug(s) {
    return (s || "unknown")
      .replace(/[°+]/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  }

  function buildFilename() {
    const hazard   = slug(readLabel(findFirst(HAZARD_SEL)))   || "hazard";
    const scenario = slug(readLabel(findFirst(SCENARIO_SEL))) || "scenario";
    const date     = new Date().toISOString().slice(0, 10);
    return `Colorado_ClimateHazard_${hazard}_${scenario}_${date}.png`;
  }

  function getViewBox() {
    const svg = document.getElementById("choro-svg");
    if (!svg) return null;
    const vb = svg.viewBox.baseVal;
    return (vb && vb.width) ? { w: vb.width, h: vb.height } : null;
  }

  // Project all four corners of the geo bbox to get the tightest SVG rect.
  function projectedBBoxRect(proj) {
    const pts = [
      [BBOX.lonMin, BBOX.latMin],
      [BBOX.lonMin, BBOX.latMax],
      [BBOX.lonMax, BBOX.latMin],
      [BBOX.lonMax, BBOX.latMax],
    ].map(p => proj(p)).filter(Boolean);
    if (pts.length < 2) return null;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }

  function isExcluded(el) {
    return EXCLUDE_SELECTORS.some(s => {
      try { return el.matches(s); } catch { return false; }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 1.  HILLSHADE
   *
   * Appended as the LAST child of #center before the cities SVG.
   * This means it floats above all county SVGs AND the TIFF canvas — but
   * pointer-events:none lets clicks pass straight through to #click-svg.
   * mix-blend-mode:multiply darkens the choropleth (and raw raster if active).
   * ══════════════════════════════════════════════════════════════════════════ */

  let hillshadeEl = null;

  function buildHillshadeUrl() {
    const aspect = (BBOX.lonMax - BBOX.lonMin) / (BBOX.latMax - BBOX.latMin);
    return HILLSHADE_REST + "?" + new URLSearchParams({
      bbox:        `${BBOX.lonMin},${BBOX.latMin},${BBOX.lonMax},${BBOX.latMax}`,
      bboxSR:      "4326",
      imageSR:     "4326",
      size:        `${Math.round(HILLSHADE_PX)},${Math.round(HILLSHADE_PX / aspect)}`,
      format:      "png32",
      transparent: "true",
      f:           "image",
    });
  }

  function positionHillshade(proj, vb) {
    if (!hillshadeEl) return;
    const r = projectedBBoxRect(proj);
    if (!r) return;
    // % positioning so it survives container resizes without a redraw.
    Object.assign(hillshadeEl.style, {
      left:   (r.x / vb.w * 100) + "%",
      top:    (r.y / vb.h * 100) + "%",
      width:  (r.w / vb.w * 100) + "%",
      height: (r.h / vb.h * 100) + "%",
    });
  }

  function initHillshade(proj, vb, container) {
    if (!hillshadeEl) {
      hillshadeEl = document.createElement("img");
      hillshadeEl.id          = "hs-layer";
      hillshadeEl.src         = buildHillshadeUrl(); // static URL — bbox never changes
      hillshadeEl.crossOrigin = "anonymous";
      hillshadeEl.alt         = "";
      Object.assign(hillshadeEl.style, {
        position:      "absolute",
        pointerEvents: "none",
        opacity:       HILLSHADE_OPACITY,
        mixBlendMode:  "multiply",
        display:       "block",
      });
      hillshadeEl.addEventListener("load",
        () => console.log("[addon] Hillshade loaded ✓"));
      hillshadeEl.addEventListener("error",
        () => console.warn("[addon] Hillshade failed — check Network tab."));

      container.appendChild(hillshadeEl); // appended last; cities come after
    }
    positionHillshade(proj, vb);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 2.  CITIES
   *
   * Appended after hillshade. viewBox is resynced every call so dots scale
   * correctly when the window is resized (projection + viewBox both change).
   * ══════════════════════════════════════════════════════════════════════════ */

  let citySvgEl = null;

  function drawCities(proj, vb) {
    const NS = "http://www.w3.org/2000/svg";

    if (!citySvgEl) {
      citySvgEl = document.createElementNS(NS, "svg");
      citySvgEl.id = "cities-layer";
      Object.assign(citySvgEl.style, {
        position:      "absolute",
        top:           "0",
        left:          "0",
        width:         "100%",
        height:        "100%",
        pointerEvents: "none",
        overflow:      "visible",
      });
      document.getElementById(MAP_CONTAINER_ID).appendChild(citySvgEl);
    }

    // MUST resync viewBox every call — it changes when the map resizes.
    citySvgEl.setAttribute("viewBox", `0 0 ${vb.w} ${vb.h}`);

    // Full redraw on every call (15 cities = trivially fast).
    citySvgEl.innerHTML = `
      <defs>
        <filter id="city-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.5"
                        flood-color="#000" flood-opacity="0.35"/>
        </filter>
      </defs>`;

    const g = document.createElementNS(NS, "g");

    CITIES.forEach(city => {
      const pt = proj([city.lon, city.lat]);
      if (!pt || isNaN(pt[0])) return;
      const [cx, cy] = pt;
      const [dx, dy] = CITY_LABEL_OFFSET;

      // white halo so dot is readable over dark terrain
      const halo = document.createElementNS(NS, "circle");
      halo.setAttribute("cx",   cx);
      halo.setAttribute("cy",   cy);
      halo.setAttribute("r",    CITY_DOT_RADIUS + 2.5);
      halo.setAttribute("fill", "rgba(255,255,255,0.72)");
      g.appendChild(halo);

      // coloured dot
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx",           cx);
      dot.setAttribute("cy",           cy);
      dot.setAttribute("r",            CITY_DOT_RADIUS);
      dot.setAttribute("fill",         CITY_DOT_COLOR);
      dot.setAttribute("stroke",       "#fff");
      dot.setAttribute("stroke-width", "1.6");
      dot.setAttribute("filter",       "url(#city-shadow)");
      g.appendChild(dot);

      // label with white knockout stroke
      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("x",               cx + dx);
      lbl.setAttribute("y",               cy + dy);
      lbl.setAttribute("font-family",     "system-ui,-apple-system,sans-serif");
      lbl.setAttribute("font-size",       CITY_LABEL_SIZE);
      lbl.setAttribute("font-weight",     "700");
      lbl.setAttribute("fill",            "#111");
      lbl.setAttribute("stroke",          "rgba(255,255,255,0.93)");
      lbl.setAttribute("stroke-width",    "3");
      lbl.setAttribute("paint-order",     "stroke");
      lbl.setAttribute("stroke-linejoin", "round");
      lbl.textContent = city.name;
      g.appendChild(lbl);
    });

    citySvgEl.appendChild(g);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 3.  LAYER TOGGLES
   * ══════════════════════════════════════════════════════════════════════════ */

  function addToggles() {
    if (document.getElementById("addon-toggles")) return;
    const panel = document.createElement("div");
    panel.id = "addon-toggles";
    Object.assign(panel.style, {
      position:       "fixed",
      top:            "60px",
      right:          "16px",
      zIndex:         "9000",
      display:        "flex",
      flexDirection:  "column",
      gap:            "6px",
      background:     "rgba(15,23,42,0.85)",
      backdropFilter: "blur(6px)",
      borderRadius:   "10px",
      padding:        "10px 14px",
      boxShadow:      "0 4px 20px rgba(0,0,0,0.4)",
      fontSize:       "12px",
      color:          "#e2e8f0",
      fontFamily:     "system-ui,sans-serif",
      userSelect:     "none",
    });

    const makeRow = (text, targetId) => {
      const lbl = document.createElement("label");
      Object.assign(lbl.style, {
        display: "flex", alignItems: "center", gap: "8px", cursor: "pointer",
      });
      const cb = document.createElement("input");
      cb.type    = "checkbox";
      cb.checked = true;
      cb.style.accentColor = "#60a5fa";
      cb.addEventListener("change", () => {
        const el = document.getElementById(targetId);
        if (el) el.style.display = cb.checked ? "" : "none";
      });
      lbl.append(cb, document.createTextNode(text));
      return lbl;
    };

    panel.append(
      makeRow("🏔  Hillshade", "hs-layer"),
      makeRow("📍  Cities",    "cities-layer"),
    );
    document.body.appendChild(panel);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 4.  PNG EXPORT
   *
   * html2canvas does not support mix-blend-mode, so if the hillshade is
   * visible during the screenshot it renders as a flat grey overlay that
   * washes out the county colours.  Fix:
   *   a) Hide the hillshade, take the screenshot (counties + cities + TIFF).
   *   b) Draw the base screenshot onto an output canvas.
   *   c) Re-draw the hillshade with globalCompositeOperation="multiply" so
   *      the blending matches what you see on screen.
   * ══════════════════════════════════════════════════════════════════════════ */

  async function captureMapCanvas(container) {
    // a) Hide hillshade so html2canvas doesn't flatten it incorrectly.
    if (hillshadeEl) hillshadeEl.style.visibility = "hidden";

    let baseCanvas;
    try {
      baseCanvas = await html2canvas(container, {
        useCORS:        true,
        allowTaint:     false,
        scale:          2,
        logging:        false,
        ignoreElements: isExcluded,
      });
    } finally {
      // Always restore visibility even if html2canvas throws.
      if (hillshadeEl) hillshadeEl.style.visibility = "";
    }

    // b) Paint base onto output canvas.
    const out = document.createElement("canvas");
    out.width  = baseCanvas.width;
    out.height = baseCanvas.height;
    const ctx  = out.getContext("2d");
    ctx.drawImage(baseCanvas, 0, 0);

    // c) Composite hillshade with multiply.
    const proj    = window.__coProjection;
    const vb      = getViewBox();
    const r       = (proj && vb) ? projectedBBoxRect(proj) : null;
    const hsReady = hillshadeEl &&
                    hillshadeEl.complete &&
                    hillshadeEl.naturalWidth > 0;

    if (r && hsReady) {
      // SVG user-unit coords → output canvas pixels.
      // out.width = container.clientWidth * scale(2), so:
      const scaleX = out.width  / vb.w;
      const scaleY = out.height / vb.h;

      ctx.save();
      ctx.globalAlpha              = HILLSHADE_OPACITY;
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(
        hillshadeEl,
        r.x * scaleX,
        r.y * scaleY,
        r.w * scaleX,
        r.h * scaleY,
      );
      ctx.restore();
    } else if (!hsReady) {
      console.warn("[addon] Hillshade not yet loaded — PNG will skip terrain layer.");
    }

    return out;
  }

  function addPngButton() {
    if (document.getElementById("png-dl-btn")) return;

    const style = document.createElement("style");
    style.textContent = `
      #png-dl-btn {
        position: fixed; bottom: 24px; right: 24px; z-index: 9000;
        display: flex; align-items: center; gap: 8px;
        padding: 11px 20px;
        background: linear-gradient(135deg, #1e40af, #2563eb);
        color: #fff; border: none; border-radius: 10px;
        font-size: 14px; font-weight: 700;
        font-family: system-ui, sans-serif;
        cursor: pointer; letter-spacing: .02em;
        box-shadow: 0 4px 16px rgba(37,99,235,.45);
        transition: opacity .15s, transform .15s;
      }
      #png-dl-btn:hover    { opacity: .9; transform: translateY(-2px); }
      #png-dl-btn:active   { transform: translateY(0); }
      #png-dl-btn:disabled { opacity: .5; cursor: wait; transform: none; }
    `;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "png-dl-btn";
    btn.innerHTML = `<span>🖼</span><span class="btn-txt"> Download Map PNG</span>`;

    btn.addEventListener("click", async () => {
      const container = document.getElementById(MAP_CONTAINER_ID);
      if (!container) { alert("Map container not found."); return; }

      btn.disabled = true;
      btn.querySelector(".btn-txt").textContent = " Generating…";

      try {
        const canvas = await captureMapCanvas(container);
        const a      = document.createElement("a");
        a.href       = canvas.toDataURL("image/png");
        a.download   = buildFilename();
        a.click();
        console.log("[addon] PNG saved:", a.download);
      } catch (err) {
        console.error("[addon] PNG export failed:", err);
        alert("PNG export failed — see console.\n\n" + err.message);
      } finally {
        btn.disabled = false;
        btn.querySelector(".btn-txt").textContent = " Download Map PNG";
      }
    });

    document.body.appendChild(btn);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 5.  MASTER UPDATE  — re-positions hillshade + redraws cities
   * ══════════════════════════════════════════════════════════════════════════ */

  function update() {
    const proj = window.__coProjection;
    if (typeof proj !== "function") {
      console.warn("[addon] window.__coProjection not set yet — skipping update.");
      return;
    }
    const vb = getViewBox();
    if (!vb) return;
    const container = document.getElementById(MAP_CONTAINER_ID);
    if (!container) return;

    // Ensure container is a CSS stacking context (required for absolute children).
    if (getComputedStyle(container).position === "static")
      container.style.position = "relative";

    initHillshade(proj, vb, container);
    drawCities(proj, vb);
  }

  // Exposed globally — call from your resize handler for zero-delay refresh:
  //   window.__addonUpdate?.();
  window.__addonUpdate = update;

  /* ══════════════════════════════════════════════════════════════════════════
   * 6.  BOOTSTRAP
   * ══════════════════════════════════════════════════════════════════════════ */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s    = document.createElement("script");
      s.src      = src;
      s.onload   = resolve;
      s.onerror  = reject;
      document.head.appendChild(s);
    });
  }

  // Wait until choro-svg has a non-zero viewBox AND __coProjection is a function.
  function waitForMap(intervalMs = 250, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const t = setInterval(() => {
        if (getViewBox() && typeof window.__coProjection === "function") {
          clearInterval(t);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error(
            "[addon] Timed out waiting for map.\n" +
            "Make sure  window.__coProjection = STATE.projection  is set in initMap()."
          ));
        }
      }, intervalMs);
    });
  }

  async function bootstrap() {
    if (typeof html2canvas === "undefined") {
      await loadScript(
        "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"
      );
    }

    addToggles();
    addPngButton();

    try {
      await waitForMap();
    } catch (e) {
      console.error(e.message);
      return;
    }

    update();

    // ResizeObserver: 80 ms debounce lets D3's resize handler run first,
    // so fitSize + window.__coProjection are both updated before we redraw.
    const container = document.getElementById(MAP_CONTAINER_ID);
    if (container && typeof ResizeObserver !== "undefined") {
      let debounce;
      new ResizeObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(update, 80);
      }).observe(container);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }

})();
