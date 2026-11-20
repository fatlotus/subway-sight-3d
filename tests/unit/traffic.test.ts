import { describe, expect, it } from 'vitest';
import { getTransitDataset } from '../../src/data/dataset';
import {
  distanceEnu3D,
  samplePolylineAtS,
  wgs84ToEnu,
} from '../../src/geo/projection';
import { DeterministicSimSource } from '../../src/sensors/simSensorSource';
import {
  buildEgoConsist,
  buildWorldStateSnapshot,
  computeNearbyLandmarks,
  computeNearbyTrains,
} from '../../src/traffic/trafficEngine';
import type { DemoScenarioId } from '../../src/types/sensors';
import type { EstimatorState } from '../../src/types/state';
import type { RailSystem, Vec3 } from '../../src/types/transit';

const TS_WEEKDAY_AM_RUSH = Date.UTC(2026, 0, 14, 13, 30, 0); // Wed 08:30 AM EST
const TS_WEEKEND_DAY = Date.UTC(2026, 0, 17, 19, 0, 0); // Sat 02:00 PM EST
const TS_LATE_NIGHT = Date.UTC(2026, 0, 14, 7, 30, 0); // Wed 02:30 AM EST

function makeEgo(overrides: Partial<EstimatorState>): EstimatorState {
  const enu: Vec3 = overrides.positionEnu ?? [0, 0, -15];
  return {
    routeId: 'A',
    serviceType: 'EXPRESS',
    direction: 'UPTOWN',
    displayLabel: 'A Express — Uptown',
    confidencePct: 95,
    candidates: [],
    currentStationId: null,
    currentStationName: 'Test Station',
    nextStationId: null,
    nextStationName: 'Next Station',
    etaSec: 45,
    positionEnu: enu,
    positionLatLng: { lat: 40.7549, lon: -73.984 },
    headingRad: 0,
    pitchRad: 0,
    speedMps: 15,
    speedMph: 33.5,
    elevationM: enu[2],
    elevationFt: enu[2] * 3.28084,
    structure: 'UNDERGROUND_TUNNEL',
    outOfNyc: false,
    manualAnchorActive: false,
    sensorStatus: { gps: 'simulated', dr: 'simulated', timing: 'active' },
    trackId: 'mta-ace-express-uptown',
    trackS: 6500,
    system: 'MTA',
    routeColor: '#0039A6',
    ...overrides,
  };
}

describe('TrafficEngine — Articulated egoConsist', () => {
  const dataset = getTransitDataset();

  it('builds 8-11 articulated cars matching schedule carCount along curved/sloped 3D spline', () => {
    const track = dataset.trackById.get('mta-bdfm-express-uptown')!;
    const pose = samplePolylineAtS(track.points, 1200); // Climbing Manhattan Bridge
    const ego = makeEgo({
      routeId: 'D',
      trackId: track.id,
      trackS: 1200,
      positionEnu: pose.enu,
      headingRad: pose.headingRad,
      pitchRad: pose.pitchRad,
    });

    const consist = buildEgoConsist(dataset, ego);
    expect(consist.length).toBeGreaterThanOrEqual(8);
    expect(consist.length).toBeLessThanOrEqual(11);

    // Adjacent cars separated by ~carLengthM + 0.6m
    const expectedSpacing = consist[0].lengthM + 0.6;
    for (let i = 1; i < consist.length; i++) {
      const dist = distanceEnu3D(consist[i - 1].enu, consist[i].enu);
      expect(dist).toBeGreaterThan(expectedSpacing - 1.5);
      expect(dist).toBeLessThan(expectedSpacing + 1.5);
    }

    // Climbing bridge -> lead car higher than tail car
    expect(consist[0].enu[2]).toBeGreaterThan(consist[consist.length - 1].enu[2]);
  });

  it('extrapolates cleanly at terminal trackS = 0 without collapsing cars', () => {
    const track = dataset.trackById.get('mta-ace-express-uptown')!;
    const pose = samplePolylineAtS(track.points, 0);
    const ego = makeEgo({
      routeId: 'A',
      trackId: track.id,
      trackS: 0,
      positionEnu: pose.enu,
    });

    const consist = buildEgoConsist(dataset, ego);
    expect(consist.length).toBe(10);
    for (let i = 1; i < consist.length; i++) {
      const dist = distanceEnu3D(consist[i - 1].enu, consist[i].enu);
      expect(dist).toBeGreaterThan(15);
    }
  });
});

