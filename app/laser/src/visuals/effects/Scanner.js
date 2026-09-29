// ============================================================
// Scanner.js – Galvo-Scanner / Fächer-Effekt
// DAS ikonischste Laser-Element: schnell sweepende Strahlen
//
// Authentische Modi:
//   sweep  – Pendel-Bewegung, erzeugt Fächer via Trail
//   snap   – Strahl springt auf Beat zu neuen Winkeln (sehr dramatisch)
//   fan    – Mehrere Strahlen gleichzeitig als statischer Fächer
//   cross  – Zwei Strahlen kreuzen sich gegenläufig
// ============================================================

import { getPaletteColors, drawLaserLine, effectOrigin, perimeterPoint, frameDt, approachFor, beatClock } from '../../shared/Config.js';

// Preset-Winkel für Snap-Modus (typische Scanner-Positionen)
const SNAP_PRESETS = [-70, -45, -20, 0, 20, 45, 70].map(d => (d / 180) * Math.PI);

// Ausrichtung: von welcher Kante aus schwenkt der Scanner? 'auto'
// (Standard) dreht den Ansatzpunkt selbstständig einmal komplett rum -
// ein echter Galvo-Kopf klebt nicht an "oben", er kann in jede
// Richtung feuern. 'oben'/'unten'/'links'/'rechts' fixieren dieselbe
// Sweep-/Snap-/Fan-/Cross-Logik auf eine feste Kante, falls das
// gewünscht ist. 'edge' simuliert einen wand-/deckenmontierten
// Projektor: der Scanner setzt seinen Ursprung dann SELBST auf den
// Bildrand, wandert dort im Takt entlang, teleportiert gelegentlich
// an eine neue Randposition - und richtet den Fächer automatisch
// nach innen aus. Das läuft bewusst unabhängig von der globalen
// "Mittelpunkt"-Einstellung: vorher musste man zusätzlich
// originMotion:'edge' setzen, sonst stand der Scanner weiter in der
// Bildmitte und der Modus sah aus, als würde er gar nichts tun.
const ORIENTATION_OFFSET = {
  up: 0,
  down: Math.PI,
  left: -Math.PI / 2,
  right: Math.PI / 2,
};
const TAU = Math.PI * 2;
// Eine volle Umdrehung alle 45s bei speed=1 - langsam genug, dass man
// dem Fächer beim Wandern folgen kann, statt dass er nur wirr dreht.
const AUTO_ROTATION_RATE = TAU / 45;

export class Scanner {
  constructor() {
    this._angle     = 0;          // aktueller Sweep-Winkel (relativ zu oben)
    this._dir       = 1;          // Richtung: +1 oder -1
    this._crossAngle = Math.PI / 4; // Gegenwinkel für Cross-Modus
    this._crossDir  = -1;
    this._time      = 0;
    this._colorIdx  = 0;
    this._snapIdx   = 0;          // Index in SNAP_PRESETS
    this._snapTarget = 0;
    this._barCounter = 0;         // Takt-Zähler für Bar-Farbwechsel
    this._edgePhase  = Math.random();  // Position auf der Randbahn (0..1)
    this._edgeLastBeat = false;
  }

  /**
   * orientation:'edge' – wandernder Ursprung auf dem Bildrand plus
   * die dazu passende Richtung "nach innen". Wandert stetig im Takt
   * und springt auf Beats gelegentlich an eine ganz andere
   * Randposition, damit es nicht nur gleichmäßig kriecht.
   */
  _edgePlacement(W, H, audioData, speed, dt = 1 / 60) {
    const bpm = Number(audioData?.bpm) > 0 ? Number(audioData.bpm) : 120;
    const beatsPerSecond = bpm / 60;

    // Ein voller Umlauf über ~16 Takte, mit dem Songtempo skaliert.
    this._edgePhase += dt * (beatsPerSecond / 64) * Math.max(0.2, speed);

    const isBeat = Boolean(audioData?.isBeat);
    if (isBeat && !this._edgeLastBeat && Math.random() < 0.12) {
      // Teleport an eine deutlich andere Stelle des Rands.
      this._edgePhase += 0.2 + Math.random() * 0.5;
    }
    this._edgeLastBeat = isBeat;

    const p = perimeterPoint(this._edgePhase);
    return { cx: p.x * W, cy: p.y * H, aim: p.aim };
  }

