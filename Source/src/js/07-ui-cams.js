// Camera UI: preview tiles, sidebar list, camera inspector (Look · Adjust · Frame · Camera · Key).
let inspTab = store.get('inspTab', 'look');
const STATUS_TEXT = { idle: ['No camera selected', 'Pick a device in the inspector.'], opening: ['Opening…', ''],
  lost: ['Disconnected', 'Plug it back in and it reconnects on its own.'], busy: ['Camera in use', 'Close other apps using it (like OBS or Camo Studio preview), then click to retry.'],
  error: ['Could not open camera', ''] };

function select(type, obj) { selected = obj ? { type, obj } : null; bus.emit('select'); }
const isSel = o => selected && selected.obj === o;

// ---------- tiles ----------
function tileFor(cam) {
  if (cam.tile) return cam.tile;
  const t = h(`<div class="tile">
    <div class="ov tl"><span class="chip-o nm" title="Click to rename"></span></div>
    <div class="ov tr"><span class="chip-o green pg" hidden>OUTPUT</span><span class="chip-o red rc" hidden>● REC</span><span class="chip-o warn fpsw" hidden></span><span class="chip-o blue lutc" hidden></span></div>
    <div class="ov bl"><span class="chip-o mono info"></span></div>
    <div class="ov br"><button class="chip-o mplay" hidden title="Play or pause the clip">${icon('play', 'sm')}</button><button class="chip-o toout" title="Send this camera to the output (virtual camera)">${icon('camera', 'sm')} Output</button><button class="chip-o cmp" title="Hold to see the original">${icon('compare', 'sm')} Original</button></div>
    <div class="vguide" hidden></div>
    <div class="msg"></div></div>`);
  t.prepend(cam.canvas);
  t.addEventListener('pointerdown', e => { if (e.target.closest('.cmp,.toout')) return; if (view.mode === 'output') { setProgramCam(cam); applyView(); } select('cam', cam); });
  t.querySelector('.toout').addEventListener('click', e => { e.stopPropagation(); setProgramCam(cam); });
  t.querySelector('.mplay').addEventListener('click', e => { e.stopPropagation(); const v = cam.video; if (v.paused) { v.play(); startLoop(cam); } else v.pause(); setTimeout(() => paintTile(cam), 50); });
  t.querySelector('.nm').addEventListener('click', e => { if (t.classList.contains('thumb')) return; e.stopPropagation(); inlineRename(cam); });
  const cmp = t.querySelector('.cmp');
  const hold = on => { if (recState.active && !cam.recR) return; cam.comparing = on; };
  cmp.addEventListener('pointerdown', e => { e.stopPropagation(); hold(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => cmp.addEventListener(ev, () => hold(false)));
  t.querySelector('.msg').addEventListener('click', () => {
    if (['busy', 'error'].includes(cam.status)) openCam(cam);
    else if (cam.status === 'lost' && cam.kind === 'media') addVideoSource(cam);
    else if (cam.status === 'lost' && cam.kind === 'screen') addScreenSource(cam);
    else if (cam.status === 'lost' && cam.kind === 'image') addImageSource(cam);
    else if (cam.status === 'lost' && cam.kind === 'phone') openPhonePairing();
  });
  // drag to reposition when zoomed in
  let drag = null;
  cam.canvas.addEventListener('pointerdown', e => {
    if (cam.adj.zoom <= 100) return;
    drag = { x: e.clientX, y: e.clientY, px: cam.adj.panX, py: cam.adj.panY, w: cam.canvas.clientWidth, h: cam.canvas.clientHeight };
    cam.canvas.setPointerCapture(e.pointerId);
  });
  cam.canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const z = cam.adj.zoom / 100, k = 2 / (z - 1) * 100;
    cam.adj.panX = clamp(Math.round(drag.px - (e.clientX - drag.x) / drag.w * k), -100, 100);
    cam.adj.panY = clamp(Math.round(drag.py - (e.clientY - drag.y) / drag.h * k), -100, 100);
  });
  cam.canvas.addEventListener('pointerup', () => { if (drag) { drag = null; saveCurrent(); if (isSel(cam)) renderInspector(); } });
  // drop a LUT or a background image
  t.addEventListener('dragover', e => { e.preventDefault(); t.classList.add('drop'); });
  t.addEventListener('dragleave', () => t.classList.remove('drop'));
  t.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation(); t.classList.remove('drop');
    const files = [...e.dataTransfer.files];
    const img = files.find(f => f.type.startsWith('image/'));
    if (img) { await setCamBg(cam, img); cam.adj.key = true; toast(`Background set for ${cam.name}`); }
    const name = await importLuts(files.filter(f => /\.cube$/i.test(f.name)));
    if (name) { cam.lut.name = name; syncRenderers(cam); toast(`${name} applied to ${cam.name}`); }
    saveCurrent(); select('cam', cam);
  });
  cam.tile = t;
  return t;
}