describe('TrafficEngine — Nearby Trains, Regional Systems & Signal-Block Separation', () => {
  const dataset = getTransitDataset();

  it('is deterministic for identical inputs and advances smoothly over time', () => {
    const ego = makeEgo({
      positionEnu: wgs84ToEnu(40.7505, -73.991, -15),
      trackId: 'mta-ace-express-uptown',
      trackS: 7600,
    });

    const a = computeNearbyTrains(dataset, ego, TS_WEEKDAY_AM_RUSH);
    const b = computeNearbyTrains(dataset, ego, TS_WEEKDAY_AM_RUSH);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);

    const later = computeNearbyTrains(dataset, ego, TS_WEEKDAY_AM_RUSH + 10_000);
    const shared = a.find((t) => later.some((u) => u.id === t.id));
    expect(shared).toBeDefined();
  });

  it('covers MTA and all 5 regional rail systems (LIRR, MNR, PATH, NJT, AIRTRAIN)', () => {
    // Penn / Herald Sq hub -> MTA, LIRR, PATH, NJT
    const pennEgo = makeEgo({
      positionEnu: wgs84ToEnu(40.7505, -73.991, -15),
      trackId: 'mta-bdfm-local-uptown',
      trackS: 7050,
    });
    const pennTrains = computeNearbyTrains(dataset, pennEgo, TS_WEEKDAY_AM_RUSH, {
      maxTrainRadiusM: 3000,
      maxNearbyTrains: 80,
    });
    const pennSystems = new Set(pennTrains.map((t) => t.system));
    expect(pennSystems.has('MTA')).toBe(true);
    expect(pennSystems.has('LIRR')).toBe(true);
    expect(pennSystems.has('PATH')).toBe(true);
    expect(pennSystems.has('NJT')).toBe(true);

    // Grand Central hub -> MNR + LIRR + MTA
    const gctEgo = makeEgo({
      positionEnu: wgs84ToEnu(40.7527, -73.9772, -12),
      trackId: 'mta-456-express-uptown',
      trackS: 10018,
    });
    const gctTrains = computeNearbyTrains(dataset, gctEgo, TS_WEEKDAY_AM_RUSH, {
      maxTrainRadiusM: 3000,
      maxNearbyTrains: 80,
    });
    const gctSystems = new Set(gctTrains.map((t) => t.system));
    expect(gctSystems.has('MNR')).toBe(true);
    expect(gctSystems.has('LIRR')).toBe(true);

    // Jamaica hub -> AIRTRAIN + LIRR
    const jamaicaEgo = makeEgo({
      positionEnu: wgs84ToEnu(40.7005, -73.8085, 8),
      trackId: null,
      trackS: 0,
    });
    const jamaicaTrains = computeNearbyTrains(dataset, jamaicaEgo, TS_WEEKDAY_AM_RUSH, {
      maxTrainRadiusM: 5000,
      maxNearbyTrains: 40,
    });
    const jamaicaSystems = new Set(jamaicaTrains.map((t) => t.system));
    expect(jamaicaSystems.has('AIRTRAIN')).toBe(true);
    expect(jamaicaSystems.has('LIRR')).toBe(true);
  });

  it('excludes inactive B and W trains during late night and weekends', () => {
    const ego = makeEgo({
      positionEnu: wgs84ToEnu(40.7505, -73.987, -15),
      trackId: 'mta-bdfm-local-uptown',
      trackS: 7050,
    });

    for (const ts of [TS_LATE_NIGHT, TS_WEEKEND_DAY]) {
      const trains = computeNearbyTrains(dataset, ego, ts, {
        maxTrainRadiusM: 4000,
        maxNearbyTrains: 80,
      });
      expect(trains.some((t) => t.routeId === 'B' || t.routeId === 'W')).toBe(
        false,
      );
    }
  });

  it('enforces >= 300m signal-block separation on the ego track across timestamps', () => {
    const track = dataset.trackById.get('mta-456-express-uptown')!;
    const egoS = 7800;
    const pose = samplePolylineAtS(track.points, egoS);
    const ego = makeEgo({
      routeId: '4',
      trackId: track.id,
      trackS: egoS,
      positionEnu: pose.enu,
    });

    for (let step = 0; step < 20; step++) {
      const ts = TS_WEEKDAY_AM_RUSH + step * 30_000;
      const trains = computeNearbyTrains(dataset, ego, ts, {
        signalBlockSeparationM: 300,
        maxTrainRadiusM: 2500,
        maxNearbyTrains: 60,
      });

      const sameTrackTrains = trains.filter(
        (t) =>
          (t.routeId === '4' || t.routeId === '5') &&
          t.id.includes('uptown'),
      );
      for (const tr of sameTrackTrains) {
        expect(tr.distanceM).toBeGreaterThanOrEqual(290);
      }
    }
  });

  it('surfaces expected regional rail systems (LIRR, NJT, MNR, PATH) during 200s demo rides with default options', () => {
    const expectations: Array<{
      scenarioId: DemoScenarioId;
      requiredSystems: RailSystem[];
    }> = [
      {
        scenarioId: 'express-overtake',
        requiredSystems: ['MTA', 'PATH', 'LIRR', 'NJT'],
      },
      {
        scenarioId: 'lexington-underground',
        requiredSystems: ['MTA', 'MNR', 'LIRR'],
      },
      {
        scenarioId: 'midtown-multi-system',
        requiredSystems: ['MTA', 'PATH', 'LIRR', 'NJT'],
      },
    ];

    for (const { scenarioId, requiredSystems } of expectations) {
      const sim = new DeterministicSimSource(dataset, {
        scenarioId,
        sampleRateHz: 1,
        autoLoop: true,
      });
      const seenSystems = new Set<RailSystem>();

      for (let t = 0; t < 200; t++) {
        const sample = sim.step(1.0);
        const gt = sim.getGroundTruth();
        const ego = makeEgo({
          routeId: gt.routeId,
          trackId: gt.trackId,
          trackS: gt.s,
          positionEnu: gt.enu,
          headingRad: gt.headingRad,
          pitchRad: gt.pitchRad,
          speedMps: gt.speedMps,
          structure: gt.structure,
        });

        const trains = computeNearbyTrains(dataset, ego, sample.tMs);
        expect(trains.length).toBeLessThanOrEqual(32);
        for (const tr of trains) {
          seenSystems.add(tr.system);
        }
      }

      for (const sys of requiredSystems) {
        expect(
          seenSystems.has(sys),
          `Expected ${sys} in nearbyTrains during ${scenarioId}`,
        ).toBe(true);
      }
    }
  });

  it('respects maxNearbyTrains bounds including 0, 1, and 4 with ascending distanceM and unique IDs', () => {
    const sim = new DeterministicSimSource(dataset, {
      scenarioId: 'midtown-multi-system',
      sampleRateHz: 1,
      autoLoop: true,
    });
    let sample = sim.step(1.0);
    for (let t = 1; t < 60; t++) {
      sample = sim.step(1.0);
    }
    const gt = sim.getGroundTruth();
    const ego = makeEgo({
      routeId: gt.routeId,
      trackId: gt.trackId,
      trackS: gt.s,
      positionEnu: gt.enu,
      headingRad: gt.headingRad,
      pitchRad: gt.pitchRad,
      speedMps: gt.speedMps,
      structure: gt.structure,
    });

    const zeroTrains = computeNearbyTrains(dataset, ego, sample.tMs, {
      maxTrainRadiusM: 2500,
      maxNearbyTrains: 0,
    });
    expect(zeroTrains).toEqual([]);

    for (const limit of [1, 4]) {
      const trains = computeNearbyTrains(dataset, ego, sample.tMs, {
        maxTrainRadiusM: 2500,
        maxNearbyTrains: limit,
      });
      expect(trains.length).toBeLessThanOrEqual(limit);
      expect(trains.length).toBeGreaterThan(0);

      const ids = new Set<string>();
      for (let i = 0; i < trains.length; i++) {
        expect(ids.has(trains[i].id)).toBe(false);
        ids.add(trains[i].id);
        if (i > 0) {
          expect(trains[i].distanceM).toBeGreaterThanOrEqual(
            trains[i - 1].distanceM,
          );
        }
      }
    }
  });
});

