// Shell: toolbar, sidebar (setups, folder), settings sheet, countdown, health, shortcuts, autosave.

// ---------- autosave + setups ----------
const snapshot = () => ({ cams: cams.map(serializeCam), audio: audio.serialize() });
function saveCurrent() { store.set('current', snapshot()); rememberDevices(); }
let _saveT = 0;
function saveCurrentSoon() { clearTimeout(_saveT); _saveT = setTimeout(saveCurrent, 400); }

async function applySnapshot(cfg) {
  await refreshDevices();
  cams.slice().forEach(removeCam);
  for (const c of cfg.cams || []) {
    const dev = videoDevices.find(d => d.deviceId === c.deviceId) || videoDevices.find(d => c.label && d.label === c.label);
    const cam = newCam({ ...c, deviceId: dev ? dev.deviceId : '' });
    if (!dev && c.deviceId) { cam.status = 'lost'; }
  }
  bus.emit('cams');
  await Promise.all(cams.filter(c => (c.deviceId && c.status !== 'lost') || c.kind === 'image').map(openCam));
  cams.filter(c => c.kind === 'media' || c.kind === 'screen' || c.kind === 'phone').forEach(c => { c.status = 'lost'; });
  await audio.load(cfg.audio || {}, audioDevices);
  bus.emit('cams'); bus.emit('audio');
}

function renderSetups() {
  const list = $('#setups'), all = store.get('setups', {}), active = store.get('activeSetup', '');
  list.innerHTML = Object.keys(all).length ? '' : '<div class="empty-note">None yet</div>';
  Object.keys(all).forEach(n => {
    const it = h(`<div class="item ${n === active ? 'sel' : ''}">${icon('layers', 'sm')}<span class="grow">${esc(n)}<div class="sub">${all[n].cams.length} cam · ${(all[n].audio.channels || []).length} audio</div></span><button class="x" title="Delete">${icon('x', 'sm')}</button></div>`);
    it.onclick = async e => {
      if (e.target.closest('.x')) { delete all[n]; store.set('setups', all); if (active === n) store.set('activeSetup', ''); return renderSetups(); }
      if (recState.active) return toast('Stop recording to switch setups', 'err');
      store.set('activeSetup', n); renderSetups();
      toast(`Loading “${n}”…`);
      await applySnapshot(all[n]); saveCurrent(); select(null);
    };
    list.appendChild(it);
  });
}
function saveSetupDialog() {
  const active = store.get('activeSetup', '');
  openMenu('Save setup', `
    <p class="note" style="padding:0 0 10px">Saves your cameras, looks, LUTs, framing and audio so you can switch to it in one click.</p>
    <div class="savebar" style="margin:0"><input id="setupName" placeholder="YouTube unboxing, Sunday service…" value="${esc(active)}" maxlength="32"><button class="btn primary" id="setupSave">Save</button></div>`,
    (body, dlg) => {
      const inp = body.querySelector('#setupName'); setTimeout(() => inp.select(), 50);
      const go = () => {
        const n = inp.value.trim(); if (!n) return inp.focus();
        const all = store.get('setups', {}); all[n] = snapshot(); store.set('setups', all); store.set('activeSetup', n);
        dlg.close(); renderSetups(); toast(`Saved setup “${n}”`);
      };
      body.querySelector('#setupSave').onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    });
}

function renderFolder() {
  const row = $('#folderRow');
  const needs = folder.kind === 'fsa' && !folder.granted;
  row.innerHTML = `${icon('folder', 'sm')}<span class="grow">${esc(folder.name)}<div class="sub">${folder.kind === 'downloads' ? 'Choose folder' : 'Save folder'}</div></span>`;
  row.onclick = chooseFolder;
}