function paintTile(cam) {
  const t = tileFor(cam);
  t.classList.toggle('sel', isSel(cam));
  t.classList.toggle('rec', recState.active && recState.segments.some(s => s.cam === cam && s.end == null));
  t.classList.toggle('grab', cam.adj.zoom > 100);
  const nmEl = t.querySelector('.nm'); if (!nmEl.querySelector('input')) nmEl.textContent = cam.name;
  t.querySelector('.rc').hidden = !t.classList.contains('rec');
  const mp = t.querySelector('.mplay'); mp.hidden = cam.kind !== 'media' || !cam.alive; if (!mp.hidden) mp.innerHTML = icon(cam.video.paused ? 'play' : 'pause', 'sm');
  t.querySelector('.pg').hidden = !(typeof progCam === 'function' && progCam() === cam && (vcamState.on || (outWin && !outWin.closed)));
  t.querySelector('.toout').hidden = typeof progCam === 'function' && progCam() === cam;
  const info = t.querySelector('.info');
  info.textContent = cam.alive && cam.actual ? `${cam.actual.w}×${cam.actual.h} · ${cam.health.fps || cam.actual.fps} fps${cam.vert.on ? ' · +9:16' : ''}` : '';
  info.parentElement.hidden = !cam.alive;
  const fw = t.querySelector('.fpsw'); fw.hidden = !(cam.alive && cam.health.low); fw.textContent = `${cam.health.fps} fps`;
  const lc = t.querySelector('.lutc'); lc.hidden = !cam.lut.name; lc.textContent = (cam.lut.bake ? 'LUT · rec ' : 'LUT · view ') ;
  const msg = t.querySelector('.msg');
  const LOST = { media: ['Video not loaded', 'Click to choose the video file again.'], screen: ['Not sharing', 'Click to share a screen or app again.'], image: ['Image missing', 'Click to choose an image.'], phone: ['Waiting for the phone', 'Open the camera page on the phone, or click to show the QR code.'] };
  const st = cam.status === 'lost' && LOST[cam.kind] ? LOST[cam.kind] : STATUS_TEXT[cam.status];
  msg.hidden = cam.status === 'live';
  if (st) msg.innerHTML = `<div><b>${st[0]}</b>${esc(cam.status === 'error' ? cam.error : st[1])}</div>`;
  const g = t.querySelector('.vguide');
  g.hidden = !cam.vert.on || !cam.alive;
  if (cam.vert.on && cam.actual) {
    const swap = (cam.adj.rot / 90) % 2 === 1, W = swap ? cam.actual.h : cam.actual.w, H = swap ? cam.actual.w : cam.actual.h;
    const cw = Math.min(1, (9 / 16) / (W / H)), left = clamp((1 - cw) / 2 + cam.vert.x / 100 * (1 - cw) / 2, 0, 1 - cw);
    g.style.cssText = `position:absolute;top:0;bottom:0;left:${left * 100}%;width:${cw * 100}%;box-shadow:0 0 0 9999px rgba(0,0,0,.45);border:1.5px solid rgba(255,255,255,.8);pointer-events:none;border-radius:2px`;
  }
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  cams.forEach(c => { grid.appendChild(tileFor(c)); paintTile(c); });
  const add = h(`<button class="addtile"><div>${icon('plus')}Add source</div></button>`);
  add.onclick = () => addCamMenu();
  grid.appendChild(add);
  grid.classList.toggle('one', cams.length === 1);
  applyView();
}

