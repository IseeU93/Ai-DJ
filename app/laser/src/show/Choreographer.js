// ============================================================
// Choreographer.js – Show State Machine (musikalisch statt zufällig)
//
// Das "Gehirn" der Show. Bekommt die komplette Analyse-Pipeline
// und entscheidet, WAS wann läuft. Leitgedanke dieser Version:
//
//   * Gewechselt wird an musikalischen Grenzen (Drop, Break,
//     Phrase, Section) – nicht nach Zufallstimern.
//   * Aggressiv ist die Show nur dort, wo die Musik aggressiv
//     ist: im Drop und auf harten Kicks. Verse/Groove laufen
//     bewusst ruhig, damit der Drop überhaupt knallt.
//   * Bei jedem Drop kommt ein ANDERER Effekt als bei den
//     letzten Drops – nie zweimal hintereinander derselbe.
//   * Effekte dürfen sich überlagern (Layering) – die Deckkraft
//     hängt an Energie und Phase.
//   * Effekt-Auswahl über Bewertung (Energiefit, Kontrast zum
//     laufenden Effekt, Neuheit), nicht über Math.random().
//
// States:
//   Ambient   → keine Musik / sehr wenig Energie
//   Groove    → laufender Beat, moderate Energie
//   Build     → steigende Spannung
//   Climax    → Drop / Peak
//   Breakdown → Energie bricht weg, Kick verschwindet
// ============================================================

const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);

/**
 * Effekt-Katalog: musikalische Eigenschaften jedes Effekts.
 *
 *  family      – ähnliche Familien sehen nacheinander langweilig aus
 *  energy      – [min, max] Energiebereich, in dem der Effekt wirkt
 *  aggression  – wie "hart" der Effekt wirkt (0 ruhig … 1 brutal)
 *  overlay     – taugt der Effekt als zweite Ebene über einem anderen?
 *  weight      – Grundgewichtung (hotBeams bewusst niedrig)
 */
export const EFFECT_CATALOG = {
  // requiresCalm: gehört in ruhige Passagen (Gesang, Intro, Break).
  // Über einem laufenden Uptempo-Beat wirken die feinen Kurven weder
  // treibend noch lesbar - sie flimmern nur.
  lissajous:   { family: 'geometry', energy: [0.00, 0.55], aggression: 0.15, overlay: false, weight: 1.0, requiresCalm: true },
  waveform:    { family: 'line',     energy: [0.00, 0.65], aggression: 0.20, overlay: false, weight: 1.0, requiresCalm: true },
  liquidSky:   { family: 'beams',    energy: [0.05, 0.85], aggression: 0.30, overlay: false, weight: 1.1 },
  tunnel:      { family: 'geometry', energy: [0.30, 1.00], aggression: 0.55, overlay: false, weight: 1.2 },
  // Fliegende Kreise: brauchen echten Schlagzeug-Antrieb, weil jeder
  // Kreis auf einem Beat losfliegt - ohne echten Kick nur der träge
  // Fallback-Timer. War früher als "Sog-Tunnel" auf die Rampe vor dem
  // Drop zugeschnitten; seit dem Umbau zu Kreisen, die quer über die
  // Fläche fliegen, ist das ein normaler, breiter einsetzbarer Effekt
  // (nicht mehr build-exklusiv gewichtet).
  // Die fliegenden Kreise sind der HÄRTESTE Effekt im Katalog: volle
  // Fläche, ständige Bewegung auf den Betrachter zu, jeder Kreis auf
  // einem Beat losgeschickt. Zusammen mit den Blitzen (chaosBlades)
  // ist das der Drop-Look - nicht mehr Hot Beams, das vorher allein
  // über seine Aggression bei fast jedem Drop nach oben gespült wurde.
  lsdTunnel:   { family: 'flying',   energy: [0.30, 1.00], aggression: 0.95, overlay: false, weight: 1.4, requiresDrive: true },
  scanner:     { family: 'beams',    energy: [0.25, 1.00], aggression: 0.60, overlay: false, weight: 1.2 },
  chaosBlades: { family: 'chaos',    energy: [0.55, 1.00], aggression: 0.92, overlay: true,  weight: 1.2 },
  // Hot Beams ist bewusst KEIN Drop-Brecher mehr: bewegte Strahlen,
  // die im Takt pumpen statt zu strobeln (siehe HotBeams.js -
  // Standardmodus ist 'solid'). Entsprechend niedrige Aggression, damit
  // der Autopilot es nicht mehr als Härte-Lieferant missversteht.
  hotBeams:    { family: 'strobe',   energy: [0.45, 1.00], aggression: 0.45, overlay: true,  weight: 0.25 },
  // Spirale: hypnotisch statt aggressiv, funktioniert über fast den
  // ganzen Energiebereich (langsam & ruhig im Ambient, schnell &
  // zoomend im Drop) - deshalb kein requiresCalm/requiresDrive.
  spiral:      { family: 'spiral',   energy: [0.05, 0.90], aggression: 0.35, overlay: false, weight: 1.0 },
  // Wandernde Schlange: für ruhige, wenig ereignisreiche Passagen -
  // dasselbe requiresCalm-Prinzip wie Lissajous/Waveform.
  snake:       { family: 'wander',   energy: [0.00, 0.35], aggression: 0.10, overlay: false, weight: 0.9, requiresCalm: true },
  // Balken-Sweep: kurzer, prägnanter Durchlauf quer über die Fläche -
  // funktioniert von Groove bis Climax, je nach `count` ein einzelner
  // Balken oder ein ganzer Fächer wie LiquidSky, nur gemeinsam
  // gerichtet statt unabhängig driftend.
  beamSweep:   { family: 'sweep',    energy: [0.15, 0.90], aggression: 0.40, overlay: false, weight: 1.0 },
  // Regenbogen-Ring: hypnotisch statt aggressiv, wie Spiral über einen
  // weiten Energiebereich einsetzbar (ruhiges Wandern im Ambient,
  // spürbarer Beat-Puls im Drop).
  rainbowRing: { family: 'ring',     energy: [0.05, 0.85], aggression: 0.30, overlay: false, weight: 1.0 },
};

/**
 * Visual strategy per state.
 *
 * trailRange: wie viel vom letzten Frame stehen bleibt (siehe
 * trailLength-Kommentar in Config.js). Alle Werte deutlich gesenkt -
 * die alten (0.60-0.92) ließen jede Bewegung eine sichtbare
 * "Geisterkopie" hinterherziehen (Ghosting), statt wie ein echter,
 * scharf sichtbarer Laserstrahl im Nebel zu wirken. Ruhige Zustände
 * behalten trotzdem etwas mehr Nachglühen als der Drop - ein Hauch
 * Dreamy-Look, aber kein Schweif.
 */
const STATE_STRATEGIES = {
  ambient: {
    effects:      ['lissajous', 'waveform', 'liquidSky', 'spiral', 'snake', 'rainbowRing'],
    colorMode:    'harmony',
    speedRange:   [0.1, 0.3],
    intensity:    [0.15, 0.35],
    trailRange:   [0.34, 0.44],
    preferMirror: false,
    strobeDiv:    1,
    aggression:   0.05,
    layering:     false,
  },
  groove: {
    // lissajous/waveform stehen mit in der Liste, weil "normale Musik
    // hören" oft Gesang über einem leichten Beat ist - kein eigener
    // Zustand, aber genauso ruhig. _effectAllowed entscheidet pro
    // Frame, ob die Stimme gerade trägt (dann die ruhigen Kurven)
    // oder der Beat (dann die treibenden Effekte).
    effects:      ['scanner', 'liquidSky', 'tunnel', 'lissajous', 'waveform', 'spiral', 'snake', 'beamSweep', 'rainbowRing'],
    colorMode:    'bar',
    speedRange:   [0.5, 0.9],
    intensity:    [0.45, 0.70],
    trailRange:   [0.32, 0.44],
    preferMirror: false,
    strobeDiv:    2,
    aggression:   0.25,
    layering:     false,
  },
  build: {
    effects:      ['lsdTunnel', 'tunnel', 'scanner', 'spiral', 'beamSweep', 'rainbowRing'],
    colorMode:    'beat',
    speedRange:   [0.8, 1.6],
    intensity:    [0.55, 0.85],
    trailRange:   [0.26, 0.38],
    preferMirror: true,
    strobeDiv:    4,
    aggression:   0.55,
    layering:     true,
  },
  climax: {
    effects:      ['scanner', 'tunnel', 'chaosBlades', 'liquidSky', 'hotBeams', 'lsdTunnel', 'spiral', 'beamSweep', 'rainbowRing'],
    colorMode:    'beat',
    speedRange:   [1.2, 2.0],
    intensity:    [0.85, 1.0],
    trailRange:   [0.14, 0.24],
    preferMirror: true,
    strobeDiv:    8,
    aggression:   1.0,
    layering:     true,
  },
  // Reine Gesangspassage: kein Beat, der etwas treiben könnte. Hier
  // wirkt jede Bewegung aufgesetzt, also bleibt die Show ruhig und
  // lässt die Stimme den Raum haben.
  vocal: {
    effects:      ['lissajous', 'waveform', 'liquidSky', 'snake'],
    colorMode:    'harmony',
    speedRange:   [0.15, 0.35],
    intensity:    [0.25, 0.45],
    trailRange:   [0.36, 0.46],
    preferMirror: false,
    strobeDiv:    1,
    aggression:   0.05,
    layering:     false,
  },
  breakdown: {
    effects:      ['liquidSky', 'lissajous', 'waveform', 'snake'],
    colorMode:    'bar',
    speedRange:   [0.25, 0.6],
    intensity:    [0.28, 0.50],
    trailRange:   [0.28, 0.38],
    preferMirror: false,
    strobeDiv:    1,
    aggression:   0.1,
    layering:     false,
  },
};

