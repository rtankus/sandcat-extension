(() => {

  let pendingFixes = [];
  let overlayIframe = null;

  console.log("Overlay injection triggered");

  // =============================
// RECEIVE ACTIVE FLIGHT FIXES
// =============================

chrome.runtime.onMessage.addListener((msg) => {

if (msg.type === "FORCE_OPEN_OVERLAY") {

  const existing = document.getElementById("overlayRoot");
  if (existing) existing.remove();

  overlayIframe = null;

  injectOverlay();
  refreshActiveFlightPanel();

}


if (msg?.type === "ACTIVE_FLIGHT_UPDATED") {

  console.log("Active flight updated — refreshing panel", msg.icao);

  pendingFixes = [];

  overlayIframe?.contentWindow?.postMessage({
    type: "CLEAR_ROUTE"
  }, "*");

  refreshActiveFlightPanel();
}

if(msg.type === "ROUTE_FIX_STREAM"){
  console.log("Overlay stream fix:", msg.fix);

  if (!overlayIframe?.contentWindow || !appendFix(msg.fix)) {
  pendingFixes.push(msg.fix);
}
}

});

 chrome.storage.onChanged.addListener((changes, area) => {

  if (area !== "local") return;

  if (
    changes.adsb_active_flight_fixes ||
    changes.adsb_active_flight_route ||
    changes.adsb_active_flight_origin ||
    changes.adsb_active_flight_destination ||
    changes.adsb_active_flight_callsign ||
    changes.adsb_active_flight_icao
  ) {
    console.log("Flight storage update detected");

    if (overlayIframe?.contentWindow) {
      refreshActiveFlightPanel();
    }
  }

});

async function refreshActiveFlightPanel(){

  const data = await chrome.storage.local.get([
    "adsb_active_flight_route",
    "adsb_active_flight_fixes",
    "adsb_active_flight_origin",
    "adsb_active_flight_destination",
    "adsb_active_flight_callsign",
    "adsb_active_flight_info",
    "adsb_active_flight_icao"
  ]);

if (!overlayIframe?.contentWindow) return;

overlayIframe.contentWindow.postMessage({
  type: "ACTIVE_FLIGHT_DATA",
  data
}, "*");

}

const existing = document.getElementById("overlayRoot");

if (existing) {
  existing.style.display = "block";
} else {
  injectOverlay();
  refreshActiveFlightPanel();
}

  function injectOverlay() {
if (document.getElementById("overlayRoot")) return;

    const BASE_WIDTH = 1100;
    const BASE_HEIGHT = 700;
    const ASPECT = BASE_WIDTH / BASE_HEIGHT;
      let lastExpandedWidth = BASE_WIDTH;

    const overlay = document.createElement("div");
    overlay.id = "overlayRoot";

    overlay.style.cssText = `
  position: fixed;
  width: ${BASE_WIDTH}px;
  height: ${BASE_HEIGHT}px;
  min-width: 400px;
  min-height: 300px;
  z-index: 2147483647;
  background: transparent;
  top: 80px;
  left: 80px;
`;

  document.body.appendChild(overlay);
  /* =============================
     SCALE WRAPPER
  ============================== */

  const scaleWrapper = document.createElement("div");
  scaleWrapper.style.cssText = `
  width: ${BASE_WIDTH}px;
  height: calc(${BASE_HEIGHT}px - 42px);
  transform-origin: top left;
  position: absolute;
  top: 42px;
  left: 0;
`;

  /* =============================
     HEADER
  ============================== */

const header = document.createElement("div");
header.style.cssText = `
  height: 42px;
  background: linear-gradient(135deg, #0f172a, #111827);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  cursor: grab;
  font-weight: 600;
  color: white;
  text-shadow: 0 0 8px rgba(255,255,255,0.12);
  border-top-left-radius: 18px;
  border-top-right-radius: 18px;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
`;

header.innerHTML = `
  <span id="overlay-title">Nearby Airports + LBX</span>

  <div style="display:flex; align-items:center; gap:10px;">

    <span id="airport-open-mini"
      title="Open Selected Now"
      style="
        cursor:pointer;
        font-size:14px;
        opacity:0.7;
        padding:2px 6px;
        border-radius:6px;
      "
    >▶</span>

    <span id="airport-minimize" style="cursor:pointer;">—</span>
    <span id="airport-close" style="cursor:pointer;">✕</span>

  </div>
`;


// 🔥 IMPORTANT: define AFTER innerHTML
const titleEl = header.querySelector("#overlay-title");
// add kitty icon
const kittyIcon = document.createElement("img");

kittyIcon.src = chrome.runtime.getURL("sandcat-icon-32.png");
/**kittyIcon.src = chrome.runtime.getURL("icon-32.png");**/

kittyIcon.width = 18;
kittyIcon.height = 18;
kittyIcon.style.marginRight = "6px";
kittyIcon.style.verticalAlign = "middle";
kittyIcon.style.display = "inline-block";
kittyIcon.style.objectFit = "contain";

const titleText = document.createElement("span");
titleText.textContent = "SandCat";

titleEl.innerHTML = "";
titleEl.appendChild(kittyIcon);
titleEl.appendChild(titleText);

function extractICAO(raw) {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const match = upper.match(/(?<![A-Z])[KPC][A-Z]{3}(?![A-Z])/);
  return match ? match[0] : null;
}

function updateHeaderICAO() {
  chrome.storage.local.get(["lb_pageKey", "lb_manualKey"], (data) => {
  const raw = data.lb_pageKey || data.lb_manualKey || "";
    const icao = extractICAO(raw);

   titleText.textContent = icao
  ? `SandCat — ${icao}`
  : "SandCat";

  });
}

// run once
updateHeaderICAO();

// listen for changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.lb_pageKey || changes.lb_manualKey)) {
    updateHeaderICAO();
  }
});


