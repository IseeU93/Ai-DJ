// ============================================================
// SpectralDecomposer.js – 8-Band Perceptual Frequency Analysis
//
// Replaces the old 3-band (bass/mid/high) system with a
// musically-meaningful 8-band decomposition. Each band has:
//   - Instantaneous energy (current frame)
//   - Smoothed energy (EMA with configurable decay)
//   - Onset flag (per-band spectral flux threshold)
//   - Envelope (attack/decay shape)
// ============================================================

const BANDS = [
  { name: 'sub',        minHz: 20,    maxHz: 60    },  // Sub-bass rumble, 808s
  { name: 'kick',       minHz: 60,    maxHz: 150   },  // Kick drum fundamental
  { name: 'lowMid',     minHz: 150,   maxHz: 400   },  // Bass guitar, warm synths
  { name: 'mid',        minHz: 400,   maxHz: 1000  },  // Vocals, snare body
  { name: 'upperMid',   minHz: 1000,  maxHz: 2500  },  // Vocal presence, guitar
  { name: 'presence',   minHz: 2500,  maxHz: 6000  },  // Snare crack, consonants
  { name: 'brilliance', minHz: 6000,  maxHz: 12000 },  // Hi-hats, cymbals
  { name: 'air',        minHz: 12000, maxHz: 20000 },  // Shimmer, reverb tails
];

export class SpectralDecomposer {
  /**
   * @param {number} sampleRate – Audio context sample rate (e.g. 44100 or 48000)
   * @param {number} fftSize – FFT size used by the analyser node
   */
  constructor(sampleRate, fftSize) {
    this._sampleRate = sampleRate;
    this._fftSize    = fftSize;
    this._binCount   = fftSize / 2;
    this._binHz      = (sampleRate / 2) / this._binCount;

    // Pre-compute bin ranges for each band
    this._bandRanges = BANDS.map(b => ({
      name:  b.name,
      start: Math.max(0, Math.floor(b.minHz / this._binHz)),
      end:   Math.min(this._binCount - 1, Math.floor(b.maxHz / this._binHz)),
    }));

    // Per-band state
    this._smoothed   = new Float32Array(BANDS.length).fill(0);
    this._envelope   = new Float32Array(BANDS.length).fill(0);
    this._prevEnergy = new Float32Array(BANDS.length).fill(0);

    // Per-band onset detection (spectral flux per band)
    this._fluxHistories = BANDS.map(() => new Float32Array(30).fill(0));
    this._onsetCooldowns = new Float32Array(BANDS.length).fill(0);

    // Previous frequency data for flux calculation
    this._prevFreqData = null;

    // EMA smoothing factor (higher = more smoothing)
    this._smoothAlpha = 0.15;

    // Envelope attack/decay
    this._envelopeAttack = 0.4;
    this._envelopeDecay  = 0.06;

    // Onset threshold multiplier and minimum
    this._onsetThreshold = 1.4;
    this._onsetMinFlux   = 0.015;
    this._onsetCooldownMs = 80;

    // Output object (reused each frame to avoid GC)
    this.bands = {};
    for (const b of BANDS) {
      this.bands[b.name] = { energy: 0, smoothed: 0, onset: false, envelope: 0 };
    }

    // Legacy combined values
    this.bass      = 0;
    this.mid       = 0;
    this.high      = 0;
    this.amplitude = 0;

    // Spectral centroid (brightness of the sound in Hz)
    this.spectralCentroid = 0;
  }

