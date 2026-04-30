
  const FIX_PROCEDURE_MAP = {};
  const FIX_AIRWAY_MAP = {};
  let FACILITY_FREQ_INDEX = [];
let PROC_FIX_MASTER = [];
let LAST_LOADED_AIRPORT = null;
let AIRPORT_FREQ_INDEX = null;
let ACTIVE_ROUTE_RENDER = 0;

window.addEventListener("error", e => {
  console.error("POPUP CRASH:", e.message, "at", e.filename, ":", e.lineno);
});

function showPopupCrash(msg) {
  let box = document.getElementById("sandcatCrashBox");

  if (!box) {
    box = document.createElement("div");
    box.id = "sandcatCrashBox";
    box.style.position = "fixed";
    box.style.left = "12px";
    box.style.bottom = "12px";
    box.style.zIndex = "999999";
    box.style.maxWidth = "650px";
    box.style.maxHeight = "220px";
    box.style.overflow = "auto";
    box.style.background = "#3b0a0a";
    box.style.color = "#fff";
    box.style.border = "2px solid #ff4d4d";
    box.style.borderRadius = "8px";
    box.style.padding = "10px";
    box.style.fontSize = "12px";
    box.style.whiteSpace = "pre-wrap";
    document.body.appendChild(box);
  }

  box.textContent += "\n" + msg;
}

window.addEventListener("error", e => {
  showPopupCrash(`POPUP CRASH: ${e.message}\n${e.filename}:${e.lineno}`);
});

window.addEventListener("unhandledrejection", e => {
  showPopupCrash(`PROMISE CRASH: ${e.reason?.message || e.reason}`);
});

window.addEventListener("unhandledrejection", e => {
  console.error("PROMISE CRASH:", e.reason);
});
window.originalConsoleLog = console.log;

console.log = (...args) => {
  window.__popupLog = window.__popupLog || [];
  window.__popupLog.push(args);
  window.__popupLog = window.__popupLog.slice(-200);
  window.originalConsoleLog(...args);
};

window.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "ROUTE_FIX_STREAM") {
    if (ACTIVE_ROUTE_RENDER > 0) return;

    const list = document.getElementById("routeResults");
    if (!list) return;

    const row = document.createElement("div");
    row.className = "routeFix";

    const fx = String(msg.fix || "").toUpperCase();
    const nav = NAVAIDS?.[fx];

    const displayText = nav?.name ? nav.name.toUpperCase() : fx;
    const copyText = nav?.name ? nav.name.toUpperCase() : fx;

    let label = nav?.name ? `${displayText} (${fx})` : displayText;

    const procs = FIX_PROCEDURE_MAP?.[fx];

    if (procs?.length) {
      const unique = new Map();

      for (const p of procs) {
        const name = p.procDisplay || p.proc || "";
        if (!unique.has(name)) unique.set(name, p.type);
      }

      for (const [name, type] of unique) {
        let cls = "procSID";
        if (type === "STAR") cls = "procSTAR";
        if (type === "IAP") cls = "procAPP";

        label += ` <span class="procTag ${cls}">${name}</span>`;
      }
    }

    const airways = FIX_AIRWAY_MAP?.[fx];

    if (airways?.length) {
      for (const aw of [...new Set(airways)]) {
        label += ` <span class="procTag procAIRWAY">${aw}</span>`;
      }
    }

    row.innerHTML = label;

    row.addEventListener("click", async () => {
      await copyWithFeedback(row, copyText);
    });

    list.appendChild(row);
  }

  if (msg.type === "ACTIVE_FLIGHT_DATA") {
    if (msg.data?.routeParts) {
      for (const part of msg.data.routeParts) {
        if (!part.airway) continue;

        for (const fix of part.fixes || []) {
          const key = String(fix || "").toUpperCase();

          if (!FIX_AIRWAY_MAP[key]) FIX_AIRWAY_MAP[key] = [];
          FIX_AIRWAY_MAP[key].push(part.airway);
        }
      }
    }

    const fixes = msg.data?.adsb_active_flight_fixes || [];

    
    if (typeof applyActiveFlightFixesToUI === "function") {
  await applyActiveFlightFixesToUI(fixes);
}
  
    renderFlightAnalysis(
      null,
      fixes,
      { ident: msg.data.adsb_active_flight_origin },
      { ident: msg.data.adsb_active_flight_destination },
      null
    );
  }

  if (msg.type === "CLEAR_ROUTE") {
    const list = document.getElementById("routeResults");
    if (list) list.innerHTML = "";
  }
});
const $ = (id) => document.getElementById(id);

let LAST_RESULTS = [];
let LAST_CENTER = "";
let MASTER_RESULTS = [];
let WAYPOINT_SEARCH_TOKEN = 0;
let waypointDebounce = null;
let NAVAIDS = null; // { IDENT: {name,type,freq,...} }


const AIRPORT_NAME_MAP = {};

document.addEventListener("DOMContentLoaded", () => {

  const resultsSearch = document.getElementById("resultsSearch");
  if (resultsSearch) {
    resultsSearch.addEventListener("input", () => {
      filterAirportSideResults(resultsSearch.value);
    });
  }

  /* -----------------------------
     RESTORE UI STATE
  ----------------------------- */
  chrome.storage.local.get("sandcat_ui_state", ({ sandcat_ui_state }) => {
    if (!sandcat_ui_state) return;

    const s = sandcat_ui_state;

    if ("hideNoApp" in s)
      document.getElementById("filterNoApproaches").checked = s.hideNoApp;

    if ("mainOnly" in s)
      document.getElementById("mainOnlyToggle").checked = s.mainOnly;

    if ("typesMode" in s)
      document.getElementById("types").value = s.typesMode;

    if ("radius" in s)
      document.getElementById("radiusNm").value = s.radius;

    if ("maxResults" in s)
      document.getElementById("maxResults").value = s.maxResults;
  });

  /* -----------------------------
     ATTACH SAVE LISTENERS
  ----------------------------- */
  [
    "filterNoApproaches",
    "mainOnlyToggle",
    "types",
    "radiusNm",
    "maxResults"
  ].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", saveUIState);
    el.addEventListener("input", saveUIState);
  });

});

function buildAirportNameMap(){

  for (const k in AIRPORT_NAME_MAP){
    delete AIRPORT_NAME_MAP[k];
  }

  for(const a of MASTER_RESULTS || []){

    const ident = String(a.ident || "").toUpperCase();
    if(!ident) continue;

    AIRPORT_NAME_MAP[ident] = a.name || "";
  }

}


async function maybeQueryNearby(ident) {

  ident = String(ident || "").trim().toUpperCase();
  if (!ident) return;

  const {
    nearby_cache,
    last_query_signature
  } = await chrome.storage.local.get([
    "nearby_cache",
    "last_query_signature"
  ]);

  const radius_nm =
    Number(document.getElementById("radiusNm")?.value || 0);

  const requestedMax =
    Number(document.getElementById("maxResults")?.value || 25);

  const hideNoApp =
    document.getElementById("filterNoApproaches")?.checked === true;

  const mainOnly =
    document.getElementById("mainOnlyToggle")?.checked === true;

  const typesMode =
    document.getElementById("types")?.value;

  const includeHelipads =
    typesMode === "helipads_only" ||
    typesMode === "airports_plus_helipads";

const intlMode = !isDomesticSandcatICAO(ident);

    
const querySignature = JSON.stringify({
  ident,
  radius_nm,
  requestedMax,
  hideNoApp,
  mainOnly,
  typesMode,
  includeHelipads,
  intlMode
});


  
if (ident === LAST_LOADED_AIRPORT) {
  console.log("Same airport already loaded");
  return;
}

if (querySignature === last_query_signature) {
  console.log("Skipping reload (same query)");
  return;
}

  console.log("Query changed → running search");
  await queryNearby(false);
}


async function copyTextSafe(text) {

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;

      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";

      document.body.appendChild(textarea);
      textarea.select();

      document.execCommand("copy");

      document.body.removeChild(textarea);

      return true;

    } catch (err) {
      console.warn("Clipboard fallback failed", err);
      return false;
    }

  }

}
async function copyWithFeedback(row, text) {

  const success = await copyTextSafe(text);

  if (!success) return;

const original = row.innerHTML;

  row.textContent = "Copied ✓";
  row.style.opacity = "1";
  row.classList.add("copied");

  setTimeout(() => {
row.innerHTML = original;
    row.style.opacity = "";
    row.classList.remove("copied");
  }, 800);

}


function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isError ? " error" : "");
}

function openFixPopover(anchorEl, title, text) {
  const pop = document.getElementById("fixPopover");
  const titleEl = document.getElementById("fixPopoverTitle");
  const content = document.getElementById("fixPopoverContent");

  titleEl.textContent = title;
  content.textContent = text;

  pop.classList.remove("hidden");

  const rect = anchorEl.getBoundingClientRect();

  const padding = 8;
  let left = rect.left;
  let top = rect.bottom + 6;

  // Keep inside viewport
  if (left + 220 > window.innerWidth - padding) {
    left = window.innerWidth - 220 - padding;
  }

  if (top + 240 > attachingBottom()) {
    top = rect.top - 240 - 6;
  }

  pop.style.left = `${Math.max(padding, left)}px`;
  pop.style.top = `${Math.max(padding, top)}px`;
}

function attachingBottom() {
  return window.innerHeight - 8;
}

function closeFixPanel() {
  const panel = document.getElementById("fixPanel");
  if (panel) panel.classList.add("hidden");
}

document.addEventListener("click", (e) => {
  const pop = document.getElementById("fixPopover");
  if (!pop) return;

  if (!pop.contains(e.target)) {
    pop.classList.add("hidden");
  }
});

document.getElementById("fixPopoverClose")
  ?.addEventListener("click", () => {
    document.getElementById("fixPopover").classList.add("hidden");
  });

  document.getElementById("mainOnlyToggle")
  ?.addEventListener("change", () => {
    renderResults(MASTER_RESULTS, LAST_CENTER);
  });


function makeChip(label, cursor = "default") {
  const span = document.createElement("span");
  span.textContent = label;
  span.style.display = "inline-block";
  span.style.padding = "3px 8px";
  span.style.border = "1px solid #ddd";
  span.style.borderRadius = "999px";
  span.style.margin = "4px 6px 0 0";
  span.style.cursor = cursor;
  span.style.userSelect = "none";
  return span;
}

function makeButtonChip(label, isActive = false) {
  const c = makeChip(label, "pointer");
  c.style.borderColor = isActive ? "#555" : "#ddd";
  c.style.fontWeight = isActive ? "600" : "400";
  c.style.background = isActive ? "rgba(0,0,0,0.04)" : "transparent";
  return c;
}

function runwayLineText(r) {
  const dims = `${r.length_ft || "?"}x${r.width_ft || "?"} ft`;
  const flags = [
    r.surface ? r.surface : null,
    r.lighted === "1" ? "LGT" : null,
    r.closed === "1" ? "CLOSED" : null
  ].filter(Boolean).join(" • ");
  return `${(r.ident1 || "?")}/${(r.ident2 || "?")} — ${dims}${flags ? " — " + flags : ""}`;
}

/* -------- SID/STAR tooltip chips -------- */

function procChip(procObj, airportIdent, procType) {

let label = procObj.displayName;

if (!label && procObj.code) {

  const parts = procObj.code.split(".");

  if (parts.length >= 2) {
    label = parts[1];   // BENKY1
  }

}

if (!label) label = procObj.name;

const span = makeChip(label, "pointer");

  span.addEventListener("click", async (e) => {
    e.stopPropagation();

    const resp = await chrome.runtime.sendMessage({
      type: "GET_PROC_FIXES",
      procType,
      procName: procObj.name,
      procCode: procObj.code
    });

    if (!resp || !resp.ok) {
      openFixPopover(span, procObj.name, resp?.error || "No response.");
      return;
    }

    if (!resp.fixes?.length) {
      openFixPopover(span, procObj.name, "No fixes found.");
      return;
    }

    const sorted = resp.fixes.slice().sort((a,b)=>a.localeCompare(b));
    // cache fix membership
for (const fx of resp.fixes || []) {

  const key = fx.toUpperCase();

  if (!FIX_PROCEDURE_MAP[key]) {
    FIX_PROCEDURE_MAP[key] = [];
  }
FIX_PROCEDURE_MAP[key].push({
  type: procType,
  proc: procObj.code || procObj.name,
  procDisplay: procObj.displayName || procObj.name
});

}
openFixPopover(span, procObj.name, " ");
await renderFixListInPopover(procObj.name, sorted);
  });

  return span;
}

function ausProcChip(procName, fixes, procType) {
function cleanAusProcName(name) {
  return String(name || "")
    .replace(/^SID\s+/i, "")
    .replace(/^STAR\s+/i, "")

    // remove redundant words
    .replace(/\b(ARRIVAL|ARRIVALS|DEPARTURE|DEPARTURES|DEP)\b/gi, "")

    // ✅ THIS IS THE NEW LINE
    .replace(/\bALPHA\b/gi, "ALFA")

    // remove runway clutter
    .replace(/\s*-\s*RUNWAYS.*$/i, "")

    // clean spacing
    .replace(/\s+/g, " ")
    .trim();
}
const label = cleanAusProcName(procName);
const span = makeChip(label, "pointer");

  span.addEventListener("click", async (e) => {
    e.stopPropagation();

    const cleanFixes = [...new Set(
      (fixes || [])
        .map(f => String(f || "").trim().toUpperCase())
        .filter(Boolean)
    )];

    if (!cleanFixes.length) {
      openFixPopover(span, procName, "No fixes parsed.");
      return;
    }

    for (const fx of cleanFixes) {
      if (!FIX_PROCEDURE_MAP[fx]) {
        FIX_PROCEDURE_MAP[fx] = [];
      }

      FIX_PROCEDURE_MAP[fx].push({
        airport: "",
        type: procType,
        proc: procName,
        procDisplay: procName
      });
    }

    openFixPopover(span, procName, " ");
    await renderFixListInPopover(procName, cleanFixes);
  });

  return span;
}

async function renderFixListInPopover(title, fixes) {
  const pop = document.getElementById("fixPopover");
  const titleEl = document.getElementById("fixPopoverTitle");
  const content = document.getElementById("fixPopoverContent");


  titleEl.textContent = title;
  content.innerHTML = "";

  // Prepare an array of unique fix idents
  const rows = [];

  for (const fxRaw of fixes) {
    const fx = String(fxRaw || "").trim().toUpperCase();
    if (!fx) continue;

    rows.push({ fx, nav: null });  // placeholder
  }

  // Do lookups in parallel
await Promise.all(rows.map(async (item) => {

  const ident = item.fx;

  const nav = NAVAIDS?.[ident];

  if (nav) {
    item.nav = nav;
  }

}));

  // Now render
  for (const { fx, nav } of rows) {
    const row = document.createElement("div");
    row.className = "fixRow";

    row.style.cursor = "pointer";


const left = document.createElement("div");
left.className = "fixCode";

const right = document.createElement("div");
right.className = "fixMeta";

const displayText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

const copyText = nav?.name
  ? nav.name.toUpperCase()
  : fx;

left.textContent = fx;

row.addEventListener("click", async (e) => {
  e.stopPropagation();

await copyWithFeedback(
  row,
  nav?.name ? nav.name.toUpperCase() : fx
);
  row.classList.add("copied");
  setTimeout(() => row.classList.remove("copied"), 600);

  const original = right.textContent;
  right.textContent = "Copied ✓";
  right.style.opacity = "1";

  setTimeout(() => {
    right.textContent = original;
    right.style.opacity = "";
  }, 800);
});


if (nav?.name) {
  right.textContent = nav.name.toUpperCase();
      const procs = FIX_PROCEDURE_MAP?.[fx.toUpperCase()];

if (procs?.length) {

  const p = procs[0];

  const procName = (p.proc || "").replace(/^.*\./,"");

  let cls = "procSID";

  if (p.type === "STAR") cls = "procSTAR";
  if (p.type === "IAP") cls = "procAPP";

  const tag = document.createElement("span");
  tag.className = `procTag ${cls}`;
  tag.textContent = procName;

  right.appendChild(tag);
}
      row.classList.add("isNav");
      row.title = `${nav.type || "NAVAID"}${nav.freq ? " • " + nav.freq : ""}`;
    } else {
      right.textContent = "";
      row.title = "Fix/Waypoint";
    }

    row.appendChild(left);
    row.appendChild(right);
    content.appendChild(row);
  }

  pop.classList.remove("hidden");
}

function iapChip(approachName, airportIdent) {
  const span = makeChip(approachName, "pointer");

  span.addEventListener("click", async (e) => {
  e.stopPropagation();

  openFixPopover(span, approachName, "Loading fixes…");

  const resp = await chrome.runtime.sendMessage({
    type: "GET_IAP_FIXES",
    airportIdent,
    approachName
  });

  if (!resp || !resp.ok) {
    openFixPopover(span, approachName, resp?.error || "Couldn’t load fixes.");
    return;
  }

  if (!resp.fixes?.length) {
    openFixPopover(span, approachName, resp.note || "No named fixes found.");
    return;
  }

  const sorted = resp.fixes.slice().sort((a,b)=>a.localeCompare(b));

  // 🔥 THIS is the important part
  await renderFixListInPopover(approachName, sorted);
});

  return span;
}

/* -------- Approaches grouping UI -------- */

function normalizeRwy(s) {
  if (!s) return null;

  let v = String(s).trim().toUpperCase();

  // Remove "RWY " prefix if present
  v = v.replace(/^RWY\s+/, "");

  // Remove leading zeros (04L -> 4L)
  v = v.replace(/^0+/, "");

  // Remove any trailing whitespace again
  v = v.trim();

  return v || null;
}

