// Mix presets + auto-ducking: each input has a role (Voice, Game, Clip, Music, Other). A mix sets each role's level,
// and ducking dips Game/Clip/Music whenever a Voice input is talking, in the recording and in your headphones.
const ROLES = [['voice', 'Voice'], ['game', 'Game'], ['clip', 'Clip'], ['music', 'Music'], ['other', 'Other']];
const roleOf = ch => ch.s.role || (ch.kind === 'media' ? 'clip' : (ch.kind === 'system' || ch.kind === 'screen') ? 'game' : 'voice');
const M = (levels, duck) => ({ levels, duck });
const MIXES = {
  'Voice first': M({ voice: 0, game: -12, clip: -10, music: -18, other: -6 }, { on: false, amount: 8 }),
  'Gaming':      M({ voice: 0, game: -10, clip: -10, music: -20, other: -6 }, { on: true, amount: 9 }),
  'Reaction':    M({ voice: 0, game: -8, clip: -6, music: -18, other: -6 }, { on: true, amount: 12 }),
  'Podcast':     M({ voice: 0, game: -20, clip: -16, music: -24, other: -10 }, { on: true, amount: 14 }),
  'Even':        M({ voice: 0, game: 0, clip: 0, music: 0, other: 0 }, { on: false, amount: 8 }),
};
const mix = { name: 'Voice first', duck: { on: false, amount: 8, sens: 50 }, edited: false, ...store.get('mix', {}) };
const saveMix = () => store.set('mix', mix);
const dbToSlider = db => db <= -60 ? 0 : db <= 0 ? (db + 60) / 60 * 91 : 91 + db / 6 * 9;
const mixSettings = name => MIXES[name] || store.get('userMixes', {})[name];

function applyMix(name) {
  const m = mixSettings(name); if (!m) return;
  const moves = audio.channels.map(ch => {
    const db = m.levels[roleOf(ch)] ?? 0, v = Math.round(dbToSlider(db) * 2) / 2;
    return { ch, r0: ch.s.rec, m0: ch.s.mon, r1: v, m1: ch.s.link ? v : ch.s.mon };
  });
  glideFaders(moves);
  mix.name = name; mix.edited = false;
  mix.duck = { ...mix.duck, on: m.duck.on, amount: m.duck.amount };
  saveMix(); renderStrips(); saveCurrentSoon(); renderMixBar();
  toast(`${name} mix${mix.duck.on ? ` · ducking ${mix.duck.amount} dB` : ''}`);
}
// Faders glide to a new mix like motorized faders (instant when animations are off).
function glideFaders(moves) {
  const t0 = performance.now(), dur = motionOff() ? 0 : 420, ease = t => 1 - Math.pow(1 - t, 3);
  const step = now => {
    const t = dur ? Math.min(1, (now - t0) / dur) : 1, k = ease(t);
    for (const mv of moves) {
      const s = mv.ch.s;
      s.rec = t < 1 ? mv.r0 + (mv.r1 - mv.r0) * k : mv.r1; s.mon = t < 1 ? mv.m0 + (mv.m1 - mv.m0) * k : mv.m1;
      audio.apply(mv.ch);
      const el = mv.ch.meterEl && mv.ch.meterEl.closest('.strip');
      if (el) for (const c of ['rec', 'mon']) { const i = el.querySelector('input.vf.' + c), v = el.querySelector('.v.' + c); if (i) i.value = s[c]; if (v) v.textContent = fmtDb(sliderDb(s[c])); }
    }
    if (t < 1) requestAnimationFrame(step); else saveCurrentSoon();
  };
  requestAnimationFrame(step);
}
function captureMix() {
  const levels = {};
  for (const [r] of ROLES) {
    const ch = audio.channels.find(c => roleOf(c) === r);
    if (ch) levels[r] = Math.round(sliderDb(ch.s.rec) === -Infinity ? -60 : sliderDb(ch.s.rec));
  }
  return M({ voice: 0, game: -12, clip: -10, music: -18, other: -6, ...levels }, { on: mix.duck.on, amount: mix.duck.amount });
}

