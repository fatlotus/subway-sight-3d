import { describe, expect, it } from 'vitest';
import { getTransitDataset } from '../../src/data/dataset';
import { distanceEnu2D, samplePolylineAtS } from '../../src/geo/projection';
import {
  DeadReckoningEngine,
  IMU_TIMEOUT_MS,
  snapToStationIfDwelling,
} from '../../src/localization/deadReckoning';
import {
  evaluateGpsVisibilityLogLikelihood,
  GpsFilter,
} from '../../src/localization/gpsFilter';
import { TrackParticleFilter } from '../../src/localization/particleFilter';
import {
  classifyServicePeriod,
  getActiveScheduleContexts,
  isRouteActiveInPeriod,
} from '../../src/localization/scheduleModel';
import { DeterministicSimSource } from '../../src/sensors/simSensorSource';
import type { EstimatorState } from '../../src/types/state';

// Fixed non-DST-boundary reference timestamps (EST = UTC-5)
const TS_WEEKDAY_AM_RUSH = Date.UTC(2026, 0, 14, 13, 30, 0); // Wed 08:30 AM EST
const TS_WEEKDAY_MIDDAY = Date.UTC(2026, 0, 14, 18, 0, 0); // Wed 01:00 PM EST
const TS_WEEKDAY_PM_RUSH = Date.UTC(2026, 0, 14, 22, 30, 0); // Wed 05:30 PM EST
const TS_WEEKDAY_EVENING = Date.UTC(2026, 0, 15, 2, 0, 0); // Wed 09:00 PM EST
const TS_WEEKEND_DAY = Date.UTC(2026, 0, 17, 19, 0, 0); // Sat 02:00 PM EST
const TS_LATE_NIGHT = Date.UTC(2026, 0, 14, 7, 30, 0); // Wed 02:30 AM EST

function assertNoNaNInEstimatorState(state: EstimatorState): void {
  expect(Number.isFinite(state.confidencePct)).toBe(true);
  expect(state.positionEnu.every(Number.isFinite)).toBe(true);
  expect(Number.isFinite(state.positionLatLng.lat)).toBe(true);
  expect(Number.isFinite(state.positionLatLng.lon)).toBe(true);
  expect(Number.isFinite(state.headingRad)).toBe(true);
  expect(Number.isFinite(state.pitchRad)).toBe(true);
  expect(Number.isFinite(state.speedMps)).toBe(true);
  expect(Number.isFinite(state.speedMph)).toBe(true);
  expect(Number.isFinite(state.elevationM)).toBe(true);
  expect(Number.isFinite(state.elevationFt)).toBe(true);
  if (state.etaSec !== null) {
    expect(Number.isFinite(state.etaSec)).toBe(true);
  }
}

