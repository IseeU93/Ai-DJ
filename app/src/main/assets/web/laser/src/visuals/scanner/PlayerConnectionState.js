const validInstanceId = (value) => typeof value === 'string' && value.trim().length > 0;

export class PlayerConnectionState {
  constructor({ staleTimeoutMs = 1500, disconnectTimeoutMs = 4000 } = {}) {
    this.staleTimeoutMs = Math.max(250, Number(staleTimeoutMs) || 1500);
    this.disconnectTimeoutMs = Math.max(this.staleTimeoutMs + 250, Number(disconnectTimeoutMs) || 4000);
    this.reset();
  }

  reset() {
    this._state = 'disconnected';
    this._reason = 'initial';
    this._instanceId = null;
    this._lastHeartbeatAtMs = null;
    this._heartbeat = null;
    this._retiredInstanceIds = new Set();
    this._pendingProbes = new Map();
    this._probeSequence = 0;
    this._probeReports = 0;
    this._lostProbes = 0;
    this._clock = null;
  }

  markConnecting(nowMs = 0) {
    if (this._instanceId) this._retiredInstanceIds.add(this._instanceId);
    this._state = 'connecting';
    this._reason = 'window-opened';
    this._instanceId = null;
    this._lastHeartbeatAtMs = Number(nowMs) || 0;
    this._heartbeat = null;
    this._pendingProbes.clear();
    this._probeSequence = 0;
    this._probeReports = 0;
    this._lostProbes = 0;
    this._clock = null;
    return this.snapshot(nowMs);
  }

  receiveHeartbeat(payload = {}, nowMs = 0) {
    const instanceId = payload.instanceId;
    if (!validInstanceId(instanceId)) return { accepted: false, reason: 'invalid-instance', state: this.snapshot(nowMs) };
    if (this._retiredInstanceIds.has(instanceId)) {
      return { accepted: false, reason: 'retired-instance', state: this.snapshot(nowMs) };
    }
    if (this._instanceId && instanceId !== this._instanceId && !['stale', 'disconnected'].includes(this._state)) {
      return { accepted: false, reason: 'unexpected-instance', state: this.snapshot(nowMs) };
    }
    if (this._instanceId && instanceId !== this._instanceId) this._retiredInstanceIds.add(this._instanceId);
    if (instanceId !== this._instanceId) {
      this._pendingProbes.clear();
      this._probeSequence = 0;
      this._probeReports = 0;
      this._lostProbes = 0;
      this._clock = null;
    }
    this._instanceId = instanceId;
    this._lastHeartbeatAtMs = Math.max(0, Number(nowMs) || 0);
    this._heartbeat = { ...payload };
    this._state = 'ready';
    this._reason = 'heartbeat';
    return { accepted: true, reason: 'ready', state: this.snapshot(nowMs) };
  }

  close(instanceId, nowMs = 0) {
    if (this._instanceId && instanceId && instanceId !== this._instanceId) {
      return { accepted: false, reason: 'different-instance', state: this.snapshot(nowMs) };
    }
    if (this._instanceId) this._retiredInstanceIds.add(this._instanceId);
    this._state = 'disconnected';
    this._reason = 'closed';
    this._clock = null;
    this._pendingProbes.clear();
    return { accepted: true, reason: 'closed', state: this.snapshot(nowMs) };
  }

  tick(nowMs = 0) {
    const now = Math.max(0, Number(nowMs) || 0);
    this._expireProbes(now);
    if (!this._instanceId || this._lastHeartbeatAtMs === null) {
      if (this._state === 'connecting' && this._lastHeartbeatAtMs !== null &&
          now - this._lastHeartbeatAtMs >= this.disconnectTimeoutMs) {
        this._state = 'disconnected';
        this._reason = 'connect-timeout';
      }
      return this.snapshot(now);
    }
    const age = Math.max(0, now - this._lastHeartbeatAtMs);
    if (age >= this.disconnectTimeoutMs) {
      if (this._state !== 'disconnected') this._retiredInstanceIds.add(this._instanceId);
      this._state = 'disconnected';
      this._reason = 'timeout';
      this._clock = null;
    } else if (age >= this.staleTimeoutMs) {
      this._state = 'stale';
      this._reason = 'heartbeat-timeout';
      this._clock = null;
    }
    return this.snapshot(now);
  }

  createProbe(nowMs = 0) {
    if (this._state !== 'ready' || !this._instanceId) return null;
    const sequence = ++this._probeSequence;
    this._pendingProbes.set(sequence, Math.max(0, Number(nowMs) || 0));
    return { sequence, targetInstanceId: this._instanceId };
  }

  receiveProbeReport(report = {}, nowMs = 0) {
    if (this._state !== 'ready' || report.instanceId !== this._instanceId) {
      return { accepted: false, reason: 'inactive-instance', state: this.snapshot(nowMs) };
    }
    const sequence = Number(report.probeSequence);
    if (!this._pendingProbes.has(sequence)) {
      return { accepted: false, reason: 'unknown-probe', state: this.snapshot(nowMs) };
    }
    this._pendingProbes.delete(sequence);
    this._probeReports++;
    this._clock = { ...report };
    return { accepted: true, reason: 'clock-updated', state: this.snapshot(nowMs) };
  }

  snapshot(nowMs = 0) {
    const now = Math.max(0, Number(nowMs) || 0);
    const heartbeatAgeMs = this._lastHeartbeatAtMs === null
      ? null
      : Math.max(0, now - this._lastHeartbeatAtMs);
    const ready = this._state === 'ready';
    return {
      state: this._state,
      reason: this._reason,
      ready,
      instanceId: this._instanceId,
      lastHeartbeatAtMs: this._lastHeartbeatAtMs,
      heartbeatAgeMs,
      heartbeat: this._heartbeat ? { ...this._heartbeat } : null,
      clockAvailable: ready && Boolean(this._clock),
      clock: ready && this._clock ? { ...this._clock } : null,
      probesSent: this._probeSequence,
      probeReports: this._probeReports,
      pendingProbes: this._pendingProbes.size,
      lostProbes: this._lostProbes,
    };
  }

  _expireProbes(nowMs) {
    for (const [sequence, sentAtMs] of this._pendingProbes) {
      if (nowMs - sentAtMs >= this.staleTimeoutMs) {
        this._pendingProbes.delete(sequence);
        this._lostProbes++;
      }
    }
  }
}