// ---------- ducking engine ----------
let duckGain = 1, voiceHold = 0;
const dbuf = new Float32Array(1024);
setInterval(() => {
  if (!audio.ctx || !audio.channels.length) return;
  let loud = -100;
  const voices = audio.channels.filter(c => roleOf(c) === 'voice' && c.n && !c.s.recMute);
  for (const v of voices) {
    v.n.an.getFloatTimeDomainData(dbuf);
    let sum = 0; for (let i = 0; i < dbuf.length; i++) sum += dbuf[i] * dbuf[i];
    loud = Math.max(loud, 10 * Math.log10(sum / dbuf.length + 1e-12));
  }
  const th = -30 - mix.duck.sens * 0.3;                    // sensitivity 0..100 → -30..-60 dB RMS
  const now = performance.now();
  if (mix.duck.on && loud > th) voiceHold = now + 450;
  const target = mix.duck.on && now < voiceHold ? Math.pow(10, -mix.duck.amount / 20) : 1;
  const T = audio.ctx.currentTime;
  for (const ch of audio.channels) {
    if (!ch.n || !ch.n.duck) continue;
    const r = roleOf(ch), g = r === 'voice' || r === 'other' ? 1 : target;
    // dip fast, recover gently
    ch.n.duck.gain.setTargetAtTime(g, T, g < ch.n.duck.gain.value ? 0.06 : 0.35);
  }
  const was = duckGain < 0.99; duckGain = target;
  if (was !== (duckGain < 0.99)) { const el = $('#duckBtn'); if (el) el.classList.toggle('active', duckGain < 0.99); }
}, 30);

// ---------- UI: Mix bar in the audio dock ----------
function renderMixBar() {
  const host = $('#mixBar'); if (!host) return;
  const mine = store.get('userMixes', {});
  host.innerHTML = `
    <select id="mixSel" title="Mix presets: levels for each role">
      ${Object.keys(MIXES).map(n => `<option ${n === mix.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      ${Object.keys(mine).length ? `<optgroup label="My mixes">${Object.keys(mine).map(n => `<option ${n === mix.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` : ''}
      <option value="__save">Save current mix…</option>
    </select>
    <button class="btn ${mix.duck.on ? 'on' : ''}" id="duckBtn" title="Ducking: lower game, clips and music while you talk">${icon('wave', 'sm')} Ducking ${mix.duck.on ? `−${mix.duck.amount} dB` : 'off'}</button>`;
  $('#mixSel').onchange = e => {
    const v = e.target.value;
    if (v === '__save') { e.target.value = mix.name; return saveMixDialog(); }
    applyMix(v);
  };
  $('#duckBtn').onclick = openDuck;
}
function saveMixDialog() {
  openMenu('Save mix', `<div class="savebar" style="margin:0"><input id="mxName" placeholder="Stream night, Sunday service…" maxlength="28"><button class="btn primary" id="mxSave">Save</button></div>`, (body, dlg) => {
    const inp = body.querySelector('#mxName'); setTimeout(() => inp.focus(), 50);
    const go = () => { const n = inp.value.trim(); if (!n) return; if (MIXES[n]) return toast('That name is built in', 'err');
      const m = store.get('userMixes', {}); m[n] = captureMix(); store.set('userMixes', m); mix.name = n; saveMix(); dlg.close(); renderMixBar(); toast(`Saved mix “${n}”`); };
    body.querySelector('#mxSave').onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
  });
}
function openDuck() {
  const d = { ...mix.duck };
  openMenu('Ducking', `
    <div class="group">${ui.toggle('on', 'Duck while I talk', d.on, 'Game, clip and music inputs dip whenever a Voice input is talking')}
      ${ui.slider('amount', 'How much', 3, 24, 1, d.amount, 8, v => `−${v} dB`)}
      ${ui.slider('sens', 'Sensitivity', 0, 100, 1, d.sens, 50, pct)}</div>
    <div class="cat">Roles</div>
    <div class="group">${audio.channels.map((ch, i) => ui.row(esc(ch.name), ui.seg('r' + i, ROLES, roleOf(ch)))).join('') || '<div class="r"><div class="lb">No audio inputs</div></div>'}</div>`,
    body => {
      bindControls(body.querySelector('.group'), d, () => { mix.duck = { ...d }; mix.edited = true; saveMix(); renderMixBar(); });
      const roles = Object.fromEntries(audio.channels.map((ch, i) => ['r' + i, roleOf(ch)]));
      bindControls(body.querySelectorAll('.group')[1], roles, (k, v) => { const ch = audio.channels[+k.slice(1)]; ch.s.role = v; if (ch.s.ai) audio.build(ch); renderStrips(); saveCurrentSoon(); });
    });
}
// cycle a strip's role with one click
function cycleRole(ch) {
  const i = ROLES.findIndex(r => r[0] === roleOf(ch));
  ch.s.role = ROLES[(i + 1) % ROLES.length][0];
  if (ch.s.ai) audio.build(ch);                       // AI cleanup only runs on voice
  renderStrips(); saveCurrentSoon(); if (isSel(ch)) renderInspector();
}
