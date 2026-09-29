// ============================================================
// HotBeams.js – Club-Beams mit echter Bewegung
//
// Bisherige Probleme (und was sich geändert hat):
//
//  1. "leuchtet nur links": Der Fächer wurde von 180°–360° gebaut
//     und beim Zeichnen nochmals um -90° gedreht. Ergebnis war ein
//     Halbkreis von unten über links nach oben – der Fächer stand
//     also seitlich statt nach oben. Jetzt wird symmetrisch um die
//     Senkrechte gebaut (-spread/2 … +spread/2 um "oben").
//
//  2. "flackert": Der Strobe blendete die Strahlen zwischen zwei
//     Sub-Beats komplett aus (hartes Blanking). Ohne stabiles
//     Beat-Grid – oder bei hoher Subdivision – wirkte das wie
//     Bildfehler. Es gibt jetzt drei Strobe-Modi, Standard ist
//     'pulse': die Strahlen bleiben sichtbar und werden im Beat
//     lediglich heller (Hüllkurve statt An/Aus).
//
//  3. "dreht sich nicht": Die Strahlen standen absolut still.
//     Jetzt gibt es Bewegungsmodi (sweep/rotate/breathe/static),
//     die an Tempo und Energie hängen.
// ============================================================

import { getPaletteColors, drawLaserLine, colorWithAlpha, effectOrigin, projectDirection, frameDt, decayFor, approachFor } from '../../shared/Config.js';

const TAU = Math.PI * 2;
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const clamp01 = (v) => clamp(Number(v) || 0, 0, 1);

export class HotBeams {
  constructor() {
    this._baseAngles  = [];  // Grundwinkel, 0 = senkrecht nach oben
    this._beamXPos    = [];  // für Parallel-Modus
    this._time        = 0;
    this._motionPhase = 0;   // Bewegungsphase (sweep/rotate)
    this._colorIdx    = 0;
    this._lastSubBeat = -1;
    this._flash       = 0;   // Hüllkurve 0..1 des letzten Sub-Beat-Pulses
    this._beatAngle   = 0;
    this._signature   = '';  // erkennt Arrangement-Änderungen
  }

  init(config) {
    this._buildArrangement(config);
  }

  _signatureOf(hb) {
    return `${hb.arrangement}:${hb.count}:${Math.round((hb.spread ?? 160) * 10)}`;
  }

  _buildArrangement(config) {
    const hb = config.hotBeams || {};
    const n  = Math.max(2, Math.min(16, Math.round(hb.count) || 8));
    const spreadRad = (clamp(Number(hb.spread ?? 160), 20, 360) / 180) * Math.PI;

    this._baseAngles = [];
    this._beamXPos   = [];

    switch (hb.arrangement) {
      case 'star':
        // Voller 360°-Stern, gleichmäßig verteilt.
        for (let i = 0; i < n; i++) this._baseAngles.push((i / n) * TAU);
        break;

      case 'parallel':
        // Senkrechte Parallelen; Winkel bleibt "oben".
        for (let i = 0; i < n; i++) {
          this._beamXPos.push(n === 1 ? 0.5 : i / (n - 1));
          this._baseAngles.push(0);
        }
        break;

      case 'cross': {
        // X-förmige Kreuzung, symmetrisch um die Senkrechte.
        const base = [45, -45, 135, -135, 20, -20, 90, -90];
        for (let i = 0; i < n; i++) {
          this._baseAngles.push((base[i % base.length] / 180) * Math.PI);
        }
        break;
      }

      case 'fan':
      default:
        // Symmetrischer Fächer um die Senkrechte (0 = oben).
        for (let i = 0; i < n; i++) {
          const t = n === 1 ? 0.5 : i / (n - 1);
          this._baseAngles.push(-spreadRad / 2 + t * spreadRad);
        }
        break;
    }

    this._signature = this._signatureOf({ ...hb, count: n });
  }

