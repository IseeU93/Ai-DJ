// ============================================================
// ChaosBlades.js – Aggressiver Blitz-Fächer
//
// Gezackte, blitzartige Laserstrahlen aus dem Projektor-Ursprung bei
// harten Kicks. Vorher starteten die Blitze an zufällig über die
// ganze Fläche verstreuten Punkten - das sieht auf einem Bildschirm
// nach Gewitter-Shader aus, hat aber keinen Bezug zu einem realen
// Laserkopf. Ein echter Kopf hat genau einen Austrittspunkt: jeder
// Blitz beginnt jetzt im gemeinsamen Ursprung und fächert von dort
// jagged nach außen auf - wie ein Scanner-Fächer, nur chaotisch statt
// geordnet.
//
// `spread` steuert seit diesem Umbau die WINKEL-Streuung um eine
// langsam wandernde Zielrichtung (0 = alle Blitze in dieselbe Richtung,
// 1 = voller Rundumschlag), nicht mehr die Position der Ansatzpunkte.
// `fullFrame` steuert die Länge (quer durchs Bild vs. kurzer Jab).
// ============================================================

import { getPaletteColors, strokeLaserPath, effectOrigin, frameDt, decayFor } from '../../shared/Config.js';

const TAU = Math.PI * 2;

export class ChaosBlades {
  constructor() {
    this._bolts = []; // aktive Blitze: { points, life, color, thickness }
    this._idlePulse = 0;
    // Zielrichtung, um die die Blitze streuen - wandert langsam, damit
    // aufeinanderfolgende Kicks nicht immer in dieselbe Ecke schlagen.
    this._aimAngle = Math.random() * TAU;
  }

  render(ctx, W, H, audioData, config) {
    const { bass, amplitude, isBeat, transients } = audioData;
    const { chaosBlades, brightness, sensitivity, palette, customColor } = config;

    const dt = frameDt(config);
    const f = dt * 60;
    const colors = getPaletteColors(palette, customColor);
    const { cx, cy } = effectOrigin(config, W, H);
    const punch = Math.min(1.4, ((bass || 0) + (amplitude || 0)) * sensitivity);

    const kickHit = Boolean(transients?.kick?.hit) || Boolean(isBeat);

    // Zielrichtung driftet langsam weiter - der Fächer "schwenkt" über
    // mehrere Kicks hinweg, statt bei jedem Treffer komplett neu zu
    // würfeln.
    this._aimAngle += (0.008 + punch * 0.01) * f;

    // ── Neue Blitze bei einem harten Kick spawnen ───────────
    // Bei schnellen Tracks (Uptempo, Hardstyle) fällt jeder einzelne
    // Blitz weniger auf, weil er sofort vom nächsten Kick überschrieben
    // wird. Deshalb steigt die Anzahl mit dem Tempo - aber gedeckelt:
    // die alte Rechnung (bis 2.2x, Obergrenze 24x tempoBoost = bis zu
    // 53 gleichzeitige, volle Bilddiagonalen lange Zickzack-Blitze pro
    // Frame) war weit jenseits dessen, was ein echter Laserkopf
    // überhaupt scannen kann - das sieht am Bildschirm nach "mehr
    // Chaos" aus, kommt auf echter Hardware aber nur noch als
    // verwaschenes Gewusel oder Flackern raus, weil die Scan-Rate
    // nicht mitkommt. "Blitze pro Kick" im UI soll ungefähr das
    // liefern, was auch tatsächlich draufsteht.
    const bpm = Number(audioData?.bpm) > 0 ? audioData.bpm : 128;
    const tempoBoost = Math.min(1.4, Math.max(1, bpm / 160));
    const maxCount = Math.max(1, Math.round(chaosBlades.boltCount || 5));

    if (kickHit && punch > 0.35) {
      const count = Math.max(1, Math.round(maxCount * Math.min(1, punch) * tempoBoost));
      for (let i = 0; i < count; i++) {
        this._spawnBolt(cx, cy, W, H, colors, chaosBlades, punch);
      }
    }

    // ── Leiser Idle-Puls, damit der Effekt nie komplett tot wirkt ──
    this._idlePulse += 0.05 * f;
    if (this._bolts.length === 0 && Math.sin(this._idlePulse) > 0.985) {
      this._spawnBolt(cx, cy, W, H, colors, chaosBlades, 0.25);
    }

    // ── Bestehende Blitze zeichnen + abklingen lassen ───────
    const decay = Math.min(0.98, Math.max(0.5, chaosBlades.decay ?? 0.86));
    this._bolts = this._bolts.filter((b) => b.life > 0.03);
    // Obergrenze folgt jetzt der konfigurierten Anzahl statt einer
    // pauschalen, immer recht hohen Zahl - "Blitze pro Kick" soll
    // wirklich die Obergrenze für alles Gleichzeitige sein, nicht nur
    // für einen einzelnen Kick-Spawn. Ein realer Laserkopf kommt bei
    // vielen gleichzeitigen vollflächigen Zickzack-Pfaden pro Frame
    // ohnehin nicht mehr hinterher.
    const maxBolts = Math.min(12, Math.round(maxCount * 1.8 * tempoBoost));
    if (this._bolts.length > maxBolts) this._bolts.splice(0, this._bolts.length - maxBolts);
    for (const bolt of this._bolts) {
      this._drawBolt(ctx, bolt, brightness);
      bolt.life *= decayFor(decay, dt);
    }
  }

