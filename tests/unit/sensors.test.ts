import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTransitDataset } from '../../src/data/dataset';
import { DeadReckoningEngine } from '../../src/localization/deadReckoning';
import { LiveSensorSource } from '../../src/sensors/liveSensorSource';
import { ReplaySensorSource } from '../../src/sensors/replaySensorSource';
import {
  createMulberry32,
  DEMO_SCENARIOS,
  DeterministicSimSource,
} from '../../src/sensors/simSensorSource';
import type { DemoScenarioId, SensorSample } from '../../src/types/sensors';

const ALL_SCENARIOS: DemoScenarioId[] = [
  'manhattan-bridge',
  'express-overtake',
  'lexington-underground',
  'steinway-queens',
  'midtown-multi-system',
];

describe('Sensors — DeterministicSimSource', () => {
  const dataset = getTransitDataset();

  it('produces identical sample sequences for the same seed and scenario', () => {
    const simA = new DeterministicSimSource(dataset, {
      scenarioId: 'manhattan-bridge',
      seed: 42,
      sampleRateHz: 10,
    });
    const simB = new DeterministicSimSource(dataset, {
      scenarioId: 'manhattan-bridge',
      seed: 42,
      sampleRateHz: 10,
    });

    const traceA = simA.generateTrace(30, 0.1);
    const traceB = simB.generateTrace(30, 0.1);

    expect(traceA.length).toBe(300);
    expect(traceA).toEqual(traceB);

    // Mulberry32 determinism check
    const rng1 = createMulberry32(999);
    const rng2 = createMulberry32(999);
    expect([rng1(), rng1(), rng1()]).toEqual([rng2(), rng2(), rng2()]);
  });

  it('supports all 5 DemoScenarioId values with finite samples and clean start/stop', () => {
    vi.useFakeTimers();
    try {
      for (const scenarioId of ALL_SCENARIOS) {
        expect(DEMO_SCENARIOS[scenarioId]).toBeDefined();
        const sim = new DeterministicSimSource(dataset, {
          scenarioId,
          sampleRateHz: 10,
        });
        expect(sim.mode).toBe('sim');

        const received: SensorSample[] = [];
        const unsub = sim.onSample((s) => received.push(s));
        sim.start();
        vi.advanceTimersByTime(500);
        sim.stop();
        unsub();

        expect(received.length).toBeGreaterThanOrEqual(4);
        for (const s of received) {
          expect(Number.isFinite(s.tMs)).toBe(true);
          expect(s.imu).toBeDefined();
          if (s.imu) {
            expect(s.imu.accelLin.every(Number.isFinite)).toBe(true);
            expect(s.imu.accelGrav.every(Number.isFinite)).toBe(true);
            expect(s.imu.gyroRadS.every(Number.isFinite)).toBe(true);
          }
          if (s.gps) {
            expect(Number.isFinite(s.gps.lat)).toBe(true);
            expect(Number.isFinite(s.gps.lon)).toBe(true);
            expect(Number.isFinite(s.gps.accuracyM)).toBe(true);
          }
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('manhattan-bridge exhibits bridge GPS lock -> Manhattan tunnel dropout, and underground scenarios suppress GPS when burst is disabled', () => {
    const sim = new DeterministicSimSource(dataset, {
      scenarioId: 'manhattan-bridge',
      autoLoop: false,
      sampleRateHz: 10,
    });

    let sawBridgeGpsLock = false;
    let sawPostBridgeTunnelNoGps = false;

    for (let i = 0; i < 3000; i++) {
      const sample = sim.step(0.1);
      const gt = sim.getGroundTruth();

      if (
        gt.structure === 'BRIDGE' &&
        sample.gps &&
        sample.gps.accuracyM < 30
      ) {
        sawBridgeGpsLock = true;
      }
      if (
        sawBridgeGpsLock &&
        gt.s > 3100 &&
        gt.gpsVisibility === 'UNDERGROUND' &&
        !sample.gps
      ) {
        sawPostBridgeTunnelNoGps = true;
        break;
      }
    }

    expect(sawBridgeGpsLock).toBe(true);
    expect(sawPostBridgeTunnelNoGps).toBe(true);

    // Underground scenario with initialGpsBurstSec: 0 suppresses GPS
    const undergroundSim = new DeterministicSimSource(dataset, {
      scenarioId: 'lexington-underground',
      autoLoop: false,
      sampleRateHz: 10,
      initialGpsBurstSec: 0,
    });
    let sawUndergroundNoGps = false;
    for (let i = 0; i < 50; i++) {
      const sample = undergroundSim.step(0.1);
      const gt = undergroundSim.getGroundTruth();
      if (gt.gpsVisibility === 'UNDERGROUND' && !sample.gps) {
        sawUndergroundNoGps = true;
        break;
      }
    }
    expect(sawUndergroundNoGps).toBe(true);
  });

  it('manhattan-bridge starts elevated (> 10 ft) and descends underground (< 0 ft) within 20s at 1x speed', () => {
    const M_TO_FT = 3.28084;
    const sim = new DeterministicSimSource(dataset, {
      scenarioId: 'manhattan-bridge',
      autoLoop: false,
      sampleRateHz: 10,
    });

    const initialGt = sim.getGroundTruth();
    const initialElevationFt = initialGt.enu[2] * M_TO_FT;
    expect(initialElevationFt).toBeGreaterThan(10);
    expect(initialGt.structure).toBe('BRIDGE');

    let maxElevationFt = initialElevationFt;
    let minElevationFt = initialElevationFt;
    let firstUndergroundSec: number | null = null;

    // 200 ticks * 0.1s = 20s of 1x simulation time
    for (let i = 1; i <= 200; i++) {
      sim.step(0.1);
      const gt = sim.getGroundTruth();
      const elevFt = gt.enu[2] * M_TO_FT;
      if (elevFt > maxElevationFt) maxElevationFt = elevFt;
      if (elevFt < minElevationFt) minElevationFt = elevFt;
      if (firstUndergroundSec === null && elevFt < 0) {
        firstUndergroundSec = i * 0.1;
      }
    }

    expect(maxElevationFt).toBeGreaterThan(10);
    expect(minElevationFt).toBeLessThan(0);
    expect(firstUndergroundSec).not.toBeNull();
    expect(firstUndergroundSec!).toBeLessThanOrEqual(20);
  });

  it('honors setPaused, setSpeedMultiplier (1/2/5), and setScenario', () => {
    vi.useFakeTimers();
    try {
      const sim1 = new DeterministicSimSource(dataset, {
        scenarioId: 'manhattan-bridge',
        sampleRateHz: 10,
      });
      const sim5 = new DeterministicSimSource(dataset, {
        scenarioId: 'manhattan-bridge',
        sampleRateHz: 10,
      });
      const startS = sim1.getGroundTruth().s;
      sim5.setSpeedMultiplier(5);

      sim1.start();
      sim5.start();
      vi.advanceTimersByTime(10_000);

      const d1 = sim1.getGroundTruth().s - startS;
      const d5 = sim5.getGroundTruth().s - startS;
      expect(d5).toBeGreaterThan(d1 * 2);

      // Pause stops advancing
      sim1.setPaused(true);
      const sBeforePause = sim1.getGroundTruth().s;
      vi.advanceTimersByTime(5_000);
      expect(sim1.getGroundTruth().s).toBe(sBeforePause);

      // Scenario switch resets track & ground truth
      sim1.setScenario('steinway-queens');
      expect(sim1.getGroundTruth().trackId).toBe('mta-7-local-outbound');
      expect(sim1.getGroundTruth().routeId).toBe('7');

      sim1.stop();
      sim5.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Sensors — ReplaySensorSource', () => {
  it('replays samples in timestamp order, honors unsubscribe and stop', () => {
    const samples: SensorSample[] = [
      { tMs: 2000, gps: { lat: 40.75, lon: -73.99, accuracyM: 12, fixAgeMs: 0 } },
      { tMs: 1000, gps: { lat: 40.74, lon: -73.99, accuracyM: 12, fixAgeMs: 0 } },
      { tMs: 3000, gps: { lat: 40.76, lon: -73.99, accuracyM: 12, fixAgeMs: 0 } },
    ];

    const replay = new ReplaySensorSource(samples);
    expect(replay.mode).toBe('replay');

    const received: number[] = [];
    const unsub = replay.onSample((s) => received.push(s.tMs));
    replay.replayAll();
    expect(received).toEqual([1000, 2000, 3000]);

    // Unsubscribe stops further delivery
    unsub();
    replay.reset();
    replay.replayAll();
    expect(received).toEqual([1000, 2000, 3000]);
  });

  it('supports timed playback with start/stop and fake timers', () => {
    vi.useFakeTimers();
    try {
      const samples: SensorSample[] = [
        { tMs: 1000 },
        { tMs: 2000 },
        { tMs: 3000 },
      ];
      const replay = new ReplaySensorSource(samples);
      const received: number[] = [];
      replay.onSample((s) => received.push(s.tMs));

      replay.start();
      vi.advanceTimersByTime(1100);
      replay.stop();
      vi.advanceTimersByTime(5000);

      expect(received).toEqual([1000, 2000]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Sensors — LiveSensorSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never calls iOS requestPermission in constructor/start and exposes explicit requestPermission()', async () => {
    const motionReq = vi.fn().mockResolvedValue('granted');
    const orientReq = vi.fn().mockResolvedValue('granted');
    const watchPosition = vi.fn().mockReturnValue(7);
    const clearWatch = vi.fn();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();

    vi.stubGlobal('DeviceMotionEvent', { requestPermission: motionReq });
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission: orientReq });
    vi.stubGlobal('navigator', {
      geolocation: { watchPosition, clearWatch },
    });
    vi.stubGlobal('window', { addEventListener, removeEventListener });

    const live = new LiveSensorSource();
    expect(live.mode).toBe('live');
    expect(motionReq).not.toHaveBeenCalled();
    expect(orientReq).not.toHaveBeenCalled();

    live.start();
    expect(motionReq).not.toHaveBeenCalled();
    expect(orientReq).not.toHaveBeenCalled();
    expect(watchPosition).toHaveBeenCalledTimes(1);

    const perm = await live.requestPermission();
    expect(perm).toBe('granted');
    expect(motionReq).toHaveBeenCalledTimes(1);
    expect(orientReq).toHaveBeenCalledTimes(1);

    live.stop();
    expect(clearWatch).toHaveBeenCalledWith(7);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('emits gpsErrorCode 1, 2, 3 for GeolocationPositionError callbacks', () => {
    let errorCb: ((err: GeolocationPositionError) => void) | null = null;
    vi.stubGlobal('navigator', {
      geolocation: {
        watchPosition: vi.fn((_ok, err) => {
          errorCb = err;
          return 1;
        }),
        clearWatch: vi.fn(),
      },
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const live = new LiveSensorSource();
    const codes: Array<number | undefined> = [];
    live.onSample((s) => codes.push(s.gpsErrorCode));

    live.start();
    expect(errorCb).not.toBeNull();

    errorCb!({ code: 1 } as GeolocationPositionError);
    errorCb!({ code: 2 } as GeolocationPositionError);
    errorCb!({ code: 3 } as GeolocationPositionError);

    expect(codes).toEqual([1, 2, 3]);
    live.stop();
  });

  it('normalizes W3C DeviceMotionEvent rotationRate (beta=X, gamma=Y, alpha=Z) to rad/s aligned with DeadReckoningEngine, plus DeviceOrientationEvent and GeolocationPosition', () => {
    let geoSuccessCb: ((pos: GeolocationPosition) => void) | null = null;
    const listeners = new Map<string, EventListener>();

    vi.stubGlobal('navigator', {
      geolocation: {
        watchPosition: vi.fn((ok) => {
          geoSuccessCb = ok;
          return 42;
        }),
        clearWatch: vi.fn(),
      },
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, cb: EventListener) => {
        listeners.set(type, cb);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    });

    const live = new LiveSensorSource();
    const received: SensorSample[] = [];
    live.onSample((s) => received.push(s));
    live.start();

    // 1. DeviceMotionEvent — W3C rotationRate deg/s -> rad/s with [beta, gamma, alpha] -> [omega_x, omega_y, omega_z]
    const motionHandler = listeners.get('devicemotion');
    expect(motionHandler).toBeDefined();

    // Upright phone: gravity along +Y, yaw around +Y is rotationRate.gamma
    motionHandler!({
      acceleration: { x: 0.1, y: 0.2, z: -0.9 },
      accelerationIncludingGravity: { x: 0, y: 9.80665, z: 0 },
      rotationRate: { alpha: 90, beta: 30, gamma: -45 },
    } as unknown as DeviceMotionEvent);

    const uprightSample = received.at(-1)!;
    expect(uprightSample.imu).toBeDefined();
    const DEG_TO_RAD = Math.PI / 180;
    expect(uprightSample.imu!.gyroRadS[0]).toBeCloseTo(30 * DEG_TO_RAD, 6); // beta -> omega_x
    expect(uprightSample.imu!.gyroRadS[1]).toBeCloseTo(-45 * DEG_TO_RAD, 6); // gamma -> omega_y
    expect(uprightSample.imu!.gyroRadS[2]).toBeCloseTo(90 * DEG_TO_RAD, 6); // alpha -> omega_z

    // Verify alignment with DeadReckoningEngine.update() when upright (+Y = Up):
    // yawRateCwRadS = -dot(gyro, gHat) = -omega_y = -(-45 deg/s) = +45 deg/s
    const drUpright = new DeadReckoningEngine();
    const drOutUpright = drUpright.update(uprightSample, 'live');
    expect(drOutUpright.yawRateCwRadS).toBeCloseTo(45 * DEG_TO_RAD, 5);

    // Flat phone: gravity along +Z, yaw around +Z is rotationRate.alpha
    motionHandler!({
      acceleration: { x: 0.0, y: 0.0, z: 0.0 },
      accelerationIncludingGravity: { x: 0, y: 0, z: 9.80665 },
      rotationRate: { alpha: -60, beta: 15, gamma: 20 },
    } as unknown as DeviceMotionEvent);

    const flatSample = received.at(-1)!;
    expect(flatSample.imu!.gyroRadS[0]).toBeCloseTo(15 * DEG_TO_RAD, 6); // beta -> omega_x
    expect(flatSample.imu!.gyroRadS[1]).toBeCloseTo(20 * DEG_TO_RAD, 6); // gamma -> omega_y
    expect(flatSample.imu!.gyroRadS[2]).toBeCloseTo(-60 * DEG_TO_RAD, 6); // alpha -> omega_z

    const drFlat = new DeadReckoningEngine();
    const drOutFlat = drFlat.update(flatSample, 'live');
    // yawRateCwRadS = -dot(gyro, [0,0,1]) = -omega_z = -(-60 deg/s) = +60 deg/s
    expect(drOutFlat.yawRateCwRadS).toBeCloseTo(60 * DEG_TO_RAD, 5);

    // 2. DeviceOrientationEvent (absolute alpha -> compassDeg)
    const orientHandler = listeners.get('deviceorientation');
    expect(orientHandler).toBeDefined();
    orientHandler!({
      alpha: 270,
      beta: 75,
      gamma: -5,
      absolute: true,
    } as unknown as DeviceOrientationEvent);

    const orientSample = received.at(-1)!;
    expect(orientSample.orientation).toEqual({
      alpha: 270,
      beta: 75,
      gamma: -5,
      compassDeg: 90,
    });

    // 3. GeolocationPosition success callback
    expect(geoSuccessCb).not.toBeNull();
    const now = Date.now();
    geoSuccessCb!({
      coords: {
        latitude: 40.7505,
        longitude: -73.9934,
        accuracy: 12.5,
        speed: 14.2,
        heading: 28.5,
        altitude: null,
        altitudeAccuracy: null,
      },
      timestamp: now - 250,
    } as GeolocationPosition);

    const gpsSample = received.at(-1)!;
    expect(gpsSample.gps).toBeDefined();
    expect(gpsSample.gps!.lat).toBeCloseTo(40.7505, 6);
    expect(gpsSample.gps!.lon).toBeCloseTo(-73.9934, 6);
    expect(gpsSample.gps!.accuracyM).toBe(12.5);
    expect(gpsSample.gps!.speedMps).toBe(14.2);
    expect(gpsSample.gps!.headingDeg).toBe(28.5);
    expect(gpsSample.gps!.fixAgeMs).toBeGreaterThanOrEqual(0);
    expect(gpsSample.gps!.fixAgeMs).toBeLessThan(2000);

    live.stop();
  });
});
