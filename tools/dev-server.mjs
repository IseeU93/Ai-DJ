// Browser-Testumgebung ohne Tauri: liefert app/ aus und simuliert die Rust-Commands
// (Ordner scannen/lesen) für einen lokalen Musikordner.
//   node tools/dev-server.mjs <musikordner> [port]
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(new URL('../app', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const music = resolve(process.argv[2] || '.');
const port = +(process.argv[3] || 5174);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const AUDIO = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);

const SHIM = `<script>
window.__TAURI__ = { core: { invoke: async (cmd, args) => {
  if (cmd === 'pick_folder') return ${JSON.stringify(music)};
  if (cmd === 'scan_folder') return (await fetch('/__scan')).json();
  if (cmd === 'read_file') return (await fetch('/__file?p=' + encodeURIComponent(args.path))).arrayBuffer();
  throw new Error('unbekannt: ' + cmd);
} } };
</script>`;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__scan') {
      const files = [];
      for (const name of (await readdir(music)).sort()) {
        if (!AUDIO.has(extname(name).toLowerCase())) continue;
        const p = join(music, name);
        const s = await stat(p);
        files.push({ path: p, name, size: s.size, modified: Math.floor(s.mtimeMs / 1000) });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(files));
    }
    if (url.pathname === '/__file') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(await readFile(url.searchParams.get('p')));
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
