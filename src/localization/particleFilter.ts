import { findNearestTracks, projectPointOntoTrack } from '../data/dataset';
import {
  distanceEnu2D,
  enuToWgs84,
  LAT_0,
  LON_0,
  samplePolylineAtS,
  wgs84ToEnu,
} from '../geo/projection';
import { createMulberry32 } from '../sensors/simSensorSource';
import type { SensorMode, SensorSample } from '../types/sensors';
import type {
  EstimatorState,
  RouteCandidate,
  ServiceType,
  TravelDirection,
} from '../types/state';
import type {
  RailSystem,
  ServicePeriod,
  StructureType,
  TrackDirection,
  TrackPolyline,
  TrackServiceType,
  TransitDataset,
  Vec3,
} from '../types/transit';
import {
  DeadReckoningEngine,
  snapToStationIfDwelling,
} from './deadReckoning';
import {
  evaluateGpsMeasurementLogLikelihood,
  GpsFilter,
} from './gpsFilter';
import {
  type ActiveScheduleContext,
  classifyServicePeriod,
  estimateNextStationAndEta,
  evaluateRunTimeLogLikelihood,
  evaluateTimetablePhaseLogLikelihood,
  getActiveScheduleContexts,
} from './scheduleModel';

export interface ManualCalibrationAnchor {
  stationId?: string;
  routeId?: string;
  direction?: TravelDirection;
}

export interface ParticleFilterOptions {
  /** Number of particles, clamped to [250, 400] (default 300). */
  particleCount?: number;
  /** Deterministic Mulberry32 seed (default 1337). */
  seed?: number;
  /** Timezone for NYC service period classification (default 'America/New_York'). */
  timeZone?: string;
}

interface Particle {
  scheduleId: string;
  trackId: string;
  routeId: string;
  system: RailSystem;
  serviceType: TrackServiceType;
  direction: TrackDirection;
  s: number;
  speedMps: number;
  dwelling: boolean;
  dwellTimerSec: number;
  lastStationIdx: number;
  timeSinceLastStopSec: number;
  weight: number;
  logWeight: number;
}

const MPS_TO_MPH = 2.236936;
const METERS_TO_FEET = 3.28084;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number | undefined | null, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function titleCaseWord(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatDisplayLabel(
  routeId: string | null,
  serviceType: ServiceType,
  direction: TravelDirection,
): string {
  if (!routeId) return 'Locating Train…';
  const svc = serviceType === 'UNKNOWN' ? '' : ` ${titleCaseWord(serviceType)}`;
  const dir = direction === 'UNKNOWN' ? '' : ` — ${titleCaseWord(direction)}`;
  return `${routeId}${svc}${dir}`;
}

function defaultCruiseSpeed(serviceType: TrackServiceType): number {
  if (serviceType === 'COMMUTER') return 20.0;
  if (serviceType === 'EXPRESS') return 15.5;
  return 11.5;
}

function maxSpeedForService(serviceType: TrackServiceType): number {
  if (serviceType === 'COMMUTER') return 32;
  if (serviceType === 'EXPRESS') return 24;
  return 18;
}

function findNearestStationOnTrack(
  track: TrackPolyline,
  s: number,
): { idx: number; distM: number } {
  const stations = track.stations;
  if (stations.length === 0) return { idx: -1, distM: Infinity };
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < stations.length; i++) {
    const d = Math.abs(stations[i].s - s);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, distM: bestDist };
}

/**
 * Track-constrained 1D hybrid particle filter fusing GPS + Dead Reckoning + Historical Timing + Manual Calibration.
 */
export class TrackParticleFilter {
  private readonly dataset: TransitDataset;
  private readonly particleCount: number;
  private readonly seed: number;
  private readonly timeZone: string;

  private prng: () => number;
  private spareGaussian: number | null = null;
  private readonly gpsFilter = new GpsFilter();
  private readonly drEngine = new DeadReckoningEngine();

  private particles: Particle[] = [];
  private prevTMs: number | null = null;
  private lastPeriod: ServicePeriod | null = null;
  private lastMoving = false;
  private consecutiveGpsDivergence = 0;
  private hasReceivedGpsFix = false;

  private manualAnchor: ManualCalibrationAnchor | null = null;
  private manualAnchorActive = false;
  private lastState: EstimatorState;

  constructor(dataset: TransitDataset, options?: ParticleFilterOptions) {
    this.dataset = dataset;
    this.particleCount = Math.round(
      clamp(options?.particleCount ?? 300, 250, 400),
    );
    this.seed = options?.seed ?? 1337;
    this.timeZone = options?.timeZone ?? 'America/New_York';
    this.prng = createMulberry32(this.seed);
    this.lastState = this.createDefaultState('lost', 'standby', 'active');
  }

  reset(): void {
    this.prng = createMulberry32(this.seed);
    this.spareGaussian = null;
    this.gpsFilter.reset();
    this.drEngine.reset();
    this.particles = [];
    this.prevTMs = null;
    this.lastPeriod = null;
    this.lastMoving = false;
    this.consecutiveGpsDivergence = 0;
    this.hasReceivedGpsFix = false;
    this.manualAnchor = null;
    this.manualAnchorActive = false;
    this.lastState = this.createDefaultState('lost', 'standby', 'active');
  }

  resetCalibration(): void {
    this.manualAnchor = null;
    this.manualAnchorActive = false;
    this.lastPeriod = null;
    this.lastState = {
      ...this.lastState,
      manualAnchorActive: false,
    };
  }

  getState(): EstimatorState {
    return this.lastState;
  }

