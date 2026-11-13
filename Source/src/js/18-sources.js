// Sources besides cameras: video clips (reaction content), images, and screen or app window shares.
// They behave like cameras: preview tile, looks/framing, recording, and main or picture-in-picture on the output.
const SOURCE_KINDS = { media: 'Video', image: 'Image', screen: 'Screen', phone: 'Phone' };
const isSourceKind = cam => cam.kind && cam.kind !== 'device';

// ---------- open / close ----------
async function openSource(cam) {
  cam.loop = null;
  if (cam.kind === 'phone' || cam.kind === 'screen') {
    const s = cam.kind === 'phone' ? cam.remoteStream : cam.stream;
    const t = s && s.getVideoTracks()[0];
    if (!t || t.readyState === 'ended') { cam.stream = null; cam.alive = false; cam.status = 'lost'; bus.emit('cam', cam); return; }
    cam.stream = s;
    cam.video.srcObject = s; cam.video.muted = true;
    t.onended = () => { cam.alive = false; cam.status = 'lost'; bus.emit('camLost', cam); bus.emit('cam', cam); if (cam.kind === 'screen') toast(`${cam.name}: sharing stopped`, 'err'); };
  } else if (cam.kind === 'media') {
    if (!cam.mediaUrl) { cam.alive = false; cam.status = 'lost'; bus.emit('cam', cam); return; }
    cam.stream = null;
    if (cam.video.src !== cam.mediaUrl) { cam.video.srcObject = null; cam.video.src = cam.mediaUrl; }
    cam.video.loop = !!cam.media.loop;
    attachMediaAudio(cam);
  } else if (cam.kind === 'image') {
    if (!cam.img) {
      const blob = cam.imgBlob || (cam.imgKey && await idbGet('blobs', cam.imgKey));
      if (!blob) { cam.alive = false; cam.status = 'lost'; bus.emit('cam', cam); return; }
      cam.img = new Image(); cam.img.decoding = 'async'; cam.img.src = URL.createObjectURL(blob);
      await cam.img.decode().catch(() => {});
    }
  }
  if (cam.kind !== 'image') {
    cam.video.play().catch(() => {});
    if (cam.video.readyState < 2) await Promise.race([new Promise(r => cam.video.addEventListener('loadeddata', r, { once: true })), sleep(4000)]);
    if (cam.kind === 'media' && !cam.media.autoplay) cam.video.pause();
  }
  const el = srcEl(cam);
  cam.actual = { w: el.videoWidth || el.naturalWidth || 1920, h: el.videoHeight || el.naturalHeight || 1080, fps: cam.kind === 'image' ? 30 : Math.round((cam.stream && cam.stream.getVideoTracks()[0].getSettings().frameRate) || 30) };
  if (cam.kind !== 'image') cam.video.onresize = () => { cam.actual.w = cam.video.videoWidth; cam.actual.h = cam.video.videoHeight; paintTile(cam); };
  cam.alive = true; cam.status = 'live';
  startLoop(cam);
  bus.emit('cam', cam); bus.emit('camBack', cam);
}

// a clip's sound goes through the mixer (so you can level it, EQ it, and it's in the recording)
function attachMediaAudio(cam) {
  if (cam.mediaNode || !audio.ctx) return;
  try {
    const ac = audio.ctx;
    cam.mediaNode = ac.createMediaElementSource(cam.video);
    const dest = ac.createMediaStreamDestination(); cam.mediaNode.connect(dest);
    cam.video.muted = false;
    audio.addChannel({ kind: 'media', name: `${cam.name} audio`, stream: dest.stream, s: { ...withPreset('Music (flat)'), monMute: false } }).then(ch => { cam.ch = ch; });
  } catch (e) { log('Clip audio unavailable: ' + e.message); }
}

function releaseSource(cam) {
  if (cam.kind === 'screen' && cam.stream) cam.stream.getTracks().forEach(t => t.stop());
  if (cam.kind === 'media') { cam.video.pause(); if (cam.mediaUrl) URL.revokeObjectURL(cam.mediaUrl); }
  if (cam.kind === 'image' && cam.img) URL.revokeObjectURL(cam.img.src);
  if (cam.ch) { audio.remove(cam.ch); cam.ch = null; }
  if (cam.kind === 'phone' && typeof closePhone === 'function') closePhone(cam);
}

