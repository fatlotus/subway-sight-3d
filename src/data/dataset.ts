import { distanceEnu2D, distanceEnu3D, samplePolylineAtS } from '../geo/projection';
import type {
  GpsVisibility,
  LandmarkDataset,
  RailSystem,
  RouteSchedule,
  Station,
  StructureType,
  TrackPolyline,
  TransitDataset,
  Vec2,
  Vec3,
  WaterLandmarkId,
} from '../types/transit';
import { createLandmarks } from './landmarks';
import { createSchedules, SERVICE_PERIODS } from './schedules';
import { createStations } from './stations';
import { createTracks } from './tracks';

const VALID_RAIL_SYSTEMS: ReadonlySet<RailSystem> = new Set([
  'MTA',
  'LIRR',
  'MNR',
  'PATH',
  'NJT',
  'AIRTRAIN',
]);

const VALID_STRUCTURES: ReadonlySet<StructureType> = new Set([
  'UNDERGROUND_TUNNEL',
  'UNDERWATER_TUNNEL',
  'ELEVATED',
  'BRIDGE',
  'OPEN_CUT',
  'AT_GRADE',
  'STATION',
]);

const VALID_GPS_VISIBILITY: ReadonlySet<GpsVisibility> = new Set([
  'OPEN_SKY',
  'URBAN_CANYON',
  'PORTAL',
  'UNDERGROUND',
]);

const REQUIRED_RIVER_IDS: readonly WaterLandmarkId[] = [
  'east-river',
  'hudson-river',
  'harlem-river',
  'upper-bay',
];

const REQUIRED_BRIDGE_IDS: readonly string[] = [
  'manhattan-bridge',
  'williamsburg-bridge',
  'brooklyn-bridge',
  'queensboro-bridge',
  'george-washington-bridge',
];

const METERS_TO_FEET = 3.28084;

export type ValidationCode =
  | 'DUPLICATE_ID'
  | 'INVALID_ENUM'
  | 'DEGENERATE_TRACK'
  | 'NON_MONOTONIC_ARC_LENGTH'
  | 'ARC_LENGTH_MISMATCH'
  | 'NON_MONOTONIC_STOP_S'
  | 'STOP_S_OUT_OF_RANGE'
  | 'BROKEN_REF'
  | 'INVALID_SCHEDULE'
  | 'CROSSING_CLEARANCE_VIOLATION'
  | 'MISSING_LANDMARK'
  | 'INVALID_LANDMARK_GEOMETRY'
  | 'MAP_INDEX_MISMATCH';

export interface ValidationIssue {
  code: ValidationCode;
  severity: 'error' | 'warning';
  entityId: string;
  message: string;
}

export interface ValidateDatasetOptions {
  /** Minimum vertical center-to-center clearance for grade-separated 2D crossings (default: 4.5m). */
  minCrossingClearanceM?: number;
  /** Horizontal radius around a shared station where crossings are treated as station interlockings (default: 35m). */
  sharedStationJunctionRadiusM?: number;
  /** Minimum |sin(angle)| between crossing segments on the same trunk before requiring vertical separation (default: 0.15). */
  shallowSwitchSinThreshold?: number;
}

export interface DatasetValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  stats: {
    stationCount: number;
    trackCount: number;
    scheduleCount: number;
    riverCount: number;
    bridgeCount: number;
    crossingsChecked: number;
    crossingsSkippedJunction: number;
  };
}

export interface TrackProjection {
  trackId: string;
  track: TrackPolyline;
  s: number;
  enu: Vec3;
  distance2dM: number;
  distance3dM: number;
  verticalOffsetM: number;
  headingRad: number;
  pitchRad: number;
  structure: StructureType;
  gpsVisibility: GpsVisibility;
}

export interface NearbyStationResult {
  station: Station;
  distance2dM: number;
  distance3dM: number;
}

