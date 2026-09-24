import {
  AUDIO_FEATURE_HARDENING_VERSION,
  AUDIO_INPUT_FOUNDATION_VERSION,
  AUDIO_FEATURE_SCHEMA_VERSION,
  normalizeAudioAnalysisConfig,
} from './analysis/AudioAnalysisConfig.js';
import { AudioFeatureExtractor } from './analysis/AudioFeatureExtractor.js';
import { AudioFeatureNormalizer } from './analysis/AudioFeatureNormalizer.js';
import { createAudioFeatureSnapshot } from './analysis/AudioFeatureSnapshot.js';
import { BrowserSystemAudioSource } from './sources/BrowserSystemAudioSource.js';
import { SyntheticAudioSource } from './sources/SyntheticAudioSource.js?v=0.2.3-r1';
import { RhythmRuntime } from './rhythm/RhythmRuntime.js?v=0.2.3-r1';

const zeroRawFeatures = (timestamp = 0) => ({
  timestamp, sampleRate: 0, fftSize: 0, nyquistHz: 0,
  rms: 0, peak: 0, crestFactor: 0, isClipping: false, isSilent: true,
  infraEnergy: 0, subEnergy: 0, lowBassEnergy: 0, bassBodyEnergy: 0, bassEnergy: 0,
  lowMidEnergy: 0, midEnergy: 0, highMidEnergy: 0, highEnergy: 0,
  lowFrequencyEnergy: 0, lowFrequencyImpact: 0, lowFrequencyImpactConfidence: 0,
  lowEndSustained: 0, lowEndTransient: 0, lowBandFlux: 0, lowBaseline: 0,
  subToLowMidRatio: 0, lowBassToLowMidRatio: 0, lowImpactToSustainedRatio: 0,
  spectralCentroid: 0, spectralFlux: 0, spectralFlatness: 0, spectralChange: 0,
  transientStrength: 0, transientCandidate: false, transientConfidence: 0,
});

const sourceSignalState = (status, raw, timestamp, staleAfterMs) => {
  if (['denied', 'unavailable', 'error'].includes(status.state)) return 'error';
  if (status.state === 'ended') return 'ended';
  if (status.state === 'idle') return 'no-source';
  if (!status.lastFrameAt) return 'source-active';
  if (timestamp - status.lastFrameAt > staleAfterMs) return 'stale';
  if (raw.isClipping) return 'clipping';
  if (raw.isSilent) return 'silence';
  return 'signal';
};

export class AudioInputRuntime {
  constructor({
    config = {},
    browserSource = new BrowserSystemAudioSource(),
    syntheticSource = new SyntheticAudioSource(),
    now = () => performance.now(),
  } = {}) {
    this.version = AUDIO_FEATURE_HARDENING_VERSION;
    this.config = normalizeAudioAnalysisConfig(config);
    this.browserSource = browserSource;
    this.syntheticSource = syntheticSource;
    this.source = null;
    this.extractor = new AudioFeatureExtractor(this.config);
    this.normalizer = new AudioFeatureNormalizer(this.config);
    this.rhythm = new RhythmRuntime();
    this.now = now;
    this.lastUpdateAt = 0;
    this.lastSnapshot = createAudioFeatureSnapshot();
    this.lastBeatClockSnapshot = this.rhythm.lastSnapshot;
    this.recording = null;
  }

  async connectSystemAudio() {
    // Invoke getDisplayMedia before yielding so the visible click keeps its
    // transient user activation, even when a synthetic source was active.
    const previousSource = this.source !== this.browserSource ? this.source : null;
    const stopPromise = previousSource?.stop?.();
    this.source = this.browserSource;
    this.extractor.reset();
    this.rhythm.reset(this.now(), 'source-changed');
    this.lastUpdateAt = 0;
    const startPromise = this.browserSource.start();
    if (stopPromise) await stopPromise;
    const status = await startPromise;
    return this._snapshotWithoutFrame(status);
  }