// Effect-specific presets per state.
//
// liquidSky.beatSwitch: in ruhigen Zuständen (ambient/vocal/breakdown)
// aus - dort reagiert ein Strahl auf den Beat nur mit einem sanften
// Tempo-Schub (Standardverhalten), kein harter Sprung. In groove/
// build/climax an: dort springt stattdessen ein Strahl auf jedem Beat
// zu einer neuen Höhe (Teleport) - das passt zum treibenden Teil.
const EFFECT_PRESETS = {
  ambient: {
    lsdTunnel: { ringCount: 1, rush: 0.4, warp: 0.2, lobes: 4, spokes: 0 },
    scanner:   { mode: 'sweep', sweepSpeed: 0.2, count: 1 },
    tunnel:    { ringCount: 2 },
    hotBeams:  { arrangement: 'fan', strobeDiv: 1, count: 5, motion: 'breathe', strobeMode: 'solid', spread: 120 },
    liquidSky: { height: 0.20, spread: 8, beamCount: 4, beatSwitch: false },
    lissajous: { beatSnap: false, autoPhase: true },
    chaosBlades: { boltCount: 2, decay: 0.90 },
    spiral: { arms: 2, turns: 1.5, zoom: 0.7, thickness: 1.2 },
    rainbowRing: { radius: 0.22, rotateSpeed: 0.5, pulseStrength: 0.3, thickness: 2.0 },
    snake: { speed: 0.7, wiggle: 0.4, pushStrength: 0.4, length: 180, thickness: 1.4 },
  },
  groove: {
    lsdTunnel: { ringCount: 1, rush: 0.8, warp: 0.3, lobes: 5, spokes: 0 },
    scanner:   { mode: 'sweep', sweepSpeed: 0.8, count: 2 },
    tunnel:    { ringCount: 4 },
    hotBeams:  { arrangement: 'fan', strobeDiv: 1, count: 7, motion: 'sweep', strobeMode: 'solid', spread: 150 },
    liquidSky: { height: 0.30, spread: 15, beamCount: 6, beatSwitch: true },
    lissajous: { beatSnap: true, autoPhase: true },
    chaosBlades: { boltCount: 3, decay: 0.88 },
    spiral: { arms: 3, turns: 2, zoom: 0.9, thickness: 1.5 },
    rainbowRing: { radius: 0.26, rotateSpeed: 0.8, pulseStrength: 0.5, thickness: 2.4 },
    snake: { speed: 1, wiggle: 0.5, pushStrength: 0.6, length: 220, thickness: 1.6 },
    beamSweep: { orientation: 'auto', count: 1, speed: 0.9, thickness: 1.8 },
  },
  build: {
    lsdTunnel: { ringCount: 2, rush: 1.5, warp: 0.5, lobes: 6, spokes: 1 },
    scanner:   { mode: 'cross', sweepSpeed: 1.2, count: 2 },
    tunnel:    { ringCount: 5 },
    hotBeams:  { arrangement: 'fan', strobeDiv: 2, count: 9, motion: 'sweep', strobeMode: 'solid', spread: 170 },
    liquidSky: { height: 0.35, spread: 20, beamCount: 7, beatSwitch: true },
    lissajous: { beatSnap: true, autoPhase: true },
    chaosBlades: { boltCount: 2, decay: 0.87, spread: 0.85, fullFrame: true },
    spiral: { arms: 4, turns: 2.4, zoom: 1.1, thickness: 1.8 },
    rainbowRing: { radius: 0.30, rotateSpeed: 1.2, pulseStrength: 0.7, thickness: 2.8 },
    beamSweep: { orientation: 'auto', count: 3, speed: 1.3, thickness: 2 },
  },
  climax: {
    lsdTunnel: { ringCount: 3, rush: 2.4, warp: 0.7, lobes: 7, spokes: 2 },
    scanner:   { mode: 'snap', sweepSpeed: 1.6, count: 3 },
    tunnel:    { ringCount: 6 },
    hotBeams:  { arrangement: 'star', strobeDiv: 2, count: 12, motion: 'rotate', strobeMode: 'pulse', spread: 200 },
    liquidSky: { height: 0.45, spread: 25, beamCount: 8, beatSwitch: true },
    lissajous: { beatSnap: true, autoPhase: true },
    chaosBlades: { boltCount: 3, decay: 0.85, spread: 0.95, fullFrame: true },
    spiral: { arms: 5, turns: 3, zoom: 1.3, thickness: 2 },
    rainbowRing: { radius: 0.34, rotateSpeed: 1.8, pulseStrength: 0.9, thickness: 3.2 },
    beamSweep: { orientation: 'auto', count: 5, speed: 1.8, thickness: 2.4 },
  },
  vocal: {
    lsdTunnel: { ringCount: 1, rush: 0.3, warp: 0.15, lobes: 3, spokes: 0 },
    scanner:   { mode: 'sweep', sweepSpeed: 0.25, count: 1 },
    tunnel:    { ringCount: 2 },
    hotBeams:  { arrangement: 'fan', strobeDiv: 1, count: 4, motion: 'breathe', strobeMode: 'solid', spread: 110 },
    liquidSky: { height: 0.22, spread: 10, beamCount: 4, beatSwitch: false },
    lissajous: { beatSnap: false, autoPhase: true },
    chaosBlades: { boltCount: 1, decay: 0.92 },
    snake: { speed: 0.6, wiggle: 0.35, pushStrength: 0.3, length: 160, thickness: 1.3 },
  },
  breakdown: {
    lsdTunnel: { ringCount: 1, rush: 0.5, warp: 0.25, lobes: 4, spokes: 0 },
    scanner:   { mode: 'sweep', sweepSpeed: 0.4, count: 1 },
    tunnel:    { ringCount: 3 },
    hotBeams:  { arrangement: 'parallel', strobeDiv: 1, count: 6, motion: 'sweep', strobeMode: 'solid', spread: 120 },
    liquidSky: { height: 0.15, spread: 10, beamCount: 4, beatSwitch: false },
    snake: { speed: 0.5, wiggle: 0.3, pushStrength: 0.25, length: 140, thickness: 1.3 },
    lissajous: { beatSnap: false, autoPhase: true },
    chaosBlades: { boltCount: 2, decay: 0.90 },
  },
};

// Palette selections per state
const STATE_PALETTES = {
  vocal:     ['cyan', 'green'],
  ambient:   ['green', 'cyan'],
  groove:    ['green', 'cyan', 'red'],
  build:     ['cyan', 'red', 'rainbow'],
  climax:    ['red', 'white', 'rainbow'],
  breakdown: ['green', 'cyan'],
};

// Effekte, die im Drop wirklich tragen. hotBeams steht bewusst
// NICHT drin - der Nutzer bekommt bei Drops Bewegung statt
// Dauerstrobe. lsdTunnel steht vorn: die fliegenden Kreise sind der
// härteste Effekt und sollen der Standard-Drop sein.
const DROP_POOL = ['lsdTunnel', 'tunnel', 'chaosBlades', 'scanner', 'beamSweep', 'liquidSky', 'spiral'];

/**
 * Effekt-Paarungen, die als Overlay zusammen zu viel werden - beide
 * für sich schon sehr "voll"/aggressiv, gemeinsam aber
 * Reizüberflutung statt Drop-Look. Rückmeldung dazu: "nicht so krasse
 * Effekte wie Blitze und Kreise gleichzeitig, das wird viel zu viel" -
 * vorher war genau diese Paarung sogar der bevorzugte Overlay-Partner
 * (PREFERRED_OVERLAY). Wird aus der Overlay-Kandidatenliste
 * ausgeschlossen, unabhängig von der sonstigen Bewertung; lsdTunnel
 * läuft in diesem Fall lieber ohne Overlay als mit den Blitzen
 * gemeinsam.
 */
const OVERLAY_CLASH = {
  lsdTunnel: ['chaosBlades'],
};

// ── Rückblick auf den bisherigen Beat ──────────────────────────
//
// Die Phase sagt, WAS die Musik gerade tut (stetiger Beat, Anlauf,
// Einschlag) - aber nicht, WIE HART. Ein durchgehend hämmernder Track
// und ein leichter Groove liefern beide die Phase "verse"; ohne
// weitere Bewertung bekämen beide dieselbe zurückhaltende Show. Genau
// das war der Fall "bei krassem Beat voll gechillt".
//
// Deshalb schaut der Choreograph zusätzlich zurück: über ein Fenster
// von mehreren Sekunden, wie laut es war UND ob dabei wirklich ein
// Beat lief. Ein einzelner lauter Takt reicht damit nicht, um die Show
// hochzureißen (das war die andere Hälfte: "beim Beat auf einmal am
// Ausrasten"), und ein kurzer Durchhänger wirft sie nicht zurück.
const DRIVE_WINDOW_FRAMES = 480;    // ~8 s bei 60 fps
// Absolute Schwellen, dieselbe Kalibrierung wie EnergyTracker's
// _highThreshold - dort markiert derselbe Wert "voll aufgedreht".
// Mit Hysterese, damit die Show an der Grenze nicht hin und her kippt.
const DRIVE_PEAK_LEVEL    = 0.45;
const DRIVE_RELEASE_LEVEL = 0.36;
// Ein Beat muss dabei wirklich laufen - eine laute Fläche ohne Schläge
// (Drone, Halbzeit-Outro, Applaus) ist kein harter Track.
const DRIVE_MIN_KICK = 0.02;

// Kurz nach einem ECHTEN Drop (nicht nur einem lauten Abschnitt) hält
// die Show die Eskalation, SOLANGE DER BEAT SPÜRBAR WEITERLÄUFT -
// unabhängig vom absoluten Pegel. Der gemeldete Fall: "nach dem Drop
// bei harten Kicks sind die Visuals entspannt". Direkt nach dem
// Einschlag fällt der Pegel oft ein Stück ab (der Mix atmet), obwohl
// der Kick unverändert durchhämmert - und dieser Abfall kann unter die
// normale Drive-Freigabeschwelle rutschen, bevor sich der Track
// überhaupt "beruhigt" hat. Bewusst getrennt von der generischen
// Pegel-Eskalation oben: die bleibt konservativ (siehe Kommentar dort,
// niedrigere Schwellen haben etablierte Tests gebrochen), dieses
// Zeitfenster wirkt nur in der Nachwirkung eines WIRKLICHEN Drops.
//
// 30s statt z.B. 10s, weil ein harter Drop-Ausklang (Kick läuft
// unverändert weiter, nur der Rest des Mixes atmet kurz) locker so
// lange tragen kann - kürzer gefasst wäre derselbe Bug nur um ein
// paar Sekunden verzögert. Trotzdem ein Zeitfenster und keine
// dauerhafte Kopplung an "läuft gerade ein Beat": praktisch jeder
// Songabschnitt hat einen Beat, eine unbefristete Kopplung würde die
// Show nach dem ersten Drop für den Rest des Tracks im Climax
// festnageln und ihr die Abwechslung nehmen.
const POST_DROP_GRACE_MS = 30000;

