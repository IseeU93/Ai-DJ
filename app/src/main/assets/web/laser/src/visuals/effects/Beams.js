// ============================================================
// Beams.js – Fächerförmige Laser-Strahlen vom Zentrum
// Klassischer Laser-Show Effekt mit rotierenden Strahlen
// HARTE KANTEN – kein Glow/Blur
// ============================================================

import { getPaletteColors, colorWithAlpha } from '../../shared/Config.js';

export class Beams {
  constructor() {
    this._angles      = [];
    this._targets     = [];
    this._time        = 0;
    this._beatImpulse = 0;
  }

  init(config) {
    const n = config.beams.count;
    this._angles  = Array.from({ length: n }, (_, i) => (i / n) * Math.PI * 2);
    this._targets = [...this._angles];
  }

  render(ctx, W, H, audioData, config) {
    const { bass, mid, high, amplitude, isBeat } = audioData;
    const { beams, speed, sensitivity, brightness, palette, customColor } = config;

    this._time += 0.008 * speed;

    const cx       = W / 2;
    const cy       = H / 2;
    const maxLen   = Math.hypot(W, H);
    const spreadRad = (beams.spread / 180) * Math.PI;
    const count    = Math.max(2, Math.min(24, beams.count));
    const colors   = getPaletteColors(palette, customColor);

    // Beat-Impuls
    if (isBeat) {
      this._beatImpulse = (Math.random() > 0.5 ? 1 : -1) * 0.4 * sensitivity;
    }
    this._beatImpulse *= 0.92;

    // Ziel-Winkel berechnen
    for (let i = 0; i < count; i++) {
      const base   = -spreadRad / 2 + (i / (count - 1 || 1)) * spreadRad;
      const rotate = this._time * 0.5 * (config.autoRotate ? 1 : 0);
      const wave   = Math.sin(this._time * (1.5 + i * 0.4)) * 0.15 * (bass + mid);
      this._targets[i] = base + rotate + wave + this._beatImpulse;
    }

    // Sanfte Interpolation
    for (let i = 0; i < count; i++) {
      this._angles[i] = this._angles[i] !== undefined
        ? this._angles[i] + (this._targets[i] - this._angles[i]) * 0.12
        : this._targets[i];
    }

    // Strahlen zeichnen – HART, KEIN BLUR
    for (let i = 0; i < count; i++) {
      const angle = this._angles[i] - Math.PI / 2;
      const color = colors[i % colors.length];

      const frac = i / count;
      let intensity = 0.5 + amplitude * sensitivity * 0.5;
      if (frac < 0.33) intensity += bass * sensitivity * 0.6;
      else if (frac < 0.66) intensity += mid * sensitivity * 0.5;
      else intensity += high * sensitivity * 0.4;
      intensity = Math.min(1, intensity) * brightness;

      const x2 = cx + Math.cos(angle) * maxLen;
      const y2 = cy + Math.sin(angle) * maxLen;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = colorWithAlpha(color, intensity);
      ctx.lineWidth   = beams.thickness;
      ctx.lineCap     = 'butt';
      ctx.stroke();
    }

    // Kleiner harter Punkt im Zentrum
    const dotR = beams.thickness * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = colorWithAlpha(colors[0], Math.min(1, amplitude + 0.4) * brightness);
    ctx.fill();
  }
}