  render(ctx, W, H, audioData, config) {
    const { bass, mid, amplitude, isBeat } = audioData;
    const { scanner, speed, brightness, sensitivity, palette, customColor, show } = config;

    const dt = frameDt(config);
    this._time += dt * speed;

    // Im Rand-Modus bestimmt der Scanner Ursprung UND Blickrichtung
    // selbst; sonst gilt der globale, wandernde Effekt-Ursprung.
    const edgeMode = scanner.orientation === 'edge';
    const placement = edgeMode
      ? this._edgePlacement(W, H, audioData, speed, dt)
      : effectOrigin(config, W, H);
    const { cx, cy } = placement;
    const aim = placement.aim || 0;
    const len    = Math.hypot(W, H);
    const colors = getPaletteColors(palette, customColor);

    // Sweep-Bereich in Radiant
    const sweepRad = (Math.min(360, Math.max(10, scanner.sweepWidth)) / 180) * Math.PI;

    // Sweep-Geschwindigkeit: Bass erhöht Geschwindigkeit (echtes Scanner-Verhalten)
    const baseSpeed = scanner.sweepSpeed * speed * 0.028;
    const sweepRate = baseSpeed * (1 + bass * sensitivity * 0.8);

    // ── Farbwechsel-Logik ──────────────────────────────────
    if (isBeat) {
      this._barCounter++;
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      } else if (show.colorMode === 'bar' && this._barCounter % 4 === 0) {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
    }

    const mode  = scanner.mode;
    const count = Math.max(1, Math.min(8, scanner.count));
    
    const bIndex = audioData.beatIndex !== undefined ? audioData.beatIndex : 0;

    // ── SWEEP-Modus: Pendelbewegung ─────────────────────────
    // Taktsynchron an der Beat-Uhr: je nach Tempo-Stufe ein Hin und Her
    // über 4, 2 oder 1 Takt (bzw. zweimal pro Takt). Die Phase wird
    // aufsummiert statt aus der Takt-Phase gerechnet - vorher sprang der
    // Strahl bei langsamer Stufe auf jeder Eins zurück an den Anfang und
    // beim Wechsel der Stufe mitten im Schwung an eine andere Stelle.
    if (mode === 'sweep' || mode === 'cross') {
      const beat = beatClock(config, this._time);
      const dBeat = this._lastBeat === undefined ? 0 : Math.max(0, Math.min(1, beat - this._lastBeat));
      this._lastBeat = beat;
      const freq = speed < 0.45 ? 0.25 : speed < 0.9 ? 0.5 : speed < 1.5 ? 1 : 2;
      this._sweepPhase = ((this._sweepPhase || 0) + (dBeat / 4) * freq) % 1;
      const p = this._sweepPhase * Math.PI * 2;
      this._angle = Math.sin(p) * (sweepRad / 2);

      if (mode === 'cross') {
        // Gegenläufiger zweiter Strahl (Phasenverschoben)
        this._crossAngle = Math.cos(p) * (sweepRad / 2);
      }
    } else {
      this._lastBeat = beatClock(config, this._time);
    }

    // ── SNAP-Modus: springt auf Beat ───────────────────────
    if (mode === 'snap') {
      // Feste Zuordnung von Beat zu Position (immer synchron!)
      // 3 ist die Mitte (0 Grad). 
      // Sequenz: Mitte, Rechts, Mitte, Links
      const SNAP_SEQ = [3, 5, 3, 1];
      
      // Bei sehr hoher Eskalation auf jedem zweiten Schlag eine zufällige
      // Position - aber einmal pro Schlag gewürfelt. Vorher wurde in jedem
      // Bild neu gewürfelt: der Strahl zitterte den ganzen Schlag lang
      // zwischen allen Positionen hin und her.
      const beatKey = Math.floor(beatClock(config, this._time));
      if (beatKey !== this._snapBeatKey) {
        this._snapBeatKey = beatKey;
        this._snapRandom = SNAP_PRESETS[Math.floor(Math.random() * SNAP_PRESETS.length)];
      }
      this._snapTarget = speed > 1.5 && bIndex % 2 !== 0
        ? this._snapRandom
        : SNAP_PRESETS[SNAP_SEQ[bIndex % SNAP_SEQ.length]];

      // Sehr schnelle Interpolation → wirkt fast wie Snap
      this._angle += (this._snapTarget - this._angle) * approachFor(0.45, dt);
    }

    // ── FAN-Modus: mehrere statische Strahlen ──────────────
    if (mode === 'fan') {
      // Fächer bewegt sich langsam als Gruppe
      this._angle = Math.sin(this._time * 0.3) * sweepRad * 0.15;
    }

    // ── Strahlen zeichnen ──────────────────────────────────
    const color     = colors[this._colorIdx % colors.length];
    const altColor  = colors[(this._colorIdx + 1) % colors.length];
    const intensity = Math.min(1, (0.65 + amplitude * sensitivity * 0.35) * brightness);
    const baseThick = scanner.thickness * (config.thicknessMul || 1.0);

    let baseOffset;
    if (edgeMode) {
      baseOffset = aim;
    } else if (scanner.orientation && scanner.orientation !== 'auto') {
      baseOffset = ORIENTATION_OFFSET[scanner.orientation] ?? 0;
    } else {
      // Auto: freie, durchgehende Drehung - unverändert, solange der
      // Ursprung in der Mitte sitzt. Wandert der Ursprung (Mittelpunkt-
      // Modus "Wandern"/"Springen"/"Rand"), zog der Fächer bisher genauso
      // frei weiter und zeigte dabei zeitweise klar von der sichtbaren
      // Fläche weg. Jetzt bekommt die Drehung einen sanften Sog Richtung
      // Bildmitte (aim, siehe effectOrigin) - stärker, je weiter der
      // Ursprung vom Zentrum entfernt ist, aber nie hart genug, um die
      // Drehung anzuhalten: der Fächer läuft weiter voll herum, verweilt
      // nur seltener genau auf dem Weg nach draußen.
      const freeRotation = this._time * AUTO_ROTATION_RATE;
      const distFromCentre = Math.min(1,
        Math.hypot(cx - W / 2, cy - H / 2) / (Math.min(W, H) / 2 || 1));
      let diff = aim - freeRotation;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      baseOffset = freeRotation + diff * distFromCentre * 0.3;
    }

    if (mode === 'fan') {
      // Alle Strahlen gleichzeitig über den Sweep-Bereich verteilt
      for (let i = 0; i < count; i++) {
        const fanAngle = -sweepRad / 2 + (i / Math.max(1, count - 1)) * sweepRad + this._angle;
        const c = colors[i % colors.length];
        this._drawBeam(ctx, cx, cy, fanAngle, baseOffset, len, c, intensity, baseThick, show.mirror);
      }
    } else if (mode === 'cross') {
      // Haupt-Strahl
      this._drawBeam(ctx, cx, cy, this._angle, baseOffset, len, color, intensity, baseThick, false);
      // Gegen-Strahl
      this._drawBeam(ctx, cx, cy, this._crossAngle, baseOffset, len, altColor, intensity, baseThick, false);
    } else {
      // Sweep / Snap: count Strahlen mit leichtem Versatz
      for (let i = 0; i < count; i++) {
        const offset = count > 1 ? ((i / (count - 1)) - 0.5) * 0.1 * sweepRad : 0;
        const c = colors[(this._colorIdx + i) % colors.length];
        this._drawBeam(ctx, cx, cy, this._angle + offset, baseOffset, len, c, intensity, baseThick, show.mirror);
      }
    }
  }

  _drawBeam(ctx, cx, cy, angle, baseOffset, len, color, intensity, thickness, mirror) {
    // Konvention: angle=0 = gerade nach oben, positiv = rechts.
    // baseOffset dreht diesen Nullpunkt auf eine andere Kante (unten/
    // links/rechts) - der Fächer selbst (Sweep/Snap/Fan/Cross) bleibt
    // exakt derselbe, schwenkt nur von dort aus.
    const a = angle + baseOffset - Math.PI / 2;
    const x2 = cx + Math.cos(a) * len;
    const y2 = cy + Math.sin(a) * len;

    drawLaserLine(ctx, cx, cy, x2, y2, color, intensity, thickness);

    if (mirror) {
      // Achsenspiegelung um dieselbe Achse wie der Ansatzpunkt: nur die
      // Schwenkbewegung wird gespiegelt, die Ausrichtung bleibt fix.
      const ma = -angle + baseOffset - Math.PI / 2;
      const mx2 = cx + Math.cos(ma) * len;
      const my2 = cy + Math.sin(ma) * len;
      drawLaserLine(ctx, cx, cy, mx2, my2, color, intensity * 0.9, thickness);
    }
  }
}