function renderCamList() {
  const list = $('#camList'); list.innerHTML = '';
  if (!cams.length) list.innerHTML = '<div class="empty-note">No cameras yet</div>';
  cams.forEach(c => {
    const sub = c.status === 'live' && c.actual ? (isSourceKind(c) ? `${SOURCE_KINDS[c.kind]} · ${c.actual.w}×${c.actual.h}` : `${RES[c.res] ? RES[c.res].l : ''} · ${c.actual.fps} fps`) : (STATUS_TEXT[c.status] || ['', ''])[0];
    const it = h(`<div class="item ${isSel(c) ? 'sel' : ''}"><span class="dot ${c.status}"></span>${icon({ phone: 'phone', media: 'play', image: 'compare', screen: 'layers' }[c.kind] || 'camera', 'sm')}
      <span class="grow">${esc(c.name)}<div class="sub">${esc(sub)}</div></span><button class="x" title="Remove">${icon('x', 'sm')}</button></div>`);
    it.onclick = e => { if (e.target.closest('.x')) { if (!recState.active) { removeCam(c); saveCurrent(); } return; } select('cam', c); };
    list.appendChild(it);
  });
}

function addCamMenu() {
  const used = new Set(cams.map(c => c.deviceId));
  const free = videoDevices.filter(d => !used.has(d.deviceId) && !/gadget cam studio/i.test(d.label));
  openMenu('Add a source', `<div class="cat" style="margin-top:0">Cameras</div>` + (free.length
    ? free.map(d => `<div class="item" data-id="${esc(d.deviceId)}">${icon('camera', 'sm')}<span class="grow">${esc(shortName(d.label) || 'Camera')}</span></div>`).join('')
    : '<div class="empty-note">Every connected camera is already added. Plug in another camera, capture card or start Camo.</div>') + `
    <div class="cat">More sources</div>
    <div class="item" data-src="phone">${icon('phone', 'sm')}<span class="grow">Phone<div class="sub">Camera or microphone over Wi-Fi (scan a QR code)</div></span></div>
    <div class="item" data-src="screen">${icon('layers', 'sm')}<span class="grow">Screen or app window<div class="sub">Games, browser, slides, any app</div></span></div>
    <div class="item" data-src="media">${icon('play', 'sm')}<span class="grow">Video file<div class="sub">For reactions and clips, with its sound in the mixer</div></span></div>
    <div class="item" data-src="image">${icon('compare', 'sm')}<span class="grow">Image<div class="sub">Title cards, logos, product shots</div></span></div>`,
    (body, dlg) => { body.querySelectorAll('[data-src]').forEach(el => el.onclick = () => { dlg.close();
      ({ phone: () => openPhonePairing(), screen: () => addScreenSource(), media: () => addVideoSource(), image: () => addImageSource() })[el.dataset.src](); });
      body.querySelectorAll('[data-id]').forEach(el => el.onclick = async () => {
      dlg.close();
      const d = videoDevices.find(x => x.deviceId === el.dataset.id);
      await sleep(50);
      const choice = await confirmAddCamera(d.label);
      if (choice === 'cancel') return;
      const mem = recallDevice(d.label);
      const name = mem.name || await askCamName(prettyCamName(d.label, cams.length + 1), d.label);
      const cam = newCam({ ...mem, deviceId: d.deviceId, label: d.label, name, ...(choice === '720' ? { res: '720', fps: 30 } : {}) });
      if (mem.name) toast(`Restored ${cam.name}’s last settings`);
      bus.emit('cams'); select('cam', cam); await openCam(cam); saveCurrent();
    }); });
}

// ---------- inspector ----------
function renderInspector() {
  const el = $('#insp');
  if (!selected) {
    el.innerHTML = `<div class="insp-empty"><div>${icon('sliders')}Select a camera or an audio input to adjust it.</div></div>`;
    return;
  }
  if (selected.type === 'cam') return renderCamInspector(el, selected.obj);
  if (selected.type === 'audio') return renderAudioInspector(el, selected.obj);
  if (selected.type === 'master') return renderMasterInspector(el);
  if (selected.type === 'program') return renderProgramInspector(el);
}

