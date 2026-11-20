import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildTransitDataset,
  findNearbyLandmarks,
  findNearestStations,
  findNearestTracks,
  getDatasetJsonSizeBytes,
  getStationArcLengthOnTrack,
  getTracksForRoute,
  getTransitDataset,
  isWithinNycBounds,
  projectPointOntoTrack,
  serializeDataset,
  validateDataset,
} from '../../src/data/dataset';
import { SERVICE_PERIODS } from '../../src/data/schedules';
import { enuToWgs84, wgs84ToEnu } from '../../src/geo/projection';
import type { RailSystem, StructureType, TrackPoint, TrackPolyline } from '../../src/types/transit';

function makeSyntheticTrack(
  id: string,
  trunk: string,
  pts: Array<[number, number, number]>,
): TrackPolyline {
  const trackPoints: TrackPoint[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [e, n, u] = pts[i];
    if (i > 0) {
      const prev = pts[i - 1];
      s += Math.hypot(e - prev[0], n - prev[1], u - prev[2]);
    }
    const wgs = enuToWgs84(e, n, u);
    trackPoints.push({
      s,
      lat: wgs.lat,
      lon: wgs.lon,
      elevM: u,
      enu: [e, n, u],
      structure: 'UNDERGROUND_TUNNEL',
      gpsVisibility: 'UNDERGROUND',
    });
  }
  return {
    id,
    name: id,
    system: 'MTA',
    trunk,
    routes: ['TEST'],
    serviceType: 'LOCAL',
    direction: 'UPTOWN',
    color: '#ffffff',
    lateralOffsetM: 0,
    totalLengthM: s,
    points: trackPoints,
    stations: [],
  };
}

