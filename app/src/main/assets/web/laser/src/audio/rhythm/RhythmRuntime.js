import { BeatCandidateExtractor } from './BeatCandidateExtractor.js';
import { BeatGridTracker } from './BeatGridTracker.js';
import { createBeatClockSnapshot } from './BeatClockSnapshot.js';
import { ContinuousTempoEstimator } from './ContinuousTempoEstimator.js?v=0.2.3-r1';
import { RhythmNoveltyTracker } from './RhythmNoveltyTracker.js';
import { TapTempoController } from './TapTempoController.js';
import {
  RHYTHM_ROBUSTNESS_TRANSITION_VERSION,
  RHYTHM_HARMONIC_STABILITY_VERSION,
  normalizeRhythmConfig,
} from './RhythmConfig.js';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export class RhythmRuntime {
  constructor({ config = {} } = {}) {
    this.version = RHYTHM_HARMONIC_STABILITY_VERSION;
    this.config = normalizeRhythmConfig(config);
    this.candidateExtractor = new BeatCandidateExtractor(this.config);
    this.noveltyTracker = new RhythmNoveltyTracker(this.config);
    this.tempoEstimator = new ContinuousTempoEstimator(this.config);
    this.phaseTracker = new BeatGridTracker(this.config);
    this.tapController = new TapTempoController(this.config);
    this.mode = 'auto';
    this.manualBpm = 120;
    this.lastAudioSnapshot = null;
    this.lastNovelty = null;
    this.lastSnapshot = createBeatClockSnapshot();
  }

  update(audioSnapshot = {}, timestamp = audioSnapshot.timestamp || 0) {
    const now = Math.max(0, finite(timestamp));
    this.lastAudioSnapshot = audioSnapshot;
    const novelty = this.noveltyTracker.update(audioSnapshot, now);
    this.lastNovelty = novelty;
    const candidate = this.candidateExtractor.process(audioSnapshot);
    let automaticTempo = this.tempoEstimator.update(novelty, now, {
      signalState: audioSnapshot.signalState,
      candidate,
      audioSnapshot,
    });
    const tap = this.tapController.getSnapshot();
    if (this.mode === 'tap-assist' && tap.ready) {
      this.tempoEstimator.setPrior(tap.bpm, tap.confidence);
      automaticTempo = this.tempoEstimator.getSnapshot(now);
    } else if (this.mode === 'auto') {
      this.tempoEstimator.setPrior(0, 0);
    }
    const tempo = this._selectedTempo(automaticTempo, tap, now);
    const beat = this.phaseTracker.update({
      timestamp: now,
      tempo,
      candidate,
      signalState: ['hold', 'lost'].includes(tempo.state) ? audioSnapshot.signalState : 'signal',
    });
    this.lastSnapshot = createBeatClockSnapshot({
      timestamp: now,
      mode: this.mode,
      candidateAnalysis: this.candidateExtractor.lastAnalysis,
      novelty,
      tempo,
      beat,
      tap,
    });
    return this.lastSnapshot;
  }

  setMode(mode) {
    if (!['auto', 'tap-assist', 'manual'].includes(mode)) throw new Error(`Unknown rhythm mode: ${mode}`);
    this.mode = mode;
    return this.mode;
  }

  setManualBpm(bpm) {
    this.manualBpm = Math.max(this.config.minBpm, Math.min(this.config.maxBpm, finite(bpm, 120)));
    return this.manualBpm;
  }

  tap(timestamp = 0) {
    const tap = this.tapController.tap(timestamp);
    if (tap.ready) this.tempoEstimator.setPrior(tap.bpm, tap.confidence);
    return tap;
  }

  beatNow(timestamp = 0) {
    const now = Math.max(0, finite(timestamp));
    const tap = this.tapController.getSnapshot();
    const automatic = this.tempoEstimator.getSnapshot(now);
    const tempo = this._selectedTempo(automatic, tap, now);
    const beat = this.phaseTracker.update({
      timestamp: now,
      tempo: {
        ...tempo,
        bpm: tempo.bpm || this.manualBpm,
        confidence: Math.max(tempo.confidence, 0.75),
      },
      signalState: this.lastAudioSnapshot?.signalState || 'signal',
      forceBeat: true,
    });
    this.lastSnapshot = createBeatClockSnapshot({
      timestamp: now,
      mode: this.mode,
      candidateAnalysis: this.candidateExtractor.lastAnalysis,
      novelty: this.lastNovelty || {},
      tempo,
      beat,
      tap,
    });
    return this.lastSnapshot;
  }

  reset(timestamp = 0, reason = 'manual-reset') {
    this.candidateExtractor.reset();
    this.noveltyTracker.reset();
    this.lastNovelty = null;
    this.tempoEstimator.reset(timestamp, reason);
    this.phaseTracker.reset(timestamp, reason);
    this.tapController.reset();
    this.lastSnapshot = createBeatClockSnapshot({ timestamp, mode: this.mode });
    return this.lastSnapshot;
  }

  _selectedTempo(automatic, tap, timestamp) {
    if (this.mode === 'manual') {
      return Object.freeze({
        ...automatic,
        state: 'locked',
        bpm: this.manualBpm,
        confidence: 1,
        stability: 1,
        lockAgeMs: automatic.lastTempoChangeAt ? Math.max(0, timestamp - automatic.lastTempoChangeAt) : 0,
        reason: 'manual-bpm-lock',
      });
    }
    if (this.mode === 'tap-assist' && tap.ready
      && (!automatic.bpm || ['searching', 'lost'].includes(automatic.state))) {
      return Object.freeze({
        ...automatic,
        state: 'tentative',
        bpm: tap.bpm,
        confidence: tap.confidence * 0.85,
        stability: tap.confidence,
        reason: 'tap-assist-prior',
      });
    }
    return automatic;
  }
}
