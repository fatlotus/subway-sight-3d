import { enuToWgs84, samplePolylineAtS } from '../geo/projection';
import type {
  DemoScenarioId,
  GpsSample,
  ImuSample,
  OrientationSample,
  SensorSample,
  SensorSource,
} from '../types/sensors';
import type {
  GpsVisibility,
  StructureType,
  TrackPolyline,
  TransitDataset,
  Vec3,
} from '../types/transit';

export interface SimScenarioConfig {
  id: DemoScenarioId;
  label: string;
  description: string;
  trackId: string;
  routeId: string;
  startS: number;
  endS: number;
  seed: number;
  baseEpochMs: number;
  /** Seconds of initial station/entrance GPS burst for underground-start demos (0 to disable). */
  initialGpsBurstSec: number;
  /** Optional initial forward speed (m/s) for mid-run scenarios that begin already underway. */
  initialSpeedMps?: number;
}

export interface SimSensorOptions {
  scenarioId?: DemoScenarioId;
  sampleRateHz?: number;
  seed?: number;
  startEpochMs?: number;
  autoLoop?: boolean;
  /** Override scenario initialGpsBurstSec (e.g. 0 for pure underground DR tests). */
  initialGpsBurstSec?: number;
}

export interface SimGroundTruth {
  scenarioId: DemoScenarioId;
  trackId: string;
  routeId: string;
  s: number;
  speedMps: number;
  enu: Vec3;
  headingRad: number;
  pitchRad: number;
  curvature: number;
  structure: StructureType;
  gpsVisibility: GpsVisibility;
  state: 'DWELL' | 'ACCEL' | 'CRUISE' | 'BRAKE';
  tMs: number;
}

/** Weekday midday EDT reference timestamp (Wed Jun 10, 2026 11:30 AM EDT). */
const DEFAULT_BASE_EPOCH_MS = Date.UTC(2026, 5, 10, 15, 30, 0);
/** Weekday AM rush EDT phase-aligned timestamps (Wed Jun 10, 2026 ~08:11–08:12 AM EDT) for regional rail corridors. */
const AM_RUSH_EXPRESS_OVERTAKE_MS = Date.UTC(2026, 5, 10, 12, 12, 0);
const AM_RUSH_LEXINGTON_MS = Date.UTC(2026, 5, 10, 12, 11, 30);
const AM_RUSH_MIDTOWN_MULTI_MS = Date.UTC(2026, 5, 10, 12, 12, 30);

export const DEMO_SCENARIOS: Record<DemoScenarioId, SimScenarioConfig> = {
  'manhattan-bridge': {
    id: 'manhattan-bridge',
    label: 'Manhattan Bridge (D Express)',
    description:
      'Elevated Manhattan Bridge span with GPS lock & East River below → dives into Manhattan tunnel with underground DR handoff.',
    trackId: 'mta-bdfm-express-uptown',
    routeId: 'D',
    startS: 2780,
    endS: 5000,
    seed: 101,
    baseEpochMs: DEFAULT_BASE_EPOCH_MS,
    initialGpsBurstSec: 1.5,
    initialSpeedMps: 23.5,
  },
  'express-overtake': {
    id: 'express-overtake',
    label: '8th Ave Express Overtake (A Express)',
    description:
      'A Express running non-stop past 23rd St & 50th St alongside C Local, Penn Station (LIRR/NJT), PATH, and Hudson River.',
    trackId: 'mta-ace-express-uptown',
    routeId: 'A',
    startS: 6500,
    endS: 9800,
    seed: 202,
    baseEpochMs: AM_RUSH_EXPRESS_OVERTAKE_MS,
    initialGpsBurstSec: 1.5,
    initialSpeedMps: 20.5,
  },
  'lexington-underground': {
    id: 'lexington-underground',
    label: 'Lexington Ave Underground (4 Express)',
    description:
      '4 Express underground dead reckoning through the sharp 14th St–Union Sq S-curve into Grand Central (MNR/LIRR).',
    trackId: 'mta-456-express-uptown',
    routeId: '4',
    startS: 7350,
    endS: 11500,
    seed: 303,
    baseEpochMs: AM_RUSH_LEXINGTON_MS,
    initialGpsBurstSec: 1.5,
  },
  'steinway-queens': {
    id: 'steinway-queens',
    label: 'Steinway Tunnel to Queens (7 Train)',
    description:
      '7 Train departing Grand Central through Steinway Tunnel under the East River → emerging onto Queensboro Plaza viaduct with GPS recovery.',
    trackId: 'mta-7-local-outbound',
    routeId: '7',
    startS: 2282.8,
    endS: 6100,
    seed: 404,
    baseEpochMs: DEFAULT_BASE_EPOCH_MS,
    initialGpsBurstSec: 1.5,
  },
  'midtown-multi-system': {
    id: 'midtown-multi-system',
    label: 'Midtown Multi-System Hub (F Local)',
    description:
      '6th Ave F Local passing 14th St, 23rd St, and 34th St–Herald Sq alongside parallel PATH, LIRR, and NJT corridors.',
    trackId: 'mta-bdfm-local-uptown',
    routeId: 'F',
    startS: 5593.4,
    endS: 8300,
    seed: 505,
    baseEpochMs: AM_RUSH_MIDTOWN_MULTI_MS,
    initialGpsBurstSec: 1.5,
  },
};