function camChanged(cam, k) {
  if (LOOK_KEYS.includes(k)) cam.adj.lookEdited = true;
  clearTimeout(camChanged.t); camChanged.t = setTimeout(checkLoad, 600);
  paintTile(cam);
  saveCurrentSoon();
}

function renderCamInspector(el, cam) {
  const scroll = el.querySelector('.insp-b') ? el.querySelector('.insp-b').scrollTop : 0;
  const tabs = [['look', 'Look'], ['adjust', 'Adjust'], ['frame', 'Frame'], ['camera', isSourceKind(cam) && cam.kind !== 'phone' ? SOURCE_KINDS[cam.kind] : 'Camera'], ['key', 'Key']];
  el.innerHTML = `<div class="insp-h">
      <div class="t">${icon('camera')}<input class="name" value="${esc(cam.name)}" spellcheck="false"><button class="btn presetbtn" title="Save or apply camera presets">${icon('layers', 'sm')} ${esc(cam.preset || 'Presets')}</button></div>
      <div class="s">${esc(shortName(cam.label) || 'No device')}${cam.actual && cam.alive ? ` · ${cam.actual.w}×${cam.actual.h} · ${cam.actual.fps} fps` : ''}</div>
      ${ui.seg('tab', tabs, inspTab, 'tabs')}</div>
    <div class="insp-b"></div>`;
  el.querySelector('.name').onchange = e => { cam.name = e.target.value.trim() || cam.name; bus.emit('cams'); saveCurrent(); };
  el.querySelector('.presetbtn').onclick = () => openCamPresets(cam);
  bindControls(el.querySelector('.insp-h'), { tab: inspTab }, (k, v) => { inspTab = v; store.set('inspTab', v); renderCamInspector(el, cam); });
  const b = el.querySelector('.insp-b');
  ({ look: camLookTab, adjust: camAdjustTab, frame: camFrameTab, camera: isSourceKind(cam) && cam.kind !== 'phone' ? sourceTab : camDeviceTab, key: camKeyTab }[inspTab] || camLookTab)(b, cam);
  if (inspTab === 'camera') {
    if (cam.kind === 'phone') { b.insertAdjacentHTML('afterbegin', phoneControlsHtml(cam)); wirePhoneControls(b, cam); }
    addCamAudioGroup(b, cam);
  }
  b.scrollTop = scroll;
}

