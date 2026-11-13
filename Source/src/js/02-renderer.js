// GPU renderer: one pass for framing, sharpening, green screen, color, looks, LUT, vertical crop and monitor overlays.

const ADJ_DEFAULT = {
  // framing
  zoom: 100, panX: 0, panY: 0, rot: 0, mirror: false, flip: false,
  // light
  exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0,
  // color
  temp: 0, tint: 0, saturation: 0, vibrance: 0, hue: 0,
  // detail & style
  sharpness: 0, vignette: 0, fade: 0, split: 0,
  // green screen
  key: false, keyColor: 'green', keySim: 50, keySmooth: 25, keySpill: 60, bgMode: 'color', bgColor: '#101114', bgKey: '',
  // monitoring (preview only)
  zebra: false, peaking: false,
  look: 'Natural',
};
const LOOK_KEYS = ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'temp', 'tint', 'saturation', 'vibrance', 'hue', 'sharpness', 'vignette', 'fade', 'split'];
const L = (desc, o) => ({ desc, a: { ...Object.fromEntries(LOOK_KEYS.map(k => [k, 0])), ...o } });
const LOOKS = {
  'Natural':        L('No adjustments. The camera as it is.', {}),
  'Bright & Clean': L('Lifted, airy and crisp. Great for desk setups.', { exposure: 15, shadows: 20, highlights: -10, contrast: 5, vibrance: 15, sharpness: 15 }),
  'Product Pop':    L('Extra detail and color for unboxings and close-ups.', { exposure: 5, contrast: 10, shadows: 15, highlights: -10, vibrance: 25, sharpness: 35 }),
  'Cinematic':      L('Teal shadows, warm highlights and soft roll-off.', { contrast: 20, highlights: -25, shadows: -10, saturation: -10, split: 60, vignette: 25, fade: 10 }),
  'Warm Glow':      L('Golden and inviting.', { temp: 25, tint: 5, vibrance: 10, contrast: -5, fade: 10, highlights: -10 }),
  'Cool Studio':    L('Clean, modern and slightly cool.', { temp: -20, contrast: 10, saturation: -5, sharpness: 15 }),
  'Vivid':          L('Punchy color for social clips.', { contrast: 15, saturation: 20, vibrance: 30, sharpness: 20 }),
  'Skin Friendly':  L('Natural skin tones without the redness.', { temp: 8, vibrance: 15, saturation: -5, highlights: -10, contrast: -5 }),
  'Matte Film':     L('Soft blacks and muted color.', { contrast: -15, fade: 45, saturation: -15, temp: 8, vignette: 15 }),
  'Moody':          L('Dark, rich and dramatic.', { exposure: -10, contrast: 25, highlights: -20, shadows: -20, saturation: -25, temp: -10, vignette: 35 }),
  'Retro':          L('Faded warm film look.', { fade: 35, temp: 20, saturation: -20, contrast: 10, split: 30, vignette: 30 }),
  'Black & White':  L('Classic monochrome with punch.', { saturation: -100, contrast: 20, sharpness: 10 }),
  'Stage Lights':   L('Tames hot stage lighting and opens up faces. Built for church.', { highlights: -45, shadows: 25, contrast: -5, vibrance: 10, temp: -5 }),
  'Low Light':      L('Brightens dim rooms and evening services.', { exposure: 35, shadows: 40, contrast: 5, sharpness: 10, saturation: -5 }),
};

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;

const FS = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D vid, bgTex; uniform sampler3D lut;
uniform vec2 texel; uniform vec4 crop; uniform mat2 rotM; uniform vec2 flipv; uniform float zoom; uniform vec2 pan;
uniform float bypass, exposure, bright, contrast, highs, shads, temp, tint, sat, vib, hue, sharp, vig, fade, split;
uniform float lutAmt, lscale, loff; uniform vec3 dmin, dmax;
uniform float keyOn, keyBlue, keyTh, keySoft, keySpill, bgMode; uniform vec3 bgCol; uniform vec2 bgScale, bgOff;
uniform float zebra, peaking, outAspect;
in vec2 uv; out vec4 o;