// ---------- adding sources ----------
function pickFile(accept) {
  return new Promise(res => { const f = document.createElement('input'); f.type = 'file'; f.accept = accept; f.onchange = () => res(f.files[0] || null); f.click(); });
}
const baseOf = n => n.replace(/\.[^.]+$/, '').slice(0, 32);

async function addVideoSource(existing) {
  const file = await pickFile('video/*,.mp4,.mov,.webm,.mkv');
  if (!file) return;
  const cam = existing || newCam({ kind: 'media', name: uniqueCamName(baseOf(file.name) || 'Video'), media: { loop: false, autoplay: false, syncRec: true } });
  if (cam.mediaUrl) URL.revokeObjectURL(cam.mediaUrl);
  cam.mediaUrl = URL.createObjectURL(file); cam.label = file.name;
  bus.emit('cams'); select('cam', cam);
  await openSource(cam); saveCurrent(); checkLoad();
  if (!cam.alive) toast('That video could not be played. Try an MP4 (H.264) or WebM file.', 'err');
}
async function addImageSource(existing) {
  const file = await pickFile('image/*');
  if (!file) return;
  const key = 'img_' + uid();
  await idbPut('blobs', key, file);
  const cam = existing || newCam({ kind: 'image', name: uniqueCamName(baseOf(file.name) || 'Image') });
  if (cam.img) { URL.revokeObjectURL(cam.img.src); cam.img = null; }
  cam.imgKey = key; cam.imgBlob = file; cam.label = file.name;
  bus.emit('cams'); select('cam', cam);
  await openSource(cam); saveCurrent();
}

async function addScreenSource(existing) {
  let withAudio = false;
  if (NATIVE && NATIVE.listSources) {
    const pick = await pickScreen(); if (!pick) return;
    withAudio = pick.audio; NATIVE.chooseSource(pick.id, pick.audio);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 }, cursor: 'always' }, audio: NATIVE ? withAudio : true, systemAudio: 'include', surfaceSwitching: 'include', selfBrowserSurface: 'exclude' });
  } catch (e) { if (e.name !== 'NotAllowedError') toast('Screen sharing: ' + e.message, 'err'); return; }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = 'detail';
  const label = vt.label || 'Screen';
  const cam = existing || newCam({ kind: 'screen', name: uniqueCamName(/window|tab/i.test(vt.getSettings().displaySurface || '') ? shortName(label).slice(0, 24) || 'App window' : 'Screen') });
  if (cam.stream) cam.stream.getTracks().forEach(t => t.stop());
  cam.stream = stream; cam.label = label;
  if (cam.ch) { audio.remove(cam.ch); cam.ch = null; }
  if (stream.getAudioTracks().length) cam.ch = await audio.addChannel({ kind: 'screen', name: `${cam.name} audio`, stream: new MediaStream(stream.getAudioTracks()), s: { ...withPreset('Gameplay / system'), monMute: true } });
  bus.emit('cams'); select('cam', cam);
  await openSource(cam); saveCurrent(); checkLoad();
}

// Windows app: our own picker with live thumbnails of screens and app windows
function pickScreen() {
  return new Promise(async resolve => {
    let done = false;
    const sources = await NATIVE.listSources();
    const screens = sources.filter(s => s.id.startsWith('screen')), wins = sources.filter(s => !s.id.startsWith('screen'));
    const card = s => `<button class="srcpick" data-id="${esc(s.id)}"><img src="${s.thumb}" alt=""><span>${s.icon ? `<img class="ico" src="${s.icon}" alt="">` : ''}${esc(s.name)}</span></button>`;
    const d = openMenu('Share a screen or app', `
      <div class="cat" style="margin-top:0">Screens</div><div class="srcgrid">${screens.map(card).join('')}</div>
      ${wins.length ? `<div class="cat">App windows</div><div class="srcgrid">${wins.map(card).join('')}</div>` : ''}
      <div class="r" style="border:0;margin-top:8px"><div class="lb">Include computer audio<small>Game, video or app sound goes into the mixer</small></div><label class="sw"><input type="checkbox" id="spAudio"><i></i></label></div>`,
      (body, dlg) => body.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { done = true; const a = body.querySelector('#spAudio').checked; dlg.close(); resolve({ id: b.dataset.id, audio: a }); }));
    d.style.width = '640px';
    d.addEventListener('close', () => { d.style.width = ''; if (!done) resolve(null); }, { once: true });
  });
}

