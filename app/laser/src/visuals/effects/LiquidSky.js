// ============================================================
// LiquidSky.js – Liquid Sky Aerial Effekt
// Mehrere unabhängige horizontale Laser-Ebenen über dem Publikum.
//
// War vorher ein Fächer eng verwandter Strahlen, die alle auf
// derselben schmalen Höhenbande hingen und sich nur gemeinsam als
// Gruppe bewegten - wirkte über die Zeit statisch. Jetzt hat jeder
// Strahl seine eigene Höhe, seinen eigenen Neigungswinkel und seine
// eigene Drift-Geschwindigkeit: sie wandern unabhängig um eine
// gemeinsame Grundhöhe (`height`) und kippen dabei jeder für sich,
// statt als starre Gruppe zusammenzuhängen.
//
// Auf dem Beat reagiert immer einer der Strahlen - standardmäßig mit
// einem Tempo-Schub (er rauscht kurz schneller durch seine
// Wanderbewegung, bleibt aber auf seiner Bahn, kein Sprung). Nur mit
// `beatSwitch` an springt er stattdessen hart zu einer komplett neuen
// Zufallshöhe. "Schnelleres Movement statt Teleport" ist also der
// Standard, der Sprung ein bewusst zugeschalteter Extra-Kick.
// ============================================================

