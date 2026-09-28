// Gesang-Scan: Whisper (Songtext-Erkennung, lokal) liefert für jeden Song die genauen Zeiten jeder
// gesungenen Zeile. Daraus wird der Gesang pro Takt und pro Schlag – viel genauer als die
// Signal-Analyse. Der Planer sieht dann, wo eine Zeile vor der Eins endet (Atempause) und wo eine
// neue beginnt, und mixt nie mitten hinein. Läuft im Hintergrund für die nächsten Songs der Queue
// (oder vorab fürs ganze Set) und wird dauerhaft gecacht.
import { readFile } from '../lib/tauri.js';
import { cacheGet, cachePut } from '../lib/store.js';
import { beatToSeconds, secondsToBar } from '../mix/planner.js';

const SR = 16000;
const VERSION = 1;

/**
 * Whisper-Halluzinationen entfernen: Wörter ohne Dauer und Endlosschleifen (Whisper "erfindet" in
 * Instrumentalteilen gern denselben Satz zwanzigmal). Echte Refrains wiederholen sich 2–4×.
 */
export function cleanWords(words) {
  const w = words.filter((x) => Number.isFinite(x.t) && Number.isFinite(x.e) && x.e - x.t >= 0.05 && x.e - x.t <= 3
    && !/thank(s)? (you )?for watching|untertitel|subtitles/i.test(x.w));
  const norm = w.map((x) => x.w.toLowerCase().replace(/[^a-zäöüß']/g, ''));
  const bad = new Uint8Array(w.length);
  for (let k = 3; k <= 10; k++) {
    for (let i = 0; i + 3 * k <= w.length; i++) {
      let rep = 0;
      for (let r = 1; r * k + i + k <= w.length; r++) {
        let same = true;
        for (let q = 0; q < k; q++) {
          if (norm[i + q] !== norm[i + r * k + q]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        rep = r;
      }
      if (rep < 2) continue;
      const durs = w.slice(i, i + (rep + 1) * k).map((x) => x.e - x.t).sort((p, q) => p - q);
      const medDur = durs[Math.floor(durs.length / 2)];
      if (rep >= 4 || medDur < 0.15) for (let q = i; q < i + (rep + 1) * k; q++) bad[q] = 1;
    }
  }
  return w.filter((_, i) => !bad[i]);
}

/** Songtext-Sprache raten (Deutsch/Englisch) – aus Online-Stil, Tags und Titel. */
export function guessLanguage(t) {
  const tags = [t.style, t.webInfo?.itunes, ...(t.webInfo?.tags || []).map((x) => x.name)].filter(Boolean).join(' ').toLowerCase();
  if (/schlager|german|deutsch|volksmusik|neue deutsche welle|ndw|krautrock|austropop/.test(tags)) return 'german';
  const name = ` ${t.title || ''} ${t.artist || ''} `.toLowerCase();
  if (/[äöüß]/.test(name) || /\s(die|der|das|und|ich|nicht|mit|wir|ein|eine|dich|mich|auf|für|nur|noch)\s/.test(name)) return 'german';
  return 'english';
}

/** Anteil jedes Abschnitts [edges[i], edges[i+1]), der von Wörtern bedeckt ist. */
function coverage(edges, words) {
  const n = edges.length - 1;
  const cov = new Float32Array(Math.max(0, n));
  let i0 = 0;
  for (const x of words) {
    // kurze Lücken zwischen Wörtern einer Zeile gehören zur Zeile
    const t = x.t - 0.05;
    const e = x.e + 0.1;
    while (i0 < n && edges[i0 + 1] <= t) i0++;
    for (let i = i0; i < n && edges[i] < e; i++) {
      cov[i] += Math.max(0, Math.min(edges[i + 1], e) - Math.max(edges[i], t)) / (edges[i + 1] - edges[i]);
    }
  }
  for (let i = 0; i < n; i++) cov[i] = Math.min(1, cov[i]);
  return cov;
}

/**
 * Neue Analyse mit Gesang aus dem Songtext: pro Takt (vocals) und pro Schlag (vocalBeats).
 * Die Signal-Erkennung bleibt als schwacher Anteil drin (Chöre, "Oh-oh", die Whisper nicht als
 * Wörter erkennt). Gibt ein neues Objekt zurück (Caches erkennen die Änderung).
 */
export function withLyricVocals(a, words) {
  const dsp = a.vocalsDsp || a.vocals;
  const clean = cleanWords(words);
  const nb = dsp.length;
  const barEdges = Array.from({ length: nb + 1 }, (_, b) => beatToSeconds(a, (a.downbeat || 0) + 4 * b));
  const barCov = coverage(barEdges, clean);
  const vocals = Float32Array.from(dsp, (d, b) => Math.max(Math.min(1, 1.6 * barCov[b]), 0.5 * d));
  const nBeats = (a.downbeat || 0) + 4 * nb;
  const beatEdges = Array.from({ length: nBeats + 1 }, (_, k) => beatToSeconds(a, k));
  const vocalBeats = Float32Array.from(coverage(beatEdges, clean), (c) => Math.min(1, 1.5 * c));
  // Gesangsgrenzen wie in der Analyse (mind. 2 Takte am Stück)
  let vocalFirst = null;
  let vocalLast = null;
  const vs = (i) => ((vocals[i - 1] ?? 0) + 2 * vocals[i] + (vocals[i + 1] ?? 0)) / 4;
  for (let i = 0; i < nb - 1; i++) {
    if (vs(i) >= 0.45 && vs(i + 1) >= 0.45) {
      if (vocalFirst === null) vocalFirst = i;
      vocalLast = i + 1;
    }
  }
  const avg = (b0, len) => {
    let s = 0;
    for (let b = b0; b < b0 + len && b < nb; b++) s += vocals[b];
    return s / Math.max(1, Math.min(len, nb - b0));
  };
  return {
    ...a,
    vocalsDsp: dsp,
    vocals,
    vocalBeats,
    vocalSource: 'lyrics',
    phrases: a.phrases.map((ph) => ({ ...ph, vocal: +avg(ph.bar, ph.bars).toFixed(3) })),
    points: { ...a.points, vocalFirst, vocalLast },
    lyricWords: clean.length,
  };
}

/**
 * Warteschlange für den Scan: mehrere Worker parallel (je nach Rechner 1–3, jeder mit einem CPU-Kern
 * bzw. der erste auf der Grafikkarte), immer in Wiedergabe-Reihenfolge. Ergebnisse bleiben dauerhaft
 * gespeichert – kein Song wird zweimal gescannt.
 */
export class VocalScan extends EventTarget {
  constructor() {
    super();
    this.enabled = true;
    const cores = globalThis.navigator?.hardwareConcurrency || 4;
    this.size = Math.max(1, Math.min(3, Math.floor(cores / 4))); // 16 Threads -> 3, 8 -> 2, 4 -> 1
    this.workers = [];
    this.seq = 0;
    this.pending = new Map();
    this.wanted = []; // Tracks in Wunsch-Reihenfolge
    this.running = new Map(); // Track-ID -> Track (wird gerade gescannt)
    this.failed = new Set();
    this.device = null;
    this.model = null; // Lade-Fortschritt des Modells
    this.shouldWait = () => false; // z. B. während ein Übergang läuft: Rechenzeit für die Wiedergabe
  }

  /**
   * Speicher-Schlüssel: Dateiname + Größe. Überlebt verschobene Ordner und angefasste Änderungsdaten
   * (Sync-Tools, Kopieren) – neu gescannt wird nur eine neue oder wirklich geänderte Datei.
   */
  static key(t) {
    const name = String(t.path || t.id).split(/[\\/]/).pop();
    return `vscan|v${VERSION}|${name}|${t.size ?? ''}`;
  }

  /** früherer Schlüssel (mit Pfad und Änderungsdatum) – alte Ergebnisse werden übernommen */
  static oldKey(t) {
    return `vscan|v${VERSION}|${t.path || t.id}|${t.size ?? ''}|${t.modified ?? ''}`;
  }

  /** Gespeicherte Wörter eines Songs (oder undefined). */
  static async stored(t) {
    const words = await cacheGet(VocalScan.key(t));
    if (words) return words;
    const old = await cacheGet(VocalScan.oldKey(t));
    if (old) cachePut(VocalScan.key(t), old);
    return old;
  }

  /** Ein gerade gescannter Song (für die Anzeige). */
  get busy() {
    return this.running.values().next().value || null;
  }

  _worker(i) {
    if (!this.workers[i]) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          this.model = m;
          this.emit('status');
          return;
        }
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (!p) return;
        if (i === 0 || !this.device) this.device = m.device || this.device;
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.words);
      };
      w.onerror = (e) => {
        for (const [id, p] of this.pending) {
          if (p.worker !== i) continue;
          p.reject(new Error(e.message || 'Worker-Fehler'));
          this.pending.delete(id);
        }
      };
      this.workers[i] = w;
    }
    return this.workers[i];
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Schon gescannte Songs sofort übernehmen (aus dem Cache), ohne zu rechnen. */
  async attach(tracks) {
    const todo = tracks.filter((t) => t?.analysis && t.analysis.vocalSource !== 'lyrics');
    const found = await Promise.all(todo.map((t) => VocalScan.stored(t)));
    const done = [];
    todo.forEach((t, i) => {
      if (!found[i] || t.analysis.vocalSource === 'lyrics') return;
      t.analysis = withLyricVocals(t.analysis, found[i]);
      done.push(t);
    });
    return done;
  }

  /** Diese Songs (in dieser Reihenfolge) scannen lassen – ersetzt die bisherige Wunschliste. */
  want(tracks) {
    this.wanted = tracks.filter((t) => t?.analysis && t.analysis.vocalSource !== 'lyrics' && !this.failed.has(t.id) && !this.running.has(t.id));
    this.emit('status');
    this._pump();
  }

  get left() {
    return this.wanted.length + this.running.size;
  }

  _pump() {
    if (!this.enabled) return;
    // während ein Übergang läuft, startet kein neuer Scan (die Wiedergabe hat Vorrang)
    const limit = this.shouldWait() ? 0 : this.size;
    for (let i = 0; i < this.size && this.running.size < limit && this.wanted.length; i++) {
      if ([...this.running.values()].some((x) => x.__vsw === i)) continue;
      this._scan(this.wanted.shift(), i);
    }
    if (this.wanted.length && this.running.size < this.size) {
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => this._pump(), 2000);
    }
  }

  async _scan(t, wi) {
    t.__vsw = wi;
    this.running.set(t.id, t);
    this.emit('status');
    try {
      const key = VocalScan.key(t);
      let words = await VocalScan.stored(t);
      if (!words) {
        const bytes = await readFile(t.path || t.id);
        const ctx = new OfflineAudioContext(1, 1, SR);
        const buf = await ctx.decodeAudioData(bytes);
        const mono = new Float32Array(buf.length);
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const d = buf.getChannelData(ch);
          for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
        }
        words = await this._run(wi, mono, guessLanguage(t));
        await cachePut(key, words);
      }
      if (t.analysis.vocalSource !== 'lyrics') t.analysis = withLyricVocals(t.analysis, words);
      this.running.delete(t.id);
      this.emit('done', t);
    } catch (err) {
      console.warn('Gesang-Scan fehlgeschlagen:', t.title, err?.message || err);
      this.failed.add(t.id);
      this.running.delete(t.id);
      this.emit('error', { track: t, error: err });
    } finally {
      this.running.delete(t.id);
      this.emit('status');
      this._pump();
    }
  }

  _run(wi, audio, language) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: wi });
      // erster Worker darf die Grafikkarte nehmen, die übrigen rechnen je auf einem CPU-Kern
      this._worker(wi).postMessage({ id, audio, language, device: wi === 0 ? 'auto' : 'wasm' }, [audio.buffer]);
    });
  }
}
