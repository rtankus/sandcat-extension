chrome.runtime.onMessage.addListener((msg, sender) => {
  console.log("MESSAGE RECEIVED IN BACKGROUND:", msg);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["inject_overlay.js"]
    });
  } catch (err) {
    console.error("Injection failed:", err);
  }
  
});

chrome.storage.onChanged.addListener((changes) => {

  if (changes.adsb_active_flight_callsign) {
    console.log(
      "%cCALLSIGN STORAGE CHANGE",
      "color:yellow;font-weight:bold",
      changes.adsb_active_flight_callsign.oldValue,
      "→",
      changes.adsb_active_flight_callsign.newValue
    );
  }

});

/* ===== ADSB DEBUG LOGGER ===== */

const DBG = (...a) => console.log("%c[ADSB]", "color:#00e0ff;font-weight:bold", ...a);

chrome.storage.onChanged.addListener((changes) => {

  if (changes.adsb_last_icao)
    DBG("Aircraft selected:", changes.adsb_last_icao.newValue);

  if (changes.adsb_active_flight_fixes)
    DBG("Fixes rebuilt:", changes.adsb_active_flight_fixes.newValue?.length || 0);

  if (changes.adsb_active_flight_fixes_at)
    DBG("Fix timestamp:", new Date(changes.adsb_active_flight_fixes_at.newValue).toLocaleTimeString());

});

importScripts("fflate.js", "csv.js", "db.js", "geo.js");let ADSB_TAB_ID = null;
const ADSB_TAB_KEY = "adsb_tab_id";
const OPENNAV_TAB_KEY = "opennav_tab_id";
const AIRNAV_TAB_KEY = "airnav_tab_id";
const SKYVECTOR_TAB_KEY = "skyvector_tab_id";
const FF_TAB_KEY = "foreflight_tab_id";
const FIXESFINDER_TAB_KEY = "fixesfinder_tab_id";
const SETTINGS_KEY = "lbx_settings";
const LB_KEY = "lb_pageKey";
const NAVAID_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
let lastAutoOpenedKey = null;
let USER_OVERRIDE_UNTIL = 0;
const AIRWAY_FIX_SET = new Set();

let NAVAID_INDEX = null; // { HNL: { ident,name,type,freq,lat,lon }, ... }

// ==========================================
// FIX INDEX (waypoints / intersections)
// ==========================================

let MASTER_FIX_INDEX = [];   // [{ident, lat, lon}]

let FACILITY_FREQ_INDEX = [];
let FIX_GRID = new Map();    // "lat|lon" -> [fixes]
let VFR_VISUAL_GRID = new Map(); // separate grid for AU VFR visual waypoints (30 NM display)

let AIRPORT_CACHE = null;
let AIRPORT_MAP = new Map();
 const PROC_ROUTE_MEM_INDEX = new Map();
// 🔥 Fast in-memory approach cache
// 🔥 In-memory performance caches
const APPROACH_MEM_CACHE = new Map();      // already added
const SIDSTAR_MEM_INDEX = new Map();
const RUNWAY_MEM_CACHE = new Map();        // airportId -> runways[]
const BIN_MEM_CACHE = new Map();           // "lat|lon" -> [airportIds]
const FIX_PROC_INDEX = new Map();


let AIRWAY_INDEX = {};
let lastProcessedIcao = null;
// key: IDENT (uppercased) -> { approaches, meta, note }

let GLOBAL_WAYPOINTS = [];
let GLOBAL_NAVAIDS = [];
let GLOBAL_POINTS = [];

let AUS_PROC_DB = {};
let AUS_PROC_BY_ICAO = {};

let SWISS_AD2_DB = {};

let IRELAND_PROC_DB = {};

let AUS_VFR_VISUAL_WAYPOINTS = [];

// ==========================================
// GITHUB DATA UPDATE
// ==========================================

const GITHUB_RAW = {
  BASE: "https://raw.githubusercontent.com/rtankus/sandcat-extension/main/",
  files: [
    "waypoints.csv",
    "navaids.csv",
    "aus_waypoints_complete.json",
    "australia_vfr_visual_waypoints.json",
    "swiss_ad2_sandcat.json"
  ]
};

async function getCachedFile(filename) {
  try {
    const cache = await caches.open("sandcat-data");
    const resp = await cache.match(GITHUB_RAW.BASE + filename);
    if (!resp) return null;
    return filename.endsWith(".json") ? resp.json() : resp.text();
  } catch {
    return null;
  }
}

async function updateDataFiles(onProgress) {
  const cache = await caches.open("sandcat-data");
  const results = { updated: [], failed: [] };
  for (const filename of GITHUB_RAW.files) {
    try {
      onProgress?.(`Fetching ${filename}…`);
      const resp = await fetch(GITHUB_RAW.BASE + filename);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await cache.put(GITHUB_RAW.BASE + filename, resp.clone());
      results.updated.push(filename);
    } catch (e) {
      results.failed.push(filename);
    }
  }
  await chrome.storage.local.set({ dataLastUpdated: Date.now() });
  return results;
}

async function loadSwissProcedures() {
  try {
    const cached = await getCachedFile("swiss_ad2_sandcat.json");
    if (cached) {
      SWISS_AD2_DB = cached;
    } else {
      const url = chrome.runtime.getURL("swiss_ad2_sandcat.json");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed loading Swiss procedures: ${res.status}`);
      SWISS_AD2_DB = await res.json();
    }
    console.log(`Loaded Swiss AD2 procedures: ${Object.keys(SWISS_AD2_DB).length} airports`);
  } catch (err) {
    console.error("Swiss procedure load failed:", err);
  }
}

loadSwissProcedures();

async function loadAustraliaProcedures() {
  try {
    const cached = await getCachedFile("aus_waypoints_complete.json");
    AUS_PROC_DB = cached ?? await (async () => {
      const url = chrome.runtime.getURL("aus_waypoints_complete.json");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed loading AU procedures: ${res.status}`);
      return res.json();
    })();
    AUS_PROC_BY_ICAO = {};

    for (const [airportName, data] of Object.entries(AUS_PROC_DB)) {
      const match = airportName.match(/\(([A-Z0-9]{4})\)/);
      if (!match) continue;

      const icao = match[1].toUpperCase();

      AUS_PROC_BY_ICAO[icao] = {
        icao,
        airportName,
        procedures: data.procedures || {},
        comms: data.comms || []
      };
    }

    console.log(
      `Loaded Australia procedures: ${Object.keys(AUS_PROC_BY_ICAO).length} airports`
    );
  } catch (err) {
    console.error("Australia procedure load failed:", err);
  }
}

loadAustraliaProcedures();

