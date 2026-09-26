import { planScannerPlaybackWindow } from './ScannerPlaybackWindow.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const EPSILON = 1e-9;
const nowMs = () => globalThis.performance?.now?.() ?? Date.now();

export function scannerPointColor(point = {}) {
  return {
    red: Math.round(clamp(Number(point.r) || 0, 0, 1) * 255),
    green: Math.round(clamp(Number(point.g) || 0, 0, 1) * 255),
    blue: Math.round(clamp(Number(point.b) || 0, 0, 1) * 255),
  };
}

export function exposureFadeAlpha(deltaTime, persistenceMs, trailScale = 1) {
  const dt = clamp(Number(deltaTime) || 0, 0, 0.1);
  const persistence = clamp((Number(persistenceMs) || 45) * clamp(trailScale, 0.25, 1), 8, 500);
  return 1 - Math.exp(-(dt * 1000) / persistence);
}

export function scannerPointEnergy(point = {}) {
  if (point.blanked) return 0;
  if (point.kind === 'cornerDwell') return 0.24;
  if (point.kind === 'endDwell') return 0.22;
  if (point.kind === 'postLightDelay') return 0.3;
  return 1;
}

export class ScannerTestRenderer {
  constructor() {
    this._exposureCanvas = null;
    this._exposureContext = null;
    this._lastScannerTime = null;
    this._lastPoint = null;
    this._currentVelocity = 0;
    this._lastResetToken = null;
    this._lastClearReason = 'initial';
    this._lastVisitedAbsoluteTime = null;
    this._duplicatePointVisits = 0;
    this.resetRuntimeDiagnostics();
  }

  clear(reason = 'explicit') {
    if (this._exposureContext && this._exposureCanvas) {
      this._exposureContext.globalCompositeOperation = 'source-over';
      this._exposureContext.globalAlpha = 1;
      this._exposureContext.fillStyle = '#000000';
      this._exposureContext.fillRect(
        0,
        0,
        this._exposureCanvas.width,
        this._exposureCanvas.height,
      );
    }
    this._lastScannerTime = null;
    this._lastPoint = null;
    this._currentVelocity = 0;
    this._lastClearReason = reason;
    this._lastVisitedAbsoluteTime = null;
    this._duplicatePointVisits = 0;
  }

  resetRuntimeDiagnostics() {
    this._droppedExposureScannerTime = 0;
    this._discardedExposureIntervals = 0;
    this._discardedScannerPoints = 0;
    this._droppedShowEvents = 0;
    this._maxProcessedScannerTimePerFrame = 0;
    this._maxProcessedPointsPerFrame = 0;
    this._catchUpLimitHits = 0;
    this._catchUpSamples = [];
  }