  render(ctx, W, H, audioData, config) {
    const { bass = 0, isBeat = false } = audioData || {};
    const hb = config.hotBeams || {};
    const {
      speed = 1, brightness = 1, sensitivity = 1,
      palette, customColor, show = {},
    } = config;

    const dt = frameDt(config);
    this._time += dt * speed;

    const colors = getPaletteColors(palette, customColor);
    const { cx, cy } = effectOrigin(config, W, H);
    const len = Math.hypot(W, H);

    // Arrangement bei Änderungen neu aufbauen (Anzahl, Form, Spreizung).
    const signature = this._signatureOf({
      arrangement: hb.arrangement,
      count: Math.max(2, Math.min(16, Math.round(hb.count) || 8)),
      spread: hb.spread ?? 160,
    });
    if (signature !== this._signature || this._baseAngles.length === 0) {
      this._buildArrangement(config);
    }

    // ── Strobe-Timing ───────────────────────────────────────
    const subDiv = clamp(Math.round(hb.strobeDiv) || 4, 1, 16);
    const hasGrid = Number(audioData?.bpm) > 0 && audioData?.beatPhase !== undefined;
    // Ohne belastbares Beat-Grid läuft der Puls auf einer freien
    // Zeitbasis statt auf zufälligen Phasensprüngen – das war die
    // eigentliche Ursache des unruhigen Flackerns.
    const bPhase = hasGrid ? clamp01(audioData.beatPhase) : (this._time * 0.5) % 1;

    const subBeatPhase = (bPhase * subDiv) % 1.0;
    const subBeatIdx = Math.floor(bPhase * subDiv) +
      (Number(audioData?.beatCount) || 0) * subDiv;

    if (subBeatIdx !== this._lastSubBeat) {
      this._lastSubBeat = subBeatIdx;
      this._flash = 1;
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
    }

    if (isBeat) {
      this._flash = 1;
      if (show.colorMode !== 'hold') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
    }

    // Hüllkurve abklingen lassen (schnell genug für "Strobe"-Gefühl,
    // aber ohne die harte Schwarzblende von vorher).
    this._flash *= decayFor(0.82, dt);

    // ── Intensität je Strobe-Modus ──────────────────────────
    //
    // Master-Schalter "Strobo aus" (config.autoStrobe.enabled === false):
    // KEINER der drei Modi darf dann noch greifen. 'gate' blankt hart,
    // 'pulse' reißt auf jedem Sub-Beat von der Grundhelligkeit auf
    // Vollausschlag hoch - genau das, was der Schalter verbieten soll.
    // Bisher wirkte der Schalter nur auf den Autopiloten (Effektauswahl
    // und Szenen-Gate); der Effekt selbst pulste unbeirrt weiter und
    // sah deshalb weiter nach Dauerstrobe aus - auch bei rein manueller
    // Bedienung, wo der Autopilot gar nichts zu sagen hat.
    const strobeAllowed = config.autoStrobe?.enabled !== false;
    const strobeMode = strobeAllowed ? (hb.strobeMode || 'solid') : 'off';
    const duty = clamp(Number(hb.duty ?? 0.4), 0.05, 1);
    let envelope;

    if (strobeMode === 'off') {
      // Dauerlicht ohne jeden Beat-Blitz. Nur die Musik-Lautstärke
      // lässt die Strahlen noch minimal atmen - das ist Bewegung,
      // kein Blinken.
      envelope = 0.85 + clamp01(bass * sensitivity) * 0.15;
    } else if (strobeMode === 'gate') {
      // Klassisches hartes Blanking (echtes Laser-Blanking).
      if (subBeatPhase >= duty) return;
      envelope = 1;
    } else if (strobeMode === 'solid') {
      // Dauerlicht, nur leicht im Beat pumpend.
      envelope = 0.82 + this._flash * 0.18;
    } else {
      // 'pulse': immer sichtbar, im Beat heller. Die Grundhelligkeit
      // liegt bewusst hoch (0.55 statt 0.28) - bei 28% war der Sprung
      // auf Vollausschlag so groß, dass 'pulse' wie ein Strobe wirkte
      // statt wie ein Pumpen im Takt.
      const floorLevel = clamp(Number(hb.floor ?? 0.55), 0, 0.9);
      envelope = floorLevel + (1 - floorLevel) * Math.max(this._flash, subBeatPhase < duty ? 1 - subBeatPhase / duty : 0);
    }

    const intensity = clamp01(brightness * envelope);
    if (intensity <= 0.02) return;

    // ── Bewegung ────────────────────────────────────────────
    // Bewegungstempo hängt am Track: schneller Song = schnellerer
    // Sweep, mehr Energie = weitere Auslenkung.
    const bpm = Number(audioData?.bpm) > 0 ? audioData.bpm : 120;
    const motion = hb.motion || 'sweep';
    const motionSpeed = clamp(Number(hb.motionSpeed ?? 1), 0, 4);
    const beatsPerSecond = bpm / 60;

    let rotation = 0;
    let spreadScale = 1;

    if (motion === 'rotate') {
      // Gleichmäßige Drehung, ein voller Umlauf über 8 Takte.
      this._motionPhase += dt * (beatsPerSecond / 32) * motionSpeed * speed;
      rotation = this._motionPhase * TAU;
    } else if (motion === 'sweep') {
      // Pendelbewegung im Takt (ein Hin und Her über 2 Takte).
      this._motionPhase += dt * (beatsPerSecond / 8) * motionSpeed * speed;
      rotation = Math.sin(this._motionPhase * TAU) * (Math.PI / 5);
    } else if (motion === 'breathe') {
      // Fächer öffnet und schließt sich.
      this._motionPhase += dt * (beatsPerSecond / 8) * motionSpeed * speed;
      spreadScale = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this._motionPhase * TAU));
    } else {
      this._motionPhase += dt * motionSpeed * speed * 0.1;
    }

    // Kleiner Bass-Impuls auf allen Strahlen.
    this._beatAngle += (0 - this._beatAngle) * approachFor(0.08, dt);
    if (isBeat) this._beatAngle = bass * sensitivity * 0.08;

    const baseThick = (Number(hb.thickness) || 2) * (config.thicknessMul || 1.0);

    // ── Strahlen zeichnen ───────────────────────────────────
    // Räumlich statt flach: der Fächer wird im Raum aufgespannt und
    // um die Hochachse gedreht (Yaw). Dadurch rücken die Strahlen
    // perspektivisch zusammen, wenn der Fächer sich wegdreht - eine
    // reine 2D-Drehung behält dagegen immer denselben Abstand und
    // sieht deshalb wie ein flaches Rad aus.
    const depth3d = clamp(Number(config.depth3d ?? 0.7), 0, 1);
    // Bei "rotate" ist die Drehung die Raumdrehung; sonst schwingt der
    // Fächer im Raum hin und her.
    const yaw = rotation;

    for (let i = 0; i < this._baseAngles.length; i++) {
      const c = colors[(this._colorIdx + Math.floor(i * 0.5)) % colors.length];

      if (hb.arrangement === 'parallel') {
        // Parallelen wandern seitlich statt starr zu stehen.
        const drift = motion === 'static' ? 0 : Math.sin(this._motionPhase * TAU + i * 0.4) * 0.06;
        const xPos = clamp(this._beamXPos[i] + drift, 0, 1) * W;
        drawLaserLine(ctx, xPos, 0, xPos, H, c, intensity, baseThick);
        continue;
      }

      const angle = this._baseAngles[i] * spreadScale + this._beatAngle;

      if (depth3d > 0.01) {
        // Der Fächer liegt in einer senkrechten Ebene, die um die
        // Hochachse gedreht wird. Bei Drehung 0 ist das Bild identisch
        // zur flachen Darstellung; mit wachsendem Winkel schiebt sich
        // die Ebene in die Tiefe und die Strahlen rücken zusammen.
        const spin = yaw * depth3d;
        const dx = Math.sin(angle) * Math.cos(spin);
        const dy = Math.cos(angle);
        const dz = Math.sin(angle) * Math.sin(spin);
        const p = projectDirection(dx, dy, dz, len * 0.8, Math.max(W, H) * 1.1);
        const x2 = cx + p.x;
        const y2 = cy + p.y;
        // Strahlen, die vom Betrachter weg zeigen, sind schwächer und
        // dünner - das ist der eigentliche Tiefeneindruck.
        const depthFade = clamp(p.scale, 0.3, 1.8);
        drawLaserLine(ctx, cx, cy, x2, y2, c,
          clamp01(intensity * (0.4 + depthFade * 0.6)),
          baseThick * (0.55 + depthFade * 0.55));
        continue;
      }

      // Canvas: -90° ist "oben"; Grundwinkel 0 zeigt damit nach oben.
      const a = angle + yaw - Math.PI / 2;
      const x2 = cx + Math.cos(a) * len;
      const y2 = cy + Math.sin(a) * len;
      drawLaserLine(ctx, cx, cy, x2, y2, c, intensity, baseThick);
    }

    // ── Zentrum-Punkt ──────────────────────────────────────
    if (hb.arrangement !== 'parallel') {
      const color = colors[this._colorIdx % colors.length];
      ctx.beginPath();
      ctx.arc(cx, cy, baseThick * 1.5, 0, TAU);
      ctx.fillStyle = colorWithAlpha(color, intensity);
      ctx.fill();
    }
  }
}
