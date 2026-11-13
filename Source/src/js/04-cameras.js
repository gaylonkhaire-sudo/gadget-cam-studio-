// Cameras: devices, hardware controls, render loop, health, hot-plug, auto setup.
const RES = { '2160': { w: 3840, h: 2160, l: '4K' }, '1080': { w: 1920, h: 1080, l: '1080p' }, '720': { w: 1280, h: 720, l: '720p' } };
const HW = [
  ['exposureMode', 'Exposure mode'], ['exposureCompensation', 'Exposure comp'], ['exposureTime', 'Shutter'], ['iso', 'ISO / gain'],
  ['whiteBalanceMode', 'White balance'], ['colorTemperature', 'WB temperature'], ['focusMode', 'Focus'], ['focusDistance', 'Focus distance'],
  ['brightness', 'Brightness'], ['contrast', 'Contrast'], ['saturation', 'Saturation'], ['sharpness', 'Sharpness'],
  ['zoom', 'Optical zoom'], ['pan', 'Pan'], ['tilt', 'Tilt'], ['torch', 'Light / torch'], ['backgroundBlur', 'Background blur'],
];

let videoDevices = [], audioDevices = [], outputDevices = [];
const cams = [];
let selected = null;                         // { type: 'cam' | 'audio' | 'master', obj }

async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  videoDevices = all.filter(d => d.kind === 'videoinput');
  audioDevices = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications');
  outputDevices = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  bus.emit('devices');
  reconnectLost();
}

function newCam(cfg = {}) {
  const n = cams.length + 1;
  const cam = {
    id: uid(), name: cfg.name || `Camera ${n}`, deviceId: cfg.deviceId || '', label: cfg.label || '',
    res: cfg.res || store.get('prefRes', '1080'), fps: +(cfg.fps || store.get('prefFps', 30)),
    adj: { ...ADJ_DEFAULT, ...(cfg.adj || {}) }, hw: { ...(cfg.hw || {}) },
    lut: { name: '', amt: 1, bake: false, ...(cfg.lut || {}) }, vert: { on: false, x: 0, ...(cfg.vert || {}) }, fileName: cfg.fileName || '', naming: cfg.naming || null, preset: cfg.preset || '', audioSrc: cfg.audioSrc || 'mix',
    kind: cfg.kind || 'device', phoneId: cfg.phoneId || '', imgKey: cfg.imgKey || '', media: { loop: false, autoplay: false, syncRec: true, restart: false, ...(cfg.media || {}) },
    stream: null, alive: false, status: 'idle', comparing: false,
    health: { fps: 0, frames: 0, t: performance.now(), low: false },
    video: document.createElement('video'), canvas: document.createElement('canvas'), r: null, bgImg: null,
  };
  cam.video.muted = true; cam.video.playsInline = true; cam.video.autoplay = true;
  // the video must live in the page or Chrome won't hand us frames; the preview is drawn on the canvas
  let pool = $('#vidpool');
  if (!pool) { pool = h('<div id="vidpool" style="position:fixed;left:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none"></div>'); document.body.appendChild(pool); }
  pool.appendChild(cam.video);
  try { cam.r = makeRenderer(cam.canvas); } catch (e) { log('WebGL error: ' + e.message); }
  cams.push(cam);
  syncRenderers(cam);
  if (cam.adj.bgKey) idbGet('blobs', cam.adj.bgKey).then(b => b && setCamBg(cam, b, false));
  return cam;
}

function syncRenderers(cam) {
  const l = cam.lut.name && luts.get(cam.lut.name) || null;
  for (const r of [cam.r, cam.recR, cam.vertR]) if (r) { r.setLut(l); r.setBg(cam.bgImg); }
}

