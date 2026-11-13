#!/usr/bin/env python3
"""Bundle src/ into one self-contained HTML file (browser) and copy it into the Electron app."""
import pathlib, shutil
root = pathlib.Path(__file__).parent
src = root / 'src'
html = (src / 'index.html').read_text()
css = (src / 'style.css').read_text()
js = '\n'.join(f'// ---- {p.name} ----\n' + p.read_text() for p in sorted((src / 'js').glob('*.js')))
out = html.replace('/*__CSS__*/', css).replace('/*__JS__*/', '(() => {\n"use strict";\n' + js + '\n})();')
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist' / 'Gadget Cam Studio.html').write_text(out)
app = root / 'electron' / 'app'
app.mkdir(parents=True, exist_ok=True)
(app / 'index.html').write_text(out)
print(f'built {len(out)//1024} KB')
