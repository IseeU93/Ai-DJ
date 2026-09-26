// ============================================================
// TransientDetector.js – Kick / Snare / Hi-Hat / Clap Separation
//
// Produces four independent trigger channels, each with:
//   - hit:      boolean (onset detected this frame)
//   - velocity: 0–1 (how hard the hit was)
//   - timeSinceLast: ms since previous hit
//
// Detection strategy per instrument:
//   Kick:  Spectral flux in 60–150 Hz, fast attack filter
//   Snare: Dual-band onset (150–400 Hz body + 2–6 kHz crack)
//   HiHat: Spike in 6–12 kHz with very fast decay
//   Clap:  Onset density (multiple micro-onsets) in 1–4 kHz
// ============================================================

export class TransientDetector {
  /**
   * @param {number} sampleRate
   * @param {number} fftSize
   */
  constructor(sampleRate, fftSize) {
    this._binHz = (sampleRate / 2) / (fftSize / 2);
    this._binCount = fftSize / 2;

    // Pre-compute bin ranges
    // Kick: bis 45 Hz runter (Sub-Anteil) und bis 160 Hz hoch - Hard-
    // style-/Uptempo-Kicks haben ihren "Tok" deutlich über 150 Hz.
    this._kickRange    = this._range(45, 160);
    this._kickPunchR   = this._range(160, 320);  // verzerrter Kick-Körper
    this._snareBodyR   = this._range(150, 400);
    this._snareCrackR  = this._range(2000, 6000);
    this._hihatRange   = this._range(6000, 12000);
    this._clapRange    = this._range(1000, 4000);

    // Previous frequency data for flux
    this._prevFreqData = null;

    // Per-channel flux histories (adaptive threshold)
    this._kickFluxHist   = new Float32Array(40).fill(0);
    this._snareFluxHist  = new Float32Array(40).fill(0);
    this._hihatFluxHist  = new Float32Array(40).fill(0);
    this._clapFluxHist   = new Float32Array(40).fill(0);

    // Clap micro-onset ring buffer (detecting flutter)
    this._clapOnsetRing  = new Float32Array(6).fill(0); // ~100ms window at 60fps
    this._clapRingIdx    = 0;

    // Timing
    this._lastKickTime   = 0;
    this._lastSnareTime  = 0;
    this._lastHihatTime  = 0;
    this._lastClapTime   = 0;

    // Cooldowns (ms) – prevents retriggering too fast
    this._kickCooldown   = 180;  // Kick can't hit faster than ~330 BPM
    this._snareCooldown  = 140;
    this._hihatCooldown  = 60;   // Hi-hats can be very fast
    this._clapCooldown   = 200;

    // Thresholds
    this._kickThreshold   = 1.35;
    this._snareThreshold  = 1.30;
    this._hihatThreshold  = 1.50;
    this._clapFlutterMin  = 2;     // Minimum micro-onsets to count as clap

    // Minimum flux to even consider (noise floor)
    this._kickMinFlux     = 0.02;
    this._snareMinFlux    = 0.015;
    this._hihatMinFlux    = 0.012;
    this._clapMinFlux     = 0.010;

    // Output (reused each frame)
    this.kick  = { hit: false, velocity: 0, timeSinceLast: Infinity };
    this.snare = { hit: false, velocity: 0, timeSinceLast: Infinity };
    this.hihat = { hit: false, velocity: 0, timeSinceLast: Infinity };
    this.clap  = { hit: false, velocity: 0, timeSinceLast: Infinity };

    // Legacy combined beat flag
    this.isBeat = false;
  }