describe('TransitDataset — loader, coverage & integrity', () => {
  const dataset = getTransitDataset();

  it('memoizes singleton loader and populates map indices', () => {
    expect(getTransitDataset()).toBe(dataset);
    expect(dataset.stations.length).toBeGreaterThan(80);
    expect(dataset.tracks.length).toBeGreaterThan(30);
    expect(dataset.schedules.length).toBeGreaterThan(40);
    expect(dataset.stationById.size).toBe(dataset.stations.length);
    expect(dataset.trackById.size).toBe(dataset.tracks.length);
  });

  it('passes validateDataset() with zero errors', () => {
    const result = validateDataset(dataset);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.stats.crossingsChecked).toBeGreaterThan(0);
  });

  it('covers all 9 MTA trunks and all 5 regional rail systems', () => {
    const mtaTrunks = new Set(
      dataset.tracks.filter((t) => t.system === 'MTA').map((t) => t.trunk),
    );
    for (const trunk of ['1/2/3', '4/5/6', '7', 'A/C/E', 'B/D/F/M', 'N/Q/R/W', 'L', 'G', 'J/Z']) {
      expect(mtaTrunks.has(trunk)).toBe(true);
    }

    const systems: RailSystem[] = ['MTA', 'LIRR', 'MNR', 'PATH', 'NJT', 'AIRTRAIN'];
    for (const sys of systems) {
      expect(dataset.stations.some((s) => s.system === sys)).toBe(true);
      expect(dataset.tracks.some((t) => t.system === sys)).toBe(true);
      expect(dataset.schedules.some((sc) => sc.system === sys)).toBe(true);
    }
  });

  it('includes all required 3D structure types and bi-level separation', () => {
    const structures = new Set<StructureType>();
    for (const tr of dataset.tracks) {
      for (const pt of tr.points) {
        structures.add(pt.structure);
      }
    }
    for (const req of [
      'UNDERGROUND_TUNNEL',
      'UNDERWATER_TUNNEL',
      'ELEVATED',
      'BRIDGE',
      'OPEN_CUT',
      'AT_GRADE',
      'STATION',
    ] as const) {
      expect(structures.has(req)).toBe(true);
    }

    // Lexington Ave bi-level check: 6 Local (-12m) vs 4/5 Express (-20m) at Grand Central
    const lexLocal = dataset.trackById.get('mta-456-local-uptown')!;
    const lexExp = dataset.trackById.get('mta-456-express-uptown')!;
    const gctEnu = dataset.stationById.get('mta-grand-central-456')!.enu;
    const pLocal = projectPointOntoTrack(gctEnu, lexLocal);
    const pExp = projectPointOntoTrack(gctEnu, lexExp);
    expect(Math.abs(pLocal.enu[2] - pExp.enu[2])).toBeGreaterThanOrEqual(6);
  });

  it('includes all 4 normative rivers at Y=0, 5 boroughs, and 5 major bridges', () => {
    const riverMap = new Map(dataset.landmarks.waterBodies.map((w) => [w.id, w]));
    for (const id of ['east-river', 'hudson-river', 'harlem-river', 'upper-bay'] as const) {
      const r = riverMap.get(id);
      expect(r).toBeDefined();
      expect(r!.elevationM).toBe(0);
      expect(r!.polygonEnu.length).toBeGreaterThanOrEqual(3);
    }

    expect(dataset.landmarks.boroughs.length).toBe(5);

    const bridgeIds = new Set(dataset.landmarks.bridges.map((b) => b.id));
    for (const bid of [
      'manhattan-bridge',
      'williamsburg-bridge',
      'brooklyn-bridge',
      'queensboro-bridge',
      'george-washington-bridge',
    ]) {
      expect(bridgeIds.has(bid)).toBe(true);
    }
  });

  it('enforces MTA service period rules (B/W inactive late night & weekends, express->local late night)', () => {
    for (const sched of dataset.schedules) {
      for (const period of SERVICE_PERIODS) {
        expect(sched.periods[period]).toBeDefined();
      }
    }

    for (const routeId of ['B', 'W']) {
      const scheds = dataset.schedules.filter((s) => s.routeId === routeId);
      expect(scheds.length).toBeGreaterThan(0);
      for (const s of scheds) {
        expect(s.periods.WEEKDAY_AM_RUSH.active).toBe(true);
        expect(s.periods.WEEKDAY_MIDDAY.active).toBe(true);
        expect(s.periods.WEEKDAY_PM_RUSH.active).toBe(true);
        expect(s.periods.WEEKEND_DAY.active).toBe(false);
        expect(s.periods.LATE_NIGHT.active).toBe(false);
      }
    }

    for (const routeId of ['A', '2', '3', '4', '5', 'D', 'N', 'Q']) {
      const scheds = dataset.schedules.filter((s) => s.routeId === routeId);
      expect(scheds.length).toBeGreaterThan(0);
      for (const s of scheds) {
        expect(s.periods.LATE_NIGHT.serviceType).toBe('LOCAL');
        expect(s.periods.LATE_NIGHT.trackIdOverride).toBeDefined();
        expect(dataset.trackById.has(s.periods.LATE_NIGHT.trackIdOverride!)).toBe(true);
      }
    }
  });

  it('satisfies offline gzipped dataset size budget (< 250 KB)', () => {
    const payload = serializeDataset(dataset);
    const jsonBytes = getDatasetJsonSizeBytes(dataset);
    const gzBytes = gzipSync(Buffer.from(payload, 'utf-8')).byteLength;

    expect(jsonBytes).toBeGreaterThan(20 * 1024);
    expect(gzBytes).toBeGreaterThan(5 * 1024);
    expect(gzBytes).toBeLessThan(250 * 1024);
  });
});

describe('TransitDataset — spatial helpers', () => {
  const dataset = getTransitDataset();

  it('finds nearest tracks and stations in Midtown and returns empty far outside NYC', () => {
    const midtown: [number, number, number] = [0, 0, -15];
    const nearTracks = findNearestTracks(dataset, midtown, 600, { limit: 5 });
    expect(nearTracks.length).toBeGreaterThan(0);
    for (let i = 1; i < nearTracks.length; i++) {
      expect(nearTracks[i].distance2dM).toBeGreaterThanOrEqual(nearTracks[i - 1].distance2dM);
    }

    expect(findNearestTracks(dataset, [100000, 100000, 0], 500)).toEqual([]);

    const nearStations = findNearestStations(dataset, midtown, 5);
    expect(nearStations.length).toBe(5);
    for (let i = 1; i < nearStations.length; i++) {
      expect(nearStations[i].distance2dM).toBeGreaterThanOrEqual(nearStations[i - 1].distance2dM);
    }

    expect(isWithinNycBounds(dataset, [0, 0, 0])).toBe(true);
    expect(isWithinNycBounds(dataset, [200000, 200000, 0])).toBe(false);
  });

  it('finds East River and Manhattan Bridge from bridge midpoint with positive elevation', () => {
    const bridgeMid = wgs84ToEnu(40.7073, -73.9908, 42);
    const nearby = findNearbyLandmarks(dataset, bridgeMid, 1000);
    const river = nearby.find((l) => l.id === 'east-river');
    const bridge = nearby.find((l) => l.id === 'manhattan-bridge');
    expect(river).toBeDefined();
    expect(river!.relativeElevationM).toBeCloseTo(42, 1);
    expect(river!.relativeElevationFt).toBeGreaterThan(130);
    expect(bridge).toBeDefined();
  });

  it('resolves tracks for route and station arc-length on track', () => {
    const aTracks = getTracksForRoute(dataset, 'A');
    expect(aTracks.length).toBeGreaterThanOrEqual(2);

    const sTimesSq = getStationArcLengthOnTrack(
      dataset,
      'mta-times-sq-123',
      'mta-123-local-uptown',
    );
    expect(sTimesSq).not.toBeNull();
    expect(sTimesSq!).toBeGreaterThan(0);
    expect(getStationArcLengthOnTrack(dataset, 'nonexistent', 'mta-123-local-uptown')).toBeNull();
  });
});

