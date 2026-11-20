import type { DrStatus, SensorMode, SensorSample } from '../types/sensors';
import type { TrackPolyline, Vec3 } from '../types/transit';

export interface DeadReckoningOutput {
  status: DrStatus;
  hasImu: boolean;
  /** Estimated forward speed along train track in m/s (>= 0). */
  speedMps: number;
  /** Incremental arc-length displacement during this step in meters (>= 0). */
  deltaSM: number;
  /** World yaw rate around vertical axis, CW-positive (rad/s) to match Track curvature * v. */
  yawRateCwRadS: number;
  /** Integrated heading change over this tick (rad, CW-positive). */
  deltaHeadingRad: number;
  /** Sliding-window horizontal acceleration vibration RMS (m/s^2). */
  vibrationRms: number;
  /** True when vibration RMS and speed indicate train is stopped/dwelling at a station. */
  isDwelling: boolean;
  /** Duration of current continuous dwell in seconds (0 if moving). */
  dwellDurationSec: number;
  /** True on the tick transitioning from moving -> dwelling (station arrival event). */
  justStopped: boolean;
  /** True on the tick transitioning from dwelling -> moving (station departure event). */
  justDeparted: boolean;
  /** Current estimated forward acceleration bias (m/s^2). */
  accelBiasMps2: number;
}

export interface DeadReckoningUpdateOptions {
  maxSpeedMps?: number;
  gpsSpeedMps?: number | null;
  scheduleSpeedMps?: number;
}

export const IMU_TIMEOUT_MS = 15_000;
const VIB_WINDOW_MS = 800;
const MAX_ACCEL_MPS2 = 1.5;
const MIN_ACCEL_MPS2 = -1.8;
const MAX_YAW_RATE_RAD_S = 2.0;

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/**
 * Gravity-aligned IMU dead reckoning engine with sliding-window vibration RMS stop/dwell detection,
 * ZUPT bias reset, yaw-rate extraction, kinematic speed clamping, and graceful missing-IMU fallback.
 */
export class DeadReckoningEngine {
  private prevTMs: number | null = null;
  private lastImuTimeMs: number | null = null;
  private gVec: Vec3 | null = null;
  private fwdAxis: Vec3 | null = null;

  private speedMps = 0;
  private accelBiasMps2 = 0;
  private isDwelling = true;
  private dwellDurationSec = 0;
  private lowVibDurationSec = 0;

  private vibWindow: Array<{ tMs: number; sqMag: number }> = [];

  reset(): void {
    this.prevTMs = null;
    this.lastImuTimeMs = null;
    this.gVec = null;
    this.fwdAxis = null;
    this.speedMps = 0;
    this.accelBiasMps2 = 0;
    this.isDwelling = true;
    this.dwellDurationSec = 0;
    this.lowVibDurationSec = 0;
    this.vibWindow = [];
  }

  /** Force stationary state and reset acceleration bias (e.g., on manual station calibration). */
  anchorStationary(): void {
    this.speedMps = 0;
    this.accelBiasMps2 = 0;
    this.isDwelling = true;
    this.dwellDurationSec = 0;
    this.lowVibDurationSec = 0;
  }

  /** Gently blend DR speed toward an external reference (GPS or particle filter posterior). */
  correctSpeed(refSpeedMps: number, alpha = 0.25): void {
    if (!Number.isFinite(refSpeedMps) || refSpeedMps < 0) return;
    const a = clamp(alpha, 0, 1);
    this.speedMps = Math.max(0, (1 - a) * this.speedMps + a * refSpeedMps);
  }