async function loadIrelandProcedures() {
  try {
    const url = chrome.runtime.getURL("ireland_procedures.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const raw = await res.json();
    IRELAND_PROC_DB = raw.airports || {};
    console.log(`Loaded Ireland procedures: ${Object.keys(IRELAND_PROC_DB).length} airports`);
  } catch (err) {
    console.error("Ireland procedure load failed:", err);
  }
}
loadIrelandProcedures();

async function loadAusVfrVisualWaypoints() {
  try {
    const cached = await getCachedFile("australia_vfr_visual_waypoints.json");
    if (cached) {
      AUS_VFR_VISUAL_WAYPOINTS = cached;
    } else {
      const url = chrome.runtime.getURL("australia_vfr_visual_waypoints.json");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed loading AUS VFR visual waypoints: ${res.status}`);
      AUS_VFR_VISUAL_WAYPOINTS = await res.json();
    }
    console.log(`Loaded AUS VFR visual waypoints: ${AUS_VFR_VISUAL_WAYPOINTS.length}`);
    addVfrVisualWaypointsToFixGrid();
  } catch (err) {
    console.error("AUS VFR visual waypoints load failed:", err);
  }
}

loadAusVfrVisualWaypoints();

const GLOBAL_BY_IDENT = new Map();
const GLOBAL_GRID = new Map();

const GLOBAL_DATA_READY = {
  waypoints: false,
  navaids: false,
  all: false
};


function safeUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function safeStr(v) {
  return String(v || "").trim();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dmsToDecimal(str) {
  if (!str) return null;

  const s = String(str).trim();
  const m = s.match(/(\d+)[°]\s*(\d+)'\s*(\d+(?:\.\d+)?)"\s*([NSEW])/i);
  if (!m) return null;

  const deg = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const hemi = m[4].toUpperCase();

  let val = deg + (min / 60) + (sec / 3600);
  if (hemi === "S" || hemi === "W") val *= -1;
  return val;
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const R_KM = 6371;
  const toRad = (d) => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R_KM * c * 0.539957;
}

function globalGridKey(lat, lon, sizeDeg = 1) {
  return `${Math.floor(lat / sizeDeg)}:${Math.floor(lon / sizeDeg)}:${sizeDeg}`;
}

function parseCsvText(text) {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }

    if (ch === "\r") {
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] ?? "";
    });
    return obj;
  });
}

function normalizeWaypoint(row) {
  // CSV headers may be "IDENT,LAT,LON" (decimal) or "Ident,Latitude,Longitude" (DMS) — handle both
  const ident = safeUpper(
    row["IDENT"] || row["Ident"] || row["ident"] || ""
  );
  const country = safeUpper(
    row["Country Code"] || row["COUNTRY CODE"] || row["country code"] || row["Country_Code"] || ""
  );
  const countryName = safeStr(
    row["Country Name"] || row["COUNTRY NAME"] || row["country name"] || ""
  );

  // Prefer decimal columns (LAT/LON); fall back to DMS columns (Latitude/Longitude)
  let lat = toNum(row["LAT"] ?? row["lat"]);
  let lon = toNum(row["LON"] ?? row["lon"]);
  if (lat == null) lat = dmsToDecimal(row["Latitude"] || row["LATITUDE"] || "");
  if (lon == null) lon = dmsToDecimal(row["Longitude"] || row["LONGITUDE"] || "");

  if (!ident || lat == null || lon == null) return null;

  return {
    ident,
    name: ident,
    kind: "waypoint",
    subtype: null,
    country,
    countryName,
    airport: null,
    lat,
    lon,
    searchText: `${ident} WAYPOINT ${country} ${countryName}`.toUpperCase()
  };
}

function normalizeNavaid(row) {
  const ident = safeUpper(row["ident"]);
  const name = safeStr(row["name"]);
  const subtype = safeUpper(row["type"]);
  const country = safeUpper(row["country code"]);
  const airport = safeUpper(row["airport"]) || null;
  const lat = toNum(row["latitude"]);
  const lon = toNum(row["longitude"]);

  if (!ident || lat == null || lon == null) return null;

  return {
    ident,
    name: name || ident,
    kind: "navaid",
    subtype: subtype || null,
    country,
    countryName: null,
    airport,
    lat,
    lon,
    searchText: `${ident} ${name} ${subtype} ${country} ${airport || ""}`.toUpperCase()
  };
}

async function loadBundledCsvText(filename) {
  const cached = await getCachedFile(filename);
  if (cached) return cached;

  const url = chrome.runtime.getURL(filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: ${res.status}`);

  const buf = await res.arrayBuffer();
  const decoder = new TextDecoder("latin1");
  return decoder.decode(buf);
}

async function loadGlobalWaypoints() {
  const text = await loadBundledCsvText("waypoints.csv");
  const rows = parseCsvText(text);

  GLOBAL_WAYPOINTS = rows
    .map(normalizeWaypoint)
    .filter(Boolean);

  GLOBAL_DATA_READY.waypoints = true;
  console.log("[Sandcat] Loaded global waypoints:", GLOBAL_WAYPOINTS.length);
}

async function loadGlobalNavaids() {
  const text = await loadBundledCsvText("navaids.csv");
  const rows = parseCsvText(text);

  GLOBAL_NAVAIDS = rows
    .map(normalizeNavaid)
    .filter(Boolean);

  GLOBAL_DATA_READY.navaids = true;
  console.log("[Sandcat] Loaded global navaids:", GLOBAL_NAVAIDS.length);
}

function buildGlobalIndexes() {
  GLOBAL_POINTS = [...GLOBAL_WAYPOINTS, ...GLOBAL_NAVAIDS];

  GLOBAL_BY_IDENT.clear();
  GLOBAL_GRID.clear();

  for (const pt of GLOBAL_POINTS) {
    if (!GLOBAL_BY_IDENT.has(pt.ident)) {
      GLOBAL_BY_IDENT.set(pt.ident, []);
    }
    GLOBAL_BY_IDENT.get(pt.ident).push(pt);

    const key = globalGridKey(pt.lat, pt.lon, 1);
    if (!GLOBAL_GRID.has(key)) {
      GLOBAL_GRID.set(key, []);
    }
    GLOBAL_GRID.get(key).push(pt);
  }

  GLOBAL_DATA_READY.all = true;
  console.log("[Sandcat] Built global indexes:", {
    total: GLOBAL_POINTS.length,
    idents: GLOBAL_BY_IDENT.size,
    gridCells: GLOBAL_GRID.size
  });
}

async function ensureGlobalDataLoaded() {
  if (GLOBAL_DATA_READY.all) return;

  await Promise.all([
    loadGlobalWaypoints(),
    loadGlobalNavaids()
  ]);

  buildGlobalIndexes();
  addWaypointsToFixGrid();
}

function scoreGlobalPoint(pt, q, countryFilter = "") {
  let score = 0;
  const ident = pt.ident || "";
  const name = safeUpper(pt.name);
  const subtype = safeUpper(pt.subtype);
  const country = safeUpper(pt.country);

  if (ident === q) score += 1000;
  else if (ident.startsWith(q)) score += 700;
  else if (ident.includes(q)) score += 400;

  if (name === q) score += 300;
  else if (name.startsWith(q)) score += 180;
  else if (name.includes(q)) score += 90;

  if (subtype && subtype.includes(q)) score += 60;
  if (countryFilter && country === countryFilter) score += 120;

  if (pt.kind === "navaid") score += 10;

  return score;
}

function searchGlobalPoints(query, opts = {}) {
  const q = safeUpper(query);
  if (!q) return [];

  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;
  const countryFilter = safeUpper(opts.country || "");

  let candidates = [];

  if (GLOBAL_BY_IDENT.has(q)) {
    candidates.push(...GLOBAL_BY_IDENT.get(q));
  }

  for (const pt of GLOBAL_POINTS) {
    if (countryFilter && safeUpper(pt.country) !== countryFilter) continue;

    if (
      pt.ident.includes(q) ||
      safeUpper(pt.name).includes(q) ||
      safeUpper(pt.subtype).includes(q) ||
      safeUpper(pt.searchText).includes(q)
    ) {
      candidates.push(pt);
    }
  }

  const seen = new Set();
  candidates = candidates.filter(pt => {
    const key = `${pt.kind}|${pt.ident}|${pt.lat}|${pt.lon}|${pt.country}|${pt.subtype || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return candidates
    .map(pt => ({ ...pt, _score: scoreGlobalPoint(pt, q, countryFilter) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}

function findNearbyGlobalPoints(lat, lon, radiusNm = 25, limit = 50, countryFilter = "") {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const sizeDeg = 1;
  const baseLat = Math.floor(lat / sizeDeg);
  const baseLon = Math.floor(lon / sizeDeg);
  const candidates = [];

  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const key = `${baseLat + dLat}:${baseLon + dLon}:${sizeDeg}`;
      const arr = GLOBAL_GRID.get(key);
      if (arr?.length) candidates.push(...arr);
    }
  }

  return candidates
    .filter(pt => !countryFilter || safeUpper(pt.country) === safeUpper(countryFilter))
    .map(pt => ({
      ...pt,
      distanceNm: distanceNm(lat, lon, pt.lat, pt.lon)
    }))
    .filter(pt => pt.distanceNm <= radiusNm)
    .sort((a, b) => a.distanceNm - b.distanceNm)
    .slice(0, limit);
}

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");

  const dp = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) dp[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j - 1] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j] + 1
        );
      }
    }
  }

  return dp[b.length][a.length];
}

function fuzzyChars(str, pattern) {
  let i = 0;
  for (const c of str) {
    if (c === pattern[i]) i++;
    if (i === pattern.length) return true;
  }
  return false;
}

function fuzzyGlobalScore(pt, query) {
  const q = safeUpper(query);
  if (!q) return 0;

  const ident = safeUpper(pt.ident);
  const name = safeUpper(pt.name);
  const subtype = safeUpper(pt.subtype);
  const country = safeUpper(pt.country);
  const countryName = safeUpper(pt.countryName);
  const blob = `${ident} ${name} ${subtype} ${country} ${countryName}`.trim();

  let score = 0;

  if (ident === q) score += 1200;
  else if (ident.startsWith(q)) score += 800;
  else if (ident.includes(q)) score += 500;

  if (name === q) score += 400;
  else if (name.startsWith(q)) score += 260;
  else if (name.includes(q)) score += 180;

  if (subtype && subtype.includes(q)) score += 90;
  if (country === q || countryName.includes(q)) score += 70;

  if (fuzzyChars(ident, q)) score += 120;
  if (fuzzyChars(name, q)) score += 80;

  const identDist = levenshtein(ident, q);
  const nameDist = levenshtein(name.slice(0, Math.max(name.length, q.length)), q);

  score += Math.max(0, 60 - identDist * 12);
  score += Math.max(0, 40 - nameDist * 8);

  if (blob.includes(q)) score += 40;

  return score;
}

function getGlobalCountries() {
  const map = new Map();

  for (const pt of GLOBAL_POINTS) {
    const code = safeUpper(pt.country);
    const name = safeStr(pt.countryName) || code;
    if (!code) continue;

    if (!map.has(code)) {
      map.set(code, name);
    }
  }

  return Array.from(map.entries())
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.code.localeCompare(b.code));
}


(async () => {
  try {
    const meta = await DB.getMeta();
    if (!meta?.nasrLoadedAt) return;

    const airports = await DB.getAllProcIndexes?.(); // if you add this helper
  } catch {}
})();

// Once user presses Play, we stop all auto-pausing for that tab
const ADSB_AUTOPAUSE_DISABLED_BY_TAB = new Map(); // tabId -> true/false

function replayKeyFromUrl(url) {
  try {
    const u = new URL(url);
    // Your urls look like ?replay=YYYY-MM-DD-HH:MM&airport=KXXX
    return u.searchParams.get("replay") || "";
  } catch {
    return "";
  }
}
/**
 * Data sources:
 * - OurAirports airports.csv + runways.csv (location + runways)
 * - FAA NASR 28-day subscription:
 *    - DP_APT.csv + DP_RTE.csv  (DP/SID names + route fixes)
 *    - STAR_APT.csv + STAR_RTE.csv + STAR_BASE.csv (STAR names + route fixes)
 * - FAA d-TPP Metafile XML (official):
 *    - Extract IAP (approach) chart names per airport (names only)
 */
/* -------------------- Auto-load CIFP from extension directory -------------------- */

async function loadLocalCifpZip() {
  
  try {
    const url = chrome.runtime.getURL("cifp.zip");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch bundled CIFP zip");

    const buf = await res.arrayBuffer();
    const u8 = new Uint8Array(buf);

    const filesObj = unzipTextFiles(u8);
    console.log("ZIP file list:", Object.keys(filesObj));
    const cifpName = pickFileName(filesObj, [/^FAACIFP/i, /CIFP/i]);

    if (!cifpName || !filesObj[cifpName]) {
      throw new Error("No FAACIFP file found inside ZIP.");
    }

    const raw = filesObj[cifpName];

if (typeof raw === "string") {
  CIFP_TEXT = raw;
} else {
  CIFP_TEXT = new TextDecoder("utf-8").decode(raw);
}

console.log("Loaded CIFP length:", CIFP_TEXT.length);
    CIFP_META = {
      file: cifpName,
      size: CIFP_TEXT.length,
      loadedAt: Date.now(),
      srcName: "bundled"
    };
buildCifpIndex();
buildFixDatabaseFromCIFP();
if (NAVAID_INDEX) {
  addNavaidsToFixGrid();
}
if (GLOBAL_WAYPOINTS.length) {
  addWaypointsToFixGrid();
  console.log("Re-added waypoints to fix grid after CIFP load:", MASTER_FIX_INDEX.length);
}
if (AUS_VFR_VISUAL_WAYPOINTS.length) {
  addVfrVisualWaypointsToFixGrid();
}

console.log("Total fixes:", MASTER_FIX_INDEX.length);

const pietz = MASTER_FIX_INDEX.find(f => f[0] === "PIETZ");
console.log("PIETZ FIX:", pietz);

console.log("CIFP loaded from extension:", cifpName);
  } catch (e) {
    console.error("Failed to auto-load CIFP:", e);
  }
}

// Load immediately when service worker starts
let CIFP_TEXT = null;
let CIFP_META = null;
let CIFP_INDEX = {};
loadLocalCifpZip();

loadOurAirportsNavaids()
  .then(() => {
    addNavaidsToFixGrid();
    console.log("Global navaids merged into fix grid:", MASTER_FIX_INDEX.length);
  })
  .catch(console.error);

// 🔥 preload procedures so FIX_PROC_INDEX is ready
ensureNasrProceduresLoaded().catch(console.error);
ensureGlobalDataLoaded().catch(err => {
  console.error("[Sandcat] Global data init failed", err);
});


const OUR = {
  AIRPORTS_URL: "https://davidmegginson.github.io/ourairports-data/airports.csv",
  RUNWAYS_URL: "https://davidmegginson.github.io/ourairports-data/runways.csv",
  REFRESH_MS: 7 * 24 * 60 * 60 * 1000
};

const FAA_NASR = {
  INDEX_URL: "https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/",
  REFRESH_MS: 14 * 24 * 60 * 60 * 1000
};

const FAA_DTPP = {
  SEARCH_URL: "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/search/",
  META_REFRESH_MS: 24 * 60 * 60 * 1000,        // refresh Metafile link daily
  XML_MEM_CACHE_MS: 6 * 60 * 60 * 1000,        // keep XML in memory for 6 hours
  APPROACH_CACHE_MS: 14 * 24 * 60 * 60 * 1000  // persist approaches 2 weeks
};


function phoneticNormalize(s) {

  return s
    .toUpperCase()
    .replace(/[AEIOU]/g, "")
    .replace(/PH/g,"F")
    .replace(/CK/g,"K")
    .replace(/Q/g,"K")
    .replace(/Z/g,"S");
}

function phoneticScore(a,b){

  const pa = phoneticNormalize(a);
  const pb = phoneticNormalize(b);

  if (pa === pb) return 10;
  if (pa.startsWith(pb)) return 5;
  if (pb.startsWith(pa)) return 5;

  return 0;
}

function fuzzyScore(a,b){

  a = a.toUpperCase();
  b = b.toUpperCase();

  if (a.includes(b)) return 3;

  let score = 0;

  for (let i=0;i<b.length;i++){
    if(a[i] === b[i]) score++;
  }

  return score >= 2 ? 2 : 0;
}

function uniqSorted(arr) {
  return Array.from(new Set((arr || []).map(s => String(s).trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}
function normKey(s) { return String(s || "").trim().toUpperCase(); }

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}
async function fetchBytes(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
function unzipTextFiles(zipBytes) {
  if (typeof fflate === "undefined") throw new Error("fflate not loaded (fflate.js missing or not importScripts’d).");
  const files = fflate.unzipSync(zipBytes);
  const out = {};
  for (const [name, bytes] of Object.entries(files)) out[name] = new TextDecoder("utf-8").decode(bytes);
  return out;
}
function pickFileName(filesObj, preferredRegexes) {
  const names = Object.keys(filesObj);
  for (const re of preferredRegexes) {
    const found = names.find(n => re.test(n));
    if (found) return found;
  }
  return names[0] || null;
}
function isPublicishAirport(type) {
  return type === "large_airport" || type === "medium_airport" || type === "small_airport";
}

function cleanHtmlText(str) {
  return String(str || "")
    .replace(/<[^>]*>/g, " ")      // remove HTML tags
    .replace(/&nbsp;/gi, " ")     // remove non-breaking spaces
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")         // collapse whitespace
    .trim();
}

function parseCifpLatLon(str) {

  const latHem = str[0];
  const latDeg = parseInt(str.substring(1,3));
  const latMin = parseInt(str.substring(3,5));
  const latSec = parseInt(str.substring(5,9)) / 100;   // <-- fix

  const lonHem = str[9];
  const lonDeg = parseInt(str.substring(10,13));
  const lonMin = parseInt(str.substring(13,15));
  const lonSec = parseInt(str.substring(15,19)) / 100; // <-- fix

  let lat = latDeg + latMin/60 + latSec/3600;
  let lon = lonDeg + lonMin/60 + lonSec/3600;

  if (latHem === "S") lat *= -1;
  if (lonHem === "W") lon *= -1;

  return { lat, lon };
}

function buildFixDatabaseFromCIFP() {

  if (!CIFP_TEXT) return;

  console.log("Building FIX database...");

  MASTER_FIX_INDEX = [];
  FIX_GRID.clear();

  const FIX_SEEN = new Set();

  const lines = CIFP_TEXT.split(/\r?\n/);

  for (const line of lines) {

    if (!line.startsWith("SUS")) continue;

    const coordMatch = line.match(/[NS]\d{8}[EW]\d{9}/);
    if (!coordMatch) continue;

    const ident = line.substring(13,18).trim();

// skip procedure geometry / garbage
if (
  ident.length < 3 ||
  /\d/.test(ident) ||        // IECC1, ISEE0
  ident === "PAB" ||
  ident === "PAD"
) continue;

    if (!/^[A-Z0-9]{3,5}$/.test(ident)) continue;
    if (ident.startsWith("RW")) continue;

    try {

      const { lat, lon } = parseCifpLatLon(coordMatch[0]);

      // ✅ deduplicate fixes

const fix = [ident, lat, lon];

// dedupe key
const dedupeKey = ident + "|" + lat.toFixed(2) + "|" + lon.toFixed(2);

if (FIX_SEEN.has(dedupeKey)) continue;
FIX_SEEN.add(dedupeKey);

MASTER_FIX_INDEX.push(fix);

// spatial grid key
const grid = gridKey(lat, lon);

if (!FIX_GRID.has(grid))
  FIX_GRID.set(grid, []);

FIX_GRID.get(grid).push(fix);

    } catch(e) {}

  }

  console.log("Total fixes loaded:", MASTER_FIX_INDEX.length);
  console.log("Grid cells:", FIX_GRID.size);
}
/* -------------------- OurAirports load -------------------- */

async function ensureOurAirportsLoaded() {
  const meta = (await DB.getMeta()) || {};
  const now = Date.now();
  if (meta.ourLoadedAt && (now - meta.ourLoadedAt) < OUR.REFRESH_MS) {

  if (!AIRPORT_MAP.size || !BIN_MEM_CACHE.size || !RUNWAY_MEM_CACHE.size) {

  const airports = await DB.getAllAirports();
  const bins = await DB.getAllBins?.();
  const runways = await DB.getAllRunways?.();

  AIRPORT_MAP.clear();
  for (const a of airports) {
    AIRPORT_MAP.set(a.id, a);
  }

  BIN_MEM_CACHE.clear();
  if (bins) {
    for (const [k, v] of bins) {
      BIN_MEM_CACHE.set(k, v);
    }
  }

  RUNWAY_MEM_CACHE.clear();
  if (runways) {
    for (const [k, v] of runways) {
      RUNWAY_MEM_CACHE.set(k, v);
    }
  }
}

  return;
}

  const [airportsCsv, runwaysCsv] = await Promise.all([
    fetchText(OUR.AIRPORTS_URL),
    fetchText(OUR.RUNWAYS_URL)
  ]);

  const airportsRows = parseCSV(airportsCsv);
  const runwaysRows = parseCSV(runwaysCsv);

  const airports = [];
  const lookup = new Map();

  for (const r of airportsRows) {
    const id = Number(r.id);
    const lat = Number(r.latitude_deg);
    const lon = Number(r.longitude_deg);
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const rec = {
      id,
      ident: (r.ident || "").toUpperCase(),
      type: r.type || "",
      name: r.name || "",
      lat,
      lon,
      country: r.iso_country || "",
      region: r.iso_region || "",
      municipality: r.municipality || "",
      gps_code: (r.gps_code || "").toUpperCase(),
      local_code: (r.local_code || "").toUpperCase(),
      iata_code: (r.iata_code || "").toUpperCase()
    };
    airports.push(rec);

    for (const key of [rec.ident, rec.gps_code, rec.local_code, rec.iata_code]) {
      if (key && !lookup.has(key)) lookup.set(key, id);
    }
  }

  const runwaysByAirportId = new Map();
  for (const r of runwaysRows) {
    const airport_ref = Number(r.airport_ref);
    if (!Number.isFinite(airport_ref)) continue;

    const rw = {
      ident1: (r.le_ident || "").toUpperCase(),
      ident2: (r.he_ident || "").toUpperCase(),
      length_ft: r.length_ft || "",
      width_ft: r.width_ft || "",
      surface: r.surface || "",
      lighted: r.lighted || "",
      closed: r.closed || ""
    };

    if (!runwaysByAirportId.has(airport_ref)) runwaysByAirportId.set(airport_ref, []);
    runwaysByAirportId.get(airport_ref).push(rw);
  }

RUNWAY_MEM_CACHE.clear();
for (const [id, rwys] of runwaysByAirportId.entries()) {
  RUNWAY_MEM_CACHE.set(id, rwys);
}

  const bins = new Map();
  for (const a of airports) {
    const key = binKey1deg(a.lat, a.lon);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(a.id);
  }
  BIN_MEM_CACHE.clear();
for (const [k, v] of bins.entries()) {
  BIN_MEM_CACHE.set(k, v);
}

  await DB.bulkPutAirports(airports);
  await DB.bulkPutLookup(Array.from(lookup.entries()));
  await DB.bulkPutBins(Array.from(bins.entries()));
  await DB.bulkPutRunways(Array.from(runwaysByAirportId.entries()));

  meta.ourLoadedAt = now;
  await DB.putMeta(meta);
  AIRPORT_CACHE = airports;
  AIRPORT_MAP.clear();

for (const a of airports) {
  AIRPORT_MAP.set(a.id, a);
}

}

/* -------------------- NASR helpers + load -------------------- */

async function findNasrCycleDate(preferPreview = true) {
  const html = await fetchText(FAA_NASR.INDEX_URL);

  const dates = [];
  const seen = new Set();

  const re1 = /NASR_Subscription\/(20\d{2}-\d{2}-\d{2})\/?/g;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const d = m[1];
    if (!seen.has(d)) { seen.add(d); dates.push(d); }
  }

  if (!dates.length) {
    const re2 = /(20\d{2}-\d{2}-\d{2})/g;
    while ((m = re2.exec(html)) !== null) {
      const d = m[1];
      if (!seen.has(d)) { seen.add(d); dates.push(d); }
    }
  }

  if (!dates.length) throw new Error("Could not find NASR cycle dates on NASR Subscription index page.");

  const preview = dates[0];
  const current = dates[1] || dates[0];
  return preferPreview ? preview : current;
}

async function findDpStarZipUrls(cycleDate) {
  const cycleUrl = `${FAA_NASR.INDEX_URL}${cycleDate}/`;
  const html = await fetchText(cycleUrl);

  const dp = html.match(/https:\/\/nfdc\.faa\.gov\/webContent\/28DaySub\/extra\/[^"']*DP_CSV\.zip/gi)?.[0] || null;
  const star = html.match(/https:\/\/nfdc\.faa\.gov\/webContent\/28DaySub\/extra\/[^"']*STAR_CSV\.zip/gi)?.[0] || null;

  if (!dp || !star) throw new Error(`Could not find DP_CSV.zip / STAR_CSV.zip on: ${cycleUrl}`);
  return { dpZipUrl: dp, starZipUrl: star };
}

function airportKeyVariants(arptId) {
  const a = normKey(arptId);
  const out = new Set();
  if (!a) return [];
  out.add(a);
  if (a.length === 3) out.add("K" + a);
  return Array.from(out);
}

async function ensureNasrProceduresLoaded() {

  const meta = (await DB.getMeta()) || {};
  const now = Date.now();

  const fresh =
    meta.nasrLoadedAt &&
    (now - meta.nasrLoadedAt) < FAA_NASR.REFRESH_MS;

  // ============================================================
  // 1️⃣ If DB is fresh, just rebuild memory from DB (fast path)
  // ============================================================

if (fresh) {

  if (SIDSTAR_MEM_INDEX.size === 0) {
    const allIndexes = await DB.getAllProcIndexes?.();
    if (allIndexes) {
      for (const [k, v] of allIndexes) {
        SIDSTAR_MEM_INDEX.set(k, v);
      }
    }
  }

  if (PROC_ROUTE_MEM_INDEX.size === 0) {
    const allRoutes = await DB.getAllProcRoutes?.();
    if (allRoutes) {
      for (const [k, v] of allRoutes) {
        PROC_ROUTE_MEM_INDEX.set(k, v);
      }
    }
  }

  // 🔥 REBUILD WAYPOINT → PROCEDURE INDEX
  FIX_PROC_INDEX.clear();

for (const [key, fixes] of PROC_ROUTE_MEM_INDEX.entries()) {

  const [type, airport, code, name] = key.split("|");

  for (const fix of fixes) {

    if (!FIX_PROC_INDEX.has(fix))
      FIX_PROC_INDEX.set(fix, []);

    FIX_PROC_INDEX.get(fix).push({
      type,
      code,
      name,
      airport
    });

  }

}

  return;
}

  // ============================================================
  // 2️⃣ Download fresh NASR data
  // ============================================================

  const cycleDate = await findNasrCycleDate(true);
  const { dpZipUrl, starZipUrl } =
    await findDpStarZipUrls(cycleDate);

  const [dpZipBytes, starZipBytes] =
    await Promise.all([
      fetchBytes(dpZipUrl),
      fetchBytes(starZipUrl)
    ]);

  const dpFiles = unzipTextFiles(dpZipBytes);
  const stFiles = unzipTextFiles(starZipBytes);

  const dpAptName  = pickFileName(dpFiles, [/DP_?APT\.csv$/i]);
  const dpRteName  = pickFileName(dpFiles, [/DP_?RTE\.csv$/i]);
  const stAptName  = pickFileName(stFiles, [/STAR_?APT\.csv$/i]);
  const stRteName  = pickFileName(stFiles, [/STAR_?RTE\.csv$/i]);
  const stBaseName = pickFileName(stFiles, [/STAR_?BASE\.csv$/i]);

  if (!dpAptName || !dpRteName)
    throw new Error("DP zip missing required CSVs.");

  if (!stAptName || !stRteName || !stBaseName)
    throw new Error("STAR zip missing required CSVs.");

  const dpApt = parseCSV(dpFiles[dpAptName]);
  const dpRte = parseCSV(dpFiles[dpRteName]);
  const stApt = parseCSV(stFiles[stAptName]);
  const stRte = parseCSV(stFiles[stRteName]);
  const stBase = parseCSV(stFiles[stBaseName]);

  // ============================================================
  // 3️⃣ Build STAR name lookup
  // ============================================================

  const starNameByCode = new Map();

  for (const r of stBase) {
    const code = String(r.STAR_COMPUTER_CODE || "").trim();
    const name = String(r.ARRIVAL_NAME || "").trim();
    if (code && name) starNameByCode.set(code, name);
  }

  // ============================================================
  // 4️⃣ Build per-airport SID/STAR index
  // ============================================================

  SIDSTAR_MEM_INDEX.clear();
  PROC_ROUTE_MEM_INDEX.clear();

  const perAirport = new Map();

  function ensureAptKey(k) {
    const kk = normKey(k);
    if (!perAirport.has(kk))
      perAirport.set(kk, { dep: new Map(), arr: new Map() });
    return perAirport.get(kk);
  }

  for (const r of dpApt) {
    const arpt = String(r.ARPT_ID || "").trim();
    const code = String(r.DP_COMPUTER_CODE || "").trim();
    const name = String(r.DP_NAME || "").trim();
    if (!arpt || !code || !name) continue;

    for (const k of airportKeyVariants(arpt)) {
      ensureAptKey(k).dep.set(name, code);
    }
  }

  for (const r of stApt) {
    const arpt = String(r.ARPT_ID || "").trim();
    const code = String(r.STAR_COMPUTER_CODE || "").trim();
    if (!arpt || !code) continue;

    const name = starNameByCode.get(code) || code;

    for (const k of airportKeyVariants(arpt)) {
      ensureAptKey(k).arr.set(name, code);
    }
  }

  for (const [aptKey, v] of perAirport.entries()) {

const departures =
  Array.from(v.dep.entries())
    .map(([name, code]) => {

      // extract revision from code
      const m = code.match(/([A-Z]+)(\d+)\./);

      const displayName = m
        ? `${m[1]} ${m[2]}`
        : name;

      return {
        name,
        code,
        displayName
      };

    })
    .sort((a,b)=>a.name.localeCompare(b.name));

const arrivals =
  Array.from(v.arr.entries())
    .map(([name, code]) => {

      const m = code.match(/([A-Z]+)(\d+)/);

      const displayName = m
        ? `${m[1]} ${m[2]}`
        : name;

      return {
        name,
        code,
        displayName
      };

    })
    .sort((a,b)=>a.name.localeCompare(b.name));

    const obj = { departures, arrivals };

    await DB.putProcIndex(aptKey, obj);
    SIDSTAR_MEM_INDEX.set(aptKey, obj);
  }

  // ============================================================
  // 5️⃣ Build procedure route fix index
  // ============================================================

  function addFix(set, f) {
    const x = String(f || "").trim().toUpperCase();
    if (!x) return;
    if (x.startsWith("RW")) return;
    set.add(x);
  }

  const dpFixesByKey = new Map();

for (const r of dpRte) {

  const code = String(r.DP_COMPUTER_CODE || "").trim();
  const name = String(r.DP_NAME || "").trim();
  if (!code || !name) continue;

const airport = String(r.ARPT_ID || "").trim();

  const k = `SID|${airport}|${code}|${name}`;   // 🔥 MISSING LINE

  if (!dpFixesByKey.has(k))
    dpFixesByKey.set(k, new Set());

addFix(dpFixesByKey.get(k), r.POINT);
addFix(dpFixesByKey.get(k), r.NEXT_POINT);
addFix(dpFixesByKey.get(k), r.FIX_IDENT);
addFix(dpFixesByKey.get(k), r.WAYPOINT_IDENT);
addFix(dpFixesByKey.get(k), r.TRANSITION_POINT);
}

for (const [k, set] of dpFixesByKey.entries()) {

  const fixesArr = Array.from(set);

  await DB.putProcRoute(k, fixesArr);
  PROC_ROUTE_MEM_INDEX.set(k, fixesArr);

const [type, airport, code, name] = k.split("|");

  for (const fix of fixesArr) {

    if (!FIX_PROC_INDEX.has(fix))
      FIX_PROC_INDEX.set(fix, []);

FIX_PROC_INDEX.get(fix).push({
  type: "SID",
  code,
  name,
  airport
});

  }
}

  const stFixesByKey = new Map();

  for (const r of stRte) {
    const code = String(r.STAR_COMPUTER_CODE || "").trim();
    if (!code) continue;

    const name = starNameByCode.get(code) || code;
const airport = code.split(".")[1] || "";
const k = `STAR|${airport}|${code}|${name}`;

    if (!stFixesByKey.has(k))
      stFixesByKey.set(k, new Set());

addFix(stFixesByKey.get(k), r.POINT);
addFix(stFixesByKey.get(k), r.NEXT_POINT);
addFix(stFixesByKey.get(k), r.FIX_IDENT);
addFix(stFixesByKey.get(k), r.WAYPOINT_IDENT);
addFix(stFixesByKey.get(k), r.TRANSITION_POINT);
  }

for (const [k, set] of stFixesByKey.entries()) {

  const fixesArr = Array.from(set);

  await DB.putProcRoute(k, fixesArr);
  PROC_ROUTE_MEM_INDEX.set(k, fixesArr);

const [type, airport, code, name] = k.split("|");

  for (const fix of fixesArr) {

    if (!FIX_PROC_INDEX.has(fix))
      FIX_PROC_INDEX.set(fix, []);

const airport = code.split(".")[1] || "";

FIX_PROC_INDEX.get(fix).push({
  type: "STAR",
  code,
  name,
  airport
});

  }
}

  meta.nasrLoadedAt = now;
  meta.nasrCycleDate = cycleDate;
  await DB.putMeta(meta);
}

/* -------------------- d-TPP Metafile: URL discovery + XML parsing -------------------- */

async function ensureDtppMetafileUrl() {
  const meta = (await DB.getMeta()) || {};
  const now = Date.now();

  if (meta.dtppMetaUrl && meta.dtppMetaLoadedAt && (now - meta.dtppMetaLoadedAt) < FAA_DTPP.META_REFRESH_MS) {
    return { url: meta.dtppMetaUrl, cycle: meta.dtppMetaCycle || "" };
  }

  const html = await fetchText(FAA_DTPP.SEARCH_URL);

  const re = /https:\/\/aeronav\.faa\.gov\/d-tpp\/(\d{4})\/xml_data\/d-tpp_Metafile\.xml/gi;
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) hits.push({ cycle: m[1], url: m[0] });

  if (!hits.length) throw new Error("Could not find d-TPP Metafile XML link on FAA search page.");

  const best = hits[0]; // current listed first

  meta.dtppMetaUrl = best.url;
  meta.dtppMetaCycle = best.cycle;
  meta.dtppMetaLoadedAt = now;
  await DB.putMeta(meta);

  return { url: best.url, cycle: best.cycle };
}

// In-memory XML cache so clicking multiple airports doesn't keep downloading the XML.
let _dtppXmlMem = null; // { cycle, url, fetchedAt, xml }

async function getMetafileXmlMemoized() {
  const now = Date.now();
  const { url, cycle } = await ensureDtppMetafileUrl();

  if (
    _dtppXmlMem &&
    _dtppXmlMem.cycle === cycle &&
    _dtppXmlMem.url === url &&
    (now - _dtppXmlMem.fetchedAt) < FAA_DTPP.XML_MEM_CACHE_MS &&
    typeof _dtppXmlMem.xml === "string" &&
    _dtppXmlMem.xml.length > 1000
  ) {
    return _dtppXmlMem;
  }

  const xml = await fetchText(url);
  _dtppXmlMem = { cycle, url, fetchedAt: now, xml };
  return _dtppXmlMem;
}

function extractIapNamesFromMetafileXml(xmlText, airportIdent3, airportIcao4) {
  const wanted3 = normKey(airportIdent3).replace(/^K/, "");
  const wanted4 = normKey(airportIcao4);
  if (!wanted3 && !wanted4) return [];

  const idxCandidates = [];

  if (wanted3) {
    const reApt = new RegExp(`<airport_name\\b[^>]*\\bapt_ident="${wanted3}"[^>]*>`, "i");
    const m = xmlText.match(reApt);
    if (m && m.index != null) idxCandidates.push(m.index);
  }
  if (wanted4) {
    const reIcao = new RegExp(`<airport_name\\b[^>]*\\bicao_ident="${wanted4}"[^>]*>`, "i");
    const m = xmlText.match(reIcao);
    if (m && m.index != null) idxCandidates.push(m.index);
  }
  if (!idxCandidates.length) return [];

  const start = Math.min(...idxCandidates);
  const end = xmlText.indexOf("</airport_name>", start);
  if (end === -1) return [];
  const block = xmlText.slice(start, end);

  const out = new Set();
  const recRe = /<record\b[^>]*>([\s\S]*?)<\/record>/gi;
  let rm;
  while ((rm = recRe.exec(block)) !== null) {
    const rec = rm[1];

    const codeM = rec.match(/<chart_code>\s*([^<]+?)\s*<\/chart_code>/i);
    const code = (codeM?.[1] || "").trim().toUpperCase();
    if (code !== "IAP") continue;

    const nameM = rec.match(/<chart_name>\s*([\s\S]*?)\s*<\/chart_name>/i);
    const name = (nameM?.[1] || "").replace(/\s+/g, " ").trim();
    if (name) out.add(name);
  }

  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

async function getApproachNamesForAirport(a, allowLiveFetch) {

  const memKey = normKey(a.ident);

  // 🔥 1️⃣ Memory cache first (fastest possible path)
  if (APPROACH_MEM_CACHE.has(memKey)) {
    return APPROACH_MEM_CACHE.get(memKey);
  }

  const now = Date.now();
  const keyVariants = [
    normKey(a.local_code),
    normKey(a.ident),
    normKey(a.gps_code)
  ].filter(Boolean);

  // --------------------------------------------------
  // 2️⃣ IndexedDB cache check
  // --------------------------------------------------

  for (const k of keyVariants) {

    const cached = await DB.getApproachIndex(k);

    const fresh = cached &&
      cached.fetchedAt &&
      (now - cached.fetchedAt) < FAA_DTPP.APPROACH_CACHE_MS;

    const hasMeta = cached &&
      cached.meta &&
      cached.meta.cycle &&
      cached.meta.url;

    const nonEmpty =
      Array.isArray(cached?.approaches) &&
      cached.approaches.length > 0;

    // ✅ Valid cached non-empty result
    if (fresh && hasMeta && nonEmpty) {
      const result = {
        approaches: cached.approaches,
        meta: cached.meta,
        note: "cache_hit"
      };

      APPROACH_MEM_CACHE.set(memKey, result);
      return result;
    }

    // ✅ Valid cached empty result (cache-only mode)
    if (fresh && hasMeta && !nonEmpty && !allowLiveFetch) {
      const result = {
        approaches: [],
        meta: cached.meta,
        note: "cache_hit_empty"
      };

      APPROACH_MEM_CACHE.set(memKey, result);
      return result;
    }

    // 🔁 Fresh but empty AND live allowed → break and refetch
    if (fresh && hasMeta && !nonEmpty && allowLiveFetch) {
      break;
    }
  }

  // --------------------------------------------------
  // 3️⃣ If live fetch not allowed, stop here
  // --------------------------------------------------

  if (!allowLiveFetch) {
    const result = {
      approaches: [],
      meta: null,
      note: "cache_only"
    };

    APPROACH_MEM_CACHE.set(memKey, result);
    return result;
  }

  // --------------------------------------------------
  // 4️⃣ Live fetch from FAA XML
  // --------------------------------------------------

  const memo = await getMetafileXmlMemoized();

  const ident3 =
    normKey(a.local_code) ||
    normKey(a.ident).replace(/^K/, "") ||
    "";

  const icao4 =
    normKey(a.ident) ||
    (ident3 ? ("K" + ident3) : "");

  const approaches =
    extractIapNamesFromMetafileXml(memo.xml, ident3, icao4);

  const cacheObj = {
    approaches,
    fetchedAt: now,
    meta: {
      cycle: memo.cycle,
      url: memo.url
    }
  };

  // Persist to IndexedDB
  for (const k of keyVariants) {
    await DB.putApproachIndex(k, cacheObj);
  }

  const result = {
    approaches,
    meta: cacheObj.meta,
    note: "live_fetch"
  };

  // 🔥 Store in fast memory cache
  APPROACH_MEM_CACHE.set(memKey, result);

  return result;
}


async function loadOurAirportsNavaids() {

  if (NAVAID_INDEX) return;

  const now = Date.now();
  const meta = (await DB.getMeta()) || {};

  // 🔥 Check DB cache first
  if (
    meta.navaidLoadedAt &&
    (now - meta.navaidLoadedAt) < NAVAID_CACHE_MS
  ) {
    const cached = await DB.getNavaids();
    if (cached && Object.keys(cached).length > 0) {
      NAVAID_INDEX = cached;
      console.log("Navaids loaded from DB cache:", Object.keys(NAVAID_INDEX).length);
      return;
    }
  }

  // 🔥 Otherwise fetch fresh
  console.log("Fetching navaids.csv...");

  const url = "https://ourairports.com/data/navaids.csv";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch navaids.csv");

  const text = await res.text();
  const rows = parseCSV(text);

  const out = Object.create(null);

for (const r of rows) {

  const ident = String(r.ident || "").trim().toUpperCase();
  if (!ident) continue;



  const type = String(r.type || "").toUpperCase();

  const ok =
    type.includes("VOR") ||
    type.includes("VORTAC") ||
    type.includes("TACAN") ||
    type.includes("NDB");

  if (!ok) continue;

  out[ident] = {
    ident,
    name: String(r.name || "").trim(),
    type,
    freq: String(r.frequency_khz || r.frequency_mhz || "").trim(),
    lat: Number(r.latitude_deg),
    lon: Number(r.longitude_deg)
  };
}

  NAVAID_INDEX = out;

  // 🔥 Persist to DB
  await DB.putNavaids(out);

  meta.navaidLoadedAt = now;
  await DB.putMeta(meta);

  console.log("Navaids fetched + cached:", Object.keys(NAVAID_INDEX).length);
}

let AIRPORT_FREQ_INDEX = null;

async function loadOurAirportsFrequencies() {

  if (AIRPORT_FREQ_INDEX) return;

  console.log("Fetching airport-frequencies.csv...");

  const url = "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv";

  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch airport-frequencies.csv");

  const text = await res.text();
  const rows = parseCSV(text);

  const out = {};

  for (const r of rows) {

    const ident = String(r.airport_ident || "").toUpperCase();
    if (!ident) continue;

    const freq = String(r.frequency_mhz || "").trim();
    if (!freq) continue;

    const type = String(r.type || "").toUpperCase();
    const desc = String(r.description || "").trim();

    if (!out[ident]) out[ident] = [];

    out[ident].push({
      type,
      name: desc || type,
      freq
    });
  }

  AIRPORT_FREQ_INDEX = out;

  console.log("Frequencies loaded:", Object.keys(out).length);
}

let AUS_FREQ_INDEX = null;

function commLabelToType(label) {
  const up = (label || "").toUpperCase();
  if (up.includes("TOWER")) return "TWR";
  if (up.includes("APPROACH") || up.includes("APCH")) return "APP";
  if (up.includes("DEPARTURE")) return "DEP";
  if (up.includes("GROUND")) return "GND";
  if (up.includes("ATIS")) return "ATIS";
  if (up.includes("DELIVERY") || up.includes("CLEARANCE")) return "DEL";
  if (up.includes("RADAR")) return "RADAR";
  if (up.includes("CENTRE") || up.includes("CENTER") || up.includes(" CTR")) return "CTR";
  if (up.includes("UNICOM")) return "UNIC";
  return "COM";
}

async function loadAusFrequencies() {
  if (AUS_FREQ_INDEX) return;
  try {
    const url = chrome.runtime.getURL("aus_waypoints_complete.json");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load aus_waypoints_complete.json");
    const data = await res.json();
    const out = {};
    for (const [key, val] of Object.entries(data)) {
      const icaoMatch = key.match(/\(([A-Z]{4})\)/);
      if (!icaoMatch) continue;
      const icao = icaoMatch[1];
      const comms = val.comms || [];
      if (!comms.length) continue;
      out[icao] = comms.map(c => ({
        type: commLabelToType(c.label),
        name: c.label,
        freq: Number(c.freq) || c.freq
      }));
    }
    AUS_FREQ_INDEX = out;
    console.log("AU frequencies loaded:", Object.keys(out).length);
  } catch (err) {
    console.error("Failed to load aus_waypoints_complete.json:", err);
    AUS_FREQ_INDEX = {};
  }
}

function getEnrichedFreqs(ident) {
  if (!ident) return [];
  if (AUS_FREQ_INDEX?.[ident]?.length) return AUS_FREQ_INDEX[ident];
  const facilityEntries = (FACILITY_FREQ_INDEX || []).filter(f => f.airport === ident);
  if (facilityEntries.length) {
    return facilityEntries.map(f => ({
      type: commLabelToType(f.label),
      name: f.label,
      freq: Number(f.freq) || f.freq
    }));
  }
  return AIRPORT_FREQ_INDEX?.[ident] || [];
}






/* -------------------- Nearby search -------------------- */

async function gatherCandidates(lat, lon, radius_nm) {

  const radius_km = radius_nm * 1.852;
  const latDelta = radius_km / 111.0;
  const lonDelta = radius_km / Math.max(1e-6, (111.320 * Math.cos((lat * Math.PI) / 180)));

  const minLat = lat - latDelta;
  const maxLat = lat + latDelta;
  const minLon = lon - lonDelta;
  const maxLon = lon + lonDelta;

  const latMinDeg = Math.floor(minLat);
  const latMaxDeg = Math.floor(maxLat);
  const lonMinDeg = Math.floor(minLon);
  const lonMaxDeg = Math.floor(maxLon);

  const out = new Set();

  for (let la = latMinDeg; la <= latMaxDeg; la++) {
    for (let lo = lonMinDeg; lo <= lonMaxDeg; lo++) {
      const key = `${la}|${lo}`;
      const ids = BIN_MEM_CACHE.get(key);
      if (ids) for (const id of ids) out.add(id);
    }
  }

  return Array.from(out);
}
function getProcIndexForAirportRecord(a) {

  const keys = [
    normKey(a.ident),
    normKey(a.local_code),
    normKey(a.gps_code)
  ].filter(Boolean);

  for (const k of keys) {
    if (SIDSTAR_MEM_INDEX.has(k)) {
      return SIDSTAR_MEM_INDEX.get(k);
    }
  }

  return { departures: [], arrivals: [] };
}

function buildCifpIndex() {

  if (!CIFP_TEXT) return;

  console.log("Building CIFP index…");

  CIFP_INDEX = {};
  AIRWAY_INDEX = {};   // 🔥 reset airway index

  const lines = CIFP_TEXT.split(/\r?\n/);

  for (const line of lines) {

// =========================================
// SUSAP (standard approach records)
// =========================================
if (line.startsWith("SUSAP ")) {

  const approachKey = line.substring(6, 18).trim();
  if (!approachKey) continue;

  const fixField = line.substring(29, 34).trim();

  if (
    /^[A-Z]{3,5}$/.test(fixField) &&
    !fixField.startsWith("RW")
  ) {

    if (!CIFP_INDEX[approachKey]) {
      CIFP_INDEX[approachKey] = new Set();
    }

    CIFP_INDEX[approachKey].add(fixField);
  }
}

// =========================================
// SPACP (procedure path records — Hawaii etc)
// =========================================
else if (line.startsWith("SPACP ")) {

  const approachKey = line.substring(6, 18).trim();

  const fixField = line.substring(29,34).trim();

  if (
    /^[A-Z0-9]{3,5}$/.test(fixField) &&
    !fixField.startsWith("RW")
  ) {

    if (!CIFP_INDEX[approachKey]) {
      CIFP_INDEX[approachKey] = new Set();
    }

    CIFP_INDEX[approachKey].add(fixField);
  }
}

    // =========================================
// AIRWAY PARSING (FOR SUSAER FORMAT)
// =========================================
else if (line.startsWith("SUSAER")) {

  const airway = line.substring(13, 18).trim();

  // Extract fix after 4-digit sequence number
const match = line.match(/\d{4}\s*([A-Z0-9]{3,5})/);
  if (!match) continue;

  const fix = match[1].trim();

  if (!airway || !fix) continue;
  if (!/^[A-Z0-9]{3,6}$/.test(fix)) continue;

  if (!AIRWAY_INDEX[airway]) {
    AIRWAY_INDEX[airway] = [];
  }

  AIRWAY_INDEX[airway].push(fix);
}
  }

  // Convert approach Sets → arrays
  for (const k in CIFP_INDEX) {
    CIFP_INDEX[k] = Array.from(CIFP_INDEX[k]);
  }
  for (const k in AIRWAY_INDEX) {
  AIRWAY_INDEX[k] = Array.from(new Set(AIRWAY_INDEX[k]));

  // Build fast airway fix lookup
AIRWAY_FIX_SET.clear();

for(const airway in AIRWAY_INDEX){
  for(const f of AIRWAY_INDEX[airway]){
    AIRWAY_FIX_SET.add(f);
  }
}

console.log("Airway fix lookup size:", AIRWAY_FIX_SET.size);
}

  console.log("CIFP approaches:", Object.keys(CIFP_INDEX).length);
  console.log("Airways loaded:", Object.keys(AIRWAY_INDEX).length);
}

function reduceTrack(points, toleranceNm = 1) {

  if (points.length <= 2) return points;

  const result = [points[0]];

  simplifySection(points, 0, points.length - 1, toleranceNm, result);

  result.push(points[points.length - 1]);

  return result;
}

function simplifySection(points, start, end, toleranceNm, result) {

  let maxDist = 0;
  let index = -1;

  const a = points[start];
  const b = points[end];

  for (let i = start + 1; i < end; i++) {

    const p = points[i];

    const d = pointToSegmentNm(p, a, b);

    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist > toleranceNm) {

    simplifySection(points, start, index, toleranceNm, result);

    result.push(points[index]);

    simplifySection(points, index, end, toleranceNm, result);
  }
}

function pointToSegmentNm(p, a, b) {

  const A = { x: a.lon, y: a.lat };
  const B = { x: b.lon, y: b.lat };
  const P = { x: p.lon, y: p.lat };

  const ABx = B.x - A.x;
  const ABy = B.y - A.y;

  const t =
    ((P.x - A.x) * ABx + (P.y - A.y) * ABy) /
    (ABx * ABx + ABy * ABy);

  const clamped = Math.max(0, Math.min(1, t));

  const closest = {
    lon: A.x + clamped * ABx,
    lat: A.y + clamped * ABy
  };

  return haversineNm(
    p.lat,
    p.lon,
    closest.lat,
    closest.lon
  );
}
// ==========================================
// ROUTE RECONSTRUCTION
// ==========================================

function collapseFixSequence(list){

  const out = [];

  for(const f of list){

    if(!f) continue;

    if(out.length === 0 || out[out.length-1] !== f){
      out.push(f);
    }

  }

  return out;

}


function isAirwayFix(fix){
  return AIRWAY_FIX_SET.has(fix);
}

function compressAirways(fixList){

  const result = [];
  let i = 0;

  while(i < fixList.length){

    let bestMatch = null;

    for(let j = i + 2; j < fixList.length; j++){

      const a = fixList[i];
      const b = fixList[j];

      for(const airway in AIRWAY_INDEX){

        const fixes = AIRWAY_INDEX[airway];

        const ia = fixes.indexOf(a);
        const ib = fixes.indexOf(b);

        if(ia === -1 || ib === -1) continue;

        const span = Math.abs(ib - ia);

        if(span < 2) continue;

        bestMatch = {
          airway,
          endFix: b,
          endIndex: j,
          span
        };

      }

    }

    if(bestMatch){

      result.push(fixList[i]);
      result.push(bestMatch.airway);
      result.push(bestMatch.endFix);

      i = bestMatch.endIndex;
      continue;

    }

    result.push(fixList[i]);
    i++;

  }

  return collapseFixSequence(result);
}


function buildRouteString(routeParts){

  if(!routeParts?.length) return "";

  const out = [];

  for(const part of routeParts){

    if(!part) continue;

    out.push(part);

  }

  return out.join(" ");
}

async function detectAirportFromPoint(lat, lon) {

  await ensureOurAirportsLoaded();

if (!AIRPORT_MAP.size) {
  const airports = await DB.getAllAirports();
  for (const a of airports) {
    AIRPORT_MAP.set(a.id, a);
  }
}

if (!BIN_MEM_CACHE.size) {
  const bins = await DB.getAllBins();
  for (const [k,v] of bins) {
    BIN_MEM_CACHE.set(k,v);
  }
}

  const candidates = await gatherCandidates(lat, lon, 25); // 25 NM search

  let best = null;
  let bestDist = Infinity;

  for (const id of candidates) {

  const a = AIRPORT_MAP.get(id);
  if (!a) continue;

  // 🔴 FILTER OUT PRIVATE STRIPS / HELIPORTS
  if (!isPublicishAirport(a.type)) continue;

  const d = haversineNm(lat, lon, a.lat, a.lon);

  if (d < bestDist) {
    best = a;
    bestDist = d;
  }
}

  if (!best || bestDist > 15) return null; // require within 15 NM
console.log("Airport candidates:", candidates.length);
  return best.ident;
}

async function reconstructRouteFromTrack(points){
const start = points[0];
const end = points[points.length - 1];

  if(!points?.length) return { ok:false };

  const reduced = reduceTrack(points);

  console.log("Reduced track nodes:", reduced.length);

  let fixes = detectFixCrossings(reduced);

  fixes = collapseFixSequence(fixes);
  fixes = filterFixBacktracking(fixes);
  fixes = [...new Set(fixes)];

  console.log("Full route fixes:", fixes);

  const airwayRoute = compressAirways(fixes);

  const routeString = buildRouteString(airwayRoute);

  console.log("Airway compressed route:", airwayRoute);
  console.log("ATC route:", routeString);
const origin = await detectAirportFromPoint(start.lat, start.lon);
const destination = await detectAirportFromPoint(end.lat, end.lon);
const enrouteAirports = await findAirportsAlongTrack(reduced, 60);
const freqs = await buildFlightFreqs(origin, destination, enrouteAirports);
const vfrWaypoints = await findVfrWaypointsAlongTrack(reduced, 30);
  console.log("[VFR] Saving to storage:", vfrWaypoints.length, "waypoints");
  return {
  ok: true,
  fixes,
  routeParts: airwayRoute,
  routeString,
  origin,
  destination,
  freqs,
  vfrWaypoints
};
}

function extractFlightLeg(trace, replayTimeSec){

  const WINDOW = 5;
  const airborne = new Array(trace.length).fill(false);

  // classify airborne using rolling window
  for(let i=0;i<trace.length;i++){

    let score = 0;
    let count = 0;

    for(let j=i-Math.floor(WINDOW/2); j<=i+Math.floor(WINDOW/2); j++){

      if(j<0 || j>=trace.length) continue;

      const alt = trace[j][3];
      const spd = trace[j][4];

      if(alt > 1200 && spd > 80) score++;
      count++;

    }

    airborne[i] = score >= Math.ceil(count/2);
  }

  // build airborne segments
  const segments = [];
  let start = null;

  for(let i=0;i<trace.length;i++){

    if(airborne[i] && start === null){
      start = i;
    }

    if(!airborne[i] && start !== null){
      segments.push([start, i]);
      start = null;
    }

  }

  if(start !== null){
    segments.push([start, trace.length-1]);
  }

  if(!segments.length){
    console.log("No airborne segments detected");
    return trace;
  }

  // Merge segments separated by short signal gaps (ADS-B dropouts).
  // Real on-ground turnarounds take 30+ min; dropouts are seconds to minutes.
  const MAX_SIGNAL_GAP_SEC = 20 * 60;
  const merged = [];
  let cur = segments[0];

  for(let i = 1; i < segments.length; i++){
    const gapSec = trace[segments[i][0]][0] - trace[cur[1]][0];
    if(gapSec <= MAX_SIGNAL_GAP_SEC){
      cur = [cur[0], segments[i][1]];
    } else {
      merged.push(cur);
      cur = segments[i];
    }
  }
  merged.push(cur);

console.log("replayTimeSecOfDay:", replayTimeSec);
console.log("trace start/end:", trace[0]?.[0], trace[trace.length-1]?.[0]);
  // choose segment closest to replay time
// choose segment with largest displacement
// choose segment containing the replay time
let best = null;

for(const seg of merged){

  const startT = trace[seg[0]][0];
  const endT   = trace[seg[1]][0];

  console.log("Segment", seg, "time:", startT, "→", endT);

  if(replayTimeSec >= startT && replayTimeSec <= endT){
    best = seg;
    break;
  }

}

// fallback if replay time isn't inside any segment
if(!best){

  let bestDelta = Infinity;

  for(const seg of merged){

    const startT = trace[seg[0]][0];
    const endT   = trace[seg[1]][0];

    const mid = (startT + endT) / 2;
    const delta = Math.abs(mid - replayTimeSec);

    if(delta < bestDelta){
      bestDelta = delta;
      best = seg;
    }

  }

}

  const leg = trace.slice(best[0], best[1]);

  console.log("Segments detected:", segments.length, "→ merged:", merged.length);
  console.log("Chosen segment:", best);
  console.log("Flight leg points:", leg.length);

  const span = haversineNm(
    leg[0][1], leg[0][2],
    leg[leg.length-1][1], leg[leg.length-1][2]
  );

  console.log("Extracted leg span NM:", span);

  return leg;
}

function searchFixesNearby(lat, lon, radius_nm){

  const radiusDeg = radius_nm / 60;

  const latMin = lat - radiusDeg;
  const latMax = lat + radiusDeg;

  const lonMin = lon - radiusDeg;
  const lonMax = lon + radiusDeg;

  const results = [];
  const seen = new Set();

  for(let la = Math.floor(latMin*4)/4; la <= latMax; la += 0.25){
  for(let lo = Math.floor(lonMin*4)/4; lo <= lonMax; lo += 0.25){

    const laSnap = Math.round(la * 4) / 4;
    const loSnap = Math.round(lo * 4) / 4;

    const key = gridKey(laSnap, loSnap);

      const cell = FIX_GRID.get(key);
      if(!cell) continue;

      for(const fx of cell){

        const d = haversineNm(lat, lon, fx[1], fx[2]);

if (d <= radius_nm) {

          if (!seen.has(fx[0])) {
  seen.add(fx[0]);
  results.push(fx);
}

        }

      }

    }
  }

  return results;
}

function installPlaneSelectionWatcher(tabId){

  console.log("Installing ADSB watcher");

  chrome.scripting.executeScript({
    target:{tabId},
    files:["adsb_bridge.js"]
  });

  chrome.scripting.executeScript({
    target:{tabId},
    world:"MAIN",
    files:["adsb_hook.js"]
  });

}

async function extractAdsbRoute(tabId, forcedIcao) {

  const tab = await chrome.tabs.get(tabId);
  const u = new URL(tab.url);

  const replay = u.searchParams.get("replay");
  if (!replay) {
    return { ok:false, error:"Missing replay parameter" };
  }

  const icaoResult = await chrome.scripting.executeScript({
  target:{tabId},
  world:"MAIN",
  func: () => {

    // -----------------------------
    // 1️⃣ Detect selected aircraft
    // -----------------------------

    let icao = null;

    try {
      if (typeof selectedPlanes === "function") {
        const p = selectedPlanes();
        if (p?.length) {
          icao = p[0].icao || p[0].hex || p[0].icao24 || null;
        }
      }
    } catch(e){}

    // -----------------------------
    // 2️⃣ Read replay clock (UTC)
    // -----------------------------

    const getSecOfDayFromText = (txt) => {
      const m = String(txt || "").match(/(\d{2}):(\d{2}):(\d{2})\s*Z\b/i);
      if (!m) return null;

      const hh = +m[1];
      const mm = +m[2];
      const ss = +m[3];

      return hh*3600 + mm*60 + ss;
    };

    let secOfDay = null;

    const candidates = [
  document.querySelector("#replayClock")?.textContent,
  document.querySelector("#replayUTC")?.textContent,
  document.querySelector("#replayTime")?.textContent
];

    for (const t of candidates) {
      secOfDay = getSecOfDayFromText(t);
      if (secOfDay != null) break;
    }

    return { icao, secOfDay };
  }
});

const info = icaoResult?.[0]?.result;

const icao =
  forcedIcao ||
  info?.icao ||
  null;
const replaySec = (typeof info?.secOfDay === "number")
  ? info.secOfDay
  : replayParamToSecOfDay(replay);

if (!icao) return { ok:false, error:"No aircraft selected in replay" };
if (replaySec == null) return { ok:false, error:"Could not read replay time" };

  const [year, month, day] = replay.split("-");
  const shard = icao.slice(-2);

  const traceUrl =
    `https://globe.adsbexchange.com/globe_history/${year}/${month}/${day}/traces/${shard}/trace_full_${icao}.json`;

  let trace;

  // Try background fetch first — outside ADSBexchange's SW scope, so their
  // fetch-dedup interceptor can't block it. Requires no session cookies for public history.
  try {
    const r = await fetch(traceUrl);
    if (r.ok) {
      const data = await r.json();
      trace = data.trace || data;
    }
  } catch(e) {}

  // Fall back to in-page XHR if background fetch returned no data (e.g. auth required).
  // XHR carries session credentials and uses a different API than fetch, so
  // ADSBexchange's fetch-specific dedup interceptor won't block it.
  if (!Array.isArray(trace) || !trace.length) {
    const relUrl = `/globe_history/${year}/${month}/${day}/traces/${shard}/trace_full_${icao}.json`;
    let xhrResult;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        args: [relUrl],
        func: async (url) => {
          return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.withCredentials = true;
            xhr.open('GET', url);
            xhr.responseType = 'json';
            xhr.onload = () => xhr.status === 200
              ? resolve({ ok: true, trace: xhr.response?.trace || xhr.response })
              : resolve({ ok: false, error: `HTTP ${xhr.status}` });
            xhr.onerror = () => resolve({ ok: false, error: 'XHR error' });
            xhr.send();
          });
        }
      });
      xhrResult = res?.[0]?.result;
    } catch(e) {
      return { ok: false, error: `scripting error: ${e.message}` };
    }
    if (xhrResult?.ok && Array.isArray(xhrResult.trace) && xhrResult.trace.length) {
      trace = xhrResult.trace;
    } else {
      return { ok: false, error: xhrResult?.error || 'trace fetch failed' };
    }
  }
  const leg = extractFlightLeg(trace, replaySec);

  const points = leg
    .filter(p => p[1] && p[2])
    .map(p => ({
      lat: p[1],
      lon: p[2]
    }));

  return {
    ok:true,
    count:points.length,
    points
  };
}

