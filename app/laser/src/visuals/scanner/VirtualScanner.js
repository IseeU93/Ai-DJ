const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const EPSILON = 1e-9;

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function direction(from, to) {
  const length = distance(from, to);
  if (length < EPSILON) return { x: 0, y: 0, length: 0 };
  return {
    x: (to.x - from.x) / length,
    y: (to.y - from.y) / length,
    length,
  };
}

function parseHexColor(hex) {
  const value = String(hex || '#00ff41').replace('#', '');
  const normalized = value.length === 3
    ? value.split('').map((part) => part + part).join('')
    : value.padEnd(6, '0').slice(0, 6);
  return {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255,
  };
}

function directionChange(previous, current, next) {
  const incoming = direction(previous, current);
  const outgoing = direction(current, next);
  if (incoming.length < EPSILON || outgoing.length < EPSILON) return 0;
  const dot = clamp(incoming.x * outgoing.x + incoming.y * outgoing.y, -1, 1);
  return Math.acos(dot);
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const ratio = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return ratio * ratio * (3 - 2 * ratio);
}

function trapezoidProfile(length, startSpeed, endSpeed, maxSpeed, acceleration) {
  const accelDistance = Math.max(0, (maxSpeed ** 2 - startSpeed ** 2) / (2 * acceleration));
  const decelDistance = Math.max(0, (maxSpeed ** 2 - endSpeed ** 2) / (2 * acceleration));
  let peakSpeed = maxSpeed;

  if (accelDistance + decelDistance > length) {
    peakSpeed = Math.sqrt(Math.max(
      0,
      acceleration * length + (startSpeed ** 2 + endSpeed ** 2) / 2,
    ));
  }

  peakSpeed = clamp(peakSpeed, Math.max(startSpeed, endSpeed), maxSpeed);
  const accelTime = Math.max(0, (peakSpeed - startSpeed) / acceleration);
  const decelTime = Math.max(0, (peakSpeed - endSpeed) / acceleration);
  const actualAccelDistance = (startSpeed + peakSpeed) * accelTime / 2;
  const actualDecelDistance = (endSpeed + peakSpeed) * decelTime / 2;
  const cruiseDistance = Math.max(0, length - actualAccelDistance - actualDecelDistance);
  const cruiseTime = peakSpeed > EPSILON ? cruiseDistance / peakSpeed : 0;

  return {
    startSpeed,
    endSpeed,
    peakSpeed,
    acceleration,
    accelTime,
    cruiseTime,
    decelTime,
    accelDistance: actualAccelDistance,
    cruiseDistance,
    totalTime: accelTime + cruiseTime + decelTime,
  };
}

function sampleProfile(profile, time) {
  const t = clamp(time, 0, profile.totalTime);
  if (t <= profile.accelTime) {
    return {
      distance: profile.startSpeed * t + 0.5 * profile.acceleration * t ** 2,
      speed: profile.startSpeed + profile.acceleration * t,
      limited: profile.startSpeed < profile.peakSpeed - EPSILON,
    };
  }

  const cruiseEnd = profile.accelTime + profile.cruiseTime;
  if (t <= cruiseEnd) {
    const cruiseElapsed = t - profile.accelTime;
    return {
      distance: profile.accelDistance + profile.peakSpeed * cruiseElapsed,
      speed: profile.peakSpeed,
      limited: false,
    };
  }

  const decelElapsed = t - cruiseEnd;
  return {
    distance: profile.accelDistance + profile.cruiseDistance +
      profile.peakSpeed * decelElapsed - 0.5 * profile.acceleration * decelElapsed ** 2,
    speed: Math.max(profile.endSpeed, profile.peakSpeed - profile.acceleration * decelElapsed),
    limited: profile.endSpeed < profile.peakSpeed - EPSILON,
  };
}

export class VirtualScanner {
  constructor() {
    this._budgetTotals = {
      prePlanOverBudgetEvents: 0, replanAttempts: 0, successfulReplans: 0,
      failedReplans: 0, finalOverBudgetEvents: 0,
    };
  }