async function setCamBg(cam, blob, persist = true) {
  try {
    cam.bgImg = await createImageBitmap(blob);
    if (persist) { const key = cam.adj.bgKey || ('bg_' + uid()); await idbPut('blobs', key, blob); cam.adj.bgKey = key; cam.adj.bgMode = 'image'; }
    syncRenderers(cam); bus.emit('cam', cam);
  } catch (e) { toast('Could not load that image: ' + e.message, 'err'); }
}

function stopCam(cam) {
  cam.loop = null;
  if (cam.kind && cam.kind !== 'device') { cam.alive = false; return; }     // sources keep their stream/file
  if (cam.stream) cam.stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
  cam.stream = null; cam.video.srcObject = null; cam.alive = false;
}

async function openCam(cam) {
  if (cam.kind && cam.kind !== 'device') return openSource(cam);
  stopCam(cam);
  if (!cam.deviceId) { cam.status = 'idle'; bus.emit('cam', cam); return; }
  const r = RES[cam.res] || RES['1080'];
  cam.status = 'opening'; bus.emit('cam', cam);
  const base = { deviceId: { exact: cam.deviceId }, width: { ideal: r.w }, height: { ideal: r.h }, frameRate: { ideal: cam.fps } };
  try {
    try { cam.stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, pan: true, tilt: true, zoom: true } }); }
    catch { cam.stream = await navigator.mediaDevices.getUserMedia({ video: base }); }
  } catch (e) {
    cam.status = e.name === 'NotReadableError' ? 'busy' : 'error'; cam.error = e.message;
    bus.emit('cam', cam); return;
  }
  const track = cam.stream.getVideoTracks()[0];
  cam.label = track.label || cam.label;
  track.onended = () => { cam.alive = false; cam.status = 'lost'; bus.emit('camLost', cam); bus.emit('cam', cam); toast(`${cam.name} disconnected. Waiting for it to come back…`, 'err'); };
  cam.video.srcObject = cam.stream;
  cam.video.play().catch(() => {});
  if (cam.video.readyState < 2) await Promise.race([new Promise(r => cam.video.addEventListener('loadeddata', r, { once: true })), sleep(4000)]);
  cam.alive = true; cam.status = 'live';
  await applyHw(cam);
  startLoop(cam);
  const s = track.getSettings();
  cam.actual = { w: s.width, h: s.height, fps: Math.round(s.frameRate || cam.fps) };
  bus.emit('cam', cam);
  bus.emit('camBack', cam);
}

async function applyHw(cam) {
  const t = cam.stream && cam.stream.getVideoTracks()[0]; if (!t || !t.getCapabilities) return;
  const caps = t.getCapabilities();
  // modes must be applied before the values that depend on them
  const keys = Object.keys(cam.hw).sort((a, b) => (/Mode$/.test(b) ? 1 : 0) - (/Mode$/.test(a) ? 1 : 0));
  for (const k of keys) if (k in caps) await t.applyConstraints({ advanced: [{ [k]: cam.hw[k] }] }).catch(() => {});
}
async function setHw(cam, k, v) {
  const t = cam.stream && cam.stream.getVideoTracks()[0]; if (!t) return;
  try {
    const extra = {};
    if (k === 'exposureTime' || k === 'iso' || k === 'exposureCompensation') extra.exposureMode = 'manual';
    if (k === 'colorTemperature') extra.whiteBalanceMode = 'manual';
    if (k === 'focusDistance') extra.focusMode = 'manual';
    const caps = t.getCapabilities();
    for (const [ek, ev] of Object.entries(extra)) if (caps[ek] && caps[ek].includes(ev) && k !== ek) { await t.applyConstraints({ advanced: [{ [ek]: ev }] }); cam.hw[ek] = ev; }
    await t.applyConstraints({ advanced: [{ [k]: v }] });
    cam.hw[k] = v;
  } catch (e) { toast(`${cam.name}: ${k} not accepted (${e.message})`, 'err'); }
}
function hwInfo(cam) {
  const t = cam.stream && cam.stream.getVideoTracks()[0];
  if (!t || !t.getCapabilities) return [];
  const caps = t.getCapabilities(), set = t.getSettings();
  return HW.filter(([k]) => k in caps && caps[k] != null && !(Array.isArray(caps[k]) && caps[k].length < 2) && !(typeof caps[k] === 'object' && !Array.isArray(caps[k]) && caps[k].max === caps[k].min))
    .map(([k, label]) => ({ k, label, cap: caps[k], value: set[k] }));
}

