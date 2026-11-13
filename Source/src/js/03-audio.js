// Audio engine: inputs → per-channel FX → Record mix (into every file) + Monitor mix (headphones).
const WORKLET = `
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors(){ return [{name:'threshold',defaultValue:-50},{name:'enabled',defaultValue:0}]; }
  constructor(){ super(); this.g = 1; this.hold = 0; }
  process(inputs, outputs, p){
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const n = inp[0].length, en = p.enabled[0] > .5, th = p.threshold[0];
    let sum = 0; for (const ch of inp) for (let i=0;i<n;i++) sum += ch[i]*ch[i];
    const db = 10*Math.log10(sum/(n*inp.length) + 1e-12);
    if (!en || db > th) this.hold = sampleRate*0.2; else this.hold -= n;
    const target = this.hold > 0 ? 1 : 0;
    for (let i=0;i<n;i++){
      this.g += (target - this.g) * (target > this.g ? 0.02 : 0.0004);
      for (let c=0;c<out.length;c++) out[c][i] = (inp[c] || inp[0])[i] * this.g;
    }
    return true;
  }
}
registerProcessor('mcr-gate', Gate);
class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors(){ return [{name:'enabled',defaultValue:1},{name:'ceiling',defaultValue:-1.5}]; }
  constructor(){ super(); this.env = 0; this.rel = Math.exp(-1/(sampleRate*0.15)); this.reduction = 0; this.t = 0; }
  process(inputs, outputs, p){
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const n = inp[0].length, en = p.enabled[0] > .5, ceil = Math.pow(10, p.ceiling[0]/20);
    let maxRed = 0;
    for (let i=0;i<n;i++){
      let pk = 0; for (const ch of inp) pk = Math.max(pk, Math.abs(ch[i]));
      this.env = pk > this.env ? pk : this.env*this.rel + pk*(1-this.rel);
      const g = en && this.env > ceil ? ceil/this.env : 1;
      maxRed = Math.max(maxRed, 1-g);
      for (let c=0;c<out.length;c++) out[c][i] = (inp[c] || inp[0])[i] * g;
    }
    this.reduction = Math.max(maxRed, this.reduction);
    if ((this.t += n) > 4800) { this.t = 0; this.port.postMessage(this.reduction); this.reduction = 0; }
    return true;
  }
}
registerProcessor('mcr-limiter', Limiter);
class DeEsser extends AudioWorkletProcessor {
  static get parameterDescriptors(){ return [{name:'enabled',defaultValue:0},{name:'amount',defaultValue:50},{name:'freq',defaultValue:5500}]; }
  constructor(){ super(); this.lp = [0,0]; this.env = 0; this.g = 1; }
  process(inputs, outputs, p){
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) return true;
    const n = inp[0].length, en = p.enabled[0] > .5;
    const a = 1 - Math.exp(-2*Math.PI*p.freq[0]/sampleRate);
    const th = Math.pow(10, (-16 - p.amount[0]*0.3)/20);
    const att = 1 - Math.exp(-1/(sampleRate*0.0008)), rel = 1 - Math.exp(-1/(sampleRate*0.06));
    const lows = [0,0], highs = [0,0];
    for (let i=0;i<n;i++){
      let hp = 0;
      for (let c=0;c<out.length;c++){
        const x = (inp[c] || inp[0])[i];
        this.lp[c] += a*(x - this.lp[c]);
        lows[c] = this.lp[c]; highs[c] = x - this.lp[c];
        hp = Math.max(hp, Math.abs(highs[c]));
      }
      this.env += (hp - this.env) * (hp > this.env ? att : rel);
      const target = en && this.env > th ? Math.pow(th/this.env, 0.85) : 1;
      this.g += (target - this.g) * (target < this.g ? 0.2 : 0.002);
      for (let c=0;c<out.length;c++) out[c][i] = lows[c] + highs[c]*this.g;
    }
    return true;
  }
}
registerProcessor('mcr-deesser', DeEsser);
// Tap: hands raw PCM to the page in ~100 ms blocks so each mic can be saved as its own WAV file.
class Tap extends AudioWorkletProcessor {
  constructor(o){ super(); this.ch = (o.processorOptions && o.processorOptions.channels) || 2; this.on = false; this.size = 4800; this.reset();
    this.port.onmessage = e => { if (e.data === 'start') { this.reset(); this.said = false; this.on = true; } else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); } }; }
  reset(){ this.buf = new Float32Array(this.size * this.ch); this.n = 0; }
  flush(){ if (this.n) { const b = this.buf.slice(0, this.n * this.ch); this.port.postMessage({ pcm: b }, [b.buffer]); } this.reset(); }
  process(inputs){
    if (!this.on) return true;
    if (!this.said) { this.said = true; this.port.postMessage({ started: currentTime }); }   // exact start, so the page can line the file up with the video
    const inp = inputs[0]; const len = inp.length ? inp[0].length : 128;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < this.ch; c++) { const src = inp[c] || inp[0]; this.buf[this.n * this.ch + c] = src ? src[i] : 0; }
      if (++this.n === this.size) this.flush();
    }
    return true;
  }
}
registerProcessor('mcr-tap', Tap);`;

