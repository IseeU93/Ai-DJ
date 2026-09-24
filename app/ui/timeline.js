// Zeitleiste eines Übergangs: Lautstärkeverlauf beider Decks + die DJ-Aktionen in Takten.
import { KILL } from '../mix/planner.js';

const LOOP_NAMES = { 16: 'Loop 16', 8: 'Loop 8', 4: 'Loop 4', 2: 'Loop 2', 1: 'Loop 1', 0.5: '½', 0.25: '¼', 0.125: '⅛' };

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

function faderCurve(steps, deck, initial) {
  const pts = [[-Infinity, initial]];
  let v = initial;
  for (const s of steps) {
    if (s.deck !== deck || s.param !== 'fader') continue;
    pts.push([s.at, v]);
    v = s.to;
    pts.push([s.at + (s.dur || 0), v]);
  }
  pts.push([Infinity, v]);
  return pts;
}

function labelFor(s) {
  if (s.action === 'loop') return LOOP_NAMES[s.bars] || `Loop ${s.bars}`;
  if (s.action === 'play') return 'Start';
  if (s.action === 'stop') return 'Stop';
  if (s.param === 'low') return s.to <= KILL + 1 ? 'Bass aus' : 'Bass an';
  if (s.param === 'vocal') return s.to > 0.5 ? 'Vocal-Cut' : 'Vocals';
  if (s.param === 'echo') return s.to > 0 ? 'Echo' : '';
  if (s.param === 'filter' && s.dur) return s.to > 0.05 ? 'Hochpass' : s.to < -0.05 ? 'Tiefpass' : 'Filter auf';
  return '';
}

/**
 * @param plan  Plan vom Planer/Conductor
 * @param progress aktuelle Position in Takten relativ zu T0 (oder null)
 * @param colors { out, in }
 */
export function drawTimeline(canvas, plan, progress, colors) {
  const { w, h, dpr } = fit(canvas);
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (!plan) return;
  const steps = plan.steps.filter((s) => s.action !== 'rate');
  const from = Math.min(0, ...steps.map((s) => s.at)) - 0.5;
  const to = Math.max(plan.bars, plan.endBars) + 0.5;
  const pad = 26 * dpr;
  const x = (bar) => pad + ((bar - from) / (to - from)) * (w - pad - 6 * dpr);

  c.font = `${10 * dpr}px "Segoe UI", sans-serif`;
  c.textBaseline = 'middle';

  // Taktraster
  const top = 12 * dpr;
  for (let b = Math.ceil(from); b <= Math.floor(to); b++) {
    const xx = Math.round(x(b));
    const major = b % 4 === 0;
    c.fillStyle = major ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
    c.fillRect(xx, top, dpr, h - top);
    if (major || plan.bars <= 2) {
      c.fillStyle = '#6d6f75';
      c.fillText(String(b), xx + 3 * dpr, 6 * dpr);
    }
  }

  const rows = [
    { deck: 'out', color: colors.out, y: top + 3 * dpr, initial: 1, name: colors.outName },
    { deck: 'in', color: colors.in, y: top + (h - top) / 2 + 1 * dpr, initial: 0, name: colors.inName },
  ];
  const rowH = (h - top) / 2 - 5 * dpr;

  for (const row of rows) {
    c.fillStyle = row.color;
    c.fillText(row.name, 6 * dpr, row.y + rowH / 2);

    // Loop-Bereiche
    const loops = steps.filter((s) => s.deck === row.deck && s.action === 'loop');
    loops.forEach((s, i) => {
      const end = loops[i + 1]?.at ?? s.at + s.bars;
      c.fillStyle = 'rgba(255,255,255,0.06)';
      c.fillRect(x(s.at), row.y, x(end) - x(s.at), rowH);
    });

    // Lautstärke-Kurve
    const pts = faderCurve(steps, row.deck, row.initial);
    c.strokeStyle = row.color;
    c.lineWidth = 1.5 * dpr;
    c.beginPath();
    const yv = (v) => row.y + rowH - v * rowH;
    c.moveTo(x(from), yv(pts[0][1]));
    for (const [bar, v] of pts.slice(1, -1)) c.lineTo(x(Math.max(from, bar)), yv(v));
    c.lineTo(x(to), yv(pts[pts.length - 1][1]));
    c.stroke();

    // Aktionen
    let lastLabelX = -Infinity;
    for (const s of steps) {
      if (s.deck !== row.deck) continue;
      const text = labelFor(s);
      if (!text) continue;
      const xx = x(s.at);
      c.fillStyle = row.color;
      c.fillRect(Math.round(xx), row.y, dpr, rowH);
      if (xx - lastLabelX < 34 * dpr) continue;
      c.fillStyle = '#cfcdc8';
      c.fillText(text, xx + 3 * dpr, row.y + rowH * 0.3);
      lastLabelX = xx;
    }
  }

  if (progress !== null && progress !== undefined && progress >= from && progress <= to) {
    c.fillStyle = '#f2f1ec';
    c.fillRect(Math.round(x(progress)), top, 2 * dpr, h - top);
  }
}