// ---------- toolbar ----------
function paintToolbar() {
  const rb = $('#rec');
  rb.classList.toggle('on', recState.active);
  rb.classList.toggle('counting', recState.counting);
  rb.disabled = recState.stopping || (!recState.active && !cams.some(c => c.alive));
  rb.title = recState.active ? 'Stop (Space)' : 'Record (Space)';
  $('#timer').classList.toggle('on', recState.active);
  $('#tMark').disabled = !recState.active;
  $('#tMark').innerHTML = icon('flag') + (recState.markers.length ? `<span style="font-size:12px;font-weight:600">${recState.markers.length}</span>` : '');
  const oa = $('#onair');
  if (oa) { oa.hidden = !vcamState.on; oa.className = 'pill'; oa.style.cssText = 'background:var(--ok);color:#fff;font-weight:600'; oa.innerHTML = icon('camera', 'sm') + 'Virtual cam on'; oa.onclick = () => select('program', program); }
}
let freeBytes = null;
async function pollFree() { if (NATIVE && folder.kind === 'native') { try { freeBytes = await NATIVE.freeSpace(); } catch { freeBytes = null; } } }
setInterval(pollFree, 5000);
setInterval(() => {
  $('#timer').textContent = fmtTime(recState.active ? performance.now() - recState.start : 0);
  const hl = recHealth(), pill = $('#health');
  const dropping = cams.filter(c => c.alive && c.health.low);
  const lost = cams.filter(c => c.status === 'lost');
  let cls = 'pill', txt;
  if (recState.active) {
    txt = fmtBytes(hl.bytes);
    if (freeBytes != null) { const left = freeBytes / Math.max(1, hl.perSec); txt += ` · ${fmtDur(left)} left`; if (left < 600) cls += ' bad'; else if (left < 1800) cls += ' warn'; }
  } else {
    txt = cams.some(c => c.alive) ? `${fmtBytes(hl.perHour)} per hour` : 'Ready';
    if (freeBytes != null && cams.some(c => c.alive)) txt += ` · ${fmtBytes(freeBytes)} free`;
  }
  if (lost.length) { cls = 'pill bad'; txt = `${lost[0].name} disconnected`; }
  else if (dropping.length) { cls = 'pill warn'; txt = `${dropping[0].name}: ${dropping[0].health.fps} fps`; }
  pill.className = cls; pill.innerHTML = icon(lost.length || dropping.length ? 'warn' : 'drive', 'sm') + esc(txt);
}, 500);

bus.on('countdown', n => { const c = $('#countdown'); c.classList.toggle('on', n > 0); if (n > 0) { const b = c.querySelector('b'); b.textContent = n; b.style.animation = 'none'; b.offsetHeight; b.style.animation = ''; } paintToolbar(); });

