import { describe, expect, it } from 'vitest';
import {
  ALT_0,
  buildTrackPoints,
  distanceEnu2D,
  distanceEnu3D,
  enuToThree,
  enuToWgs84,
  isInsideNycBounds,
  LAT_0,
  LON_0,
  M_LAT,
  M_LON,
  samplePolylineAtS,
  threeToEnu,
  wgs84ToEnu,
  wrapAngleRad,
} from '../../src/geo/projection';
import type { GpsVisibility, StructureType, TrackPoint } from '../../src/types/transit';

function makeTrackPoint(
  s: number,
  e: number,
  n: number,
  u: number,
  structure: StructureType = 'UNDERGROUND_TUNNEL',
  gpsVisibility: GpsVisibility = 'UNDERGROUND',
): TrackPoint {
  const wgs = enuToWgs84(e, n, u);
  return {
    s,
    lat: wgs.lat,
    lon: wgs.lon,
    elevM: u,
    enu: [e, n, u],
    structure,
    gpsVisibility,
  };
}

describe('projection — origin & constants', () => {
  it('uses Midtown Manhattan origin constants matching PROJECT.md', () => {
    expect(LAT_0).toBe(40.7549);
    expect(LON_0).toBe(-73.984);
    expect(ALT_0).toBe(0);
    expect(M_LAT).toBe(111048.8);
    expect(M_LON).toBe(84327.6);
  });

  it('maps origin (LAT_0, LON_0, 0) to [0, 0, 0] and back', () => {
    const enu = wgs84ToEnu(LAT_0, LON_0, 0);
    expect(enu[0]).toBeCloseTo(0, 10);
    expect(enu[1]).toBeCloseTo(0, 10);
    expect(enu[2]).toBeCloseTo(0, 10);

    const enuDefaultElev = wgs84ToEnu(LAT_0, LON_0);
    expect(enuDefaultElev).toEqual([0, 0, 0]);

    const wgs = enuToWgs84(0, 0, 0);
    expect(wgs.lat).toBeCloseTo(LAT_0, 10);
    expect(wgs.lon).toBeCloseTo(LON_0, 10);
    expect(wgs.elevM).toBeCloseTo(0, 10);
  });
});

describe('projection — WGS84 <-> ENU round-trip accuracy', () => {
  const cases: Array<[string, number, number, number]> = [
    ['Times Square Underground', 40.7553, -73.9875, -16],
    ['Manhattan Bridge Deck', 40.7073, -73.9908, 42],
    ['George Washington Bridge', 40.8517, -73.9527, 65],
    ['JFK AirTrain Terminal 4', 40.6441, -73.7824, 12],
    ['Newark Penn Station', 40.7347, -74.1642, 6],
    ['East River Underwater Tunnel', 40.747, -73.9648, -34],
  ];

  it.each(cases)('round-trips %s within 1e-6', (_name, lat, lon, elevM) => {
    const enu = wgs84ToEnu(lat, lon, elevM);
    const rt = enuToWgs84(enu[0], enu[1], enu[2]);
    expect(Math.abs(rt.lat - lat)).toBeLessThan(1e-6);
    expect(Math.abs(rt.lon - lon)).toBeLessThan(1e-6);
    expect(Math.abs(rt.elevM - elevM)).toBeLessThan(1e-6);
  });

  it('has correct directional signs and metric scale', () => {
    const northPt = wgs84ToEnu(LAT_0 + 0.01, LON_0, 5);
    expect(northPt[0]).toBeCloseTo(0, 8);
    expect(northPt[1]).toBeCloseTo(0.01 * M_LAT, 6);
    expect(northPt[2]).toBe(5);

    const eastPt = wgs84ToEnu(LAT_0, LON_0 + 0.01, -12);
    expect(eastPt[0]).toBeCloseTo(0.01 * M_LON, 6);
    expect(eastPt[1]).toBeCloseTo(0, 8);
    expect(eastPt[2]).toBe(-12);
  });

  it('checks NYC metro bounds accurately', () => {
    expect(isInsideNycBounds(40.7549, -73.984)).toBe(true);
    expect(isInsideNycBounds(40.7347, -74.1642)).toBe(true);
    expect(isInsideNycBounds(37.7749, -122.4194)).toBe(false); // San Francisco
    expect(isInsideNycBounds(51.5074, -0.1278)).toBe(false); // London
  });
});

describe('projection — ENU <-> Three.js axis mapping (X=E, Y=U, Z=-N)', () => {
  it('maps arbitrary ENU coordinates to Three.js and back', () => {
    const three = enuToThree(123.4, 567.8, -18.5);
    expect(three).toEqual([123.4, -18.5, -567.8]);
    expect(threeToEnu(three[0], three[1], three[2])).toEqual([123.4, 567.8, -18.5]);
  });

  it('maps cardinal basis vectors cleanly', () => {
    expect(enuToThree(0, 10, 0)).toEqual([0, 0, -10]); // North -> -Z
    expect(enuToThree(10, 0, 0)).toEqual([10, 0, 0]); // East -> +X
    expect(enuToThree(0, 0, 10)).toEqual([0, 10, 0]); // Up -> +Y
  });
});

