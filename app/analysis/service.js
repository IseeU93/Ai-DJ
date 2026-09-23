// Analysiert eine Dateiliste parallel (Web Worker), mit IndexedDB-Cache.
import { ANALYSIS_SR, ANALYSIS_VERSION } from './analyze.js';
import { readFile } from '../lib/tauri.js';
import { cacheGet, cachePut } from '../lib/store.js';
import { readMetadata } from '../lib/metadata.js';

class WorkerPool {
  constructor(size) {
    this.workers = Array.from({ length: size }, () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
    this.idle = [...this.workers];
    this.waiting = [];
    this.seq = 0;
  }

  run(L, R, sr) {
    return new Promise((resolve, reject) => {
      const job = { L, R, sr, resolve, reject };
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
    worker.postMessage({ id, L: job.L, R: job.R, sr: job.sr }, [job.L.buffer, job.R.buffer]);
  }
}

const cacheKey = (f) => `${f.path}|${f.size}|${f.modified}|v${ANALYSIS_VERSION}`;

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
  }

  /**
   * @param files [{path, name, size, modified}]
   * @param onTrack (track) für jeden fertigen Track (auch aus dem Cache)
   * @param onProgress (done, total, file)
   */
  async analyzeAll(files, { onTrack, onProgress, onError } = {}) {
    let done = 0;
    const total = files.length;
    const queue = [...files];
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
        onProgress?.(done, total, file);
      }
    };
    await Promise.all(Array.from({ length: decodeSlots + 1 }, workerLoop));
  }

  async analyzeOne(file) {
    const key = cacheKey(file);
    const cached = await cacheGet(key);
    if (cached) return { ...file, id: file.path, ...cached };

    const bytes = await readFile(file.path);
    const meta = readMetadata(bytes, file.name);
    const { L, R } = await decodeForAnalysis(bytes);
    const analysis = await this.pool.run(L, R, ANALYSIS_SR);
    const record = { ...meta, analysis };
    cachePut(key, record);
    return { ...file, id: file.path, ...record };
  }
}