// ---------- settings ----------
function openSettings() {
  const p = project;
  const prefs = { prefRes: store.get('prefRes', '1080'), prefFps: store.get('prefFps', 30) };
  $('#settingsBody').innerHTML = `
    ${ui.group('Project',
      ui.row('Name', `<input type="text" data-k="name" value="${esc(p.name)}">`, 'Used in every file name') +
      ui.row('Next take', `<input type="number" data-k="take" value="${p.take}" min="1" style="width:80px">`) +
      ui.row('File names', `<button class="btn" id="nameEdit">Edit…</button>`, `<span id="namePrev" style="font-family:var(--mono)">${esc(previewName(defaultNaming()))}.${EXT}</span>`))}
    ${ui.group('Recording',
      ui.row('Quality', ui.seg('bitrate', [[8000000, 'Good'], [16000000, 'High'], [35000000, 'Max']], p.bitrate), '8, 16 or 35 Mbps per camera') +
      ui.row('Countdown', ui.seg('countdown', [[0, 'Off'], [3, '3 s'], [5, '5 s'], [10, '10 s']], p.countdown)) +
      ui.row('File format', `<span class="note keep" style="padding:0">${EXT.toUpperCase()} · ${esc((MIME.match(/codecs=([^,]+)/) || [, 'default'])[1])}</span>`))}
    ${ui.group('New cameras',
      ui.row('Resolution', ui.seg('prefRes', [['720', '720p'], ['1080', '1080p'], ['2160', '4K']], prefs.prefRes)) +
      ui.row('Frame rate', ui.seg('prefFps', [[24, '24'], [30, '30'], [60, '60']], prefs.prefFps)))}
    ${NATIVE ? ui.group('Finishing (Windows app)',
      ui.toggle('finalize', 'Finish files for editing', p.finalize, 'Converts each file to constant frame rate with FFmpeg after you stop, so Resolve stays in sync') +
      ui.row('Codec', ui.seg('codec', [['h264', 'H.264'], ['h265', 'H.265']], p.codec), 'Uses your graphics hardware when available'))
      : ui.group('Windows app', ui.row('Browser version', '', 'Install the Windows app for constant frame rate files, H.265, free-space tracking, system audio without screen sharing and global hotkeys.'))}
    ${ui.group('Appearance',
      ui.row('Style', ui.seg('style', [['glass', 'Liquid glass'], ['classic', 'Classic']], appearance.style)) +
      ui.toggle('ambient', 'Ambient glow', appearance.ambient, 'Soft color from your main camera behind the panels') +
      ui.toggle('solid', 'Reduce transparency', appearance.solid, 'Solid panels. Easier to read and lighter on older computers') +
      ui.toggle('motion', 'Animations', appearance.motion, 'Smooth motion across the app, plus the live voice view in the EQ') +
      ui.toggle('tips', 'Show tips', appearance.tips, 'Show short explanations under settings and in panels'))}
    ${ui.group('Presets', `<div class="r"><div class="lb">Move presets between computers<small>Camera presets, looks, audio presets and setups in one file</small></div><button class="btn" id="pExp">Export</button><button class="btn" id="pImp">Import</button></div>`)}
    ${ui.group('Performance', `<div class="r"><div class="lb">Load on this computer<small>${perf.level().pct}% of capacity with your current cameras</small></div><button class="btn" id="perfOpen">Details</button></div>`)}
    ${extraSettingsHtml()}
    ${ui.group('Keyboard', `<div class="keys" style="padding:10px 0"><kbd>Space</kbd><span>Record / stop</span><kbd>M</kbd><span>Add marker</span><kbd>Esc</kbd><span>Cancel countdown</span><kbd>T</kbd><span>Teleprompter</span><kbd>1–9</kbd><span>Put a camera on the output</span><kbd>L</kbd><span>Switch preview layout</span></div>${NATIVE ? `<div class="cat" style="margin:4px 0 0">From any app</div><div class="keys" style="padding:6px 0 10px"><kbd>Ctrl+Shift+R</kbd><span>Record / stop</span><kbd>Ctrl+Shift+M</kbd><span>Add marker</span></div>` : ''}`)}
    ${ui.group('Activity', '<div id="activity" style="padding:8px 0"></div>')}`;
  const act = $('#activity'); activity.slice(0, 80).forEach(a => act.appendChild(h(`<div><time>${a.t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>${esc(a.msg)}</div>`)));
  const groups = $$('#settingsBody .group');
  bindControls(groups[0], p, () => saveProject());
  bindControls(groups[1], p, () => saveProject());
  bindControls(groups[2], prefs, (k, v) => store.set(k, v));
  if (NATIVE) bindControls(groups[3], p, () => saveProject());
  $('#perfOpen').onclick = () => { $('#settings').close(); openPerf(); };
  $('#nameEdit').onclick = () => openNameBuilder({ title: 'File names for every camera', naming: defaultNaming(),
    onSave: nm => { project.naming = nm; project.filePattern = ''; saveProject(); $('#namePrev').textContent = previewName(defaultNaming()) + '.' + EXT; if (selected && selected.type === 'cam') renderInspector(); toast('File names updated'); } });
  bindControls($$('#settingsBody .group').find(g => g.querySelector('[data-seg=style]')), appearance, () => applyAppearance());
  wireExtraSettings($('#settingsBody'));
  $('#pExp').onclick = exportPresets; $('#pImp').onclick = () => importPresets();
  $('#settings').showModal();
}

// ---------- shortcuts ----------
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); requestRecord(); }
  else if (e.key === 'm' || e.key === 'M') addMarker();
  else if (e.key === 't' || e.key === 'T') openPrompter();
  else if (e.key === 'Escape' && recState.counting) { recState.counting = false; bus.emit('countdown', 0); }
});
window.addEventListener('beforeunload', e => { if (recState.active) { e.preventDefault(); e.returnValue = ''; } });
if (NATIVE && NATIVE.onHotkey) NATIVE.onHotkey(k => { if (k === 'record') requestRecord(); if (k === 'marker') addMarker(); });

