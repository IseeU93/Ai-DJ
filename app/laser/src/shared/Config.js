// ============================================================
// Config.js – Updated: Effects + Show + Choreographer Config
// Includes autoColor mode and harmony-aware palette selection
// ============================================================

export const DEFAULT_CONFIG = {
  // Effekt-Auswahl (neue Effekte)
  effect: 'scanner', // 'scanner'|'tunnel'|'lsdTunnel'|'hotBeams'|'liquidSky'|'lissajous'|'waveform'|'chaosBlades'|'spiral'|'snake'|'beamSweep'|'rainbowRing'

  // Farbpalette ('green'|'red'|'cyan'|'white'|'rainbow'|'custom'|'autoColor')
  palette: 'green',
  customColor: '#00ff41',
  autoColor: false,  // When true, palette is driven by harmony analysis

  // Globale visuelle Einstellungen
  brightness: 1.0,
  // Nachleucht-Trail: wie viel vom letzten Frame stehen bleibt, bevor
  // der nächste draufgezeichnet wird (trailAlpha = 1 - trailLength,
  // siehe LaserRenderer._render). War 0.80 - bei 60fps braucht ein
  // bewegtes Element dann über 170ms, um auf 10% Helligkeit
  // abzuklingen: jeder Strahl zog eine sichtbare "Geisterkopie" hinter
  // sich her (Ghosting), statt wie ein echter, in Nebel sichtbarer
  // Laserstrahl scharf zu wirken. Deutlich gesenkt - ein Hauch
  // Nachglühen bleibt, aber kein Schweif mehr.
  trailLength: 0.30,
  autoRotate: true,

  // Autopilot / Choreographer
  autopilot: false,
  // Eskalation: 4-stufiger Knopfslider im UI (Niedrig/Mittel/Hoch/
  // Vollgas), bestimmt u.a. wie viele Effekte gleichzeitig laufen
  // dürfen (Choreographer._maxEffectLayers). 0.45 = Mittel (Default).
  escalation: 0.45,

  // Choreographer (replaces old autopilot when active)
  choreographer: {
    enabled: false,          // Use new intelligent Choreographer
    // Der Autopilot-Schalter im UI aktiviert den Choreographen mit.
    transitionSpeed: 0.06,   // Crossfade speed (per frame, 0.06 ≈ 280ms)
    effectCooldown: 4000,    // Min ms between effect changes
    paletteCooldown: 8000,   // Min ms between palette changes
    useHarmonyColors: true,  // Map musical key to colors
    allowLayering: true,     // Allow overlay effects during climax
  },

  // Auto-Strobe / Auto-Blackout: kurze, automatische Musik-Punktuierung,
  // unabhängig von Autopilot/Choreographer (funktioniert auch im rein
  // manuellen Modus). Reagiert direkt auf Transienten/Energie aus der
  // Audio-Analyse, siehe src/show/AutoPunctuation.js.
  // enabled ist jetzt ein echter Master-Switch: gilt auch für das
  // Strobe/Blackout, das der Choreograph im Autopilot-Modus selbst
  // fährt (vorher war der Schalter dort wirkungslos - ein zentraler
  // Grund für "Strobe geht trotz ausgeschaltetem Schalter"). Default
  // true, damit sich am bisherigen Autopilot-Verhalten nichts ändert,
  // solange niemand den Schalter anfasst.
  autoStrobe: {
    enabled: true,
    sensitivity: 0.65,   // 0..1 – wie stark ein Kick sein muss, um zu triggern
    minGapMs: 140,        // Mindestabstand zwischen zwei Strobe-Bursts
    burstMs: 220,         // Wie lange der Strobe-Overlay aktiv bleibt
    // 'auto' = passender Overlay-Effekt, der nicht dem laufenden
    // Effekt entspricht. Alternativ ein fester Effektname.
    overlayEffect: 'auto',
  },
  // Selber Master-Switch-Hinweis wie bei autoStrobe.
  autoBlackout: {
    enabled: true,
    sensitivity: 0.85,   // höher = seltener/nur bei sehr harten Hits
    minGapMs: 500,        // Mindestabstand zwischen zwei Blackout-Punktierungen
    flashMs: 90,           // Dauer der Blackout-Punktierung
  },

  // Reaktivität
  sensitivity: 1.0,
  speed: 1.0,

  // Player-Status
  blackout: false,
  freeze: false,

  // Bewegung des Effekt-Ursprungs (für alle zentrierten Effekte):
  // 'auto'  = Drift in ruhigen Teilen, Sprünge auf Kicks im Drop
  // 'drift' = weiches Wandern auf einer Lissajous-Bahn
  // 'snap'  = auf jedem Kick an eine neue Position springen
  // 'static'= feste Bildmitte
  originMotion: 'auto',
  originRange: 0.22,   // maximale Auslenkung, Anteil der Bildbreite

  // ── Räumliche Wirkung ────────────────────────────────────
  // beatPump: Schub nach vorn auf jedem Kick (Maßstab). Skaliert die
  // GESAMTE Szene um den Ursprung - trifft also jeden Effekt
  // gleichermaßen. Bei Effekten mit viel Fläche (z.B. die Schlange,
  // deren Spur sich über den ganzen Bildschirm zieht) wirkt der
  // Skalierungssprung auf jedem Beat schnell wie Wackeln statt wie
  // ein Puls - deshalb standardmäßig aus (beatPumpEnabled), per
  // Schalter in den globalen Einstellungen aktivierbar.
  // depth3d:  perspektivische Drehung im Raum statt in der Fläche
  beatPumpEnabled: false,
  beatPump:   0.5,
  depth3d:    0.7,


  // ════════════════════════════════════════════════════════
  // SHOW-KONFIGURATION
  // ════════════════════════════════════════════════════════
  scannerPrototype: {
    enabled:         false,
    scanRate:        30000,
    pointSpacing:    0.015,
    maxVelocity:     1500,
    maxAcceleration: 6000000,
    cornerDwell:     6,
    endDwell:        4,
    preLightDelayMs: 0.10,
    postLightDelayMs: 0.10,
    pointBudget:     2400,
    persistenceMs:   45,
    beamWidth:       0.75,
    haloWidth:       1.8,
    snapshotExtrapolationMs: 120,
    snapshotFallbackMs: 500,
    clockSlewMsPerSecond: 2,
    adaptiveQuality: true,
    maxScannerTimePerFrame: 0.05,
    maxPointsPerFrame: 1500,
  },

  show: {
    intensity:    'auto',      // 'break'|'build'|'drop'|'auto'
    beatDivision: 4,           // Strobe-Subdivision: 1,2,4,8,16
    colorMode:    'beat',      // 'hold'|'beat'|'bar'|'harmony'
    movementMode: 'quantized', // 'fluid'|'quantized'|'strobe' (hauptsächlich Scanner)
    mirror:       false,
    tapBpm:       0,           // manuell getappt (0 = auto)
  },

  // ════════════════════════════════════════════════════════
  // EFFEKT-SPEZIFISCHE EINSTELLUNGEN
  // ════════════════════════════════════════════════════════

  scanner: {
    count:      2,
    sweepWidth: 140,   // Grad
    sweepSpeed: 1.0,
    mode:       'sweep', // 'sweep'|'snap'|'fan'|'cross'
    // 'auto' dreht den Ansatzpunkt selbstständig einmal komplett rum,
    // statt an 'up' zu kleben. 'up'/'down'/'left'/'right' fixieren
    // denselben Sweep/Snap/Fan/Cross auf eine feste Kante.
    orientation: 'auto',
    thickness:  1.5,
  },

  // Rahmen-Tunnel: rechteckige Konturen erscheinen auf jedem Beat und
  // wachsen, ohne Mittelpunkt oder Speichen (siehe Tunnel.js).
  tunnel: {
    // Die Rahmen sind durchgehende Konturen ohne Blanking-Lücken -
    // die frühere "Segmente pro Kante"-Einstellung gibt es deshalb
    // nicht mehr.
    ringCount: 4,   // maximal gleichzeitig wachsende Rahmen (Spawn-Gate)
    thickness: 2.2, // Strichstärke der Rahmen (2.6 wirkte zu hart, 1.5 kaum sichtbar)
  },

  // Sog-Tunnel für die Rampe vor dem Drop. Immer mittig, mit dunklem
  // Loch im Zentrum (siehe src/visuals/effects/LsdTunnel.js).
  // Fliegende Kreise: starten außerhalb einer Bildkante, wandern quer
  // über die Fläche und wachsen dabei. Jeder Beat schickt den
  // nächsten los, reihum oben/unten/links/rechts.
  lsdTunnel: {
    ringCount:  1,      // Kreise, die pro Beat gleichzeitig starten
    maxCircles: 5,      // Obergrenze gleichzeitig fliegender Kreise (Spawn-Gate, kein Abschneiden)
    hole:       0.06,   // Start-Radius (Anteil der kurzen Kante)
    rush:       1.0,    // Flug-/Wachstumstempo (zusätzlich zum echten Beat-Tempo)
    lobes:      5,      // Ecken der Kontur (wenige = Vieleck, viele = glatter Kreis)
    warp:       0.35,   // Wackeln/Elliptizität der Kreise
    spokes:     0,      // zusätzliche Kreise pro Beat (0 = aus)
    thickness:  1.8,
  },

  hotBeams: {
    count:       8,
    arrangement: 'fan',   // 'fan'|'star'|'parallel'|'cross'
    strobeDiv:   1,        // Puls pro Beat (nicht 4x pro Beat - das wirkte wie Strobe)
    thickness:   2,
    spread:      160,      // Öffnungswinkel des Fächers in Grad
    motion:      'sweep',  // 'sweep'|'rotate'|'breathe'|'static'
    motionSpeed: 1.0,      // Multiplikator der Bewegungsgeschwindigkeit
    // 'solid' = Dauerlicht mit leichtem Pumpen (Standard)
    // 'pulse' = immer sichtbar, im Beat deutlich heller
    // 'gate'  = hartes Laser-Blanking (aggressiv)
    // Bei global abgeschaltetem Strobe (autoStrobe.enabled === false)
    // wird JEDER dieser Modi im Effekt selbst auf Dauerlicht
    // heruntergefahren - siehe HotBeams.render().
    strobeMode:  'solid',
    duty:        0.4,      // Anteil des Sub-Beats mit vollem Licht
    floor:       0.55,     // Grundhelligkeit zwischen den Pulsen
  },

  liquidSky: {
    beamCount: 6,
    height:    0.30,    // normalisiert 0-1 (0=oben) - Grundhöhe, um die die Strahlen streuen/wandern
    spread:    15,      // Grad Winkel-Spreizung
    thickness: 1.5,
    // Wie reagiert ein Strahl auf den Beat? Aus (Standard): Tempo-
    // Schub - er rauscht kurz schneller durch seine Wanderbewegung,
    // kein Sprung. An: harter Sprung zu einer neuen Zufallshöhe
    // (Teleport) - bewusst ein Extra, kein Standardverhalten.
    beatSwitch: false,
  },

  lissajous: {
    freqX:     2,
    freqY:     3,
    autoPhase: true,
    beatSnap:  true,   // auf Beat zu neuem Frequenzpaar springen
  },

  waveform: {
    // 'wave' = Wellenfeld in Perspektive (klassische Lasershow-Figur),
    // 'radial' = Spektrum-Stern, 'circular' = Polar-Ring,
    // 'mirror'/'line' = klassisch flach (Analyse-Optik).
    style:     'wave',
    thickness: 1.5,
    rotate:    true,   // Figur dreht sich im Takt
    symmetry:  2,      // Spiegelachsen (1 = keine)
  },

  // Neuer aggressiver Effekt: gezackte Blitz-Strahlen, die bei harten
  // Kicks explosionsartig aufblitzen und schnell wieder verblassen.
  chaosBlades: {
    boltCount:   3,     // max. Anzahl Blitze pro Kick (steigt mit dem Tempo)
    spread:      0.7,   // Streuung der Ansatzpunkte über die Fläche (0..1)
    fullFrame:   true,  // Blitze schlagen quer durchs Bild statt nach außen
    jaggedness:  0.55,  // 0..1, wie stark die Blitze zackig abweichen
    decay:       0.86,  // Abkling-Faktor pro Frame (näher an 1 = länger sichtbar)
    thickness:   2,
  },

  // Laser-Spirale: mehrere Arme winden sich vom Ursprung nach außen,
  // Drehung beschleunigt auf dem Beat.
  spiral: {
    arms:      3,
    turns:     2.2,   // Umdrehungen pro Arm über die volle Länge
    zoom:      1,      // Gesamtgröße
    thickness: 1.6,
  },

  // Wandernde Laser-Schlange: für ruhige, wenig ereignisreiche
  // Passagen. Kein fester Ursprung - der Kopf erkundet die ganze
  // Fläche in sanften Zufallskurven, auf jedem Beat ein kurzer Schub.
  snake: {
    speed:        1,
    wiggle:       0.5,   // 0..1 – wie stark die Richtung driftet
    pushStrength: 0.6,   // 0..1.5 – Tempo-Schub auf jedem Beat
    length:       220,   // Länge der Spur in Segmenten
    thickness:    1.6,
  },

  // Balken-Sweep: ein oder mehrere volle Bildschirm-Balken laufen auf
  // jedem Beat von einer Kante zur gegenüberliegenden durch.
  beamSweep: {
    // 'vertical'|'horizontal'|'diagonal'|'auto' (wechselt zufällig)
    orientation: 'auto',
    count:       1,      // 1 = ein Balken, mehr = paralleler Fächer wie LiquidSky
    speed:       1,
    thickness:   2,
  },

  // Regenbogen-Ring: hohler, sich drehender Kreis mit echtem
  // Regenbogen um den Umfang (unabhängig von der Palette - das ist
  // die Identität des Effekts). Skaliert leicht auf jedem Beat.
  rainbowRing: {
    radius:        0.26,  // Anteil der kurzen Kante
    thickness:     2.6,
    rotateSpeed:   1.0,
    pulseStrength: 0.5,   // wie stark der Beat-Skalen-Puls ausschlägt
  },
};