  /**
   * Call once per frame.
   * @param {Uint8Array} frequencyData
   * @param {number} now – performance.now()
   */
  analyze(frequencyData, now) {
    if (!this._prevFreqData) {
      this._prevFreqData = new Uint8Array(frequencyData.length);
      this._prevFreqData.set(frequencyData);
      return;
    }

    // ── KICK ────────────────────────────────────────────────
    // Bei schnellen Kicks (150-180 BPM) liegen zwei bis drei Kicks im
    // Verlaufsfenster. Ein Mittelwert als Schwelle wird dann von den
    // Kicks selbst hochgezogen und der nächste Kick fällt durch. Der
    // Median ignoriert die Spitzen und bildet die echte Grundlinie.
    const kickFlux = this._bandFlux(frequencyData, this._kickRange)
      + this._bandFlux(frequencyData, this._kickPunchR) * 0.35;
    const kickBase = this._pushAndMedian(this._kickFluxHist, kickFlux);
    const kickReady = (now - this._lastKickTime) > this._kickCooldown;

    this.kick.hit = false;
    if (kickReady && kickFlux > kickBase * this._kickThreshold && kickFlux > this._kickMinFlux) {
      // Zusätzlich muss die Energie im Kick-Band schnell ansteigen -
      // das trennt Kicks von gehaltenem Bass. Die Schwelle ist relativ
      // zur Bandenergie, damit sie bei leisem Material nicht zu streng
      // und bei lautem nicht zu lasch ist.
      const kickEnergy = this._bandEnergy(frequencyData, this._kickRange);
      const prevKickEnergy = this._bandEnergy(this._prevFreqData, this._kickRange);
      const attackSharpness = kickEnergy - prevKickEnergy;
      const attackNeeded = Math.max(0.02, kickEnergy * 0.05);

      if (attackSharpness > attackNeeded) {
        this.kick.hit      = true;
        this.kick.velocity = Math.min(1, kickFlux / (kickBase * 2.5 + 0.001));
        this._lastKickTime = now;
      }
    }
    this.kick.timeSinceLast = now - this._lastKickTime;

    // ── SNARE ───────────────────────────────────────────────
    // Snare has a dual-band signature: body (150–400) + crack (2k–6k)
    const snareBodyFlux  = this._bandFlux(frequencyData, this._snareBodyR);
    const snareCrackFlux = this._bandFlux(frequencyData, this._snareCrackR);
    // Combined flux weighted toward the crack (more distinctive)
    const snareFlux = snareBodyFlux * 0.35 + snareCrackFlux * 0.65;
    const snareAvg  = this._pushAndMedian(this._snareFluxHist, snareFlux);
    const snareReady = (now - this._lastSnareTime) > this._snareCooldown;

    this.snare.hit = false;
    if (snareReady && snareFlux > snareAvg * this._snareThreshold && snareFlux > this._snareMinFlux) {
      // Both bands must have some activity (body AND crack)
      if (snareBodyFlux > this._snareMinFlux * 0.3 && snareCrackFlux > this._snareMinFlux * 0.3) {
        this.snare.hit      = true;
        this.snare.velocity = Math.min(1, snareFlux / (snareAvg * 2.5 + 0.001));
        this._lastSnareTime = now;
      }
    }
    this.snare.timeSinceLast = now - this._lastSnareTime;

    // ── HI-HAT ──────────────────────────────────────────────
    const hihatFlux = this._bandFlux(frequencyData, this._hihatRange);
    const hihatAvg  = this._pushAndAvg(this._hihatFluxHist, hihatFlux);
    const hihatReady = (now - this._lastHihatTime) > this._hihatCooldown;

    this.hihat.hit = false;
    if (hihatReady && hihatFlux > hihatAvg * this._hihatThreshold && hihatFlux > this._hihatMinFlux) {
      // Hi-hat characteristic: energy in this band drops quickly
      // We accept it if the brilliance band has meaningful energy
      const hihatEnergy = this._bandEnergy(frequencyData, this._hihatRange);
      if (hihatEnergy > 0.05) {
        this.hihat.hit      = true;
        this.hihat.velocity = Math.min(1, hihatFlux / (hihatAvg * 2.5 + 0.001));
        this._lastHihatTime = now;
      }
    }
    this.hihat.timeSinceLast = now - this._lastHihatTime;

    // ── CLAP ────────────────────────────────────────────────
    // Clap detection: multiple micro-onsets (flutter) in 1–4 kHz within ~100ms
    const clapFlux = this._bandFlux(frequencyData, this._clapRange);
    const clapAvg  = this._pushAndAvg(this._clapFluxHist, clapFlux);

    // Track micro-onsets in ring buffer
    const isMicroOnset = clapFlux > clapAvg * 1.15 && clapFlux > this._clapMinFlux;
    this._clapOnsetRing[this._clapRingIdx] = isMicroOnset ? 1 : 0;
    this._clapRingIdx = (this._clapRingIdx + 1) % this._clapOnsetRing.length;

    // Count micro-onsets in the window
    let microOnsetCount = 0;
    for (let i = 0; i < this._clapOnsetRing.length; i++) {
      microOnsetCount += this._clapOnsetRing[i];
    }

    const clapReady = (now - this._lastClapTime) > this._clapCooldown;

    this.clap.hit = false;
    if (clapReady && microOnsetCount >= this._clapFlutterMin) {
      this.clap.hit      = true;
      this.clap.velocity = Math.min(1, clapFlux / (clapAvg * 2.0 + 0.001));
      this._lastClapTime = now;
      // Clear ring to prevent re-trigger
      this._clapOnsetRing.fill(0);
    }
    this.clap.timeSinceLast = now - this._lastClapTime;

    // ── Legacy beat flag ────────────────────────────────────
    this.isBeat = this.kick.hit || this.snare.hit;

    // Store current frame for next diff
    this._prevFreqData.set(frequencyData);
  }

