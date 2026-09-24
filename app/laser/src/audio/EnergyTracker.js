// ============================================================
// EnergyTracker.js – Musical Energy & Drama Arc Intelligence
//
// Replaces the simple musicState string ('chill'/'dance'/'hardcore')
// with a continuous, multi-dimensional energy model:
//
//   level:         0–1, current overall energy
//   trend:         'falling' | 'rising' | 'steady' | 'exploding'
//   tension:       0–1, accumulated musical tension
//   phase:         'intro' | 'verse' | 'build' | 'drop' | 'break' | 'outro'
//   dropImminent:  true when build-up pattern suggests a drop is coming
//
// The killer feature: anticipating drops by detecting the build-up
// pattern (rising energy + increasing hi-hat density + rising
// spectral centroid).
// ============================================================

export class EnergyTracker {
  constructor() {
    // ── Current State ────────────────────────────────────
    this.level         = 0;        // 0–1 instantaneous
    this.trend         = 'steady'; // 'falling'|'rising'|'steady'|'exploding'
    this.tension       = 0;       // 0–1, builds over seconds
    this.phase         = 'intro';  // current musical phase
    this.dropImminent  = false;    // prediction flag
    this.kickDensity   = 0;        // Kick-Dichte der letzten ~1 s
    this.hihatDensity  = 0;        // Hi-Hat-Dichte der letzten ~1 s
    this.centroidRising = false;   // Filter-Sweep nach oben (Build-Signal)
    // Gesangspassage: Stimme trägt, Schlagzeug fehlt weitgehend.
    this.vocalness  = 0;           // 0..1, geglättet
    this.vocalOnly  = false;       // true = tragende Stimme ohne Beat
    this.rumble     = false;       // Tieftonfläche ohne Schläge
    this._percussionEma = 0;       // geglättete Schlag-Aktivität

    // Legacy compatibility
    this.musicState    = 'chill';  // 'idle'|'chill'|'dance'|'hardcore'

    // ── History Buffers ──────────────────────────────────
    // Short-term: ~0.5 sec (30 frames at 60fps)
    this._shortHistory  = new Float32Array(30).fill(0);
    // Medium-term: ~3 sec (180 frames)
    this._medHistory    = new Float32Array(180).fill(0);
    // Long-term: ~10 sec (600 frames)
    this._longHistory   = new Float32Array(600).fill(0);

    // Spectral centroid history (for build detection)
    this._centroidHistory = new Float32Array(180).fill(0);

    // Hi-hat density history (for build detection)
    this._hihatDensity    = new Float32Array(120).fill(0);

    // Kick density (for break detection: kick disappears)
    this._kickPresence    = new Float32Array(120).fill(0);

    // ── Phase Transition Timing ──────────────────────────
    this._phaseStartTime    = 0;
    this._lastDropTime      = 0;
    this._lastBreakTime     = 0;
    this._timeSinceLastDrop = Infinity;

    // ── Tension Model ────────────────────────────────────
    this._tensionAccum  = 0;
    // 0.997 ließ die Spannung bei normaler Musik über Minuten anwachsen -
    // irgendwann galt jede lautere Passage als Build. Halbwertszeit jetzt
    // ~2 s statt ~4 s.
    this._tensionDecay  = 0.994;
    this._tensionBuild  = 0.008;   // Rate of tension increase during builds

    // ── Thresholds ───────────────────────────────────────
    this._idleThreshold     = 0.02;
    this._lowThreshold      = 0.15;
    this._highThreshold     = 0.45;
    // Energiesprung, der einen Drop markiert. 0.30 war so hoch, dass
    // saubere, komprimierte Produktionen (bei denen die Energie im
    // Drop kaum "explodiert", sondern nur voller wird) nie als Drop
    // erkannt wurden - die Show blieb dann im Build hängen.
    this._dropExplosion     = 0.18;
    // kickDensity ist der Anteil der letzten ~1s, in dem `kick.hit`
    // wahr war - und `hit` ist ein EINZELNER Frame pro Treffer, kein
    // gehaltenes Flag. Bei 60fps ergibt ein stinknormaler Beat mit
    // einem Kick pro Schlag rechnerisch nur ~0.033 (120 BPM) bis
    // ~0.048 (174 BPM) - deutlich unter den früher hier verwendeten
    // 0.05/0.10. Die Folge: VERSE war für echte Musik so gut wie nie
    // erreichbar, die Phase blieb irgendwo hängen (meist BUILD, weil
    // dort auch nichts mehr zurück nach VERSE führte) - genau das
    // "flackert bei ganz normaler Musik"-Verhalten. Schwellen jetzt
    // auf den tatsächlich erreichbaren Bereich kalibriert.
    this._kickDensityVerse  = 0.02;   // "läuft überhaupt ein Beat"
    // 0.028 statt z.B. 0.035: ein simpler Kick auf jedem Schlag liegt
    // bei 120 BPM (dem langsamsten üblichen Tempo) bei ~0.033 - die
    // Schwelle muss komfortabel darunter liegen, sonst reisst ein
    // stinknormaler Drop mit stetigem Kick die Schwelle nicht.
    this._kickDensityDrop   = 0.028;  // "läuft ein echter, spürbarer Beat"
    this._buildDuration     = 3000;  // Min ms to consider a build-up
    this._breakDuration     = 1500;  // Min ms of low energy for break
    // Ein Build, der nach so langer Zeit keinen Drop hervorgebracht
    // hat, war keiner - siehe Freigabe unten in _detectPhase. Ein
    // echter Riser dauert selten mehr als ein paar Takte; 20 s sind
    // grosszuegig (bei 128 BPM gut 10 Takte).
    this._maxBuildDuration  = 20000;

    this._frameCount = 0;
  }