// ---------- EQ presets ----------
// 5 bands: Low shelf, Low-mid bell, Mid bell, Presence bell, Air shelf.  [freq Hz, gain dB, Q]
const E = (ls, lm, md, pr, hs) => ({ lsF:ls[0], lsG:ls[1], lmF:lm[0], lmG:lm[1], lmQ:lm[2] ?? 1, mdF:md[0], mdG:md[1], mdQ:md[2] ?? 1,
                                     prF:pr[0], prG:pr[1], prQ:pr[2] ?? 1, hsF:hs[0], hsG:hs[1] });
const FLAT = E([120,0],[300,0],[800,0],[3500,0],[10000,0]);
const BASE = { lowcut:0, gate:false, gateTh:-50, noise:false, comp:false, compAmt:40, deess:false, deessAmt:50 };
const PRESET_KEYS = [...Object.keys(BASE), ...Object.keys(FLAT)];
const P = (cat, desc, o, eq) => ({ cat, desc, s: { ...BASE, ...o, ...eq } });
const PRESETS = {
  'Natural Voice':      P('Voice', 'Clean, honest voice with a touch of clarity. The best starting point.', {lowcut:80, gate:true, gateTh:-52, comp:true, compAmt:40, deess:true, deessAmt:35}, E([120,0],[300,-2,1],[800,0],[3500,2,0.9],[11000,2])),
  'YouTube Voiceover':  P('Voice', 'Bright, upfront and punchy. The polished creator sound.', {lowcut:100, gate:true, gateTh:-48, noise:true, comp:true, compAmt:65, deess:true, deessAmt:55}, E([100,1.5],[300,-3.5,1.4],[800,-1,1],[3500,4,0.9],[12000,3.5])),
  'Broadcast Radio':    P('Voice', 'Deep, smooth, larger-than-life FM radio voice.', {lowcut:70, gate:true, gateTh:-48, noise:true, comp:true, compAmt:75, deess:true, deessAmt:55}, E([110,3.5],[280,-3,1.2],[700,-2,1],[3000,3,0.8],[10000,3])),
  'Podcast Crisp':      P('Voice', 'Tight and clear. Cuts through on phone speakers and earbuds.', {lowcut:90, gate:true, gateTh:-50, comp:true, compAmt:60, deess:true, deessAmt:50}, E([120,1],[250,-3,1.2],[900,-1.5,1.2],[4000,3,1],[12000,2.5])),
  'Warm & Intimate':    P('Voice', 'Rich and close. Great for storytelling and calm reviews.', {lowcut:70, gate:true, gateTh:-55, comp:true, compAmt:45, deess:true, deessAmt:35}, E([150,2.5],[350,-1,1],[1000,-1,1],[3000,1,1],[10000,1])),
  'Announcer / Hype':   P('Voice', 'Big, loud and exciting. Intros, giveaways and event hype.', {lowcut:80, gate:true, gateTh:-45, comp:true, compAmt:85, deess:true, deessAmt:60}, E([100,4],[250,-3,1.2],[600,-2,1],[2500,4,0.8],[9000,4])),
  'Lav mic':            P('Mic types', 'Fixes chest boom and the muffled top end of a clip-on lav.', {lowcut:100, gate:true, gateTh:-50, noise:true, comp:true, compAmt:55, deess:true, deessAmt:45}, E([150,-1],[300,-3,1.2],[750,-3,1.5],[3500,4,1],[11000,3])),
  'Camera mic':         P('Mic types', 'Adds body and clarity to an on-camera mic and reduces room sound.', {lowcut:120, gate:true, gateTh:-42, noise:true, comp:true, compAmt:55}, E([150,1.5],[350,-2.5,1.2],[900,-2,1.2],[3000,3,0.9],[10000,1])),
  'Phone mic':          P('Mic types', 'Gentle polish for a phone’s already-processed mic.', {lowcut:100, gate:true, gateTh:-48, comp:true, compAmt:40}, E([140,2],[350,-2,1],[1000,-1.5,1],[3200,1.5,1],[10000,1])),
  'Mixer feed':         P('Mic types', 'Light touch for a mix that is already EQed at a soundboard.', {lowcut:60, comp:true, compAmt:35}, E([100,0],[300,-1,1],[800,0],[3500,1,1],[12000,1.5])),
  'Dynamic (SM7B, MV7)': P('Mic types', 'Opens up dark dynamic mics with presence and air.', {lowcut:70, gate:true, gateTh:-55, comp:true, compAmt:55, deess:true, deessAmt:40}, E([120,0],[250,-2,1],[800,0],[4500,3,0.8],[10000,5])),
  'Condenser':          P('Mic types', 'Tames room sound and sharpness from sensitive condensers.', {lowcut:80, gate:true, gateTh:-52, noise:true, comp:true, compAmt:45, deess:true, deessAmt:50}, E([120,0],[250,-2.5,1.2],[1200,-1,1],[4000,1,1],[12000,-1])),
  'USB mic':            P('Mic types', 'Fixes the boxy tone of most USB mics.', {lowcut:90, gate:true, gateTh:-50, noise:true, comp:true, compAmt:50, deess:true, deessAmt:40}, E([130,1.5],[300,-3,1.2],[1000,-1.5,1],[3500,2.5,1],[10000,2])),
  'Shotgun':            P('Mic types', 'Balanced, focused tone for boom and camera-top shotguns.', {lowcut:100, gate:true, gateTh:-48, comp:true, compAmt:50, deess:true, deessAmt:40}, E([130,1],[300,-2,1],[1000,-1,1],[3500,2,1],[10000,1.5])),
  'Headset / gaming':   P('Mic types', 'Fuller and less nasal for headset mics.', {lowcut:120, gate:true, gateTh:-48, noise:true, comp:true, compAmt:60}, E([150,2.5],[400,-3,1.2],[1000,-2,1],[3000,2,1],[9000,2])),
  'Sermon / Pulpit':    P('Church', 'Even, clear preaching. Smooths out loud and soft moments.', {lowcut:90, comp:true, compAmt:70, deess:true, deessAmt:45}, E([150,-1],[300,-2,1],[800,0],[3000,2.5,0.9],[10000,1])),
  'Worship band mix':   P('Church', 'Full, open music mix with sparkle and a little glue.', {lowcut:30, comp:true, compAmt:25}, E([80,1.5],[300,-1.5,0.9],[800,-1,1],[3500,1,1],[12000,2])),
  'Choir':              P('Church', 'Airy, blended voices without boom.', {lowcut:100, comp:true, compAmt:35, deess:true, deessAmt:35}, E([150,-1],[350,-2,1],[1000,0],[3000,1.5,0.8],[12000,3])),
  'Room / congregation': P('Church', 'Clearer room sound with less mud. Blend it under the board feed.', {lowcut:120, comp:true, compAmt:40}, E([150,-2],[300,-3,1],[1000,-2,1],[3500,2,1],[10000,3])),
  'Unboxing & ASMR':    P('Content', 'Keeps tape, clicks and textures crisp. Gate stays off so quiet sounds survive.', {lowcut:60, comp:true, compAmt:35}, E([120,0],[300,-2,1],[800,0],[4000,1.5,1],[12000,4])),
  'Gameplay / system':  P('Content', 'Slightly fuller game and app audio that sits under your voice.', {comp:true, compAmt:20}, E([80,1],[300,-1,1],[1000,-1,1],[3500,0,1],[10000,1])),
  'Music (flat)':       P('Content', 'No coloring, just light leveling.', {comp:true, compAmt:15}, FLAT),
  'Clean (bypass)':     P('Content', 'Every effect off.', {}, FLAT),
  'Too boomy':          P('Fix it', 'Removes boom from being too close to the mic or a boomy room.', {lowcut:120, gate:true, gateTh:-50, comp:true, compAmt:45}, E([140,-3],[250,-4,1.2],[800,0],[3500,2.5,1],[10000,2])),
  'Too thin':           P('Fix it', 'Adds weight and body to a small or distant voice.', {lowcut:50, gate:true, gateTh:-52, comp:true, compAmt:45}, E([160,3.5],[300,1,0.8],[900,-1,1],[3000,1,1],[10000,1])),
  'Too harsh / hissy S': P('Fix it', 'Softens piercing S and T sounds and harsh highs.', {lowcut:80, gate:true, gateTh:-52, comp:true, compAmt:40, deess:true, deessAmt:80}, E([120,0.5],[300,-1.5,1],[1000,0],[6500,-4,2.5],[11000,-1.5])),
  'Muffled':            P('Fix it', 'Brings back clarity when a mic is covered or pointed away.', {lowcut:90, gate:true, gateTh:-52, comp:true, compAmt:45, deess:true, deessAmt:40}, E([120,0],[300,-3,1],[800,-1,1],[3500,4,0.8],[12000,5])),
  'Echoey room':        P('Fix it', 'Tighter gate and cuts that make a bouncy room less obvious.', {lowcut:110, gate:true, gateTh:-42, noise:true, comp:true, compAmt:35}, E([150,-1],[400,-3,1],[1000,-2,1],[3000,2,1],[10000,0])),
  'Phone call':         P('Effects', 'Narrow, tinny phone sound for skits.', {lowcut:400, comp:true, compAmt:70}, E([300,-10],[600,0,1],[1500,6,1.2],[2500,3,1],[3500,-18])),
  'Walkie-talkie':      P('Effects', 'Squashed radio-chatter sound.', {lowcut:350, comp:true, compAmt:90}, E([400,-8],[700,0,1],[1800,8,1.5],[2800,4,1],[3000,-20])),
  'Megaphone':          P('Effects', 'Loud, honky bullhorn sound.', {lowcut:500, comp:true, compAmt:95}, E([600,-6],[800,0,1],[1200,8,2],[2500,6,1],[4000,-15])),
  'Deep cinematic':     P('Effects', 'Movie-trailer depth. Best on lower voices.', {lowcut:40, comp:true, compAmt:70, deess:true, deessAmt:40}, E([100,6],[250,-2,1],[700,-2,1],[3000,2,1],[9000,2])),
};
const PRESET_CATS = ['Voice', 'Mic types', 'Church', 'Content', 'Fix it', 'Effects'];
// older preset names still work
const PRESET_ALIAS = { 'Lark Max 2 (lav)': 'Lav mic', 'Sony ZV camera mic': 'Camera mic', 'Camo (phone mic)': 'Phone mic', 'StudioLive board feed': 'Mixer feed' };
const presetSettings = name => { name = PRESET_ALIAS[name] || name; return PRESETS[name] ? PRESETS[name].s : store.get('userPresets', {})[name]; };
const withPreset = name => ({ ...presetSettings(name), preset: PRESET_ALIAS[name] || name, presetEdited: false });
const CH_DEFAULT = { gain: 0, pan: 0, mode: 'stereo', delay: 0, rec: 91, mon: 91, recMute: false, monMute: false, link: true, ...withPreset('Clean (bypass)') };
// Pick a sensible preset from the device name.
function guessPreset(label) {
  const l = (label || '').toLowerCase();
  if (/lark|wireless|lav|rode wireless|dji mic|hollyland/.test(l)) return 'Lav mic';
  if (/studiolive|presonus|mixer|board|behringer|yamaha|x32|soundcraft/.test(l)) return 'Mixer feed';
  if (/camo|iphone|android|phone/.test(l)) return 'Phone mic';
  if (/sony|zv|cam link|elgato|capture|hdmi|usb video|uvc/.test(l)) return 'Camera mic';
  if (/sm7|mv7|dynamic|podmic|re20/.test(l)) return 'Dynamic (SM7B, MV7)';
  if (/headset|arctis|hyperx|corsair|razer|logitech g/.test(l)) return 'Headset / gaming';
  if (/yeti|quadcast|blue|fifine|at2020|usb mic|microphone \(usb/.test(l)) return 'USB mic';
  if (/scarlett|focusrite|motu|audient|interface|xlr/.test(l)) return 'Condenser';
  return 'Natural Voice';
}

const sliderDb = v => v <= 0 ? -Infinity : v <= 91 ? (v / 91) * 60 - 60 : (v - 91) / 9 * 6;   // 91 = 0 dB, 100 = +6 dB
const dbGain = db => db === -Infinity ? 0 : Math.pow(10, db / 20);
const fmtDb = db => db === -Infinity ? '−∞' : (db > 0 ? '+' : '') + db.toFixed(1);
const shortName = label => (label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').replace(/^(Default|Communications) - /, '').trim().slice(0, 32);

const audio = (() => {
  let ac, recBus, monBus, recLim, monLim, recDest, recAn, monAn, worklets = false, cgReduction = 0;
  const channels = [];
  const master = { rec: 91, mon: 91, recMute: false, monMute: true, clipguard: true, sink: '' };

  async function init() {
    ac = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    try {
      try { await ac.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKLET)); }
      catch { await ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))); }
      worklets = true;
    } catch (e) { log('Gate, de-esser and Clipguard unavailable: ' + e.message); }
    const lim = () => worklets ? new AudioWorkletNode(ac, 'mcr-limiter', { outputChannelCount: [2] }) : ac.createGain();
    recBus = ac.createGain(); monBus = ac.createGain(); recLim = lim(); monLim = lim();
    recAn = ac.createAnalyser(); monAn = ac.createAnalyser(); recAn.fftSize = monAn.fftSize = 1024;
    recDest = ac.createMediaStreamDestination(); recDest.channelCount = 2;
    recBus.connect(recLim); recLim.connect(recAn); recLim.connect(recDest);
    monBus.connect(monLim); monLim.connect(monAn); monLim.connect(ac.destination);
    if (worklets) recLim.port.onmessage = e => { cgReduction = e.data; };
    applyMaster();
    const resume = () => ac.state !== 'running' && ac.resume();
    document.addEventListener('pointerdown', resume); resume();
  }

  // AI voice cleanup: RNNoise neural network, Windows app only, voice channels only.
  const ai = { state: NATIVE && NATIVE.rnnoise ? 'off' : 'unsupported', name: '', wasm: null, err: '', loading: null };
  const aiOn = ch => ch.s.ai && ai.state === 'ready' && roleOf(ch) === 'voice';
  function loadAi() {
    if (ai.state === 'ready' || ai.state === 'unsupported') return Promise.resolve(ai.state === 'ready');
    if (ai.loading) return ai.loading;
    ai.state = 'loading'; bus.emit('audio');
    return ai.loading = (async () => {
      try {
        const r = await NATIVE.rnnoise();
        if (!r || r.error) throw new Error(r ? r.error : 'no response');
        await ac.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(r.worklet));
        const m = r.worklet.match(/registerProcessor\(\s*["'`]([^"'`]+)["'`]/);
        ai.name = m ? m[1] : '@sapphi-red/web-noise-suppressor/rnnoise';
        ai.wasm = r.simd && WebAssembly.validate(new Uint8Array(r.simd)) ? r.simd : r.wasm;
        ai.state = 'ready';
        channels.filter(c => c.s.ai && c.n).forEach(build);
        return true;
      } catch (e) { ai.state = 'error'; ai.err = e.message; log('AI voice cleanup unavailable: ' + e.message); return false; }
      finally { ai.loading = null; bus.emit('audio'); }
    })();
  }
  async function setAi(ch, on) {
    ch.s.ai = !!on;
    if (on && !(await loadAi())) { ch.s.ai = false; toast('AI voice cleanup could not start', 'err'); return false; }
    if (ch.n) build(ch);
    return true;
  }

  function migrate(o) {
    if (o.preset && PRESET_ALIAS[o.preset]) o = { ...o, preset: PRESET_ALIAS[o.preset] };
    if ('low' in o && !('lsG' in o)) { o = { ...o, lsG: o.low, mdG: o.mid, hsG: o.high, preset: 'Custom', presetEdited: false }; delete o.low; delete o.mid; delete o.high; }
    return o;
  }

  async function addChannel(cfg) {
    const ch = { id: uid(), kind: cfg.kind, deviceId: cfg.deviceId || '', label: cfg.label || '', name: cfg.name || 'Input',
                 s: { ...CH_DEFAULT, ...migrate(cfg.s || {}) }, stream: null, n: null, alive: false };
    channels.push(ch);
    await open(ch, cfg.stream);
    bus.emit('audio');
    return ch;
  }

  async function open(ch, given) {
    if (ch.stream && !given && ch.kind === 'device') ch.stream.getTracks().forEach(t => t.stop());
    try {
      if (given) ch.stream = given;
      else if (ch.kind === 'device') ch.stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: { exact: ch.deviceId }, channelCount: { ideal: 2 }, sampleRate: 48000,
        echoCancellation: false, autoGainControl: false, noiseSuppression: !!ch.s.noise } });
      ch.alive = true;
    } catch (e) { ch.alive = false; log(`Audio input "${ch.name}" not available: ${e.message}`); bus.emit('audio'); return; }
    const t = ch.stream.getAudioTracks()[0];
    if (t) t.onended = () => { ch.alive = false; toast(`Audio input "${ch.name}" disconnected`, 'err'); bus.emit('audio'); };
    build(ch);
  }

  function build(ch) {
    if (ch.n) Object.values(ch.n).forEach(n => { try { n.disconnect(); } catch {} });
    const n = ch.n = {};
    n.src = ac.createMediaStreamSource(ch.stream);
    let head = n.src;
    if (ch.s.mode !== 'stereo') {
      n.split = ac.createChannelSplitter(2); n.merge = ac.createChannelMerger(2);
      const idx = ch.s.mode === 'right' ? 1 : 0;
      n.src.connect(n.split); n.split.connect(n.merge, idx, 0); n.split.connect(n.merge, idx, 1);
      head = n.merge;
    }
    const bq = t => { const f = ac.createBiquadFilter(); f.type = t; return f; };
    n.in = ac.createGain();
    n.hpf = bq('highpass'); n.hpf.Q.value = 0.707;
    n.ai = null;
    if (ch.s.ai && ai.state === 'off') loadAi();
    if (aiOn(ch)) {
      try { n.ai = new AudioWorkletNode(ac, ai.name, { processorOptions: { wasmBinary: ai.wasm, maxChannels: 2 } }); }
      catch (e) { log('AI voice cleanup failed on ' + ch.name + ': ' + e.message); n.ai = null; }
    }
    n.gate = worklets ? new AudioWorkletNode(ac, 'mcr-gate', { outputChannelCount: [2] }) : ac.createGain();
    n.ls = bq('lowshelf'); n.lm = bq('peaking'); n.md = bq('peaking'); n.pr = bq('peaking'); n.hs = bq('highshelf');
    n.dees = worklets ? new AudioWorkletNode(ac, 'mcr-deesser', { outputChannelCount: [2] }) : ac.createGain();
    n.comp = ac.createDynamicsCompressor(); n.comp.attack.value = 0.005; n.comp.release.value = 0.15; n.comp.knee.value = 6;
    n.delay = ac.createDelay(1.0); n.pan = ac.createStereoPanner();
    n.an = ac.createAnalyser(); n.an.fftSize = 1024;
    n.anIn = ac.createAnalyser(); n.anIn.fftSize = 2048; n.anIn.smoothingTimeConstant = .75;
    n.anOut = ac.createAnalyser(); n.anOut.fftSize = 2048; n.anOut.smoothingTimeConstant = .75;   // input spectrum for the EQ view
    n.recSend = ac.createGain(); n.monSend = ac.createGain(); n.duck = ac.createGain();
    head.connect(n.in); n.in.connect(n.hpf); n.in.connect(n.anIn);
    if (n.ai) { n.hpf.connect(n.ai); n.ai.connect(n.gate); } else n.hpf.connect(n.gate);   // AI cleanup runs right after the low cut
    n.gate.connect(n.ls);
    n.ls.connect(n.lm); n.lm.connect(n.md); n.md.connect(n.pr); n.pr.connect(n.hs); n.hs.connect(n.dees);
    n.dees.connect(n.comp); n.comp.connect(n.delay); n.delay.connect(n.pan); n.pan.connect(n.an); n.pan.connect(n.anOut);
    if (!ch.iso) { ch.iso = ac.createMediaStreamDestination(); ch.iso.channelCount = 2; }
    n.pan.connect(ch.iso);                                  // clean feed of this mic alone: after effects, before faders
    if (ch.tap) n.pan.connect(ch.tap);
    n.pan.connect(n.duck);                                  // ducking sits after the meter so meters show the real input
    n.duck.connect(n.recSend); n.recSend.connect(recBus);
    n.duck.connect(n.monSend); n.monSend.connect(monBus);
    apply(ch);
  }

  function apply(ch) {
    const n = ch.n, s = ch.s; if (!n) return;
    const T = ac.currentTime, set = (p, v) => p.setTargetAtTime(v, T, 0.015);
    set(n.in.gain, dbGain(s.gain));
    n.hpf.frequency.value = s.lowcut || 10;
    if (worklets) { n.gate.parameters.get('enabled').value = s.gate ? 1 : 0; n.gate.parameters.get('threshold').value = s.gateTh; }
    n.ls.frequency.value = s.lsF; n.ls.gain.value = s.lsG;
    n.lm.frequency.value = s.lmF; n.lm.gain.value = s.lmG; n.lm.Q.value = s.lmQ;
    n.md.frequency.value = s.mdF; n.md.gain.value = s.mdG; n.md.Q.value = s.mdQ;
    n.pr.frequency.value = s.prF; n.pr.gain.value = s.prG; n.pr.Q.value = s.prQ;
    n.hs.frequency.value = s.hsF; n.hs.gain.value = s.hsG;
    if (worklets) { n.dees.parameters.get('enabled').value = s.deess ? 1 : 0; n.dees.parameters.get('amount').value = s.deessAmt; }
    if (s.comp) { n.comp.threshold.value = -10 - s.compAmt * 0.3; n.comp.ratio.value = 2 + s.compAmt * 0.06; }
    else { n.comp.threshold.value = 0; n.comp.ratio.value = 1; }
    n.delay.delayTime.value = s.delay / 1000;
    n.pan.pan.value = s.pan / 100;
    set(n.recSend.gain, s.recMute ? 0 : dbGain(sliderDb(s.rec)));
    set(n.monSend.gain, s.monMute ? 0 : dbGain(sliderDb(s.mon)));
  }

  // a stable name for an input that survives restarts (used by cameras that record one mic)
  const keyOf = ch => ch.kind === 'device' ? 'dev:' + (ch.deviceId || ch.name) : ch.kind + ':' + ch.name;
  const byKey = k => channels.find(c => keyOf(c) === k);
  const isoTrack = k => { const c = byKey(k); return c && c.iso ? c.iso.stream.getAudioTracks()[0] : null; };
  function tapOf(ch, channels = 2) {
    if (!worklets) return null;
    if (!ch.tap) { ch.tap = new AudioWorkletNode(ac, 'mcr-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', processorOptions: { channels } }); if (ch.n) ch.n.pan.connect(ch.tap); }
    return ch.tap;
  }
  // Sync beep: a short tone that lands in every recording at the same instant, so editors can line everything up.
  function syncBeep() {
    const T = ac.currentTime + 0.02, o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 1000; g.gain.setValueAtTime(0, T); g.gain.linearRampToValueAtTime(0.5, T + 0.005); g.gain.setValueAtTime(0.5, T + 0.115); g.gain.linearRampToValueAtTime(0, T + 0.12);
    o.connect(g); g.connect(recBus);
    channels.forEach(c => { if (c.iso) g.connect(c.iso); if (c.tap) g.connect(c.tap); });
    o.start(T); o.stop(T + 0.13); o.onended = () => g.disconnect();
    return T;
  }

  function remove(ch) {
    if (ch.n) Object.values(ch.n).forEach(n => { try { n.disconnect(); } catch {} });
    try { ch.tap && ch.tap.disconnect(); } catch {}
    if (ch.stream) ch.stream.getTracks().forEach(t => t.stop());
    channels.splice(channels.indexOf(ch), 1);
    bus.emit('audio');
  }
  function clear() { [...channels].forEach(remove); }

  function applyMaster() {
    const T = ac.currentTime;
    recBus.gain.setTargetAtTime(master.recMute ? 0 : dbGain(sliderDb(master.rec)), T, 0.015);
    monBus.gain.setTargetAtTime(master.monMute ? 0 : dbGain(sliderDb(master.mon)), T, 0.015);
    if (worklets) recLim.parameters.get('enabled').value = master.clipguard ? 1 : 0;
  }
  async function setSink(id) {
    if (!ac.setSinkId) return false;
    try { await ac.setSinkId(id === 'default' ? '' : id); master.sink = id; return true; }
    catch (e) { toast('Could not switch monitor output: ' + e.message, 'err'); return false; }
  }

  const buf = new Float32Array(1024);
  const peakOf = an => { an.getFloatTimeDomainData(buf); let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v)); return 20 * Math.log10(pk || 1e-6); };

  async function addSystemAudio() {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, systemAudio: 'include',
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } });
      if (!s.getAudioTracks().length) { s.getTracks().forEach(t => t.stop()); toast('No audio was shared. Pick your entire screen and turn on system audio.', 'err'); return null; }
      s.getVideoTracks().forEach(t => t.enabled = false);
      const ch = await addChannel({ kind: 'system', name: 'System audio', stream: s, s: { ...withPreset('Gameplay / system'), monMute: true } });
      log('System audio added (muted in your headphones so you do not hear it twice)');
      return ch;
    } catch (e) { if (e.name !== 'NotAllowedError') toast('System audio: ' + e.message, 'err'); return null; }
  }

  // Sound check: listen for `secs`, then set each input's gain so speech peaks land near -10 dBFS.
  async function soundCheck(secs, onTick) {
    const peaks = new Map(channels.filter(c => c.n).map(c => [c, -100]));
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      for (const [c] of peaks) {
        const pre = peakOf(c.n.an) - c.s.gain;      // level before the gain stage
        peaks.set(c, Math.max(peaks.get(c), pre));
      }
      onTick && onTick(secs - (performance.now() - t0) / 1000);
      await sleep(40);
    }
    const out = [];
    for (const [c, pk] of peaks) {
      if (pk < -55) { out.push({ name: c.name, skipped: true }); continue; }
      c.s.gain = clamp(Math.round((-10 - pk) * 2) / 2, -24, 24);
      apply(c); out.push({ name: c.name, gain: c.s.gain, peak: pk });
    }
    bus.emit('audio');
    return out;
  }

  function beep(freq = 1000, dur = 0.12, toRecord = false) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = freq; g.gain.value = 0.25; o.connect(g); g.connect(ac.destination);
    if (toRecord) g.connect(recBus);
    o.start(); o.stop(ac.currentTime + dur);
  }

  function serialize() {
    return { master: { ...master }, channels: channels.filter(c => c.kind === 'device').map(c => ({ kind: c.kind, deviceId: c.deviceId, label: c.label, name: c.name, s: { ...c.s } })) };
  }
  async function load(cfg, devices) {
    clear();
    Object.assign(master, cfg.master || {});
    applyMaster();
    if (master.sink) setSink(master.sink);
    for (const c of cfg.channels || []) {
      const dev = devices.find(d => d.deviceId === c.deviceId) || devices.find(d => c.label && d.label === c.label);
      if (dev) await addChannel({ ...c, deviceId: dev.deviceId, label: dev.label });
    }
  }

  return {
    init, addChannel, open, build, apply, remove, clear, applyMaster, setSink, addSystemAudio, soundCheck, beep, serialize, load,
    channels, master, peakOf, keyOf, byKey, isoTrack, tapOf, syncBeep, sampleRate: () => ac ? ac.sampleRate : 48000, loadAi, setAi, aiActive: ch => !!(ch.n && ch.n.ai), get aiState() { return ai.state; },
    get recAn() { return recAn; }, get monAn() { return monAn; }, get ctx() { return ac; },
    get cg() { return cgReduction; }, resetCg() { cgReduction = 0; },
    track: () => channels.length && recDest ? recDest.stream.getAudioTracks()[0] : null,
  };
})();
