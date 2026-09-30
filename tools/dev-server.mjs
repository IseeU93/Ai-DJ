// Browser-Testumgebung ohne Tauri: liefert app/ aus und simuliert die Rust-Commands
// (Ordner scannen/lesen) für einen lokalen Musikordner – und den Companion-Server für die
// Handy-App (Port 7779, PIN 1234 – 7777 bleibt für die echte App frei), damit sich die App auch gegen den Browser testen lässt.
//   node tools/dev-server.mjs <musikordner> [port]
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(new URL('../app', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const music = resolve(process.argv[2] || '.');
const port = +(process.argv[3] || 5174);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);

const SHIM = `<script>
window.__TAURI__ = { core: { invoke: async (cmd, args) => {
  if (cmd === 'pick_folder') return ${JSON.stringify(music)};
  if (cmd === 'scan_folder') return (await fetch('/__scan')).json();
  if (cmd === 'read_file') return (await fetch('/__file?p=' + encodeURIComponent(args.path))).arrayBuffer();
  if (cmd === 'companion_push') return fetch('/__companion/push', { method: 'POST', body: args.state });
  if (cmd === 'companion_event') return fetch('/__companion/event', { method: 'POST', body: args.event });
  if (cmd === 'companion_info') return (await fetch('/__companion/info')).json();
  if (cmd === 'web_get') { const r = await fetch('/__web?u=' + encodeURIComponent(args.url)); if (!r.ok) throw new Error(await r.text()); return r.text(); }
  throw new Error('unbekannt: ' + cmd);
} }, event: { listen: async (name, cb) => {
  if (name !== 'companion-cmd') return () => {};
  (async function poll() {
    for (;;) {
      try {
        const r = await fetch('/__companion/cmds');
        for (const c of await r.json()) cb({ payload: c });
      } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
  })();
  return () => {};
} } };
</script>`;

// ---- Companion-Emulation (gleiche API wie src-tauri/src/companion.rs)
const PIN = '1234';
const comp = { seq: 0, state: 'null', events: [], waiters: [], cmds: [], cmdWaiters: [], lastSeen: 0 };
const wake = () => { for (const w of comp.waiters.splice(0)) w(); };
const readBody = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d)); });
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/hello') return json(res, 200, { app: 'AI-DJ', host: 'Dev-Server', needsPin: true });
  if ((req.headers['x-pin'] || url.searchParams.get('pin')) !== PIN) return json(res, 401, { error: 'PIN falsch' });
  comp.lastSeen = Date.now();
  if (url.pathname === '/api/state') {
    const since = +(url.searchParams.get('since') || 0);
    const wait = Math.min(30, +(url.searchParams.get('wait') || 0));
    if (comp.seq <= since && wait > 0) await new Promise((ok) => { comp.waiters.push(ok); setTimeout(ok, wait * 1000); });
    const ev = comp.events.filter((e) => e.seq > since).map((e) => e.data);
    return json(res, 200, `{"seq":${comp.seq},"state":${comp.state},"events":[${ev.join(',')}]}`);
  }
  if (url.pathname === '/api/cmd' && req.method === 'POST') {
    const b = await readBody(req);
    comp.cmds.push(b);
    for (const w of comp.cmdWaiters.splice(0)) w();
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'unbekannt' });
}).listen(7779, () => console.log('Companion-Emulation: Port 7779, PIN 1234'));


createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__scan') {
      const files = [];
      const walk = async (dir, depth) => {
        for (const name of (await readdir(dir)).sort()) {
          const p = join(dir, name);
          const s = await stat(p);
          if (s.isDirectory()) {
            if (depth < 4) await walk(p, depth + 1);
            continue;
          }
          if (!AUDIO.has(extname(name).toLowerCase())) continue;
          files.push({ path: p, name, size: s.size, modified: Math.floor(s.mtimeMs / 1000) });
        }
      };
      await walk(music, 0);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(files));
    }
    if (url.pathname === '/__companion/push') {
      const st = await readBody(req);
      if (st !== comp.state) { comp.seq++; comp.state = st; wake(); }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__companion/event') {
      comp.seq++;
      comp.events.push({ seq: comp.seq, data: await readBody(req) });
      comp.events = comp.events.slice(-50);
      wake();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__companion/info') {
      return json(res, 200, { ip: 'localhost', port: 7779, pin: PIN, connected: Date.now() - comp.lastSeen < 40000 });
    }
    if (url.pathname === '/__companion/cmds') {
      if (!comp.cmds.length) await new Promise((ok) => { comp.cmdWaiters.push(ok); setTimeout(ok, 25000); });
      return json(res, 200, comp.cmds.splice(0));
    }
    if (url.pathname === '/__web') {
      // wie web_get in main.rs: nur die Musik-Datenbanken
      const u = url.searchParams.get('u');
      if (!['https://itunes.apple.com/', 'https://musicbrainz.org/ws/2/'].some((h) => u.startsWith(h))) return json(res, 403, 'Adresse nicht erlaubt');
      const r = await fetch(u, { headers: { 'user-agent': 'Automix/0.2 ( https://github.com/IseeU93/Ai-DJ )' } });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      return res.end(await r.text());
    }
    if (url.pathname === '/__file') {
      const data = await readFile(url.searchParams.get('p')); // erst lesen: fehlt die Datei, sauber 404
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(data);
    }
    const path = join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    let body = await readFile(path);
    if (path.endsWith('index.html')) body = body.toString().replace('<head>', `<head>${SHIM}`);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (err) {
    res.writeHead(404);
    res.end(String(err));
  }
}).listen(port, () => console.log(`Dev-Server: http://localhost:${port}  (Musik: ${music})`));