describe('projection — helpers & lateral offset buildTrackPoints', () => {
  it('wraps angles into (-PI, PI] and computes 2D/3D distances', () => {
    expect(wrapAngleRad(0)).toBeCloseTo(0, 10);
    expect(wrapAngleRad(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
    expect(wrapAngleRad(-1.5 * Math.PI)).toBeCloseTo(0.5 * Math.PI, 10);
    expect(distanceEnu2D([0, 0, 0], [3, 4, 12])).toBeCloseTo(5, 10);
    expect(distanceEnu3D([0, 0, 0], [3, 4, 12])).toBeCloseTo(13, 10);
  });

  it('offsets parallel tracks horizontally along right-hand normal', () => {
    const base = [
      { lat: LAT_0, lon: LON_0, elevM: -15, structure: 'UNDERGROUND_TUNNEL' as const, gpsVisibility: 'UNDERGROUND' as const },
      { lat: LAT_0 + 0.001, lon: LON_0, elevM: -15, structure: 'UNDERGROUND_TUNNEL' as const, gpsVisibility: 'UNDERGROUND' as const },
    ];
    const rightPts = buildTrackPoints(base, 6);
    const leftPts = buildTrackPoints(base, -6);

    // Heading due North -> +6m right-hand normal shifts East (+6)
    expect(rightPts[0].enu[0]).toBeCloseTo(6, 5);
    expect(leftPts[0].enu[0]).toBeCloseTo(-6, 5);
    expect(rightPts[0].s).toBe(0);
    expect(rightPts[1].s).toBeCloseTo(0.001 * M_LAT, 3);
  });
});

describe('samplePolylineAtS — straight, boundaries & headings', () => {
  const straightNorth: TrackPoint[] = [
    makeTrackPoint(0, 0, 0, -10),
    makeTrackPoint(100, 0, 100, -10),
  ];

  it('interpolates midpoint and clamps out-of-range s', () => {
    const mid = samplePolylineAtS(straightNorth, 50);
    expect(mid.enu[0]).toBeCloseTo(0, 8);
    expect(mid.enu[1]).toBeCloseTo(50, 8);
    expect(mid.enu[2]).toBeCloseTo(-10, 8);
    expect(mid.tangentEnu).toEqual([0, 1, 0]);
    expect(mid.headingRad).toBeCloseTo(0, 8);
    expect(mid.pitchRad).toBeCloseTo(0, 8);
    expect(mid.curvature).toBeCloseTo(0, 8);

    const beforeStart = samplePolylineAtS(straightNorth, -25);
    expect(beforeStart.s).toBe(0);
    expect(beforeStart.enu).toEqual([0, 0, -10]);

    const afterEnd = samplePolylineAtS(straightNorth, 250);
    expect(afterEnd.s).toBe(100);
    expect(afterEnd.enu).toEqual([0, 100, -10]);
  });

  it('computes compass headings accurately for N, E, S, W, NE', () => {
    const north = samplePolylineAtS([makeTrackPoint(0, 0, 0, 0), makeTrackPoint(100, 0, 100, 0)], 50);
    const east = samplePolylineAtS([makeTrackPoint(0, 0, 0, 0), makeTrackPoint(100, 100, 0, 0)], 50);
    const south = samplePolylineAtS([makeTrackPoint(0, 0, 0, 0), makeTrackPoint(100, 0, -100, 0)], 50);
    const west = samplePolylineAtS([makeTrackPoint(0, 0, 0, 0), makeTrackPoint(100, -100, 0, 0)], 50);
    const ne = samplePolylineAtS(
      [makeTrackPoint(0, 0, 0, 0), makeTrackPoint(Math.hypot(100, 100), 100, 100, 0)],
      50,
    );

    expect(north.headingRad).toBeCloseTo(0, 6);
    expect(east.headingRad).toBeCloseTo(Math.PI / 2, 6);
    expect(Math.abs(south.headingRad)).toBeCloseTo(Math.PI, 6);
    expect(west.headingRad).toBeCloseTo(-Math.PI / 2, 6);
    expect(ne.headingRad).toBeCloseTo(Math.PI / 4, 6);
  });

  it('handles empty, single-point, and duplicate-point edge cases', () => {
    expect(() => samplePolylineAtS([], 0)).toThrow();

    const single = samplePolylineAtS([makeTrackPoint(0, 5, 10, -2, 'STATION', 'UNDERGROUND')], 50);
    expect(single.enu).toEqual([5, 10, -2]);
    expect(single.structure).toBe('STATION');

    const dup = samplePolylineAtS(
      [
        makeTrackPoint(0, 0, 0, 0),
        makeTrackPoint(0, 0, 0, 0),
        makeTrackPoint(100, 100, 0, 0),
      ],
      0,
    );
    expect(dup.tangentEnu[0]).toBeCloseTo(1, 6);
    expect(dup.headingRad).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('samplePolylineAtS — pitch & curvature', () => {
  it('computes accurate positive and negative pitch on sloped ramps', () => {
    const climbLen = Math.hypot(100, 10);
    const climb = samplePolylineAtS(
      [makeTrackPoint(0, 0, 0, 0), makeTrackPoint(climbLen, 0, 100, 10)],
      climbLen / 2,
    );
    expect(climb.pitchRad).toBeGreaterThan(0);
    expect(climb.pitchRad).toBeCloseTo(Math.atan2(10, 100), 5);
    expect(Math.hypot(...climb.tangentEnu)).toBeCloseTo(1, 8);

    const diveLen = Math.hypot(100, 15);
    const dive = samplePolylineAtS(
      [makeTrackPoint(0, 0, 0, 0), makeTrackPoint(diveLen, 0, 100, -15)],
      diveLen / 2,
    );
    expect(dive.pitchRad).toBeLessThan(0);
    expect(dive.pitchRad).toBeCloseTo(Math.atan2(-15, 100), 5);
  });

  it('computes signed curvature ~ +/- 1/R on 90-deg circular arcs', () => {
    const R = 200;
    const segs = 36;

    // Clockwise (right-hand) turn from North (0) to East (+PI/2)
    // Center at (R, 0), start at (0, 0) moving North
    const cwPts: TrackPoint[] = [];
    let sCw = 0;
    for (let i = 0; i <= segs; i++) {
      const theta = (i / segs) * (Math.PI / 2);
      const e = R - R * Math.cos(theta);
      const n = R * Math.sin(theta);
      if (i > 0) {
        const prev = cwPts[i - 1].enu;
        sCw += Math.hypot(e - prev[0], n - prev[1]);
      }
      cwPts.push(makeTrackPoint(sCw, e, n, 0));
    }

    // Counter-clockwise (left-hand) turn from North (0) to West (-PI/2)
    // Center at (-R, 0), start at (0, 0) moving North
    const ccwPts: TrackPoint[] = [];
    let sCcw = 0;
    for (let i = 0; i <= segs; i++) {
      const theta = (i / segs) * (Math.PI / 2);
      const e = -R + R * Math.cos(theta);
      const n = R * Math.sin(theta);
      if (i > 0) {
        const prev = ccwPts[i - 1].enu;
        sCcw += Math.hypot(e - prev[0], n - prev[1]);
      }
      ccwPts.push(makeTrackPoint(sCcw, e, n, 0));
    }

    const cwMid = samplePolylineAtS(cwPts, sCw / 2);
    const ccwMid = samplePolylineAtS(ccwPts, sCcw / 2);

    const expectedK = 1 / R; // 0.005 rad/m
    expect(cwMid.curvature).toBeGreaterThan(0);
    expect(ccwMid.curvature).toBeLessThan(0);
    expect(cwMid.curvature * ccwMid.curvature).toBeLessThan(0);
    expect(Math.abs(cwMid.curvature - expectedK) / expectedK).toBeLessThan(0.1);
    expect(Math.abs(Math.abs(ccwMid.curvature) - expectedK) / expectedK).toBeLessThan(0.1);
  });

  it('returns correct structure & gpsVisibility across multi-segment transitions', () => {
    const pts: TrackPoint[] = [
      makeTrackPoint(0, 0, 0, -15, 'UNDERGROUND_TUNNEL', 'UNDERGROUND'),
      makeTrackPoint(100, 0, 100, 0, 'OPEN_CUT', 'PORTAL'),
      makeTrackPoint(200, 0, 200, 40, 'BRIDGE', 'OPEN_SKY'),
      makeTrackPoint(300, 0, 300, 15, 'ELEVATED', 'OPEN_SKY'),
    ];

    expect(samplePolylineAtS(pts, 50)).toMatchObject({
      structure: 'UNDERGROUND_TUNNEL',
      gpsVisibility: 'UNDERGROUND',
    });
    expect(samplePolylineAtS(pts, 150)).toMatchObject({
      structure: 'OPEN_CUT',
      gpsVisibility: 'PORTAL',
    });
    expect(samplePolylineAtS(pts, 250)).toMatchObject({
      structure: 'BRIDGE',
      gpsVisibility: 'OPEN_SKY',
    });
    expect(samplePolylineAtS(pts, 350)).toMatchObject({
      structure: 'ELEVATED',
      gpsVisibility: 'OPEN_SKY',
    });
  });
});