  async startSynthetic(signalType) {
    await this._switchSource(this.syntheticSource);
    await this.syntheticSource.start(signalType);
    return this.update(this.now(), { force: true });
  }

  async disconnect() {
    if (this.source) await this.source.stop();
    this.source = null;
    this.extractor.reset();
    this.rhythm.reset(this.now(), 'source-disconnected');
    return this._snapshotWithoutFrame({ state: 'idle' });
  }

  async _switchSource(nextSource) {
    if (this.source && this.source !== nextSource) await this.source.stop();
    this.source = nextSource;
    this.extractor.reset();
    this.rhythm.reset(this.now(), 'source-changed');
    this.lastUpdateAt = 0;
  }

  update(timestamp = this.now(), { force = false } = {}) {
    const minimumInterval = 1000 / this.config.updateHz;
    if (!force && this.lastUpdateAt && timestamp - this.lastUpdateAt < minimumInterval) return this.lastSnapshot;
    const deltaTime = this.lastUpdateAt ? Math.max(0, timestamp - this.lastUpdateAt) / 1000 : 1 / this.config.updateHz;
    this.lastUpdateAt = timestamp;
    const frame = this.source?.readFrame?.(this.source === this.syntheticSource
      ? { frameSize: this.config.fftSize, timestamp }
      : timestamp);
    const raw = frame ? this.extractor.extract(frame) : zeroRawFeatures(timestamp);
    const status = this.source?.getStatus?.() || {
      sourceId: '', sourceType: '', state: 'idle', sampleRate: 0, channelCount: 0,
      lastFrameAt: 0,
    };
    const signalState = sourceSignalState(status, raw, timestamp, this.config.staleAfterMs);
    const normalized = this.normalizer.normalize(raw, { deltaTime, timestamp, signalState });
    this.lastSnapshot = createAudioFeatureSnapshot({
      timestamp, sourceStatus: status, rawFeatures: raw, normalizedFeatures: normalized, signalState,
    });
    this.lastBeatClockSnapshot = this.rhythm.update(this.lastSnapshot, timestamp);
    this._record(this.lastSnapshot, this.lastBeatClockSnapshot);
    return this.lastSnapshot;
  }

  startCalibration(timestamp = this.now()) {
    return this.normalizer.startCalibration(timestamp, 10_000);
  }

  resetCalibration() {
    return this.normalizer.resetCalibration();
  }

  getCalibrationStatus(timestamp = this.now()) {
    return this.normalizer.getCalibrationStatus(timestamp);
  }

  startRecording(durationSeconds = null, timestamp = this.now()) {
    const duration = durationSeconds === null ? null : Math.max(1, Math.min(60, Number(durationSeconds) || 30));
    this.recording = {
      startedAt: timestamp,
      endsAt: duration === null ? null : timestamp + duration * 1000,
      durationSeconds: duration,
      snapshots: [],
      rhythmSnapshots: [],
      stoppedAt: null,
    };
    return this.getRecordingStatus(timestamp);
  }

  stopRecording(timestamp = this.now()) {
    if (this.recording && this.recording.stoppedAt === null) this.recording.stoppedAt = timestamp;
    return this.getRecordingStatus(timestamp);
  }

  getRecordingStatus(timestamp = this.now()) {
    if (!this.recording) return Object.freeze({ active: false, snapshotCount: 0, elapsedSeconds: 0 });
    const active = this.recording.stoppedAt === null
      && (this.recording.endsAt === null || timestamp < this.recording.endsAt);
    return Object.freeze({
      active,
      snapshotCount: this.recording.snapshots.length,
      elapsedSeconds: Math.max(0, ((this.recording.stoppedAt ?? timestamp) - this.recording.startedAt) / 1000),
      durationSeconds: this.recording.durationSeconds,
    });
  }