/** Own-property type guard preventing prototype-chain keys (e.g. 'toString', '__proto__') from bypassing scenario validation. */
export function isValidDemoScenarioId(id: unknown): id is DemoScenarioId {
  return (
    typeof id === 'string' &&
    Object.prototype.hasOwnProperty.call(DEMO_SCENARIOS, id)
  );
}

/** Deterministic Mulberry32 PRNG returning uniform values in [0, 1). */
export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAVITY_MPS2 = 9.80665;
const A_ACCEL_MPS2 = 1.05;
const A_BRAKE_MPS2 = 1.2;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Deterministic 1D kinematic & sensor simulator covering all 5 NYC demo scenarios.
 * Supports real-time interval playback (1x/2x/5x, pause/resume) and synchronous step()/generateTrace()
 * for deterministic unit and replay tests.
 */
export class DeterministicSimSource implements SensorSource {
  readonly mode = 'sim' as const;

  private readonly dataset: TransitDataset;
  private readonly sampleRateHz: number;
  private readonly autoLoop: boolean;
  private readonly customSeed?: number;
  private readonly customStartEpochMs?: number;
  private readonly customInitialGpsBurstSec?: number;

  private readonly listeners = new Set<(sample: SensorSample) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private paused = false;
  private speedMultiplier: 1 | 2 | 5 = 1;

  private scenarioId: DemoScenarioId;
  private track!: TrackPolyline;
  private prng!: () => number;
  private spareGaussian: number | null = null;

  private s = 0;
  private speedMps = 0;
  private accelLongMps2 = 0;
  private kinState: 'DWELL' | 'ACCEL' | 'CRUISE' | 'BRAKE' = 'DWELL';
  private dwellRemainingSec = 0;
  private elapsedSimMs = 0;
  private baseEpochMs = DEFAULT_BASE_EPOCH_MS;
  private lastGpsEmitMs = -1_000_000;
  private nextStationIdx = 0;

  constructor(dataset: TransitDataset, options?: SimSensorOptions) {
    this.dataset = dataset;
    this.sampleRateHz = Math.max(1, options?.sampleRateHz ?? 10);
    this.autoLoop = options?.autoLoop ?? true;
    this.customSeed = options?.seed;
    this.customStartEpochMs = options?.startEpochMs;
    this.customInitialGpsBurstSec = options?.initialGpsBurstSec;
    this.scenarioId = isValidDemoScenarioId(options?.scenarioId)
      ? options.scenarioId
      : 'manhattan-bridge';

    this.initScenario(this.scenarioId);
  }

