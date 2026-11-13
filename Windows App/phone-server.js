// Phone camera server: serves the phone page over HTTPS on the local network and relays WebRTC signaling
// between phones and the app (Server-Sent Events down, POST up). Video itself goes phone → app directly over Wi-Fi.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let server = null, info = null;
const clients = new Set();          // { role: 'app' | 'phone', id, res }

function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      const virt = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|vpn/i.test(name);
      const wifi = /wi-?fi|wlan|wireless/i.test(name);
      out.push({ address: a.address, name, score: (virt ? -10 : 0) + (wifi ? 2 : 0) + (a.address.startsWith('192.168.') ? 1 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }

function makeCert(dir, ips) {
  const file = path.join(dir, 'phone-cert.json');
  const saved = readJSON(file, null);
  if (saved && saved.ips && ips.every(ip => saved.ips.includes(ip))) return saved;
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Gadget Cam Studio' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...['127.0.0.1', ...ips].map(ip => ({ type: 7, ip }))] }],
  });
  const cert = { key: pems.private, cert: pems.cert, ips: ['127.0.0.1', ...ips] };
  try { fs.writeFileSync(file, JSON.stringify(cert)); } catch {}
  return cert;
}

function send(res, obj) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} }
function broadcast(filter, obj) { for (const c of clients) if (filter(c)) send(c.res, obj); }

function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const k = u.searchParams.get('k');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (k !== info.token) { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('<h2 style="font-family:system-ui">This link has expired. Scan the QR code in Gadget Cam Studio again.</h2>'); }

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/phone')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'phone.html')));
  }
  if (req.method === 'GET' && u.pathname === '/events') {
    const c = { role: u.searchParams.get('role') === 'app' ? 'app' : 'phone', id: u.searchParams.get('id') || crypto.randomUUID(), res };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(c);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => {
      clearInterval(ping); clients.delete(c);
      if (c.role === 'phone' && ![...clients].some(x => x.role === 'phone' && x.id === c.id)) broadcast(x => x.role === 'app', { type: 'bye', from: c.id });
    });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/signal') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        if (msg.to === 'app') broadcast(c => c.role === 'app', msg);
        else if (msg.to === 'phones') broadcast(c => c.role === 'phone', msg);
        else broadcast(c => c.role === 'phone' && c.id === msg.to, msg);
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }
  res.writeHead(404); res.end();
}

async function start({ dataDir, insecure = false, port = 47821, host = '0.0.0.0' }) {
  if (server) return info;
  const ips = lanIPs().map(i => i.address);
  const tokFile = path.join(dataDir, 'phone-token.json');
  const token = readJSON(tokFile, {}).token || crypto.randomBytes(9).toString('base64url');
  try { fs.writeFileSync(tokFile, JSON.stringify({ token })); } catch {}
  const scheme = insecure ? 'http' : 'https';
  server = insecure ? http.createServer(handler) : https.createServer(makeCert(dataDir, ips), handler);
  await new Promise((res, rej) => {
    server.once('error', e => { if (e.code === 'EADDRINUSE') { server.listen(0, host, res); } else rej(e); });
    server.listen(port, host, res);
  });
  const p = server.address().port;
  const lan = ips[0] || '127.0.0.1';
  info = { token, port: p, ips, scheme,
    phoneUrl: `${scheme}://${lan}:${p}/?k=${token}`,
    appUrl: `${scheme}://127.0.0.1:${p}`,
    altUrls: ips.slice(1).map(ip => `${scheme}://${ip}:${p}/?k=${token}`) };
  return info;
}
function resetToken(dataDir) {
  const token = crypto.randomBytes(9).toString('base64url');
  try { fs.writeFileSync(path.join(dataDir, 'phone-token.json'), JSON.stringify({ token })); } catch {}
  if (info) {
    info.token = token;
    const lan = info.ips[0] || '127.0.0.1';
    info.phoneUrl = `${info.scheme}://${lan}:${info.port}/?k=${token}`;
    info.altUrls = info.ips.slice(1).map(ip => `${info.scheme}://${ip}:${info.port}/?k=${token}`);
  }
  return info;
}

module.exports = { start, resetToken, lanIPs, get info() { return info; } };

// For local testing without Electron: node phone-server.js --insecure
if (require.main === module) {
  start({ dataDir: os.tmpdir(), insecure: process.argv.includes('--insecure'), host: '127.0.0.1' })
    .then(i => console.log(JSON.stringify(i)));
}