function filterFixBacktracking(list, window = 10){

  const result = [];

  for(const f of list){

    if(!f) continue;

    const recent = result.slice(-window);

    if(recent.includes(f)) continue;

    result.push(f);

  }

  return result;

}


function extractSidStarNamesFromCifp(airportIdent) {

  if (!CIFP_TEXT) return { departures: [], arrivals: [] };

  const deps = new Set();
  const arrs = new Set();

  const lines = CIFP_TEXT.split(/\r?\n/);

  return {
    departures: Array.from(deps).sort(),
    arrivals: Array.from(arrs).sort()
  };
}


function parseGlobalKeyAirportDateTime(rawText) {
  const raw = String(rawText || "").trim();
  const upper = raw.toUpperCase();

  const MONTHS = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04",
    MAY: "05", JUN: "06", JUL: "07", AUG: "08",
    SEP: "09", OCT: "10", NOV: "11", DEC: "12"
  };

  const dateMatch = upper.match(
    /-([A-Z]{3})-(\d{1,2})-(\d{4})-(\d{4})Z\b/
  );

  if (!dateMatch) return null;

  const airport = extractAirportFromDashedKey(raw);
  const month = MONTHS[dateMatch[1]];
  const day = dateMatch[2].padStart(2, "0");
  const year = dateMatch[3];
  const hhmm = dateMatch[4];

  if (!month) return null;

  const hour = hhmm.slice(0, 2);
  const minute = hhmm.slice(2, 4);

  return {
    airport,
    replay: `${year}-${month}-${day}-${hour}:${minute}`,
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    format: "flex_dashed"
  };
}

