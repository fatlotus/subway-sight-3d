import {
  distanceEnu2D,
  isInsideNycBounds,
  wgs84ToEnu,
  wrapAngleRad,
} from '../geo/projection';
import type { GpsStatus, SensorMode, SensorSample } from '../types/sensors';
import type { GpsVisibility, Vec3 } from '../types/transit';

export const GPS_MAX_HARD_ACCURACY_M = 150;
export const GPS_SOFT_ACCURACY_M = 500;
export const GPS_STALE_MS = 8_000;
export const GPS_LOST_MOVING_MS = 12_000;
export const GPS_MAX_VALID_SPEED_MPS = 45;
export const GPS_MIN_HEADING_SPEED_MPS = 2.0;

const DEG_TO_RAD = Math.PI / 180;

export interface GpsFilterResult {
  status: GpsStatus;
  outOfNyc: boolean;
  /** True when fix passes accuracy (<=150m), staleness (<=8s), finite, and inside-NYC gates. */
  acceptedForHardUpdate: boolean;
  /** True when accuracy is in (150m, 500m] and fix is fresh — soft prior only. */
  acceptedForSoftPrior: boolean;
  /** Latest valid ENU position [E, N, 0] if inside NYC and accepted, else null. */
  enu: Vec3 | null;
  latLng: { lat: number; lon: number } | null;
  accuracyM: number | null;
  speedMps: number | null;
  headingRad: number | null;
  timeSinceLastGoodFixMs: number;
  /** True when GPS is lost/stale while moving (and not denied/outOfNyc) -> negative tunnel evidence. */
  hasNegativeTunnelEvidence: boolean;
}

function makeEmptyResult(status: GpsStatus): GpsFilterResult {
  return {
    status,
    outOfNyc: false,
    acceptedForHardUpdate: false,
    acceptedForSoftPrior: false,
    enu: null,
    latLng: null,
    accuracyM: null,
    speedMps: null,
    headingRad: null,
    timeSinceLastGoodFixMs: Infinity,
    hasNegativeTunnelEvidence: false,
  };
}

/**
 * GPS accuracy, staleness, kinematic, and NYC-bounds filter with tunnel-visibility evidence.
 */
export class GpsFilter {
  private denied = false;
  private signalLost = false;
  private outOfNyc = false;
  private lastGoodFixTimeMs: number | null = null;
  private lastOutOfNycLatLng: { lat: number; lon: number } | null = null;
  private lastResult: GpsFilterResult = makeEmptyResult('lost');

  reset(): void {
    this.denied = false;
    this.signalLost = false;
    this.outOfNyc = false;
    this.lastGoodFixTimeMs = null;
    this.lastOutOfNycLatLng = null;
    this.lastResult = makeEmptyResult('lost');
  }

  getLastResult(): GpsFilterResult {
    return this.lastResult;
  }

