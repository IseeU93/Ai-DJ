// Kopiert Transformers.js + ONNX-Runtime (WASM) nach app/vendor, damit die App sie lokal lädt
// (kein CDN, funktioniert offline). Läuft automatisch vor dev/build.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'app/vendor');
await mkdir(out, { recursive: true });

const files = [['node_modules/@huggingface/transformers/dist/transformers.min.js', 'transformers.min.js']];
// alle WASM-Varianten der ONNX-Runtime (je nach Browser-Fähigkeiten wird eine davon geladen)
for (const v of ['', '.jsep', '.asyncify', '.jspi']) {
  for (const ext of ['mjs', 'wasm']) {
    const name = `ort-wasm-simd-threaded${v}.${ext}`;
    files.push([`node_modules/onnxruntime-web/dist/${name}`, name]);
  }
}
for (const [from, to] of files) await copyFile(resolve(root, from), resolve(out, to));
console.log('vendor: Transformers.js + ONNX-Runtime nach app/vendor kopiert');