  scan(paths, options = {}) {
    const settings = this._normalizeOptions(options);
    const normalizedPaths = Array.isArray(paths)
      ? paths.filter((path) => Array.isArray(path.points) && path.points.length > 0)
      : [];
    const requestedGeometryPoints = normalizedPaths.reduce((sum, path) => sum + path.points.length, 0);
    const initialBuild = this._buildStream(normalizedPaths, settings);
    const requestedPoints = initialBuild.points.length;
    const context = {
      effect: options.effect || null,
      showTime: Math.max(0, Number(options.showTime) || 0),
      cycleId: options.cycleId ?? null,
      replanReason: options.replanReason || 'geometry-change',
      adaptiveQuality: options.adaptiveQuality || 'full',
    };
    const preValidation = this._validateStream(initialBuild.points, initialBuild.cycleDuration, settings, context);
    let plannedPaths = normalizedPaths;
    let build = initialBuild;
    let qualityLevel = 0;
    let replannedPaths = 0;

    while (build.points.length > settings.pointBudget && qualityLevel < 24) {
      qualityLevel++;
      plannedPaths = this._planGeometry(normalizedPaths, qualityLevel);
      build = this._buildStream(plannedPaths, settings);
      replannedPaths++;
    }

    const prePlanOverBudget = requestedPoints > settings.pointBudget;
    const finalOverBudget = build.points.length > settings.pointBudget;
    const budgetSatisfied = !finalOverBudget;
    const successfulReplan = prePlanOverBudget && replannedPaths > 0 && budgetSatisfied;
    const failedReplan = prePlanOverBudget && replannedPaths > 0 && finalOverBudget;
    const budgetCurrent = {
      requestedPointCount: requestedPoints,
      configuredBudget: settings.pointBudget,
      prePlanOverBudgetEvents: prePlanOverBudget ? 1 : 0,
      replanAttempts: replannedPaths,
      successfulReplans: successfulReplan ? 1 : 0,
      failedReplans: failedReplan ? 1 : 0,
      finalOverBudgetEvents: finalOverBudget ? 1 : 0,
      finalPointCount: build.points.length,
    };
    this._budgetTotals.prePlanOverBudgetEvents += budgetCurrent.prePlanOverBudgetEvents;
    this._budgetTotals.replanAttempts += budgetCurrent.replanAttempts;
    this._budgetTotals.successfulReplans += budgetCurrent.successfulReplans;
    this._budgetTotals.failedReplans += budgetCurrent.failedReplans;
    this._budgetTotals.finalOverBudgetEvents += budgetCurrent.finalOverBudgetEvents;
    const points = build.points;
    this._recalculatePointIntervals(points, build.cycleDuration);
    const counts = this._countKinds(points);
    const visiblePoints = points.reduce((sum, point) => sum + (point.blanked ? 0 : 1), 0);
    const motion = this._measureMotion(points, build.cycleDuration);
    const postValidation = this._validateStream(points, build.cycleDuration, settings, context);
    const finalGeometryPoints = plannedPaths.reduce((sum, path) => sum + path.points.length, 0);

    return {
      points,
      stats: {
        scanRate: settings.scanRate,
        effectiveScanRate: build.cycleDuration > 0 ? points.length / build.cycleDuration : 0,
        pointBudget: settings.pointBudget,
        finalBudget: settings.pointBudget,
        requestedPoints,
        pointsPerCycle: points.length,
        visiblePoints,
        blankedPoints: points.length - visiblePoints,
        transferPoints: counts.transfer,
        cornerDwellPoints: counts.cornerDwell,
        endDwellPoints: counts.endDwell,
        preLightDelayPoints: counts.preLightDelay,
        postLightDelayPoints: counts.postLightDelay,
        blankOffPoints: counts.preLightDelay,
        blankOnPoints: counts.postLightDelay,
        maxVelocity: settings.maxVelocity,
        actualMaxVelocity: motion.maxVelocity,
        maxAcceleration: settings.maxAcceleration,
        maxObservedAcceleration: motion.maxAcceleration,
        accelerationLimitedPoints: build.accelerationLimitedPoints,
        cycleDuration: build.cycleDuration,
        estimatedRepeatRate: build.cycleDuration > 0 ? 1 / build.cycleDuration : 0,
        effectiveRepeatRate: build.cycleDuration > 0 ? 1 / build.cycleDuration : 0,
        requestedPointSpacing: settings.geometryTolerance,
        effectivePointSpacing: settings.geometryTolerance * (2 ** qualityLevel),
        requestedGeometryPoints,
        finalGeometryPoints,
        removedGeometryPoints: requestedGeometryPoints - finalGeometryPoints,
        removedMotionPoints: Math.max(0, requestedPoints - points.length),
        replannedPaths,
        qualityLevel,
        geometryScale: qualityLevel < 8 ? 1 : 0.7 ** (qualityLevel - 7),
        qualityLabel: qualityLevel === 0 ? 'full' : `replanned-${qualityLevel}`,
        preBoundaryViolations: preValidation.total,
        postBoundaryViolations: postValidation.total,
        boundaryViolations: postValidation,
        violationDetails: postValidation.details,
        duplicateTimestamps: postValidation.duplicateTimestamps,
        intervalSumError: postValidation.intervalSumError,
        cycleId: context.cycleId,
        replanReason: context.replanReason,
        adaptiveQuality: context.adaptiveQuality,
        prePlanBudgetPressure: prePlanOverBudget,
        finalBudgetExceeded: finalOverBudget,
        budgetExceeded: finalOverBudget,
        budgetSatisfied,
        budgetCurrent,
        budgetCumulative: { ...this._budgetTotals },
        requestedPointCount: requestedPoints,
        configuredBudget: settings.pointBudget,
        prePlanOverBudgetEvents: this._budgetTotals.prePlanOverBudgetEvents,
        replanAttempts: this._budgetTotals.replanAttempts,
        successfulReplans: this._budgetTotals.successfulReplans,
        failedReplans: this._budgetTotals.failedReplans,
        finalOverBudgetEvents: this._budgetTotals.finalOverBudgetEvents,
        finalPointCount: points.length,
        budgetOverruns: this._budgetTotals.finalOverBudgetEvents,
      },
    };
  }

