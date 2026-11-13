// Camera presets: save a camera's settings under a name, apply them to any camera, export/import between computers.
// Plus device memory: a camera you plug back in gets the settings it had last time.
const PRESET_PARTS = [
  ['image', 'Image adjustments', 'Look, light, color and detail'],
  ['framing', 'Framing', 'Zoom, pan, tilt, rotate, mirror, 9:16 copy'],
  ['lut', 'LUT', 'Which LUT, strength, record with LUT'],
  ['key', 'Green screen', 'Key settings and background'],
  ['controls', 'Camera controls', 'Exposure, white balance, focus on the camera itself'],
  ['format', 'Resolution & frame rate', ''],
  ['monitor', 'Monitoring', 'Zebras and focus peaking'],
  ['file', 'File name', ''],
];
const PART_KEYS = {
  image: [...LOOK_KEYS, 'look', 'lookEdited'],
  framing: ['zoom', 'panX', 'panY', 'rot', 'mirror', 'flip'],
  key: ['key', 'keyColor', 'keySim', 'keySmooth', 'keySpill', 'bgMode', 'bgColor', 'bgKey'],
  monitor: ['zebra', 'peaking'],
};

function capturePreset(cam, parts) {
  const d = { parts: [...parts] };
  if (parts.includes('image') || parts.includes('framing') || parts.includes('key') || parts.includes('monitor')) {
    d.adj = {};
    for (const p of ['image', 'framing', 'key', 'monitor']) if (parts.includes(p)) PART_KEYS[p].forEach(k => d.adj[k] = cam.adj[k]);
  }
  if (parts.includes('framing')) d.vert = { ...cam.vert };
  if (parts.includes('lut')) d.lut = { ...cam.lut };
  if (parts.includes('controls')) d.hw = { ...cam.hw };
  if (parts.includes('format')) { d.res = cam.res; d.fps = cam.fps; }
  if (parts.includes('file')) { d.fileName = cam.fileName || ''; d.naming = cam.naming || null; }
  return d;
}

async function applyPreset(cam, d, name) {
  if (recState.active && d.parts.includes('format')) return toast('Stop recording to change resolution or frame rate', 'err');
  if (d.adj) Object.assign(cam.adj, d.adj);
  if (d.vert) cam.vert = { ...cam.vert, ...d.vert };
  if (d.lut) { cam.lut = { ...cam.lut, ...d.lut }; if (cam.lut.name && !luts.has(cam.lut.name)) { toast(`LUT “${cam.lut.name}” isn’t on this computer. Import it to use it.`, 'err'); cam.lut.name = ''; } }
  if (d.fileName !== undefined) cam.fileName = d.fileName;
  if (d.naming !== undefined) cam.naming = d.naming;
  if (d.adj && d.adj.bgKey) { const blob = await idbGet('blobs', d.adj.bgKey); if (blob) await setCamBg(cam, blob, false); }
  syncRenderers(cam);
  let reopen = false;
  if (d.res && d.res !== cam.res) { cam.res = d.res; reopen = true; }
  if (d.fps && +d.fps !== cam.fps) { cam.fps = +d.fps; reopen = true; }
  if (d.hw) cam.hw = { ...cam.hw, ...d.hw };
  if (reopen && cam.deviceId) await openCam(cam);
  else if (d.hw && cam.alive) await applyHw(cam);
  cam.preset = name || '';
  paintTile(cam); saveCurrent(); checkLoad();
  if (isSel(cam)) renderInspector();
}

// ---------- device memory ----------
function rememberDevices() {
  const mem = store.get('deviceMemory', {});
  for (const c of cams) if (c.label) mem[c.label] = { ...capturePreset(c, PRESET_PARTS.map(p => p[0])), name: c.name };
  store.set('deviceMemory', mem);
}
function recallDevice(label) {
  const m = store.get('deviceMemory', {})[label];
  return m ? { adj: { ...ADJ_DEFAULT, ...(m.adj || {}) }, vert: m.vert, lut: m.lut, hw: m.hw, res: m.res, fps: m.fps, fileName: m.fileName, naming: m.naming, name: m.name } : {};
}