  // ── Helpers ─────────────────────────────────────────────────

  _range(minHz, maxHz) {
    return {
      start: Math.max(0, Math.floor(minHz / this._binHz)),
      end:   Math.min(this._binCount - 1, Math.floor(maxHz / this._binHz)),
    };
  }

  _bandFlux(freqData, range) {
    let flux = 0;
    for (let i = range.start; i <= range.end; i++) {
      const diff = freqData[i] - this._prevFreqData[i];
      if (diff > 0) flux += diff;
    }
    const count = range.end - range.start + 1;
    return count > 0 ? flux / (255 * count) : 0;
  }

  _bandEnergy(freqData, range) {
    let sum = 0;
    for (let i = range.start; i <= range.end; i++) sum += freqData[i];
    const count = range.end - range.start + 1;
    return count > 0 ? sum / (255 * count) : 0;
  }

  /**
   * Schiebt den Wert in die Historie und liefert deren Median.
   * Robuste Grundlinie: Ausreißer (die Treffer selbst) verschieben
   * sie kaum, im Gegensatz zum Mittelwert.
   */
  _pushAndMedian(hist, value) {
    for (let i = 0; i < hist.length - 1; i++) hist[i] = hist[i + 1];
    hist[hist.length - 1] = value;
    if (!this._sortScratch || this._sortScratch.length !== hist.length) {
      this._sortScratch = new Float32Array(hist.length);
    }
    this._sortScratch.set(hist);
    this._sortScratch.sort();
    const mid = hist.length >> 1;
    return hist.length % 2 === 0
      ? (this._sortScratch[mid - 1] + this._sortScratch[mid]) / 2
      : this._sortScratch[mid];
  }

  _pushAndAvg(hist, value) {
    for (let i = 0; i < hist.length - 1; i++) hist[i] = hist[i + 1];
    hist[hist.length - 1] = value;
    let sum = 0;
    for (let i = 0; i < hist.length; i++) sum += hist[i];
    return sum / hist.length;
  }

  /**
   * Returns a serializable snapshot.
   */
  getSnapshot() {
    return {
      kick:  { hit: this.kick.hit,  velocity: this.kick.velocity,  timeSinceLast: this.kick.timeSinceLast },
      snare: { hit: this.snare.hit, velocity: this.snare.velocity, timeSinceLast: this.snare.timeSinceLast },
      hihat: { hit: this.hihat.hit, velocity: this.hihat.velocity, timeSinceLast: this.hihat.timeSinceLast },
      clap:  { hit: this.clap.hit,  velocity: this.clap.velocity,  timeSinceLast: this.clap.timeSinceLast },
    };
  }
}