export const PALETTES = {
  green:   ['#00ff41', '#39ff14', '#00ff7f', '#00cc33'],
  red:     ['#ff0040', '#ff2060', '#ff6080', '#ff0080'],
  cyan:    ['#00ffff', '#00ccff', '#0080ff', '#00f0f0'],
  white:   ['#ffffff', '#e0e8ff', '#ffffc8', '#c8ffff'],
  rainbow: ['#ff0040', '#ff8000', '#ffff00', '#00ff41', '#00ccff', '#8800ff', '#ff00cc'],
};

/**
 * Returns the color array for a palette.
 * @param {string} paletteName
 * @param {string} customColor – hex color for 'custom' palette
 * @param {string[]} [harmonyPalette] – colors suggested by HarmonyAnalyzer
 */
export function getPaletteColors(paletteName, customColor, harmonyPalette) {
  if (paletteName === 'autoColor' && harmonyPalette && harmonyPalette.length > 0) {
    return harmonyPalette;
  }
  if (paletteName === 'custom') return [customColor];
  return PALETTES[paletteName] || PALETTES['green'];
}

/**
 * Wandelt einen Hex-String in ein RGBA um.
 */
export function colorWithAlpha(hex, alpha) {
  // Hex ohne '#'
  const c = hex.replace('#', '');
  if (c.length === 6) {
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

/**
 * Zeichnet einen Laserstrahl: farbiger Halo + scharfer weißer Kern,
 * konstante Breite über die ganze Länge.
 *
 * War vorher wahlweise ein getaperter "Nebelkegel" mit bis zu drei
 * Farbverläufen pro Strahl (Streulicht-Kegel, Körper, Kern) plus
 * Austrittsfleck - optisch als "Strahl im Nebel" gedacht, aber sowohl
 * spürbar teurer (Canvas2D rastert Gradients pro Frame auf der CPU)
 * als auch als eigene Reglergruppe ("Strahlaufweitung"/"Nebeldichte")
 * mehr Bedienfeld, als es wert war. Jetzt gibt es nur noch diese eine,
 * schlanke Variante - keine Gradients, keine Nebel-Parameter.
 */
export function drawLaserLine(ctx, x1, y1, x2, y2, color, intensity, thickness) {
  if (intensity <= 0.01) return;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) return;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = colorWithAlpha(color, intensity * 0.4);
  ctx.lineWidth = thickness * 4;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, intensity)})`;
  ctx.lineWidth = Math.max(0.4, thickness * 0.8);
  ctx.stroke();
}

/**
 * Perspektivische Projektion einer Raumrichtung auf die Bildfläche.
 *
 * Damit ein Fächer räumlich wirkt, darf er nicht in der Bildebene
 * aufgespannt werden: dreht sich ein Fächer im Raum um die Hochachse,
 * rücken die Strahlen perspektivisch zusammen, und die zum Betrachter
 * zeigenden werden größer. Genau diese Stauchung fehlt einer reinen
 * 2D-Drehung - deshalb sieht die immer wie ein flaches Rad aus.
 *
 * Koordinaten: x rechts, y oben, z vom Betrachter weg.
 * Bei dz = 0 ist das Ergebnis identisch zur flachen Darstellung, die
 * Bildgröße bleibt also erhalten.
 *
 * @param {number} dx,dy,dz – Richtung (muss nicht normiert sein)
 * @param {number} length   – Länge des Strahls in Pixeln
 * @param {number} fov      – Brennweite in Pixeln (größer = flacher)
 * @returns {{x:number,y:number,scale:number}} Bildversatz und Tiefenfaktor
 */
export function projectDirection(dx, dy, dz, length, fov = 1200) {
  const z = dz * length;
  // scale < 1 = weiter weg (kleiner), > 1 = näher am Betrachter
  const scale = fov / Math.max(fov * 0.2, fov + z);
  return { x: dx * length * scale, y: -dy * length * scale, scale };
}

/**
 * Zeichnet einen beliebigen Pfad im Laser-Look: breiter farbiger Halo
 * plus schmaler, sehr heller Kern. Genau das unterscheidet einen echten
 * Laserstrahl optisch von einer gewöhnlichen Linie - eine einfarbige
 * 1,5-px-Linie sieht immer nach Zeichenprogramm aus, nie nach Laser.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {() => void} tracePath – legt den Pfad an (ohne stroke())
 */
export function strokeLaserPath(ctx, tracePath, color, intensity, thickness = 1.5) {
  if (intensity <= 0.01) return;

  // 1. Halo
  ctx.beginPath();
  tracePath();
  ctx.strokeStyle = colorWithAlpha(color, intensity * 0.35);
  ctx.lineWidth = thickness * 3.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // 2. Farbiger Körper
  ctx.beginPath();
  tracePath();
  ctx.strokeStyle = colorWithAlpha(color, intensity * 0.85);
  ctx.lineWidth = thickness * 1.6;
  ctx.stroke();

  // 3. Weißer Kern
  ctx.beginPath();
  tracePath();
  ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, intensity)})`;
  ctx.lineWidth = Math.max(0.5, thickness * 0.55);
  ctx.stroke();
}

