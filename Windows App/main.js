// Gadget Cam Studio for Windows: Electron shell around the same app, plus native file writing, FFmpeg finishing,
// system-audio loopback, global hotkeys and a tray icon.
const { app, BrowserWindow, ipcMain, dialog, session, desktopCapturer, globalShortcut, Tray, Menu, nativeImage, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const phoneServer = require('./phone-server.js');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// performance: use the GPU for everything it can do, and never slow down when the window is in the background
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('enable-features', 'MediaFoundationD3D11VideoCapture,PlatformHEVCEncoderSupport');

let win = null, tray = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
const saveSettings = () => fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2)).catch(() => {});

function ffmpegPath() {
  let p = require('ffmpeg-static');
  return p ? p.replace('app.asar', 'app.asar.unpacked') : 'ffmpeg';
}

async function defaultFolder() {
  const dir = path.join(app.getPath('videos'), 'Gadget Cam Studio');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}
async function folder() {
  if (settings.folder) { try { await fsp.access(settings.folder); return settings.folder; } catch {} }
  settings.folder = await defaultFolder(); saveSettings();
  return settings.folder;
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 680,
    title: 'Gadget Cam Studio',
    backgroundColor: dark ? '#1c1c1e' : '#f5f5f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#f5f5f7' : '#1d1d1f', height: 52 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  nativeTheme.on('updated', () => win && win.setTitleBarOverlay({ symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f5f7' : '#1d1d1f' }));

  // teleprompter and other pop-ups open as real windows
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { width: 980, height: 640, autoHideMenuBar: true, backgroundColor: '#000000', title: 'Teleprompter' } }));
  // closing while recording
  win.webContents.on('will-prevent-unload', e => {
    const choice = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Keep recording', 'Quit anyway'], defaultId: 0, cancelId: 0,
      message: 'A recording is in progress', detail: 'Quitting now may leave the current files unfinished.' });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

let nextSource = null;
ipcMain.handle('listSources', async () => {
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true });
  return list.filter(s => !/Gadget Cam Studio/i.test(s.name)).map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), icon: s.appIcon ? s.appIcon.toDataURL() : '' }));
});
ipcMain.handle('chooseSource', (_, id, audio) => { nextSource = { id, audio: !!audio }; });

function setupPermissions() {
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'window-management']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed.has(perm));
  // "System audio" in the app: capture everything Windows plays, with no screen-share picker
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    const pick = nextSource; nextSource = null;
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    if (pick) {
      const src = sources.find(s => s.id === pick.id) || sources.find(s => s.id.startsWith('screen'));
      return cb(pick.audio ? { video: src, audio: 'loopback' } : { video: src });
    }
    cb({ video: sources.find(s => s.id.startsWith('screen')) || sources[0], audio: 'loopback' });   // "System audio" input
  });
}

function trayIcon() {
  const s = 32, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - s / 2 + .5, y - s / 2 + .5), a = Math.max(0, Math.min(1, s * .38 - d + .5));
    const i = (y * s + x) * 4; buf[i] = 48; buf[i + 1] = 59; buf[i + 2] = 255; buf[i + 3] = Math.round(a * 255);   // BGRA red dot
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s, scaleFactor: 2 });
}
function setupTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Gadget Cam Studio');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Gadget Cam Studio', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
    { label: 'Record / Stop    Ctrl+Shift+R', click: () => win && win.webContents.send('hotkey', 'record') },
    { label: 'Add marker       Ctrl+Shift+M', click: () => win && win.webContents.send('hotkey', 'marker') },
    { label: 'Open recordings folder', click: async () => shell.openPath(await folder()) },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
  tray.on('click', () => win && (win.isVisible() ? win.focus() : win.show()));
}

function setupHotkeys() {
  // Record and mark from any app.
  globalShortcut.register('CommandOrControl+Shift+R', () => win && win.webContents.send('hotkey', 'record'));
  globalShortcut.register('CommandOrControl+Shift+M', () => win && win.webContents.send('hotkey', 'marker'));
}

// ---------- file IPC ----------
const streams = new Map();
let nextId = 1;
async function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, -ext.length || undefined);
  let p = path.join(dir, name), n = 2;
  while (true) { try { await fsp.access(p); p = path.join(dir, `${base} (${n++})${ext}`); } catch { return p; } }
}

