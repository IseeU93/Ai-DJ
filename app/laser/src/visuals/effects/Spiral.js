// ============================================================
// Spiral.js – Laser-Spirale
//
// Klassisches Lasershow-Motiv: mehrere Arme winden sich vom Ursprung
// nach außen und drehen sich, beschleunigt vom Beat. War vorher eine
// tote Datei mit nackten, einfarbigen Linien ohne Halo/Kern (nicht an
// die übrigen Laser-Konventionen der App angepasst) - jetzt über
// strokeLaserPath mit Blanking-Lücken wie ein echter Galvo, der die
// Spirale in Segmenten abfährt statt einer makellosen Kurve.
// ============================================================

import { getPaletteColors, strokeLaserPath, effectOrigin, frameDt, decayFor, approachFor } from '../../shared/Config.js';

const TAU = Math.PI * 2;
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);

export class Spiral {
  constructor() {
    this._rotation    = 0;
    this._rotVelocity = 0;
    this._time        = 0;
    this._zoom        = 1;
    this._colorIdx    = 0;
    this._barCounter  = 0;
  }

  render(ctx, W, H, audioData, config) {
    const { bass = 0, mid = 0, amplitude = 0, isBeat = false } = audioData || {};
    const sp = config.spiral || {};
    const {
      speed = 1, brightness = 1, sensitivity = 1, palette, customColor, show = {},
    } = config;

    const dt = frameDt(config);
    const f = dt * 60;
    this._time += dt * speed;

    // Beat treibt die Drehung an - klingt danach wieder ab, statt
    // konstant zu rotieren wie ein Bildschirmschoner.
    if (isBeat) {
      this._rotVelocity += 0.05 * sensitivity;
      this._barCounter++;
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % 8;
      } else if (show.colorMode === 'bar' && this._barCounter % 4 === 0) {
        this._colorIdx = (this._colorIdx + 1) % 8;
      }
    }
    this._rotVelocity *= decayFor(0.96, dt);
    this._rotation += (0.05 + this._rotVelocity) * speed * 0.35 * f;

    const targetZoom = clamp(sp.zoom ?? 1, 0.3, 2) * (1 + bass * sensitivity * 0.2);
    this._zoom += (targetZoom - this._zoom) * approachFor(0.08, dt);

    const { cx, cy } = effectOrigin(config, W, H);
    const maxR   = Math.min(W, H) * 0.46 * this._zoom;
    const arms   = clamp(Math.round(sp.arms ?? 3), 1, 8);
    const turns  = clamp(sp.turns ?? 2.2, 0.5, 5);
    const thickness = clamp(sp.thickness ?? 1.6, 0.5, 6) * (config.thicknessMul || 1);
    const colors = getPaletteColors(palette, customColor);

    const segments = 8;   // Blanking-Segmente pro Arm
    const gap = 0.05;
    const stepsPerSeg = 14;

    for (let arm = 0; arm < arms; arm++) {
      const armOffset = (arm / arms) * TAU;
      const color = colors[(this._colorIdx + arm) % colors.length];
      const armIntensity = clamp01((0.55 + amplitude * sensitivity * 0.4) * brightness);

      for (let s = 0; s < segments; s++) {
        const from = s / segments;
        const to = (s + 1) / segments - gap;

        strokeLaserPath(ctx, () => {
          for (let i = 0; i <= stepsPerSeg; i++) {
            const t = from + (to - from) * (i / stepsPerSeg);
            const angle = armOffset + this._rotation + t * TAU * turns;
            const wobble = Math.sin(t * 14 + this._time * 2) * bass * sensitivity * maxR * 0.03;
            const r = t * maxR + wobble;
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
        }, color, armIntensity * (0.4 + from * 0.6), thickness * (0.5 + from * 0.6));
      }
    }
  }
}