  /**
   * Call once per frame.
   * @param {object} bands – from SpectralDecomposer (8 bands)
   * @param {object} transients – from TransientDetector
   * @param {number} amplitude – RMS amplitude
   * @param {number} spectralCentroid – Hz
   * @param {number} bpm – current BPM
   * @param {number} now – performance.now()
   */
  analyze(bands, transients, amplitude, spectralCentroid, bpm, now) {
    this._frameCount++;

    // ── Compute instantaneous energy level ──────────────
    const energy = (bands.sub?.energy || 0) * 0.15 +
                   (bands.kick?.energy || 0) * 0.25 +
                   (bands.lowMid?.energy || 0) * 0.10 +
                   (bands.mid?.energy || 0) * 0.15 +
                   (bands.upperMid?.energy || 0) * 0.10 +
                   (bands.presence?.energy || 0) * 0.10 +
                   (bands.brilliance?.energy || 0) * 0.08 +
                   (bands.air?.energy || 0) * 0.07;

    this.level = energy;

    // ── Push to histories ───────────────────────────────
    this._pushHistory(this._shortHistory, energy);
    this._pushHistory(this._medHistory, energy);
    this._pushHistory(this._longHistory, energy);
    this._pushHistory(this._centroidHistory, spectralCentroid / 10000); // Normalize
    this._pushHistory(this._hihatDensity, transients.hihat.hit ? 1 : 0);
    this._pushHistory(this._kickPresence, transients.kick.hit ? 1 : 0);

    // ── Gesangs-Erkennung ───────────────────────────────
    this._detectVocal(bands, transients);

    // ── Compute trend ───────────────────────────────────
    this.trend = this._computeTrend();

    // ── Update tension ──────────────────────────────────
    this._updateTension(now);

    // ── Detect phase ────────────────────────────────────
    this._detectPhase(bands, transients, amplitude, bpm, now);

    // ── Predict drop ────────────────────────────────────
    this._predictDrop(now);

    // ── Legacy musicState ───────────────────────────────
    this._updateLegacyState(bpm);

    this._timeSinceLastDrop = now - this._lastDropTime;
  }

  // ── Gesangs-Erkennung ─────────────────────────────────────