// Render loop, driven by the camera's own frames
// the element frames come from: <video> for cameras, screens and clips; <img> for images
const srcEl = cam => cam.kind === 'image' ? cam.img : cam.video;
const srcReady = cam => cam.kind === 'image' ? !!(cam.img && cam.img.complete && cam.img.naturalWidth) : cam.video.readyState >= 2;

function previewWidth(cam) {
  const t = cam.tile;
  if (!t || !t.isConnected || t.classList.contains('hidden-v')) return 0;      // not on screen: skip
  return Math.max(320, Math.round((cam.canvas.clientWidth || 640) * (window.devicePixelRatio || 1)));
}

function startLoop(cam) {
  const token = cam.loop = {};
  let n = 0;
  const step = () => {
    if (cam.loop !== token || !(cam.stream || cam.kind === 'media' || cam.kind === 'image')) return;
    const v = srcEl(cam);
    if (srcReady(cam)) {
      const a = cam.adj; n++;
      const pw = document.hidden ? 0 : previewWidth(cam);
      const thumb = cam.tile && cam.tile.classList.contains('thumb');
      if (cam.r && pw && (!thumb || n % 2 === 0)) cam.r.draw(v, a, { lutAmt: cam.comparing ? 0 : cam.lut.amt, bypass: cam.comparing, overlays: true, maxW: pw });
      if (cam.recR) cam.recR.draw(v, a, { lutAmt: cam.lut.bake ? cam.lut.amt : 0, overlays: false });
      if (cam.vertR) cam.vertR.draw(v, a, { lutAmt: cam.lut.bake ? cam.lut.amt : 0, overlays: false, vertical: cam.vert });
      cam.health.frames++;
    }
    const now = performance.now(), hl = cam.health;
    if (now - hl.t >= 1000) {
      hl.fps = Math.round(hl.frames * 1000 / (now - hl.t)); hl.frames = 0; hl.t = now;
      const want = cam.actual ? cam.actual.fps : cam.fps;
      hl.low = cam.kind !== 'image' && cam.kind !== 'media' && !document.hidden && hl.fps < want * 0.85;
      if (recState.active && hl.low) cam.health.dropped = (cam.health.dropped || 0) + Math.max(0, want - hl.fps);
      bus.emit('health', cam);
    }
    // images have no frames of their own; video sources drive the loop with their real frame rate
    if (cam.kind === 'image' || (cam.kind === 'media' && v.paused)) setTimeout(step, 1000 / (cam.fps || 30));
    else if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(step);
  };
  step();
}

// Hot-plug: reopen cameras that dropped out once their device reappears
let reconnecting = false;
async function reconnectLost() {
  if (reconnecting) return; reconnecting = true;
  try {
    for (const cam of cams.filter(c => c.status === 'lost')) {
      const dev = videoDevices.find(d => d.deviceId === cam.deviceId) || videoDevices.find(d => cam.label && d.label === cam.label);
      if (dev) { cam.deviceId = dev.deviceId; log(`${cam.name} is back`); await openCam(cam); if (cam.alive) toast(`${cam.name} reconnected`); }
    }
  } finally { reconnecting = false; }
}
setInterval(() => { if (cams.some(c => c.status === 'lost')) refreshDevices(); }, 2000);

function removeCam(cam) {
  stopCam(cam);
  if (cam.kind && cam.kind !== 'device') releaseSource(cam);
  for (const r of [cam.r, cam.recR, cam.vertR]) r && r.destroy();
  cam.video.remove(); cam.tile && cam.tile.remove();
  cams.splice(cams.indexOf(cam), 1);
  if (selected && selected.obj === cam) selected = null;
  bus.emit('cams');
}