function camLookTab(b, cam) {
  const a = cam.adj, mine = store.get('userLooks', {});
  const desc = LOOKS[a.look] ? LOOKS[a.look].desc : mine[a.look] ? 'Your saved look.' : 'Your own adjustments.';
  const card = (n, d, isMine) => `<button class="card ${a.look === n ? 'on' : ''}" data-look="${esc(n)}" title="${esc(d)}"><b>${esc(n)}</b><span>${esc(d)}</span>${isMine ? `<i class="del" data-del="1" title="Delete">${icon('x', 'sm')}</i>` : ''}</button>`;
  const lutOpts = [['', 'None'], ...[...luts.keys()].sort().map(n => [n, n]), ['__import', 'Import .cube…']];
  b.innerHTML = `
    <div class="now"><div><b>${esc(a.look)}${a.lookEdited ? '<em>EDITED</em>' : ''}</b><span>${esc(desc)}</span></div></div>
    <div class="cards">${Object.entries(LOOKS).map(([n, l]) => card(n, l.desc)).join('')}</div>
    <div class="cat">My looks</div>
    <div class="cards">${Object.keys(mine).map(n => card(n, 'Saved look', true)).join('') || '<div class="empty-note" style="grid-column:1/-1">None yet</div>'}</div>
    <div class="savebar"><input placeholder="Name this look" maxlength="28"><button class="btn primary">Save</button></div>
    ${ui.group('LUT', `
      ${ui.select('name', 'LUT', lutOpts, cam.lut.name)}
      ${ui.slider('amt', 'Strength', 0, 100, 1, Math.round(cam.lut.amt * 100), 100, pct)}
      ${ui.toggle('bake', 'Record with LUT', cam.lut.bake, 'Off keeps your file clean (S-Log) for grading. On burns the LUT into the recording.')}`,
      `<button data-act="luts">Manage</button>`)}
    <div class="btns"><button class="btn" data-act="copy">${icon('copy', 'sm')} Copy look to all cameras</button><button class="btn danger" data-act="reset">Reset all</button></div>`;
  b.querySelectorAll('[data-look]').forEach(c => c.onclick = e => {
    const n = c.dataset.look;
    if (e.target.closest('[data-del]')) { const m = store.get('userLooks', {}); delete m[n]; store.set('userLooks', m); return renderInspector(); }
    const vals = LOOKS[n] ? LOOKS[n].a : mine[n];
    Object.assign(a, vals, { look: n, lookEdited: false });
    paintTile(cam); saveCurrent(); renderInspector(); checkLoad();
  });
  const nameIn = b.querySelector('.savebar input');
  const saveLook = () => {
    const n = nameIn.value.trim(); if (!n) return nameIn.focus();
    if (LOOKS[n]) return toast('That name belongs to a built-in look', 'err');
    const m = store.get('userLooks', {}); m[n] = Object.fromEntries(LOOK_KEYS.map(k => [k, a[k]])); store.set('userLooks', m);
    a.look = n; a.lookEdited = false; saveCurrent(); renderInspector(); toast(`Saved look “${n}”`);
  };
  b.querySelector('.savebar button').onclick = saveLook;
  nameIn.onkeydown = e => { if (e.key === 'Enter') saveLook(); };
  const lutObj = { name: cam.lut.name, amt: Math.round(cam.lut.amt * 100), bake: cam.lut.bake };
  bindControls(b.querySelector('.group'), lutObj, async (k, v) => {
    if (k === 'name' && v === '__import') { const n = await pickLut(); lutObj.name = n || cam.lut.name; if (n) cam.lut.name = n; syncRenderers(cam); return renderInspector(); }
    if (k === 'name') { cam.lut.name = v; syncRenderers(cam); }
    if (k === 'amt') cam.lut.amt = v / 100;
    if (k === 'bake') cam.lut.bake = v;
    paintTile(cam); saveCurrentSoon(); checkLoad();
  });
  b.querySelector('[data-act=luts]').onclick = manageLuts;
  b.querySelector('[data-act=copy]').onclick = () => {
    cams.filter(c => c !== cam).forEach(c => { LOOK_KEYS.forEach(k => c.adj[k] = a[k]); c.adj.look = a.look; c.adj.lookEdited = a.lookEdited; c.lut = { ...cam.lut }; syncRenderers(c); paintTile(c); });
    saveCurrent(); toast('Look copied to every camera');
  };
  b.querySelector('[data-act=reset]').onclick = () => {
    Object.assign(cam.adj, { ...ADJ_DEFAULT, bgKey: cam.adj.bgKey }); cam.lut = { name: '', amt: 1, bake: false }; syncRenderers(cam);
    paintTile(cam); saveCurrent(); renderInspector();
  };
}

function camAdjustTab(b, cam) {
  const a = cam.adj, s = (k, l, min, max, f) => ui.slider(k, l, min, max, 1, a[k], 0, f || signed);
  b.innerHTML = `
    ${ui.group('Light', s('exposure', 'Exposure', -100, 100) + s('brightness', 'Brightness', -100, 100) + s('contrast', 'Contrast', -100, 100) + s('highlights', 'Highlights', -100, 100) + s('shadows', 'Shadows', -100, 100))}
    ${ui.group('Color', s('temp', 'Temperature', -100, 100) + s('tint', 'Tint', -100, 100) + s('saturation', 'Saturation', -100, 100) + s('vibrance', 'Vibrance', -100, 100) + s('hue', 'Hue', -180, 180))}
    ${ui.group('Detail & style', s('sharpness', 'Sharpness', 0, 100, pct) + s('vignette', 'Vignette', 0, 100, pct) + s('fade', 'Fade', 0, 100, pct) + s('split', 'Teal & orange', 0, 100, pct))}
    <div class="note">Double-click a slider to reset it. Hold “Original” on the preview to compare.</div>`;
  bindControls(b, a, k => camChanged(cam, k));
  setFmt(b, 'exposure', v => (v > 0 ? '+' : '') + (v / 50).toFixed(1) + ' EV');
  setFmt(b, 'hue', v => signed(v) + '°');
  setFmt(b, 'temp', v => v > 0 ? `Warmer ${v}` : v < 0 ? `Cooler ${-v}` : '0');
  setFmt(b, 'tint', v => v > 0 ? `Magenta ${v}` : v < 0 ? `Green ${-v}` : '0');
}

