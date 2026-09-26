// ============================================================
// RainbowRing.js – Regenbogen-Ring
//
// Ein einzelner Kreis, innen hohl (nur die Kontur leuchtet, keine
// Fläche) - wie jeder Effekt hier nur gezeichnete Konturen, kein
// Fill. Die Farbe läuft als echter Regenbogen um den ganzen Umfang,
// unabhängig von der gewählten Palette: das ist die Identität dieses
// Effekts, kein Stil, den man wegstellen könnte. Der Ring dreht sich
// durchgehend - erst die Drehung macht den Regenbogen wirklich
// sichtbar, ein stehender Kreis sähe gedreht genauso aus wie
// ungedreht. Auf dem Beat bekommt er einen leichten, weich
// abklingenden Skalen-Puls (kein harter Sprung), dazu ein
// kontinuierliches Atmen mit Bass/Lautstärke. Der Mittelpunkt nutzt
// denselben wandernden Ursprung wie Scanner/Tunnel/Spiral - der Ring
// steht also nicht fest in der Mitte, sondern bewegt sich mit.
// ============================================================

import { strokeLaserPath, effectOrigin } from '../../shared/Config.js';

const TAU = Math.PI * 2;
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);

// Bogenstücke rund um den Ring - jedes bekommt seine eigene Farbe
// (feste Zuordnung Segment -> Farbton), zusammen ergibt das einen
// weichen, durchgehenden Regenbogen ohne echte Blanking-Lücken.
const SEGMENTS = 36;
const STEPS_PER_SEGMENT = 3; // kleine Bogenglättung pro Farbsegment

/** Hue (Grad, 0-360) -> Hex-Farbe bei voller Sättigung/Helligkeit. */
function hueToHex(hue) {
  const h = ((hue % 360) + 360) % 360;
  const c = 1;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export class RainbowRing {
  constructor() {
    this._time = 0;
    this._rotation = Math.random() * TAU;
    // Zufälliger Start-Farbton, damit nicht jede Instanz exakt bei Rot
    // beginnt - reine Geschmackssache, keine funktionale Rolle.
    this._huePhase = Math.random() * 360;
    // Feder-Modell für den Beat-Puls, wie bei Spiral/HotBeams: weiches
    // Abklingen statt hartem Sprung.
    this._pulse = 0;
    this._pulseVel = 0;
    this._breath = 0;
    this._level = 0;
  }

  render(ctx, W, H, audioData, config) {
    const { bass = 0, amplitude = 0, isBeat = false, transients } = audioData || {};
    const rr = config.rainbowRing || {};
    const { speed = 1, brightness = 1, sensitivity = 1 } = config;

    const dt = 1 / 60;
    this._time += dt * speed;

    // ── Drehung ──────────────────────────────────────────────
    const rotateSpeed = clamp(rr.rotateSpeed ?? 1, 0, 3);
    this._rotation += dt * speed * rotateSpeed * 0.6;

    // ── Beat-Puls: leicht, federnd, klingt weich ab ─────────
    const pulseStrength = clamp(rr.pulseStrength ?? 0.5, 0, 1);
    if (isBeat) {
      const velocity = Number(transients?.kick?.velocity);
      const strength = Number.isFinite(velocity) && velocity > 0 ? velocity : 1;
      this._pulseVel += pulseStrength * 2.2 * (0.5 + strength * 0.5);
    }
    const stiffness = 120;
    const damping = 12;
    this._pulseVel += (0 - this._pulse) * stiffness * dt;
    this._pulseVel -= this._pulseVel * damping * dt;
    this._pulse += this._pulseVel * dt;
    // "Leicht" skaliert - der Ausschlag bleibt bewusst klein (grob
    // 7-15% bei üblichen pulseStrength-Werten), aber deutlich
    // wahrnehmbar, kein dramatischer Sprung wie beim globalen Beat-Pump.
    const beatScale = 1 + clamp(this._pulse, -0.5, 1) * 1.6;

    // ── Kontinuierliches Reagieren, zusätzlich zum Beat-Puls ──
    // Atmet leicht mit Bass/Lautstärke statt nur auf Kicks zu springen.
    const reactiveScale = 1 + amplitude * sensitivity * 0.07 + bass * sensitivity * 0.05;

    // ── Atmen, auch ohne Beat ────────────────────────────────
    // Im Break, bei reinem Gesang oder ganz ohne Kick stand der Ring
    // sonst still. Er wächst und schrumpft jetzt ruhig: mit bekanntem
    // Tempo über zwei Takte (8 Schläge), sonst in ~4 s. Die geglättete
    // Lautstärke macht das Atmen in lauten Passagen etwas tiefer.
    const bpm = Number(audioData?.bpm);
    const breathPeriod = bpm > 40 ? (60 / bpm) * 8 : 4;
    this._breath = (this._breath + dt * speed / breathPeriod) % 1;
    this._level += (amplitude - this._level) * 0.05;
    const breathDepth = clamp(rr.breathDepth ?? 0.14, 0, 0.4) * (0.7 + this._level * 0.6);
    const breathScale = 1 + Math.sin(this._breath * Math.PI * 2) * breathDepth;

    // ── Position: derselbe wandernde Ursprung wie andere zentrierte
    // Effekte - der Ring bewegt sich also mit, statt starr in der
    // Mitte zu kleben.
    const { cx, cy } = effectOrigin(config, W, H);

    const baseRadius = Math.min(W, H) * clamp(rr.radius ?? 0.26, 0.05, 0.48);
    const radius = baseRadius * beatScale * reactiveScale * breathScale;

    const thickness = clamp(rr.thickness ?? 2.6, 0.5, 8) * (config.thicknessMul || 1);
    const intensity = clamp01(
      brightness * (0.6 + amplitude * sensitivity * 0.3 + (isBeat ? 0.15 : 0)),
    );
    if (intensity <= 0.02 || radius <= 1) return;

    for (let s = 0; s < SEGMENTS; s++) {
      const a0 = (s / SEGMENTS) * TAU + this._rotation;
      const a1 = ((s + 1) / SEGMENTS) * TAU + this._rotation;
      const hue = this._huePhase + (s / SEGMENTS) * 360;
      const color = hueToHex(hue);

      strokeLaserPath(ctx, () => {
        for (let i = 0; i <= STEPS_PER_SEGMENT; i++) {
          const a = a0 + (a1 - a0) * (i / STEPS_PER_SEGMENT);
          const x = cx + Math.cos(a) * radius;
          const y = cy + Math.sin(a) * radius;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      }, color, intensity, thickness);
    }
  }
}
