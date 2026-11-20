import type {
  GpsVisibility,
  SampledTrackPoint,
  StructureType,
  TrackPoint,
  Vec3,
} from '../types/transit';

/** Midtown Manhattan coordinate origin (Single Source of Truth). */
export const LAT_0 = 40.7549;
export const LON_0 = -73.9840;
export const ALT_0 = 0.0;

/** Local linearized meters-per-degree scales at 40.7549°N. */
export const M_LAT = 111048.8;
export const M_LON = 84327.6;

/** Loose NYC metro bounding box for fast out-of-NYC detection. */
export const NYC_BOUNDS = {
  minLat: 40.45,
  maxLat: 41.05,
  minLon: -74.35,
  maxLon: -73.65,
} as const;

export interface RawTrackWaypoint {
  lat: number;
  lon: number;
  elevM: number;
  structure: StructureType;
  gpsVisibility: GpsVisibility;
  maxSpeedMps?: number;
}

/** Convert WGS84 (lat, lon, elevM) to Midtown local ENU [east, north, up] in meters. */
export function wgs84ToEnu(lat: number, lon: number, elevM = 0): Vec3 {
  const east = (lon - LON_0) * M_LON;
  const north = (lat - LAT_0) * M_LAT;
  const up = elevM - ALT_0;
  return [east, north, up];
}

/** Exact algebraic inverse of wgs84ToEnu. */
export function enuToWgs84(
  e: number,
  n: number,
  u = 0,
): { lat: number; lon: number; elevM: number } {
  return {
    lat: LAT_0 + n / M_LAT,
    lon: LON_0 + e / M_LON,
    elevM: ALT_0 + u,
  };
}

/** Convert ENU [east, north, up] to Three.js right-handed [X=E, Y=U, Z=-N]. */
export function enuToThree(e: number, n: number, u: number): Vec3 {
  return [e, u, n === 0 ? 0 : -n];
}

/** Convert Three.js [X, Y, Z] back to ENU [east, north, up]. */
export function threeToEnu(x: number, y: number, z: number): Vec3 {
  return [x, z === 0 ? 0 : -z, y];
}