import { getPaletteColors, drawLaserLine, frameDt, decayFor } from '../../shared/Config.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export class LiquidSky {
  constructor() {
    this._time       = 0;
    this._colorIdx   = 0;
    this._barCounter = 0;
    this._beams      = []; // je Strahl: { yBase, yFreq, yPhaseAcc, yAmp, speedBoost, angleBase, angleFreq, anglePhase, angleAmp, jumpY }
  }

  init() {
    this._beams = [];
  }

  /** Zufällige Ziel-Höhe um die konfigurierte Grundhöhe herum. */
  _randomYBase(baseHeight, spread) {
    return clamp01(baseHeight + (Math.random() - 0.5) * spread * 2);
  }

  /** Erzeugt/kürzt den Pool an unabhängigen Strahlen auf `n` Stück. */
  _ensureBeams(n, baseHeight, spread) {
    while (this._beams.length < n) {
      this._beams.push({
        // Um die konfigurierte Grundhöhe verteilte Startposition +
        // eigene, langsame Wander-Bewegung darum herum.
        yBase:  this._randomYBase(baseHeight, spread),
        yFreq:  0.04 + Math.random() * 0.10,
        // Eigener, laufender Phasen-Zähler statt Ableitung aus der
        // globalen Zeit - nur so kann EIN Strahl auf dem Beat
        // vorübergehend schneller durch seine Wanderbewegung rauschen,
        // ohne dass alle anderen mit-beschleunigen.
        yPhaseAcc: Math.random() * TAU,
        yAmp:   0.12 + Math.random() * 0.22,
        // Klingt nach einem Beat-Tempo-Schub wieder ab (siehe render).
        speedBoost: 0,
        // Eigene Grundneigung plus eigenes langsames Kippen - jeder
        // Strahl dreht sich unabhängig von den anderen.
        angleBase:  (Math.random() - 0.5) * 0.5,
        angleFreq:  0.03 + Math.random() * 0.09,
        anglePhase: Math.random() * TAU,
        angleAmp:   (10 + Math.random() * 22) * (Math.PI / 180),
        jumpY: 0, // zusätzlicher Sprung-Offset (nur im Teleport-Modus), klingt ab
      });
    }
    if (this._beams.length > n) this._beams.length = n;
  }

  render(ctx, W, H, audioData, config) {
    const { bass, mid, amplitude, isBeat } = audioData;
    const { liquidSky, speed, brightness, sensitivity, palette, customColor, show } = config;

    const dt = frameDt(config);
    this._time += dt * speed;

    const colors = getPaletteColors(palette, customColor);
    // "Anzahl" ist die Zahl der SICHTBAREN Balken, nicht der
    // unabhängigen Strahlen: mit globalem Spiegeln an zeichnet die
    // Schleife unten pro Strahl eine zweite, gespiegelte Linie - ohne
    // diese Halbierung hier verdoppelte sich die Balkenzahl heimlich
    // (in Build/Climax steht Spiegeln standardmäßig an), was bei vielen
    // unabhängig wandernden Strahlen schnell nach "viel zu viele
    // Balken" aussieht statt nach der sauberen Symmetrie, die Spiegeln
    // bei einfacheren Effekten ergibt.
    const configuredCount = Math.max(2, Math.min(12, liquidSky.beamCount));
    const n = show.mirror ? Math.max(2, Math.round(configuredCount / 2)) : configuredCount;
    // Grundhöhe der Ebene (0=oben) - vorher komplett ignoriert, jeder
    // Strahl bekam unabhängig davon eine Zufallsposition über die
    // ganze Bildhöhe. Jetzt der Mittelpunkt, um den herum die Strahlen
    // streuen und wandern.
    const baseHeight = clamp01(Number(liquidSky.height ?? 0.30));
    const heightSpread = 0.28;
    this._ensureBeams(n, baseHeight, heightSpread);

    // ── Beat: Farbwechsel + einer der Strahlen reagiert ──────
    // Standard: Tempo-Schub (schnelleres Movement) - der Strahl
    // rauscht kurz schneller durch seine Wanderbewegung und klingt
    // wieder ab, bleibt dabei aber immer auf seiner Bahn. Nur mit
    // `beatSwitch` an springt er stattdessen hart zu einer neuen
    // Zufallshöhe (Teleport-Modus, siehe Dateikopf).
    if (isBeat) {
      this._barCounter++;
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      } else if (show.colorMode === 'bar' && this._barCounter % 4 === 0) {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
      const b = this._beams[Math.floor(Math.random() * this._beams.length)];
      if (liquidSky.beatSwitch) {
        b.yBase = this._randomYBase(baseHeight, heightSpread);
        b.jumpY = (Math.random() - 0.5) * 0.25 * sensitivity;
      } else {
        b.speedBoost = 1.4 + Math.random() * 1.6 * sensitivity;
      }
    }
    for (const b of this._beams) {
      b.jumpY *= decayFor(0.88, dt);
      // Tempo-Schub klingt über gut 20 Frames ab (~1/3s bei 60fps) -
      // spürbar schneller, aber kein harter Sprung in der Geschwindigkeit.
      b.speedBoost *= decayFor(0.9, dt);
      b.yPhaseAcc += dt * speed * b.yFreq * TAU * (1 + b.speedBoost);
    }

    const spreadDeg = Math.min(60, Math.max(0, liquidSky.spread));
    const spreadRad = (spreadDeg / 180) * Math.PI;

    // ── Strahlen zeichnen ───────────────────────────────────
    for (let i = 0; i < n; i++) {
      const b = this._beams[i];

      // Höhe: eigene Basis + eigene Wanderbewegung (eigener Phasen-
      // Zähler, siehe _ensureBeams) + kurzer Beat-Sprung im
      // Teleport-Modus, der ausklingt.
      const yT = clamp01(b.yBase + Math.sin(b.yPhaseAcc) * b.yAmp + b.jumpY);
      const beamY = yT * H;

      // Neigung: eigene Grundneigung + eigenes langsames Kippen +
      // etwas Bass-Wackeln + der konfigurierte Spread als Rahmen.
      const wobble = Math.sin(this._time * 0.5 + i * 0.7) * bass * sensitivity * 0.05;
      const beamAngle = b.angleBase
        + Math.sin(this._time * b.angleFreq * TAU + b.anglePhase) * b.angleAmp
        + wobble
        + (spreadRad > 0 ? (i / Math.max(1, n - 1) - 0.5) * spreadRad * 0.3 : 0);

      const halfW  = W / 2;
      const dy     = Math.tan(beamAngle) * halfW;
      const x1 = 0;
      const y1 = beamY - dy;
      const x2 = W;
      const y2 = beamY + dy;

      const baseInt   = (0.5 + amplitude * sensitivity * 0.4) * brightness;
      const intensity = Math.min(1, baseInt + (isBeat ? 0.2 : 0));
      const color     = colors[(this._colorIdx + Math.floor(i / 2)) % colors.length];
      const baseThick = liquidSky.thickness * (config.thicknessMul || 1.0);

      drawLaserLine(ctx, x1, y1, x2, y2, color, intensity, baseThick);

      if (show.mirror) {
        drawLaserLine(ctx, x2, y1, x1, y2, color, intensity * 0.7, baseThick);
      }
    }
  }
}
