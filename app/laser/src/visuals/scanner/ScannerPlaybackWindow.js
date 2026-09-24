const clampNonNegative = (value) => Number.isFinite(value) ? Math.max(0, value) : 0;

export function planScannerPlaybackWindow({
  previousScannerTime,
  scannerTime,
  scanRate,
  maxScannerTimePerFrame = 0.05,
  maxPointsPerFrame = 1500,
} = {}) {
  const toTime = clampNonNegative(Number(scannerTime));
  const rate = Math.max(1, Number(scanRate) || 30000);
  const byTime = Math.max(1 / rate, Number(maxScannerTimePerFrame) || 0.05);
  const byPoints = Math.max(1, Math.floor(Number(maxPointsPerFrame) || 1500)) / rate;
  const maximumWindow = Math.min(byTime, byPoints);
  const previous = Number(previousScannerTime);
  const requestedFrom = Number.isFinite(previous) && previous <= toTime
    ? Math.max(0, previous)
    : toTime;
  const requestedDuration = Math.max(0, toTime - requestedFrom);
  const processedDuration = Math.min(requestedDuration, maximumWindow);
  const fromTime = toTime - processedDuration;
  const droppedExposureDuration = Math.max(0, requestedDuration - processedDuration);

  return {
    requestedFrom,
    fromTime,
    toTime,
    requestedDuration,
    processedDuration,
    droppedExposureDuration,
    estimatedDroppedScannerPoints: Math.floor(droppedExposureDuration * rate),
    catchUpLimited: droppedExposureDuration > 0,
    maxScannerTimePerFrame: maximumWindow,
    maxPointsPerFrame: Math.floor(maximumWindow * rate),
  };
}
