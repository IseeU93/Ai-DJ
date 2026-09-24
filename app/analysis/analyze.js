// Track-Analyse für DJ-Mixing: Beatgrid, Downbeats, Phrasen/Sektionen, Tonart, Gesang, Lautheit.
// Reines JS ohne DOM – läuft im Web Worker und in Node-Tests.
import { stft } from './fft.js';

export const ANALYSIS_VERSION = 6;
export const ANALYSIS_SR = 22050;

const ONSET_N = 1024;
const ONSET_HOP = 256;
const SPEC_N = 4096;
const SPEC_HOP = 2048;
const WAVE_RATE = 100; // Wellenform-Spalten pro Sekunde
// Versatz zwischen Flux-Peak und tatsächlichem Onset (per Test mit Klick-Spuren kalibriert)
const ONSET_CALIB_S = 0.0125;

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

// ---------------------------------------------------------------- Hilfen

function biquad(type, freq, sr, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * freq) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
  } else {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function filter(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function percentile(values, p) {
  const a = Array.from(values).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

function zscore(arr) {
  let m = 0;
  for (const v of arr) m += v;
  m /= arr.length || 1;
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  s = Math.sqrt(s / (arr.length || 1)) || 1;
  return arr.map((v) => (v - m) / s);
}

const db = (x) => 10 * Math.log10(x + 1e-12);

function rmsRange(x, a, b) {
  a = Math.max(0, Math.floor(a));
  b = Math.min(x.length, Math.floor(b));
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return b > a ? s / (b - a) : 0;
}

// ---------------------------------------------------------------- Onsets & Tempo

function onsetEnvelope(mid, sr) {
  const binHz = sr / ONSET_N;
  const lowBins = Math.max(2, Math.round(150 / binHz));
  const maxBin = Math.min(ONSET_N / 2, Math.round(9000 / binHz));
  const prev = new Float64Array(ONSET_N / 2 + 1);
  const frames = Math.floor(mid.length / ONSET_HOP) + 1;
  const flux = new Float32Array(frames);
  const low = new Float32Array(frames);
  stft(mid, ONSET_N, ONSET_HOP, (t, mag) => {
    let s = 0;
    let l = 0;
    for (let k = 1; k <= maxBin; k++) {
      const lm = Math.log1p(100 * mag[k]);
      const d = lm - prev[k];
      if (d > 0 && t > 0) {
        s += d;
        if (k <= lowBins) l += d;
      }
      prev[k] = lm;
    }
    flux[t] = s;
    low[t] = l;
  });
  const fr = sr / ONSET_HOP;
  const full = detrend(flux, Math.round(fr * 0.4));
  const lowEnv = detrend(low, Math.round(fr * 0.4));
  // Kick/Bass stärker gewichten: in Clubmusik definiert die Bassdrum den Beat, nicht die Hi-Hat
  const mf = mean(full) || 1;
  const ml = mean(lowEnv) || 1;
  const env = new Float32Array(frames);
  for (let t = 0; t < frames; t++) env[t] = full[t] / mf + 1.5 * (lowEnv[t] / ml);
  return { env, low: lowEnv, flux, fr };
}

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return s / (a.length || 1);
}

/** Lokalen Mittelwert abziehen und halbwellen-gleichrichten. */
function detrend(x, w) {
  const out = new Float32Array(x.length);
  let acc = 0;
  for (let t = 0; t < x.length + w; t++) {
    if (t < x.length) acc += x[t];
    if (t - 2 * w - 1 >= 0) acc -= x[t - 2 * w - 1];
    const c = t - w;
    if (c >= 0 && c < x.length) {
      const cnt = Math.min(t, x.length - 1) - Math.max(0, t - 2 * w) + 1;
      out[c] = Math.max(0, x[c] - acc / cnt);
    }
  }
  return out;
}

/** Entscheidet zwischen Phase und Phase + halber Beat anhand der Bassdrum-Onsets. */
function resolveHalfBeat(lowEnv, P, phase) {
  const score = (ph) => {
    let s = 0;
    for (let t = ph; t < lowEnv.length; t += P) s += Math.max(interp(lowEnv, t - 1), interp(lowEnv, t), interp(lowEnv, t + 1));
    return s;
  };
  const a = score(phase);
  const b = score(phase + P / 2);
  return b > a * 1.25 ? phase + P / 2 : phase;
}

function estimateTempo(env, fr) {
  const minLag = Math.floor((fr * 60) / 210);
  const maxLag = Math.ceil((fr * 60) / 60);
  const n = env.length;
  const acf = new Float64Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < acf.length; lag++) {
    let s = 0;
    for (let t = 0; t + lag < n; t++) s += env[t] * env[t + lag];
    acf[lag] = s / (n - lag);
  }
  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fr) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 122) / 0.9) ** 2);
    const s = (acf[lag] + 0.5 * acf[Math.min(acf.length - 1, 2 * lag)]) * prior;
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  // parabolische Verfeinerung
  const a = acf[best - 1] || 0;
  const b = acf[best];
  const c = acf[best + 1] || 0;
  const denom = a - 2 * b + c;
  const off = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  let bpm = (60 * fr) / (best + Math.max(-0.5, Math.min(0.5, off)));
  while (bpm < 78) bpm *= 2;
  while (bpm >= 185) bpm /= 2;
  return bpm;
}