  /**
   * Immediately anchor all particles to a user-selected station, route, and/or direction.
   */
  setManualCalibration(
    anchor: ManualCalibrationAnchor,
    tMsOverride?: number,
  ): EstimatorState {
    if (
      !anchor.stationId &&
      !anchor.routeId &&
      (!anchor.direction || anchor.direction === 'UNKNOWN')
    ) {
      return this.lastState;
    }
    const tMs =
      typeof tMsOverride === 'number' && Number.isFinite(tMsOverride)
        ? tMsOverride
        : (this.prevTMs ?? Date.now());
    this.prevTMs = tMs;
    const period = classifyServicePeriod(tMs, this.timeZone);
    const activeContexts = getActiveScheduleContexts(this.dataset, period);

    let matched = this.filterContextsByAnchor(activeContexts, anchor);

    // Fallback: if route is inactive in current period (e.g. user explicitly picks B on weekend),
    // synthesize contexts from all dataset schedules matching the anchor so calibration never fails silently.
    if (matched.length === 0) {
      const fallbackContexts = this.buildFallbackContexts(period);
      matched = this.filterContextsByAnchor(fallbackContexts, anchor);
    }

    // If still empty (e.g. stationId + incompatible routeId), relax to stationId only or routeId only.
    if (matched.length === 0 && anchor.stationId) {
      matched = this.filterContextsByAnchor(activeContexts, {
        stationId: anchor.stationId,
      });
    }
    if (matched.length === 0 && anchor.routeId) {
      const fallbackContexts = this.buildFallbackContexts(period);
      matched = this.filterContextsByAnchor(fallbackContexts, {
        routeId: anchor.routeId,
        direction: anchor.direction,
      });
    }

    if (matched.length === 0) {
      return this.lastState;
    }

    this.manualAnchor = { ...anchor };
    this.manualAnchorActive = true;
    this.consecutiveGpsDivergence = 0;

    if (anchor.stationId) {
      this.drEngine.anchorStationary();
    }

    const prevEnu = this.lastState.positionEnu;
    this.particles = [];
    const w = 1 / this.particleCount;

    for (let i = 0; i < this.particleCount; i++) {
      const ctx = matched[i % matched.length];
      const track = ctx.effectiveTrack;

      let baseS = track.totalLengthM * 0.5;
      let stationIdx = 0;
      if (anchor.stationId) {
        const idx = track.stations.findIndex(
          (st) => st.stationId === anchor.stationId,
        );
        if (idx >= 0) {
          baseS = track.stations[idx].s;
          stationIdx = idx;
        }
      } else {
        const proj = projectPointOntoTrack(prevEnu, track);
        baseS = proj.s;
        stationIdx = findNearestStationOnTrack(track, baseS).idx;
      }

      const jitter = anchor.stationId ? this.nextGaussian(0, 4) : this.nextGaussian(0, 25);
      const s = clamp(baseS + jitter, 0, track.totalLengthM);

      this.particles.push({
        scheduleId: ctx.schedule.id,
        trackId: track.id,
        routeId: ctx.schedule.routeId,
        system: ctx.schedule.system,
        serviceType: ctx.effectiveServiceType,
        direction: ctx.schedule.direction,
        s,
        speedMps: anchor.stationId ? 0 : this.lastState.speedMps,
        dwelling: Boolean(anchor.stationId),
        dwellTimerSec: 0,
        lastStationIdx: stationIdx,
        timeSinceLastStopSec: 0,
        weight: w,
        logWeight: 0,
      });
    }

    const ctxMap = this.makeContextMap(matched);
    const gpsRes = this.gpsFilter.getLastResult();
    const state = this.extractState(
      ctxMap,
      gpsRes.status,
      this.lastState.sensorStatus.dr,
      activeContexts.length > 0 ? 'active' : 'degraded',
    );
    this.lastState = state;
    return state;
  }