export class Choreographer {
  constructor() {
    // ── State ────────────────────────────────────────────
    this.state         = 'ambient';
    this._prevState    = 'ambient';
    this._stateTime    = 0;
    this._transitionProgress = 1;

    // ── Current decisions ────────────────────────────────
    this.primaryEffect   = 'lissajous';
    this.overlayEffect   = null;
    this.overlayOpacity  = 0;
    // Ebenen jenseits von Haupteffekt + erstem Overlay - nur befüllt,
    // wenn die Eskalationsstufe ("Hoch"/"Vollgas") mehr erlaubt.
    this._extraLayers    = [];
    this.palette         = 'green';
    this.speed           = 0.3;
    this.intensity       = 0.3;
    this.trailLength     = 0.40;
    this.colorMode       = 'harmony';
    this.mirror          = false;
    this.autoRotate      = true;
    this.strobeDiv       = 1;

    // Musikalische Zusatzwerte für die Renderer-Seite
    this.aggression      = 0;   // 0..1, wie hart die Show gerade fährt
    this.accent          = 0;   // 0..1, Kick-Akzent-Hüllkurve

    this.effectConfig    = {};

    // ── Transition ───────────────────────────────────────
    this._targetSpeed     = 0.3;
    this._targetIntensity = 0.3;
    this._targetTrail     = 0.40;
    this._targetAggression = 0;
    this._transitionRate  = 0.04;

    // ── Timing ───────────────────────────────────────────
    this._lastEffectChange  = 0;
    this._lastPaletteChange = 0;
    this._effectCooldown    = 4000;
    this._paletteCooldown   = 8000;
    this._effectStartBeat   = 0;
    this._minBeatsPerEffect = 16;   // mind. eine Phrase stehen lassen

    // ── Escalation ───────────────────────────────────────
    this.escalation = 0.5;

    // Master-Switch von außen (config.autoStrobe.enabled): steuert
    // nicht nur den Strobe-Gate/HotBeams-Overlay (siehe
    // _updateStrobePlan/_applyStrobeOverlay), sondern verhindert auch,
    // dass hotBeams - ein Effekt, der schon in seinem eigenen
    // Standardmodus ('pulse') stark im Beat pulsiert, also von sich
    // aus wie Strobe wirkt - überhaupt als Effekt gewählt wird.
    this.strobeAllowed = true;

    // ── Musikcharakter / sofortige Reaktion ──────────────
    // Der Autopilot wechselt nicht nach einer Anzahl Beats, sondern
    // sobald sich der Charakter der Musik ändert. Damit ein kurzer
    // Ausreißer nicht sofort umschaltet, muss der neue Charakter
    // erst ein paar Frames stabil anliegen.
    this.character        = null;
    // Fallback-Glättung, falls die Energie-Analyse keine Dichtewerte
    // liefert: ein einzelner Kick-Frame darf den Charakter nicht
    // frameweise umkippen lassen.
    this._kickDensityEma  = 0;
    this._hihatDensityEma = 0;
    this._characterKey    = null;
    this._pendingCharacter = null;
    this._pendingSince    = 0;
    this._mismatchSince   = 0;
    this._characterDebounceMs = 260;   // neuer Charakter muss halten
    this._mismatchGraceMs     = 450;   // Effekt passt nicht mehr zur Energie
    this._minSwitchGapMs      = 900;   // Stotterschutz (Struktur schlägt ihn)
    this.switchReason     = 'init';    // warum zuletzt gewechselt wurde

    // ── Strobe-Planung ───────────────────────────────────
    this.strobe        = { active: false, div: 1, mode: 'pulse', reason: 'off', duty: 0.4 };
    // Blanking-Gate für die gesamte Szene: in der Aus-Phase zeichnet
    // der Renderer nichts. Genau das ist "Strobe" bei einem Laser -
    // die Effekte selbst flackern, statt dass das Bild weiß wird.
    this.strobeGate    = { active: false, div: 4, duty: 0.35 };

    // ── Blackout-Planung ─────────────────────────────────
    // Der Autopilot setzt Blackouts selbst - als Dramaturgie-Mittel
    // an den Stellen, an denen ein Cut wirkt, nicht als Dauerzustand.
    this.blackout       = false;
    this.blackoutReason = 'off';
    this._blackoutUntil = -Infinity;
    this._lastBlackoutAt = -Infinity;
    this._minBlackoutGapMs = 4000;
    this._lastDropEnteredAt = -Infinity;
    this._dropEndedAt = 0;
    this.buildProgress = 0;
    this._baseOverlay  = null;
    this._baseOverlayOpacity = 0;
    this.hotBeamsConfig = null;

    // ── Variety ──────────────────────────────────────────
    this._effectHistory = [];
    this._maxHistory    = 6;
    this._dropHistory   = [];   // Effekte der letzten Drops
    this._paletteHistory = [];

    this._lastBeatCount = 0;
    this._lastPhase     = null;

    // ── Trackverlauf ─────────────────────────────────────
    // Ein Track ist ein Bogen, kein Zufallsgenerator: der erste Drop
    // darf kleiner sein als der dritte, und was in Minute 1 schon
    // dran war, soll in Minute 2 nicht schon wieder kommen. Diese
    // Werte beschreiben, WO im Track die Show gerade steht.
    // ── Rückblick auf den bisherigen Beat ────────────────
    // Gleitendes Fenster über Lautstärke und Schlag-Aktivität, siehe
    // die Konstanten oben. Daraus entsteht `sustainedDrive`: wie hart
    // die Musik in den letzten Sekunden WIRKLICH war.
    this._levelWindow     = [];
    this._kickWindow      = [];
    this.sustainedLevel   = 0;      // mittlere Lautstärke im Fenster
    this.sustainedKick    = 0;      // Schlag-Dichte im Fenster
    this.sustainedDrive   = false;  // hämmert der Track gerade durch?
    this.driveEscalated   = false;  // Climax aus dem Rückblick statt aus einem Drop
    this._inDetectedDrop  = false;  // läuft gerade ein WIRKLICH erkannter Drop?

    this._trackStartedAt  = null;   // erste Frame-Zeit mit hörbarer Musik
    this._trackDropCount  = 0;      // wie viele Drops bisher liefen
    this._trackEffectUse  = {};     // wie oft jeder Effekt schon dran war
    this._quietSince      = null;   // Stille -> vermutlich Trackwechsel
    this.trackProgress    = 0;      // 0..1, grobe Position im Track
    // Aus Nutzer-Eskalation UND Trackverlauf gemischt: der Bogen
    // steigt über den Track an, ohne den Regler zu überschreiben.
    this.arcEscalation    = 0.5;
  }

  // ── Rückblick auf den bisherigen Beat ─────────────────────

  /**
   * Schreibt Lautstärke und Schlag-Aktivität über ein gleitendes
   * Fenster mit und leitet daraus ab, ob der Track gerade wirklich
   * durchhämmert. Bewusst über mehrere Sekunden statt pro Frame:
   * die Show soll dem Verlauf folgen, nicht jedem einzelnen Takt.
   */
  _updateDrive(energy, transients, now) {
    const level = clamp01(energy.level);
    const kickHit = transients?.kick?.hit ? 1 : 0;

    this._levelWindow.push(level);
    this._kickWindow.push(kickHit);
    while (this._levelWindow.length > DRIVE_WINDOW_FRAMES) this._levelWindow.shift();
    while (this._kickWindow.length > DRIVE_WINDOW_FRAMES) this._kickWindow.shift();

    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    this.sustainedLevel = avg(this._levelWindow);
    // Bevorzugt der gemessene Wert aus der Energie-Analyse - das
    // Fenster hier ist nur der Rückfall, wenn er fehlt.
    this.sustainedKick = Number.isFinite(energy.kickDensity)
      ? Number(energy.kickDensity)
      : avg(this._kickWindow);

    const beatRunning = this.sustainedKick >= DRIVE_MIN_KICK;

    // Nachwirkung eines echten Drops: siehe Kommentar bei
    // POST_DROP_GRACE_MS. Läuft der Beat noch spürbar, bleibt die Show
    // eskaliert, egal was der Pegel gerade macht.
    const sinceDropEnd = this._dropEndedAt > 0 ? now - this._dropEndedAt : Infinity;
    if (sinceDropEnd >= 0 && sinceDropEnd < POST_DROP_GRACE_MS && beatRunning) {
      this.sustainedDrive = true;
      return;
    }

    // Das Fenster muss erst voll genug sein, sonst würde der Start
    // eines lauten Tracks sofort als "hämmert durch" gelten.
    if (this._levelWindow.length < DRIVE_WINDOW_FRAMES * 0.5) {
      this.sustainedDrive = false;
      return;
    }

    // Hysterese: rein bei PEAK, raus erst bei RELEASE.
    const threshold = this.sustainedDrive ? DRIVE_RELEASE_LEVEL : DRIVE_PEAK_LEVEL;
    this.sustainedDrive = beatRunning && this.sustainedLevel >= threshold;
  }

  // ── Trackverlauf ──────────────────────────────────────────