describe('validateDataset — negative mutation tests', () => {
  it('catches NON_MONOTONIC_ARC_LENGTH, DEGENERATE_TRACK, BROKEN_REF, INVALID_ENUM, and MISSING_LANDMARK', () => {
    const base = buildTransitDataset();

    // 1. NON_MONOTONIC_ARC_LENGTH
    const badArc = buildTransitDataset();
    badArc.tracks[0].points[1].s = 0;
    expect(validateDataset(badArc).errors.some((e) => e.code === 'NON_MONOTONIC_ARC_LENGTH')).toBe(true);

    // 2. DEGENERATE_TRACK
    const badTrack = buildTransitDataset();
    badTrack.tracks[0].points = badTrack.tracks[0].points.slice(0, 1);
    expect(validateDataset(badTrack).errors.some((e) => e.code === 'DEGENERATE_TRACK')).toBe(true);

    // 3. NON_MONOTONIC_STOP_S
    const badStopOrder = buildTransitDataset();
    badStopOrder.tracks[0].stations[1].s = badStopOrder.tracks[0].stations[0].s;
    expect(validateDataset(badStopOrder).errors.some((e) => e.code === 'NON_MONOTONIC_STOP_S')).toBe(true);

    // 4. BROKEN_REF
    const brokenRef = buildTransitDataset();
    brokenRef.schedules[0].trackId = 'does-not-exist';
    expect(validateDataset(brokenRef).errors.some((e) => e.code === 'BROKEN_REF')).toBe(true);

    // 5. INVALID_ENUM
    const badEnum = buildTransitDataset();
    (badEnum.stations[0] as unknown as { system: string }).system = 'FAKE_RAIL';
    expect(validateDataset(badEnum).errors.some((e) => e.code === 'INVALID_ENUM')).toBe(true);

    // 6. MISSING_LANDMARK
    const missingRiver = buildTransitDataset();
    missingRiver.landmarks.waterBodies = missingRiver.landmarks.waterBodies.filter(
      (w) => w.id !== 'east-river',
    );
    expect(validateDataset(missingRiver).errors.some((e) => e.code === 'MISSING_LANDMARK')).toBe(true);

    // Ensure base was never mutated
    expect(validateDataset(base).valid).toBe(true);
  });

  it('catches CROSSING_CLEARANCE_VIOLATION (< 4.5m) and passes when separated (>= 4.5m)', () => {
    const base = buildTransitDataset();

    // Two perpendicular tracks crossing at ENU (5000, 5000) with only 2m vertical separation
    const trA = makeSyntheticTrack('synth-a', 'trunk-a', [
      [4900, 5000, -10],
      [5100, 5000, -10],
    ]);
    const trBTooClose = makeSyntheticTrack('synth-b', 'trunk-b', [
      [5000, 4900, -12],
      [5000, 5100, -12],
    ]);
    const failing = buildTransitDataset({
      stations: [],
      tracks: [trA, trBTooClose],
      schedules: [],
      landmarks: base.landmarks,
    });
    const failRes = validateDataset(failing);
    expect(failRes.valid).toBe(false);
    expect(failRes.errors.some((e) => e.code === 'CROSSING_CLEARANCE_VIOLATION')).toBe(true);

    // Now separate by 6m (-10m vs -16m) -> passes cleanly
    const trBSeparated = makeSyntheticTrack('synth-b', 'trunk-b', [
      [5000, 4900, -16],
      [5000, 5100, -16],
    ]);
    const passing = buildTransitDataset({
      stations: [],
      tracks: [trA, trBSeparated],
      schedules: [],
      landmarks: base.landmarks,
    });
    const passRes = validateDataset(passing);
    expect(passRes.errors).toEqual([]);
    expect(passRes.valid).toBe(true);
  });
});