describe('TrafficEngine — Landmarks & WorldStateSnapshot', () => {
  const dataset = getTransitDataset();

  it('computes accurate relativeElevationFt sign for bridges (river below) and tunnels (river overhead)', () => {
    // Manhattan Bridge midpoint (+42m above East River at 0m) -> positive > +130 ft
    const bridgeEgo = makeEgo({
      positionEnu: wgs84ToEnu(40.7073, -73.9908, 42),
      structure: 'BRIDGE',
    });
    const bridgeLandmarks = computeNearbyLandmarks(dataset, bridgeEgo, 2000);
    const eastRiverBridge = bridgeLandmarks.find((l) => l.id === 'east-river');
    expect(eastRiverBridge).toBeDefined();
    expect(eastRiverBridge!.distanceM).toBe(0);
    expect(eastRiverBridge!.relativeElevationFt).toBeGreaterThan(130);
    expect(bridgeLandmarks.some((l) => l.id === 'manhattan-bridge')).toBe(true);

    // Steinway Tunnel (-34m under East River) -> negative < -100 ft
    const steinwayEgo = makeEgo({
      positionEnu: wgs84ToEnu(40.747, -73.9648, -34),
      structure: 'UNDERWATER_TUNNEL',
    });
    const steinwayLandmarks = computeNearbyLandmarks(dataset, steinwayEgo, 2000);
    const eastRiverTunnel = steinwayLandmarks.find((l) => l.id === 'east-river');
    expect(eastRiverTunnel).toBeDefined();
    expect(eastRiverTunnel!.distanceM).toBe(0);
    expect(eastRiverTunnel!.relativeElevationFt).toBeLessThan(-100);

    // Hudson River Tunnel (-34m under Hudson River) -> negative < -100 ft
    const hudsonEgo = makeEgo({
      positionEnu: wgs84ToEnu(40.7545, -74.011, -34),
      structure: 'UNDERWATER_TUNNEL',
    });
    const hudsonLandmarks = computeNearbyLandmarks(dataset, hudsonEgo, 2000);
    const hudsonRiver = hudsonLandmarks.find((l) => l.id === 'hudson-river');
    expect(hudsonRiver).toBeDefined();
    expect(hudsonRiver!.distanceM).toBe(0);
    expect(hudsonRiver!.relativeElevationFt).toBeLessThan(-100);
  });

  it('builds a complete WorldStateSnapshot and empties arrays when outOfNyc is true', () => {
    const ego = makeEgo({
      positionEnu: wgs84ToEnu(40.7073, -73.9908, 42),
      trackId: 'mta-bdfm-express-uptown',
      trackS: 1981,
    });
    const snap = buildWorldStateSnapshot({
      dataset,
      ego,
      timestampMs: TS_WEEKDAY_AM_RUSH,
      mode: 'sim',
      scenarioId: 'manhattan-bridge',
    });

    expect(snap.egoConsist.length).toBeGreaterThanOrEqual(8);
    expect(snap.nearbyTrains.length).toBeGreaterThan(0);
    expect(snap.nearbyLandmarks.length).toBeGreaterThan(0);

    // Out-of-NYC returns empty arrays cleanly
    const oonSnap = buildWorldStateSnapshot({
      dataset,
      ego: makeEgo({ outOfNyc: true }),
      timestampMs: TS_WEEKDAY_AM_RUSH,
      mode: 'live',
    });
    expect(oonSnap.egoConsist).toEqual([]);
    expect(oonSnap.nearbyTrains).toEqual([]);
    expect(oonSnap.nearbyLandmarks).toEqual([]);
  });
});