  /**
   * Schätzt, wie weit der Track fortgeschritten ist - ohne
   * Track-Metadaten, allein aus dem, was zu hören war: Spielzeit seit
   * der ersten hörbaren Stelle und Anzahl bereits gelaufener Drops.
   * Längere Stille setzt alles zurück (neuer Track).
   */
  _updateTrackProgress(energy, now) {
    const level = clamp01(energy.level);

    if (level < 0.03) {
      if (this._quietSince === null) this._quietSince = now;
      // Über 4 s Stille: der nächste Ton ist ein neuer Track.
      if (now - this._quietSince > 4000 && this._trackStartedAt !== null) {
        this._trackStartedAt = null;
        this._trackDropCount = 0;
        this._trackEffectUse = {};
        this.trackProgress = 0;
      }
    } else {
      this._quietSince = null;
      if (this._trackStartedAt === null) this._trackStartedAt = now;
    }

    if (this._trackStartedAt === null) {
      this.trackProgress = 0;
    } else {
      // Zwei unabhängige Schätzer, der großzügigere gewinnt: reine
      // Spielzeit (ein typischer Track läuft ~4 Minuten) und die Zahl
      // der Drops (nach dem dritten Drop ist man sicher im letzten
      // Drittel, egal wie lang der Track ist).
      const byTime = clamp01((now - this._trackStartedAt) / 240000);
      const byDrops = clamp01(this._trackDropCount / 3) * 0.8;
      this.trackProgress = Math.max(byTime, byDrops);
    }

    // Der Bogen steigt über den Track: dieselbe Reglerstellung fährt
    // am Anfang etwas zurückhaltender als am Ende.
    this.arcEscalation = clamp01(this.escalation * (0.75 + this.trackProgress * 0.45));
  }

  /**
   * Main update. Call once per frame.
   * @param {object} analysis – the full pipeline output
   * @param {number} now – performance.now()
   * @returns {object} – show decisions
   */
  update(analysis, now) {
    const energy     = analysis.energy || {};
    const rhythm     = analysis.rhythm || {};
    const transients = analysis.transients || {};
    const harmony    = analysis.harmony || {};

    // ── 0. Rückblick + Trackverlauf ──────────────────────
    this._updateDrive(energy, transients, now);
    this._updateTrackProgress(energy, now);

    // ── 1. Show-State bestimmen ──────────────────────────
    this._updateState(energy, rhythm, transients, now);

    // ── 2. Kick-Akzent (Aggression nur da, wo es kickt) ──
    this._updateAccent(transients, energy);

    // ── 3. Musikcharakter bestimmen ──────────────────────
    this.character = this._describeCharacter(energy, transients);

    // ── 4. Strobe-Plan (wann passt Strobe überhaupt?) ────
    this._updateStrobePlan(energy, now, rhythm);

    // ── 5. Effekte wählen ────────────────────────────────
    this._chooseEffects(energy, rhythm, transients, now);

    // ── 6. Palette wählen ────────────────────────────────
    this._choosePalette(energy, rhythm, harmony, now);

    // ── 7. Parameter interpolieren ───────────────────────
    this._interpolateParams(energy, rhythm, now);

    // ── 8. Effekt-Presets anwenden ───────────────────────
    this._applyEffectPresets();

    // ── 9. Strobe-Overlay über das normale Layering legen ─
    this._applyStrobeOverlay();

    // ── 10. Blackout-Dramaturgie ─────────────────────────
    this._updateBlackout(energy, rhythm, now);

    return this.getSnapshot();
  }

  // ── State Machine ─────────────────────────────────────────

  _updateState(energy, rhythm, transients, now) {
    this._prevState = this.state;
    const phase = energy.phase || 'intro';

    // ── Drop-Buchführung am ECHTEN Drop ──────────────────
    // Bewusst an der erkannten Phase festgemacht und nicht am
    // Show-Zustand: seit der Rückblick auch laute Abschnitte ohne Drop
    // in den Climax hebt, wäre "Zustand == climax" kein verlässliches
    // Signal mehr für "ein Drop hat eingeschlagen". Sonst zählte jeder
    // laute Abschnitt als Drop und der Nachklang nach einem echten
    // Drop käme nie, weil die Show den Climax gar nicht mehr verlässt.
    const inDrop = phase === 'drop';
    if (inDrop && !this._inDetectedDrop) {
      this._lastDropEnteredAt = now;
      this._trackDropCount++;
    } else if (!inDrop && this._inDetectedDrop) {
      this._dropEndedAt = now;
    }
    this._inDetectedDrop = inDrop;

    // Eine tragende Stimme ohne Beat gewinnt gegen die Phasenlogik:
    // dort ist jede treibende Show fehl am Platz. Im Drop gilt das
    // nicht - da ist ohnehin etwas anderes los.
    if (energy.vocalOnly && phase !== 'drop') {
      this.state = 'vocal';
      this._finishStateChange(now);
      return;
    }

    switch (phase) {
      case 'intro':
      case 'outro':
        this.state = 'ambient';
        break;
      case 'verse':
        this.state = 'groove';
        break;
      case 'build':
        this.state = 'build';
        break;
      case 'drop':
        this.state = 'climax';
        break;
      case 'break':
        this.state = 'breakdown';
        break;
      default:
        if (energy.level < 0.05) this.state = 'ambient';
        else if (energy.level < 0.35) this.state = 'groove';
        else if (energy.trend === 'rising') this.state = 'build';
        else if (energy.level > 0.7) this.state = 'climax';
        else this.state = 'groove';
    }

    // ── Korrektur aus dem Rückblick ──────────────────────
    // Ein durchgehend hämmernder Track liefert dieselbe Phase wie ein
    // leichter Groove ("verse"), verdient aber die große Show. Die
    // Phase sagt WAS passiert, der Rückblick WIE HART - erst beides
    // zusammen ergibt die richtige Entscheidung.
    //
    // Bewusst nur aus dem Groove heraus: die ruhigen Zustände
    // (vocal/breakdown/ambient) sind eigene musikalische Aussagen und
    // werden nicht überstimmt, und ein echter Drop ist ohnehin schon
    // Climax.
    this.driveEscalated = false;
    if (this.state === 'groove' && this.sustainedDrive) {
      this.state = 'climax';
      this.driveEscalated = true;
    }

    this._finishStateChange(now);
  }

  /** Übergangs-Buchhaltung nach einer Zustandsentscheidung. */
  _finishStateChange(now) {
    if (this.state !== this._prevState) {
      this._stateTime = now;
      this._transitionProgress = 0;
      // Drop-Zeitpunkte werden in _updateState an der erkannten Phase
      // geführt, nicht hier am Zustand - siehe Kommentar dort.
      // Der Drop schnappt hart um, alles andere blendet weich.
      this._transitionRate = this.state === 'climax' ? 0.35 : 0.05;
    }

    if (this._transitionProgress < 1) {
      this._transitionProgress = Math.min(1, this._transitionProgress + this._transitionRate);
    }
  }

  // ── Kick-Akzent ───────────────────────────────────────────

  /**
   * Die Show soll nicht dauerhaft brüllen, sondern auf Kicks
   * "atmen". Der Akzent ist eine schnelle Hüllkurve, die nur bei
   * einem echten Kick/Snare-Treffer neu gesetzt wird.
   */
  _updateAccent(transients, energy) {
    const kick = transients.kick || {};
    const snare = transients.snare || {};
    const velocity = Math.max(
      kick.hit ? clamp01(kick.velocity ?? 1) : 0,
      snare.hit ? clamp01(snare.velocity ?? 1) * 0.7 : 0,
    );

    if (velocity > 0) {
      this.accent = Math.max(this.accent, velocity);
    }
    this.accent *= 0.86;
    if (this.accent < 0.01) this.accent = 0;
  }

  // ── Effect Selection ──────────────────────────────────────