  exportRecording(timestamp = this.now()) {
    const status = this.source?.getStatus?.() || {};
    return Object.freeze({
      schemaVersion: AUDIO_FEATURE_SCHEMA_VERSION,
      foundationVersion: AUDIO_INPUT_FOUNDATION_VERSION,
      featureHardeningVersion: this.version,
      rhythmVersion: this.rhythm.version,
      rhythmSchemaVersion: this.lastBeatClockSnapshot.schemaVersion,
      exportedAt: timestamp,
      metadata: Object.freeze({
        sourceId: String(status.sourceId || ''),
        sourceType: String(status.sourceType || ''),
        sampleRate: Number(status.sampleRate) || 0,
        channelCount: Number(status.channelCount) || 0,
        updateHz: this.config.updateHz,
        fftSize: this.config.fftSize,
      }),
      snapshots: Object.freeze([...(this.recording?.snapshots || [])]),
      rhythmSnapshots: Object.freeze([...(this.recording?.rhythmSnapshots || [])]),
    });
  }

  _record(snapshot, beatClockSnapshot) {
    if (!this.recording || this.recording.stoppedAt !== null) return;
    if (this.recording.endsAt !== null && snapshot.timestamp >= this.recording.endsAt) {
      this.recording.stoppedAt = snapshot.timestamp;
      return;
    }
    this.recording.snapshots.push(snapshot);
    this.recording.rhythmSnapshots.push(Object.freeze({
      timestamp: snapshot.timestamp,
      audioFeatureSummary: Object.freeze({
        signalState: snapshot.signalState,
        rms: snapshot.level.rms.smoothed,
        lowFrequencyEnergy: snapshot.lowEnd.totalEnergy.smoothed,
        lowFrequencyImpact: snapshot.lowEnd.impact.value,
        spectralFlux: snapshot.spectrum.flux.smoothed,
        transientStrength: snapshot.transient.strength.smoothed,
      }),
      beatCandidate: beatClockSnapshot.candidate,
      rhythmNovelty: beatClockSnapshot.novelty,
      bpmCandidates: beatClockSnapshot.tempo.topCandidates,
      continuousTempo: beatClockSnapshot.tempo,
      selectedBpm: beatClockSnapshot.tempo.bpm,
      tempoState: beatClockSnapshot.tempo.state,
      tempoConfidence: beatClockSnapshot.tempo.confidence,
      phase: beatClockSnapshot.beat.phase,
      phaseConfidence: beatClockSnapshot.beat.phaseConfidence,
      predictedNextBeat: beatClockSnapshot.beat.predictedNextBeatTime,
      phaseCorrection: beatClockSnapshot.beat.correctionMs,
      beatEvent: beatClockSnapshot.beat.event,
      beatGrid: beatClockSnapshot.beat,
      anchorClustering: beatClockSnapshot.beat.anchorClustering,
      lockFreshness: Object.freeze({
        value: beatClockSnapshot.tempo.lockFreshness,
        lastStrongAnchorAgeMs: beatClockSnapshot.tempo.lastStrongAnchorAgeMs,
        lastAnyAnchorAgeMs: beatClockSnapshot.tempo.lastAnyAnchorAgeMs,
        recentAnchorCount: beatClockSnapshot.tempo.recentAnchorCount,
        recentGridSupport: beatClockSnapshot.tempo.recentGridSupport,
        recentTempoAgreement: beatClockSnapshot.tempo.recentTempoAgreement,
        rhythmicContinuity: beatClockSnapshot.tempo.rhythmicContinuity,
        staleScore: beatClockSnapshot.tempo.staleLockScore,
      }),
      harmonicResolution: Object.freeze({
        baseBpm: beatClockSnapshot.tempo.baseBpm,
        doubleBpm: beatClockSnapshot.tempo.doubleBpm,
        intermediateBeatSupport: beatClockSnapshot.tempo.intermediateBeatSupport,
        intermediateEventQuality: beatClockSnapshot.tempo.intermediateEventQuality,
        baseTempoEvidence: beatClockSnapshot.tempo.baseTempoEvidence,
        supportConsistency: beatClockSnapshot.tempo.intermediateSupportConsistency,
        multiBandAgreement: beatClockSnapshot.tempo.intermediateMultiBandAgreement,
        supportDurationMs: beatClockSnapshot.tempo.intermediateSupportDurationMs,
        onsetRegularity: beatClockSnapshot.tempo.intermediateOnsetRegularity,
        dancePriorContribution: beatClockSnapshot.tempo.dancePriorContribution,
        finalDecision: beatClockSnapshot.tempo.finalHarmonicDecision,
      }),
      harmonicStability: Object.freeze({
        fullTimeSupportHistory: beatClockSnapshot.tempo.fullTimeSupportHistory,
        halfTimeTakeoverEvidence: beatClockSnapshot.tempo.halfTimeTakeoverEvidence,
        halfTimeTakeoverReason: beatClockSnapshot.tempo.halfTimeTakeoverReason,
        harmonicMaturity: beatClockSnapshot.tempo.harmonicLockMaturity,
        harmonicAmbiguity: beatClockSnapshot.tempo.harmonicAmbiguity,
      }),
      lowTempoResolution: Object.freeze({
        baseBpm: beatClockSnapshot.tempo.baseBpm,
        doubleBpm: beatClockSnapshot.tempo.doubleBpm,
        baseTempoEvidence: beatClockSnapshot.tempo.baseTempoEvidence,
        intermediateBeatSupport: beatClockSnapshot.tempo.intermediateBeatSupport,
        intermediateEventQuality: beatClockSnapshot.tempo.intermediateEventQuality,
        intermediateConsistency: beatClockSnapshot.tempo.intermediateSupportConsistency,
        multiBandAgreement: beatClockSnapshot.tempo.intermediateMultiBandAgreement,
        dancePriorContribution: beatClockSnapshot.tempo.dancePriorContribution,
        decisionReason: beatClockSnapshot.tempo.finalHarmonicDecision,
      }),
      acquisition: Object.freeze({
        confidence: beatClockSnapshot.tempo.acquisitionConfidence,
        maturity: beatClockSnapshot.tempo.acquisitionMaturity,
        lockQuality: beatClockSnapshot.tempo.lockQuality,
        periodicityConfidence: beatClockSnapshot.tempo.periodicityConfidence,
        anchorSupport: beatClockSnapshot.tempo.acquisitionAnchorSupport,
        evidenceAgeMs: beatClockSnapshot.tempo.acquisitionEvidenceAgeMs,
        reason: beatClockSnapshot.tempo.acquisitionReason,
      }),
      transition: Object.freeze({
        state: beatClockSnapshot.tempo.transitionState,
        oldTempo: beatClockSnapshot.tempo.transitionOldTempo,
        candidateTempo: beatClockSnapshot.tempo.transitionCandidateTempo,
        staleDurationMs: beatClockSnapshot.tempo.staleDurationMs,
        reacquireDurationMs: beatClockSnapshot.tempo.reacquireDurationMs,
      }),
    }));
  }

  _snapshotWithoutFrame(status) {
    const timestamp = this.now();
    const sourceStatus = this.source?.getStatus?.() || status;
    const raw = zeroRawFeatures(timestamp);
    const signalState = sourceSignalState(sourceStatus, raw, timestamp, this.config.staleAfterMs);
    const normalized = this.normalizer.normalize(raw, { timestamp, signalState });
    this.lastSnapshot = createAudioFeatureSnapshot({ timestamp, sourceStatus, rawFeatures: raw, normalizedFeatures: normalized, signalState });
    this.lastBeatClockSnapshot = this.rhythm.update(this.lastSnapshot, timestamp);
    return this.lastSnapshot;
  }
}
