// ============================================================
// RhythmAnalyzer.js – Advanced Rhythm Analysis
//
// Features:
//   - Oktav-korrekte BPM-Schätzung (Interval-Folding + Clustering)
//   - Beat-Grid mit durchgehendem virtuellem Metronom
//   - Musikalische Struktur-Flags: beat / bar / phrase / section
//   - 16-Step Groove-Template (Onset-Muster pro Takt)
//   - Downbeat-Erkennung
//   - Tempo-Change-Erkennung (half-time, double-time)
//
// ── Oktav-Problem (war der Grund für "BPM zu langsam") ──────
// Aus jedem Onset-Paar entstehen Intervalle, die Vielfache des
// echten Beats sind (1, 2, 3, 4 Beats Abstand). Vorher wurden
// Intervalle nur grob auf 320–1050 ms gefaltet – ein Bereich von
// mehr als einer Oktave. Dadurch überlebten echter Beat (z.B.
// 469 ms = 128 BPM) UND Doppel-Beat (938 ms = 64 BPM) gleich-
// zeitig, und das Clustering entschied sich regelmäßig für die
// halbe Geschwindigkeit.
//
// Jetzt wird jedes Intervall in ein Fenster von GENAU einer
// Oktave gefaltet (Standard 90–180 BPM). Dadurch fallen alle
// Vielfachen desselben Tempos exakt aufeinander, das Clustering
// wird eindeutig und das Ergebnis liegt im tanzbaren Bereich.
// ============================================================

// Bevorzugtes Tempofenster: exakt eine Oktave (x2).
// 90–180 BPM deckt House/Techno/EDM (120–150), Hardstyle (150)
// und Drum'n'Bass (172–176) ohne Halbierung ab.
export const DEFAULT_TEMPO_WINDOW = Object.freeze({ minBpm: 90, maxBpm: 180 });

/**
 * Faltet ein Intervall (ms) in das Zielfenster einer Oktave.
 * @returns {number} gefaltetes Intervall in ms, oder 0 wenn unbrauchbar
 */
export function foldInterval(intervalMs, minBpm = DEFAULT_TEMPO_WINDOW.minBpm, maxBpm = DEFAULT_TEMPO_WINDOW.maxBpm) {
  let iv = Number(intervalMs);
  if (!Number.isFinite(iv) || iv <= 0) return 0;

  const maxIv = 60000 / minBpm;   // längstes erlaubtes Intervall
  const minIv = 60000 / maxBpm;   // kürzestes erlaubtes Intervall

  // Sicherheitsnetz gegen Endlosschleifen bei absurden Eingaben
  let guard = 0;
  while (iv > maxIv && guard++ < 32) iv /= 2;
  guard = 0;
  while (iv < minIv && guard++ < 32) iv *= 2;

  if (iv < minIv * 0.98 || iv > maxIv * 1.02) return 0;
  return iv;
}

