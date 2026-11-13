// Performance budget: estimate load from every camera, warn before it's too much, offer one-click fixes.
// 1 unit = one 1080p30 camera (preview + recording). The budget scales with this computer's CPU, memory and GPU.
const perf = (() => {
  let info = null;
  function detect() {
    if (info) return info;
    const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 8;
    let gpu = '';
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      gpu = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : '';
    } catch {}
    const software = /swiftshader|llvmpipe|basic render|software/i.test(gpu);
    let budget = clamp(cores / 2, 2, 8);
    if (mem < 8) budget *= 0.75;
    if (software) budget = Math.min(budget, 1.5);
    const gpuName = gpu.replace(/ANGLE \(|\)$|Direct3D11.*|vs_\d.*|, D3D11.*/g, '').replace(/\s+/g, ' ').trim().split(',').slice(-1)[0].trim();
    info = { cores, mem, gpu: gpuName || 'Unknown graphics', software, budget };
    return info;
  }

  // load of one camera; o overrides { res, fps, vert, processed }
  function camLoad(cam, o = {}) {
    const res = o.res || cam.res, fps = +(o.fps || cam.fps);
    const r = RES[res] || RES['1080'];
    const live = !o.res && cam.actual && cam.alive;
    const w = live ? cam.actual.w : r.w, hh = live ? cam.actual.h : r.h, f = live && !o.fps ? cam.actual.fps : fps;
    const base = (w * hh * f) / (1920 * 1080 * 30);
    const processed = o.processed ?? (adjActive(cam.adj) || (cam.lut.name && cam.lut.bake));
    const vert = o.vert ?? cam.vert.on;
    const parts = { camera: base, preview: 0.05 * base, color: processed ? 0.5 * base : 0, vertical: vert ? 0.6 * base : 0 };
    return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts, w, h: hh, fps: f };
  }
  function outputLoad() {
    if (typeof vcamState === 'undefined' || !(vcamState.on || (outWin && !outWin.closed))) return 0;
    const [w, hh] = OUT_RES[program.res] || OUT_RES['720'];
    return (w * hh * program.fps) / (1920 * 1080 * 30) * (program.pipIdx >= 0 ? 0.8 : 0.5);
  }
  function total(extra = 0) {
    return cams.filter(c => c.deviceId && c.status !== 'idle').reduce((a, c) => a + camLoad(c).total, 0) + outputLoad() + extra;
  }
  function level(t = total()) {
    const pct = Math.round(t / detect().budget * 100);
    return { pct, state: pct > 100 ? 'over' : pct >= 75 ? 'heavy' : 'ok' };
  }
  function diskMbps() {
    return cams.filter(c => c.alive).reduce((a, c) => a + project.bitrate / 1e6 * (c.vert.on ? 1.6 : 1), 0);
  }
  function issues() {
    const out = [], lv = level();
    if (lv.state === 'over') out.push({ kind: 'bad', text: `About ${lv.pct}% of what this computer can comfortably handle. Expect dropped frames.` });
    else if (lv.state === 'heavy') out.push({ kind: 'warn', text: `About ${lv.pct}% of capacity. Fine for short takes; long ones may drop frames.` });
    const fourK = cams.filter(c => c.alive && c.actual && c.actual.h >= 2160);
    if (fourK.length >= 2) out.push({ kind: 'warn', text: `${fourK.length} cameras at 4K. If they share a USB port or hub, they can run out of bandwidth. Use separate ports.` });
    const mbps = diskMbps();
    if (mbps > 150) out.push({ kind: 'warn', text: `Writing about ${Math.round(mbps)} Mbps to disk. Record to an internal SSD, not a USB flash drive.` });
    if (detect().software) out.push({ kind: 'bad', text: 'Graphics acceleration is off in this browser, so every camera is drawn in software. Turn on hardware acceleration in Chrome or Edge settings.' });
    return out;
  }
  return { detect, camLoad, total, level, issues, diskMbps, outputLoad };
})();

// ---------- one-click fixes ----------
async function perfFix(kind) {
  if (recState.active) return toast('Stop recording first', 'err');
  const live = cams.filter(c => c.deviceId);
  if (kind === '1080') { for (const c of live) if (c.res === '2160') { c.res = '1080'; await openCam(c); } }
  if (kind === '30') { for (const c of live) if (c.fps > 30) { c.fps = 30; await openCam(c); } }
  if (kind === 'vert') live.forEach(c => { c.vert.on = false; paintTile(c); });
  saveCurrent(); renderAll(); paintLoad();
  toast(`Now at ${perf.level().pct}% of capacity`);
}

// ---------- warn before adding a camera ----------
function confirmAddCamera(label) {
  const pref = { res: store.get('prefRes', '1080'), fps: store.get('prefFps', 30) };
  const add = perf.camLoad({ res: pref.res, fps: pref.fps, adj: ADJ_DEFAULT, lut: {}, vert: {} }, { ...pref, processed: false, vert: false }).total;
  const after = perf.level(perf.total(add));
  if (after.state === 'ok') return Promise.resolve('add');
  const lighter = perf.level(perf.total(perf.camLoad({ adj: ADJ_DEFAULT, lut: {}, vert: {} }, { res: '720', fps: 30, processed: false, vert: false }).total));
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const d = openMenu(after.state === 'over' ? 'That may be too many cameras' : 'This computer is getting busy', `
      <div class="perfbar ${after.state}"><i style="width:${Math.min(100, after.pct)}%"></i></div>
      <p class="note" style="padding:8px 0 14px">Adding ${esc(shortName(label) || 'this camera')} at ${RES[pref.res].l} ${pref.fps} fps brings you to about <b>${after.pct}%</b> of what this computer can comfortably record.
      ${after.state === 'over' ? 'Previews may stutter and recordings may drop frames.' : 'Short takes should be fine.'}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${lighter.state !== 'over' ? `<button class="btn primary" data-v="720" style="justify-content:center">Add at 720p 30 fps (${lighter.pct}%)</button>` : ''}
        <button class="btn" data-v="add" style="justify-content:center">Add anyway</button>
        <button class="btn" data-v="cancel" style="justify-content:center">Cancel</button>
      </div>`, (body, dlg) => body.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { finish(b.dataset.v); dlg.close(); }));
    d.addEventListener('close', () => finish('cancel'), { once: true });
  });
}