function extractAirportFromDashedKey(rawKey) {
  const upper = String(rawKey || "").toUpperCase();

  const ignore = new Set([
    "NY", "APP", "DEP", "CENTER", "CENTRE", "CENT", "RADAR", "TOWER", "GROUND",
    "CTR", "FINAL", "FINA", "FREQ", "VAD", "GND", "TWR",
    "APPR", "ARR", "ARRIVAL", "DEPARTURE", "V2"
  ]);

  // ✅ Global key first token priority:
  // YPJT2-Melbourne-Center... -> YPJT
  // LSZH1-Zurich... -> LSZH
  // KPBI2-... -> KPBI
  const firstToken = upper.split("-")[0]?.trim();
  const firstLetters = firstToken.replace(/[^A-Z]/g, "");

  if (
    /^[A-Z]{4}\d*$/.test(firstToken) &&
    !ignore.has(firstLetters)
  ) {
    return firstLetters.slice(0, 4);
  }

  const dateSplit = upper.split(/-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-/);
  const beforeDate = dateSplit[0] || upper;

  const parts = beforeDate.split("-").filter(Boolean);

  for (const rawPart of parts) {
    const p = rawPart.toUpperCase();

    const lettersOnly = p.replace(/[^A-Z]/g, "");

    if (ignore.has(p) || ignore.has(lettersOnly)) continue;
    if (lettersOnly.startsWith("FINA") || lettersOnly.startsWith("FINAL")) continue;

    // ICAO with optional sector number: KPBI2 -> KPBI, LSZH1 -> LSZH, YPJT2 -> YPJT
    const icao = p.match(/^([A-Z]{4})\d*$/);
    if (icao && !ignore.has(icao[1])) {
      return icao[1];
    }

    // IATA: LGA
    if (/^[A-Z]{3}$/.test(p) && !ignore.has(p)) {
      return p;
    }
  }

  return null;
}



