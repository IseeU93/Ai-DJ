// Synthetische "Songs" mit bekannter Struktur für Analyse-Tests (kein urheberrechtlich geschütztes Material).

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/**
 * sections: [{bars, kick, bass, pad, vocal}]; Akkordwechsel auf jedem Downbeat.
 * Liefert {L, R, sr, firstBeat, bpm}.
 */
export function synthSong({ bpm = 128, sr = 22050, offset = 0.37, root = 57, sections, seed = 1 }) {
  const beat = 60 / bpm;
  const totalBars = sections.reduce((a, s) => a + s.bars, 0);
  const n = Math.ceil((offset + totalBars * 4 * beat + 1) * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const noise = rng(seed);
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const progression = [0, 5, 7, 3]; // relative Akkordgrundtöne pro Takt (Moll-Feeling)

  let bar = 0;
  for (const sec of sections) {
    for (let b = 0; b < sec.bars; b++, bar++) {
      const chordRoot = root + progression[bar % 4];
      for (let k = 0; k < 4; k++) {
        const t0 = offset + (bar * 4 + k) * beat;
        const i0 = Math.round(t0 * sr);
        if (sec.kick) {
          const len = Math.round(0.14 * sr);
          for (let i = 0; i < len && i0 + i < n; i++) {
            const tt = i / sr;
            const f = 50 + 90 * Math.exp(-tt * 40);
            const v = 0.7 * Math.exp(-tt * 22) * Math.sin(2 * Math.PI * f * tt);
            L[i0 + i] += v;
            R[i0 + i] += v;
          }
        }
        if (sec.kick) {
          // Hi-Hat auf Offbeat (seitlich im Stereobild)
          const h0 = Math.round((t0 + beat / 2) * sr);
          const len = Math.round(0.03 * sr);
          for (let i = 0; i < len && h0 + i < n; i++) {
            const v = 0.12 * Math.exp(-i / (0.006 * sr)) * noise();
            L[h0 + i] += v * 1.3;
            R[h0 + i] += v * 0.4;
          }
        }
        const b0 = i0;
        const len = Math.round(beat * sr);
        for (let i = 0; i < len && b0 + i < n; i++) {
          const tt = (b0 + i) / sr;
          let l = 0;
          let r = 0;
          if (sec.bass) {
            const v = 0.25 * Math.sin(2 * Math.PI * hz(chordRoot - 24) * tt) * Math.min(1, i / 200);
            l += v;
            r += v;
          }
          if (sec.pad) {
            // Pad breit im Stereobild
            const a = 0.05 * Math.sin(2 * Math.PI * hz(chordRoot) * tt);
            const c = 0.05 * Math.sin(2 * Math.PI * hz(chordRoot + 3) * tt);
            const d = 0.05 * Math.sin(2 * Math.PI * hz(chordRoot + 7) * tt);
            l += a + c * 0.3 + d;
            r += a * 0.3 + c + d * 0.2;
          }
          if (sec.vocal) {
            // "Stimme": zentriert, obertonreich, mit Vibrato, Melodie im 300–3000-Hz-Bereich
            const f0 = hz(chordRoot + 12 + [0, 3, 7, 5][k]) * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * tt));
            let v = 0;
            for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * tt) / h;
            v *= 0.08 * Math.min(1, i / 400) * Math.min(1, (len - i) / 400);
            l += v;
            r += v;
          }
          L[b0 + i] += l;
          R[b0 + i] += r;
        }
      }
    }
  }
  return { L, R, sr, firstBeat: offset, bpm };
}
