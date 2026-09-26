// ============================================================
// HarmonyAnalyzer.js – Chromagram, Key Detection, Color Mapping
//
// Computes a 12-bin chromagram (one bin per pitch class C–B)
// from the FFT, estimates the musical key, and suggests
// color palettes that match the emotional tone of the key.
//
// The chromagram enables:
//   - Chord change detection → trigger color transitions
//   - Key modulation → palette shifts
//   - Dissonance measurement → visual distortion
//
// Music–Color associations follow Scriabin-inspired and
// synesthesia research mappings.
// ============================================================

// Pitch class names
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Key profiles (Krumhansl-Kessler major/minor profiles normalized)
// These are the expected pitch-class distributions for each key
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Key → Color palette mapping (Scriabin-inspired + modern synesthesia research)
const KEY_PALETTES = {
  'C major':  ['#ffffff', '#e8f0ff', '#f0f8ff', '#d0e8ff'],  // White, pure, bright
  'C minor':  ['#6040a0', '#8060c0', '#5030a0', '#7050b0'],  // Deep purple, somber
  'C# major': ['#ff00ff', '#ff40ff', '#cc00cc', '#ff80ff'],   // Magenta, vivid
  'C# minor': ['#400060', '#600080', '#300050', '#500070'],   // Dark violet
  'D major':  ['#ffcc00', '#ffa800', '#ffe040', '#ff9900'],   // Gold, triumphant
  'D minor':  ['#0044cc', '#0066ff', '#003399', '#0055dd'],   // Deep blue, melancholy
  'D# major': ['#ff6080', '#ff8090', '#ff4060', '#ffa0b0'],   // Rose, warm
  'D# minor': ['#404060', '#505080', '#303050', '#606090'],   // Slate, moody
  'E major':  ['#00ff80', '#40ffa0', '#00cc66', '#80ffc0'],   // Spring green
  'E minor':  ['#00ff41', '#00cc33', '#008822', '#39ff14'],   // Green, mysterious
  'F major':  ['#ff4040', '#ff6060', '#cc3030', '#ff8080'],   // Red, passionate
  'F minor':  ['#800000', '#a02020', '#600000', '#c04040'],   // Dark red, intense
  'F# major': ['#00ccff', '#40ddff', '#0099cc', '#80eeff'],   // Sky blue
  'F# minor': ['#8800ff', '#6600cc', '#aa00ff', '#bb40ff'],   // Purple, dark
  'G major':  ['#ff8000', '#ffa040', '#cc6600', '#ffb060'],   // Orange, warm
  'G minor':  ['#305030', '#406040', '#204020', '#508050'],   // Forest green
  'G# major': ['#ff0080', '#ff40a0', '#cc0066', '#ff60b0'],   // Hot pink
  'G# minor': ['#202040', '#303060', '#101030', '#404080'],   // Midnight
  'A major':  ['#ffff00', '#ffff40', '#cccc00', '#ffff80'],   // Yellow, joyful
  'A minor':  ['#0044cc', '#0066ff', '#003399', '#2266dd'],   // Blue, sad
  'A# major': ['#ff6000', '#ff8020', '#cc4c00', '#ffa040'],   // Amber
  'A# minor': ['#604020', '#805030', '#403010', '#a06040'],   // Burnt sienna
  'B major':  ['#00ffff', '#40ffff', '#00cccc', '#80ffff'],   // Cyan, crystalline
  'B minor':  ['#003366', '#004488', '#002244', '#005599'],   // Navy, introspective
};

export class HarmonyAnalyzer {
  /**
   * @param {number} sampleRate
   * @param {number} fftSize
   */
  constructor(sampleRate, fftSize) {
    this._sampleRate = sampleRate;
    this._fftSize    = fftSize;
    this._binHz      = (sampleRate / 2) / (fftSize / 2);

    // Pre-compute which FFT bins correspond to each pitch class
    // We look at harmonics from C2 (~65 Hz) to C6 (~1047 Hz)
    this._pitchBinMap = this._buildPitchBinMap();

    // ── Output State ─────────────────────────────────────
    this.chromagram       = new Float32Array(12).fill(0);
    this.smoothedChroma   = new Float32Array(12).fill(0);
    this.dominantNote     = 'C';
    this.dominantNoteIdx  = 0;
    this.estimatedKey     = 'C major';
    this.keyConfidence    = 0;
    this.suggestedPalette = KEY_PALETTES['C major'];
    this.dissonance       = 0;     // 0–1

    // Chord change detection
    this._prevChroma      = new Float32Array(12).fill(0);
    this.chordChanged     = false;
    this._chordChangeCooldown = 0;

    // EMA smoothing for chromagram
    this._chromaSmooth = 0.12;

    // Key estimation runs less frequently (every ~10 frames)
    this._keyEstimationCounter = 0;
    this._keyEstimationInterval = 10;
  }

  /**
   * Call once per frame.
   * @param {Uint8Array} frequencyData
   * @param {number} now
   */
  analyze(frequencyData, now) {
    // ── Compute raw chromagram ────────────────────────────
    this.chromagram.fill(0);

    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      const bins = this._pitchBinMap[pitchClass];
      let energy = 0;
      let count  = 0;

      for (const bin of bins) {
        if (bin >= 0 && bin < frequencyData.length) {
          energy += frequencyData[bin] / 255;
          count++;
        }
      }

      this.chromagram[pitchClass] = count > 0 ? energy / count : 0;
    }

    // ── Smooth chromagram (EMA) ──────────────────────────
    for (let i = 0; i < 12; i++) {
      this.smoothedChroma[i] += (this.chromagram[i] - this.smoothedChroma[i]) * this._chromaSmooth;
    }

