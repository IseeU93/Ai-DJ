// ============================================================
// LsdTunnel.js – Fliegende Kreise (klassischer Laser-Effekt)
//
// War zweimal etwas anderes: erst verzerrte, gewobbelte Ringe (sah
// nach Screensaver aus), dann Lichtstöße entlang radialer Strahlen
// aus der Bildmitte (zu abstrakt, "die Ringe passen überhaupt
// nicht" / "nicht von der Mitte aus"). Jetzt das, was auf echten
// Lasershows tatsächlich zu sehen ist: geschlossene Kreise, die aus
// einer komplett zufälligen Richtung ins Bild fliegen, dabei größer
// werden und auf der GEGENÜBERLIEGENDEN Seite wieder hinauslaufen -
// kein Verblassen, kein Verschwinden mittendrin, sie laufen einfach
// vom Bildschirm.
//
// Jeder Beat schickt einen neuen Kreis los, in eine zufällige
// Richtung (nicht mehr reihum oben/unten/links/rechts). Mehrere
// Kreise aus verschiedenen Richtungen sind dabei gleichzeitig
// unterwegs - aber begrenzt: maxCircles (Default 5) deckelt, wie
// viele gleichzeitig fliegen dürfen. Das ist ein Spawn-Gate, kein
// Abschneiden - ist das Limit erreicht, wird einfach nichts Neues
// losgeschickt, bis wieder ein Kreis komplett vom Bildschirm ist.
// Kein Kreis wird je mitten im Flug gelöscht.
//
// Flugtempo hängt am echten Song-Tempo (BPM), nicht nur an der
// "rush"-Einstellung - schnellere Tracks lassen die Kreise schneller
// fliegen.
//
// Gezeichnet wird nur die Kontur (strokeLaserPath) als EIN
// durchgehender Kreis, keine Blanking-Lücken - ein Laserkreis ohne
// Löcher.
// ============================================================

import { getPaletteColors, strokeLaserPath, frameDt } from '../../shared/Config.js';

const TAU = Math.PI * 2;
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);

export class LsdTunnel {
  constructor() {
    this._time = 0;
    this._colorIdx = 0;
    this._circles = [];    // fliegende Kreise: { time, dir, startX, startY, colorIdx }
    this._spawnAcc = 0;    // Fallback-Emission ohne verlässlichen Beat
  }

  init() {
    this._circles = [];
    this._spawnAcc = 0;
  }