ipcMain.handle('getFolder', () => folder());
ipcMain.handle('chooseFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose where recordings are saved', defaultPath: await folder(), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.folder = r.filePaths[0]; saveSettings();
  return settings.folder;
});
// backup drive: a second copy of every file, written at the same time
async function backupFolder() {
  if (!settings.backup) return null;
  try { await fsp.access(settings.backup); return settings.backup; } catch { return null; }
}
ipcMain.handle('getBackupFolder', () => settings.backup || null);
ipcMain.handle('chooseBackupFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a backup folder (ideally on another drive)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.backup = r.filePaths[0]; saveSettings();
  return settings.backup;
});
ipcMain.handle('clearBackupFolder', () => { delete settings.backup; saveSettings(); });
ipcMain.handle('backupFreeSpace', async () => { const d = await backupFolder(); if (!d) return null; const s = await fsp.statfs(d); return s.bavail * s.bsize; });
// rewrite bytes inside a finished file (WAV headers get their final sizes this way)
ipcMain.handle('patch', async (_, p, pos, ab) => { const fh = await fsp.open(p, 'r+'); try { await fh.write(Buffer.from(ab), 0, ab.byteLength, pos); } finally { await fh.close(); } });
ipcMain.handle('openFile', async (_, name, where) => {
  const dir = where === 'backup' ? await backupFolder() : await folder();
  if (!dir) throw new Error('Backup folder not available');
  const p = await uniquePath(dir, name);
  const ws = fs.createWriteStream(p);
  const id = nextId++;
  streams.set(id, { ws, path: p });
  return id;
});
ipcMain.handle('write', (_, id, ab) => new Promise((res, rej) => {
  const s = streams.get(id); if (!s) return rej(new Error('closed'));
  s.ws.write(Buffer.from(ab), err => err ? rej(err) : res());
}));
ipcMain.handle('close', (_, id) => new Promise(res => {
  const s = streams.get(id); if (!s) return res(null);
  streams.delete(id); s.ws.end(() => res(s.path));
}));
ipcMain.handle('writeText', async (_, name, text) => { const p = await uniquePath(await folder(), name); await fsp.writeFile(p, text, 'utf8'); return p; });
ipcMain.handle('freeSpace', async () => { const s = await fsp.statfs(await folder()); return s.bavail * s.bsize; });