  render(ctx, width, height, stream, showTime, deltaTime, options = {}) {
    const resetToken = options.resetToken ?? 0;
    if (this._lastResetToken !== null && resetToken !== this._lastResetToken) {
      this.clear(options.resetReason || 'runtime-reset');
    }
    this._lastResetToken = resetToken;

    const exposureScale = clamp(Number(options.exposureScale) || 1, 0.4, 1);
    this._ensureBuffer(width, height, exposureScale);
    const exposure = this._exposureContext;
    const bufferWidth = this._exposureCanvas.width;
    const bufferHeight = this._exposureCanvas.height;
    const realDeltaTime = Math.max(0, Number(deltaTime) || 0);
    const scannerTime = Math.max(0, Number(showTime) || 0);
    const fadeAlpha = exposureFadeAlpha(realDeltaTime, options.persistenceMs, options.trailScale);

    const exposureStartedAt = nowMs();
    exposure.globalCompositeOperation = 'source-over';
    exposure.globalAlpha = 1;
    exposure.fillStyle = `rgba(0, 0, 0, ${fadeAlpha})`;
    exposure.fillRect(0, 0, bufferWidth, bufferHeight);

    const points = stream.points;
    const cycleDuration = stream.stats.cycleDuration;
    const cycleScanRate = Math.min(
      Number(stream.stats.scanRate) || 0,
      Number(stream.stats.effectiveScanRate) || 0,
    );
    const previousScannerTime = this._lastScannerTime === null || scannerTime < this._lastScannerTime
      ? Math.max(0, scannerTime - realDeltaTime)
      : this._lastScannerTime;
    const playbackWindow = planScannerPlaybackWindow({
      previousScannerTime,
      scannerTime,
      scanRate: cycleScanRate,
      maxScannerTimePerFrame: options.maxScannerTimePerFrame,
      maxPointsPerFrame: options.maxPointsPerFrame,
    });
    let playedPoints = 0;
    let repeatedCycles = 0;
    const pointStreamStartedAt = nowMs();
    if (points.length > 0 && cycleDuration > 0) {
      this._lastPoint = this._pointAt(points, cycleDuration, playbackWindow.fromTime);
      playedPoints = this._visitPointsBetween(
        points,
        cycleDuration,
        playbackWindow.fromTime,
        playbackWindow.toTime,
        playbackWindow.maxPointsPerFrame,
        (point, absoluteTime) => {
          if (this._lastVisitedAbsoluteTime !== null && absoluteTime <= this._lastVisitedAbsoluteTime + EPSILON) {
            this._duplicatePointVisits++;
            return;
          }
          this._drawPoint(exposure, bufferWidth, bufferHeight, point, options);
          this._lastPoint = point;
          this._lastVisitedAbsoluteTime = absoluteTime;
        },
      );
      repeatedCycles = playbackWindow.processedDuration / cycleDuration;
      const currentPoint = this._pointAt(points, cycleDuration, scannerTime);
      this._currentVelocity = currentPoint?.velocity || 0;
    } else {
      this._currentVelocity = 0;
    }
    if (playbackWindow.catchUpLimited) {
      this._droppedExposureScannerTime += playbackWindow.droppedExposureDuration;
      this._discardedExposureIntervals++;
      this._discardedScannerPoints += playbackWindow.estimatedDroppedScannerPoints;
      this._catchUpLimitHits++;
    }
    this._maxProcessedScannerTimePerFrame = Math.max(
      this._maxProcessedScannerTimePerFrame,
      playbackWindow.processedDuration,
    );
    this._maxProcessedPointsPerFrame = Math.max(this._maxProcessedPointsPerFrame, playedPoints);
    const catchUpCurrent = {
      requestedScannerTime: playbackWindow.requestedDuration,
      processedScannerTime: playbackWindow.processedDuration,
      droppedExposureScannerTime: playbackWindow.droppedExposureDuration,
      processedPoints: playedPoints,
      droppedScannerPoints: playbackWindow.estimatedDroppedScannerPoints,
      catchUpLimitHit: playbackWindow.catchUpLimited,
    };
    this._catchUpSamples.push(catchUpCurrent);
    if (this._catchUpSamples.length > 180) this._catchUpSamples.shift();
    const catchUpWindow = this._summarizeCatchUpWindow();
    const pointStreamMs = nowMs() - pointStreamStartedAt;
    this._lastScannerTime = scannerTime;

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this._exposureCanvas, 0, 0, width, height);
    const exposureMs = nowMs() - exposureStartedAt;
    const playbackScannerTime = cycleScanRate > 0 ? playedPoints / cycleScanRate : 0;
    return {
      currentVelocity: this._currentVelocity,
      playedPoints,
      cycleScanRate,
      playbackScannerTime,
      playbackPointRate: playedPoints > 0 ? cycleScanRate : 0,
      renderVisitRate: realDeltaTime > 0 ? playedPoints / realDeltaTime : 0,
      repeatedCycles,
      repeatedCycleRate: cycleDuration > 0 ? 1 / cycleDuration : 0,
      effectivePlayedScanRate: playedPoints > 0 ? cycleScanRate : 0,
      duplicatePointVisits: this._duplicatePointVisits,
      catchUpLimited: playbackWindow.catchUpLimited,
      requestedPlaybackScannerTime: playbackWindow.requestedDuration,
      processedPlaybackScannerTime: playbackWindow.processedDuration,
      droppedExposureScannerTime: this._droppedExposureScannerTime,
      droppedExposureIntervals: this._discardedExposureIntervals,
      droppedScannerPoints: this._discardedScannerPoints,
      droppedShowEvents: this._droppedShowEvents,
      maxProcessedScannerTimePerFrame: this._maxProcessedScannerTimePerFrame,
      maxProcessedPointsPerFrame: this._maxProcessedPointsPerFrame,
      catchUpLimitHits: this._catchUpLimitHits,
      catchUpCurrent,
      catchUpWindow,
      catchUpCumulative: {
        droppedExposureScannerTime: this._droppedExposureScannerTime,
        droppedExposureIntervals: this._discardedExposureIntervals,
        droppedScannerPoints: this._discardedScannerPoints,
        droppedShowEvents: this._droppedShowEvents,
        maxProcessedScannerTimePerFrame: this._maxProcessedScannerTimePerFrame,
        maxProcessedPointsPerFrame: this._maxProcessedPointsPerFrame,
        catchUpLimitHits: this._catchUpLimitHits,
      },
      maxPlaybackPointsPerFrame: playbackWindow.maxPointsPerFrame,
      pointStreamMs,
      exposureMs,
      exposureScale,
      trailExposureLevel: options.trailScale ?? 1,
      lastClearReason: this._lastClearReason,
    };
  }

  _ensureBuffer(width, height, scale) {
    if (!this._exposureCanvas) {
      this._exposureCanvas = document.createElement('canvas');
      this._exposureContext = this._exposureCanvas.getContext('2d');
    }
    const bufferWidth = Math.max(1, Math.round(width * scale));
    const bufferHeight = Math.max(1, Math.round(height * scale));
    if (this._exposureCanvas.width !== bufferWidth || this._exposureCanvas.height !== bufferHeight) {
      this._exposureCanvas.width = bufferWidth;
      this._exposureCanvas.height = bufferHeight;
      this.clear('exposure-size');
    }
  }

  _summarizeCatchUpWindow() {
    const samples = this._catchUpSamples;
    return {
      sampleCount: samples.length,
      droppedExposureScannerTime: samples.reduce(
        (sum, sample) => sum + sample.droppedExposureScannerTime,
        0,
      ),
      droppedExposureIntervals: samples.filter((sample) => sample.catchUpLimitHit).length,
      droppedScannerPoints: samples.reduce((sum, sample) => sum + sample.droppedScannerPoints, 0),
      droppedShowEvents: 0,
      maxProcessedScannerTimePerFrame: samples.length
        ? Math.max(...samples.map((sample) => sample.processedScannerTime))
        : 0,
      maxProcessedPointsPerFrame: samples.length
        ? Math.max(...samples.map((sample) => sample.processedPoints))
        : 0,
      catchUpLimitHits: samples.filter((sample) => sample.catchUpLimitHit).length,
    };
  }

  _visitPointsBetween(points, cycleDuration, fromTime, toTime, limit, visitor) {
    if (toTime <= fromTime + EPSILON) return 0;
    let visited = 0;
    let cycleIndex = Math.floor(fromTime / cycleDuration);
    let localTime = fromTime - cycleIndex * cycleDuration;
    let pointIndex = this._upperBound(points, localTime);
    if (pointIndex >= points.length) {
      cycleIndex++;
      pointIndex = 0;
    }

    while (visited < limit) {
      const absoluteTime = cycleIndex * cycleDuration + points[pointIndex].timestamp;
      if (absoluteTime > toTime + EPSILON) break;
      if (absoluteTime > fromTime + EPSILON) {
        visitor(points[pointIndex], absoluteTime);
        visited++;
      }
      pointIndex++;
      if (pointIndex >= points.length) {
        cycleIndex++;
        pointIndex = 0;
      }
    }
    return visited;
  }

  _pointAt(points, cycleDuration, time) {
    if (points.length === 0 || cycleDuration <= 0) return null;
    const localTime = ((time % cycleDuration) + cycleDuration) % cycleDuration;
    const index = this._upperBound(points, localTime) - 1;
    return index >= 0 ? points[index] : points[points.length - 1];
  }

  _upperBound(points, time) {
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (points[middle].timestamp <= time + EPSILON) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  _drawPoint(ctx, width, height, point, options) {
    const energy = scannerPointEnergy(point);
    if (energy <= 0) return;
    const scale = Math.min(width, height) * 0.46;
    const x = width / 2 + point.x * scale;
    const y = height / 2 + point.y * scale;
    const { red, green, blue } = scannerPointColor(point);
    const intensity = clamp(point.intensity, 0, 1) * energy;
    const canConnect = this._lastPoint && !this._lastPoint.blanked &&
      this._lastPoint.pathId === point.pathId;
    const previousX = canConnect ? width / 2 + this._lastPoint.x * scale : x;
    const previousY = canConnect ? height / 2 + this._lastPoint.y * scale : y;
    const haloWidth = clamp(Number(options.haloWidth) || 1.8, 0.8, 5);
    const beamWidth = clamp(Number(options.beamWidth) || 0.75, 0.4, 2);

    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(previousX, previousY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${clamp(intensity * 0.08, 0, 0.16)})`;
    ctx.lineWidth = haloWidth;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(previousX, previousY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${clamp(intensity * 0.58, 0, 0.72)})`;
    ctx.lineWidth = beamWidth;
    ctx.stroke();
  }
}