/**
 * Ein einzelner Laserpunkt: harter weißer Kern mit farbigem Halo.
 * Genau so sieht ein stehender Galvo-Punkt an der Wand aus.
 */
export function drawLaserDot(ctx, x, y, color, intensity, size = 2) {
  if (intensity <= 0.01) return;

  ctx.beginPath();
  ctx.arc(x, y, size * 2.6, 0, Math.PI * 2);
  ctx.fillStyle = colorWithAlpha(color, intensity * 0.30);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, size * 1.3, 0, Math.PI * 2);
  ctx.fillStyle = colorWithAlpha(color, intensity * 0.85);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.4, size * 0.5), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, intensity)})`;
  ctx.fill();
}

/**
 * Punkt auf dem Bildrand, im Uhrzeigersinn parametrisiert
 * (t in 0..1, 0 = Mitte der oberen Kante). Liefert normierte
 * Koordinaten (0..1) plus `aim`: den Winkel, in den ein Effekt von
 * dieser Randposition aus "nach innen" strahlen muss (0=oben,
 * PI=unten, -PI/2=links, PI/2=rechts - dieselbe Konvention wie
 * Scanner.js' baseOffset).
 *
 * Gemeinsam genutzt von LaserRenderer (originMotion:'edge') und
 * Scanner (orientation:'edge'), damit beide dieselbe Randbahn und
 * dieselbe Innen-Richtung berechnen.
 */
export function perimeterPoint(t) {
  const u = ((Number(t) || 0) % 1 + 1) % 1;
  // Vier gleich lange Segmente im Uhrzeigersinn, Start links oben:
  // oben → rechts → unten → links. Die Koordinaten bleiben dabei
  // immer im Bild (0..1) - eine frühere Fassung startete in der Mitte
  // der oberen Kante und lief dadurch bis x = 1.5, also aus dem Bild
  // heraus, wo der "Ursprung am Rand" gar nicht mehr sichtbar war.
  if (u < 0.25) {
    return { x: u / 0.25, y: 0, aim: Math.PI };                // obere Kante → nach unten
  } else if (u < 0.5) {
    return { x: 1, y: (u - 0.25) / 0.25, aim: -Math.PI / 2 };  // rechte Kante → nach links
  } else if (u < 0.75) {
    return { x: 1 - (u - 0.5) / 0.25, y: 1, aim: 0 };          // untere Kante → nach oben
  }
  return { x: 0, y: 1 - (u - 0.75) / 0.25, aim: Math.PI / 2 }; // linke Kante → nach rechts
}

/**
 * Ursprung eines zentrierten Effekts. Der Renderer lässt den Punkt
 * wandern (config.origin), damit kein Effekt an einem statischen
 * Mittelpunkt klebt. Fällt auf die Bildmitte zurück.
 *
 * `aim` (nur bei originMotion:'edge' gesetzt) ist der Winkel, in den
 * ein Effekt "nach innen" strahlen sollte, wenn der Ursprung am
 * Bildrand sitzt (0=oben, PI=unten, -PI/2=links, PI/2=rechts - dieselbe
 * Konvention wie Scanner.js' baseOffset). Effekte, die ihn ignorieren,
 * verhalten sich exakt wie zuvor.
 */
export function effectOrigin(config, W, H) {
  const o = config?.origin;
  if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) {
    const cx = o.x * W;
    const cy = o.y * H;
    // Ohne expliziten aim (nur originMotion:'edge' setzt einen) zeigt
    // "nach innen" jetzt Richtung Bildmitte statt pauschal nach oben -
    // harmlos, wenn der Ursprung eh in der Mitte sitzt (aim wird dann
    // 0, wie vorher), aber ein nützlicher Hinweis für Effekte, deren
    // Ursprung wandert (Scanner im Auto-Modus nutzt das, damit der
    // Fächer nicht bevorzugt an die nächste Bildkante zeigt).
    const aim = Number.isFinite(o.aim) ? o.aim : Math.atan2(W / 2 - cx, -(H / 2 - cy));
    return { cx, cy, aim };
  }
  return { cx: W / 2, cy: H / 2, aim: 0 };
}

export function getPaletteColor(palette, index, customColor) {
  return getPaletteColors(palette, customColor)[index % getPaletteColors(palette, customColor).length];
}