describe('Localization — GpsFilter', () => {
  it('rejects coarse GPS (>150m / >500m), handles staleness & denial, and scores negative tunnel evidence', () => {
    const filter = new GpsFilter();

    // Valid lock inside NYC
    const r1 = filter.update(
      {
        tMs: 10_000,
        gps: {
          lat: 40.7549,
          lon: -73.984,
          accuracyM: 12,
          speedMps: 14,
          headingDeg: 25,
          fixAgeMs: 100,
        },
      },
      true,
      'live',
    );
    expect(r1.status).toBe('locked');
    expect(r1.acceptedForHardUpdate).toBe(true);
    expect(r1.outOfNyc).toBe(false);

    // Coarse GPS (>150m and >500m) rejected for hard update
    const r200 = filter.update(
      {
        tMs: 11_000,
        gps: { lat: 40.7549, lon: -73.984, accuracyM: 200, fixAgeMs: 0 },
      },
      true,
      'live',
    );
    expect(r200.acceptedForHardUpdate).toBe(false);
    expect(r200.acceptedForSoftPrior).toBe(true);

    const r600 = filter.update(
      {
        tMs: 12_000,
        gps: { lat: 40.78, lon: -73.95, accuracyM: 600, fixAgeMs: 0 },
      },
      true,
      'live',
    );
    expect(r600.acceptedForHardUpdate).toBe(false);
    expect(r600.acceptedForSoftPrior).toBe(false);

    // Staleness -> stale (>8s) -> lost (>12s while moving)
    const rStale = filter.update({ tMs: 19_000 }, true, 'live');
    expect(rStale.status).toBe('stale');

    const rLost = filter.update({ tMs: 24_000 }, true, 'live');
    expect(rLost.status).toBe('lost');
    expect(rLost.hasNegativeTunnelEvidence).toBe(true);

    // Negative tunnel visibility likelihood strongly prefers UNDERGROUND over OPEN_SKY
    const llUnder = evaluateGpsVisibilityLogLikelihood('UNDERGROUND', rLost);
    const llSky = evaluateGpsVisibilityLogLikelihood('OPEN_SKY', rLost);
    expect(llUnder).toBeGreaterThan(llSky + 1.5);

    // Permission denied
    const rDenied = filter.update({ tMs: 25_000, gpsErrorCode: 1 }, true, 'live');
    expect(rDenied.status).toBe('denied');
    expect(rDenied.hasNegativeTunnelEvidence).toBe(false);

    // Out-of-NYC detection (San Francisco)
    const rSf = filter.update(
      {
        tMs: 26_000,
        gps: { lat: 37.7749, lon: -122.4194, accuracyM: 15, fixAgeMs: 0 },
      },
      false,
      'live',
    );
    expect(rSf.outOfNyc).toBe(true);
    expect(rSf.acceptedForHardUpdate).toBe(false);

    // Permission denied after out-of-NYC clears stale outOfNyc on subsequent heartbeats
    const rDeniedAfterSf = filter.update({ tMs: 27_000, gpsErrorCode: 1 }, false, 'live');
    expect(rDeniedAfterSf.status).toBe('denied');
    expect(rDeniedAfterSf.outOfNyc).toBe(false);

    const rHeartbeatAfterDenied = filter.update({ tMs: 28_000 }, false, 'live');
    expect(rHeartbeatAfterDenied.status).toBe('denied');
    expect(rHeartbeatAfterDenied.outOfNyc).toBe(false);
  });

  it('transitions immediately to lost on gpsErrorCode 2 and 3, persists across IMU-only samples, and recovers on valid fix', () => {
    for (const errCode of [2, 3] as const) {
      const filter = new GpsFilter();

      // Establish valid GPS lock
      const locked = filter.update(
        {
          tMs: 10_000,
          gps: {
            lat: 40.7527,
            lon: -73.9772,
            accuracyM: 15,
            speedMps: 9,
            headingDeg: 28,
            fixAgeMs: 0,
          },
        },
        true,
        'live',
      );
      expect(locked.status).toBe('locked');
      expect(locked.hasNegativeTunnelEvidence).toBe(false);

      // Immediate underground GPS error (code 2 or 3) -> lost + negative tunnel evidence while moving
      const lostImmediate = filter.update(
        { tMs: 10_100, gpsErrorCode: errCode },
        true,
        'live',
      );
      expect(lostImmediate.status).toBe('lost');
      expect(lostImmediate.hasNegativeTunnelEvidence).toBe(true);
      expect(lostImmediate.acceptedForHardUpdate).toBe(false);

      // Subsequent IMU-only samples well within 8s staleness window must remain lost (not flip back to locked)
      const imuMoving = filter.update(
        {
          tMs: 10_200,
          imu: {
            accelLin: [0, 1.0, 0],
            accelGrav: [0, 0, -9.81],
            gyroRadS: [0, 0, 0],
          },
        },
        true,
        'live',
      );
      expect(imuMoving.status).toBe('lost');
      expect(imuMoving.hasNegativeTunnelEvidence).toBe(true);

      // Stationary sample still stays lost, without negative tunnel evidence
      const imuStopped = filter.update({ tMs: 10_300 }, false, 'live');
      expect(imuStopped.status).toBe('lost');
      expect(imuStopped.hasNegativeTunnelEvidence).toBe(false);

      // Fresh valid GPS fix clears signalLost and recovers to locked
      const recovered = filter.update(
        {
          tMs: 11_000,
          gps: {
            lat: 40.7549,
            lon: -73.984,
            accuracyM: 12,
            speedMps: 10,
            headingDeg: 28,
            fixAgeMs: 0,
          },
        },
        true,
        'live',
      );
      expect(recovered.status).toBe('locked');
      expect(recovered.acceptedForHardUpdate).toBe(true);
      expect(recovered.hasNegativeTunnelEvidence).toBe(false);
    }
  });
});