  _chooseEffects(energy, rhythm, transients, now) {
    const strategy = STATE_STRATEGIES[this.state];
    if (!strategy) return;

    const beatCount = Number(rhythm.beatCount) || 0;
    const isStateChange = this.state !== this._prevState;
    const level = clamp01(energy.level);

    const beatAdvanced = beatCount !== this._lastBeatCount;
    const sectionBoundary = rhythm.sectionBoundary !== undefined
      ? Boolean(rhythm.sectionBoundary)
      : (beatAdvanced && beatCount % 32 === 0);
    this._lastBeatCount = beatCount;

    // Nur ein WIRKLICH erkannter Drop zählt als "enteredDrop" - nicht
    // schon jeder Wechsel nach Climax. Sonst griffe beim Rückblick-
    // Climax (sustainedDrive, siehe _updateState) dieselbe Dramaturgie
    // wie bei einem echten Einschlag: DROP_POOL-Auswahl (favorisiert
    // die härtesten Effekte, oft die fliegenden Kreise) statt der
    // normalen, gemäßigteren Bewertung. Genau das ließ die Show bei
    // durchgehend hart geklopfter Musik ohne echten Drop - Rap/Trap
    // mit heißem 808 zum Beispiel - wirken, als würde sie mitten in
    // ganz normalen Lyrics plötzlich "ausrasten".
    const enteredDrop  = isStateChange && this.state === 'climax' && this._inDetectedDrop;
    const enteredBreak = isStateChange && this.state === 'breakdown';
    // Rückblick-Climax ohne echten Drop: bleibt lauter/schneller (das
    // ist gewollt - ein hart durchgehender Track SOLL präsenter
    // wirken), aber ohne die extremsten, drop-spezifischen Effekte.
    // hotBeams ist über strobeAllowed ohnehin oft schon raus; hier
    // zusätzlich die beiden "vollsten" Effekte ausschließen.
    const effectsPool = (this.state === 'climax' && this.driveEscalated)
      ? strategy.effects.filter((e) => e !== 'chaosBlades' && e !== 'lsdTunnel')
      : strategy.effects;

    // ── a) Charakterwechsel ──────────────────────────────
    // Sobald die Musik hörbar etwas anderes macht (Energieband,
    // Kick da/weg, Abschnittswechsel), wird sofort neu entschieden -
    // nicht erst an der nächsten Phrasengrenze.
    const key = this.character?.key || null;
    let characterChanged = false;
    if (key && key !== this._characterKey) {
      if (key !== this._pendingCharacter) {
        this._pendingCharacter = key;
        this._pendingSince = now;
      } else if (now - this._pendingSince >= this._characterDebounceMs) {
        characterChanged = true;
      }
    } else {
      this._pendingCharacter = null;
    }

    // ── b) Effekt passt nicht mehr zur Energie ───────────
    // Das ist der Fall "nach dem Drop gammelt ein langsamer Effekt
    // weiter": der laufende Effekt liegt außerhalb seines Energie-
    // fensters, also raus damit - unabhängig von jedem Beatzähler.
    const meta = EFFECT_CATALOG[this.primaryEffect];
    let mismatch = false;
    if (meta) {
      const tooQuiet = level > meta.energy[1] + 0.10;
      const tooLoud  = level < meta.energy[0] - 0.10;
      if (tooQuiet || tooLoud) {
        if (this._mismatchSince === 0) this._mismatchSince = now;
        if (now - this._mismatchSince >= this._mismatchGraceMs) mismatch = true;
      } else {
        this._mismatchSince = 0;
      }
    }

    // ── c) Abwechslung, wenn sich musikalisch nichts tut ─
    const beatsOnEffect = beatCount - this._effectStartBeat;
    const heldLongEnough = beatsOnEffect >= this._minBeatsPerEffect ||
      (now - this._lastEffectChange) > this._effectCooldown * 2;

    const gapOk = (now - this._lastEffectChange) >= this._minSwitchGapMs;

    // Läuft ein Effekt, dessen Voraussetzung weggefallen ist (etwa der
    // Sog-Tunnel, nachdem der Beat aufgehört hat), muss er sofort
    // weichen - unabhängig von Cooldowns.
    const notAllowed = !this._effectAllowed(this.primaryEffect);

    let reason = null;
    if (notAllowed) reason = 'effect-not-allowed';
    else if (isStateChange) reason = enteredDrop ? 'drop' : (enteredBreak ? 'break' : 'section-change');
    else if (mismatch && gapOk) reason = 'energy-mismatch';
    else if (characterChanged && gapOk) reason = 'character-change';
    else if (sectionBoundary && heldLongEnough) reason = 'variety';

    if (reason) {
      this._characterKey = key;
      this._pendingCharacter = null;
      this._mismatchSince = 0;

      const chosen = enteredDrop
        ? this._pickDropEffect(energy)
        : this._pickEffect(effectsPool, energy);

      if (chosen && chosen !== this.primaryEffect) {
        this.primaryEffect = chosen;
        this._lastEffectChange = now;
        this._effectStartBeat = beatCount;
        this.switchReason = reason;
        this._pushHistory(this._effectHistory, chosen, this._maxHistory);
        // Für den Trackverlauf mitzählen: was in diesem Track schon
        // dran war, tritt bei späteren Entscheidungen zurück.
        this._trackEffectUse[chosen] = (this._trackEffectUse[chosen] || 0) + 1;
        if (enteredDrop) this._pushHistory(this._dropHistory, chosen, 3);
      } else if (chosen) {
        this._effectStartBeat = beatCount;
      }

      this._updateOverlay(energy, chosen || this.primaryEffect);
    }

    if (energy.dropImminent && this.state === 'build') {
      // Kurz vor dem Drop leicht zurücknehmen – macht den Einschlag größer.
      this._targetIntensity = Math.max(0.3, this._targetIntensity - 0.01);
    }
  }

  // ── Musikcharakter ────────────────────────────────────────

  /**
   * Beschreibt, was die Musik gerade TUT - unabhängig von Takt und
   * Beatzähler. Der Schlüssel (key) ist die Kurzform: ändert er
   * sich, hat sich der Charakter geändert und die Show reagiert.
   */
  _describeCharacter(energy, transients) {
    const level = clamp01(energy.level);

    // Rohe Treffer glätten (EMA über ~1 s bei 60 fps).
    this._kickDensityEma += ((transients?.kick?.hit ? 1 : 0) - this._kickDensityEma) * 0.05;
    this._hihatDensityEma += ((transients?.hihat?.hit ? 1 : 0) - this._hihatDensityEma) * 0.05;

    const kickDensity = Number.isFinite(energy.kickDensity)
      ? Number(energy.kickDensity)
      : this._kickDensityEma;
    const hihatDensity = Number.isFinite(energy.hihatDensity)
      ? Number(energy.hihatDensity)
      : this._hihatDensityEma;

    let band;
    if (level < 0.06) band = 'silent';
    else if (level < 0.22) band = 'sparse';
    else if (level < 0.45) band = 'groove';
    else if (level < 0.70) band = 'driving';
    else band = 'peak';

    // Läuft ein Beat, oder ist es eine flächige Passage? (0.06 war für
    // einen simplen Kick-pro-Schlag-Beat real nie erreichbar, siehe
    // Kommentar in _effectAllowed.)
    const pulse = kickDensity > 0.03 ? 'beat' : 'flow';
    // Viele Hi-Hats = "busy", typisch für Builds und schnelle Parts.
    const texture = hihatDensity > 0.14 ? 'busy' : 'plain';

    // Gesangs-Antrieb: kontinuierliches Maß statt der binären
    // vocalOnly-Flagge. Die Flagge kippt erst nach knapp einer Sekunde
    // Anlaufzeit und verlangt fast komplett fehlenden Kick - genau der
    // Bereich dazwischen (Strophe mit Gesang UND leichtem Beat) ist
    // "normales Musikhören" und soll trotzdem keine treibenden Effekte
    // bekommen. Die Gates unten prüfen deshalb dieses Maß direkt.
    const vocalness = clamp01(Number(energy.vocalness) || 0);
    const dropImminent = Boolean(energy.dropImminent);

    return {
      band, pulse, texture, level, kickDensity, hihatDensity, vocalness, dropImminent,
      key: `${this.state}|${band}|${pulse}`,
    };
  }

  // ── Strobe-Planung ────────────────────────────────────────

  /**
   * Entscheidet, WANN Strobe musikalisch passt - und in welcher
   * Auflösung. Grundregel: Strobe gehört in den Drop und in die
   * Rampe kurz davor, niemals in Break, Intro oder Outro.
   */
  _updateStrobePlan(energy, now, rhythm = {}) {
    const tension = clamp01(energy.tension);
    const hihat = Number(this.character?.hihatDensity) || 0;
    const kick = Number(this.character?.kickDensity) || 0;
    const bpm = Number(rhythm?.bpm) > 0 ? Number(rhythm.bpm) : 128;
    const beatMs = 60000 / bpm;

    let active = false;
    let div = 1;
    let mode = 'pulse';
    let duty = 0.40;
    let reason = 'off';

    // Nachklang: die ersten Takte NACH dem Drop dürfen noch strobend
    // auslaufen - der Ausstieg ist musikalisch Teil des Drops.
    const sinceDropEnd = now - this._dropEndedAt;
    const dropAfterglow = this._dropEndedAt > 0 && sinceDropEnd < 2200
      && this.state !== 'breakdown' && this.state !== 'ambient' && this.state !== 'vocal';

    if (this.state === 'vocal') {
      // Gesangspassage: niemals.
      reason = 'vocal';
    } else if (dropAfterglow) {
      active = kick > 0.02 && this.escalation >= 0.35;
      div = 8;
      mode = 'gate';
      duty = 0.34;
      reason = active ? 'post-drop' : 'post-drop-quiet';
    } else if (this.state === 'breakdown' || this.state === 'ambient') {
      // Ruhige Abschnitte bleiben ruhig - hier zerstört Strobe die Dramaturgie.
      reason = 'calm';
    } else if (this.state === 'climax' && !this._inDetectedDrop) {
      // Climax allein aus dem Rückblick (lauter Abschnitt ohne
      // erkannten Drop) bekommt KEINEN Strobe. Strobe ist ein Akzent
      // auf ein Ereignis, keine Reaktion auf Lautstärke - sonst
      // flackert es bei jedem energiereichen Track dauerhaft.
      reason = 'loud-no-drop';
    } else if (this.state === 'climax') {
      // Strobe ist ein Akzent, kein Dauerzustand. Ein 30-Sekunden-Drop,
      // der durchgehend flackert, ist anstrengend und nimmt dem Strobe
      // jede Wirkung. Deshalb Bursts: die ersten zwei Takte nach dem
      // Einschlag, danach je nach Eskalation ein Takt alle 8 bzw. 4
      // Takte. Dazwischen läuft der Effekt sauber durch.
      const sinceEntry = now - this._lastDropEnteredAt;
      const beatsIn = sinceEntry / beatMs;
      const entryBurst = beatsIn < 8;                            // 2 Takte
      const accentPeriod = this.escalation > 0.9 ? 16 : 32;      // alle 4/8 Takte
      const accentBurst = this.escalation > 0.7 && (beatsIn % accentPeriod) < 4;
      const burst = this.escalation >= 0.35 && (entryBurst || accentBurst);

      active = kick > 0.03 && burst;
      div = hihat > 0.18 ? 8 : 4;
      mode = 'gate';
      duty = 0.30;
      reason = active ? 'drop' : (burst ? 'drop-no-kick' : 'drop-hold');
    } else if (this.state === 'build') {
      // Strobe gehört an den Drop, nicht in den ganzen Build. Ein
      // Build-up, das schon zwei Minuten vorher durchflackert, nimmt
      // dem Drop genau die Wirkung, für die der Strobe da ist.
      // Deshalb nur noch die Rampe unmittelbar davor (dropImminent).
      if (energy.dropImminent) {
        active = true; div = 16; mode = 'gate'; duty = 0.22; reason = 'pre-drop';
      } else {
        reason = 'build-hold';
      }
      this.buildProgress = tension;
    } else if (this.state === 'groove') {
      // Normale Musik bekommt keinen Strobe. Punkt.
      reason = 'groove-calm';
    }

    if (this.state !== 'build') this.buildProgress = 0;

    this.strobe = { active, div, mode, duty, reason };
    this.strobeDiv = active ? div : (this.state === 'groove' ? 2 : 1);

    // Szenen-Blanking: nur im Drop und in der Rampe direkt davor.
    // Je höher die Eskalation, desto kürzer die An-Phase - und damit
    // desto härter das Flackern.
    if (reason === 'drop' || reason === 'pre-drop' || reason === 'post-drop') {
      this.strobeGate = {
        active: true,
        div,
        duty: clamp(duty * (1.15 - this.escalation * 0.35), 0.12, 0.75),
      };
    } else {
      this.strobeGate = { active: false, div, duty };
    }

    // Passende Hot-Beams-Einstellung mitliefern, falls der Strobe
    // als Overlay gefahren wird.
    this.hotBeamsConfig = active
      ? {
          strobeDiv: div,
          strobeMode: mode,
          duty,
          motion: reason === 'pre-drop' ? 'static' : 'sweep',
          arrangement: reason === 'pre-drop' ? 'fan' : 'star',
          count: reason === 'pre-drop' ? 10 : 12,
        }
      : null;
  }

