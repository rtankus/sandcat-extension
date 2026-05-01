/* SandCat — SkyVector overlay (isolated world, document_idle)
 * Handles canvas creation, chrome.storage, and draw calls.
 * Projection is done by skyvector_fetch_spy.js (MAIN world, document_start). */
(function () {
  'use strict';

  let canvas, ctx;
  let trackPoints = [];
  let waypointPoints = [];
  let callsign = '';
  let visible = true;

  // ── Receive projected pixels from MAIN-world spy ──────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.__sandcatPixels) draw(e.data.__sandcatPixels, e.data.__sandcatWaypointPixels || []);
  });

  // ── Send track to MAIN-world spy (triggers reprojection) ──────────────────
  function sendTrack() {
    window.postMessage({
      __sandcatTrack: visible ? trackPoints : [],
      __sandcatWaypoints: visible ? waypointPoints : []
    }, '*');
  }

  // ── Canvas setup ──────────────────────────────────────────────────────────
  function initCanvas() {
    document.getElementById('sc-sv-canvas')?.remove();
    document.getElementById('sc-sv-hud')?.remove();

    canvas = document.createElement('canvas');
    canvas.id = 'sc-sv-canvas';

    const chartEl = document.querySelector('#chart');
    if (chartEl) {
      Object.assign(canvas.style, {
        position: 'absolute',
        top: '0', left: '0',
        width: '100%', height: '100%',
        pointerEvents: 'none',
        zIndex: '10'
      });
      chartEl.appendChild(canvas);
    } else {
      Object.assign(canvas.style, {
        position: 'fixed',
        top: '0', left: '0',
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        zIndex: '9998'
      });
      document.body.appendChild(canvas);
    }

    syncCanvasSize();
    ctx = canvas.getContext('2d');

    // HUD — single toggle button only
    const hud = document.createElement('div');
    hud.id = 'sc-sv-hud';
    Object.assign(hud.style, {
      position: 'fixed', bottom: '14px', right: '14px',
      zIndex: '99999', fontFamily: 'monospace', fontSize: '12px', userSelect: 'none'
    });

    const btnToggle = document.createElement('button');
    btnToggle.id = 'sc-sv-toggle';
    btnToggle.textContent = '✈ SandCat Track';
    Object.assign(btnToggle.style, {
      padding: '5px 10px',
      background: 'rgba(34,197,94,0.92)',
      color: '#000', border: 'none', borderRadius: '6px',
      fontWeight: '700', cursor: 'pointer', fontSize: '12px',
      fontFamily: 'monospace', boxShadow: '0 2px 6px rgba(0,0,0,0.5)'
    });
    btnToggle.addEventListener('click', () => {
      visible = !visible;
      btnToggle.style.background = visible
        ? 'rgba(34,197,94,0.92)'
        : 'rgba(100,116,139,0.7)';
      if (!visible) {
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      sendTrack();
    });

    hud.appendChild(btnToggle);
    document.body.appendChild(hud);
  }

  function syncCanvasSize() {
    if (!canvas) return;
    const p = canvas.parentElement;
    canvas.width  = p?.clientWidth  || window.innerWidth;
    canvas.height = p?.clientHeight || window.innerHeight;
  }

  // ── Move canvas into #chart if it wasn't ready at init ────────────────────
  function ensureInChart() {
    if (canvas?.isConnected && canvas.parentElement?.id === 'chart') return;
    const chartEl = document.querySelector('#chart');
    if (chartEl && canvas) {
      chartEl.appendChild(canvas);
      Object.assign(canvas.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '10'
      });
      syncCanvasSize();
      sendTrack();
    } else {
      setTimeout(ensureInChart, 300);
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────
  function draw(pixels, waypointPixels) {
    if (!canvas || !ctx) return;
    syncCanvasSize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!visible) return;
    if (!pixels || pixels.length < 2) {
      if (waypointPixels?.length) drawWaypointDots(waypointPixels);
      return;
    }

    const pts = pixels;

    // Glow
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0,255,100,0.18)';
    ctx.lineWidth = 9;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();

    // Main line
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(34,197,94,0.92)';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.setLineDash([]);
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();

    // Direction arrows
    ctx.fillStyle = 'rgba(34,197,94,0.85)';
    const step = Math.max(1, Math.floor(pts.length / 8));
    for (let i = step; i < pts.length - 1; i += step) {
      const a = pts[i - 1], b = pts[i];
      drawArrow((a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x));
    }

    // Dots
    ctx.fillStyle = 'rgba(34,197,94,0.4)';
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
    }

    drawEndMarker(pts[0].x, pts[0].y, '#22c55e', 'O');
    drawEndMarker(pts[pts.length - 1].x, pts[pts.length - 1].y, '#f59e0b', 'D');

    if (callsign) {
      const mid = pts[Math.floor(pts.length / 2)];
      ctx.font = 'bold 11px monospace';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(callsign, mid.x + 10, mid.y - 7);
      ctx.fillStyle = 'rgba(34,197,94,0.95)';
      ctx.fillText(callsign, mid.x + 10, mid.y - 7);
    }

    if (waypointPixels?.length) drawWaypointDots(waypointPixels);
  }

  function drawWaypointDots(wpts) {
    for (const p of wpts) {
      // Diamond
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.beginPath();
      ctx.moveTo(0, -5); ctx.lineTo(5, 0); ctx.lineTo(0, 5); ctx.lineTo(-5, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(251,191,36,0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();

      // Label
      if (p.ident) {
        ctx.font = 'bold 9px monospace';
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.strokeText(p.ident, p.x + 7, p.y - 3);
        ctx.fillStyle = 'rgba(251,191,36,1)';
        ctx.fillText(p.ident, p.x + 7, p.y - 3);
      }
    }
  }

  function drawArrow(x, y, angle) {
    const len = 7;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(len, 0); ctx.lineTo(-len / 2, len / 2); ctx.lineTo(-len / 2, -len / 2);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawEndMarker(x, y, color, label) {
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([]); ctx.stroke();
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  function loadFromStorage() {
    chrome.storage.local.get(
      ['adsb_active_flight_track', 'adsb_active_flight_callsign', 'adsb_active_flight_waypoints'],
      (data) => {
        trackPoints    = data.adsb_active_flight_track || [];
        callsign       = data.adsb_active_flight_callsign || '';
        waypointPoints = data.adsb_active_flight_waypoints || [];
        updateHudLabel();
        sendTrack();
      }
    );
  }

  chrome.storage.onChanged.addListener((changes) => {
    if ('adsb_active_flight_track' in changes || 'adsb_active_flight_callsign' in changes || 'adsb_active_flight_waypoints' in changes) {
      if ('adsb_active_flight_track' in changes)
        trackPoints = changes.adsb_active_flight_track.newValue || [];
      if ('adsb_active_flight_callsign' in changes)
        callsign = changes.adsb_active_flight_callsign.newValue || '';
      if ('adsb_active_flight_waypoints' in changes)
        waypointPoints = changes.adsb_active_flight_waypoints.newValue || [];
      updateHudLabel();
      sendTrack();
    }
  });

  function updateHudLabel() {
    const btn = document.getElementById('sc-sv-toggle');
    if (!btn) return;
    btn.textContent = trackPoints.length > 0
      ? `✈ ${callsign || 'Track'} (${trackPoints.length} pts)`
      : '✈ SandCat Track';
  }

  // ── URL / nav changes ─────────────────────────────────────────────────────
  const _replace = history.replaceState.bind(history);
  history.replaceState = function (...a) { _replace(...a); sendTrack(); };
  const _push = history.pushState.bind(history);
  history.pushState = function (...a) { _push(...a); sendTrack(); };
  window.addEventListener('popstate', sendTrack);

  // ── Resize ────────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => { syncCanvasSize(); sendTrack(); });

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    initCanvas();
    loadFromStorage();
    ensureInChart();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