/** Wrap any angle in radians into (-PI, PI]. */
export function wrapAngleRad(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

/** 2D horizontal distance in ENU (East, North). */
export function distanceEnu2D(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 3D Euclidean distance in ENU (East, North, Up). */
export function distanceEnu3D(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Fast bounding-box check for NYC metro area. */
export function isInsideNycBounds(lat: number, lon: number): boolean {
  return (
    lat >= NYC_BOUNDS.minLat &&
    lat <= NYC_BOUNDS.maxLat &&
    lon >= NYC_BOUNDS.minLon &&
    lon <= NYC_BOUNDS.maxLon
  );
}

/**
 * Project raw WGS84 waypoints to TrackPoints with optional horizontal lateral offset
 * along the unit right-hand normal (with clamped miter joins) and cumulative 3D arc-length `s`.
 */
export function buildTrackPoints(
  waypoints: readonly RawTrackWaypoint[],
  lateralOffsetM = 0,
): TrackPoint[] {
  if (waypoints.length === 0) {
    return [];
  }

  const baseEnu: Vec3[] = waypoints.map((wp) =>
    wgs84ToEnu(wp.lat, wp.lon, wp.elevM),
  );

  // Compute unit right-hand normal for each segment in 2D ENU
  const segNormals: Array<[number, number]> = [];
  for (let i = 0; i < baseEnu.length - 1; i++) {
    const dE = baseEnu[i + 1][0] - baseEnu[i][0];
    const dN = baseEnu[i + 1][1] - baseEnu[i][1];
    const h = Math.hypot(dE, dN);
    if (h > 1e-9) {
      // Heading North (0, 1) -> right-hand normal is East (1, 0)
      segNormals.push([dN / h, -dE / h]);
    } else {
      segNormals.push([1, 0]);
    }
  }

  const offsetEnu: Vec3[] = baseEnu.map((p, i) => {
    if (lateralOffsetM === 0 || baseEnu.length < 2) {
      return [p[0], p[1], p[2]];
    }
    let nx = 0;
    let ny = 0;
    if (i === 0) {
      [nx, ny] = segNormals[0];
    } else if (i === baseEnu.length - 1) {
      [nx, ny] = segNormals[segNormals.length - 1];
    } else {
      const nIn = segNormals[i - 1];
      const nOut = segNormals[i];
      const ax = nIn[0] + nOut[0];
      const ay = nIn[1] + nOut[1];
      const alen = Math.hypot(ax, ay);
      if (alen > 1e-6) {
        const ux = ax / alen;
        const uy = ay / alen;
        const dot = ux * nIn[0] + uy * nIn[1];
        const miterScale = Math.min(1.5, 1 / Math.max(0.5, dot));
        nx = ux * miterScale;
        ny = uy * miterScale;
      } else {
        [nx, ny] = nIn;
      }
    }
    return [p[0] + nx * lateralOffsetM, p[1] + ny * lateralOffsetM, p[2]];
  });

  const result: TrackPoint[] = [];
  let cumulativeS = 0;
  for (let i = 0; i < waypoints.length; i++) {
    const enu = offsetEnu[i];
    if (i > 0) {
      cumulativeS += distanceEnu3D(offsetEnu[i - 1], enu);
    }
    const wgs = enuToWgs84(enu[0], enu[1], enu[2]);
    const wp = waypoints[i];
    result.push({
      s: cumulativeS,
      lat: wgs.lat,
      lon: wgs.lon,
      elevM: enu[2],
      enu,
      structure: wp.structure,
      gpsVisibility: wp.gpsVisibility,
      maxSpeedMps: wp.maxSpeedMps,
    });
  }

  return result;
}

/** Binary search for segment index i in [0, points.length - 2] containing sClamped. */
function findSegmentIndex(points: readonly TrackPoint[], sClamped: number): number {
  const lastSeg = points.length - 2;
  if (sClamped <= points[0].s) return 0;
  if (sClamped >= points[points.length - 1].s) return lastSeg;

  let lo = 0;
  let hi = lastSeg;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sClamped < points[mid].s) {
      hi = mid - 1;
    } else if (sClamped > points[mid + 1].s) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(lastSeg, lo));
}

/** Compute normalized 3D tangent at segment index i, scanning outward if zero-length. */
function computeSegmentTangent(points: readonly TrackPoint[], segIndex: number): Vec3 {
  const maxSeg = points.length - 2;
  for (let offset = 0; offset <= maxSeg; offset++) {
    const candidates = offset === 0 ? [segIndex] : [segIndex + offset, segIndex - offset];
    for (const idx of candidates) {
      if (idx < 0 || idx > maxSeg) continue;
      const a = points[idx].enu;
      const b = points[idx + 1].enu;
      const dE = b[0] - a[0];
      const dN = b[1] - a[1];
      const dU = b[2] - a[2];
      const len = Math.hypot(dE, dN, dU);
      if (len > 1e-9) {
        return [dE / len, dN / len, dU / len];
      }
    }
  }
  return [0, 1, 0];
}

/** Internal continuous position interpolation at sClamped. */
function samplePositionAtS(points: readonly TrackPoint[], sClamped: number): Vec3 {
  const idx = findSegmentIndex(points, sClamped);
  const p0 = points[idx];
  const p1 = points[idx + 1];
  const ds = p1.s - p0.s;
  const t = ds > 1e-9 ? Math.min(Math.max((sClamped - p0.s) / ds, 0), 1) : 0;
  return [
    p0.enu[0] + t * (p1.enu[0] - p0.enu[0]),
    p0.enu[1] + t * (p1.enu[1] - p0.enu[1]),
    p0.enu[2] + t * (p1.enu[2] - p0.enu[2]),
  ];
}

/**
 * Sample a TrackPoint polyline at arc-length `s` (clamped to [sMin, sMax]).
 * Computes ENU position, unit tangent, compass heading, vertical pitch,
 * smoothed signed horizontal curvature (rad/m), structure, and gpsVisibility.
 */
export function samplePolylineAtS(
  points: readonly TrackPoint[],
  s: number,
): SampledTrackPoint {
  if (points.length === 0) {
    throw new Error('samplePolylineAtS requires at least one TrackPoint');
  }

  if (points.length === 1) {
    const p0 = points[0];
    return {
      s: p0.s,
      enu: [p0.enu[0], p0.enu[1], p0.enu[2]],
      tangentEnu: [0, 1, 0],
      headingRad: 0,
      pitchRad: 0,
      curvature: 0,
      structure: p0.structure,
      gpsVisibility: p0.gpsVisibility,
    };
  }

  const sMin = points[0].s;
  const sMax = points[points.length - 1].s;
  const sClamped = Number.isFinite(s)
    ? Math.min(Math.max(s, sMin), sMax)
    : s === Infinity
      ? sMax
      : sMin;

  const segIdx = findSegmentIndex(points, sClamped);
  const p0 = points[segIdx];
  const p1 = points[segIdx + 1];
  const ds = p1.s - p0.s;
  const t = ds > 1e-9 ? Math.min(Math.max((sClamped - p0.s) / ds, 0), 1) : 0;

  const enu: Vec3 = [
    p0.enu[0] + t * (p1.enu[0] - p0.enu[0]),
    p0.enu[1] + t * (p1.enu[1] - p0.enu[1]),
    p0.enu[2] + t * (p1.enu[2] - p0.enu[2]),
  ];

  const tangentEnu = computeSegmentTangent(points, segIdx);
  const hLen = Math.hypot(tangentEnu[0], tangentEnu[1]);
  const headingRad = hLen > 1e-9 ? Math.atan2(tangentEnu[0], tangentEnu[1]) : 0;
  const pitchRad = Math.atan2(tangentEnu[2], hLen);

  // Second-order continuous 3-point chord curvature over ~25m half-window
  let curvature = 0;
  const totalSpan = sMax - sMin;
  if (points.length >= 3 && totalSpan > 1e-3) {
    const delta = Math.min(25, Math.max(1, totalSpan * 0.25));
    const sMinus = Math.max(sMin, sClamped - delta);
    const sPlus = Math.min(sMax, sClamped + delta);
    const l1 = sClamped - sMinus;
    const l2 = sPlus - sClamped;
    if (l1 > 1e-3 && l2 > 1e-3) {
      const pA = samplePositionAtS(points, sMinus);
      const pB = samplePositionAtS(points, sPlus);
      const h1 = Math.atan2(enu[0] - pA[0], enu[1] - pA[1]);
      const h2 = Math.atan2(pB[0] - enu[0], pB[1] - enu[1]);
      curvature = wrapAngleRad(h2 - h1) / (0.5 * (l1 + l2));
    }
  }

  const attrPoint = sClamped >= sMax ? points[points.length - 1] : p0;

  return {
    s: sClamped,
    enu,
    tangentEnu,
    headingRad,
    pitchRad,
    curvature,
    structure: attrPoint.structure,
    gpsVisibility: attrPoint.gpsVisibility,
  };
}