  update(
    sample: SensorSample,
    isMoving: boolean,
    mode: SensorMode,
  ): GpsFilterResult {
    const hasValidTMs = Number.isFinite(sample.tMs);

    // 1. Handle explicit GeolocationPositionError codes
    if (sample.gpsErrorCode === 1) {
      this.denied = true;
      this.signalLost = false;
      this.outOfNyc = false;
      this.lastOutOfNycLatLng = null;
      const res: GpsFilterResult = {
        status: 'denied',
        outOfNyc: false,
        acceptedForHardUpdate: false,
        acceptedForSoftPrior: false,
        enu: null,
        latLng: null,
        accuracyM: null,
        speedMps: null,
        headingRad: null,
        timeSinceLastGoodFixMs:
          hasValidTMs && this.lastGoodFixTimeMs !== null
            ? Math.max(0, sample.tMs - this.lastGoodFixTimeMs)
            : Infinity,
        hasNegativeTunnelEvidence: false,
      };
      this.lastResult = res;
      return res;
    }

    if (sample.gpsErrorCode === 2 || sample.gpsErrorCode === 3) {
      this.signalLost = true;
      const timeSince =
        hasValidTMs && this.lastGoodFixTimeMs !== null
          ? Math.max(0, sample.tMs - this.lastGoodFixTimeMs)
          : Infinity;
      const status: GpsStatus = this.denied ? 'denied' : 'lost';
      const hasNegativeTunnelEvidence = !this.denied && !this.outOfNyc && isMoving;
      const res: GpsFilterResult = {
        status,
        outOfNyc: this.outOfNyc,
        acceptedForHardUpdate: false,
        acceptedForSoftPrior: false,
        enu: null,
        latLng: this.outOfNyc ? this.lastOutOfNycLatLng : null,
        accuracyM: null,
        speedMps: null,
        headingRad: null,
        timeSinceLastGoodFixMs: timeSince,
        hasNegativeTunnelEvidence,
      };
      this.lastResult = res;
      return res;
    }

    const gps = sample.gps;
    if (
      gps &&
      Number.isFinite(gps.lat) &&
      Number.isFinite(gps.lon) &&
      Number.isFinite(gps.accuracyM) &&
      gps.accuracyM > 0
    ) {
      this.denied = false;
      const effectiveAgeMs = Number.isFinite(gps.fixAgeMs)
        ? Math.max(0, gps.fixAgeMs)
        : gps.fixAgeMs === -Infinity
          ? 0
          : Infinity;

      // 2. NYC bounds check for credible fixes (<= 500m)
      if (!isInsideNycBounds(gps.lat, gps.lon)) {
        if (gps.accuracyM <= GPS_SOFT_ACCURACY_M && effectiveAgeMs <= GPS_STALE_MS) {
          this.signalLost = false;
          this.outOfNyc = true;
          this.lastOutOfNycLatLng = { lat: gps.lat, lon: gps.lon };
          const res: GpsFilterResult = {
            status: mode === 'sim' ? 'simulated' : 'locked',
            outOfNyc: true,
            acceptedForHardUpdate: false,
            acceptedForSoftPrior: false,
            enu: null,
            latLng: { lat: gps.lat, lon: gps.lon },
            accuracyM: gps.accuracyM,
            speedMps: null,
            headingRad: null,
            timeSinceLastGoodFixMs: effectiveAgeMs,
            hasNegativeTunnelEvidence: false,
          };
          this.lastResult = res;
          return res;
        }
        // Very coarse (>500m) or stale out-of-NYC fix: ignore completely
      } else {
        // Inside NYC
        const validSpeed =
          typeof gps.speedMps === 'number' &&
          Number.isFinite(gps.speedMps) &&
          gps.speedMps >= 0 &&
          gps.speedMps <= GPS_MAX_VALID_SPEED_MPS
            ? gps.speedMps
            : null;

        const validHeading =
          typeof gps.headingDeg === 'number' &&
          Number.isFinite(gps.headingDeg) &&
          validSpeed !== null &&
          validSpeed >= GPS_MIN_HEADING_SPEED_MPS
            ? wrapAngleRad(gps.headingDeg * DEG_TO_RAD)
            : null;

        if (
          gps.accuracyM <= GPS_MAX_HARD_ACCURACY_M &&
          effectiveAgeMs <= GPS_STALE_MS
        ) {
          this.signalLost = false;
          this.outOfNyc = false;
          this.lastOutOfNycLatLng = null;
          if (hasValidTMs) {
            this.lastGoodFixTimeMs = sample.tMs - effectiveAgeMs;
          }
          const res: GpsFilterResult = {
            status: mode === 'sim' ? 'simulated' : 'locked',
            outOfNyc: false,
            acceptedForHardUpdate: true,
            acceptedForSoftPrior: true,
            enu: wgs84ToEnu(gps.lat, gps.lon, 0),
            latLng: { lat: gps.lat, lon: gps.lon },
            accuracyM: gps.accuracyM,
            speedMps: validSpeed,
            headingRad: validHeading,
            timeSinceLastGoodFixMs: effectiveAgeMs,
            hasNegativeTunnelEvidence: false,
          };
          this.lastResult = res;
          return res;
        }

        if (
          gps.accuracyM <= GPS_SOFT_ACCURACY_M &&
          effectiveAgeMs <= GPS_STALE_MS
        ) {
          this.outOfNyc = false;
          const timeSince =
            hasValidTMs && this.lastGoodFixTimeMs !== null
              ? Math.max(0, sample.tMs - this.lastGoodFixTimeMs)
              : Infinity;
          const status = this.computeStaleStatus(timeSince, isMoving, mode);
          const res: GpsFilterResult = {
            status,
            outOfNyc: false,
            acceptedForHardUpdate: false,
            acceptedForSoftPrior: true,
            enu: wgs84ToEnu(gps.lat, gps.lon, 0),
            latLng: { lat: gps.lat, lon: gps.lon },
            accuracyM: gps.accuracyM,
            speedMps: validSpeed,
            headingRad: validHeading,
            timeSinceLastGoodFixMs: timeSince,
            hasNegativeTunnelEvidence: false,
          };
          this.lastResult = res;
          return res;
        }
        // Accuracy > 500m or stale fix: fall through without updating lastGoodFixTimeMs
      }
    }

    // 3. No fresh acceptable fix on this tick -> evaluate staleness / tunnel loss
    if (this.outOfNyc) {
      const res: GpsFilterResult = {
        status: this.denied ? 'denied' : mode === 'sim' ? 'simulated' : 'stale',
        outOfNyc: true,
        acceptedForHardUpdate: false,
        acceptedForSoftPrior: false,
        enu: null,
        latLng: this.lastOutOfNycLatLng,
        accuracyM: null,
        speedMps: null,
        headingRad: null,
        timeSinceLastGoodFixMs: Infinity,
        hasNegativeTunnelEvidence: false,
      };
      this.lastResult = res;
      return res;
    }

    const timeSince =
      hasValidTMs && this.lastGoodFixTimeMs !== null
        ? Math.max(0, sample.tMs - this.lastGoodFixTimeMs)
        : Infinity;

    const status = this.denied
      ? 'denied'
      : this.computeStaleStatus(timeSince, isMoving, mode);

    const hasNegativeTunnelEvidence =
      !this.denied &&
      !this.outOfNyc &&
      isMoving &&
      (status === 'lost' || (status === 'stale' && timeSince > GPS_STALE_MS));

    const res: GpsFilterResult = {
      status,
      outOfNyc: false,
      acceptedForHardUpdate: false,
      acceptedForSoftPrior: false,
      enu: null,
      latLng: null,
      accuracyM: null,
      speedMps: null,
      headingRad: null,
      timeSinceLastGoodFixMs: timeSince,
      hasNegativeTunnelEvidence,
    };
    this.lastResult = res;
    return res;
  }