export class RhythmAnalyzer {
  constructor(options = {}) {
    // ── Tempo-Fenster ────────────────────────────────────
    this.minBpm = Number(options.minBpm) || DEFAULT_TEMPO_WINDOW.minBpm;
    this.maxBpm = Number(options.maxBpm) || DEFAULT_TEMPO_WINDOW.maxBpm;

    // ── BPM Estimation ───────────────────────────────────
    this.bpm            = 0;
    this.bpmConfidence  = 0;      // 0–1, how stable the BPM is
    this.lockedBpm      = 0;      // Stable BPM (only updates when confident)
    this.spotifyBpm     = 0;      // Externally set BPM hint

    this._onsetHistory  = [];     // Timestamps of recent onsets
    this._beatIntervals = [];     // Recent folded inter-onset intervals (ms)
    this._maxIntervals  = 48;

    // ── Phase Tracking ───────────────────────────────────
    this.beatPhase      = 0;      // 0–1 progress within current beat
    this.beatIndex      = 0;      // 0–3 within a bar (4/4 assumed)
    this.measurePhase   = 0;      // 0–1 progress within full measure
    this.beatCount      = 0;      // Grid-Beats seit Start (musikalisch, nicht Onset-Zähler)
    this.onsetCount     = 0;      // rohe erkannte Transienten (Legacy-Zähler)
    this.downbeat       = false;  // True on beat 1 of each bar
    this.barCount       = 0;      // Takte seit Start

    // ── Musikalische Struktur-Flags (genau 1 Frame lang true) ──
    this.gridBeat       = false;  // neuer Beat laut Grid
    this.barBoundary    = false;  // Beginn eines neuen Takts (4 Beats)
    this.phraseBoundary = false;  // Beginn einer neuen Phrase (16 Beats)
    this.sectionBoundary = false; // Beginn eines neuen Abschnitts (32 Beats)

    // ── Visual Beat Matching (PLL) ───────────────────────
    this.visualBpm      = 0;      // Fast-adapting BPM for visual sync
    this.visualPhase    = 0;      // 0–1 continuous phase for smooth rendering
    this._pllInterval   = 500;    // Current PLL period (ms)

    // Virtual metronome (runs continuously between real beats)
    this._virtualTime         = 0;
    this._lastPhaseTime       = 0;
    this.isVirtualBeat        = false;
    this._virtualBeatTriggered = false;
    this._lastGridBeatIndex   = -1;

    // ── Groove Template ──────────────────────────────────
    this.groove         = new Float32Array(16).fill(0);
    this._grooveAccum   = new Float32Array(16).fill(0);
    this._grooveCounts  = new Float32Array(16).fill(0);
    this._grooveBars    = 0;

    // ── Beat Timing ──────────────────────────────────────
    this._lastBeatTime  = 0;
    this._lastDropTime  = 0;

    // ── Tempo Change Detection ───────────────────────────
    this._tempoHistory  = [];
    this.tempoChange    = 'steady'; // 'steady' | 'halfTime' | 'doubleTime' | 'changing'
  }

  /**
   * Call once per frame.
   * @param {object} transients – from TransientDetector (kick/snare/hihat/clap)
   * @param {number} energyLevel – current overall energy (0–1)
   * @param {number} bass – current bass energy (for downbeat detection)
   * @param {number} now – performance.now()
   */
  analyze(transients, energyLevel, bass, now) {
    if (this._lastPhaseTime === 0) this._lastPhaseTime = now;

    const dt = now - this._lastPhaseTime;
    this._lastPhaseTime = now;

    const isOnset = transients.kick.hit || transients.snare.hit;

    // ── IOI BPM Estimation ─────────────────────────────────
    if (isOnset) {
      this._collectIntervals(now);
      this._estimateBPM();
      this._lastBeatTime = now;
      this.onsetCount++;
    }

    // ── Phase Tracking ─────────────────────────────────────
    this._updatePhase(isOnset, bass, energyLevel, now, dt);

    // ── Groove Template ────────────────────────────────────
    this._updateGroove(transients, now);

    // ── Tempo Change Detection ─────────────────────────────
    this._detectTempoChange();
  }

  // ── BPM Estimation ──────────────────────────────────────────

  _collectIntervals(now) {
    this._onsetHistory.push(now);
    // Nur ein kurzes Fenster betrachten – ältere Onsets gehören oft
    // schon zu einem anderen musikalischen Abschnitt.
    while (this._onsetHistory.length > 12) this._onsetHistory.shift();
    while (this._onsetHistory.length > 2 && now - this._onsetHistory[0] > 6000) {
      this._onsetHistory.shift();
    }

    for (let i = 0; i < this._onsetHistory.length - 1; i++) {
      const raw = now - this._onsetHistory[i];
      // Extrem kurze Abstände sind Doppel-Trigger derselben Transiente,
      // extrem lange stammen aus einer Pause – beide verfälschen das Grid.
      if (raw < 90 || raw > 4000) continue;

      const folded = foldInterval(raw, this.minBpm, this.maxBpm);
      if (folded <= 0) continue;

      this._beatIntervals.push(folded);
      if (this._beatIntervals.length > this._maxIntervals) this._beatIntervals.shift();
    }
  }

