// adsb_bridge.js

(function () {

  if (window.__adsbBridgeInstalled) return;
  window.__adsbBridgeInstalled = true;

  console.log("ADSB bridge loaded");

  // Reset dedup state in background so re-selecting after a page reload isn't silently dropped
  chrome.runtime.sendMessage({ type: "ADSB_PAGE_LOADED" }).catch(() => {});

  // Listen for hook messages
  window.addEventListener("message", (event) => {

    if (event.source !== window) return;

    const msg = event.data;

    if (!msg) return;
    if (msg.source !== "adsb_hook") return;
    if (!msg.icao || msg.icao === "undefined") return;

    console.log("[SC Bridge] Received from hook, forwarding to BG:", msg.icao);

    chrome.runtime.sendMessage(msg).then(() => {
      console.log("[SC Bridge] BG received message for:", msg.icao);
    }).catch(err => {
      console.warn("[SC Bridge] sendMessage FAILED (SW dead?):", err?.message);
    });

  });

})();