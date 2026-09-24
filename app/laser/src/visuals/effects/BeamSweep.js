// ============================================================
// BeamSweep.js – Balken-Sweep über den ganzen Bildschirm
//
// Ein (oder mehrere parallele) voller Bildschirm-Balken, die auf
// jedem Beat von einer Kante zur gegenüberliegenden durchlaufen -
// oben↔unten, links↔rechts oder diagonal. `count` regelt, ob nur
// EIN Balken läuft oder viele gleichzeitig - bei vielen ähnlich wie
// LiquidSky, aber alle Balken bewegen sich gemeinsam in dieselbe
// Richtung statt unabhängig zu driften.
//
// Kein Ursprungspunkt, kein Verblassen mittendrin: ein Durchlauf ist
// fertig, sobald er komplett über den Bildrand hinausgelaufen ist.
// ============================================================

import { getPaletteColors, drawLaserLine } from '../../shared/Config.js';

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);
const SQRT1_2 = Math.SQRT1_2;

// dir = Bewegungsrichtung. Bei 'diagonal' laufen die Balken schräg
// durchs Bild statt achsparallel.
const ORIENTATIONS = {
  vertical:   [{ x: 0, y: 1 }, { x: 0, y: -1 }],
  horizontal: [{ x: 1, y: 0 }, { x: -1, y: 0 }],
  diagonal:   [
    { x: SQRT1_2, y: SQRT1_2 }, { x: -SQRT1_2, y: SQRT1_2 },
    { x: SQRT1_2, y: -SQRT1_2 }, { x: -SQRT1_2, y: -SQRT1_2 },
  ],
};
const ORIENTATION_KEYS = ['vertical', 'horizontal', 'diagonal'];

export class BeamSweep {
  constructor() {
    this._time = 0;
    this._colorIdx = 0;
    this._sweeps = [];   // aktive Durchläufe: { time, dir, perp, bars, travelDist, colorIdx }
    this._spawnAcc = 0;
  }

  init() {
    this._sweeps = [];
    this._spawnAcc = 0;
  }

  render(ctx, W, H, audioData, config) {
    const { amplitude = 0, isBeat = false, bpm } = audioData || {};
    const bs = config.beamSweep || {};
    const {
      speed = 1, brightness = 1, sensitivity = 1, palette, customColor,
    } = config;

    const dt = 1 / 60;
    this._time += dt * speed;

    const colors = getPaletteColors(palette, customColor);
    const beatsPerSecond = (Number(bpm) > 0 ? bpm : 128) / 60;
    const rushBase = clamp(bs.speed ?? 1, 0.2, 10);
    // Über 3 = "harter" Modus für Hardstyle/Uptempo-Kicks: der Balken peitscht in ~2 Schlägen
    // über den ganzen Schirm. Bis 3 bleibt alles wie bisher (ruhiger Scanner).

    // ── Beat-Synchronisation: ein Durchlauf startet auf dem Beat -
    // aber jetzt mit Spawn-Gate. Ein Durchlauf braucht (durch das
    // langsamere Scanner-Tempo) mehrere Takte, um den Bildschirm zu
    // queren - würde weiterhin jeder Beat einen neuen Durchlauf
    // starten, würden sich viele Balken gleichzeitig stapeln statt
    // wie ein ruhiger Scanner zu wirken. Deshalb: solange schon
    // maxConcurrent Durchläufe unterwegs sind, wird kein neuer
    // gestartet (kein Abschneiden - reine Spawn-Bremse).
    const maxConcurrent = rushBase > 3 ? 3 : 2;
    if (isBeat) {
      if (this._sweeps.length < maxConcurrent) this._spawnSweep(colors, W, H, bs);
      this._spawnAcc = 0;
    } else {
      this._spawnAcc += dt * beatsPerSecond * Math.min(rushBase, 3) * 0.4;
      if (this._spawnAcc >= 1) {
        this._spawnAcc -= 1;
        if (this._sweeps.length < maxConcurrent) this._spawnSweep(colors, W, H, bs);
      }
    }

    // Deutlich langsamer als vorher (0.4 + rush*0.4 war praktisch ein
    // Sprint über den ganzen Bildschirm) und jetzt am echten Takt
    // orientiert statt an einer festen Basisgeschwindigkeit - soll
    // sich "wie ein Scanner" bewegen, nicht wie ein Warp-Sprung.
    const perBeat = rushBase <= 3 ? 0.045 + rushBase * 0.045 : 0.18 + (rushBase - 3) * 0.06;
    const speedPxPerSec = Math.hypot(W, H) * beatsPerSecond * perBeat;
    const thickness = clamp(bs.thickness ?? 2, 0.5, 6) * (config.thicknessMul || 1);
    const halfLen = Math.hypot(W, H); // lang genug für jede Orientierung

    this._sweeps = this._sweeps.filter((s) => (this._time - s.time) * speedPxPerSec < s.travelDist);

    for (const sweep of this._sweeps) {
      const age = this._time - sweep.time;
      const dist = age * speedPxPerSec;
      // Nur kurz einblenden - kein Ausblenden, der Balken läuft mit
      // voller Helligkeit vom Bildschirm statt zu verblassen.
      const fadeIn = clamp01(age / 0.08);
      const intensity = clamp01(brightness * fadeIn * (0.6 + amplitude * sensitivity * 0.35));
      if (intensity <= 0.02) continue;

      const color = colors[sweep.colorIdx % colors.length];
      for (const bar of sweep.bars) {
        const px = bar.x + sweep.dir.x * dist;
        const py = bar.y + sweep.dir.y * dist;
        const x1 = px - sweep.perp.x * halfLen;
        const y1 = py - sweep.perp.y * halfLen;
        const x2 = px + sweep.perp.x * halfLen;
        const y2 = py + sweep.perp.y * halfLen;
        drawLaserLine(ctx, x1, y1, x2, y2, color, intensity, thickness);
      }
    }
  }

  /** Startet einen neuen Durchlauf: `count` parallele Balken, die gemeinsam in `dir` laufen. */
  _spawnSweep(colors, W, H, bs) {
    this._colorIdx = (this._colorIdx + 1) % colors.length;

    const orientationKey = bs.orientation && bs.orientation !== 'auto'
      ? bs.orientation
      : ORIENTATION_KEYS[Math.floor(Math.random() * ORIENTATION_KEYS.length)];
    const variants = ORIENTATIONS[orientationKey] || ORIENTATIONS.vertical;
    const dir = variants[Math.floor(Math.random() * variants.length)];
    const perp = { x: -dir.y, y: dir.x };

    const count = clamp(Math.round(bs.count ?? 1), 1, 12);
    const margin = Math.min(W, H) * 0.15;
    const travelDist = Math.hypot(W, H) + margin * 2;

    const cx = W / 2;
    const cy = H / 2;
    const startBaseX = cx - dir.x * (travelDist / 2);
    const startBaseY = cy - dir.y * (travelDist / 2);

    const spacing = Math.hypot(W, H) * 0.45 / Math.max(1, count);
    const bars = [];
    for (let i = 0; i < count; i++) {
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * spacing;
      bars.push({ x: startBaseX + perp.x * offset, y: startBaseY + perp.y * offset });
    }

    this._sweeps.push({ time: this._time, dir, perp, bars, travelDist, colorIdx: this._colorIdx });
  }
}
