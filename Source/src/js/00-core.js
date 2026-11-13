// Core helpers: DOM, storage, IndexedDB, formatting, icons, toasts.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 9);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NATIVE = window.mcrNative || null;          // present only in the installable Windows app

const store = {
  get(k, d) { try { const v = localStorage.getItem('mcr2_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mcr2_' + k, JSON.stringify(v)); } catch {} },
};

// IndexedDB: luts (parsed .cube), blobs (background images), handles (save folder)
let _db = null;
function idb() {
  if (!_db) _db = new Promise((res, rej) => {
    const r = indexedDB.open('multicam-recorder-2', 1);
    r.onupgradeneeded = () => ['luts', 'blobs', 'handles'].forEach(n => r.result.objectStoreNames.contains(n) || r.result.createObjectStore(n));
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return _db;
}
async function idbDo(storeName, mode, fn) {
  try {
    const d = await idb();
    return await new Promise((res, rej) => {
      const tx = d.transaction(storeName, mode), req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error);
    });
  } catch (e) { console.warn('IndexedDB', e); return undefined; }
}
const idbGet = (s, k) => idbDo(s, 'readonly', st => st.get(k));
const idbPut = (s, k, v) => idbDo(s, 'readwrite', st => st.put(v, k));
const idbDel = (s, k) => idbDo(s, 'readwrite', st => st.delete(k));
const idbAll = s => idbDo(s, 'readonly', st => st.getAll());

// Formatting
const fmtTime = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.round(b / 1e3) + ' KB';
const fmtDur = sec => sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / 60)} min`;
const safeName = s => String(s).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'cam';

// Activity log + toasts
const activity = [];
function log(msg) {
  activity.unshift({ t: new Date(), msg });
  if (activity.length > 200) activity.pop();
  const el = $('#activity'); if (el) el.prepend(h(`<div><time>${new Date().toLocaleTimeString([], { hour:'numeric', minute:'2-digit', second:'2-digit' })}</time>${esc(msg)}</div>`));
}
function toast(msg, kind = '') {
  const host = $('#toasts'); if (!host) return;
  const t = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 6000 : 3200);
  if (kind === 'err') log(msg);
}

// Tiny event bus
// Animations follow the system's reduce-motion setting and the app's own Animations switch.
const motionOff = () => document.body.classList.contains('nomotion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const bus = { on(e, f) { (this[e] ||= []).push(f); }, emit(e, ...a) { (this[e] || []).forEach(f => f(...a)); } };

// Original line icons (24px grid, stroke-based)
const ICON = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  camera: '<rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  wand: '<path d="M4 20L15 9M14 4v3M18.5 5.5l-2 2M20 10h-3M9.5 4.5l1.5 1.5"/>',
  folder: '<path d="M3 7.5a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  text: '<path d="M4 6h16M4 11h16M4 16h10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13l2.5-8h9L19 13M17 16.5h.1"/>',
  compare: '<path d="M12 3v18"/><rect x="3" y="5" width="18" height="14" rx="3"/>',
  reset: '<path d="M4 12a8 8 0 108-8H8"/><path d="M8 1v6H2" transform="translate(2 0)"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  export: '<path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n] || ''}</svg>`;
