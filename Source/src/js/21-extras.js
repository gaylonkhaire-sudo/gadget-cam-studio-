// Titles (lower thirds) on the output, phone remote controls, per-camera audio choice, Phones settings, hotkeys, updates.

// ---------- titles ----------
const titles = { list: [], style: 'bar', align: 'left', color: '#0a84ff', autoHide: 8, size: 100, ...store.get('titles', {}) };
const saveTitles = () => store.set('titles', { ...titles, list: titles.list });
const titleLive = { id: null, t0: 0, out: 0, last: null, timer: null };
const ease = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

function showTitle(id) {
  const t = titles.list.find(x => x.id === id); if (!t) return;
  clearTimeout(titleLive.timer);
  Object.assign(titleLive, { id, t0: performance.now(), out: 0, last: id });
  if (titles.autoHide > 0) titleLive.timer = setTimeout(hideTitle, titles.autoHide * 1000);
  ensureLoop(); paintTitleButtons();
}
function hideTitle() {
  clearTimeout(titleLive.timer);
  if (titleLive.id && !titleLive.out) titleLive.out = performance.now();
  paintTitleButtons();
}
function toggleTitle() {
  if (titleLive.id && !titleLive.out) return hideTitle();
  const id = titleLive.last && titles.list.some(t => t.id === titleLive.last) ? titleLive.last : titles.list[0] && titles.list[0].id;
  if (!id) return toast('Add a title in the Output panel first', 'err');
  showTitle(id);
}
function paintTitleButtons() {
  $$('#insp [data-tshow]').forEach(b => { const on = b.dataset.tshow === titleLive.id && !titleLive.out; b.textContent = on ? 'Hide' : 'Show'; b.classList.toggle('primary', on); });
}

// drawn into the output (so it's in the virtual camera, output window and output recording)
function drawTitles(x, W, H) {
  if (!titleLive.id) return;
  const t = titles.list.find(q => q.id === titleLive.id); if (!t) { titleLive.id = null; return; }
  const now = performance.now(), anim = !motionOff();
  const pin = anim ? ease((now - titleLive.t0) / 450) : 1;
  const pout = titleLive.out ? (anim ? ease((now - titleLive.out) / 350) : 1) : 0;
  if (pout >= 1) { titleLive.id = null; titleLive.out = 0; paintTitleButtons(); return; }
  const k = pin * (1 - pout), sc = H / 1080 * titles.size / 100;
  const f1 = Math.round(54 * sc), f2 = Math.round(34 * sc), pad = Math.round(26 * sc), gap = Math.round(10 * sc);
  const font = '-apple-system, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
  x.save();
  x.font = `700 ${f1}px ${font}`; const w1 = x.measureText(t.l1 || '').width;
  x.font = `500 ${f2}px ${font}`; const w2 = t.l2 ? x.measureText(t.l2).width : 0;
  const bw = Math.max(w1, w2) + pad * 2 + (titles.style === 'clean' ? 0 : Math.round(10 * sc)), bh = f1 + (t.l2 ? f2 + gap : 0) + pad * 1.6;
  const mx = Math.round(W * 0.06), by = Math.round(H * 0.86 - bh);
  const bx = titles.align === 'center' ? Math.round((W - bw) / 2) : mx;
  const slide = (1 - k) * Math.round(-60 * sc) * (titles.align === 'center' ? 0 : 1), rise = (1 - k) * Math.round(24 * sc) * (titles.align === 'center' ? 1 : 0);
  x.globalAlpha = k; x.translate(slide, rise);
  const acc = titles.color || '#0a84ff', r = Math.round(14 * sc);
  const textX = bx + pad + (titles.style === 'clean' ? Math.round(14 * sc) : Math.round(10 * sc));
  if (titles.style === 'bar') {
    x.fillStyle = 'rgba(16,16,20,.78)'; x.beginPath(); x.roundRect(bx, by, bw * Math.min(1, pin * 1.15), bh, r); x.fill();
    x.fillStyle = acc; x.beginPath(); x.roundRect(bx, by, Math.round(8 * sc), bh, [r, 0, 0, r]); x.fill();
  } else if (titles.style === 'glass') {
    x.fillStyle = 'rgba(255,255,255,.2)'; x.strokeStyle = 'rgba(255,255,255,.45)'; x.lineWidth = Math.max(1, 2 * sc);
    x.beginPath(); x.roundRect(bx, by, bw * Math.min(1, pin * 1.15), bh, r * 1.4); x.fill(); x.stroke();
  } else if (titles.style === 'church') {
    const h1 = f1 + pad, h2 = t.l2 ? f2 + pad * .8 : 0;
    x.fillStyle = acc; x.fillRect(bx, by, Math.max(w1 + pad * 2.4, 0) * Math.min(1, pin * 1.2), h1);
    if (t.l2) { x.fillStyle = 'rgba(255,255,255,.94)'; x.fillRect(bx, by + h1, (w2 + pad * 2.4) * Math.min(1, pin * 1.1), h2); }
    x.textBaseline = 'middle';
    x.fillStyle = '#fff'; x.font = `700 ${f1}px ${font}`; x.fillText(t.l1 || '', bx + pad * 1.2, by + h1 / 2);
    if (t.l2) { x.fillStyle = '#1c1c1e'; x.font = `500 ${f2}px ${font}`; x.fillText(t.l2, bx + pad * 1.2, by + h1 + h2 / 2); }
    x.restore(); return;
  } else {                                                   // clean: text with a soft shadow and a thin accent line
    x.fillStyle = acc; x.fillRect(bx, by + pad * .5, Math.round(6 * sc), bh - pad);
    x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = 18 * sc; x.shadowOffsetY = 2 * sc;
  }
  x.textBaseline = 'top';
  x.fillStyle = titles.style === 'glass' ? '#fff' : '#fff';
  x.font = `700 ${f1}px ${font}`; x.fillText(t.l1 || '', textX, by + pad * .8);
  if (t.l2) { x.fillStyle = 'rgba(255,255,255,.82)'; x.font = `500 ${f2}px ${font}`; x.fillText(t.l2, textX, by + pad * .8 + f1 + gap); }
  x.restore();
}
const titlesAnimating = () => !!titleLive.id;

