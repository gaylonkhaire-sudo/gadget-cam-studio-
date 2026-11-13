// Audio UI: mixer dock strips, sidebar list, channel inspector (presets, EQ curve, FX), master inspector, sound check.
const BANDS = [['ls', 'Low', 30, 400, false], ['lm', 'Low-mid', 100, 1000, true], ['md', 'Mid', 300, 3000, true], ['pr', 'Presence', 1500, 10000, true], ['hs', 'Air', 3000, 16000, false]];
const hz = v => v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + ' kHz' : Math.round(v) + ' Hz';
const dB = v => (v > 0 ? '+' : '') + v + ' dB';
let eqAdv = store.get('eqAdv', false);

function faderHtml(cls, label, val) {
  return `<div class="fcol"><span class="v ${cls}">${fmtDb(sliderDb(val))}</span><input type="range" class="vf ${cls}" min="0" max="100" step="0.5" value="${val}" title="${label}"></div>`;
}
function wireFader(root, cls, get, set, after) {
  const f = root.querySelector('input.vf.' + cls), v = root.querySelector('.v.' + cls);
  const upd = val => { set(val); v.textContent = fmtDb(sliderDb(val)); after(cls, val); };
  f.addEventListener('input', () => upd(+f.value));
  f.addEventListener('dblclick', () => { f.value = 91; upd(91); });
  f.addEventListener('pointerdown', e => e.stopPropagation());
}

function renderStrips() {
  const host = $('#strips'); host.innerHTML = '';
  for (const ch of audio.channels) {
    const s = ch.s;
    const el = h(`<div class="strip ${isSel(ch) ? 'sel' : ''} ${ch.alive ? '' : 'dead'}">
      <div class="nm">${esc(ch.name)}</div><div class="pz"><button class="role r-${roleOf(ch)}" title="Role (click to change): sets its level in mix presets and whether it ducks">${ROLES.find(r => r[0] === roleOf(ch))[1]}</button> ${esc(s.preset || 'Custom')}${s.presetEdited ? ' ·' : ''}</div>
      <div class="body"><div class="vm"><i></i><b></b></div>${audio.aiActive(ch) ? '<span class="aibadge strip-ai" title="AI voice cleanup is on">AI</span>' : ''}${faderHtml('rec', 'REC', s.rec)}${faderHtml('mon', 'MON', s.mon)}</div>
      <div class="row"><button class="mute rm ${s.recMute ? 'on' : ''}" title="Mute in recording">REC</button><button class="mute mm ${s.monMute ? 'on' : ''}" title="Mute in headphones">MON</button><button class="lk ${s.link ? 'on' : ''}" title="Move both faders together">LINK</button></div></div>`);
    ch.meterEl = el.querySelector('.vm');
    el.onclick = e => { if (!e.target.closest('button,input')) select('audio', ch); };
    el.querySelector('.role').onclick = e => { e.stopPropagation(); cycleRole(ch); };
    const after = (cls, val) => {
      if (s.link) { const o = cls === 'rec' ? 'mon' : 'rec'; s[o] = val; el.querySelector('input.vf.' + o).value = val; el.querySelector('.v.' + o).textContent = fmtDb(sliderDb(val)); }
      audio.apply(ch); saveCurrentSoon();
    };
    wireFader(el, 'rec', () => s.rec, v => s.rec = v, after);
    wireFader(el, 'mon', () => s.mon, v => s.mon = v, after);
    el.querySelector('.rm').onclick = e => { s.recMute = !s.recMute; e.currentTarget.classList.toggle('on', s.recMute); audio.apply(ch); saveCurrentSoon(); };
    el.querySelector('.mm').onclick = e => { s.monMute = !s.monMute; e.currentTarget.classList.toggle('on', s.monMute); audio.apply(ch); saveCurrentSoon(); };
    el.querySelector('.lk').onclick = e => { s.link = !s.link; e.currentTarget.classList.toggle('on', s.link); saveCurrentSoon(); };
    host.appendChild(el);
  }
  if (!audio.channels.length) host.appendChild(h(`<div class="empty-note" style="align-self:center;padding:30px 10px">No audio inputs. Click “Add input”.</div>`));
  const m = audio.master;
  const rec = h(`<div class="strip master ${selected && selected.type === 'master' ? 'sel' : ''}" style="margin-left:auto">
      <div class="nm">Record mix</div><div class="pz" id="cgText">Clipguard ${m.clipguard ? 'on' : 'off'}</div>
      <div class="body"><div class="vm"><i></i><b></b></div>${faderHtml('rec', 'REC', m.rec)}</div>
      <div class="row"><button class="mute ${m.recMute ? 'on' : ''}">MUTE</button></div></div>`);
  const mon = h(`<div class="strip master ${selected && selected.type === 'master' ? 'sel' : ''}">
      <div class="nm">Headphones</div><div class="pz">${m.monMute ? 'Muted' : 'Monitor mix'}</div>
      <div class="body"><div class="vm"><i></i><b></b></div>${faderHtml('mon', 'MON', m.mon)}</div>
      <div class="row"><button class="mute ${m.monMute ? 'on' : ''}">MUTE</button></div></div>`);
  audio.recMeterEl = rec.querySelector('.vm'); audio.monMeterEl = mon.querySelector('.vm');
  const mAfter = () => { audio.applyMaster(); saveCurrentSoon(); };
  wireFader(rec, 'rec', () => m.rec, v => m.rec = v, mAfter);
  wireFader(mon, 'mon', () => m.mon, v => m.mon = v, mAfter);
  rec.querySelector('.mute').onclick = e => { m.recMute = !m.recMute; e.currentTarget.classList.toggle('on', m.recMute); mAfter(); };
  mon.querySelector('.mute').onclick = e => { m.monMute = !m.monMute; e.currentTarget.classList.toggle('on', m.monMute); mon.querySelector('.pz').textContent = m.monMute ? 'Muted' : 'Monitor mix'; mAfter(); };
  [rec, mon].forEach(x => x.onclick = e => { if (!e.target.closest('button,input')) select('master', audio.master); });
  host.append(rec, mon);
}

