# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SandCat is a Manifest V3 Chrome extension for aviation professionals. It overlays a resizable, draggable panel on any webpage showing nearby airports, instrument procedures (SIDs, STARs, approaches), navaids, airways, and active flight data. It also integrates with Labelbox (for audio annotation workflows) and SkyVector (flight planning charts).

## Loading the extension for testing

There is no build step. Load the extension directly in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this directory

After editing any JS file, click the reload icon on the extensions page, then reload the tab where you're testing.

## Architecture

### Entry points

- **`background.js`** — the service worker. Imports `fflate.js`, `csv.js`, `db.js`, and `geo.js` via `importScripts`. Owns all in-memory indexes (fixes, navaids, airports, procedures), responds to messages from content scripts, and does all data fetching/caching.

- **`inject_overlay.js`** — injected into the active tab when the toolbar button is clicked. Creates a fixed overlay `<div>` containing a draggable/resizable header and an `<iframe>` that loads `popup.html`. Communicates with `popup.js` via `postMessage`.

- **`popup.html` / `popup.js`** — the UI rendered inside the overlay iframe. Handles airport search, procedure display, route fix streaming, and active flight panels.

- **`labelbox_grab_id.js`** — content script injected on all pages. Only activates on `editor.labelbox.com`. Watches for Labelbox data-row changes, extracts a global key (audio filename), and writes it to `chrome.storage.local["lb_pageKey"]`.

- **`adsb_bridge.js`** — content script injected on all pages. Injects `adsb_hook.js` into the page's MAIN world, then relays aircraft-selection messages from the hook to `background.js`.

- **`adsb_hook.js`** — runs in the MAIN world on `globe.adsbexchange.com`. Hooks `requestAnimationFrame` to detect when a user selects an aircraft (from URL params or the `selectedPlanes()` global), then fires a `postMessage` to `adsb_bridge.js`.

- **`skyvector_fetch_spy.js`** — MAIN world content script on SkyVector. Wraps `fetch` before SkyVector caches it to intercept map bounding-box API calls, then projects the active flight track into canvas pixel coordinates.

- **`skyvector_overlay.js`** — isolated-world content script on SkyVector. Creates a `<canvas>` overlay and draws the flight track using projected pixels received from `skyvector_fetch_spy.js` via `postMessage`.

### Message bus

All cross-context communication goes through `chrome.runtime.sendMessage` / `chrome.storage.local`, plus `postMessage` for iframe↔page-context bridging. Key storage keys:

| Key | Owner | Meaning |
|-----|-------|---------|
| `lb_pageKey` | labelbox_grab_id | Current Labelbox data-row identifier |
| `lb_manualKey` | popup | Manually typed airport/key override |
| `adsb_last_icao` | background | ICAO hex of selected aircraft |
| `adsb_active_flight_fixes` | background | Decoded route fix array |
| `adsb_active_flight_route` | background | Raw route string |
| `adsb_active_flight_origin/destination` | background | Departure/arrival ICAO |
| `adsb_active_flight_callsign` | background | Flight callsign |
| `overlayPosition` / `overlaySize` / `overlayMinimized` | inject_overlay | Persisted overlay state |
| `lbx_settings` | popup | User toggle settings (adsb, opennav, etc.) |
| `dataLastUpdated` | background | Timestamp of last GitHub data pull |

### Data layer

`background.js` maintains several in-memory indexes built at startup from bundled static files and an optional `CacheStorage` ("sandcat-data") for GitHub-fetched updates:

- `MASTER_FIX_INDEX` / `FIX_GRID` — waypoints/intersections, spatially bucketed by 1° grid cell
- `NAVAID_INDEX` / `GLOBAL_NAVAIDS` — navaids from `navaids.csv`
- `AIRPORT_CACHE` / `AIRPORT_MAP` — airports from `airports.js`
- `AUS_PROC_BY_ICAO` — Australian procedures from `aus_waypoints_complete.json`
- `SWISS_AD2_DB` — Swiss AD2 procedures from `swiss_ad2_sandcat.json`
- `IRELAND_PROC_DB` — Irish procedures from `ireland_procedures.json`
- `AUS_VFR_VISUAL_WAYPOINTS` / `VFR_VISUAL_GRID` — Australian VFR visual reporting points

Airport/runway/procedure data from FAA NASR CIFP (`cifp.zip`) is parsed on demand and persisted in IndexedDB (`db.js`, database `nearby_airports_db_v4`).

### Utility modules (loaded via `importScripts` in background)

- **`geo.js`** — `haversineNm`, `binKey1deg`
- **`csv.js`** — CSV parser
- **`db.js`** — IndexedDB wrapper (stores: airports, lookup, bins, runways, procIndex, procRoutes, approachIndex)
- **`fflate.js`** — vendored zlib/deflate for decompressing `cifp.zip`

### Standalone scripts (not loaded in extension, used for data prep)

- **`parse-swiss-aip.js`** — Node script to parse Swiss AIP PDFs into `swiss_ad2_sandcat.json` (uses `pdf-parse`)
- **`csv.js`** / **`airports.js`** / **`navaids.js`** / **`search.js`** are also referenced from `popup.html` and loaded as web-accessible resources in the iframe context

## Data update flow

Static bundled data can be refreshed from the GitHub repo (`rtankus/sandcat-extension`) via `updateDataFiles()` in `background.js`, which fetches the listed CSV/JSON files and stores them in `CacheStorage`. On next startup, `getCachedFile()` prefers the cache over the bundled extension resource.

## Key constraints

- No build toolchain — plain JS, no bundler, no TypeScript.
- `background.js` is a service worker: no DOM access, use `importScripts` not ES module `import`.
- The overlay iframe (`popup.html`) communicates with the injected page script exclusively via `window.postMessage`; it cannot call `chrome.runtime` APIs directly for cross-script calls — those go through `inject_overlay.js` as a relay.
- Two SkyVector scripts must run in different worlds: `skyvector_fetch_spy.js` in `MAIN` (to wrap `fetch` before the page caches it) and `skyvector_overlay.js` in the isolated world (to access `chrome.storage`).