const closeBtn = header.querySelector("#airport-close");
const minimizeBtn = header.querySelector("#airport-minimize");
const openMiniBtn = header.querySelector("#airport-open-mini");
openMiniBtn.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
});

closeBtn.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  e.preventDefault();
  overlay.style.display = "none";
});

closeBtn.addEventListener("click", () => {

  chrome.storage.local.set({
    overlayOpen: false,
    overlayPosition: {
      left: overlay.offsetLeft,
      top: overlay.offsetTop
    },
    overlaySize: {
      width: overlay.offsetWidth
    }
  });
overlay.style.display = "none";
});

minimizeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  overlay.dataset.collapsed === "true" ? expand() : collapse();
});

openMiniBtn.addEventListener("click", async (e) => {

  e.stopPropagation(); // prevent collapse toggle

  const { lbx_settings, lb_pageKey, lb_manualKey } =
    await chrome.storage.local.get([
      "lbx_settings",
      "lb_pageKey",
      "lb_manualKey"
    ]);

  const rawText = (lb_pageKey || lb_manualKey || "").trim();
  if (!rawText) return;

  const s = lbx_settings || {};
  const settings = {
    adsb:        s.adsb        ?? true,
    opennav:     s.opennav     ?? false,
    airnav:      s.airnav      ?? false,
    foreflight:  s.foreflight  ?? false,
    fixesfinder: s.fixesfinder ?? false,
    skyvector:   s.skyvector   ?? false,
    adsbSpeed:   s.adsbSpeed   ?? 500,
  };

  chrome.runtime.sendMessage({ type: "RUN_AUTOLAUNCH", rawText, settings });

});

  /* =============================
     IFRAME
  ============================== */

const iframe = document.createElement("iframe");
overlayIframe = iframe;
iframe.src = chrome.runtime.getURL("popup.html");
iframe.style.cssText = `
  border: none;
  width: 100%;
  height: 100%;
  display: block;
`;

