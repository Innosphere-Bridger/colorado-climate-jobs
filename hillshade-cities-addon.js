/**
 * hillshade-cities-addon.js  (v4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Layering is handled by DOM insertion order — no z-index or position changes
 * are made to the existing SVGs (which broke clicks, TIFF, and the slider).
 *
 * Insertion points:
 *   #choro-svg    ← choropleth fills
 *   #hs-layer     ← hillshade inserted immediately AFTER #choro-svg
 *   #outline-svg  ← county borders
 *   #cities-layer ← cities inserted immediately AFTER #outline-svg
 *   #click-svg    ← transparent click targets (untouched)
 *
 * PROJECTION NOTE
 * ───────────────
 * Revert to your original d3.geoAlbers() — do NOT use geoEquirectangular.
 * The Albers projection with parallels at [37.5, 40.5] already minimises
 * Colorado's border curvature to a few pixels. Equirectangular stretches
 * Colorado horizontally and breaks the TIFF canvas renderer.
 *
 * Your initMap() projection block should be:
 *
 *   STATE.projection = d3.geoAlbers()
 *       .rotate([105.55, 0])
 *       .center([0, 39.0])
 *       .parallels([37.5, 40.5])
 *       .fitSize([w, h], STATE.countyGeo);
 *
 * And in the resize handler:
 *
 *   STATE.projection
 *       .rotate([105.55, 0])
 *       .center([0, 39.0])
 *       .parallels([37.5, 40.5])
 *       .fitSize([w2, h2], STATE.countyGeo);
 *
 * INSTALL
 * ───────
 * 1. Drop this file next to index.html.
 * 2. Add before </body>:
 *      <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
 *      <script src="hillshade-cities-addon.js"></script>
 * 3. In initMap(), after fitSize:
 *      window.__coProjection = STATE.projection;
 *    Same line in the resize handler.
 * 4. (Optional) at the end of the resize handler for instant city/hillshade update:
 *      window.__addonUpdate?.();
 */