  _normalizeOptions(options) {
    const maxAcceleration = clamp(
      Number(options.maxAcceleration) || 6000000,
      10,
      10000000,
    );
    return {
      scanRate: clamp(Number(options.scanRate) || 30000, 1000, 100000),
      pointBudget: Math.max(16, Math.round(Number(options.pointBudget) || 1200)),
      geometryTolerance: clamp(Number(options.pointSpacing) || 0.015, 0.001, 0.25),
      maxVelocity: clamp(Number(options.maxVelocity) || 1500, 1, 5000),
      maxAcceleration,
      motionAcceleration: maxAcceleration * 0.70,
      maxCornerDwell: clamp(Math.round(Number(options.cornerDwell) || 0), 0, 24),
      endDwell: clamp(Math.round(Number(options.endDwell) || 0), 0, 32),
      preLightDelay: clamp(Number(options.preLightDelayMs ?? options.blankOffDelayMs) || 0, 0, 20) / 1000,
      postLightDelay: clamp(Number(options.postLightDelayMs ?? options.blankOnDelayMs) || 0, 0, 20) / 1000,
    };
  }

  _buildStream(paths, settings) {
    const state = {
      points: [],
      time: 0,
      pointPeriod: 1 / settings.scanRate,
      accelerationLimitedPoints: 0,
    };
    let scannerPosition = null;
    let firstPosition = null;

    paths.forEach((path, pathId) => {
      const source = path.points;
      const start = source[0];
      if (!firstPosition) firstPosition = start;
      this._appendTransfer(state, scannerPosition, start, settings);
      this._appendTimedHold(
        state,
        start,
        Math.round(settings.preLightDelay / state.pointPeriod),
        this._pointStyle(path, pathId, true, 'preLightDelay'),
      );

      const rgb = parseHexColor(path.color);
      const intensity = clamp(Number(path.intensity) || 0, 0, 1);
      const vertices = path.closed ? [...source, source[0]] : [...source];
      const cornerData = this._cornerData(vertices, settings);
      this._appendPoint(state, start, {
        ...rgb,
        intensity,
        blanked: false,
        pathId,
        kind: 'visible',
        velocity: 0,
        velocityX: 0,
        velocityY: 0,
      });

      for (let index = 0; index < vertices.length - 1; index++) {
        const from = vertices[index];
        const to = vertices[index + 1];
        const startSpeed = index === 0 ? 0 : cornerData[index - 1].speed;
        const endSpeed = index < cornerData.length ? cornerData[index].speed : 0;
        this._appendSegment(state, from, to, startSpeed, endSpeed, settings, {
          ...rgb,
          intensity,
          blanked: false,
          pathId,
          kind: 'visible',
        });

        const corner = cornerData[index];
        if (corner?.dwell > 0) {
          this._appendTimedHold(state, to, corner.dwell, {
            ...rgb,
            intensity,
            blanked: false,
            pathId,
            kind: 'cornerDwell',
          });
        }
      }

      const end = path.closed ? start : source[source.length - 1];
      this._appendTimedHold(state, end, settings.endDwell, {
        ...rgb,
        intensity,
        blanked: false,
        pathId,
        kind: 'endDwell',
      });
      this._appendTimedHold(
        state,
        end,
        Math.round(settings.postLightDelay / state.pointPeriod),
        {
          ...rgb,
          intensity,
          blanked: false,
          pathId,
          kind: 'postLightDelay',
        },
      );
      scannerPosition = end;
    });

    if (scannerPosition && firstPosition) {
      this._appendTransfer(state, scannerPosition, firstPosition, settings);
    }

    const cycleDuration = Math.max(state.pointPeriod, state.time);
    return {
      points: state.points,
      cycleDuration,
      accelerationLimitedPoints: state.accelerationLimitedPoints,
    };
  }