function extractICAOFromKey(rawKey) {
  if (!rawKey) return null;

  const dashed = extractAirportFromDashedKey(rawKey);
  if (dashed) return dashed;

  const upper = String(rawKey).toUpperCase();

  const domestic = upper.match(
    /(?<![A-Z])(?:K[A-Z]{3}|PA[A-Z]{2}|PH[A-Z]{2}|P[A-Z]{3}|C[A-Z]{3})(?![A-Z])/
  );

  if (domestic) return domestic[0];

  return null;
}


function attachDisplayNames(nasrList, cifpList) {

  return nasrList.map(p => {

    // If NASR already gave us a number, keep it
    if (p.displayName && /\d/.test(p.displayName)) {
      return p;
    }

    const base = p.name.replace(/\s*\d+.*/, "").toUpperCase();

    const match = cifpList.find(c =>
      c.toUpperCase().startsWith(base)
    );

    if (match) {

      const m = match.match(/^([A-Z]+)(\d)/);

      if (m) {
        return {
          ...p,
          displayName: `${m[1]}${m[2]}`
        };
      }
    }

    return p; // do NOT overwrite displayName
  });
}
function gridKey(lat, lon){

  const latBin = Math.floor(lat * 4) / 4;
  const lonBin = Math.floor(lon * 4) / 4;

  return `${latBin.toFixed(2)}|${lonBin.toFixed(2)}`;
}

function detectFixCrossings(track){

  const fixes = [];

  for(let i=0;i<track.length-1;i++){

    const a = track[i];
    const b = track[i+1];

    const dLat = b.lat - a.lat;
    const dLon = b.lon - a.lon;

    const dist = haversineNm(a.lat,a.lon,b.lat,b.lon);

    const steps = Math.max(1,Math.ceil(dist/0.5)); // 1 NM sampling

    for(let s=0;s<=steps;s++){

      const t = s/steps;

      const lat = a.lat + dLat*t;
      const lon = a.lon + dLon*t;

      const nearby = searchFixesNearby(lat,lon,5);

      for (const fx of nearby) {
  const ident = fx[0];

  if (fixes[fixes.length - 1] !== ident) {
    fixes.push(ident);
  }
}

    }

  }

  return collapseFixSequence(fixes);
}

function haversineNm(lat1, lon1, lat2, lon2) {

  const R = 3440.065;

  const dLat = (lat2 - lat1) * Math.PI/180;
  const dLon = (lon2 - lon1) * Math.PI/180;

  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) *
    Math.cos(lat2*Math.PI/180) *
    Math.sin(dLon/2)**2;

  return 2 * R * Math.asin(Math.sqrt(a));
}


const WATCHED_TABS = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {

  if(
    changeInfo.status === "complete" &&
    tab.url?.includes("adsbexchange.com") &&
    !WATCHED_TABS.has(tabId)
  ){
    WATCHED_TABS.add(tabId);
    installPlaneSelectionWatcher(tabId);
  }

});


function addFacilityToIndex(freq, label, airport){

  if(!freq) return;

  const key = `${freq}|${label}|${airport}`;

  if(!FACILITY_FREQ_INDEX.some(f =>
      `${f.freq}|${f.label}|${f.airport}` === key
  )){
    FACILITY_FREQ_INDEX.push({
      freq: String(freq),
      label: label || "",
      airport
    });
  }

}