/* 🔥 ADD THIS BLOCK BACK */
overlay.appendChild(header);
overlay.appendChild(scaleWrapper);
scaleWrapper.appendChild(iframe);
iframe.addEventListener("load", () => {

  console.log("Overlay iframe ready");


  if (pendingFixes.length) {
    console.log("Flushing pending fixes:", pendingFixes.length);

    pendingFixes.forEach(fix => appendFix(fix));
    pendingFixes = [];
  }

});

/* =============================
   STABLE INVISIBLE EDGE RESIZE
============================= */

const EDGE = 18;
const MIN_W = 400;

const edgeLayer = document.createElement("div");
// after header/scaleWrapper appended

const HEADER_H = 42;

edgeLayer.style.position = "absolute";
edgeLayer.style.left = "0";
edgeLayer.style.right = "0";
edgeLayer.style.top = HEADER_H + "px";                 // ✅ start below header
edgeLayer.style.bottom = "0";
edgeLayer.style.pointerEvents = "none";
edgeLayer.style.zIndex = "2147483647";

overlay.appendChild(edgeLayer);

function createEdge(where) {
  const el = document.createElement("div");
  el.dataset.edge = where;
  el.style.position = "absolute";
  el.style.pointerEvents = "auto";
  el.style.background = "transparent";

  if (where === "l") { el.style.left=0; el.style.top=0; el.style.bottom=0; el.style.width=EDGE+"px"; el.style.cursor="ew-resize"; }
  if (where === "r") { el.style.right=0; el.style.top=0; el.style.bottom=0; el.style.width=EDGE+"px"; el.style.cursor="ew-resize"; }
  if (where === "b") { el.style.left=0; el.style.right=0; el.style.bottom=0; el.style.height=EDGE+"px"; el.style.cursor="ns-resize"; }
  if (where === "bl") { el.style.left=0; el.style.bottom=0; el.style.width=EDGE*1.5+"px"; el.style.height=EDGE*1.5+"px"; el.style.cursor="nesw-resize"; }
  if (where === "br") { el.style.right=0; el.style.bottom=0; el.style.width=EDGE*1.5+"px"; el.style.height=EDGE*1.5+"px"; el.style.cursor="nwse-resize"; }

  edgeLayer.appendChild(el);
  return el;
}

const resizeEdges = ["l","r","b","bl","br"].map(createEdge);

let resizing = false;
let activePointer = null;
let dir = null;
let sx=0, sy=0, sw=0, sh=0, sl=0, st=0;

function startResize(e, direction) {
  if (overlay.dataset.collapsed === "true") return;

  resizing = true;
  activePointer = e.pointerId;
  dir = direction;

  sx = e.clientX;
  sy = e.clientY;
  sw = overlay.offsetWidth;
  sh = overlay.offsetHeight;
  sl = overlay.offsetLeft;
  st = overlay.offsetTop;

  overlay.setPointerCapture(e.pointerId);
  iframe.style.pointerEvents = "none";
  e.preventDefault();
}

function appendFix(fix){

  if (!overlayIframe?.contentWindow) return false;

  overlayIframe.contentWindow.postMessage({
    type: "ROUTE_FIX_STREAM",
    fix
  }, "*");

  return true;
}

function doResize(e) {
  if (!resizing || e.pointerId !== activePointer) return;

  const dx = e.clientX - sx;
  const dy = e.clientY - sy;

  let newWidth = sw;
  let newLeft = sl;
  let newTop = st;

  if (dir.includes("r")) {
    newWidth = sw + dx;
  }

  if (dir.includes("l")) {
    newWidth = sw - dx;
    newLeft = sl + dx;
  }

  if (dir.includes("b")) {
    newWidth = sw + dy * ASPECT;
  }

  if (dir.includes("t")) {
    newWidth = sw - dy * ASPECT;
    newTop = st + (sh - newWidth / ASPECT);
  }

  newWidth = Math.max(MIN_W, newWidth);
  const newHeight = newWidth / ASPECT;

  overlay.style.width = newWidth + "px";
  overlay.style.height = newHeight + "px";
  overlay.style.left = newLeft + "px";
  overlay.style.top = newTop + "px";
}