function parseRunwayFromApproachName(name) {
  // Matches "... RWY 17C ..." or "... RWY 4 ..." etc.
  const m = String(name || "").toUpperCase().match(/\bRWY\s+(\d{1,2}[LRC]?)/);
  return m ? normalizeRwy(m[1]) : null;
}

function groupApproachesByRunway(approaches) {
  const map = new Map(); // rwy -> [names]
  const other = [];

  for (const n of (approaches || [])) {
    const rwy = parseRunwayFromApproachName(n);
    if (!rwy) {
      other.push(n);
      continue;
    }
    if (!map.has(rwy)) map.set(rwy, []);
    map.get(rwy).push(n);
  }

  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => a.localeCompare(b));
    map.set(k, arr);
  }
  other.sort((a, b) => a.localeCompare(b));

  return { map, other };
}

function phoneticNormalize(str){

  if(!str) return "";

  str = str.toUpperCase().replace(/[^A-Z]/g,"");

  // common aviation pronunciation patterns
  const rules = [

    [/PH/g,"F"],
    [/CK/g,"K"],
    [/Q/g,"K"],
    [/X/g,"KS"],
    [/Z/g,"S"],
    [/DG/g,"J"],
    [/GH/g,"G"],
    [/KN/g,"N"],
    [/WR/g,"R"],

    // vowel sounds
    [/EE/g,"I"],
    [/EA/g,"I"],
    [/IE/g,"I"],
    [/EY/g,"I"],
    [/AY/g,"I"],

    [/OO/g,"U"],
    [/OU/g,"U"],

    // disney → dsnee compression
    [/ISN/g,"SN"],
    [/YSN/g,"SN"]
  ];

  
  for(const [r,rep] of rules)
    str = str.replace(r,rep);
// compress Y/E vowel noise
str = str.replace(/Y/g,"I");
  // collapse duplicates
  str = str.replace(/(.)\1+/g,"$1");

  // remove vowels except first
  str = str[0] + str.slice(1).replace(/[AEIOU]/g,"");

  return str;
}


function fuzzy(str, pattern) {
  let i = 0;
  for (const c of str) {
    if (c === pattern[i]) i++;
    if (i === pattern.length) return true;
  }
  return false;
}


function extractRunwayQuery(q) {
  q = String(q || "").toUpperCase();
  const m = q.match(/\b(?:RWY|RUNWAY)?\s*(\d{1,2}[LRC]?)\b/);
  return m ? normalizeRwy(m[1]) : null;
}

function airportHasRunway(a, target) {
  target = normalizeRwy(target);
  if (!target) return false;

  return (a.runways || []).some(r => {
    const r1 = normalizeRwy(r.ident1);
    const r2 = normalizeRwy(r.ident2);
    return r1 === target || r2 === target;
  });
}

function filterAirportSideResults(raw) {
  raw = String(raw || "").trim().toUpperCase();

  const runwayQ = extractRunwayQuery(raw);

  const textQ = raw
    .replace(/\b(?:RWY|RUNWAY)?\s*\d{1,2}[LRC]?\b/i, "")
    .trim();

  const filtered = (MASTER_RESULTS || []).filter(a => {
    const matchesText = textQ ? fuzzyMatchAirport(a, textQ) : true;
    const matchesRunway = runwayQ ? airportHasRunway(a, runwayQ) : true;
    return matchesText && matchesRunway;
  });

  renderResults(filtered, LAST_CENTER);
}


function fuzzyMatchAirport(a, query) {
  const q = query.toUpperCase().trim();
  if (!q) return true;

  const fields = [
    a.ident,
    a.name,
    a.municipality,
    a.region
  ].filter(Boolean).map(s => s.toUpperCase());

  // Basic fuzzy: every character in order
  function fuzzy(str, pattern) {
    let i = 0;
    for (const c of str) {
      if (c === pattern[i]) i++;
      if (i === pattern.length) return true;
    }
    return false;
  }

  return fields.some(f =>
    f.includes(q) || fuzzy(f, q)
  );
}




function soundScore(fix,query){

  fix = String(fix||"").toUpperCase();
  query = String(query||"").toUpperCase();

  if(!fix || !query) return 0;

  const fixPh = phoneticNormalize(fix);
  const qPh = phoneticNormalize(query);

  let score = 0;

  // strongest: phonetic equality
  if(fixPh === qPh) score += 200;

  // phonetic contains
  if(fixPh.includes(qPh) || qPh.includes(fixPh))
    score += 120;

  // literal match
  if(fix === query) score += 100;

  if(fix.startsWith(query)) score += 80;

  if(fix.includes(query)) score += 50;

  // fuzzy character order
  if(fuzzy(fix,query))
    score += 40;

  const dist = levenshtein(fixPh,qPh);
  score += Math.max(0,40 - dist*6);

  return score;
}

function consonantSkeleton(str){

  if(!str) return "";

  str = str.toUpperCase().replace(/[^A-Z]/g,"");

  // aviation style vowel removal
  str = str.replace(/[AEIOU]/g,"");

  // normalize consonant sounds
  str = str
    .replace(/PH/g,"F")
    .replace(/CK/g,"K")
    .replace(/Q/g,"K")
    .replace(/Z/g,"S")
    .replace(/DG/g,"J");

  // collapse duplicates
  str = str.replace(/(.)\1+/g,"$1");

  return str;
}

function stripVowels(s){

  if(!s) return "";

  return s
    .toUpperCase()
    .replace(/[^A-Z]/g,"")
    .replace(/[AEIOU]/g,"");

}

function levenshtein(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

async function searchWaypoints(query, token = 0) {
const useNationwide =
  document.getElementById("procGlobalToggle")?.checked === true;
  const resultsContainer = document.getElementById("results");
  resultsContainer.innerHTML = "";

  query = (query || "").trim().toUpperCase();

  if (!query || query.length < 2) {
    renderResults(MASTER_RESULTS, LAST_CENTER);
    return;
  }

  const matches = [];
  const seen = new Set();

  console.log(
    "PROC MAP SIZE:",
    Object.keys(FIX_PROCEDURE_MAP).length
  );


/* -------------------------------
   SID / STAR SEARCH
--------------------------------*/

if (useNationwide) {

  // 🇺🇸 Nationwide CIFP search
  for (const item of PROC_FIX_MASTER) {

    const fix = item.fix;
    const procs = item.procedures;
    const nav = NAVAIDS?.[fix];

    let score = soundScore(fix, query);

    if (nav?.name) {

      const nameUpper = nav.name.toUpperCase();

      if (nameUpper.includes(query))
        score = Math.max(score, 90);

      score = Math.max(
        score,
        soundScore(nameUpper.replace(/[^A-Z]/g, ""), query)
      );
    }

    if (score <= 0) continue;

    for (const p of procs) {

      const procName =
        p.displayName ||
        (p.code ? p.code.replace(/^.*\./, "") : "") ||
        p.name ||
        "";

      matches.push({
        airport: p.airport || "",
        procedure: procName.replace(/^.*\./,""),
        type: p.type,
        fix,
        score,
        navName: nav?.name || ""
      });

    }

  }

} else {

  // 📍 Nearby airports only
  for (const fix in FIX_PROCEDURE_MAP) {

    const procs = FIX_PROCEDURE_MAP[fix];
    const nav = NAVAIDS?.[fix];

    let score = soundScore(fix, query);

    if (nav?.name) {

      const nameUpper = nav.name.toUpperCase();

      if (nameUpper.includes(query))
        score = Math.max(score, 90);

      score = Math.max(
        score,
        soundScore(nameUpper.replace(/[^A-Z]/g, ""), query)
      );
    }

    if (score <= 0) continue;

    for (const p of procs) {

      const procName =
        p.procDisplay ||
        (p.proc ? p.proc.replace(/^.*\./, "") : "") ||
        "";

      matches.push({
        airport: p.airport || "",
        procedure: procName.replace(/^.*\./,""),
        type: p.type,
        fix,
        score,
        navName: nav?.name || ""
      });

    }

  }

}


  /* -------------------------------
     IAP SEARCH
  --------------------------------*/
if (!useNationwide) {
  for (const airport of (MASTER_RESULTS || [])) {

    const ident = String(airport?.ident || "").toUpperCase();
    if (!ident) continue;

    for (const apNameRaw of (airport.approaches || [])) {

      const apName = String(apNameRaw || "").trim();
      if (!apName) continue;

      const resp = await chrome.runtime.sendMessage({
        type: "GET_IAP_FIXES",
        airportIdent: ident,
        approachName: apName
      });

      const fixes = resp?.fixes || [];

      for (const fixRaw of fixes) {

        const fix = String(fixRaw || "").toUpperCase().trim();
        if (!fix) continue;

        const nav = NAVAIDS?.[fix];
let score = soundScore(fix, query);

if (nav?.name) {

  const nameUpper = nav.name.toUpperCase();

  if (nameUpper.includes(query))
    score = Math.max(score, 90);

  score = Math.max(
    score,
    soundScore(nameUpper.replace(/[^A-Z]/g, ""), query)
  );
}

if (score < 10) continue;

        const key = `${ident}|IAP|${apName}|${fix}`;
        if (seen.has(key)) continue;
        seen.add(key);

        matches.push({
          airport: ident,
          procedure: apName,
          type: "IAP",
          fix,
          score,
          navName: nav?.name || ""
        });

      }

    }

  }
}

/* -------------------------------
   GLOBAL FIXES (non-US airports)
--------------------------------*/
const isGlobal = LAST_CENTER && !isDomesticSandcatICAO(LAST_CENTER);
if (isGlobal) {
  try {
    const coordResp = await chrome.runtime.sendMessage({
      type: "GET_AIRPORT_COORDS",
      ident: LAST_CENTER
    });
    if (coordResp?.ok && coordResp.airport) {
      const { lat, lon } = coordResp.airport;
      const nearbyResp = await chrome.runtime.sendMessage({
        type: "FIND_NEARBY_GLOBAL_POINTS",
        lat,
        lon,
        radiusNm: 200,
        limit: 400
      });
      for (const pt of nearbyResp?.results || []) {
        const identScore = soundScore(pt.ident || "", query);
        const nameClean = (pt.name || "").replace(/[^A-Z]/gi, "").toUpperCase();
        const nameScore = nameClean ? soundScore(nameClean, query) : 0;
        const score = Math.max(identScore, nameScore);
        if (score <= 0) continue;
        const key = `${pt.ident}|${pt.kind}|${Math.round((pt.lat || 0) * 10)}|${Math.round((pt.lon || 0) * 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          airport: "",
          procedure: pt.subtype || (pt.kind === "navaid" ? "NAVAID" : "FIX"),
          type: pt.kind === "navaid" ? "NAVAID" : "FIX",
          fix: (pt.ident || "").toUpperCase(),
          score,
          navName: pt.name || "",
          country: pt.country || ""
        });
      }
    }
  } catch (e) {
    console.warn("Global waypoint search failed:", e);
  }
}

  if (!matches.length) {

    resultsContainer.innerHTML =
      "<div class='card'>No waypoint matches found.</div>";

    return;

  }

  /* -------------------------------
     SORT BEST FIRST
  --------------------------------*/

  matches.sort((a, b) => b.score - a.score);

  for (const m of matches.slice(0, 60)) {

    const div = document.createElement("div");
    div.className = "card";

let tagClass = "procSID";

if (m.type === "STAR") tagClass = "procSTAR";
if (m.type === "IAP") tagClass = "procAPP";
if (m.type === "NAVAID") tagClass = "procAIRWAY";

const countryLabel = m.country ? ` · ${m.country}` : "";

div.innerHTML = `
<div class="title">
  ${m.navName ? m.navName.toUpperCase() + " (" + m.fix + ")" : m.fix}
</div>
  <div class="sub">
   ${m.airport ? m.airport + " " : ""}
<span class="procTag ${tagClass}">
      ${m.type}
    </span>
    ${m.procedure}${countryLabel}
  </div>
`;

    div.style.cursor = "pointer";

div.addEventListener("click", async () => {
  await copyWithFeedback(
    div,
    m.navName ? m.navName.toUpperCase() : m.fix
  );
});

    resultsContainer.appendChild(div);

  }

}

function normalizeAirport(a){
  if(!a) return "";
  a = a.toUpperCase();
  if(a.length === 3) return "K"+a;
  return a;
}

async function runProcedureSearch(query){

  const resultsContainer = document.getElementById("results");
  resultsContainer.innerHTML = "";

const rawQuery = (query || "").trim().toUpperCase();
const queryPh = phoneticNormalize(rawQuery);
  if(!query) return;

  const resp = await chrome.runtime.sendMessage({
  type: "SEARCH_PROCEDURES",
  query
});
console.log("PROC SEARCH RESP:", resp);
const procs = resp?.results || [];
const matches = [];
const seen = new Set();

for(const p of procs){

  const name = (p.displayName || p.name || "").toUpperCase();
  const code = (p.code || "").toUpperCase();

const airport = normalizeAirport(p.airport || "");
const key = `${airport}|${p.type}|${code}`;

  if(seen.has(key)) continue;
  seen.add(key);

const cleanName = name
  .replace(/[0-9]/g,"")
  .replace(/(STAR|SID|ARRIVAL|DEPARTURE)/g,"")
  .trim();

const namePh = phoneticNormalize(cleanName);

let score = 0;

// literal matches
if(cleanName.startsWith(rawQuery)) score += 140;
if(cleanName.includes(rawQuery)) score += 200;


// fuzzy literal
if(fuzzy(cleanName, rawQuery))
  score += 120;

// edit distance (handles eagle/eagul)
const distPh = levenshtein(namePh, queryPh);
if (distPh <= 2) score += 140;

// phonetic
score = Math.max(score, soundScore(cleanName, queryPh));
score = Math.max(score, soundScore(code, queryPh));

// phonetic equality (DISNEY vs DSNEE)
if(namePh === queryPh) score += 400;

// phonetic containment
if(namePh.includes(queryPh) || queryPh.includes(namePh))
  score += 180;

// vowel-stripped compare
const nvName = namePh.replace(/[AEIOU]/g,"");
const nvQuery = queryPh.replace(/[AEIOU]/g,"");

const skName = stripVowels(cleanName);
const skQuery = stripVowels(rawQuery);

if(skName === skQuery)
  score += 500;

if(skName.includes(skQuery) || skQuery.includes(skName))
  score += 250;

const skelName = consonantSkeleton(cleanName);
const skelQuery = consonantSkeleton(rawQuery);

if(skelName === skelQuery)
  score += 350;

if(skelName.includes(skelQuery))
  score += 200;

if(nvName === nvQuery) score += 250;

if(score < 20) continue;

matches.push({
  airport: p.airport,
  name: p.name || p.displayName,   // ⭐ REQUIRED
  procedure: (p.displayName || p.name || "").replace(/^.*\./,""),
  type: p.type,
  code: p.code,
  score
});

}

  if(!matches.length){

    resultsContainer.innerHTML =
      "<div class='card'>No procedures found.</div>";

    return;

  }

  matches.sort((a,b)=>b.score-a.score);

  for(const proc of matches.slice(0,60)){

    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "pointer";

const header = document.createElement("div");

let tagClass = "procSID";

if(proc.type === "STAR") tagClass = "procSTAR";
if(proc.type === "IAP") tagClass = "procAPP";

header.innerHTML = `
  <div class="title">
    ${proc.procedure}
    <span class="procTag ${tagClass}">
      ${proc.type}
    </span>
  </div>
  <div class="sub">
    ${proc.airport}
  </div>
`;

    const fixesBox = document.createElement("div");
    fixesBox.style.marginTop = "6px";
    fixesBox.style.display = "none";

    card.appendChild(header);
    card.appendChild(fixesBox);

    card.addEventListener("click", async () => {

      if(fixesBox.dataset.loaded){

        fixesBox.style.display =
          fixesBox.style.display === "none" ? "block" : "none";

        return;
      }

      fixesBox.innerHTML = "Loading fixes…";
      fixesBox.style.display = "block";

      const resp = await chrome.runtime.sendMessage({
        type: "GET_PROC_FIXES",
        procType: proc.type === "SID" ? "DP" : proc.type,
        procName: proc.name,
        procCode: proc.code
      });

      fixesBox.innerHTML = "";

      const fixes = resp?.fixes || [];

      if(!fixes.length){
        fixesBox.innerHTML = "<em>No fixes found</em>";
        return;
      }

for(const fxRaw of fixes){

  const fx = String(fxRaw).toUpperCase();
  const nav = NAVAIDS?.[fx];

  const row = document.createElement("div");
  row.className = "fixRow";
  row.style.cursor = "pointer";

  const left = document.createElement("div");
  left.className = "fixCode";
  left.textContent = fx;

  const right = document.createElement("div");
  right.className = "fixMeta";

  if(nav?.name){
right.textContent = nav.name.toUpperCase();
  } else {
    right.textContent = "";
  }

  row.appendChild(left);
  row.appendChild(right);

  row.addEventListener("click", async (e) => {

    e.stopPropagation();

    await copyWithFeedback(row, fx);

  });

  fixesBox.appendChild(row);
}

      fixesBox.dataset.loaded = "1";

    });

    resultsContainer.appendChild(card);

  }

}

function parseCSV(text) {
  const rows = [];
  const lines = text.split("\n").filter(Boolean);

  const headers = lines[0].split(",");

  for (let i = 1; i < lines.length; i++) {
    const cols = [];
    let current = "";
    let inQuotes = false;

    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cols.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    cols.push(current);

    const obj = {};
    headers.forEach((h, idx) => {
      obj[h.trim()] = (cols[idx] || "").trim();
    });

    rows.push(obj);
  }

  return rows;
}


async function loadOurAirportsFrequencies() {
  if (AIRPORT_FREQ_INDEX) return;

  console.log("Loading OurAirports frequencies...");

  const res = await fetch(
    "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv"
  );

  const text = await res.text();
  const rows = parseCSV(text);

  const map = {};
  const seen = new Set();

  for (const r of rows) {
    const ident = String(r.airport_ident || "").toUpperCase();
    if (!ident) continue;

    const rawFreq = String(r.frequency_mhz || "").trim();
    if (!rawFreq) continue;

    const freq = parseFloat(rawFreq);
    if (isNaN(freq) || freq < 108 || freq > 137) continue;

    let type = (r.type || "").toUpperCase();
    let name = (r.description || "").trim();

    name = name
      .replace(/\[.*?\]/g, "")
      .replace(/\(.*?\)/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const TYPE_MAP = {
      TWR: "Tower",
      GND: "Ground",
      APP: "Approach",
      DEP: "Departure",
      ATIS: "ATIS",
      CTAF: "CTAF",
      UNICOM: "UNICOM",
      AWOS: "AWOS",
      ASOS: "ASOS"
    };

    const cleanName =
      TYPE_MAP[type] ||
      name ||
      type ||
      "Unknown";

    const freqParts = rawFreq.split(/[ /]+/);

    for (const part of freqParts) {
      const f = parseFloat(part);
      if (isNaN(f) || f < 108 || f > 137) continue;

      const key = `${ident}_${cleanName}_${f}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!map[ident]) map[ident] = [];

      map[ident].push({
        type,
        name: cleanName,
        freq: f.toFixed(3)
      });
    }
  }

  AIRPORT_FREQ_INDEX = map;
  console.log("OurAirports loaded:", Object.keys(map).length);
}

function buildRunwayPairs(runways) {
  const out = [];
  const seen = new Set();

  for (const r of (runways || [])) {
    const a0 = normalizeRwy(r.ident1);
const b0 = normalizeRwy(r.ident2);

if (!a0 || !b0) continue;

    // Canonicalize so 31R/13L and 13L/31R are the same
    const pair = [a0, b0].sort((x, y) => {
      const nx = parseInt(x, 10);
      const ny = parseInt(y, 10);
      if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
      return x.localeCompare(y);
    });

    const key = `${pair[0]}/${pair[1]}`;

    // Extra safety: also mark the reverse orientation as seen
    const rev = `${pair[1]}/${pair[0]}`;

    if (seen.has(key) || seen.has(rev)) continue;
    seen.add(key);
    seen.add(rev);

    out.push({
      pairKey: key,
      end1: pair[0],
      end2: pair[1],
      label: key
    });
  }

  out.sort((x, y) => {
    const nx = parseInt(x.end1, 10);
    const ny = parseInt(y.end1, 10);
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
    return x.pairKey.localeCompare(y.pairKey);
  });

  return out;
}

function renderRunwayEndSection(container, airportIdent, rwy, names, defaultExpanded = false) {
  if (!Array.isArray(names)) {
    console.warn("Approach names not array:", names);
    names = [];
  }

  const details = document.createElement("details");
  details.open = defaultExpanded;

  const summary = document.createElement("summary");
  summary.textContent = `RWY ${rwy} (${names.length})`;
  summary.style.cursor = "pointer";
  summary.style.fontWeight = "600";
  summary.style.marginTop = "6px";
  details.appendChild(summary);

  const wrap = document.createElement("div");
  wrap.style.marginTop = "6px";

  const MAX = 10;
  const initial = names.slice(0, MAX);

  for (const n of initial) {
    wrap.appendChild(iapChip(n, airportIdent));   // 🔥 use passed value
  }

  if (names.length > MAX) {
    const more = makeButtonChip(`Show all (${names.length})`);
    more.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrap.innerHTML = "";
      for (const n2 of names) {
        wrap.appendChild(iapChip(n2, airportIdent));  // 🔥 use passed value
      }
    });
    wrap.appendChild(more);
  }

  details.appendChild(wrap);
  container.appendChild(details);
}

