// File name builder: pick pieces (Project, Take, Camera, Date…), order them, choose a separator, see the result live.
const NAME_PIECES = [
  ['project', 'Project'], ['take', 'Take'], ['camera', 'Camera'], ['date', 'Date'], ['time', 'Time'], ['setup', 'Setup'], ['text', 'Your text'],
];
const SEPARATORS = [['_', 'Underscore  _'], ['-', 'Dash  -'], [' ', 'Space'], ['', 'None']];
const DEFAULT_NAMING = { parts: [{ t: 'project' }, { t: 'take' }, { t: 'camera' }], sep: '_' };
const NAME_STYLES = [
  ['Project, take, camera', { parts: [{ t: 'project' }, { t: 'take' }, { t: 'camera' }], sep: '_' }],
  ['Date, project, camera', { parts: [{ t: 'date' }, { t: 'project' }, { t: 'camera' }], sep: ' ' }],
  ['Camera, take', { parts: [{ t: 'camera' }, { t: 'take' }], sep: '_' }],
  ['Project, camera, time', { parts: [{ t: 'project' }, { t: 'camera' }, { t: 'time' }], sep: '-' }],
];
const cloneNaming = n => ({ parts: (n.parts || []).map(p => ({ ...p })), sep: n.sep ?? '_' });

function namingToPattern(n) {
  return (n.parts || []).map(p => p.t === 'text' ? (p.v || '').replace(/[{}]/g, '') : p.t === 'take' ? 'T{take}' : `{${p.t}}`).filter(Boolean).join(n.sep ?? '_');
}
// legacy {token} patterns → builder parts (best effort)
function patternToNaming(pat) {
  if (!pat || !pat.trim()) return null;
  const sepM = pat.match(/\}([ _\-])/);
  const sep = sepM ? sepM[1] : '_';
  const parts = [];
  for (const tok of pat.split(/(T?\{\w+\})/)) {
    const m = tok.match(/^T?\{(\w+)\}$/);
    if (m) { parts.push({ t: m[1].toLowerCase() }); continue; }
    const txt = tok.replace(/^[ _\-]+|[ _\-]+$/g, '');
    if (txt) parts.push({ t: 'text', v: txt });
  }
  return parts.length ? { parts, sep } : null;
}
const defaultNaming = () => project.naming || patternToNaming(project.filePattern) || DEFAULT_NAMING;
const camNaming = cam => cam.naming || patternToNaming(cam.fileName) || null;     // null = same as other cameras

function previewName(naming, cam) {
  const c = cam || { name: cams[0] ? cams[0].name : 'Camera 1' };
  const tmp = { ...c, naming, fileName: '' };
  return fileBaseFor(tmp);
}

// ---------- the builder sheet ----------
// opts: { title, naming, cam, allowDefault, onSave(naming | null) }
function openNameBuilder(opts) {
  let n = cloneNaming(opts.naming || defaultNaming());
  const draw = (body, dlg) => {
    const pill = (p, i) => {
      const label = (NAME_PIECES.find(x => x[0] === p.t) || [, p.t])[1];
      return `<span class="npart ${p.t === 'text' ? 'txt' : ''}" data-i="${i}">
        <button class="nmv" data-mv="-1" title="Move left" ${i === 0 ? 'disabled' : ''}>‹</button>
        ${p.t === 'text' ? `<input class="ntxt" value="${esc(p.v || '')}" placeholder="text" maxlength="40" size="${Math.max(4, (p.v || '').length + 1)}">` : `<b>${label}</b>`}
        <button class="nmv" data-mv="1" title="Move right" ${i === n.parts.length - 1 ? 'disabled' : ''}>›</button>
        <button class="nx" title="Remove">×</button></span>`;
    };
    const ext = EXT;
    body.innerHTML = `
      <div class="nprev"><span class="nlab">File name</span><div class="nval">${esc(previewName(n, opts.cam))}<span>.${ext}</span></div></div>
      <div class="cat">Pieces, in order</div>
      <div class="nparts">${n.parts.map(pill).join('<span class="nsep">' + (n.sep === ' ' ? '␣' : esc(n.sep) || '·') + '</span>') || '<span class="empty-note">Add at least one piece below.</span>'}</div>
      <div class="cat">Add</div>
      <div class="chips">${NAME_PIECES.map(([t, l]) => `<button class="chip" data-add="${t}">+ ${l}</button>`).join('')}</div>
      <div class="cat">Between pieces</div>
      ${ui.seg('sep', SEPARATORS, n.sep)}
      <div class="cat">Quick styles</div>
      <div class="chips">${NAME_STYLES.map(([l], i) => `<button class="chip" data-style="${i}">${l}</button>`).join('')}</div>
      <p class="note" style="padding:10px 0 0">Project and take come from Settings. Take goes up by one after every recording. Camera is each camera’s name.</p>
      <div style="display:flex;gap:8px;margin-top:14px">
        ${opts.allowDefault ? '<button class="btn" data-act="default">Use the default name</button>' : ''}
        <span style="flex:1"></span>
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save" ${n.parts.length ? '' : 'disabled'}>Save</button>
      </div>`;
    const redraw = () => draw(body, dlg);
    body.querySelectorAll('.npart').forEach(el => {
      const i = +el.dataset.i;
      el.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { const j = i + +b.dataset.mv; [n.parts[i], n.parts[j]] = [n.parts[j], n.parts[i]]; redraw(); });
      el.querySelector('.nx').onclick = () => { n.parts.splice(i, 1); redraw(); };
      const t = el.querySelector('.ntxt');
      if (t) t.oninput = () => { n.parts[i].v = t.value; t.size = Math.max(4, t.value.length + 1); body.querySelector('.nval').firstChild.textContent = previewName(n, opts.cam); };
    });
    body.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
      n.parts.push(b.dataset.add === 'text' ? { t: 'text', v: '' } : { t: b.dataset.add }); redraw();
      if (b.dataset.add === 'text') { const ins = body.querySelectorAll('.ntxt'); ins[ins.length - 1].focus(); }
    });
    body.querySelectorAll('[data-style]').forEach(b => b.onclick = () => { n = cloneNaming(NAME_STYLES[+b.dataset.style][1]); redraw(); });
    bindControls(body.querySelector('[data-seg=sep]').parentElement, n, () => redraw());
    body.querySelector('[data-act=cancel]').onclick = () => dlg.close();
    body.querySelector('[data-act=save]').onclick = () => { opts.onSave(cloneNaming(n)); dlg.close(); };
    const def = body.querySelector('[data-act=default]'); if (def) def.onclick = () => { opts.onSave(null); dlg.close(); };
  };
  const d = openMenu(opts.title || 'File name', '', (body, dlg) => draw(body, dlg));
  d.style.width = '520px';
  d.addEventListener('close', () => { d.style.width = ''; }, { once: true });
}