// ---------- wiring ----------
function renderAll() { renderMixBar(); renderSetups(); renderCamList(); renderAudList(); renderOutList(); renderFolder(); renderGrid(); renderStrips(); renderInspector(); paintToolbar(); }
bus.on('cams', () => { renderGrid(); renderCamList(); renderOutList(); renderInspector(); paintToolbar(); paintLoad(); });
bus.on('cam', cam => { paintTile(cam); renderCamList(); paintToolbar(); if (isSel(cam) && document.activeElement?.type !== 'range') renderInspector(); });
bus.on('health', cam => paintTile(cam));
bus.on('audio', () => { renderStrips(); renderAudList(); renderMixBar(); if (selected && selected.type === 'audio' && !audio.channels.includes(selected.obj)) select(null); });
bus.on('select', () => { renderInspector(); renderCamList(); renderAudList(); renderOutList(); cams.forEach(paintTile); renderStrips(); if (view.mode === 'spotlight' || view.mode === 'single') applyView(); });
bus.on('rec', () => { paintToolbar(); cams.forEach(paintTile); if (recState.active && promptWin && !promptWin.closed) promptWin.postMessage('mcr-play', '*'); });
bus.on('marker', paintToolbar);
bus.on('folder', renderFolder);
bus.on('luts', () => { if (selected && selected.type === 'cam' && inspTab === 'look') renderInspector(); cams.forEach(syncRenderers); });
bus.on('devices', () => { if (selected && selected.type === 'cam' && inspTab === 'camera') renderInspector(); });

function initChrome() {
  if (NATIVE) document.body.classList.add('native');
  $('#tSide').innerHTML = icon('sidebar'); $('#tInsp').innerHTML = icon('sliders');
  $('#tSettings').innerHTML = icon('gear'); $('#tPrompt').innerHTML = icon('text');
  $('#tMini').innerHTML = `<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="7" height="6" rx="1.2" fill="currentColor" stroke="none"/></svg>`; $('#tMini').onclick = toggleMiniPreview;
  $('#auto').innerHTML = icon('wand') + 'Auto setup';
  $('#addSetup').innerHTML = icon('plus', 'sm'); $('#addCamS').innerHTML = icon('plus', 'sm'); $('#addAudS').innerHTML = icon('plus', 'sm');
  $('#soundCheck').innerHTML = icon('wave', 'sm') + ' Sound check'; $('#addAud').innerHTML = icon('plus', 'sm') + ' Add input';
  const app = $('#app');
  const setDock = c => { $('#dock').classList.toggle('collapsed', c); $('#dockToggle').innerHTML = `<svg class="ic sm" viewBox="0 0 24 24" style="transform:rotate(${c ? -90 : 0}deg)"><path d="M6 9l6 6 6-6"/></svg>`; };
  setDock(store.get('dockCollapsed', false));
  $('#dockToggle').onclick = () => { const c = !$('#dock').classList.contains('collapsed'); setDock(c); store.set('dockCollapsed', c); };
  if (store.get('noSide', false)) app.classList.add('no-side');
  if (store.get('noInsp', false)) app.classList.add('no-insp');
  $('#tSide').onclick = () => store.set('noSide', app.classList.toggle('no-side'));
  $('#tInsp').onclick = () => store.set('noInsp', app.classList.toggle('no-insp'));
  $('#rec').onclick = requestRecord;
  $('#tMark').onclick = addMarker;
  $('#tSettings').onclick = openSettings;
  $('#load').onclick = openPerf;
  $('#tPrompt').onclick = openPrompter;
  $('#auto').onclick = async () => { if (recState.active) return toast('Stop recording first', 'err'); await autoSetup(); store.set('activeSetup', ''); saveCurrent(); renderAll(); if (cams.length) openNameCameras(true); };
  $('#addSetup').onclick = saveSetupDialog;
  $('#addCamS').onclick = addCamMenu;
  $('#nameCamS').innerHTML = `<svg class="ic sm" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`; $('#nameCamS').onclick = () => openNameCameras();
  $('#addAudS').onclick = $('#addAud').onclick = addAudioMenu;
  $('#soundCheck').onclick = runSoundCheck;
}

// ---------- appearance ----------
const appearance = { style: 'glass', solid: false, ambient: true, tips: false, motion: true, ...store.get('appearance', {}) };
function applyAppearance() {
  document.body.classList.toggle('glass', appearance.style === 'glass');
  document.body.classList.toggle('solid', appearance.solid);
  document.body.classList.toggle('compact', !appearance.tips);
  document.body.classList.toggle('nomotion', !appearance.motion);
  store.set('appearance', appearance);
}
applyAppearance();
// ambient glow follows the main camera (tiny, slow, cheap)
setInterval(() => {
  if (appearance.style !== 'glass' || appearance.solid || !appearance.ambient || document.hidden) return;
  const c = $('#ambient canvas'), cam = (typeof focusCam === 'function' && focusCam()) || cams.find(x => x.alive);
  if (!c || !cam || !cam.alive || !cam.canvas.width) return;
  try { c.getContext('2d').drawImage(cam.canvas, 0, 0, c.width, c.height); } catch {}
}, 400);
