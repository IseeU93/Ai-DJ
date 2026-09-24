// Übernimmt die Lasershow (Renderer, Effekte, Choreograph, Audio-Analyse, Beamer-Player) aus dem
// Beamer-Lasershow-Projekt nach app/laser/. Die Kopie ist eingecheckt, damit der Mixer auch ohne
// das andere Projekt läuft. Aufruf nach Änderungen an der Lasershow: npm run sync:laser
// Pfad zum Projekt: LASERSHOW_DIR=... (Standard: ../beamer-lasershow/beamer-lasershow)
import { cp, rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(process.env.LASERSHOW_DIR || resolve(root, '../beamer-lasershow/beamer-lasershow'));
const out = resolve(root, 'app/laser');

try {
  await access(resolve(src, 'src/visuals/LaserRenderer.js'));
} catch {
  console.error(`sync-laser: Lasershow nicht gefunden unter ${src} (LASERSHOW_DIR setzen)`);
  process.exit(1);
}

const DIRS = ['audio', 'visuals', 'show', 'shared', 'player'];
await rm(resolve(out, 'src'), { recursive: true, force: true });
await mkdir(resolve(out, 'src/style'), { recursive: true });
for (const d of DIRS) await cp(resolve(src, 'src', d), resolve(out, 'src', d), { recursive: true });
await cp(resolve(src, 'src/style/player.css'), resolve(out, 'src/style/player.css'));
// Player-Seite: Google-Fonts-Import raus (CSP/offline), Rest unverändert
const css = await readFile(resolve(out, 'src/style/player.css'), 'utf8');
await writeFile(resolve(out, 'src/style/player.css'), css.replace(/^@import url\([^)]*\);\s*$/m, ''));
await cp(resolve(src, 'player.html'), resolve(out, 'player.html'));
const version = (await readFile(resolve(src, 'VERSION'), 'utf8').catch(() => '?')).trim();
await writeFile(resolve(out, 'VERSION'), `${version}\n`);
console.log(`sync-laser: Lasershow ${version} nach app/laser kopiert`);