// ---------- presets UI ----------
function openCamPresets(cam) {
  const draw = (body, dlg) => {
    const all = store.get('camPresets', {});
    const include = new Set(store.get('camPresetParts', ['image', 'framing', 'lut', 'key', 'controls', 'format']));
    body.innerHTML = `
      <div class="cat" style="margin-top:0">Apply to ${esc(cam.name)}</div>
      <div class="cards" style="grid-template-columns:1fr">${Object.entries(all).map(([n, d]) => `
        <button class="card ${cam.preset === n ? 'on' : ''}" data-apply="${esc(n)}"><b>${esc(n)}</b>
          <span>${d.parts.map(p => (PRESET_PARTS.find(x => x[0] === p) || [, p])[1]).join(' · ')}</span>
          <i class="del" data-del="${esc(n)}" title="Delete">${icon('x', 'sm')}</i></button>`).join('') || '<div class="empty-note">No camera presets yet. Set up a camera the way you like it, then save it below.</div>'}</div>
      <div class="cat">Save ${esc(cam.name)}’s settings as a preset</div>
      <div class="group" style="margin-bottom:8px">${PRESET_PARTS.map(([k, l, sub]) => ui.toggle(k, l, include.has(k), sub)).join('')}</div>
      <div class="savebar" style="margin-top:0"><input id="cpName" placeholder="Desk A-cam, Pulpit wide…" value="${esc(cam.preset || '')}" maxlength="32"><button class="btn primary" id="cpSave">Save</button></div>
      <div class="btns" style="margin-top:14px"><button class="btn" id="cpExport">${icon('export', 'sm')} Export all</button><button class="btn" id="cpImport">Import…</button></div>
      <p class="note" style="padding:0">Export saves every camera preset, look and audio preset to one file, so you can bring them to another computer.</p>`;
    const parts = Object.fromEntries(PRESET_PARTS.map(([k]) => [k, include.has(k)]));
    bindControls(body.querySelector('.group'), parts, () => store.set('camPresetParts', Object.keys(parts).filter(k => parts[k])));
    body.querySelectorAll('[data-apply]').forEach(c => c.onclick = async e => {
      if (e.target.closest('[data-del]')) { const a = store.get('camPresets', {}); delete a[c.dataset.apply]; store.set('camPresets', a); return draw(body, dlg); }
      dlg.close(); await applyPreset(cam, all[c.dataset.apply], c.dataset.apply); toast(`Applied “${c.dataset.apply}” to ${cam.name}`);
    });
    const inp = body.querySelector('#cpName');
    const save = () => {
      const n = inp.value.trim(); if (!n) return inp.focus();
      const chosen = Object.keys(parts).filter(k => parts[k]);
      if (!chosen.length) return toast('Pick at least one thing to include', 'err');
      const a = store.get('camPresets', {}); a[n] = capturePreset(cam, chosen); store.set('camPresets', a);
      cam.preset = n; saveCurrent(); toast(`Saved camera preset “${n}”`); draw(body, dlg); if (isSel(cam)) renderInspector();
    };
    body.querySelector('#cpSave').onclick = save; inp.onkeydown = e => { if (e.key === 'Enter') save(); };
    body.querySelector('#cpExport').onclick = exportPresets;
    body.querySelector('#cpImport').onclick = () => importPresets(() => draw(body, dlg));
  };
  openMenu('Camera presets', '', (body, dlg) => draw(body, dlg));
}

async function exportPresets() {
  const data = { app: 'Gadget Cam Studio', kind: 'presets', version: 1, exported: new Date().toISOString(),
    camPresets: store.get('camPresets', {}), userLooks: store.get('userLooks', {}), userPresets: store.get('userPresets', {}), setups: store.get('setups', {}) };
  const name = `Gadget Cam Studio presets ${new Date().toISOString().slice(0, 10)}.json`;
  if (NATIVE) { const p = await NATIVE.writeText(name, JSON.stringify(data, null, 2)); toast(`Saved ${String(p).split(/[\\/]/).pop()} to your recordings folder`); }
  else download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name);
}
function importPresets(done) {
  const f = document.createElement('input'); f.type = 'file'; f.accept = '.json,application/json';
  f.onchange = async () => {
    try {
      const d = JSON.parse(await f.files[0].text());
      if (d.app !== 'Gadget Cam Studio' || d.kind !== 'presets') throw new Error('This isn’t a Gadget Cam Studio presets file');
      let n = 0;
      for (const k of ['camPresets', 'userLooks', 'userPresets', 'setups']) {
        const cur = store.get(k, {}), inc = d[k] || {};
        Object.assign(cur, inc); n += Object.keys(inc).length; store.set(k, cur);
      }
      toast(`Imported ${n} presets`); renderSetups(); renderInspector(); done && done();
    } catch (e) { toast('Import failed: ' + e.message, 'err'); }
  };
  f.click();
}