function camFrameTab(b, cam) {
  const a = cam.adj, v = cam.vert;
  b.innerHTML = `
    ${ui.group('Framing',
      ui.slider('zoom', 'Zoom', 100, 400, 1, a.zoom, 100, z => (z / 100).toFixed(2) + '×') +
      ui.slider('panX', 'Pan', -100, 100, 1, a.panX, 0, signed) +
      ui.slider('panY', 'Tilt', -100, 100, 1, a.panY, 0, signed) +
      ui.row('Rotate', ui.seg('rot', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], a.rot)) +
      ui.toggle('mirror', 'Mirror', a.mirror) + ui.toggle('flip', 'Flip upside down', a.flip))}
    <div class="note">When zoomed in, drag the preview to reposition. Rotate 90° to record vertical from a camera turned on its side.</div>
    ${ui.group('Vertical copy for Shorts',
      ui.toggle('on', 'Also record 9:16', v.on, 'Saves a second file cropped for Shorts, Reels and TikTok.') +
      ui.slider('x', 'Crop position', -100, 100, 1, v.x, 0, x => x === 0 ? 'Center' : x < 0 ? `Left ${-x}` : `Right ${x}`))}`;
  bindControls(b.querySelector('.group'), a, k => { camChanged(cam, k); if (k === 'zoom' && a.zoom <= 100) { a.panX = a.panY = 0; } });
  bindControls(b.querySelectorAll('.group')[1], v, () => { paintTile(cam); saveCurrentSoon(); checkLoad(); });
}

function camDeviceTab(b, cam) {
  const a = cam.adj, hw = hwInfo(cam);
  const devOpts = [['', 'None'], ...videoDevices.map(d => [d.deviceId, shortName(d.label) || 'Camera'])];
  const hwHtml = hw.map(({ k, label, cap, value }) => {
    if (Array.isArray(cap)) return ui.select(k, label, cap.map(m => [m, m[0].toUpperCase() + m.slice(1)]), value);
    if (typeof cap === 'boolean' || k === 'torch' || k === 'backgroundBlur') return ui.toggle(k, label, !!value);
    const step = cap.step || (cap.max - cap.min) / 100;
    return ui.slider(k, label, cap.min, cap.max, step, value ?? cap.min, value ?? cap.min, x => +(+x).toFixed(step < 1 ? 2 : 0));
  }).join('');
  b.innerHTML = `
    ${ui.group('Device',
      ui.select('deviceId', 'Camera', devOpts, cam.deviceId) +
      ui.row('Resolution', ui.seg('res', [['720', '720p'], ['1080', '1080p'], ['2160', '4K']], cam.res)) +
      ui.row('Frame rate', ui.seg('fps', [[24, '24'], [30, '30'], [60, '60']], cam.fps)))}
    ${ui.group('Camera controls', hwHtml || '<div class="r"><div class="lb"><small>This camera doesn’t expose hardware controls. Capture cards usually don’t, so set exposure and white balance on the camera itself, or use the Adjust tab.</small></div></div>')}
    ${ui.group('File name', `<div class="r"><div class="lb">${camNaming(cam) ? 'Own name' : 'Same as other cameras'}<small><span style="font-family:var(--mono)">${esc(fileBaseFor(cam))}.${EXT}</span>${cam.vert.on ? `<br>9:16 copy adds “_vertical”` : ''}</small></div><button class="btn" data-act="name">${camNaming(cam) ? 'Edit…' : 'Customize…'}</button></div>`)}
    ${ui.group('Monitoring', ui.toggle('zebra', 'Zebras', a.zebra, 'Stripes over areas that are too bright. Preview only.') + ui.toggle('peaking', 'Focus peaking', a.peaking, 'Highlights sharp edges in red. Preview only.'))}
    <div class="note">${cam.alive && cam.actual ? `Receiving ${cam.actual.w}×${cam.actual.h} at ${cam.health.fps || cam.actual.fps} fps.` : ''}</div>`;
  const groups = b.querySelectorAll('.group');
  b.querySelector('[data-act=name]').onclick = () => openNameBuilder({ title: `File name for ${cam.name}`, naming: camNaming(cam) || defaultNaming(), cam, allowDefault: true,
    onSave: nm => { cam.naming = nm; cam.fileName = ''; saveCurrent(); renderInspector(); } });
  const dev = { deviceId: cam.deviceId, res: cam.res, fps: cam.fps };
  bindControls(groups[0], dev, async (k, v) => {
    if (recState.active) { toast('Stop recording to change devices', 'err'); return renderInspector(); }
    if (k === 'deviceId') { const d = videoDevices.find(x => x.deviceId === v); cam.deviceId = v; cam.label = d ? d.label : ''; }
    if (k === 'res') cam.res = v;
    if (k === 'fps') cam.fps = +v;
    await openCam(cam); saveCurrent(); renderInspector(); checkLoad();
  });
  const hwObj = Object.fromEntries(hw.map(x => [x.k, x.value]));
  bindControls(groups[1], hwObj, (k, v) => { setHw(cam, k, v); saveCurrentSoon(); });
  bindControls(groups[3], a, () => saveCurrentSoon());
}

