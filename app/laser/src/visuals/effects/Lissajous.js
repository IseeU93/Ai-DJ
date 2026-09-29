// ============================================================
// Lissajous.js – Verbessert: Beat-Snap zu musikalischen Frequenzverhältnissen
// ============================================================

import { getPaletteColors, strokeLaserPath, effectOrigin, frameDt, approachFor, decayFor, beatClock } from '../../shared/Config.js';

// Musikalisch sinnvolle Frequenz-Paare für Lissajous-Figuren
const FREQ_PAIRS = [
  [1, 1], [1, 2], [2, 3], [3, 4], [3, 5], [4, 5],
  [5, 6], [2, 5], [1, 3], [3, 8], [5, 8], [4, 7],
];

export class Lissajous {
  constructor() {
    this._phase      = 0;
    this._time       = 0;
    this._pairIdx    = 0;
    this._freqXFine  = 2;
    this._freqYFine  = 3;
    this._colorIdx   = 0;
    this._barCounter = 0;
  }

  render(ctx, W, H, audioData, config) {
    const { bass, mid, amplitude, isBeat } = audioData;
    const { lissajous, speed, brightness, sensitivity, palette, customColor, show } = config;

    const dt = frameDt(config);
    const f = dt * 60;
    this._time += 0.01 * speed * f;

    const colors = getPaletteColors(palette, customColor);

    // ── Beat-Snap: zu nächstem Frequenz-Paar springen ─────
    if (isBeat) {
      this._barCounter++;
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      } else if (show.colorMode === 'bar' && this._barCounter % 4 === 0) {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
    }

    // Beat-Snap: die Figur wechselt einmal pro Takt (nicht auf jedem
    // Schlag - das war hektisch und ließ sie nie ausschwingen) und
    // morpht dabei weich in das nächste Frequenzpaar.
    if (lissajous.beatSnap) {
      const bar = Math.floor(beatClock(config, this._time * 0.5) / 4);
      if (this._lastBar === undefined) this._lastBar = bar;
      if (bar !== this._lastBar) {
        this._lastBar = bar;
        this._pairIdx = (this._pairIdx + 1) % FREQ_PAIRS.length;
      }
    }

    // Ziel-Frequenzen (manuell oder Beat-Snap)
    const [tX, tY] = lissajous.beatSnap
      ? FREQ_PAIRS[this._pairIdx]
      : [lissajous.freqX, lissajous.freqY];

    // Audio-Modulation: Bass/Mid verschiebt Frequenzen minimal
    const targetFX = tX + bass * sensitivity * 0.4;
    const targetFY = tY + mid  * sensitivity * 0.3;
    // langsam ausschwingen (~1 s): das Morphen ist der Effekt
    const k = approachFor(0.035, dt);
    this._freqXFine += (targetFX - this._freqXFine) * k;
    this._freqYFine += (targetFY - this._freqYFine) * k;

    // Phase dreht sich → morpht die Figur
    if (lissajous.autoPhase) {
      this._phase += 0.004 * speed * (1 + bass * 0.5) * f;
    }

    const { cx, cy } = effectOrigin(config, W, H);
    const radius = Math.min(W, H) * 0.43 * (0.85 + amplitude * sensitivity * 0.2);
    const color  = colors[this._colorIdx % colors.length];
    const color2 = colors[(this._colorIdx + 1) % colors.length];

    // ── Figur zeichnen ─────────────────────────────────────
    const STEPS = 2000;

    // Laser-Strich: farbiger Halo + weißer Kern statt einfarbiger Linie.
    const thickness = 1.5 * (config.thicknessMul || 1);
    strokeLaserPath(ctx, () => {
      for (let i = 0; i <= STEPS; i++) {
        const t = (i / STEPS) * Math.PI * 2;
        const x = cx + Math.sin(this._freqXFine * t + this._phase) * radius;
        const y = cy + Math.sin(this._freqYFine * t) * radius;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }, color, brightness, thickness);

    // Auf dem Beat: zweite, kleinere Kurve, die weich ausklingt (vorher
    // ein einzelnes Bild - je nach Bildrate kaum zu sehen oder ein Flackern).
    if (isBeat) this._ghost = 1;
    this._ghost = (this._ghost || 0) * decayFor(0.9, dt);
    if (this._ghost > 0.05 && colors.length > 1) {
      const [nX, nY] = FREQ_PAIRS[(this._pairIdx + 1) % FREQ_PAIRS.length];
      strokeLaserPath(ctx, () => {
        for (let i = 0; i <= 1000; i++) {
          const t = (i / 1000) * Math.PI * 2;
          const x = cx + Math.sin(nX * t + this._phase + Math.PI * 0.5) * radius * 0.7;
          const y = cy + Math.sin(nY * t + Math.PI * 0.25) * radius * 0.7;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      }, color2, brightness * 0.5 * this._ghost, thickness * 0.7);
    }
  }
}