// ---------- media controls (Video sources) ----------
bus.on('rec', () => {
  for (const c of cams) if (c.kind === 'media' && c.alive && c.media.syncRec) {
    if (recState.active && !recState.stopping) { if (c.media.restart) c.video.currentTime = 0; c.video.play().catch(() => {}); startLoop(c); }
  }
});
const fmtClock = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${String(x).padStart(2, '0')}`; };

function sourceTab(b, cam) {
  const kind = SOURCE_KINDS[cam.kind] || 'Source';
  if (cam.kind === 'media') {
    const v = cam.video;
    b.innerHTML = `
      ${ui.group('Playback', `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 0 6px">
          <button class="btn primary" id="mPlay" style="width:78px;justify-content:center">${v.paused ? 'Play' : 'Pause'}</button>
          <button class="btn" id="mBack" title="Back 5 seconds">−5s</button><button class="btn" id="mFwd" title="Forward 5 seconds">+5s</button>
          <span id="mTime" style="margin-left:auto;font:12px var(--mono);color:var(--dim)">${fmtClock(v.currentTime)} / ${fmtClock(v.duration)}</span></div>
        <input type="range" class="s" id="mSeek" min="0" max="1000" value="${v.duration ? Math.round(v.currentTime / v.duration * 1000) : 0}" style="--p:${v.duration ? v.currentTime / v.duration * 100 : 0}%;margin-bottom:8px">` +
        ui.toggle('syncRec', 'Play when recording starts', cam.media.syncRec, 'Your reaction and the clip start together') +
        ui.toggle('restart', 'Start from the beginning', !!cam.media.restart, 'Each recording plays the clip from 0:00') +
        ui.toggle('loop', 'Loop', !!cam.media.loop))}
      ${ui.group('File', ui.row(esc(cam.label || 'No file'), `<button class="btn" id="mFile">Replace…</button>`))}
      <div class="note">The clip’s sound is in the mixer as “${esc(cam.name)} audio”. Set it lower than your mic so your reaction stays clear.</div>`;
    const play = b.querySelector('#mPlay'), seek = b.querySelector('#mSeek'), time = b.querySelector('#mTime');
    const sync = () => { if (!b.isConnected) return v.removeEventListener('timeupdate', sync); play.textContent = v.paused ? 'Play' : 'Pause';
      time.textContent = `${fmtClock(v.currentTime)} / ${fmtClock(v.duration)}`; if (document.activeElement !== seek && v.duration) { seek.value = Math.round(v.currentTime / v.duration * 1000); seek.style.setProperty('--p', (v.currentTime / v.duration * 100) + '%'); } };
    v.addEventListener('timeupdate', sync); v.addEventListener('play', sync); v.addEventListener('pause', sync);
    play.onclick = () => { if (v.paused) { v.play(); startLoop(cam); } else v.pause(); };
    b.querySelector('#mBack').onclick = () => { v.currentTime = Math.max(0, v.currentTime - 5); };
    b.querySelector('#mFwd').onclick = () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); };
    seek.oninput = () => { if (v.duration) v.currentTime = seek.value / 1000 * v.duration; seek.style.setProperty('--p', seek.value / 10 + '%'); };
    bindControls(b.querySelector('.group'), cam.media, k => { if (k === 'loop') v.loop = cam.media.loop; saveCurrentSoon(); });
    b.querySelector('#mFile').onclick = () => addVideoSource(cam);
    return;
  }
  if (cam.kind === 'image') {
    b.innerHTML = `${ui.group('Image', ui.row(esc(cam.label || 'Image'), `<button class="btn" id="iFile">Replace…</button>`, cam.actual ? `${cam.actual.w}×${cam.actual.h}` : ''))}
      <div class="note">Use images as a title card, a product shot, or as the picture-in-picture over a camera. Frame and Look work on images too.</div>`;
    b.querySelector('#iFile').onclick = () => addImageSource(cam);
    return;
  }
  if (cam.kind === 'screen') {
    b.innerHTML = `${ui.group('Sharing', ui.row(esc(shortName(cam.label) || 'Screen'), `<button class="btn" id="sAgain">Change…</button>`, cam.alive && cam.actual ? `${cam.actual.w}×${cam.actual.h}` : 'Not sharing'))}
      <div class="note">Tip: for game or app reactions, put this on the output with your camera as picture-in-picture, then turn on “Record the output too” in the Output panel.</div>`;
    b.querySelector('#sAgain').onclick = () => addScreenSource(cam);
    return;
  }
  b.innerHTML = `<div class="note">${kind}</div>`;
}