describe('Localization — DeadReckoningEngine', () => {
  const dataset = getTransitDataset();

  it('handles 45-degree tilted phone gravity projection, yaw-rate extraction, dwell ZUPT, and speed clamping', () => {
    const dr = new DeadReckoningEngine();
    const s45 = Math.SQRT1_2;
    // Phone tilted 45 deg in Y-Z plane: gHat = [0, s45, s45]
    // Forward horizontal axis orthogonal to gHat: [0, -s45, s45]
    const gVec: [number, number, number] = [0, 9.80665 * s45, 9.80665 * s45];
    let tMs = 1000;

    // 1. Start stationary with tilted phone, then accelerate at 1.0 m/s^2 for 6s with CW yaw rate +0.2 rad/s
    let out = dr.update(
      {
        tMs,
        imu: {
          accelLin: [0, 0, 0],
          accelGrav: gVec,
          gyroRadS: [0, 0, 0],
        },
      },
      'live',
      { maxSpeedMps: 18 },
    );
    for (let i = 0; i < 60; i++) {
      tMs += 100;
      const aLong = 1.0;
      out = dr.update(
        {
          tMs,
          imu: {
            accelLin: [0, -aLong * s45, aLong * s45],
            accelGrav: [gVec[0], gVec[1] - aLong * s45, gVec[2] + aLong * s45],
            gyroRadS: [0, -0.2 * s45, -0.2 * s45],
          },
        },
        'live',
        { maxSpeedMps: 18 },
      );
    }

    expect(out.hasImu).toBe(true);
    expect(out.isDwelling).toBe(false);
    expect(out.speedMps).toBeGreaterThan(3.5);
    expect(out.speedMps).toBeLessThanOrEqual(18);
    expect(out.yawRateCwRadS).toBeCloseTo(0.2, 1);

    // 2. Brake to a stop (~5s) and dwell (~3s) with low vibration -> ZUPT resets speed to 0
    for (let i = 0; i < 80; i++) {
      tMs += 100;
      const aLong = out.speedMps > 0.2 ? -1.2 : 0;
      out = dr.update(
        {
          tMs,
          imu: {
            accelLin: [0.01, -aLong * s45, aLong * s45],
            accelGrav: gVec,
            gyroRadS: [0, 0, 0],
          },
        },
        'live',
        { maxSpeedMps: 18 },
      );
    }
    expect(out.isDwelling).toBe(true);
    expect(out.speedMps).toBe(0);

    // Station snapping helper
    const track = dataset.trackById.get('mta-ace-express-uptown')!;
    const stRef = track.stations[2];
    const snap = snapToStationIfDwelling(track, stRef.s + 22, true, 65);
    expect(snap.snapped).toBe(true);
    expect(snap.stationId).toBe(stRef.stationId);
    expect(snap.s).toBe(stRef.s);
  });

  it('degrades gracefully to schedule-driven DR when IMU is missing', () => {
    const dr = new DeadReckoningEngine();
    const out1 = dr.update({ tMs: 1000 }, 'live', { scheduleSpeedMps: 12 });
    const out2 = dr.update({ tMs: 2000 }, 'live', { scheduleSpeedMps: 12 });
    expect(out1.status).toBe('unavailable');
    expect(out2.hasImu).toBe(false);
    expect(out2.speedMps).toBe(12);
    expect(out2.deltaSM).toBeCloseTo(12, 3);
  });

  it('retains active DR status within IMU_TIMEOUT_MS grace window and degrades to unavailable afterward', () => {
    const dr = new DeadReckoningEngine();
    let tMs = 10_000;
    // Feed active motion burst so DR leaves standby and enters active state
    for (let i = 0; i < 15; i++) {
      tMs += 100;
      dr.update(
        {
          tMs,
          imu: {
            accelLin: [0.15, 0.05, -0.95],
            accelGrav: [0, 9.80665, 0],
            gyroRadS: [0, -0.04, 0],
          },
        },
        'live',
      );
    }

    // Heartbeat without IMU 5s later (well within IMU_TIMEOUT_MS) stays active
    const withinGrace = dr.update({ tMs: tMs + 5_000 }, 'live', {
      scheduleSpeedMps: 11,
    });
    expect(withinGrace.hasImu).toBe(true);
    expect(withinGrace.status).toBe('active');

    // Extended silence beyond IMU_TIMEOUT_MS degrades to unavailable
    const pastGrace = dr.update(
      { tMs: tMs + IMU_TIMEOUT_MS + 1_000 },
      'live',
      { scheduleSpeedMps: 11 },
    );
    expect(pastGrace.hasImu).toBe(false);
    expect(pastGrace.status).toBe('unavailable');
  });
});

