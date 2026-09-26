import {
  FREQUENCY_BANDS_HZ,
  normalizeAudioAnalysisConfig,
} from './AudioAnalysisConfig.js';

const EPSILON = 1e-12;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));
const boundedRatio = (numerator, denominator, max = 8) => Math.max(
  0,
  Math.min(max, finite(numerator) / Math.max(0.002, finite(denominator))),
);
const response = (deltaTime, seconds) => 1 - Math.exp(-Math.max(0, deltaTime) / Math.max(0.001, seconds));

const magnitudeSpectrum = (samples, fftSize) => {
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const available = Math.min(samples?.length || 0, fftSize);
  for (let index = 0; index < available; index++) {
    const window = fftSize > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1)) : 1;
    real[index] = finite(Number(samples[index])) * window;
  }

  for (let index = 1, reversed = 0; index < fftSize; index++) {
    let bit = fftSize >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let length = 2; length <= fftSize; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const phaseReal = Math.cos(angle);
    const phaseImaginary = Math.sin(angle);
    for (let offset = 0; offset < fftSize; offset += length) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let index = 0; index < length / 2; index++) {
        const even = offset + index;
        const odd = even + length / 2;
        const oddReal = real[odd] * rotationReal - imaginary[odd] * rotationImaginary;
        const oddImaginary = real[odd] * rotationImaginary + imaginary[odd] * rotationReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = rotationReal * phaseReal - rotationImaginary * phaseImaginary;
        rotationImaginary = rotationReal * phaseImaginary + rotationImaginary * phaseReal;
        rotationReal = nextReal;
      }
    }
  }

  const magnitudes = new Float64Array(fftSize / 2);
  const scale = 4 / fftSize;
  for (let index = 0; index < magnitudes.length; index++) {
    magnitudes[index] = Math.hypot(real[index], imaginary[index]) * scale;
  }
  return magnitudes;
};

const decodeSpectrum = (frame, fftSize) => {
  if (!frame.frequencyData?.length || frame.spectrumScale === 'pcm') {
    return magnitudeSpectrum(frame.timeDomainSamples, fftSize);
  }
  const magnitudes = new Float64Array(Math.min(frame.frequencyData.length, fftSize / 2));
  for (let index = 0; index < magnitudes.length; index++) {
    const value = Number(frame.frequencyData[index]);
    magnitudes[index] = frame.spectrumScale === 'decibels'
      ? (Number.isFinite(value) ? 10 ** (value / 20) : 0)
      : Math.max(0, finite(value));
  }
  return magnitudes;
};

const bandEnergy = (magnitudes, sampleRate, fftSize, range) => {
  const nyquist = sampleRate / 2;
  const minHz = Math.max(0, range.minHz);
  const maxHz = Math.min(range.maxHz, nyquist);
  if (maxHz <= minHz) return 0;
  const first = Math.max(1, Math.ceil(minHz * fftSize / sampleRate));
  const last = Math.min(magnitudes.length - 1, Math.floor(maxHz * fftSize / sampleRate));
  if (last < first) return 0;
  let energy = 0;
  let count = 0;
  for (let index = first; index <= last; index++) {
    energy += magnitudes[index] * magnitudes[index];
    count++;
  }
  return count ? Math.sqrt(energy / count) : 0;
};

export class AudioFeatureExtractor {
  constructor(config = {}) {
    this.config = normalizeAudioAnalysisConfig(config);
    this._previousSpectrum = null;
    this._previousRms = 0;
    this._previousTimestamp = null;
    this._previousLowFrequencyEnergy = 0;
    this._lowBaseline = 0;
    this._lowSustained = 0;
    this._lowImpact = 0;
  }

  reset() {
    this._previousSpectrum = null;
    this._previousRms = 0;
    this._previousTimestamp = null;
    this._previousLowFrequencyEnergy = 0;
    this._lowBaseline = 0;
    this._lowSustained = 0;
    this._lowImpact = 0;
  }

