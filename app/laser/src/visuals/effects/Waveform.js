// ============================================================
// Waveform.js – Wellenform im Laser-Look
//
// Die flache Oszilloskop-Linie quer über das Bild war der am
// wenigsten laserartige Effekt im ganzen Programm: ein dünner
// einfarbiger Strich, wie aus einem Audio-Editor. Ein Laser
// zeichnet so etwas radial, symmetrisch und mit hartem weißem
// Kern – und dreht die Figur im Takt.
//
// Stile:
//   radial   – Spektrum-Stern vom Zentrum (Standard)
//   circular – Polar-Wellenform als geschlossener Ring
//   mirror   – gespiegelte Doppellinie
//   line     – klassische flache Linie (nur noch als Option)
// ============================================================

import {
  getPaletteColors, colorWithAlpha, strokeLaserPath, drawLaserDot, effectOrigin,
} from '../../shared/Config.js';

const TAU = Math.PI * 2;
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

export class Waveform {
  constructor() {
    this._time         = 0;
    this._circleRadius = 0;
    this._rotation     = 0;
    this._colorIdx     = 0;
    this._beatPulse    = 0;
    this._bars         = null;   // geglättete Balkenwerte (radial)
  }

  render(ctx, W, H, audioData, config) {
    const { isBeat = false, bpm, frequencyData, timeDomainData } = audioData || {};
    const wf = config.waveform || {};
    const { speed = 1, palette, customColor, show = {} } = config;

    const dt = 1 / 60;
    this._time += dt * speed;

    const colors = getPaletteColors(palette, customColor);

    if (isBeat) {
      this._beatPulse = 1;
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
    }
    this._beatPulse *= 0.87;

    // Rotation im Takt – ein stehendes Bild wirkt nie nach Lasershow.
    if (wf.rotate !== false) {
      const beatsPerSecond = (Number(bpm) > 0 ? bpm : 120) / 60;
      this._rotation += dt * (beatsPerSecond / 16) * TAU * speed;
    }

    switch (wf.style) {
      case 'wave':
        this._renderWaveField(ctx, W, H, timeDomainData, colors, audioData, config);
        break;
      case 'line':
        this._renderLine(ctx, W, H, timeDomainData, colors, config);
        break;
      case 'mirror':
        this._renderMirror(ctx, W, H, timeDomainData, colors, config);
        break;
      case 'circular':
        this._renderCircular(ctx, W, H, timeDomainData, colors, audioData, config);
        break;
      case 'radial':
        this._renderRadial(ctx, W, H, frequencyData, colors, audioData, config);
        break;
      default:
        this._renderWaveField(ctx, W, H, timeDomainData, colors, audioData, config);
        break;
    }
  }

