import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SceneManagerLike, SubwaySightApp } from '../../src/app';
import {
  getTransitDataset,
  projectPointOntoTrack,
} from '../../src/data/dataset';
import { buildTrackPoints, samplePolylineAtS } from '../../src/geo/projection';
import { DeadReckoningEngine } from '../../src/localization/deadReckoning';
import { GpsFilter } from '../../src/localization/gpsFilter';
import { TrackParticleFilter } from '../../src/localization/particleFilter';
import {
  classifyServicePeriod,
  estimateNextStationAndEta,
  evaluateTimetablePhaseLogLikelihood,
  getActiveScheduleContexts,
} from '../../src/localization/scheduleModel';
import {
  clearCalibration,
  DEFAULT_SETTINGS,
  loadLatestCalibration,
  loadSettings,
  resetStorageForTests,
  saveCalibration,
  saveSettings,
} from '../../src/pwa/storage';
import { CameraController } from '../../src/render/CameraController';
import { LandmarkLayer } from '../../src/render/LandmarkLayer';
import type { SceneManagerOptions } from '../../src/render/SceneManager';
import { StructureLayer } from '../../src/render/StructureLayer';
import { TrackLayer } from '../../src/render/TrackLayer';
import { LiveSensorSource } from '../../src/sensors/liveSensorSource';
import { ReplaySensorSource } from '../../src/sensors/replaySensorSource';
import {
  DEMO_SCENARIOS,
  DeterministicSimSource,
  isValidDemoScenarioId,
} from '../../src/sensors/simSensorSource';
import {
  buildWorldStateSnapshot,
  computeNearbyTrains,
} from '../../src/traffic/trafficEngine';
import type { DemoScenarioId, SensorSample } from '../../src/types/sensors';
import type { EstimatorState, WorldStateSnapshot } from '../../src/types/state';
import type {
  ServicePeriod,
  TrackPolyline,
  TransitDataset,
} from '../../src/types/transit';
import { type HudCallbacks, HudController } from '../../src/ui/HudController';

// ---------------------------------------------------------------------------
// Shared lightweight DOM & browser stubs for Node-environment unit tests
// ---------------------------------------------------------------------------

class MockEvent {
  readonly type: string;
  propagationStopped = false;
  constructor(type: string) {
    this.type = type;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class MockClassList {
  private readonly set = new Set<string>();
  add(...tokens: string[]): void {
    for (const t of tokens) if (t) this.set.add(t);
  }
  remove(...tokens: string[]): void {
    for (const t of tokens) this.set.delete(t);
  }
  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.set.add(token);
      return true;
    }
    if (force === false) {
      this.set.delete(token);
      return false;
    }
    if (this.set.has(token)) {
      this.set.delete(token);
      return false;
    }
    this.set.add(token);
    return true;
  }
  contains(token: string): boolean {
    return this.set.has(token);
  }
  toString(): string {
    return Array.from(this.set).join(' ');
  }
}

class MockElement {
  readonly tagName: string;
  readonly ownerDocument: MockDocument;
  parentNode: MockElement | null = null;
  readonly children: MockElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly classList = new MockClassList();
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  textContent = '';
  hidden = false;
  type = '';
  value = '';

  constructor(tagName: string, ownerDocument: MockDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(val: string) {
    for (const part of val.split(/\s+/)) {
      if (part) this.classList.add(part);
    }
  }

  get firstChild(): MockElement | null {
    return this.children[0] ?? null;
  }

  appendChild(child: MockElement): MockElement {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === 'SELECT' && this.children.length === 1 && !this.value) {
      this.value = child.value;
    }
    return child;
  }

  removeChild(child: MockElement): MockElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(cb);
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  setPointerCapture(_pointerId: number): void {
    // no-op stub
  }

  releasePointerCapture(_pointerId: number): void {
    // no-op stub
  }

  dispatchEvent(ev: MockEvent | Record<string, unknown>): boolean {
    const type = (ev as { type: string }).type;
    let curr: MockElement | null = this;
    while (curr && !(ev as MockEvent).propagationStopped) {
      const set = curr.listeners.get(type);
      if (set) {
        for (const fn of Array.from(set)) {
          fn(ev);
        }
      }
      curr = curr.parentNode;
    }
    return true;
  }

  click(): void {
    this.dispatchEvent(new MockEvent('click'));
  }

  findByTestId(testId: string): MockElement | null {
    if (this.attributes.get('data-testid') === testId) return this;
    for (const child of this.children) {
      const found = child.findByTestId(testId);
      if (found) return found;
    }
    return null;
  }
}

class MockDocument {
  createElement(tag: string): MockElement {
    return new MockElement(tag, this);
  }
}

function makeFakeSceneManager(): SceneManagerLike & {
  setGyroEnabledMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
} {
  let viewMode = 'inside';
  let frameCount = 0;
  const setGyroEnabledMock = vi.fn();
  const disposeMock = vi.fn();
  return {
    setGyroEnabledMock,
    disposeMock,
    update: vi.fn(() => {
      frameCount++;
    }),
    setViewMode: vi.fn((m) => {
      viewMode = m;
    }),
    setGyroEnabled: setGyroEnabledMock,
    handleDeviceOrientation: vi.fn(),
    resetCameraView: vi.fn(),
    getCameraDebug: () => ({
      yaw: 0,
      pitch: 0,
      position: [0, 2, 0],
      viewMode,
      drawCalls: 20,
      frameCount,
    }),
    dispose: disposeMock,
  };
}

function makeMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (idx: number) => Array.from(store.keys())[idx] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
}

function setupBasicWindowStubs(ls: Storage = makeMemoryLocalStorage()): {
  winListeners: Map<string, Set<(ev: unknown) => void>>;
} {
  const winListeners = new Map<string, Set<(ev: unknown) => void>>();
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, cb: (ev: unknown) => void) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)!.add(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: (ev: unknown) => void) => {
      winListeners.get(type)?.delete(cb);
    }),
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return { winListeners };
}

function makeBaseEgo(overrides?: Partial<EstimatorState>): EstimatorState {
  return {
    routeId: 'D',
    serviceType: 'EXPRESS',
    direction: 'UPTOWN',
    displayLabel: 'D Express — Uptown',
    confidencePct: 90,
    candidates: [],
    currentStationId: 'mta-grand-st',
    currentStationName: 'Grand St',
    nextStationId: 'mta-broadway-lafayette',
    nextStationName: 'Broadway-Lafayette St',
    etaSec: 45,
    positionEnu: [0, 0, -15],
    positionLatLng: { lat: 40.7549, lon: -73.984 },
    headingRad: 0,
    pitchRad: 0,
    speedMps: 12,
    speedMph: 26.8,
    elevationM: -15,
    elevationFt: -49.2,
    structure: 'UNDERGROUND_TUNNEL',
    outOfNyc: false,
    manualAnchorActive: false,
    trackId: 'mta-6ave-exp-up',
    trackS: 1000,
    sensorStatus: { gps: 'locked', dr: 'active', timing: 'active' },
    ...overrides,
  };
}