  extract(frame = {}) {
    const samples = frame.timeDomainSamples || new Float32Array(this.config.fftSize);
    const fftSize = Number.isFinite(frame.fftSize) ? frame.fftSize : this.config.fftSize;
    const sampleRate = Number.isFinite(frame.sampleRate) && frame.sampleRate > 0 ? frame.sampleRate : 48000;
    let sumSquares = 0;
    let peak = 0;
    for (const raw of samples) {
      const sample = finite(Number(raw));
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
    const isSilent = rms < this.config.silenceRms && peak < this.config.silenceRms * 4;
    const magnitudes = decodeSpectrum({ ...frame, timeDomainSamples: samples }, fftSize);
    const bands = {};
    for (const [name, range] of Object.entries(FREQUENCY_BANDS_HZ)) {
      bands[`${name}Energy`] = bandEnergy(magnitudes, sampleRate, fftSize, range);
    }
    // Compatibility feature for consumers of schema v1. The hardened feature
    // model exposes the individual low-end bands in addition to this broad view.
    bands.bassEnergy = Math.sqrt((
      bands.subEnergy ** 2
      + bands.lowBassEnergy ** 2
      + bands.bassBodyEnergy ** 2
    ) / 3);

    let weightedFrequency = 0;
    let magnitudeTotal = 0;
    let logTotal = 0;
    let flatnessCount = 0;
    for (let index = 1; index < magnitudes.length; index++) {
      const magnitude = Math.max(0, finite(magnitudes[index]));
      const frequency = index * sampleRate / fftSize;
      if (frequency > sampleRate / 2) break;
      weightedFrequency += frequency * magnitude;
      magnitudeTotal += magnitude;
      if (magnitude > EPSILON) {
        logTotal += Math.log(magnitude);
        flatnessCount++;
      }
    }
    const spectralCentroid = magnitudeTotal > EPSILON ? weightedFrequency / magnitudeTotal : 0;
    const arithmeticMean = flatnessCount ? magnitudeTotal / flatnessCount : 0;
    const spectralFlatness = arithmeticMean > EPSILON
      ? clamp01(Math.exp(logTotal / flatnessCount) / arithmeticMean)
      : 0;

    let positiveDifferenceSquares = 0;
    let absoluteDifference = 0;
    let comparisonEnergy = 0;
    if (this._previousSpectrum?.length === magnitudes.length) {
      for (let index = 1; index < magnitudes.length; index++) {
        const difference = magnitudes[index] - this._previousSpectrum[index];
        if (difference > 0) positiveDifferenceSquares += difference * difference;
        absoluteDifference += Math.abs(difference);
        comparisonEnergy += magnitudes[index] + this._previousSpectrum[index];
      }
    }
    const currentEnergy = Math.sqrt(magnitudes.reduce((sum, value) => sum + value * value, 0));
    const spectralFlux = this._previousSpectrum
      ? clamp01(Math.sqrt(positiveDifferenceSquares) / Math.max(currentEnergy, EPSILON))
      : 0;
    const spectralChange = this._previousSpectrum
      ? clamp01(absoluteDifference / Math.max(comparisonEnergy, EPSILON))
      : 0;
    const levelRise = clamp01((rms - this._previousRms) / Math.max(this._previousRms, 0.02));
    const transientStrength = isSilent ? 0 : clamp01(spectralFlux * 0.7 + levelRise * 0.3);
    const transientCandidate = !isSilent && transientStrength >= this.config.transientThreshold;
    const signalConfidence = clamp01(rms / Math.max(this.config.silenceRms * 20, EPSILON));
    const transientConfidence = transientCandidate
      ? clamp01((transientStrength - this.config.transientThreshold) / (1 - this.config.transientThreshold) * signalConfidence)
      : 0;

    const timestamp = finite(frame.timestamp);
    const deltaTime = this._previousTimestamp !== null && timestamp > this._previousTimestamp
      ? Math.min(0.25, (timestamp - this._previousTimestamp) / 1000)
      : 1 / this.config.updateHz;
    const lowFrequencyEnergy = Math.sqrt(
      bands.infraEnergy ** 2 * 0.1
      + bands.subEnergy ** 2 * 0.34
      + bands.lowBassEnergy ** 2 * 0.36
      + bands.bassBodyEnergy ** 2 * 0.2,
    );
    let lowPositiveDifferenceSquares = 0;
    let lowCurrentEnergy = 0;
    if (this._previousSpectrum?.length === magnitudes.length) {
      const firstLowBin = Math.max(1, Math.ceil(20 * fftSize / sampleRate));
      const lastLowBin = Math.min(magnitudes.length - 1, Math.floor(250 * fftSize / sampleRate));
      for (let index = firstLowBin; index <= lastLowBin; index++) {
        const difference = magnitudes[index] - this._previousSpectrum[index];
        if (difference > 0) lowPositiveDifferenceSquares += difference * difference;
        lowCurrentEnergy += magnitudes[index] * magnitudes[index];
      }
    }
    const lowBandFlux = this._previousSpectrum
      ? clamp01(Math.sqrt(lowPositiveDifferenceSquares) / Math.max(Math.sqrt(lowCurrentEnergy), EPSILON))
      : 0;
    const lowEnergyRise = clamp01(
      (lowFrequencyEnergy - this._previousLowFrequencyEnergy)
      / Math.max(this._previousLowFrequencyEnergy, this._lowBaseline, 0.015),
    );
    const baselineExcess = clamp01(
      (lowFrequencyEnergy - this._lowBaseline)
      / Math.max(0.04, this._lowBaseline * 2.5),
    );
    const lowSum = bands.subEnergy + bands.lowBassEnergy + bands.bassBodyEnergy + bands.lowMidEnergy;
    const lowBandDominance = clamp01(
      ((bands.subEnergy + bands.lowBassEnergy) / Math.max(0.01, bands.bassBodyEnergy + bands.lowMidEnergy)) / 1.5,
    );
    const lowMidShare = clamp01(bands.lowMidEnergy / Math.max(0.01, lowSum));
    const lowAttackEvidence = clamp01(levelRise * 0.55 + lowBandFlux * 0.35 + lowEnergyRise * 0.1);
    const lowEnergyPresence = isSilent ? 0 : clamp01(lowFrequencyEnergy / 0.06);
    const lowImpactInstant = lowEnergyPresence
      * lowAttackEvidence
      * (0.55 + baselineExcess * 0.45)
      * (0.4 + lowBandDominance * 0.6);
    const impactSeconds = lowImpactInstant > this._lowImpact
      ? this.config.lowImpactAttackSeconds
      : this.config.lowImpactReleaseSeconds;
    this._lowImpact += (lowImpactInstant - this._lowImpact) * response(deltaTime, impactSeconds);
    const sustainedSeconds = lowFrequencyEnergy > this._lowSustained
      ? this.config.lowEnergyAttackSeconds
      : this.config.lowEnergyReleaseSeconds;
    this._lowSustained += (lowFrequencyEnergy - this._lowSustained) * response(deltaTime, sustainedSeconds);
    const lowFrequencyImpactConfidence = clamp01(
      lowEnergyPresence
      * lowAttackEvidence
      * (0.35 + baselineExcess * 0.65)
      * (0.25 + lowBandDominance * 0.75)
      * (1 - lowMidShare * 0.6),
    );
    const baselineSeconds = lowFrequencyEnergy > this._lowBaseline
      ? this.config.lowBaselineRiseSeconds
      : this.config.lowBaselineFallSeconds;
    this._lowBaseline += (lowFrequencyEnergy - this._lowBaseline) * response(deltaTime, baselineSeconds);
    const subToLowMidRatio = boundedRatio(bands.subEnergy, bands.lowMidEnergy);
    const lowBassToLowMidRatio = boundedRatio(bands.lowBassEnergy, bands.lowMidEnergy);
    const lowImpactToSustainedRatio = boundedRatio(this._lowImpact, this._lowSustained);

    this._previousSpectrum = Float64Array.from(magnitudes);
    this._previousRms = rms;
    this._previousTimestamp = timestamp;
    this._previousLowFrequencyEnergy = lowFrequencyEnergy;

    const result = {
      timestamp,
      sampleRate,
      fftSize,
      nyquistHz: sampleRate / 2,
      rms,
      peak,
      crestFactor: rms > EPSILON ? peak / rms : 0,
      isClipping: peak >= this.config.clippingPeak,
      isSilent,
      ...bands,
      spectralCentroid,
      spectralFlux,
      spectralFlatness,
      spectralChange,
      transientStrength,
      transientCandidate,
      transientConfidence,
      lowFrequencyEnergy,
      lowFrequencyImpact: clamp01(this._lowImpact),
      lowFrequencyImpactConfidence,
      lowEndSustained: Math.max(0, finite(this._lowSustained)),
      lowEndTransient: clamp01(this._lowImpact),
      lowBandFlux,
      lowBaseline: Math.max(0, finite(this._lowBaseline)),
      subToLowMidRatio,
      lowBassToLowMidRatio,
      lowImpactToSustainedRatio,
    };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'number' && !Number.isFinite(value)) result[key] = 0;
    }
    return Object.freeze(result);
  }
}