function stopResize(e) {
  if (!resizing || e.pointerId !== activePointer) return;

  resizing = false;
  activePointer = null;

  overlay.releasePointerCapture(e.pointerId);
  iframe.style.pointerEvents = "auto";

  chrome.storage.local.set({
    overlaySize: { width: overlay.offsetWidth },
    overlayPosition: { left: overlay.offsetLeft, top: overlay.offsetTop }
  });
}

resizeEdges.forEach(edge => {
  edge.addEventListener("pointerdown", e => startResize(e, edge.dataset.edge));
});

overlay.addEventListener("pointermove", doResize);
overlay.addEventListener("pointerup", stopResize);
overlay.addEventListener("pointercancel", () => {
  resizing = false;
  activePointer = null;
  iframe.style.pointerEvents = "auto";
});


function setEdgeLayerVisible(expanded) {
  edgeLayer.style.display = expanded ? "block" : "none";
}


  /* =============================
     SCALE LOGIC
  ============================== */

  function applyScale() {
    if (overlay.dataset.collapsed === "true") {
      scaleWrapper.style.transform = "scale(1)";
      return;
    }
    const scale = overlay.offsetWidth / BASE_WIDTH;
    scaleWrapper.style.transform = `scale(${scale})`;
  }

  new ResizeObserver(applyScale).observe(overlay);


function updatePointerMode() {
  const collapsed = overlay.dataset.collapsed === "true";

  overlay.style.pointerEvents = collapsed ? "none" : "auto";
  header.style.pointerEvents = "auto";
}

function updateMiniButton() {
  openMiniBtn.style.display =
    overlay.dataset.collapsed === "true"
      ? "inline-block"
      : "none";
}
  /* =============================
     COLLAPSE / EXPAND
  ============================== */
function collapse() {
    overlay.dataset.collapsed = "true";
  updateMiniButton();

  // Save expanded width
  lastExpandedWidth = overlay.offsetWidth;

  // Hide scaled content
  scaleWrapper.style.display = "none";
  iframe.style.display = "none";

  // 🔥 CRITICAL: shrink overlay completely
  overlay.style.width = "auto";
  overlay.style.height = header.offsetHeight + "px";

  // Remove scaling constraints
  overlay.style.minWidth = "unset";
  overlay.style.minHeight = "unset";

  // Glass styling ONLY on header
  overlay.style.background = "transparent";
  overlay.style.backdropFilter = "none";
  overlay.style.border = "none";
  overlay.style.boxShadow = "none";

  header.style.backdropFilter = "blur(14px)";
  header.style.background = "rgba(15, 23, 42, 0.75)";
  header.style.border = "1px solid rgba(255,255,255,0.08)";
  header.style.borderRadius = "22px";
overlay.style.borderRadius = "22px";
  header.style.boxShadow = "0 10px 25px rgba(0,0,0,0.4)";
  setEdgeLayerVisible(false);

  updatePointerMode();

  chrome.storage.local.set({
    overlayMinimized: true,
    overlaySize: { width: lastExpandedWidth }
  });
}