function serializeCam(c) {
  return { name: c.name, deviceId: c.deviceId, label: c.label, res: c.res, fps: c.fps, adj: { ...c.adj }, hw: { ...c.hw }, lut: { ...c.lut }, vert: { ...c.vert }, fileName: c.fileName || '', naming: c.naming || null, preset: c.preset || '', audioSrc: c.audioSrc || 'mix',
    kind: c.kind || 'device', phoneId: c.phoneId || '', imgKey: c.imgKey || '', media: c.media ? { ...c.media } : undefined };
}

// One-click setup: every camera at its best mode, sensible audio inputs with matched presets.
async function autoSetup() {
  await refreshDevices();
  cams.filter(c => !c.kind || c.kind === 'device').forEach(removeCam);
  audio.channels.filter(c => c.kind === 'device').forEach(c => audio.remove(c));
  const real = videoDevices.filter(d => !/virtual|obs|snap camera|xsplit|gadget cam studio/i.test(d.label));
  const list = real.length ? real : videoDevices;
  for (const d of list.slice(0, 6)) {
    const mem = recallDevice(d.label);
    const cam = newCam({ ...mem, deviceId: d.deviceId, label: d.label, name: mem.name || prettyCamName(d.label, cams.length + 1) });
    await openCam(cam);
    if (cam.alive && cam.actual && cam.actual.h < RES[cam.res].h) {
      cam.res = cam.actual.h >= 1080 ? '1080' : '720';        // camera can't do what we asked; settle on what it can
    }
  }
  // stay within what this computer can handle
  if (perf.level().state === 'over') {
    for (const c of cams) if (c.res === '2160') { c.res = '1080'; await openCam(c); }
    for (const c of cams) if (perf.level().state === 'over' && c.fps > 30) { c.fps = 30; await openCam(c); }
    for (const c of cams.slice().reverse()) if (perf.level().state === 'over' && c.res === '1080') { c.res = '720'; await openCam(c); }
    const lv = perf.level();
    toast(lv.state === 'over' ? `${cams.length} cameras is more than this computer can comfortably record (${lv.pct}%). Consider removing one.` : `Lowered camera settings to fit this computer (${lv.pct}% load)`, lv.state === 'over' ? 'err' : '');
  }
  const def = audioDevices.find(d => d.deviceId === 'default');
  const picks = [];
  const pro = audioDevices.filter(d => d.deviceId !== 'default' && /lark|wireless|studiolive|presonus|scarlett|focusrite|motu|interface|rode|shure|dji/i.test(d.label));
  if (pro.length) picks.push(...pro.slice(0, 3));
  else if (def) picks.push(audioDevices.find(d => d.deviceId !== 'default' && d.groupId === def.groupId) || def);
  else if (audioDevices[0]) picks.push(audioDevices[0]);
  for (const d of picks) await audio.addChannel({ kind: 'device', deviceId: d.deviceId, label: d.label, name: shortName(d.label) || 'Mic', s: withPreset(guessPreset(d.label)) });
  bus.emit('cams'); bus.emit('audio');
  log(`Auto setup: ${cams.length} camera(s), ${audio.channels.length} audio input(s)`);
  toast(`Set up ${cams.length} camera${cams.length === 1 ? '' : 's'} and ${audio.channels.length} audio input${audio.channels.length === 1 ? '' : 's'}`);
}
function prettyCamName(label, n) {
  const l = shortName(label);
  if (/camo/i.test(l)) return 'Camo';
  if (/cam link|capture|hdmi|usb video|uvc|elgato|magewell/i.test(l)) return `Camera ${n}`;
  return l ? l.replace(/\s*(webcam|camera)\s*/i, ' ').trim().slice(0, 20) || `Camera ${n}` : `Camera ${n}`;
}
