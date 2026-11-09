// Schläge und Einsen per neuronalem Netz: „Beat This!“ (CPJKU, ISMIR 2024, MIT-Lizenz) als ONNX.
// Das Netz bekommt ein Log-Mel-Spektrogramm (wie torchaudio im Original) in 30-s-Stücken und
// liefert pro 20-ms-Frame, wie sicher dort ein Schlag bzw. eine Eins liegt. Daraus werden hier die
// Schlagzeiten (auf Bruchteile eines Frames genau) und das Raster für den Mixer: festes Tempo, wo
// der Song gleichmäßig läuft, sonst eine Beat-Map; die Eins per Mehrheit der erkannten Einsen.
// Alles hier ist reine Rechnung – das Netz selbst wird als Funktion übergeben (App: onnxruntime-web
// im Analyse-Worker, Tests: onnxruntime-node).
import { fft } from './fft.js';

export const NN_SR = 22050;
const N_FFT = 1024;
const HOP = 441; // 50 Frames pro Sekunde
const FPS = NN_SR / HOP;
const N_MELS = 128;
const CHUNK = 1500;
const BORDER = 6;

let melBank = null;
/** Mel-Filterbank wie torchaudio.functional.melscale_fbanks (Slaney-Skala, ohne Normierung). */
function mels() {
  if (melBank) return melBank;
  const nFreq = N_FFT / 2 + 1;
  const fSp = 200 / 3;
  const logStep = Math.log(6.4) / 27;
  const hz2mel = (f) => (f < 1000 ? f / fSp : 15 + Math.log(f / 1000) / logStep);
  const mel2hz = (m) => (m < 15 ? m * fSp : 1000 * Math.exp(logStep * (m - 15)));
  const m0 = hz2mel(30);
  const m1 = hz2mel(11000);
  const fPts = Array.from({ length: N_MELS + 2 }, (_, i) => mel2hz(m0 + ((m1 - m0) * i) / (N_MELS + 1)));
  const bank = [];
  for (let m = 0; m < N_MELS; m++) {
    const w = new Float32Array(nFreq);
    let lo = nFreq;
    let hi = 0;
    for (let k = 0; k < nFreq; k++) {
      const f = (k * NN_SR) / 2 / (nFreq - 1);
      const down = (f - fPts[m]) / (fPts[m + 1] - fPts[m]);
      const up = (fPts[m + 2] - f) / (fPts[m + 2] - fPts[m + 1]);
      w[k] = Math.max(0, Math.min(down, up));
      if (w[k] > 0) {
        lo = Math.min(lo, k);
        hi = k;
      }
    }
    bank.push({ w, lo, hi });
  }
  melBank = bank;
  return bank;
}

/** Log-Mel-Spektrogramm (Frames x 128) eines Mono-Signals bei 22050 Hz – wie LogMelSpect im Original. */
export function logMel(x) {
  const n = x.length;
  const frames = 1 + Math.floor(n / HOP);
  const half = N_FFT / 2;
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT); // periodisches Hann
  const bank = mels();
  const out = new Float32Array(frames * N_MELS);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const mag = new Float64Array(half + 1);
  const norm = 1 / Math.sqrt(N_FFT); // normalized="frame_length"
  // center=True mit Spiegelung am Rand
  const at = (i) => {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * n - 2 - i;
    return i >= 0 && i < n ? x[i] : 0;
  };
  for (let f = 0; f < frames; f++) {
    const s = f * HOP - half;
    if (s >= 0 && s + N_FFT <= n) for (let i = 0; i < N_FFT; i++) re[i] = x[s + i] * win[i];
    else for (let i = 0; i < N_FFT; i++) re[i] = at(s + i) * win[i];
    im.fill(0);
    fft(re, im);
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]) * norm;
    for (let m = 0; m < N_MELS; m++) {
      const { w, lo, hi } = bank[m];
      let v = 0;
      for (let k = lo; k <= hi; k++) v += w[k] * mag[k];
      out[f * N_MELS + m] = Math.log1p(1000 * v);
    }
  }
  return { data: out, frames };
}

/**
 * Netz über den ganzen Song: 30-s-Stücke mit 6 Frames Rand (wie split_piece/aggregate_prediction,
 * „keep_first“). `run(Float32Array [CHUNK*128])` -> { beat: Float32Array[CHUNK], downbeat } (Logits).
 */