function interp(env, t) {
  const i = Math.floor(t);
  if (i < 0 || i + 1 >= env.length) return 0;
  const f = t - i;
  return env[i] * (1 - f) + env[i + 1] * f;
}

/** Findet Periode + Phase des Beatgrids (in Frames) mit Sub-Frame-Genauigkeit. */
function fitGrid(env, fr, bpm0) {
  const P0 = (60 * fr) / bpm0;
  const B = 64;
  const hist = new Float64Array(B);
  let bestP = P0;
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let s = -40; s <= 40; s++) {
    const P = P0 * (1 + s * 0.0005);
    hist.fill(0);
    for (let t = 0; t < env.length; t++) {
      if (env[t] === 0) continue;
      const ph = (t % P) / P;
      hist[Math.floor(ph * B) % B] += env[t];
    }
    for (let b = 0; b < B; b++) {
      const v = hist[(b + B - 1) % B] * 0.5 + hist[b] + hist[(b + 1) % B] * 0.5;
      if (v > bestScore) {
        bestScore = v;
        bestP = P;
        bestPhase = ((b + 0.5) / B) * P;
      }
    }
  }

  // Regression über lokale Peaks um jeden vorhergesagten Beat
  let P = bestP;
  let phase = bestPhase;
  for (let iter = 0; iter < 3; iter++) {
    const pts = [];
    const K = Math.floor((env.length - phase) / P);
    const radius = P * (iter === 0 ? 0.12 : 0.07);
    for (let k = 0; k <= K; k++) {
      const pred = phase + k * P;
      let bi = -1;
      let bv = 0;
      for (let t = Math.max(1, Math.floor(pred - radius)); t <= Math.min(env.length - 2, Math.ceil(pred + radius)); t++) {
        if (env[t] > bv && env[t] >= env[t - 1] && env[t] >= env[t + 1]) {
          bv = env[t];
          bi = t;
        }
      }
      if (bi < 0) continue;
      const a = env[bi - 1];
      const b = env[bi];
      const c = env[bi + 1];
      const d = a - 2 * b + c;
      const off = d !== 0 ? (0.5 * (a - c)) / d : 0;
      pts.push({ k, t: bi + off, w: bv });
    }
    if (pts.length < 8) break;
    const wMed = percentile(pts.map((p) => p.w), 0.4);
    const use = pts.filter((p) => p.w >= wMed);
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const p of use) {
      sw += p.w; sk += p.w * p.k; st += p.w * p.t; skk += p.w * p.k * p.k; skt += p.w * p.k * p.t;
    }
    const den = sw * skk - sk * sk;
    if (Math.abs(den) < 1e-9) break;
    const newP = (sw * skt - sk * st) / den;
    const newPhase = (st - newP * sk) / sw;
    if (Math.abs(newP - P) / P > 0.01) break; // Ausreißer – groben Fit behalten
    P = newP;
    phase = newPhase;
  }
  return { P, phase };
}