  /**
   * Call once per frame with the current FFT frequency data.
   * @param {Uint8Array} frequencyData – from analyser.getByteFrequencyData()
   * @param {Uint8Array} timeDomainData – from analyser.getByteTimeDomainData()
   * @param {number} now – performance.now()
   */
  analyze(frequencyData, timeDomainData, now) {
    if (!this._prevFreqData) {
      this._prevFreqData = new Uint8Array(frequencyData.length);
    }

    // ── Per-band analysis ────────────────────────────────
    for (let b = 0; b < this._bandRanges.length; b++) {
      const range = this._bandRanges[b];
      const bandName = range.name;

      // 1. Instantaneous energy (normalized 0–1)
      const energy = this._computeBandEnergy(frequencyData, range.start, range.end);

      // 2. Smoothed energy (EMA)
      this._smoothed[b] += (energy - this._smoothed[b]) * this._smoothAlpha;

      // 3. Envelope (fast attack, slow decay)
      if (energy > this._envelope[b]) {
        this._envelope[b] += (energy - this._envelope[b]) * this._envelopeAttack;
      } else {
        this._envelope[b] += (energy - this._envelope[b]) * this._envelopeDecay;
      }

      // 4. Per-band onset detection via spectral flux
      const flux = this._computeBandFlux(frequencyData, range.start, range.end);
      const fluxHist = this._fluxHistories[b];

      // Shift FIFO and insert new flux
      for (let i = 0; i < fluxHist.length - 1; i++) {
        fluxHist[i] = fluxHist[i + 1];
      }
      fluxHist[fluxHist.length - 1] = flux;

      // Average flux for adaptive threshold
      let avgFlux = 0;
      for (let i = 0; i < fluxHist.length; i++) avgFlux += fluxHist[i];
      avgFlux /= fluxHist.length;

      // Cooldown tracking
      const cooldownActive = this._onsetCooldowns[b] > 0;
      if (cooldownActive) {
        this._onsetCooldowns[b] = Math.max(0, this._onsetCooldowns[b] - 16); // ~16ms per frame
      }

      const isOnset = !cooldownActive &&
                      flux > avgFlux * this._onsetThreshold &&
                      flux > this._onsetMinFlux;

      if (isOnset) {
        this._onsetCooldowns[b] = this._onsetCooldownMs;
      }

      // Store previous energy for next frame
      this._prevEnergy[b] = energy;

      // Write to output
      this.bands[bandName].energy   = energy;
      this.bands[bandName].smoothed = this._smoothed[b];
      this.bands[bandName].onset    = isOnset;
      this.bands[bandName].envelope = this._envelope[b];
    }

    // Store previous frequency data
    this._prevFreqData.set(frequencyData);

    // ── Legacy combined values (for backward compat) ──────
    this.bass = this.bands.sub.energy * 0.4 + this.bands.kick.energy * 0.6;
    this.mid  = this.bands.lowMid.energy * 0.25 +
                this.bands.mid.energy * 0.5 +
                this.bands.upperMid.energy * 0.25;
    this.high = this.bands.presence.energy * 0.4 +
                this.bands.brilliance.energy * 0.4 +
                this.bands.air.energy * 0.2;

    // RMS amplitude from time domain
    this.amplitude = this._computeRMS(timeDomainData);

    // ── Spectral centroid ─────────────────────────────────
    this.spectralCentroid = this._computeSpectralCentroid(frequencyData);
  }

  // ── Internal helpers ─────────────────────────────────────

  _computeBandEnergy(freqData, startBin, endBin) {
    if (startBin > endBin) return 0;
    let sum = 0;
    for (let i = startBin; i <= endBin; i++) {
      sum += freqData[i];
    }
    return sum / (255 * (endBin - startBin + 1));
  }

  _computeBandFlux(freqData, startBin, endBin) {
    if (!this._prevFreqData || startBin > endBin) return 0;
    let flux = 0;
    for (let i = startBin; i <= endBin; i++) {
      const diff = freqData[i] - this._prevFreqData[i];
      if (diff > 0) flux += diff;
    }
    const binCount = endBin - startBin + 1;
    return flux / (255 * binCount);
  }

  _computeRMS(timeDomainData) {
    let ss = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      const s = (timeDomainData[i] - 128) / 128;
      ss += s * s;
    }
    return Math.sqrt(ss / timeDomainData.length);
  }

  _computeSpectralCentroid(freqData) {
    let weightedSum = 0;
    let totalEnergy = 0;
    for (let i = 1; i < freqData.length; i++) {
      const freq = i * this._binHz;
      const mag  = freqData[i];
      weightedSum += freq * mag;
      totalEnergy += mag;
    }
    return totalEnergy > 0 ? weightedSum / totalEnergy : 0;
  }

  /**
   * Returns a snapshot of all band data for serialization.
   */
  getSnapshot() {
    const result = {};
    for (const b of BANDS) {
      const d = this.bands[b.name];
      result[b.name] = {
        energy:   d.energy,
        smoothed: d.smoothed,
        onset:    d.onset,
        envelope: d.envelope,
      };
    }
    return result;
  }
}

export { BANDS };
