export const PLAYER_RENDER_MODES = Object.freeze({
  NATIVE: 'native',
  HD_1080: '1080p',
  UHD_2160: '2160p',
});

export function resolvePlayerCanvasSize(mode, {
  cssWidth = 1, cssHeight = 1, devicePixelRatio = 1,
} = {}) {
  const normalized = Object.values(PLAYER_RENDER_MODES).includes(mode)
    ? mode
    : PLAYER_RENDER_MODES.NATIVE;
  if (normalized === PLAYER_RENDER_MODES.HD_1080) return { width: 1920, height: 1080, mode: normalized };
  if (normalized === PLAYER_RENDER_MODES.UHD_2160) return { width: 3840, height: 2160, mode: normalized };
  const dpr = Math.max(0.25, Number(devicePixelRatio) || 1);
  return {
    width: Math.max(1, Math.round((Number(cssWidth) || 1) * dpr)),
    height: Math.max(1, Math.round((Number(cssHeight) || 1) * dpr)),
    mode: normalized,
  };
}

export function createPlayerPerformanceResult({ diagnostics = {}, canvas = {}, css = {},
  devicePixelRatio = 1, durationSeconds = 0, renderMode = 'native', versions = {} } = {}) {
  const summary = diagnostics.loadTest?.summary || null;
  const catchUp = diagnostics.catchUpCumulative || null;
  const finalBudgetEvents = Number(diagnostics.finalOverBudgetEvents ?? summary?.finalOverBudgetEvents);
  const motionViolations = Number(diagnostics.postBoundaryViolations ?? summary?.motionBoundaryViolations);
  const duplicateVisits = Number(diagnostics.duplicatePointVisits);
  const acceptance = {
    foregroundValid: summary?.resultValidity === 'valid-foreground',
    duplicatePointVisitsZero: Number.isFinite(duplicateVisits) ? duplicateVisits === 0 : null,
    motionBoundaryViolationsZero: Number.isFinite(motionViolations) ? motionViolations === 0 : null,
    finalBudgetOverrunsZero: Number.isFinite(finalBudgetEvents) ? finalBudgetEvents === 0 : null,
    catchUpScannerTimeWithin50Ms: catchUp
      ? Number(catchUp.maxProcessedScannerTimePerFrame) <= 0.050001
      : null,
    catchUpPointsWithin1500: catchUp
      ? Number(catchUp.maxProcessedPointsPerFrame) <= 1500
      : null,
    droppedShowEventsZero: catchUp ? Number(catchUp.droppedShowEvents) === 0 : null,
    negativeUnaccountedFramesZero: summary
      ? Number(summary.negativeUnaccountedFrames) === 0
      : null,
  };
  return {
    schemaVersion: 1,
    source: 'native-player-performance',
    versions: { ...versions },
    createdAt: new Date().toISOString(),
    durationSeconds: Number(durationSeconds) || summary?.durationSeconds || 0,
    renderMode,
    resolution: {
      canvasWidth: Number(canvas.width) || 0,
      canvasHeight: Number(canvas.height) || 0,
      cssWidth: Number(css.width) || 0,
      cssHeight: Number(css.height) || 0,
      devicePixelRatio: Number(devicePixelRatio) || 1,
    },
    visibility: diagnostics.environment || null,
    resultValidity: summary?.resultValidity || diagnostics.loadTest?.resultValidity || 'environment-limited',
    performance: summary,
    scanner: {
      scanRate: diagnostics.scanRate ?? null,
      cycleScanRate: diagnostics.cycleScanRate ?? null,
      playbackPointRate: diagnostics.playbackPointRate ?? null,
      duplicatePointVisits: diagnostics.duplicatePointVisits ?? null,
      motionBoundaryViolations: diagnostics.postBoundaryViolations ?? null,
      budget: diagnostics.budgetCurrent ?? null,
      catchUp,
    },
    quality: diagnostics.adaptiveQualityState || null,
    acceptance,
    accepted: Object.values(acceptance).every((value) => value === true),
  };
}