// ---------------------------------------------------------------- Spektral-Features

function spectralFeatures(mid, side, sr) {
  const binHz = sr / SPEC_N;
  const frames = Math.floor(mid.length / SPEC_HOP) + 1;
  const chroma = new Float32Array(frames * 12);
  const vocal = new Float32Array(frames);
  const totals = new Float32Array(frames);

  const vLo = Math.round(350 / binHz);
  const vHi = Math.round(4000 / binHz);
  const nb = vHi - vLo + 1;
  const cLo = Math.max(1, Math.round(180 / binHz)); // Kick/Sub-Bereich raus – verfälscht sonst die Tonart
  const cHi = Math.round(2000 / binHz);
  const pc = new Int8Array(SPEC_N / 2 + 1).fill(-1);
  for (let k = cLo; k <= cHi; k++) {
    const midi = 69 + 12 * Math.log2((k * binHz) / 440);
    pc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  // Seiten-Spektrum im Stimmband zwischenspeichern
  const sideBand = new Float32Array(frames * nb);
  stft(side, SPEC_N, SPEC_HOP, (t, mag) => {
    for (let k = vLo; k <= vHi; k++) sideBand[t * nb + k - vLo] = mag[k] * mag[k];
  });

  const pow = new Float64Array(SPEC_N / 2 + 1);
  // Letzte zwei Frames für "stabile" Energie (Minimum über 3 Frames): gehaltene Töne bleiben,
  // Drums/Transienten fallen raus. Chroma gehört daher zum vorigen Frame (t - 1).
  const prev1 = new Float64Array(SPEC_N / 2 + 1);
  const prev2 = new Float64Array(SPEC_N / 2 + 1);
  stft(mid, SPEC_N, SPEC_HOP, (t, mag) => {
    let total = 1e-9;
    for (let k = 1; k < mag.length; k++) {
      const p = mag[k] * mag[k];
      pow[k] = p;
      total += p;
      if (pc[k] >= 0 && t >= 2) chroma[(t - 1) * 12 + pc[k]] += Math.min(p, prev1[k], prev2[k]);
    }
    prev2.set(prev1);
    prev1.set(pow);
    // Stimme ~ zentrierte (Mitte >> Seite), tonale Peaks im Bereich 350–4000 Hz.
    // Rauschen (Hi-Hats) hat keine Peaks, breite Pads/Synths haben viel Seitenanteil.
    let centered = 0;
    for (let k = vLo + 3; k <= vHi - 3; k++) {
      const p = pow[k];
      if (p < pow[k - 1] || p < pow[k + 1]) continue;
      const neigh = (pow[k - 3] + pow[k + 3] + pow[k - 2] + pow[k + 2]) / 4;
      if (p < neigh * 4) continue;
      const peak = p + pow[k - 1] + pow[k + 1];
      const sidePeak = sideBand[t * nb + k - vLo] + sideBand[t * nb + k - vLo - 1] + sideBand[t * nb + k - vLo + 1];
      centered += Math.max(0, peak - 2 * sidePeak);
    }
    vocal[t] = centered;
    totals[t] = total;
    // Frame-Chroma normieren (Wurzel der Frame-Energie als Gewicht), damit laute Passagen nicht alles bestimmen
    if (t >= 2) {
      const f = (t - 1) * 12;
      let cs = 0;
      for (let i = 0; i < 12; i++) cs += chroma[f + i];
      if (cs > 0) {
        const g = Math.sqrt(cs) / cs;
        for (let i = 0; i < 12; i++) chroma[f + i] *= g;
      }
    }
  });
  // auf die Lautheit des Tracks normieren (nicht pro Frame – sonst dominieren leise Breakdowns)
  const ref = percentile(totals, 0.9) || 1;
  for (let t = 0; t < frames; t++) vocal[t] /= ref;

  return { chroma, vocal, frames, fps: sr / SPEC_HOP };
}

function estimateKey(chroma, frames) {
  const sum = new Float64Array(12);
  for (let t = 0; t < frames; t++) for (let i = 0; i < 12; i++) sum[i] += chroma[t * 12 + i];
  const corr = (profile, shift) => {
    let mx = 0, my = 0;
    for (let i = 0; i < 12; i++) { mx += sum[i]; my += profile[i]; }
    mx /= 12; my /= 12;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) {
      const x = sum[(i + shift) % 12] - mx;
      const y = profile[i] - my;
      num += x * y; dx += x * x; dy += y * y;
    }
    return num / Math.sqrt(dx * dy || 1);
  };
  let best = { score: -Infinity };
  const scores = [];
  for (let s = 0; s < 12; s++) {
    for (const [profile, mode] of [[MAJOR, 'major'], [MINOR, 'minor']]) {
      const score = corr(profile, s);
      scores.push(score);
      if (score > best.score) best = { score, root: s, mode };
    }
  }
  scores.sort((a, b) => b - a);
  const name = `${NOTE[best.root]}${best.mode === 'minor' ? 'm' : ''}`;
  const camelot = best.mode === 'minor' ? CAMELOT_MINOR[best.root] : CAMELOT_MAJOR[best.root];
  return { name, camelot, confidence: Math.max(0, Math.min(1, (scores[0] - scores[1]) * 5)) };
}