function addNavaidsToFixGrid() {
  if (!NAVAID_INDEX) return;

  const seen = new Set(
    MASTER_FIX_INDEX.map(f => `${f[0]}|${f[1].toFixed(2)}|${f[2].toFixed(2)}`)
  );

  for (const ident in NAVAID_INDEX) {
    const n = NAVAID_INDEX[ident];
    const lat = Number(n.lat);
    const lon = Number(n.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const key = `${ident}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fix = [ident, lat, lon];
    MASTER_FIX_INDEX.push(fix);

    const grid = gridKey(lat, lon);
    if (!FIX_GRID.has(grid)) FIX_GRID.set(grid, []);
    FIX_GRID.get(grid).push(fix);
  }
}

function addWaypointsToFixGrid() {
  if (!GLOBAL_WAYPOINTS.length) return;

  const seen = new Set(
    MASTER_FIX_INDEX.map(f => `${f[0]}|${f[1].toFixed(2)}|${f[2].toFixed(2)}`)
  );

  let added = 0;
  for (const wp of GLOBAL_WAYPOINTS) {
    const lat = Number(wp.lat);
    const lon = Number(wp.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const key = `${wp.ident}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const fix = [wp.ident, lat, lon];
    MASTER_FIX_INDEX.push(fix);

    const grid = gridKey(lat, lon);
    if (!FIX_GRID.has(grid)) FIX_GRID.set(grid, []);
    FIX_GRID.get(grid).push(fix);
    added++;
  }

  console.log(`International waypoints added to fix grid: ${added}`);
}

function addVfrVisualWaypointsToFixGrid() {
  if (!AUS_VFR_VISUAL_WAYPOINTS.length) return;

  VFR_VISUAL_GRID.clear();
  let added = 0;

  for (const wp of AUS_VFR_VISUAL_WAYPOINTS) {
    const lat = Number(wp.latitude);
    const lon = Number(wp.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const code = String(wp.code || "").trim().toUpperCase();
    if (!code) continue;

    const entry = { code, name: wp.name || code, state: wp.state || "", lat, lon };
    const grid = gridKey(lat, lon);
    if (!VFR_VISUAL_GRID.has(grid)) VFR_VISUAL_GRID.set(grid, []);
    VFR_VISUAL_GRID.get(grid).push(entry);
    added++;
  }

  console.log(`AUS VFR visual waypoints indexed: ${added}`);
}

function searchVfrVisualNearby(lat, lon, radius_nm) {
  const radiusDeg = radius_nm / 60;
  const latMin = lat - radiusDeg;
  const latMax = lat + radiusDeg;
  const lonMin = lon - radiusDeg;
  const lonMax = lon + radiusDeg;

  const results = [];
  const seen = new Set();

  for (let la = Math.floor(latMin * 4) / 4; la <= latMax; la += 0.25) {
    for (let lo = Math.floor(lonMin * 4) / 4; lo <= lonMax; lo += 0.25) {
      const laSnap = Math.round(la * 4) / 4;
      const loSnap = Math.round(lo * 4) / 4;
      const cell = VFR_VISUAL_GRID.get(gridKey(laSnap, loSnap));
      if (!cell) continue;
      for (const wp of cell) {
        if (seen.has(wp.code)) continue;
        if (haversineNm(lat, lon, wp.lat, wp.lon) <= radius_nm) {
          seen.add(wp.code);
          results.push(wp);
        }
      }
    }
  }

  return results;
}

async function findVfrWaypointsAlongTrack(reducedPoints, radiusNm = 30) {
  if (!reducedPoints?.length) return [];
  if (!VFR_VISUAL_GRID.size && AUS_VFR_VISUAL_WAYPOINTS.length) addVfrVisualWaypointsToFixGrid();
  if (!VFR_VISUAL_GRID.size) {
    console.warn("[VFR] Grid empty — no VFR waypoints indexed");
    return [];
  }

  const step = Math.max(1, Math.floor(reducedPoints.length / 60));
  console.log(`[VFR] Searching track (${reducedPoints.length} pts, step=${step}) against grid (${VFR_VISUAL_GRID.size} cells, ${AUS_VFR_VISUAL_WAYPOINTS.length} waypoints)`);

  const seen = new Set();
  const found = [];

  for (let i = 0; i < reducedPoints.length; i += step) {
    const pt = reducedPoints[i];
    const nearby = searchVfrVisualNearby(pt.lat, pt.lon, radiusNm);
    for (const wp of nearby) {
      if (!seen.has(wp.code)) {
        seen.add(wp.code);
        found.push({ code: wp.code, name: wp.name, state: wp.state });
      }
    }
  }

  console.log(`[VFR] Found ${found.length} waypoints along track:`, found.map(w => w.code));
  return found;
}

/* -------------------- Flight frequency helpers -------------------- */

function isTowerFreq(f) {
  const t = (f.type || "").toUpperCase();
  const d = (f.name || "").toUpperCase();
  return t === "TWR" || d.includes("TOWER");
}

function isEnrouteFreq(f) {
  const t = (f.type || "").toUpperCase();
  const d = (f.name || "").toUpperCase();
  return ["CTR", "APP", "APCH", "DEP", "RADAR", "RDO"].includes(t) ||
    d.includes("CENTER") || d.includes("APPROACH") ||
    d.includes("DEPARTURE") || d.includes("RADAR") ||
    d.includes("DIRECTOR");
}

async function findAirportsAlongTrack(reducedPoints, radiusNm = 60) {
  if (!reducedPoints?.length) return [];

  await ensureOurAirportsLoaded();

  if (!BIN_MEM_CACHE.size) {
    const bins = await DB.getAllBins();
    for (const [k, v] of bins) BIN_MEM_CACHE.set(k, v);
  }
  if (!AIRPORT_MAP.size) {
    const airports = await DB.getAllAirports();
    for (const a of airports) AIRPORT_MAP.set(a.id, a);
  }

  const seenIds = new Set();
  const found = [];
  const step = Math.max(1, Math.floor(reducedPoints.length / 40));

  for (let i = 0; i < reducedPoints.length; i += step) {
    const pt = reducedPoints[i];
    const candidates = await gatherCandidates(pt.lat, pt.lon, radiusNm);

    for (const id of candidates) {
      if (seenIds.has(id)) continue;
      const a = AIRPORT_MAP.get(id);
      if (!a) continue;
      if (a.type !== "large_airport" && a.type !== "medium_airport") continue;
      seenIds.add(id);
      found.push({ airport: a, trackIndex: i });
    }
  }

  found.sort((a, b) => a.trackIndex - b.trackIndex);
  return found.map(f => f.airport);
}

async function fetchAndCacheFacilityFreqs(ident) {
  if (!ident) return;
  if (FACILITY_FREQ_INDEX.some(f => f.airport === ident)) return;
  try {
    const url = `https://www.airnav.com/airport/${ident}`;
    const html = await fetchText(url);
    const commsMatch = html.match(/Airport Communications([\s\S]*?)<\/TABLE>/i);
    if (!commsMatch) return;
    const table = commsMatch[1];
    const rowRegex = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
    let row;
    while ((row = rowRegex.exec(table)) !== null) {
      let clean = row[1].replace(/&nbsp;/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (!clean) continue;
      const freqMatches = clean.match(/\d{3}\.\d{1,3}/g);
      if (!freqMatches) continue;
      const firstFreqIndex = clean.search(/\d{3}\.\d{1,3}/);
      let facilityName = clean.slice(0, firstFreqIndex).trim().replace(/\s+/g, " ").toUpperCase();
      const segments = clean.slice(firstFreqIndex).split(";");
      for (let seg of segments) {
        seg = seg.replace(/\s+/g, " ").trim();
        const freq = seg.match(/\d{3}\.\d{1,3}/);
        if (!freq) continue;
        addFacilityToIndex(freq[0], facilityName, ident);
      }
    }
  } catch (e) {
    // silent — airnav unreachable or airport not found
  }
}

async function buildFlightFreqs(origin, destination, enrouteAirports) {
  const result = { origin: null, destination: null, enroute: [] };

  await loadOurAirportsFrequencies();
  await loadAusFrequencies();

  // Pre-fetch airnav comms for any US airport not already in the index
  const usIdents = [origin, destination, ...enrouteAirports.map(a => a.ident)]
    .filter(id => id && /^K[A-Z0-9]{3}$/.test(id) && !FACILITY_FREQ_INDEX.some(f => f.airport === id));
  if (usIdents.length) {
    await Promise.all(usIdents.map(fetchAndCacheFacilityFreqs));
  }

  const lookupAirport = ident => {
    for (const a of AIRPORT_MAP.values()) {
      if (a.ident === ident) return a;
    }
    return null;
  };

  if (origin) {
    const allOriginFreqs = getEnrichedFreqs(origin);
    const freqs = allOriginFreqs.filter(isTowerFreq);
    if (freqs.length) {
      const a = lookupAirport(origin);
      const depEntry = allOriginFreqs.find(f => {
        const t = (f.type || "").toUpperCase();
        const n = (f.name || "").toUpperCase();
        return t === "DEP" || n.includes("DEPARTURE");
      });
      result.origin = { ident: origin, name: a?.name || origin, freqs, depFacilityName: depEntry?.name || null };
    }
  }

  if (destination) {
    const allDestFreqs = getEnrichedFreqs(destination);
    const freqs = allDestFreqs.filter(isTowerFreq);
    if (freqs.length) {
      const a = lookupAirport(destination);
      const appEntry = allDestFreqs.find(f => {
        const t = (f.type || "").toUpperCase();
        const n = (f.name || "").toUpperCase();
        return t === "APP" || t === "APCH" || n.includes("APPROACH");
      });
      result.destination = { ident: destination, name: a?.name || destination, freqs, appFacilityName: appEntry?.name || null };
    }
  }

  for (const a of enrouteAirports) {
    if (a.ident === origin || a.ident === destination) continue;
    const freqs = getEnrichedFreqs(a.ident).filter(isEnrouteFreq);
    if (!freqs.length) continue;
    // Pick the primary facility name: CTR > RADAR > APP > first available
    const primary = freqs.find(f => (f.type || "").toUpperCase() === "CTR")
      || freqs.find(f => ["RADAR", "RDO"].includes((f.type || "").toUpperCase()))
      || freqs.find(f => ["APP", "APCH"].includes((f.type || "").toUpperCase()))
      || freqs[0];
    result.enroute.push({ ident: a.ident, name: a.name, freqs, facilityName: primary?.name || null });
    if (result.enroute.length >= 15) break;
  }

  return result;
}


/* -------------------- Message handling -------------------- */



chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {

      if (msg.type === "ADSB_PAGE_LOADED") {
        lastProcessedIcao = null;
        return;
      }

      if (msg.type === "CLEAR_ACTIVE_FLIGHT") {

  lastProcessedIcao = null;

  await chrome.storage.local.remove([
    "adsb_active_flight_fixes",
    "adsb_active_flight_route",
    "adsb_active_flight_origin",
    "adsb_active_flight_destination",
    "adsb_active_flight_callsign",
    "adsb_active_flight_icao",
    "adsb_active_flight_fixes_at"
  ]);

  chrome.runtime.sendMessage({
    type: "ACTIVE_FLIGHT_UPDATED"
  });

  sendResponse({ ok: true });
  return true;
}
if (msg.type === "DETECT_FIX_SEQUENCE") {

  const result = await reconstructRouteFromTrack(msg.track);

  await chrome.storage.local.set({
    adsb_active_flight_fixes: result.fixes,
    adsb_active_flight_route: result.routeString,
    adsb_active_flight_vfr_waypoints: result.vfrWaypoints || [],
    adsb_active_flight_fixes_at: Date.now()
  });

  sendResponse({
    ok: true,
    fixes: result.fixes,
    routeString: result.routeString
  });

  return true;
}

if(msg.type === "ADSB_AIRCRAFT_UPDATED"){
console.log("SETTING CALLSIGN (UPDATED):", msg.callsign);
  const prev = await chrome.storage.local.get([
    "adsb_active_flight_lat",
    "adsb_active_flight_lon",
    "adsb_active_flight_alt",
    "adsb_active_flight_callsign"
  ]);

  const changed =
    prev.adsb_active_flight_lat !== msg.lat ||
    prev.adsb_active_flight_lon !== msg.lon ||
    prev.adsb_active_flight_alt !== msg.alt ||
    (msg.callsign && prev.adsb_active_flight_callsign !== msg.callsign);

  if(!changed) return;

  await chrome.storage.local.set({
    adsb_active_flight_lat: msg.lat,
    adsb_active_flight_lon: msg.lon,
    adsb_active_flight_alt: msg.alt,
    adsb_active_flight_callsign: msg.callsign
  });

  chrome.runtime.sendMessage({
    type: "ACTIVE_FLIGHT_UPDATED"
  });

  return;
}

if(msg.type === "ADSB_AIRCRAFT_SELECTED"){
  const icao = msg.icao;
  if(!icao) return;

  // Deduplicate: ignore re-selection of the same aircraft (hook can fire multiple times)
  if (lastProcessedIcao === icao.toLowerCase()) return;
  lastProcessedIcao = icao.toLowerCase();

  const tabId = _sender?.tab?.id;
  if (!tabId) return;

  // 🔥 CLEAR OLD FLIGHT IMMEDIATELY
  await chrome.storage.local.set({
    adsb_active_flight_fixes: [],
    adsb_active_flight_route: null,
    adsb_active_flight_origin: null,
    adsb_active_flight_destination: null,
    adsb_active_flight_callsign: msg.callsign || null,
    adsb_active_flight_icao: msg.icao,
    adsb_active_flight_vfr_waypoints: [],
    adsb_active_flight_fixes_at: Date.now()
  });

chrome.storage.local.set({
  adsb_active_flight_last_update: Date.now()
});

chrome.runtime.sendMessage({
  type: "ACTIVE_FLIGHT_UPDATED"
}).catch(()=>{});

  const routeData = await extractAdsbRoute(tabId, icao);

  if(!routeData.ok){
    console.log("Route extraction failed:", routeData.error);
    return;
  }

  const result = await reconstructRouteFromTrack(routeData.points);

  const prev = await chrome.storage.local.get("adsb_active_flight_route");

  if(prev.adsb_active_flight_route === result.routeString){
    return;
  }

  const trackReduced = reduceTrack(routeData.points, 0.3).slice(0, 800).map(p => ({ lat: p.lat, lon: p.lon }));

  await chrome.storage.local.set({
    adsb_active_flight_fixes: result.fixes,
    adsb_active_flight_route: result.routeString,
    adsb_active_flight_origin: result.origin,
    adsb_active_flight_destination: result.destination,
    adsb_active_flight_freqs: result.freqs || null,
    adsb_active_flight_track: trackReduced,
    adsb_active_flight_callsign: msg.callsign || null,
    adsb_active_flight_icao: msg.icao,
    adsb_active_flight_vfr_waypoints: result.vfrWaypoints || [],
    adsb_active_flight_fixes_at: Date.now()
  });

  chrome.runtime.sendMessage({
    type: "ACTIVE_FLIGHT_UPDATED"
  });

}

if (msg?.type === "RECONSTRUCT_ADSB_ROUTE") {

  (async () => {

    const tabs = await chrome.tabs.query({
      url: "*://globe.adsbexchange.com/*"
    });

    if (!tabs.length) {
      sendResponse({ ok:false, error:"ADS-B tab not found" });
      return;
    }

    const routeData = await extractAdsbRoute(tabs[0].id);

    if (!routeData.ok) {
      sendResponse(routeData);
      return;
    }

    const result = await reconstructRouteFromTrack(routeData.points);

    // store the new flight
const trackReduced2 = reduceTrack(routeData.points, 0.3).slice(0, 800).map(p => ({ lat: p.lat, lon: p.lon }));
await chrome.storage.local.set({
  adsb_active_flight_fixes: result.fixes,
  adsb_active_flight_route: result.routeString,
  adsb_active_flight_callsign: msg.callsign || null,
  adsb_active_flight_origin: result.origin,
  adsb_active_flight_destination: result.destination,
  adsb_active_flight_freqs: result.freqs || null,
  adsb_active_flight_track: trackReduced2,
  adsb_active_flight_vfr_waypoints: result.vfrWaypoints || [],
  adsb_active_flight_fixes_at: Date.now(),
  adsb_active_flight_icao: msg.icao
});

setTimeout(() => {
  chrome.runtime.sendMessage({ type: "ACTIVE_FLIGHT_UPDATED" });
}, 0);

    sendResponse({ ok:true, ...result });

  })();

  return true;
}


if (msg?.type === "GET_ADSB_ROUTE") {

  console.log("GET_ADSB_ROUTE request received");

  const tabs = await chrome.tabs.query({
  url: "*://globe.adsbexchange.com/*"
});

if (!tabs.length) {
  sendResponse({ok:false,error:"ADS-B tab not found"});
  return;
}

const route = await extractAdsbRoute(tabs[0].id);

  sendResponse(route);
  return true;
}
    
if (msg?.type === "SEARCH_WAYPOINTS_NEAR") {

  const { lat, lon, radius_nm } = msg;

  const fixes = searchFixesNearby(lat, lon, radius_nm);

  sendResponse({
    ok: true,
    fixes
  });

  return true;
}

if (msg?.type === "SEARCH_AIRPORTS_GLOBAL") {
  (async () => {
    const query = String(msg.query || "").toUpperCase().trim();
    if (!query) { sendResponse({ ok: true, results: [] }); return; }

    await ensureOurAirportsLoaded();
    await loadOurAirportsFrequencies();
    await loadAusFrequencies();

    const results = [];
    for (const a of AIRPORT_MAP.values()) {
      const identMatch = a.ident && a.ident.toUpperCase().includes(query);
      const nameMatch = a.name && a.name.toUpperCase().includes(query);
      const muniMatch = a.municipality && a.municipality.toUpperCase().includes(query);
      if (!identMatch && !nameMatch && !muniMatch) continue;
      if (a.type !== "large_airport" && a.type !== "medium_airport" && a.type !== "small_airport") continue;
      const freqs = getEnrichedFreqs(a.ident);
      results.push({ ident: a.ident, name: a.name, type: a.type, municipality: a.municipality, country: a.country, lat: a.lat, lon: a.lon, freqs });
      if (results.length >= 30) break;
    }

    results.sort((a, b) => {
      const aExact = a.ident.toUpperCase() === query ? 0 : 1;
      const bExact = b.ident.toUpperCase() === query ? 0 : 1;
      return aExact - bExact;
    });

    sendResponse({ ok: true, results });
  })();
  return true;
}

if (msg.type === "GET_AIRPORT_NAME") {

  const ident = String(msg.ident || "").toUpperCase();

  await ensureOurAirportsLoaded();

  let airport = null;

  for (const a of AIRPORT_MAP.values()) {
    if (a.ident === ident) {
      airport = a;
      break;
    }
  }

  if (!airport) {
    sendResponse({ ok:false });
    return true;
  }

  sendResponse({
    ok:true,
    name: airport.name || ""
  });

  return true;
}


if (msg?.type === "GET_AUS_PROCEDURES") {
  const icao = String(msg.icao || "").toUpperCase();

  sendResponse({
    ok: true,
    icao,
    data: AUS_PROC_BY_ICAO[icao] || null
  });

  return true;
}

if (msg?.type === "GET_SWISS_PROCEDURES") {
  const icao = String(msg.icao || "").toUpperCase();
  sendResponse({ ok: true, icao, data: SWISS_AD2_DB[icao] || null });
  return true;
}

if (msg?.type === "GET_IRELAND_PROCEDURES") {
  const icao = String(msg.icao || "").toUpperCase();
  sendResponse({ ok: true, icao, data: IRELAND_PROC_DB[icao] || null });
  return true;
}

      if (msg?.type === "GET_GLOBAL_COUNTRIES") {
  await ensureGlobalDataLoaded();
  sendResponse({
    ok: true,
    countries: getGlobalCountries()
  });
  return true;
}

if (msg?.type === "SEARCH_GLOBAL_POINTS") {
  await ensureGlobalDataLoaded();

  sendResponse({
    ok: true,
    results: searchGlobalPoints(msg.query || "", {
      limit: Number(msg.limit || 50),
      country: msg.country || ""
    })
  });
  return true;
}

if (msg?.type === "FIND_NEARBY_GLOBAL_POINTS") {
  await ensureGlobalDataLoaded();

  sendResponse({
    ok: true,
    results: findNearbyGlobalPoints(
      Number(msg.lat),
      Number(msg.lon),
      Number(msg.radiusNm || 25),
      Number(msg.limit || 50),
      msg.country || ""
    )
  });
  return true;
}

if (msg?.type === "GET_AIRPORT_COORDS") {
  await ensureOurAirportsLoaded();

  const ident = normKey(msg.ident);
  let found = null;

  for (const a of AIRPORT_MAP.values()) {
    if (
      normKey(a.ident) === ident ||
      normKey(a.gps_code) === ident ||
      normKey(a.local_code) === ident ||
      normKey(a.iata_code) === ident
    ) {
      found = a;
      break;
    }
  }

  sendResponse({
    ok: !!found,
    airport: found
      ? {
          ident: found.ident,
          name: found.name,
          lat: found.lat,
          lon: found.lon,
          country: found.country
        }
      : null
  });
  return true;
}
if (msg?.type === "SEARCH_GLOBAL_POINTS") {
  await ensureGlobalDataLoaded();

  const results = searchGlobalPoints(msg.query || "", {
    limit: Number(msg.limit || 50),
    country: msg.country || ""
  });

  sendResponse({ ok: true, results });
  return;
}

if (msg?.type === "GET_GLOBAL_COUNTRIES") {
  await ensureGlobalDataLoaded();

  sendResponse({
    ok: true,
    countries: getGlobalCountries()
  });
  return;
}

if (msg?.type === "GET_AIRPORT_COORDS") {
  await ensureOurAirportsLoaded();

  const ident = normKey(msg.ident);
  let found = null;

  for (const a of AIRPORT_MAP.values()) {
    if (
      normKey(a.ident) === ident ||
      normKey(a.gps_code) === ident ||
      normKey(a.local_code) === ident ||
      normKey(a.iata_code) === ident
    ) {
      found = a;
      break;
    }
  }

  sendResponse({
    ok: !!found,
    airport: found ? {
      ident: found.ident,
      name: found.name,
      lat: found.lat,
      lon: found.lon,
      country: found.country
    } : null
  });
  return;
}

      if (msg?.type === "FIND_NEARBY_GLOBAL_POINTS") {
        await ensureGlobalDataLoaded();

        const results = findNearbyGlobalPoints(
          Number(msg.lat),
          Number(msg.lon),
          Number(msg.radiusNm || 20),
          Number(msg.limit || 50)
        );

        sendResponse({ ok: true, results });
        return;
      }

      if (msg?.type === "GLOBAL_DATA_STATUS") {
        sendResponse({
          ok: true,
          ready: GLOBAL_DATA_READY,
          counts: {
            waypoints: GLOBAL_WAYPOINTS.length,
            navaids: GLOBAL_NAVAIDS.length,
            total: GLOBAL_POINTS.length
          }
        });
        return;
      }


if (msg?.type === "GET_AIRPORT_RUNWAY_INDEX") {
  await ensureOurAirportsLoaded();

  const index = {};

  for (const a of AIRPORT_MAP.values()) {
    if (!a) continue;

    const ident =
      String(a.ident || a.gps_code || a.local_code || a.iata_code || "")
        .trim()
        .toUpperCase();

    if (!ident) continue;

    const runways = RUNWAY_MEM_CACHE.get(a.id) || [];
    index[ident] = runways.map(r => ({
      le_ident: String(r.le_ident || r.ident1 || "").toUpperCase(),
      he_ident: String(r.he_ident || r.ident2 || "").toUpperCase()
    }));
  }

  sendResponse({ ok: true, index });
  return;
}

if (msg?.type === "GET_AIRPORT_RUNWAYS") {
  await ensureOurAirportsLoaded();

  const ident = String(msg.ident || "").trim().toUpperCase();
  if (!ident) {
    sendResponse({ ok: false, runways: [] });
    return;
  }

  let airport = null;

  for (const a of AIRPORT_MAP.values()) {
    const aIdent = String(a.ident || "").toUpperCase();
    const gps = String(a.gps_code || "").toUpperCase();
    const local = String(a.local_code || "").toUpperCase();
    const iata = String(a.iata_code || "").toUpperCase();

    if (
      ident === aIdent ||
      ident === gps ||
      ident === local ||
      ident === iata
    ) {
      airport = a;
      break;
    }
  }

  if (!airport) {
    sendResponse({ ok: false, runways: [] });
    return;
  }

  const runways = RUNWAY_MEM_CACHE.get(airport.id) || [];

  sendResponse({
    ok: true,
    ident: airport.ident,
    airport,
    runways
  });
  return;
}

      if (msg?.type === "GET_AIRPORT_SEARCH_INDEX") {
  await ensureOurAirportsLoaded();

  const items = [];

  for (const a of AIRPORT_MAP.values()) {
    if (!a?.ident) continue;

    items.push({
      ident: String(a.ident || "").toUpperCase(),
      name: String(a.name || ""),
      municipality: String(a.municipality || ""),
      region: String(a.region || ""),
      country: String(a.country || ""),
      gps_code: String(a.gps_code || "").toUpperCase(),
      local_code: String(a.local_code || "").toUpperCase(),
      iata_code: String(a.iata_code || "").toUpperCase()
    });
  }

  sendResponse({ ok: true, items });
  return true;
}

if (msg?.type === "GET_AIRPORT_FREQS") {

  await loadOurAirportsFrequencies();

  const ident = String(msg.ident || "").toUpperCase();

  const freqs = AIRPORT_FREQ_INDEX?.[ident] || [];

  sendResponse({
    ok: true,
    freqs
  });

  return true;
}

if (msg?.type === "GET_FACILITY_FREQ_INDEX") {

  sendResponse({
    ok: true,
    index: FACILITY_FREQ_INDEX
  });

  return true;
}

if (msg?.type === "GET_PROC_FIX_MASTER") {

  console.log("FIX_PROC_INDEX sample:", FIX_PROC_INDEX.get("DSNEE"));

  await ensureNasrProceduresLoaded();

  const results = [];

  for (const [fix, procs] of FIX_PROC_INDEX.entries()) {

    const enriched = procs.map(p => {

      const m = (p.name || "").match(/^([A-Z]+)(\d+)/);
      const display = m ? `${m[1]} ${m[2]}` : p.name;

      return {
        airport: p.airport,
        type: p.type,
        procedure: display,
        code: p.code
      };

    });

    results.push({
      fix,
      procedures: enriched
    });

  }

  sendResponse({
    ok: true,
    results
  });

  return true;
}


if (msg.type === "GET_ALL_PROCEDURES") {
  sendResponse({
    ok: true,
    results: PROCEDURE_INDEX
  });
}

      if (msg.callsign) {
  console.log(
    "%cCALLSIGN MESSAGE",
    "color:cyan;font-weight:bold",
    msg.type,
    msg.callsign
  );
}

if (msg.type === "GET_AIRPORT_NAME") {

  const ident = String(msg.ident || "").toUpperCase();

  await ensureOurAirportsLoaded();

  let airport = null;

  for (const a of AIRPORT_MAP.values()) {
    if (a.ident === ident) {
      airport = a;
      break;
    }
  }

  if (!airport) {
    sendResponse({ ok:false });
    return true;
  }

  sendResponse({
    ok:true,
    name: airport.name || ""
  });

  return true;
}


if (msg?.type === "SEARCH_PROC_FIXES") {

  await ensureNasrProceduresLoaded();

  const q = String(msg.query || "").toUpperCase();

  const results = [];

for (const [fix, procs] of FIX_PROC_INDEX.entries()) {

  const score =
    fuzzyScore(fix, q) +
    phoneticScore(fix, q);

  if (score < 1) continue;

    for (const p of procs) {

      const m = (p.name || "").match(/^([A-Z]+)(\d+)/);
      const display = m ? `${m[1]} ${m[2]}` : p.name;

      results.push({
        ident: fix,
        airport: p.airport,
        type: p.type,
        procedure: display,
        code: p.code
      });

      if (results.length > 200) break;
    }

    if (results.length > 200) break;
  }

  sendResponse({ ok:true, results });
  return true;
}

if (msg?.type === "INIT_PROC_INDEX") {

  await ensureNasrProceduresLoaded();

  sendResponse({ ok:true });
  return true;
}

if (msg.type === "EXPAND_AIRWAY") {

  (async () => {

    const airway = msg.airway;
    const entry = msg.entry;
    const exit = msg.exit;

    const list = AIRWAY_INDEX?.[airway];
    if (!list) {
      sendResponse({ ok: false });
      return;
    }

    const start = list.indexOf(entry);
    const end = list.indexOf(exit);

    if (start === -1 || end === -1) {
      sendResponse({ ok: false });
      return;
    }

    const slice = start <= end
      ? list.slice(start, end + 1)
      : list.slice(end, start + 1).reverse();

    sendResponse({ ok: true, fixes: slice });

  })();

  return true; // 🔥 REQUIRED
}

if (msg?.type === "GET_PROC_FIXES_BY_NAME") {

  const name = String(msg.name || "").trim().toUpperCase();
  if (!name) {
    sendResponse({ ok: false });
    return true;
  }

  let found = null;

  for (const [key, fixes] of PROC_ROUTE_MEM_INDEX.entries()) {
    const parts = key.split("|");
    const procName = parts[2]?.toUpperCase();
    if (procName === name) {
      found = fixes;
      break;
    }
  }

  if (!found || !found.length) {
    sendResponse({ ok: false });
    return true;
  }

  sendResponse({ ok: true, fixes: found });
  return true;
}

if (msg?.type === "LB_AIRPORT_FOUND") {

  const rawText = String(msg.rawText || "").trim();
  if (!rawText) {
    sendResponse({ ok: false });
    return;
  }

  const airport = extractICAOFromKey(rawText);
  lastDetectedAirport = airport;

  chrome.storage.local.set({ [LB_KEY]: rawText }, () => {
    console.log("Stored new LB key:", rawText);
    sendResponse({ ok: true });
  });

  return;
}

if (msg?.type === "GET_LAST_AIRPORT") {
  sendResponse({ ok: true, airport: lastDetectedAirport });
  return;
}

      if (msg?.type === "FETCH_AIRNAV") {

  const icao = String(msg.icao || "").trim().toUpperCase();
  if (!icao) {
    sendResponse({ ok: false, error: "Missing ICAO" });
    return;
  }

  const url = `https://www.airnav.com/airport/${icao}`;

  try {
    const html = await fetchText(url);
    const results = [];

    // -------------------------------
    // 1. AIRPORT COMMUNICATIONS
    // -------------------------------

// -------------------------------
// AIRPORT COMMUNICATIONS (FULL FACILITY NAMES + CLEAN FORMAT)
// -------------------------------

const commsMatch = html.match(/Airport Communications([\s\S]*?)<\/TABLE>/i);

if (commsMatch) {

  const table = commsMatch[1];
  const rowRegex = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
  let row;

  while ((row = rowRegex.exec(table)) !== null) {

    let clean = row[1]
      .replace(/&nbsp;/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!clean) continue;

    // Must contain a frequency
    const freqMatches = clean.match(/\d{3}\.\d{1,3}/g);
    if (!freqMatches) continue;

    // Extract full facility name before first frequency
    const firstFreqIndex = clean.search(/\d{3}\.\d{1,3}/);
    let facilityName = clean.slice(0, firstFreqIndex).trim();

    // Normalize spacing
    facilityName = facilityName.replace(/\s+/g, " ").toUpperCase();

    // Split everything after into segments separated by semicolons
    const after = clean.slice(firstFreqIndex);
    const segments = after.split(";");

    for (let seg of segments) {
      seg = seg.replace(/\s+/g, " ").trim();
      if (!seg) continue;

      const freq = seg.match(/\d{3}\.\d{1,3}/);
      if (!freq) continue;

      const labelPart = seg.replace(freq[0], "").trim();

      results.push({
        type: "comm",
        label: facilityName,
        freq: labelPart ? `${labelPart} ${freq[0]}` : freq[0]
      });

      addFacilityToIndex(freq[0], facilityName, icao);
    }
  }
}

// -------------------------------
// ARTCC (Table Cell Version)
// -------------------------------

const artccMatch = html.match(
  /ARTCC:\s*&nbsp;?\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/i
);

if (artccMatch) {
  const artccName = cleanHtmlText(artccMatch[1]).toUpperCase();

  if (artccName) {
    results.push({
      type: "comm",
      label: artccName,
      freq: ""
    });
  }
}
    // -------------------------------
    // 2. NAVIGATION AIDS
    // -------------------------------

    const navMatch = html.match(/Nearby Radio Navigation Aids([\s\S]*?)<\/TABLE>/i);

    if (navMatch) {
      const navRegex = /([A-Z\s]+)\s+(VORTAC|VOR\/DME|VOR)[\s\S]*?([\d.]{3,7})/gi;
      let match;

      while ((match = navRegex.exec(navMatch[1])) !== null) {
        results.push({
          type: "nav",
          label: match[1].trim() + " " + match[2],
          freq: match[3]
        });
      }
    }
// Sort communications so CENTER appears first
results.sort((a, b) => {

  if (a.type !== "comm" || b.type !== "comm") return 0;

  const isCenterA = a.label.includes("CENTER");
  const isCenterB = b.label.includes("CENTER");

  if (isCenterA && !isCenterB) return -1;
  if (!isCenterA && isCenterB) return 1;

  return 0;
});
    sendResponse({ ok: true, data: results });

  } catch (e) {
    sendResponse({ ok: false, error: "AirNav fetch failed." });
  }

  return;
}

if (msg.type === "GET_NAVAID_BY_IDENT") {

  const ident = msg.ident?.toUpperCase();
  if (!ident) {
    sendResponse({ ok: false });
    return;
  }

  const navaid = NAVAID_INDEX?.[ident];

  if (!navaid) {
    sendResponse({ ok: false });
    return;
  }

  sendResponse({
    ok: true,
    name: navaid.name,
    type: navaid.type
  });

  return true;
}

      if (msg?.type === "GET_DR_AIRPORT") {
  const { lb_pageKey } = await chrome.storage.local.get("lb_pageKey");
  const airport = extractICAOFromKey(lb_pageKey);
  sendResponse({ ok: true, airport });
  return;
}

if (msg?.type === "GET_APPROACHES") {
  const ident = String(msg.ident || "").trim().toUpperCase();
  if (!ident) {
    sendResponse({ ok: false, error: "Missing airport ident." });
    return;
  }

  await ensureOurAirportsLoaded();
  await loadOurAirportsNavaids();

  const airportId = await DB.lookupAirportId(ident);
  if (!airportId) {
    sendResponse({ ok: false, error: "Airport not found." });
    return;
  }

  const airport = await DB.getAirport(airportId);
  if (!airport) {
    sendResponse({ ok: false, error: "Airport record missing." });
    return;
  }

  const ap = await getApproachNamesForAirport(airport, true);

  sendResponse({
    ok: true,
    approaches: ap.approaches || [],
    approaches_meta: ap.meta || null,
    approaches_note: ap.note || "",
    count: (ap.approaches || []).length
  });

  return;
}
// ---- Get approach fixes (best-effort from CIFP) ----
// ---- Get approach fixes (CIFP exact match) ----
if (msg?.type === "GET_IAP_FIXES") {

  const airportIdent = msg.airportIdent.toUpperCase();
  const approachName = msg.approachName.toUpperCase();

  const runwayMatch = approachName.match(/RWY\s+(\d{1,2}[LRC]?)/);
  if (!runwayMatch) {
    sendResponse({ ok: true, fixes: [] });
    return;
  }

  const runway = runwayMatch[1].replace(/^0+/, "");

  const fixes = [];

  for (const key in CIFP_INDEX) {

    // must belong to airport
    if (!key.startsWith(airportIdent)) continue;

    // match runway anywhere in key
    if (!key.includes(runway)) continue;

    fixes.push(...CIFP_INDEX[key]);
  }

  sendResponse({
    ok: true,
    fixes: [...new Set(fixes)]
  });

  return;
}

if (msg?.type === "GET_PROC_FIXES") {

  await ensureNasrProceduresLoaded();

let procType = String(msg.procType || "").trim().toUpperCase();

if (procType === "DP") procType = "SID";
  let procName = String(msg.procName || "").trim().toUpperCase();
  const procCode = String(msg.procCode || "").trim().toUpperCase();

  if (!procType) {
    sendResponse({ ok:false, error:"Missing procType" });
    return;
  }

  // Normalize "DSNEE 6" → "DSNEE6"
  procName = procName.replace(/\s+/g,"");

  let fixes = [];

  for (const [key, route] of PROC_ROUTE_MEM_INDEX.entries()) {

    if (!key.startsWith(procType + "|")) continue;

    const keyUpper = key.toUpperCase();

    if (
      keyUpper.includes(procName) ||
      (procCode && keyUpper.includes(procCode))
    ) {
      fixes = route;
      break;
    }

  }

  sendResponse({ ok:true, fixes });
  return;
}

      // ✅ NEW: On-demand approaches for a clicked airport

if (msg?.type === "QUERY_NEARBY") {
  await ensureOurAirportsLoaded();
  await loadOurAirportsNavaids();

  const ident = String(msg.ident || "").trim().toUpperCase();
  const radius_nm = Number(msg.radius_nm);
  const max_results = Math.max(1, Math.min(200, Number(msg.max_results || 25)));
  const country = msg.country === "ANY" ? "ANY" : "US";
  const intlMode = msg.intlMode === true || country === "ANY";

  // find center airport
  let center = null;

  for (const a of AIRPORT_MAP.values()) {
    const aIdent = String(a.ident || "").toUpperCase();
    const gps = String(a.gps_code || "").toUpperCase();
    const local = String(a.local_code || "").toUpperCase();
    const iata = String(a.iata_code || "").toUpperCase();

    if (
      ident === aIdent ||
      ident === gps ||
      ident === local ||
      ident === iata
    ) {
      center = a;
      break;
    }
  }

  if (!center) {
    sendResponse({ ok: false, error: `Airport not found: ${ident}` });
    return;
  }

  // gather candidate airports in the radius
  const candidateIds = await gatherCandidates(center.lat, center.lon, radius_nm);
  const nearby = [];

  for (const id of candidateIds) {
    const a = AIRPORT_MAP.get(id);
    if (!a) continue;

    // country filter
    if (!intlMode && country === "US" && a.country !== "US") continue;

    const d = haversineNm(center.lat, center.lon, a.lat, a.lon);
    if (d > radius_nm) continue;

    nearby.push({
      ...a,
      distance: d
    });
  }

  nearby.sort((a, b) => a.distance - b.distance);

  if (nearby.length > max_results) {
    nearby.length = max_results;
  }

  const results = [];

  for (let i = 0; i < nearby.length; i++) {
    const a = nearby[i];
    const rwys = RUNWAY_MEM_CACHE.get(a.id) || [];

    let procIndex = { departures: [], arrivals: [] };
    let approaches = [];
    let approaches_meta = null;
    let approaches_note = intlMode
      ? "intl_phase1_no_procedures"
      : "";

    if (!intlMode && a.country === "US") {
      procIndex = getProcIndexForAirportRecord(a) || { departures: [], arrivals: [] };

      try {
        const approachData = await getApproachNamesForAirport(a, true);
        approaches = approachData?.approaches || [];
        approaches_meta = approachData?.meta || null;
        approaches_note = approachData?.note || "";
      } catch (e) {
        approaches = [];
        approaches_meta = null;
        approaches_note = "approach_lookup_failed";
      }
    }

    results.push({
      ident: a.ident,
      name: a.name,
      country: a.country,
      region: a.region,
      municipality: a.municipality,
      type: a.type,
      distance_nm: a.distance,
      runways: rwys,
      departures: procIndex.departures || [],
      arrivals: procIndex.arrivals || [],
      approaches,
      approaches_meta,
      approaches_note
    });
  }

  sendResponse({
    ok: true,
    center: { ident: center.ident, name: center.name },
    results
  });
  return;
}

      // ===== RUN_AUTOLAUNCH =====
if (msg?.type === "RUN_AUTOLAUNCH") {
  if (!msg.rawText) {
    sendResponse({ ok: false });
    return;
  }

  await runSelectedActions(msg.rawText, msg.settings || {});
  sendResponse({ ok: true });
  return;
}

// ===== READ_CLIPBOARD =====
if (msg?.type === "READ_CLIPBOARD") {
  try {
    const text = await navigator.clipboard.readText();
    sendResponse({ ok: true, text });
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
  return;
}

// ===== ADSB_USER_OVERRIDE =====
if (msg?.type === "ADSB_USER_OVERRIDE") {
  USER_OVERRIDE_UNTIL = Date.now() + 5000;
  sendResponse({ ok: true });
  return;
}

// ===== ADSB_USER_PRESSED_PLAY =====
if (msg?.type === "ADSB_USER_PRESSED_PLAY") {
  const tabId = _sender?.tab?.id;
  if (typeof tabId === "number") {
    ADSB_AUTOPAUSE_DISABLED_BY_TAB.set(tabId, true);
    USER_OVERRIDE_UNTIL = Date.now() + 5000;
  }
  sendResponse({ ok: true });
  return;
}

// ===== GET_NAVAID_INDEX =====
if (msg?.type === "GET_NAVAID_INDEX") {
  await loadOurAirportsNavaids();
  sendResponse({ ok: true, index: NAVAID_INDEX });
  return;
}

// ===== LOOKUP_NAVAID =====
if (msg?.type === "LOOKUP_NAVAID") {
  await loadOurAirportsNavaids();
  const ident = String(msg.ident || "").trim().toUpperCase();
  const hit = NAVAID_INDEX?.[ident] || null;
  sendResponse({ ok: true, hit });
  return;
}


/* ===============================
   SEARCH PROCEDURES (NATIONWIDE)
=============================== */

if (msg?.type === "SEARCH_PROCEDURES") {

  const query = String(msg.query || "").trim().toUpperCase();

  if (!query) {
    sendResponse({ ok:true, results:[] });
    return;
  }

  await ensureNasrProceduresLoaded();

  const results = [];

  for (const [airport, data] of SIDSTAR_MEM_INDEX.entries()) {

    for (const p of data.departures || []) {

      const name = (p.displayName || p.name || "").toUpperCase();

      const score =
        fuzzyScore(name, query) +
        phoneticScore(name, query);

      if (score <= 0) continue;

      results.push({
        airport,
        type: "SID",
        name: p.displayName || p.name,
        code: p.code,
        score
      });
    }

    for (const p of data.arrivals || []) {

      const name = (p.displayName || p.name || "").toUpperCase();

      const score =
        fuzzyScore(name, query) +
        phoneticScore(name, query);

      if (score <= 0) continue;

      results.push({
        airport,
        type: "STAR",
        name: p.displayName || p.name,
        code: p.code,
        score
      });
    }

  }

  results.sort((a,b)=>b.score-a.score);

  sendResponse({
    ok:true,
    results: results.slice(0,200)
  });

  return;
}


      sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});

let lastDetectedAirport = null;


function parseReplayFromGlobalKey(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
const foreign = parseGlobalKeyAirportDateTime(rawText);
if (foreign) return foreign;
  // ---------- NEW FORMAT ----------
  // 250914_0726_115.wav
  // YYMMDD_HHMM_...
  let m = raw.match(/\b(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})_\d+\.wav\b/i);
  if (m) {
    const yy = Number(m[1]);
    const year = String(yy >= 70 ? 1900 + yy : 2000 + yy); // safe pivot
    const month = m[2];
    const day = m[3];
    const hour = m[4];
    const minute = m[5];

    return {
      replay: `${year}-${month}-${day}-${hour}:${minute}`,
      airport: extractICAOFromKey(raw) || null,
      format: "new_compact"
    };
  }

  // ---------- OLD FORMAT ----------
  // ...-Sep-14-2025-0726Z_...
  m = raw.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{1,2})-(\d{4})-(\d{4})Z/i
  );

  if (m) {
    const months = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
    };

    const year = m[3];
    const month = months[m[1]];
    const day = String(m[2]).padStart(2, "0");
    const hour = m[4].slice(0, 2);
    const minute = m[4].slice(2, 4);

    return {
      replay: `${year}-${month}-${day}-${hour}:${minute}`,
      airport: extractICAOFromKey(raw) || null,
      format: "old_named"
    };
  }

  return null;
}

