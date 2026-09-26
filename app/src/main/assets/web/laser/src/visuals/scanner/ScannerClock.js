import { SCANNER_SNAPSHOT_SCHEMA_VERSION } from '../../shared/Version.js';

const DEFAULT_SEED = 0x4c415345;

function defaultEpochNowMs() {
  if (typeof performance !== 'undefined') return performance.timeOrigin + performance.now();
  return Date.now();
}

function normalizeSeed(seed) {
  const numeric = Number(seed);
  return Number.isFinite(numeric) ? (numeric >>> 0) : DEFAULT_SEED;
}

/** Shared monotonic show clock with bounded slew and cycle-boundary hard resync. */
export class ScannerClock {
  constructor({ nowMs = defaultEpochNowMs, originMs, seed, maxSlewMsPerSecond = 2 } = {}) {
    this._nowMs = nowMs;
    const initialNow = Number(this._nowMs());
    this._originMs = Number.isFinite(originMs) ? Number(originMs) : initialNow;
    this._seed = normalizeSeed(seed ?? Math.floor(initialNow));
    this._sequence = 0;
    this._probeSequence = 0;
    this._lastTime = 0;
    this._correctionMs = 0;
    this._targetCorrectionMs = 0;
    this._pendingHardCorrectionMs = null;
    this._maxSlewMsPerSecond = Math.max(0.1, Number(maxSlewMsPerSecond) || 2);
    this._lastCorrectionEpochMs = initialNow;
  }

  sync(snapshot) {
    if (!snapshot || !Number.isFinite(Number(snapshot.originMs))) return false;
    if (Number(snapshot.schemaVersion) !== SCANNER_SNAPSHOT_SCHEMA_VERSION) return false;
    const sequence = Math.max(0, Math.floor(Number(snapshot.sequence) || 0));
    if (sequence < this._sequence) return false;
    this._originMs = Number(snapshot.originMs);
    this._seed = normalizeSeed(snapshot.seed);
    this._sequence = sequence;
    return true;
  }

  snapshot() {
    this._sequence++;
    return {
      schemaVersion: SCANNER_SNAPSHOT_SCHEMA_VERSION,
      originMs: this._originMs,
      seed: this._seed,
      sequence: this._sequence,
    };
  }

  now() {
    const epochMs = Number(this._nowMs());
    this._advanceCorrection(epochMs);
    const candidate = this.timeAt(epochMs);
    this._lastTime = Math.max(this._lastTime, candidate);
    return this._lastTime;
  }

  timeAt(epochMs) {
    if (!Number.isFinite(epochMs)) return this._lastTime;
    return Math.max(0, (epochMs - this._originMs + this._correctionMs) / 1000);
  }

  sample() {
    const sampledAtMs = Number(this._nowMs());
    this._advanceCorrection(sampledAtMs);
    this._probeSequence++;
    return {
      schemaVersion: SCANNER_SNAPSHOT_SCHEMA_VERSION,
      showTime: this.timeAt(sampledAtMs),
      sampledAtMs,
      seed: this._seed,
      sequence: this._sequence,
      probeSequence: this._probeSequence,
    };
  }

  deviationFrom(report) {
    if (!report || !Number.isFinite(Number(report.sampledAtMs)) ||
        !Number.isFinite(Number(report.showTime))) return null;
    const expected = this.timeAt(Number(report.sampledAtMs));
    return (Number(report.showTime) - expected) * 1000;
  }

  requestSmoothCorrection(deltaMs) {
    if (!Number.isFinite(deltaMs)) return false;
    this._targetCorrectionMs = this._correctionMs + Number(deltaMs);
    return true;
  }

  requestHardCorrection(deltaMs) {
    if (!Number.isFinite(deltaMs)) return false;
    this._pendingHardCorrectionMs = Number(deltaMs);
    return true;
  }

  commitCycleBoundary() {
    if (!Number.isFinite(this._pendingHardCorrectionMs)) return false;
    this._correctionMs += this._pendingHardCorrectionMs;
    this._targetCorrectionMs = this._correctionMs;
    this._pendingHardCorrectionMs = null;
    return true;
  }

  getCorrectionState() {
    return {
      correctionMs: this._correctionMs,
      targetCorrectionMs: this._targetCorrectionMs,
      pendingHardCorrectionMs: this._pendingHardCorrectionMs,
    };
  }

  get seed() { return this._seed; }

  _advanceCorrection(epochMs) {
    if (!Number.isFinite(epochMs)) return;
    const elapsedSeconds = Math.max(0, (epochMs - this._lastCorrectionEpochMs) / 1000);
    this._lastCorrectionEpochMs = Math.max(this._lastCorrectionEpochMs, epochMs);
    const difference = this._targetCorrectionMs - this._correctionMs;
    const step = this._maxSlewMsPerSecond * elapsedSeconds;
    this._correctionMs += Math.sign(difference) * Math.min(Math.abs(difference), step);
  }
}