function expand() {
    overlay.dataset.collapsed = "false";
  updateMiniButton();
// 🔥 CRITICAL FIX
  updatePointerMode();
  const width = lastExpandedWidth || BASE_WIDTH;

  overlay.style.width = width + "px";
  overlay.style.height = (width / ASPECT) + "px";

  overlay.style.minWidth = "400px";
  overlay.style.minHeight = "300px";

  overlay.style.background = "transparent";
  overlay.style.border = "none";
  overlay.style.boxShadow = "none";

  header.style.backdropFilter = "none";
  header.style.background = "linear-gradient(135deg, #0f172a, #111827)";
  header.style.border = "none";
  header.style.borderRadius = "18px 18px 0 0";
overlay.style.borderRadius = "18px";
  header.style.boxShadow = "none";

  scaleWrapper.style.display = "block";
  iframe.style.display = "block";
  setEdgeLayerVisible(true);

  applyScale();

  chrome.storage.local.set({ overlayMinimized: false });
}

  /* =============================
     DRAG
  ============================== */

  let offsetX = 0;
  let offsetY = 0;
  let dragMoved = false;

  header.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragMoved = false;
    header.setPointerCapture(e.pointerId);
    offsetX = e.clientX - overlay.offsetLeft;
    offsetY = e.clientY - overlay.offsetTop;
  });

  header.addEventListener("pointermove", (e) => {
    if (!header.hasPointerCapture(e.pointerId)) return;
    dragMoved = true;
    const newLeft = e.clientX - offsetX;
let newTop = e.clientY - offsetY;

// 🚫 Prevent going above viewport
if (newTop < 0) newTop = 0;

overlay.style.left = Math.max(0, newLeft) + "px";
overlay.style.top = Math.max(0, newTop) + "px";
  });

 header.addEventListener("pointerup", (e) => {
  if (!header.hasPointerCapture(e.pointerId)) return;
  header.releasePointerCapture(e.pointerId);

  try {
  chrome.storage?.local?.set({
    overlayPosition: {
      top: overlay.offsetTop,
      left: overlay.offsetLeft
    }
  });
} catch (e) {
  console.warn("Extension context lost, skipping storage write");
}

  // 🔥 DO NOT toggle if click was on control buttons
  if (e.target.closest("#airport-close") || e.target.closest("#airport-minimize")) {
    return;
  }

  if (!dragMoved) {
    overlay.dataset.collapsed === "true" ? expand() : collapse();
  }
});


  /* =============================
     RESTORE STATE
  ============================== */

   chrome.storage.local.get(
  ["overlayPosition","overlaySize","overlayMinimized"],
  (data) => {

    let top = data.overlayPosition?.top ?? 80;
    let left = data.overlayPosition?.left ?? 80;

    // Prevent off-screen spawn
    top = Math.max(0, top);
    left = Math.max(0, left);

    overlay.style.top = top + "px";
    overlay.style.left = left + "px";

    if (data.overlaySize?.width) {
      lastExpandedWidth = data.overlaySize.width;
    }

    data.overlayMinimized ? collapse() : expand();
  }
);

  } // closes injectOverlay()