function buildAdsbReplayUrl(rawText) {
  const parsed = parseReplayFromGlobalKey(rawText);
  if (!parsed?.replay) return null;

  let airport =
    parsed.airport || extractICAOFromKey(rawText);

  const badAirportTokens = new Set([
    "CENT", "CENTER", "CENTRE", "CTR",
    "APP", "DEP", "TWR", "GND",
    "RADAR", "FINAL", "FINA"
  ]);

  if (airport && badAirportTokens.has(String(airport).toUpperCase())) {
    airport = extractAirportFromDashedKey(rawText);
  }

  const airportParam =
    /^[A-Z]{3,4}$/.test(airport || "")
      ? `&airport=${encodeURIComponent(airport)}`
      : "";

  return `https://globe.adsbexchange.com/?replay=${encodeURIComponent(parsed.replay)}${airportParam}`;
}

function clampPopupSpeed(v) {
  const n = Number(v);
  return Math.max(0, Math.min(988, Number.isFinite(n) ? n : 500));
}

// =============================
// Tab Helpers
// =============================

function openOrReuseTabBackgroundAsync(url, storageKey, patterns = [], preferPattern = false) {
  return new Promise((resolve) => {

    const create = () => {
      chrome.tabs.create({ url, active: false }, (tab) => {
        if (tab?.id != null)
          chrome.storage.local.set({ [storageKey]: tab.id });
        resolve(tab?.id);
      });
    };

    const update = (id) => {
      chrome.tabs.update(id, { url, active: false }, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          findOrCreate();
          return;
        }
        chrome.storage.local.set({ [storageKey]: id });
        resolve(id);
      });
    };

    const findOrCreate = () => {
      if (!patterns.length) return create();
      chrome.tabs.query({ url: patterns }, (tabs) => {
        const existing = tabs?.[0];
        if (existing?.id != null) update(existing.id);
        else create();
      });
    };

    if (preferPattern) {
      findOrCreate();
    } else {
      chrome.storage.local.get([storageKey], (res) => {
        const saved = res[storageKey];
        if (typeof saved === "number") update(saved);
        else findOrCreate();
      });
    }

  });
}

async function waitForTabComplete(tabId) {
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (t) => {
      if (t?.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

// =============================
// ADSB UI Wait
// =============================

async function waitForAdsbReplayUI(tabId) {

  for (let i = 0; i < 60; i++) {

    const ready = await new Promise((resolve) => {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        func: () => {
          return !!(
            document.getElementById("replayPlay") &&
            document.getElementById("replaySpeedSelect") &&
            document.getElementById("replaySpeedHint")
          );
        }
      }, (r) => resolve(!!r?.[0]?.result));
    });

    if (ready) return true;
    await new Promise(r => setTimeout(r, 250));
  }

  return false;
}

// =============================
// Force Pause
// =============================

async function adsbForcePausedFor(tabId, ms = 6000) {

  // ✅ If user already took control, never fight them
  if (ADSB_AUTOPAUSE_DISABLED_BY_TAB.get(tabId)) return;

  // Optional: extra short override window if you want
  if (Date.now() < USER_OVERRIDE_UNTIL) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [ms],
    func: (duration) => {

      const start = Date.now();

      const pauseIfNeeded = () => {
        // ✅ If user pressed play, stop immediately
        if (window.__ADSB_DISABLE_AUTOPAUSE__ === true) return false;

        const btn = document.getElementById("replayPlay");
        if (!btn) return true;

        const text = btn.textContent.trim().toLowerCase();
        if (text === "pause") btn.click(); // scripted click (not trusted)
        return true;
      };

      // run once
      if (!pauseIfNeeded()) return;

      const iv = setInterval(() => {
        const keepGoing = pauseIfNeeded();
        if (!keepGoing || (Date.now() - start >= duration)) clearInterval(iv);
      }, 250);
    }
  });
}

// =============================
// ADSB Speed Injection (Binary Search)
// =============================