function renderAudList() {
  const list = $('#audList'); list.innerHTML = '';
  if (!audio.channels.length) list.innerHTML = '<div class="empty-note">No audio inputs</div>';
  audio.channels.forEach(ch => {
    const it = h(`<div class="item ${isSel(ch) ? 'sel' : ''}"><span class="dot ${ch.alive ? 'live' : 'lost'}"></span>${icon(ch.kind === 'system' ? 'speaker' : 'mic', 'sm')}
      <span class="grow">${esc(ch.name)}<div class="sub">${esc(ch.s.preset || 'Custom')}</div></span><button class="x" title="Remove">${icon('x', 'sm')}</button></div>`);
    it.onclick = e => { if (e.target.closest('.x')) { audio.remove(ch); if (isSel(ch)) select(null); saveCurrent(); return; } select('audio', ch); };
    list.appendChild(it);
  });
}

// live meters
const meterHold = new WeakMap();
function paintMeter(el, db) {
  if (!el) return;
  const p = clamp((db + 60) / 60 * 100, 0, 100), st = meterHold.get(el) || { hold: 0 };
  st.hold = st.hold > p ? st.hold - 0.5 : p; meterHold.set(el, st);
  el.firstChild.style.height = p + '%'; el.lastChild.style.bottom = st.hold + '%';
}
(function meterLoop() {
  if (audio.recAn) {
    audio.channels.forEach(ch => ch.n && paintMeter(ch.meterEl, audio.peakOf(ch.n.an)));
    paintMeter(audio.recMeterEl, audio.peakOf(audio.recAn)); paintMeter(audio.monMeterEl, audio.peakOf(audio.monAn));
    const cg = $('#cgText');
    if (cg) { const r = audio.cg; cg.textContent = !audio.master.clipguard ? 'Clipguard off' : r > 0.02 ? `Clipguard −${(-20 * Math.log10(1 - r)).toFixed(1)} dB` : 'Clipguard on'; cg.style.color = audio.master.clipguard && r > 0.02 ? 'var(--warn)' : ''; }
  }
  requestAnimationFrame(meterLoop);
})();

