// UI kit: inspector controls (sliders, switches, menus, segmented controls) + one binder for all of them.
// Plain-text descriptions become hover tooltips; only live info (HTML like file previews) stays on screen.
const tipOnly = sub => sub && !/[<]/.test(sub);
const subHtml = sub => sub && !tipOnly(sub) ? `<small>${sub}</small>` : '';
const tipAttr = sub => tipOnly(sub) ? ` title="${esc(sub)}"` : '';
const ui = {
  slider(k, label, min, max, step, val, dflt = 0, fmt = v => v, opts = {}) {
    const center = min < 0 && max > 0;
    const p = ((val - min) / (max - min) * 100).toFixed(2);
    return `<div class="sl ${val !== dflt ? 'changed' : ''} ${opts.cls || ''}" data-wrap="${k}">
      <div class="top"><span>${label}</span><output>${esc(fmt(val))}</output></div>
      <input type="range" class="s ${center ? 'center' : ''}" data-k="${k}" data-d="${dflt}" min="${min}" max="${max}" step="${step}" value="${val}" style="--p:${p}%"></div>`;
  },
  toggle(k, label, val, sub = '') {
    return `<div class="r"${tipAttr(sub)}><div class="lb">${label}${subHtml(sub)}</div>
      <label class="sw"><input type="checkbox" data-k="${k}" ${val ? 'checked' : ''}><i></i></label></div>`;
  },
  select(k, label, options, val, sub = '') {
    return `<div class="r"${tipAttr(sub)}><div class="lb">${label}${subHtml(sub)}</div>
      <select data-k="${k}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  },
  seg(k, options, val, cls = '') {
    return `<div class="seg ${cls}" data-seg="${k}">${options.map(([v, l]) => `<button data-v="${esc(v)}" class="${String(v) === String(val) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  },
  row(label, html, sub = '') { return `<div class="r"${tipAttr(sub)}><div class="lb">${label}${subHtml(sub)}</div>${html}</div>`; },
  group(title, inner, action = '') { return `<div class="group-h"><span>${title}</span>${action}</div><div class="group">${inner}</div>`; },
};

// Bind every [data-k] / [data-seg] inside root to obj. onChange(key, value) runs after each change.
function bindControls(root, obj, onChange) {
  root.querySelectorAll('input[type=range][data-k]').forEach(inp => {
    const k = inp.dataset.k, wrap = inp.closest('.sl'), out = wrap && wrap.querySelector('output');
    const fmt = inp._fmt || (v => v);
    const paint = () => {
      const v = +inp.value;
      inp.style.setProperty('--p', ((v - inp.min) / (inp.max - inp.min) * 100) + '%');
      if (out) out.textContent = (inp._fmt || fmt)(v);
      if (wrap) wrap.classList.toggle('changed', v !== +inp.dataset.d);
    };
    inp.addEventListener('input', () => { obj[k] = +inp.value; paint(); onChange(k, obj[k]); });
    inp.addEventListener('dblclick', () => { inp.value = inp.dataset.d; obj[k] = +inp.value; paint(); onChange(k, obj[k]); });
    inp._paint = paint;
  });
  root.querySelectorAll('input[type=checkbox][data-k]').forEach(inp => inp.addEventListener('change', () => { obj[inp.dataset.k] = inp.checked; onChange(inp.dataset.k, inp.checked); }));
  root.querySelectorAll('select[data-k], input[type=color][data-k], input[type=text][data-k], input[type=number][data-k]').forEach(inp => {
    inp.addEventListener(inp.type === 'color' ? 'input' : 'change', () => {
      const raw = inp.value, v = inp.type === 'number' || (/^-?\d+(\.\d+)?$/.test(raw) && typeof obj[inp.dataset.k] === 'number') ? +raw : raw;
      obj[inp.dataset.k] = v; onChange(inp.dataset.k, v);
    });
  });
  root.querySelectorAll('[data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const k = seg.dataset.seg, cur = obj[k];
    const v = typeof cur === 'number' ? +b.dataset.v : typeof cur === 'boolean' ? b.dataset.v === 'true' : b.dataset.v;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    obj[k] = v; onChange(k, v);
  })));
}
// attach value formatters to sliders after binding html is in the DOM
function setFmt(root, k, fmt) { const i = root.querySelector(`input[data-k="${k}"]`); if (i) { i._fmt = fmt; i._paint && i._paint(); } }

const signed = v => (v > 0 ? '+' : '') + v;
const pct = v => v + '%';

function openMenu(title, html, bindFn) {
  const d = $('#menu'); $('#menuTitle').textContent = title; $('#menuBody').innerHTML = html;
  bindFn && bindFn($('#menuBody'), d);
  if (!d.open) d.showModal();
  return d;
}
document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) c.closest('dialog').close(); });
