// Teleprompter: a separate window you can put on any screen near the lens.
let promptWin = null;
function openPrompter() {
  if (promptWin && !promptWin.closed) { promptWin.focus(); return; }
  promptWin = window.open('', 'mcr-prompter', 'width=980,height=640');
  if (!promptWin) return toast('Allow pop-ups for this page to open the teleprompter', 'err');
  const text = store.get('prompter', 'Paste your script here.\n\nPress Space to start and stop scrolling. Use the arrow keys to change speed, and + or − to change the text size.\n\nTurn on “Start with recording” and it scrolls the moment you hit Record.');
  const cfg = { speed: 40, size: 56, mirror: false, auto: true, ...store.get('prompterCfg', {}) };
  promptWin.document.open();
  promptWin.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Teleprompter</title><style>
    *{box-sizing:border-box}html,body{margin:0;height:100%;background:#000;color:#fff;font-family:-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;overflow:hidden}
    #bar{position:fixed;top:0;left:0;right:0;display:flex;gap:14px;align-items:center;padding:10px 16px;background:rgba(28,28,30,.85);backdrop-filter:blur(20px);z-index:2;font-size:13px;transition:opacity .3s}
    body.playing #bar{opacity:0}body.playing #bar:hover{opacity:1}
    button{font:inherit;color:#fff;background:rgba(255,255,255,.14);border:0;border-radius:8px;height:30px;padding:0 14px}
    button.on{background:#0a84ff}label{display:flex;align-items:center;gap:6px;color:#aeaeb2}input[type=range]{width:110px;accent-color:#0a84ff}
    #view{position:absolute;inset:0;overflow:hidden}#text{padding:45vh 9vw 80vh;white-space:pre-wrap;line-height:1.45;font-weight:600;outline:none}
    body.mirror #text{transform:scaleX(-1)}#guide{position:fixed;left:0;right:0;top:40vh;height:0;border-top:2px solid rgba(10,132,255,.6);pointer-events:none}
  </style></head><body><div id="bar"><button id="play">Play</button><label>Speed <input id="speed" type="range" min="5" max="150"></label>
  <label>Size <input id="size" type="range" min="24" max="120"></label><button id="mirror">Mirror</button><button id="auto">Start with recording</button>
  <button id="top">Back to top</button><span style="margin-left:auto;color:#8e8e93">Click the text to edit</span></div>
  <div id="view"><div id="text" contenteditable="true" spellcheck="false"></div></div><div id="guide"></div></body></html>`);
  promptWin.document.close();
  const d = promptWin.document, w = promptWin, view = d.getElementById('view'), t = d.getElementById('text');
  t.textContent = text;
  let playing = false, last = 0, pos = 0;
  const apply = () => {
    t.style.fontSize = cfg.size + 'px'; d.body.classList.toggle('mirror', cfg.mirror);
    d.getElementById('mirror').classList.toggle('on', cfg.mirror); d.getElementById('auto').classList.toggle('on', cfg.auto);
    d.getElementById('speed').value = cfg.speed; d.getElementById('size').value = cfg.size;
    store.set('prompterCfg', cfg);
  };
  const setPlay = p => { playing = p; d.body.classList.toggle('playing', p); d.getElementById('play').textContent = p ? 'Pause' : 'Play'; d.getElementById('play').classList.toggle('on', p); last = 0; pos = view.scrollTop; if (p) w.requestAnimationFrame(tick); };
  const tick = ts => { if (!playing) return; if (last) { pos += cfg.speed * (ts - last) / 1000; view.scrollTop = pos; } last = ts; w.requestAnimationFrame(tick); };
  apply();
  d.getElementById('play').onclick = () => setPlay(!playing);
  d.getElementById('speed').oninput = e => { cfg.speed = +e.target.value; apply(); };
  d.getElementById('size').oninput = e => { cfg.size = +e.target.value; apply(); };
  d.getElementById('mirror').onclick = () => { cfg.mirror = !cfg.mirror; apply(); };
  d.getElementById('auto').onclick = () => { cfg.auto = !cfg.auto; apply(); };
  d.getElementById('top').onclick = () => { view.scrollTop = 0; pos = 0; };
  t.addEventListener('input', () => store.set('prompter', t.innerText));
  t.addEventListener('focus', () => setPlay(false));
  view.addEventListener('wheel', () => { pos = view.scrollTop; }, { passive: true });
  d.addEventListener('keydown', e => {
    if (d.activeElement === t) { if (e.key === 'Escape') t.blur(); return; }
    if (e.code === 'Space') { e.preventDefault(); setPlay(!playing); }
    if (e.key === 'ArrowUp') { cfg.speed = Math.min(150, cfg.speed + 5); apply(); }
    if (e.key === 'ArrowDown') { cfg.speed = Math.max(5, cfg.speed - 5); apply(); }
    if (e.key === '+' || e.key === '=') { cfg.size = Math.min(120, cfg.size + 4); apply(); }
    if (e.key === '-') { cfg.size = Math.max(24, cfg.size - 4); apply(); }
  });
  w.addEventListener('message', e => { if (e.data === 'mcr-play' && cfg.auto && !playing) setPlay(true); });
}
