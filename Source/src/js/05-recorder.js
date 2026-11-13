// Recorder: file sinks, per-camera segments (survives unplugging), vertical copies, markers, Resolve export, countdown.
function pickMime() {
  const list = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
                'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
const MIME = pickMime();
const EXT = MIME.startsWith('video/mp4') ? 'mp4' : 'webm';

const recState = { active: false, start: 0, startDate: null, take: 1, markers: [], segments: [], counting: false, stopping: false };
const project = { name: 'Video', take: 1, bitrate: 16000000, countdown: 3, finalize: true, codec: 'h264', micFiles: true, syncBeep: true, chapters: true, ...store.get('project', {}) };
const saveProject = () => store.set('project', project);

// ---------- where files go ----------
let folder = { kind: 'downloads', name: 'Downloads', handle: null, path: '' };
async function loadFolder() {
  if (NATIVE) { const p = await NATIVE.getFolder(); if (p) folder = { kind: 'native', name: p.split(/[\\/]/).pop() || p, path: p }; bus.emit('folder'); return; }
  const handle = await idbGet('handles', 'folder');
  if (handle) folder = { kind: 'fsa', name: handle.name, handle, granted: (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' };
  bus.emit('folder');
}
async function chooseFolder() {
  if (NATIVE) { const p = await NATIVE.chooseFolder(); if (p) { folder = { kind: 'native', name: p.split(/[\\/]/).pop() || p, path: p }; bus.emit('folder'); } return; }
  if (!window.showDirectoryPicker) { toast('Folder saving needs Chrome or Edge. Files will go to Downloads.', 'err'); return; }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'multicam', startIn: 'videos' });
    await idbPut('handles', 'folder', handle);
    folder = { kind: 'fsa', name: handle.name, handle, granted: true };
    bus.emit('folder'); log('Save folder: ' + handle.name);
  } catch (e) { if (e.name !== 'AbortError') toast('Folder not available: ' + e.message, 'err'); }
}
async function ensureFolderAccess() {           // must run inside a click
  if (backup.kind === 'fsa' && !backup.granted) { try { backup.granted = (await backup.handle.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { backup.granted = false; } }
  if (folder.kind !== 'fsa') return true;
  if (folder.granted) return true;
  try { folder.granted = (await folder.handle.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { folder.granted = false; }
  if (!folder.granted) toast('No permission for the save folder. Files will go to Downloads this time.', 'err');
  bus.emit('folder');
  return folder.granted;
}
// One file on one drive. patchStart(bytes) rewrites the first bytes when the file closes (used for WAV headers).
async function openOne(fileName, where = 'main') {
  let head = null;
  const dir = where === 'backup' ? backup : folder;
  if (dir.kind === 'native') {
    const id = await NATIVE.openFile(fileName, where);
    return { name: fileName, write: async b => NATIVE.write(id, await b.arrayBuffer()), patchStart: b => head = b,
      close: async () => { const p = await NATIVE.close(id); if (head && p) await NATIVE.patch(p, 0, await head.arrayBuffer()); return p; } };
  }
  if (dir.kind === 'fsa' && dir.granted) {
    try {
      const fh = await dir.handle.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      return { name: fileName, write: b => w.write(b), patchStart: b => head = b,
        close: async () => { if (head) await w.write({ type: 'write', position: 0, data: head }); await w.close(); return fileName; } };
    } catch (e) { if (where === 'backup') throw e; log(`Could not write ${fileName} to folder (${e.message}). Using Downloads.`); }
  }
  if (where === 'backup') throw new Error('Backup folder not available');
  const parts = [];
  return { name: fileName, write: async b => { parts.push(b); }, patchStart: b => head = b,
    close: async () => {
      if (head && parts.length) parts[0] = new Blob([head, parts[0].slice(head.size)]);
      download(new Blob(parts, { type: /\.wav$/i.test(fileName) ? 'audio/wav' : (MIME.split(';')[0] || 'video/webm') }), fileName); return fileName; } };
}
// Main file plus, when a backup folder is set, an identical copy written alongside it.
let backupWarned = false;
async function openSink(fileName) {
  const main = await openOne(fileName, 'main');
  if (!backupOn()) return main;
  let bk = null, bq = Promise.resolve(), ok = true;
  const fail = e => { ok = false; log(`Backup copy of ${fileName} stopped: ${e.message}`); if (!backupWarned) { backupWarned = true; toast('Backup drive stopped writing. Your main files are still recording.', 'err'); } };
  try { bk = await openOne(fileName, 'backup'); } catch (e) { fail(e); return main; }
  return { name: fileName,
    write: b => { if (ok) bq = bq.then(() => bk.write(b)).catch(fail); return main.write(b); },
    patchStart: b => { main.patchStart(b); bk.patchStart(b); },
    close: async () => { const p = await main.close(); await bq; if (ok) try { await bk.close(); } catch (e) { fail(e); } return p; } };
}

// ---------- backup folder ----------
let backup = { kind: 'none', name: '', handle: null, path: '' };
const backupOn = () => backup.kind === 'native' || (backup.kind === 'fsa' && backup.granted);
async function loadBackup() {
  if (NATIVE) { const p = NATIVE.getBackupFolder && await NATIVE.getBackupFolder(); backup = p ? { kind: 'native', name: p.split(/[\\/]/).pop() || p, path: p } : { kind: 'none' }; bus.emit('folder'); return; }
  const handle = await idbGet('handles', 'backup');
  if (handle) backup = { kind: 'fsa', name: handle.name, handle, granted: (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' };
  bus.emit('folder');
}
async function chooseBackup() {
  if (NATIVE) { const p = await NATIVE.chooseBackupFolder(); if (p) backup = { kind: 'native', name: p.split(/[\\/]/).pop() || p, path: p }; bus.emit('folder'); return; }
  if (!window.showDirectoryPicker) return toast('Backup folders need Chrome, Edge or the Windows app', 'err');
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'gcs-backup' });
    if (folder.handle && await folder.handle.isSameEntry(handle)) return toast('Pick a different folder, ideally on another drive', 'err');
    await idbPut('handles', 'backup', handle);
    backup = { kind: 'fsa', name: handle.name, handle, granted: true }; bus.emit('folder');
  } catch (e) { if (e.name !== 'AbortError') toast('Folder not available: ' + e.message, 'err'); }
}
async function clearBackup() {
  if (NATIVE) await NATIVE.clearBackupFolder(); else await idbDel('handles', 'backup');
  backup = { kind: 'none' }; bus.emit('folder');
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function writeText(name, text) {
  if (folder.kind === 'native') return NATIVE.writeText(name, text);
  const s = await openSink(name);
  if (folder.kind === 'fsa' && folder.granted) { await s.write(new Blob([text])); return s.close(); }
  download(new Blob([text], { type: 'text/plain' }), name); return name;
}

// ---------- segments ----------
// File names: a pattern with tokens, set for all cameras in Settings or per camera in the inspector.
const DEFAULT_PATTERN = '{project}_T{take}_{camera}';
const NAME_TOKENS = ['{project}', '{take}', '{camera}', '{date}', '{time}', '{setup}'];
const cleanFile = s => String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);
function fileBaseFor(cam, when = new Date()) {
  const pattern = cam.naming ? namingToPattern(cam.naming)
    : (cam.fileName && cam.fileName.trim()) || (project.naming ? namingToPattern(project.naming) : project.filePattern) || DEFAULT_PATTERN;
  const pad = n => String(n).padStart(2, '0');
  const vals = {
    project: project.name, take: project.take, camera: cam.name, setup: store.get('activeSetup', '') || 'Setup',
    date: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    time: `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`,
  };
  const out = cleanFile(pattern.replace(/\{(project|take|camera|date|time|setup)\}/gi, (_, k) => vals[k.toLowerCase()]));
  return out || cleanFile(`${project.name}_T${project.take}_${cam.name}`) || 'Recording';
}
// unique base names for this take (two cameras can't share a name)
let takeNames = new Map();
function assignTakeNames(list) {
  takeNames = new Map(); const used = new Set();
  const when = recState.startDate || new Date();
  // if the file-name style leaves out the camera and several cameras record, add each camera's name to every file
  const bases = list.map(c => fileBaseFor(c, when));
  const clash = new Set(bases.map(x => x.toLowerCase())).size < bases.length;
  list.forEach((cam, i) => {
    let b = bases[i];
    const nm = cam.naming || defaultNaming();
    const hasCam = (nm.parts || []).some(p => p.t === 'camera') || /\{camera\}/i.test(cam.fileName || '');
    if (clash && !hasCam) b = cleanFile(`${b}${(nm.sep ?? '_') || '_'}${cam.name}`);
    let n = 2; const base = b;
    while (used.has(b.toLowerCase())) b = `${base}_${n++}`;
    used.add(b.toLowerCase()); takeNames.set(cam, b);
  });
}
function baseName(cam) {
  if (!takeNames.has(cam)) assignTakeNames([...takeNames.keys(), cam]);
  return takeNames.get(cam);
}

async function startSegment(cam, kind) {
  const prev = recState.segments.filter(s => s.cam === cam && s.kind === kind).length;
  const file = `${baseName(cam)}${kind === 'vertical' ? '_vertical' : ''}${prev ? '_part' + (prev + 1) : ''}.${EXT}`;
  const raw = cam.stream && (!cam.kind || cam.kind === 'device' || cam.kind === 'phone' || cam.kind === 'screen') ? cam.stream.getVideoTracks()[0] : null;
  const fps = (cam.actual && cam.actual.fps) || cam.fps;
  let vTrack = raw;
  if (kind === 'vertical') {
    if (!cam.vertR) { cam.vertR = makeRenderer(document.createElement('canvas')); syncRenderers(cam); }
    cam.vertR.draw(srcEl(cam), cam.adj, { lutAmt: cam.lut.bake ? cam.lut.amt : 0, vertical: cam.vert });
    vTrack = cam.vertR.canvas.captureStream(fps).getVideoTracks()[0];
  } else if (cam.r && (!raw || adjActive(cam.adj) || (cam.lut.name && cam.lut.bake))) {
    if (!cam.recR) { cam.recR = makeRenderer(document.createElement('canvas')); syncRenderers(cam); }
    cam.recR.draw(srcEl(cam), cam.adj, { lutAmt: cam.lut.bake ? cam.lut.amt : 0 });
    vTrack = cam.recR.canvas.captureStream(fps).getVideoTracks()[0];
  }
  const tracks = [vTrack];
  const at = camAudioTrack(cam); if (at) tracks.push(at.clone());
  const stream = new MediaStream(tracks);
  const rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: kind === 'vertical' ? project.bitrate * 0.6 : project.bitrate, audioBitsPerSecond: 256000 });
  const sink = await openSink(file);
  const seg = { cam, kind, file, sink, rec, stream, processed: vTrack !== raw, bytes: 0, queue: Promise.resolve(),
                offset: (performance.now() - recState.start) / 1000, end: null,
                w: kind === 'vertical' ? cam.vertR.canvas.width : (vTrack !== raw ? cam.recR.canvas.width : cam.actual.w),
                h: kind === 'vertical' ? cam.vertR.canvas.height : (vTrack !== raw ? cam.recR.canvas.height : cam.actual.h), fps };
  if (at && kind === 'main' && !recState.segments.some(x => x.head)) seg.head = [];   // first seconds kept to measure audio sync after the take
  rec.ondataavailable = ev => {
    if (!ev.data || !ev.data.size) return;
    seg.bytes += ev.data.size;
    if (seg.head && seg.head.length < 4) seg.head.push(ev.data);
    seg.queue = seg.queue.then(() => seg.sink.write(ev.data)).catch(e => log(`${file}: write error ${e.message}`));
  };
  seg.done = new Promise(res => rec.onstop = res);
  seg.started = new Promise(res => rec.addEventListener('start', () => { seg.t0 = performance.now(); res(); }, { once: true }));
  recState.segments.push(seg);
  return seg;
}
// Find the sync beep in a video file's own audio and work out how far each mic file is from it.
// Video recorders begin a little after they're told to, by an amount that can't be known in advance, so we measure it.
async function measureSync(segs) {
  const v = segs.find(x => x.head && x.head.length), wavs = segs.filter(x => x.kind === 'wav' && x.startedCtx != null);
  segs.forEach(x => { if (x !== v) delete x.head; });
  if (!v || !wavs.length || recState.beepCtx == null) { if (v) delete v.head; return; }
  try {
    const buf = await audio.ctx.decodeAudioData(await new Blob(v.head, { type: MIME.split(';')[0] }).arrayBuffer());
    const x = buf.getChannelData(0), sr = buf.sampleRate, n = Math.round(sr * 0.002), w = 2 * Math.PI * 1000 / sr;
    let at = -1;
    for (let i = 0; i + n < x.length && at < 0; i += n) {
      let re = 0, im = 0, e = 0;
      for (let k = 0; k < n; k++) { const q = x[i + k]; re += q * Math.cos(w * k); im -= q * Math.sin(w * k); e += q * q; }
      const c = Math.hypot(re, im) / n;
      if (c > 0.08 && c / (Math.sqrt(e / n) + 1e-9) > 0.6) at = i / sr;
    }
    if (at >= 0) { wavs.forEach(s => { s.lead = (recState.beepCtx - s.startedCtx) + (s.pad || 0) - at; }); log(`Mic files lined up to video (${Math.round(wavs[0].lead * 1000)} ms)`); }
  } catch (e) { log('Sync check skipped: ' + e.message); }
  delete v.head;
}

// which sound goes into a camera's file: the full mix, one mic on its own, or none
function camAudioTrack(cam) {
  const pick = cam.audioSrc || 'mix';
  if (pick === 'none') return null;
  if (pick !== 'mix') { const t = audio.isoTrack(pick); if (t) return t; log(`${cam.name}: chosen audio input missing, using the full mix`); }
  return audio.track();
}

// ---------- a WAV file per mic (24-bit, 48 kHz), fed by the mic's own clean signal ----------
function wavHeader(dataBytes, ch, rate) {
  const b = new ArrayBuffer(44), v = new DataView(b), w = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, ch, true); v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 3, true); v.setUint16(32, ch * 3, true); v.setUint16(34, 24, true);
  w(36, 'data'); v.setUint32(40, dataBytes, true);
  return new Blob([b]);
}
function to24(f32, inCh, outCh) {
  const frames = f32.length / inCh, out = new Uint8Array(frames * outCh * 3); let o = 0;
  for (let i = 0; i < frames; i++) for (let c = 0; c < outCh; c++) {
    let x = outCh === 1 && inCh === 2 ? f32[i * 2] : f32[i * inCh + c];
    x = x > 1 ? 1 : x < -1 ? -1 : x; const n = Math.round(x * 8388607);
    out[o++] = n & 255; out[o++] = (n >> 8) & 255; out[o++] = (n >> 16) & 255;
  }
  return out;
}
async function startWavSegment(ch) {
  const tap = audio.tapOf(ch); if (!tap) return null;
  const rate = audio.sampleRate(), outCh = ch.s.mode === 'stereo' ? 2 : 1;
  let base = fileBaseFor({ name: ch.name, naming: null, fileName: '' }, recState.startDate);
  if (!base.includes(cleanFile(ch.name))) base += '_' + cleanFile(ch.name);       // every mic file names its mic
  const taken = recState.segments.filter(x => x.kind === 'wav').map(x => x.file);
  let file = `${base}.wav`, n = 2; while (taken.includes(file)) file = `${base}_${n++}.wav`;
  const sink = await openSink(file);
  await sink.write(wavHeader(0, outCh, rate));
  const seg = { ch, kind: 'wav', file, sink, bytes: 0, queue: Promise.resolve(), offset: 0, end: null, stream: new MediaStream(), rate, channels: outCh };
  let finish; seg.done = new Promise(r => finish = r);
  tap.port.onmessage = e => {
    if (e.data.done) return finish();
    if (e.data.started != null) {                       // pad the front so sample 0 of this file is the same instant as frame 0 of the video
      const began = performance.now() - (audio.ctx.currentTime - e.data.started) * 1000;
      const n = Math.round(clamp((began - recState.start) / 1000, 0, 2) * rate);
      if (n) { const z = new Uint8Array(n * outCh * 3); seg.bytes += z.length; seg.queue = seg.queue.then(() => seg.sink.write(new Blob([z]))).catch(() => {}); }
      seg.startedCtx = e.data.started; seg.pad = n / rate;
      return;
    }
    if (!e.data.pcm) return;
    const bytes = to24(e.data.pcm, 2, outCh); seg.bytes += bytes.length;
    seg.queue = seg.queue.then(() => seg.sink.write(new Blob([bytes]))).catch(err => log(`${file}: write error ${err.message}`));
  };
  seg.rec = { state: 'inactive', start() { this.state = 'recording'; tap.port.postMessage('start'); }, stop() { this.state = 'inactive'; tap.port.postMessage('stop'); } };
  seg.beforeClose = () => seg.sink.patchStart(wavHeader(seg.bytes, outCh, rate));
  recState.segments.push(seg);
  return seg;
}

