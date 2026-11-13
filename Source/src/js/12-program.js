// Program output: one clean feed (camera + look + optional picture-in-picture) for the virtual camera and the output window.
const program = { camIdx: 0, pipIdx: -1, pipPos: 'br', pipX: .8, pipY: .78, pipSize: 28, pipShape: 'rounded', pipBorder: 'none', pipShadow: true, mainFit: 'contain', trans: 'fade', transMs: 400, record: false, res: '720', fps: 30, lut: true, vcam: false, ...store.get('program', {}) };
program.vcam = false;                         // never auto-start a camera other apps can see
const saveProgram = () => store.set('program', { ...program, vcam: false });
const OUT_RES = { '720': [1280, 720], '1080': [1920, 1080] };
let progLive = false, progTimer = 0, outWin = null, vcamState = { on: false, error: '', mode: null, connected: false };
const vcamName = () => vcamState.mode === 'gcs' ? 'Gadget Cam Studio' : 'OBS Virtual Camera';
let progR = null, pipR = null;
const comp = document.createElement('canvas');
const cctx = comp.getContext('2d', { alpha: false });

const progCam = () => cams[program.camIdx] || cams.find(c => c.alive) || null;
const pipCam = () => program.pipIdx >= 0 && program.pipIdx !== program.camIdx ? cams[program.pipIdx] || null : null;

function setProgramCam(cam) {
  const i = cams.indexOf(cam); if (i < 0) return;
  program.camIdx = i; saveProgram();
  cams.forEach(paintTile);
  if (view.mode === 'output') applyView();
  if (selected && selected.type === 'program') renderInspector();
  renderOutList();
}

