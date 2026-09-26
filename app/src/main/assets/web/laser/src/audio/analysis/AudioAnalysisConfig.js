export const AUDIO_INPUT_FOUNDATION_VERSION = '0.1.0';
export const AUDIO_FEATURE_HARDENING_VERSION = '0.2.0';
export const AUDIO_FEATURE_SCHEMA_VERSION = 2;

export const FREQUENCY_BANDS_HZ = Object.freeze({
  infra: Object.freeze({ minHz: 20, maxHz: 45 }),
  sub: Object.freeze({ minHz: 45, maxHz: 80 }),
  lowBass: Object.freeze({ minHz: 80, maxHz: 140 }),
  bassBody: Object.freeze({ minHz: 140, maxHz: 250 }),
  lowMid: Object.freeze({ minHz: 250, maxHz: 500 }),
  mid: Object.freeze({ minHz: 500, maxHz: 2000 }),
  highMid: Object.freeze({ minHz: 2000, maxHz: 6000 }),
  high: Object.freeze({ minHz: 6000, maxHz: 16000 }),
});

export const DEFAULT_AUDIO_ANALYSIS_CONFIG = Object.freeze({
  fftSize: 2048,
  updateHz: 40,
  silenceRms: 0.0005,
  clippingPeak: 0.995,
  transientThreshold: 0.22,
  staleAfterMs: 750,
  attackSeconds: 0.06,
  releaseSeconds: 0.4,
  lowEnergyAttackSeconds: 0.12,
  lowEnergyReleaseSeconds: 0.65,
  lowImpactAttackSeconds: 0.02,
  lowImpactReleaseSeconds: 0.11,
  lowBaselineRiseSeconds: 2.5,
  lowBaselineFallSeconds: 6,
  noiseFloorSeconds: 18,
  typicalLevelSeconds: 6,
  peakReferenceRiseSeconds: 3,
  peakReferenceFallSeconds: 24,
});

const finiteClamp = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const validFftSize = (value) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number)
    && number >= 1024
    && number <= 8192
    && (number & (number - 1)) === 0;
};

export const normalizeAudioAnalysisConfig = (input = {}) => Object.freeze({
  fftSize: validFftSize(input.fftSize) ? Number(input.fftSize) : DEFAULT_AUDIO_ANALYSIS_CONFIG.fftSize,
  updateHz: finiteClamp(input.updateHz, DEFAULT_AUDIO_ANALYSIS_CONFIG.updateHz, 30, 60),
  silenceRms: finiteClamp(input.silenceRms, DEFAULT_AUDIO_ANALYSIS_CONFIG.silenceRms, 0.00001, 0.05),
  clippingPeak: finiteClamp(input.clippingPeak, DEFAULT_AUDIO_ANALYSIS_CONFIG.clippingPeak, 0.8, 1),
  transientThreshold: finiteClamp(input.transientThreshold, DEFAULT_AUDIO_ANALYSIS_CONFIG.transientThreshold, 0.05, 0.9),
  staleAfterMs: finiteClamp(input.staleAfterMs, DEFAULT_AUDIO_ANALYSIS_CONFIG.staleAfterMs, 250, 5000),
  attackSeconds: finiteClamp(input.attackSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.attackSeconds, 0.01, 1),
  releaseSeconds: finiteClamp(input.releaseSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.releaseSeconds, 0.05, 3),
  lowEnergyAttackSeconds: finiteClamp(input.lowEnergyAttackSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.lowEnergyAttackSeconds, 0.03, 1.5),
  lowEnergyReleaseSeconds: finiteClamp(input.lowEnergyReleaseSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.lowEnergyReleaseSeconds, 0.1, 4),
  lowImpactAttackSeconds: finiteClamp(input.lowImpactAttackSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.lowImpactAttackSeconds, 0.005, 0.25),
  lowImpactReleaseSeconds: finiteClamp(input.lowImpactReleaseSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.lowImpactReleaseSeconds, 0.03, 0.5),
  lowBaselineRiseSeconds: finiteClamp(input.lowBaselineRiseSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.lowBaselineRiseSeconds, 0.5, 20),
  lowBaselineFallSeconds: finiteClamp(input.lowBaselineFallSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.lowBaselineFallSeconds, 1, 60),
  noiseFloorSeconds: finiteClamp(input.noiseFloorSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.noiseFloorSeconds, 2, 120),
  typicalLevelSeconds: finiteClamp(input.typicalLevelSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.typicalLevelSeconds, 1, 60),
  peakReferenceRiseSeconds: finiteClamp(input.peakReferenceRiseSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.peakReferenceRiseSeconds, 0.5, 30),
  peakReferenceFallSeconds: finiteClamp(input.peakReferenceFallSeconds, DEFAULT_AUDIO_ANALYSIS_CONFIG.peakReferenceFallSeconds, 2, 180),
});
