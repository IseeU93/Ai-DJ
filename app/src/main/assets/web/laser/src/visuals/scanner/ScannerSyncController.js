const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

export class ScannerSyncController {
  constructor({ windowSize = 120, smoothThresholdMs = 12, hardThresholdMs = 80 } = {}) {
    this._windowSize = Math.max(8, Math.floor(windowSize));
    this._smoothThresholdMs = smoothThresholdMs;
    this._hardThresholdMs = hardThresholdMs;
    this._lastProbeSequence = 0;
    this._deviations = [];
    this._lostClockProbes = 0;
    this._hardResyncs = 0;
  }

  createProbe(clock) {
    const sample = clock.sample();
    return { ...sample, probeSequence: sample.probeSequence ?? sample.sequence };
  }

  receiveProbe(probe, clock) {
    if (!probe || !Number.isFinite(probe.showTime) || !Number.isFinite(probe.sampledAtMs)) return false;
    const sequence = Math.max(0, Math.floor(Number(probe.probeSequence ?? probe.sequence) || 0));
    if (sequence <= this._lastProbeSequence) return false;
    if (this._lastProbeSequence > 0 && sequence > this._lastProbeSequence + 1) {
      this._lostClockProbes += sequence - this._lastProbeSequence - 1;
    }
    this._lastProbeSequence = sequence;
    const localAtProbe = clock.timeAt(probe.sampledAtMs);
    const deviationMs = (localAtProbe - probe.showTime) * 1000;
    this._record(deviationMs);
    if (Math.abs(deviationMs) >= this._hardThresholdMs) {
      clock.requestHardCorrection(-deviationMs);
    } else if (Math.abs(deviationMs) >= this._smoothThresholdMs) {
      clock.requestSmoothCorrection(-deviationMs);
    }
    return true;
  }

  commitCycleBoundary(clock) {
    if (clock.commitCycleBoundary()) {
      this._hardResyncs++;
      return true;
    }
    return false;
  }

  recordReportDeviation(deviationMs, probeSequence = null) {
    if (!Number.isFinite(deviationMs)) return;
    if (Number.isInteger(probeSequence) && this._lastProbeSequence > 0 &&
        probeSequence > this._lastProbeSequence + 1) {
      this._lostClockProbes += probeSequence - this._lastProbeSequence - 1;
    }
    if (Number.isInteger(probeSequence)) this._lastProbeSequence = Math.max(this._lastProbeSequence, probeSequence);
    this._record(deviationMs);
  }

  getDiagnostics() {
    const absolute = this._deviations.map(Math.abs);
    const current = this._deviations[this._deviations.length - 1] ?? 0;
    return {
      clockDeltaMs: current,
      clockAverageDeltaMs: this._deviations.length
        ? this._deviations.reduce((sum, value) => sum + value, 0) / this._deviations.length
        : 0,
      clockMaxDeltaMs: absolute.length ? Math.max(...absolute) : 0,
      clockP95DeltaMs: percentile(absolute, 0.95),
      lostClockProbes: this._lostClockProbes,
      hardResyncs: this._hardResyncs,
    };
  }

  _record(deviationMs) {
    this._deviations.push(clamp(Number(deviationMs), -60000, 60000));
    if (this._deviations.length > this._windowSize) this._deviations.shift();
  }
}
