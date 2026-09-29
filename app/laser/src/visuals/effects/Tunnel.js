// ============================================================
// Tunnel.js – Rahmen-Tunnel (ohne Mittelpunkt)
//
// War vorher ein Kranz radialer Strahlen plus Tiefenringe, die alle
// auf einen kleinen, hell gefüllten Punkt in der Bildmitte
// zuliefen - genau das wirkte zu sehr nach "alles kommt aus einem
// Punkt" und zu ähnlich zu Scanner/HotBeams/ChaosBlades.
//
// Neu: reine Rahmen (Rechteck-Konturen, keine Speichen, kein
// Zentrumspunkt), die auf jedem Beat neu erscheinen und wachsen -
// wie durch einen Tunnel aus Fotorahmen fliegen. Jeder Rahmen dreht
// sich während des Wachsens leicht weiter, das ergibt den
// "verdrehten Schacht"-Effekt, den vorher die Speichen simuliert
// haben, ganz ohne dass irgendwo Linien in einem Punkt zusammen-
// laufen.
// ============================================================

import { getPaletteColors, strokeLaserPath, frameDt } from '../../shared/Config.js';

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);

export class Tunnel {
  constructor() {
    this._time = 0;
    this._colorIdx = 0;
    this._barCounter = 0;
    this._spawnAcc = 0;   // Fallback-Emission ohne verlässlichen Beat
    this._frames = this._seedFrames();    // wachsende Rahmen: { time, colorIdx, rotation }
  }

  init(config) {
    const cap = clamp(Math.round(config?.tunnel?.ringCount) || 4, 1, 12);
    this._frames = this._seedFrames(cap);
    this._spawnAcc = 0;
  }

  /**
   * Sofort etwas sichtbar statt bis zum ersten Beat auf ein leeres
   * Bild zu warten: ein paar Rahmen in unterschiedlichen
   * Wachstumsstadien vorbelegen, wie ein Tunnel, in den man schon
   * mittendrin fliegt.
   */
  _seedFrames(cap = 3) {
    // Nie mehr vorbelegen als gleichzeitig erlaubt sind, sonst stünde
    // der Effekt direkt nach dem Start über seinem eigenen Limit.
    return [0.016, 0.4, 0.9].slice(0, Math.max(1, cap)).map((offset, i) => ({
      time: -offset, colorIdx: i, rotation: (Math.random() - 0.5) * 0.3,
    }));
  }

