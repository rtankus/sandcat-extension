// labelbox_grab_id.js
// Opens the Labelbox "data row details" (info) panel ONCE PER NEW DATA ROW,
// extracts Global Key, stores to chrome.storage.local["lb_rawText"], then goes passive.
//
// Key points:
// - Detects DR changes via URL changes + DOM mutations
// - Opens panel only if "Global Key" label is not visible
// - Won’t repeatedly re-open the panel for the same DR
// - Cooldown to avoid UI fighting/spam
// Only run inside the actual editor frame
// labelbox_grab_id.js

console.log("GRABBER LOADED IN:", location.hostname);

// Only run inside the real editor frame
if (location.hostname !== "editor.labelbox.com") {
  console.log("[LB GK] Not editor frame — exiting.");
} else {

(() => {
  if (window.__lbGKPerDRLoaded) return;
  window.__lbGKPerDRLoaded = true;

  const STORAGE_KEY = "lb_pageKey";

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

// Flexible dashed global-key style:
// AF-AF-HAA-410-Mar-30-2026-1100Z_61_VAD_v2.wav
// KPBI2-Gnd-Twr-Mar-30-2026-1100Z_61_VAD_v2.wav
// LSZH1-Radar-133050-Apr-12-2026-0630Z_14_VAD_v2.wav
// YPJT2-Center-Jan-25-2026-0100Z_25_VAD_v2.wav
// NY-LGA-Dep-Mar-17-2026-1230Z_14_VAD_v2.wav
// NY-App-LGA-Fina12-Feb-03-2026-1800Z_45_VAD_v2.wav
const FLEX_DASHED_KEY_REGEX =
  new RegExp(
    `\\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-(${MONTHS})-\\d{1,2}-\\d{4}-\\d{4}Z_\\d+_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\\.wav\\b`,
    "i"
  );

// Numeric style:
const NEW_KEY_REGEX =
  /\b\d{6}_\d{4}_\d+\.wav\b/i;

// IATA/ICAO compact style: SJC-20260414131831_31_VAD_v2.wav
const IATA_COMPACT_KEY_REGEX =
  /\b[A-Za-z]{2,4}-\d{14}_\d+_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.wav\b/i;

const KEY_REGEX =
  new RegExp(
    `${FLEX_DASHED_KEY_REGEX.source}|${NEW_KEY_REGEX.source}|${IATA_COMPACT_KEY_REGEX.source}`,
    "i"
  );

  const MONTH_NAMES = {
    jan:"January", feb:"February", mar:"March", apr:"April",
    may:"May", jun:"June", jul:"July", aug:"August",
    sep:"September", oct:"October", nov:"November", dec:"December"
  };

  function parseKeyParts(rawKey) {
    const m = rawKey.match(
      /-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{1,2})-(\d{4})-(\d{4}Z)/i
    );
    if (!m) return null;
    return {
      month: MONTH_NAMES[m[1].toLowerCase()] || m[1],
      day: m[2],
      year: m[3],
      time: m[4].toUpperCase()
    };
  }

  const INJECTED_ID = "sc-lb-key-display";

  function findToolbarMiddle() {
    const editBtn = document.querySelector('[data-cy="edit-label-btn"]');
    const detailsBtn = document.querySelector('[data-cy="data-row-details-button"]');
    if (!editBtn || !detailsBtn) return null;
    let el = editBtn.parentElement;
    while (el && el !== document.body) {
      if (el.contains(detailsBtn)) {
        for (const child of el.children) {
          if (!child.contains(editBtn) && !child.contains(detailsBtn)) return child;
        }
        return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  function isSandCatExpanded() {
    const root = document.getElementById("overlayRoot");
    return root && root.style.display !== "none" && root.dataset.collapsed !== "true";
  }

  function injectDisplay(icao, airportName, parts) {
    const middle = findToolbarMiddle();
    if (!middle) return;

    let wrapper = document.getElementById(INJECTED_ID);
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.id = INJECTED_ID;
      wrapper.style.cssText = [
        "display:flex", "flex-direction:row", "align-items:center",
        "gap:10px", "white-space:nowrap", "user-select:none"
      ].join(";");

      // Info block (clickable to open/restore overlay)
      const info = document.createElement("div");
      info.className = "sc-lb-info";
      info.style.cssText = [
        "display:flex", "flex-direction:column", "align-items:center",
        "justify-content:center", "line-height:1.4", "cursor:pointer"
      ].join(";");
      info.addEventListener("click", () => {
        if (!isSandCatExpanded()) {
          chrome.runtime.sendMessage({ type: "OPEN_SANDCAT_OVERLAY" });
        }
      });

      // "Open Selected Now" button
      const btn = document.createElement("button");
      btn.className = "sc-lb-open-btn";
      btn.textContent = "Open Selected Now";
      btn.style.cssText = [
        "font-size:11px", "font-weight:500", "color:#fff",
        "background:rgba(255,255,255,0.1)", "border:1px solid rgba(255,255,255,0.25)",
        "border-radius:6px", "padding:3px 10px", "cursor:pointer",
        "white-space:nowrap", "line-height:1.6",
        "transition:background 0.15s"
      ].join(";");
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "rgba(255,255,255,0.2)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "rgba(255,255,255,0.1)";
      });
      btn.addEventListener("click", async () => {
        const { lb_pageKey, lbx_settings } = await new Promise(resolve =>
          chrome.storage.local.get(["lb_pageKey", "lbx_settings"], resolve)
        );
        if (!lb_pageKey) return;
        chrome.runtime.sendMessage({
          type: "RUN_AUTOLAUNCH",
          rawText: lb_pageKey,
          settings: lbx_settings || {}
        });
      });

      wrapper.appendChild(info);
      wrapper.appendChild(btn);
      middle.appendChild(wrapper);
    }

    const topLine = airportName ? `${icao} · ${airportName}` : (icao || "—");
    const dateLine = parts ? `${parts.month} ${parts.day} ${parts.year} · ${parts.time}` : "";

    const info = wrapper.querySelector(".sc-lb-info");
    if (info) {
      info.innerHTML = `
        <span style="font-size:13px;font-weight:600;color:#fff;">${topLine}</span>
        <span style="font-size:11px;color:#aaa;">${dateLine}</span>
      `;
    }
  }

  function clearDisplay() {
    document.getElementById(INJECTED_ID)?.remove();
  }

  async function updateDisplay(rawKey) {
    if (!rawKey) { clearDisplay(); return; }
    const parts = parseKeyParts(rawKey);
    const firstToken = rawKey.split("-")[0] || "";
    const icao = firstToken.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);

    let airportName = null;
    if (icao.length === 4) {
      try {
        const resp = await new Promise(resolve =>
          chrome.runtime.sendMessage({ type: "GET_AIRPORT_NAME_ICAO", icao }, resolve)
        );
        if (resp?.ok && resp.name) airportName = resp.name;
      } catch { /* background sleeping */ }
    }

    injectDisplay(icao || null, airportName, parts);
  }

  const DEBUG = false; // set true for console logs

  const norm = (s) => (s || "").toString().replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => { if (DEBUG) console.log("[LB GK]", ...args); };

  let lastSeenKey = "";
  let running = false;

  // Track per “data row identity” so we only click once per DR
  let lastDrIdentity = "";
  const openedForDr = new Set();

  // Prevent spam clicks
  let lastClickTs = 0;
  const CLICK_COOLDOWN_MS = 2500;

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function click(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {
      try {
        el.click();
        return true;
      } catch {
        return false;
      }
    }
  }

  function findDetailsButton() {
    // Confirmed selector from you:
    const btn = document.querySelector('button[data-cy="data-row-details-button"]');
    if (btn && isVisible(btn)) return btn;

    // Fallback if Labelbox changes it slightly
    const alt = Array.from(document.querySelectorAll("button[data-cy]"))
      .filter(isVisible)
      .find((b) => (b.getAttribute("data-cy") || "").toLowerCase().includes("details"));
    return alt || null;
  }

  function findGlobalKeyLabelEl() {
    const candidates = Array.from(document.querySelectorAll("span"))
      .filter(isVisible)
      .filter((el) => norm(el.textContent).toLowerCase() === "global key");

    if (!candidates.length) return null;

    // Prefer the one farthest to the right (details panel)
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (br.left + br.width) - (ar.left + ar.width);
    });

    return candidates[0];
  }

