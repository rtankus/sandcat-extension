// adsb_hook.js

if (location.hostname.includes("adsbexchange.com")) {

  // Always reset lastIcao on each bridge injection so re-selecting the same
  // aircraft after a page soft-nav (where the hook's closure persists) works.
  window.__adsbLastIcao = null;

  if (window.__adsbStoreHook) {
    console.log("[SC Hook] Already installed — lastIcao reset for re-selection");
  } else {

    window.__adsbStoreHook = true;

    console.log("[SC Hook] Installed");

    function detectAircraft(){

  try {

    const params = new URLSearchParams(location.search);
    let icaoRaw = params.get("icao");

    // Ignore literal "undefined" string from malformed ADSB URL params
    if (icaoRaw === "undefined") icaoRaw = null;

    let callsign = null;

    try {

      if (typeof selectedPlanes === "function") {

        const planes = selectedPlanes();

        if (planes && planes.length) {

          const p = planes[0];

          if (!icaoRaw) {
            icaoRaw = p.icao || p.hex || p.icao24 || null;
          }

          callsign =
            p.flight ||
            p.callsign ||
            p.t ||
            null;

        }

      }

    } catch(e){}

    if (!icaoRaw) {
      if (window.__adsbLastIcao !== null) {
        console.log("[SC Hook] Deselected — lastIcao was:", window.__adsbLastIcao);
        window.__adsbLastIcao = null;
      }
      return;
    }

    const clean = icaoRaw.toLowerCase();

    if (clean !== window.__adsbLastIcao) {

      window.__adsbLastIcao = clean;

      console.log("[SC Hook] NEW selection → posting:", clean, "callsign:", callsign);

      window.postMessage({
        source: "adsb_hook",
        type: "ADSB_AIRCRAFT_SELECTED",
        icao: clean,
        callsign: callsign?.trim() || null
      }, "*");

    }

  } catch(e){ console.warn("[SC Hook] detectAircraft error:", e); }

}

    const origRAF = window.requestAnimationFrame;

    window.requestAnimationFrame = function(fn){

      return origRAF.call(this,function(){

        detectAircraft();

        return fn.apply(this,arguments);

      });

    };

    // Run once immediately after load
    setTimeout(detectAircraft, 1000);

  }

}