// ---------- FFmpeg finishing: constant frame rate MP4 that DaVinci Resolve edits cleanly ----------
function run(args) {
  return new Promise(res => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-4000); });
    p.on('close', code => res({ code, err }));
    p.on('error', e => res({ code: -1, err: e.message }));
  });
}
const ENCODERS = {
  h264: b => [['-c:v', 'h264_amf', '-rc', 'cbr', '-b:v', b, '-quality', 'quality'], ['-c:v', 'h264_nvenc', '-preset', 'p5', '-b:v', b], ['-c:v', 'h264_qsv', '-b:v', b], ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17']],
  h265: b => [['-c:v', 'hevc_amf', '-rc', 'cbr', '-b:v', b, '-quality', 'quality'], ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-b:v', b], ['-c:v', 'hevc_qsv', '-b:v', b], ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20', '-tag:v', 'hvc1']],
};
let workingEncoder = {};
ipcMain.handle('finalize', async (_, items, opts) => {
  const out = [];
  for (const it of items) {
    try {
      const dir = path.dirname(it.path), ext = path.extname(it.path), base = path.basename(it.path, ext);
      const originals = path.join(dir, 'Originals');
      await fsp.mkdir(originals, { recursive: true });
      const src = await uniquePath(originals, path.basename(it.path));
      await fsp.rename(it.path, src);
      const dst = await uniquePath(dir, base + '.mp4');
      const fps = String(Math.round(it.fps || 30)), br = String(Math.round((it.bitrate || 16e6) * 1.1));
      const list = ENCODERS[opts.codec === 'h265' ? 'h265' : 'h264'](br);
      const order = workingEncoder[opts.codec] != null ? [list[workingEncoder[opts.codec]], ...list] : list;
      let ok = false, last = '';
      for (const enc of order) {
        const r = await run(['-hide_banner', '-y', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-fps_mode', 'cfr', '-r', fps,
          ...enc, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', dst]);
        if (r.code === 0) { ok = true; workingEncoder[opts.codec] = list.indexOf(enc); break; }
        last = r.err.split('\n').filter(Boolean).slice(-2).join(' ');
      }
      if (ok) out.push({ ok: true, path: dst });
      else { await fsp.rename(src, it.path).catch(() => {}); out.push({ ok: false, path: it.path, error: last }); }
    } catch (e) { out.push({ ok: false, path: it.path, error: e.message }); }
  }
  return out;
});
ipcMain.handle('openFolder', async () => shell.openPath(await folder()));

// Phone cameras: our own local HTTPS server uses a self-signed certificate; trust it for the app's own connection.
app.on('certificate-error', (e, wc, url, err, cert, cb) => {
  const i = phoneServer.info;
  if (i && (url.startsWith(`https://127.0.0.1:${i.port}`) || i.ips.some(ip => url.startsWith(`https://${ip}:${i.port}`)))) { e.preventDefault(); cb(true); }
  else cb(false);
});
ipcMain.handle('phoneInfo', async () => {
  const i = await phoneServer.start({ dataDir: app.getPath('userData') });
  let qr = '';
  try { qr = await require('qrcode').toDataURL(i.phoneUrl, { margin: 1, width: 440, errorCorrectionLevel: 'M' }); } catch {}
  return { ...i, qr };
});
ipcMain.handle('phoneReset', async () => {
  const i = phoneServer.resetToken(app.getPath('userData'));
  let qr = '';
  try { qr = await require('qrcode').toDataURL(i.phoneUrl, { margin: 1, width: 440, errorCorrectionLevel: 'M' }); } catch {}
  return { ...i, qr };
});

// ---------- auto-updates from GitHub Releases ----------
let updater = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  try { updater = require('electron-updater').autoUpdater; } catch { updater = null; return; }
  updater.autoDownload = true; updater.autoInstallOnAppQuit = true;
  const send = (state, extra = {}) => win && win.webContents.send('update', { state, ...extra });
  updater.on('checking-for-update', () => send('checking'));
  updater.on('update-available', i => send('downloading', { version: i.version, percent: 0 }));
  updater.on('update-not-available', () => send('current'));
  updater.on('download-progress', p => send('downloading', { percent: Math.round(p.percent) }));
  updater.on('update-downloaded', i => send('ready', { version: i.version }));
  updater.on('error', e => send('error', { message: String((e && e.message) || e).split('\n')[0] }));
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 8000);
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000);
}
ipcMain.handle('appVersion', () => app.getVersion());
ipcMain.handle('checkUpdates', async () => {
  if (!updater) return { state: app.isPackaged ? 'unavailable' : 'dev' };
  try { await updater.checkForUpdates(); return { state: 'checking' }; } catch (e) { return { state: 'error', message: e.message }; }
});
ipcMain.handle('installUpdate', () => { if (updater) updater.quitAndInstall(false, true); });

app.whenReady().then(() => {
  setupPermissions();
  createWindow();
  setupTray();
  setupHotkeys();
  setupUpdates();
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

// AI voice cleanup (RNNoise). The model ships inside @sapphi-red/web-noise-suppressor; we hand its worklet + wasm to the page.
let rnnCache = null;
ipcMain.handle('rnnoise', async () => {
  if (rnnCache) return rnnCache;
  try {
    const root = [path.join(__dirname, 'node_modules', '@sapphi-red', 'web-noise-suppressor'),
      path.join(process.resourcesPath || '', 'app.asar', 'node_modules', '@sapphi-red', 'web-noise-suppressor')].find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    if (!root) throw new Error('RNNoise package missing');
    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else files.push(p); } };
    walk(root);
    const low = p => p.replace(/\\/g, '/').toLowerCase();
    const js = files.filter(p => /rnnoise/.test(low(p)) && /\.m?js$/.test(low(p)));
    const worklet = js.map(p => [p, fs.readFileSync(p, 'utf8')]).find(([, t]) => /registerProcessor\s*\(/.test(t) && !/^\s*import\s/m.test(t));
    const wasm = files.find(p => /^rnnoise\.wasm$/.test(path.basename(low(p))));
    const simd = files.find(p => /^rnnoise[_-]simd\.wasm$/.test(path.basename(low(p))));
    if (!worklet || !wasm) throw new Error('RNNoise files not found');
    const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    rnnCache = { worklet: worklet[1], wasm: ab(await fsp.readFile(wasm)), simd: simd ? ab(await fsp.readFile(simd)) : null };
    return rnnCache;
  } catch (e) { return { error: e.message }; }
});