  /**
   * Ein Blitz schlägt quer durch das GANZE Bild: er beginnt außerhalb
   * einer Kante und endet außerhalb der gegenüberliegenden, versetzt
   * quer zur Schlagrichtung. Damit kommt er weder aus einem festen
   * Punkt noch startet er mitten im Bild an einer beliebigen Stelle -
   * beides sah eher nach Effekt-Ursprung als nach Gewitter aus.
   *
   * `spread` streut die Schlagrichtung um die langsam wandernde
   * Zielrichtung, `fullFrame` entscheidet, ob der Versatz quer dazu
   * das ganze Bild ausnutzt oder nur den mittleren Bereich.
   */
  _spawnBolt(cx, cy, W, H, colors, cfg, punch) {
    const diag = Math.hypot(W, H);
    const spread = Math.min(1, Math.max(0, cfg.spread ?? 0.7));
    const fullFrame = cfg.fullFrame !== false;

    const angle = this._aimAngle + (Math.random() - 0.5) * TAU * spread;

    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const perpX = -dirY;
    const perpY = dirX;

    // Quer zur Schlagrichtung versetzt: so liegen aufeinanderfolgende
    // Blitze über die Fläche verteilt statt alle auf derselben Linie.
    const offsetRange = diag * (fullFrame ? 0.5 : 0.22);
    const offset = (Math.random() - 0.5) * offsetRange;

    // Länge über die volle Diagonale plus Rand: der Blitz beginnt und
    // endet außerhalb des Bildes.
    const len = diag * 1.25;
    const segments = 7 + Math.floor(Math.random() * 5);
    const jag = Math.min(1, Math.max(0, cfg.jaggedness ?? 0.55));
    const stepLen = len / segments;

    let x = W / 2 + perpX * offset - dirX * len * 0.5;
    let y = H / 2 + perpY * offset - dirY * len * 0.5;

    const points = [{ x, y }];
    for (let s = 0; s < segments; s++) {
      const wobble = (Math.random() - 0.5) * jag * stepLen * 1.4;
      x += dirX * stepLen + perpX * wobble;
      y += dirY * stepLen + perpY * wobble;
      points.push({ x, y });
    }

    this._bolts.push({
      points,
      life: 1,
      color: colors[Math.floor(Math.random() * colors.length)],
      thickness: Math.max(0.5, (cfg.thickness ?? 2) * (0.6 + punch * 0.7)),
    });
  }

  _drawBolt(ctx, bolt, brightness) {
    if (bolt.points.length < 2) return;
    const intensity = Math.max(0, Math.min(1, brightness * bolt.life));
    if (intensity <= 0.01) return;

    // Gleicher Laser-Look wie jeder andere Strahl im Katalog: Halo +
    // Farbkörper + weißer Kern (strokeLaserPath), statt einer nackten
    // Linie ohne Glow.
    strokeLaserPath(ctx, () => {
      ctx.moveTo(bolt.points[0].x, bolt.points[0].y);
      for (let i = 1; i < bolt.points.length; i++) {
        ctx.lineTo(bolt.points[i].x, bolt.points[i].y);
      }
    }, bolt.color, intensity, bolt.thickness * bolt.life + 0.4);
  }
}