function titlesGroupHtml() {
  const rows = titles.list.map(t => `<div class="trow" data-tid="${t.id}">
      <div class="tin"><input class="l1" value="${esc(t.l1)}" placeholder="Name or heading" maxlength="60"><input class="l2" value="${esc(t.l2 || '')}" placeholder="Second line (optional)" maxlength="80"></div>
      <div class="tbtns"><button class="btn" data-tshow="${t.id}">Show</button><button class="x" data-tdel="${t.id}" title="Delete">${icon('x', 'sm')}</button></div></div>`).join('');
  return ui.group('Titles',
    (rows || '<div class="empty-note" style="padding:8px 0">No titles yet. Add names, scripture or topics.</div>') +
    `<div class="btns" style="margin:8px 0"><button class="btn" data-act="tadd">＋ Add title</button></div>` +
    ui.row('Style', ui.seg('style', [['bar', 'Bar'], ['clean', 'Clean'], ['glass', 'Glass'], ['church', 'Classic']], titles.style)) +
    ui.row('Position', ui.seg('align', [['left', 'Left'], ['center', 'Center']], titles.align)) +
    ui.row('Hide after', ui.seg('autoHide', [[0, 'Never'], [5, '5 s'], [8, '8 s'], [15, '15 s']], titles.autoHide)) +
    ui.slider('size', 'Size', 60, 160, 5, titles.size, 100, pct) +
    `<div class="r"><div class="lb">Accent color</div><input type="color" class="tcolor" value="${esc(titles.color)}"></div>`);
}
function wireTitles(el) {
  const g = [...el.querySelectorAll('.group')].find(x => x.querySelector('[data-act=tadd]')); if (!g) return;
  g.querySelector('[data-act=tadd]').onclick = () => { titles.list.push({ id: uid(), l1: '', l2: '' }); saveTitles(); renderInspector(); setTimeout(() => { const i = $$('#insp .trow .l1').pop(); if (i) i.focus(); }, 50); };
  g.querySelectorAll('.trow').forEach(row => {
    const t = titles.list.find(x => x.id === row.dataset.tid);
    row.querySelector('.l1').oninput = e => { t.l1 = e.target.value; saveTitles(); };
    row.querySelector('.l2').oninput = e => { t.l2 = e.target.value; saveTitles(); };
  });
  g.querySelectorAll('[data-tshow]').forEach(b => b.onclick = () => { const id = b.dataset.tshow; if (titleLive.id === id && !titleLive.out) hideTitle(); else showTitle(id); });
  g.querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => { titles.list = titles.list.filter(x => x.id !== b.dataset.tdel); if (titleLive.id === b.dataset.tdel) titleLive.id = null; saveTitles(); renderInspector(); });
  g.querySelector('.tcolor').oninput = e => { titles.color = e.target.value; saveTitles(); };
  bindControls(g, titles, () => saveTitles());
  paintTitleButtons();
}