async function applyAdsbexchangeReplaySpeed(tabId, popupSpeedVal) {

  const targetSpeed = clampPopupSpeed(popupSpeedVal);

  for (let attempt = 0; attempt < 25; attempt++) {

    const res = await new Promise((resolve) => {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        args: [targetSpeed],
        func: (target) => {

          const hintEl = document.getElementById("replaySpeedHint");
          const sliderEl = document.getElementById("replaySpeedSelect");
          if (!hintEl || !sliderEl) return { ok: false };

          if (typeof window.jQuery !== "function") return { ok: false };

          const $ = window.jQuery;
          const $slider = $("#replaySpeedSelect");
          if (typeof $slider.slider !== "function") return { ok: false };

          const inst = $slider.slider("instance");
          if (!inst) return { ok: false };

          const parseHint = () => {
            const m = hintEl.textContent.match(/Speed:\s*([0-9.]+)\s*x/i);
            return m ? Number(m[1]) : NaN;
          };

          const fire = (value) => {
            const ui = { value, values: [value], handle: inst.handle?.[0] };

            try { $slider.slider("value", value); } catch {}
            try { inst._trigger("slide", null, ui); } catch {}
            try { inst._trigger("change", null, ui); } catch {}
            try { inst._trigger("stop", null, ui); } catch {}
          };

          let min = 0, max = 10;

          const initial = parseHint();
          if (!Number.isFinite(initial)) return { ok: false };

          let lo = min;
          let hi = max;
          let bestV = min;
          let bestHint = initial;

          for (let i = 0; i < 18; i++) {

            const mid = (lo + hi) / 2;
            fire(mid);

            const h = parseHint();
            if (!Number.isFinite(h)) return { ok: false };

            if (Math.abs(h - target) < Math.abs(bestHint - target)) {
              bestHint = h;
              bestV = mid;
            }

            if (h < target) lo = mid;
            else hi = mid;
          }

          fire(bestV);
          return { ok: true };
        }
      }, (r) => resolve(r?.[0]?.result));
    });

    if (res?.ok) return true;
    await new Promise(r => setTimeout(r, 250));
  }

  return false;
}

async function installAdsbUserPlayDetector(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      // idempotent
      if (window.__ADSB_USER_LISTENER_INSTALLED__) return;
      window.__ADSB_USER_LISTENER_INSTALLED__ = true;

      // default: autopause allowed until user says otherwise
      window.__ADSB_DISABLE_AUTOPAUSE__ = false;

      document.addEventListener(
        "click",
        (e) => {
          const btn = e.target.closest("#replayPlay");
          if (!btn) return;

          // ✅ IMPORTANT:
          // - ADSB "auto-play" is NOT a click
          // - our own scripted clicks are NOT trusted
          // So only a real user click can disable autopause
          if (!e.isTrusted) return;

          window.__ADSB_DISABLE_AUTOPAUSE__ = true;

          chrome.runtime.sendMessage({ type: "ADSB_USER_PRESSED_PLAY" });
        },
        true
      );
    }
  });
}
// =============================
// Core Runner
// =============================

async function forceAdsbDateFinal(tabId, replay) {

  const [year, month, day] = replay.split("-").map(Number);

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [year, month, day],
    func: (year, month, day) => {

      function trySet() {

        const el = document.getElementById("replayDatepicker");
        if (!el || !window.$) return false;

        const inst = $.datepicker._getInst(el);
        if (!inst) return false;

        const date = new Date(year, month - 1, day);

        console.log("Setting ADSB date (final):", date);

        // ✅ Step 1: set UI
        $(el).datepicker("setDate", date);

        // 🔥 Step 2: trigger REAL commit
        if (inst.settings?.onSelect) {
          inst.settings.onSelect.call(el, $(el).val(), inst);
        }

        return true;
      }

      function waitLoop() {
        if (!trySet()) {
          setTimeout(waitLoop, 300);
        }
      }

      waitLoop();
    }
  });
}


async function runSelectedActions(rawText, settings) {

  const icao = extractICAOFromKey(rawText);

  // ===== ADSB =====
  if (settings.adsb) {
  const url = buildAdsbReplayUrl(rawText);
  if (url) {

    const newReplayKey = replayKeyFromUrl(url);

    const tabId = await openOrReuseTabBackgroundAsync(
      url,
      ADSB_TAB_KEY,
      ["*://globe.adsbexchange.com/*"]
    );

    if (typeof tabId === "number") {

      // ✅ New replay => allow autopause again until user presses play
      // (If you want “once per tab ever”, remove this reset.)
      ADSB_AUTOPAUSE_DISABLED_BY_TAB.set(tabId, false);

      await waitForTabComplete(tabId);

      const ready = await waitForAdsbReplayUI(tabId);
      const replay = replayKeyFromUrl(url);
      await forceAdsbDateFinal(tabId, replay);
      if (ready) {

        // Install the user detector ASAP
        await installAdsbUserPlayDetector(tabId);

        // Make sure page flag is sane on load
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => { window.__ADSB_DISABLE_AUTOPAUSE__ = false; }
        });

        await adsbForcePausedFor(tabId, 6000);
        await applyAdsbexchangeReplaySpeed(tabId, settings.adsbSpeed);
        await adsbForcePausedFor(tabId, 4000);
      }
    }
  }
}

  if (!icao) return;

  // ===== SkyVector =====
  if (settings.skyvector) {
    await openOrReuseTabBackgroundAsync(
      `https://skyvector.com/airport/${icao}`,
      SKYVECTOR_TAB_KEY,
      ["*://skyvector.com/*"],
      true
    );
  }

  // ===== OpenNav =====
  if (settings.opennav) {
    await openOrReuseTabBackgroundAsync(
      `https://opennav.com/airport/${icao}`,
      OPENNAV_TAB_KEY,
      ["*://opennav.com/*"]
    );
  }

  // ===== AirNav =====
  if (settings.airnav) {
    await openOrReuseTabBackgroundAsync(
      `https://www.airnav.com/airport/${icao}`,
      AIRNAV_TAB_KEY,
      ["*://www.airnav.com/*"]
    );
  }

  // ===== ForeFlight =====
  if (settings.foreflight) {
    await openOrReuseTabBackgroundAsync(
      `https://plan.foreflight.com/map`,
      FF_TAB_KEY,
      ["*://plan.foreflight.com/*"]
    );
  }

// ===== FixesFinder =====
// ===== FixesFinder =====
if (settings.fixesfinder) {

  const tabId = await openOrReuseTabBackgroundAsync(
    `https://fixesfinder.com/facilities`,
    FIXESFINDER_TAB_KEY,
    ["*://fixesfinder.com/*"]
  );

  if (typeof tabId === "number") {

    await waitForTabComplete(tabId);

    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",   // ⭐ THIS IS THE KEY FIX
      args: [icao],
      func: (icao) => {

        function waitForBox() {

          const box = document.getElementById("aptSearch");

          if (!box) {
            setTimeout(waitForBox, 300);
            return;
          }

          console.log("FixesFinder typing ICAO:", icao);

          box.focus();
          box.value = "";

          for (const c of icao) {

            box.value += c;

            box.dispatchEvent(new KeyboardEvent("keydown", {
              key: c,
              bubbles: true
            }));

            box.dispatchEvent(new KeyboardEvent("keyup", {
              key: c,
              bubbles: true
            }));

            box.dispatchEvent(new Event("input", { bubbles: true }));
          }

          box.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true
          }));

          box.dispatchEvent(new KeyboardEvent("keyup", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true
          }));

        }

        waitForBox();

      }
    });

  }
}


}

// =============================
// Auto-run when Global Key changes
// =============================

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (!changes.lb_pageKey?.newValue) return;

  const newKey = changes.lb_pageKey.newValue;
  if (!newKey) return;

  // Prevent duplicate auto-run in same worker session
  if (newKey === lastAutoOpenedKey) return;

  lastAutoOpenedKey = newKey;

  const { lbx_settings } =
    await chrome.storage.local.get("lbx_settings");

  await runSelectedActions(newKey, lbx_settings || {});
});

function replayParamToSecOfDay(replayStr) {
  // replayStr like "2026-02-08-07:48"
  const m = String(replayStr).match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  return hh * 3600 + mm * 60;
}


function safeUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function safeStr(v) {
  return String(v || "").trim();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

/**
 * Converts DMS like:
 * 31° 31' 13.59" N
 * 065° 52' 20.14" E
 */
function dmsToDecimal(str) {
  if (!str) return null;

  const s = String(str).trim();

  const m = s.match(/(\d+)[°]\s*(\d+)'\s*(\d+(?:\.\d+)?)"\s*([NSEW])/i);
  if (!m) return null;

  const deg = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const hemi = m[4].toUpperCase();

  let val = deg + (min / 60) + (sec / 3600);
  if (hemi === "S" || hemi === "W") val *= -1;
  return val;
}

/** Great-circle distance in NM */
function distanceNm(lat1, lon1, lat2, lon2) {
  const R_KM = 6371;
  const toRad = (d) => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = R_KM * c;
  return km * 0.539957;
}

function gridKey(lat, lon, sizeDeg = 1) {
  return `${Math.floor(lat / sizeDeg)}:${Math.floor(lon / sizeDeg)}:${sizeDeg}`;
}


function parseCsvText(text) {
  // If you already have parseCSV(text) in csv.js, use that instead.
  // Replace this whole function with: return parseCSV(text);
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }

    if (ch === "\r") {
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] ?? "";
    });
    return obj;
  });
}


function normalizeWaypoint(row) {
  // CSV headers may be "IDENT,LAT,LON" (decimal) or "Ident,Latitude,Longitude" (DMS) — handle both
  const ident = safeUpper(
    row["IDENT"] || row["Ident"] || row["ident"] || ""
  );
  const country = safeUpper(
    row["Country Code"] || row["COUNTRY CODE"] || row["country code"] || row["Country_Code"] || ""
  );
  const countryName = safeStr(
    row["Country Name"] || row["COUNTRY NAME"] || row["country name"] || ""
  );

  // Prefer decimal columns (LAT/LON); fall back to DMS columns (Latitude/Longitude)
  let lat = toNum(row["LAT"] ?? row["lat"]);
  let lon = toNum(row["LON"] ?? row["lon"]);
  if (lat == null) lat = dmsToDecimal(row["Latitude"] || row["LATITUDE"] || "");
  if (lon == null) lon = dmsToDecimal(row["Longitude"] || row["LONGITUDE"] || "");

  if (!ident || lat == null || lon == null) return null;

  return {
    ident,
    name: ident,
    kind: "waypoint",
    subtype: null,
    country,
    countryName,
    airport: null,
    lat,
    lon,
    searchText: `${ident} WAYPOINT ${country} ${countryName}`.toUpperCase()
  };
}

function normalizeNavaid(row) {
  const ident = safeUpper(row["ident"]);
  const name = safeStr(row["name"]);
  const subtype = safeUpper(row["type"]);
  const country = safeUpper(row["country code"]);
  const airport = safeUpper(row["airport"]) || null;
  const lat = toNum(row["latitude"]);
  const lon = toNum(row["longitude"]);

  if (!ident || lat == null || lon == null) return null;

  return {
    ident,
    name: name || ident,
    kind: "navaid",
    subtype: subtype || null,
    country,
    countryName: null,
    airport,
    lat,
    lon,
    searchText: `${ident} ${name} ${subtype} ${country} ${airport || ""}`.toUpperCase()
  };
}



async function loadBundledCsvText(filename) {
  const cached = await getCachedFile(filename);
  if (cached) return cached;

  const url = chrome.runtime.getURL(filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: ${res.status}`);

  const buf = await res.arrayBuffer();
  const decoder = new TextDecoder("latin1");
  return decoder.decode(buf);
}

async function loadGlobalWaypoints() {
  try {
    const text = await loadBundledCsvText("waypoints.csv");
    const rows = parseCsvText(text);

    GLOBAL_WAYPOINTS = rows
      .map(normalizeWaypoint)
      .filter(Boolean);

    GLOBAL_DATA_READY.waypoints = true;
    console.log("[Sandcat] Loaded global waypoints:", GLOBAL_WAYPOINTS.length);
  } catch (err) {
    console.error("[Sandcat] Failed loading waypoints.csv", err);
    GLOBAL_WAYPOINTS = [];
  }
}

async function loadGlobalNavaids() {
  try {
    const text = await loadBundledCsvText("navaids.csv");
    const rows = parseCsvText(text);

    GLOBAL_NAVAIDS = rows
      .map(normalizeNavaid)
      .filter(Boolean);

    GLOBAL_DATA_READY.navaids = true;
    console.log("[Sandcat] Loaded global navaids:", GLOBAL_NAVAIDS.length);
  } catch (err) {
    console.error("[Sandcat] Failed loading navaids.csv", err);
    GLOBAL_NAVAIDS = [];
  }
}


function buildGlobalIndexes() {
  GLOBAL_POINTS = [...GLOBAL_WAYPOINTS, ...GLOBAL_NAVAIDS];

  GLOBAL_BY_IDENT.clear();
  GLOBAL_GRID.clear();

  for (const pt of GLOBAL_POINTS) {
    // ident index
    if (!GLOBAL_BY_IDENT.has(pt.ident)) {
      GLOBAL_BY_IDENT.set(pt.ident, []);
    }
    GLOBAL_BY_IDENT.get(pt.ident).push(pt);

    // spatial grid
    const key = gridKey(pt.lat, pt.lon, 1);
    if (!GLOBAL_GRID.has(key)) {
      GLOBAL_GRID.set(key, []);
    }
    GLOBAL_GRID.get(key).push(pt);
  }

  GLOBAL_DATA_READY.all = true;
  console.log("[Sandcat] Built global indexes:", {
    total: GLOBAL_POINTS.length,
    idents: GLOBAL_BY_IDENT.size,
    gridCells: GLOBAL_GRID.size
  });
}

// ===== ENSURE LOADED =====
async function ensureGlobalDataLoaded() {
  if (GLOBAL_DATA_READY.all) return;

  await Promise.all([
    loadGlobalWaypoints(),
    loadGlobalNavaids()
  ]);

  buildGlobalIndexes();
  addWaypointsToFixGrid();
}

function scoreGlobalPoint(pt, q) {
  let score = 0;
  const ident = pt.ident || "";
  const name = safeUpper(pt.name);
  const subtype = safeUpper(pt.subtype);
  const country = safeUpper(pt.country);

  if (ident === q) score += 1000;
  else if (ident.startsWith(q)) score += 700;
  else if (ident.includes(q)) score += 400;

  if (name === q) score += 300;
  else if (name.startsWith(q)) score += 180;
  else if (name.includes(q)) score += 90;

  if (subtype && subtype.includes(q)) score += 50;
  if (country && country === q) score += 40;

  if (pt.kind === "navaid") score += 10; // slight preference if tied

  return score;
}

function searchGlobalPoints(query, opts = {}) {
  const q = safeUpper(query);
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;
  const countryFilter = safeUpper(opts.country || "");

  let candidates = GLOBAL_POINTS;

  if (countryFilter) {
    candidates = candidates.filter(pt => safeUpper(pt.country) === countryFilter);
  }

  if (!q) {
    return candidates.slice(0, limit);
  }

  const scored = [];
  const seen = new Set();

  for (const pt of candidates) {
    const score = fuzzyGlobalScore(pt, q);
    if (score <= 0) continue;

    const key = `${pt.kind}|${pt.ident}|${pt.lat}|${pt.lon}|${pt.country}|${pt.subtype || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    scored.push({ ...pt, _score: score });
  }

  scored.sort((a, b) => b._score - a._score);

  return scored
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}

function findNearbyGlobalPoints(lat, lon, radiusNm = 20, limit = 50) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const sizeDeg = 1;
  const baseLat = Math.floor(lat / sizeDeg);
  const baseLon = Math.floor(lon / sizeDeg);

  const candidates = [];
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const key = `${baseLat + dLat}:${baseLon + dLon}:${sizeDeg}`;
      const arr = GLOBAL_GRID.get(key);
      if (arr?.length) candidates.push(...arr);
    }
  }

  const results = candidates
    .map(pt => ({
      ...pt,
      distanceNm: distanceNm(lat, lon, pt.lat, pt.lon)
    }))
    .filter(pt => pt.distanceNm <= radiusNm)
    .sort((a, b) => a.distanceNm - b.distanceNm)
    .slice(0, limit);

  return results;
}




globalThis.debugCIFP = function () {

  try {

    const procIndex =
      globalThis.PROC_INDEX ||
      globalThis.procIndex ||
      {};

    const procFixMaster =
      globalThis.PROC_FIX_MASTER ||
      globalThis.procFixMaster ||
      [];

    console.log("====== CIFP DEBUG ======");

    console.log("PROC_INDEX airports:",
      Object.keys(procIndex).length);

    let procedureCount = 0;
    const procedureNames = new Set();

    for (const airport in procIndex) {

      const types = procIndex[airport];

      for (const type in types) {

        for (const p of types[type]) {

          procedureCount++;

          procedureNames.add(
            p.displayName || p.name || p.code
          );

        }

      }

    }

    console.log("Total procedures:", procedureCount);
    console.log("Unique procedure names:", procedureNames.size);

    console.log(
      "PROC_FIX_MASTER entries:",
      procFixMaster.length
    );

    const known = [
      "DSNEE",
      "CHSLY",
      "BENKY",
      "PECKS",
      "BAYLR",
      "TRUKN",
      "HOBTT",
      "EAGUL"
    ];

    console.log("------ Known procedure checks ------");

    for (const name of known) {

      const found = procFixMaster.some(x =>
        (x.procedures || []).some(p =>
          (p.displayName || p.name || "")
            .toUpperCase()
            .includes(name)
        )
      );

      console.log(name, found ? "FOUND" : "MISSING");

    }

    console.log("====== END DEBUG ======");

  } catch (err) {

    console.error("CIFP debug failed:", err);

  }

};

// ===== INIT GLOBAL DATA ON STARTUP =====
ensureGlobalDataLoaded().catch(err => {
  console.error("[Sandcat] Global data init failed", err);
});

// ===== DATA UPDATE MESSAGE HANDLER =====
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "UPDATE_DATA_FILES") return;

  (async () => {
    try {
      const results = await updateDataFiles((message) => {
        chrome.runtime.sendMessage({ type: "DATA_UPDATE_PROGRESS", message }).catch(() => {});
      });

      // Force reload in-memory data from newly cached files
      GLOBAL_DATA_READY.waypoints = false;
      GLOBAL_DATA_READY.navaids = false;
      GLOBAL_DATA_READY.all = false;
      await Promise.all([
        loadSwissProcedures(),
        loadAustraliaProcedures(),
        loadAusVfrVisualWaypoints(),
        ensureGlobalDataLoaded()
      ]);

      chrome.runtime.sendMessage({ type: "DATA_UPDATE_DONE", results }).catch(() => {});
    } catch (err) {
      chrome.runtime.sendMessage({ type: "DATA_UPDATE_ERROR", error: err.message }).catch(() => {});
    }
  })();
});


