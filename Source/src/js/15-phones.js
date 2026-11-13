// Phones as cameras or microphones over Wi-Fi (Windows app). The phone opens a page from our local server
// (QR code), we exchange WebRTC offers through that server, and the video/audio flows phone → app directly.
const phones = new Map();       // phoneId → { id, name, mode, pc, dc, cam, ch, caps, stats, state }
let phoneInfo = null, phoneES = null, pairDlgOpen = false;
const allowedPhones = () => store.get('allowedPhones', {});
const pendingPhones = new Map();

async function phoneService() {
  if (!NATIVE || !NATIVE.phoneInfo) return null;
  if (!phoneInfo) {
    try { phoneInfo = await NATIVE.phoneInfo(); }
    catch (e) { log('Phone server could not start: ' + e.message); return null; }
  }
  if (!phoneES) listenPhones();
  return phoneInfo;
}
function listenPhones() {
  phoneES = new EventSource(`${phoneInfo.appUrl}/events?role=app&k=${encodeURIComponent(phoneInfo.token)}`);
  phoneES.onopen = () => phoneSignal({ to: 'phones', type: 'who' });
  phoneES.onmessage = e => { try { onPhoneMsg(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
}
function phoneSignal(m) {
  if (!phoneInfo) return;
  return fetch(`${phoneInfo.appUrl}/signal?k=${encodeURIComponent(phoneInfo.token)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ from: 'app', ...m }) }).catch(() => {});
}

async function onPhoneMsg(m) {
  const p = phones.get(m.from);
  if (m.type === 'hello') {
    const allowed = allowedPhones()[m.from];
    if (allowed || !store.get('askNewPhones', true)) return connectPhone(m.from, m.name, m.mode || 'camera');
    if (pendingPhones.has(m.from)) return;
    pendingPhones.set(m.from, m);
    askToAllow(m);
  } else if (m.type === 'answer' && p && p.pc) {
    await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
  } else if (m.type === 'ice' && p && p.pc && m.candidate) {
    try { await p.pc.addIceCandidate(m.candidate); } catch {}
  } else if (m.type === 'bye' && p) {
    setTimeout(() => { const q = phones.get(m.from); if (q && q.pc && q.pc.connectionState !== 'connected') phoneLost(q); }, 4000);
  }
}

function askToAllow(m) {
  const kind = m.mode === 'mic' ? 'microphone' : 'camera';
  const d = openMenu('New phone', `
    <div style="text-align:center;padding:6px 0 4px">${icon(m.mode === 'mic' ? 'mic' : 'phone')}
      <p style="margin:10px 0 4px;font-size:15px"><b>${esc(m.name || 'A phone')}</b> wants to join as a ${kind}.</p>
      <p class="note" style="padding:0 0 14px">Only allow phones you recognize. Allowed phones reconnect on their own next time.</p></div>
    <div style="display:flex;gap:8px"><button class="btn" data-a="no" style="flex:1;justify-content:center">Decline</button><button class="btn primary" data-a="yes" style="flex:1;justify-content:center">Allow</button></div>`,
    (body, dlg) => body.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      dlg.close(); pendingPhones.delete(m.from);
      if (b.dataset.a === 'yes') { const a = allowedPhones(); a[m.from] = { name: m.name, at: Date.now() }; store.set('allowedPhones', a); connectPhone(m.from, m.name, m.mode || 'camera'); }
      else { phoneSignal({ to: m.from, type: 'declined' }); log(`Declined ${m.name || 'a phone'}`); }
    }));
  d.addEventListener('close', () => pendingPhones.delete(m.from), { once: true });
}

// prefer the phone's hardware H.264 encoder (High profile first), then VP9
function preferCodecs(tr) {
  if (!tr.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
  const list = RTCRtpReceiver.getCapabilities('video').codecs;
  const score = c => {
    const m = c.mimeType.toLowerCase(), f = c.sdpFmtpLine || '';
    if (m === 'video/h264') return /profile-level-id=64/i.test(f) ? 0 : /profile-level-id=4d/i.test(f) ? 1 : 2;
    if (m === 'video/vp9') return 3; if (m === 'video/av1') return 4; if (m === 'video/vp8') return 5;
    return 9;                                     // rtx, red, ulpfec stay at the end
  };
  try { tr.setCodecPreferences(list.slice().sort((a, b) => score(a) - score(b))); } catch {}
}
// tell the phone it may send a lot: high video bandwidth, stereo full-rate Opus
function boostSdp(sdp) {
  return sdp.split(/(?=\r\nm=)/).map(sec => {
    if (/^(\r\n)?m=video/.test(sec)) {
      if (!/\r\nb=AS:/.test(sec)) sec = sec.replace(/(\r\nc=[^\r\n]*)/, '$1\r\nb=AS:45000');
      const pts = [...sec.matchAll(/a=rtpmap:(\d+) (H264|VP9|VP8|AV1)\//gi)].map(m => m[1]);
      for (const pt of pts) sec = sec.replace(new RegExp(`(\\r\\na=fmtp:${pt} [^\\r\\n]*)`), '$1;x-google-start-bitrate=15000;x-google-min-bitrate=5000;x-google-max-bitrate=45000');
    }
    if (/^(\r\n)?m=audio/.test(sec)) {
      const pt = (sec.match(/a=rtpmap:(\d+) opus\/48000/i) || [])[1];
      if (pt) sec = sec.replace(new RegExp(`(\\r\\na=fmtp:${pt} [^\\r\\n]*)`), '$1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;usedtx=0;useinbandfec=1');
    }
    return sec;
  }).join('');
}

function uniqueCamName(base) {
  let n = base, i = 2;
  while (cams.some(c => c.name === n)) n = `${base} ${i++}`;
  return n;
}

async function connectPhone(id, name, mode) {
  const old = phones.get(id);
  if (old && old.pc) { try { old.pc.close(); } catch {} }
  const p = old || { id };
  Object.assign(p, { name: name || p.name || 'Phone', mode, state: 'connecting', caps: null, stats: null });
  phones.set(id, p);
  if (mode === 'camera') {
    p.cam = cams.find(c => c.kind === 'phone' && c.phoneId === id) || null;
    if (!p.cam) {
      p.cam = newCam({ kind: 'phone', phoneId: id, name: uniqueCamName(p.name), res: '2160', fps: 30 });
      p.cam.status = 'lost';
      bus.emit('cams');
    }
  }
  if (p.ch) { audio.remove(p.ch); p.ch = null; }
  const pc = p.pc = new RTCPeerConnection({ iceServers: [] });
  if (mode === 'camera') preferCodecs(pc.addTransceiver('video', { direction: 'recvonly' }));
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const dc = p.dc = pc.createDataChannel('ctl');
  dc.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'caps') { p.caps = m; if (m.name) p.name = m.name; if (p.cam && isSel(p.cam) && inspTab === 'camera') renderInspector(); renderPairList(); }
    if (m.type === 'stats') { p.stats = m; const el = $('#phoneStats'); if (el && p.cam && isSel(p.cam)) el.textContent = phoneStatsText(p); }
  };
  pc.onicecandidate = e => { if (e.candidate) phoneSignal({ to: id, type: 'ice', candidate: e.candidate }); };
  pc.ontrack = async e => {
    const t = e.track;
    if (t.kind === 'video' && p.cam) {
      p.cam.remoteStream = new MediaStream([t]);
      await openCam(p.cam);
      t.addEventListener('ended', () => phoneLost(p));
    }
    if (t.kind === 'audio') {
      const isMic = mode === 'mic';
      const ch = await audio.addChannel({ kind: 'phone', name: isMic ? p.name : `${p.cam ? p.cam.name : p.name} mic`, stream: new MediaStream([t]),
        s: { ...withPreset(isMic ? 'Natural Voice' : 'Phone mic'), recMute: !isMic, monMute: true } });
      p.ch = ch;
      if (!isMic) log(`${ch.name} added to the mixer, muted in the recording. Unmute REC to use it.`);
      if (isMic) toast(`${p.name} is ready as a microphone`);
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    p.state = s;
    if (s === 'connected') { log(`${p.name} connected (${mode})`); if (mode === 'camera') toast(`${p.cam.name} connected`); }
    if (s === 'failed' || s === 'closed') phoneLost(p);
    if (s === 'disconnected') setTimeout(() => { if (pc.connectionState === 'disconnected') phoneLost(p); }, 4000);
    renderPairList();
  };
  const offer = await pc.createOffer();
  const sdp = boostSdp(offer.sdp);
  await pc.setLocalDescription({ type: 'offer', sdp });
  phoneSignal({ to: id, type: 'offer', sdp });
  renderPairList();
}

function phoneLost(p) {
  if (p.state === 'lost') return;
  p.state = 'lost';
  if (p.cam && p.cam.status !== 'lost') { p.cam.alive = false; p.cam.status = 'lost'; p.cam.remoteStream = null; bus.emit('camLost', p.cam); bus.emit('cam', p.cam); }
  if (p.ch) { p.ch.alive = false; bus.emit('audio'); }
  log(`${p.name} disconnected`);
  renderPairList();
}
function closePhone(cam) {
  for (const p of phones.values()) if (p.cam === cam) { try { p.pc && p.pc.close(); } catch {} if (p.ch) audio.remove(p.ch); phones.delete(p.id); }
}
function phoneOf(cam) { for (const p of phones.values()) if (p.cam === cam) return p; return null; }
function phoneCmd(cam, cmd) { const p = phoneOf(cam); if (p && p.dc && p.dc.readyState === 'open') p.dc.send(JSON.stringify({ cmd: 'set', ...cmd })); }
function phoneStatsText(p) {
  const s = p.stats; if (!s) return 'Waiting for stats…';
  return `Receiving ${s.w || '?'}×${s.h || '?'} · ${Math.round(s.fps || 0)} fps · ${(s.mbps || 0).toFixed(1)} Mbps${s.limit && s.limit !== 'none' ? ` · limited by ${s.limit === 'bandwidth' ? 'Wi-Fi speed' : s.limit}` : ''}`;
}

// ---------- pairing screen (shown at startup and from "Add camera") ----------
function renderPairList() {
  const el = $('#pairList'); if (!el) return;
  const list = [...phones.values()];
  el.innerHTML = list.length ? list.map(p => `<div class="item"><span class="dot ${p.state === 'connected' ? 'live' : p.state === 'lost' ? 'lost' : 'opening'}"></span>${icon(p.mode === 'mic' ? 'mic' : 'phone', 'sm')}
      <span class="grow">${esc(p.cam ? p.cam.name : p.name)}<div class="sub">${p.mode === 'mic' ? 'Microphone' : 'Camera'} · ${p.state === 'connected' ? 'Connected' : p.state === 'lost' ? 'Disconnected' : 'Connecting…'}</div></span></div>`).join('')
    : '<div class="empty-note">Waiting for a phone to scan the code…</div>';
}

async function openPhonePairing(fromStartup = false) {
  if (!NATIVE || !NATIVE.phoneInfo) {
    return openMenu('Add a phone', `<p class="note" style="padding:0">Phone cameras and microphones need the Windows app, because it runs the small local server your phone connects to. In the browser, use Camo or Windows Phone Link to add a phone as a regular camera.</p>`);
  }
  const info = await phoneService();
  if (!info) return toast('The phone server could not start. See Settings → Activity.', 'err');
  pairDlgOpen = true;
  const d = openMenu(fromStartup ? 'Connect your phones' : 'Add a phone', `
    <div style="display:flex;gap:18px;align-items:flex-start">
      <img id="pairQr" src="${info.qr}" alt="QR code" style="width:180px;height:180px;border-radius:12px;background:#fff;padding:6px;flex:none">
      <ol class="note keep" style="margin:0;padding:0 0 0 18px;line-height:1.55;color:var(--text)">
        <li>Connect the phone to the same Wi-Fi as this computer.</li>
        <li>Scan the code with the phone’s camera.</li>
        <li>The phone will warn that the connection isn’t private. That’s expected for a local app. On iPhone tap <b>Show Details → visit this website</b>; on Android tap <b>Advanced → Proceed</b>.</li>
        <li>Choose <b>Use as camera</b> or <b>Use as microphone</b>.</li>
      </ol>
    </div>
    <div class="note keep" style="padding:10px 0 0;font-family:var(--mono);font-size:11.5px;user-select:all;word-break:break-all">${esc(info.phoneUrl)}</div>
    ${info.altUrls && info.altUrls.length ? `<div class="note keep" style="padding:4px 0 0;font-size:11.5px">Phone can’t connect? You may be on a different network. Try: <span style="font-family:var(--mono);user-select:all">${info.altUrls.map(esc).join(' · ')}</span></div>` : ''}
    <div class="cat">Phones</div><div id="pairList"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:14px">
      <label class="sw" style="transform:scale(.85)"><input type="checkbox" id="pairStartup" ${store.get('pairAtStartup', true) ? 'checked' : ''}><i></i></label>
      <span class="note" style="padding:0;flex:1">Show this when Gadget Cam Studio opens</span>
      <button class="btn" id="pairNew" title="Make a new code. Old links stop working.">New code</button>
      <button class="btn primary" id="pairDone">${fromStartup ? 'Continue' : 'Done'}</button>
    </div>
    <p class="note" style="padding:8px 0 0">If Windows asks about the firewall, allow Gadget Cam Studio on <b>private networks</b>.</p>`,
    (body, dlg) => {
      body.querySelector('#pairDone').onclick = () => dlg.close();
      body.querySelector('#pairStartup').onchange = e => store.set('pairAtStartup', e.target.checked);
      body.querySelector('#pairNew').onclick = async () => {
        phoneInfo = await NATIVE.phoneReset();
        try { phoneES && phoneES.close(); } catch {} phoneES = null; listenPhones();
        body.querySelector('#pairQr').src = phoneInfo.qr;
        toast('New code made. Phones you already allowed need to scan it again.');
        dlg.close(); openPhonePairing(fromStartup);
      };
      renderPairList();
    });
  d.style.width = '560px';
  d.addEventListener('close', () => { pairDlgOpen = false; d.style.width = ''; }, { once: true });
}

// greet on launch, and keep listening for allowed phones in the background
async function phonesOnBoot() {
  if (!NATIVE || !NATIVE.phoneInfo) return;
  await phoneService();
  if (store.get('pairAtStartup', true)) setTimeout(() => openPhonePairing(true), 600);
}