// ---------------------------------------------------------------- Hauptfunktion

export function analyzeTrack(L, R, sr) {
  const n = L.length;
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = (L[i] + R[i]) * 0.5;
    side[i] = (L[i] - R[i]) * 0.5;
  }
  const duration = n / sr;

  // --- Beatgrid
  const { env, low, fr } = onsetEnvelope(mid, sr);
  const bpmCoarse = estimateTempo(env, fr);
  const grid = fitGrid(env, fr, bpmCoarse);
  const P = grid.P;
  const phase = resolveHalfBeat(low, P, grid.phase);
  const beatInterval = (P * ONSET_HOP) / sr;
  const bpm = 60 / beatInterval;
  let firstBeat = (phase * ONSET_HOP) / sr + ONSET_CALIB_S;
  firstBeat = ((firstBeat % beatInterval) + beatInterval) % beatInterval;
  const beatCount = Math.floor((duration - firstBeat) / beatInterval) + 1;
  const beatTime = (k) => firstBeat + k * beatInterval;

  // --- Filterbänder (Energie, Wellenform)
  const lowSig = filter(mid, biquad('lp', 150, sr));
  const highSig = filter(mid, biquad('hp', 3000, sr));

  // --- Spektral-Features
  const spec = spectralFeatures(mid, side, sr);
  const key = estimateKey(spec.chroma, spec.frames);

  const frameRange = (t0, t1) => [
    Math.max(0, Math.round(t0 * spec.fps)),
    Math.min(spec.frames, Math.max(Math.round(t0 * spec.fps) + 1, Math.round(t1 * spec.fps))),
  ];

  // Gesangs-Score pro Frame (z-normalisiert innerhalb des Tracks)
  // --- Beat-Features für Downbeat-Erkennung
  const beatChroma = [];
  const beatLow = [];
  const beatEnergy = [];
  for (let k = 0; k < beatCount; k++) {
    const t0 = beatTime(k);
    const [f0, f1] = frameRange(t0, t0 + beatInterval);
    const c = new Float64Array(12);
    for (let f = f0; f < f1; f++) for (let i = 0; i < 12; i++) c[i] += spec.chroma[f * 12 + i];
    const norm = Math.hypot(...c) || 1;
    beatChroma.push(c.map((v) => v / norm));
    const of = Math.round(t0 * fr);
    let lm = 0;
    for (let t = of - 3; t <= of + 3; t++) if (t >= 0 && t < low.length) lm = Math.max(lm, low[t]);
    beatLow.push(lm);
    beatEnergy.push(db(rmsRange(mid, t0 * sr, (t0 + beatInterval) * sr)));
  }
  const zLow = zscore(beatLow);
  const phaseScore = [0, 0, 0, 0];
  for (let k = 1; k < beatCount; k++) {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += beatChroma[k][i] * beatChroma[k - 1][i];
    const change = 1 - dot;
    const jump = Math.max(0, beatEnergy[k] - beatEnergy[k - 1]) / 6;
    phaseScore[k % 4] += change * 2 + 0.4 * zLow[k] + jump;
  }
  const downbeat = phaseScore.indexOf(Math.max(...phaseScore));

  // --- Takte
  const bars = [];
  for (let b = 0; downbeat + 4 * b + 4 <= beatCount; b++) {
    const t0 = beatTime(downbeat + 4 * b);
    const t1 = t0 + 4 * beatInterval;
    const [f0, f1] = frameRange(t0, t1);
    let v = 0;
    const chroma = new Float64Array(12);
    for (let f = f0; f < f1; f++) {
      v += spec.vocal[f];
      for (let i = 0; i < 12; i++) chroma[i] += spec.chroma[f * 12 + i];
    }
    const cn = Math.hypot(...chroma) || 1;
    // Rhythmus: Onset-Dichte, Kick auf den Beats, 16tel-Muster (für Wiederholungs-/Loop-Erkennung)
    const e0 = Math.round(t0 * fr);
    const e1 = Math.round(t1 * fr);
    let onset = 0;
    for (let t = e0; t < e1 && t < env.length; t++) onset += env[t];
    let kick = 0;
    for (let k = 0; k < 4; k++) {
      const c = Math.round((t0 + k * beatInterval) * fr);
      let m = 0;
      for (let t = c - 2; t <= c + 2; t++) if (t >= 0 && t < low.length) m = Math.max(m, low[t]);
      kick += m / 4;
    }
    const pattern = new Float64Array(16);
    for (let k = 0; k < 16; k++) {
      const c = Math.round((t0 + (k * beatInterval) / 4) * fr);
      let m = 0;
      for (let t = c - 1; t <= c + 1; t++) if (t >= 0 && t < env.length) m = Math.max(m, env[t]);
      pattern[k] = m;
    }
    // Bassline = tiefe Frequenzen ZWISCHEN den Kicks (die Kick selbst ist kurz, eine Bassline klingt weiter)
    let sub = 0;
    for (let k = 0; k < 4; k++) {
      const bt = t0 + k * beatInterval;
      sub += rmsRange(lowSig, (bt + Math.min(0.15, beatInterval * 0.3)) * sr, (bt + beatInterval) * sr) / 4;
    }
    bars.push({
      rms: db(rmsRange(mid, t0 * sr, t1 * sr)),
      low: db(sub),
      high: db(rmsRange(highSig, t0 * sr, t1 * sr)),
      vocalRaw: v / Math.max(1, f1 - f0),
      chroma: Array.from(chroma, (x) => x / cn),
      onset: onset / Math.max(1, e1 - e0),
      kick,
      pattern,
    });
  }
  const barCount = bars.length;

  // Drums 0..1: Onset-Stärke relativ zu den rhythmischsten Takten des Tracks.
  // (Leicht gekrümmt, damit Breaks mit einzelnen Akkordwechseln nicht als "Drums" zählen.)
  const pOn = percentile(bars.map((b) => b.onset), 0.9) || 1;
  const drums = bars.map((b) => Math.min(1, (b.onset / (0.6 * pOn)) ** 1.2));

  // Wiederholung: wie ähnlich ist ein Takt dem vorigen / 2 / 4 Takte davor (Rhythmus + Harmonie)
  const cos = (x, y) => {
    let d = 0, nx = 0, ny = 0;
    for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
    return nx && ny ? d / Math.sqrt(nx * ny) : 0;
  };
  const repeat = bars.map((b, i) => {
    let best = 0;
    for (const lag of [1, 2, 4]) {
      const o = bars[i - lag] || bars[i + lag];
      if (!o) continue;
      const sim = 0.6 * cos(b.pattern, o.pattern) + 0.4 * cos(b.chroma, o.chroma) - Math.min(0.5, Math.abs(b.rms - o.rms) / 12);
      best = Math.max(best, sim);
    }
    return Math.max(0, Math.min(1, best));
  });

  // Gesang pro Takt -> 0..1, relativ zum Track, aber mit absoluter Untergrenze
  // (sonst würde ein Instrumental auf volle Skala hochnormalisiert)
  const rawV = bars.map((b) => b.vocalRaw);
  const vFloor = percentile(rawV, 0.15);
  const vCeil = Math.max(percentile(rawV, 0.97), vFloor + 0.004);
  const vocals = rawV.map((x) => Math.max(0, Math.min(1, (x - vFloor) / (vCeil - vFloor))));

  // --- Phrasen (8 Takte): Offset über Neuheits-Kurve
  const feat = ['rms', 'low', 'high'].map((k) => zscore(bars.map((b) => b[k])));
  const novelty = new Float64Array(barCount);
  for (let b = 1; b < barCount; b++) {
    let d = 0;
    for (const f of feat) d += (f[b] - f[b - 1]) ** 2;
    d += (vocals[b] - vocals[b - 1]) ** 2;
    let cd = 0;
    for (let i = 0; i < 12; i++) cd += (bars[b].chroma[i] - bars[b - 1].chroma[i]) ** 2;
    novelty[b] = Math.sqrt(d) + cd;
  }
  let phraseOffset = 0;
  let bestNov = -Infinity;
  const meanNov = novelty.reduce((a, b) => a + b, 0) / Math.max(1, barCount);
  for (let o = 0; o < 8; o++) {
    let s = o === 0 ? meanNov * 2 : 0;
    for (let b = o; b < barCount; b += 4) s += (b - o) % 8 === 0 ? novelty[b] : novelty[b] * 0.5;
    if (s > bestNov) {
      bestNov = s;
      phraseOffset = o;
    }
  }

  const phrases = [];
  if (phraseOffset > 0) phrases.push({ bar: 0, bars: phraseOffset });
  for (let b = phraseOffset; b < barCount; b += 8) phrases.push({ bar: b, bars: Math.min(8, barCount - b) });

  const p90rms = percentile(bars.map((b) => b.rms), 0.9);
  const p90low = percentile(bars.map((b) => b.low), 0.9);
  const avg = (arr, from, len) => {
    let t = 0;
    for (let i = from; i < from + len; i++) t += arr[i];
    return t / Math.max(1, len);
  };
  const barEnergy = bars.map((b) => b.rms - p90rms);
  const barBass = bars.map((b) => b.low - p90low);
  for (const ph of phrases) {
    ph.energy = avg(barEnergy, ph.bar, ph.bars);
    ph.bass = avg(barBass, ph.bar, ph.bars);
    ph.vocal = avg(vocals, ph.bar, ph.bars);
    ph.drums = avg(drums, ph.bar, ph.bars);
    ph.label = ph.energy > -4.5 && ph.bass > -6 && ph.drums > 0.35 ? 'main' : 'break';
  }
  const mains = phrases.filter((p) => p.label === 'main');
  if (mains.length) {
    const first = phrases.indexOf(mains[0]);
    const last = phrases.indexOf(mains[mains.length - 1]);
    phrases.forEach((p, i) => {
      if (i < first) p.label = 'intro';
      else if (i > last) p.label = 'outro';
    });
  } else {
    phrases.forEach((p) => (p.label = 'main'));
  }
  // Build-up: Phrase direkt vor einem Hauptteil, in der Energie/Drums zum Ende hin ansteigen
  phrases.forEach((p, i) => {
    const next = phrases[i + 1];
    if (!next || next.label !== 'main' || p.label === 'main' || p.label === 'intro' || p.bars < 4) return;
    const h = Math.max(1, Math.floor(p.bars / 2));
    const rise = avg(barEnergy, p.bar + p.bars - h, h) - avg(barEnergy, p.bar, h);
    const drumRise = avg(drums, p.bar + p.bars - h, h) - avg(drums, p.bar, h);
    if (rise > 1.5 || drumRise > 0.12) p.label = 'build';
  });
  // Drops: Beginn jedes Hauptteil-Blocks
  const drops = [];
  phrases.forEach((p, i) => {
    if (p.label === 'main' && (i === 0 || phrases[i - 1].label !== 'main')) drops.push(p.bar);
  });

  // --- Mix-Punkte (als Beat-Indizes, immer auf Downbeats)
  const barBeat = (b) => downbeat + 4 * b;
  const silentDb = p90rms - 30;
  let firstBar = bars.findIndex((b) => b.rms > silentDb);
  if (firstBar < 0) firstBar = 0;
  let lastBar = barCount - 1;
  while (lastBar > 0 && bars[lastBar].rms <= silentDb) lastBar--;
  const firstMain = phrases.find((p) => p.label === 'main');
  const outro = phrases.find((p) => p.label === 'outro');
  const dropBar = firstMain ? Math.max(firstMain.bar, firstBar) : firstBar;
  // Gesangsgrenzen (mind. 2 Takte am Stück, damit einzelne Ausreißer nicht zählen)
  let vocalFirst = null;
  let vocalLast = null;
  for (let i = 0; i < barCount - 1; i++) {
    if (vocals[i] >= 0.5 && vocals[i + 1] >= 0.5) {
      if (vocalFirst === null) vocalFirst = i;
      vocalLast = i + 1;
    }
  }

  // --- Lautheit / Intensität
  const mainBars = [];
  phrases.filter((p) => p.label === 'main').forEach((p) => {
    for (let b = p.bar; b < p.bar + p.bars; b++) mainBars.push(b);
  });
  let mainPow = 0;
  for (const b of mainBars) mainPow += 10 ** (bars[b].rms / 10);
  mainPow /= Math.max(1, mainBars.length);
  const mainRms = Math.sqrt(mainPow);
  const gainDb = Math.max(-12, Math.min(4, 20 * Math.log10(0.22 / (mainRms + 1e-9))));

  let fluxSum = 0;
  for (const v of env) fluxSum += v;
  const intensity = fluxSum / env.length;
  const brightness = mainBars.length
    ? mainBars.reduce((a, b) => a + (bars[b].high - bars[b].rms), 0) / mainBars.length
    : 0;
  const bassWeight = mainBars.length
    ? mainBars.reduce((a, b) => a + (bars[b].low - bars[b].rms), 0) / mainBars.length
    : 0;

  // --- Wellenform (3 Bänder)
  const cols = Math.ceil(duration * WAVE_RATE);
  const spc = sr / WAVE_RATE;
  const wLow = new Uint8Array(cols);
  const wMid = new Uint8Array(cols);
  const wHigh = new Uint8Array(cols);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mid[i]));
  const scale = 255 / peak;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * spc);
    const b = Math.min(n, Math.floor((c + 1) * spc));
    let pl = 0, pm = 0, ph = 0;
    for (let i = a; i < b; i++) {
      const lo = Math.abs(lowSig[i]);
      const hi = Math.abs(highSig[i]);
      const m = Math.abs(mid[i] - lowSig[i] - highSig[i]);
      if (lo > pl) pl = lo;
      if (m > pm) pm = m;
      if (hi > ph) ph = hi;
    }
    wLow[c] = Math.min(255, pl * scale);
    wMid[c] = Math.min(255, pm * scale);
    wHigh[c] = Math.min(255, ph * scale * 1.4);
  }

  return {
    version: ANALYSIS_VERSION,
    duration,
    bpm,
    beatInterval,
    firstBeat,
    beatCount,
    downbeat,
    barCount,
    phraseOffset,
    key,
    phrases: phrases.map(({ bar, bars: len, label, energy, bass, vocal, drums: dr }) => ({
      bar, bars: len, label,
      energy: +energy.toFixed(2), bass: +bass.toFixed(2), vocal: +vocal.toFixed(3), drums: +dr.toFixed(3),
    })),
    vocals: Float32Array.from(vocals),
    barRms: Float32Array.from(bars.map((b) => b.rms)),
    barEnergy: Float32Array.from(barEnergy),
    barBass: Float32Array.from(barBass),
    barDrums: Float32Array.from(drums),
    barRepeat: Float32Array.from(repeat),
    points: {
      startBar: firstBar,
      dropBar,
      drops,
      outroBar: outro ? outro.bar : null,
      lastBar,
      vocalFirst,
      vocalLast,
    },
    loudness: { mainRms, gainDb },
    intensity,
    brightness,
    bassWeight,
    waveform: { rate: WAVE_RATE, low: wLow, mid: wMid, high: wHigh },
  };
}