(function () {
  "use strict";

  /* ══════════════════════════════════════════════════════════════════════════
   * CONFIG
   * ══════════════════════════════════════════════════════════════════════════ */

  const BBOX = { lonMin: -109.05, latMin: 36.99, lonMax: -102.04, latMax: 41.01 };

  const HILLSHADE_REST =
    "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/export";

  const HILLSHADE_PX      = 1200;
  const HILLSHADE_OPACITY = 0.45;

  const CITY_DOT_RADIUS   = 5;
  const CITY_DOT_COLOR    = "#dc143c";
  const CITY_LABEL_SIZE   = 11;
  const CITY_LABEL_OFFSET = [8, 4];

  const MAP_CONTAINER_ID = "center";

  const HAZARD_SEL   = ["#hazard-select",   "[data-hazard]",   ".hazard-label",   "select:first-of-type"];
  const SCENARIO_SEL = ["#scenario-select", "[data-scenario]", ".scenario-label", "select:nth-of-type(2)"];

  /* ══════════════════════════════════════════════════════════════════════════
   * CITY DATA
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
    for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
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
      .replace(/[°+]/g, "").replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  function buildFilename() {
    const hazard   = slug(readLabel(findFirst(HAZARD_SEL)))   || "hazard";
    const scenario = slug(readLabel(findFirst(SCENARIO_SEL))) || "scenario";
    return `Colorado_ClimateHazard_${hazard}_${scenario}_${new Date().toISOString().slice(0, 10)}.png`;
  }

  function getViewBox() {
    const svg = document.getElementById("choro-svg");
    if (!svg) return null;
    const vb = svg.viewBox.baseVal;
    return (vb && vb.width) ? { w: vb.width, h: vb.height } : null;
  }

  function projectedBBoxRect(proj) {
    const pts = [
      [BBOX.lonMin, BBOX.latMin], [BBOX.lonMin, BBOX.latMax],
      [BBOX.lonMax, BBOX.latMin], [BBOX.lonMax, BBOX.latMax],
    ].map(p => proj(p)).filter(Boolean);
    if (pts.length < 2) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys),
             w: Math.max(...xs) - Math.min(...xs),
             h: Math.max(...ys) - Math.min(...ys) };
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 1.  HILLSHADE
   *
   * Inserted into the DOM immediately AFTER #choro-svg so it sits above the
   * county fills but below #outline-svg (county borders).
   * No position or z-index changes to any existing element.
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
      hillshadeEl.src         = buildHillshadeUrl();
      hillshadeEl.crossOrigin = "anonymous";
      hillshadeEl.alt         = "";
      Object.assign(hillshadeEl.style, {
        position:      "absolute",
        pointerEvents: "none",
        opacity:       HILLSHADE_OPACITY,
        mixBlendMode:  "multiply",
        display:       "block",
      });
      hillshadeEl.addEventListener("load",  () => console.log("[addon] Hillshade loaded ✓"));
      hillshadeEl.addEventListener("error", () => console.warn("[addon] Hillshade image failed — check Network tab."));

      // Insert AFTER #choro-svg — DOM order places it above fills, below borders.
      const choroSvg = document.getElementById("choro-svg");
      if (choroSvg && choroSvg.parentNode) {
        choroSvg.parentNode.insertBefore(hillshadeEl, choroSvg.nextSibling);
      } else {
        container.appendChild(hillshadeEl);
      }
    }
    positionHillshade(proj, vb);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 2.  CITIES
   *
   * Inserted AFTER #outline-svg — above county borders, below #click-svg.
   * viewBox is synced on every call so cities scale correctly on resize.
   * ══════════════════════════════════════════════════════════════════════════ */

  let citySvgEl = null;

  function drawCities(proj, vb) {
    const NS = "http://www.w3.org/2000/svg";

    if (!citySvgEl) {
      citySvgEl = document.createElementNS(NS, "svg");
      citySvgEl.id = "cities-layer";
      Object.assign(citySvgEl.style, {
        position:      "absolute",
        top: "0", left: "0",
        width: "100%", height: "100%",
        pointerEvents: "none",
        overflow:      "visible",
      });

      // Insert AFTER #outline-svg — above borders, below click targets.
      const outlineSvg = document.getElementById("outline-svg");
      if (outlineSvg && outlineSvg.parentNode) {
        outlineSvg.parentNode.insertBefore(citySvgEl, outlineSvg.nextSibling);
      } else {
        document.getElementById(MAP_CONTAINER_ID).appendChild(citySvgEl);
      }
    }

    // Sync viewBox to match the choropleth SVG — critical for correct scaling.
    citySvgEl.setAttribute("viewBox", `0 0 ${vb.w} ${vb.h}`);

    citySvgEl.innerHTML = `
      <defs>
        <filter id="city-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.5"
                        flood-color="#000000" flood-opacity="0.35"/>
        </filter>
      </defs>`;

    const g = document.createElementNS(NS, "g");

    CITIES.forEach(city => {
      const pt = proj([city.lon, city.lat]);
      if (!pt || isNaN(pt[0])) return;
      const [cx, cy] = pt;
      const [dx, dy] = CITY_LABEL_OFFSET;

      const halo = document.createElementNS(NS, "circle");
      halo.setAttribute("cx", cx); halo.setAttribute("cy", cy);
      halo.setAttribute("r", CITY_DOT_RADIUS + 2.5);
      halo.setAttribute("fill", "rgba(255,255,255,0.72)");
      g.appendChild(halo);

      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
      dot.setAttribute("r",  CITY_DOT_RADIUS);
      dot.setAttribute("fill",         CITY_DOT_COLOR);
      dot.setAttribute("stroke",       "#ffffff");
      dot.setAttribute("stroke-width", "1.6");
      dot.setAttribute("filter",       "url(#city-shadow)");
      g.appendChild(dot);

      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("x", cx + dx); lbl.setAttribute("y", cy + dy);
      lbl.setAttribute("font-family",     "system-ui,-apple-system,sans-serif");
      lbl.setAttribute("font-size",       CITY_LABEL_SIZE);
      lbl.setAttribute("font-weight",     "700");
      lbl.setAttribute("fill",            "#111111");
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
      position: "fixed", top: "60px", right: "16px", zIndex: "9000",
      display: "flex", flexDirection: "column", gap: "6px",
      background: "rgba(15,23,42,0.85)", backdropFilter: "blur(6px)",
      borderRadius: "10px", padding: "10px 14px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
      fontSize: "12px", color: "#e2e8f0",
      fontFamily: "system-ui,sans-serif", userSelect: "none",
    });
    const makeRow = (text, id) => {
      const lbl = document.createElement("label");
      Object.assign(lbl.style, { display:"flex", alignItems:"center", gap:"8px", cursor:"pointer" });
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = true; cb.style.accentColor = "#60a5fa";
      cb.addEventListener("change", () => {
        const el = document.getElementById(id);
        if (el) el.style.display = cb.checked ? "" : "none";
      });
      lbl.append(cb, document.createTextNode(text));
      return lbl;
    };
    panel.append(makeRow("🏔  Hillshade", "hs-layer"), makeRow("📍  Cities", "cities-layer"));
    document.body.appendChild(panel);
  }

  /* ══════════════════════════════════════════════════════════════════════════
   * 4.  PNG DOWNLOAD
   * ══════════════════════════════════════════════════════════════════════════ */

  function addPngButton() {
    if (document.getElementById("png-dl-btn")) return;
    const style = document.createElement("style");
    style.textContent = `
      #png-dl-btn {
        position:fixed; bottom:24px; right:24px; z-index:9000;
        display:flex; align-items:center; gap:8px; padding:11px 20px;
        background:linear-gradient(135deg,#1e40af,#2563eb);
        color:#fff; border:none; border-radius:10px;
        font-size:14px; font-weight:700; font-family:system-ui,sans-serif;
        cursor:pointer; letter-spacing:.02em;
        box-shadow:0 4px 16px rgba(37,99,235,.45);
        transition:opacity .15s,transform .15s;
      }
      #png-dl-btn:hover  { opacity:.9; transform:translateY(-2px); }
      #png-dl-btn:active { transform:translateY(0); }
      #png-dl-btn:disabled { opacity:.5; cursor:wait; transform:none; }
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
        const canvas = await html2canvas(container, {
          useCORS: true, allowTaint: false, scale: 2, logging: false,
          ignoreElements: el => el.id === "png-dl-btn" || el.id === "addon-toggles",
        });
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = buildFilename();
        a.click();
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
   * 5.  MASTER UPDATE
   * ══════════════════════════════════════════════════════════════════════════ */

  function update() {
    const proj = window.__coProjection;
    if (typeof proj !== "function") return;
    const vb = getViewBox();
    if (!vb) return;
    const container = document.getElementById(MAP_CONTAINER_ID);
    if (!container) return;
    // Only set position if not already set — avoids breaking existing layout.
    if (getComputedStyle(container).position === "static")
      container.style.position = "relative";
    initHillshade(proj, vb, container);
    drawCities(proj, vb);
  }

  window.__addonUpdate = update;

  /* ══════════════════════════════════════════════════════════════════════════
   * 6.  BOOTSTRAP
   * ══════════════════════════════════════════════════════════════════════════ */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function waitForMap(ms = 250, limit = 120) {
    return new Promise((resolve, reject) => {
      let n = 0;
      const t = setInterval(() => {
        if (getViewBox() && typeof window.__coProjection === "function") {
          clearInterval(t); resolve();
        } else if (++n > limit) {
          clearInterval(t);
          reject(new Error("[addon] Timed out — set window.__coProjection = STATE.projection in initMap()."));
        }
      }, ms);
    });
  }

  async function bootstrap() {
    if (typeof html2canvas === "undefined")
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");

    addToggles();
    addPngButton();

    try { await waitForMap(); } catch (e) { console.error(e.message); return; }

    update();

    const container = document.getElementById(MAP_CONTAINER_ID);
    if (container && typeof ResizeObserver !== "undefined") {
      let timer;
      new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(update, 80); })
        .observe(container);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }

})();