function createKeyDisplayOverlay() {
  if (document.getElementById("scKeyDisplay")) return;

  const MONTH_FULL = {
    jan:"January", feb:"February", mar:"March", apr:"April", may:"May", jun:"June",
    jul:"July", aug:"August", sep:"September", oct:"October", nov:"November", dec:"December"
  };
  const MONTH_NUM = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const FACILITY_MAP = {
    gnd:"Ground", twr:"Tower", app:"Approach", appr:"Approach", dep:"Departure",
    radar:"Radar", ctr:"Center", center:"Center", centre:"Center", arr:"Arrival",
    del:"Delivery", clnc:"Clearance", clr:"Clearance", atis:"ATIS",
    fin:"Final", final:"Final", ctrl:"Control"
  };

  function parseKey(raw) {
    if (!raw) return null;
    const compact = raw.match(/^([A-Za-z]{2,4})-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}_/);
    if (compact) {
      return {
        icao: compact[1].toUpperCase(), facilities: [],
        month: MONTH_NUM[parseInt(compact[3], 10) - 1] || compact[3],
        day: parseInt(compact[4], 10), year: compact[2],
        time: compact[5] + compact[6] + "Z"
      };
    }
    const dateM = raw.match(/-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{1,2})-(\d{4})-(\d{4}Z)/i);
    if (!dateM) return null;
    const tokens = raw.substring(0, dateM.index).split("-");
    return {
      icao: tokens[0].replace(/\d+$/, "").toUpperCase(),
      facilities: tokens.slice(1).map(t => FACILITY_MAP[t.toLowerCase()]).filter(Boolean),
      month: MONTH_FULL[dateM[1].toLowerCase()] || dateM[1],
      day: parseInt(dateM[2], 10), year: dateM[3], time: dateM[4].toUpperCase()
    };
  }

  const card = document.createElement("div");
  card.id = "scKeyDisplay";
  card.style.cssText = [
    "position:fixed", "bottom:20px", "right:20px", "z-index:2147483646",
    "background:rgba(13,14,20,0.93)", "backdrop-filter:blur(10px)",
    "-webkit-backdrop-filter:blur(10px)",
    "border:1px solid rgba(255,255,255,0.10)", "border-radius:12px",
    "padding:12px 14px 10px 14px", "min-width:220px", "max-width:300px",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 6px 24px rgba(0,0,0,0.55),0 1px 3px rgba(0,0,0,0.3)",
    "display:none", "cursor:move", "user-select:none"
  ].join(";");

  const closeBtn = document.createElement("button");
  closeBtn.id = "scKeyClose";
  closeBtn.textContent = "×";
  closeBtn.style.cssText = [
    "position:absolute", "top:6px", "right:8px", "background:none", "border:none",
    "color:rgba(255,255,255,0.35)", "font-size:16px", "line-height:1",
    "cursor:pointer", "padding:2px 4px", "border-radius:4px"
  ].join(";");
  closeBtn.addEventListener("mouseenter", () => { closeBtn.style.color = "rgba(255,255,255,0.75)"; });
  closeBtn.addEventListener("mouseleave", () => { closeBtn.style.color = "rgba(255,255,255,0.35)"; });
  function notifyGkVisibility(visible) {
    overlayIframe?.contentWindow?.postMessage({ type: "GK_OVERLAY_VISIBLE", visible }, "*");
  }

  closeBtn.addEventListener("click", (e) => { e.stopPropagation(); card.style.display = "none"; notifyGkVisibility(false); });

  const content = document.createElement("div");
  content.id = "scKeyContent";
  card.appendChild(closeBtn);
  card.appendChild(content);
  document.body.appendChild(card);

  let dragging = false, ox = 0, oy = 0;
  card.addEventListener("pointerdown", (e) => {
    if (e.target === closeBtn || e.target.id === "scKeyLaunch") return;
    dragging = true;
    card.setPointerCapture(e.pointerId);
    const r = card.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    card.style.left = (e.clientX - ox) + "px";
    card.style.top = (e.clientY - oy) + "px";
    card.style.right = "auto";
    card.style.bottom = "auto";
  });
  card.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    try {
      chrome.storage.local.set({ keyOverlayPosition: { top: card.offsetTop, left: card.offsetLeft } });
    } catch(e) {}
  });

  const lookupName = (icao) => new Promise(resolve =>
    chrome.runtime.sendMessage({ type: "GET_AIRPORT_NAME_ICAO", icao }, (r) => resolve(r?.ok ? r.name : null))
  );

  async function updateDisplay(raw) {
    const parsed = parseKey(raw);
    if (!parsed) { card.style.display = "none"; return; }

    let airportName = "";
    try {
      airportName = await lookupName(parsed.icao) || "";
      if (!airportName && parsed.icao.length === 3) {
        airportName = await lookupName("K" + parsed.icao) || "";
      }
    } catch(e) {}

    const nameHtml = `<div style="font-size:13px;font-weight:600;color:#e8e8f0;line-height:1.35;padding-right:14px">${airportName || parsed.icao}</div>`;
    const servHtml = parsed.facilities.length
      ? `<div style="font-size:11.5px;color:#7eb8f5;margin-top:3px;font-weight:500">${parsed.facilities.join(" · ")}</div>`
      : "";
    const dateHtml = `<div style="font-size:10.5px;color:rgba(255,255,255,0.4);margin-top:7px;display:flex;justify-content:space-between;align-items:center"><span>${parsed.month} ${parsed.day}, ${parsed.year}</span><span style="font-weight:500;color:rgba(255,255,255,0.55)">${parsed.time}</span><span id="scKeyLaunch" title="Open Selected Now" style="cursor:pointer;opacity:0.5;font-size:11px;padding:1px 4px;border-radius:4px;transition:opacity 0.15s">▶</span></div>`;

    content.innerHTML = nameHtml + servHtml + dateHtml;

    const launchBtn = content.querySelector("#scKeyLaunch");
    if (launchBtn) {
      launchBtn.addEventListener("mouseenter", () => { launchBtn.style.opacity = "1"; });
      launchBtn.addEventListener("mouseleave", () => { launchBtn.style.opacity = "0.5"; });
      launchBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const { lbx_settings, lb_pageKey, lb_manualKey } = await chrome.storage.local.get(["lbx_settings", "lb_pageKey", "lb_manualKey"]);
        const rawText = (lb_pageKey || lb_manualKey || "").trim();
        if (!rawText) return;
        const s = lbx_settings || {};
        chrome.runtime.sendMessage({ type: "RUN_AUTOLAUNCH", rawText, settings: {
          adsb: s.adsb ?? true, opennav: s.opennav ?? false, airnav: s.airnav ?? false,
          foreflight: s.foreflight ?? false, fixesfinder: s.fixesfinder ?? false,
          skyvector: s.skyvector ?? false, adsbSpeed: s.adsbSpeed ?? 500
        }});
      });
    }

    card.style.display = "block";
    notifyGkVisibility(true);
  }

  chrome.storage.local.get(["lb_pageKey", "lb_manualKey", "keyOverlayPosition"], (data) => {
    if (data.keyOverlayPosition) {
      const maxLeft = window.innerWidth - 240;
      const maxTop = window.innerHeight - 80;
      card.style.bottom = "auto";
      card.style.right = "auto";
      card.style.top = Math.min(Math.max(0, data.keyOverlayPosition.top), maxTop) + "px";
      card.style.left = Math.min(Math.max(0, data.keyOverlayPosition.left), maxLeft) + "px";
    }
    updateDisplay(data.lb_pageKey || data.lb_manualKey || "");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.lb_pageKey && !changes.lb_manualKey)) return;
    chrome.storage.local.get(["lb_pageKey", "lb_manualKey"], (data) => {
      updateDisplay(data.lb_pageKey || data.lb_manualKey || "");
    });
  });

  function clampToViewport() {
    if (card.style.display === "none") return;
    const maxLeft = window.innerWidth - card.offsetWidth - 8;
    const maxTop = window.innerHeight - card.offsetHeight - 8;
    if (card.style.left) card.style.left = Math.min(Math.max(0, parseInt(card.style.left)), maxLeft) + "px";
    if (card.style.top) card.style.top = Math.min(Math.max(0, parseInt(card.style.top)), maxTop) + "px";
  }
  window.addEventListener("resize", clampToViewport);
}

createKeyDisplayOverlay();

window.addEventListener("message", (e) => {
  if (e.data?.type === "SHOW_GK_OVERLAY") {
    const card = document.getElementById("scKeyDisplay");
    if (card) { card.style.display = "block"; overlayIframe?.contentWindow?.postMessage({ type: "GK_OVERLAY_VISIBLE", visible: true }, "*"); }
  }
  if (e.data?.type === "GET_GK_VISIBILITY") {
    const card = document.getElementById("scKeyDisplay");
    overlayIframe?.contentWindow?.postMessage({ type: "GK_OVERLAY_VISIBLE", visible: card?.style.display !== "none" && !!card }, "*");
  }
});

})(); // closes IIFE