  _cornerData(vertices, settings) {
    const data = [];
    for (let index = 1; index < vertices.length - 1; index++) {
      const angle = directionChange(vertices[index - 1], vertices[index], vertices[index + 1]);
      const dwellScale = smoothstep(8 * Math.PI / 180, 145 * Math.PI / 180, angle);
      const dwell = Math.round(settings.maxCornerDwell * dwellScale);
      const directionDelta = 2 * Math.sin(angle / 2);
      const directionalLimit = directionDelta > EPSILON
        ? settings.maxAcceleration * 0.25 / settings.scanRate / directionDelta
        : settings.maxVelocity;
      const angleLimit = settings.maxVelocity * Math.max(0.08, Math.cos(angle / 2) ** 2);
      data.push({
        angle,
        dwell,
        speed: dwell > 0 ? 0 : Math.min(settings.maxVelocity, directionalLimit, angleLimit),
      });
    }
    const speeds = [0, ...data.map((corner) => corner.speed), 0];
    for (let index = 1; index < speeds.length; index++) {
      const segmentLength = distance(vertices[index - 1], vertices[index]);
      const reachable = Math.sqrt(speeds[index - 1] ** 2 +
        2 * settings.motionAcceleration * segmentLength);
      speeds[index] = Math.min(speeds[index], reachable);
    }
    for (let index = speeds.length - 2; index >= 0; index--) {
      const segmentLength = distance(vertices[index], vertices[index + 1]);
      const reachable = Math.sqrt(speeds[index + 1] ** 2 +
        2 * settings.motionAcceleration * segmentLength);
      speeds[index] = Math.min(speeds[index], reachable);
    }
    data.forEach((corner, index) => { corner.speed = speeds[index + 1]; });
    return data;
  }

  _appendTransfer(state, from, to, settings) {
    const style = this._pointStyle(null, null, true, 'transfer');
    if (!from) {
      this._appendPoint(state, to, style);
      return;
    }
    this._appendSegment(state, from, to, 0, 0, settings, style);
  }