  // ── Blackout-Planung ──────────────────────────────────────

  /**
   * Blackouts als Dramaturgie: der harte Cut auf Schwarz wirkt genau
   * an drei Stellen - beim Einschlag des Drops (Hit-to-Black, danach
   * explodiert das Bild), beim Absturz in einen Break, und als
   * seltener Akzent auf einer Eins mitten im Drop. Überall sonst ist
   * ein Blackout nur ein Aussetzer.
   */
  _updateBlackout(energy, rhythm, now) {
    // Auch hier nur ein WIRKLICH erkannter Drop - sonst bekäme ein
    // Rückblick-Climax (durchgehend hart geklopfte Musik ohne echten
    // Einschlag, siehe Kommentar in _chooseEffects) denselben harten
    // Blackout-Cut wie ein echter Drop. _lastDropEnteredAt wird bereits
    // in _updateState korrekt (an die erkannte Phase gekoppelt)
    // geführt - hier nur noch lesen, nicht nochmal setzen.
    const enteredDrop = this.state === 'climax' && this._prevState !== 'climax' && this._inDetectedDrop;
    const enteredBreak = this.state === 'breakdown' && this._prevState !== 'breakdown';

    const gapOk = (now - this._lastBlackoutAt) >= this._minBlackoutGapMs;
    let trigger = null;
    let durationMs = 0;

    if (enteredDrop) {
      // Kurzer harter Cut direkt am Einschlag.
      trigger = 'drop-hit'; durationMs = 110;
    } else if (enteredBreak) {
      trigger = 'break-in'; durationMs = 180;
    } else if (
      gapOk &&
      this.state === 'climax' &&
      rhythm?.downbeat &&
      (now - this._lastDropEnteredAt) > 6000 &&
      this.escalation > 0.5
    ) {
      // Seltener Akzent auf der Eins, tief im Drop.
      trigger = 'drop-accent'; durationMs = 80;
    }

    if (trigger && (gapOk || enteredDrop || enteredBreak)) {
      this._lastBlackoutAt = now;
      this._blackoutUntil = now + durationMs;
      this.blackoutReason = trigger;
    }

    this.blackout = now < this._blackoutUntil;
    if (!this.blackout && this.blackoutReason !== 'off' && now >= this._blackoutUntil) {
      this.blackoutReason = 'off';
    }
  }

  /**
   * Der Riser vor dem Drop bekommt einen echten Strobe-Overlay -
   * das ist die eine Stelle, an der Hot Beams musikalisch sitzt.
   */
  _applyStrobeOverlay() {
    // Master-Schalter: hotBeams pulsiert in seinem Standardmodus stark im
    // Beat und wirkt daher von sich aus wie Strobe. Diese Methode setzt
    // overlayEffect='hotBeams' DIREKT, ohne durch _effectAllowed() zu
    // laufen - deshalb hier ein eigener Guard, sonst bleibt HotBeams bei
    // global abgeschaltetem Strobe trotzdem als Pre-Drop/Drop-Overlay aktiv.
    if (!this.strobeAllowed) {
      if (this.overlayEffect === 'hotBeams') {
        this.overlayEffect = this._baseOverlay;
        this.overlayOpacity = this._baseOverlayOpacity;
      }
      return;
    }

    const primaryMeta = EFFECT_CATALOG[this.primaryEffect];
    // Im Drop bekommt der Strobe nur dann eine eigene Ebene, wenn der
    // Haupteffekt nicht ohnehin schon aus Strahlen besteht - sonst
    // liegt Strobe auf Strobe und es wird nur unruhig.
    //
    // Und er verdrängt niemals die Blitze: die sind im Drop der
    // Akzent, der den Einschlag setzt. Vorher belegte der Strobe die
    // Overlay-Ebene jeden Frame neu und schob chaosBlades komplett aus
    // der Show - im Drop war dann ausgerechnet Hot Beams zu sehen und
    // von den Blitzen gar nichts.
    const boltsRunning = this._baseOverlay === 'chaosBlades'
      || this._extraLayers.includes('chaosBlades');
    const dropStrobeFits =
      this.strobe.reason === 'drop' &&
      this.escalation > 0.6 &&
      !boltsRunning &&
      primaryMeta && primaryMeta.family !== 'beams' && primaryMeta.family !== 'strobe';

    if (this.strobe.reason === 'pre-drop') {
      this.overlayEffect = 'hotBeams';
      this.overlayOpacity = 1;
    } else if (dropStrobeFits) {
      this.overlayEffect = 'hotBeams';
      this.overlayOpacity = 1;
    } else if (this.overlayEffect === 'hotBeams' && this._baseOverlay !== 'hotBeams') {
      this.overlayEffect = this._baseOverlay;
      this.overlayOpacity = this._baseOverlayOpacity;
    }
  }

  /**
   * Bewertet Kandidaten musikalisch statt zufällig:
   * Energiefit + Kontrast zum laufenden Effekt + Neuheit.
   */
  _pickEffect(candidates, energy, { exclude = [] } = {}) {
    const level = clamp01(energy.level);
    const current = EFFECT_CATALOG[this.primaryEffect];
    let pool = candidates.filter((e) => EFFECT_CATALOG[e] && !exclude.includes(e)
      && this._effectAllowed(e));
    if (pool.length === 0) return this.primaryEffect;

    // Effekte, die zur aktuellen Energie schlicht nicht passen, fliegen
    // hart raus - sonst landet nach einem Drop wieder ein Schleicher
    // auf der Leinwand, nur weil er "an der Reihe" wäre.
    const fitting = pool.filter((e) => {
      const [lo, hi] = EFFECT_CATALOG[e].energy;
      return level >= lo - 0.05 && level <= hi + 0.05;
    });
    if (fitting.length > 0) pool = fitting;

    // Was die Musik gerade TUT - das entscheidet stärker als jede
    // Zustandslogik, ob ein Effekt passt oder aufgesetzt wirkt.
    const pulse = this.character?.pulse || 'flow';
    const vocalness = clamp01(Number(this.character?.vocalness) || 0);

    let best = null;
    let bestScore = -Infinity;

    for (const key of pool) {
      const meta = EFFECT_CATALOG[key];
      let score = meta.weight;

      // Energiefit: liegt der Track im Wohlfühlbereich des Effekts?
      // Deutlich schärfer gewichtet als vorher - ein Effekt außerhalb
      // seines Energiefensters ist der häufigste Grund dafür, dass
      // "der Effekt überhaupt nicht zur Musik passt".
      const [lo, hi] = meta.energy;
      if (level < lo) score -= (lo - level) * 3.5;
      else if (level > hi) score -= (level - hi) * 3.5;
      else score += 0.8;

      // Aggressionsfit: passt die Härte zur aktuellen Phase? Der
      // Trackverlauf hebt den Anspruch über den Track an (arcEscalation),
      // damit der letzte Drop härter ausfällt als der erste.
      const wantedAggression = clamp01(
        (STATE_STRATEGIES[this.state]?.aggression ?? 0.3) * (0.6 + this.arcEscalation * 0.8),
      );
      score -= Math.abs(meta.aggression - wantedAggression) * 0.9;

      // Puls-Fit: läuft ein echter Beat, tragen harte, treibende
      // Effekte - und die feinen Kurven flimmern nur mit. Über einer
      // flächigen Passage ohne Schläge ist es exakt umgekehrt.
      if (pulse === 'beat') {
        score += (meta.aggression - 0.3) * 0.8;
        if (meta.requiresCalm) score -= 0.8;
      } else {
        score -= (meta.aggression - 0.3) * 1.0;
      }

      // Eine tragende Stimme verträgt keine Härte, egal was die
      // Energiekurve gerade meldet.
      score -= vocalness * meta.aggression * 1.2;

      // Kontrast: andere Familie als der laufende Effekt wirkt frischer.
      if (current && meta.family !== current.family) score += 0.4;
      if (key === this.primaryEffect) score -= 1.2;

      // Neuheit: was zuletzt lief, wird deutlich abgewertet.
      const idx = this._effectHistory.lastIndexOf(key);
      if (idx >= 0) {
        const recency = (idx + 1) / this._effectHistory.length; // 1 = zuletzt
        score -= recency * 1.4;
      }

      // Trackverlauf: was in diesem Track schon oft dran war, tritt
      // zurück - damit ein langer Track nicht dreimal dieselbe
      // Handvoll Effekte durchspielt.
      score -= Math.min(this._trackEffectUse[key] || 0, 4) * 0.3;

      // Minimales Rauschen, damit gleichwertige Kandidaten wechseln -
      // schwächer als vorher, damit die musikalischen Kriterien
      // wirklich den Ausschlag geben und nicht der Zufall.
      score += Math.random() * 0.15;

      if (score > bestScore) { bestScore = score; best = key; }
    }

    return best;
  }

