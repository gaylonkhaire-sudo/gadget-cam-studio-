// Safe bridge between the app page and Windows (files, FFmpeg, hotkeys).
const { contextBridge, ipcRenderer } = require('electron');
let vcam = null;
try { vcam = require('./vcam.js'); } catch (e) { vcam = null; }

contextBridge.exposeInMainWorld('mcrNative', {
  platform: process.platform,
  getFolder: () => ipcRenderer.invoke('getFolder'),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  openFolder: () => ipcRenderer.invoke('openFolder'),
  openFile: (name, where) => ipcRenderer.invoke('openFile', name, where),
  patch: (path, pos, arrayBuffer) => ipcRenderer.invoke('patch', path, pos, arrayBuffer),
  getBackupFolder: () => ipcRenderer.invoke('getBackupFolder'),
  chooseBackupFolder: () => ipcRenderer.invoke('chooseBackupFolder'),
  clearBackupFolder: () => ipcRenderer.invoke('clearBackupFolder'),
  backupFreeSpace: () => ipcRenderer.invoke('backupFreeSpace'),
  appVersion: () => ipcRenderer.invoke('appVersion'),
  checkUpdates: () => ipcRenderer.invoke('checkUpdates'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  onUpdate: cb => ipcRenderer.on('update', (_, u) => cb(u)),
  write: (id, arrayBuffer) => ipcRenderer.invoke('write', id, arrayBuffer),
  close: id => ipcRenderer.invoke('close', id),
  writeText: (name, text) => ipcRenderer.invoke('writeText', name, text),
  freeSpace: () => ipcRenderer.invoke('freeSpace'),
  finalize: (items, opts) => ipcRenderer.invoke('finalize', items, opts),
  onHotkey: cb => ipcRenderer.on('hotkey', (_, k) => cb(k)),
  vcamAvailable: () => vcam ? vcam.available() : { ok: false, error: 'Virtual camera component missing' },
  vcamStart: (w, h, fps) => { try { return vcam.start(w, h, fps); } catch (e) { return { ok: false, error: e.message }; } },
  vcamFrame: data => { try { return vcam.frame(data); } catch { return false; } },
  vcamStop: () => { try { vcam && vcam.stop(); } catch {} },
  listSources: () => ipcRenderer.invoke('listSources'),
  chooseSource: (id, audio) => ipcRenderer.invoke('chooseSource', id, audio),
  phoneInfo: () => ipcRenderer.invoke('phoneInfo'),
  phoneReset: () => ipcRenderer.invoke('phoneReset'),
  rnnoise: () => ipcRenderer.invoke('rnnoise'),
  vcamStatus: () => { try { return vcam ? vcam.status() : { mode: null }; } catch { return { mode: null }; } },
});