function extractKeyFromGlobalKeyRow(labelEl) {
  if (!labelEl) return null;

  const row =
    labelEl.closest(".MuiGrid-container") ||
    labelEl.closest('[class*="MuiGrid-container"]') ||
    labelEl.parentElement;

  if (!row) return null;

  // 🔥 NEW: Direct text extraction (Labelbox changed DOM)
  const text = (row.innerText || "").trim();

  const match = text.match(KEY_REGEX);
  if (match) return match[0];

  return null;
}

function writeIfChanged(key, reason) {
  const k = norm(key);
  if (!k) return;
  if (k === lastSeenKey) return;

  lastSeenKey = k;

  // Always store
  chrome.storage.local.set({ [STORAGE_KEY]: k }, () => {
    console.log("[LB GK] stored lb_rawText =", k, "reason=", reason);

    // Also message background (and confirm response)
    chrome.runtime.sendMessage(
      { type: "LB_AIRPORT_FOUND", rawText: k },
      (resp) => {
        console.log("[LB GK] sent LB_AIRPORT_FOUND resp=", resp, "runtimeErr=", chrome.runtime.lastError?.message || null);
      }
    );
  });
}

  // Try to derive a stable “DR identity” from URL.
  // Labelbox routes vary; we just need something that changes when the data row changes.
  function getDataRowIdentity() {
    const href = location.href;

    // Common patterns: UUIDs or long IDs in URL
    const uuid = href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return `uuid:${uuid[0].toLowerCase()}`;

    // Sometimes an ID appears after /data-rows/ or /datarows/
    const dr = href.match(/data-rows\/([^/?#]+)/i) || href.match(/datarows\/([^/?#]+)/i);
    if (dr && dr[1]) return `dr:${dr[1]}`;

    // Fallback: full URL (good enough in many work queues)
    return `url:${href}`;
  }

  async function openPanelOnceForThisDR(reason) {
    const drId = getDataRowIdentity();
    lastDrIdentity = drId;

    // Already opened for this DR? Don't click again.
    if (openedForDr.has(drId)) return false;

    // If Global Key is already visible, do not click; just mark as opened for this DR.
    if (findGlobalKeyLabelEl()) {
      openedForDr.add(drId);
      return false;
    }

    // Respect the "auto-open details panel" toggle
    const { lbx_settings } = await new Promise(resolve =>
      chrome.storage.local.get(["lbx_settings"], resolve)
    );
    if (!(lbx_settings?.autodetails ?? true)) return false;

    // Cooldown
    const now = Date.now();
    if (now - lastClickTs < CLICK_COOLDOWN_MS) return false;

    const btn = findDetailsButton();
    if (!btn) return false;

    // Click once
    lastClickTs = now;
    openedForDr.add(drId);
    log("clicking details panel for DR:", drId, reason);
    click(btn);

    // Wait a bit for panel to render
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      if (findGlobalKeyLabelEl()) return true;
    }
    return true;
  }

  async function readAndStore(reason) {
    if (running) return;
    running = true;

    try {
      // Always attempt "open once per DR" first
      await openPanelOnceForThisDR(reason);

      // Passive read if Global Key visible
      const label = findGlobalKeyLabelEl();
      if (!label) return;

      // A few retries because panel content updates async
      for (let i = 0; i < 15; i++) {

  const label = findGlobalKeyLabelEl();
  if (!label) {
    await sleep(200);
    continue;
  }

  const key = extractKeyFromGlobalKeyRow(label);

  // 🔥 CRITICAL: ensure it's DIFFERENT from lastSeenKey
  if (key && key !== lastSeenKey) {
    writeIfChanged(key, reason);
    return;
  }

  await sleep(250);
}

console.warn("[LB GK] Timed out waiting for NEW key.");
    } finally {
      running = false;
    }
  }

  // --- Triggers ---

  // 1) Initial load: open for current DR
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    lastSeenKey = norm(res[STORAGE_KEY]);
    lastDrIdentity = getDataRowIdentity();
    readAndStore("init");
  });

  // 2) Watch URL changes in SPA (pushState/replaceState + popstate)
  function installHistoryHooks() {
    const _push = history.pushState;
    const _replace = history.replaceState;

    history.pushState = function (...args) {
      const r = _push.apply(this, args);
      setTimeout(() => {
        const id = getDataRowIdentity();
        if (id !== lastDrIdentity) {
          lastDrIdentity = id;
          readAndStore("pushState");
        }
      }, 0);
      return r;
    };

    history.replaceState = function (...args) {
      const r = _replace.apply(this, args);
      setTimeout(() => {
        const id = getDataRowIdentity();
        if (id !== lastDrIdentity) {
          lastDrIdentity = id;
          readAndStore("replaceState");
        }
      }, 0);
      return r;
    };

    window.addEventListener("popstate", () => {
      const id = getDataRowIdentity();
      if (id !== lastDrIdentity) {
        lastDrIdentity = id;
        readAndStore("popstate");
      }
    });

    window.addEventListener("hashchange", () => {
      const id = getDataRowIdentity();
      if (id !== lastDrIdentity) {
        lastDrIdentity = id;
        readAndStore("hashchange");
      }
    });
  }

  // 3) MutationObserver: catches DR changes that don't change URL
  let debounceTimer = null;
  function schedule(reason) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // If identity changed, treat as new DR and open once
      const id = getDataRowIdentity();
      if (id !== lastDrIdentity) {
        lastDrIdentity = id;
        readAndStore("mutation:newDR");
      } else {
        // Otherwise just try to read (passive), but still won’t click again for same DR
        readAndStore("mutation");
      }
    }, 350);
  }

  const obs = new MutationObserver(() => { schedule("mutation"); });
  obs.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  installHistoryHooks();

  function saveToLabelbox(text) {
    const ta = document.querySelector('textarea[data-allow-alt-arrows="true"]');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const checkBtn = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'done');
    if (checkBtn) checkBtn.click();
  }

  // Extra delayed attempts (Labelbox boot can be slow)
  setTimeout(() => readAndStore("delay_1s"), 1000);
  setTimeout(() => readAndStore("delay_3s"), 3000);
  setTimeout(() => readAndStore("delay_7s"), 7000);

  let lastDataRowParam = null;