  /**
   * Process one SensorSample and return the updated EstimatorState.
   */
  step(sample: SensorSample, mode: SensorMode = 'live'): EstimatorState {
    const hasValidTMs = Number.isFinite(sample.tMs);
    const dtSec =
      hasValidTMs && this.prevTMs !== null
        ? clamp((sample.tMs - this.prevTMs) / 1000, 0, 2.0)
        : 0;
    if (hasValidTMs) {
      this.prevTMs = sample.tMs;
    }

    const period = classifyServicePeriod(sample.tMs, this.timeZone);
    const activeContexts = getActiveScheduleContexts(this.dataset, period);
    const ctxMap = this.makeContextMap(activeContexts);

    // 1. Update GPS filter
    const gpsRes = this.gpsFilter.update(sample, this.lastMoving, mode);

    // Out-of-NYC fast path (zero NaN, confidencePct = 0) — bypassed when manually anchored to NYC
    if (gpsRes.outOfNyc && gpsRes.latLng && !this.manualAnchorActive) {
      const enu = wgs84ToEnu(gpsRes.latLng.lat, gpsRes.latLng.lon, 0);
      const state: EstimatorState = {
        routeId: null,
        serviceType: 'UNKNOWN',
        direction: 'UNKNOWN',
        displayLabel: 'Outside NYC Transit Area',
        confidencePct: 0,
        candidates: [],
        currentStationId: null,
        currentStationName: 'Outside NYC',
        nextStationId: null,
        nextStationName: '—',
        etaSec: null,
        positionEnu: [
          finiteOr(enu[0], 0),
          finiteOr(enu[1], 0),
          finiteOr(enu[2], 0),
        ],
        positionLatLng: {
          lat: finiteOr(gpsRes.latLng.lat, LAT_0),
          lon: finiteOr(gpsRes.latLng.lon, LON_0),
        },
        headingRad: 0,
        pitchRad: 0,
        speedMps: 0,
        speedMph: 0,
        elevationM: 0,
        elevationFt: 0,
        structure: 'AT_GRADE',
        outOfNyc: true,
        manualAnchorActive: this.manualAnchorActive,
        sensorStatus: {
          gps: gpsRes.status,
          dr: sample.imu ? (mode === 'sim' ? 'simulated' : 'standby') : 'unavailable',
          timing: activeContexts.length > 0 ? 'active' : 'degraded',
        },
        trackId: null,
        trackS: 0,
      };
      this.lastState = state;
      return state;
    }

    // 2. Migrate particles if service period changed or any particle references an inactive
    //    schedule / changed track (preserve active manual calibration anchors, while still
    //    re-projecting onto updated effectiveTrack when a schedule switches express/local)
    if (this.particles.length > 0) {
      if (this.manualAnchorActive) {
        if (
          (this.lastPeriod !== null && this.lastPeriod !== period) ||
          this.particles.some((p) => {
            const ctx = ctxMap.get(p.scheduleId);
            return Boolean(ctx && ctx.effectiveTrack.id !== p.trackId);
          })
        ) {
          this.reprojectParticlesOntoEffectiveTracks(ctxMap);
        }
      } else if (
        (this.lastPeriod !== null && this.lastPeriod !== period) ||
        this.particles.some((p) => {
          const ctx = ctxMap.get(p.scheduleId);
          return !ctx || ctx.effectiveTrack.id !== p.trackId;
        })
      ) {
        this.migrateParticlesForPeriod(activeContexts, ctxMap);
      }
    }
    this.lastPeriod = period;

    // 3. Update Dead Reckoning engine
    const currentMaxSpeed =
      this.lastState.serviceType === 'COMMUTER'
        ? 32
        : this.lastState.serviceType === 'EXPRESS'
          ? 24
          : 22;

    const drOut = this.drEngine.update(sample, mode, {
      maxSpeedMps: currentMaxSpeed,
      gpsSpeedMps: gpsRes.speedMps,
      scheduleSpeedMps: 11.5,
    });

    this.lastMoving =
      !drOut.isDwelling &&
      (drOut.speedMps > 1.0 || (gpsRes.speedMps ?? 0) > 1.5);

    const isStationaryLiveFarFromTrack =
      mode === 'live' &&
      !this.manualAnchorActive &&
      gpsRes.acceptedForHardUpdate &&
      gpsRes.enu !== null &&
      drOut.isDwelling &&
      (gpsRes.speedMps ?? 0) < 1.5 &&
      findNearestTracks(this.dataset, gpsRes.enu, 80, { limit: 1 }).length === 0;

    if (isStationaryLiveFarFromTrack) {
      this.particles = [];
      this.hasReceivedGpsFix = true;
      const state = this.createDefaultState(
        gpsRes.status,
        drOut.status,
        activeContexts.length > 0 ? 'active' : 'degraded',
        gpsRes.enu,
      );
      this.lastState = state;
      return state;
    }

    // 4. Cold-start particle initialization & single-fix high-accuracy GPS re-localization
    if (this.particles.length === 0) {
      if (gpsRes.acceptedForHardUpdate && gpsRes.enu) {
        this.spawnParticlesNearEnu(
          gpsRes.enu,
          gpsRes.accuracyM ?? 30,
          gpsRes.speedMps ?? drOut.speedMps,
          activeContexts,
          this.particleCount,
        );
        this.hasReceivedGpsFix = true;
      } else {
        this.spawnUniformParticles(activeContexts);
      }
    } else if (
      gpsRes.acceptedForHardUpdate &&
      gpsRes.enu &&
      !this.manualAnchorActive
    ) {
      const gpsAcc = gpsRes.accuracyM ?? 999;
      if (!this.hasReceivedGpsFix) {
        // First hard-accepted GPS fix after a no-GPS uniform cold start:
        // focus particles around the GPS fix immediately so we localize on this tick.
        this.spawnParticlesNearEnu(
          gpsRes.enu,
          gpsRes.accuracyM ?? 30,
          gpsRes.speedMps ?? drOut.speedMps,
          activeContexts,
          this.particleCount,
        );
        this.hasReceivedGpsFix = true;
        this.consecutiveGpsDivergence = 0;
      } else if (gpsAcc <= 50) {
        // Check if current cloud diverges significantly from a high-accuracy GPS fix
        // (e.g., tunnel exit or large location jump) and immediately re-seed so we
        // score and extract at the new location on this same tick.
        let preDistSum = 0;
        let preWSum = 0;
        for (let i = 0; i < this.particles.length; i++) {
          const p = this.particles[i];
          const ctx = ctxMap.get(p.scheduleId);
          if (!ctx) continue;
          const pose = samplePolylineAtS(ctx.effectiveTrack.points, p.s);
          preDistSum += p.weight * distanceEnu2D(pose.enu, gpsRes.enu);
          preWSum += p.weight;
        }
        const preMeanDist = preWSum > 0 ? preDistSum / preWSum : 0;
        const divergeThreshold = Math.max(250, gpsAcc * 3);
        if (preMeanDist > divergeThreshold) {
          this.spawnParticlesNearEnu(
            gpsRes.enu,
            gpsAcc,
            gpsRes.speedMps ?? drOut.speedMps,
            activeContexts,
            this.particleCount,
          );
          this.consecutiveGpsDivergence = 0;
        }
      }
    }

    // Ensure any manually anchored schedules (even if inactive in period) are in ctxMap
    if (this.manualAnchorActive) {
      for (const p of this.particles) {
        if (!ctxMap.has(p.scheduleId)) {
          const fallback = this.buildFallbackContexts(period).find(
            (c) => c.schedule.id === p.scheduleId,
          );
          if (fallback) {
            ctxMap.set(fallback.schedule.id, fallback);
          }
        }
      }
      this.reprojectParticlesOntoEffectiveTracks(ctxMap);
    }

    // 5. Prediction + Measurement Update
    let maxLogW = -Infinity;
    let weightedDistToGps = 0;
    let weightSumForGps = 0;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const ctx = ctxMap.get(p.scheduleId);
      if (!ctx) continue;
      const track = ctx.effectiveTrack;

      // Prediction step
      if (drOut.isDwelling) {
        p.dwelling = true;
        p.speedMps = 0;
        p.dwellTimerSec += dtSec;
        const snapped = snapToStationIfDwelling(track, p.s, true, 65);
        if (snapped.snapped) {
          p.s = p.s + 0.35 * (snapped.s - p.s);
        }
      } else {
        p.dwelling = false;
        p.dwellTimerSec = 0;
        const vTarget = drOut.hasImu
          ? drOut.speedMps
          : gpsRes.speedMps !== null
            ? gpsRes.speedMps
            : defaultCruiseSpeed(p.serviceType);
        const maxV = maxSpeedForService(p.serviceType);
        const vNoise = dtSec > 0 ? this.nextGaussian(0, 0.7) : 0;
        const sNoise = dtSec > 0 ? this.nextGaussian(0, 1.4 * Math.sqrt(dtSec)) : 0;
        p.speedMps = clamp(0.68 * vTarget + 0.32 * p.speedMps + vNoise, 0, maxV);
        p.s = clamp(p.s + p.speedMps * dtSec + sNoise, 0, track.totalLengthM);
        p.timeSinceLastStopSec += dtSec;
      }

      // Sample 3D pose on track
      const pose = samplePolylineAtS(track.points, p.s);

      // Accumulate measurement log-likelihood
      let logL = 0;

      // A. GPS Position + Heading + Speed + Tunnel Visibility
      logL += evaluateGpsMeasurementLogLikelihood(
        pose.enu,
        pose.headingRad,
        p.speedMps,
        pose.gpsVisibility,
        gpsRes,
      );

      if (gpsRes.acceptedForHardUpdate && gpsRes.enu) {
        weightedDistToGps += p.weight * distanceEnu2D(pose.enu, gpsRes.enu);
        weightSumForGps += p.weight;
      }

      // B. Gyro Yaw-Rate Curvature Matching
      if (
        drOut.hasImu &&
        p.speedMps > 3.0 &&
        Math.abs(drOut.yawRateCwRadS) > 0.015
      ) {
        const expectedYaw = p.speedMps * pose.curvature;
        const sigmaYaw = 0.06;
        logL +=
          -0.5 *
          Math.min(9.0, ((drOut.yawRateCwRadS - expectedYaw) / sigmaYaw) ** 2);
      }

      // C. Station Stop/Dwell & Express-vs-Local Disambiguation
      const nearestStop = findNearestStationOnTrack(track, p.s);

      if (drOut.isDwelling) {
        if (drOut.justStopped) {
          if (nearestStop.distM <= 85) {
            logL += 1.5;
            if (
              p.lastStationIdx >= 0 &&
              p.lastStationIdx < track.stations.length &&
              nearestStop.idx >= 0 &&
              nearestStop.idx < track.stations.length &&
              nearestStop.idx !== p.lastStationIdx &&
              p.timeSinceLastStopSec > 10
            ) {
              const fromId = track.stations[p.lastStationIdx].stationId;
              const toId = track.stations[nearestStop.idx].stationId;
              logL +=
                0.5 *
                evaluateRunTimeLogLikelihood(
                  ctx,
                  fromId,
                  toId,
                  p.timeSinceLastStopSec,
                );
            }
            p.lastStationIdx = nearestStop.idx;
            p.timeSinceLastStopSec = 0;
          } else if (nearestStop.distM > 120) {
            logL -= 2.0;
          }
        } else if (drOut.dwellDurationSec >= 1.5 && dtSec > 0) {
          if (nearestStop.distM <= 85) {
            logL += 0.3 * dtSec;
          } else if (nearestStop.distM > 120) {
            logL -= 0.45 * dtSec;
          }
        }
      } else if (drOut.speedMps >= 6.0 && dtSec > 0) {
        // Train is cruising: if passing directly through a scheduled stop on this track
        // without having stopped there recently, penalize strongly (separates Express vs Local!).
        if (
          nearestStop.idx >= 0 &&
          nearestStop.distM <= 45 &&
          p.timeSinceLastStopSec > 12 &&
          nearestStop.idx !== p.lastStationIdx
        ) {
          logL -= 2.4 * dtSec;
        }

        // Speed ceiling consistency: sustained speed > 17.5 m/s favors Express/Commuter over Local
        if (drOut.speedMps > 17.5 && p.serviceType === 'LOCAL') {
          logL -= 0.65 * dtSec;
        }
      }

      // D. Soft Timetable Phase Prior
      if (dtSec > 0) {
        logL +=
          0.05 *
          dtSec *
          evaluateTimetablePhaseLogLikelihood(ctx, p.s, sample.tMs);
      }

      // E. Manual Calibration Anchor Soft Guard
      if (this.manualAnchorActive && this.manualAnchor) {
        if (
          this.manualAnchor.routeId &&
          p.routeId !== this.manualAnchor.routeId
        ) {
          logL -= 2.5;
        }
        if (
          this.manualAnchor.direction &&
          this.manualAnchor.direction !== 'UNKNOWN' &&
          p.direction !== this.manualAnchor.direction
        ) {
          logL -= 2.5;
        }
      }

      p.logWeight += logL;
      if (p.logWeight > maxLogW) {
        maxLogW = p.logWeight;
      }
    }