  render(ctx, W, H, audioData, config) {
    const { bass = 0, amplitude = 0, isBeat = false, bpm } = audioData;
    const { tunnel, speed, brightness, sensitivity, palette, customColor, show } = config;

    const dt = frameDt(config);
    this._time += dt * speed;

    const colors = getPaletteColors(palette, customColor);
    // Bewusst NICHT der wandernde Effekt-Ursprung wie bei
    // Scanner/HotBeams/Spiral/RainbowRing: der Tunnel soll immer aus
    // der Bildmitte kommen, nicht mit dem Mittelpunkt-Regler
    // mitwandern - das würde den "man fliegt geradeaus durch einen
    // Tunnel"-Effekt zerstören.
    const cx = W / 2;
    const cy = H / 2;

    if (isBeat) {
      this._barCounter++;
      if (show.colorMode === 'beat') {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      } else if (show.colorMode === 'bar' && this._barCounter % 4 === 0) {
        this._colorIdx = (this._colorIdx + 1) % colors.length;
      }
    }

    // ── Beat-Synchronisation: ein Rahmen startet exakt auf dem Beat.
    // Ohne verlässlichen Beat emittiert ein Fallback-Timer weiter.
    const beatsPerSecond = (Number(bpm) > 0 ? bpm : 128) / 60;
    // "Rahmen gleichzeitig" (ringCount) begrenzt jetzt wirklich, wie
    // viele Rahmen zeitgleich wachsen dürfen - vorher stand hier eine
    // feste 16 und der Regler war komplett wirkungslos. Wie bei den
    // fliegenden Kreisen ist das ein Spawn-Gate und keine Eviction:
    // ist das Limit erreicht, startet einfach kein neuer Rahmen, statt
    // einem laufenden mitten im Wachsen den Stecker zu ziehen.
    const maxConcurrent = clamp(Math.round(tunnel.ringCount) || 4, 1, 12);
    const spawnFrame = () => {
      if (this._frames.length >= maxConcurrent) return;
      this._frames.push({ time: this._time, colorIdx: this._colorIdx, rotation: (Math.random() - 0.5) * 0.3 });
    };
    // Nicht auf JEDEM Beat ein neuer Rahmen - das wirkte hart und
    // aggressiv (bei 200 BPM über drei grelle Rahmen pro Sekunde).
    // Jetzt alle 2 Beats, ab 150 BPM alle 4 Beats: ruhiger Flug durch
    // den Tunnel statt Dauerfeuer.
    const every = Number(bpm) >= 150 ? 4 : 2;
    if (isBeat) {
      this._beatCount = (this._beatCount || 0) + 1;
      if (this._beatCount % every === 0) spawnFrame();
      this._spawnAcc = 0;
    } else {
      this._spawnAcc += (dt * speed * beatsPerSecond * 0.5) / (every / 2);
      if (this._spawnAcc >= 1) {
        this._spawnAcc -= 1;
        spawnFrame();
      }
    }

    // ── Wachstum ─────────────────────────────────────────────
    // An echte Beats gekoppelt statt an die feste "Reaktivität"-
    // Regelgröße: ein Rahmen braucht 6 Beats (anderthalb Takte), um
    // voll auszuwachsen - bei einem schnellen Track geht das
    // entsprechend fixer, bei einem langsamen entsprechend
    // gemächlicher. Vorher 4 Beats - wirkte als "n bisschen zu
    // schnell" zurückgemeldet.
    // 8 Beats (vorher 6) und nie schneller als 1,6 s: gemächlicheres
    // Wachsen, auch wenn der Show-Takt die Geschwindigkeit hochdreht.
    const lifetime = Math.max(1.6, clamp(8 / beatsPerSecond, 0.4, 8) / Math.max(0.3, Math.min(speed, 1.3)));
    // Deutlich über die Bildfläche hinaus (Diagonale statt kurzer
    // Kante) - vorher blendete das Ausfaden den Rahmen genau dann
    // weg, wenn er eigentlich den Rand erreicht hätte.
    const maxSize = Math.hypot(W, H) * 1.05;
    const startSize = Math.min(W, H) * 0.05;
    const aspect = W / H;

    // Deutlich kräftiger als vorher (1.5 fest, kein Regler) - "man
    // sieht die quasi nicht" war eine berechtigte Rückmeldung. Jetzt
    // ein eigener, einstellbarer Wert wie bei jedem anderen Effekt.
    const baseThick = clamp(tunnel.thickness ?? 2.2, 0.5, 8) * Math.min(1.2, config.thicknessMul || 1.0);

    this._frames = this._frames.filter((f) => (this._time - f.time) < lifetime);

    for (const frame of this._frames) {
      const age = this._time - frame.time;
      const t = clamp01(age / lifetime);
      const eased = t * t * (3 - 2 * t);

      const halfH = (startSize + eased * (maxSize - startSize)) / 2;
      const halfW = halfH * aspect;
      const rotation = frame.rotation * eased * 0.6;

      // Nur kurz einblenden beim Spawn - kein Ausblenden mehr zum
      // Ende hin, der Rahmen bleibt hell bis er wirklich über den
      // Bildrand hinausgewachsen ist (dann entfernt ihn der Filter
      // oben ohnehin, ohne dass man ihn verblassen sehen würde).
      //
      // depthFade simuliert Tiefe (fern = dünner/dunkler, nah = voll)
      // - der Bereich war vorher 0.35..1.0, ein frisch gespawnter,
      // noch kleiner Rahmen war dadurch kaum zu sehen ("man sieht die
      // quasi nicht"). Jetzt 0.6..1.0: deutlich präsenter von Anfang
      // an, der Tiefeneffekt bleibt als leichtes Nachdunkeln erhalten.
      // Weich einblenden (0,2 s statt eines 0,1-s-Blitzes) und auf dem
      // letzten Viertel sanft ausblenden, damit kein Rahmen hart
      // aufpoppt oder abrupt verschwindet; Spitzen etwas gedämpft.
      const fadeIn = clamp01(age / 0.2);
      const fadeOut = 1 - clamp01((t - 0.75) / 0.25);
      const depthFade = 0.6 + eased * 0.4;
      const intensity = Math.min(0.9, clamp01(
        brightness * fadeIn * fadeOut * depthFade
        * (0.6 + amplitude * sensitivity * 0.3 + bass * sensitivity * 0.1),
      ));
      if (intensity <= 0.02) continue;

      const color = colors[(this._colorIdx + frame.colorIdx) % colors.length];
      const corners = [
        { x: -halfW, y: -halfH }, { x: halfW, y: -halfH },
        { x: halfW, y: halfH }, { x: -halfW, y: halfH },
      ].map((p) => ({
        x: cx + p.x * Math.cos(rotation) - p.y * Math.sin(rotation),
        y: cy + p.x * Math.sin(rotation) + p.y * Math.cos(rotation),
      }));

      // EIN durchgehender, geschlossener Rahmen - keine Blanking-Lücken
      // mehr. Die vorherige Segmentierung ("wie ein Galvo, der den
      // Rahmen in Stücken abfährt") ließ den Tunnel gestrichelt und
      // löchrig aussehen statt nach einer sauberen Laserkontur.
      strokeLaserPath(ctx, () => {
        for (let i = 0; i < corners.length; i++) {
          const p = corners[i];
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        }
        ctx.lineTo(corners[0].x, corners[0].y);
      }, color, intensity, baseThick * (0.8 + eased * 0.4));
    }
  }
}