float luma(vec3 c){ return dot(c, vec3(.2126,.7152,.0722)); }
vec3 hueRot(vec3 c, float a){
  const mat3 toY = mat3(.299,.596,.211, .587,-.274,-.523, .114,-.322,.312);
  const mat3 toR = mat3(1.,1.,1., .956,-.272,-1.106, .621,-.647,1.703);
  vec3 y = toY*c; float cs = cos(a), sn = sin(a);
  y.yz = vec2(y.y*cs - y.z*sn, y.y*sn + y.z*cs);
  return toR*y;
}
vec2 srcUV(vec2 u){
  u = crop.xy + u*crop.zw;                 // vertical crop
  vec2 q = (u - .5)/zoom + pan*(.5 - .5/zoom); // zoom and reposition in output space
  q = rotM * q; q *= flipv;
  return q + .5;
}
void main(){
  vec2 s = srcUV(uv);
  vec3 c = texture(vid, s).rgb;
  if (bypass > .5) { o = vec4(c,1.); return; }
  vec3 nl = texture(vid, s - vec2(texel.x,0.)).rgb, nr = texture(vid, s + vec2(texel.x,0.)).rgb;
  vec3 nu = texture(vid, s - vec2(0.,texel.y)).rgb, nd = texture(vid, s + vec2(0.,texel.y)).rgb;
  if (sharp > 0.) c = clamp(c + (c - (nl+nr+nu+nd)*.25)*sharp*3., 0., 1.);

  float alpha = 1.;
  if (keyOn > .5) {
    float k = keyBlue > .5 ? c.b - max(c.r,c.g) : c.g - max(c.r,c.b);
    alpha = 1. - smoothstep(keyTh, keyTh + keySoft, k);
    if (k > 0.) {
      float m = keyBlue > .5 ? max(c.r,c.g) : max(c.r,c.b);
      if (keyBlue > .5) c.b = mix(c.b, m, keySpill); else c.g = mix(c.g, m, keySpill);
    }
  }

  c *= exp2(exposure);
  c *= vec3(1. + temp*.22 + tint*.05, 1. - tint*.18, 1. - temp*.22 + tint*.05);
  float l = luma(c);
  c += (1. - smoothstep(0., .55, l)) * shads * .3;
  c += smoothstep(.45, 1., l) * highs * .3;
  c += bright * .2;
  c = (c - .5) * (1. + contrast) + .5;
  c = mix(vec3(fade*.12), vec3(1. - fade*.04), clamp(c, 0., 1.));
  l = luma(c);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1. + vib*(1. - (mx - mn))*1.2);
  c = mix(vec3(l), c, 1. + sat);
  if (hue != 0.) c = hueRot(c, hue);
  l = luma(c);
  c += split * (vec3(-.04,.02,.06)*(1. - l) + vec3(.07,.03,-.05)*l);
  vec2 vq = uv - .5; vq.x *= outAspect;
  c *= 1. - vig * smoothstep(.35, 1., length(vq) / length(vec2(outAspect*.5, .5)));
  c = clamp(c, 0., 1.);

  if (lutAmt > 0.) {
    vec3 n = clamp((c - dmin) / (dmax - dmin), 0., 1.);
    c = mix(c, texture(lut, n*lscale + loff).rgb, lutAmt);
  }
  if (keyOn > .5) {
    vec3 bg = bgMode > .5 ? texture(bgTex, uv*bgScale + bgOff).rgb : bgCol;
    c = mix(bg, c, alpha);
  }
  if (zebra > .5 && luma(c) > .95 && mod(gl_FragCoord.x + gl_FragCoord.y, 14.) < 7.) c = vec3(.05);
  if (peaking > .5) {
    float e = abs(luma(nr) - luma(nl)) + abs(luma(nd) - luma(nu));
    if (e > .22) c = mix(c, vec3(1.,.15,.2), .85);
  }
  o = vec4(c, 1.);
}`;

function hexRgb(hex) { const n = parseInt((hex || '#000000').slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

function makeRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, desynchronized: true, powerPreference: 'high-performance' });
  if (!gl) return null;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uc = {}; const U = n => (n in uc) ? uc[n] : (uc[n] = gl.getUniformLocation(prog, n));
  const f1 = (n, v) => gl.uniform1f(U(n), v), f2 = (n, a, b) => gl.uniform2f(U(n), a, b);
  gl.uniform1i(U('vid'), 0); gl.uniform1i(U('lut'), 1); gl.uniform1i(U('bgTex'), 2);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const tex = (unit, target) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  const vtex = tex(0, gl.TEXTURE_2D), ltex = tex(1, gl.TEXTURE_3D), btex = tex(2, gl.TEXTURE_2D);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

  let hasLut = false, bgAspect = 0, vsize = [0, 0];
  function setLut(l) {
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, ltex);
    if (!l) { hasLut = false; gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 2, 2, 2, 0, gl.RGB, gl.FLOAT, new Float32Array(24)); return; }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, l.size, l.size, l.size, 0, gl.RGB, gl.FLOAT, l.data);
    f1('lscale', (l.size - 1) / l.size); f1('loff', .5 / l.size);
    gl.uniform3fv(U('dmin'), l.dmin); gl.uniform3fv(U('dmax'), l.dmax);
    hasLut = true;
  }
  function setBg(img) {
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, btex);
    if (!img) { bgAspect = 0; return; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    bgAspect = img.width / img.height;
  }
  setLut(null);

  // opts: { lutAmt, bypass, overlays, vertical: {x} | null }
  function draw(video, a, opts) {
    // works for <video>, <img> and <canvas> sources
    const vw = video.videoWidth || video.naturalWidth || (video.tagName === 'CANVAS' ? video.width : 0), vh = video.videoHeight || video.naturalHeight || (video.tagName === 'CANVAS' ? video.height : 0);
    if (!vw) return false;
    const k = ((a.rot || 0) / 90) % 4, swap = k % 2 === 1;
    let W = swap ? vh : vw, H = swap ? vw : vh;
    let crop = [0, 0, 1, 1];
    if (opts.vertical) {                         // 9:16 crop from the (rotated) frame
      const target = 9 / 16, cur = W / H;
      if (cur > target) { const cw = target / cur; crop = [clamp((1 - cw) / 2 + (opts.vertical.x || 0) / 100 * (1 - cw) / 2, 0, 1 - cw), 0, cw, 1]; W = Math.round(H * target / 2) * 2; }
    }
    // previews render at the size they're shown, not the camera's full resolution
    if (opts.maxW && W > opts.maxW) { const s = opts.maxW / W; W = Math.max(2, Math.round(W * s / 2) * 2); H = Math.max(2, Math.round(H * s / 2) * 2); }
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vtex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    vsize = [vw, vh];
    const ang = -k * Math.PI / 2, cs = Math.cos(ang), sn = Math.sin(ang);
    gl.uniformMatrix2fv(U('rotM'), false, [cs, sn, -sn, cs]);
    gl.uniform4f(U('crop'), ...crop);
    f2('flipv', a.mirror ? -1 : 1, a.flip ? -1 : 1);
    f1('zoom', Math.max(1, a.zoom / 100)); f2('pan', a.panX / 100, a.panY / 100);
    f2('texel', 1 / vw, 1 / vh);
    f1('bypass', opts.bypass ? 1 : 0);
    f1('exposure', a.exposure / 50); f1('bright', a.brightness / 100); f1('contrast', a.contrast / 100);
    f1('highs', a.highlights / 100); f1('shads', a.shadows / 100); f1('temp', a.temp / 100); f1('tint', a.tint / 100);
    f1('sat', a.saturation / 100); f1('vib', a.vibrance / 100); f1('hue', a.hue * Math.PI / 180);
    f1('sharp', a.sharpness / 100); f1('vig', a.vignette / 100 * .8); f1('fade', a.fade / 100); f1('split', a.split / 100);
    f1('lutAmt', hasLut ? (opts.lutAmt || 0) : 0);
    f1('keyOn', a.key ? 1 : 0); f1('keyBlue', a.keyColor === 'blue' ? 1 : 0);
    f1('keyTh', .4 - a.keySim / 100 * .37); f1('keySoft', .005 + a.keySmooth / 100 * .25); f1('keySpill', a.keySpill / 100);
    const useImg = a.bgMode === 'image' && bgAspect > 0;
    f1('bgMode', useImg ? 1 : 0); gl.uniform3fv(U('bgCol'), hexRgb(a.bgColor));
    const ca = W / H;
    if (useImg && bgAspect > ca) { const sx = ca / bgAspect; f2('bgScale', sx, 1); f2('bgOff', (1 - sx) / 2, 0); }
    else if (useImg) { const sy = bgAspect / ca; f2('bgScale', 1, sy); f2('bgOff', 0, (1 - sy) / 2); }
    f1('outAspect', ca);
    f1('zebra', opts.overlays && a.zebra ? 1 : 0); f1('peaking', opts.overlays && a.peaking ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
  function destroy() { const ext = gl.getExtension('WEBGL_lose_context'); ext && ext.loseContext(); }
  return { setLut, setBg, draw, destroy, canvas };
}

// Does this camera need GPU processing in the recording (vs. the untouched camera feed)?
function adjActive(a) {
  return a.zoom !== 100 || a.panX || a.panY || a.rot || a.mirror || a.flip || a.key || LOOK_KEYS.some(k => a[k]);
}