export async function frameLogits(spec, run) {
  const { data, frames } = spec;
  const beat = new Float32Array(frames).fill(-1000);
  const down = new Float32Array(frames).fill(-1000);
  const starts = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (frames > CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  const done = new Uint8Array(frames);
  for (const s of starts) {
    const chunk = new Float32Array(CHUNK * N_MELS);
    const a = Math.max(0, s);
    const b = Math.min(frames, s + CHUNK);
    chunk.set(data.subarray(a * N_MELS, b * N_MELS), (a - s) * N_MELS);
    const p = await run(chunk);
    for (let i = BORDER; i < CHUNK - BORDER; i++) {
      const f = s + i;
      if (f < 0 || f >= frames || done[f]) continue; // frühere Stücke haben Vorrang
      beat[f] = p.beat[i];
      down[f] = p.downbeat[i];
      done[f] = 1;
    }
  }
  return { beat, down };
}

/** Spitzen über 50 % (Logit > 0), Maximum in ±70 ms, Zeit per Parabel auf Bruchteile eines Frames. */
export function peaks(l) {
  const out = [];
  for (let i = 0; i < l.length; i++) {
    if (l[i] <= 0) continue;
    let max = true;
    for (let d = -3; d <= 3 && max; d++) if (d && (l[i + d] ?? -1000) > l[i]) max = false;
    if (!max) continue;
    if (out.length && i - out[out.length - 1].i <= 1) continue; // Doppelspitze
    const a = l[i - 1] ?? l[i];
    const c = l[i + 1] ?? l[i];
    const den = a - 2 * l[i] + c;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    out.push({ i, t: (i + off) / FPS, v: l[i] });
  }
  return out;
}

/** Komplett: Mono-Signal (22050 Hz) -> { beats, downbeats } in Sekunden. */
export async function detectBeats(x, run) {
  const spec = logMel(x);
  const { beat, down } = await frameLogits(spec, run);
  const beats = peaks(beat).map((p) => p.t);
  const downbeats = peaks(down).map((p) => p.t);
  return { beats, downbeats };
}

const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : NaN;
};

/**
 * Lücken (verpasste Schläge) füllen, Doppel-Schläge entfernen – gegen das lokale Tempo, aber in der
 * Oktave des ganzen Songs: zählt das Netz eine Passage in halbem Tempo (Lemon Tree, Little Talks),
 * werden die fehlenden Schläge ergänzt, statt das Tempo mittendrin zu halbieren.
 */
function regularize(beats) {
  if (beats.length < 8) return beats.slice();
  const ibi = beats.slice(1).map((t, i) => t - beats[i]);
  const T0 = median(ibi);
  const out = [beats[0]];
  for (let i = 1; i < beats.length; i++) {
    let local = median(ibi.slice(Math.max(0, i - 9), i + 8));
    if (local < 0.8 * T0 || local > 1.25 * T0) local = T0;
    const g = beats[i] - out[out.length - 1];
    if (g < 0.55 * local) continue;
    const k = Math.round(g / local);
    const prev = out[out.length - 1];
    if (k >= 2 && k <= 16) for (let j = 1; j < k; j++) out.push(prev + (g * j) / k);
    out.push(beats[i]);
  }
  return out;
}

/** Jeden zweiten Schlag (halbes Tempo); behalten wird die Hälfte, auf der mehr Einsen liegen. */
function halve(beats, downbeats) {
  const on = [0, 0];
  for (const d of downbeats) {
    const k = nearest(beats, d);
    if (k >= 0 && Math.abs(beats[k] - d) < 0.05) on[k % 2]++;
  }
  const par = on[1] > on[0] ? 1 : 0;
  return beats.filter((_, k) => k % 2 === par);
}

/** Zwischenschläge einfügen (doppeltes Tempo). */
function double(beats) {
  const out = [];
  for (let k = 0; k < beats.length; k++) {
    out.push(beats[k]);
    if (k + 1 < beats.length) out.push((beats[k] + beats[k + 1]) / 2);
  }
  return out;
}

function nearest(arr, t) {
  let lo = 0;
  let hi = arr.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= t) lo = m;
    else hi = m;
  }
  return Math.abs(arr[lo] - t) <= Math.abs(arr[hi] - t) ? lo : hi;
}

/**
 * Raster für den Mixer aus den Netz-Schlägen.
 * @param nn { beats, downbeats } in Sekunden
 * @param opt { hintBpm (eigene Tempo-Schätzung, entscheidet die Oktave), bpmMin, bpmFactor }
 * @returns { beatInterval, firstBeat, beatMap (Float64Array|null), downbeatVotes [4], jitterMs } oder null
 */