  /**
   * Drop-Auswahl: garantiert ein anderer Effekt als bei den
   * letzten Drops – genau das, was vorher gefehlt hat.
   */
  /**
   * Darf dieser Effekt gerade überhaupt laufen?
   *
   * Effekte mit `requiresDrive` brauchen echte Schläge oder die Rampe
   * vor dem Drop. Sie werden ausdrücklich NICHT über die Energie
   * freigegeben: eine Tieftonfläche unter einer Gesangsspur hebt die
   * Energie genauso an wie ein Beat, treibt aber nichts. Ein
   * schwellender Refrain tut das auch - steigende Energie, dichtere
   * Hi-Hats, heller werdendes Spektrum sind genau die Merkmale, die
   * die Phasenerkennung als "Build" liest, obwohl kein einziger Kick
   * fällt. Deshalb reicht "wir sind im Build" allein nicht mehr:
   * verlangt wird zusätzlich entweder echte Kick-Dichte oder ein
   * konkret angekündigter Drop (dropImminent, der Tension UND
   * Hi-Hat-Aufbau UND zeitlichen Abstand zum letzten Drop verlangt -
   * ein Vielfaches spezifischer als bloß "Build").
   */
  _effectAllowed(key) {
    // hotBeams pulsiert schon in seinem Standardmodus stark im Beat -
    // wirkt also von sich aus wie Strobe, unabhängig vom
    // Gate/Overlay-Mechanismus. Bei global abgeschaltetem Strobe darf
    // der Autopilot den Effekt deshalb gar nicht erst wählen.
    if (key === 'hotBeams' && !this.strobeAllowed) return false;

    const meta = EFFECT_CATALOG[key];
    const CALM_STATES = ['vocal', 'ambient', 'breakdown'];
    const kickDensity = Number(this.character?.kickDensity) || 0;
    const vocalness = clamp01(Number(this.character?.vocalness) || 0);

    // kickDensity ist der Anteil der letzten ~1s, in dem der Kick
    // getroffen hat - und ein Treffer ist ein einzelner Frame, kein
    // gehaltenes Flag. Ein stinknormaler Beat (ein Kick pro Schlag)
    // liegt dadurch rechnerisch nur bei ~0.033 (120 BPM) bis ~0.048
    // (174 BPM), nie höher. Die Schwellen hier sind auf diesen
    // tatsächlich erreichbaren Bereich kalibriert (siehe dieselbe
    // Korrektur in EnergyTracker._detectPhase) - mit 0.05/0.08 war
    // "wirklich treibender Beat" für echte Musik so gut wie nie
    // erreichbar.
    if (meta?.requiresCalm) {
      // Nur in ruhigen Abschnitten - und auch dort nicht, wenn wider
      // Erwarten ein dichter Beat läuft.
      if (CALM_STATES.includes(this.state)) return kickDensity < 0.025;
      // Im Groove trägt oft der Gesang über einem leichten Beat - das
      // ist "normales Musikhören" und darf die ruhigen Kurven auch
      // ohne eigenen Gesangs-Zustand bekommen.
      if (this.state === 'groove') return vocalness > 0.4 && kickDensity < 0.025;
      return false;
    }

    if (!meta?.requiresDrive) return true;

    // Eine tragende Stimme verträgt sich mit keinem treibenden Effekt -
    // unabhängig davon, welche Phase die Energie gerade meldet. Das
    // ist genau der Fall, den ein schwellender Refrain sonst als
    // "Build" durchrutschen lässt.
    if (vocalness > 0.35) return false;
    if (CALM_STATES.includes(this.state)) return false;

    if (this.state === 'climax') return kickDensity >= 0.028;
    if (this.state === 'build') return kickDensity >= 0.028 || Boolean(this.character?.dropImminent);
    // Groove: nur bei wirklich treibendem, spürbarem Beat - "ab und zu
    // ein Akzent" reicht nicht für einen Effekt, der Antrieb braucht.
    return kickDensity >= 0.035;
  }

  _pickDropEffect(energy) {
    const strategyEffects = STATE_STRATEGIES.climax.effects;
    const pool = DROP_POOL.filter((e) => strategyEffects.includes(e));
    // Auch ausschließen, was gerade schon läuft: sonst kann ein Drop
    // "frisch" (nicht in _dropHistory) einen Effekt wählen, der aber
    // zufällig identisch mit dem noch laufenden Build-Effekt ist - dann
    // wechselt sichtbar gar nichts, obwohl die Bewertung "neu" dachte.
    const notCurrent = pool.filter((e) => e !== this.primaryEffect);
    const fresh = notCurrent.filter((e) => !this._dropHistory.includes(e));
    const candidates = fresh.length > 0
      ? fresh
      : notCurrent.filter((e) => e !== this._dropHistory[this._dropHistory.length - 1]);
    return this._pickEffect(
      candidates.length > 0 ? candidates : (notCurrent.length > 0 ? notCurrent : pool),
      energy,
    );
  }

  /**
   * Bevorzugter Overlay-Partner im Drop - unabhängig davon, welcher
   * Effekt gerade vorne läuft, gehören die Blitze im Climax dazu: der
   * einzige Effekt, der den Einschlag punktuell akzentuiert, statt nur
   * weiterzulaufen. Ausnahme: OVERLAY_CLASH-Paarungen (siehe dort) -
   * die sind schon aus `candidates` raus, `partner` kann dann also nie
   * matchen, aber der Kommentar hier hält fest, warum lsdTunnel
   * absichtlich NICHT bevorzugt mit den Blitzen läuft.
   */
  _preferredOverlayFor(primary, candidates) {
    // Nur im ECHTEN Drop bevorzugt - ein Rückblick-Climax (siehe
    // Kommentar in _chooseEffects) bekommt die Blitze nicht automatisch
    // aufgedrängt, sonst liefen sie bei durchgehend hart geklopfter
    // Musik ohne echten Einschlag (Rap/Trap z.B.) quasi dauerhaft mit.
    const partner = (this.state === 'climax' && !this.driveEscalated && candidates.includes('chaosBlades'))
      ? 'chaosBlades'
      : null;
    if (!partner) return null;
    if (!this._effectAllowed(partner)) return null;
    return partner;
  }

  /**
   * Layering: zweite Ebene über dem Hauptaffekt. Erlaubt in Build
   * und Climax (und mit hoher Eskalation auch im Groove), Deckkraft
   * hängt an Energie und Phase.
   */
  _updateOverlay(energy, primary) {
    const strategy = STATE_STRATEGIES[this.state];
    const level = clamp01(energy.level);

    const maxLayers = this._maxEffectLayers();
    // Bei "Niedrig" (maxLayers === 1) läuft grundsätzlich kein Overlay,
    // egal was Zustand/Energie sonst erlauben würden. Layering ist
    // außerdem Drop-Dramaturgie: mehrere Ebenen gleichzeitig markieren
    // den Einschlagsmoment, sind aber nicht für einen ganzen,
    // durchgehend hart geklopften Track ohne echten Drop gedacht -
    // genau das ist Rap/Trap mit heißem 808: laut und hart die ganze
    // Zeit, ohne Kontrast. Rückblick-Climax (driveEscalated) bekommt
    // deshalb nur den einen, präsenteren Haupteffekt statt zusätzlich
    // gestapelter Ebenen über die komplette Spielzeit.
    const allowed = strategy?.layering && this.escalation > 0.25 && maxLayers > 1
      && !(this.state === 'climax' && this.driveEscalated);
    if (!allowed) {
      this._baseOverlay = null;
      this._baseOverlayOpacity = 0;
      this.overlayEffect = null;
      this.overlayOpacity = 0;
      this._extraLayers = [];
      return;
    }

    const primaryMeta = EFFECT_CATALOG[primary];
    const candidates = Object.keys(EFFECT_CATALOG).filter((key) => {
      const meta = EFFECT_CATALOG[key];
      if (!meta.overlay) return false;
      if (key === primary) return false;
      // Gleiche Familie übereinander sieht nur nach Doppelbild aus.
      if (primaryMeta && meta.family === primaryMeta.family) return false;
      // Die ganz harten Overlays (>0.8 Aggression, z.B. die Blitze)
      // sind nur im ECHTEN Drop frei - ein Rückblick-Climax ohne
      // erkannten Drop bekommt sie nicht, sonst liefe z.B. bei
      // durchgehend hart geklopftem Rap/Trap ohne echten Einschlag
      // dieselbe Drop-Dramaturgie quasi dauerhaft mit.
      if (!(this.state === 'climax' && !this.driveEscalated) && meta.aggression > 0.8) return false;
      // Zwei sehr "volle" Effekte gemeinsam sind zu viel (siehe
      // OVERLAY_CLASH) - lieber ohne Overlay als überladen.
      if (OVERLAY_CLASH[primary]?.includes(key)) return false;
      return true;
    });

    if (candidates.length === 0) {
      this._baseOverlay = null;
      this._baseOverlayOpacity = 0;
      this.overlayEffect = null;
      this.overlayOpacity = 0;
      this._extraLayers = [];
      return;
    }

    // Feste Paarung zuerst (fliegende Kreise + Blitze), sonst bewerten.
    this.overlayEffect = this._preferredOverlayFor(primary, candidates)
      || this._pickEffect(candidates, energy, { exclude: [primary] });
    // Keine Halbtransparenz mehr: ein Laser ist an oder aus. Die zweite
    // Ebene wird genauso voll gezeichnet wie die erste.
    this.overlayOpacity = 1;
    this._baseOverlay = this.overlayEffect;
    this._baseOverlayOpacity = this.overlayOpacity;

    // Dritte Ebene und mehr: nur wenn die Eskalationsstufe es zulässt
    // ("Hoch" = 3, "Vollgas" = kein Limit).
    this._extraLayers = this._pickExtraLayers(energy, primary, this.overlayEffect, maxLayers);
  }