  /**
   * Erkennt Passagen, in denen im Wesentlichen nur gesungen wird.
   *
   * Kennzeichen: die Energie sitzt im Stimmbereich (400 Hz - 6 kHz),
   * während Sub/Kick und die Hi-Hat-Bänder weitgehend leer sind. Ein
   * einzelner Frame reicht dafür nicht - jede Snare trifft dieselben
   * Bänder -, deshalb wird der Wert über etwa eine Sekunde geglättet.
   */
  _detectVocal(bands, transients) {
    const voice = (bands.mid?.energy || 0) + (bands.upperMid?.energy || 0)
      + (bands.presence?.energy || 0) * 0.6;

    // Entscheidend ist die SCHLAG-Aktivität, nicht die Bassenergie.
    // Ein Hintergrund-Rumble (Sub-Fläche, Drone, Raumhall) füllt die
    // tiefen Bänder dauerhaft, ohne dass ein einziger Schlag fällt -
    // ein Vergleich von Stimm- gegen Bassenergie hielt solche Stellen
    // deshalb fälschlich für "Band spielt", und die Show fuhr weiter
    // volles Programm über einer reinen Gesangspassage.
    const struck = (transients?.kick?.hit || transients?.snare?.hit
      || transients?.clap?.hit) ? 1 : 0;
    this._percussionEma += (struck - this._percussionEma) * 0.03;

    // Dauerhafte Tieftonenergie ohne Schläge = Rumble. Nur zur
    // Diagnose; auf die Entscheidung hat sie bewusst keinen Einfluss.
    const lowEnergy = (bands.sub?.energy || 0) + (bands.kick?.energy || 0);
    this.rumble = lowEnergy > 0.12 && this._percussionEma < 0.02;

    // Schwelle 0.015 entspricht etwa einem Schlag pro Sekunde: ein
    // durchlaufender Beat (bei 120 BPM jede halbe Sekunde) liegt klar
    // darüber, vereinzelte Akzente in einer ruhigen Passage darunter.
    const present = voice > 0.06 && this._percussionEma < 0.015;
    this.vocalness += ((present ? 1 : 0) - this.vocalness) * 0.02;

    // Zusätzlich muss der Kick wirklich weg sein - sonst ist es ein
    // normaler Vers mit Gesang, und der soll seine Show behalten.
    const kickDensity = this._average(this._kickPresence.subarray(-90));
    this.vocalOnly = this.vocalness > 0.6 && kickDensity < 0.02;
  }

  // ── Trend Detection ───────────────────────────────────────

  _computeTrend() {
    const shortAvg = this._average(this._shortHistory);
    const medAvg   = this._average(this._medHistory);
    const longAvg  = this._average(this._longHistory);

    const shortDelta = shortAvg - medAvg;
    const medDelta   = medAvg - longAvg;

    if (shortDelta > 0.15 && medDelta > 0.08) return 'exploding';
    if (shortDelta > 0.04 || medDelta > 0.03) return 'rising';
    if (shortDelta < -0.04 || medDelta < -0.03) return 'falling';
    return 'steady';
  }

  // ── Tension Model ─────────────────────────────────────────

  _updateTension(now) {
    if (this.trend === 'rising' || this.trend === 'exploding') {
      // Tension builds faster when hi-hat density is increasing (classic build-up sign)
      const hihatRate = this._average(this._hihatDensity.subarray(-30));
      const tensionRate = this._tensionBuild * (1 + hihatRate * 3);
      this._tensionAccum = Math.min(1, this._tensionAccum + tensionRate);
    } else if (this.trend === 'falling') {
      // Tension releases
      this._tensionAccum *= 0.98;
    } else {
      // Slow natural decay
      this._tensionAccum *= this._tensionDecay;
    }

    // On a detected drop, tension snaps to zero (release!)
    if (this.phase === 'drop' && (now - this._phaseStartTime) < 500) {
      this._tensionAccum *= 0.3;
    }

    this.tension = this._tensionAccum;
  }

  // ── Phase Detection ───────────────────────────────────────