describe('Localization — ScheduleModel', () => {
  const dataset = getTransitDataset();

  it('classifies all 6 NYC service periods accurately and filters B/W and late-night overrides', () => {
    expect(classifyServicePeriod(TS_WEEKDAY_AM_RUSH)).toBe('WEEKDAY_AM_RUSH');
    expect(classifyServicePeriod(TS_WEEKDAY_MIDDAY)).toBe('WEEKDAY_MIDDAY');
    expect(classifyServicePeriod(TS_WEEKDAY_PM_RUSH)).toBe('WEEKDAY_PM_RUSH');
    expect(classifyServicePeriod(TS_WEEKDAY_EVENING)).toBe('WEEKDAY_EVENING');
    expect(classifyServicePeriod(TS_WEEKEND_DAY)).toBe('WEEKEND_DAY');
    expect(classifyServicePeriod(TS_LATE_NIGHT)).toBe('LATE_NIGHT');

    // B and W active on weekday rush/midday, inactive on weekends and late night
    expect(isRouteActiveInPeriod(dataset, 'B', 'WEEKDAY_AM_RUSH')).toBe(true);
    expect(isRouteActiveInPeriod(dataset, 'W', 'WEEKDAY_MIDDAY')).toBe(true);
    expect(isRouteActiveInPeriod(dataset, 'B', 'WEEKEND_DAY')).toBe(false);
    expect(isRouteActiveInPeriod(dataset, 'W', 'WEEKEND_DAY')).toBe(false);
    expect(isRouteActiveInPeriod(dataset, 'B', 'LATE_NIGHT')).toBe(false);
    expect(isRouteActiveInPeriod(dataset, 'W', 'LATE_NIGHT')).toBe(false);

    // Late night redirects express A onto local track with synthesized/borrowed local runTimes
    const lateNightCtxs = getActiveScheduleContexts(dataset, 'LATE_NIGHT');
    const aUptown = lateNightCtxs.find(
      (c) => c.schedule.routeId === 'A' && c.schedule.direction === 'UPTOWN',
    );
    expect(aUptown).toBeDefined();
    expect(aUptown!.effectiveTrack.id).toBe('mta-ace-local-uptown');
    expect(aUptown!.effectiveServiceType).toBe('LOCAL');
    expect(aUptown!.effectiveRunTimes.length).toBeGreaterThan(0);
  });

  it('keeps classifyServicePeriod cache consistent across minute/hour boundaries and backward clock jumps', () => {
    // 05:59:30 EST -> LATE_NIGHT, 06:00:00 EST -> WEEKDAY_AM_RUSH
    const ts0559 = Date.UTC(2026, 0, 14, 10, 59, 30);
    const ts0600 = Date.UTC(2026, 0, 14, 11, 0, 0);
    expect(classifyServicePeriod(ts0559)).toBe('LATE_NIGHT');
    expect(classifyServicePeriod(ts0559 + 15_000)).toBe('LATE_NIGHT');
    expect(classifyServicePeriod(ts0600)).toBe('WEEKDAY_AM_RUSH');
    // Backward clock jump across boundary must invalidate minute bucket cleanly
    expect(classifyServicePeriod(ts0559)).toBe('LATE_NIGHT');
  });
});