// ---------- which audio goes into each camera's file ----------
function camAudioOptions() {
  return [['mix', 'Full mix'], ...audio.channels.map(c => [audio.keyOf(c), c.name + ' only']), ['none', 'No audio']];
}
function addCamAudioGroup(b, cam) {
  const opts = camAudioOptions(), cur = cam.audioSrc || 'mix';
  if (!opts.some(o => o[0] === cur)) opts.splice(opts.length - 1, 0, [cur, 'Saved input (not connected)']);
  b.insertAdjacentHTML('beforeend', ui.group('Audio in this file', ui.select('audioSrc', 'Sound', opts, cur, 'Full mix puts every mic in. Pick one mic to give this camera its own audio, like each person’s lav on their own camera.')));
  const g = [...b.querySelectorAll('.group')].pop();
  bindControls(g, cam, () => { saveCurrentSoon(); toast(cam.audioSrc === 'mix' ? `${cam.name}: full mix` : cam.audioSrc === 'none' ? `${cam.name}: no audio` : `${cam.name}: ${opts.find(o => o[0] === cam.audioSrc)[1]}`); });
}

// ---------- phone remote controls (camera tab for phones) ----------
function phoneControlsHtml(cam) {
  const p = phoneOf(cam), c = p && p.caps;
  if (!p) return '';
  if (!c || !c.devices) return ui.group('Phone', `<div class="r"><div class="lb">${esc(p.name)}<small>Waiting for the phone…</small></div></div>`);
  const q = [['2160-30', '4K 30'], ['1080-60', '1080p 60'], ['1080-30', '1080p 30'], ['720-30', '720p 30']];
  return ui.group('Phone', `<div class="r"><div class="lb">${esc(p.name)}<small id="phoneStats">${esc(phoneStatsText(p))}</small></div></div>` +
    (c.devices.length > 1 ? ui.select('deviceId', 'Lens', c.devices.map(d => [d.id, d.label]), c.deviceId) : '') +
    ui.row('Quality', ui.seg('quality', q, c.quality)) +
    (c.zoom ? ui.slider('zoom', 'Zoom', c.zoom.min, c.zoom.max, c.zoom.step, c.zoom.value, c.zoom.min, v => (+v).toFixed(1) + '×') : '') +
    (c.torch ? ui.toggle('torch', 'Flashlight', c.torchOn) : '') +
    ui.toggle('mic', 'Send phone mic', c.mic, 'Adds the phone’s microphone to the mixer'));
}
function wirePhoneControls(b, cam) {
  const g = [...b.querySelectorAll('.group')].find(x => x.querySelector('#phoneStats')); if (!g) return;
  const c = phoneOf(cam).caps, state = { deviceId: c.deviceId, quality: c.quality, zoom: c.zoom ? c.zoom.value : 1, torch: c.torchOn, mic: c.mic };
  let zt = 0;
  bindControls(g, state, (k, v) => {
    if (k === 'zoom') { clearTimeout(zt); zt = setTimeout(() => phoneCmd(cam, { zoom: +v }), 60); return; }
    phoneCmd(cam, { [k]: k === 'torch' || k === 'mic' ? !!v : v });
    if (k === 'quality' || k === 'deviceId') toast('Switching on the phone…');
  });
}

