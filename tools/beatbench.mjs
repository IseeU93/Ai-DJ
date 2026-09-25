// Prüfstand für die Beat-Erkennung: synthetische Songs mit echten Drum-Patterns (Rap, Pop, House,
// Half-Time, Swing, schwankendes Tempo, Intro ohne Drums) mit bekannter Wahrheit.
// Misst: Tempo-Fehler, Timing-Fehler der Beats über den ganzen Song, richtige "Eins".
//   node tools/beatbench.mjs
import { analyzeTrack } from '../app/analysis/analyze.js';

const SR = 22050;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
}

/**
 * pattern: { kick: [16tel-Positionen im Takt], snare: [...], hat: 8|16|0, swing: 0..0.33 }
 * drift: relative Tempo-Schwankung (z. B. 0.01 = ±1 % langsam über den Song, wie live gespielt)
 */
export function drumSong({ bpm, bars = 64, pattern, drift = 0, introBars = 0, seed = 1, offset = 0.31, vocals = true, root = 57 }) {
  const rnd = rng(seed);
  // Beat-Zeiten mit Tempo-Verlauf (Wahrheit)
  const beats = [];
  let t = offset;
  const nBeats = bars * 4;
  for (let k = 0; k <= nBeats; k++) {
    beats.push(t);
    const tempo = bpm * (1 + drift * Math.sin((2 * Math.PI * k) / nBeats));
    t += 60 / tempo;
  }
  const n = Math.ceil((t + 1) * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const add = (time, fn, len) => {
    const i0 = Math.round(time * SR);
    for (let i = 0; i < len * SR && i0 + i < n; i++) {
      const v = fn(i / SR);
      L[i0 + i] += v;
      R[i0 + i] += v;
    }
  };
  const at16 = (bar, s16) => {
    const k = bar * 4 + Math.floor(s16 / 4);
    const frac = (s16 % 4) / 4;
    const b0 = beats[k];
    const b1 = beats[k + 1] ?? b0 + 60 / bpm;
    let f = frac;
    if (pattern.swing && s16 % 2 === 1) f += pattern.swing * 0.25; // Swing: Offbeat-16tel später
    return b0 + (b1 - b0) * f;
  };
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const prog = [0, 5, 7, 3];
  for (let bar = 0; bar < bars; bar++) {
    const drums = bar >= introBars;
    const chord = root + prog[bar % 4];
    const tb = beats[bar * 4];
    const te = beats[bar * 4 + 4];
    // Pad/Akkord über den ganzen Takt (Akkordwechsel auf der Eins)
    add(tb, (x) => 0.05 * (Math.sin(2 * Math.PI * hz(chord) * x) + Math.sin(2 * Math.PI * hz(chord + 3) * x) + Math.sin(2 * Math.PI * hz(chord + 7) * x)) * Math.min(1, x * 20), te - tb);
    if (!drums) continue;
    for (const s of pattern.kick) add(at16(bar, s), (x) => 0.8 * Math.exp(-x * 20) * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-x * 35)) * x), 0.18);
    for (const s of pattern.snare || []) add(at16(bar, s), (x) => 0.35 * Math.exp(-x * 25) * (rnd() * 2 + 0.5 * Math.sin(2 * Math.PI * 190 * x)), 0.15);
    if (pattern.hat) {
      const step = 16 / pattern.hat;
      // Hi-Hat realistisch hell: differenziertes Rauschen (Energie vor allem oberhalb ~5 kHz)
      for (let s = 0; s < 16; s += step) {
        let prev = 0;
        add(at16(bar, s), (x) => {
          const w = rnd() * 2;
          const v = w - prev;
          prev = w;
          return 0.1 * Math.exp(-x * 90) * v;
        }, 0.04);
      }
    }
    // Bass auf Kick-Positionen
    for (const s of pattern.kick) add(at16(bar, s), (x) => 0.25 * Math.sin(2 * Math.PI * hz(chord - 24) * x) * Math.exp(-x * 4), 0.3);
    if (vocals && bar % 8 < 6 && bar > introBars + 4) {
      const f = hz(chord + 12);
      add(tb + (te - tb) * 0.1, (x) => 0.08 * Math.sin(2 * Math.PI * f * x * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * x))) * Math.min(1, x * 10), (te - tb) * 0.8);
    }
  }
  return { L, R, sr: SR, beats, bpm };
}

const P = {
  fourFloor: { kick: [0, 4, 8, 12], snare: [4, 12], hat: 8 },
  rap: { kick: [0, 6, 10], snare: [4, 12], hat: 8 },
  rapSparse: { kick: [0, 7], snare: [4, 12], hat: 16 },
  halfTime: { kick: [0, 10], snare: [8], hat: 8 },
  swing: { kick: [0, 7, 10], snare: [4, 12], hat: 16, swing: 0.3 },
  popOffbeat: { kick: [0, 3, 8, 11], snare: [4, 12], hat: 8 },
  trap: { kick: [0, 11], snare: [8], hat: 16 },
};