  _detectPhase(bands, transients, amplitude, bpm, now) {
    const prevPhase = this.phase;
    const shortAvg  = this._average(this._shortHistory);
    const medAvg    = this._average(this._medHistory);
    const longAvg   = this._average(this._longHistory);

    // Kick presence in recent frames
    const kickDensity  = this._average(this._kickPresence.subarray(-60));
    const hihatDensity = this._average(this._hihatDensity.subarray(-60));

    // Spectral centroid trend (rising = filter sweep in build-ups)
    const centroidRecent = this._average(this._centroidHistory.subarray(-30));
    const centroidOlder  = this._average(this._centroidHistory.subarray(-90, -30));
    const centroidRising = centroidRecent > centroidOlder * 1.15;

    // ── Phase Rules ──────────────────────────────────────

    let nextPhase = prevPhase;

    // IDLE: Essentially silence
    if (shortAvg < this._idleThreshold && amplitude < this._idleThreshold) {
      nextPhase = 'intro';
    }
    // DROP: Energieeinschlag nach Build oder Break.
    // Zwei Wege dorthin:
    //   a) klassischer Energie-Sprung ("exploding")
    //   b) angekündigter Drop (dropImminent) + zurückkehrender Kick -
    //      genau der Fall, in dem die Energie nicht explodiert, aber
    //      musikalisch trotzdem der Drop ist.
    // Ein Drop braucht Kontrast: die Energie muss deutlich über dem
    // 10-Sekunden-Durchschnitt liegen. Bei gleichmäßig lauter Musik ist
    // shortAvg ≈ longAvg, und dann ist es schlicht kein Drop - egal wie
    // laut. Genau das hat vorher "normale" Musik in den Drop geschoben.
    else if (
      (prevPhase === 'build' || prevPhase === 'break') &&
      kickDensity > this._kickDensityDrop &&
      shortAvg > longAvg * 1.22 &&
      (now - this._lastDropTime) > 6000 &&
      (
        (this.trend === 'exploding' && shortAvg > medAvg + this._dropExplosion) ||
        (this.dropImminent && this.trend !== 'falling' && shortAvg > medAvg + this._dropExplosion * 0.6) ||
        (prevPhase === 'break' && this.trend === 'rising' && shortAvg > longAvg * 1.4)
      )
    ) {
      nextPhase = 'drop';
      this._lastDropTime = now;
    }
    // BUILD: Energy rising for sustained period + hi-hat density increasing
    else if (
      this.trend === 'rising' &&
      this.tension > 0.3 &&
      hihatDensity > 0.05 &&
      (centroidRising || this.tension > 0.5) &&
      prevPhase !== 'drop'
    ) {
      nextPhase = 'build';
    }
    // BREAK: Energy drops significantly + kick disappears
    else if (
      shortAvg < longAvg * 0.5 &&
      kickDensity < 0.03 &&
      prevPhase !== 'intro' &&
      (now - this._lastBreakTime) > 5000
    ) {
      nextPhase = 'break';
      if (prevPhase !== 'break') this._lastBreakTime = now;
    }
    // OUTRO: Sustained decrease from any active phase
    else if (
      this.trend === 'falling' &&
      shortAvg < this._lowThreshold &&
      longAvg > this._lowThreshold &&
      (prevPhase === 'drop' || prevPhase === 'verse')
    ) {
      nextPhase = 'outro';
    }
    // VERSE: stetige Musik mit laufendem Beat.
    //
    // Die frühere Obergrenze (shortAvg < _highThreshold) war eine tote
    // Zone: durchgehend LAUTE Musik lag darüber, konnte damit VERSE nie
    // erreichen - und weil DROP zwingend Kontrast zum 10-Sekunden-Mittel
    // braucht (den gleichmäßig laute Musik nie erzeugt), traf am Ende
    // gar keine Regel mehr zu. Die Phase blieb dann auf dem letzten
    // Wert stehen, in der Praxis dauerhaft "build". Und "build" heißt
    // für die Show: sich für einen Drop zurückhalten, der nie kommt -
    // ausgerechnet beim härtesten Teil des Tracks lief die Show also
    // gebremst (und wegen dropImminent obendrein im Dauer-Riser).
    // Wie laut es ist, entscheidet die Show selbst über energy.level;
    // die Phase sagt nur, WAS gerade passiert.
    else if (
      shortAvg > this._lowThreshold &&
      this.trend === 'steady' &&
      kickDensity > this._kickDensityVerse
    ) {
      nextPhase = 'verse';
    }
    
    // Ein Drop hält mindestens 6 Sekunden - so lange bleibt die Show
    // im Climax, statt nach wenigen Frames wieder zurückzufallen.
    const dropAge = now - this._lastDropTime;
    if (prevPhase === 'drop' && dropAge < 6000) {
      nextPhase = 'drop';
    }

    // ... aber er endet auch wieder. Vorher blieb die Phase bei dauerhaft
    // lauter Musik für immer auf "drop", weil keine andere Regel mehr
    // griff - und damit lief der Strobe endlos. Nach 24 s ist der Drop
    // als Ereignis vorbei; läuft der Kick weiter, ist es ein Verse.
    //
    // Die Schwelle war hier als feste 0.05 stehengeblieben, obwohl ein
    // stinknormaler Beat rechnerisch nie über ~0.048 kommt (siehe
    // Kalibrierung oben) - jeder Drop endete damit zwangsläufig in
    // "outro", also in der ruhigsten Show, die es gibt. Deshalb hier
    // dieselbe benannte Konstante wie überall sonst statt einer Zahl.
    if (prevPhase === 'drop' && nextPhase === 'drop' && dropAge > 24000) {
      nextPhase = kickDensity > this._kickDensityVerse ? 'verse' : 'outro';
    }

    // Ein Build ist ein ÜBERGANG, kein Dauerzustand. Führt er über
    // längere Zeit zu keinem Drop, war es keiner - dann lief einfach
    // durchgehend energiereiche Musik. Ohne diese Bremse blieb die
    // Show bei gleichmäßig lauter Musik dauerhaft im Anlauf hängen:
    // gedrosselte Intensität plus Dauer-Riser, während der Track am
    // härtesten war.
    const buildAge = now - this._phaseStartTime;
    if (prevPhase === 'build' && nextPhase === 'build' && buildAge > this._maxBuildDuration) {
      nextPhase = kickDensity > this._kickDensityVerse ? 'verse' : 'break';
    }

    // Kennzahlen für den Choreographen mitschreiben.
    this.kickDensity = kickDensity;
    this.hihatDensity = hihatDensity;
    this.centroidRising = centroidRising;

    // ── Hysteresis / Cooldown ─────────────────────────────
    // Prevent rapid fluttering between phases (unless it's a sudden drop or silence)
    const timeSinceChange = now - this._phaseStartTime;
    if (nextPhase !== prevPhase) {
      if (nextPhase === 'drop' || nextPhase === 'intro' || timeSinceChange > 2500) {
        this.phase = nextPhase;
        this._phaseStartTime = now;
      }
    }
  }

