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