// warn once when a settings change crosses into heavy/over
let lastState = 'ok';
function checkLoad(reason) {
  const lv = perf.level();
  const worse = { ok: 0, heavy: 1, over: 2 };
  if (worse[lv.state] > worse[lastState]) {
    toast(lv.state === 'over' ? `Load is now ${lv.pct}%. Expect dropped frames. Click the load meter for fixes.` : `Load is now ${lv.pct}%. Long takes may drop frames.`, lv.state === 'over' ? 'err' : '');
  }
  lastState = lv.state;
  paintLoad();
}

// toolbar meter
function paintLoad() {
  const el = $('#load'); if (!el) return;
  const lv = perf.level();
  el.hidden = !cams.some(c => c.alive);
  el.className = 'pill' + (lv.state === 'over' ? ' bad' : lv.state === 'heavy' ? ' warn' : '');
  el.innerHTML = `${icon('bolt', 'sm')}Load ${lv.pct}%`;
  el.title = 'Estimated load on this computer. Click for details.';
}

function openPerf() {
  const hw = perf.detect(), lv = perf.level(), list = cams.filter(c => c.deviceId);
  const tag = (t, on) => on ? `<span class="pill" style="height:20px;font-size:11px;padding:0 7px">${t}</span>` : '';
  const rows = list.map(c => {
    const l = perf.camLoad(c), share = Math.round(l.total / hw.budget * 100);
    return `<div class="r"><div class="lb">${esc(c.name)}<small>${l.w}×${l.h} · ${l.fps} fps</small></div>
      <span style="display:flex;gap:4px">${tag('Color', l.parts.color > 0)}${tag('9:16', l.parts.vertical > 0)}</span>
      <span style="font:12px var(--mono);color:var(--dim);width:44px;text-align:right">${share}%</span></div>`;
  }).join('') + (perf.outputLoad() ? `<div class="r"><div class="lb">Output<small>${vcamState.on ? 'Virtual camera' : 'Output window'} · ${program.res}p ${program.fps} fps</small></div><span style="font:12px var(--mono);color:var(--dim);width:44px;text-align:right">${Math.round(perf.outputLoad() / hw.budget * 100)}%</span></div>` : '') || '<div class="r"><div class="lb"><small>No cameras yet</small></div></div>';
  const iss = perf.issues();
  const has4k = list.some(c => c.res === '2160'), has60 = list.some(c => c.fps > 30), hasVert = list.some(c => c.vert.on);
  openMenu('Performance', `
    <div class="perfbar ${lv.state}"><i style="width:${Math.min(100, lv.pct)}%"></i></div>
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--dim);margin:6px 2px 12px"><span>${lv.state === 'ok' ? 'Comfortable' : lv.state === 'heavy' ? 'Busy' : 'Too much'}</span><span>${lv.pct}% of capacity</span></div>
    ${iss.map(i => `<div class="r" style="border:0;align-items:flex-start"><span style="color:var(--${i.kind === 'bad' ? 'rec' : 'warn'});padding-top:2px">${icon('warn', 'sm')}</span><div class="lb"><small style="color:var(--text);font-size:12.5px">${esc(i.text)}</small></div></div>`).join('')}
    ${ui.group('Cameras', rows)}
    ${has4k || has60 || hasVert ? ui.group('Quick fixes', `<div class="btns" style="margin:10px 0">
      ${has4k ? '<button class="btn" data-fix="1080">Use 1080p everywhere</button>' : ''}
      ${has60 ? '<button class="btn" data-fix="30">Use 30 fps everywhere</button>' : ''}
      ${hasVert ? '<button class="btn" data-fix="vert">Turn off 9:16 copies</button>' : ''}</div>`) : ''}
    <p class="note">This computer: ${hw.cores} CPU threads${navigator.deviceMemory ? `, ${hw.mem}+ GB memory` : ''}, ${esc(hw.gpu)}. Color adjustments, LUTs baked into the file and 9:16 copies each add work per camera. The estimate is a guide; the live frame-rate warnings show what's really happening.</p>`,
    (body, dlg) => body.querySelectorAll('[data-fix]').forEach(b => b.onclick = async () => { dlg.close(); await perfFix(b.dataset.fix); openPerf(); }));
}

// live watchdog: sustained frame drops while recording
let lowSince = 0, warnedLive = false;
setInterval(() => {
  paintLoad();
  if (!recState.active) { lowSince = 0; warnedLive = false; return; }
  const low = cams.filter(c => c.alive && c.health.low);
  if (!low.length) { lowSince = 0; return; }
  lowSince = lowSince || Date.now();
  if (!warnedLive && Date.now() - lowSince > 5000) {
    warnedLive = true;
    toast(`${low.map(c => c.name).join(' and ')} ${low.length > 1 ? 'are' : 'is'} dropping frames. Next take, try fewer cameras, 1080p or 30 fps.`, 'err');
  }
}, 1000);