function getDataRowParam() {
  try {
    const params = new URLSearchParams(location.search);
    return params.get("dataRow");
  } catch {
    return null;
  }
}


function watchDataRowChange() {
  const current = getDataRowParam();
  if (!current) return;

  if (current !== lastDataRowParam) {
    lastDataRowParam = current;

    console.log("[LB GK] dataRow changed → triggering re-read");

    // Reset state so extraction runs clean
    lastSeenKey = "";
    openedForDr.clear();

    readAndStore("dataRowChange");
  }
}
setInterval(watchDataRowChange, 500);

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.source !== 'sc_lb_fetch') return;
  const key = e.data.globalKey;
  if (key) writeIfChanged(key, 'fetch_intercept');
});
})();

function grabCurrentGlobalKey() {

  // Check all frames (including editor iframe)
  for (let i = 0; i < window.frames.length; i++) {
    try {
      const frame = window.frames[i];
      const href = frame.location.href;

      if (!href) continue;

      const params = new URLSearchParams(frame.location.search);
      const dataRow = params.get("dataRow");

      if (dataRow) {
        console.log("Found key in frame:", href);
        return dataRow;
      }

    } catch (e) {
      // Ignore cross-origin frames
    }
  }

  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg?.type === "MANUAL_GRAB_GLOBAL_KEY") {

    const key = grabCurrentGlobalKey(); // use your existing function

    if (key) {
      sendResponse({ ok: true, key });
    } else {
      sendResponse({ ok: false });
    }

    return true;
  }

});
}