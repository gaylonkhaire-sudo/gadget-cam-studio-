// LUT library: parse .cube files and keep them in IndexedDB.
const luts = new Map();   // name -> { name, size, data: Float32Array, dmin, dmax }

function parseCube(text, fileName) {
  let size = 0, dmin = [0, 0, 0], dmax = [1, 1, 1], title = '';
  const vals = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/), k = p[0].toUpperCase();
    if (k === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (k === 'LUT_3D_SIZE') size = parseInt(p[1]);
    else if (k === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported. Use a 3D .cube LUT.');
    else if (k === 'DOMAIN_MIN') dmin = p.slice(1, 4).map(Number);
    else if (k === 'DOMAIN_MAX') dmax = p.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(p[0]) && p.length >= 3) vals.push(+p[0], +p[1], +p[2]);
  }
  if (!size) throw new Error('No LUT_3D_SIZE found');
  if (vals.length !== size ** 3 * 3) throw new Error(`Expected ${size ** 3} entries, found ${vals.length / 3}`);
  return { name: fileName.replace(/\.cube$/i, '') || title || 'LUT', size, data: new Float32Array(vals), dmin, dmax };
}

async function loadLuts() {
  const all = await idbAll('luts') || [];
  all.forEach(l => luts.set(l.name, l));
  bus.emit('luts');
}
async function importLuts(files) {
  let last = null;
  for (const f of files) {
    if (!/\.cube$/i.test(f.name)) { toast(`${f.name}: only .cube LUTs are supported`, 'err'); continue; }
    try {
      const l = parseCube(await f.text(), f.name);
      luts.set(l.name, l); await idbPut('luts', l.name, l);
      log(`Imported LUT ${l.name} (${l.size}³)`); last = l.name;
    } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
  }
  bus.emit('luts');
  return last;
}
async function deleteLut(name) { luts.delete(name); await idbDel('luts', name); bus.emit('luts'); }
