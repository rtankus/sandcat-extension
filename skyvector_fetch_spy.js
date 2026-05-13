/* SandCat — SkyVector fetch spy (runs in MAIN world at document_start)
 * Wraps window.fetch before SkyVector caches it, intercepts /api/dLayer calls,
 * and posts the bounding box to the isolated-world overlay content script. */
(function () {

  var _bbox = null;
  var _trackPts = [];
  var _waypointPts = [];
  var _rafId = null;

  function mercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function parseBbox(urlStr) {
    try {
      var u = new URL(urlStr, location.origin);
      var ll1 = u.searchParams.get('ll1');
      var ll2 = u.searchParams.get('ll2');
      if (!ll1 || !ll2) return;
      var p1 = ll1.split(',').map(Number);
      var p2 = ll2.split(',').map(Number);
      if (p1.length < 2 || p2.length < 2) return;
      _bbox = { lat1: p1[0], lon1: p1[1], lat2: p2[0], lon2: p2[1] };
      schedProject();
    } catch (e) {}
  }

  function project() {
    if (!_bbox || !_trackPts.length) return;
    var chart = document.querySelector('#chart');
    if (!chart) return;
    var W = chart.offsetWidth;
    var H = chart.offsetHeight;
    if (!W || !H) return;

    var my1   = mercY(_bbox.lat1);   // bottom-left  → larger mercY
    var my2   = mercY(_bbox.lat2);   // top-right    → smaller mercY
    var mySpan = my1 - my2;          // always positive

    var pts = _trackPts.map(function (p) {
      return {
        x: (p.lon - _bbox.lon1) / (_bbox.lon2 - _bbox.lon1) * W,
        y: (mercY(p.lat) - my2) / mySpan * H,
        alt: p.alt != null ? p.alt : null,
        ts:  p.ts  != null ? p.ts  : null
      };
    });

    var wpts = _waypointPts.map(function (p) {
      return {
        x: (p.lon - _bbox.lon1) / (_bbox.lon2 - _bbox.lon1) * W,
        y: (mercY(p.lat) - my2) / mySpan * H,
        ident: p.ident
      };
    });

    window.postMessage({ __sandcatPixels: pts, __sandcatWaypointPixels: wpts }, '*');
  }

  function schedProject() {
    if (_rafId) return;
    _rafId = requestAnimationFrame(function () { _rafId = null; project(); });
  }

  // ── Wrap window.fetch ─────────────────────────────────────────────────────
  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input
            : (input && typeof input.url === 'string') ? input.url : '';
    if (url.indexOf('/api/dLayer') !== -1) parseBbox(url);
    return _origFetch.apply(this, arguments);
  };

  // ── Wrap XHR as fallback ──────────────────────────────────────────────────
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string' && url.indexOf('/api/dLayer') !== -1) parseBbox(url);
    return _origOpen.apply(this, arguments);
  };

  // ── Receive track from isolated-world overlay script ──────────────────────
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    if (e.data && e.data.__sandcatTrack !== undefined) {
      _trackPts = e.data.__sandcatTrack || [];
      schedProject();
    }
    if (e.data && e.data.__sandcatWaypoints !== undefined) {
      _waypointPts = e.data.__sandcatWaypoints || [];
      schedProject();
    }
    // Re-project on demand (e.g. after toggle)
    if (e.data && e.data.__sandcatReproject) {
      schedProject();
    }
  });

})();
