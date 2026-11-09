// Track-Analyse für DJ-Mixing: Beatgrid, Downbeats, Phrasen/Sektionen, Tonart, Gesang, Lautheit.
// Reines JS ohne DOM – läuft im Web Worker und in Node-Tests.
import { stft } from './fft.js';
import { gridFromBeats } from './beatnet.js';

export const ANALYSIS_VERSION = 18;
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
  const snr = new Float32Array(frames);
  // Snare-Band (Körper ~180 Hz bis 2,5 kHz – darüber liegen vor allem Hi-Hats): die Snare auf 2 und 4 ist in Pop/Rap/
  // Hip-Hop der verlässlichste Beat-Anker – die Kick sitzt dort oft auf Offbeats
  const snLo = Math.round(180 / binHz);
  const snHi = Math.min(maxBin, Math.round(2500 / binHz));
  stft(mid, ONSET_N, ONSET_HOP, (t, mag) => {
    let s = 0;
    let l = 0;
    let m = 0;
    for (let k = 1; k <= maxBin; k++) {
      const lm = Math.log1p(100 * mag[k]);
      const d = lm - prev[k];
      if (d > 0 && t > 0) {
        s += d;
        if (k <= lowBins) l += d;
        else if (k >= snLo && k <= snHi) m += d;
      }
      prev[k] = lm;
    }
    flux[t] = s;
    low[t] = l;
    snr[t] = m;
  });
  const fr = sr / ONSET_HOP;
  const full = detrend(flux, Math.round(fr * 0.4));
  const lowEnv = detrend(low, Math.round(fr * 0.4));
  // Kick/Bass stärker gewichten: in Clubmusik definiert die Bassdrum den Beat, nicht die Hi-Hat
  const mf = mean(full) || 1;
  const ml = mean(lowEnv) || 1;
  const env = new Float32Array(frames);
  for (let t = 0; t < frames; t++) env[t] = full[t] / mf + 1.5 * (lowEnv[t] / ml);
  return { env, low: lowEnv, snare: detrend(snr, Math.round(fr * 0.4)), flux, fr };
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
function resolveHalfBeat(lowEnv, P, phase, snareEnv = null) {
  const sum = (e, ph) => {
    let s = 0;
    for (let t = ph; t < e.length; t += P) s += Math.max(interp(e, t - 1), interp(e, t), interp(e, t + 1));
    return s;
  };
  // Backbeat: auf der richtigen Beat-Position wechselt die Snare von Schlag zu Schlag (2 und 4
  // stark, 1 und 3 schwach). Einen halben Beat daneben verschwindet dieser Wechsel. Hi-Hats, die
  // gleichmäßig auf Beat und Offbeat liegen, heben sich beim Vergleich gerade/ungerade auf.
  const backbeat = (e, ph) => {
    let even = 0;
    let odd = 0;
    let k = 0;
    for (let t = ph; t < e.length; t += P, k++) {
      const v = Math.max(interp(e, t - 1), interp(e, t), interp(e, t + 1));
      if (k % 2) odd += v;
      else even += v;
    }
    return Math.abs(even - odd) / (even + odd + 1e-9);
  };
  // Kick allein reicht nicht: im Rap/Pop liegen oft mehr Kicks auf Offbeats als auf Beats.
  const score = (ph) => {
    const k = sum(lowEnv, ph) / (sum(lowEnv, ph) + sum(lowEnv, ph + P / 2) + 1e-9);
    if (!snareEnv) return k;
    return k + 2 * backbeat(snareEnv, ph);
  };
  const a = score(phase);
  const b = score(phase + P / 2);
  return b > a * 1.1 ? phase + P / 2 : phase;
}


/**
 * Beat-Tracker mit variablem Tempo (dynamische Programmierung, nach Ellis 2007): folgt jedem
 * einzelnen Schlag, auch wenn das Tempo leicht schwankt (live eingespielt, ältere Produktionen).
 * Pro Schritt darf sich der Abstand nur wenig ändern (±10 %), große Sprünge kosten viel.
 * Liefert Beat-Positionen in Frames (Sub-Frame genau).
 */
function trackBeats(env, P) {
  const n = env.length;
  let m = 0;
  for (let t = 0; t < n; t++) m += env[t];
  m /= n || 1;
  let v = 0;
  for (let t = 0; t < n; t++) v += (env[t] - m) ** 2;
  const sd = Math.sqrt(v / (n || 1)) || 1;
  const alpha = 400;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(P * 0.9));
  const hi = Math.round(P * 1.1);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bi = -1;
    for (let tau = Math.max(0, t - hi); tau <= t - lo; tau++) {
      const d = Math.log((t - tau) / P);
      const sc = score[tau] - alpha * d * d;
      if (sc > best) {
        best = sc;
        bi = tau;
      }
    }
    const o = env[t] / sd;
    if (bi >= 0 && best > 0) {
      score[t] = o + best;
      back[t] = bi;
    } else score[t] = o;
  }
  let end = n - 1;
  for (let t = Math.max(0, n - hi); t < n; t++) if (score[t] > score[end]) end = t;
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) {
    const a = env[t - 1] ?? 0;
    const b = env[t];
    const c = env[t + 1] ?? 0;
    const den = a - 2 * b + c;
    beats.push(t + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0));
    if (back[t] < 0) break;
  }
  return beats.reverse();
}

/**
 * Glättet eine Beat-Liste (Frames): lokale Gerade über ±6 Schläge. Einzelne Ausreißer (auf eine
 * synkopierte Kick gesprungen) verschwinden, ein echter Tempo-Verlauf bleibt erhalten.
 */
