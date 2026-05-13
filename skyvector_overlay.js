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
  let lastPixels = [];

  // ── Label collision tracker (reset each draw call) ────────────────────────
  let _placed = [];
  function resetPlaced() { _placed = []; }
  function claimRect(x, y, w, h) { _placed.push({ x, y, w, h }); }
  function canPlace(x, y, w, h) {
    const PAD = 3;
    for (const r of _placed) {
      if (x - PAD < r.x + r.w && x + w + PAD > r.x &&
          y - PAD < r.y + r.h && y + h + PAD > r.y) return false;
    }
    return true;
  }

  // ── Receive projected pixels from MAIN-world spy ──────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.__sandcatPixels) {
      lastPixels = e.data.__sandcatPixels;
      draw(lastPixels, e.data.__sandcatWaypointPixels || []);
    }
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
    document.getElementById('sc-sv-alttip')?.remove();

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

    // Altitude tooltip
    const tip = document.createElement('div');
    tip.id = 'sc-sv-alttip';
    Object.assign(tip.style, {
      position: 'fixed',
      display: 'none',
      background: 'rgba(15,23,42,0.92)',
      color: '#22c55e',
      fontFamily: 'monospace',
      fontSize: '12px',
      fontWeight: '700',
      padding: '4px 9px',
      borderRadius: '6px',
      border: '1px solid rgba(34,197,94,0.35)',
      pointerEvents: 'none',
      zIndex: '99999',
      whiteSpace: 'nowrap',
      letterSpacing: '0.03em'
    });
    document.body.appendChild(tip);

    window.addEventListener('mousemove', (e) => {
      if (!visible || !lastPixels.length || !canvas) {
        tip.style.display = 'none';
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const my = (e.clientY - rect.top) * (canvas.height / rect.height);

      let best = null, bestDist = Infinity;
      for (const p of lastPixels) {
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < bestDist) { bestDist = d; best = p; }
      }

      if (best && bestDist < 22 && best.alt != null) {
        const altLabel = fmtAlt(best.alt);
        const tsLabel  = fmtTs(best.ts);
        tip.textContent = tsLabel ? `${altLabel}  ${tsLabel}` : altLabel;
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top  = (e.clientY - 18) + 'px';
      } else {
        tip.style.display = 'none';
      }
    });
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
    resetPlaced();
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

    drawAltitudeMarkers(pts);

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

  function fmtAlt(alt) {
    if (alt == null) return null;
    return alt >= 18000
      ? `FL${String(Math.round(alt / 100)).padStart(3, '0')}`
      : `${alt.toLocaleString()} ft`;
  }

  function fmtTs(secOfDay) {
    if (secOfDay == null) return null;
    const h = Math.floor(secOfDay / 3600) % 24;
    const m = Math.floor((secOfDay % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}Z`;
  }

  function drawWaypointDots(wpts) {
    const R = 10;
    ctx.font = 'bold 11px monospace';

    for (const p of wpts) {
      // Claim diamond footprint so labels don't overlap it
      claimRect(p.x - R - 1, p.y - R - 1, (R + 1) * 2, (R + 1) * 2);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.setLineDash([]);

      // Glow halo
      ctx.beginPath();
      ctx.moveTo(0, -(R + 4)); ctx.lineTo(R + 4, 0); ctx.lineTo(0, R + 4); ctx.lineTo(-(R + 4), 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(34,211,238,0.18)';
      ctx.fill();

      // Outer ring diamond
      ctx.beginPath();
      ctx.moveTo(0, -R); ctx.lineTo(R, 0); ctx.lineTo(0, R); ctx.lineTo(-R, 0);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Inner fill diamond
      const IR = R - 2.5;
      ctx.beginPath();
      ctx.moveTo(0, -IR); ctx.lineTo(IR, 0); ctx.lineTo(0, IR); ctx.lineTo(-IR, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(34,211,238,0.88)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.restore();

      // Label — try 4 candidate positions, pick first that fits
      if (p.ident) {
        const tw = ctx.measureText(p.ident).width;
        const th = 11;
        const gap = 4;
        const candidates = [
          { ax: p.x + R + gap,          ay: p.y - th / 2, align: 'left'   }, // right
          { ax: p.x - R - gap - tw,     ay: p.y - th / 2, align: 'left'   }, // left
          { ax: p.x - tw / 2,           ay: p.y - R - gap - th, align: 'left' }, // above
          { ax: p.x - tw / 2,           ay: p.y + R + gap, align: 'left'  }, // below
        ];

        let chosen = null;
        for (const c of candidates) {
          if (canPlace(c.ax, c.ay, tw, th)) { chosen = c; break; }
        }

        if (chosen) {
          claimRect(chosen.ax, chosen.ay, tw, th);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.strokeText(p.ident, chosen.ax, chosen.ay);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(p.ident, chosen.ax, chosen.ay);
        }
      }
    }
  }

  function drawAltitudeMarkers(pts) {
    const MIN_DIST = 160;
    let lastMarkerX = -MIN_DIST, lastMarkerY = -MIN_DIST;

    ctx.font = 'bold 10px monospace';

    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      if (p.alt == null) continue;
      if (Math.hypot(p.x - lastMarkerX, p.y - lastMarkerY) < MIN_DIST) continue;

      const altLabel = fmtAlt(p.alt) || '';
      const tsLabel  = fmtTs(p.ts)   || '';
      const bw = Math.max(ctx.measureText(altLabel).width, ctx.measureText(tsLabel).width) + 10;
      const bh = tsLabel ? 28 : 16;

      // Perpendicular normals — try both sides of the track
      const prev = pts[i - 1];
      const tx = p.x - prev.x, ty = p.y - prev.y;
      const tLen = Math.hypot(tx, ty) || 1;
      const tickLen = 14;
      const normals = [
        { nx: -ty / tLen, ny:  tx / tLen },
        { nx:  ty / tLen, ny: -tx / tLen },
      ];

      let placed = false;
      for (const { nx, ny } of normals) {
        const tipX = p.x + nx * (tickLen + 2);
        const tipY = p.y + ny * (tickLen + 2);
        // Badge anchored on the side the tick points toward
        const bx = tipX + (nx >= 0 ? 2 : -bw - 2);
        const by = tipY + (ny >= 0 ? 2 : -bh - 2);

        if (!canPlace(bx, by, bw, bh)) continue;

        claimRect(bx, by, bw, bh);
        lastMarkerX = p.x; lastMarkerY = p.y;

        // Tick
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.5;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + nx * tickLen, p.y + ny * tickLen);
        ctx.stroke();

        // Badge background
        ctx.fillStyle = 'rgba(15,23,42,0.88)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(34,211,238,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Text
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#22d3ee';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(altLabel, bx + bw / 2, by + 3);
        if (tsLabel) {
          ctx.fillStyle = 'rgba(148,163,184,0.9)';
          ctx.font = '9px monospace';
          ctx.fillText(tsLabel, bx + bw / 2, by + 15);
        }

        placed = true;
        break;
      }

      if (!placed) lastMarkerX = p.x; // still advance so we skip this dense zone
    }
    ctx.setLineDash([]);
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