  private computeStaleStatus(
    timeSinceMs: number,
    isMoving: boolean,
    mode: SensorMode,
  ): GpsStatus {
    if (this.signalLost) {
      return 'lost';
    }
    if (this.lastGoodFixTimeMs === null) {
      return isMoving ? 'lost' : mode === 'sim' ? 'simulated' : 'lost';
    }
    if (timeSinceMs > GPS_LOST_MOVING_MS && isMoving) {
      return 'lost';
    }
    if (timeSinceMs > GPS_STALE_MS) {
      return 'stale';
    }
    return mode === 'sim' ? 'simulated' : 'locked';
  }
}

/**
 * Evaluate log-likelihood of a track point's GPS visibility class given current GPS filter state.
 * Handles both positive GPS lock (penalizing UNDERGROUND) and negative tunnel evidence (penalizing OPEN_SKY).
 */
export function evaluateGpsVisibilityLogLikelihood(
  gpsVisibility: GpsVisibility,
  filterResult: GpsFilterResult,
): number {
  if (filterResult.acceptedForHardUpdate && filterResult.accuracyM !== null) {
    const tightFix = filterResult.accuracyM <= 50;
    switch (gpsVisibility) {
      case 'OPEN_SKY':
        return 0.0;
      case 'PORTAL':
        return tightFix ? -0.3 : -0.15;
      case 'URBAN_CANYON':
        return tightFix ? -0.4 : -0.2;
      case 'UNDERGROUND':
        return tightFix ? -2.8 : -1.2;
    }
  }

  if (filterResult.hasNegativeTunnelEvidence) {
    switch (gpsVisibility) {
      case 'UNDERGROUND':
        return 0.0;
      case 'PORTAL':
        return -0.5;
      case 'URBAN_CANYON':
        return -0.8;
      case 'OPEN_SKY':
        return -2.2;
    }
  }

  return 0.0;
}

/**
 * Evaluate combined GPS measurement + visibility log-likelihood for a particle pose.
 */
export function evaluateGpsMeasurementLogLikelihood(
  particleEnu: Vec3,
  particleHeadingRad: number,
  particleSpeedMps: number,
  particleVisibility: GpsVisibility,
  filterResult: GpsFilterResult,
): number {
  let logL = evaluateGpsVisibilityLogLikelihood(particleVisibility, filterResult);

  if (
    !filterResult.acceptedForHardUpdate ||
    filterResult.enu === null ||
    filterResult.accuracyM === null
  ) {
    return logL;
  }

  const sigmaPos = Math.max(15, Math.min(GPS_MAX_HARD_ACCURACY_M, filterResult.accuracyM));
  const dist2d = distanceEnu2D(particleEnu, filterResult.enu);
  const posTerm = Math.min(25, (dist2d / sigmaPos) ** 2);
  logL += -0.5 * posTerm;

  if (filterResult.headingRad !== null) {
    const dTheta = Math.abs(wrapAngleRad(particleHeadingRad - filterResult.headingRad));
    const sigmaHeading = 0.45;
    logL += -0.5 * Math.min(12, (dTheta / sigmaHeading) ** 2);
  }

  if (filterResult.speedMps !== null) {
    const dSpeed = particleSpeedMps - filterResult.speedMps;
    const sigmaSpeed = 3.5;
    logL += -0.5 * Math.min(9, (dSpeed / sigmaSpeed) ** 2);
  }

  return logL;
}
