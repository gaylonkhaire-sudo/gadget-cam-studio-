// Feeds the app's output to a virtual camera so Meet, Zoom, Teams, OBS, etc. see it as a webcam.
// 1st choice: our own "Gadget Cam Studio" camera (Windows 11, installed by the app installer).
// Fallback:   the OBS Virtual Camera driver (installed with OBS Studio 26+; OBS doesn't need to be running).
// Shared-memory layout matches OBS's video queue: header (aligned to 32) followed by 3 NV12 frame slots,
// each slot = 32-byte frame header (timestamp first) + NV12 data, aligned to 32.
const fs = require('fs');
const path = require('path');

const NAME = 'OBSVirtualCamVideo';
const STATE = { INVALID: 0, STARTING: 1, READY: 2, STOPPING: 3 };
const FRAME_HEADER = 32;
const align = (v, a) => (v + a - 1) & ~(a - 1);
// struct queue_header: write_idx@0 read_idx@4 state@8 offsets[3]@12 type@24 cx@28 cy@32 (pad) interval@40 reserved[8]@48 → 80 bytes
const OFF = { write: 0, read: 4, state: 8, offsets: 12, type: 24, cx: 28, cy: 32, interval: 40 };
const HEADER_SIZE = 80;

let k = null;
function api() {
  if (k) return k;
  const koffi = require('koffi');
  const lib = koffi.load('kernel32.dll');
  k = {
    CreateFileMappingW: lib.func('void* __stdcall CreateFileMappingW(intptr_t hFile, void* attrs, uint32_t protect, uint32_t hi, uint32_t lo, str16 name)'),
    OpenFileMappingW: lib.func('void* __stdcall OpenFileMappingW(uint32_t access, int inherit, str16 name)'),
    MapViewOfFile: lib.func('uintptr_t __stdcall MapViewOfFile(void* h, uint32_t access, uint32_t hi, uint32_t lo, uintptr_t bytes)'),
    UnmapViewOfFile: lib.func('int __stdcall UnmapViewOfFile(uintptr_t addr)'),
    CloseHandle: lib.func('int __stdcall CloseHandle(void* h)'),
    Move: lib.func('void __stdcall RtlMoveMemory(uintptr_t dst, const void* src, uintptr_t len)'),
    MoveIn: lib.func('RtlMoveMemory', 'void', ['void *', 'uintptr_t', 'uintptr_t']),
    Tick: lib.func('uint64_t __stdcall GetTickCount64()'),
  };
  return k;
}

let q = null;   // { handle, base(BigInt), cx, cy, offsets[], frameBytes, idx, t0 }
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const put = (off, buf) => api().Move(q.base + BigInt(off), buf, buf.length);

const resFile = () => path.join(process.env.APPDATA || '', 'obs-studio', 'obs-virtualcam.txt');
let savedRes = null;

// ---------- Gadget Cam Studio camera ----------
const GCS = { name: 'Global\\GadgetCamStudioFrames', clsid: '{476C473E-FE84-43EB-82C1-F0C70887D7C9}', magic: 0x31534347,
  header: 64, slots: 3, slotBytes: 1920 * 1080 * 3 / 2 };