async function endSegment(seg) {
  if (seg.end != null) return;
  seg.end = (performance.now() - recState.start) / 1000;
  if (seg.rec.state !== 'inactive') seg.rec.stop();
  await seg.done; await seg.queue;
  if (seg.beforeClose) seg.beforeClose();
  seg.path = await seg.sink.close();
  seg.stream.getTracks().forEach(t => { if (!(seg.cam && seg.cam.stream && seg.cam.stream.getVideoTracks()[0] === t)) t.stop(); });
  log(`Saved ${seg.file} (${fmtBytes(seg.bytes)})`);
}

// unplugged mid-take: close its files; reopen as a new part when it returns
bus.on('camLost', cam => { if (recState.active) recState.segments.filter(s => s.cam === cam && s.end == null).forEach(endSegment); });
bus.on('camBack', async cam => {
  if (!recState.active || recState.stopping) return;
  const segs = [await startSegment(cam, 'main')];
  if (cam.vert.on) segs.push(await startSegment(cam, 'vertical'));
  segs.forEach(s => s.rec.start(1000));
  log(`${cam.name}: recording resumed as a new part`);
});

// ---------- start / stop ----------
async function requestRecord() {
  if (recState.active) return stopRecording();
  if (recState.counting) { recState.counting = false; bus.emit('countdown', 0); return; }
  if (!cams.some(c => c.alive)) { toast('Add a camera first', 'err'); return; }
  await ensureFolderAccess();
  const n = +project.countdown || 0;
  if (n > 0) {
    recState.counting = true;
    for (let i = n; i > 0; i--) {
      if (!recState.counting) return;
      bus.emit('countdown', i); audio.beep(i === 1 ? 1320 : 880, 0.08); await sleep(1000);
    }
    if (!recState.counting) return;
    recState.counting = false; bus.emit('countdown', 0);
  }
  await startRecording();
}