  // ── Drop Prediction ───────────────────────────────────────

  _predictDrop(now) {
    // Drop is imminent when:
    // 1. We're in a build phase
    // 2. Tension is very high
    // 3. Hi-hat density is increasing or peaked
    // 4. Spectral centroid is rising (filter sweep)
    // 5. It's been a while since the last drop

    const hihatRate     = this._average(this._hihatDensity.subarray(-30));
    const centroidRate  = this._average(this._centroidHistory.subarray(-30));
    const centroidOlder = this._average(this._centroidHistory.subarray(-90, -30));

    this.dropImminent = (
      this.phase === 'build' &&
      this.tension > 0.6 &&
      (hihatRate > 0.1 || this.tension > 0.8) &&
      (now - this._lastDropTime) > 8000
    );
  }

  // ── Legacy musicState ─────────────────────────────────────

  _updateLegacyState(bpm) {
    const shortAvg = this._average(this._shortHistory);
    const activeBpm = bpm || 120;

    if (shortAvg < this._idleThreshold) {
      this.musicState = 'idle';
    } else if (this.phase === 'drop' || this.phase === 'build' && this.tension > 0.7) {
      this.musicState = 'hardcore';
    } else if (shortAvg > this._highThreshold || activeBpm > 140) {
      this.musicState = 'hardcore';
    } else if (shortAvg < this._lowThreshold || activeBpm < 90) {
      this.musicState = 'chill';
    } else {
      this.musicState = 'dance';
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  _pushHistory(arr, value) {
    for (let i = 0; i < arr.length - 1; i++) arr[i] = arr[i + 1];
    arr[arr.length - 1] = value;
  }

  _average(arr) {
    if (!arr || arr.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  /**
   * Returns a serializable snapshot.
   */
  getSnapshot() {
    return {
      level:            this.level,
      trend:            this.trend,
      tension:          this.tension,
      phase:            this.phase,
      dropImminent:     this.dropImminent,
      kickDensity:      this.kickDensity,
      vocalness:        this.vocalness,
      vocalOnly:        this.vocalOnly,
      rumble:           this.rumble,
      percussion:       this._percussionEma,
      hihatDensity:     this.hihatDensity,
      centroidRising:   this.centroidRising,
      timeSinceLastDrop: this._timeSinceLastDrop,
      musicState:       this.musicState,
    };
  }
}