let mode = null;                    // 'gcs' | 'obs'
let g = null;                       // { handle, base, cx, cy, fps, count }
let gLastTry = 0;
function gcsInstalled() {
  if (process.platform !== 'win32') return false;
  try {
    const r = require('child_process').spawnSync('reg', ['query', `HKLM\\Software\\Classes\\CLSID\\${GCS.clsid}\\InprocServer32`], { windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}
function gcsOpen() {
  if (g && g.base) return true;
  const now = Date.now(); if (now - gLastTry < 1000) return false; gLastTry = now;
  const a = api();
  const size = GCS.header + GCS.slots * GCS.slotBytes;
  const handle = a.OpenFileMappingW(0x0002 | 0x0004, 0, GCS.name);      // exists only while an app is using the camera
  if (!handle) return false;
  const addr = a.MapViewOfFile(handle, 0x0002 | 0x0004, 0, 0, size);
  if (!addr) { a.CloseHandle(handle); return false; }
  const base = BigInt(addr), hb = Buffer.alloc(4);
  a.MoveIn(hb, base, 4);
  if (hb.readUInt32LE(0) !== GCS.magic) { a.UnmapViewOfFile(base); a.CloseHandle(handle); return false; }
  g.handle = handle; g.base = base;
  return true;
}
function gcsWrite(buf) {
  if (!gcsOpen()) return false;
  const a = api(), b = g.base;
  const next = g.count + 1, slot = next % GCS.slots;
  a.Move(b + BigInt(GCS.header + slot * GCS.slotBytes), buf, Math.min(buf.length, GCS.slotBytes));
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(g.cx, 0); hdr.writeUInt32LE(g.cy, 4); hdr.writeUInt32LE(g.fps, 8);
  a.Move(b + 8n, hdr, 12);                                            // width, height, fps
  a.Move(b + 24n, u64(a.Tick()), 8);                                  // lastWriteMs
  a.Move(b + 20n, u32(next), 4);                                      // writeCount last: frame is complete
  g.count = next;
  return true;
}
function gcsClose() {
  if (g && g.base) { try { api().UnmapViewOfFile(g.base); api().CloseHandle(g.handle); } catch {} }
  g = null;
}

function available() {
  if (process.platform !== 'win32') return { ok: false, error: 'Virtual camera is Windows only' };
  try { api(); return { ok: true }; } catch (e) { return { ok: false, error: 'Virtual camera component missing: ' + e.message }; }
}

function start(cx, cy, fps) {
  stop();
  const a = api();
  cx = cx & ~1; cy = cy & ~1;
  if (gcsInstalled() && cx <= 1920 && cy <= 1080) {
    mode = 'gcs'; g = { cx, cy, fps: fps || 30, count: 0 }; gcsOpen();
    return { ok: true, mode, cx, cy, connected: !!(g && g.base) };
  }
  mode = 'obs';
  // If the mapping already exists, OBS's own virtual camera (or another app) is using it.
  const existing = a.OpenFileMappingW(0x0004 /* FILE_MAP_READ */, 0, NAME);
  if (existing) { a.CloseHandle(existing); return { ok: false, error: 'The OBS Virtual Camera is already in use. Stop “Start Virtual Camera” in OBS (or the other app using it), then try again.' }; }
  const frameBytes = cx * cy * 3 / 2;
  const slot = align(frameBytes + FRAME_HEADER, 32);
  const first = align(HEADER_SIZE, 32);
  const size = first + slot * 3;
  const handle = a.CreateFileMappingW(-1, null, 0x04 /* PAGE_READWRITE */, 0, size, NAME);
  if (!handle) return { ok: false, error: 'Could not create the virtual camera buffer' };
  const addr = a.MapViewOfFile(handle, 0xF001F /* FILE_MAP_ALL_ACCESS */, 0, 0, size);
  if (!addr) { a.CloseHandle(handle); return { ok: false, error: 'Could not map the virtual camera buffer' }; }
  q = { handle, base: BigInt(addr), cx, cy, frameBytes, offsets: [first, first + slot, first + slot * 2], idx: 0, t0: process.hrtime.bigint() };
  const interval = Math.round(10000000 / (fps || 30));           // 100 ns units
  put(0, Buffer.alloc(first));                                      // zero the header
  put(OFF.state, u32(STATE.STARTING));
  q.offsets.forEach((o, i) => put(OFF.offsets + i * 4, u32(o)));
  put(OFF.type, u32(0));                                            // video queue
  put(OFF.cx, u32(cx)); put(OFF.cy, u32(cy));
  put(OFF.interval, u64(interval));
  // Tell the camera driver our size so apps that open it next pick the right format
  try {
    const f = resFile();
    if (fs.existsSync(path.dirname(f))) { savedRes = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; fs.writeFileSync(f, `${cx}x${cy}x${interval}`); }
  } catch {}
  return { ok: true, mode, cx, cy };
}

// data: NV12 bytes (Y plane, then interleaved UV), exactly cx*cy*1.5
function frame(data) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (mode === 'gcs') return gcsWrite(buf);
  if (!q) return false;
  if (buf.length < q.frameBytes) return false;
  q.idx++;
  const slotIdx = (q.idx - 1) % 3, off = q.offsets[slotIdx];
  put(off, u64(process.hrtime.bigint() - q.t0));                    // timestamp in ns
  put(off + FRAME_HEADER, buf.subarray(0, q.frameBytes));
  put(OFF.write, u32(q.idx));
  put(OFF.read, u32(slotIdx));
  put(OFF.state, u32(STATE.READY));
  return true;
}

function stop() {
  if (mode === 'gcs') gcsClose();
  mode = null;
  if (!q) return;
  try { put(OFF.state, u32(STATE.STOPPING)); } catch {}
  const a = api();
  try { a.UnmapViewOfFile(q.base); } catch {}
  try { a.CloseHandle(q.handle); } catch {}
  q = null;
  try { if (savedRes != null) { const f = resFile(); savedRes ? fs.writeFileSync(f, savedRes) : fs.unlinkSync(f); } } catch {}
  savedRes = null;
}

function status() { return { mode, connected: mode === 'gcs' ? !!(g && g.base) : !!q, gcsInstalled: gcsInstalled() }; }

module.exports = { available, start, frame, stop, status };