function camKeyTab(b, cam) {
  const a = cam.adj;
  b.innerHTML = `
    ${ui.group('Green screen',
      ui.toggle('key', 'Remove background', a.key, 'For a physical green or blue screen behind you.') +
      ui.row('Screen color', ui.seg('keyColor', [['green', 'Green'], ['blue', 'Blue']], a.keyColor)) +
      ui.slider('keySim', 'Similarity', 0, 100, 1, a.keySim, 50, pct) +
      ui.slider('keySmooth', 'Smoothness', 0, 100, 1, a.keySmooth, 25, pct) +
      ui.slider('keySpill', 'Spill removal', 0, 100, 1, a.keySpill, 60, pct))}
    ${ui.group('Background',
      ui.row('Use', ui.seg('bgMode', [['color', 'Color'], ['image', 'Image']], a.bgMode)) +
      ui.row('Color', `<input type="color" data-k="bgColor" value="${a.bgColor}">`) +
      ui.row('Image', `<button class="btn" data-act="img">${cam.bgImg ? 'Change…' : 'Choose…'}</button>`, 'Or drop an image onto the preview.'))}
    <div class="note">Raise Similarity until the screen disappears, then add Smoothness for softer edges. Even lighting on the screen gives the cleanest result.</div>`;
  bindControls(b, a, () => { paintTile(cam); saveCurrentSoon(); });
  b.querySelector('[data-act=img]').onclick = () => { const f = $('#fileImg'); f.onchange = async () => { if (f.files[0]) { await setCamBg(cam, f.files[0]); a.key = true; saveCurrent(); renderInspector(); } f.value = ''; }; f.click(); };
}

function pickLut() {
  return new Promise(res => {
    const f = $('#fileLut');
    f.onchange = async () => { const n = await importLuts([...f.files]); f.value = ''; res(n); };
    f.click();
  });
}
function manageLuts() {
  const draw = (body) => {
    body.innerHTML = ([...luts.values()].map(l => `<div class="item"><span class="grow">${esc(l.name)}<div class="sub">${l.size}³ cube</div></span><button class="x" data-del="${esc(l.name)}">${icon('x', 'sm')}</button></div>`).join('')
      || '<div class="empty-note">No LUTs yet. Sony’s S-Log3 to Rec.709 LUTs are a good start.</div>') +
      `<div class="btns" style="margin-top:12px"><button class="btn primary" data-imp>Import .cube files…</button></div>`;
    body.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => { await deleteLut(x.dataset.del); cams.forEach(c => { if (!luts.has(c.lut.name)) { c.lut.name = ''; syncRenderers(c); } }); draw(body); });
    body.querySelector('[data-imp]').onclick = async () => { await pickLut(); draw(body); };
  };
  openMenu('LUTs', '', body => draw(body));
}
