// Motion: smooth entrances, layout changes that glide (FLIP), and live audio glows on the mixer strips.
const motion = (() => {
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  const seenStrips = new WeakSet();

  // play a one-shot class (removed when its animation ends)
  function enter(el, cls = 'm-enter') {
    if (!el || motionOff()) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  // FLIP: remember where tiles were, change the layout, then glide them from old to new spots
  function flip(change, host = '#grid') {
    const root = $(host);
    if (!root || motionOff()) return change();
    const els = [...root.children].filter(e => e.offsetParent);
    const before = new Map(els.map(e => [e, e.getBoundingClientRect()]));
    change();
    for (const [e, a] of before) {
      if (!e.isConnected || !e.offsetParent) continue;
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) continue;
      e.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` },
                 { transformOrigin: '0 0', transform: 'none' }], { duration: 380, easing: EASE });
    }
    // tiles that just appeared fade and scale in
    [...root.children].filter(e => e.offsetParent && !before.has(e)).forEach(e => enter(e));
  }

  // live strip states: talking glow, ducked dip, AI badge breathing with the voice
  const buf = new Float32Array(1024);
  function rms(an) { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return 10 * Math.log10(s / buf.length + 1e-12); }
  setInterval(() => {
    if (!audio.ctx || document.hidden) return;
    for (const ch of audio.channels) {
      const el = ch.meterEl && ch.meterEl.closest('.strip'); if (!el || !ch.n) continue;
      if (!seenStrips.has(ch)) { seenStrips.add(ch); enter(el); }
      const lvl = rms(ch.n.an), talking = ch.alive && !ch.s.recMute && lvl > -42;
      el.classList.toggle('talking', talking);
      el.style.setProperty('--lvl', clamp((lvl + 60) / 50, 0, 1).toFixed(2));
      const ducked = ch.n.duck && ch.n.duck.gain.value < 0.9;
      el.classList.toggle('ducked', !!ducked);
    }
  }, 60);

  // inspector content rises in when you pick something new
  let lastSel = null;
  bus.on('select', () => {
    const now = selected && selected.obj;
    if (now !== lastSel) { lastSel = now; requestAnimationFrame(() => enter($('#insp'), 'm-insp')); }
  });

  return { enter, flip };
})();

// Wrap layout changes so tiles glide instead of jumping.
{
  const plainApplyView = applyView;
  applyView = (...a) => motion.flip(() => plainApplyView(...a));
}
// New camera tiles pop in once.
{
  const plainTileFor = tileFor;
  tileFor = cam => { const fresh = !cam.tile, t = plainTileFor(cam); if (fresh) requestAnimationFrame(() => motion.enter(t)); return t; };
}
// Dialogs and menus open with a soft spring.
{
  const show = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () { show.call(this); motion.enter(this, 'm-pop'); };
}