describe('Localization — TrackParticleFilter', () => {
  const dataset = getTransitDataset();

  it('disambiguates Express vs Local to > 80% confidence on express-overtake', () => {
    const sim = new DeterministicSimSource(dataset, {
      scenarioId: 'express-overtake',
      seed: 202,
      sampleRateHz: 10,
      autoLoop: false,
    });
    const pf = new TrackParticleFilter(dataset, {
      particleCount: 300,
      seed: 1337,
    });

    let state = pf.getState();
    // Run ~110s of simulated ride (14th St -> skips 23rd St -> dwells at 34th St Penn -> 42nd St)
    for (let i = 0; i < 1100; i++) {
      const sample = sim.step(0.1);
      state = pf.step(sample, 'sim');
    }

    assertNoNaNInEstimatorState(state);
    expect(state.routeId).toBe('A');
    expect(state.serviceType).toBe('EXPRESS');
    expect(state.confidencePct).toBeGreaterThan(80);
  });

  it('maintains bounded position through manhattan-bridge GPS lock -> underground DR handoff', () => {
    const sim = new DeterministicSimSource(dataset, {
      scenarioId: 'manhattan-bridge',
      seed: 101,
      sampleRateHz: 10,
      autoLoop: false,
    });
    const pf = new TrackParticleFilter(dataset, {
      particleCount: 300,
      seed: 4242,
    });

    let state = pf.getState();
    let sawBridgeLock = false;
    let sawTunnelLost = false;
    let tunnelErrorM = Infinity;

    for (let i = 0; i < 2400; i++) {
      const sample = sim.step(0.1);
      state = pf.step(sample, 'sim');
      const gt = sim.getGroundTruth();

      if (gt.structure === 'BRIDGE' && state.sensorStatus.gps === 'simulated') {
        sawBridgeLock = true;
      }
      if (sawBridgeLock && gt.s > 3300 && state.sensorStatus.gps === 'lost') {
        sawTunnelLost = true;
        tunnelErrorM = distanceEnu2D(state.positionEnu, gt.enu);
        break;
      }
    }

    assertNoNaNInEstimatorState(state);
    expect(sawBridgeLock).toBe(true);
    expect(sawTunnelLost).toBe(true);
    expect(state.sensorStatus.dr).toBe('simulated');
    expect(tunnelErrorM).toBeLessThan(350);
  });

  it('rejects coarse/noisy GPS (>500m) without teleporting', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 7 });
    const anchored = pf.setManualCalibration({
      stationId: 'mta-grand-central-456',
      routeId: '4',
      direction: 'UPTOWN',
    });
    const beforeEnu = anchored.positionEnu;

    // Inject coarse 600m GPS jump ~2 km away
    const after = pf.step(
      {
        tMs: TS_WEEKDAY_MIDDAY,
        gps: {
          lat: 40.77,
          lon: -73.96,
          accuracyM: 600,
          fixAgeMs: 0,
        },
      },
      'live',
    );

    assertNoNaNInEstimatorState(after);
    expect(distanceEnu2D(beforeEnu, after.positionEnu)).toBeLessThan(100);
  });

  it('handles out-of-NYC GPS cleanly with outOfNyc=true, confidencePct=0, and zero NaN', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 7 });
    const state = pf.step(
      {
        tMs: TS_WEEKDAY_MIDDAY,
        gps: {
          lat: 37.7749,
          lon: -122.4194,
          accuracyM: 15,
          fixAgeMs: 0,
        },
      },
      'live',
    );

    assertNoNaNInEstimatorState(state);
    expect(state.outOfNyc).toBe(true);
    expect(state.confidencePct).toBe(0);
    expect(state.routeId).toBeNull();
    expect(state.candidates).toEqual([]);
  });

  it('assigns zero probability to B and W during late-night and weekend periods', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 9 });
    const track = dataset.trackById.get('mta-bdfm-express-uptown')!;
    const pose = samplePolylineAtS(track.points, 2000);
    const lat = 40.7549 + pose.enu[1] / 111048.8;
    const lon = -73.984 + pose.enu[0] / 84327.6;

    for (const ts of [TS_LATE_NIGHT, TS_WEEKEND_DAY]) {
      pf.reset();
      const state = pf.step(
        {
          tMs: ts,
          gps: { lat, lon, accuracyM: 15, speedMps: 12, headingDeg: 0, fixAgeMs: 0 },
        },
        'live',
      );
      assertNoNaNInEstimatorState(state);
      const bw = state.candidates.filter(
        (c) => c.routeId === 'B' || c.routeId === 'W',
      );
      expect(bw.length).toBe(0);
    }
  });

  it('supports immediate manual calibration and resetCalibration()', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 11 });
    const state = pf.setManualCalibration({
      stationId: 'mta-grand-central-456',
      routeId: '4',
      direction: 'UPTOWN',
    });

    assertNoNaNInEstimatorState(state);
    expect(state.manualAnchorActive).toBe(true);
    expect(state.routeId).toBe('4');
    expect(state.currentStationId).toBe('mta-grand-central-456');
    expect(state.confidencePct).toBeGreaterThanOrEqual(90);

    pf.resetCalibration();
    expect(pf.getState().manualAnchorActive).toBe(false);
  });

  it('preserves manual NYC calibration across live heartbeats and out-of-NYC (London) GPS fixes until resetCalibration()', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 23 });
    const londonGps = {
      lat: 51.5074,
      lon: -0.1278,
      accuracyM: 20,
      fixAgeMs: 0,
    };

    // 1. Out-of-NYC London GPS fix puts filter in outOfNyc state
    const outState = pf.step(
      { tMs: TS_WEEKDAY_MIDDAY, gps: londonGps },
      'live',
    );
    assertNoNaNInEstimatorState(outState);
    expect(outState.outOfNyc).toBe(true);
    expect(outState.confidencePct).toBe(0);

    // 2. Manual Calibration recovers to Grand Central on line 4
    const calibrated = pf.setManualCalibration(
      { stationId: 'mta-grand-central-456', routeId: '4' },
      TS_WEEKDAY_MIDDAY + 500,
    );
    assertNoNaNInEstimatorState(calibrated);
    expect(calibrated.outOfNyc).toBe(false);
    expect(calibrated.manualAnchorActive).toBe(true);
    expect(calibrated.routeId).toBe('4');
    expect(calibrated.confidencePct).toBeGreaterThanOrEqual(80);

    // 3. Subsequent 1-second live heartbeat does NOT clobber manual calibration back to London
    const afterHeartbeat = pf.step({ tMs: TS_WEEKDAY_MIDDAY + 1500 }, 'live');
    assertNoNaNInEstimatorState(afterHeartbeat);
    expect(afterHeartbeat.outOfNyc).toBe(false);
    expect(afterHeartbeat.manualAnchorActive).toBe(true);
    expect(afterHeartbeat.routeId).toBe('4');
    expect(afterHeartbeat.confidencePct).toBeGreaterThanOrEqual(80);

    // 4. Subsequent London GPS fix also does NOT clobber active manual calibration
    const afterLondonFix = pf.step(
      { tMs: TS_WEEKDAY_MIDDAY + 2500, gps: londonGps },
      'live',
    );
    assertNoNaNInEstimatorState(afterLondonFix);
    expect(afterLondonFix.outOfNyc).toBe(false);
    expect(afterLondonFix.manualAnchorActive).toBe(true);
    expect(afterLondonFix.routeId).toBe('4');
    expect(afterLondonFix.confidencePct).toBeGreaterThanOrEqual(80);

    // 5. After resetCalibration() (Auto-Detect), a London GPS fix restores outOfNyc === true
    pf.resetCalibration();
    expect(pf.getState().manualAnchorActive).toBe(false);
    const afterReset = pf.step(
      { tMs: TS_WEEKDAY_MIDDAY + 3500, gps: londonGps },
      'live',
    );
    assertNoNaNInEstimatorState(afterReset);
    expect(afterReset.outOfNyc).toBe(true);
    expect(afterReset.confidencePct).toBe(0);
  });

  it('migrates cleanly off inactive route after resetCalibration() across midnight service-period boundary', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 19 });
    // 2026-06-10 23:59:50 EDT (WEEKDAY_EVENING) -> crosses midnight to 00:00:20 EDT (LATE_NIGHT)
    const startMs = Date.parse('2026-06-10T23:59:50-04:00');
    const imuSample = {
      accelLin: [0, 0.15, 0] as [number, number, number],
      accelGrav: [0, 9.81, 0] as [number, number, number],
      gyroRadS: [0, 0, 0] as [number, number, number],
    };

    // Prime clock at 23:59:50 EDT then anchor to B Uptown
    pf.step({ tMs: startMs, imu: imuSample }, 'live');
    const anchored = pf.setManualCalibration({ routeId: 'B', direction: 'UPTOWN' });
    assertNoNaNInEstimatorState(anchored);
    expect(anchored.manualAnchorActive).toBe(true);
    expect(anchored.routeId).toBe('B');

    // Step 30s across midnight to 00:00:20 EDT while anchored
    for (let s = 1; s <= 30; s++) {
      const st = pf.step({ tMs: startMs + s * 1000, imu: imuSample }, 'live');
      assertNoNaNInEstimatorState(st);
      expect(st.manualAnchorActive).toBe(true);
      expect(st.routeId).toBe('B');
    }

    // Release manual anchor during LATE_NIGHT (when B is inactive)
    pf.resetCalibration();
    expect(pf.getState().manualAnchorActive).toBe(false);

    // Step with IMU-only: should immediately migrate to an active LATE_NIGHT route
    for (let s = 31; s <= 40; s++) {
      const st = pf.step({ tMs: startMs + s * 1000, imu: imuSample }, 'live');
      assertNoNaNInEstimatorState(st);
      expect(st.manualAnchorActive).toBe(false);
      expect(st.routeId).not.toBeNull();
      expect(st.routeId).not.toBe('B');
      expect(st.confidencePct).toBeGreaterThan(0);
    }

    // Step with valid GPS fixes in Midtown 6th Ave
    for (let i = 0; i < 3; i++) {
      const st = pf.step(
        {
          tMs: startMs + (41 + i) * 1000,
          imu: imuSample,
          gps: {
            lat: 40.7505 + i * 0.0001,
            lon: -73.9878 + i * 0.0001,
            accuracyM: 12,
            speedMps: 10,
            headingDeg: 29,
            fixAgeMs: 0,
          },
        },
        'live',
      );
      assertNoNaNInEstimatorState(st);
      expect(st.manualAnchorActive).toBe(false);
      expect(st.routeId).not.toBeNull();
      expect(st.routeId).not.toBe('B');
      expect(st.confidencePct).toBeGreaterThan(0);
    }
  });

  it('meets < 5 ms/tick performance budget over 100 filter ticks', () => {
    const sim = new DeterministicSimSource(dataset, {
      scenarioId: 'lexington-underground',
      seed: 303,
      sampleRateHz: 10,
    });
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 1337 });

    const samples = sim.generateTrace(10, 0.1); // 100 ticks
    const t0 = performance.now();
    for (const s of samples) {
      pf.step(s, 'sim');
    }
    const elapsedMs = performance.now() - t0;
    const avgMsPerTick = elapsedMs / samples.length;

    expect(avgMsPerTick).toBeLessThan(5.0);
  });

  it('re-localizes on a single high-accuracy GPS fix after cold start and across large NYC location jumps', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 4242 });
    const t0 = Date.UTC(2026, 5, 10, 15, 30, 0);

    // Premature uniform cold-start step without GPS
    pf.step({ tMs: t0 }, 'live');

    // Single high-accuracy GPS fix in West Village (14th St / Christopher St area)
    const st1 = pf.step(
      {
        tMs: t0 + 1000,
        gps: {
          lat: 40.7334,
          lon: -74.0029,
          accuracyM: 12,
          speedMps: 6,
          headingDeg: 15,
          fixAgeMs: 0,
        },
      },
      'live',
    );
    assertNoNaNInEstimatorState(st1);
    expect(st1.outOfNyc).toBe(false);
    expect(st1.currentStationId).not.toBeNull();
    expect(Math.abs(st1.positionLatLng.lat - 40.7334)).toBeLessThan(0.01);

    // Single high-accuracy GPS jump ~10km north to Harlem River
    const st2 = pf.step(
      {
        tMs: t0 + 2000,
        gps: {
          lat: 40.8105,
          lon: -73.9335,
          accuracyM: 12,
          speedMps: 8,
          headingDeg: 25,
          fixAgeMs: 0,
        },
      },
      'live',
    );
    assertNoNaNInEstimatorState(st2);
    expect(st2.outOfNyc).toBe(false);
    expect(Math.abs(st2.positionLatLng.lat - 40.8105)).toBeLessThan(0.015);
    expect(Math.abs(st2.positionLatLng.lon - -73.9335)).toBeLessThan(0.015);
  });

  it('reports high confidence (>= 80% for station+line, >= 65% for single anchor) when manual calibration is active', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 777 });
    const t0 = Date.UTC(2026, 5, 10, 15, 30, 0);

    pf.setManualCalibration({ stationId: 'mta-canal-ace', routeId: 'A' });
    const stBoth = pf.step({ tMs: t0 + 500 }, 'live');
    expect(stBoth.manualAnchorActive).toBe(true);
    expect(stBoth.routeId).toBe('A');
    expect(stBoth.currentStationId).toBe('mta-canal-ace');
    expect(stBoth.confidencePct).toBeGreaterThanOrEqual(80);

    pf.setManualCalibration({ stationId: 'mta-canal-ace' });
    const stStationOnly = pf.step({ tMs: t0 + 1500 }, 'live');
    expect(stStationOnly.manualAnchorActive).toBe(true);
    expect(stStationOnly.confidencePct).toBeGreaterThanOrEqual(65);
  });

  it('identifies express-overtake as EXPRESS on initial moving tick via speed and heading physics', () => {
    const sim = new DeterministicSimSource(dataset, {
      scenarioId: 'express-overtake',
      seed: 202,
      sampleRateHz: 10,
      autoLoop: false,
    });
    const pf = new TrackParticleFilter(dataset, {
      particleCount: 300,
      seed: 1337,
    });

    const firstSample = sim.step(0.1);
    const state = pf.step(firstSample, 'sim');

    assertNoNaNInEstimatorState(state);
    expect(state.manualAnchorActive).toBe(false);
    expect(state.speedMph).toBeGreaterThan(0);
    expect(state.serviceType).toBe('EXPRESS');
    expect(state.routeId).toBe('A');
  });

  it('uses explicit tMs override in setManualCalibration after a backward clock jump to LATE_NIGHT', () => {
    const pf = new TrackParticleFilter(dataset, { particleCount: 300, seed: 888 });
    // First step at weekday midday (A runs EXPRESS)
    pf.step({ tMs: TS_WEEKDAY_MIDDAY }, 'live');
    const middayCal = pf.setManualCalibration(
      { stationId: 'mta-14st-ace', routeId: 'A' },
      TS_WEEKDAY_MIDDAY,
    );
    expect(middayCal.routeId).toBe('A');
    expect(middayCal.serviceType).toBe('EXPRESS');

    // Backward clock jump to LATE_NIGHT (A runs LOCAL on local track)
    const lateNightCal = pf.setManualCalibration(
      { stationId: 'mta-14st-ace', routeId: 'A' },
      TS_LATE_NIGHT,
    );
    expect(lateNightCal.routeId).toBe('A');
    expect(lateNightCal.serviceType).toBe('LOCAL');
    expect(lateNightCal.confidencePct).toBeGreaterThanOrEqual(80);
  });
});