afterEach(() => {
  resetStorageForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ===========================================================================
// PART 1: CORE ENGINE ADVERSARIAL & REGRESSION TESTS (Bugs 1–7)
// ===========================================================================

describe('Tier 5 Adversarial — Core Engine', () => {
  const dataset = getTransitDataset();

  describe('projection.ts edge cases (Bug 7)', () => {
    it('clamps +Infinity to sMax and -Infinity/NaN to sMin', () => {
      const track = dataset.tracks[0];
      const sMin = track.points[0].s;
      const sMax = track.points[track.points.length - 1].s;

      const atPosInf = samplePolylineAtS(track.points, Infinity);
      expect(atPosInf.s).toBeCloseTo(sMax, 5);
      expect(atPosInf.enu.every(Number.isFinite)).toBe(true);

      const atNegInf = samplePolylineAtS(track.points, -Infinity);
      expect(atNegInf.s).toBeCloseTo(sMin, 5);

      const atNaN = samplePolylineAtS(track.points, Number.NaN);
      expect(atNaN.s).toBeCloseTo(sMin, 5);
    });

    it('handles empty buildTrackPoints, zero-length polylines, and purely vertical segments with finite outputs', () => {
      expect(buildTrackPoints([])).toEqual([]);

      const duplicatePts = buildTrackPoints([
        {
          lat: 40.7549,
          lon: -73.984,
          elevM: -10,
          structure: 'UNDERGROUND_TUNNEL',
          gpsVisibility: 'UNDERGROUND',
        },
        {
          lat: 40.7549,
          lon: -73.984,
          elevM: -10,
          structure: 'UNDERGROUND_TUNNEL',
          gpsVisibility: 'UNDERGROUND',
        },
        {
          lat: 40.7549,
          lon: -73.984,
          elevM: -10,
          structure: 'UNDERGROUND_TUNNEL',
          gpsVisibility: 'UNDERGROUND',
        },
      ]);
      const sampledDup = samplePolylineAtS(duplicatePts, 0);
      expect(sampledDup.enu.every(Number.isFinite)).toBe(true);
      expect(sampledDup.tangentEnu.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(sampledDup.headingRad)).toBe(true);
      expect(Number.isFinite(sampledDup.pitchRad)).toBe(true);
      expect(Number.isFinite(sampledDup.curvature)).toBe(true);

      const verticalPts = buildTrackPoints([
        {
          lat: 40.7549,
          lon: -73.984,
          elevM: -30,
          structure: 'UNDERGROUND_TUNNEL',
          gpsVisibility: 'UNDERGROUND',
        },
        {
          lat: 40.7549,
          lon: -73.984,
          elevM: 10,
          structure: 'ELEVATED',
          gpsVisibility: 'OPEN_SKY',
        },
      ]);
      const sampledVert = samplePolylineAtS(verticalPts, 20);
      expect(sampledVert.enu.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(sampledVert.headingRad)).toBe(true);
      expect(Number.isFinite(sampledVert.pitchRad)).toBe(true);
      expect(sampledVert.pitchRad).toBeCloseTo(Math.PI / 2, 4);
    });
  });

  describe('GpsFilter non-finite timestamp & extreme coordinates (Bug 2)', () => {
    it('never poisons lastGoodFixTimeMs on NaN tMs and still transitions to lost underground', () => {
      const gf = new GpsFilter();
      const validGps = {
        lat: 40.7549,
        lon: -73.984,
        accuracyM: 15,
        fixAgeMs: 100,
      };

      // First sample has NaN tMs
      const r0 = gf.update({ tMs: Number.NaN, gps: validGps }, true, 'live');
      expect(r0.status).toBe('locked');

      // Subsequent GPS-less ticks while moving must NOT remain permanently 'locked'
      const r1 = gf.update({ tMs: 100_000 }, true, 'live');
      expect(r1.status).toBe('lost');
      expect(r1.hasNegativeTunnelEvidence).toBe(true);
      expect(Number.isNaN(r1.timeSinceLastGoodFixMs)).toBe(false);

      // Valid fix followed by NaN tMs fix followed by 30s GPS loss
      gf.update({ tMs: 200_000, gps: validGps }, true, 'live');
      gf.update({ tMs: Number.NaN, gps: validGps }, true, 'live');
      const r2 = gf.update({ tMs: 230_000 }, true, 'live');
      expect(r2.status).toBe('lost');
      expect(r2.hasNegativeTunnelEvidence).toBe(true);
    });

    it('rejects Infinity fixAgeMs as stale, rejects accuracyM <= 0, and flags poles/antimeridian as outOfNyc', () => {
      const gf = new GpsFilter();

      // fixAgeMs === Infinity must NOT be treated as brand-new (0 ms)
      const staleInf = gf.update(
        {
          tMs: 10_000,
          gps: {
            lat: 40.7549,
            lon: -73.984,
            accuracyM: 10,
            fixAgeMs: Infinity,
          },
        },
        true,
        'live',
      );
      expect(staleInf.acceptedForHardUpdate).toBe(false);
      expect(staleInf.acceptedForSoftPrior).toBe(false);

      // accuracyM <= 0 must be ignored
      const zeroAcc = gf.update(
        {
          tMs: 11_000,
          gps: { lat: 40.7549, lon: -73.984, accuracyM: 0, fixAgeMs: 0 },
        },
        false,
        'live',
      );
      expect(zeroAcc.acceptedForHardUpdate).toBe(false);

      // Extreme poles and antimeridian
      for (const [lat, lon] of [
        [90, 0],
        [-90, 0],
        [0, 180],
        [0, -180],
      ]) {
        const res = gf.update(
          {
            tMs: 12_000,
            gps: { lat, lon, accuracyM: 25, fixAgeMs: 0 },
          },
          false,
          'live',
        );
        expect(res.outOfNyc).toBe(true);
        expect(res.acceptedForHardUpdate).toBe(false);
      }
    });
  });

  describe('DeadReckoningEngine backward timestamps, NaN tMs & extreme IMU (Bug 3)', () => {
    it('evicts stale vibWindow on backward timestamp jump so ZUPT/dwell detection works', () => {
      const dr = new DeadReckoningEngine();
      // High vibration tick at t = 10_000
      dr.update(
        {
          tMs: 10_000,
          imu: {
            accelLin: [3.0, 0, 2.0],
            accelGrav: [0, 9.81, 0],
            gyroRadS: [0, 0, 0],
          },
        },
        'live',
      );

      // Backward clock jump to t = 5_000, followed by 2.0s completely stationary
      let lastOut = dr.update(
        {
          tMs: 5_000,
          imu: {
            accelLin: [0, 0, 0],
            accelGrav: [0, 9.81, 0],
            gyroRadS: [0, 0, 0],
          },
        },
        'live',
      );
      for (let i = 1; i <= 20; i++) {
        lastOut = dr.update(
          {
            tMs: 5_000 + i * 100,
            imu: {
              accelLin: [0, 0, 0],
              accelGrav: [0, 9.81, 0],
              gyroRadS: [0, 0, 0],
            },
          },
          'live',
        );
      }
      expect(lastOut.vibrationRms).toBeLessThan(0.05);
      expect(lastOut.isDwelling).toBe(true);
    });

    it('handles NaN tMs, zero gravity vector, extreme IMU values, and NaN IMU components', () => {
      const dr = new DeadReckoningEngine();
      const out1 = dr.update(
        {
          tMs: Number.NaN,
          imu: {
            accelLin: [1e6, -1e6, 1e6],
            accelGrav: [0, 0, 0],
            gyroRadS: [100, -100, 100],
          },
        },
        'live',
      );
      expect(Number.isFinite(out1.speedMps)).toBe(true);
      expect(Number.isFinite(out1.deltaSM)).toBe(true);
      expect(Number.isFinite(out1.yawRateCwRadS)).toBe(true);

      const out2 = dr.update(
        {
          tMs: 1000,
          imu: {
            accelLin: [Number.NaN, 0, 0],
            accelGrav: [0, 9.81, 0],
            gyroRadS: [0, 0, 0],
          },
        },
        'live',
      );
      expect(Number.isFinite(out2.speedMps)).toBe(true);
      expect(Number.isFinite(out2.vibrationRms)).toBe(true);
    });
  });

  describe('scheduleModel.ts NaN timestamp, DST/midnight & sparse tracks (Bug 7)', () => {
    it('returns 0 in evaluateTimetablePhaseLogLikelihood for NaN/Infinity inputs', () => {
      const ctxs = getActiveScheduleContexts(dataset, 'WEEKDAY_AM_RUSH');
      expect(ctxs.length).toBeGreaterThan(0);
      expect(
        evaluateTimetablePhaseLogLikelihood(ctxs[0], 1000, Number.NaN),
      ).toBe(0);
      expect(
        evaluateTimetablePhaseLogLikelihood(ctxs[0], 1000, Infinity),
      ).toBe(0);
      expect(
        evaluateTimetablePhaseLogLikelihood(ctxs[0], Number.NaN, Date.now()),
      ).toBe(0);
    });

    it('classifies DST transitions and midnight rollovers cleanly and handles 0/1-station tracks', () => {
      // Spring-forward 2026-03-08 02:30 AM EDT (06:30 UTC) -> LATE_NIGHT
      expect(classifyServicePeriod(Date.UTC(2026, 2, 8, 7, 30, 0))).toBe(
        'LATE_NIGHT',
      );
      // Midnight weekday (2026-06-10 00:05 EDT = 04:05 UTC) -> LATE_NIGHT
      expect(classifyServicePeriod(Date.UTC(2026, 5, 10, 4, 5, 0))).toBe(
        'LATE_NIGHT',
      );

      const ctxs = getActiveScheduleContexts(dataset, 'WEEKDAY_AM_RUSH');
      const baseCtx = ctxs[0];
      const zeroStationTrack: TrackPolyline = {
        ...baseCtx.effectiveTrack,
        stations: [],
      };
      const zeroEta = estimateNextStationAndEta(
        { ...baseCtx, effectiveTrack: zeroStationTrack },
        500,
        10,
        dataset,
      );
      expect(zeroEta.currentStationId).toBeNull();
      expect(zeroEta.nextStationId).toBeNull();
      expect(zeroEta.etaSec).toBeNull();

      const oneStationTrack: TrackPolyline = {
        ...baseCtx.effectiveTrack,
        stations: [baseCtx.effectiveTrack.stations[0]],
      };
      const oneEta = estimateNextStationAndEta(
        { ...baseCtx, effectiveTrack: oneStationTrack },
        0,
        10,
        dataset,
      );
      expect(oneEta.currentStationId).toBe(
        oneStationTrack.stations[0].stationId,
      );
    });
  });

  describe('TrackParticleFilter empty calibration, NaN tMs & extreme dt (Bug 5)', () => {
    it('treats empty manual calibration {} and { direction: UNKNOWN } as no-ops', () => {
      const pf = new TrackParticleFilter(dataset);
      const before = pf.getState();

      const afterEmpty = pf.setManualCalibration({});
      expect(afterEmpty.manualAnchorActive).toBe(false);
      expect(afterEmpty).toBe(before);

      const afterUnknownDir = pf.setManualCalibration({
        direction: 'UNKNOWN',
      });
      expect(afterUnknownDir.manualAnchorActive).toBe(false);

      const afterBogus = pf.setManualCalibration({
        stationId: 'nonexistent-station-xyz',
        routeId: 'ZZZ',
      });
      expect(afterBogus.manualAnchorActive).toBe(false);
    });

    it('handles inactive B route during LATE_NIGHT, NaN tMs, extreme dt, and empty schedules', () => {
      const pf = new TrackParticleFilter(dataset);
      // Late night timestamp (02:00 EDT) -> B train is inactive, fallback should still calibrate
      const lateNightMs = Date.UTC(2026, 5, 10, 6, 0, 0);
      const calState = pf.setManualCalibration({ routeId: 'B' }, lateNightMs);
      expect(calState.manualAnchorActive).toBe(true);
      expect(calState.routeId).toBe('B');
      pf.resetCalibration();

      // NaN tMs must not poison GPS staleness
      pf.step(
        {
          tMs: Number.NaN,
          gps: { lat: 40.7549, lon: -73.984, accuracyM: 15, fixAgeMs: 0 },
        },
        'live',
      );
      // Extreme dt: 0, negative, +1e7s
      for (const tMs of [100_000, 100_000, 90_000, 10_000_000_000]) {
        const st = pf.step({ tMs }, 'live');
        expect(st.positionEnu.every(Number.isFinite)).toBe(true);
        expect(Number.isFinite(st.confidencePct)).toBe(true);
      }

      // Empty dataset.schedules
      const emptySchedDataset: TransitDataset = {
        ...dataset,
        schedules: [],
      };
      const emptyPf = new TrackParticleFilter(emptySchedDataset);
      const st = emptyPf.step({ tMs: Date.now() }, 'live');
      expect(st.positionEnu.every(Number.isFinite)).toBe(true);
      expect(st.sensorStatus.timing).toBe('degraded');
    });
  });

  describe('LiveSensorSource NaN events, permission denial & missing geolocation (Bug 4)', () => {
    it('drops all-NaN DeviceMotion and DeviceOrientation events instead of emitting synthetic zeros', () => {
      const { winListeners } = setupBasicWindowStubs();
      const src = new LiveSensorSource();
      const samples: SensorSample[] = [];
      src.onSample((s) => samples.push(s));
      src.start();

      // Dispatch all-NaN devicemotion
      const motionEv = {
        acceleration: { x: Number.NaN, y: Number.NaN, z: Number.NaN },
        accelerationIncludingGravity: {
          x: Number.NaN,
          y: Number.NaN,
          z: Number.NaN,
        },
        rotationRate: {
          alpha: Number.NaN,
          beta: Number.NaN,
          gamma: Number.NaN,
        },
      };
      for (const cb of winListeners.get('devicemotion') ?? []) {
        cb(motionEv);
      }

      // Dispatch all-NaN deviceorientation
      const orientEv = {
        alpha: Number.NaN,
        beta: Number.NaN,
        gamma: Number.NaN,
      };
      for (const cb of winListeners.get('deviceorientation') ?? []) {
        cb(orientEv);
      }

      // Filter out only IMU/orientation samples (missing geolocation emits gpsErrorCode: 2)
      const imuOrOrient = samples.filter((s) => s.imu || s.orientation);
      expect(imuOrOrient).toHaveLength(0);

      // Missing navigator.geolocation must emit gpsErrorCode: 2
      expect(samples.some((s) => s.gpsErrorCode === 2)).toBe(true);

      src.stop();
    });

    it('resolves requestMotionPermission to denied when iOS requestPermission rejects', async () => {
      setupBasicWindowStubs();
      vi.stubGlobal('DeviceMotionEvent', {
        requestPermission: vi.fn(() => Promise.reject(new Error('denied'))),
      });
      vi.stubGlobal('DeviceOrientationEvent', {
        requestPermission: vi.fn(() => Promise.resolve('granted')),
      });
      const src = new LiveSensorSource();
      const res = await src.requestMotionPermission();
      expect(res).toBe('denied');
    });
  });

  describe('DeterministicSimSource & ReplaySensorSource edge cases (Bug 6)', () => {
    it('preserves initialSpeedMps and CRUISE state on manhattan-bridge autoLoop wraparound', () => {
      const sim = new DeterministicSimSource(dataset, {
        scenarioId: 'manhattan-bridge',
        autoLoop: true,
        sampleRateHz: 10,
      });

      const startS = DEMO_SCENARIOS['manhattan-bridge'].startS;
      let prevS = sim.getGroundTruth().s;
      let wrappedTruth = null;

      // Advance until s wraps back near startS
      for (let i = 0; i < 4000; i++) {
        sim.step(0.5);
        const gt = sim.getGroundTruth();
        if (gt.s < prevS - 500) {
          wrappedTruth = gt;
          break;
        }
        prevS = gt.s;
      }

      expect(wrappedTruth).not.toBeNull();
      expect(wrappedTruth!.s).toBeCloseTo(startS, 0);
      expect(wrappedTruth!.state).toBe('CRUISE');
      expect(wrappedTruth!.speedMps).toBeGreaterThan(5);
    });

    it('guards generateTrace against dtSec <= 0 and non-finite durationSec, and guards setScenario', () => {
      const sim = new DeterministicSimSource(dataset, {
        scenarioId: 'manhattan-bridge',
      });
      expect(sim.generateTrace(0, 0.1)).toEqual([]);
      expect(sim.generateTrace(-5, 0.1)).toEqual([]);
      expect(sim.generateTrace(Number.NaN, 0.1)).toEqual([]);

      // dtSec === 0 must fall back to default dt instead of infinite-looping
      const trace = sim.generateTrace(1, 0);
      expect(trace.length).toBeGreaterThan(0);
      expect(trace.length).toBeLessThanOrEqual(20);

      // Unknown scenario ID must be a safe no-op
      sim.setScenario('bogus-scenario' as DemoScenarioId);
      expect(sim.getScenarioId()).toBe('manhattan-bridge');
    });

    it('returns null on empty ReplaySensorSource with loop: true', () => {
      const replay = new ReplaySensorSource([], { loop: true });
      expect(replay.stepNext()).toBeNull();
    });
  });

  describe('TrafficEngine non-finite guards & signal-block invariants (Bug 1)', () => {
    it('returns [] on Infinity/NaN timestampMs and NaN ego.positionEnu without hanging', () => {
      const ego = makeBaseEgo();
      expect(computeNearbyTrains(dataset, ego, Infinity)).toEqual([]);
      expect(computeNearbyTrains(dataset, ego, -Infinity)).toEqual([]);
      expect(computeNearbyTrains(dataset, ego, Number.NaN)).toEqual([]);
      expect(
        computeNearbyTrains(
          dataset,
          makeBaseEgo({ positionEnu: [Number.NaN, Number.NaN, Number.NaN] }),
          Date.UTC(2026, 5, 10, 12, 30, 0),
        ),
      ).toEqual([]);
    });

    it('sanitizes NaN options so radius and 300m signal-block guards are never bypassed', () => {
      const ego = makeBaseEgo();
      const ts = Date.UTC(2026, 5, 10, 12, 30, 0);
      const trains = computeNearbyTrains(dataset, ego, ts, {
        signalBlockSeparationM: Number.NaN,
        maxTrainRadiusM: Number.NaN,
      });
      for (const t of trains) {
        expect(Number.isFinite(t.distanceM)).toBe(true);
        const maxAllowed = t.system === 'MTA' ? 3000 : 6000;
        expect(t.distanceM).toBeLessThanOrEqual(maxAllowed + 1e-3);
      }
    });

    it('enforces >= 300m pairwise signal-block separation across all 48 tracks x 6 service periods', () => {
      const periodTimestamps: Record<ServicePeriod, number> = {
        WEEKDAY_AM_RUSH: Date.UTC(2026, 5, 10, 12, 30, 0),
        WEEKDAY_MIDDAY: Date.UTC(2026, 5, 10, 16, 30, 0),
        WEEKDAY_PM_RUSH: Date.UTC(2026, 5, 10, 21, 30, 0),
        WEEKDAY_EVENING: Date.UTC(2026, 5, 11, 1, 30, 0),
        WEEKEND_DAY: Date.UTC(2026, 5, 13, 17, 0, 0),
        LATE_NIGHT: Date.UTC(2026, 5, 10, 6, 30, 0),
      };

      let checkedSameTrackPairs = 0;

      const ego = makeBaseEgo({ trackId: undefined, trackS: undefined });
      for (const [period, ts] of Object.entries(periodTimestamps) as Array<
        [ServicePeriod, number]
      >) {
        const trains = computeNearbyTrains(dataset, ego, ts, {
          maxTrainRadiusM: 30_000,
          maxNearbyTrains: 200,
          signalBlockSeparationM: 300,
        });
        expect(trains.every((t) => Number.isFinite(t.distanceM))).toBe(true);

        const ctxByScheduleId = new Map(
          getActiveScheduleContexts(dataset, period).map((ctx) => [
            ctx.schedule.id,
            ctx,
          ]),
        );
        const sByTrack = new Map<string, number[]>();
        for (const train of trains) {
          const scheduleId = train.id.split('#')[0];
          const ctx = ctxByScheduleId.get(scheduleId);
          expect(ctx).toBeDefined();
          if (!ctx) continue;
          const track = ctx.effectiveTrack;
          const proj = projectPointOntoTrack(train.enu, track);
          const list = sByTrack.get(track.id) ?? [];
          list.push(proj.s);
          sByTrack.set(track.id, list);
        }

        for (const sList of sByTrack.values()) {
          for (let i = 0; i < sList.length; i++) {
            for (let j = i + 1; j < sList.length; j++) {
              checkedSameTrackPairs++;
              expect(Math.abs(sList[i] - sList[j])).toBeGreaterThanOrEqual(
                300 - 1e-6,
              );
            }
          }
        }
      }
      expect(checkedSameTrackPairs).toBeGreaterThan(0);

      // Also verify 0-station synthetic dataset snapshot produces finite consist
      const emptySnap = buildWorldStateSnapshot({
        dataset: { ...dataset, stations: [], schedules: [] },
        ego: makeBaseEgo(),
        timestampMs: Date.UTC(2026, 5, 10, 12, 30, 0),
        mode: 'live',
      });
      expect(emptySnap.egoConsist.length).toBeGreaterThan(0);
      expect(emptySnap.nearbyTrains).toEqual([]);
    });
  });
});

// ===========================================================================
// PART 2: RENDER, UI, PWA & APP WIRING ADVERSARIAL TESTS (Bugs 8–15)
// ===========================================================================

describe('Tier 5 Adversarial — Render, UI, PWA & App Wiring', () => {
  const dataset = getTransitDataset();

  describe('SubwaySightApp resilience, races & context-loss (Bugs 8–11)', () => {
    it('handles invalid scenarioId safely without throwing in enterDemoMode and selectDemoScenario', () => {
      setupBasicWindowStubs();
      const doc = new MockDocument();
      const container = doc.createElement('div');
      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: () => makeFakeSceneManager(),
      });

      expect(() =>
        app.enterDemoMode('not-a-real-scenario' as DemoScenarioId),
      ).not.toThrow();
      expect(app.getDebugSnapshot().mode).toBe('sim');
      expect(app.getLatestSnapshot().scenarioId).toBe('manhattan-bridge');

      expect(() =>
        app.selectDemoScenario('also-invalid' as DemoScenarioId),
      ).not.toThrow();
      expect(app.getLatestSnapshot().scenarioId).toBe('manhattan-bridge');

      // Prototype-chain keys must never bypass own-property scenario validation
      const protoKeys = ['toString', 'constructor', '__proto__', 'valueOf'];
      const sim = new DeterministicSimSource(dataset, {
        scenarioId: 'express-overtake',
      });
      for (const key of protoKeys) {
        expect(isValidDemoScenarioId(key)).toBe(false);

        expect(() => {
          const fallbackSim = new DeterministicSimSource(dataset, {
            scenarioId: key as DemoScenarioId,
          });
          expect(fallbackSim.getScenarioId()).toBe('manhattan-bridge');
        }).not.toThrow();

        expect(() => sim.setScenario(key as DemoScenarioId)).not.toThrow();
        expect(sim.getScenarioId()).toBe('express-overtake');

        expect(() =>
          app.enterDemoMode(key as DemoScenarioId),
        ).not.toThrow();
        expect(app.getDebugSnapshot().mode).toBe('sim');
        expect(app.getLatestSnapshot().scenarioId).toBe('manhattan-bridge');

        expect(() =>
          app.selectDemoScenario(key as DemoScenarioId),
        ).not.toThrow();
        expect(app.getLatestSnapshot().scenarioId).toBe('manhattan-bridge');
      }

      app.dispose();
    });

    it('makes double-dispose idempotent and ignores all post-dispose API calls without leaking timers', () => {
      setupBasicWindowStubs();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const doc = new MockDocument();
      const container = doc.createElement('div');
      const fakeScene = makeFakeSceneManager();

      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: () => fakeScene,
      });

      app.dispose();
      app.dispose();
      expect(fakeScene.disposeMock).toHaveBeenCalledTimes(1);

      const intervalsAfterDispose = setIntervalSpy.mock.calls.length;
      app.enterDemoMode('manhattan-bridge');
      app.exitDemoMode();
      app.selectDemoScenario('express-overtake');
      app.toggleDemoPause();
      app.selectDemoSpeed(5);

      expect(setIntervalSpy.mock.calls.length).toBe(intervalsAfterDispose);
      expect(app.getDebugSnapshot().mode).toBe('live');
    });

    it('prevents stale iOS gyro permission promise from re-enabling gyro after user turns it OFF', async () => {
      setupBasicWindowStubs();
      const resolvers: Array<(v: 'granted' | 'denied') => void> = [];
      vi.stubGlobal('DeviceOrientationEvent', {
        requestPermission: vi.fn(
          () =>
            new Promise<'granted' | 'denied'>((resolve) => {
              resolvers.push(resolve);
            }),
        ),
      });

      const doc = new MockDocument();
      const container = doc.createElement('div');
      const fakeScene = makeFakeSceneManager();
      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: () => fakeScene,
      });

      const gyroBtn = container.findByTestId('btn-gyro-toggle')!;
      // Double-tap while permission prompt is pending
      gyroBtn.click(); // req #1
      gyroBtn.click(); // req #2
      expect(resolvers.length).toBe(2);

      // Resolve req #2 -> enables gyro
      resolvers[1]('granted');
      await new Promise((r) => setTimeout(r, 0));
      expect(gyroBtn.getAttribute('aria-pressed')).toBe('true');

      // User now turns gyro OFF
      gyroBtn.click();
      expect(gyroBtn.getAttribute('aria-pressed')).toBe('false');

      // Stale req #1 finally resolves 'granted' -> MUST be ignored
      resolvers[0]('granted');
      await new Promise((r) => setTimeout(r, 0));
      expect(gyroBtn.getAttribute('aria-pressed')).toBe('false');
      expect(fakeScene.setGyroEnabledMock).toHaveBeenLastCalledWith(false);

      app.dispose();
    });

    it('prevents slow startup IndexedDB calibration restore from clobbering user manual calibration', async () => {
      setupBasicWindowStubs();

      // Stub IndexedDB with a controllable delayed getAll() returning an old Canal St / A record
      const idbHook: { trigger: (() => void) | null } = { trigger: null };
      const staleRecord = {
        id: 'cal-old',
        stationId: 'mta-canal-ace',
        routeId: 'A',
        savedAtMs: Date.now() - 10_000,
      };
      vi.stubGlobal('indexedDB', {
        open: vi.fn(() => {
          const openReq: Record<string, unknown> = {};
          queueMicrotask(() => {
            openReq.result = {
              objectStoreNames: { contains: () => true },
              close: vi.fn(),
              transaction: (_store: string, mode: string) => ({
                objectStore: () => ({
                  getAll: () => {
                    const getReq: Record<string, unknown> = {};
                    if (mode === 'readonly' && !idbHook.trigger) {
                      idbHook.trigger = () => {
                        getReq.result = [staleRecord];
                        (getReq.onsuccess as (() => void) | undefined)?.();
                      };
                    } else {
                      queueMicrotask(() => {
                        getReq.result = [staleRecord];
                        (getReq.onsuccess as (() => void) | undefined)?.();
                      });
                    }
                    return getReq;
                  },
                  put: () => {
                    const putReq: Record<string, unknown> = {};
                    queueMicrotask(() => {
                      (putReq.onsuccess as (() => void) | undefined)?.();
                    });
                    return putReq;
                  },
                }),
              }),
            };
            (openReq.onsuccess as (() => void) | undefined)?.();
          });
          return openReq;
        }),
      });

      const doc = new MockDocument();
      const container = doc.createElement('div');
      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: () => makeFakeSceneManager(),
      });

      // Wait for open() microtask so getAll() is in-flight
      await Promise.resolve();
      await Promise.resolve();

      // User manually calibrates to 116 St / 1 BEFORE startup IDB restore resolves
      container.findByTestId('btn-calibrate')!.click();
      container.findByTestId('calibrate-station-select')!.value =
        'mta-116st-columbia';
      container.findByTestId('calibrate-line-select')!.value = '1';
      container.findByTestId('btn-calibrate-apply')!.click();
      expect(app.getDebugSnapshot().estimate.stationId).toBe(
        'mta-116st-columbia',
      );

      // Now let the slow startup IDB read resolve
      idbHook.trigger?.();
      await new Promise((r) => setTimeout(r, 10));

      // Fresh user calibration must NOT be clobbered by stale Canal St / A record
      expect(app.getDebugSnapshot().estimate.stationId).toBe(
        'mta-116st-columbia',
      );
      expect(app.getDebugSnapshot().estimate.line).toBe('1');

      app.dispose();
    });

    it('handles WebGL onContextLost, onContextRestored, and btn-webgl-retry recovery', () => {
      setupBasicWindowStubs();
      const doc = new MockDocument();
      const container = doc.createElement('div');
      let capturedOpts: SceneManagerOptions | undefined;
      let createCount = 0;
      let shouldThrow = false;
      const scenes: Array<ReturnType<typeof makeFakeSceneManager>> = [];

      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: (_canvas, _ds, opts) => {
          createCount++;
          capturedOpts = opts;
          if (shouldThrow) {
            throw new Error('WebGL unavailable');
          }
          const s = makeFakeSceneManager();
          scenes.push(s);
          return s;
        },
      });

      const banner = container.findByTestId('webgl-fallback-banner')!;
      expect(banner.hidden).toBe(true);

      // Context lost -> banner shown
      capturedOpts?.onContextLost?.();
      expect(banner.hidden).toBe(false);
      expect(banner.getAttribute('data-reason')).toBe('context-lost');

      // Context restored -> banner hidden
      capturedOpts?.onContextRestored?.();
      expect(banner.hidden).toBe(true);

      // Context lost again -> click retry -> old scene disposed, new scene mounted
      capturedOpts?.onContextLost?.();
      const retryBtn = container.findByTestId('btn-webgl-retry')!;
      retryBtn.click();
      expect(createCount).toBe(2);
      expect(scenes[0].disposeMock).toHaveBeenCalledTimes(1);
      expect(banner.hidden).toBe(true);

      // Retry fails -> banner shows unavailable
      shouldThrow = true;
      retryBtn.click();
      expect(banner.hidden).toBe(false);
      expect(banner.getAttribute('data-reason')).toBe('unavailable');

      app.dispose();
    });

    it('handles rapid Live <-> Demo <-> all 5 scenarios switching cleanly', () => {
      setupBasicWindowStubs();
      const doc = new MockDocument();
      const container = doc.createElement('div');
      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: () => makeFakeSceneManager(),
      });

      const scenarioIds: DemoScenarioId[] = [
        'manhattan-bridge',
        'express-overtake',
        'lexington-underground',
        'steinway-queens',
        'midtown-multi-system',
      ];
      for (const id of scenarioIds) {
        app.enterDemoMode(id);
        expect(app.getDebugSnapshot().mode).toBe('sim');
        expect(app.getLatestSnapshot().scenarioId).toBe(id);
      }
      app.exitDemoMode();
      expect(app.getDebugSnapshot().mode).toBe('live');

      app.dispose();
    });
  });

  describe('CameraController DOM pointer drag, pinch-zoom, double-tap & dispose', () => {
    it('processes pointer drag, pinch-zoom FOV clamp, double-tap reset, and cleans up on dispose()', () => {
      const doc = new MockDocument();
      const canvas = doc.createElement('canvas');
      canvas.style.touchAction = 'auto';

      const camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 10000);
      const ctrl = new CameraController(
        camera,
        canvas as unknown as HTMLCanvasElement,
      );
      expect(canvas.style.touchAction).toBe('none');
      expect(canvas.listeners.get('pointerdown')?.size).toBe(1);
      expect(canvas.listeners.get('pointermove')?.size).toBe(1);
      expect(canvas.listeners.get('pointerup')?.size).toBe(1);
      expect(canvas.listeners.get('pointercancel')?.size).toBe(1);

      // Single-pointer drag rotates yaw & pitch
      canvas.dispatchEvent({
        type: 'pointerdown',
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      canvas.dispatchEvent({
        type: 'pointermove',
        pointerId: 1,
        clientX: 180,
        clientY: 130,
      });
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerId: 1,
        clientX: 180,
        clientY: 130,
      });
      const origin = new THREE.Vector3(0, 0, 0);
      ctrl.update(origin, 0, 0, 0.25);
      const afterDrag = ctrl.getDebugAngles();
      expect(Math.abs(afterDrag.yaw)).toBeGreaterThan(0.05);

      // Two-finger pinch-zoom adjusts FOV within [45, 90]
      canvas.dispatchEvent({
        type: 'pointerdown',
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      canvas.dispatchEvent({
        type: 'pointerdown',
        pointerId: 2,
        clientX: 200,
        clientY: 100,
      });
      canvas.dispatchEvent({
        type: 'pointermove',
        pointerId: 2,
        clientX: 400,
        clientY: 100,
      });
      canvas.dispatchEvent({
        type: 'pointercancel',
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      });
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerId: 2,
        clientX: 400,
        clientY: 100,
      });
      ctrl.update(origin, 0, 0, 0.25);
      expect(camera.fov).toBeGreaterThanOrEqual(45);
      expect(camera.fov).toBeLessThanOrEqual(90);

      // Double-tap resets yaw/pitch back to 0
      canvas.dispatchEvent({
        type: 'pointerdown',
        pointerId: 3,
        clientX: 150,
        clientY: 150,
      });
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerId: 3,
        clientX: 150,
        clientY: 150,
      });
      canvas.dispatchEvent({
        type: 'pointerdown',
        pointerId: 4,
        clientX: 152,
        clientY: 151,
      });
      canvas.dispatchEvent({
        type: 'pointerup',
        pointerId: 4,
        clientX: 152,
        clientY: 151,
      });
      for (let i = 0; i < 8; i++) {
        ctrl.update(origin, 0, 0, 0.25);
      }
      expect(Math.abs(ctrl.getDebugAngles().yaw)).toBeLessThan(0.01);

      // dispose() removes all 4 pointer listeners and restores touchAction
      ctrl.dispose();
      expect(canvas.style.touchAction).toBe('auto');
      expect(canvas.listeners.get('pointerdown')?.size).toBe(0);
      expect(canvas.listeners.get('pointermove')?.size).toBe(0);
      expect(canvas.listeners.get('pointerup')?.size).toBe(0);
      expect(canvas.listeners.get('pointercancel')?.size).toBe(0);
    });
  });

  describe('HudController Demo Drawer sync & NaN/negative formatting (Bugs 12–13)', () => {
    it('syncs Demo Drawer on reload in Demo Mode and re-opens after Hide', () => {
      const ls = makeMemoryLocalStorage();
      setupBasicWindowStubs(ls);
      saveSettings({ demoMode: true, demoScenarioId: 'manhattan-bridge' });

      const doc = new MockDocument();
      const container = doc.createElement('div');
      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: () => makeFakeSceneManager(),
      });

      const demoDrawer = container.findByTestId('demo-drawer')!;
      const demoBtn = container.findByTestId('btn-demo-mode')!;
      const hideBtn = container.findByTestId('btn-demo-close')!;
      const liveBtn = container.findByTestId('btn-live-mode')!;

      // On reload with demoMode: true, drawer must be visible
      expect(app.getDebugSnapshot().mode).toBe('sim');
      expect(demoDrawer.hidden).toBe(false);

      // Clicking Hide hides drawer while staying in Demo Mode
      hideBtn.click();
      expect(demoDrawer.hidden).toBe(true);
      expect(app.getDebugSnapshot().mode).toBe('sim');

      // Clicking btn-demo-mode while drawer is hidden re-opens drawer without exiting Demo Mode
      demoBtn.click();
      expect(demoDrawer.hidden).toBe(false);
      expect(app.getDebugSnapshot().mode).toBe('sim');

      // Clicking btn-live-mode exits Demo Mode and hides drawer
      liveBtn.click();
      expect(app.getDebugSnapshot().mode).toBe('live');
      expect(demoDrawer.hidden).toBe(true);

      app.dispose();
    });

    it('clamps negative distances to 0m and formats NaN/Infinity landmark elevation safely', () => {
      const doc = new MockDocument();
      const container = doc.createElement('div');
      const noopCallbacks: HudCallbacks = {
        onApplyCalibration: vi.fn(),
        onResetCalibration: vi.fn(),
        onEnterDemoMode: vi.fn(),
        onExitDemoMode: vi.fn(),
        onSelectScenario: vi.fn(),
        onToggleDemoPause: vi.fn(),
        onSelectDemoSpeed: vi.fn(),
        onToggleGyro: vi.fn(),
        onResetView: vi.fn(),
        onChangeViewMode: vi.fn(),
      };
      const hud = new HudController(
        container as unknown as HTMLElement,
        dataset,
        noopCallbacks,
        { doc: doc as unknown as Document },
      );

      const snapshot: WorldStateSnapshot = {
        timestampMs: Date.UTC(2026, 5, 10, 12, 30, 0),
        mode: 'sim',
        scenarioId: 'manhattan-bridge',
        ego: makeBaseEgo(),
        egoConsist: [],
        nearbyTrains: [
          {
            id: 't1',
            system: 'MTA',
            routeId: 'A',
            color: '#2850ad',
            distanceM: -25,
            enu: [0, 0, 0],
            headingRad: 0,
            pitchRad: 0,
            carCount: 8,
            carLengthM: 18,
            carWidthM: 3,
            cars: [],
          },
        ],
        nearbyLandmarks: [
          {
            id: 'east-river',
            name: 'East River',
            kind: 'river',
            distanceM: -10,
            relativeElevationFt: Number.NaN,
          },
          {
            id: 'hudson-river',
            name: 'Hudson River',
            kind: 'river',
            distanceM: 500,
            relativeElevationFt: Infinity,
          },
        ],
      };

      hud.update(snapshot);
      const trainList = container.findByTestId('nearby-trains-list')!;
      const lmList = container.findByTestId('nearby-landmarks-list')!;
      expect(trainList.children[0].children[1].textContent).toBe('A 0m');
      expect(lmList.children[0].textContent).toBe('East River 0m (0ft)');
      expect(lmList.children[1].textContent).toBe('Hudson River 500m (0ft)');

      hud.dispose();
    });
  });

  describe('storage.ts QuotaExceededError, SecurityError, corrupted JSON & IDB arbitration (Bugs 14–15)', () => {
    it('retains in-memory settings when localStorage.setItem throws QuotaExceededError', () => {
      const ls = makeMemoryLocalStorage();
      ls.setItem = vi.fn(() => {
        throw new Error('QuotaExceededError');
      });
      vi.stubGlobal('localStorage', ls);

      saveSettings({ viewMode: 'ghost', demoSpeedMultiplier: 5 });
      const loaded = loadSettings();
      expect(loaded.viewMode).toBe('ghost');
      expect(loaded.demoSpeedMultiplier).toBe(5);
    });

    it('handles corrupted JSON and SecurityError in localStorage gracefully', () => {
      const ls = makeMemoryLocalStorage();
      ls.setItem('subwaysight:settings:v1', '{broken-json');
      ls.setItem('subwaysight:calibration:v1', '{broken-json');
      vi.stubGlobal('localStorage', ls);

      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

      // SecurityError on getItem
      ls.getItem = vi.fn(() => {
        throw new Error('SecurityError');
      });
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('sanitizes empty calibrations, resolves IDB onblocked, and picks newest savedAtMs across IDB/memory/mirror', async () => {
      vi.stubGlobal('localStorage', makeMemoryLocalStorage());

      // Empty calibration (neither stationId nor routeId) must not be returned
      await saveCalibration({ savedAtMs: 12345 });
      expect(await loadLatestCalibration()).toBeNull();

      // IndexedDB onblocked must resolve cleanly instead of hanging
      vi.stubGlobal('indexedDB', {
        open: vi.fn(() => {
          const req: Record<string, unknown> = {};
          queueMicrotask(() => {
            (req.onblocked as (() => void) | undefined)?.();
          });
          return req;
        }),
      });
      await saveCalibration({
        stationId: 'mta-canal-ace',
        routeId: 'A',
        savedAtMs: 2000,
      });
      const loadedBlocked = await loadLatestCalibration();
      expect(loadedBlocked?.stationId).toBe('mta-canal-ace');

      // Stale IDB record (savedAtMs: 1000) vs newer memory/mirror record (savedAtMs: 5000) when IDB put aborts
      vi.stubGlobal('indexedDB', {
        open: vi.fn(() => {
          const openReq: Record<string, unknown> = {};
          queueMicrotask(() => {
            openReq.result = {
              objectStoreNames: { contains: () => true },
              close: vi.fn(),
              transaction: (_store: string, mode: string) => {
                const tx: Record<string, unknown> = {
                  objectStore: () => ({
                    getAll: () => {
                      const getReq: Record<string, unknown> = {};
                      queueMicrotask(() => {
                        getReq.result = [
                          {
                            id: 'cal-old',
                            stationId: 'mta-canal-ace',
                            routeId: 'A',
                            savedAtMs: 1000,
                          },
                        ];
                        (getReq.onsuccess as (() => void) | undefined)?.();
                      });
                      return getReq;
                    },
                    put: () => {
                      const putReq: Record<string, unknown> = {};
                      queueMicrotask(() => {
                        (tx.onabort as (() => void) | undefined)?.();
                      });
                      return putReq;
                    },
                    clear: () => {
                      const clrReq: Record<string, unknown> = {};
                      queueMicrotask(() => {
                        (clrReq.onsuccess as (() => void) | undefined)?.();
                      });
                      return clrReq;
                    },
                  }),
                };
                void mode;
                return tx;
              },
            };
            (openReq.onsuccess as (() => void) | undefined)?.();
          });
          return openReq;
        }),
      });

      await saveCalibration({
        stationId: 'mta-116st-columbia',
        routeId: '1',
        savedAtMs: 5000,
      });
      const newest = await loadLatestCalibration();
      expect(newest?.stationId).toBe('mta-116st-columbia');
      expect(newest?.savedAtMs).toBe(5000);

      await clearCalibration();
    });
  });

  describe('Empty TransitDataset in 3D render layers', () => {
    it('constructs and disposes TrackLayer, StructureLayer, and LandmarkLayer cleanly on empty dataset', () => {
      const emptyDataset: TransitDataset = {
        stations: [],
        tracks: [],
        schedules: [],
        landmarks: { waterBodies: [], boroughs: [], bridges: [] },
        stationById: new Map(),
        trackById: new Map(),
      };

      const trackLayer = new TrackLayer(emptyDataset.tracks);
      const structureLayer = new StructureLayer(emptyDataset);
      const landmarkLayer = new LandmarkLayer(emptyDataset.landmarks);

      expect(() => {
        trackLayer.dispose();
        structureLayer.dispose();
        landmarkLayer.dispose();
      }).not.toThrow();
    });
  });

  describe('Manual calibration across service-period track overrides (Iteration 3 Gap 1)', () => {
    const assertFiniteEstimatorState = (st: EstimatorState): void => {
      expect(Number.isFinite(st.positionEnu[0])).toBe(true);
      expect(Number.isFinite(st.positionEnu[1])).toBe(true);
      expect(Number.isFinite(st.positionEnu[2])).toBe(true);
      expect(Number.isFinite(st.positionLatLng.lat)).toBe(true);
      expect(Number.isFinite(st.positionLatLng.lon)).toBe(true);
      expect(Number.isFinite(st.headingRad)).toBe(true);
      expect(Number.isFinite(st.pitchRad)).toBe(true);
      expect(Number.isFinite(st.speedMps)).toBe(true);
      expect(Number.isFinite(st.speedMph)).toBe(true);
      expect(Number.isFinite(st.elevationM)).toBe(true);
      expect(Number.isFinite(st.trackS ?? 0)).toBe(true);
      expect(Number.isFinite(st.confidencePct)).toBe(true);
    };

    const movingImu = {
      accelLin: [0, 1.5, 0] as [number, number, number],
      accelGrav: [0, 1.5, 9.81] as [number, number, number],
      gyroRadS: [0, 0, 0] as [number, number, number],
    };
    const stationaryImu = {
      accelLin: [0, 0, 0] as [number, number, number],
      accelGrav: [0, 0, 9.81] as [number, number, number],
      gyroRadS: [0, 0, 0] as [number, number, number],
    };

    it('re-projects Route A Uptown manual anchor across LATE_NIGHT -> WEEKDAY_AM_RUSH without out-of-bounds crash', () => {
      const dataset = getTransitDataset();
      const filter = new TrackParticleFilter(dataset, { seed: 42 });

      const lateNightMs = Date.parse('2026-06-10T06:00:00Z'); // 02:00 EDT (LATE_NIGHT, 17-stop local)
      expect(classifyServicePeriod(lateNightMs)).toBe('LATE_NIGHT');

      filter.setManualCalibration(
        {
          routeId: 'A',
          direction: 'UPTOWN',
          stationId: 'mta-59st-columbus-ac',
        },
        lateNightMs,
      );

      // Cross 6:00 AM into WEEKDAY_AM_RUSH (12-stop mta-ace-express-uptown)
      let tMs = Date.parse('2026-06-10T12:00:00Z'); // 08:00 EDT
      expect(classifyServicePeriod(tMs)).toBe('WEEKDAY_AM_RUSH');

      let state: EstimatorState | null = null;
      // 15 moving ticks (1s each, > 10s since last stop)
      for (let i = 0; i < 15; i++) {
        tMs += 1000;
        const sample: SensorSample = { tMs, imu: movingImu };
        expect(() => {
          state = filter.step(sample, 'live');
        }).not.toThrow();
      }

      // 10 stationary/dwell ticks to trigger drOut.justStopped & station stop likelihood
      for (let i = 0; i < 10; i++) {
        tMs += 1000;
        const sample: SensorSample = { tMs, imu: stationaryImu };
        expect(() => {
          state = filter.step(sample, 'live');
        }).not.toThrow();
      }

      expect(state).not.toBeNull();
      assertFiniteEstimatorState(state!);
      expect(state!.manualAnchorActive).toBe(true);
      expect(state!.routeId).toBe('A');
      expect(state!.trackId).toBe('mta-ace-express-uptown');
    });

    it('re-projects Route 2 Uptown manual anchor at last stop across WEEKDAY_EVENING -> LATE_NIGHT without out-of-bounds crash', () => {
      const dataset = getTransitDataset();
      const filter = new TrackParticleFilter(dataset, { seed: 99 });

      const expressTrack = dataset.trackById.get('mta-123-express-uptown')!;
      expect(expressTrack).toBeDefined();
      const lastStationId =
        expressTrack.stations[expressTrack.stations.length - 1].stationId;

      const eveningMs = Date.parse('2026-06-11T02:00:00Z'); // 22:00 EDT (WEEKDAY_EVENING, 14-stop express)
      expect(classifyServicePeriod(eveningMs)).toBe('WEEKDAY_EVENING');

      filter.setManualCalibration(
        {
          routeId: '2',
          direction: 'UPTOWN',
          stationId: lastStationId,
        },
        eveningMs,
      );

      // Cross midnight into LATE_NIGHT (12-stop mta-123-local-uptown)
      let tMs = Date.parse('2026-06-11T04:05:00Z'); // 00:05 EDT
      expect(classifyServicePeriod(tMs)).toBe('LATE_NIGHT');

      let state: EstimatorState | null = null;
      // 15 moving ticks + 10 stationary ticks
      for (let i = 0; i < 25; i++) {
        tMs += 1000;
        const sample: SensorSample = {
          tMs,
          imu: i < 15 ? movingImu : stationaryImu,
        };
        expect(() => {
          state = filter.step(sample, 'live');
        }).not.toThrow();
      }

      expect(state).not.toBeNull();
      assertFiniteEstimatorState(state!);
      expect(state!.manualAnchorActive).toBe(true);
      expect(state!.routeId).toBe('2');
      expect(state!.trackId).toBe('mta-123-local-uptown');
    });
  });

  describe('Out-of-Date-range finite timestamps (Iteration 3 Gap 2)', () => {
    const VALID_PERIODS: readonly ServicePeriod[] = [
      'WEEKDAY_AM_RUSH',
      'WEEKDAY_MIDDAY',
      'WEEKDAY_PM_RUSH',
      'WEEKDAY_EVENING',
      'WEEKEND_DAY',
      'LATE_NIGHT',
    ];

    it('classifyServicePeriod handles out-of-Date-range finite timestamps without RangeError', () => {
      const extremeTimestamps = [
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER,
        1e20,
        -1e20,
        8_640_000_000_000_001,
        -8_640_000_000_000_001,
        8_640_000_000_000_000,
        -8_640_000_000_000_000,
      ];

      for (const ts of extremeTimestamps) {
        let period: ServicePeriod | undefined;
        expect(() => {
          period = classifyServicePeriod(ts);
        }).not.toThrow();
        expect(VALID_PERIODS).toContain(period);
      }
    });

    it('TrackParticleFilter.step and computeNearbyTrains handle out-of-Date-range finite timestamps safely', () => {
      const dataset = getTransitDataset();
      const filter = new TrackParticleFilter(dataset, { seed: 7 });
      const badTimestamps = [Number.MAX_SAFE_INTEGER, 1e20, -1e20];

      for (const tMs of badTimestamps) {
        let state: EstimatorState | null = null;
        expect(() => {
          state = filter.step({ tMs }, 'live');
        }).not.toThrow();
        expect(state).not.toBeNull();
        expect(Number.isFinite(state!.positionEnu[0])).toBe(true);
        expect(Number.isFinite(state!.positionEnu[1])).toBe(true);
        expect(Number.isFinite(state!.positionEnu[2])).toBe(true);
        expect(Number.isFinite(state!.confidencePct)).toBe(true);

        let nearby: ReturnType<typeof computeNearbyTrains> = [];
        expect(() => {
          nearby = computeNearbyTrains(dataset, state!, tMs);
        }).not.toThrow();
        for (const train of nearby) {
          expect(Number.isFinite(train.distanceM)).toBe(true);
          expect(Number.isFinite(train.enu[0])).toBe(true);
          expect(Number.isFinite(train.enu[1])).toBe(true);
          expect(Number.isFinite(train.enu[2])).toBe(true);
        }
      }
    });
  });
});