function addAudioMenu() {
  const used = new Set(audio.channels.map(c => c.deviceId));
  const devs = audioDevices.filter(d => d.deviceId !== 'default' && !used.has(d.deviceId));
  openMenu('Add audio input',
    devs.map(d => `<div class="item" data-id="${esc(d.deviceId)}">${icon('mic', 'sm')}<span class="grow">${esc(shortName(d.label) || 'Microphone')}<div class="sub">Preset: ${esc(guessPreset(d.label))}</div></span></div>`).join('') +
    `<div class="item" data-sys="1">${icon('speaker', 'sm')}<span class="grow">System audio<div class="sub">Games, browser, music${NATIVE ? '' : ' (Chrome asks to share your screen)'}</div></span></div>`,
    (body, dlg) => body.querySelectorAll('.item').forEach(el => el.onclick = async () => {
      dlg.close();
      let ch;
      if (el.dataset.sys) ch = await audio.addSystemAudio();
      else { const d = audioDevices.find(x => x.deviceId === el.dataset.id); ch = await audio.addChannel({ kind: 'device', deviceId: d.deviceId, label: d.label, name: shortName(d.label) || 'Mic', s: withPreset(guessPreset(d.label)) }); }
      if (ch) { select('audio', ch); saveCurrent(); }
    }));
}

async function runSoundCheck() {
  if (!audio.channels.length) return toast('Add an audio input first', 'err');
  if (recState.active) return toast('Stop recording first', 'err');
  const btn = $('#soundCheck'); btn.disabled = true;
  toast('Sound check: talk normally for 5 seconds…');
  const res = await audio.soundCheck(5, left => { btn.textContent = `Listening… ${Math.ceil(left)}`; });
  btn.disabled = false; btn.innerHTML = `${icon('wave', 'sm')} Sound check`;
  const done = res.filter(r => !r.skipped);
  toast(done.length ? 'Levels set: ' + done.map(r => `${r.name} ${dB(r.gain)}`).join(', ') : 'No sound heard. Check your inputs.', done.length ? '' : 'err');
  saveCurrent(); renderInspector();
}