function smoothBeats(beats, w = 6) {
  const out = new Float64Array(beats.length);
  for (let k = 0; k < beats.length; k++) {
    const i0 = Math.max(0, k - w);
    const i1 = Math.min(beats.length - 1, k + w);
    // robuste Gerade: Median der Steigungen um k, dann Median der Achsenabschnitte
    const slopes = [];
    for (let i = i0; i <= i1; i++) for (let j = i + 1; j <= i1; j++) slopes.push((beats[j] - beats[i]) / (j - i));
    slopes.sort((x, y) => x - y);
    const slope = slopes[Math.floor(slopes.length / 2)] || 0;
    const inter = [];
    for (let i = i0; i <= i1; i++) inter.push(beats[i] - slope * (i - k));
    inter.sort((x, y) => x - y);
    out[k] = inter[Math.floor(inter.length / 2)];
  }
  return out;
}

/** Summe einer Hüllkurve an (gebrochenen) Frame-Positionen, jeweils bestes aus ±1 Frame. */
function envAt(e, positions) {
  let s = 0;
  for (const t of positions) s += Math.max(interp(e, t - 1), interp(e, t), interp(e, t + 1));
  return s;
}

const BPM_MAX = 300; // Uptempo/Terror geht bis ~300

function estimateTempo(env, fr) {
  const minLag = Math.floor((fr * 60) / BPM_MAX);
  const maxLag = Math.ceil((fr * 60) / 60);
  const n = env.length;
  const acf = new Float64Array(maxLag * 4 + 2);
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
  // Synkopierte Kick (z. B. auf 1, 1e+, 3, 3e+) täuscht gern ein Tempo von 4/3 bzw. 3/4 des echten
  // vor. Der echte Beat wiederholt sich über den ganzen Takt (4 Schläge) deutlich stärker – nur
  // dann wechseln, wenn der Nachbar auch als einzelner Beat klar vorhanden ist.
  const at = (l) => acf[Math.max(0, Math.min(acf.length - 1, Math.round(l)))];
  // durchgehender schneller Puls (z. B. Uptempo mit Kick auf jedem Schlag) erzeugt dieselben
  // Muster, ist aber kein Synkopen-Fall -> dann nicht wechseln
  const steadyPulse = at(best / 2) >= 0.6 * at(best);
  for (const ratio of steadyPulse ? [] : [4 / 3, 3 / 4]) {
    const alt = best * ratio;
    if (alt < minLag || alt > maxLag) continue;
    if (at(alt) >= 0.5 * at(best) && at(4 * alt) > 1.3 * at(4 * best)) {
      best = Math.round(alt);
      break;
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

/**
 * Doppeltes Tempo? Bei Uptempo/Hardcore (200–300 BPM) landet die Autokorrelation gern auf der halben
 * Geschwindigkeit. Verräterisch: dann sitzt auf jedem "Offbeat" eine genauso kräftige Bassdrum wie
 * auf dem Beat. Bei normalem 4/4 ist dort höchstens eine Hi-Hat, im Bassband also fast nichts.
 */
/** Anteil der Beats bzw. Offbeats mit deutlicher Kick (Abdeckung), für die Uptempo-Prüfung. */
function kickCoverage(lowEnv, P, phase) {
  const peaks = (ph) => {
    const out = [];
    for (let t = ph; t < lowEnv.length; t += P) out.push(Math.max(interp(lowEnv, t - 1), interp(lowEnv, t), interp(lowEnv, t + 1)));
    return out;
  };
  const on = peaks(phase);
  const off = peaks(phase + P / 2);
  const all = [...on, ...off].sort((x, y) => y - x);
  const ref = all[Math.floor(all.length * 0.1)] || 1e-9; // typische starke Kick
  const cov = (arr) => arr.filter((v) => v > 0.35 * ref).length / (arr.length || 1);
  return { on: cov(on), off: cov(off) };
}

function offbeatKickRatio(lowEnv, P, phase) {
  const score = (ph) => {
    let s = 0;
    for (let t = ph; t < lowEnv.length; t += P) s += Math.max(interp(lowEnv, t - 1), interp(lowEnv, t), interp(lowEnv, t + 1));
    return s;
  };
  const on = score(phase);
  return on > 0 ? score(phase + P / 2) / on : 0;
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
  const pitch = new Float32Array(frames); // Tonhöhe (Halbtöne) des stärksten mittigen Peaks
  const bandMid = new Float32Array(frames); // Energie im Stimmband (Mitte)
  const bandSide = new Float32Array(frames); // Energie im Stimmband (Seite)
  const peaks = new Float32Array(frames); // Anzahl mittiger tonaler Peaks
  const cRatio = new Float32Array(frames); // Anteil mittiger Energie im Stimmband (alle Bins)
  const formant = new Float32Array(frames); // mittige Energie 1–3,5 kHz relativ zu 350 Hz–1 kHz
  const pitchFine = new Float32Array(frames); // Tonhöhe des stärksten mittigen Peaks, fein interpoliert

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
    let domE = 0;
    let domK = 0;
    let bm = 0;
    let bs = 0;
    let cAll = 0;
    let cHi = 0;
    let cLoE = 0;
    const kSplit = Math.round(1000 / binHz);
    for (let k = vLo; k <= vHi; k++) {
      const sp = sideBand[t * nb + k - vLo];
      bm += pow[k];
      bs += sp;
      const c = Math.max(0, pow[k] - 2 * sp);
      cAll += c;
      if (k >= kSplit) cHi += c;
      else cLoE += c;
    }
    bandMid[t] = bm;
    bandSide[t] = bs;
    cRatio[t] = cAll / (bm + 1e-12);
    formant[t] = Math.log((cHi + 1e-12) / (cLoE + 1e-12));
    let np = 0;
    for (let k = vLo + 3; k <= vHi - 3; k++) {
      const p = pow[k];
      if (p < pow[k - 1] || p < pow[k + 1]) continue;
      const neigh = (pow[k - 3] + pow[k + 3] + pow[k - 2] + pow[k + 2]) / 4;
      if (p < neigh * 4) continue;
      const peak = p + pow[k - 1] + pow[k + 1];
      const sidePeak = sideBand[t * nb + k - vLo] + sideBand[t * nb + k - vLo - 1] + sideBand[t * nb + k - vLo + 1];
      const c = Math.max(0, peak - 2 * sidePeak);
      centered += c;
      if (c > 0) np++;
      if (c > domE) {
        domE = c;
        domK = k;
      }
    }
    pitch[t] = domK ? 12 * Math.log2((domK * binHz) / 440) : NaN;
    if (domK) {
      // parabolische Interpolation des Peaks: feine Tonhöhe für Gleiten/Vibrato
      const a0 = Math.sqrt(pow[domK - 1]);
      const a1 = Math.sqrt(pow[domK]);
      const a2 = Math.sqrt(pow[domK + 1]);
      const den = a0 - 2 * a1 + a2;
      const off = den ? Math.max(-0.5, Math.min(0.5, (0.5 * (a0 - a2)) / den)) : 0;
      pitchFine[t] = 12 * Math.log2(((domK + off) * binHz) / 440);
    } else pitchFine[t] = NaN;
    vocal[t] = centered;
    peaks[t] = np;
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
  for (let t = 0; t < frames; t++) {
    vocal[t] /= ref;
    bandMid[t] /= ref;
    bandSide[t] /= ref;
  }

  return { chroma, vocal, pitch, pitchFine, bandMid, bandSide, peaks, cRatio, formant, frames, fps: sr / SPEC_HOP };
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

// ---------------------------------------------------------------- Gesangs-Modell

// Logistische Regression, trainiert an Whisper-Wortzeiten (Songtext-Erkennung) von Songs aus der
// eigenen DJ-Bibliothek (Pop, Rock, Schlager, Dance; Deutsch und Englisch). Geprüft je Song mit einem
// Modell, das diesen Song nicht kannte: findet ~9 von 10 gesungenen Takten (vorher ~4 von 10).
// Ergebnis ist eine Wahrscheinlichkeit 0..1 pro Takt.
const VOCAL_MODEL = {
  w: [0.2764, -0.5352, -0.2567, 0.0197, 0.5438, 0.1224, -0.1195, 0.5648, -0.2756, 0.0549, 0.1789, -0.1399, 0.2326, 0.1452, -0.1519, -0.177, 0.209, -0.3904, 0.3874, 0.3844, 0.284, 0.0586],
  b: 0.0596,
  mu: [-3.24432, 0.49732, -0.2684, 0.35033, -0.24556, 1.5911, -1.1616, 0.51082, -0.05098, -1.47903, -12.87767, 1.23595, 0.67303, -0.00832, -0.28798, 0.42428, 0.00176, -0.2684, 0.51082, -0.24556, -0.00832, 0.00176],
  sd: [1.60035, 0.74257, 1.4951, 0.14376, 1.40732, 0.84592, 0.54667, 0.76272, 4.50496, 7.56604, 3.61057, 0.18519, 0.15386, 0.13318, 0.87077, 0.27114, 0.26143, 1.35514, 0.67724, 1.2846, 0.11796, 0.19178],
};

/** Merkmale pro Takt (teils absolut, teils relativ zum Track) plus Nachbartakte als Kontext. */
export function vocalFeatures(bars) {
  const L = (x) => Math.log(1e-6 + x);
  const lv = bars.map((b) => L(b.vPlain));
  const lm = bars.map((b) => L(b.bandMid));
  const ls = bars.map((b) => L(b.bandSide));
  const lvx = bars.map((b) => L(b.vMax));
  const p10 = percentile(lv, 0.1);
  const p50 = percentile(lv, 0.5);
  const p90 = percentile(lv, 0.9);
  const m50 = percentile(lm, 0.5);
  const x10 = percentile(lvx, 0.1);
  const x90 = percentile(lvx, 0.9);
  const r50 = percentile(bars.map((b) => b.rms), 0.5);
  const pk50 = percentile(bars.map((b) => b.peaks), 0.5);
  const cr50 = percentile(bars.map((b) => b.cRatio), 0.5);
  const g50 = percentile(bars.map((b) => b.glide), 0.5);
  const base = bars.map((b, i) => [
    lv[i],
    (lv[i] - p10) / (p90 - p10 + 1e-6),
    lv[i] - p50,
    b.melody,
    lm[i] - m50,
    lm[i] - ls[i], // Mitte vs. Seite im Stimmband
    lv[i] - lm[i], // tonal-mittiger Anteil am Stimmband
    (lvx[i] - x10) / (x90 - x10 + 1e-6),
    b.peaks - pk50,
    b.rms - r50,
    b.high - b.rms,
    Math.log(1 + b.onset),
    b.cRatio,
    b.cRatio - cr50,
    b.formant,
    b.glide,
    b.glide - g50,
  ]);
  return base.map((x, i) => {
    const pr = base[i - 1] || x;
    const nx = base[i + 1] || x;
    return [...x, (pr[2] + nx[2]) / 2, (pr[7] + nx[7]) / 2, (pr[4] + nx[4]) / 2, (pr[13] + nx[13]) / 2, (pr[16] + nx[16]) / 2];
  });
}

function vocalModel(bars) {
  const { w, b, mu, sd } = VOCAL_MODEL;
  return vocalFeatures(bars).map((x) => {
    let s = b;
    for (let j = 0; j < w.length; j++) s += (w[j] * (x[j] - mu[j])) / sd[j];
    const p = 1 / (1 + Math.exp(-s));
    // auf die gewohnte Skala: rein instrumentale Takte ~0, sicherer Gesang ~1
    return Number.isFinite(p) ? Math.max(0, Math.min(1, (p - 0.25) / 0.45)) : 0;
  });
}

/** Hüllkurve |x|, geglättet (Einpol-Tiefpass, tau in Sekunden). */
function envelope(x, sr, tau) {
  const a = Math.exp(-1 / (tau * sr));
  const e = new Float32Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    const ax = Math.abs(x[i]);
    v = ax > v ? ax : a * v + (1 - a) * ax;
    e[i] = v;
  }
  return e;
}

/**
 * Four-on-the-floor-Prüfung: Liegt die Bassdrum auf (fast) jedem Schlag – aber einen halben Schlag
 * neben dem Raster? Dann hat der Tracker den Offbeat erwischt (Hi-Hats/Offbeat-Bass, Clap-Muster),
 * und jeder Mix mit einem richtig erkannten Track klappert Kick gegen Kick. Die Bass-Energie wird
 * über alle Schläge gefaltet; nur bei einem klaren Puls pro Schlag (hoher Kontrast) zählt die Lage
 * seines Anstiegs. Synkopierte Kicks (Rap/Pop) verschmieren das Profil und bleiben unangetastet. Liefert die Verschiebung in Schlägen (0, wenn das Raster stimmt).
 */
function fourFloorShift(lowSig, sr, beatTime, count) {
  const J = 96;
  const prof = new Float64Array(J);
  const byPos = Array.from({ length: 4 }, () => new Float64Array(J));
  let used = 0;
  for (let k = 1; k < count - 2; k++) {
    const t0 = beatTime(k);
    const t1 = beatTime(k + 1);
    if (t0 < 0 || t1 * sr >= lowSig.length) continue;
    for (let j = 0; j < J; j++) {
      const i0 = Math.round((t0 + ((t1 - t0) * j) / J) * sr);
      const i1 = Math.max(i0 + 1, Math.round((t0 + ((t1 - t0) * (j + 1)) / J) * sr));
      let v = 0;
      for (let i = i0; i < i1; i++) v += lowSig[i] * lowSig[i];
      prof[j] += v / (i1 - i0);
      byPos[k % 4][j] += v / (i1 - i0);
    }
    used++;
  }
  if (used < 32) return 0;
  // steilster Anstieg (zyklisch, über 2 Bins geglättet)
  const rise = (p) => {
    const P = (j) => p[((j % J) + J) % J];
    let best = -Infinity;
    let bj = 0;
    for (let j = 0; j < J; j++) {
      const d = P(j + 1) + P(j + 2) - P(j - 1) - P(j - 2);
      if (d > best) { best = d; bj = j + 0.5; }
    }
    return bj;
  };
  const bj = rise(prof);
  let mx = 0;
  let mn = Infinity;
  for (const v of prof) { mx = Math.max(mx, v); mn = Math.min(mn, v); }
  // Kontrast: zwischen den Kicks fast Stille im Bass – nur dann ist es ein klarer Puls auf jedem Schlag
  const contrast = mx / (mn + 1e-12);
  let ph = bj / J;
  if (ph >= 0.5) ph -= 1;
  // kleine Versätze erledigt die Feinausrichtung – hier geht es nur um grob falsche Phasen
  if (contrast < 15 || Math.abs(ph) < 0.35) return 0;
  // Four-on-the-floor heißt: Kick auf jedem Schlag des Takts. Rap mit Kicks auf einzelnen Offbeats
  // (Snare 2+4 auf dem Raster) hat sie nur auf manchen Taktpositionen – dann bleibt das Raster.
  for (const p of byPos) {
    const d = Math.abs(rise(p) - bj) / J;
    if (Math.min(d, 1 - d) > 0.08) return 0;
  }
  return ph;
}

/**
 * Verfeinert die Beat-Phase sample-genau an den echten Anschlägen (Kick, sonst Gesamtsignal):
 * pro Beat wird der steilste Anstieg der Hüllkurve gesucht; der Median der Abweichungen
 * korrigiert das Raster. Streuung und Drift ergeben die Zuverlässigkeit des Grids.
 */
function refinePhase(sig, sr, firstBeat, beatInterval, duration) {
  const env = envelope(sig, sr, 0.004);
  const win = Math.min(0.045, beatInterval * 0.2);
  const offs = [];
  for (let t = firstBeat; t < duration - win; t += beatInterval) {
    const i0 = Math.max(1, Math.floor((t - win) * sr));
    const i1 = Math.min(env.length - 1, Math.floor((t + win) * sr));
    let best = -1;
    let bestD = 0;
    const step = Math.max(1, Math.round(sr / 4000)); // 0,25-ms-Raster reicht
    for (let i = i0 + step; i < i1; i += step) {
      const d = env[i] - env[i - step];
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) offs.push({ t, off: best / sr - t, s: bestD });
  }
  if (offs.length < 16) return { shift: 0, jitterMs: 20, driftMs: 0 };
  const strong = offs.filter((o) => o.s >= percentile(offs.map((x) => x.s), 0.5));
  const med = (arr) => percentile(arr, 0.5);
  const shift = med(strong.map((o) => o.off));
  const jitter = med(strong.map((o) => Math.abs(o.off - shift)));
  const third = Math.floor(strong.length / 3);
  const drift = third >= 4 ? med(strong.slice(-third).map((o) => o.off)) - med(strong.slice(0, third).map((o) => o.off)) : 0;
  return { shift, jitterMs: jitter * 1000, driftMs: drift * 1000 };
}

/**
 * @param override optional { bpmFactor, shiftSec, downbeatSec, bpm (getappt), bpmMin (Uptempo-Playlist) }
 * @param nn optional { beats, downbeats } vom neuronalen Beat-Tracker (beatnet.js) – liefert dann Raster und Eins
 */
export function analyzeTrack(L, R, sr, override = null, nn = null) {
  const n = L.length;
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = (L[i] + R[i]) * 0.5;
    side[i] = (L[i] - R[i]) * 0.5;
  }
  const duration = n / sr;

  // --- Beatgrid
  const { env, low, snare, fr } = onsetEnvelope(mid, sr);
  // Tempo: getappt > geschätzt; Uptempo-Playlists falten ins Uptempo-Tempo
  let bpmCoarse = override?.bpm > 0 ? override.bpm : estimateTempo(env, fr);
  if (override?.bpmMin > 0 && !(override?.bpm > 0)) while (bpmCoarse < override.bpmMin && bpmCoarse * 2 <= BPM_MAX) bpmCoarse *= 2;
  let grid = fitGrid(env, fr, bpmCoarse);
  let phase = resolveHalfBeat(low, grid.P, grid.phase, snare);
  const cover = kickCoverage(low, grid.P, phase);
  if (!(override?.bpm > 0) && (60 * fr) / grid.P * 2 <= BPM_MAX && offbeatKickRatio(low, grid.P, phase) >= 0.8 && cover.on >= 0.75 && cover.off >= 0.75) {
    grid = fitGrid(env, fr, ((60 * fr) / grid.P) * 2);
    phase = resolveHalfBeat(low, grid.P, grid.phase, snare);
  }
  const P = grid.P;
  // Netz-Schläge (Beat This!) sind viel genauer als die eigene Onset-Suche – die eigene Schätzung
  // entscheidet dann nur noch die Tempo-Oktave
  const nnGrid = nn && !(override?.bpm > 0) ? gridFromBeats(nn, { hintBpm: (60 * fr) / P, bpmMin: override?.bpmMin, bpmFactor: override?.bpmFactor }) : null;
  let beatInterval = (P * ONSET_HOP) / sr;
  if (override?.bpmFactor) beatInterval /= override.bpmFactor;
  let bpm = 60 / beatInterval;
  let firstBeat = (phase * ONSET_HOP) / sr + ONSET_CALIB_S;

  // --- Filterbänder (Energie, Wellenform, Anschläge)
  const lowSig = filter(mid, biquad('lp', 150, sr));
  const highSig = filter(mid, biquad('hp', 3000, sr));

  // Phase sample-genau an den Kick-Anschlägen ausrichten (ohne Kick: Gesamtsignal)
  const kickShare = rmsRange(lowSig, 0, n) / (rmsRange(mid, 0, n) + 1e-12);
  let gridConfidence;
  let beatMap = null;
  let nnVotes = null;
  if (nnGrid) {
    ({ beatInterval, firstBeat, beatMap } = nnGrid);
    bpm = 60 / beatInterval;
    nnVotes = nnGrid.downbeatVotes;
    if (beatMap) {
      if (override?.shiftSec) for (let k = 0; k < beatMap.length; k++) beatMap[k] += override.shiftSec;
      firstBeat = beatMap[0];
    } else {
      // das Netz rechnet in 20-ms-Frames: sample-genau an den Kick-Anschlägen nachziehen
      const r = refinePhase(kickShare > 0.15 ? lowSig : mid, sr, ((firstBeat % beatInterval) + beatInterval) % beatInterval, beatInterval, duration);
      const before = firstBeat + (Math.abs(r.shift) < 0.015 ? r.shift : 0) + (override?.shiftSec || 0);
      firstBeat = ((before % beatInterval) + beatInterval) % beatInterval;
      // Schlag-Nummern verschieben sich, wenn der erste Schlag über die Null rutscht
      const dk = Math.round((before - firstBeat) / beatInterval);
      nnVotes = [0, 1, 2, 3].map((i) => nnGrid.downbeatVotes[(((i - dk) % 4) + 4) % 4]);
    }
    gridConfidence = Math.max(0.6, Math.min(1, 1 - nnGrid.jitterMs / 40));
  } else {
    const refine = refinePhase(kickShare > 0.15 ? lowSig : mid, sr, ((firstBeat % beatInterval) + beatInterval) % beatInterval, beatInterval, duration);
    firstBeat += refine.shift;
    if (override?.shiftSec) firstBeat += override.shiftSec;
    firstBeat = ((firstBeat % beatInterval) + beatInterval) % beatInterval;
    gridConfidence = Math.max(0, Math.min(1, 1 - (refine.jitterMs * 1.5 + Math.abs(refine.driftMs)) / 30));
  }

  // Schwankendes Tempo (live gespielt): festes Raster läuft weg -> jedem Schlag einzeln folgen.
  // Nur übernehmen, wenn die Beat-Map die Anschläge klar besser trifft als das feste Raster.
  if (!nnGrid && gridConfidence < 0.7 && !(override?.bpm > 0) && !override?.bpmFactor) {
    const raw = trackBeats(env, beatInterval * fr); // Beat-Abstand in Frames
    if (raw.length > 32) {
      let map = smoothBeats(raw);
      // halber Beat daneben? (gleiche Kick+Backbeat-Prüfung wie beim festen Raster)
      const mids = Array.from({ length: map.length - 1 }, (_, k) => (map[k] + map[k + 1]) / 2);
      const bb = (pos) => {
        let even = 0;
        let odd = 0;
        pos.forEach((t, k) => {
          const x = Math.max(interp(snare, t - 1), interp(snare, t), interp(snare, t + 1));
          if (k % 2) odd += x;
          else even += x;
        });
        return Math.abs(even - odd) / (even + odd + 1e-9);
      };
      const kFrac = (pos, other) => envAt(low, pos) / (envAt(low, pos) + envAt(low, other) + 1e-9);
      const sOn = kFrac(map, mids) + 2 * bb(map);
      const sMid = kFrac(mids, map) + 2 * bb(mids);
      if (sMid > sOn * 1.1) map = Float64Array.from(mids);
      // Vergleich mit dem festen Raster: trifft die Map die Anschläge besser?
      const gridPos = [];
      const ph0 = ((firstBeat - ONSET_CALIB_S) * sr) / ONSET_HOP;
      const Pfr = (beatInterval * sr) / ONSET_HOP;
      for (let t = ((ph0 % Pfr) + Pfr) % Pfr; t < env.length; t += Pfr) gridPos.push(t);
      const perBeat = (pos) => envAt(env, pos) / (pos.length || 1);
      if (perBeat(map) > perBeat(gridPos) * 1.05) {
        beatMap = Float64Array.from(map, (f) => (f * ONSET_HOP) / sr + ONSET_CALIB_S);
        // an den Kick-Anschlägen ausrichten (gemeinsamer Versatz)
        const env2 = envelope(kickShare > 0.15 ? lowSig : mid, sr, 0.004);
        const offs = [];
        const win = Math.min(0.03, beatInterval * 0.15);
        for (const t of beatMap) {
          const i0 = Math.max(1, Math.floor((t - win) * sr));
          const i1 = Math.min(env2.length - 1, Math.floor((t + win) * sr));
          let best = -1;
          let bestD = 0;
          for (let i = i0 + 4; i < i1; i += 4) {
            const d = env2[i] - env2[i - 4];
            if (d > bestD) {
              bestD = d;
              best = i;
            }
          }
          if (best > 0) offs.push(best / sr - t);
        }
        if (offs.length > 16) {
          const shift = percentile(offs, 0.5);
          for (let k = 0; k < beatMap.length; k++) beatMap[k] += shift;
        }
        if (override?.shiftSec) for (let k = 0; k < beatMap.length; k++) beatMap[k] += override.shiftSec;
        beatInterval = (beatMap[beatMap.length - 1] - beatMap[0]) / (beatMap.length - 1);
        bpm = 60 / beatInterval;
        firstBeat = beatMap[0];
        gridConfidence = Math.max(gridConfidence, 0.75); // folgt jetzt jedem Schlag
      }
    }
  }
  // Raster auf dem Offbeat? (Four-on-the-floor: die Kick muss auf dem Schlag liegen)
  if (!nnGrid && kickShare > 0.15 && !override?.shiftSec) {
    const bt = beatMap ? (k) => beatMap[k] : (k) => firstBeat + k * beatInterval;
    const cnt = beatMap ? beatMap.length : Math.floor((duration - firstBeat) / beatInterval) + 1;
    const ph = fourFloorShift(lowSig, sr, bt, cnt);
    if (ph) {
      if (beatMap) {
        const shifted = Float64Array.from(beatMap, (t, k) => t + ph * ((beatMap[k + 1] ?? t + beatInterval) - t));
        // sample-genau an den Kick-Anschlägen ausrichten (gemeinsamer Versatz)
        const r = refinePhase(lowSig, sr, shifted[0], beatInterval, Math.min(duration, shifted[shifted.length - 1] + beatInterval));
        for (let k = 0; k < shifted.length; k++) beatMap[k] = shifted[k] + (Math.abs(r.shift) < 0.03 ? r.shift : 0);
        firstBeat = beatMap[0];
      } else {
        firstBeat += ph * beatInterval;
        firstBeat = ((firstBeat % beatInterval) + beatInterval) % beatInterval;
        const r = refinePhase(lowSig, sr, firstBeat, beatInterval, duration);
        if (Math.abs(r.shift) < 0.03) firstBeat = (((firstBeat + r.shift) % beatInterval) + beatInterval) % beatInterval;
      }
    }
  }
  const beatCount = beatMap ? beatMap.length : Math.floor((duration - firstBeat) / beatInterval) + 1;
  const beatTime = beatMap
    ? (k) => (k < beatMap.length ? beatMap[Math.max(0, k)] + Math.min(0, k) * beatInterval : beatMap[beatMap.length - 1] + (k - beatMap.length + 1) * beatInterval)
    : (k) => firstBeat + k * beatInterval;
  const highEnv = envelope(highSig, sr, 0.01);

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
  const beatSnare = [];
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
    // Snare-Anschlag (Höhen-Hüllkurve steigt direkt am Beat)
    const i = Math.round(t0 * sr);
    const pre = highEnv[Math.max(0, i - Math.round(0.03 * sr))] || 0;
    let post = 0;
    for (let j = i; j < Math.min(highEnv.length, i + Math.round(0.04 * sr)); j += 16) post = Math.max(post, highEnv[j]);
    beatSnare.push(Math.max(0, post - pre));
  }
  const zLow = zscore(beatLow);
  const zSnare = zscore(beatSnare);
  const phaseScore = [0, 0, 0, 0];
  for (let k = 1; k < beatCount; k++) {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += beatChroma[k][i] * beatChroma[k - 1][i];
    const change = 1 - dot;
    const jump = Math.max(0, beatEnergy[k] - beatEnergy[k - 1]) / 6;
    phaseScore[k % 4] += change * 2 + 0.4 * zLow[k] + jump;
    // Backbeat: Snare auf 2 und 4 -> der Schlag davor/danach ist die "1" bzw. "3"
    phaseScore[(k + 3) % 4] += 0.35 * zSnare[k]; // k ist Zählzeit 2 -> k-1 ist die 1
    phaseScore[(k + 1) % 4] += 0.35 * zSnare[k]; // k ist Zählzeit 4 -> k+1 ist die 1
    phaseScore[k % 4] -= 0.3 * zSnare[k]; // Snare selbst ist selten auf der 1
    phaseScore[(k + 2) % 4] -= 0.3 * zSnare[k];
  }
  let downbeat = phaseScore.indexOf(Math.max(...phaseScore));
  // Eins vom Netz: klare Mehrheit gilt; sind zwei Lagen fast gleich oft erkannt (z. B. nach
  // halbiertem Tempo), entscheidet zwischen diesen beiden die eigene Takt-Analyse
  if (nnVotes && nnVotes.reduce((a, b) => a + b, 0) >= 8) {
    const order = [0, 1, 2, 3].sort((a, b) => nnVotes[b] - nnVotes[a]);
    const [p1, p2] = order;
    downbeat = nnVotes[p1] >= 1.5 * nnVotes[p2] ? p1 : phaseScore[p1] >= phaseScore[p2] ? p1 : p2;
  }
  // Four-on-the-floor: Anteil der Beats (in kräftigen Passagen) mit deutlichem Kick
  const strongLow = percentile(beatLow, 0.9) || 1;
  const loud = percentile(beatEnergy, 0.5);
  let kicks = 0;
  let counted = 0;
  for (let k = 0; k < beatCount; k++) {
    if (beatEnergy[k] < loud) continue;
    counted++;
    if (beatLow[k] >= 0.35 * strongLow) kicks++;
  }
  const fourFloor = counted ? kicks / counted : 0.5;
  if (override?.downbeatSec !== undefined && override?.downbeatSec !== null) {
    const k = Math.round((override.downbeatSec - firstBeat) / beatInterval);
    downbeat = ((k % 4) + 4) % 4;
  }

  /** Gesangs-Merkmale eines Zeitabschnitts (Takt oder Schlag). */
  function vocalSeg(t0, t1) {
    const [f0, f1] = frameRange(t0, t1);
    const n = Math.max(1, f1 - f0);
    let v = 0;
    let moves = 0;
    let pairs = 0;
    let bmS = 0;
    let bsS = 0;
    let npS = 0;
    let vMax = 0;
    let crS = 0;
    let foS = 0;
    let glides = 0;
    let gPairs = 0;
    for (let f = f0 + 1; f < f1; f++) {
      const d = Math.abs(spec.pitch[f] - spec.pitch[f - 1]);
      if (!Number.isFinite(d)) continue;
      pairs++;
      if (d >= 0.5 && d <= 8) moves++; // Melodieschritt (kein Oktav-/Obertonsprung)
      const g = Math.abs(spec.pitchFine[f] - spec.pitchFine[f - 1]);
      if (Number.isFinite(g) && g < 1.5) {
        gPairs++;
        if (g >= 0.08 && g <= 0.7) glides++; // Stimme gleitet/vibriert, Instrumente stehen
      }
    }
    for (let f = f0; f < f1; f++) {
      v += spec.vocal[f];
      bmS += spec.bandMid[f];
      bsS += spec.bandSide[f];
      npS += spec.peaks[f];
      crS += spec.cRatio[f];
      foS += spec.formant[f];
      vMax = Math.max(vMax, spec.vocal[f]);
    }
    const e0 = Math.round(t0 * fr);
    const e1 = Math.round(t1 * fr);
    let onset = 0;
    for (let t = e0; t < e1 && t < env.length; t++) onset += env[t];
    return {
      rms: db(rmsRange(mid, t0 * sr, t1 * sr)),
      high: db(rmsRange(highSig, t0 * sr, t1 * sr)),
      vPlain: v / n,
      melody: pairs ? moves / pairs : 0,
      bandMid: bmS / n,
      bandSide: bsS / n,
      peaks: npS / n,
      vMax,
      cRatio: crS / n,
      formant: foS / n,
      glide: gPairs ? glides / gPairs : 0,
      onset: onset / Math.max(1, e1 - e0),
    };
  }

  // --- Takte
  const bars = [];
  for (let b = 0; downbeat + 4 * b + 4 <= beatCount; b++) {
    const t0 = beatTime(downbeat + 4 * b);
    const t1 = t0 + 4 * beatInterval;
    const [f0, f1] = frameRange(t0, t1);
    const vs = vocalSeg(t0, t1);
    const chroma = new Float64Array(12);
    for (let f = f0; f < f1; f++) {
      for (let i = 0; i < 12; i++) chroma[i] += spec.chroma[f * 12 + i];
    }
    const cn = Math.hypot(...chroma) || 1;
    // Rhythmus: Onset-Dichte, Kick auf den Beats, 16tel-Muster (für Wiederholungs-/Loop-Erkennung)
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
    // Mitten-Band (150 Hz – 3 kHz): Stimme, Akkorde, Leads – dort überlagern sich zwei Songs am hörbarsten
    let ms = 0;
    const s0 = Math.max(0, Math.floor(t0 * sr));
    const s1 = Math.min(n, Math.floor(t1 * sr));
    for (let i = s0; i < s1; i++) {
      const r = mid[i] - lowSig[i] - highSig[i];
      ms += r * r;
    }
    bars.push({
      ...vs,
      low: db(sub),
      midBand: db(s1 > s0 ? ms / (s1 - s0) : 0),
      // Stimme = mittig + tonal + melodisch; stehende Akkorde (Pads) bewegen sich kaum
      vocalRaw: vs.vPlain * Math.min(1, 0.15 + 4 * vs.melody),
      chroma: Array.from(chroma, (x) => x / cn),
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
  // (nur noch für die Abschnitts-Erkennung – dort ist sie seit Langem eingestellt)
  const rawV = bars.map((b) => b.vocalRaw);
  const vFloor = percentile(rawV, 0.15);
  const vCeil = Math.max(percentile(rawV, 0.97), vFloor + 0.004);
  const vocalsNov = rawV.map((x) => Math.max(0, Math.min(1, (x - vFloor) / (vCeil - vFloor))));
  // Gesang für alle Mix-Entscheidungen: Wahrscheinlichkeit pro Takt aus dem trainierten Modell –
  // findet auch leise Strophen (die Normierung oben sah fast nur die lauten Refrains)
  // (classicVocals: nur für synthetische Test-Songs – Sinus-"Stimmen" und mittige Sinus-Pads kennt das Modell nicht)
  const vocals = override?.classicVocals ? vocalsNov : vocalModel(bars);

  // --- Phrasen (8 Takte): Offset über Neuheits-Kurve
  const feat = ['rms', 'low', 'high'].map((k) => zscore(bars.map((b) => b[k])));
  const novelty = new Float64Array(barCount);
  for (let b = 1; b < barCount; b++) {
    let d = 0;
    for (const f of feat) d += (f[b] - f[b - 1]) ** 2;
    d += (vocalsNov[b] - vocalsNov[b - 1]) ** 2;
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
  // Höhen (Hi-Hats, Becken) und Mitten relativ zu den lautesten Takten; Kick 0..1 relativ zu den kräftigsten
  const p90high = percentile(bars.map((b) => b.high), 0.9);
  const p90mid = percentile(bars.map((b) => b.midBand), 0.9);
  const p90kick = percentile(bars.map((b) => b.kick), 0.9) || 1;
  const barHigh = bars.map((b) => b.high - p90high);
  const barMid = bars.map((b) => b.midBand - p90mid);
  const barKick = bars.map((b) => Math.min(1, b.kick / p90kick));
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
  // Build-up: Phrase direkt vor einem Hauptteil (ohne volle Bassline), die entweder in sich
  // ansteigt oder als Stufe lauter/rhythmischer ist als der Teil davor
  phrases.forEach((p, i) => {
    const next = phrases[i + 1];
    const prev = phrases[i - 1];
    if (!next || next.label !== 'main' || p.label === 'main' || p.bars < 4 || i === 0) return;
    const h = Math.max(1, Math.floor(p.bars / 2));
    const rise = avg(barEnergy, p.bar + p.bars - h, h) - avg(barEnergy, p.bar, h);
    const drumRise = avg(drums, p.bar + p.bars - h, h) - avg(drums, p.bar, h);
    const stepUp = prev && prev.label !== 'main'
      && (p.energy - prev.energy > 1.5 || p.drums - prev.drums > 0.15);
    const noBassline = p.bass < next.bass - 6;
    if ((rise > 1.5 || drumRise > 0.12 || stepUp) && noBassline) p.label = 'build';
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
  const vs = (i) => ((vocals[i - 1] ?? 0) + 2 * vocals[i] + (vocals[i + 1] ?? 0)) / 4;
  for (let i = 0; i < barCount - 1; i++) {
    if (vs(i) >= 0.45 && vs(i + 1) >= 0.45) {
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
  // Beat-Stärke: wie deutlich die Anschläge genau auf den Schlägen herausstechen (Party-/Clubtrack
  // hoch, Ballade mit weichem, schwebendem Rhythmus niedrig) – für die Stimmung in der Reihenfolge.
  // ("intensity" oben ist durch die Normierung der Hüllkurve immer gleich und taugt dafür nicht.)
  let onBeat = 0;
  let nBeat = 0;
  for (let k = 0; k < beatCount; k++) {
    const f = ((beatTime(k) - ONSET_CALIB_S) * sr) / ONSET_HOP;
    if (f < 1 || f >= env.length - 1) continue;
    onBeat += Math.max(env[Math.floor(f)], env[Math.ceil(f)]);
    nBeat++;
  }
  const pulse = nBeat ? onBeat / nBeat / (intensity || 1) : 1;
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
    beats: beatMap, // nur bei schwankendem Tempo: exakte Zeit jedes Schlags
    gridConfidence,
    gridOverride: override || null,
    gridSource: nnGrid ? 'nn' : 'dsp',
    fourFloor,
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
    barHigh: Float32Array.from(barHigh),
    barMid: Float32Array.from(barMid),
    barKick: Float32Array.from(barKick),
    barRepeat: Float32Array.from(repeat),
    // Harmonie pro Takt (12 Halbtöne, 0–255): erkennt wiederkehrende Teile wie den Refrain
    barChroma: Uint8Array.from(bars.flatMap((b) => b.chroma.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)))),
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
    pulse,
    brightness,
    bassWeight,
    waveform: { rate: WAVE_RATE, low: wLow, mid: wMid, high: wHigh },
    // nur für Messungen/Tests: Rohwerte pro Takt
    ...(override?.debug ? { debugBars: bars.map((x) => ({ vRaw: x.vocalRaw, vPlain: x.vPlain, melody: x.melody, rms: x.rms, low: x.low, high: x.high, onset: x.onset, bandMid: x.bandMid, bandSide: x.bandSide, peaks: x.peaks, vMax: x.vMax, cRatio: x.cRatio, formant: x.formant, glide: x.glide })) } : {}),
  };
}
