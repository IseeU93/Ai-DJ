// Analysiert eine Dateiliste parallel (Web Worker), mit IndexedDB-Cache.
import { ANALYSIS_SR, ANALYSIS_VERSION } from './analyze.js';
import { readFile } from '../lib/tauri.js';
import { cacheGet, cachePut, gridOverride } from '../lib/store.js';
import { readMetadata, tidyMeta, fromFilename } from '../lib/metadata.js';

class WorkerPool {
  constructor(size) {
    this.workers = Array.from({ length: size }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
    this.idle = [...this.workers];
    this.waiting = [];
    this.seq = 0;
  }

  run(L, R, sr, override = null) {
    return new Promise((resolve, reject) => {
      const job = { L, R, sr, override, resolve, reject };
      const w = this.idle.pop();
      if (w) this._start(w, job);
      else this.waiting.push(job);
    });
  }

  _start(worker, job) {
    const id = ++this.seq;
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data.result);
      const next = this.waiting.shift();
      if (next) this._start(worker, next);
      else this.idle.push(worker);
    };
    worker.postMessage({ id, L: job.L, R: job.R, sr: job.sr, override: job.override }, [job.L.buffer, job.R.buffer]);
  }
}

const cacheKey = (f, ov) => `${f.path}|${f.size}|${f.modified}|v${ANALYSIS_VERSION}${ov ? `|${JSON.stringify(ov)}` : ''}`;

async function decodeForAnalysis(bytes) {
  const ctx = new OfflineAudioContext(2, 1, ANALYSIS_SR);
  const buf = await ctx.decodeAudioData(bytes);
  const L = new Float32Array(buf.length);
  buf.copyFromChannel(L, 0);
  const R = new Float32Array(buf.length);
  buf.copyFromChannel(R, buf.numberOfChannels > 1 ? 1 : 0);
  return { L, R };
}

export class AnalysisService {
  constructor() {
    const cores = navigator.hardwareConcurrency || 4;
    this.pool = new WorkerPool(Math.max(1, Math.min(3, cores - 1)));
    this.hintFor = null; // (file) => Zusatz-Hinweis für die Analyse, z.B. { bpmMin } bei Uptempo-Playlists
  }

  /**
   * @param files [{path, name, size, modified}]
   * @param onTrack (track) für jeden fertigen Track (auch aus dem Cache)
   * @param onProgress (done, total, file)
   */
  async analyzeAll(files, { onTrack, onProgress, onError } = {}) {
    const total = files.length;
    // 1) Schon analysierte Songs in einem Rutsch aus dem Speicher holen (parallel, ohne Rechnen) –
    //    sonst sieht das Laden wie ein kompletter Neu-Scan aus und dauert unnötig
    const queue = [];
    let done = 0;
    for (let i = 0; i < files.length; i += 48) {
      const chunk = files.slice(i, i + 48);
      const hits = await Promise.all(chunk.map((f) => this.fromCache(f).catch(() => null)));
      chunk.forEach((f, j) => {
        if (hits[j]) {
          onTrack?.(hits[j]);
          done++;
        } else queue.push(f);
      });
      onProgress?.(done, total, null, { cached: true, fresh: queue.length });
    }
    // 2) Nur neue oder geänderte Dateien wirklich analysieren
    const fresh = queue.length;
    let freshDone = 0;
    const decodeSlots = 2; // Dekodieren + Worker parallel, aber RAM im Rahmen halten
    const workerLoop = async () => {
      while (queue.length) {
        const file = queue.shift();
        try {
          const track = await this.analyzeOne(file);
          onTrack?.(track);
        } catch (err) {
          onError?.(file, err);
        }
        done++;
        freshDone++;
        onProgress?.(done, total, file, { cached: false, fresh, freshDone });
      }
    };
    await Promise.all(Array.from({ length: decodeSlots + 1 }, workerLoop));
  }

  /** Track aus dem Speicher (oder null, wenn die Datei neu/geändert ist). */
  async fromCache(file, override = gridOverride(file.path)) {
    const hint = this.hintFor?.(file);
    if (hint && !(override?.bpm > 0)) override = { ...hint, ...(override || {}) };
    const cached = await cacheGet(cacheKey(file, override));
    if (!cached) return null;
    const meta = tidyMeta(cached);
    // ältere Cache-Einträge ohne Merker: stimmt der Name mit dem Dateinamen überein, gab es keine Tags
    if (meta.tagged === undefined) {
      const f = tidyMeta(fromFilename(file.name));
      meta.tagged = !(f.title === meta.title && f.artist === meta.artist);
    }
    return { ...file, id: file.path, ...meta };
  }

  async analyzeOne(file, override = gridOverride(file.path)) {
    const hint = this.hintFor?.(file);
    if (hint && !(override?.bpm > 0)) override = { ...hint, ...(override || {}) };
    const key = cacheKey(file, override);
    const cached = await cacheGet(key);
    if (cached) {
      const meta = tidyMeta(cached);
      // ältere Cache-Einträge ohne Merker: stimmt der Name mit dem Dateinamen überein, gab es keine Tags
      if (meta.tagged === undefined) {
        const f = tidyMeta(fromFilename(file.name));
        meta.tagged = !(f.title === meta.title && f.artist === meta.artist);
      }
      return { ...file, id: file.path, ...meta };
    }

    const bytes = await readFile(file.path);
    const meta = readMetadata(bytes, file.name);
    const { L, R } = await decodeForAnalysis(bytes);
    const analysis = await this.pool.run(L, R, ANALYSIS_SR, override);
    const record = { ...meta, analysis };
    cachePut(key, record);
    return { ...file, id: file.path, ...record };
  }
}