async function startRecording() {
  if (recState.active) return;
  const live = cams.filter(c => c.alive);
  if (!live.length) return;
  Object.assign(recState, { active: true, start: performance.now(), startDate: new Date(), take: project.take, markers: [], segments: [], stopping: false, syncAt: null, beepCtx: null, introName: '' });
  backupWarned = false;
  live.forEach(c => { c.comparing = false; c.health.dropped = 0; });
  assignTakeNames(cams);
  const segs = [];
  for (const cam of live) {
    segs.push(await startSegment(cam, 'main'));
    if (cam.vert.on) segs.push(await startSegment(cam, 'vertical'));
  }
  if (program.record) {
    ensureLoop(); if (!comp.width) composeFrame();
    const tracks = [comp.captureStream(program.fps).getVideoTracks()[0]];
    const at = audio.track(); if (at) tracks.push(at.clone());
    const stream = new MediaStream(tracks);
    const file = `${fileBaseFor({ name: 'Output', naming: null, fileName: '' }, recState.startDate)}.${EXT}`;
    const rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: project.bitrate, audioBitsPerSecond: 256000 });
    const sink = await openSink(file);
    const seg = { cam: null, kind: 'program', file, sink, rec, stream, processed: true, bytes: 0, queue: Promise.resolve(), offset: 0, end: null, w: comp.width, h: comp.height, fps: program.fps };
    rec.ondataavailable = ev => { if (!ev.data || !ev.data.size) return; seg.bytes += ev.data.size; seg.queue = seg.queue.then(() => seg.sink.write(ev.data)).catch(e => log(`${file}: write error ${e.message}`)); };
    seg.done = new Promise(res => rec.onstop = res);
    seg.started = new Promise(res => rec.addEventListener('start', () => { seg.t0 = performance.now(); res(); }, { once: true }));
    recState.segments.push(seg); segs.push(seg);
  }
  if (project.micFiles) for (const ch of audio.channels.filter(c => c.n)) { const w = await startWavSegment(ch); if (w) segs.push(w); }
  recState.start = performance.now();               // all recorders start together, right now
  const vids = segs.filter(s => s.kind !== 'wav'), wavs = segs.filter(s => s.kind === 'wav');
  vids.forEach(s => { s.offset = 0; s.rec.start(1000); });
  // video recorders take a moment to really begin; time zero is when they did, and mic files are padded to match
  await Promise.race([Promise.all(vids.map(s => s.started).filter(Boolean)), sleep(600)]);
  const t0s = vids.map(s => s.t0).filter(Boolean); if (t0s.length) recState.start = Math.min(...t0s);
  wavs.forEach(s => { s.offset = 0; s.rec.start(); });
  if (project.syncBeep && audio.channels.length) setTimeout(() => { if (recState.active && !recState.stopping) { recState.beepCtx = audio.syncBeep(); recState.syncAt = (performance.now() - recState.start) / 1000; } }, 1000);
  audio.resetCg();
  bus.emit('rec');
  log(`Recording take ${project.take}: ${live.length} camera(s), ${segs.length} file(s), ${EXT.toUpperCase()}`);
}