  _estimateBPM() {
    if (this._beatIntervals.length < 4) return;

    const intervals = [...this._beatIntervals];
    const clusters = [];

    // Neuere Intervalle zählen mehr als ältere.
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i];
      const weight = 0.5 + (i / Math.max(1, intervals.length - 1)) * 0.5;
      let found = false;
      for (const cluster of clusters) {
        if (Math.abs(iv - cluster.center) / cluster.center < 0.08) {
          cluster.values.push(iv);
          cluster.weight += weight;
          cluster.center = cluster.values.reduce((a, b) => a + b, 0) / cluster.values.length;
          found = true;
          break;
        }
      }
      if (!found) clusters.push({ center: iv, values: [iv], weight });
    }

    clusters.sort((a, b) => b.weight - a.weight);
    const best = clusters[0];
    if (!best || best.values.length < 3) return;

    const sorted = [...best.values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const candidate = Math.round(60000 / median);
    if (candidate < this.minBpm - 1 || candidate > this.maxBpm + 1) return;

    this.bpm = candidate;

    const totalWeight = clusters.reduce((a, c) => a + c.weight, 0) || 1;
    this.bpmConfidence = Math.min(1, best.weight / totalWeight);

    if (this.bpmConfidence > 0.55 && best.values.length >= 5) {
      this.lockedBpm = this.bpm;
    }

    // Schnell reagierender Wert für die visuelle Synchronisation –
    // ebenfalls oktav-gefaltet, damit er nicht gegen das Grid arbeitet.
    const recent = intervals.slice(-4);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const visual = Math.round(60000 / recentAvg);
    if (visual >= this.minBpm && visual <= this.maxBpm) this.visualBpm = visual;
  }

  /** Aktuell gültiges Tempo (externer Hint > Lock > Schätzung > Fallback). */
  getActiveBpm() {
    return this.spotifyBpm || this.lockedBpm || this.bpm || 120;
  }

  // ── Phase Tracking ──────────────────────────────────────────

  _updatePhase(isOnset, bass, energyLevel, now, dt) {
    const activeBpm = this.getActiveBpm();
    const baseInterval = 60000 / activeBpm;

    // Virtuelles Metronom läuft immer weiter, auch zwischen Onsets –
    // dadurch bleibt das Grid während Breaks/Vocal-Passagen stabil.
    this._virtualTime += dt;

    const targetPllInterval = this.visualBpm ? 60000 / this.visualBpm : baseInterval;
    if (!this._pllInterval) this._pllInterval = baseInterval;
    this._pllInterval += (targetPllInterval - this._pllInterval) * 0.1;

    this.visualPhase += dt / this._pllInterval;

    if (isOnset) {
      const currentBeat = Math.round(this._virtualTime / baseInterval);

      if (bass > 0.8 && energyLevel > 0.35 && (now - this._lastDropTime > 4000)) {
        // Harter Einstieg (Drop): Grid hart auf diesen Moment setzen.
        this._virtualTime = 0;
        this.visualPhase = 0;
        this._lastDropTime = now;
        this._lastGridBeatIndex = -1;
      } else {
        const expectedTime = currentBeat * baseInterval;
        this._virtualTime += (expectedTime - this._virtualTime) * 0.25;

        const nearestPhase = Math.round(this.visualPhase);
        const phaseError = nearestPhase - this.visualPhase;
        this.visualPhase += phaseError * 0.35;
      }
    }

    this.visualPhase = this.visualPhase % 1.0;
    if (this.visualPhase < 0) this.visualPhase += 1.0;

    this.beatPhase = this.visualPhase;

    // ── Musikalische Zählung über das Grid, nicht über Onsets ──
    // Vorher zählte beatCount jede erkannte Transiente – bei einem
    // Kick+Snare-Pattern also doppelt so schnell und bei Pausen gar
    // nicht. Damit waren "% 16"/"% 32"-Phrasengrenzen musikalisch
    // wertlos. Jetzt zählt ausschließlich das Beat-Grid.
    const gridIndex = Math.floor(this._virtualTime / baseInterval);
    this.gridBeat = false;
    this.barBoundary = false;
    this.phraseBoundary = false;
    this.sectionBoundary = false;

    if (gridIndex !== this._lastGridBeatIndex) {
      if (this._lastGridBeatIndex >= 0 && gridIndex > this._lastGridBeatIndex) {
        this.beatCount += (gridIndex - this._lastGridBeatIndex);
        this.gridBeat = true;
        this.barBoundary = this.beatCount % 4 === 0;
        this.phraseBoundary = this.beatCount % 16 === 0;
        this.sectionBoundary = this.beatCount % 32 === 0;
        if (this.barBoundary) this.barCount++;
      }
      this._lastGridBeatIndex = gridIndex;
    }

    this.beatIndex = ((this.beatCount % 4) + 4) % 4;
    this.measurePhase = (this.beatIndex + this.beatPhase) / 4.0;
    this.downbeat = this.gridBeat && this.beatIndex === 0;

    if (this.beatPhase < 0.15 && !this._virtualBeatTriggered) {
      this.isVirtualBeat = true;
      this._virtualBeatTriggered = true;
    } else {
      this.isVirtualBeat = false;
    }

    if (this.beatPhase > 0.5) this._virtualBeatTriggered = false;
  }

  // ── Groove Template ─────────────────────────────────────────

  _updateGroove(transients, now) {
    const activeBpm = this.spotifyBpm || this.lockedBpm || this.bpm;
    if (activeBpm <= 0) return;

    const stepInBar = Math.floor(this.measurePhase * 16) % 16;

    let strength = 0;
    if (transients.kick.hit)  strength += transients.kick.velocity;
    if (transients.snare.hit) strength += transients.snare.velocity * 0.9;
    if (transients.hihat.hit) strength += transients.hihat.velocity * 0.5;
    if (transients.clap.hit)  strength += transients.clap.velocity * 0.7;

    if (strength > 0) {
      this._grooveAccum[stepInBar] += strength;
      this._grooveCounts[stepInBar]++;
    }

    if (this.downbeat) {
      this._grooveBars++;
      if (this._grooveBars >= 4) {
        for (let i = 0; i < 16; i++) {
          this.groove[i] = this._grooveCounts[i] > 0
            ? this._grooveAccum[i] / this._grooveCounts[i]
            : 0;
        }
        const maxGroove = Math.max(...this.groove, 0.001);
        for (let i = 0; i < 16; i++) this.groove[i] /= maxGroove;

        this._grooveAccum.fill(0);
        this._grooveCounts.fill(0);
        this._grooveBars = 0;
      }
    }
  }

  // ── Tempo Change Detection ──────────────────────────────────

  _detectTempoChange() {
    if (this.bpm <= 0) { this.tempoChange = 'steady'; return; }

    this._tempoHistory.push(this.bpm);
    if (this._tempoHistory.length > 30) this._tempoHistory.shift();
    if (this._tempoHistory.length < 10) { this.tempoChange = 'steady'; return; }

    const recent = this._tempoHistory.slice(-5);
    const older  = this._tempoHistory.slice(0, 5);
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgOlder  = older.reduce((a, b) => a + b, 0) / older.length;
    const ratio = avgRecent / avgOlder;

    if (ratio > 1.8 && ratio < 2.2) {
      this.tempoChange = 'doubleTime';
    } else if (ratio > 0.45 && ratio < 0.55) {
      this.tempoChange = 'halfTime';
    } else if (Math.abs(ratio - 1.0) > 0.15) {
      this.tempoChange = 'changing';
    } else {
      this.tempoChange = 'steady';
    }
  }

  /**
   * Returns a serializable snapshot of rhythm state.
   */
  getSnapshot() {
    return {
      bpm:            Math.round(this.getActiveBpm()),
      bpmConfidence:  this.bpmConfidence,
      beatPhase:      this.beatPhase,
      beatIndex:      this.beatIndex,
      measurePhase:   this.measurePhase,
      beatCount:      this.beatCount,
      barCount:       this.barCount,
      onsetCount:     this.onsetCount,
      downbeat:       this.downbeat,
      gridBeat:       this.gridBeat,
      barBoundary:    this.barBoundary,
      phraseBoundary: this.phraseBoundary,
      sectionBoundary: this.sectionBoundary,
      isVirtualBeat:  this.isVirtualBeat,
      groove:         this.groove,
      tempoChange:    this.tempoChange,
    };
  }
}
