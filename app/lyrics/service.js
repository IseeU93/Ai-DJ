// Songtext-Erkennung für Wortspiele: transkribiert nur die relevanten Stellen eines Tracks
// (Ende des alten, Gesangsanfang des neuen) und cacht die Wörter mit Zeitstempeln.
import { readFile } from '../lib/tauri.js';
import { cacheGet, cachePut } from '../lib/store.js';

const SR = 16000;
const MAX_SECONDS = 40;

export class LyricsService extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.language = 'german';
  }

  _worker() {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          this.dispatchEvent(new CustomEvent('progress', { detail: m }));
          return;
        }
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (!p) return;
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.words);
      };
    }
    return this.worker;
  }

  _run(audio) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._worker().postMessage({ id, audio, language: this.language }, [audio.buffer]);
    });
  }

  /** Wörter mit absoluten Zeiten (Sekunden im Track) im Bereich [from, to]. */
  getWords(track, from, to) {
    from = Math.max(0, from);
    to = Math.min(track.analysis.duration, Math.max(from + 2, Math.min(to, from + MAX_SECONDS)));
    const key = `lyrics|${this.language}|${track.path}|${track.size}|${track.modified}|${from.toFixed(1)}|${to.toFixed(1)}`;
    // nacheinander abarbeiten – Whisper im Browser ist rechenintensiv
    const job = this.queue.then(async () => {
      const cached = await cacheGet(key);
      if (cached) return cached;
      const bytes = await readFile(track.path);
      const ctx = new OfflineAudioContext(1, 1, SR);
      const buf = await ctx.decodeAudioData(bytes);
      const a = Math.floor(from * SR);
      const b = Math.min(buf.length, Math.floor(to * SR));
      const mono = new Float32Array(b - a);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = a; i < b; i++) mono[i - a] += d[i] / buf.numberOfChannels;
      }
      const words = (await this._run(mono)).map((w) => ({ ...w, start: w.start + from, end: w.end + from }));
      cachePut(key, words);
      return words;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