  update(
    sample: SensorSample,
    mode: SensorMode,
    options?: DeadReckoningUpdateOptions,
  ): DeadReckoningOutput {
    const hasValidTMs = Number.isFinite(sample.tMs);
    if (hasValidTMs && this.prevTMs !== null && sample.tMs < this.prevTMs) {
      this.vibWindow = [];
    }
    const dtSec =
      hasValidTMs && this.prevTMs !== null
        ? clamp((sample.tMs - this.prevTMs) / 1000, 0, 2.0)
        : 0;
    if (hasValidTMs) {
      this.prevTMs = sample.tMs;
    }

    const maxSpeedMps =
      typeof options?.maxSpeedMps === 'number' &&
      Number.isFinite(options.maxSpeedMps) &&
      options.maxSpeedMps > 0
        ? options.maxSpeedMps
        : 28;

    const gpsSpeedMps =
      typeof options?.gpsSpeedMps === 'number' &&
      Number.isFinite(options.gpsSpeedMps) &&
      options.gpsSpeedMps >= 0
        ? options.gpsSpeedMps
        : null;

    const scheduleSpeedMps =
      typeof options?.scheduleSpeedMps === 'number' &&
      Number.isFinite(options.scheduleSpeedMps) &&
      options.scheduleSpeedMps >= 0
        ? options.scheduleSpeedMps
        : 11.5;

    const imu = sample.imu;
    const imuValid =
      imu !== undefined &&
      isFiniteVec3(imu.accelLin) &&
      isFiniteVec3(imu.accelGrav) &&
      isFiniteVec3(imu.gyroRadS);

    if (imuValid && hasValidTMs) {
      this.lastImuTimeMs = sample.tMs;
    }

    const tForImu = hasValidTMs ? sample.tMs : this.prevTMs;
    const hasImu =
      this.lastImuTimeMs !== null &&
      tForImu !== null &&
      tForImu - this.lastImuTimeMs <= IMU_TIMEOUT_MS;

    // Graceful degradation when IMU is unavailable
    if (!hasImu || !imuValid) {
      const prevDwelling = this.isDwelling;
      if (gpsSpeedMps !== null) {
        this.speedMps = clamp(gpsSpeedMps, 0, maxSpeedMps);
      } else {
        this.speedMps = clamp(scheduleSpeedMps, 0, maxSpeedMps);
      }
      this.isDwelling = this.speedMps < 0.3;
      this.dwellDurationSec = this.isDwelling ? this.dwellDurationSec + dtSec : 0;

      return {
        status: hasImu ? (mode === 'sim' ? 'simulated' : 'active') : 'unavailable',
        hasImu,
        speedMps: this.speedMps,
        deltaSM: this.speedMps * dtSec,
        yawRateCwRadS: 0,
        deltaHeadingRad: 0,
        vibrationRms: 0,
        isDwelling: this.isDwelling,
        dwellDurationSec: this.dwellDurationSec,
        justStopped: !prevDwelling && this.isDwelling,
        justDeparted: prevDwelling && !this.isDwelling,
        accelBiasMps2: this.accelBiasMps2,
      };
    }

    // 1. Low-pass gravity vector estimation
    const gravNorm = norm3(imu.accelGrav);
    if (this.gVec === null) {
      this.gVec = gravNorm > 1.0 ? [...imu.accelGrav] : [0, 9.80665, 0];
    } else if (gravNorm > 1.0) {
      const alphaG = clamp(dtSec / (0.4 + dtSec), 0.05, 1.0);
      this.gVec = [
        (1 - alphaG) * this.gVec[0] + alphaG * imu.accelGrav[0],
        (1 - alphaG) * this.gVec[1] + alphaG * imu.accelGrav[1],
        (1 - alphaG) * this.gVec[2] + alphaG * imu.accelGrav[2],
      ];
    }

    const gLen = norm3(this.gVec);
    const gHat: Vec3 =
      gLen > 1e-3
        ? [this.gVec[0] / gLen, this.gVec[1] / gLen, this.gVec[2] / gLen]
        : [0, 1, 0];

    // 2. Linear acceleration (use accelLin directly; fall back to accelGrav - gVec if accelLin is zeroed)
    const linNorm = norm3(imu.accelLin);
    const aLin: Vec3 =
      linNorm > 1e-6 || gravNorm < 1.0
        ? imu.accelLin
        : [
            imu.accelGrav[0] - this.gVec[0],
            imu.accelGrav[1] - this.gVec[1],
            imu.accelGrav[2] - this.gVec[2],
          ];

    // Project onto horizontal plane orthogonal to gHat
    const aVert = dot3(aLin, gHat);
    const aHoriz: Vec3 = [
      aLin[0] - aVert * gHat[0],
      aLin[1] - aVert * gHat[1],
      aLin[2] - aVert * gHat[2],
    ];
    const aHorizMag = norm3(aHoriz);

    // 3. World yaw rate (CW-positive = -dot(gyro, gHat))
    const omegaUp = dot3(imu.gyroRadS, gHat);
    const yawRateCwRadS = clamp(-omegaUp, -MAX_YAW_RATE_RAD_S, MAX_YAW_RATE_RAD_S);
    const deltaHeadingRad = yawRateCwRadS * dtSec;

    // 4. Sliding-window vibration RMS
    const vibTMs = hasValidTMs ? sample.tMs : (this.prevTMs ?? 0);
    this.vibWindow.push({ tMs: vibTMs, sqMag: aHorizMag * aHorizMag });
    const cutoffMs = vibTMs - VIB_WINDOW_MS;
    while (
      this.vibWindow.length > 1 &&
      (this.vibWindow[0].tMs < cutoffMs || this.vibWindow[0].tMs > vibTMs)
    ) {
      this.vibWindow.shift();
    }
    let sumSq = 0;
    for (let i = 0; i < this.vibWindow.length; i++) {
      sumSq += this.vibWindow[i].sqMag;
    }
    const vibrationRms = Math.sqrt(sumSq / Math.max(1, this.vibWindow.length));

    // 5. Re-orthogonalize forward traction axis against gHat if initialized
    if (this.fwdAxis !== null) {
      const proj = dot3(this.fwdAxis, gHat);
      const orth: Vec3 = [
        this.fwdAxis[0] - proj * gHat[0],
        this.fwdAxis[1] - proj * gHat[1],
        this.fwdAxis[2] - proj * gHat[2],
      ];
      const oLen = norm3(orth);
      if (oLen > 1e-3) {
        this.fwdAxis = [orth[0] / oLen, orth[1] / oLen, orth[2] / oLen];
      } else {
        this.fwdAxis = null;
      }
    }

    // 6. Stop / dwell detector with hysteresis
    const prevDwelling = this.isDwelling;
    if (vibrationRms < 0.14 && this.speedMps < 1.2) {
      this.lowVibDurationSec += dtSec;
    } else if (vibrationRms < 0.08) {
      this.lowVibDurationSec += dtSec * 1.5;
    } else {
      this.lowVibDurationSec = 0;
    }

    if (this.isDwelling) {
      if (
        vibrationRms > 0.28 ||
        aHorizMag > 0.45 ||
        (gpsSpeedMps !== null && gpsSpeedMps > 2.0)
      ) {
        this.isDwelling = false;
        this.dwellDurationSec = 0;
        this.lowVibDurationSec = 0;
      } else {
        this.dwellDurationSec += dtSec;
      }
    } else {
      const gpsStopped = gpsSpeedMps !== null && gpsSpeedMps < 0.3;
      if (
        this.lowVibDurationSec >= 0.5 ||
        (gpsStopped && vibrationRms < 0.18)
      ) {
        this.isDwelling = true;
        this.dwellDurationSec = 0;
      }
    }

    const justStopped = !prevDwelling && this.isDwelling;
    const justDeparted = prevDwelling && !this.isDwelling;

    // 7. ZUPT when dwelling; signed longitudinal integration when moving
    if (this.isDwelling) {
      this.speedMps = 0;
      if (this.fwdAxis !== null) {
        const rawLong = dot3(aHoriz, this.fwdAxis);
        this.accelBiasMps2 = 0.8 * this.accelBiasMps2 + 0.2 * rawLong;
      } else {
        this.accelBiasMps2 *= 0.8;
      }
    } else {
      // Learn dominant horizontal traction axis on departure from rest
      if (
        (this.fwdAxis === null || (justDeparted && this.speedMps < 0.5)) &&
        aHorizMag > 0.35
      ) {
        this.fwdAxis = [
          aHoriz[0] / aHorizMag,
          aHoriz[1] / aHorizMag,
          aHoriz[2] / aHorizMag,
        ];
      }

      let aFwd = 0;
      if (this.fwdAxis !== null) {
        aFwd = dot3(aHoriz, this.fwdAxis) - this.accelBiasMps2;
      } else if (aHorizMag > 0.35) {
        aFwd = aHorizMag;
      }

      aFwd = clamp(aFwd, MIN_ACCEL_MPS2, MAX_ACCEL_MPS2);
      this.speedMps = clamp(this.speedMps + aFwd * dtSec, 0, maxSpeedMps);

      // Gentle damping near zero acceleration to prevent long-tunnel drift
      if (Math.abs(aFwd) < 0.05 && dtSec > 0) {
        this.speedMps *= Math.pow(0.995, dtSec);
      }

      // Complementary filter anchor with GPS speed when locked
      if (gpsSpeedMps !== null) {
        this.speedMps = clamp(
          0.7 * this.speedMps + 0.3 * gpsSpeedMps,
          0,
          maxSpeedMps,
        );
      }
    }

    const status: DrStatus =
      mode === 'sim' ? 'simulated' : this.isDwelling ? 'standby' : 'active';

    return {
      status,
      hasImu: true,
      speedMps: this.speedMps,
      deltaSM: this.speedMps * dtSec,
      yawRateCwRadS,
      deltaHeadingRad,
      vibrationRms,
      isDwelling: this.isDwelling,
      dwellDurationSec: this.dwellDurationSec,
      justStopped,
      justDeparted,
      accelBiasMps2: this.accelBiasMps2,
    };
  }
}

/**
 * Pure helper: snap arc-length `s` to the nearest station on `track` when dwelling within `snapRadiusM`.
 */
export function snapToStationIfDwelling(
  track: TrackPolyline,
  s: number,
  isDwelling: boolean,
  snapRadiusM = 65,
): { snapped: boolean; s: number; stationId: string | null; distM: number } {
  if (!isDwelling || track.stations.length === 0 || !Number.isFinite(s)) {
    return { snapped: false, s, stationId: null, distM: Infinity };
  }

  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < track.stations.length; i++) {
    const d = Math.abs(track.stations[i].s - s);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0 && bestDist <= snapRadiusM) {
    const ref = track.stations[bestIdx];
    return {
      snapped: true,
      s: ref.s,
      stationId: ref.stationId,
      distM: bestDist,
    };
  }

  return { snapped: false, s, stationId: null, distM: bestDist };
}