async function stopRecording() {
  if (!recState.active || recState.stopping) return;
  recState.stopping = true; bus.emit('rec');
  const dur = (performance.now() - recState.start) / 1000;
  await Promise.all(recState.segments.map(endSegment));
  for (const cam of cams) { cam.recR && cam.recR.destroy(); cam.recR = null; cam.vertR && cam.vertR.destroy(); cam.vertR = null; }
  let segs = recState.segments;
  if (NATIVE && project.finalize) {
    toast('Finishing files for editing…');
    const vids = segs.filter(s => s.kind !== 'wav');
    const res = await NATIVE.finalize(vids.map(s => ({ path: s.path, fps: s.fps, bitrate: project.bitrate })), { codec: project.codec });
    res.forEach((r, i) => { if (r.ok) vids[i].path = r.path; else log(`Could not finish ${vids[i].file}: ${r.error}`); });
  }
  await measureSync(segs);
  if (recState.markers.length && project.chapters) await nameMarkers();
  try { await exportProject(segs, dur); } catch (e) { log('Export failed: ' + e.message); }
  recState.active = false; recState.stopping = false;
  project.take++; saveProject();
  bus.emit('rec');
  const nw = segs.filter(s => s.kind === 'wav').length, nv = segs.length - nw;
  toast(`Take ${recState.take} saved: ${nv} video${nv === 1 ? '' : 's'}${nw ? `, ${nw} mic file${nw === 1 ? '' : 's'}` : ''}${backupOn() ? ' + backup' : ''}${recState.markers.length ? `, ${recState.markers.length} markers` : ''}`);
}

