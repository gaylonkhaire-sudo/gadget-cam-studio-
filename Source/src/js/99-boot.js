// Startup: permissions, restore last session (or auto setup), first render.
async function boot() {
  const err = $('#gateErr'); err.textContent = '';
  if (!navigator.mediaDevices || !window.MediaRecorder) { err.textContent = 'This browser can’t record. Please use Chrome or Edge.'; return; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
    s.getTracks().forEach(t => t.stop());
  } catch (e) {
    err.textContent = 'Camera and microphone access was blocked. Allow it in the address bar, then try again.';
    $('#gate').hidden = false; return;
  }
  $('#gate').hidden = true;
  await audio.init();
  await Promise.all([loadLuts(), loadFolder(), loadBackup()]);
  await refreshDevices();
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  const cur = store.get('current', null);
  if (cur && (cur.cams || []).length) await applySnapshot(cur);
  else { await autoSetup(); setTimeout(() => cams.length && openNameCameras(true), 500); }
  saveCurrent();
  renderAll();
  if (cams[0] && !selected) select('cam', cams[0]);
  phonesOnBoot();
  log(`Ready. Recording format ${MIME || 'browser default'}${NATIVE ? ' (Windows app)' : ''}`);
  if (EXT !== 'mp4' && !NATIVE) log('This browser records WebM. Update Chrome or Edge for MP4.');
  store.set('started', true);
}

initChrome();
$('#start').onclick = boot;
(async () => {
  // Skip the welcome screen when permission was already given
  try {
    const [c, m] = await Promise.all([navigator.permissions.query({ name: 'camera' }), navigator.permissions.query({ name: 'microphone' })]);
    if (store.get('started', false) && c.state === 'granted' && m.state === 'granted') boot();
  } catch {}
})();
