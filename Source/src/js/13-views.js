// Studio preview layouts (Grid · Spotlight · Single · Output) and framing guides.
const view = { mode: 'grid', guides: 'none', ...store.get('view', {}) };
const saveView = () => store.set('view', view);
const LAYOUTS = [['grid', 'Grid'], ['spotlight', 'Spotlight'], ['single', 'Single'], ['output', 'Output']];
const GUIDES = [['none', 'No guides'], ['thirds', 'Rule of thirds'], ['center', 'Center'], ['safe', 'Safe areas'], ['vertical', '9:16 frame']];

// the camera shown large in Spotlight and Single
function focusCam() {
  if (selected && selected.type === 'cam' && cams.includes(selected.obj)) return selected.obj;
  return progCam() || cams[0] || null;
}

const GUIDE_SVG = {
  thirds: '<path d="M33.33 0V100M66.67 0V100M0 33.33H100M0 66.67H100"/>',
  center: '<path d="M50 44V56M44 50H56"/><circle cx="50" cy="50" r="2.2" fill="none"/>',
  safe: '<rect x="5" y="5" width="90" height="90" fill="none"/><rect x="10" y="10" width="80" height="80" fill="none" stroke-dasharray="1.5 1.5"/>',
  vertical: '<rect x="34.18" y="0" width="31.64" height="100" fill="none"/>',
};
function guideHtml() {
  if (view.guides === 'none') return '';
  return `<svg class="guides" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${GUIDE_SVG[view.guides] || ''}</svg>`;
}

// bar above the previews
function renderStageBar() {
  let bar = $('#stagebar');
  if (!bar) { bar = h('<div id="stagebar"></div>'); $('#grid').before(bar); }
  const fc = focusCam();
  const showNav = (view.mode === 'single' || view.mode === 'spotlight') && cams.length > 1;
  bar.innerHTML = `
    ${ui.seg('mode', LAYOUTS, view.mode)}
    ${showNav ? `<div class="nav"><button class="tb" data-nav="-1" title="Previous camera">‹</button><span>${esc(fc ? fc.name : '')}</span><button class="tb" data-nav="1" title="Next camera">›</button></div>` : ''}
    <select data-k="guides" title="Framing guides">${GUIDES.map(([v, l]) => `<option value="${v}" ${v === view.guides ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  bindControls(bar, view, () => { saveView(); renderGrid(); });
  bar.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => {
    if (!cams.length) return;
    const i = cams.indexOf(focusCam()), n = cams[(i + +b.dataset.nav + cams.length) % cams.length];
    select('cam', n);
  });
}

// output preview tile for the Output layout
let outTile = null;
function outputTile() {
  if (outTile) return outTile;
  outTile = h(`<div class="tile focus outtile"><canvas></canvas>
    <div class="ov tl"><span class="chip-o green">OUTPUT</span><span class="chip-o otn"></span></div>
    <div class="ov bl"><span class="chip-o mono oti"></span></div></div>`);
  return outTile;
}
function drawOutputTile() {
  if (view.mode !== 'output' || !outTile || !comp.width) return;
  const c = outTile.querySelector('canvas');
  if (c.width !== comp.width) { c.width = comp.width; c.height = comp.height; }
  c.getContext('2d').drawImage(comp, 0, 0);
  const pc = progCam();
  outTile.querySelector('.otn').textContent = pc ? pc.name + (pipCam() ? ` + ${pipCam().name}` : '') : 'No camera';
  outTile.querySelector('.oti').textContent = `${comp.width}×${comp.height} · ${program.fps} fps${vcamState.on ? ' · virtual camera on' : ''}`;
}

// arrange tiles for the current layout (called at the end of renderGrid)
function applyView() {
  const grid = $('#grid');
  ['grid', 'spotlight', 'single', 'output'].forEach(m => grid.classList.toggle('v-' + m, view.mode === m));
  const fc = focusCam();
  cams.forEach(c => {
    const t = tileFor(c), isFocus = (view.mode === 'spotlight' || view.mode === 'single') && c === fc;
    t.classList.toggle('focus', isFocus);
    t.classList.toggle('thumb', (view.mode === 'spotlight' && !isFocus) || view.mode === 'output');
    t.classList.toggle('hidden-v', view.mode === 'single' && !isFocus);
    t.classList.toggle('onout', view.mode === 'output' && progCam() === c);
    t.querySelector('.guides') && t.querySelector('.guides').remove();
    if (view.guides !== 'none' && !t.classList.contains('thumb')) t.insertAdjacentHTML('beforeend', guideHtml());
  });
  const add = grid.querySelector('.addtile');
  if (add) add.hidden = view.mode === 'single' || view.mode === 'output';
  if (view.mode === 'output') {
    const ot = outputTile();
    ot.querySelector('.guides') && ot.querySelector('.guides').remove();
    if (view.guides !== 'none') ot.insertAdjacentHTML('beforeend', guideHtml());
    grid.prepend(ot); enablePipDrag(ot.querySelector('canvas')); ensureLoop();
  } else if (outTile) outTile.remove();
  if (fc && (view.mode === 'spotlight' || view.mode === 'single')) grid.prepend(tileFor(fc));
  renderStageBar();
}

// keep big previews inside the visible area
new ResizeObserver(() => { const g = $('#grid'); if (g) g.style.setProperty('--gh', g.clientHeight + 'px'); }).observe(document.documentElement);
setTimeout(() => { const g = $('#grid'); if (g) { const ro = new ResizeObserver(() => g.style.setProperty('--gh', g.clientHeight + 'px')); ro.observe(g); } }, 0);

// L cycles layouts
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'l' || e.key === 'L') {
    const i = LAYOUTS.findIndex(l => l[0] === view.mode);
    view.mode = LAYOUTS[(i + 1) % LAYOUTS.length][0]; saveView(); renderGrid();
    toast(`${LAYOUTS.find(l => l[0] === view.mode)[1]} layout`);
  }
});