  render(ctx, W, H, audioData, config) {
    const { amplitude = 0, isBeat = false, bpm } = audioData || {};
    const cfg = config.lsdTunnel || {};
    const {
      speed = 1, brightness = 1, sensitivity = 1, palette, customColor,
    } = config;

    const dt = frameDt(config);
    this._time += dt * speed;

    const colors = getPaletteColors(palette, customColor);
    const rushBase = clamp(cfg.rush ?? 1, 0.1, 4);
    const beatsPerSecond = (Number(bpm) > 0 ? bpm : 128) / 60;

    // ── Beat-Synchronisation: ein Kreis startet exakt auf dem Beat,
    // in eine zufällige Richtung. Ohne verlässlichen Beat sorgt ein
    // Fallback-Timer dafür, dass der Effekt nie einfriert.
    //
    // Früher gab es hier eine harte "maxConcurrent"-Obergrenze, die
    // bei jedem neuen Beat die ÄLTESTEN Kreise abgeschnitten hat -
    // egal wie weit sie schon geflogen waren. Das ließ Kreise auf dem
    // Beat einfach verschwinden, statt den Bildschirm zu queren.
    // Jetzt entscheidet allein die Position (siehe Filter unten), ob
    // ein Kreis noch da ist - kein künstliches Limit mehr.
    // "Ringe" (ringCount) ist jetzt die Anzahl Kreise, die pro Beat
    // gleichzeitig starten (statt einer nun sinnlosen Obergrenze).
    // Spawn-Gate statt Eviction: solange das Limit erreicht ist, wird
    // einfach nichts Neues losgeschickt - kein Kreis wird deshalb
    // abgeschnitten. Sobald durch das Positions-Filter unten wieder
    // Platz ist (ein Kreis ist komplett vom Bildschirm), darf der
    // nächste Beat wieder spawnen. So bleiben nie mehr als maxConcurrent
    // Kreise gleichzeitig unterwegs.
    const maxConcurrent = clamp(Math.round(cfg.maxCircles) || 5, 1, 20);
    const perBeat = clamp(Math.round(cfg.ringCount) || 1, 1, 8);
    if (isBeat) {
      for (let i = 0; i < perBeat && this._circles.length < maxConcurrent; i++) {
        this._spawnCircle(colors, W, H);
      }
      this._spawnAcc = 0;
    } else {
      this._spawnAcc += dt * beatsPerSecond * rushBase * 0.5;
      if (this._spawnAcc >= 1) {
        this._spawnAcc -= 1;
        if (this._circles.length < maxConcurrent) this._spawnCircle(colors, W, H);
      }
    }
    const extraStreams = clamp(Math.round(cfg.spokes ?? 0), 0, 16);
    if (extraStreams > 0 && isBeat) {
      for (let i = 0; i < extraStreams && this._circles.length < maxConcurrent; i++) {
        this._spawnCircle(colors, W, H);
      }
    }

    // ── Wachstum + Flug ────────────────────────────────────────
    // Tempo hängt jetzt am echten Takt statt nur an der "rush"-
    // Einstellung: bei 120 BPM entspricht das genau dem alten Tempo,
    // schnellere Tracks lassen die Kreise spürbar schneller fliegen,
    // langsamere entsprechend gemächlicher.
    const speedPxPerSec = Math.hypot(W, H) * (0.10 + rushBase * 0.08) * (beatsPerSecond / 2);
    // Deutlich größer als vorher (0.3 * kurze Kante war nur ein
    // kleiner Fleck) - der Kreis soll auf seinem Weg wirklich den
    // Bildschirm füllen können, nicht nur ein Stück davon.
    const maxRadius = Math.hypot(W, H) * 0.55;
    const startRadius = Math.min(W, H) * clamp(cfg.hole ?? 0.06, 0.01, 0.3);
    // Strecke, über die ein Kreis von startRadius auf maxRadius wächst -
    // unabhängig davon, wann er den Bildschirm verlässt (das entscheidet
    // jetzt allein seine Position, siehe Filter unten).
    const growthDist = Math.hypot(W, H) * 0.5;

    // "Ausbuchtungen" bestimmt jetzt die Eckigkeit der Kontur: wenige
    // Segmente = eher ein Vieleck, viele = ein glatter Kreis.
    const steps = clamp(Math.round(cfg.lobes) || 5, 3, 48);
    const wobbleAmt = clamp(cfg.warp ?? 0.35, 0, 1);
    const thickness = clamp(cfg.thickness ?? 1.8, 0.5, 6) * (config.thicknessMul || 1);

    // Ein Kreis verschwindet nicht mehr durch Ausblenden - er bleibt,
    // bis er (samt seinem Radius) komplett außerhalb des sichtbaren
    // Bilds ist, läuft also wirklich vom Bildschirm.
    this._circles = this._circles.filter((c) => {
      const dist = (this._time - c.time) * speedPxPerSec;
      const px = c.startX + c.dir.x * dist;
      const py = c.startY + c.dir.y * dist;
      return !(px + maxRadius < 0 || px - maxRadius > W || py + maxRadius < 0 || py - maxRadius > H);
    });

    for (const circle of this._circles) {
      const age = this._time - circle.time;
      const dist = age * speedPxPerSec;
      const growT = clamp01(dist / growthDist);
      const eased = growT * growT * (3 - 2 * growT);

      const radius = startRadius + eased * (maxRadius - startRadius);
      const px = circle.startX + circle.dir.x * dist;
      const py = circle.startY + circle.dir.y * dist;

      // Nur ein kurzes Einblenden beim Spawn - kein Ausblenden mehr,
      // der Kreis läuft mit voller Helligkeit vom Bildschirm.
      const fadeIn = clamp01(age / 0.15);
      const intensity = clamp01(
        brightness * fadeIn * (0.55 + amplitude * sensitivity * 0.35),
      );
      if (intensity <= 0.02 || radius <= 0.5) continue;

      const color = colors[circle.colorIdx % colors.length];
      const squash = 1 + Math.sin(this._time * 1.6 + circle.time) * 0.08 * wobbleAmt;

      // Ein durchgehender Kreis, keine Blanking-Lücken.
      strokeLaserPath(ctx, () => {
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * TAU;
          const x = px + Math.cos(a) * radius;
          const y = py + Math.sin(a) * radius * squash;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      }, color, intensity, thickness * (0.6 + eased * 0.4));
    }
  }

  /**
   * Startet außerhalb des Bildes in einer komplett zufälligen
   * Richtung und fliegt quer durch, bis er auf der gegenüber-
   * liegenden Seite wieder hinausläuft.
   */
  _spawnCircle(colors, W, H) {
    this._colorIdx = (this._colorIdx + 1) % colors.length;

    const angle = Math.random() * TAU;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    // Senkrecht zur Flugrichtung, für einen zufälligen seitlichen
    // Versatz - sonst fliegt jeder Kreis exakt durchs Zentrum.
    const perp = { x: -dir.y, y: dir.x };

    const cx = W / 2;
    const cy = H / 2;
    const spawnRadius = Math.hypot(W, H) / 2 + Math.min(W, H) * 0.15;
    const lateral = (Math.random() - 0.5) * spawnRadius * 1.6;

    const startX = cx - dir.x * spawnRadius + perp.x * lateral;
    const startY = cy - dir.y * spawnRadius + perp.y * lateral;

    this._circles.push({
      time: this._time, dir, startX, startY,
      colorIdx: this._colorIdx,
    });
  }
}