export const CASES = [
  { name: 'House 124', bpm: 124, pattern: P.fourFloor },
  { name: 'Pop 100 (Kick verschoben)', bpm: 100, pattern: P.popOffbeat },
  { name: 'Rap 92', bpm: 92, pattern: P.rap },
  { name: 'Rap 87.5 sparsam', bpm: 87.5, pattern: P.rapSparse },
  { name: 'Hip-Hop Swing 96', bpm: 96, pattern: P.swing },
  { name: 'Half-Time 140', bpm: 140, pattern: P.halfTime },
  { name: 'Trap 75', bpm: 75, pattern: P.trap },
  { name: 'Rap 94 live (±1 %)', bpm: 94, pattern: P.rap, drift: 0.01 },
  { name: 'Pop 104 live (±0,6 %)', bpm: 104, pattern: P.popOffbeat, drift: 0.006 },
  { name: 'Pop 110, 8 Takte Intro ohne Drums', bpm: 110, pattern: P.popOffbeat, introBars: 8 },
  { name: 'House 126 live (±0,4 %)', bpm: 126, pattern: P.fourFloor, drift: 0.004 },
];

/** Bewertung: Tempo, Timing-Fehler (ms) je Beat über den Song, Anteil Beats < 20 ms, Eins richtig? */
export function evaluate(c) {
  const song = drumSong({ bars: 64, ...c });
  const a = analyzeTrack(song.L, song.R, song.sr);
  const truth = song.beats;
  const meanBpm = (60 * (truth.length - 1)) / (truth[truth.length - 1] - truth[0]);
  const bpmErr = Math.abs(a.bpm - meanBpm) / meanBpm;
  // Halb/Doppel zählt als falsch (sonst mixt er auf den falschen Schlag)
  const errs = [];
  // vorhergesagte Beat-Zeiten: Beat-Map (schwankendes Tempo) oder festes Raster
  const nearest = (t) => {
    if (a.beats) {
      let lo = 0;
      let hi = a.beats.length - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (a.beats[m] < t) lo = m;
        else hi = m;
      }
      return Math.abs(a.beats[lo] - t) < Math.abs(a.beats[hi] - t) ? a.beats[lo] : a.beats[hi];
    }
    return a.firstBeat + Math.round((t - a.firstBeat) / a.beatInterval) * a.beatInterval;
  };
  for (let k = (c.introBars || 0) * 4; k < truth.length - 1; k++) errs.push(Math.abs(nearest(truth[k]) - truth[k]) * 1000);
  errs.sort((x, y) => x - y);
  const med = errs[Math.floor(errs.length / 2)];
  const p90 = errs[Math.floor(errs.length * 0.9)];
  const ok20 = errs.filter((e) => e < 20).length / errs.length;
  // Eins: vorhergesagter Taktanfang fällt auf einen echten Taktanfang
  const dbTime = a.beats ? a.beats[a.downbeat] : a.firstBeat + a.downbeat * a.beatInterval;
  let kTrue = 0;
  for (let k = 0; k < truth.length; k++) if (Math.abs(truth[k] - dbTime) < Math.abs(truth[kTrue] - dbTime)) kTrue = k;
  const downbeatOk = ((kTrue % 4) + 4) % 4 === 0;
  return { name: c.name, bpm: +a.bpm.toFixed(2), truthBpm: +meanBpm.toFixed(2), bpmErr, med, p90, ok20, downbeatOk, conf: +a.gridConfidence.toFixed(2), map: !!a.beats };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('beatbench.mjs')) {
  let score = 0;
  for (const c of CASES) {
    const r = evaluate(c);
    const good = r.bpmErr < 0.01 && r.ok20 > 0.9 && r.downbeatOk;
    if (good) score++;
    console.log(
      `${good ? '✔' : '✖'} ${r.name.padEnd(34)} BPM ${String(r.bpm).padEnd(7)} (wahr ${r.truthBpm})  Median ${r.med.toFixed(1).padStart(5)} ms  90% ${r.p90.toFixed(1).padStart(6)} ms  <20ms ${(r.ok20 * 100).toFixed(0).padStart(3)}%  Eins ${r.downbeatOk ? 'ok' : 'FALSCH'}  Zuverl. ${r.conf}${r.map ? '  (Beat-Map)' : ''}`,
    );
  }
  console.log(`\n${score}/${CASES.length} sauber`);
}