  /**
   * Ebenen jenseits von Haupteffekt + erstem Overlay. Jede weitere
   * Ebene braucht eine eigene Familie und muss selbst als Overlay
   * taugen - sonst sieht es nur nach Doppelbild statt nach mehr Show
   * aus. "Vollgas" (maxLayers === Infinity) nimmt so viele, wie der
   * Katalog an familienfremden, überlagerungsfähigen Effekten hergibt.
   */
  _pickExtraLayers(energy, primary, firstOverlay, maxLayers) {
    if (!(maxLayers > 2)) return [];

    const used = new Set([primary, firstOverlay].filter(Boolean));
    const usedFamilies = new Set(
      [primary, firstOverlay]
        .map((key) => EFFECT_CATALOG[key]?.family)
        .filter(Boolean),
    );

    let pool = Object.keys(EFFECT_CATALOG).filter((key) => {
      const meta = EFFECT_CATALOG[key];
      if (!meta.overlay) return false;
      if (used.has(key)) return false;
      if (usedFamilies.has(meta.family)) return false;
      // Dieselbe Ausnahme wie in _updateOverlay: die ganz harten
      // Overlays sind nur im ECHTEN Drop frei, nicht schon bei jedem
      // Rückblick-Climax (siehe dortiger Kommentar).
      if (!(this.state === 'climax' && !this.driveEscalated) && meta.aggression > 0.8) return false;
      return true;
    });

    const layers = [];
    // +2 = Haupteffekt und erstes Overlay sind schon vergeben.
    while (pool.length > 0 && (maxLayers === Infinity || layers.length + 2 < maxLayers)) {
      const pick = this._pickEffect(pool, energy, { exclude: [...used] });
      if (!pick || used.has(pick)) break;
      layers.push(pick);
      used.add(pick);
      const fam = EFFECT_CATALOG[pick]?.family;
      pool = pool.filter((key) => key !== pick && EFFECT_CATALOG[key]?.family !== fam);
    }
    return layers;
  }

  /**
   * Eskalationsstufe → maximale Zahl gleichzeitig laufender Effekte
   * (Haupteffekt eingerechnet). Der Autopilot-Slider im UI hat vier
   * Stufen: Niedrig = 1, Mittel = 2, Hoch = 3, Vollgas = kein Limit
   * (die Katalog-/Familienregeln setzen dort die praktische Grenze).
   */
  _maxEffectLayers() {
    const e = this.escalation;
    if (e < 0.3) return 1;
    if (e < 0.6) return 2;
    if (e < 0.9) return 3;
    return Infinity;
  }

  // ── Palette Selection ─────────────────────────────────────

  _choosePalette(energy, rhythm, harmony, now) {
    const strategy = STATE_STRATEGIES[this.state];
    if (!strategy) return;

    const timeSinceChange = now - this._lastPaletteChange;
    const sectionBoundary = Boolean(rhythm.sectionBoundary);

    const shouldChange = (
      (this.state !== this._prevState) ||
      (sectionBoundary && timeSinceChange > this._paletteCooldown) ||
      (harmony.chordChanged && timeSinceChange > this._paletteCooldown) ||
      (timeSinceChange > this._paletteCooldown * 3)
    );

    if (shouldChange) {
      if (strategy.colorMode === 'harmony' && harmony.suggestedPalette) {
        this.palette = 'custom';
      } else {
        const palettes = STATE_PALETTES[this.state] || ['green'];
        let pool = [...palettes];
        if (this.escalation > 0.7) pool.push('rainbow');
        if (this.escalation > 0.9 && this.state === 'climax') pool.push('white');

        // Nicht zweimal hintereinander dieselbe Farbe.
        const fresh = pool.filter((p) => p !== this.palette);
        const source = fresh.length > 0 ? fresh : pool;
        this.palette = source[Math.floor(Math.random() * source.length)];
        this._pushHistory(this._paletteHistory, this.palette, 4);
      }

      this._lastPaletteChange = now;
    }

    this.colorMode = strategy.colorMode;
  }

  // ── Parameter Interpolation ───────────────────────────────

  _interpolateParams(energy, rhythm, now) {
    const strategy = STATE_STRATEGIES[this.state];
    if (!strategy) return;

    const energyT = clamp01(energy.level);

    // Die Animationsgeschwindigkeit hängt am echten Tempo: ein
    // 150-BPM-Track läuft sichtbar schneller als ein 105-BPM-Track.
    const bpm = Number(rhythm?.bpm) > 0 ? Number(rhythm.bpm) : 128;
    const tempoFactor = clamp(bpm / 128, 0.7, 1.6);

    const [minSpeed, maxSpeed] = strategy.speedRange;
    this._targetSpeed = (minSpeed + (maxSpeed - minSpeed) * energyT) * tempoFactor;

    const [minInt, maxInt] = strategy.intensity;
    // Grundhelligkeit bleibt moderat; der "Punch" kommt aus dem
    // Kick-Akzent, nicht aus einer dauerhaft hohen Intensität.
    const base = minInt + (maxInt - minInt) * (energyT * 0.7 + this.escalation * 0.3);
    const accentBoost = this.accent * (0.10 + strategy.aggression * 0.25);
    this._targetIntensity = clamp(base + accentBoost, 0, 1);

    const [minTrail, maxTrail] = strategy.trailRange;
    this._targetTrail = maxTrail - (maxTrail - minTrail) * energyT;

    this._targetAggression = clamp01(
      strategy.aggression * (0.5 + this.escalation * 0.7) * (0.75 + energyT * 0.35),
    );

    const rate = this.state === 'climax' ? 0.18 : 0.06;
    this.speed       += (this._targetSpeed     - this.speed)      * rate;
    this.intensity   += (this._targetIntensity - this.intensity)  * (rate * 2);
    this.trailLength += (this._targetTrail     - this.trailLength) * rate;
    this.aggression  += (this._targetAggression - this.aggression) * rate;

    this.mirror     = strategy.preferMirror && this.escalation > 0.4;
    this.autoRotate = true;
    // strobeDiv kommt aus _updateStrobePlan() - dort entscheidet sich
    // musikalisch, ob Strobe überhaupt passt.
  }

  // ── Effect Presets ────────────────────────────────────────

  _applyEffectPresets() {
    this.effectConfig = this._presetFor(this.primaryEffect) || {};
  }

  /**
   * Berechnet die skalierten Preset-Werte (EFFECT_PRESETS[state][key])
   * für einen einzelnen Effekt-Key, inklusive der escalation-/
   * aggression-Skalierung. Wird sowohl für den Haupteffekt
   * (_applyEffectPresets) als auch für jede aktive Overlay-Ebene
   * genutzt (siehe getSnapshot -> overlayEffectConfigs) - vorher gab
   * es Presets nur für den Haupteffekt, wodurch z.B. BeamSweep als
   * Overlay-Layer nie sein state-abhängiges "count" bekam und optisch
   * wie ein fest hängender Wert wirkte ("Anzahl-Regler tut nichts,
   * vor allem vom Autopiloten").
   */
  _presetFor(key) {
    const presets = EFFECT_PRESETS[this.state];
    if (!presets) return null;
    const preset = presets[key];
    if (!preset) return null;

    const out = { ...preset };
    if (out.sweepSpeed) {
      out.sweepSpeed *= (0.7 + this.escalation * 0.6);
    }
    if (out.count) {
      out.count = Math.round(out.count * (0.8 + this.escalation * 0.4));
    }
    if (out.lines) {
      out.lines = Math.round(out.lines * (0.8 + this.escalation * 0.4));
    }
    if (out.motionSpeed === undefined && out.motion) {
      out.motionSpeed = 0.6 + this.aggression * 1.2;
    }
    return out;
  }

  /**
   * Returns the current show decisions as a plain object.
   */
  getSnapshot() {
    return {
      state:          this.state,
      primaryEffect:  this.primaryEffect,
      overlayEffect:  this.overlayEffect,
      overlayOpacity: this.overlayOpacity,
      // Alle Overlay-Ebenen (0..n), overlayEffect bleibt die erste
      // davon - bestehende Konsumenten brauchen sich nicht zu ändern.
      overlayEffects: this._composeOverlayEffects(),
      // Preset-Config je aktiver Overlay-Ebene (state-abhängig, siehe
      // _presetFor) - overlayEffect selbst bekommt sein Preset nicht
      // automatisch über effectConfig (das gilt nur für primaryEffect).
      overlayEffectConfigs: this._composeOverlayEffects().reduce((acc, key) => {
        const preset = this._presetFor(key);
        if (preset) acc[key] = preset;
        return acc;
      }, {}),
      palette:        this.palette,
      speed:          this.speed,
      intensity:      this.intensity,
      trailLength:    this.trailLength,
      colorMode:      this.colorMode,
      mirror:         this.mirror,
      autoRotate:     this.autoRotate,
      strobeDiv:      this.strobeDiv,
      aggression:     this.aggression,
      accent:         this.accent,
      strobe:         { ...this.strobe },
      strobeMode:     this.strobe.mode,
      strobeGate:     { ...this.strobeGate },
      blackout:       this.blackout,
      blackoutReason: this.blackoutReason,
      hotBeamsConfig: this.hotBeamsConfig ? { ...this.hotBeamsConfig } : null,
      buildProgress:  this.buildProgress,
      // Wo im Track die Show steht (0..1) und wie viele Drops schon
      // liefen - der Bogen, nach dem der Autopilot mitentscheidet.
      trackProgress:  this.trackProgress,
      trackDrops:     this._trackDropCount,
      character:      this.character ? { ...this.character } : null,
      switchReason:   this.switchReason,
      effectConfig:   this.effectConfig,
      transition:     this._transitionProgress,
    };
  }

  // ── Internal ──────────────────────────────────────────────

  /**
   * this.overlayEffect kann durch den Strobe-Overlay (_applyStrobeOverlay)
   * kurzzeitig auf 'hotBeams' springen, unabhängig von _extraLayers -
   * deshalb wird hier zusammengesetzt statt _extraLayers direkt zu lesen.
   */
  _composeOverlayEffects() {
    const list = [];
    if (this.overlayEffect) list.push(this.overlayEffect);
    for (const key of this._extraLayers) {
      if (key && !list.includes(key)) list.push(key);
    }
    return list;
  }

  _pushHistory(list, value, maxLength) {
    list.push(value);
    while (list.length > maxLength) list.shift();
  }
}

export { STATE_STRATEGIES, EFFECT_PRESETS, STATE_PALETTES, DROP_POOL };