export interface NearbyLandmarkResult {
  id: string;
  name: string;
  kind: 'river' | 'bridge';
  distanceM: number;
  relativeElevationM: number;
  relativeElevationFt: number;
}

export interface Aabb2D {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
}

const trackAabbCache = new WeakMap<TrackPolyline, Aabb2D>();

export function getTrackAabb(track: TrackPolyline): Aabb2D {
  const cached = trackAabbCache.get(track);
  if (cached) return cached;

  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const pt of track.points) {
    const [e, n] = pt.enu;
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
  }
  const aabb: Aabb2D = { minE, maxE, minN, maxN };
  trackAabbCache.set(track, aabb);
  return aabb;
}

function aabbsOverlap(a: Aabb2D, b: Aabb2D): boolean {
  return a.minE <= b.maxE && a.maxE >= b.minE && a.minN <= b.maxN && a.maxN >= b.minN;
}

export function distToAabb2D(e: number, n: number, box: Aabb2D): number {
  const dx = e < box.minE ? box.minE - e : e > box.maxE ? e - box.maxE : 0;
  const dy = n < box.minN ? box.minN - n : n > box.maxN ? n - box.maxN : 0;
  return Math.hypot(dx, dy);
}

/** Pure factory for building a TransitDataset (supports custom/synthetic datasets in tests). */
export function buildTransitDataset(raw?: {
  stations?: Station[];
  tracks?: TrackPolyline[];
  schedules?: RouteSchedule[];
  landmarks?: LandmarkDataset;
}): TransitDataset {
  const stations = raw?.stations ?? createStations();
  const tracks = raw?.tracks ?? createTracks(stations);
  const schedules = raw?.schedules ?? createSchedules(tracks, stations);
  const landmarks = raw?.landmarks ?? createLandmarks();

  const stationById = new Map<string, Station>(stations.map((s) => [s.id, s]));
  const trackById = new Map<string, TrackPolyline>(tracks.map((t) => [t.id, t]));

  return {
    stations,
    tracks,
    schedules,
    landmarks,
    stationById,
    trackById,
  };
}

let cachedDataset: TransitDataset | null = null;