// ---------- channel inspector ----------
// EQ view: the curve glides to new settings, with the live voice behind it (grey = what comes in, color = what you hear).
const eqView = { ch: null, cur: null, tgt: null, run: false, bins: null, binsIn: null, pulse: 0 };
function eqTarget(ch) {
  const N = 240, f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = 20 * Math.pow(1000, i / (N - 1));
  const mag = new Float32Array(N).fill(1), m = new Float32Array(N), ph = new Float32Array(N);
  for (const k of ['hpf', 'ls', 'lm', 'md', 'pr', 'hs']) { ch.n[k].getFrequencyResponse(f, m, ph); for (let i = 0; i < N; i++) mag[i] *= m[i]; }
  return Float32Array.from(mag, v => clamp(20 * Math.log10(v || 1e-6), -18, 18));
}
function drawEq(ch) {
  if (!ch || !ch.n) return;
  const tgt = eqTarget(ch);
  if (eqView.ch !== ch || !eqView.cur || motionOff()) eqView.cur = Float32Array.from(tgt);
  eqView.ch = ch; eqView.tgt = tgt; eqView.pulse = 1;
  if (!eqView.run) { eqView.run = true; requestAnimationFrame(eqFrame); }
}
function eqFrame() {
  const ch = eqView.ch, cv = $('#insp .eqc');
  if (!cv || !ch || !ch.n || !isSel(ch)) { eqView.run = false; eqView.ch = null; return; }
  const cs = getComputedStyle(document.documentElement), col = n => cs.getPropertyValue(n).trim();
  const x = cv.getContext('2d'), W = cv.width, H = cv.height, R = 18, N = eqView.cur.length;
  const X = v => Math.log(v / 20) / Math.log(1000) * W, Y = d => H / 2 - d / R * (H / 2 - 10);
  for (let i = 0; i < N; i++) eqView.cur[i] += (eqView.tgt[i] - eqView.cur[i]) * 0.22;
  eqView.pulse *= 0.9;
  x.clearRect(0, 0, W, H);
  x.strokeStyle = col('--line'); x.lineWidth = 1.5;
  for (const g of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { x.beginPath(); x.moveTo(X(g), 0); x.lineTo(X(g), H); x.stroke(); }
  for (const g of [-12, -6, 6, 12]) { x.beginPath(); x.moveTo(0, Y(g)); x.lineTo(W, Y(g)); x.stroke(); }
  x.strokeStyle = col('--line2'); x.beginPath(); x.moveTo(0, Y(0)); x.lineTo(W, Y(0)); x.stroke();
  const acc = col('--accent');
  // live spectrum
  const spec = (an, key) => {
    if (!an) return null;
    const b = eqView[key] && eqView[key].length === an.frequencyBinCount ? eqView[key] : (eqView[key] = new Float32Array(an.frequencyBinCount));
    an.getFloatFrequencyData(b); return b;
  };
  const sr = audio.ctx ? audio.ctx.sampleRate : 48000;
  const drawSpec = (b, fill, alpha) => {
    if (!b) return;
    const hz = sr / 2 / b.length;
    x.beginPath(); x.moveTo(0, H);
    for (let px = 0; px <= W; px += 4) {
      const fq = 20 * Math.pow(1000, px / W), i = Math.min(b.length - 1, Math.round(fq / hz));
      const lo = Math.max(1, Math.round(fq / hz * 0.94)), hi = Math.min(b.length - 1, Math.round(fq / hz * 1.06));
      let v = -140; for (let k = lo; k <= Math.max(lo, hi); k++) v = Math.max(v, b[k]); if (!isFinite(v)) v = b[i];
      x.lineTo(px, H - clamp((v + 100) / 80, 0, 1) * (H - 8));
    }
    x.lineTo(W, H); x.closePath(); x.globalAlpha = alpha; x.fillStyle = fill; x.fill(); x.globalAlpha = 1;
  };
  if (!motionOff()) {
    drawSpec(spec(ch.n.anIn, 'binsIn'), col('--faint'), .22);
    drawSpec(spec(ch.n.anOut, 'bins'), acc, .28);
  }
  x.fillStyle = col('--faint'); x.font = '500 18px ' + col('--font');
  [[100, '100'], [1000, '1k'], [10000, '10k']].forEach(([g, l]) => x.fillText(l, X(g) + 5, H - 10));
  x.beginPath();
  for (let i = 0; i < N; i++) { const yy = Y(eqView.cur[i]); i ? x.lineTo(i / (N - 1) * W, yy) : x.moveTo(0, yy); }
  x.lineWidth = 3.5 + eqView.pulse * 2; x.strokeStyle = acc; x.shadowColor = acc; x.shadowBlur = 6 + eqView.pulse * 14; x.stroke(); x.shadowBlur = 0;
  x.lineTo(W, Y(0)); x.lineTo(0, Y(0)); x.closePath(); x.globalAlpha = .12; x.fillStyle = acc; x.fill(); x.globalAlpha = 1;
  BANDS.forEach(([k]) => {
    const g = ch.s[k + 'G']; if (!g) return;
    const i = Math.round(X(ch.s[k + 'F']) / W * (N - 1)), yy = Y(eqView.cur[clamp(i, 0, N - 1)]);
    x.beginPath(); x.arc(X(ch.s[k + 'F']), yy, 8 + eqView.pulse * 3, 0, 7); x.fillStyle = '#fff'; x.fill(); x.lineWidth = 3; x.strokeStyle = acc; x.stroke();
  });
  if (audio.aiActive(ch)) { x.font = '600 17px ' + col('--font'); x.fillStyle = acc; x.fillText('AI CLEANUP ON', W - 150, 26); }
  requestAnimationFrame(eqFrame);
}

function aiRow(ch) {
  const s = ch.s, st = audio.aiState;
  if (roleOf(ch) !== 'voice') return `<div class="note keep ai-note">AI voice cleanup is only for voice mics. This input is set to ${esc(ROLES.find(r => r[0] === roleOf(ch))[1].toLowerCase())}; change its role to Voice to use it.</div>`;
  if (st === 'unsupported') return `<div class="r ai-row off"><div class="lb">AI voice cleanup <span class="aibadge">AI</span><div class="sub">Windows app only</div></div><label class="sw dis"><input type="checkbox" disabled><i></i></label></div>
    <div class="note keep ai-note">Made for speaking voices. It can make singing, music or instruments sound watery, so leave it off for those.</div>`;
  return `<div class="r ai-row ${audio.aiActive(ch) ? 'live' : ''}"><div class="lb">AI voice cleanup <span class="aibadge">AI</span>${st === 'loading' ? '<div class="sub">Loading…</div>' : st === 'error' ? '<div class="sub">Couldn’t start</div>' : ''}</div>
      <label class="sw"><input type="checkbox" data-k="ai" ${s.ai ? 'checked' : ''}><i></i></label></div>
    <div class="note keep ai-note">Made for speaking voices. It can make singing, music or instruments sound watery, so leave it off for those.</div>`;
}

function renderAudioInspector(el, ch) {
  const scroll = el.querySelector('.insp-b') ? el.querySelector('.insp-b').scrollTop : 0;
  const s = ch.s, mine = store.get('userPresets', {});
  const desc = PRESETS[s.preset] ? PRESETS[s.preset].desc : mine[s.preset] ? 'Your saved preset.' : 'Your own settings.';
  const chip = (n, isMine) => `<button class="chip ${n === s.preset ? 'on' : ''}" data-p="${esc(n)}" title="${esc(PRESETS[n] ? PRESETS[n].desc : 'Your preset')}">${esc(n)}${isMine ? '<i class="del" data-del="1">✕</i>' : ''}</button>`;
  const sl = (k, l, min, max, step, d, f) => ui.slider(k, l, min, max, step, s[k], d, f);
  el.innerHTML = `<div class="insp-h"><div class="t">${icon(ch.kind === 'system' ? 'speaker' : 'mic')}<input class="name" value="${esc(ch.name)}" spellcheck="false"></div>
      <div class="s">${esc(ch.kind === 'system' ? 'System audio' : shortName(ch.label) || 'Input')}${ch.alive ? '' : ' · not connected'}</div></div>
    <div class="insp-b ${eqAdv ? 'showadv' : ''}">
      <div class="now"><div><b>${esc(s.preset || 'Custom')}${s.presetEdited ? '<em>EDITED</em>' : ''}</b><span>${esc(desc)}</span></div></div>
      <canvas class="eqc" width="680" height="220"></canvas>
      <div class="mypre">
        <div class="cat" style="margin-top:0;display:flex;align-items:center">My presets
          ${mine[s.preset] && s.presetEdited ? `<button class="btn" data-act="update" style="margin-left:auto;height:24px;font-size:12px">Update “${esc(s.preset)}”</button>` : ''}</div>
        <div class="chips">${Object.keys(mine).map(n => chip(n, true)).join('') || '<span class="empty-note" style="padding:0">None yet</span>'}</div>
        <div class="savebar"><input placeholder="Name this sound" maxlength="28"><button class="btn primary">Save</button></div>
      </div>
      ${PRESET_CATS.map(c => `<div class="cat">${c}</div><div class="chips">${Object.keys(PRESETS).filter(n => PRESETS[n].cat === c).map(n => chip(n)).join('')}</div>`).join('')}
      ${ui.group('Input',
        (ch.kind === 'device' ? ui.select('mode', 'Channel', [['stereo', 'Stereo'], ['left', 'Left only (input 1)'], ['right', 'Right only (input 2)']], s.mode) : '') +
        sl('gain', 'Gain', -24, 24, 0.5, 0, dB) + sl('pan', 'Pan', -100, 100, 1, 0, v => v === 0 ? 'Center' : v < 0 ? `L ${-v}` : `R ${v}`) +
        sl('delay', 'Audio delay', 0, 500, 5, 0, v => v + ' ms'), '')}
      <div class="note" style="margin:-6px 0 6px">Use audio delay to line up lip sync with capture cards.</div>
      ${ui.group('Clean up',
        aiRow(ch) +
        (ch.kind === 'device' ? ui.toggle('noise', 'Noise removal', s.noise, 'Built-in background noise reduction') : '') +
        sl('lowcut', 'Low cut', 0, 500, 5, 0, v => v ? hz(v) : 'Off') +
        ui.toggle('gate', 'Noise gate', s.gate, 'Silences the mic between words') + sl('gateTh', 'Gate level', -80, -20, 1, -50, v => v + ' dB') +
        ui.toggle('deess', 'De-esser', s.deess, 'Softens harsh S sounds') + sl('deessAmt', 'De-ess amount', 0, 100, 1, 50, pct))}
      ${ui.group('EQ', BANDS.map(([k, l, lo, hi, q]) =>
        sl(k + 'G', l, -15, 15, 0.5, 0, dB) +
        `<div class="adv">${sl(k + 'F', '↳ Frequency', lo, hi, lo < 200 ? 5 : lo < 1000 ? 10 : 50, s[k + 'F'], hz)}${q ? sl(k + 'Q', '↳ Width', 0.3, 4, 0.1, s[k + 'Q'], v => (+v).toFixed(1)) : ''}</div>`).join(''),
        `<button data-act="adv">${eqAdv ? 'Hide' : 'Show'} frequencies</button>`)}
      ${ui.group('Level', ui.toggle('comp', 'Compressor', s.comp, 'Evens out loud and quiet moments') + sl('compAmt', 'Amount', 0, 100, 1, 40, pct))}
      <div class="btns"><button class="btn danger" data-act="remove">Remove input</button></div>
    </div>`;
  el.querySelector('.name').onchange = e => { ch.name = e.target.value.trim() || ch.name; bus.emit('audio'); saveCurrent(); };
  const b = el.querySelector('.insp-b');
  b.querySelectorAll('[data-p]').forEach(c => c.onclick = e => {
    const n = c.dataset.p;
    if (e.target.closest('[data-del]')) { const m = store.get('userPresets', {}); delete m[n]; store.set('userPresets', m); if (s.preset === n) s.preset = 'Custom'; return renderInspector(); }
    const prevNoise = s.noise;
    Object.assign(s, withPreset(n));
    if (ch.kind !== 'device') s.noise = false;
    if (s.noise !== prevNoise) audio.open(ch); else audio.apply(ch);
    bus.emit('audio'); saveCurrent(); renderInspector();
  });
  const nameIn = b.querySelector('.savebar input');
  const save = () => {
    const n = nameIn.value.trim(); if (!n) return nameIn.focus();
    if (PRESETS[n]) return toast('That name belongs to a built-in preset', 'err');
    const m = store.get('userPresets', {}); m[n] = Object.fromEntries(PRESET_KEYS.map(k => [k, s[k]])); store.set('userPresets', m);
    s.preset = n; s.presetEdited = false; bus.emit('audio'); saveCurrent(); renderInspector(); toast(`Saved preset “${n}”`);
  };
  b.querySelector('.savebar button').onclick = save;
  const up = b.querySelector('[data-act=update]');
  if (up) up.onclick = () => { const m = store.get('userPresets', {}); m[s.preset] = Object.fromEntries(PRESET_KEYS.map(k => [k, s[k]])); store.set('userPresets', m); s.presetEdited = false; bus.emit('audio'); saveCurrent(); renderInspector(); toast(`Updated “${s.preset}”`); };
  nameIn.onkeydown = e => { if (e.key === 'Enter') save(); };
  b.querySelector('[data-act=adv]').onclick = () => { eqAdv = !eqAdv; store.set('eqAdv', eqAdv); renderInspector(); };
  b.querySelector('[data-act=remove]').onclick = () => { audio.remove(ch); select(null); saveCurrent(); };
  bindControls(b, s, k => {
    if (PRESET_KEYS.includes(k) && !s.presetEdited) { s.presetEdited = true; const nb = b.querySelector('.now b'); if (nb) nb.innerHTML = `${esc(s.preset || 'Custom')}<em>EDITED</em>`; }
    if (k === 'ai') { audio.setAi(ch, s.ai).then(() => { renderStrips(); renderInspector(); }); return; }
    if (k === 'mode') audio.build(ch); else if (k === 'noise') audio.open(ch); else audio.apply(ch);
    drawEq(ch); saveCurrentSoon();
  });
  b.scrollTop = scroll;
  drawEq(ch);
}

function renderMasterInspector(el) {
  const m = audio.master;
  const outs = outputDevices.length ? outputDevices.map(d => [d.deviceId, d.deviceId === 'default' ? 'System default' : shortName(d.label) || 'Output']) : [['default', 'System default']];
  el.innerHTML = `<div class="insp-h"><div class="t">${icon('speaker')}<b style="font-size:16px">Mixes</b></div><div class="s">Record mix goes into every file. Monitor mix is what you hear.</div></div>
    <div class="insp-b">
      ${ui.group('Record mix', ui.toggle('clipguard', 'Clipguard', m.clipguard, 'Keeps recordings from ever clipping, even if someone shouts'))}
      ${ui.group('Headphones', ui.select('sink', 'Output', outs, m.sink || 'default') + ui.toggle('monMute', 'Mute headphones', m.monMute, 'Starts muted so speakers don’t cause feedback'))}
      <div class="btns"><button class="btn" data-act="sc">${icon('wave', 'sm')} Run sound check</button></div>
    </div>`;
  bindControls(el, m, async k => { if (k === 'sink') await audio.setSink(m.sink); audio.applyMaster(); renderStrips(); saveCurrentSoon(); });
  el.querySelector('[data-act=sc]').onclick = runSoundCheck;
}