function renderAusApproachesGrouped(apWrap, airportIdent, runways, ausApproaches) {
  const pairs = buildRunwayPairs(runways || []);

  const byRunway = new Map();
  const other = [];

  for (const ap of ausApproaches || []) {
    const rwy = parseRunwayFromApproachName(ap.name);

    if (!rwy) {
      other.push(ap);
      continue;
    }

    if (!byRunway.has(rwy)) byRunway.set(rwy, []);
    byRunway.get(rwy).push(ap);
  }

  if (!pairs.length) {
    for (const ap of ausApproaches) {
      apWrap.appendChild(ausProcChip(ap.name, ap.fixes, "IAP"));
    }
    return;
  }

  const selected = apWrap.dataset.selectedPairKey || pairs[0].pairKey;
  apWrap.dataset.selectedPairKey = selected;

  let selectorRow = apWrap.querySelector(".rwy-selector");

  if (!selectorRow) {
    selectorRow = document.createElement("div");
    selectorRow.className = "rwy-selector";
    apWrap.appendChild(selectorRow);

    for (const p of pairs) {
      const btn = makeButtonChip(p.label, selected === p.pairKey);

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        apWrap.dataset.selectedPairKey = p.pairKey;

        apWrap.innerHTML = "";
        renderAusApproachesGrouped(apWrap, airportIdent, runways, ausApproaches);
      });

      selectorRow.appendChild(btn);
    }
  }

  const content = document.createElement("div");
  const sel = pairs.find(x => x.pairKey === selected) || pairs[0];
  const ends = [sel.end1, sel.end2].filter(Boolean);

  let any = false;

  for (const end of ends) {
    const aps = byRunway.get(end) || [];
    if (!aps.length) continue;

    any = true;

    const block = document.createElement("div");
    block.className = "rwy-block";

    const h = document.createElement("div");
    h.className = "rwy-header";
    h.textContent = `RWY ${end} (${aps.length})`;
    block.appendChild(h);

    const wrap = document.createElement("div");

    for (const ap of aps) {
      wrap.appendChild(ausProcChip(ap.name, ap.fixes, "IAP"));
    }

    block.appendChild(wrap);
    content.appendChild(block);
  }

  if (!any) {
    const none = document.createElement("div");
    none.style.opacity = "0.75";
    none.textContent = "(no approaches tagged to this runway pair)";
    content.appendChild(none);
  }

  if (other.length) {
    const h = document.createElement("div");
    h.style.fontWeight = "700";
    h.style.marginTop = "10px";
    h.textContent = `Other (${other.length})`;
    content.appendChild(h);

    const wrap = document.createElement("div");

    for (const ap of other) {
      wrap.appendChild(ausProcChip(ap.name, ap.fixes, "IAP"));
    }

    content.appendChild(wrap);
  }

  apWrap.appendChild(content);
}

function renderApproachesGrouped(apWrap, airportIdent, runways, approaches, metaNoteLine) {

  apWrap.innerHTML = "";
  apWrap.style.opacity = "1";

  if (!Array.isArray(approaches) || approaches.length === 0) {
    apWrap.style.opacity = "0.75";
    apWrap.textContent = metaNoteLine || "(none found)";
    return;
  }

  const safeRunways = Array.isArray(runways) ? runways : [];
const pairs = buildRunwayPairs(safeRunways);
  const { map, other } = groupApproachesByRunway(approaches);

    console.log("Runways:", runways);
console.log("Approach map keys:", Array.from(map.keys()));

  // If no runway pairs exist, show all as a flat list
  if (!pairs.length) {
    const wrap = document.createElement("div");
    for (const n of approaches) wrap.appendChild(iapChip(n, airportIdent));
    apWrap.appendChild(wrap);
    return;
  }

  // Default = first runway pair (no "All runways")
  const selected = apWrap.dataset.selectedPairKey || pairs[0].pairKey;
  apWrap.dataset.selectedPairKey = selected;

  // Buttons row
  const selectorRow = document.createElement("div");
  selectorRow.className = "rwy-selector";

  for (const p of pairs) {
    const btn = makeButtonChip(p.label, selected === p.pairKey);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      apWrap.dataset.selectedPairKey = p.pairKey;
      renderApproachesGrouped(apWrap, airportIdent, runways, approaches, metaNoteLine);
    });
    selectorRow.appendChild(btn);
  }

  apWrap.appendChild(selectorRow);

  const content = document.createElement("div");
  const sel = pairs.find(x => x.pairKey === selected) || pairs[0];
  const ends = [sel.end1, sel.end2].filter(Boolean);

  let any = false;

  for (const end of ends) {
    const names = (map.get(end) || []);
    if (!names.length) continue;

    any = true;

    const block = document.createElement("div");
    block.className = "rwy-block";

    const h = document.createElement("div");
    h.className = "rwy-header";
    h.textContent = `RWY ${end} (${names.length})`;
    block.appendChild(h);

    const wrap = document.createElement("div");

    const MAX = 12;
    const initial = names.slice(0, MAX);

    for (const n of initial) wrap.appendChild(iapChip(n, airportIdent));

    if (names.length > MAX) {
      const more = makeButtonChip(`Show all (${names.length})`);
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        wrap.innerHTML = "";
        for (const n2 of names) wrap.appendChild(iapChip(n2, airportIdent));
      });
      wrap.appendChild(more);
    }

    block.appendChild(wrap);
    content.appendChild(block);
  }

  if (!any) {
    const none = document.createElement("div");
    none.style.opacity = "0.75";
    none.textContent = "(no approaches tagged to this runway pair)";
    content.appendChild(none);
  }

  if (other.length) {
    const h = document.createElement("div");
    h.style.fontWeight = "700";
    h.style.marginTop = "10px";
    h.textContent = `Other (${other.length})`;
    content.appendChild(h);

    const wrap = document.createElement("div");
    for (const n of other) wrap.appendChild(iapChip(n, airportIdent));
    content.appendChild(wrap);
  }

  apWrap.appendChild(content);
}

/* -------- Approach loading (on demand) -------- */

// Card click should not fire when interacting with chips/tooltips
function isClickOnInteractive(e) {
  const t = e.target;
  if (t.closest("span")) return true;
  if (t.closest("summary")) return true;
  return false;
}



