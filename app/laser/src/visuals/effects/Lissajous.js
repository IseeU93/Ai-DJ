// ============================================================
// Lissajous.js – Verbessert: Beat-Snap zu musikalischen Frequenzverhältnissen
// ============================================================

import { getPaletteColors, strokeLaserPath, effectOrigin } from '../../shared/Config.js';

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

    this._time += 0.01 * speed;

    const colors = getPaletteColors(palette, customColor);

    // ── Beat-Snap: zu nächstem Frequenz-Paar springen ─────
    if (isBeat) {
      this._barCounter++;
      if (lissajous.beatSnap) {
        this._pairIdx = (this._pairIdx + 1) % FREQ_PAIRS.length;
      }
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      } else if (show.colorMode === 'bar' && this._barCounter % 4 === 0) {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
    }

    // Ziel-Frequenzen (manuell oder Beat-Snap)
    const [tX, tY] = lissajous.beatSnap
      ? FREQ_PAIRS[this._pairIdx]
      : [lissajous.freqX, lissajous.freqY];

    // Audio-Modulation: Bass/Mid verschiebt Frequenzen minimal
    const targetFX = tX + bass * sensitivity * 0.4;
    const targetFY = tY + mid  * sensitivity * 0.3;
    this._freqXFine += (targetFX - this._freqXFine) * 0.06;
    this._freqYFine += (targetFY - this._freqYFine) * 0.06;

    // Phase dreht sich → morpht die Figur
    if (lissajous.autoPhase) {
      this._phase += 0.004 * speed * (1 + bass * 0.5);
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

    // Auf Beat: kurze 2. Kurve mit phasenverschobenem Frequenzpaar
    if (isBeat && colors.length > 1) {
      const [nX, nY] = FREQ_PAIRS[(this._pairIdx + 1) % FREQ_PAIRS.length];
      strokeLaserPath(ctx, () => {
        for (let i = 0; i <= 1000; i++) {
          const t = (i / 1000) * Math.PI * 2;
          const x = cx + Math.sin(nX * t + this._phase + Math.PI * 0.5) * radius * 0.7;
          const y = cy + Math.sin(nY * t + Math.PI * 0.25) * radius * 0.7;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      }, color2, brightness * 0.5, thickness * 0.7);
    }
  }
}
