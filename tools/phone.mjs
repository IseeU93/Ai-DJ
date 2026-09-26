// Handy-App (AI-DJ Companion) aktualisieren – per USB-/WLAN-Debugging (adb):
//   node tools/phone.mjs assets    Mixer (app/) in die Handy-App kopieren (Selbst-Modus)
//   node tools/phone.mjs build     assets + App bauen + auf dem Handy installieren
//   node tools/phone.mjs tracks    Tracks abgleichen: fehlende aufs Handy, nur-Handy-Tracks auf den PC
//   node tools/phone.mjs update    build + tracks (alles auf einmal)
// Pfade in tools/phone.local.json (nicht im Git):
//   { "android": "C:/Users/…/AIDJCompanion", "music": "C:/Users/…/Music/Privat/DJ" }
// Gelöscht wird nie etwas – nur fehlende Dateien werden kopiert.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const cfgFile = join(here, 'phone.local.json');
const cfg = existsSync(cfgFile) ? JSON.parse(await readFile(cfgFile, 'utf8')) : {};
const ANDROID = cfg.android || process.env.AUTOMIX_ANDROID;
const MUSIC = cfg.music || process.env.AUTOMIX_MUSIC;
const PHONE_ROOT = '/storage/emulated/0/Music/Automix';
const AUDIO = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i;
const ADB = [process.env.ADB, join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb.exe'), 'adb'].find((p) => p && (p === 'adb' || existsSync(p)));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`);
  return r.stdout || '';
}
const adb = (...args) => run(ADB, args, { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

async function assets() {
  if (!ANDROID) throw new Error('Pfad zur Android-App fehlt (tools/phone.local.json: "android")');
  const out = join(ANDROID, 'app/src/main/assets/web');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  // app/vendor (Reste eines Experiments, vom Mixer nicht genutzt) nicht mitnehmen
  const skip = join(repo, 'app', 'vendor');
  await cp(join(repo, 'app'), out, { recursive: true, filter: (src) => !src.startsWith(skip) });
  await cp(join(here, 'phone/phone-shim.js'), join(out, 'phone-shim.js'));
  const index = join(out, 'index.html');
  const html = await readFile(index, 'utf8');
  await writeFile(index, html.replace('<head>', '<head>\n  <script src="phone-shim.js"></script>'));
  console.log(`Mixer -> ${out}`);
}

function build() {
  const jbr = 'C:/Program Files/Android/Android Studio/jbr';
  const env = { ...process.env, ...(existsSync(jbr) ? { JAVA_HOME: jbr } : {}) };
  run(join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), ['assembleDebug', '-q'], { cwd: ANDROID, env, shell: process.platform === 'win32', stdio: 'inherit' });
  const apk = join(ANDROID, 'app/build/outputs/apk/debug/app-debug.apk');
  console.log(adb('install', '-r', apk).trim().split('\n').pop());
}

async function localFiles(dir, base = dir, out = new Map(), depth = 0) {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const st = await stat(p);
    if (st.isDirectory()) {
      if (depth < 4) await localFiles(p, base, out, depth + 1);
    } else if (AUDIO.test(name)) out.set(p.slice(base.length + 1).split(/[\\/]/).join('/'), st.size);
  }
  return out;
}

function phoneFiles() {
  adb('shell', 'mkdir', '-p', PHONE_ROOT);
  const text = adb('shell', `find '${PHONE_ROOT}' -type f -exec stat -c '%s|%n' {} +`);
  const out = new Map();
  for (const line of text.split('\n')) {
    const i = line.indexOf('|');
    if (i < 0) continue;
    const p = line.slice(i + 1).trim();
    if (AUDIO.test(p) && p.startsWith(`${PHONE_ROOT}/`)) out.set(p.slice(PHONE_ROOT.length + 1), +line.slice(0, i));
  }
  return out;
}

async function tracks() {
  if (!MUSIC) throw new Error('Musik-Ordner fehlt (tools/phone.local.json: "music")');
  const pc = await localFiles(MUSIC);
  const phone = phoneFiles();
  const toPhone = [...pc.keys()].filter((p) => !phone.has(p));
  const toPc = [...phone.keys()].filter((p) => !pc.has(p));
  const mb = (list, sizes) => (list.reduce((s, p) => s + sizes.get(p), 0) / 1e6).toFixed(0);
  console.log(`PC ${pc.size} · Handy ${phone.size} · aufs Handy: ${toPhone.length} (${mb(toPhone, pc)} MB) · zum PC: ${toPc.length} (${mb(toPc, phone)} MB)`);
  let i = 0;
  for (const rel of toPhone) {
    process.stdout.write(`\r  ↓ ${++i}/${toPhone.length} ${rel.slice(0, 60).padEnd(60)}`);
    adb('push', join(MUSIC, ...rel.split('/')), `${PHONE_ROOT}/${rel}`);
  }
  if (toPhone.length) process.stdout.write('\n');
  i = 0;
  for (const rel of toPc) {
    process.stdout.write(`\r  ↑ ${++i}/${toPc.length} ${rel.slice(0, 60).padEnd(60)}`);
    const target = join(MUSIC, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    adb('pull', `${PHONE_ROOT}/${rel}`, target);
  }
  if (toPc.length) process.stdout.write('\n');
  console.log('Tracks abgeglichen.');
}

const task = process.argv[2] || 'update';
if (task === 'assets') await assets();
else if (task === 'build') {
  await assets();
  build();
} else if (task === 'tracks') await tracks();
else if (task === 'update') {
  await assets();
  build();
  await tracks();
} else console.log('Aufruf: node tools/phone.mjs assets|build|tracks|update');