  _appendSegment(state, from, to, startSpeed, endSpeed, settings, style) {
    const vector = direction(from, to);
    if (vector.length < EPSILON) return;
    const profile = trapezoidProfile(
      vector.length,
      clamp(startSpeed, 0, settings.maxVelocity),
      clamp(endSpeed, 0, settings.maxVelocity),
      settings.maxVelocity,
      settings.motionAcceleration,
    );
    if (profile.totalTime < EPSILON) return;

    const sampleCount = Math.max(1, Math.ceil(profile.totalTime / state.pointPeriod));
    for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex++) {
      const sampleTime = Math.min(profile.totalTime, sampleIndex * state.pointPeriod);
      const sample = sampleProfile(profile, sampleTime);
      const ratio = clamp(sample.distance / vector.length, 0, 1);
      const atEnd = sampleIndex === sampleCount;
      this._appendPoint(state, atEnd ? to : {
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
      }, {
        ...style,
        velocity: atEnd ? endSpeed : sample.speed,
        velocityX: vector.x * (atEnd ? endSpeed : sample.speed),
        velocityY: vector.y * (atEnd ? endSpeed : sample.speed),
      });
      if (sample.limited) state.accelerationLimitedPoints++;
    }
  }

  _appendTimedHold(state, point, count, style) {
    for (let index = 0; index < count; index++) {
      this._appendPoint(state, point, {
        ...style,
        velocity: 0,
        velocityX: 0,
        velocityY: 0,
      });
    }
  }

  _appendPoint(state, point, style) {
    if (!point) return;
    // deltaTime is scanner time consumed since the preceding emitted point.
    // Every emitted point consumes exactly one configured scanner interval.
    const deltaTime = state.pointPeriod;
    state.time += deltaTime;
    state.points.push({
      x: point.x,
      y: point.y,
      r: style.r ?? 0,
      g: style.g ?? 0,
      b: style.b ?? 0,
      intensity: style.intensity ?? 0,
      blanked: Boolean(style.blanked),
      pathId: style.pathId ?? null,
      kind: style.kind || 'visible',
      velocity: style.velocity ?? 0,
      velocityX: style.velocityX ?? 0,
      velocityY: style.velocityY ?? 0,
      timestamp: state.time,
      deltaTime,
    });
  }

  _pointStyle(path, pathId, blanked, kind) {
    const rgb = parseHexColor(path?.color);
    return {
      ...rgb,
      intensity: blanked ? 0 : clamp(Number(path?.intensity) || 0, 0, 1),
      blanked,
      pathId,
      kind,
      velocity: 0,
      velocityX: 0,
      velocityY: 0,
    };
  }

  _planGeometry(paths, qualityLevel) {
    const stride = 2 ** Math.min(qualityLevel, 7);
    const pathDivisor = qualityLevel < 4 ? 1 : 2 ** (qualityLevel - 3);
    const pathCount = Math.max(1, Math.ceil(paths.length / pathDivisor));
    const geometryScale = qualityLevel < 8 ? 1 : 0.7 ** (qualityLevel - 7);
    const scalePoint = (point) => ({ x: point.x * geometryScale, y: point.y * geometryScale });
    return paths.slice(0, pathCount).map((path) => {
      const minimum = path.closed ? 4 : Math.min(2, path.points.length);
      const target = Math.max(minimum, Math.ceil(path.points.length / stride));
      if (target >= path.points.length) return { ...path, points: path.points.map(scalePoint) };
      const points = [];
      for (let index = 0; index < target; index++) {
        const sourceIndex = Math.round(index * (path.points.length - 1) / Math.max(1, target - 1));
        points.push(scalePoint(path.points[sourceIndex]));
      }
      return { ...path, points };
    });
  }

  _validateStream(points, cycleDuration, settings, context = {}) {
    const motion = this._measureMotion(points, cycleDuration, settings, context);
    const intervalSum = points.reduce((sum, point) => sum + (Number(point.deltaTime) || 0), 0);
    const duplicateTimestamps = points.reduce((count, point, index) => count + (
      index > 0 && point.timestamp <= points[index - 1].timestamp ? 1 : 0
    ), 0);
    const intervalSumError = Math.abs(intervalSum - cycleDuration);
    const effectiveScanRate = cycleDuration > 0 ? points.length / cycleDuration : 0;
    const violations = {
      velocity: motion.maxVelocity > settings.maxVelocity * 1.001 ? 1 : 0,
      acceleration: motion.maxAcceleration > settings.maxAcceleration * 1.001 ? 1 : 0,
      visibleTransfer: points.some((point) => point.kind === 'transfer' && !point.blanked) ? 1 : 0,
      invalidPreLight: points.some((point) => point.kind === 'preLightDelay' && !point.blanked) ? 1 : 0,
      invalidPostLight: points.some((point) => point.kind === 'postLightDelay' && point.blanked) ? 1 : 0,
      outOfBounds: points.some((point) => Math.abs(point.x) > 1.000001 || Math.abs(point.y) > 1.000001) ? 1 : 0,
      invalidTiming: points.some((point) => !Number.isFinite(point.timestamp) ||
        !Number.isFinite(point.deltaTime) || point.deltaTime <= 0) ||
        duplicateTimestamps > 0 || intervalSumError > EPSILON ? 1 : 0,
      scanRate: effectiveScanRate > settings.scanRate * 1.000001 ? 1 : 0,
    };
    violations.total = Object.values(violations).reduce((sum, value) => sum + value, 0);
    violations.details = motion.violationDetails;
    violations.duplicateTimestamps = duplicateTimestamps;
    violations.intervalSumError = intervalSumError;
    return violations;
  }

  _recalculatePointIntervals(points, cycleDuration) {
    let previousTime = 0;
    points.forEach((point, index) => {
      point.deltaTime = index === 0 ? point.timestamp : point.timestamp - previousTime;
      point.cycleDuration = cycleDuration;
      previousTime = point.timestamp;
    });
  }

  _countKinds(points) {
    const counts = {
      transfer: 0,
      cornerDwell: 0,
      endDwell: 0,
      preLightDelay: 0,
      postLightDelay: 0,
    };
    points.forEach((point) => {
      if (point.kind in counts) counts[point.kind]++;
    });
    return counts;
  }

  _measureMotion(points, cycleDuration, settings = null, context = {}) {
    let maxVelocity = 0;
    let maxAcceleration = 0;
    const violationDetails = [];
    const record = (type, index, previous, current, dt, measured, limit) => {
      if (violationDetails.length >= 8 || measured <= limit * 1.001) return;
      violationDetails.push({
        type,
        effect: context.effect || null,
        showTime: context.showTime ?? null,
        cycleId: context.cycleId ?? null,
        pointIndex: index,
        pathId: current?.pathId ?? null,
        previousKind: previous?.kind ?? null,
        currentKind: current?.kind ?? null,
        previousVelocity: { x: previous?.velocityX || 0, y: previous?.velocityY || 0 },
        currentVelocity: { x: current?.velocityX || 0, y: current?.velocityY || 0 },
        deltaTime: dt,
        measured,
        limit,
        adaptiveQuality: context.adaptiveQuality || 'full',
        replanReason: context.replanReason || null,
      });
    };
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      maxVelocity = Math.max(maxVelocity, point.velocity || 0);
      if (settings) record('velocity', index, points[index - 1], point, point.deltaTime,
        point.velocity || 0, settings.maxVelocity);
      if (index === 0) continue;
      const previous = points[index - 1];
      const dt = Math.max(EPSILON, point.timestamp - previous.timestamp);
      const acceleration = Math.hypot(
        (point.velocityX || 0) - (previous.velocityX || 0),
        (point.velocityY || 0) - (previous.velocityY || 0),
      ) / dt;
      maxAcceleration = Math.max(maxAcceleration, acceleration);
      if (settings) record('acceleration', index, previous, point, dt,
        acceleration, settings.maxAcceleration);
    }
    if (points.length > 1 && cycleDuration > points[points.length - 1].timestamp) {
      const first = points[0];
      const last = points[points.length - 1];
      const dt = cycleDuration - last.timestamp + first.timestamp;
      const cycleAcceleration = Math.hypot(
        (first.velocityX || 0) - (last.velocityX || 0),
        (first.velocityY || 0) - (last.velocityY || 0),
      ) / Math.max(EPSILON, dt);
      maxAcceleration = Math.max(maxAcceleration, cycleAcceleration);
      if (settings) record('cycle-acceleration', 0, last, first, dt,
        cycleAcceleration, settings.maxAcceleration);
    }
    return { maxVelocity, maxAcceleration, violationDetails };
  }
}
