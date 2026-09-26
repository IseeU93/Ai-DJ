// ============================================================
// Snake.js – Wandernde Laser-Schlange
//
// Ein einzelner Kopf wandert in sanften, zufälligen Kurven über die
// GANZE Fläche (kein fester Ursprung, kein Zentrum) und hinterlässt
// eine Spur - wie eine Schlange, die durch den Nebel gleitet. Auf
// jedem Beat bekommt der Kopf einen kurzen Schub nach vorn (schneller,
// nicht abrupt die Richtung wechselnd), fällt danach zurück auf
// Grundtempo. Gedacht für ruhige, wenig ereignisreiche Passagen -
// bewegt sich immer, auch ganz ohne Musik.
// ============================================================

import { getPaletteColors, strokeLaserPath } from '../../shared/Config.js';

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);

export class Snake {
  constructor() {
    this._time     = 0;
    this._angle    = Math.random() * Math.PI * 2;
    this._x        = 0.5;   // normiert 0..1, wird beim ersten Frame zentriert
    this._y        = 0.5;
    this._speedPump = 0;    // klingt nach jedem Beat-Schub wieder ab
    this._trail    = null;  // { x, y }[], normierte Koordinaten
    this._colorIdx = 0;
  }

  render(ctx, W, H, audioData, config) {
    const { amplitude = 0, isBeat = false } = audioData || {};
    const sn = config.snake || {};
    const {
      speed = 1, brightness = 1, sensitivity = 1, palette, customColor, show = {},
    } = config;

    const dt = 1 / 60;
    this._time += dt * speed;

    const colors = getPaletteColors(palette, customColor);
    if (!this._trail) {
      this._trail = [{ x: this._x, y: this._y }];
      if (show.colorMode) this._colorIdx = 0;
    }

    if (isBeat) {
      this._speedPump = clamp(sn.pushStrength ?? 0.6, 0, 1.5);
      if (show.colorMode === 'beat') this._colorIdx = (this._colorIdx + 1) % colors.length;
    }
    this._speedPump *= 0.9; // klingt in ~20 Frames ab, kein harter Sprung

    // Sanftes Zufalls-Schlängeln: der Winkel driftet, statt zu springen -
    // das ergibt eine weiche Kurve statt eines Zickzacks.
    this._angle += (Math.random() - 0.5) * clamp(sn.wiggle ?? 0.5, 0, 1) * 0.5;

    // Sanftes Gegenlenken statt hartem Abprall: je näher der Kopf an
    // den Rand kommt, desto stärker biegt sich der Winkel zur Mitte -
    // kein abruptes Umdrehen mehr, das wie Wackeln aussah.
    const edgeMargin = 0.14;
    const distToEdge = Math.min(this._x, 1 - this._x, this._y, 1 - this._y);
    if (distToEdge < edgeMargin) {
      const pull = 1 - clamp01(distToEdge / edgeMargin);
      const towardCentre = Math.atan2(0.5 - this._y, 0.5 - this._x);
      let diff = towardCentre - this._angle;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // auf -π..π normieren
      this._angle += diff * pull * 0.15;
    }

    const baseSpeed = clamp(sn.speed ?? 1, 0.2, 3) * 0.12;
    const travel = baseSpeed * dt * speed * (1 + this._speedPump + amplitude * sensitivity * 0.3);

    // Kleine Sicherheitsmarge, falls das Gegenlenken bei extremem
    // Tempo/Wiggle doch mal nicht schnell genug greift.
    this._x = clamp(this._x + Math.cos(this._angle) * travel, 0.01, 0.99);
    this._y = clamp(this._y + Math.sin(this._angle) * travel, 0.01, 0.99);
    this._trail.push({ x: this._x, y: this._y });

    // Deutlich länger als vorher (46) - eine Spur, die man wirklich
    // als durchgehende Linie über einen großen Teil der Fläche liest.
    const maxTrail = clamp(Math.round(sn.length ?? 220), 12, 500);
    while (this._trail.length > maxTrail) this._trail.shift();

    const color = colors[this._colorIdx % colors.length];
    const thickness = clamp(sn.thickness ?? 1.6, 0.5, 6) * (config.thicknessMul || 1);
    const intensity = clamp01(brightness * (0.55 + amplitude * sensitivity * 0.35));

    if (this._trail.length >= 2) {
      strokeLaserPath(ctx, () => {
        this._trail.forEach((p, i) => {
          const x = p.x * W;
          const y = p.y * H;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
      }, color, intensity, thickness);
    }

    // Heller Kopf am vorderen Ende, damit die Bewegungsrichtung lesbar bleibt.
    const head = this._trail[this._trail.length - 1];
    strokeLaserPath(ctx, () => {
      ctx.arc(head.x * W, head.y * H, thickness * 0.9, 0, Math.PI * 2);
    }, color, clamp01(intensity * 1.2), thickness * 0.6);
  }
}