// ---------- Settings: Phones, Backup, Recording extras, Updates ----------
function extraSettingsHtml() {
  const allowed = allowedPhones(), ids = Object.keys(allowed);
  const p = project;
  return `
    ${ui.group('Audio files & sync',
      ui.toggle('micFiles', 'Save each mic as its own file', p.micFiles, '24-bit WAV per audio input, lined up with the video. Edit each voice separately.') +
      ui.toggle('syncBeep', 'Sync beep', p.syncBeep, 'A short beep one second in, in every file, so cameras and mics line up instantly') +
      ui.toggle('chapters', 'Chapters from markers', p.chapters, 'Name your markers after a take and get a YouTube chapters file'))}
    ${ui.group('Backup copy',
      `<div class="r"><div class="lb">${backupOn() ? esc(backup.name) : backup.kind === 'fsa' ? esc(backup.name) + ' (needs permission)' : 'Off'}<small>A second copy of every file, written at the same time. Use another drive.</small></div>
        <span style="display:flex;gap:6px">${backup.kind !== 'none' ? '<button class="btn" id="bkOff">Turn off</button>' : ''}<button class="btn" id="bkPick">${backup.kind !== 'none' ? 'Change…' : 'Choose…'}</button></span></div>`)}
    ${NATIVE ? ui.group('Phones',
      ui.toggle('pairAtStartup', 'Show pairing when the app opens', store.get('pairAtStartup', true)) +
      ui.toggle('askNewPhones', 'Ask before a new phone joins', store.get('askNewPhones', true), 'Allowed phones always reconnect on their own') +
      (ids.length ? ids.map(id => `<div class="r"><div class="lb">${esc(allowed[id].name || 'Phone')}<small>Allowed ${new Date(allowed[id].at || Date.now()).toLocaleDateString()}</small></div><button class="btn" data-unphone="${esc(id)}">Remove</button></div>`).join('')
        : '<div class="r"><div class="lb"><small>No phones allowed yet</small></div></div>') +
      `<div class="btns" style="margin:8px 0"><button class="btn" id="phPair">Pair a phone…</button><button class="btn" id="phNew">New code</button></div>`) : ''}
    ${NATIVE ? ui.group('Updates', `<div class="r"><div class="lb">Gadget Cam Studio <span id="appVer"></span><small id="updState">Updates install automatically when you quit.</small></div><button class="btn" id="updBtn">Check now</button></div>`) : ''}`;
}
function wireExtraSettings(body) {
  const g = name => [...body.querySelectorAll('.group')].find(x => x.previousElementSibling && x.previousElementSibling.textContent.trim().toLowerCase() === name.toLowerCase());
  const af = g('Audio files & sync'); if (af) bindControls(af, project, () => saveProject());
  const pk = body.querySelector('#bkPick'); if (pk) pk.onclick = async () => { await chooseBackup(); refreshSettings(); };
  const off = body.querySelector('#bkOff'); if (off) off.onclick = async () => { await clearBackup(); refreshSettings(); };
  const ph = g('Phones');
  if (ph) {
    const prefs = { pairAtStartup: store.get('pairAtStartup', true), askNewPhones: store.get('askNewPhones', true) };
    bindControls(ph, prefs, (k, v) => store.set(k, v));
    ph.querySelectorAll('[data-unphone]').forEach(b => b.onclick = () => { const a = allowedPhones(); delete a[b.dataset.unphone]; store.set('allowedPhones', a); refreshSettings(); toast('Phone removed. It will need to be allowed again.'); });
    body.querySelector('#phPair').onclick = () => { $('#settings').close(); openPhonePairing(); };
    body.querySelector('#phNew').onclick = async () => { phoneInfo = await NATIVE.phoneReset(); try { phoneES && phoneES.close(); } catch {} phoneES = null; listenPhones(); toast('New pairing code made'); };
  }
  if (NATIVE && NATIVE.appVersion) {
    NATIVE.appVersion().then(v => { const e = body.querySelector('#appVer'); if (e) e.textContent = v; });
    paintUpdate();
    body.querySelector('#updBtn').onclick = async () => {
      if (update.state === 'ready') return installUpdate();
      const r = await NATIVE.checkUpdates(); update = { ...update, ...r }; paintUpdate();
    };
  }
}
function refreshSettings() { const d = $('#settings'); if (d && d.open) { const sc = $('#settingsBody').scrollTop; d.close(); openSettings(); $('#settingsBody').scrollTop = sc; } }

// ---------- updates ----------
let update = { state: 'idle' };
function paintUpdate() {
  const s = $('#updState'), b = $('#updBtn'); if (!s) return;
  const txt = { idle: 'Updates install automatically when you quit.', checking: 'Checking…', current: 'You’re up to date.', downloading: `Downloading ${update.version || 'update'}${update.percent != null ? ` · ${update.percent}%` : ''}…`,
    ready: `Version ${update.version} is ready.`, error: 'Couldn’t check: ' + (update.message || 'unknown error'), dev: 'Updates work in the installed app.', unavailable: 'Updates aren’t set up in this build.' }[update.state] || '';
  s.textContent = txt; b.textContent = update.state === 'ready' ? 'Restart & update' : 'Check now'; b.classList.toggle('primary', update.state === 'ready');
}
function installUpdate() {
  if (recState.active) return toast('Stop recording first', 'err');
  NATIVE.installUpdate();
}
if (NATIVE && NATIVE.onUpdate) NATIVE.onUpdate(u => {
  const was = update.state; update = { ...update, ...u }; paintUpdate();
  if (u.state === 'ready' && was !== 'ready') toast(`Update ${u.version} downloaded. It installs when you quit, or restart from Settings.`);
});