// ---------- RGB → NV12 on the GPU (BT.709, limited range, like OBS) ----------
function makeNV12() {
  const cv = document.createElement('canvas');
  const gl = cv.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const vs = `#version 300 es
  in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
  const fs = `#version 300 es
  precision highp float; uniform sampler2D src; uniform vec2 size; out vec4 o;
  void main(){
    ivec2 q = ivec2(gl_FragCoord.xy); int H = int(size.y); vec4 r = vec4(0.);
    if (q.y < H) {
      for (int k = 0; k < 4; k++) { vec3 c = texture(src, (vec2(float(q.x*4+k), float(q.y)) + .5) / size).rgb;
        r[k] = (16. + 219.*dot(c, vec3(.2126,.7152,.0722))) / 255.; }
    } else {
      int row = q.y - H;
      for (int j = 0; j < 2; j++) { vec3 c = texture(src, vec2(float(2*(q.x*2+j)+1), float(2*row+1)) / size).rgb;
        r[j*2]   = (128. + 224.*dot(c, vec3(-.1146,-.3854,.5))) / 255.;
        r[j*2+1] = (128. + 224.*dot(c, vec3(.5,-.4542,-.0458))) / 255.; }
    }
    o = r;
  }`;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(pr, 'src'), 0);
  const uSize = gl.getUniformLocation(pr, 'size');
  // render into an RGBA8 texture (not the canvas) so all 4 bytes per texel come back untouched
  const fbt = gl.createTexture(), fb = gl.createFramebuffer();
  let out = null;
  return {
    convert(source, w, h) {
      const ow = w / 4, oh = h * 3 / 2;
      if (!out || out.length !== w * h * 3 / 2) {
        out = new Uint8Array(w * h * 3 / 2);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fbt);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbt, 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, ow, oh);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform2f(uSize, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out;
    },
  };
}
let nv12 = null;

// ---------- compose one frame ----------
function fitDraw(src, x, y, w, h, cover = false) {     // contain (letterbox) or cover (fill and crop), centered
  const sw = src.width, sh = src.height; if (!sw || !sh) return;
  const s = cover ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh), dw = sw * s, dh = sh * s;
  if (cover) { cctx.save(); cctx.beginPath(); cctx.rect(x, y, w, h); cctx.clip(); }
  cctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  if (cover) cctx.restore();
}
const trans = { from: null, t0: 0, last: null }; let fromR = null;
let pipRect = null;                                     // where the inset was last drawn (output pixels), for dragging
function composeFrame() {
  const [W, H] = OUT_RES[program.res] || OUT_RES['720'];
  if (comp.width !== W || comp.height !== H) { comp.width = W; comp.height = H; }
  cctx.fillStyle = '#000'; cctx.fillRect(0, 0, W, H);
  const cam = progCam();
  // camera switch → start a transition from the old shot (both stay live while it plays)
  if (cam !== trans.last) {
    if (trans.last && cam && program.trans !== 'cut' && cams.includes(trans.last) && trans.last.alive) {
      trans.from = trans.last; trans.t0 = performance.now();
      fromR = fromR || makeRenderer(document.createElement('canvas'));
      fromR.setLut(trans.from.lut.name && luts.get(trans.from.lut.name) || null); fromR.setBg(trans.from.bgImg);
    } else trans.from = null;
    trans.last = cam;
  }
  let k = 1;
  if (trans.from) {
    k = (performance.now() - trans.t0) / Math.max(100, program.transMs);
    if (k >= 1 || !trans.from.alive || !srcReady(trans.from) || !cams.includes(trans.from)) { trans.from = null; k = 1; }
  }
  const cover = program.mainFit === 'cover';
  const drawTo = () => {
    if (cam && cam.alive && srcReady(cam)) {
      progR = progR || makeRenderer(document.createElement('canvas'));
      syncProgramLuts();
      if (progR.draw(srcEl(cam), cam.adj, { lutAmt: program.lut ? cam.lut.amt : 0, maxW: W })) fitDraw(progR.canvas, 0, 0, W, H, cover);
    } else {
      cctx.fillStyle = '#8e8e93'; cctx.font = `500 ${Math.round(H / 24)}px -apple-system, "Segoe UI", system-ui`; cctx.textAlign = 'center';
      cctx.fillText(cam ? `${cam.name} is not connected` : 'No camera', W / 2, H / 2);
    }
  };
  const drawFrom = () => { const f = trans.from; if (fromR.draw(srcEl(f), f.adj, { lutAmt: program.lut ? f.lut.amt : 0, maxW: W })) fitDraw(fromR.canvas, 0, 0, W, H, cover); };
  const zoomed = (z, fn) => { cctx.save(); cctx.translate(W / 2, H / 2); cctx.scale(z, z); cctx.translate(-W / 2, -H / 2); fn(); cctx.restore(); };
  if (!trans.from) drawTo();
  else {
    const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, type = program.trans;
    if (type === 'dip') {
      if (k < .5) drawFrom(); else drawTo();
      cctx.save(); cctx.globalAlpha = k < .5 ? k * 2 : (1 - k) * 2; cctx.fillStyle = '#000'; cctx.fillRect(0, 0, W, H); cctx.restore();
    } else if (type === 'slide') {
      cctx.save(); cctx.translate(-Math.round(e * W), 0); drawFrom(); cctx.restore();
      cctx.save(); cctx.translate(W - Math.round(e * W), 0); cctx.fillStyle = '#000'; cctx.fillRect(0, 0, W, H); drawTo(); cctx.restore();
    } else if (type === 'zoom') {
      zoomed(1 + .12 * e, drawFrom);
      cctx.save(); cctx.globalAlpha = e; zoomed(1.08 - .08 * e, drawTo); cctx.restore();
    } else {                                                 // fade
      drawFrom();
      cctx.save(); cctx.globalAlpha = e; drawTo(); cctx.restore();
    }
  }
  const pc = pipCam();
  pipRect = null;
  if (pc && pc.alive && srcReady(pc)) {
    pipR = pipR || makeRenderer(document.createElement('canvas'));
    const pw = Math.round(W * program.pipSize / 100);
    if (pipR.draw(srcEl(pc), pc.adj, { lutAmt: program.lut ? pc.lut.amt : 0, maxW: Math.max(320, pw * 1.5) })) {
      const src = pipR.canvas, circle = program.pipShape === 'circle';
      const ph = circle ? pw : Math.round(pw * src.height / src.width);
      const m = Math.round(W * 0.025);
      let x, y;
      if (program.pipPos === 'custom') { x = Math.round(program.pipX * W - pw / 2); y = Math.round(program.pipY * H - ph / 2); }
      else { x = program.pipPos.includes('r') ? W - pw - m : m; y = program.pipPos.includes('b') ? H - ph - m : m; }
      x = clamp(x, 0, W - pw); y = clamp(y, 0, H - ph);
      const r = circle ? pw / 2 : program.pipShape === 'square' ? 0 : Math.round(pw * 0.06);
      const path = () => { cctx.beginPath(); circle ? cctx.arc(x + pw / 2, y + ph / 2, pw / 2, 0, Math.PI * 2) : cctx.roundRect(x, y, pw, ph, r); };
      if (program.pipShadow) { cctx.save(); cctx.shadowColor = 'rgba(0,0,0,.5)'; cctx.shadowBlur = m * 1.2; cctx.shadowOffsetY = m * .25; path(); cctx.fillStyle = '#000'; cctx.fill(); cctx.restore(); }
      cctx.save(); path(); cctx.clip();
      if (circle) { const s = Math.max(pw / src.width, ph / src.height), dw = src.width * s, dh = src.height * s; cctx.drawImage(src, x + (pw - dw) / 2, y + (ph - dh) / 2, dw, dh); }
      else cctx.drawImage(src, x, y, pw, ph);
      cctx.restore();
      if (program.pipBorder !== 'none') { cctx.save(); path(); cctx.lineWidth = Math.max(2, W * 0.004); cctx.strokeStyle = program.pipBorder === 'white' ? '#fff' : '#0a84ff'; cctx.stroke(); cctx.restore(); }
      pipRect = { x, y, w: pw, h: ph };
    }
  }
  drawTitles(cctx, W, H);
}

// drag the inset on any output preview
function enablePipDrag(canvas) {
  if (canvas._pipDrag) return; canvas._pipDrag = true;
  let drag = null;
  const toOut = e => {                                   // canvas is shown with object-fit: contain
    const r = canvas.getBoundingClientRect(), W = comp.width, H = comp.height;
    const s = Math.min(r.width / W, r.height / H), ox = r.left + (r.width - W * s) / 2, oy = r.top + (r.height - H * s) / 2;
    return { x: (e.clientX - ox) / s, y: (e.clientY - oy) / s };
  };
  canvas.addEventListener('pointerdown', e => {
    if (!pipRect) return;
    const p = toOut(e);
    if (p.x < pipRect.x || p.x > pipRect.x + pipRect.w || p.y < pipRect.y || p.y > pipRect.y + pipRect.h) return;
    e.stopPropagation(); e.preventDefault();
    drag = { dx: p.x - (pipRect.x + pipRect.w / 2), dy: p.y - (pipRect.y + pipRect.h / 2) };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) { const p = pipRect && toOut(e); canvas.style.cursor = p && p.x >= pipRect.x && p.x <= pipRect.x + pipRect.w && p.y >= pipRect.y && p.y <= pipRect.y + pipRect.h ? 'grab' : ''; return; }
    const p = toOut(e);
    program.pipPos = 'custom'; program.pipX = clamp((p.x - drag.dx) / comp.width, 0, 1); program.pipY = clamp((p.y - drag.dy) / comp.height, 0, 1);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointerup', () => { if (drag) { drag = null; saveProgram(); if (selected && selected.type === 'program') renderInspector(); } });
}
let lutKey = '';
function syncProgramLuts() {
  const cam = progCam(), pc = pipCam();
  const key = `${cam && cam.lut.name}|${pc && pc.lut.name}|${program.camIdx}|${program.pipIdx}`;
  if (key === lutKey) return; lutKey = key;
  if (progR && cam) { progR.setLut(cam.lut.name && luts.get(cam.lut.name) || null); progR.setBg(cam.bgImg); }
  if (pipR && pc) { pipR.setLut(pc.lut.name && luts.get(pc.lut.name) || null); pipR.setBg(pc.bgImg); }
}
bus.on('luts', () => { lutKey = ''; });

// ---------- loop: runs only while something is watching ----------
function wantLoop() { return vcamState.on || (outWin && !outWin.closed) || (selected && selected.type === 'program') || view.mode === 'output' || (recState.active && program.record) || !!document.pictureInPictureElement; }
function ensureLoop() {
  if (progLive || !wantLoop()) return;
  progLive = true;
  const tick = () => {
    if (!wantLoop()) { progLive = false; return; }
    const t0 = performance.now();
    composeFrame();
    if (vcamState.on && NATIVE) {
      nv12 = nv12 || makeNV12();
      if (nv12) NATIVE.vcamFrame(nv12.convert(comp, comp.width, comp.height));
    }
    drawOutputTile();
    const pv = $('#progPreview'); if (pv) { const x = pv.getContext('2d'); x.drawImage(comp, 0, 0, pv.width, pv.height); }
    progTimer = setTimeout(tick, Math.max(1, 1000 / program.fps - (performance.now() - t0)));
  };
  tick();
}

// ---------- virtual camera ----------
async function startVcam() {
  if (!NATIVE || !NATIVE.vcamStart) {
    vcamState = { on: false, error: 'browser', mode: null, connected: false }; renderOutList(); if (selected && selected.type === 'program') renderInspector();
    return toast('The virtual camera needs the Windows app. In the browser, use the output window with OBS.', 'err');
  }
  const av = NATIVE.vcamAvailable(); if (!av.ok) { vcamState = { on: false, error: av.error, mode: null, connected: false }; toast(av.error, 'err'); renderOutList(); return; }
  const [W, H] = OUT_RES[program.res];
  const r = NATIVE.vcamStart(W, H, program.fps);
  if (!r.ok) { vcamState = { on: false, error: r.error, mode: null, connected: false }; toast(r.error, 'err'); }
  else {
    vcamState = { on: true, error: '', mode: r.mode || 'obs', connected: !!r.connected }; program.vcam = true;
    if (vcamState.mode === 'obs') {
      const hasObs = (await navigator.mediaDevices.enumerateDevices()).some(d => d.kind === 'videoinput' && /obs virtual camera/i.test(d.label));
      if (!hasObs) log('Neither camera driver was found. Reinstall Gadget Cam Studio (Windows 11) or install OBS Studio.');
    }
    toast(`Virtual camera on: pick “${vcamName()}” in Meet, Zoom or OBS`);
    log(`Virtual camera started as ${vcamName()} at ${W}×${H} ${program.fps} fps`); ensureLoop();
  }
  renderOutList(); paintToolbar(); if (selected && selected.type === 'program') renderInspector();
}
function stopVcam() {
  if (NATIVE && NATIVE.vcamStop) NATIVE.vcamStop();
  vcamState = { on: false, error: '', mode: null, connected: false }; program.vcam = false;
  renderOutList(); paintToolbar(); if (selected && selected.type === 'program') renderInspector();
  log('Virtual camera stopped');
}
window.addEventListener('beforeunload', () => { if (vcamState.on && NATIVE) NATIVE.vcamStop(); });
setInterval(() => {
  if (!vcamState.on || !NATIVE || !NATIVE.vcamStatus) return;
  const s = NATIVE.vcamStatus(), was = vcamState.connected;
  vcamState.connected = !!s.connected;
  if (was !== vcamState.connected) { renderOutList(); if (selected && selected.type === 'program') renderInspector(); if (vcamState.connected && vcamState.mode === 'gcs') log('An app started using the Gadget Cam Studio camera'); }
}, 1000);

// ---------- output window (for OBS Window Capture, a second screen, or a projector) ----------
function openOutputWindow() {
  if (outWin && !outWin.closed) { outWin.focus(); return; }
  const [W, H] = OUT_RES[program.res];
  outWin = window.open('', 'mcr-output', `width=${Math.round(W / 2)},height=${Math.round(H / 2)}`);
  if (!outWin) return toast('Allow pop-ups for this page to open the output window', 'err');
  outWin.document.open();
  outWin.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gadget Cam Studio Output</title><style>
    html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}canvas{width:100%;height:100%;object-fit:contain;display:block}</style></head>
    <body><canvas id="c"></canvas></body></html>`);
  outWin.document.close();
  const c = outWin.document.getElementById('c'), x = c.getContext('2d', { alpha: false });
  const draw = () => {
    if (!outWin || outWin.closed) return;
    if (c.width !== comp.width) { c.width = comp.width; c.height = comp.height; }
    if (comp.width) x.drawImage(comp, 0, 0);
    outWin.requestAnimationFrame(draw);
  };
  outWin.requestAnimationFrame(draw);
  outWin.document.addEventListener('dblclick', () => outWin.document.fullscreenElement ? outWin.document.exitFullscreen() : outWin.document.documentElement.requestFullscreen());
  ensureLoop(); renderOutList();
  const watch = setInterval(() => { if (!outWin || outWin.closed) { clearInterval(watch); outWin = null; renderOutList(); } }, 1000);
}