export function gridFromBeats(nn, opt = {}) {
  let b = regularize(nn.beats);
  if (b.length < 32) return null;
  let T = median(b.slice(1).map((t, i) => t - b[i]));
  // Tempo-Oktave: das Netz zählt Pop-Songs gern doppelt so schnell, wie ein DJ sie mixt (Luftballons,
  // Take on Me). Liegt die eigene Schätzung beim halben Tempo, gilt sie; andersherum (eigene doppelt)
  // hat das Netz recht (Zombie, We Will Rock You).
  if (opt.hintBpm > 0 && Math.abs(Math.log((opt.hintBpm * 2 * T) / 60)) < 0.04) b = halve(b, nn.downbeats);
  if (opt.bpmFactor === 0.5) b = halve(b, nn.downbeats);
  else if (opt.bpmFactor === 2) b = double(b);
  T = median(b.slice(1).map((t, i) => t - b[i]));
  while (opt.bpmMin > 0 && 60 / T < opt.bpmMin && 120 / T <= 200) {
    b = double(b);
    T /= 2;
  }
  // gleichmäßiges Tempo? -> Gerade durch die Schläge (Kleinste Quadrate). Geratene Schläge im
  // schlaglosen Intro oder Break fallen nach der ersten Runde aus der Anpassung, damit sie einen
  // durchgehend gleichmäßigen Song nicht zur Beat-Map machen.
  const n = b.length;
  let slope = 0;
  let icpt = 0;
  let use = (k) => true;
  for (let it = 0; it < 3; it++) {
    let m = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (let k = 0; k < n; k++) {
      if (!use(k)) continue;
      m++; sk += k; st += b[k]; skk += k * k; skt += k * b[k];
    }
    if (m < 32) break;
    slope = (m * skt - sk * st) / (m * skk - sk * sk);
    icpt = (st - slope * sk) / m;
    const s = slope, c = icpt;
    use = (k) => Math.abs(b[k] - (c + s * k)) < 0.03;
  }
  const res = b.map((t, k) => t - (icpt + slope * k));
  const absRes = res.map(Math.abs).sort((p, q) => p - q);
  const p75 = absRes[Math.floor(absRes.length * 0.75)];
  const inl = res.filter((r) => Math.abs(r) < 0.03);
  const rms = Math.sqrt(inl.reduce((s, r) => s + r * r, 0) / Math.max(1, inl.length));
  let beatInterval;
  let firstBeat;
  let beatMap = null;
  let beatAt;
  if (p75 < 0.015 && rms < 0.012) {
    beatInterval = slope;
    firstBeat = icpt;
    beatAt = (k) => icpt + slope * k;
  } else {
    // schwankendes Tempo: jedem Schlag folgen, Wackler (Frame-Raster) über ±4 Schläge glätten
    beatMap = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 4);
      const z = Math.min(n - 1, k + 4);
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, m = 0;
      for (let j = a; j <= z; j++) {
        const d = j - k;
        s0 += d; s1 += b[j]; s2 += d * d; s3 += d * b[j]; m++;
      }
      const sl = (m * s3 - s0 * s1) / (m * s2 - s0 * s0 || 1);
      beatMap[k] = (s1 - sl * s0) / m;
    }
    beatInterval = (beatMap[n - 1] - beatMap[0]) / (n - 1);
    firstBeat = beatMap[0];
    beatAt = (k) => beatMap[k];
  }
  // Einsen: Mehrheit der Netz-Einsen auf den Rasterschlägen (Index modulo 4)
  const votes = [0, 0, 0, 0];
  const k0 = beatMap ? 0 : Math.floor(-firstBeat / beatInterval) + 1; // erster Schlag >= 0 s
  const idxOf = (t) => (beatMap ? nearest(beatMap, t) : Math.round((t - firstBeat) / beatInterval));
  for (const d of nn.downbeats) {
    const k = idxOf(d);
    if (k < 0 || Math.abs(beatAt(k) - d) > 0.3 * beatInterval) continue;
    votes[(((k - (beatMap ? 0 : k0)) % 4) + 4) % 4]++;
  }
  if (!beatMap) firstBeat = icpt + slope * k0; // App-Konvention: erster Schlag im Bereich [0, Intervall)
  return { beatInterval, firstBeat, beatMap, downbeatVotes: votes, jitterMs: rms * 1000 };
}