/** Memoized singleton TransitDataset loader for runtime use. */
export function getTransitDataset(): TransitDataset {
  if (!cachedDataset) {
    cachedDataset = buildTransitDataset();
  }
  return cachedDataset;
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function isFiniteVec2(v: Vec2): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

/** Comprehensive dataset integrity validator including 3D crossing vertical clearance checks. */
export function validateDataset(
  dataset: TransitDataset,
  options?: ValidateDatasetOptions,
): DatasetValidationResult {
  const minClearanceM = options?.minCrossingClearanceM ?? 4.5;
  const junctionRadiusM = options?.sharedStationJunctionRadiusM ?? 35;
  const shallowSwitchSin = options?.shallowSwitchSinThreshold ?? 0.15;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const pushError = (code: ValidationCode, entityId: string, message: string): void => {
    errors.push({ code, severity: 'error', entityId, message });
  };

  // 1. Station uniqueness, enums, finite coordinates & map index consistency
  const seenStationIds = new Set<string>();
  for (const st of dataset.stations) {
    if (seenStationIds.has(st.id)) {
      pushError('DUPLICATE_ID', st.id, `Duplicate station ID "${st.id}"`);
    }
    seenStationIds.add(st.id);

    if (!VALID_RAIL_SYSTEMS.has(st.system)) {
      pushError('INVALID_ENUM', st.id, `Invalid station system "${String(st.system)}"`);
    }
    if (!VALID_STRUCTURES.has(st.structure)) {
      pushError('INVALID_ENUM', st.id, `Invalid station structure "${String(st.structure)}"`);
    }
    if (!VALID_GPS_VISIBILITY.has(st.gpsVisibility)) {
      pushError('INVALID_ENUM', st.id, `Invalid station gpsVisibility "${String(st.gpsVisibility)}"`);
    }
    if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon) || !Number.isFinite(st.elevM) || !isFiniteVec3(st.enu)) {
      pushError('DEGENERATE_TRACK', st.id, `Station "${st.id}" has non-finite coordinates`);
    }
    if (dataset.stationById.get(st.id) !== st) {
      pushError('MAP_INDEX_MISMATCH', st.id, `stationById mismatch for "${st.id}"`);
    }
  }
  if (dataset.stationById.size !== seenStationIds.size) {
    pushError('MAP_INDEX_MISMATCH', 'stationById', `stationById size (${dataset.stationById.size}) !== unique stations (${seenStationIds.size})`);
  }

  // 2. Track uniqueness, enums, geometry, monotonic arc-length & station refs
  const seenTrackIds = new Set<string>();
  const trackStationSets = new Map<string, Set<string>>();

  for (const track of dataset.tracks) {
    if (seenTrackIds.has(track.id)) {
      pushError('DUPLICATE_ID', track.id, `Duplicate track ID "${track.id}"`);
    }
    seenTrackIds.add(track.id);

    if (!VALID_RAIL_SYSTEMS.has(track.system)) {
      pushError('INVALID_ENUM', track.id, `Invalid track system "${String(track.system)}"`);
    }
    if (dataset.trackById.get(track.id) !== track) {
      pushError('MAP_INDEX_MISMATCH', track.id, `trackById mismatch for "${track.id}"`);
    }
    if (track.points.length < 2 || !Number.isFinite(track.totalLengthM) || track.totalLengthM <= 0) {
      pushError('DEGENERATE_TRACK', track.id, `Track "${track.id}" must have >= 2 points and totalLengthM > 0`);
      continue;
    }

    const first = track.points[0];
    if (Math.abs(first.s) > 1e-6) {
      pushError('ARC_LENGTH_MISMATCH', track.id, `Track "${track.id}" first point s=${first.s} (expected 0)`);
    }

    for (let i = 0; i < track.points.length; i++) {
      const pt = track.points[i];
      if (!VALID_STRUCTURES.has(pt.structure)) {
        pushError('INVALID_ENUM', track.id, `Track "${track.id}" point[${i}] invalid structure "${String(pt.structure)}"`);
      }
      if (!VALID_GPS_VISIBILITY.has(pt.gpsVisibility)) {
        pushError('INVALID_ENUM', track.id, `Track "${track.id}" point[${i}] invalid gpsVisibility "${String(pt.gpsVisibility)}"`);
      }
      if (!Number.isFinite(pt.s) || !isFiniteVec3(pt.enu) || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lon)) {
        pushError('DEGENERATE_TRACK', track.id, `Track "${track.id}" point[${i}] has non-finite values`);
      }
      if (i > 0) {
        const prev = track.points[i - 1];
        if (!(pt.s > prev.s)) {
          pushError('NON_MONOTONIC_ARC_LENGTH', track.id, `Track "${track.id}" point[${i}].s (${pt.s}) <= point[${i - 1}].s (${prev.s})`);
        } else {
          const ds = pt.s - prev.s;
          const segDist = distanceEnu3D(prev.enu, pt.enu);
          if (Math.abs(ds - segDist) > Math.max(0.5, 0.02 * segDist)) {
            pushError('ARC_LENGTH_MISMATCH', track.id, `Track "${track.id}" segment[${i - 1}->${i}] ds=${ds.toFixed(2)} vs 3D dist=${segDist.toFixed(2)}`);
          }
        }
      }
    }

    const lastS = track.points[track.points.length - 1].s;
    if (Math.abs(lastS - track.totalLengthM) > 0.5) {
      pushError('ARC_LENGTH_MISMATCH', track.id, `Track "${track.id}" last point s=${lastS.toFixed(2)} !== totalLengthM=${track.totalLengthM.toFixed(2)}`);
    }

    const stSet = new Set<string>();
    let prevStopS = -Infinity;
    for (let i = 0; i < track.stations.length; i++) {
      const ref = track.stations[i];
      stSet.add(ref.stationId);
      if (!dataset.stationById.has(ref.stationId)) {
        pushError('BROKEN_REF', track.id, `Track "${track.id}" references missing station "${ref.stationId}"`);
      }
      if (!Number.isFinite(ref.s) || ref.s < -1e-6 || ref.s > track.totalLengthM + 1e-6) {
        pushError('STOP_S_OUT_OF_RANGE', track.id, `Track "${track.id}" stop "${ref.stationId}" s=${ref.s} out of [0, ${track.totalLengthM}]`);
      }
      if (!(ref.s > prevStopS)) {
        pushError('NON_MONOTONIC_STOP_S', track.id, `Track "${track.id}" stop "${ref.stationId}" s=${ref.s} <= previous stop s=${prevStopS}`);
      }
      prevStopS = ref.s;
    }
    trackStationSets.set(track.id, stSet);
  }
  if (dataset.trackById.size !== seenTrackIds.size) {
    pushError('MAP_INDEX_MISMATCH', 'trackById', `trackById size (${dataset.trackById.size}) !== unique tracks (${seenTrackIds.size})`);
  }

  // 3. Schedule uniqueness, referential integrity, service periods & runTimes
  const seenSchedIds = new Set<string>();
  for (const sched of dataset.schedules) {
    if (seenSchedIds.has(sched.id)) {
      pushError('DUPLICATE_ID', sched.id, `Duplicate schedule ID "${sched.id}"`);
    }
    seenSchedIds.add(sched.id);

    if (!VALID_RAIL_SYSTEMS.has(sched.system)) {
      pushError('INVALID_ENUM', sched.id, `Invalid schedule system "${String(sched.system)}"`);
    }
    const track = dataset.trackById.get(sched.trackId);
    if (!track) {
      pushError('BROKEN_REF', sched.id, `Schedule "${sched.id}" references missing track "${sched.trackId}"`);
    }
    if (sched.lateNightTrackId && !dataset.trackById.has(sched.lateNightTrackId)) {
      pushError('BROKEN_REF', sched.id, `Schedule "${sched.id}" references missing lateNightTrackId "${sched.lateNightTrackId}"`);
    }

    for (const period of SERVICE_PERIODS) {
      const rule = sched.periods[period];
      if (!rule) {
        pushError('INVALID_SCHEDULE', sched.id, `Schedule "${sched.id}" missing service period "${period}"`);
        continue;
      }
      if (rule.active && (!Number.isFinite(rule.headwaySec) || rule.headwaySec <= 0)) {
        pushError('INVALID_SCHEDULE', sched.id, `Schedule "${sched.id}" active period "${period}" has invalid headwaySec=${rule.headwaySec}`);
      }
      if (rule.trackIdOverride && !dataset.trackById.has(rule.trackIdOverride)) {
        pushError('BROKEN_REF', sched.id, `Schedule "${sched.id}" period "${period}" references missing trackIdOverride "${rule.trackIdOverride}"`);
      }
    }

    let prevFromS = -Infinity;
    for (const rt of sched.runTimes) {
      if (!dataset.stationById.has(rt.fromStationId)) {
        pushError('BROKEN_REF', sched.id, `Schedule "${sched.id}" runTime references missing fromStationId "${rt.fromStationId}"`);
      }
      if (!dataset.stationById.has(rt.toStationId)) {
        pushError('BROKEN_REF', sched.id, `Schedule "${sched.id}" runTime references missing toStationId "${rt.toStationId}"`);
      }
      if (!Number.isFinite(rt.meanSec) || rt.meanSec <= 0 || !Number.isFinite(rt.stdSec) || rt.stdSec < 0 || !Number.isFinite(rt.dwellSec) || rt.dwellSec < 0) {
        pushError('INVALID_SCHEDULE', sched.id, `Schedule "${sched.id}" invalid runTime timing (${rt.fromStationId} -> ${rt.toStationId})`);
      }
      if (track) {
        const fromS = getStationArcLengthOnTrack(dataset, rt.fromStationId, track.id);
        const toS = getStationArcLengthOnTrack(dataset, rt.toStationId, track.id);
        if (fromS !== null && toS !== null) {
          if (!(toS > fromS) || fromS < prevFromS) {
            pushError('NON_MONOTONIC_STOP_S', sched.id, `Schedule "${sched.id}" non-monotonic stops ${rt.fromStationId}(${fromS}) -> ${rt.toStationId}(${toS})`);
          }
          prevFromS = fromS;
        }
      }
    }
  }

  // 4. Landmarks integrity
  const riverIds = new Set<string>();
  for (const river of dataset.landmarks.waterBodies) {
    if (riverIds.has(river.id)) {
      pushError('DUPLICATE_ID', river.id, `Duplicate water body ID "${river.id}"`);
    }
    riverIds.add(river.id);
    if (river.elevationM !== 0) {
      pushError('INVALID_LANDMARK_GEOMETRY', river.id, `Water body "${river.id}" must have elevationM === 0 (got ${river.elevationM})`);
    }
    if (river.polygonEnu.length < 3 || !river.polygonEnu.every(isFiniteVec2)) {
      pushError('INVALID_LANDMARK_GEOMETRY', river.id, `Water body "${river.id}" must have >= 3 finite polygon vertices`);
    }
  }
  for (const reqId of REQUIRED_RIVER_IDS) {
    if (!riverIds.has(reqId)) {
      pushError('MISSING_LANDMARK', reqId, `Missing required river landmark "${reqId}"`);
    }
  }

  const bridgeIds = new Set<string>();
  for (const bridge of dataset.landmarks.bridges) {
    if (bridgeIds.has(bridge.id)) {
      pushError('DUPLICATE_ID', bridge.id, `Duplicate bridge ID "${bridge.id}"`);
    }
    bridgeIds.add(bridge.id);
    if (bridge.deckPointsEnu.length < 2 || !bridge.deckPointsEnu.every(isFiniteVec3) || !(bridge.deckElevationM > 0)) {
      pushError('INVALID_LANDMARK_GEOMETRY', bridge.id, `Bridge "${bridge.id}" has invalid deck geometry or elevation`);
    }
  }
  for (const reqBridgeId of REQUIRED_BRIDGE_IDS) {
    if (!bridgeIds.has(reqBridgeId)) {
      pushError('MISSING_LANDMARK', reqBridgeId, `Missing required bridge landmark "${reqBridgeId}"`);
    }
  }

  // 5. 3D Crossing Vertical Clearance Check (2D ENU segment intersection)
  let crossingsChecked = 0;
  let crossingsSkippedJunction = 0;

  const trackAabbs = dataset.tracks.map((t) => getTrackAabb(t));

  for (let i = 0; i < dataset.tracks.length; i++) {
    const trackA = dataset.tracks[i];
    if (trackA.points.length < 2) continue;
    const aabbA = trackAabbs[i];
    const stationsA = trackStationSets.get(trackA.id) ?? new Set<string>();

    for (let j = i + 1; j < dataset.tracks.length; j++) {
      const trackB = dataset.tracks[j];
      if (trackB.points.length < 2) continue;
      if (!aabbsOverlap(aabbA, trackAabbs[j])) continue;

      const stationsB = trackStationSets.get(trackB.id) ?? new Set<string>();
      const sharedStationPositions: Vec3[] = [];
      for (const stId of stationsA) {
        if (stationsB.has(stId)) {
          const st = dataset.stationById.get(stId);
          if (st) sharedStationPositions.push(st.enu);
        }
      }

      const sameTrunk = trackA.system === trackB.system && trackA.trunk === trackB.trunk;

      for (let sa = 0; sa < trackA.points.length - 1; sa++) {
        const p0 = trackA.points[sa].enu;
        const p1 = trackA.points[sa + 1].enu;
        const aMinE = Math.min(p0[0], p1[0]);
        const aMaxE = Math.max(p0[0], p1[0]);
        const aMinN = Math.min(p0[1], p1[1]);
        const aMaxN = Math.max(p0[1], p1[1]);
        const adE = p1[0] - p0[0];
        const adN = p1[1] - p0[1];
        const aLen = Math.hypot(adE, adN);
        if (aLen < 1e-6) continue;

        for (let sb = 0; sb < trackB.points.length - 1; sb++) {
          const q0 = trackB.points[sb].enu;
          const q1 = trackB.points[sb + 1].enu;

          if (
            aMaxE < Math.min(q0[0], q1[0]) ||
            aMinE > Math.max(q0[0], q1[0]) ||
            aMaxN < Math.min(q0[1], q1[1]) ||
            aMinN > Math.max(q0[1], q1[1])
          ) {
            continue;
          }

          const bdE = q1[0] - q0[0];
          const bdN = q1[1] - q0[1];
          const bLen = Math.hypot(bdE, bdN);
          if (bLen < 1e-6) continue;

          const denom = adE * bdN - adN * bdE;
          if (Math.abs(denom) < 1e-6) continue;

          const qpE = q0[0] - p0[0];
          const qpN = q0[1] - p0[1];
          const t = (qpE * bdN - qpN * bdE) / denom;
          const u = (qpE * adN - qpN * adE) / denom;

          if (t < 0 || t > 1 || u < 0 || u > 1) continue;

          const xE = p0[0] + t * adE;
          const xN = p0[1] + t * adN;

          // Exclusion 1: Shared topological endpoint (merge/branch node)
          const nearAEnd = t < 0.05 || t > 0.95;
          const nearBEnd = u < 0.05 || u > 0.95;
          if (nearAEnd && nearBEnd) {
            const epA = t < 0.5 ? p0 : p1;
            const epB = u < 0.5 ? q0 : q1;
            if (Math.hypot(epA[0] - epB[0], epA[1] - epB[1]) < 1.5) {
              crossingsSkippedJunction++;
              continue;
            }
          }

          // Exclusion 2: Shared station interlocking
          let nearSharedStation = false;
          for (const stEnu of sharedStationPositions) {
            if (Math.hypot(xE - stEnu[0], xN - stEnu[1]) <= junctionRadiusM) {
              nearSharedStation = true;
              break;
            }
          }
          if (nearSharedStation) {
            crossingsSkippedJunction++;
            continue;
          }

          // Exclusion 3: Same-trunk shallow switch/crossover
          const sinAngle = Math.abs(denom) / (aLen * bLen);
          if (sameTrunk && sinAngle < shallowSwitchSin) {
            crossingsSkippedJunction++;
            continue;
          }

          crossingsChecked++;
          const zA = p0[2] + t * (p1[2] - p0[2]);
          const zB = q0[2] + u * (q1[2] - q0[2]);
          const clearanceM = Math.abs(zA - zB);

          if (clearanceM < minClearanceM) {
            pushError(
              'CROSSING_CLEARANCE_VIOLATION',
              `${trackA.id}<->${trackB.id}`,
              `Tracks "${trackA.id}" (z=${zA.toFixed(1)}m) and "${trackB.id}" (z=${zB.toFixed(1)}m) cross at ENU(${xE.toFixed(0)}, ${xN.toFixed(0)}) with clearance ${clearanceM.toFixed(2)}m < ${minClearanceM}m`,
            );
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      stationCount: dataset.stations.length,
      trackCount: dataset.tracks.length,
      scheduleCount: dataset.schedules.length,
      riverCount: dataset.landmarks.waterBodies.length,
      bridgeCount: dataset.landmarks.bridges.length,
      crossingsChecked,
      crossingsSkippedJunction,
    },
  };
}

/** Exact closest-point 2D projection of an ENU point onto a TrackPolyline. */
export function projectPointOntoTrack(
  enu: Vec3,
  track: TrackPolyline,
): TrackProjection {
  let bestDist2DSq = Infinity;
  let bestS = 0;

  for (let i = 0; i < track.points.length - 1; i++) {
    const a = track.points[i];
    const b = track.points[i + 1];
    const dE = b.enu[0] - a.enu[0];
    const dN = b.enu[1] - a.enu[1];
    const segLenSq = dE * dE + dN * dN;

    let t = 0;
    if (segLenSq > 1e-9) {
      t = ((enu[0] - a.enu[0]) * dE + (enu[1] - a.enu[1]) * dN) / segLenSq;
      t = Math.min(Math.max(t, 0), 1);
    }

    const projE = a.enu[0] + t * dE;
    const projN = a.enu[1] + t * dN;
    const dx = enu[0] - projE;
    const dy = enu[1] - projN;
    const distSq = dx * dx + dy * dy;

    if (distSq < bestDist2DSq) {
      bestDist2DSq = distSq;
      bestS = a.s + t * (b.s - a.s);
    }
  }

  const sampled = samplePolylineAtS(track.points, bestS);
  const distance2dM = distanceEnu2D(enu, sampled.enu);
  const distance3dM = distanceEnu3D(enu, sampled.enu);

  return {
    trackId: track.id,
    track,
    s: sampled.s,
    enu: sampled.enu,
    distance2dM,
    distance3dM,
    verticalOffsetM: enu[2] - sampled.enu[2],
    headingRad: sampled.headingRad,
    pitchRad: sampled.pitchRad,
    structure: sampled.structure,
    gpsVisibility: sampled.gpsVisibility,
  };
}

/** AABB-pruned nearest track search in ENU coordinates, sorted ascending by distance. */
export function findNearestTracks(
  dataset: TransitDataset,
  enu: Vec3,
  maxDistM: number,
  options?: { limit?: number; systems?: readonly RailSystem[]; use3d?: boolean },
): TrackProjection[] {
  const systemFilter = options?.systems ? new Set(options.systems) : null;
  const use3d = options?.use3d ?? false;
  const results: TrackProjection[] = [];

  for (const track of dataset.tracks) {
    if (systemFilter && !systemFilter.has(track.system)) continue;
    if (track.points.length < 2) continue;

    const aabb = getTrackAabb(track);
    if (distToAabb2D(enu[0], enu[1], aabb) > maxDistM) continue;

    const proj = projectPointOntoTrack(enu, track);
    const dist = use3d ? proj.distance3dM : proj.distance2dM;
    if (dist <= maxDistM) {
      results.push(proj);
    }
  }

  results.sort((a, b) =>
    use3d ? a.distance3dM - b.distance3dM : a.distance2dM - b.distance2dM,
  );

  if (options?.limit !== undefined && results.length > options.limit) {
    return results.slice(0, options.limit);
  }
  return results;
}

/** Find nearest stations sorted by 2D distance. */
export function findNearestStations(
  dataset: TransitDataset,
  enu: Vec3,
  limit = 5,
  options?: { maxDistM?: number; systems?: readonly RailSystem[]; trackId?: string },
): NearbyStationResult[] {
  const systemFilter = options?.systems ? new Set(options.systems) : null;
  let allowedStationIds: Set<string> | null = null;
  if (options?.trackId) {
    const tr = dataset.trackById.get(options.trackId);
    if (!tr) return [];
    allowedStationIds = new Set(tr.stations.map((s) => s.stationId));
  }

  const results: NearbyStationResult[] = [];
  for (const st of dataset.stations) {
    if (systemFilter && !systemFilter.has(st.system)) continue;
    if (allowedStationIds && !allowedStationIds.has(st.id)) continue;

    const distance2dM = distanceEnu2D(enu, st.enu);
    if (options?.maxDistM !== undefined && distance2dM > options.maxDistM) continue;
    const distance3dM = distanceEnu3D(enu, st.enu);
    results.push({ station: st, distance2dM, distance3dM });
  }

  results.sort((a, b) => a.distance2dM - b.distance2dM);
  return results.slice(0, Math.max(0, limit));
}

function pointToSegmentDist2D(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(px - a[0], py - a[1]);
  const t = Math.min(Math.max(((px - a[0]) * dx + (py - a[1]) * dy) / lenSq, 0), 1);
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function isPointInPolygon2D(px: number, py: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToPolygon2D(px: number, py: number, poly: readonly Vec2[]): number {
  if (poly.length < 3) return Infinity;
  if (isPointInPolygon2D(px, py, poly)) return 0;
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d = pointToSegmentDist2D(px, py, a, b);
    if (d < minD) minD = d;
  }
  return minD;
}

/** Find nearby river and bridge landmarks within maxDistM, sorted ascending by 2D distance. */
export function findNearbyLandmarks(
  dataset: TransitDataset,
  enu: Vec3,
  maxDistM = 1500,
): NearbyLandmarkResult[] {
  const results: NearbyLandmarkResult[] = [];

  for (const river of dataset.landmarks.waterBodies) {
    const dist = distanceToPolygon2D(enu[0], enu[1], river.polygonEnu);
    if (dist <= maxDistM) {
      const relM = enu[2] - river.elevationM;
      results.push({
        id: river.id,
        name: river.name,
        kind: 'river',
        distanceM: dist,
        relativeElevationM: relM,
        relativeElevationFt: relM * METERS_TO_FEET,
      });
    }
  }

  for (const bridge of dataset.landmarks.bridges) {
    let minD = Infinity;
    for (let i = 0; i < bridge.deckPointsEnu.length - 1; i++) {
      const a = bridge.deckPointsEnu[i];
      const b = bridge.deckPointsEnu[i + 1];
      const d = pointToSegmentDist2D(enu[0], enu[1], [a[0], a[1]], [b[0], b[1]]);
      if (d < minD) minD = d;
    }
    if (minD <= maxDistM) {
      const relM = enu[2] - bridge.deckElevationM;
      results.push({
        id: bridge.id,
        name: bridge.name,
        kind: 'bridge',
        distanceM: minD,
        relativeElevationM: relM,
        relativeElevationFt: relM * METERS_TO_FEET,
      });
    }
  }

  results.sort((a, b) => a.distanceM - b.distanceM);
  return results;
}

/** Return all TrackPolylines serving a given routeId. */
export function getTracksForRoute(
  dataset: TransitDataset,
  routeId: string,
): TrackPolyline[] {
  return dataset.tracks.filter((t) => t.routes.includes(routeId));
}

/** Return the arc-length `s` of stationId on trackId, or null if not served. */
export function getStationArcLengthOnTrack(
  dataset: TransitDataset,
  stationId: string,
  trackId: string,
): number | null {
  const track = dataset.trackById.get(trackId);
  if (!track) return null;
  const ref = track.stations.find((s) => s.stationId === stationId);
  return ref ? ref.s : null;
}

/** Fast out-of-NYC check based on proximity to any track in the dataset. */
export function isWithinNycBounds(
  dataset: TransitDataset,
  enu: Vec3,
  marginM = 5000,
): boolean {
  return findNearestTracks(dataset, enu, marginM, { limit: 1 }).length > 0;
}

/** Browser-safe JSON serializer (excludes runtime Map indices). */
export function serializeDataset(dataset: TransitDataset): string {
  return JSON.stringify({
    stations: dataset.stations,
    tracks: dataset.tracks,
    schedules: dataset.schedules,
    landmarks: dataset.landmarks,
  });
}

/** Browser-safe UTF-8 byte length of the serialized dataset. */
export function getDatasetJsonSizeBytes(dataset: TransitDataset): number {
  return new TextEncoder().encode(serializeDataset(dataset)).byteLength;
}