async function renderResults(list, centerIdentUpper) {
  list = dedupeAirportsByIdent(list);

  const root = $("results");
  root.innerHTML = "";

  const sideList = document.getElementById("sideList");
if (sideList) sideList.innerHTML = "";
const sideQuery = document.getElementById("resultsSearch")?.value || "";

  // Store last results for filtering toggle
LAST_RESULTS = list.slice();
LAST_CENTER = centerIdentUpper;

const mainOnly = document.getElementById("mainOnlyToggle")?.checked;
let typesMode = document.getElementById("types")?.value;
const hideNoApp = document.getElementById("filterNoApproaches")?.checked;
const maxResultsUI = Number(document.getElementById("maxResults")?.value || 25);

if (mainOnly && centerIdentUpper) {
  list = list.filter(a =>
    String(a.ident || "").toUpperCase() === centerIdentUpper
  );
}

/* -----------------------------
   TYPE FILTER
----------------------------- */
if (typesMode === "public") {
  list = list.filter(a => {
    const t = String(a.type || a.t || "").toLowerCase();
    return t !== "heliport" && t !== "seaplane base";
  });
} else if (typesMode === "all_airports") {
  list = list.filter(a => {
    const t = String(a.type || a.t || "").toLowerCase();
    return t !== "heliport";
  });
} else if (typesMode === "helipads_only") {
  list = list.filter(a => {
    const t = String(a.type || a.t || "").toLowerCase();
    return t === "heliport";
  });
} else if (typesMode === "airports_plus_helipads") {
  // no extra filter needed
}

/* -----------------------------
   PRELOAD AU DATA FOR FILTERING
----------------------------- */
for (const a of list) {
  const ident = String(a.ident || "").toUpperCase();

  if (ident.startsWith("Y") && !a.__ausData) {
    try {
      a.__ausData = await getAusProceduresForAirport(ident);
    } catch (e) {
      console.warn("AUS preload failed:", ident, e);
      a.__ausData = null;
    }
  }
  if (ident.startsWith("LS") && !a.__chData) {
    try {
      a.__chData = await getSwissProceduresForAirport(ident);
    } catch (e) {
      console.warn("Swiss preload failed:", ident, e);
      a.__chData = null;
    }
  }
  if (ident.startsWith("EI") && !a.__eiData) {
    try {
      a.__eiData = await getIrelandProceduresForAirport(ident);
    } catch (e) {
      console.warn("Ireland preload failed:", ident, e);
      a.__eiData = null;
    }
  }
}
/* -----------------------------
   IAP FILTER
----------------------------- */
if (hideNoApp) {
  list = list.filter(a => {
    const t = String(a.type || a.t || "").toLowerCase();

    // 🚫 ALWAYS exclude heliports here
    if (t === "heliport") return false;

    const hasUsIap =
      Array.isArray(a.approaches) && a.approaches.length > 0;

    const ausProcedures = a.__ausData?.procedures || {};

    const hasAusIap = Object.keys(ausProcedures).some(name =>
      /^(RNP|ILS|LOC|VOR|NDB|GNSS|DME)\b/i.test(name)
    );

    const hasSwissIap = (a.__chData?.procedures?.approaches?.length || 0) > 0;

    const hasIrelandIap = (a.__eiData?.IAPs?.length || 0) > 0;

    return hasUsIap || hasAusIap || hasSwissIap || hasIrelandIap;
  });
}

if (hideNoApp && typesMode === "airports_plus_helipads") {
  typesMode = "all_airports";
}

// cap after filtering
list = list.slice(0, maxResultsUI);

  if (!list.length) {
    root.innerHTML =
      `<div class="card"><div class="title">No airports found</div><div class="sub">Try increasing radius or switching Country filter to Any.</div></div>`;
    return;
  }

  for (const a of list) {
    const airportIdent = String(a.ident || "").toUpperCase();
let ausData = a.__ausData || null;

if (!ausData && airportIdent.startsWith("Y")) {
  try {
    ausData = await getAusProceduresForAirport(airportIdent);
    a.__ausData = ausData;
  } catch (e) {
    console.warn("AUS procedure fetch failed:", airportIdent, e);
  }
}

try {
  ausData = await getAusProceduresForAirport(airportIdent);
} catch (e) {
  console.warn("AUS fetch failed:", airportIdent, e);
}

let chData = a.__chData || null;
if (!chData && airportIdent.startsWith("LS")) {
  try {
    chData = await getSwissProceduresForAirport(airportIdent);
    a.__chData = chData;
  } catch (e) {
    console.warn("Swiss fetch failed:", airportIdent, e);
  }
}

let eiData = a.__eiData || null;
if (!eiData && airportIdent.startsWith("EI")) {
  try {
    eiData = await getIrelandProceduresForAirport(airportIdent);
    a.__eiData = eiData;
  } catch (e) {
    console.warn("Ireland fetch failed:", airportIdent, e);
  }
}

    const div = document.createElement("div");
    div.className = "card";
    div.style.cursor = "pointer";

    const cardId = `airport_${airportIdent}`;
div.id = cardId;

if (sideList) {
  const item = document.createElement("div");
  item.className = "sideItem";

  // Build runway string
  const rwyText = (a.runways || [])
    .map(r => `${r.ident1}/${r.ident2}`)
    .join(", ");

    item.dataset.runways = rwyText.toUpperCase(); // ✅ THIS LINE

  item.innerHTML = `
    <div class="code">${airportIdent}</div>
    <div class="name">${a.name || ""}</div>
    <div class="rwys">${rwyText}</div>
  `;

  item.addEventListener("click", () => {

  document.querySelectorAll(".sideItem")
    .forEach(el => el.classList.remove("active"));

  item.classList.add("active");

  const mainPanel = document.getElementById("mainPanel");
  if (!mainPanel) return;

  const offset = div.offsetTop - mainPanel.offsetTop;

  mainPanel.scrollTo({
    top: offset - 12,
    behavior: "smooth"
  });



  // Load facility info
const facilityContent = document.getElementById("facilityContent");
facilityContent.innerHTML = "<em>Loading facility info...</em>";

chrome.runtime.sendMessage(
  { type: "FETCH_AIRNAV", icao: airportIdent },
  async (resp) => {

    const facilityContent = document.getElementById("facilityContent");
    facilityContent.innerHTML = "";

    const facilitySearch = document.getElementById("facilitySearch");
    if (facilitySearch) facilitySearch.value = "";

    // ✅ Load OurAirports fallback
    await loadOurAirportsFrequencies();

    const ourAirports = AIRPORT_FREQ_INDEX?.[airportIdent] || [];
    const ausComms = a.__ausData?.comms || ausData?.comms || [];
    if (!a.__chData && airportIdent.startsWith("LS")) {
      try { a.__chData = await getSwissProceduresForAirport(airportIdent); } catch(e) {}
    }
    const chComms = a.__chData?.comms || [];

    let usedAirNav = false;

    if (resp && resp.ok && resp.data?.length) {

      usedAirNav = true;

      const comms = resp.data.filter(d => d.type === "comm");
      const navs = resp.data.filter(d => d.type === "nav");

      if (comms.length) {
        const commTitle = document.createElement("div");
        commTitle.innerHTML = "<strong>Communications</strong>";
        facilityContent.appendChild(commTitle);

        comms.forEach(c => {
          const div = document.createElement("div");
          div.className = "facilityItem";
          div.innerText = `${c.label} — ${c.freq}`;
          facilityContent.appendChild(div);
        });
      }

      navs.forEach(n => {
        const div = document.createElement("div");
        div.className = "facilityItem";
        div.innerText = `${n.label} — ${n.freq}`;
        facilityContent.appendChild(div);
      });

    }

// 🇦🇺 Australia DAP comms
if (ausComms.length) {
  const title = document.createElement("div");
  title.innerHTML = `<strong>Australia DAP</strong>`;
  title.style.marginTop = "8px";
  facilityContent.appendChild(title);

  const seenAus = new Set();

  for (const c of ausComms) {
    const label = String(c.label || "").trim();
    const freq = String(c.freq || "").trim();

    if (!label || !freq) continue;

    const key = `${label}_${freq}`;
    if (seenAus.has(key)) continue;
    seenAus.add(key);

    const div = document.createElement("div");
    div.className = "facilityItem";
    div.innerText = `${label} — ${freq}`;

    facilityContent.appendChild(div);

    FACILITY_FREQ_INDEX.push({
      freq,
      label,
      airport: airportIdent
    });
  }
}

// 🇨🇭 Swiss AD2 comms
if (chComms.length) {
  const chTitle = document.createElement("div");
  chTitle.innerHTML = `<strong>Switzerland AIP</strong>`;
  chTitle.style.marginTop = "8px";
  facilityContent.appendChild(chTitle);

  const seenCh = new Set();
  for (const c of chComms) {
    const label = String(c.label || c.type || "").trim();
    const freq = String(c.freq || "").trim();
    if (!label || !freq) continue;
    const key = `${label}_${freq}`;
    if (seenCh.has(key)) continue;
    seenCh.add(key);
    const div = document.createElement("div");
    div.className = "facilityItem";
    div.innerText = `${label} — ${freq}`;
    facilityContent.appendChild(div);
    FACILITY_FREQ_INDEX.push({ freq, label, airport: airportIdent });
  }
}

// 🇮🇪 Ireland AIP comms
const eiComms = a.__eiData?.frequencies || eiData?.frequencies || [];
if (eiComms.length) {
  const eiTitle = document.createElement("div");
  eiTitle.innerHTML = `<strong>Ireland AIP</strong>`;
  eiTitle.style.marginTop = "8px";
  facilityContent.appendChild(eiTitle);
  const seenEi = new Set();
  for (const c of eiComms) {
    const label = String(c.name || c.type || "").trim();
    const freq = String(c.frequency || "").trim();
    if (!label || !freq) continue;
    const key = `${label}_${freq}`;
    if (seenEi.has(key)) continue;
    seenEi.add(key);
    const div = document.createElement("div");
    div.className = "facilityItem";
    div.innerText = `${label} — ${freq}`;
    facilityContent.appendChild(div);
    FACILITY_FREQ_INDEX.push({ freq, label, airport: airportIdent });
  }
}

    // ✅ Always add OurAirports (dedup later if you want)
    if (ourAirports.length) {

      const title = document.createElement("div");
      title.innerHTML = `<strong>OurAirports</strong>`;
      title.style.marginTop = "8px";
      facilityContent.appendChild(title);

      for (const f of ourAirports) {

        const div = document.createElement("div");
        div.className = "facilityItem";

        const name = prettyFreqName(f);

        div.innerText = `${name} — ${f.freq}`;

        facilityContent.appendChild(div);

        // 🔥 also feed your global index
        FACILITY_FREQ_INDEX.push({
          freq: f.freq,
          label: name,
          airport: airportIdent
        });
      }

    }

if (!usedAirNav && !ourAirports.length && !ausComms.length && !eiComms.length) {
  facilityContent.innerHTML = "No facility data found.";
}

  }
);
});

  sideList.appendChild(item);
}

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `${a.ident} — ${a.name || "(unknown name)"}`;

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${Number(a.distance_nm || 0).toFixed(1)} NM • ${a.municipality || ""} ${a.region || ""} ${a.country || ""}`.trim();

    const rwysBlock = document.createElement("div");
rwysBlock.className = "rwys";

const pairs = buildRunwayPairs(a.runways || []);

if (!pairs.length) {
  rwysBlock.textContent = "No runway data in dataset for this airport.";
} else {
  for (const p of pairs) {
    const chip = makeButtonChip(p.label);
    rwysBlock.appendChild(chip);
  }
}

    const proc = document.createElement("div");
    proc.className = "proc";

/* ---------------- Departures ---------------- */
/* ---------------- Departures ---------------- */
const dpLabel = document.createElement("div");
dpLabel.className = "section-title";
dpLabel.textContent = "Departures (DP/SID)";
proc.appendChild(dpLabel);

const dpWrap = document.createElement("div");
const deps = (a.departures || []);

for (const p of deps) {
  dpWrap.appendChild(procChip(p, a.ident, "DP"));
}

if (ausData?.procedures) {
  for (const [name, fixes] of Object.entries(ausData.procedures)) {
    if (/^SID\b/i.test(name)) {
      dpWrap.appendChild(ausProcChip(name, fixes, "SID"));
    }
  }
}

for (const sid of (chData?.procedures?.sids || [])) {
  dpWrap.appendChild(swissProcChip(sid, "SID"));
}

renderIrelandProcsByRunway(dpWrap, eiData?.SIDs || [], "SID");

if (!deps.length && !dpWrap.children.length) {
  dpWrap.textContent = "(none found)";
}

const dpPanel = document.createElement("div");
dpPanel.className = "section-panel departures";
dpPanel.appendChild(dpWrap);
proc.appendChild(dpPanel);

/* ---------------- Arrivals ---------------- */
const stLabel = document.createElement("div");
stLabel.className = "section-title";
stLabel.textContent = "Arrivals (STAR)";
proc.appendChild(stLabel);

const stWrap = document.createElement("div");
const arrs = (a.arrivals || []);

for (const p of arrs) {
  stWrap.appendChild(procChip(p, a.ident, "STAR"));
}

if (ausData?.procedures) {
  for (const [name, fixes] of Object.entries(ausData.procedures)) {
    if (/^STAR\b/i.test(name)) {
      stWrap.appendChild(ausProcChip(name, fixes, "STAR"));
    }
  }
}

for (const star of (chData?.procedures?.stars || [])) {
  stWrap.appendChild(swissProcChip(star, "STAR"));
}

renderIrelandProcsByRunway(stWrap, eiData?.STARs || [], "STAR");

if (!arrs.length && !stWrap.children.length) {
  stWrap.textContent = "(none found)";
}

const stPanel = document.createElement("div");
stPanel.className = "section-panel arrivals";
stPanel.appendChild(stWrap);
proc.appendChild(stPanel);

/* ---------------- Approaches ---------------- */
/* ---------------- Approaches ---------------- */
const apLabel = document.createElement("div");
apLabel.className = "section-title";
apLabel.textContent = "Approaches (IAP)";
proc.appendChild(apLabel);

const apWrap = document.createElement("div");
apWrap.dataset.airportIdent = airportIdent;
apWrap.dataset.approachesLoaded = "0";

const aps = a.approaches || [];
const meta = a.approaches_meta || null;
const note = a.approaches_note || "";
const metaLine = meta?.cycle
  ? `(none found) • cycle=${meta.cycle} • note=${note || "n/a"}`
  : null;

if (aps.length) {
  apWrap.dataset.approachesLoaded = "1";
  apWrap.dataset.approachesCount = String(aps.length);
  renderApproachesGrouped(
    apWrap,
    airportIdent,
    a.runways || [],
    aps,
    metaLine || "(none found)"
  );
}

if (ausData?.procedures) {
  const ausApproaches = [];

  for (const [name, fixes] of Object.entries(ausData.procedures)) {
    const isApproach =
      /^(RNP|ILS|LOC|VOR|NDB|GNSS|DME)\b/i.test(name) &&
      !/^SID\b/i.test(name) &&
      !/^STAR\b/i.test(name);

    if (isApproach) {
      ausApproaches.push({ name, fixes });
    }
  }

  if (ausApproaches.length) {
    renderAusApproachesGrouped(
      apWrap,
      airportIdent,
      a.runways || [],
      ausApproaches
    );
  }
}

if (chData?.procedures?.approaches?.length) {
  for (const ap of chData.procedures.approaches) {
    apWrap.appendChild(swissProcChip(ap, "IAP"));
  }
}

renderIrelandIAPsByRunwayPair(apWrap, eiData?.IAPs || []);

if (!aps.length && !apWrap.children.length) {
  apWrap.textContent =
    airportIdent === centerIdentUpper
      ? "(none found / not cached yet)"
      : "(click card to load; will group by runway)";
  apWrap.style.opacity = "0.75";
}

const apPanel = document.createElement("div");
apPanel.className = "section-panel approaches";
apPanel.appendChild(apWrap);
proc.appendChild(apPanel);

/* ---------------- Visual Approaches ---------------- */
if (eiData?.visual_approaches?.length) {
  const vacLabel = document.createElement("div");
  vacLabel.className = "section-title";
  vacLabel.textContent = "Visual Approaches";
  proc.appendChild(vacLabel);

  const vacWrap = document.createElement("div");
  for (const vac of eiData.visual_approaches) {
    vacWrap.appendChild(irelandProcChip(vac, "VAC"));
  }

  const vacPanel = document.createElement("div");
  vacPanel.className = "section-panel";
  vacPanel.appendChild(vacWrap);
  proc.appendChild(vacPanel);
}

console.log("ARRIVALS RAW:", a.arrivals);

// Card click loads full approaches if not already loaded
div.appendChild(title);
div.appendChild(sub);
div.appendChild(proc);
root.appendChild(div);
  }
}

function prettyFreqName(f) {

  const map = {
    TWR: "Tower",
    GND: "Ground",
    APP: "Approach",
    DEP: "Departure",
    ATIS: "ATIS",
    CTAF: "CTAF",
    UNICOM: "UNICOM"
  };

  return map[f.type] || f.name || f.type;
}

function isDomesticSandcatICAO(icao) {
  icao = String(icao || "").toUpperCase();
  return icao.startsWith("K") || icao.startsWith("PA") || icao.startsWith("PH");
}

function applyAirportModeForICAO(icao) {
  const iapToggle = document.getElementById("filterNoApproaches");

  const isIntlNeeded =
    /^[A-Z]{4}$/.test(icao) && !isDomesticSandcatICAO(icao);

  // Do NOT auto-disable IAP anymore.
  // AU/non-US IAP filtering now works from ausData.
}

function extractAirportFromDashedKey(rawKey) {
  const upper = String(rawKey || "").toUpperCase();
  const beforeDate = upper.split(/-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-/)[0];
  const parts = beforeDate.split("-").filter(Boolean);

  const ignore = new Set([
    "NY", "APP", "DEP", "CENTER", "RADAR", "TOWER", "GROUND",
    "CTR", "FINAL", "FINA", "FREQ", "VAD", "V2"
  ]);

  for (const p of parts) {
    // full ICAO like LSZH1 -> LSZH
    const icao = p.match(/^([A-Z]{4})\d?$/);
    if (icao && !ignore.has(icao[1])) return icao[1];

    // IATA like LGA
    if (/^[A-Z]{3}$/.test(p) && !ignore.has(p)) return p;
  }

  return null;
}


function extractICAOFromKey(rawKey) {
  if (!rawKey) return null;

  const dashedAirport = extractAirportFromDashedKey(rawKey);
  if (dashedAirport) return dashedAirport;

  const upper = String(rawKey).toUpperCase();

  const domestic = upper.match(/(?<![A-Z])(?:K[A-Z]{3}|PA[A-Z]{2}|PH[A-Z]{2}|P[A-Z]{3}|C[A-Z]{3})(?![A-Z])/);
  if (domestic) return domestic[0];

  return null;
}

  function autoResizeTextarea(el) {
  if (!el) return;

  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

async function handleNewPageKey(newRaw) {

  if (!newRaw) return;

  const lbxKeyEl = document.getElementById("lbxKey");
  if (lbxKeyEl) {
    lbxKeyEl.value = newRaw;
    autoResizeTextarea(lbxKeyEl);
  }

  const newAirport = extractICAOFromKey(newRaw);
if (!/^[A-Z]{3,4}$/.test(newAirport)) return;

applyAirportModeForICAO(newAirport);

const input = document.getElementById("airportInput");
if (input) {
  input.value = newAirport;
    const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
 maybeQueryNearby(normalizeAirport(newAirport));
}
  }

  // 🔥 Update overlay header immediately
chrome.storage.local.set({ overlayActiveICAO: normalizeAirport(newAirport) });

  // 🔥 Run autolaunch
  const { lbx_settings } =
    await chrome.storage.local.get(["lbx_settings"]);

  chrome.runtime.sendMessage({
    type: "RUN_AUTOLAUNCH",
    rawText: newRaw,
    settings: lbx_settings || { adsb: true }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.lb_pageKey?.newValue) {
    handleNewPageKey(changes.lb_pageKey.newValue);
  }
});

async function detectProcedures(routeFixes, origin, dest){

  const result = {
    sid: null,
    star: null
  };

  if(!routeFixes?.length) return result;

const startSegment = routeFixes.slice(0,15);
const endSegment   = routeFixes.slice(-15);

  if(origin){

    const resp = await chrome.runtime.sendMessage({
      type:"GET_PROCS_FOR_AIRPORT",
      airport: origin,
      procType:"DP"
    });

    const procs = resp?.procs || [];

    let bestScore = 0;

    for(const p of procs){

      const fixesResp = await chrome.runtime.sendMessage({
        type:"GET_PROC_FIXES",
        procType:"DP",
        procName:p.name,
        procCode:p.code
      });

      const fixes = fixesResp?.fixes || [];

      const score = fixes.filter(f => startSegment.includes(f)).length;

      if(score > bestScore && score >= 3){
        bestScore = score;
        result.sid = p.code || p.name;
      }

    }

  }

  if(dest){

    const resp = await chrome.runtime.sendMessage({
      type:"GET_PROCS_FOR_AIRPORT",
      airport: dest,
      procType:"STAR"
    });

    const procs = resp?.procs || [];

    let bestScore = 0;

    for(const p of procs){

      const fixesResp = await chrome.runtime.sendMessage({
        type:"GET_PROC_FIXES",
        procType:"STAR",
        procName:p.name,
        procCode:p.code
      });

      const fixes = fixesResp?.fixes || [];

      const score = fixes.filter(f => endSegment.includes(f)).length;

      if(score > bestScore && score >= 3){
        bestScore = score;
        result.star = p.code || p.name;
      }

    }

  }

  return result;
}

function dedupeAirportsByIdent(list) {
  const seen = new Set();
  const out = [];

  for (const a of list || []) {
    const ident = String(a.ident || a.gps_code || a.local_code || "").toUpperCase();
    if (!ident) continue;

    if (seen.has(ident)) continue;
    seen.add(ident);

    out.push(a);
  }

  return out;
}


async function queryNearby(force = false) {

  const ident = ($("airportInput").value || "").trim().toUpperCase();
  if (!force && ident === LAST_LOADED_AIRPORT) {
  console.log("Already loaded:", ident);
  return;
}

  if (!ident) {
    return setStatus("Enter an airport identifier (e.g., KDAL).", true);
  }

  const radius_nm = Number($("radiusNm").value || 0);
  if (!Number.isFinite(radius_nm) || radius_nm <= 0) {
    return setStatus("Radius must be a positive number.", true);
  }

  const mainOnly =
    document.getElementById("mainOnlyToggle")?.checked === true;

  const requestedMax =
    Number($("maxResults").value || 25);

  const hideNoApp =
    document.getElementById("filterNoApproaches")?.checked === true;

  const typesMode = $("types").value;

  const includeHelipads =
    typesMode === "helipads_only" ||
    typesMode === "airports_plus_helipads";

const intlMode = !isDomesticSandcatICAO(ident);
const country = intlMode ? "ANY" : "US";

  /* -----------------------------
     QUERY SIGNATURE CACHE CHECK
  ----------------------------- */

  const { last_query_signature } =
    await chrome.storage.local.get("last_query_signature");

const querySignature = JSON.stringify({
  ident,
  radius_nm,
  requestedMax,
  hideNoApp,
  mainOnly,
  typesMode,
  includeHelipads,
  intlMode
});
  if (!force && querySignature === last_query_signature) {
    console.log("Skipping reload (same query):", ident);
    return;
  }

  console.log(
    "CHSLY check:",
    Object.keys(FIX_PROCEDURE_MAP).filter(f => f.includes("CHSLY"))
  );

  setStatus("Finding nearby airports…");

  /* -----------------------------
     RESULT SIZE CONTROL
  ----------------------------- */

  const fetchMax = hideNoApp
    ? Math.min(200, requestedMax * 6)
    : requestedMax;

const resp = await chrome.runtime.sendMessage({
  type: "QUERY_NEARBY",
  ident,
  radius_nm,
  max_results: fetchMax,
  country,
  typesMode,
  includeHelipads,
  mainOnly,
  intlMode
});

  if (!resp || !resp.ok) {
    return setStatus(resp?.error || "Unknown error", true);
  }

  if (mainOnly) {
    setStatus(`Loaded ${ident} (main airport only).`);
  } else {
    setStatus(`Loaded ${resp.results.length} airports near ${resp.center.ident}.`);
  }

MASTER_RESULTS = dedupeAirportsByIdent(resp.results);

  buildAirportNameMap();

  renderResults(
    MASTER_RESULTS,
    String(resp.center.ident || "").toUpperCase()
  );

/* -----------------------------
   PRELOAD SID / STAR FIX MAP
----------------------------- */
if (!intlMode) {
for (const airport of MASTER_RESULTS) {

  /* SID */
  for (const p of airport.departures || []) {

    const resp = await chrome.runtime.sendMessage({
      type: "GET_PROC_FIXES",
      procType: "DP",
      procName: p.name,
      procCode: p.code
    });

    for (const fx of resp?.fixes || []) {

      const key = fx.toUpperCase();

      if (!FIX_PROCEDURE_MAP[key]) {
        FIX_PROCEDURE_MAP[key] = [];
      }

      const exists = FIX_PROCEDURE_MAP[key].some(
        x => x.proc === (p.code || p.name) && x.airport === airport.ident
      );

      if (!exists) {
        FIX_PROCEDURE_MAP[key].push({
          airport: airport.ident,
          type: "SID",
          proc: p.code || p.name,
          procDisplay: p.displayName || p.name
        });
      }

    }
  }

  /* STAR */
  for (const p of airport.arrivals || []) {

    const resp = await chrome.runtime.sendMessage({
      type: "GET_PROC_FIXES",
      procType: "STAR",
      procName: p.name,
      procCode: p.code
    });

    for (const fx of resp?.fixes || []) {

      const key = fx.toUpperCase();

      if (!FIX_PROCEDURE_MAP[key]) {
        FIX_PROCEDURE_MAP[key] = [];
      }

      const exists = FIX_PROCEDURE_MAP[key].some(
        x => x.proc === (p.code || p.name) && x.airport === airport.ident
      );

      if (!exists) {
        FIX_PROCEDURE_MAP[key].push({
          airport: airport.ident,
          type: "STAR",
          proc: p.code || p.name,
          procDisplay: p.displayName || p.name
        });
      }

    }
  }

}
}
  /* -----------------------------
     SAVE CACHE
  ----------------------------- */

await chrome.storage.local.set({
  last_query_signature: querySignature,
  nearby_cache: {
    airport: ident,
    results: resp.results,
    center: String(resp.center.ident || "").toUpperCase()
  }
});

LAST_LOADED_AIRPORT = ident;
await chrome.storage.local.set({
  last_loaded_airport: ident
});
}

$("searchBtn").addEventListener("click", queryNearby);
$("airportInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") queryNearby();
});

// ---- CIFP loader wiring ----
const cifpBtn = $("cifpBtn");
const cifpFile = $("cifpFile");
const cifpStatus = $("cifpStatus");

if (cifpBtn && cifpFile && cifpStatus) {
  cifpBtn.addEventListener("click", () => cifpFile.click());

  cifpFile.addEventListener("change", async () => {
    const f = cifpFile.files && cifpFile.files[0];
    if (!f) return;

    cifpStatus.textContent = "Loading…";

    try {
      const arrayBuffer = await f.arrayBuffer();
const u8 = new Uint8Array(arrayBuffer);   // 🔥 important
const resp = await chrome.runtime.sendMessage({
  type: "LOAD_CIFP_ZIP",
  bytes: Array.from(u8),                  // send as normal array
  filename: f.name
});

      if (!resp || !resp.ok) {
        cifpStatus.textContent = `Failed: ${resp?.error || "No response"}`;
        return;
      }
      cifpStatus.textContent = `Loaded: ${resp.summary || "OK"}`;
    } catch (e) {
      cifpStatus.textContent = `Failed: ${String(e?.message || e)}`;
    } finally {
      cifpFile.value = ""; // allow re-upload same file
    }
  });
}

function runLocalFacilitySearch(q){

  const items = document.querySelectorAll("#facilityContent .facilityItem");

  items.forEach(item => {

    const text = item.textContent.toUpperCase();

    item.style.display =
      text.includes(q) ? "" : "none";

  });

}

async function preloadProcedureMaps(origin, dest) {
  for (const airport of [origin, dest]) {
    if (!airport) continue;

    const sidResp = await chrome.runtime.sendMessage({
      type: "GET_PROCS_FOR_AIRPORT",
      airport,
      procType: "DP"
    });

    for (const p of sidResp?.procs || []) {
      const fixesResp = await chrome.runtime.sendMessage({
        type: "GET_PROC_FIXES",
        procType: "DP",
        procName: p.name,
        procCode: p.code
      });

      for (const fx of fixesResp?.fixes || []) {
        const key = String(fx || "").toUpperCase();
        if (!FIX_PROCEDURE_MAP[key]) FIX_PROCEDURE_MAP[key] = [];

        FIX_PROCEDURE_MAP[key].push({
          type: "SID",
          proc: p.code || p.name,
          procDisplay: p.displayName || p.name
        });
      }
    }

    const starResp = await chrome.runtime.sendMessage({
      type: "GET_PROCS_FOR_AIRPORT",
      airport,
      procType: "STAR"
    });

    for (const p of starResp?.procs || []) {
      const fixesResp = await chrome.runtime.sendMessage({
        type: "GET_PROC_FIXES",
        procType: "STAR",
        procName: p.name,
        procCode: p.code
      });

      for (const fx of fixesResp?.fixes || []) {
        const key = String(fx || "").toUpperCase();
        if (!FIX_PROCEDURE_MAP[key]) FIX_PROCEDURE_MAP[key] = [];

        FIX_PROCEDURE_MAP[key].push({
          type: "STAR",
          proc: p.code || p.name,
          procDisplay: p.displayName || p.name
        });
      }
    }

    const airportResp = await chrome.runtime.sendMessage({
      type: "GET_AIRPORT_DETAILS",
      ident: airport
    });

    const airportData = airportResp?.airport || airportResp?.data || null;
    const approaches = airportData?.approaches || [];

    for (const ap of approaches) {
      const resp = await chrome.runtime.sendMessage({
        type: "GET_IAP_FIXES",
        airportIdent: airport,
        approachName: ap
      });

      for (const fx of resp?.fixes || []) {
        const key = String(fx || "").toUpperCase();
        if (!FIX_PROCEDURE_MAP[key]) FIX_PROCEDURE_MAP[key] = [];

        FIX_PROCEDURE_MAP[key].push({
          type: "IAP",
          proc: ap,
          procDisplay: ap
        });
      }
    }
  }
}

async function refreshActiveFlightPanel() {
  console.log("REFRESHING ACTIVE PANEL");

  const renderId = ++ACTIVE_ROUTE_RENDER;

  const data = await chrome.storage.local.get([
    "adsb_active_flight_callsign",
    "adsb_active_flight_info",
    "adsb_active_flight_origin",
    "adsb_active_flight_destination",
    "adsb_active_flight_fixes",
    "adsb_active_flight_freqs",
    "adsb_active_flight_vfr_waypoints"
  ]);

  if (renderId !== ACTIVE_ROUTE_RENDER) return;

  console.log("[VFR] From storage:", (data.adsb_active_flight_vfr_waypoints || []).length, "waypoints");

  window.activeFlightCallsign =
    data.adsb_active_flight_callsign ||
    data.adsb_active_flight_info?.callsign ||
    null;

  window.activeFlightOrigin = data.adsb_active_flight_origin || null;
  window.activeFlightDest = data.adsb_active_flight_destination || null;

  const routeBox = document.getElementById("routeResults");
  if (!routeBox) return;

  let fixes = (data.adsb_active_flight_fixes || [])
    .map(f => String(f || "").toUpperCase())
    .filter(Boolean);

  await preloadProcedureMaps(
    window.activeFlightOrigin,
    window.activeFlightDest
  );

if (!fixes.length) {
  routeBox.innerHTML = "<div class='routeFix'>No active flight</div>";
  renderFlightFreqs(null);
  renderFlightAirports(null, "");
  return;
}

  if (fixes.length > 100) fixes = fixes.slice(0, 100);

  await applyActiveFlightFixesToUI(fixes);

  if (routePanelMode === "vfr") {
    renderVfrWaypoints(data.adsb_active_flight_vfr_waypoints || []);
  }

  const origin = window.activeFlightOrigin;
  const dest = window.activeFlightDest;

  let originName = AIRPORT_NAME_MAP[origin] || "";
  let destName = AIRPORT_NAME_MAP[dest] || "";

  if (!originName && origin) {
    const resp = await chrome.runtime.sendMessage({
      type: "GET_AIRPORT_NAME",
      ident: origin
    });
    originName = resp?.name || "";
  }

  if (!destName && dest) {
    const resp = await chrome.runtime.sendMessage({
      type: "GET_AIRPORT_NAME",
      ident: dest
    });
    destName = resp?.name || "";
  }

  renderFlightAnalysis(
    null,
    fixes,
    { ident: origin, name: originName },
    { ident: dest, name: destName },
    null
  );

  renderFlightFreqs(data.adsb_active_flight_freqs || null);
  renderFlightAirports(data.adsb_active_flight_freqs || null, "");
}

async function applyActiveFlightFixesToUI(fixes) {
  const container = document.getElementById("routeResults");
  if (!container) return;

  container.innerHTML = "";

  if (!fixes?.length) {
    container.innerHTML =
      "<div class='routeFix'>No active flight detected</div>";
    return;
  }

  fixes = [...new Set(fixes.map(f => String(f || "").toUpperCase()))];

  const max = Math.min(fixes.length, 100);

  for (let i = 0; i < max; i++) {
    const fx = fixes[i];

    const nav = NAVAIDS?.[fx];

    const displayText = nav?.name ? nav.name.toUpperCase() : fx;
    const copyText = nav?.name ? nav.name.toUpperCase() : fx;

    let label = nav?.name ? `${displayText} (${fx})` : displayText;

    const procs = FIX_PROCEDURE_MAP?.[fx];

    if (procs?.length) {
      const unique = new Map();

      for (const p of procs) {
        const name = p.procDisplay || p.proc || "";
        if (!unique.has(name)) unique.set(name, p.type);
      }

      for (const [name, type] of unique) {
        let cls = "procSID";
        if (type === "STAR") cls = "procSTAR";
        if (type === "IAP") cls = "procAPP";

        label += ` <span class="procTag ${cls}">${name}</span>`;
      }
    }

    const airways = FIX_AIRWAY_MAP?.[fx];

    if (airways?.length) {
      for (const aw of [...new Set(airways)]) {
        label += ` <span class="procTag procAIRWAY">${aw}</span>`;
      }
    }

    const row = document.createElement("div");
    row.className = "routeFix";
    row.innerHTML = label;

    row.addEventListener("click", async () => {
      await copyWithFeedback(row, copyText);
    });

    container.appendChild(row);
  }
}

function renderVfrWaypoints(waypoints) {
  const container = document.getElementById("routeVfrWps");
  if (!container) return;

  container.innerHTML = "";

  if (!waypoints?.length) {
    container.innerHTML = "<div class='routeFix' style='color:#4b5563'>No VFR waypoints within 30 NM of track</div>";
    return;
  }

  for (const wp of waypoints) {
    const row = document.createElement("div");
    row.className = "routeFix";
    const state = wp.state ? ` · ${wp.state}` : "";
    row.innerHTML = `<span style="color:#38bdf8;font-weight:600">${wp.code}</span> <span style="color:#94a3b8;font-size:10px">${wp.name}${state}</span>`;
    row.title = `Copy ${wp.code}`;
    row.addEventListener("click", async () => {
      await copyWithFeedback(row, wp.code);
    });
    container.appendChild(row);
  }
}

function flattenRoute(track) {
  return track || [];
}

async function getAdsbRoute() {
  const tabs = await chrome.tabs.query({
    url: "*://globe.adsbexchange.com/*"
  });

  if (!tabs.length) {
    console.warn("ADS-B tab not found");
    return null;
  }

  const tabId = tabs[0].id;

  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      {
        type: "GET_ADSB_ROUTE_FROM_TAB",
        tabId
      },
      res => {
        if (!res?.ok) {
          console.warn("Route fetch failed");
          resolve(null);
        } else {
          resolve(res.coords);
        }
      }
    );
  });
}

async function findWaypointsAlongRoute(track) {
  const points = flattenRoute(track);
  if (!points.length) return [];

  const found = new Set();
  const results = [];
  const STEP = 6;

  for (let i = 0; i < points.length; i += STEP) {
    const { lat, lon } = points[i];

    const resp = await chrome.runtime.sendMessage({
      type: "SEARCH_WAYPOINTS_NEAR",
      lat,
      lon,
      radius_nm: 8
    });

    if (!resp?.ok) continue;

    for (const fix of resp.fixes || []) {
      const id = fix.ident;
      if (found.has(id)) continue;

      found.add(id);
      results.push(fix);
    }
  }

  return results;
}

async function renderRouteWaypoints(fixes) {
  const container = document.getElementById("routeResults");
  if (!container) return;

  container.innerHTML = "";

  for (const fx of fixes || []) {
    const row = document.createElement("div");
    row.className = "routeFix";

    const ident = String(fx.ident || "").toUpperCase();
    const nav = NAVAIDS?.[ident];

    row.textContent = nav ? `${ident} — ${nav.name}` : ident;

    row.addEventListener("click", async () => {
      await copyWithFeedback(row, ident);
    });

    container.appendChild(row);
  }
}


async function findNearestAirport(lat, lon){

  const resp = await chrome.runtime.sendMessage({
    type: "SEARCH_NEAREST_AIRPORT",
    lat,
    lon
  });

  if(!resp?.ok) return null;

  return resp.airport;
}

async function getAusProceduresForAirport(icao) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      {
        type: "GET_AUS_PROCEDURES",
        icao
      },
      response => {
        resolve(response?.data || null);
      }
    );
  });
}

async function getSwissProceduresForAirport(icao) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: "GET_SWISS_PROCEDURES", icao },
      response => { resolve(response?.data || null); }
    );
  });
}

async function getIrelandProceduresForAirport(icao) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: "GET_IRELAND_PROCEDURES", icao },
      response => { resolve(response?.data || null); }
    );
  });
}

function swissProcChip(proc, procType) {
  const label = proc.name || "(unnamed)";
  const fixes = (proc.waypoints || [])
    .map(w => String(w.ident || "").trim().toUpperCase())
    .filter(Boolean);
  const span = makeChip(label, "pointer");

  span.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!fixes.length) {
      openFixPopover(span, label, "No waypoints.");
      return;
    }
    const cleanFixes = [...new Set(fixes)];
    for (const fx of cleanFixes) {
      if (!FIX_PROCEDURE_MAP[fx]) FIX_PROCEDURE_MAP[fx] = [];
      FIX_PROCEDURE_MAP[fx].push({ airport: "", type: procType, proc: label, procDisplay: label });
    }
    openFixPopover(span, label, " ");
    await renderFixListInPopover(label, cleanFixes);
  });
  return span;
}

function formatIrelandChipLabel(proc, procType) {
  const name = proc.name || "(unnamed)";
  if (procType === "IAP" || procType === "VAC") return name;
  // SID/STAR: "ELTIG1M CAT A/B RWY07" → "ELTIG 1M CAT A/B RWY 07"
  const fix = name.slice(0, 5);
  const suffix = name.slice(5).trim();
  const cat = proc.category ? ` CAT ${proc.category}` : "";
  const rwyRaw = (proc.runway || "").replace(/^RWY/i, "").trim();
  const rwy = rwyRaw ? ` RWY ${rwyRaw}` : "";
  return `${fix}${suffix ? " " + suffix : ""}${cat}${rwy}`;
}

function formatAltConstraint(w) {
  if (!w.altitude && w.altitude !== 0) return null;
  const alt = w.altitude;
  const sym = w.constraint === "at_or_above" ? "≥" :
              w.constraint === "at_or_below" ? "≤" : "";
  return `${sym}${alt}`.trim();
}

async function renderIrelandFixListInPopover(title, waypoints) {
  const pop = document.getElementById("fixPopover");
  const titleEl = document.getElementById("fixPopoverTitle");
  const content = document.getElementById("fixPopoverContent");

  titleEl.textContent = title;
  content.innerHTML = "";

  const seen = new Set();
  for (const w of waypoints) {
    const fx = String(w.fix || "").trim().toUpperCase();
    if (!fx) continue;
    const nav = NAVAIDS?.[fx] || null;
    const altLabel = formatAltConstraint(w);

    const row = document.createElement("div");
    row.className = "fixRow";
    row.style.cursor = "pointer";

    const left = document.createElement("div");
    left.className = "fixCode";
    left.textContent = fx;

    const right = document.createElement("div");
    right.className = "fixMeta";

    const parts = [];
    if (nav?.name) parts.push(nav.name.toUpperCase());
    if (altLabel) parts.push(altLabel);
    right.textContent = parts.join(" · ");

    if (nav) {
      row.classList.add("isNav");
      row.title = `${nav.type || "NAVAID"}${nav.freq ? " • " + nav.freq : ""}`;
    } else {
      row.title = "Fix/Waypoint";
    }

    row.addEventListener("click", async (e) => {
      e.stopPropagation();
      await copyWithFeedback(row, nav?.name ? nav.name.toUpperCase() : fx);
      row.classList.add("copied");
      const orig = right.textContent;
      right.textContent = "Copied ✓";
      setTimeout(() => { right.textContent = orig; row.classList.remove("copied"); }, 800);
    });

    row.appendChild(left);
    row.appendChild(right);
    if (!seen.has(fx)) {
      content.appendChild(row);
      seen.add(fx);
    }
  }

  pop.classList.remove("hidden");
}

function irelandProcChip(proc, procType) {
  const label = proc.name || "(unnamed)";
  const chipLabel = formatIrelandChipLabel(proc, procType);

  // VAC waypoints are strings, not objects
  const waypoints = procType === "VAC"
    ? (proc.waypoints || []).map(w => typeof w === "string" ? { fix: w } : w)
    : (proc.waypoints || []);

  const fixes = waypoints.map(w => String(w.fix || "").trim().toUpperCase()).filter(Boolean);
  const span = makeChip(chipLabel, "pointer");

  span.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!fixes.length) {
      openFixPopover(span, label, "No waypoints.");
      return;
    }
    const cleanFixes = [...new Set(fixes)];
    for (const fx of cleanFixes) {
      if (!FIX_PROCEDURE_MAP[fx]) FIX_PROCEDURE_MAP[fx] = [];
      FIX_PROCEDURE_MAP[fx].push({ airport: "", type: procType, proc: label, procDisplay: label });
    }
    openFixPopover(span, label, " ");
    await renderIrelandFixListInPopover(label, waypoints);
  });
  return span;
}

function renderIrelandProcsByRunway(container, procs, procType) {
  if (!procs.length) return;

  const groups = new Map();
  for (const proc of procs) {
    const rwy = (proc.runway || "ALL").replace(/^RWY/i, "").trim() || "ALL";
    if (!groups.has(rwy)) groups.set(rwy, []);
    groups.get(rwy).push(proc);
  }

  const sorted = [...groups.keys()].sort((a, b) => {
    if (a === "ALL") return 1;
    if (b === "ALL") return -1;
    return parseInt(a) - parseInt(b) || a.localeCompare(b);
  });

  const selected = container.dataset.selectedRwyKey || sorted[0];
  container.dataset.selectedRwyKey = selected;

  const selectorRow = document.createElement("div");
  selectorRow.className = "rwy-selector";

  for (const rwy of sorted) {
    const label = rwy === "ALL" ? "All" : rwy;
    const btn = makeButtonChip(label, selected === rwy);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      container.dataset.selectedRwyKey = rwy;
      container.innerHTML = "";
      renderIrelandProcsByRunway(container, procs, procType);
    });
    selectorRow.appendChild(btn);
  }

  container.appendChild(selectorRow);

  const rwyProcs = groups.get(selected) || [];
  const block = document.createElement("div");
  block.className = "rwy-block";

  const h = document.createElement("div");
  h.className = "rwy-header";
  h.textContent = selected === "ALL" ? `All Runways (${rwyProcs.length})` : `RWY ${selected} (${rwyProcs.length})`;
  block.appendChild(h);

  const wrap = document.createElement("div");
  for (const proc of rwyProcs) wrap.appendChild(irelandProcChip(proc, procType));
  block.appendChild(wrap);
  container.appendChild(block);
}

function reciprocalRunway(rwy) {
  const m = String(rwy).match(/^(\d{1,2})([LRC]?)$/i);
  if (!m) return null;
  let num = ((parseInt(m[1], 10) - 1 + 18) % 36) + 1;
  const suf = m[2].toUpperCase();
  const recSuf = suf === "L" ? "R" : suf === "R" ? "L" : suf;
  return String(num).padStart(2, "0") + recSuf;
}

function buildIrelandRunwayPairs(procs) {
  const rwySet = new Set(
    procs.map(p => (p.runway || "").replace(/^RWY/i, "").trim()).filter(Boolean)
  );

  const seen = new Set();
  const pairs = [];

  for (const rwy of [...rwySet].sort()) {
    const rec = reciprocalRunway(rwy);
    const key = [rwy, rec || ""].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b)).join("/");
    if (seen.has(key)) continue;
    seen.add(key);

    const end1 = key.split("/")[0];
    const end2 = key.split("/")[1];
    pairs.push({ pairKey: key, end1, end2, label: key });
  }

  return pairs.sort((a, b) => parseInt(a.end1) - parseInt(b.end1) || a.pairKey.localeCompare(b.pairKey));
}

function renderIrelandIAPsByRunwayPair(container, iaps) {
  if (!iaps.length) return;

  const byRunway = new Map();
  const other = [];

  for (const proc of iaps) {
    const rwy = (proc.runway || "").replace(/^RWY/i, "").trim();
    if (rwy) {
      if (!byRunway.has(rwy)) byRunway.set(rwy, []);
      byRunway.get(rwy).push(proc);
    } else {
      other.push(proc);
    }
  }

  const pairs = buildIrelandRunwayPairs(iaps);

  if (!pairs.length) {
    for (const proc of iaps) container.appendChild(irelandProcChip(proc, "IAP"));
    return;
  }

  const selected = container.dataset.selectedPairKey || pairs[0].pairKey;
  container.dataset.selectedPairKey = selected;

  const selectorRow = document.createElement("div");
  selectorRow.className = "rwy-selector";

  for (const p of pairs) {
    const btn = makeButtonChip(p.label, selected === p.pairKey);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      container.dataset.selectedPairKey = p.pairKey;
      container.innerHTML = "";
      renderIrelandIAPsByRunwayPair(container, iaps);
    });
    selectorRow.appendChild(btn);
  }

  container.appendChild(selectorRow);

  const content = document.createElement("div");
  const sel = pairs.find(x => x.pairKey === selected) || pairs[0];
  const ends = [sel.end1, sel.end2].filter(Boolean);
  let any = false;

  for (const end of ends) {
    const procs = byRunway.get(end) || [];
    if (!procs.length) continue;
    any = true;

    const block = document.createElement("div");
    block.className = "rwy-block";

    const h = document.createElement("div");
    h.className = "rwy-header";
    h.textContent = `RWY ${end} (${procs.length})`;
    block.appendChild(h);

    const wrap = document.createElement("div");
    for (const proc of procs) wrap.appendChild(irelandProcChip(proc, "IAP"));
    block.appendChild(wrap);
    content.appendChild(block);
  }

  if (!any) {
    const none = document.createElement("div");
    none.style.opacity = "0.75";
    none.textContent = "(no approaches tagged to this runway pair)";
    content.appendChild(none);
  }

  if (other.length) {
    const h = document.createElement("div");
    h.style.fontWeight = "700";
    h.style.marginTop = "10px";
    h.textContent = `Other (${other.length})`;
    content.appendChild(h);
    const wrap = document.createElement("div");
    for (const proc of other) wrap.appendChild(irelandProcChip(proc, "IAP"));
    content.appendChild(wrap);
  }

  container.appendChild(content);
}



/* =============================
   PANEL TOGGLE WIRING (FINAL)
============================= */

const overlayRoot = document.getElementById("overlayRoot");
const facilityPanel = document.getElementById("facilityPanel");
const lbxPanel = document.getElementById("lbxPanel");
const facilityHeader = facilityPanel?.querySelector(".panel-header");
const lbxHeader = document.getElementById("lbxTitle");

const routePanel = document.getElementById("routePanel");
const routeTitle = document.getElementById("routeTitle");

const airportSearchPanel = document.getElementById("airportSearchPanel");
const airportSearchTitle = document.getElementById("airportSearchTitle");

// ── Accordion: only one panel open at a time ──────────────────────────────
const PANEL_DEFS = [
  { el: facilityPanel,      openClass: "facility-open",     headerSel: ".panel-header",        storageKey: "facilityOpen" },
  { el: lbxPanel,           openClass: "lbx-open",          headerSel: "#lbxTitle",             storageKey: "lbxOpen" },
  { el: airportSearchPanel, openClass: "airportsearch-open", headerSel: "#airportSearchTitle",  storageKey: "airportSearchOpen" },
  { el: routePanel,         openClass: "route-open",         headerSel: "#routeTitle",           storageKey: "routeOpen" },
];

function collapseAllPanels(exceptClass) {
  for (const p of PANEL_DEFS) {
    if (p.openClass !== exceptClass) {
      overlayRoot.classList.remove(p.openClass);
    }
  }
}

function savePanelState() {
  const state = {};
  for (const p of PANEL_DEFS) state[p.storageKey] = overlayRoot.classList.contains(p.openClass);
  chrome.storage.local.set(state);
}

// Restore saved panel state (only one at a time — honour last-saved open panel)
chrome.storage.local.get(["facilityOpen", "lbxOpen", "airportSearchOpen", "routeOpen"], (data) => {
  // Find the last panel that was open and restore only that one
  for (const p of PANEL_DEFS) {
    if (data[p.storageKey]) {
      collapseAllPanels(p.openClass);
      overlayRoot.classList.add(p.openClass);
      break;
    }
  }
});

for (const p of PANEL_DEFS) {
  if (!p.el) continue;
  p.el.addEventListener("click", (e) => {
    const isOpen = overlayRoot.classList.contains(p.openClass);
    if (!isOpen) {
      collapseAllPanels(p.openClass);
      overlayRoot.classList.add(p.openClass);
    } else {
      if (e.target.closest(p.headerSel)) {
        overlayRoot.classList.remove(p.openClass);
      }
    }
    savePanelState();
  });
}
// React to changes even while overlay is open


(async function initPopup() {
const saved = await chrome.storage.local.get("last_loaded_airport");

if (saved?.last_loaded_airport) {
  LAST_LOADED_AIRPORT = saved.last_loaded_airport;
  console.log("Restored last airport:", LAST_LOADED_AIRPORT);
}
chrome.runtime.sendMessage({ type: "GET_NAVAID_INDEX" })
  .then(navResp => {
    if (navResp?.ok) NAVAIDS = navResp.index || null;
  })
  .catch(() => {});


chrome.runtime.sendMessage({ type: "GET_PROC_FIX_MASTER" })
  .then(resp => {
    if (resp?.ok) {
      PROC_FIX_MASTER = resp.results || [];
      console.log("PROC MASTER LOADED:", PROC_FIX_MASTER.length);
    }
  })
  .catch(err => {
    console.warn("PROC MASTER load failed:", err);
  });

  

// 🔥 Load current Labelbox key on popup open
try {
  const { lb_pageKey } = await chrome.storage.local.get("lb_pageKey");

  if (lb_pageKey) {
    console.log("Bootstrapping from lb_pageKey:", lb_pageKey);
    await handleNewPageKey(lb_pageKey);
  }
} catch (err) {
  console.warn("lb_pageKey bootstrap failed:", err);
}

// 🔥 Strong ICAO bootstrap
try {
  let drAirport = null;

  // 1️⃣ Try in-memory fast source
  const memResp = await chrome.runtime.sendMessage({
    type: "GET_LAST_AIRPORT"
  });

  if (memResp?.airport) {
    drAirport = memResp.airport;
  }

  // 2️⃣ Fallback to storage
  if (!drAirport) {
    const storageResp = await chrome.runtime.sendMessage({
      type: "GET_DR_AIRPORT"
    });
    drAirport = storageResp?.airport;
  }

if (/^[A-Z]{3,4}$/.test(drAirport)) {
  const input = document.getElementById("airportInput");
  if (input) {
    input.value = drAirport;

    applyAirportModeForICAO(drAirport); // 🔥 ADD THIS LINE HERE

      console.log("ICAO synced:", drAirport);
      const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh && drAirport !== LAST_LOADED_AIRPORT) {
  maybeQueryNearby(drAirport);
}
    }

  }

} catch (err) {
  console.warn("ICAO bootstrap failed:", err);
}
  const refreshBtn = document.getElementById("icaoRefreshBtn");



chrome.storage.local.get(
  ["sandcat_search_settings", "nearby_cache"],
  (data) => {

    const radiusInput = document.getElementById("radiusNm");
    const maxResultsInput = document.getElementById("maxResults");

    const settings = data.sandcat_search_settings || {};

    if (radiusInput) {
      radiusInput.value = settings.radius_nm || 25;
    }

    if (maxResultsInput) {
      maxResultsInput.value = settings.max_results || 25;
    }

    /* 🔥 Instant cache restore */
    if (data.nearby_cache?.results?.length) {

      MASTER_RESULTS = data.nearby_cache.results;

      renderResults(
        MASTER_RESULTS,
        data.nearby_cache.center
      );

      console.log("Restored nearby airport cache");
    }

const airport = document.getElementById("airportInput")?.value;

if (airport && airport !== LAST_LOADED_AIRPORT) {
  maybeQueryNearby(airport);
}
  }
);


if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {

    console.log("Manual ICAO refresh triggered");

    const { lb_pageKey } = await chrome.storage.local.get("lb_pageKey");

    if (!lb_pageKey) {
      console.warn("No lb_pageKey found.");
      return;
    }

    const newAirport = extractICAOFromKey(lb_pageKey);

    if (!/^[A-Z]{4}$/.test(newAirport)) {
      console.warn("Invalid ICAO extracted:", newAirport);
      return;
    }

    const input = document.getElementById("airportInput");

    if (!input) return;

    input.value = newAirport;
    applyAirportModeForICAO(newAirport);

    console.log("ICAO refreshed to:", newAirport);

    const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  queryNearby(false);
}
  });
}



  const { nearby_cache } =
    await chrome.storage.local.get(["nearby_cache"]);

 
const radiusInput = document.getElementById("radiusNm");
const maxResultsInput = document.getElementById("maxResults");

function saveSearchSettings() {
  chrome.storage.local.set({
    sandcat_search_settings: {
      radius_nm: Number(radiusInput?.value || 25),
      max_results: Number(maxResultsInput?.value || 25)
    }
  });
}

radiusInput?.addEventListener("input", saveSearchSettings);
maxResultsInput?.addEventListener("input", saveSearchSettings);


const facilitySearch = document.getElementById("facilitySearch");

facilitySearch?.addEventListener("input", () => {

  const raw = facilitySearch.value.trim().toUpperCase();

  // extract runway (e.g. 18, 18L, RWY 18)
  const rwyMatch = raw.match(/\b(?:RWY|RUNWAY)?\s*(\d{1,2}[LRC]?)\b/);
  const runwayQ = rwyMatch ? normalizeRwy(rwyMatch[1]) : null;

  // remove runway part from text search
  const textQ = raw.replace(/\b(?:RWY|RUNWAY)?\s*\d{1,2}[LRC]?\b/, "").trim();

  const items = document.querySelectorAll("#facilityContent .facilityItem");

  items.forEach(item => {

    const text = item.textContent.toUpperCase();

    // 🔥 get runway data from dataset (we’ll add this next)
    const rwyData = item.dataset.runways || "";

    const matchesText = !textQ || text.includes(textQ);
    const matchesRunway = !runwayQ || rwyData.includes(runwayQ);

    if (matchesText && matchesRunway) {
      item.style.display = "";
    } else {
      item.style.display = "none";
    }

  });

});


let LAST_AUTOLAUNCHED_ICAO = null;

let LAST_AUTOLAUNCHED_RAW = null;

// storage.onChanged for lb_pageKey is handled by the outer listener at top of file
// (handleNewPageKey covers ICAO sync, textarea update, and autolaunch)

async function runInitialAutomation() {
  const { lb_pageKey, lbx_settings } =
  await chrome.storage.local.get(["lb_pageKey", "lbx_settings"]);

if (!lb_pageKey) return;

LAST_AUTOLAUNCHED_RAW = lb_pageKey;

const airport = extractICAOFromKey(lb_pageKey);
  if (!/^[A-Z]{4}$/.test(airport)) return;

  const input = document.getElementById("airportInput");
  if (input) {
    input.value = airport;
    const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  maybeQueryNearby(airport);
}
  }

  chrome.runtime.sendMessage({
    type: "RUN_AUTOLAUNCH",
    rawText: lb_pageKey,
    settings: lbx_settings || {}
  });
}

runInitialAutomation().catch(err => {
  console.error("Initial automation failed:", err);
});


chrome.runtime.sendMessage(
    { type: "GET_LAST_AIRPORT" },
    (res) => {

      if (!res?.ok || !res.airport) return;

      const input = document.getElementById("airportInput");
      if (!input) return;

      input.value = res.airport;

      // 🔥 trigger search automatically
     if (res.airport !== LAST_LOADED_AIRPORT) {
  maybeQueryNearby(res.airport);
}
    }
  );



  /* =============================
     LBX FUNCTIONAL WIRING
  ============================== */

  const lbxKeyEl = document.getElementById("lbxKey");


if (lbxKeyEl) {

  // Resize on typing
  lbxKeyEl.addEventListener("input", () => {
  autoResizeTextarea(lbxKeyEl);

  chrome.storage.local.set({
    lb_manualKey: lbxKeyEl.value.trim()
  });
});

  // Resize once on load (after value restored)
  setTimeout(() => autoResizeTextarea(lbxKeyEl), 0);
}

  const openBtn = document.getElementById("lbxOpenNow");

  const optAdsb = document.getElementById("opt_adsb");
  const optOpenNav = document.getElementById("opt_opennav");
  const optAirNav = document.getElementById("opt_airnav");
  const optSkyVector = document.getElementById("opt_skyvector");

  const speedSlider = document.getElementById("adsbSpeed");
  const speedText = document.getElementById("adsbSpeedText");


  /* ---------- Restore Settings ---------- */

  chrome.storage.local.get(
  ["lb_pageKey", "lb_manualKey", "lbx_settings"],
  (data) => {

    const displayKey = data.lb_pageKey || data.lb_manualKey || "";
    

    if (lbxKeyEl) {
      lbxKeyEl.value = displayKey;
      autoResizeTextarea(lbxKeyEl);
    }

    if (data.lbx_settings) {
      const settings = data.lbx_settings;
      if (optAdsb) optAdsb.checked = !!settings.adsb;
      if (optOpenNav) optOpenNav.checked = !!settings.opennav;
      if (optAirNav) optAirNav.checked = !!settings.airnav;
      if (optFixesFinder) optFixesFinder.checked = !!settings.fixesfinder;
      if (optForeflight) optForeflight.checked = !!settings.foreflight;
      if (optSkyVector) optSkyVector.checked = !!settings.skyvector;
      if (speedSlider && settings.adsbSpeed != null) speedSlider.value = settings.adsbSpeed;
      if (speedText && settings.adsbSpeed != null) speedText.value = settings.adsbSpeed;
    }
  }
);





async function preloadProcedureMaps(origin, dest){

  async function loadProcedures(airport, type){

    if(!airport) return;

    const resp = await chrome.runtime.sendMessage({
      type:"GET_PROCS_FOR_AIRPORT",
      airport,
      procType:type
    });

    for(const p of resp?.procs || []){

      const fixesResp = await chrome.runtime.sendMessage({
        type:"GET_PROC_FIXES",
        procType:type,
        procName:p.name,
        procCode:p.code
      });

      for(const fx of fixesResp?.fixes || []){

        const key = fx.toUpperCase();

        if(!FIX_PROCEDURE_MAP[key]){
          FIX_PROCEDURE_MAP[key] = [];
        }

        FIX_PROCEDURE_MAP[key].push({
          type:type === "DP" ? "SID" : "STAR",
          proc:p.code,
          procDisplay:p.displayName || p.code.split(".")[1]
        });

      }

    }

  }

  /* SID */
  await loadProcedures(origin,"DP");

  /* STAR */
  await loadProcedures(dest,"STAR");


  /* IAP (approaches) */
  if(dest){

    const airportData = MASTER_RESULTS
      ?.find(a => a.ident === dest);

    const approaches = airportData?.approaches || [];

    for(const ap of approaches){

      const resp = await chrome.runtime.sendMessage({
        type:"GET_IAP_FIXES",
        airportIdent:dest,
        approachName:ap
      });

      for(const fx of resp?.fixes || []){

        const key = fx.toUpperCase();

        if(!FIX_PROCEDURE_MAP[key]){
          FIX_PROCEDURE_MAP[key] = [];
        }

        FIX_PROCEDURE_MAP[key].push({
          type:"IAP",
          proc:ap,
          procDisplay:ap
        });

      }

    }

  }

}



  /* ---------- Persist Settings ---------- */
const optForeflight = document.getElementById("opt_foreflight");
const optFixesFinder = document.getElementById("opt_fixesfinder");
  function saveLBXSettings() {
    chrome.storage.local.set({
      lbx_settings: {
        adsb: optAdsb?.checked,
        opennav: optOpenNav?.checked,
        airnav: optAirNav?.checked,
        fixesfinder: optFixesFinder?.checked,
        adsbSpeed: Number(speedSlider?.value ?? 500),
        foreflight: optForeflight?.checked,
        skyvector: optSkyVector?.checked,
      }
    });
  }

  optAdsb?.addEventListener("change", saveLBXSettings);
  optOpenNav?.addEventListener("change", saveLBXSettings);
  optAirNav?.addEventListener("change", saveLBXSettings);
  optFixesFinder?.addEventListener("change", saveLBXSettings);
  optForeflight?.addEventListener("change", saveLBXSettings);
  optSkyVector?.addEventListener("change", saveLBXSettings);

  /* ---------- Slider Sync ---------- */

  if (speedSlider && speedText) {

    speedSlider.addEventListener("input", () => {
      speedText.value = speedSlider.value;
      saveLBXSettings();
    });

    speedText.addEventListener("input", () => {
      const v = Number(speedText.value ?? 1);
      if (!isNaN(v)) {
        speedSlider.value = v;
        saveLBXSettings();
      }
    });
  }

  /* ---------- Open Selected Now ---------- */

openBtn?.addEventListener("click", async () => {
  const rawText = lbxKeyEl?.value?.trim();
  if (!rawText) return;

  const settings = {
    adsb: optAdsb?.checked ?? true,
    opennav: optOpenNav?.checked ?? false,
    airnav: optAirNav?.checked ?? false,
    foreflight: optForeflight?.checked ?? false,
    fixesfinder: optFixesFinder?.checked ?? false,
    skyvector: optSkyVector?.checked ?? false,
    adsbSpeed: Number(speedSlider?.value || 500),
  };

  chrome.runtime.sendMessage({ type: "RUN_AUTOLAUNCH", rawText, settings });
});


document.getElementById("refreshKeyBtn")?.addEventListener("click", async () => {

  const status = document.getElementById("refreshStatus");
  status.textContent = "Syncing...";

  let rawKey = null;

  // 1️⃣ Try grabbing fresh key from active tab
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (tab?.id) {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "MANUAL_GRAB_GLOBAL_KEY"
      });

      if (res?.ok && res.key) {
        rawKey = res.key;
        await chrome.storage.local.set({ lb_pageKey: rawKey });
        // 🔥 Manually run the same logic as storage listener
handleNewPageKey(rawKey);
      }
    }
  } catch (err) {
    // ignore and fallback
  }

  // 2️⃣ Fallback to saved key
  if (!rawKey) {
    const data = await chrome.storage.local.get("lb_pageKey");
rawKey = data.lb_pageKey;
  }

  if (!rawKey) {
    status.textContent = "Global key not found.";
    setTimeout(() => status.textContent = "", 2000);
    return;
  }

  // 🔥 Extract ICAO
  const icao = extractICAOFromKey(rawKey);

  if (!/^[A-Z]{4}$/.test(icao)) {
    status.textContent = "Invalid ICAO.";
    setTimeout(() => status.textContent = "", 2000);
    return;
  }

  // 🔥 Replace airport input
  const input = document.getElementById("airportInput");
  if (input) input.value = icao;

  // 🔥 Force search
  const { lbx_settings } =
  await chrome.storage.local.get(["lbx_settings"]);

const autoRefresh =
  lbx_settings?.autorefresh ?? true;

if (autoRefresh) {
  maybeQueryNearby(icao);
}

  status.textContent = "Synced ✓";
  setTimeout(() => status.textContent = "", 2000);
});

document.getElementById("pasteKeyBtn")?.addEventListener("click", () => {

  const status = document.getElementById("refreshStatus");

  try {
    const textarea = document.createElement("textarea");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";

    document.body.appendChild(textarea);
    textarea.focus();

    const success = document.execCommand("paste");

    if (!success) {
      status.textContent = "Clipboard blocked.";
      document.body.removeChild(textarea);
      return;
    }

    const rawKey = textarea.value.trim();
    document.body.removeChild(textarea);

    if (!rawKey) {
      status.textContent = "Clipboard empty.";
      return;
    }

    chrome.storage.local.set({ lb_manualKey: rawKey });

    const lbxKeyEl = document.getElementById("lbxKey");
    if (lbxKeyEl) lbxKeyEl.value = rawKey;

    const icao = extractICAOFromKey(rawKey);

    const airportInput = document.getElementById("airportInput");
    if (airportInput && /^[A-Z]{4}$/.test(icao)) {
      airportInput.value = icao;
      queryNearby();
    }

    status.textContent = "Pasted ✓";

  } catch (err) {
    status.textContent = "Clipboard blocked.";
  }

});





chrome.storage.local.get("adsb_active_flight_callsign", (data) => {
  window.activeFlightCallsign = data.adsb_active_flight_callsign || null;
});

document.getElementById("adsbClearFlight")?.addEventListener("click", async () => {
  document.getElementById("routeResults").innerHTML =
    "<div class='routeFix'>No active flight</div>";

  const analysis = document.getElementById("routeAnalysis");
  if (analysis) analysis.innerHTML = "";

  renderFlightFreqs(null);
  renderFlightAirports(null, "");

  window.activeFlightCallsign = null;
  window.activeFlightOrigin = null;
  window.activeFlightDest = null;

  await chrome.runtime.sendMessage({ type: "CLEAR_ACTIVE_FLIGHT" });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;

  if (
    changes.adsb_active_flight_fixes ||
    changes.adsb_active_flight_callsign ||
    changes.adsb_active_flight_origin ||
    changes.adsb_active_flight_destination ||
    changes.adsb_active_flight_vfr_waypoints
  ) {
    refreshActiveFlightPanel().catch(err => {
      console.error("Active flight panel refresh failed:", err);
    });
  }
});


const flightSearch = document.getElementById("flightFixSearch");
const routeBody = document.querySelector(".routeBody");
let routePanelMode = "fixes"; // "fixes" | "freqs"
let freqSearchTimer = null;

function setRoutePanelMode(mode) {
  routePanelMode = mode;
  if (!routeBody) return;
  routeBody.classList.toggle("fixes-mode", mode === "fixes");
  routeBody.classList.toggle("freqs-mode", mode === "freqs");
  routeBody.classList.toggle("airports-mode", mode === "airports");
  routeBody.classList.toggle("vfr-mode", mode === "vfr");
  document.getElementById("routeModeFixes")?.classList.toggle("active", mode === "fixes");
  document.getElementById("routeModeFreqs")?.classList.toggle("active", mode === "freqs");
  document.getElementById("routeModeAirports")?.classList.toggle("active", mode === "airports");
  document.getElementById("routeModeVfr")?.classList.toggle("active", mode === "vfr");
  if (flightSearch) {
    flightSearch.placeholder = mode === "fixes" ? "Search fixes..." : mode === "freqs" ? "Filter by airport or freq name..." : mode === "airports" ? "Search airports..." : "Search VFR waypoints...";
    flightSearch.value = "";
  }
  if (mode === "freqs") {
    chrome.storage.local.get("adsb_active_flight_freqs").then(d => {
      renderFlightFreqs(d.adsb_active_flight_freqs || null);
    });
  }
  if (mode === "airports") {
    chrome.storage.local.get("adsb_active_flight_freqs").then(d => {
      renderFlightAirports(d.adsb_active_flight_freqs || null, "");
    });
  }
  if (mode === "vfr") {
    chrome.storage.local.get("adsb_active_flight_vfr_waypoints").then(d => {
      renderVfrWaypoints(d.adsb_active_flight_vfr_waypoints || []);
    });
  }
}

document.getElementById("routeModeFixes")?.addEventListener("click", () => setRoutePanelMode("fixes"));
document.getElementById("routeModeFreqs")?.addEventListener("click", () => setRoutePanelMode("freqs"));
document.getElementById("routeModeAirports")?.addEventListener("click", () => setRoutePanelMode("airports"));
document.getElementById("routeModeVfr")?.addEventListener("click", () => setRoutePanelMode("vfr"));

flightSearch?.addEventListener("input", async () => {
  const q = flightSearch.value.trim().toUpperCase();

  if (routePanelMode === "vfr") {
    const d = await chrome.storage.local.get("adsb_active_flight_vfr_waypoints");
    let wps = d.adsb_active_flight_vfr_waypoints || [];
    if (q) {
      wps = wps.filter(wp =>
        wp.code.includes(q) ||
        (wp.name || "").toUpperCase().includes(q) ||
        (wp.state || "").toUpperCase().includes(q)
      );
    }
    renderVfrWaypoints(wps);
    return;
  }

  if (routePanelMode === "airports") {
    chrome.storage.local.get("adsb_active_flight_freqs").then(d => {
      renderFlightAirports(d.adsb_active_flight_freqs || null, q);
    });
    return;
  }

  if (routePanelMode === "freqs") {
    clearTimeout(freqSearchTimer);
    if (!q || q.length < 1) {
      chrome.storage.local.get("adsb_active_flight_freqs").then(d => {
        renderFlightFreqs(d.adsb_active_flight_freqs || null);
      });
      return;
    }
    freqSearchTimer = setTimeout(async () => {
      const d = await chrome.storage.local.get("adsb_active_flight_freqs");
      const freqs = d.adsb_active_flight_freqs;
      if (!freqs) return;
      // Build filtered version: keep airports whose ident/name/any freq name matches
      function freqMatchesQuery(f) {
        const name = String(f.name || "").toUpperCase();
        const type = String(f.type || "").toUpperCase();
        const mhz = String(f.freq || "");
        if (type.includes(q) || name.includes(q) || mhz.includes(q)) return true;
        if (soundScore(name, q) > 40 || soundScore(type, q) > 60) return true;
        return false;
      }
      function airportMatchesQuery(ident, name) {
        const id = String(ident || "").toUpperCase();
        const nm = String(name || "").toUpperCase();
        return id.includes(q) || nm.includes(q) || soundScore(nm, q) > 40 || soundScore(id, q) > 60;
      }
      function filterSection(sec) {
        if (!sec) return null;
        const aptMatch = airportMatchesQuery(sec.ident, sec.name);
        const filteredFreqs = aptMatch ? sec.freqs : sec.freqs.filter(freqMatchesQuery);
        if (!filteredFreqs.length) return null;
        return { ...sec, freqs: filteredFreqs };
      }
      const filtered = {
        origin: filterSection(freqs.origin),
        destination: filterSection(freqs.destination),
        enroute: (freqs.enroute || []).map(filterSection).filter(Boolean)
      };
      renderFlightFreqs(filtered);
    }, 160);
    return;
  }

  const data = await chrome.storage.local.get("adsb_active_flight_fixes");

  let fixes = data.adsb_active_flight_fixes || [];

  if (q) {
    fixes = fixes
      .map(f => {
        const fix = String(f || "").toUpperCase();
        const nav = NAVAIDS?.[fix];

        let score = soundScore(fix, q);

        if (nav?.name) {
          const nameUpper = nav.name.toUpperCase();

          if (nameUpper.startsWith(q)) score = Math.max(score, 150);
          if (nameUpper.includes(q)) score = Math.max(score, 120);

          score = Math.max(
            score,
            soundScore(nameUpper.replace(/[^A-Z]/g, ""), q)
          );
        }

        return { fix, score };
      })
      .filter(r => r.score > 10)
      .sort((a, b) => b.score - a.score)
      .map(r => r.fix);
  }

  applyActiveFlightFixesToUI(fixes);
});

function adaptAirportsForSearchJs() {
  if (!Array.isArray(window.AIRPORTS)) {
    console.warn("AIRPORTS missing before search.js init");
    return;
  }

  window.AIRPORTS = window.AIRPORTS.map(a => ({
    ...a,

    // search.js expected fields
    id: a.id || a.ident || a.icao || a.iata || "",
    n: a.n || a.name || "",
    city: a.city || a.municipality || "",
    st: a.st || a.region || "",
    icao: a.icao || a.ident || "",
    iata: a.iata || "",
    lc: a.lc || a.local_code || a.ident || "",
    lat: a.lat ?? a.latitude_deg ?? a.latitude,
    lon: a.lon ?? a.longitude_deg ?? a.longitude,
    t: a.t || a.type || "",
    sched: a.sched || a.scheduled_service || "0",
    kw: a.kw || `${a.ident || ""} ${a.name || ""} ${a.municipality || ""} ${a.region || ""}`
  }));

  console.log("Adapted AIRPORTS for search.js:", window.AIRPORTS.length);
}

adaptAirportsForSearchJs();

if (typeof initAirportSearch === "function") {
  initAirportSearch();
}

// Airport Lookup US / Global toggle
(function initAptRegionToggle() {
  const btnUS = document.getElementById("aptRegionUS");
  const btnGlobal = document.getElementById("aptRegionGlobal");
  const globalBox = document.getElementById("globalAptResults");
  const usHeader = document.getElementById("aptUSHeader");
  const guessLabel = document.getElementById("aptGuessLabel");
  const contextRow = document.querySelector(".airportLookupContextRow");
  const contextBlock = document.getElementById("airportContextBlock");
  const filterEl = document.getElementById("airportSearchFilters");
  const suggEl = document.getElementById("airportSuggestions");
  const resultsEl = document.getElementById("airportSearchResults");
  const queryInput = document.getElementById("airportSearchQuery");
  const contextInput = document.getElementById("airportSearchContext");
  const helperText = document.getElementById("airportSearchHelperText");

  if (!btnUS || !btnGlobal) return;

  let aptRegion = "US";
  let globalAptTimer = null;

  function setAptRegion(region) {
    aptRegion = region;
    btnUS.classList.toggle("active", region === "US");
    btnGlobal.classList.toggle("active", region === "global");

    const showUS = region === "US";
    if (usHeader) usHeader.style.display = showUS ? "" : "none";
    if (guessLabel) guessLabel.textContent = showUS ? "AIRPORT GUESS" : "SEARCH";
    if (contextRow) contextRow.style.display = "";
    if (contextBlock) contextBlock.style.display = "";
    if (helperText) helperText.style.display = showUS ? "" : "none";
    if (filterEl) filterEl.style.display = showUS ? "" : "none";
    if (suggEl) suggEl.style.display = showUS ? "" : "none";
    if (resultsEl) resultsEl.style.display = showUS ? "" : "none";
    if (globalBox) globalBox.style.display = showUS ? "none" : "";

    if (queryInput) queryInput.placeholder = showUS
      ? "Type what you heard, e.g. 'dulles' or 'LAX'"
      : "Airport name or ICAO...";
    if (contextInput && !showUS) contextInput.placeholder =
      "Add context clues: nearby NAVAIDs, waypoints, city, frequencies...";

    if (!showUS) runGlobalAptSearch();
  }

  function extractContextIdents(text) {
    // Pull 2-5 char uppercase-looking tokens that could be idents/waypoints
    const tokens = String(text || "").toUpperCase().match(/\b[A-Z]{2,5}\b/g) || [];
    const stop = new Set(["AND","THE","FOR","ARE","YOU","HAS","HAD","BUT","NOT","THIS","THAT","WITH","FROM","THEY","HAVE","WILL","ALSO","BEEN","BEEN","WHEN","WHAT","SAID","EACH","THAN","THEN","THEM","SOME","MORE","VERY","JUST","OVER","KNOW","TAKE","INTO","YEAR","YOUR","GOOD","MOST","MUCH","BEFORE","AFTER","ABOUT","LIKE","BEEN","CALL","ONLY","COME","ITS","NOW","HOW","DID","GET","HIM","HIS","ALL","OUT","WAY","TWO","USE","HER","WHO","OIL","SIT","SET","PUT","FAR","LET","LOT","AGO","CAN","MAY","CAR","SKY","ALT","HDG","SPD","FLT","ATC","CTR","TWR","APP","DEP","GND","DEL","ATIS"]);
    return [...new Set(tokens.filter(t => t.length >= 2 && !stop.has(t)))].slice(0, 8);
  }

  async function runGlobalAptSearch() {
    if (!globalBox) return;
    const q = queryInput?.value.trim() || "";
    const contextRaw = contextInput?.value || "";
    const contextIdents = extractContextIdents(contextRaw);

    if (!q || q.length < 2) {
      globalBox.innerHTML = `<div class="routeFix" style="color:#4b5563;font-size:11px">Type to search global airports...</div>`;
      return;
    }

    // Run main query + any context ident queries in parallel
    const queries = [q, ...contextIdents.filter(id => id !== q)].slice(0, 5);
    const allRespArr = await Promise.all(
      queries.map(qr => chrome.runtime.sendMessage({ type: "SEARCH_AIRPORTS_GLOBAL", query: qr }))
    );

    // Merge, deduplicate, and sort (main query matches first)
    const seen = new Set();
    const merged = [];
    // First pass: main query results
    for (const a of (allRespArr[0]?.results || [])) {
      if (!seen.has(a.ident)) { seen.add(a.ident); merged.push({ ...a, _primary: true }); }
    }
    // Second pass: context results
    for (let i = 1; i < allRespArr.length; i++) {
      for (const a of (allRespArr[i]?.results || [])) {
        if (!seen.has(a.ident)) { seen.add(a.ident); merged.push(a); }
      }
    }

    if (!merged.length) {
      globalBox.innerHTML = `<div class="routeFix" style="color:#4b5563;font-size:11px">No airports found</div>`;
      return;
    }

    globalBox.innerHTML = "";
    for (const a of merged.slice(0, 40)) {
      const card = document.createElement("div");
      card.className = "routeAirportCard";
      const meta = [a.municipality, a.country].filter(Boolean).join(", ");
      const chips = (a.freqs || []).slice(0, 6).map(f => {
        const mhz = typeof f.freq === "number" ? f.freq.toFixed(3) : f.freq;
        return `<span class="freqChip">${f.type || ""} ${mhz}</span>`;
      }).join("");
      const metaHtml = meta ? `<span class="routeAirportName" style="color:#64748b;font-size:10px;margin-left:4px">${meta}</span>` : "";
      card.innerHTML =
        `<span class="routeAirportIdent">${a.ident}</span><span class="routeAirportName">${a.name || ""}</span>${metaHtml}` +
        (chips ? `<div class="freqChips" style="margin-top:3px">${chips}</div>` : "");
      globalBox.appendChild(card);
    }
  }

  btnUS.addEventListener("click", () => setAptRegion("US"));
  btnGlobal.addEventListener("click", () => setAptRegion("global"));

  queryInput?.addEventListener("input", () => {
    if (aptRegion !== "global") return;
    clearTimeout(globalAptTimer);
    globalAptTimer = setTimeout(runGlobalAptSearch, 220);
  });

  contextInput?.addEventListener("input", () => {
    if (aptRegion !== "global") return;
    clearTimeout(globalAptTimer);
    globalAptTimer = setTimeout(runGlobalAptSearch, 350);
  });

  if (globalBox) globalBox.style.display = "none";
})();

try {
  await refreshActiveFlightPanel();
} catch (err) {
  console.error("Active flight panel failed:", err);
}

})();


// Re-render when filter toggled
document.getElementById("filterNoApproaches")
  ?.addEventListener("change", () => {
    renderResults(MASTER_RESULTS, LAST_CENTER);
  });

// Waypoint fuzzy search in main results
(function initWaypointSearch() {
  const input = document.getElementById("waypointSearch");
  const clearBtn = document.getElementById("waypointClearBtn");
  const toggle = document.getElementById("procGlobalToggle");

  if (!input) return;

  function runSearch() {
    const q = input.value.trim();
    if (clearBtn) clearBtn.style.display = q ? "" : "none";
    if (!q) {
      renderResults(MASTER_RESULTS, LAST_CENTER);
      return;
    }
    const token = ++WAYPOINT_SEARCH_TOKEN;
    searchWaypoints(q, token);
  }

  let debounce = null;
  input.addEventListener("input", (e) => {
    e.stopPropagation();
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 200);
  });
  input.addEventListener("keydown", (e) => e.stopPropagation());

  clearBtn?.addEventListener("click", () => {
    input.value = "";
    if (clearBtn) clearBtn.style.display = "none";
    renderResults(MASTER_RESULTS, LAST_CENTER);
  });

  toggle?.addEventListener("change", () => {
    if (input.value.trim()) runSearch();
  });
})();



function dedupeFixes(fixes){

  const out = [];

  for(const fx of fixes){

    if(out.length === 0 || out[out.length-1] !== fx){
      out.push(fx);
    }

  }

  return out;
}

function renderFlightAirports(freqs, query) {
  const box = document.getElementById("routeAirports");
  if (!box) return;
  box.innerHTML = "";
  if (!freqs) return;

  const q = String(query || "").toUpperCase().trim();

  const all = [];
  if (freqs.origin) all.push({ ...freqs.origin, role: "ORIG" });
  for (const e of (freqs.enroute || [])) all.push({ ...e, role: null });
  if (freqs.destination) all.push({ ...freqs.destination, role: "DEST" });

  const filtered = q
    ? all.filter(a => {
        const id = String(a.ident || "").toUpperCase();
        const nm = String(a.name || "").toUpperCase();
        return id.includes(q) || nm.includes(q) || soundScore(id, q) > 60 || soundScore(nm, q) > 40;
      })
    : all;

  if (!filtered.length) {
    box.innerHTML = `<div class="routeFix" style="color:#4b5563">No airports</div>`;
    return;
  }

  for (const a of filtered) {
    const card = document.createElement("div");
    card.className = "routeAirportCard";
    const roleHtml = a.role ? `<span class="routeAirportRole">${a.role}</span>` : "";
    card.innerHTML = `<span class="routeAirportIdent" style="cursor:pointer;text-decoration:underline dotted" title="Load in ICAO search">${a.ident}</span><span class="routeAirportName">${a.name || ""}</span>${roleHtml}`;

    const identEl = card.querySelector(".routeAirportIdent");
    identEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      const input = document.getElementById("airportInput");
      if (input) {
        input.value = String(a.ident || "").toUpperCase();
        queryNearby(true);
        const airportSearchPanel = document.getElementById("airportSearchPanel");
        const overlayRoot = document.getElementById("overlayRoot");
        if (overlayRoot && airportSearchPanel) {
          overlayRoot.classList.add("airportsearch-open");
        }
      }
    });

    box.appendChild(card);
  }
}

function renderFlightFreqs(freqs) {
  const box = document.getElementById("routeFreqs");
  if (!box) return;
  box.innerHTML = "";
  if (!freqs) return;

  const sections = [];
  if (freqs.origin?.freqs?.length) sections.push({ label: freqs.origin.ident + " (Origin)", facilityName: freqs.origin.depFacilityName || null, items: freqs.origin.freqs });
  if (freqs.destination?.freqs?.length) sections.push({ label: freqs.destination.ident + " (Dest)", facilityName: freqs.destination.appFacilityName || null, items: freqs.destination.freqs });
  for (const e of (freqs.enroute || [])) {
    if (e.freqs?.length) sections.push({ label: e.ident, facilityName: e.facilityName || null, items: e.freqs });
  }
  if (!sections.length) return;

  const wrapper = document.createElement("div");
  wrapper.className = "freqPanel";

  for (const sec of sections) {
    const header = document.createElement("div");
    header.className = "freqSectionHeader";
    header.textContent = sec.label;
    wrapper.appendChild(header);

    if (sec.facilityName) {
      const sub = document.createElement("div");
      sub.className = "freqFacilityName";
      sub.textContent = sec.facilityName;
      wrapper.appendChild(sub);
    }

    for (const f of sec.items) {
      const row = document.createElement("div");
      row.className = "freqRow";
      const mhz = typeof f.freq === "number" ? f.freq.toFixed(3) : f.freq;
      row.innerHTML = `<span class="freqType">${f.type || ""}</span><span class="freqMhz">${mhz}</span><span class="freqName">${f.name || ""}</span>`;
      wrapper.appendChild(row);
    }
  }

  box.appendChild(wrapper);
}

function renderFlightAnalysis(route, fixes, origin, dest, procedures){

  const container = document.getElementById("routeAnalysis");
  if(!container) return;

  container.innerHTML = "";

  const analysis = document.createElement("div");
  analysis.className = "analysisBox";

const callsign =
  window.activeFlightCallsign ||
  "Unknown";

  function isAirport(code){
  return /^[A-Z]{4}$/.test(code);
}

const originCode =
  isAirport(origin?.ident)
    ? origin.ident
    : isAirport(origin)
    ? origin
    : window.activeFlightOrigin || "?";

const destCode =
  isAirport(dest?.ident)
    ? dest.ident
    : isAirport(dest)
    ? dest
    : window.activeFlightDest || "?";

/* Flight */
const od = document.createElement("div");
od.className = "analysisBlock";

const originName = origin?.name || originCode;
const destName   = dest?.name   || destCode;

od.innerHTML = `
  <div class="analysisHeader">Flight</div>

  <div class="flightCallsign">
    ✈ ${callsign}
  </div>

  <div class="flightRoute">

    <div class="flightAirport">
      ${originName} <span class="airportCode">(${originCode})</span>
    </div>

    <div class="flightArrow">↓</div>

    <div class="flightAirport">
      ${destName} <span class="airportCode">(${destCode})</span>
    </div>

  </div>
`;

analysis.appendChild(od);

  /* Procedures */
  if(procedures?.sid || procedures?.star){

    const procBlock = document.createElement("div");
    procBlock.className = "analysisBlock";

    procBlock.innerHTML = `
      <div class="analysisHeader">Procedures</div>
      <div>SID: ${procedures.sid || "-"}</div>
      <div>STAR: ${procedures.star || "-"}</div>
    `;

    analysis.appendChild(procBlock);
  }

  if(origin?.name && dest?.name){

  const routeHeader = document.getElementById("flightRouteHeader");

  if(routeHeader){

    routeHeader.innerHTML = `
      ${origin.ident} → ${dest.ident}
      <div class="routeSub">
        ${origin.name} → ${dest.name}
      </div>
    `;

  }

}

  container.appendChild(analysis);
}


function extractCurrentLeg(track){

  if(!track?.length) return track;

  let takeoff = 0;
  let landing = track.length - 1;

  // detect last takeoff
  for(let i=1;i<track.length;i++){

    const prev = track[i-1];
    const cur  = track[i];

    if(
      prev.alt < 800 &&
      prev.gs < 40 &&
      cur.alt > 2000 &&
      cur.gs > 120
    ){
      takeoff = i;
    }

  }

  // detect landing
  for(let i=takeoff;i<track.length;i++){

    const p = track[i];

    if(
      p.alt < 800 &&
      p.gs < 40 &&
      i > takeoff + 200
    ){
      landing = i;
      break;
    }

  }

  return track.slice(takeoff, landing);
}



function formatCoord(n) {
  return Number.isFinite(n) ? n.toFixed(4) : "";
}

function renderGlobalResults(results) {
  const box = document.getElementById("globalResults");
  if (!box) return;

  if (!results || !results.length) {
    box.innerHTML = `<div class="mutedResult">No global waypoint/navaid matches</div>`;
    return;
  }

  box.innerHTML = results.map(r => {
    const title = r.name && r.name !== r.ident
      ? `${escapeHtmlLocal(r.ident)} — ${escapeHtmlLocal(r.name)}`
      : escapeHtmlLocal(r.ident);

    const meta1 = [
      r.kind === "waypoint" ? "Waypoint" : "Navaid",
      r.subtype || "",
      r.country || ""
    ].filter(Boolean).join(" · ");

    const meta2 = [
      r.airport ? `Airport ${escapeHtmlLocal(r.airport)}` : "",
      `${formatCoord(r.lat)}, ${formatCoord(r.lon)}`
    ].filter(Boolean).join(" · ");

    return `
      <div class="globalResultCard">
        <div class="globalResultTitle">${title}</div>
        <div class="globalResultMeta">${escapeHtmlLocal(meta1)}</div>
        <div class="globalResultMeta">${escapeHtmlLocal(meta2)}</div>
      </div>
    `;
  }).join("");
}

function escapeHtmlLocal(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}


async function runGlobalSearch(query, opts = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "SEARCH_GLOBAL_POINTS",
      query,
      limit: opts.limit || 20,
      countryBias: opts.countryBias || "",
      airportBias: opts.airportBias || ""
    }, (res) => {
      if (chrome.runtime.lastError) {
        console.error("Global search error:", chrome.runtime.lastError.message);
        resolve([]);
        return;
      }

      if (!res?.ok) {
        console.error("Global search failed:", res?.error);
        resolve([]);
        return;
      }

      resolve(res.results || []);
    });
  });
}

async function getGlobalCountries() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_GLOBAL_COUNTRIES" },
      (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          console.error("GET_GLOBAL_COUNTRIES failed:", chrome.runtime.lastError?.message || res?.error);
          resolve([]);
          return;
        }
        resolve(res.countries || []);
      }
    );
  });
}

async function populateGlobalCountryFilter() {
  const sel = document.getElementById("globalCountryFilter");
  if (!sel) return;

  const countries = await getGlobalCountries();

  sel.innerHTML = `<option value="">Any</option>` + countries.map(c => {
    const label = c.name && c.name !== c.code ? `${c.code} — ${c.name}` : c.code;
    return `<option value="${escapeHtmlLocal(c.code)}">${escapeHtmlLocal(label)}</option>`;
  }).join("");
}


let GLOBAL_WAYPOINT_INDEX = null;
let GLOBAL_NAVAID_INDEX = null;

function dmsToDecimal(s) {
  s = String(s || "").trim();
  const m = s.match(/(\d+)°\s*(\d+)'\s*([\d.]+)"\s*([NSEW])/i);
  if (!m) return Number(s);

  let v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
  if (/[SW]/i.test(m[4])) v *= -1;
  return v;
}

function distNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadGlobalContextClues() {
  if (GLOBAL_WAYPOINT_INDEX && GLOBAL_NAVAID_INDEX) return;

  GLOBAL_WAYPOINT_INDEX = {};
  GLOBAL_NAVAID_INDEX = {};

  const [wpText, navText] = await Promise.all([
    fetch(chrome.runtime.getURL("waypoints.csv")).then(r => r.text()),
    fetch(chrome.runtime.getURL("navaids.csv")).then(r => r.text())
  ]);

  for (const r of parseCSV(wpText)) {
    const ident = String(r["Ident"] || "").toUpperCase();
    if (!ident) continue;

    GLOBAL_WAYPOINT_INDEX[ident] = {
      ident,
      country: r["Country Code"],
      lat: dmsToDecimal(r["Latitude"]),
      lon: dmsToDecimal(r["Longitude"])
    };
  }

  for (const r of parseCSV(navText)) {
    const ident = String(r["ident"] || "").toUpperCase();
    if (!ident) continue;

    GLOBAL_NAVAID_INDEX[ident] = {
      ident,
      name: r["name"],
      type: r["type"],
      country: r["country code"],
      airport: String(r["airport"] || "").toUpperCase(),
      lat: Number(r["latitude"]),
      lon: Number(r["longitude"])
    };
  }

  console.log(
    "Global context clues loaded:",
    Object.keys(GLOBAL_WAYPOINT_INDEX).length,
    "waypoints,",
    Object.keys(GLOBAL_NAVAID_INDEX).length,
    "navaids"
  );
}

function extractContextFixes(ctx) {
  const words = String(ctx || "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(w => w.length >= 2 && w.length <= 5);

  const hits = [];

  for (const w of words) {
    if (GLOBAL_NAVAID_INDEX?.[w]) {
      hits.push({ type: "navaid", ...GLOBAL_NAVAID_INDEX[w] });
    }

    if (GLOBAL_WAYPOINT_INDEX?.[w]) {
      hits.push({ type: "waypoint", ...GLOBAL_WAYPOINT_INDEX[w] });
    }
  }

  return hits;
}

function saveUIState() {
  chrome.storage.local.set({
    sandcat_ui_state: {
      hideNoApp: document.getElementById("filterNoApproaches")?.checked,
      mainOnly: document.getElementById("mainOnlyToggle")?.checked,
      typesMode: document.getElementById("types")?.value,
      radius: document.getElementById("radiusNm")?.value,
      maxResults: document.getElementById("maxResults")?.value
    }
  });
}

// ===== UPDATE DATA BUTTON =====
document.getElementById("updateDataBtn")?.addEventListener("click", () => {
  const btn = document.getElementById("updateDataBtn");
  const statusEl = document.getElementById("updateDataStatus");
  btn.disabled = true;
  statusEl.textContent = "Connecting…";
  chrome.runtime.sendMessage({ type: "UPDATE_DATA_FILES" });
});

chrome.runtime.onMessage.addListener((msg) => {
  const btn = document.getElementById("updateDataBtn");
  const statusEl = document.getElementById("updateDataStatus");
  if (!statusEl) return;

  if (msg.type === "DATA_UPDATE_PROGRESS") {
    statusEl.textContent = msg.message;
  } else if (msg.type === "DATA_UPDATE_DONE") {
    const n = msg.results.updated.length;
    const f = msg.results.failed.length;
    statusEl.textContent = f === 0 ? `✓ ${n} files updated` : `${n} updated, ${f} failed`;
    if (btn) btn.disabled = false;
  } else if (msg.type === "DATA_UPDATE_ERROR") {
    statusEl.textContent = `Error: ${msg.error}`;
    if (btn) btn.disabled = false;
  }
});