  onSample(cb: (sample: SensorSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const dtSec = 1 / this.sampleRateHz;
    const intervalMs = Math.max(10, Math.round(1000 / this.sampleRateHz));

    this.timer = setInterval(() => {
      if (!this.running || this.paused) return;
      for (let i = 0; i < this.speedMultiplier; i++) {
        const sample = this.step(dtSec);
        this.emit(sample);
      }
    }, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setScenario(id: DemoScenarioId): void {
    if (!isValidDemoScenarioId(id)) {
      return;
    }
    this.scenarioId = id;
    this.initScenario(id);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setSpeedMultiplier(mult: 1 | 2 | 5): void {
    this.speedMultiplier = mult;
  }

  getScenarioId(): DemoScenarioId {
    return this.scenarioId;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getSpeedMultiplier(): 1 | 2 | 5 {
    return this.speedMultiplier;
  }

  /** Synchronously advance simulation by dtSec and return the generated SensorSample. */
  step(dtSec: number): SensorSample {
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, 0.5) : 0.1;
    const cfg = DEMO_SCENARIOS[this.scenarioId];

    this.advanceKinematics(dt, cfg);
    this.elapsedSimMs += dt * 1000;

    const tMs = Math.round(this.baseEpochMs + this.elapsedSimMs);
    const sampled = samplePolylineAtS(this.track.points, this.s);

    // Device frame: upright phone held facing forward along the train.
    // +Y = Up (accelGrav[1] = +9.80665), -Z = Forward (accelLin[2] = -aLong), +X = Right.
    const vibSigma =
      this.speedMps < 0.2 ? 0.025 : 0.12 + 0.025 * this.speedMps;

    const ax = this.nextGaussian(0, vibSigma);
    const ay = this.nextGaussian(0, vibSigma * 0.8);
    const az = -this.accelLongMps2 + this.nextGaussian(0, vibSigma);

    // Curvature is CW-positive (+ = right turn). Around +Up (+Y), CW turn has negative omegaUp.
    const omegaUp = -this.speedMps * sampled.curvature;
    const gyroNoise = this.speedMps < 0.2 ? 0.002 : 0.008;

    const imu: ImuSample = {
      accelLin: [ax, ay, az],
      accelGrav: [ax, ay + GRAVITY_MPS2, az],
      gyroRadS: [
        this.nextGaussian(0, gyroNoise),
        omegaUp + this.nextGaussian(0, gyroNoise),
        this.nextGaussian(0, gyroNoise),
      ],
    };

    const headingDeg = ((sampled.headingRad * RAD_TO_DEG) % 360 + 360) % 360;
    const orientation: OrientationSample = {
      alpha: ((360 - headingDeg) % 360 + 360) % 360,
      beta: 75,
      gamma: 0,
      compassDeg: headingDeg,
    };

    let gps: GpsSample | undefined;
    if (this.elapsedSimMs - this.lastGpsEmitMs >= 999) {
      this.lastGpsEmitMs = this.elapsedSimMs;
      gps = this.synthesizeGps(sampled.enu, sampled.gpsVisibility, headingDeg, cfg);
    }

    return {
      tMs,
      gps,
      imu,
      orientation,
    };
  }

  /** Synchronously generate a deterministic trace of SensorSamples for testing/replay. */
  generateTrace(durationSec: number, dtSec = 1 / this.sampleRateHz): SensorSample[] {
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return [];
    }
    const safeDt =
      Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 1 / this.sampleRateHz;
    const steps = Math.max(1, Math.floor(durationSec / safeDt));
    const samples: SensorSample[] = [];
    for (let i = 0; i < steps; i++) {
      samples.push(this.step(safeDt));
    }
    return samples;
  }

  /** Return exact ground truth kinematics for accuracy assertions in unit tests. */
  getGroundTruth(): SimGroundTruth {
    const cfg = DEMO_SCENARIOS[this.scenarioId];
    const sampled = samplePolylineAtS(this.track.points, this.s);
    return {
      scenarioId: this.scenarioId,
      trackId: this.track.id,
      routeId: cfg.routeId,
      s: this.s,
      speedMps: this.speedMps,
      enu: sampled.enu,
      headingRad: sampled.headingRad,
      pitchRad: sampled.pitchRad,
      curvature: sampled.curvature,
      structure: sampled.structure,
      gpsVisibility: sampled.gpsVisibility,
      state: this.kinState,
      tMs: Math.round(this.baseEpochMs + this.elapsedSimMs),
    };
  }

  private emit(sample: SensorSample): void {
    for (const cb of this.listeners) {
      cb(sample);
    }
  }

  private initScenario(id: DemoScenarioId): void {
    const cfg = DEMO_SCENARIOS[id];
    const foundTrack = this.dataset.trackById.get(cfg.trackId);
    if (!foundTrack) {
      throw new Error(`DeterministicSimSource: track "${cfg.trackId}" not found in dataset`);
    }
    this.track = foundTrack;
    this.prng = createMulberry32(this.customSeed ?? cfg.seed);
    this.spareGaussian = null;

    this.s = Math.max(0, Math.min(cfg.startS, this.track.totalLengthM));
    const initSpeed =
      typeof cfg.initialSpeedMps === 'number' &&
      Number.isFinite(cfg.initialSpeedMps) &&
      cfg.initialSpeedMps > 0
        ? Math.min(cfg.initialSpeedMps, this.getSegmentMaxSpeed(this.s))
        : 0;
    this.speedMps = initSpeed;
    this.accelLongMps2 = 0;
    this.elapsedSimMs = 0;
    this.baseEpochMs = this.customStartEpochMs ?? cfg.baseEpochMs;
    this.lastGpsEmitMs = -1_000_000;

    // Check if starting directly at a station -> short initial dwell (2s), else start underway.
    const atStation = this.track.stations.some((st) => Math.abs(st.s - this.s) <= 20);
    if (initSpeed > 0) {
      this.kinState = 'CRUISE';
      this.dwellRemainingSec = 0;
    } else if (atStation) {
      this.kinState = 'DWELL';
      this.dwellRemainingSec = 2.0;
    } else {
      this.kinState = 'ACCEL';
      this.dwellRemainingSec = 0;
    }

    this.nextStationIdx = this.findNextStationIndex(this.s + 25);
  }

  private findNextStationIndex(fromS: number): number {
    for (let i = 0; i < this.track.stations.length; i++) {
      if (this.track.stations[i].s >= fromS) {
        return i;
      }
    }
    return -1;
  }

  private getSegmentMaxSpeed(s: number): number {
    const pts = this.track.points;
    let maxV =
      this.track.serviceType === 'COMMUTER'
        ? 28
        : this.track.serviceType === 'EXPRESS'
          ? 21
          : 15.5;

    for (let i = 0; i < pts.length - 1; i++) {
      if (s >= pts[i].s && s <= pts[i + 1].s) {
        const segMax = pts[i].maxSpeedMps;
        if (typeof segMax === 'number' && Number.isFinite(segMax)) {
          maxV = segMax;
        }
        break;
      }
    }
    return maxV;
  }

  private advanceKinematics(dt: number, cfg: SimScenarioConfig): void {
    const endS = Math.min(cfg.endS, this.track.totalLengthM);

    if (this.s >= endS - 2) {
      if (this.autoLoop) {
        this.s = Math.max(0, Math.min(cfg.startS, this.track.totalLengthM));
        const initSpeed =
          typeof cfg.initialSpeedMps === 'number' &&
          Number.isFinite(cfg.initialSpeedMps) &&
          cfg.initialSpeedMps > 0
            ? Math.min(cfg.initialSpeedMps, this.getSegmentMaxSpeed(this.s))
            : 0;
        this.speedMps = initSpeed;
        this.accelLongMps2 = 0;
        const atStation = this.track.stations.some(
          (st) => Math.abs(st.s - this.s) <= 20,
        );
        if (initSpeed > 0) {
          this.kinState = 'CRUISE';
          this.dwellRemainingSec = 0;
        } else if (atStation) {
          this.kinState = 'DWELL';
          this.dwellRemainingSec = 2.0;
        } else {
          this.kinState = 'ACCEL';
          this.dwellRemainingSec = 0;
        }
        this.nextStationIdx = this.findNextStationIndex(this.s + 25);
        return;
      } else {
        this.speedMps = 0;
        this.accelLongMps2 = 0;
        this.kinState = 'DWELL';
        return;
      }
    }

    const vMax = this.getSegmentMaxSpeed(this.s);
    const nextStation =
      this.nextStationIdx >= 0 && this.nextStationIdx < this.track.stations.length
        ? this.track.stations[this.nextStationIdx]
        : null;
    const distToNext = nextStation ? nextStation.s - this.s : Infinity;

    switch (this.kinState) {
      case 'DWELL': {
        this.speedMps = 0;
        this.accelLongMps2 = 0;
        this.dwellRemainingSec -= dt;
        if (this.dwellRemainingSec <= 0) {
          this.kinState = 'ACCEL';
          this.nextStationIdx = this.findNextStationIndex(this.s + 25);
        }
        break;
      }
      case 'ACCEL': {
        const stopDist = (this.speedMps * this.speedMps) / (2 * A_BRAKE_MPS2) + 8;
        if (distToNext <= stopDist) {
          this.kinState = 'BRAKE';
          this.accelLongMps2 = -A_BRAKE_MPS2;
        } else {
          this.accelLongMps2 = A_ACCEL_MPS2;
          this.speedMps = Math.min(vMax, this.speedMps + this.accelLongMps2 * dt);
          if (this.speedMps >= vMax - 0.05) {
            this.kinState = 'CRUISE';
            this.accelLongMps2 = 0;
          }
        }
        this.s = Math.min(endS, this.s + this.speedMps * dt);
        break;
      }
      case 'CRUISE': {
        const stopDist = (this.speedMps * this.speedMps) / (2 * A_BRAKE_MPS2) + 8;
        if (distToNext <= stopDist) {
          this.kinState = 'BRAKE';
          this.accelLongMps2 = -A_BRAKE_MPS2;
        } else if (this.speedMps > vMax + 0.2) {
          this.accelLongMps2 = -0.5;
          this.speedMps = Math.max(vMax, this.speedMps + this.accelLongMps2 * dt);
        } else if (this.speedMps < vMax - 0.2) {
          this.accelLongMps2 = 0.5;
          this.speedMps = Math.min(vMax, this.speedMps + this.accelLongMps2 * dt);
        } else {
          this.accelLongMps2 = 0;
        }
        this.s = Math.min(endS, this.s + this.speedMps * dt);
        break;
      }
      case 'BRAKE': {
        if (nextStation && distToNext > 1.5 && this.speedMps > 0.2) {
          const reqDecel = (this.speedMps * this.speedMps) / (2 * Math.max(1, distToNext));
          this.accelLongMps2 = -Math.max(0.5, Math.min(1.5, reqDecel));
        } else {
          this.accelLongMps2 = -A_BRAKE_MPS2;
        }
        this.speedMps = Math.max(0, this.speedMps + this.accelLongMps2 * dt);
        this.s = Math.min(endS, this.s + this.speedMps * dt);

        if (
          this.speedMps <= 0.15 ||
          (nextStation && this.s >= nextStation.s - 1.5)
        ) {
          if (nextStation && Math.abs(nextStation.s - this.s) <= 25) {
            this.s = Math.min(endS, nextStation.s);
          }
          this.speedMps = 0;
          this.accelLongMps2 = 0;
          this.kinState = 'DWELL';
          const stObj = nextStation
            ? this.dataset.stationById.get(nextStation.stationId)
            : undefined;
          this.dwellRemainingSec = stObj?.isHub ? 16 : 11;
          this.nextStationIdx = this.findNextStationIndex(this.s + 25);
        }
        break;
      }
    }
  }

  private synthesizeGps(
    enu: Vec3,
    visibility: GpsVisibility,
    headingDeg: number,
    cfg: SimScenarioConfig,
  ): GpsSample | undefined {
    const burstSec = this.customInitialGpsBurstSec ?? cfg.initialGpsBurstSec;

    if (visibility === 'UNDERGROUND') {
      if (burstSec > 0 && this.elapsedSimMs <= burstSec * 1000) {
        return this.makeNoisyGps(enu, 22, headingDeg);
      }
      return undefined;
    }

    if (visibility === 'PORTAL') {
      if (this.prng() < 0.5) return undefined;
      return this.makeNoisyGps(enu, 35 + this.prng() * 45, headingDeg);
    }

    if (visibility === 'URBAN_CANYON') {
      return this.makeNoisyGps(enu, 25 + this.prng() * 35, headingDeg);
    }

    // OPEN_SKY (bridge / elevated / open cut)
    return this.makeNoisyGps(enu, 8 + this.prng() * 7, headingDeg);
  }

  private makeNoisyGps(
    enu: Vec3,
    accuracyM: number,
    headingDeg: number,
  ): GpsSample {
    const posSigma = accuracyM * 0.35;
    const noisyE = enu[0] + this.nextGaussian(0, posSigma);
    const noisyN = enu[1] + this.nextGaussian(0, posSigma);
    const wgs = enuToWgs84(noisyE, noisyN, enu[2]);
    const noisySpeed = Math.max(0, this.speedMps + this.nextGaussian(0, 0.25));
    const noisyHeading =
      this.speedMps >= 1.5
        ? (((headingDeg + this.nextGaussian(0, 3)) % 360) + 360) % 360
        : undefined;

    return {
      lat: wgs.lat,
      lon: wgs.lon,
      accuracyM,
      speedMps: noisySpeed,
      headingDeg: noisyHeading,
      fixAgeMs: 100,
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
