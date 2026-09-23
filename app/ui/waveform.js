// Wellenformen: gezoomte Deck-Ansicht mit Beatgrid/Phrasen und Track-Übersicht.
import { barToSeconds } from '../mix/planner.js';

const SECTION_COLORS = {
  intro: '#3a3d44',
  main: null, // Deck-Farbe
  break: '#2b3a33',
  outro: '#3a3d44',
};
const SECTION_NAMES = { intro: 'Intro', main: 'Main', break: 'Break', outro: 'Outro' };

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class DeckWaveform {
  constructor(canvas, color) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.rgb = hexToRgb(color);
    this.secondsVisible = 9;
  }

  /**
   * @param track  Track mit analysis
   * @param pos    aktuelle Position in Sekunden
   * @param marks  { mixStart, mixEnd, label } in Sekunden (Track-Zeit), optional
   * @param loop   { start, len } in Sekunden, optional
   */
  draw(track, pos, marks, loop) {
    const { w, h, dpr } = fit(this.canvas);
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    if (!track) return;
    const a = track.analysis;
    const wf = a.waveform;
    const pps = w / this.secondsVisible;
    const t0 = pos - w / 2 / pps;
    const mid = h / 2;
    const amp = (h / 2 - 6 * dpr) / 255;
    const [r, g, b] = this.rgb;

    // Übergangsbereich hinterlegen
    if (marks) {
      const x1 = (marks.mixStart - t0) * pps;
      const x2 = (marks.mixEnd - t0) * pps;
      c.fillStyle = 'rgba(255,255,255,0.045)';
      c.fillRect(x1, 0, x2 - x1, h);
    }
    if (loop && loop.len > 0) {
      const x1 = (loop.start - t0) * pps;
      c.fillStyle = `rgba(${r},${g},${b},0.14)`;
      c.fillRect(x1, 0, loop.len * pps, h);
    }

    // Wellenform (3 Bänder)
    const colsPerPx = wf.rate / pps;
    const layers = [
      [wf.low, `rgba(${r},${g},${b},0.95)`],
      [wf.mid, `rgba(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)},0.75)`],
      [wf.high, 'rgba(236,234,228,0.7)'],
    ];
    for (const [data, fill] of layers) {
      c.fillStyle = fill;
      for (let x = 0; x < w; x += dpr) {
        const ta = t0 + x / pps;
        if (ta < 0) continue;
        const i0 = Math.floor(ta * wf.rate);
        if (i0 >= data.length) break;
        const i1 = Math.min(data.length, Math.max(i0 + 1, Math.floor(i0 + colsPerPx * dpr)));
        let m = 0;
        for (let i = i0; i < i1; i++) if (data[i] > m) m = data[i];
        const hh = m * amp;
        c.fillRect(x, mid - hh, dpr, hh * 2);
      }
    }

    // Beatgrid
    const k0 = Math.max(0, Math.floor((t0 - a.firstBeat) / a.beatInterval));
    const k1 = Math.ceil((t0 + w / pps - a.firstBeat) / a.beatInterval);
    for (let k = k0; k <= k1; k++) {
      const x = Math.round((a.firstBeat + k * a.beatInterval - t0) * pps);
      const isBar = (k - a.downbeat) % 4 === 0;
      c.fillStyle = isBar ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)';
      if (isBar) c.fillRect(x, 0, dpr, h);
      else {
        c.fillRect(x, 0, dpr, 5 * dpr);
        c.fillRect(x, h - 5 * dpr, dpr, 5 * dpr);
      }
    }

    // Phrasen + Sektionsband + Gesang
    c.font = `${10 * dpr}px "Segoe UI", sans-serif`;
    c.textBaseline = 'top';
    for (const ph of a.phrases) {
      const ts = barToSeconds(a, ph.bar);
      const te = barToSeconds(a, ph.bar + ph.bars);
      const x1 = (ts - t0) * pps;
      const x2 = (te - t0) * pps;
      if (x2 < 0 || x1 > w) continue;
      c.fillStyle = SECTION_COLORS[ph.label] || this.color;
      c.globalAlpha = ph.label === 'main' ? 0.7 : 1;
      c.fillRect(x1, h - 3 * dpr, x2 - x1, 3 * dpr);
      c.globalAlpha = 1;
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.fillRect(Math.round(x1), 0, dpr, h);
      c.fillStyle = 'rgba(220,218,213,0.7)';
      c.fillText(SECTION_NAMES[ph.label], x1 + 4 * dpr, 4 * dpr);
    }
    const vox = a.vocals;
    for (let bar = 0; bar < vox.length; bar++) {
      if (vox[bar] < 0.35) continue;
      const x1 = (barToSeconds(a, bar) - t0) * pps;
      const x2 = (barToSeconds(a, bar + 1) - t0) * pps;
      if (x2 < 0 || x1 > w) continue;
      c.fillStyle = `rgba(236,234,228,${0.15 + 0.5 * vox[bar]})`;
      c.fillRect(x1, 0, x2 - x1, 2 * dpr);
    }

    if (marks) {
      const x = (marks.mixStart - t0) * pps;
      c.fillStyle = '#ecebe6';
      c.fillRect(Math.round(x), 0, 2 * dpr, h);
      c.fillText(marks.label, x + 5 * dpr, 16 * dpr);
    }

    // gespielter Bereich abdunkeln + Playhead
    c.fillStyle = 'rgba(11,12,14,0.42)';
    c.fillRect(0, 0, w / 2, h);
    c.fillStyle = '#f2f1ec';
    c.fillRect(Math.round(w / 2) - dpr, 0, 2 * dpr, h);
  }
}

export function drawOverview(canvas, track, pos, color, marks) {
  const { w, h, dpr } = fit(canvas);
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (!track) return;
  const a = track.analysis;
  const wf = a.waveform;
  const dur = a.duration;
  const n = wf.low.length;
  const px = pos / dur;
  for (let x = 0; x < w; x += dpr) {
    const i0 = Math.floor((x / w) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((x + dpr) / w) * n));
    let m = 0;
    for (let i = i0; i < i1 && i < n; i++) m = Math.max(m, wf.low[i], wf.mid[i]);
    const hh = (m / 255) * (h / 2 - 3 * dpr);
    c.fillStyle = x / w < px ? '#4a4c52' : color;
    c.fillRect(x, h / 2 - 1.5 * dpr - hh, dpr, hh * 2);
  }
  for (const ph of a.phrases) {
    const x1 = (barToSeconds(a, ph.bar) / dur) * w;
    const x2 = (barToSeconds(a, ph.bar + ph.bars) / dur) * w;
    c.fillStyle = SECTION_COLORS[ph.label] || color;
    c.globalAlpha = ph.label === 'main' ? 0.6 : 1;
    c.fillRect(x1, h - 3 * dpr, x2 - x1, 3 * dpr);
    c.globalAlpha = 1;
  }
  if (marks) {
    c.fillStyle = 'rgba(255,255,255,0.12)';
    const x1 = (marks.mixStart / dur) * w;
    c.fillRect(x1, 0, ((marks.mixEnd - marks.mixStart) / dur) * w, h);
  }
  c.fillStyle = '#f2f1ec';
  c.fillRect(Math.round(px * w), 0, dpr, h);
}