    // 6. Normalize weights & compute ESS
    let sumW = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const shifted = this.particles[i].logWeight - maxLogW;
      const w = Number.isFinite(shifted) ? Math.exp(Math.max(-50, shifted)) : 0;
      this.particles[i].weight = w;
      sumW += w;
    }

    if (!Number.isFinite(sumW) || sumW <= 0) {
      const uniform = 1 / Math.max(1, this.particles.length);
      for (let i = 0; i < this.particles.length; i++) {
        this.particles[i].weight = uniform;
        this.particles[i].logWeight = 0;
      }
    } else {
      let sumSq = 0;
      for (let i = 0; i < this.particles.length; i++) {
        this.particles[i].weight /= sumW;
        sumSq += this.particles[i].weight * this.particles[i].weight;
      }
      const ess = sumSq > 0 ? 1 / sumSq : 0;
      if (ess < 0.5 * this.particles.length) {
        this.systematicResample();
      }
    }

    // 7. Kidnapped-train / GPS-reacquisition recovery
    if (gpsRes.acceptedForHardUpdate && gpsRes.enu && weightSumForGps > 0) {
      const meanDist = weightedDistToGps / weightSumForGps;
      const divergeThreshold = Math.max(250, (gpsRes.accuracyM ?? 30) * 3);
      if (meanDist > divergeThreshold && !this.manualAnchorActive) {
        this.consecutiveGpsDivergence += 1;
        if (this.consecutiveGpsDivergence >= 2) {
          this.injectFreshParticlesNearEnu(
            gpsRes.enu,
            gpsRes.accuracyM ?? 30,
            gpsRes.speedMps ?? drOut.speedMps,
            activeContexts,
            Math.floor(this.particleCount * 0.25),
          );
          this.consecutiveGpsDivergence = 0;
        }
      } else {
        this.consecutiveGpsDivergence = 0;
      }
    }

    // 8. Extract EstimatorState
    const state = this.extractState(
      ctxMap,
      gpsRes.status,
      drOut.status,
      activeContexts.length > 0 ? 'active' : 'degraded',
      gpsRes.enu,
    );
    this.lastState = state;
    return state;
  }

  private makeContextMap(
    contexts: readonly ActiveScheduleContext[],
  ): Map<string, ActiveScheduleContext> {
    const map = new Map<string, ActiveScheduleContext>();
    for (const ctx of contexts) {
      map.set(ctx.schedule.id, ctx);
    }
    return map;
  }

  private buildFallbackContexts(period: ServicePeriod): ActiveScheduleContext[] {
    const out: ActiveScheduleContext[] = [];
    for (const sched of this.dataset.schedules) {
      const rule = sched.periods[period] ?? sched.periods.WEEKDAY_MIDDAY;
      const track = this.dataset.trackById.get(sched.trackId);
      if (!track) continue;
      out.push({
        schedule: sched,
        period,
        rule: { ...rule, active: true },
        effectiveTrack: track,
        effectiveServiceType: sched.serviceType,
        effectiveRunTimes: sched.runTimes,
        cumulativeStopSec: track.stations.map((_, idx) => idx * 90),
        totalTripDurationSec: Math.max(120, track.stations.length * 90),
      });
    }
    return out;
  }

  private filterContextsByAnchor(
    contexts: readonly ActiveScheduleContext[],
    anchor: ManualCalibrationAnchor,
  ): ActiveScheduleContext[] {
    return contexts.filter((ctx) => {
      if (anchor.routeId && ctx.schedule.routeId !== anchor.routeId) {
        return false;
      }
      if (
        anchor.direction &&
        anchor.direction !== 'UNKNOWN' &&
        ctx.schedule.direction !== anchor.direction
      ) {
        return false;
      }
      if (anchor.stationId) {
        const hasStation = ctx.effectiveTrack.stations.some(
          (st) => st.stationId === anchor.stationId,
        );
        if (!hasStation) return false;
      }
      return true;
    });
  }

  private spawnParticlesNearEnu(
    enu: Vec3,
    accuracyM: number,
    initialSpeedMps: number,
    activeContexts: readonly ActiveScheduleContext[],
    count: number,
  ): void {
    const radius = Math.max(250, accuracyM * 2.5);
    const nearestTracks = findNearestTracks(this.dataset, enu, radius, {
      limit: 12,
    });
    const projByTrackId = new Map(nearestTracks.map((p) => [p.trackId, p]));

    const candidates = activeContexts.filter((ctx) =>
      projByTrackId.has(ctx.effectiveTrack.id),
    );
    if (candidates.length === 0) {
      this.particles = [];
      return;
    }

    this.particles = [];
    const w = 1 / count;
    const spread = Math.min(80, Math.max(15, accuracyM));

    for (let i = 0; i < count; i++) {
      const ctx = candidates[i % candidates.length];
      const proj = projByTrackId.get(ctx.effectiveTrack.id)!;
      const s = clamp(
        proj.s + this.nextGaussian(0, spread),
        0,
        ctx.effectiveTrack.totalLengthM,
      );
      const nearestStop = findNearestStationOnTrack(ctx.effectiveTrack, s);

      this.particles.push({
        scheduleId: ctx.schedule.id,
        trackId: ctx.effectiveTrack.id,
        routeId: ctx.schedule.routeId,
        system: ctx.schedule.system,
        serviceType: ctx.effectiveServiceType,
        direction: ctx.schedule.direction,
        s,
        speedMps: clamp(
          initialSpeedMps + this.nextGaussian(0, 1.0),
          0,
          maxSpeedForService(ctx.effectiveServiceType),
        ),
        dwelling: initialSpeedMps < 0.5,
        dwellTimerSec: 0,
        lastStationIdx: nearestStop.idx,
        timeSinceLastStopSec: 0,
        weight: w,
        logWeight: 0,
      });
    }
  }

  private injectFreshParticlesNearEnu(
    enu: Vec3,
    accuracyM: number,
    speedMps: number,
    activeContexts: readonly ActiveScheduleContext[],
    injectCount: number,
  ): void {
    const radius = Math.max(250, accuracyM * 2.5);
    const nearestTracks = findNearestTracks(this.dataset, enu, radius, {
      limit: 8,
    });
    const projByTrackId = new Map(nearestTracks.map((p) => [p.trackId, p]));
    const candidates = activeContexts.filter((ctx) =>
      projByTrackId.has(ctx.effectiveTrack.id),
    );
    if (candidates.length === 0) return;

    const n = Math.min(injectCount, this.particles.length);
    const w = 1 / this.particles.length;
    for (let i = 0; i < n; i++) {
      const ctx = candidates[i % candidates.length];
      const proj = projByTrackId.get(ctx.effectiveTrack.id)!;
      const s = clamp(
        proj.s + this.nextGaussian(0, Math.min(60, Math.max(15, accuracyM))),
        0,
        ctx.effectiveTrack.totalLengthM,
      );
      this.particles[i] = {
        scheduleId: ctx.schedule.id,
        trackId: ctx.effectiveTrack.id,
        routeId: ctx.schedule.routeId,
        system: ctx.schedule.system,
        serviceType: ctx.effectiveServiceType,
        direction: ctx.schedule.direction,
        s,
        speedMps: clamp(speedMps, 0, maxSpeedForService(ctx.effectiveServiceType)),
        dwelling: speedMps < 0.5,
        dwellTimerSec: 0,
        lastStationIdx: findNearestStationOnTrack(ctx.effectiveTrack, s).idx,
        timeSinceLastStopSec: 0,
        weight: w,
        logWeight: 0,
      };
    }
    for (let i = 0; i < this.particles.length; i++) {
      this.particles[i].weight = w;
      this.particles[i].logWeight = 0;
    }
  }

  private spawnUniformParticles(
    activeContexts: readonly ActiveScheduleContext[],
  ): void {
    const mtaContexts = activeContexts.filter(
      (c) => c.schedule.system === 'MTA',
    );
    const pool = mtaContexts.length > 0 ? mtaContexts : activeContexts;
    if (pool.length === 0) return;

    this.particles = [];
    const w = 1 / this.particleCount;
    for (let i = 0; i < this.particleCount; i++) {
      const ctx = pool[i % pool.length];
      const s = this.prng() * ctx.effectiveTrack.totalLengthM;
      this.particles.push({
        scheduleId: ctx.schedule.id,
        trackId: ctx.effectiveTrack.id,
        routeId: ctx.schedule.routeId,
        system: ctx.schedule.system,
        serviceType: ctx.effectiveServiceType,
        direction: ctx.schedule.direction,
        s,
        speedMps: 0,
        dwelling: true,
        dwellTimerSec: 0,
        lastStationIdx: findNearestStationOnTrack(ctx.effectiveTrack, s).idx,
        timeSinceLastStopSec: 0,
        weight: w,
        logWeight: 0,
      });
    }
  }

  private reprojectParticlesOntoEffectiveTracks(
    ctxMap: Map<string, ActiveScheduleContext>,
  ): void {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const existingCtx = ctxMap.get(p.scheduleId);
      if (!existingCtx || existingCtx.effectiveTrack.id === p.trackId) {
        continue;
      }
      const oldTrack = this.dataset.trackById.get(p.trackId);
      const enu = oldTrack
        ? samplePolylineAtS(oldTrack.points, p.s).enu
        : this.lastState.positionEnu;
      const proj = projectPointOntoTrack(enu, existingCtx.effectiveTrack);
      p.trackId = existingCtx.effectiveTrack.id;
      p.serviceType = existingCtx.effectiveServiceType;
      p.s = proj.s;
      p.lastStationIdx = findNearestStationOnTrack(
        existingCtx.effectiveTrack,
        p.s,
      ).idx;
    }
  }

  private migrateParticlesForPeriod(
    activeContexts: readonly ActiveScheduleContext[],
    ctxMap: Map<string, ActiveScheduleContext>,
  ): void {
    const activeByTrackId = new Map<string, ActiveScheduleContext[]>();
    for (const ctx of activeContexts) {
      const list = activeByTrackId.get(ctx.effectiveTrack.id) ?? [];
      list.push(ctx);
      activeByTrackId.set(ctx.effectiveTrack.id, list);
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const existingCtx = ctxMap.get(p.scheduleId);
      if (existingCtx) {
        // Schedule is still active, but its effectiveTrack may have changed (e.g. A express -> local late night)
        if (existingCtx.effectiveTrack.id !== p.trackId) {
          const oldTrack = this.dataset.trackById.get(p.trackId);
          const enu = oldTrack
            ? samplePolylineAtS(oldTrack.points, p.s).enu
            : this.lastState.positionEnu;
          const proj = projectPointOntoTrack(enu, existingCtx.effectiveTrack);
          p.trackId = existingCtx.effectiveTrack.id;
          p.serviceType = existingCtx.effectiveServiceType;
          p.s = proj.s;
          p.lastStationIdx = findNearestStationOnTrack(
            existingCtx.effectiveTrack,
            p.s,
          ).idx;
        }
        continue;
      }

      // Schedule became inactive (e.g. B or W at midnight / weekend): project onto nearest active track
      const oldTrack = this.dataset.trackById.get(p.trackId);
      const enu = oldTrack
        ? samplePolylineAtS(oldTrack.points, p.s).enu
        : this.lastState.positionEnu;
      const nearest = findNearestTracks(this.dataset, enu, 400, { limit: 6 });

      let replacement: ActiveScheduleContext | null = null;
      let replacementS = 0;
      for (const proj of nearest) {
        const list = activeByTrackId.get(proj.trackId);
        if (list && list.length > 0) {
          replacement = list[i % list.length];
          replacementS = proj.s;
          break;
        }
      }

      if (!replacement && activeContexts.length > 0) {
        replacement = activeContexts[i % activeContexts.length];
        replacementS = projectPointOntoTrack(enu, replacement.effectiveTrack).s;
      }

      if (replacement) {
        p.scheduleId = replacement.schedule.id;
        p.trackId = replacement.effectiveTrack.id;
        p.routeId = replacement.schedule.routeId;
        p.system = replacement.schedule.system;
        p.serviceType = replacement.effectiveServiceType;
        p.direction = replacement.schedule.direction;
        p.s = replacementS;
        p.lastStationIdx = findNearestStationOnTrack(
          replacement.effectiveTrack,
          p.s,
        ).idx;
      }
    }
  }

  private systematicResample(): void {
    const n = this.particles.length;
    if (n === 0) return;

    const next: Particle[] = new Array(n);
    const step = 1 / n;
    const u0 = this.prng() * step;
    let cumW = this.particles[0].weight;
    let idx = 0;

    for (let i = 0; i < n; i++) {
      const target = u0 + i * step;
      while (target > cumW && idx < n - 1) {
        idx += 1;
        cumW += this.particles[idx].weight;
      }
      const src = this.particles[idx];
      const track = this.dataset.trackById.get(src.trackId);
      const maxS = track ? track.totalLengthM : src.s;
      const roughenedS = clamp(src.s + this.nextGaussian(0, 2.0), 0, maxS);

      next[i] = {
        ...src,
        s: roughenedS,
        weight: step,
        logWeight: 0,
      };
    }

    this.particles = next;
  }

  private extractState(
    ctxMap: Map<string, ActiveScheduleContext>,
    gpsStatus: EstimatorState['sensorStatus']['gps'],
    drStatus: EstimatorState['sensorStatus']['dr'],
    timingStatus: EstimatorState['sensorStatus']['timing'],
    fallbackEnu?: Vec3 | null,
  ): EstimatorState {
    if (this.particles.length === 0) {
      return this.createDefaultState(gpsStatus, drStatus, timingStatus, fallbackEnu);
    }

    // Aggregate weights by (routeId, serviceType, direction)
    const groupWeights = new Map<
      string,
      {
        routeId: string;
        serviceType: TrackServiceType;
        direction: TrackDirection;
        scheduleId: string;
        weight: number;
      }
    >();

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const key = `${p.routeId}|${p.serviceType}|${p.direction}`;
      const existing = groupWeights.get(key);
      if (existing) {
        existing.weight += p.weight;
      } else {
        groupWeights.set(key, {
          routeId: p.routeId,
          serviceType: p.serviceType,
          direction: p.direction,
          scheduleId: p.scheduleId,
          weight: p.weight,
        });
      }
    }

    const sortedGroups = [...groupWeights.values()].sort(
      (a, b) => b.weight - a.weight,
    );

    const candidates: RouteCandidate[] = sortedGroups.slice(0, 4).map((g) => ({
      routeId: g.routeId,
      serviceType: g.serviceType,
      direction: g.direction,
      probability: clamp(g.weight, 0, 1),
    }));

    const rawTop = sortedGroups[0];
    if (!rawTop) {
      return this.createDefaultState(gpsStatus, drStatus, timingStatus, fallbackEnu);
    }

    let top = rawTop;
    if (
      !this.manualAnchorActive &&
      this.lastState.routeId !== null &&
      this.lastState.serviceType !== 'UNKNOWN' &&
      this.lastState.direction !== 'UNKNOWN'
    ) {
      const prevKey = `${this.lastState.routeId}|${this.lastState.serviceType}|${this.lastState.direction}`;
      const prevGroup = groupWeights.get(prevKey);
      if (
        prevGroup &&
        prevGroup.weight >= 0.12 &&
        rawTop.weight < prevGroup.weight + 0.08
      ) {
        top = prevGroup;
      }
    }

    const winningCtx = ctxMap.get(top.scheduleId);
    if (!winningCtx) {
      return this.createDefaultState(gpsStatus, drStatus, timingStatus, fallbackEnu);
    }

    // Weighted mean s, speed, and spread over winning group particles
    let wSum = 0;
    let sSum = 0;
    let vSum = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (
        p.routeId === top.routeId &&
        p.serviceType === top.serviceType &&
        p.direction === top.direction
      ) {
        wSum += p.weight;
        sSum += p.weight * p.s;
        vSum += p.weight * p.speedMps;
      }
    }

    const meanS = wSum > 0 ? sSum / wSum : 0;
    const meanSpeedMps = wSum > 0 ? vSum / wSum : 0;

    let varS = 0;
    if (wSum > 0) {
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        if (
          p.routeId === top.routeId &&
          p.serviceType === top.serviceType &&
          p.direction === top.direction
        ) {
          const d = p.s - meanS;
          varS += p.weight * d * d;
        }
      }
      varS /= wSum;
    }
    const stdS = Math.sqrt(Math.max(0, varS));
    const spreadFactor = this.manualAnchorActive
      ? 1.0
      : stdS <= 300
        ? 1.0
        : clamp(1.0 - (stdS - 300) / 1200, 0.5, 1.0);

    const baseConfidence = Math.round(clamp(top.weight * 100 * spreadFactor, 0, 100));
    const manualFloor =
      this.manualAnchorActive && this.manualAnchor
        ? this.manualAnchor.stationId && this.manualAnchor.routeId
          ? 80
          : 65
        : 0;
    const rawConfidence = Math.max(baseConfidence, manualFloor);
    const isUnknown = top.weight < 0.15 && !this.manualAnchorActive;

    const track = winningCtx.effectiveTrack;
    const pose = samplePolylineAtS(track.points, meanS);
    const wgs = enuToWgs84(pose.enu[0], pose.enu[1], pose.enu[2]);
    const stationInfo = estimateNextStationAndEta(
      winningCtx,
      meanS,
      meanSpeedMps,
      this.dataset,
    );

    const routeId = isUnknown ? null : top.routeId;
    const serviceType: ServiceType = isUnknown ? 'UNKNOWN' : top.serviceType;
    const direction: TravelDirection = isUnknown ? 'UNKNOWN' : top.direction;

    const safeSpeedMps = finiteOr(meanSpeedMps, 0);
    const safeElevM = finiteOr(pose.enu[2], 0);

    return {
      routeId,
      serviceType,
      direction,
      displayLabel: formatDisplayLabel(routeId, serviceType, direction),
      confidencePct: finiteOr(rawConfidence, 0),
      candidates,
      currentStationId: stationInfo.currentStationId,
      currentStationName: stationInfo.currentStationName,
      nextStationId: stationInfo.nextStationId,
      nextStationName: stationInfo.nextStationName,
      etaSec: stationInfo.etaSec,
      positionEnu: [
        finiteOr(pose.enu[0], 0),
        finiteOr(pose.enu[1], 0),
        safeElevM,
      ],
      positionLatLng: {
        lat: finiteOr(wgs.lat, LAT_0),
        lon: finiteOr(wgs.lon, LON_0),
      },
      headingRad: finiteOr(pose.headingRad, 0),
      pitchRad: finiteOr(pose.pitchRad, 0),
      speedMps: safeSpeedMps,
      speedMph: finiteOr(safeSpeedMps * MPS_TO_MPH, 0),
      elevationM: safeElevM,
      elevationFt: finiteOr(safeElevM * METERS_TO_FEET, 0),
      structure: pose.structure as StructureType,
      outOfNyc: false,
      manualAnchorActive: this.manualAnchorActive,
      sensorStatus: {
        gps: gpsStatus,
        dr: drStatus,
        timing: timingStatus,
      },
      trackId: track.id,
      trackS: finiteOr(meanS, 0),
      system: winningCtx.schedule.system,
      routeColor: winningCtx.schedule.color,
    };
  }

  private createDefaultState(
    gpsStatus: EstimatorState['sensorStatus']['gps'],
    drStatus: EstimatorState['sensorStatus']['dr'],
    timingStatus: EstimatorState['sensorStatus']['timing'],
    fallbackEnu?: Vec3 | null,
  ): EstimatorState {
    const hasGpsEnu = Boolean(
      fallbackEnu &&
        Number.isFinite(fallbackEnu[0]) &&
        Number.isFinite(fallbackEnu[1]),
    );
    const enu: Vec3 = hasGpsEnu ? [fallbackEnu![0], fallbackEnu![1], 2] : [0, 0, -15];
    const latLng = enuToWgs84(enu[0], enu[1], enu[2]);
    return {
      routeId: null,
      serviceType: 'UNKNOWN',
      direction: 'UNKNOWN',
      displayLabel: hasGpsEnu ? 'Not Near a Rail Line' : 'Locating Train…',
      confidencePct: 0,
      candidates: [],
      currentStationId: null,
      currentStationName: hasGpsEnu ? 'Street Level' : 'Locating…',
      nextStationId: null,
      nextStationName: '—',
      etaSec: null,
      positionEnu: enu,
      positionLatLng: hasGpsEnu
        ? { lat: latLng.lat, lon: latLng.lon }
        : { lat: LAT_0, lon: LON_0 },
      headingRad: 0,
      pitchRad: 0,
      speedMps: 0,
      speedMph: 0,
      elevationM: enu[2],
      elevationFt: enu[2] * METERS_TO_FEET,
      structure: hasGpsEnu ? 'AT_GRADE' : 'UNDERGROUND_TUNNEL',
      outOfNyc: false,
      manualAnchorActive: this.manualAnchorActive,
      sensorStatus: {
        gps: gpsStatus,
        dr: drStatus,
        timing: timingStatus,
      },
      trackId: null,
      trackS: 0,
    };
  }

  private nextGaussian(mean: number, std: number): number {
    if (this.spareGaussian !== null) {
      const val = this.spareGaussian;
      this.spareGaussian = null;
      return mean + std * val;
    }
    const u1 = Math.max(1e-12, this.prng());
    const u2 = this.prng();
    const r = Math.sqrt(-2.0 * Math.log(u1));
    const theta = 2.0 * Math.PI * u2;
    this.spareGaussian = r * Math.sin(theta);
    return mean + std * (r * Math.cos(theta));
  }
}