function addMarker() {
  if (!recState.active) { toast('Markers can be added while recording'); return; }
  const t = (performance.now() - recState.start) / 1000;
  recState.markers.push({ t, name: `Marker ${recState.markers.length + 1}` });
  bus.emit('marker'); toast(`Marker ${recState.markers.length} at ${fmtTime(t * 1000)}`);
}

// ---------- Resolve export: FCPXML timeline with every angle stacked + markers, marker EDL, CSV ----------
const xmlEsc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function tc(sec, fps) { const f = Math.round(sec * fps); return [f / (3600 * fps) | 0, (f / (60 * fps) | 0) % 60, (f / fps | 0) % 60, f % fps].map(n => String(n).padStart(2, '0')).join(':'); }

async function exportProject(segs, dur) {
  const main = segs.filter(s => s.kind === 'main');
  if (!main.length) return;
  const fps = main[0].fps || 30;
  const T = sec => `${Math.round(sec * fps)}/${fps}s`;
  const title = `${project.name} Take ${recState.take}`;
  const fmts = new Map(); let fi = 1;
  const fmtId = s => { const k = `${s.w}x${s.h}@${s.fps}`; if (!fmts.has(k)) fmts.set(k, { id: 'r' + fi++, ...s }); return fmts.get(k).id; };
  const src = s => folder.kind === 'native' ? 'file:///' + encodeURI(s.path.replace(/\\/g, '/')).replace(/#/g, '%23') : encodeURIComponent(s.path || s.file);
  const assets = main.map((s, i) => ({ id: 'a' + (i + 1), s, f: fmtId(s), len: Math.max(1 / fps, (s.end ?? dur) - s.offset) }));
  // mic files: trim or shift by the measured difference, rounded to whole frames so every editor accepts it
  const wavs = segs.filter(s => s.kind === 'wav').map((s, i) => { const lead = Math.round(clamp(s.lead || 0, -1, 1) * fps) / fps;
    return { id: 'w' + (i + 1), s, lead, full: Math.max(1 / fps, (s.end ?? dur) - s.offset), len: Math.max(1 / fps, (s.end ?? dur) - s.offset - Math.max(lead, 0)) }; });
  const seqFmt = fmtId(main[0]);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
${[...fmts.values()].map(f => `    <format id="${f.id}" frameDuration="1/${f.fps}s" width="${f.w}" height="${f.h}"/>`).join('\n')}
${assets.map(a => `    <asset id="${a.id}" name="${xmlEsc(a.s.file)}" src="${xmlEsc(src(a.s))}" start="0s" duration="${T(a.len)}" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000" format="${a.f}"/>`).join('\n')}
${wavs.map(a => `    <asset id="${a.id}" name="${xmlEsc(a.s.file)}" src="${xmlEsc(src(a.s))}" start="0s" duration="${T(a.full)}" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="${a.s.channels}" audioRate="48000"/>`).join('\n')}
  </resources>
  <library>
    <event name="${xmlEsc(project.name)}">
      <project name="${xmlEsc(title)}">
        <sequence format="${seqFmt}" duration="${T(dur)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <gap name="Gadget Cam Studio" offset="0s" start="0s" duration="${T(dur)}">
${assets.map((a, i) => `              <asset-clip ref="${a.id}" lane="${i + 1}" offset="${T(a.s.offset)}" name="${xmlEsc(a.s.cam.name)}" start="0s" duration="${T(a.len)}" format="${a.f}" tcFormat="NDF"/>`).join('\n')}
${wavs.map((a, i) => `              <asset-clip ref="${a.id}" lane="-${i + 1}" offset="${T(a.s.offset + Math.max(-a.lead, 0))}" name="${xmlEsc(a.s.ch.name)}" start="${T(Math.max(a.lead, 0))}" duration="${T(a.len)}"/>`).join('\n')}
${recState.markers.map(m => `              <marker start="${T(m.t)}" duration="1/${fps}s" value="${xmlEsc(m.name)}"/>`).join('\n')}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
  const base = `${safeName(project.name)}_T${recState.take}`;
  await writeText(`${base}_Resolve.fcpxml`, xml);
  if (recState.markers.length) {
    const edl = `TITLE: ${title}\nFCM: NON-DROP FRAME\n\n` + recState.markers.map((m, i) =>
      `${String(i + 1).padStart(3, '0')}  001      V     C        ${tc(m.t, fps)} ${tc(m.t + 1 / fps, fps)} ${tc(m.t, fps)} ${tc(m.t + 1 / fps, fps)}  \n |C:ResolveColorBlue |M:${m.name} |D:1\n`).join('\n');
    await writeText(`${base}_markers.edl`, edl);
    await writeText(`${base}_markers.csv`, 'Marker,Timecode,Seconds\n' + recState.markers.map(m => `"${m.name}",${tc(m.t, fps)},${m.t.toFixed(3)}`).join('\n') + '\n');
  }
  if (recState.markers.length && project.chapters) await writeText(`${base}_YouTube_chapters.txt`, youtubeChapters());
  log(`Exported ${base}_Resolve.fcpxml${recState.markers.length ? ' and markers' : ''}`);
}

// ---------- YouTube chapters from markers ----------
const ytTime = sec => { sec = Math.floor(sec); const h = sec / 3600 | 0, m = (sec / 60 | 0) % 60, s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
function youtubeChapters() {
  const list = [{ t: 0, name: recState.introName || 'Intro' }, ...recState.markers.filter(m => m.t >= 10)];
  return list.map(m => `${ytTime(m.t)} ${m.name}`).join('\n') + '\n';
}
// Right after a take with markers: name them once, and they flow into Resolve, the CSV and YouTube chapters.
function nameMarkers() {
  return new Promise(resolve => {
    let done = false; const finish = () => { if (done) return; done = true; clearTimeout(timer); try { dlg.close(); } catch {} resolve(); };
    const rows = recState.markers.map((m, i) => `<div class="r chap"><span class="tc">${ytTime(m.t)}</span><input data-i="${i}" value="${esc(m.name)}" maxlength="60" spellcheck="true"></div>`).join('');
    const dlg = h(`<dialog class="chapdlg"><div class="dh"><b>Name your chapters</b><button class="btn primary" data-act="ok">Save</button></div>
      <div class="db"><div class="group"><div class="r chap"><span class="tc">0:00</span><input data-intro value="${esc(recState.introName || 'Intro')}" maxlength="60"></div>${rows}</div>
      <div class="note keep">These names go into your Resolve markers and a YouTube chapters file you can paste into the description.${recState.markers.some(m => m.t < 10) ? ' Markers in the first 10 seconds are left out of YouTube chapters.' : ''}</div></div></dialog>`);
    document.body.appendChild(dlg); dlg.showModal();
    const first = dlg.querySelector('input[data-i]'); if (first) { first.focus(); first.select(); }
    dlg.querySelector('[data-act=ok]').onclick = () => {
      dlg.querySelectorAll('input[data-i]').forEach(inp => { const v = inp.value.trim(); if (v) recState.markers[+inp.dataset.i].name = v; });
      recState.introName = dlg.querySelector('[data-intro]').value.trim() || 'Intro';
      finish();
    };
    dlg.addEventListener('keydown', e => { if (e.key === 'Enter') dlg.querySelector('[data-act=ok]').click(); });
    dlg.addEventListener('close', () => { finish(); setTimeout(() => dlg.remove(), 400); });
    const timer = setTimeout(finish, 180000);              // never hold up saving for more than 3 minutes
  });
}

// ---------- health ----------
function recHealth() {
  const el = recState.active ? (performance.now() - recState.start) / 1000 : 0;
  const bytes = recState.segments.reduce((a, s) => a + s.bytes, 0);
  const live = recState.segments.filter(s => s.end == null).length;
  const perSec = el > 3 ? bytes / el : (cams.filter(c => c.alive).length * project.bitrate / 8) + cams.filter(c => c.alive && c.vert.on).length * project.bitrate * 0.6 / 8;
  return { elapsed: el, bytes, perHour: perSec * 3600, perSec, liveFiles: live };
}