// ---------- sidebar + inspector ----------
function renderOutList() {
  const list = $('#outList'); if (!list) return;
  const isSelP = selected && selected.type === 'program';
  const cam = progCam();
  list.innerHTML = `
    <div class="item ${isSelP ? 'sel' : ''}" data-o="vc"><span class="dot ${vcamState.on ? 'live' : ''}"></span>${icon('camera', 'sm')}
      <span class="grow">Virtual camera<div class="sub">${vcamState.on ? (vcamState.mode === 'gcs' && !vcamState.connected ? 'Ready · waiting for an app' : `On · ${esc(cam ? cam.name : '')}`) : NATIVE ? 'Off' : 'Windows app'}</div></span>
      <label class="sw" style="transform:scale(.8);margin-right:-6px" title="Turn the virtual camera on or off"><input type="checkbox" ${vcamState.on ? 'checked' : ''}><i></i></label></div>
    <div class="item" data-o="win"><span class="dot ${outWin && !outWin.closed ? 'live' : ''}"></span>${icon('layers', 'sm')}
      <span class="grow">Output window<div class="sub">${outWin && !outWin.closed ? 'Open' : 'Off'}</div></span></div>`;
  const sw = list.querySelector('.sw input');
  sw.onclick = e => e.stopPropagation();
  sw.onchange = () => sw.checked ? startVcam() : stopVcam();
  list.querySelector('[data-o=vc]').onclick = e => { if (!e.target.closest('.sw')) select('program', program); };
  list.querySelector('[data-o=win]').onclick = () => { openOutputWindow(); select('program', program); };
}

