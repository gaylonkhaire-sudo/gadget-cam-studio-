// Naming cameras: inline rename on the preview, a name prompt when adding a camera, and a "Name your cameras" sheet.
// The camera's name is what the "Camera" piece of every file name uses.
const NAME_IDEAS = ['A-cam', 'B-cam', 'C-cam', 'Wide', 'Close-up', 'Overhead', 'Desk', 'Product', 'Pulpit', 'Stage', 'Choir', 'Crowd'];

function renameCam(cam, name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n || n === cam.name) return;
  cam.name = n;
  bus.emit('cams'); saveCurrent();
}

// click the name on a preview to rename it in place
function inlineRename(cam) {
  const chip = cam.tile && cam.tile.querySelector('.nm'); if (!chip || chip.querySelector('input')) return;
  const inp = h(`<input class="nmedit" value="${esc(cam.name)}" maxlength="40" spellcheck="false">`);
  chip.textContent = ''; chip.appendChild(inp); inp.select();
  let done = false;
  const finish = ok => { if (done) return; done = true; const v = inp.value; chip.textContent = cam.name; if (ok) renameCam(cam, v); paintTile(cam); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('pointerdown', e => e.stopPropagation());
}

const ideaChips = used => `<div class="chips" style="margin-top:8px">${NAME_IDEAS.filter(n => !used.has(n)).slice(0, 8).map(n => `<button class="chip" data-idea="${n}" style="height:26px">${n}</button>`).join('')}</div>`;

// ask for a name when adding a camera; resolves to the chosen name (or the suggestion if skipped)
function askCamName(suggested, label) {
  return new Promise(resolve => {
    let result = suggested, done = false;
    const used = new Set(cams.map(c => c.name));
    const d = openMenu('Name this camera', `
      <p class="note" style="padding:0 0 10px">${esc(shortName(label) || 'New camera')}. The name shows on the preview and goes into every file this camera records.</p>
      <input id="cnName" value="${esc(suggested)}" maxlength="40" spellcheck="false" style="width:100%;background:var(--fill);border:0;border-radius:9px;height:36px;padding:0 12px;font-size:15px">
      ${ideaChips(used)}
      <div class="note keep" id="cnPrev" style="padding:10px 2px 0;font-family:var(--mono)"></div>
      <div style="display:flex;gap:8px;margin-top:14px"><span style="flex:1"></span><button class="btn primary" id="cnOk">Add camera</button></div>`,
      (body, dlg) => {
        const inp = body.querySelector('#cnName'), prev = body.querySelector('#cnPrev');
        const upd = () => { result = inp.value.trim() || suggested; prev.textContent = `Files: ${fileBaseFor({ name: result, naming: null, fileName: '' })}.${EXT}`; };
        inp.oninput = upd; upd(); setTimeout(() => inp.select(), 60);
        body.querySelectorAll('[data-idea]').forEach(b => b.onclick = () => { inp.value = b.dataset.idea; upd(); inp.focus(); });
        const ok = () => { done = true; dlg.close(); resolve(result); };
        body.querySelector('#cnOk').onclick = ok;
        inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
      });
    d.addEventListener('close', () => { if (!done) resolve(result); }, { once: true });
  });
}

// rename every camera at once, with each one's file name shown live
function openNameCameras(afterSetup = false) {
  if (!cams.length) return toast('Add a camera first');
  const draw = (body, dlg) => {
    body.innerHTML = `
      <p class="note" style="padding:0 0 12px">${afterSetup ? 'Give each camera a name you’ll recognize. ' : ''}Names show on the previews and go into every file each camera records.</p>
      ${cams.map((c, i) => `<div class="group" style="padding:10px 12px;margin-bottom:10px" data-i="${i}">
        <div style="display:flex;align-items:center;gap:10px"><span class="dot ${c.status}" style="width:8px;height:8px;border-radius:50%;background:${c.alive ? 'var(--ok)' : 'var(--faint)'}"></span>
          <input class="cnIn" value="${esc(c.name)}" maxlength="40" spellcheck="false" style="flex:1;background:var(--fill);border:0;border-radius:8px;height:32px;padding:0 10px;font-size:14px;font-weight:600">
          <span class="note" style="padding:0;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(shortName(c.label) || (c.kind === 'phone' ? 'Phone' : ''))}</span></div>
        ${ideaChips(new Set(cams.map(x => x.name)))}
        <div class="note keep cnFile" style="padding:8px 2px 0;font-family:var(--mono)">${esc(fileBaseFor(c))}.${EXT}</div></div>`).join('')}
      <div style="display:flex;gap:8px"><button class="btn" id="cnPattern">File name style…</button><span style="flex:1"></span><button class="btn primary" id="cnDone">Done</button></div>`;
    body.querySelectorAll('[data-i]').forEach(row => {
      const cam = cams[+row.dataset.i], inp = row.querySelector('.cnIn'), file = row.querySelector('.cnFile');
      const upd = () => { const n = inp.value.trim(); if (n) { cam.name = n; paintTile(cam); } file.textContent = `${fileBaseFor(cam)}.${EXT}`; };
      inp.oninput = upd;
      inp.onchange = () => { renameCam(cam, inp.value); };
      row.querySelectorAll('[data-idea]').forEach(b => b.onclick = () => { inp.value = b.dataset.idea; upd(); renameCam(cam, b.dataset.idea); });
    });
    body.querySelector('#cnDone').onclick = () => { bus.emit('cams'); saveCurrent(); dlg.close(); };
    body.querySelector('#cnPattern').onclick = () => { dlg.close(); openNameBuilder({ title: 'File names for every camera', naming: defaultNaming(),
      onSave: nm => { project.naming = nm; project.filePattern = ''; saveProject(); openNameCameras(); } }); };
  };
  const d = openMenu('Name your cameras', '', (body, dlg) => draw(body, dlg));
  d.style.width = '520px';
  d.addEventListener('close', () => { d.style.width = ''; bus.emit('cams'); saveCurrent(); }, { once: true });
}
