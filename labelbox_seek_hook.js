if (location.hostname !== 'editor.labelbox.com') return;
if (window.__scSeekHooked) return;
window.__scSeekHooked = true;

const _origAdd = EventTarget.prototype.addEventListener;

EventTarget.prototype.addEventListener = function(type, fn, opts) {
  if ((type === 'mousedown' || type === 'pointerdown') && typeof fn === 'function') {
    const origFn = fn;
    fn = function scSeekWrap(ev) {
      const group = ev.target?.closest?.('.vis-foreground > .vis-group');
      if (group) {
        const fgs = document.querySelectorAll('.vis-foreground');
        if (fgs.length) {
          const mainFg = [...fgs].reduce((a, b) =>
            a.getBoundingClientRect().width >= b.getBoundingClientRect().width ? a : b
          );
          if (mainFg.contains(group)) return; // speaker row click — skip seek
        }
      }
      return origFn.call(this, ev);
    };
  }
  return _origAdd.call(this, type, fn, opts);
};

(function() {
  if (window.__scFetchGK) return;
  window.__scFetchGK = true;

  const KEY_REGEX = /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{1,2}-\d{4}-\d{4}Z_\d+_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.wav\b|\b\d{6}_\d{4}_\d+\.wav\b|\b[A-Za-z]{2,4}-\d{14}_\d+_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*\.wav\b/i;

  const _orig = window.fetch;
  window.fetch = function(input, init) {
    const p = _orig.apply(this, arguments);
    p.then(r => r.clone().text()).then(text => {
      const gk = text.match(/"globalKey"\s*:\s*"([^"]+)"/);
      if (!gk) return;
      const wav = gk[1].match(KEY_REGEX);
      if (wav) window.postMessage({ source: 'sc_lb_fetch', globalKey: wav[0] }, '*');
    }).catch(() => {});
    return p;
  };
})();