  // ── Wellenfeld in Perspektive ───────────────────────────────
  //
  // Das ist die Figur, die man aus echten Lasershows kennt: mehrere
  // waagerechte Strahlen, die als Feld in die Tiefe gestaffelt sind
  // und im Takt durchlaufend wellen. Ein Spektrum-Balkendiagramm -
  // ob flach oder rund - bleibt dagegen immer ein Analysewerkzeug.
  _renderWaveField(ctx, W, H, data, colors, audioData, config) {
    const { bass = 0, amplitude = 0 } = audioData || {};
    const { brightness = 1, sensitivity = 1, waveform: wf = {} } = config;

    const lines = 9;
    const segments = 5;          // Blanking-Segmente pro Linie
    const gap = 0.04;
    const thickness = (Number(wf.thickness) || 1.5) * (config.thicknessMul || 1);
    const horizon = H * 0.34;    // Fluchtpunkt-Höhe
    const depth = H * 0.52;

    // Wellenamplitude atmet mit Bass und Beat.
    const amp = H * 0.055 * (0.5 + bass * sensitivity + this._beatPulse * 0.6);
    const scroll = this._time * 1.4;

    for (let l = 0; l < lines; l++) {
      const t = l / (lines - 1);
      // Perspektive: hinten dicht gestaffelt, vorne weit auseinander.
      const y0 = horizon + Math.pow(t, 1.9) * depth;
      const near = Math.pow(t, 1.6);            // 0 = fern, 1 = nah
      const color = colors[(this._colorIdx + l) % colors.length];
      const intensity = clamp(brightness * (0.35 + near * 0.6), 0, 1);
      const lineAmp = amp * (0.35 + near * 1.1);

      // Seitlicher Rand läuft nach hinten zusammen.
      const inset = (1 - near) * W * 0.18;

      for (let s = 0; s < segments; s++) {
        const from = s / segments;
        const to = (s + 1) / segments - gap;
        const steps = 26;

        strokeLaserPath(ctx, () => {
          for (let i = 0; i <= steps; i++) {
            const u = from + (to - from) * (i / steps);
            const x = inset + u * (W - inset * 2);

            // Wellenform des Signals plus durchlaufende Grundwelle.
            let sample = 0;
            if (data && data.length > 0) {
              const idx = Math.min(data.length - 1, Math.floor(u * (data.length - 1)));
              sample = (data[idx] - 128) / 128;
            }
            const travel = Math.sin(u * Math.PI * 3 + scroll - l * 0.55);
            const y = y0 + (travel * 0.7 + sample * 0.6) * lineAmp;

            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
        }, color, intensity, thickness * (0.6 + near * 0.7));
      }
    }
  }

  // ── Radialer Spektrum-Stern ─────────────────────────────────
  _renderRadial(ctx, W, H, data, colors, audioData, config) {
    const { brightness = 1, sensitivity = 1, waveform: wf = {} } = config;
    const { cx, cy } = effectOrigin(config, W, H);
    const bars = 48;
    const symmetry = clamp(Math.round(Number(wf.symmetry) || 2), 1, 6);
    const innerR = Math.min(W, H) * 0.10 * (1 + this._beatPulse * 0.15);
    const maxLen = Math.min(W, H) * 0.36;
    const thickness = (Number(wf.thickness) || 1.5) * (config.thicknessMul || 1);

    if (!this._bars || this._bars.length !== bars) this._bars = new Float32Array(bars);

    // Spektrum auf die Balken verteilen; ohne Daten ein ruhiges
    // Atmen, damit der Effekt nie tot aussieht.
    for (let i = 0; i < bars; i++) {
      let value;
      if (data && data.length > 0) {
        // Logarithmisch abgreifen: tiefe Frequenzen bekommen mehr Platz.
        const t = i / (bars - 1);
        const idx = Math.min(data.length - 1, Math.floor(Math.pow(t, 1.7) * data.length * 0.7));
        value = (data[idx] || 0) / 255;
      } else {
        value = 0.25 + 0.2 * Math.sin(this._time * 2 + i * 0.4);
      }
      // Glätten, sonst zappelt der Stern unruhig.
      this._bars[i] += (value - this._bars[i]) * 0.35;
    }

    const sectorCount = bars * symmetry;
    for (let s = 0; s < sectorCount; s++) {
      const barIdx = symmetry === 1
        ? s % bars
        // Gespiegelt: der Stern bleibt achsensymmetrisch.
        : (Math.floor(s / symmetry) % bars);
      const mirrored = symmetry > 1 && (s % 2 === 1);
      const value = this._bars[mirrored ? bars - 1 - barIdx : barIdx];

      const angle = this._rotation + (s / sectorCount) * TAU;
      const len = innerR + maxLen * clamp(value * sensitivity, 0, 1.4);
      const x1 = cx + Math.cos(angle) * innerR;
      const y1 = cy + Math.sin(angle) * innerR;
      const x2 = cx + Math.cos(angle) * len;
      const y2 = cy + Math.sin(angle) * len;

      const color = colors[(this._colorIdx + Math.floor(barIdx / 6)) % colors.length];
      const intensity = clamp(brightness * (0.45 + value * 0.7), 0, 1);

      strokeLaserPath(ctx, () => {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }, color, intensity, thickness);

      // Heller Punkt an der Spitze – das Auge liest ihn sofort als Laser.
      drawLaserDot(ctx, x2, y2, color, intensity * 0.9, thickness * 0.9);
    }
  }

  // ── Polar-Wellenform ────────────────────────────────────────
  //
  // Ein roher Polar-Plot der Wellenform ist ein zappelnder Kreis -
  // das liest jeder sofort als Audio-Plugin, nicht als Laser. Drei
  // Dinge machen daraus eine Laserfigur:
  //   1. Symmetrie: die Kurve wird gespiegelt, dadurch entsteht eine
  //      bewusst gestaltete Form statt Rauschen.
  //   2. Blanking: die Kontur wird in Segmente mit Lücken zerlegt -
  //      genau so zeichnet ein Galvo eine geschlossene Figur.
  //   3. Spitzen: an den Ausschlägen sitzen Punkte und kurze Speichen
  //      nach außen.
  _renderCircular(ctx, W, H, data, colors, audioData, config) {
    const { bass = 0 } = audioData || {};
    const { brightness = 1, sensitivity = 1, waveform: wf = {} } = config;

    const { cx, cy } = effectOrigin(config, W, H);
    const baseR = Math.min(W, H) * 0.26 * (0.9 + bass * 0.2 + this._beatPulse * 0.10);
    const modRange = Math.min(W, H) * 0.17 * sensitivity;
    const thickness = (Number(wf.thickness) || 1.5) * (config.thicknessMul || 1);
    const symmetry = clamp(Math.round(Number(wf.symmetry) || 2), 1, 6);

    this._circleRadius += (baseR - this._circleRadius) * 0.08;

    const points = 240;
    const segments = 6;            // Blanking-Segmente
    const gap = 0.06;              // Lücke zwischen den Segmenten

    // Radius an einer Position der Figur – gespiegelt, damit die Form
    // symmetrisch bleibt.
    const radiusAt = (t) => {
      const folded = symmetry === 1
        ? t
        : Math.abs(((t * symmetry) % 2) - 1); // Dreieckswelle: 0..1..0
      let sample;
      if (data && data.length > 0) {
        const idx = Math.min(data.length - 1, Math.floor(folded * (data.length - 1)));
        sample = (data[idx] - 128) / 128;
      } else {
        sample = Math.sin(folded * TAU * 3 + this._time * 3) * 0.4;
      }
      return this._circleRadius + sample * modRange;
    };

    for (let s = 0; s < segments; s++) {
      const from = s / segments;
      const to = (s + 1) / segments - gap / segments;
      const color = colors[(this._colorIdx + s) % colors.length];
      const steps = Math.max(8, Math.round(points / segments));

      strokeLaserPath(ctx, () => {
        for (let i = 0; i <= steps; i++) {
          const t = from + (to - from) * (i / steps);
          const angle = t * TAU - Math.PI / 2 + this._rotation;
          const r = radiusAt(t);
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      }, color, brightness, thickness);

      // Punkt am Segmentanfang: markiert die Blanking-Kante.
      const angleStart = from * TAU - Math.PI / 2 + this._rotation;
      const rStart = radiusAt(from);
      drawLaserDot(
        ctx,
        cx + Math.cos(angleStart) * rStart,
        cy + Math.sin(angleStart) * rStart,
        color, brightness * 0.9, thickness,
      );
    }

    // Kurze Speichen nach außen an den stärksten Ausschlägen.
    const spokes = 12;
    for (let i = 0; i < spokes; i++) {
      const t = i / spokes;
      const r = radiusAt(t);
      if (r < this._circleRadius + modRange * 0.35) continue;
      const angle = t * TAU - Math.PI / 2 + this._rotation;
      const color = colors[(this._colorIdx + i) % colors.length];
      strokeLaserPath(ctx, () => {
        ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
        ctx.lineTo(cx + Math.cos(angle) * (r + modRange * 0.45), cy + Math.sin(angle) * (r + modRange * 0.45));
      }, color, brightness * 0.8, thickness * 0.8);
    }

    // Dünner Innenring als Tiefenmarkierung.
    ctx.beginPath();
    ctx.arc(cx, cy, this._circleRadius * 0.5, 0, TAU);
    ctx.strokeStyle = colorWithAlpha(colors[(this._colorIdx + 1) % colors.length], 0.22 * brightness);
    ctx.lineWidth = Math.max(0.5, thickness * 0.6);
    ctx.stroke();
  }

  // ── Gespiegelte Doppellinie ─────────────────────────────────
  _renderMirror(ctx, W, H, data, colors, config) {
    const { brightness = 1, sensitivity = 1, waveform: wf = {} } = config;
    const cy = H / 2;
    const thickness = (Number(wf.thickness) || 1.5) * (config.thicknessMul || 1);
    const length = data && data.length > 0 ? data.length : 256;

    [1, -1].forEach((sign, idx) => {
      const color = colors[(this._colorIdx + idx) % colors.length];
      strokeLaserPath(ctx, () => {
        for (let i = 0; i < length; i++) {
          const t = i / (length - 1);
          const x = t * W;
          const sample = data && data.length > 0
            ? Math.abs((data[i] - 128) / 128)
            : Math.abs(Math.sin(t * Math.PI * 6 + this._time * 3)) * 0.5;
          const y = cy + sign * sample * H * 0.42 * (0.5 + sensitivity * 0.5);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      }, color, brightness, thickness);
    });
  }

  // ── Klassische flache Linie ─────────────────────────────────
  _renderLine(ctx, W, H, data, colors, config) {
    const { brightness = 1, sensitivity = 1, waveform: wf = {} } = config;
    const cy = H / 2;
    const thickness = (Number(wf.thickness) || 1.5) * (config.thicknessMul || 1);
    const color = colors[this._colorIdx % colors.length];
    const length = data && data.length > 0 ? data.length : 256;

    strokeLaserPath(ctx, () => {
      for (let i = 0; i < length; i++) {
        const t = i / (length - 1);
        const x = t * W;
        const sample = data && data.length > 0
          ? (data[i] - 128) / 128
          : Math.sin(t * Math.PI * 6 + this._time * 3) * 0.5;
        const y = cy + sample * H * 0.4 * (0.5 + sensitivity * 0.6);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
    }, color, brightness, thickness);
  }
}