    // ── Dominant note ────────────────────────────────────
    let maxChroma = 0;
    for (let i = 0; i < 12; i++) {
      if (this.smoothedChroma[i] > maxChroma) {
        maxChroma = this.smoothedChroma[i];
        this.dominantNoteIdx = i;
      }
    }
    this.dominantNote = NOTE_NAMES[this.dominantNoteIdx];

    // ── Key estimation (less frequent) ───────────────────
    this._keyEstimationCounter++;
    if (this._keyEstimationCounter >= this._keyEstimationInterval) {
      this._keyEstimationCounter = 0;
      this._estimateKey();
    }

    // ── Chord change detection ───────────────────────────
    this._detectChordChange();

    // ── Dissonance ───────────────────────────────────────
    this._computeDissonance();

    // Copy current chroma for next frame comparison
    this._prevChroma.set(this.smoothedChroma);
  }

  // ── Key Estimation (Krumhansl-Kessler algorithm) ──────────

  _estimateKey() {
    let bestKey   = 'C major';
    let bestScore = -Infinity;

    for (let root = 0; root < 12; root++) {
      // Rotate chromagram so 'root' is at index 0
      const rotated = new Float32Array(12);
      for (let i = 0; i < 12; i++) {
        rotated[i] = this.smoothedChroma[(i + root) % 12];
      }

      // Correlate with major profile
      const majorScore = this._correlate(rotated, MAJOR_PROFILE);
      if (majorScore > bestScore) {
        bestScore = majorScore;
        bestKey = `${NOTE_NAMES[root]} major`;
      }

      // Correlate with minor profile
      const minorScore = this._correlate(rotated, MINOR_PROFILE);
      if (minorScore > bestScore) {
        bestScore = minorScore;
        bestKey = `${NOTE_NAMES[root]} minor`;
      }
    }

    this.estimatedKey  = bestKey;
    this.keyConfidence = Math.max(0, Math.min(1, bestScore));
    this.suggestedPalette = KEY_PALETTES[bestKey] || KEY_PALETTES['C major'];
  }

  _correlate(a, b) {
    // Pearson correlation coefficient
    const n = a.length;
    let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
    for (let i = 0; i < n; i++) {
      sumA  += a[i];
      sumB  += b[i];
      sumAB += a[i] * b[i];
      sumA2 += a[i] * a[i];
      sumB2 += b[i] * b[i];
    }
    const num = n * sumAB - sumA * sumB;
    const den = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
    return den > 0 ? num / den : 0;
  }

  // ── Chord Change Detection ────────────────────────────────

  _detectChordChange() {
    if (this._chordChangeCooldown > 0) {
      this._chordChangeCooldown--;
      this.chordChanged = false;
      return;
    }

    // Compute cosine distance between current and previous chroma
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < 12; i++) {
      dotProduct += this.smoothedChroma[i] * this._prevChroma[i];
      normA += this.smoothedChroma[i] * this.smoothedChroma[i];
      normB += this._prevChroma[i] * this._prevChroma[i];
    }
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    const similarity = (normA > 0 && normB > 0) ? dotProduct / (normA * normB) : 1;

    // Chord change if similarity drops below threshold
    this.chordChanged = similarity < 0.85;

    if (this.chordChanged) {
      this._chordChangeCooldown = 15; // ~250ms at 60fps
    }
  }

  // ── Dissonance ────────────────────────────────────────────

  _computeDissonance() {
    // Simple dissonance: how much energy is on minor 2nds (semitones)
    // and tritones vs consonant intervals
    let dissonantEnergy  = 0;
    let consonantEnergy  = 0;
    const totalEnergy    = this.smoothedChroma.reduce((a, b) => a + b, 0);

    if (totalEnergy < 0.01) { this.dissonance = 0; return; }

    for (let i = 0; i < 12; i++) {
      for (let j = i + 1; j < 12; j++) {
        const interval = j - i;
        const product  = this.smoothedChroma[i] * this.smoothedChroma[j];

        // Dissonant intervals: minor 2nd (1), major 7th (11), tritone (6)
        if (interval === 1 || interval === 11 || interval === 6) {
          dissonantEnergy += product;
        }
        // Consonant intervals: unison, octave, perfect 5th (7), perfect 4th (5), major 3rd (4)
        else if (interval === 0 || interval === 7 || interval === 5 || interval === 4) {
          consonantEnergy += product;
        }
      }
    }

    const total = dissonantEnergy + consonantEnergy;
    this.dissonance = total > 0 ? dissonantEnergy / total : 0;
  }

  // ── Pitch Bin Mapping ─────────────────────────────────────

  _buildPitchBinMap() {
    // For each of the 12 pitch classes, find all FFT bins
    // that correspond to that note's harmonics in the range C2–C6
    const map = Array.from({ length: 12 }, () => []);

    // C2 = 65.41 Hz, iterate through octaves up to C6 = 1046.5 Hz
    for (let midi = 36; midi <= 84; midi++) { // C2 = MIDI 36, C6 = MIDI 84
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      const bin  = Math.round(freq / this._binHz);
      const pitchClass = midi % 12;

      if (bin > 0 && bin < this._fftSize / 2) {
        map[pitchClass].push(bin);
      }
    }

    return map;
  }

  /**
   * Returns a serializable snapshot.
   */
  getSnapshot() {
    return {
      chromagram:       this.smoothedChroma,
      dominantNote:     this.dominantNote,
      estimatedKey:     this.estimatedKey,
      keyConfidence:    this.keyConfidence,
      suggestedPalette: this.suggestedPalette,
      chordChanged:     this.chordChanged,
      dissonance:       this.dissonance,
    };
  }
}

export { NOTE_NAMES, KEY_PALETTES };