function renderProgramInspector(el) {
  const camOpts = cams.map((c, i) => [i, c.name]);
  const [W, H] = OUT_RES[program.res];
  el.innerHTML = `<div class="insp-h"><div class="t">${icon('camera')}<b style="font-size:16px">Output</b></div>
      <div class="s">Virtual camera · window · recording</div></div>
    <div class="insp-b">
      <canvas id="progPreview" width="640" height="360" style="width:100%;aspect-ratio:16/9;border-radius:11px;background:#000;display:block;margin-bottom:12px"></canvas>
      ${ui.group('Virtual camera', ui.toggle('vcam', 'Virtual camera', vcamState.on,
        NATIVE ? (vcamState.on ? (vcamState.mode === 'gcs' ? (vcamState.connected ? `Live as “Gadget Cam Studio” · ${W}×${H}` : 'Ready. Pick “Gadget Cam Studio” as the camera in Meet, Zoom, Teams or OBS.') : `Live as “OBS Virtual Camera” · ${W}×${H}`)
          : 'Shows up as “Gadget Cam Studio” in Meet, Zoom, Teams, OBS and the Windows Camera app') : 'Needs the Windows app. In the browser, use the output window below with OBS.')
        + (vcamState.error && vcamState.error !== 'browser' ? `<div class="r"><div class="lb"><small style="color:var(--rec)">${esc(vcamState.error)}</small></div></div>` : ''))}
      ${ui.group('Picture', ui.select('camIdx', 'Main', camOpts, program.camIdx, 'Tip: press 1–9 to switch') +
        ui.row('Fit', ui.seg('mainFit', [['contain', 'Fit'], ['cover', 'Fill']], program.mainFit), 'Fill crops to the edges, handy for phones and odd-sized clips') +
        ui.toggle('lut', 'Include LUT', program.lut, 'Show each source’s LUT in the output') +
        ui.row('Transition', ui.seg('trans', [['cut', 'Cut'], ['fade', 'Fade'], ['dip', 'Dip'], ['slide', 'Slide'], ['zoom', 'Zoom']], program.trans), 'How the output moves from one camera to the next') +
        (program.trans !== 'cut' ? ui.slider('transMs', 'Speed', 150, 1500, 50, program.transMs, 400, v => (v / 1000).toFixed(2) + ' s') : ''))}
      ${ui.group('Picture in picture', ui.select('pipIdx', 'Inset', [[-1, 'None'], ...camOpts], program.pipIdx) +
        (program.pipIdx >= 0 ? ui.row('Position', ui.seg('pipPos', [['tl', '↖'], ['tr', '↗'], ['bl', '↙'], ['br', '↘'], ['custom', 'Free']], program.pipPos), 'Or drag the inset on the preview') +
          ui.slider('pipSize', 'Size', 10, 50, 1, program.pipSize, 28, pct) +
          ui.row('Shape', ui.seg('pipShape', [['rounded', 'Rounded'], ['square', 'Square'], ['circle', 'Circle']], program.pipShape)) +
          ui.row('Border', ui.seg('pipBorder', [['none', 'None'], ['white', 'White'], ['accent', 'Blue']], program.pipBorder)) +
          ui.toggle('pipShadow', 'Shadow', program.pipShadow) +
          `<div class="btns" style="margin:8px 0"><button class="btn" data-act="swap">⇄ Swap main and inset</button></div>` : ''))}
      ${ui.group('Record', ui.toggle('record', 'Record the output too', program.record, 'Saves this exact picture, with the inset, as its own file. Perfect for reactions.'))}
      ${ui.group('Format', ui.row('Resolution', ui.seg('res', [['720', '720p'], ['1080', '1080p']], program.res), 'Video calls usually send 720p') +
        ui.row('Frame rate', ui.seg('fps', [[24, '24'], [30, '30'], [60, '60']], program.fps)))}
      <div class="btns"><button class="btn" data-act="win">${icon('layers', 'sm')} Output window</button><button class="btn" data-act="mini">${icon('compare', 'sm')} Floating mini preview</button></div>
      <div class="note">${NATIVE ? (vcamState.mode === 'obs' ? 'Using the OBS Virtual Camera because the Gadget Cam Studio camera isn’t installed (it needs Windows 11). Turn off “Start Virtual Camera” in OBS while this is on. ' : 'When this app is closed, the Gadget Cam Studio camera shows a dark standby screen. ') : ''}The output window has no buttons or borders. Add it in OBS with Window Capture, or double-click it for full screen on another display.</div>
    </div>`;
  bindControls(el, program, async (k, v) => {
    if (k === 'vcam') { v ? await startVcam() : stopVcam(); return; }
    saveProgram(); lutKey = '';
    if ((k === 'res' || k === 'fps') && vcamState.on) { stopVcam(); await startVcam(); }
    if (k === 'record' && v) toast('The output will be saved as its own file on every recording');
    if (['camIdx', 'pipIdx', 'res', 'pipPos', 'trans'].includes(k)) { cams.forEach(paintTile); renderInspector(); renderOutList(); if (view.mode === 'output') applyView(); }
  });
  const recG = [...el.querySelectorAll('.group-h')].find(x => x.textContent.trim() === 'Record');
  if (recG) { recG.insertAdjacentHTML('beforebegin', titlesGroupHtml()); wireTitles(el); }
  el.querySelector('[data-act=win]').onclick = openOutputWindow;
  el.querySelector('[data-act=mini]').onclick = toggleMiniPreview;
  const sw = el.querySelector('[data-act=swap]');
  if (sw) sw.onclick = () => { [program.camIdx, program.pipIdx] = [program.pipIdx, program.camIdx]; saveProgram(); lutKey = ''; cams.forEach(paintTile); renderInspector(); if (view.mode === 'output') applyView(); };
  enablePipDrag(el.querySelector('#progPreview'));
  ensureLoop();
}

// number keys put a camera on the output
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9 && cams[n - 1]) { setProgramCam(cams[n - 1]); toast(`${cams[n - 1].name} on output`); }
});

// ---------- floating mini preview ----------
let miniVideo = null;
async function toggleMiniPreview() {
  if (document.pictureInPictureElement) { await document.exitPictureInPicture().catch(() => {}); return; }
  if (!document.pictureInPictureEnabled) return toast('Floating preview isn’t available in this browser', 'err');
  ensureLoop();
  if (!miniVideo) {
    miniVideo = document.createElement('video'); miniVideo.muted = true; miniVideo.playsInline = true;
    ($('#vidpool') || document.body).appendChild(miniVideo);
    miniVideo.addEventListener('leavepictureinpicture', () => paintToolbar());
  }
  if (!comp.width) composeFrame();
  miniVideo.srcObject = comp.captureStream(program.fps);
  await miniVideo.play().catch(() => {});
  try { await miniVideo.requestPictureInPicture(); ensureLoop(); } catch (e) { toast('Could not open the floating preview: ' + e.message, 'err'); }
  paintToolbar();
}
