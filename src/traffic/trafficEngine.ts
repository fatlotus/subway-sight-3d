import {
  distToAabb2D,
  findNearbyLandmarks,
  findNearestTracks,
  getTrackAabb,
} from '../data/dataset';
import { distanceEnu3D, samplePolylineAtS } from '../geo/projection';
import {
  type ActiveScheduleContext,
  classifyServicePeriod,
  getActiveScheduleContexts,
} from '../localization/scheduleModel';
import type { DemoScenarioId, SensorMode } from '../types/sensors';
import type {
  EgoConsistCar,
  EstimatorState,
  NearbyLandmark,
  NearbyTrain,
  NearbyTrainCar,
  WorldStateSnapshot,
} from '../types/state';
import type {
  ServicePeriod,
  TrackPoint,
  TransitDataset,
  Vec3,
} from '../types/transit';

export interface TrafficEngineOptions {
  /** Minimum arc-length separation on the same physical track in meters (default: 300). */
  signalBlockSeparationM?: number;
  /** Maximum 3D distance from ego to include nearby trains in meters (default: 2500). */
  maxTrainRadiusM?: number;
  /** Maximum number of nearby trains returned, sorted nearest-first (default: 32). */
  maxNearbyTrains?: number;
  /** Maximum 2D distance from ego to include nearby landmarks in meters (default: 2000). */
  maxLandmarkRadiusM?: number;
}

export interface BuildWorldStateInput {
  dataset: TransitDataset;
  ego: EstimatorState;
  timestampMs: number;
  mode: SensorMode;
  scenarioId?: DemoScenarioId;
  options?: TrafficEngineOptions;
}

interface TimelineSegment {
  tStart: number;
  tEnd: number;
  sStart: number;
  sEnd: number;
}

interface TripTimeline {
  segments: TimelineSegment[];
  totalTripSec: number;
}

const COUPLER_GAP_M = 0.6;
const DEFAULT_SIGNAL_BLOCK_M = 300;
const DEFAULT_MAX_TRAIN_RADIUS_M = 2500;
const DEFAULT_MAX_NEARBY_TRAINS = 32;
const DEFAULT_MAX_LANDMARK_RADIUS_M = 2000;

const timelineCache = new WeakMap<TransitDataset, Map<string, TripTimeline>>();

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Sample a TrackPoint polyline at arc-length `s`, linearly extrapolating along the
 * endpoint tangent when `s` falls outside `[sMin, sMax]` so articulated cars near
 * terminals never collapse onto a single point.
 */
function sampleTrackWithExtrapolation(
  points: readonly TrackPoint[],
  s: number,
): { enu: Vec3; headingRad: number; pitchRad: number } {
  const sMin = points[0].s;
  const sMax = points[points.length - 1].s;

  if (s < sMin) {
    const base = samplePolylineAtS(points, sMin);
    const ds = s - sMin; // negative
    return {
      enu: [
        base.enu[0] + base.tangentEnu[0] * ds,
        base.enu[1] + base.tangentEnu[1] * ds,
        base.enu[2] + base.tangentEnu[2] * ds,
      ],
      headingRad: base.headingRad,
      pitchRad: base.pitchRad,
    };
  }

  if (s > sMax) {
    const base = samplePolylineAtS(points, sMax);
    const ds = s - sMax; // positive
    return {
      enu: [
        base.enu[0] + base.tangentEnu[0] * ds,
        base.enu[1] + base.tangentEnu[1] * ds,
        base.enu[2] + base.tangentEnu[2] * ds,
      ],
      headingRad: base.headingRad,
      pitchRad: base.pitchRad,
    };
  }

  const sampled = samplePolylineAtS(points, s);
  return {
    enu: sampled.enu,
    headingRad: sampled.headingRad,
    pitchRad: sampled.pitchRad,
  };
}

function getOrBuildTimeline(
  dataset: TransitDataset,
  ctx: ActiveScheduleContext,
  period: ServicePeriod,
): TripTimeline {
  let map = timelineCache.get(dataset);
  if (!map) {
    map = new Map<string, TripTimeline>();
    timelineCache.set(dataset, map);
  }

  const key = `${ctx.schedule.id}|${ctx.effectiveTrack.id}|${period}`;
  const cached = map.get(key);
  if (cached) return cached;

  const track = ctx.effectiveTrack;
  const stations = track.stations;
  const rtByPair = new Map(
    ctx.effectiveRunTimes.map((rt) => [
      `${rt.fromStationId}->${rt.toStationId}`,
      rt,
    ]),
  );

  const avgSpeed =
    ctx.effectiveServiceType === 'COMMUTER'
      ? 20.0
      : ctx.effectiveServiceType === 'EXPRESS'
        ? 15.5
        : 11.5;

  const segments: TimelineSegment[] = [];
  let t = 0;

  if (stations.length === 0) {
    const dur = Math.max(60, track.totalLengthM / avgSpeed);
    segments.push({ tStart: 0, tEnd: dur, sStart: 0, sEnd: track.totalLengthM });
    const tl: TripTimeline = { segments, totalTripSec: dur };
    map.set(key, tl);
    return tl;
  }

  // Optional prefix before first station
  if (stations[0].s > 1) {
    const dur = Math.max(10, stations[0].s / avgSpeed);
    segments.push({ tStart: t, tEnd: t + dur, sStart: 0, sEnd: stations[0].s });
    t += dur;
  }

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    // Dwell at intermediate stations (skip initial dwell at i === 0 so departure is smooth at t = 0)
    if (i > 0) {
      const prevRt = rtByPair.get(`${stations[i - 1].stationId}->${st.stationId}`);
      const dwell = Math.max(10, prevRt ? prevRt.dwellSec : ctx.rule.dwellSec);
      segments.push({ tStart: t, tEnd: t + dwell, sStart: st.s, sEnd: st.s });
      t += dwell;
    }

    if (i < stations.length - 1) {
      const nextSt = stations[i + 1];
      const rt = rtByPair.get(`${st.stationId}->${nextSt.stationId}`);
      const runDur = Math.max(
        20,
        rt
          ? rt.meanSec
          : Math.round((nextSt.s - st.s) / avgSpeed + 18) *
              (ctx.rule.runTimeMultiplier ?? 1.0),
      );
      segments.push({
        tStart: t,
        tEnd: t + runDur,
        sStart: st.s,
        sEnd: nextSt.s,
      });
      t += runDur;
    }
  }

  const lastS = stations[stations.length - 1].s;
  if (track.totalLengthM - lastS > 1) {
    const dur = Math.max(10, (track.totalLengthM - lastS) / avgSpeed);
    segments.push({
      tStart: t,
      tEnd: t + dur,
      sStart: lastS,
      sEnd: track.totalLengthM,
    });
    t += dur;
  }

  const timeline: TripTimeline = {
    segments,
    totalTripSec: Math.max(60, t),
  };
  map.set(key, timeline);
  return timeline;
}

function evalTripArcLength(timeline: TripTimeline, elapsedSec: number): number {
  const segs = timeline.segments;
  if (segs.length === 0) return 0;
  if (elapsedSec <= segs[0].tStart) return segs[0].sStart;
  const last = segs[segs.length - 1];
  if (elapsedSec >= last.tEnd) return last.sEnd;

  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const seg = segs[mid];
    if (elapsedSec < seg.tStart) {
      hi = mid - 1;
    } else if (elapsedSec > seg.tEnd) {
      lo = mid + 1;
    } else {
      if (seg.sStart === seg.sEnd || seg.tEnd <= seg.tStart) {
        return seg.sStart;
      }
      const u = clamp((elapsedSec - seg.tStart) / (seg.tEnd - seg.tStart), 0, 1);
      // Blended smooth ease-in-out for realistic acceleration and braking
      const smooth = 0.5 - 0.5 * Math.cos(Math.PI * u);
      const blend = 0.25 * smooth + 0.75 * u;
      return seg.sStart + blend * (seg.sEnd - seg.sStart);
    }
  }
  return last.sEnd;
}

/**
 * Build the articulated own-train consist (8–11 cars) along the exact 3D track spline.
 */
export function buildEgoConsist(
  dataset: TransitDataset,
  ego: EstimatorState,
): EgoConsistCar[] {
  if (ego.outOfNyc) return [];

  // Resolve car dimensions from matching RouteSchedule
  let matchedSched = ego.routeId
    ? dataset.schedules.find(
        (s) => s.routeId === ego.routeId && s.trackId === ego.trackId,
      ) ?? dataset.schedules.find((s) => s.routeId === ego.routeId)
    : undefined;

  if (!matchedSched && ego.trackId) {
    matchedSched = dataset.schedules.find((s) => s.trackId === ego.trackId);
  }

  const carCount = clamp(matchedSched?.carCount ?? 10, 8, 11);
  const carLengthM = matchedSched?.carLengthM ?? 18.44;
  const carWidthM = matchedSched?.carWidthM ?? 3.05;
  const spacing = carLengthM + COUPLER_GAP_M;

  // Resolve ego track and arc-length
  let track = ego.trackId ? dataset.trackById.get(ego.trackId) : undefined;
  let egoS =
    track && typeof ego.trackS === 'number' && Number.isFinite(ego.trackS)
      ? ego.trackS
      : null;

  if (!track || egoS === null) {
    const nearest = findNearestTracks(dataset, ego.positionEnu, 150, {
      limit: 1,
    });
    if (nearest.length > 0) {
      track = nearest[0].track;
      egoS = nearest[0].s;
    }
  }

  const cars: EgoConsistCar[] = [];

  if (track && egoS !== null) {
    for (let i = 0; i < carCount; i++) {
      const sCar = egoS - i * spacing;
      const pose = sampleTrackWithExtrapolation(track.points, sCar);
      cars.push({
        carIndex: i,
        enu: pose.enu,
        headingRad: pose.headingRad,
        pitchRad: pose.pitchRad,
        lengthM: carLengthM,
        widthM: carWidthM,
      });
    }
    return cars;
  }

  // Fallback when ego is off-track: extrapolate straight backwards from ego pose
  const h = Number.isFinite(ego.headingRad) ? ego.headingRad : 0;
  const p = Number.isFinite(ego.pitchRad) ? ego.pitchRad : 0;
  const fwdE = Math.sin(h) * Math.cos(p);
  const fwdN = Math.cos(h) * Math.cos(p);
  const fwdU = Math.sin(p);

  for (let i = 0; i < carCount; i++) {
    const back = i * spacing;
    cars.push({
      carIndex: i,
      enu: [
        ego.positionEnu[0] - fwdE * back,
        ego.positionEnu[1] - fwdN * back,
        ego.positionEnu[2] - fwdU * back,
      ],
      headingRad: h,
      pitchRad: p,
      lengthM: carLengthM,
      widthM: carWidthM,
    });
  }

  return cars;
}

/**
 * Deterministically project rough real-time nearby MTA & regional rail trains
 * (`LIRR`, `MNR`, `PATH`, `NJT`, `AIRTRAIN`) from bundled historical schedules,
 * enforcing >= 300m signal-block separation per physical track.
 */
export function computeNearbyTrains(
  dataset: TransitDataset,
  ego: EstimatorState,
  timestampMs: number,
  options?: TrafficEngineOptions,
): NearbyTrain[] {
  if (
    ego.outOfNyc ||
    !Number.isFinite(timestampMs) ||
    !ego.positionEnu.every(Number.isFinite)
  ) {
    return [];
  }

  const rawSignalBlock = options?.signalBlockSeparationM;
  const signalBlockM = Math.max(
    100,
    typeof rawSignalBlock === 'number' && Number.isFinite(rawSignalBlock)
      ? rawSignalBlock
      : DEFAULT_SIGNAL_BLOCK_M,
  );
  const rawMaxRadius = options?.maxTrainRadiusM;
  const hasExplicitRadius =
    typeof rawMaxRadius === 'number' && Number.isFinite(rawMaxRadius);
  const maxRadiusM = Math.max(
    100,
    hasExplicitRadius ? rawMaxRadius : DEFAULT_MAX_TRAIN_RADIUS_M,
  );
  const regionalRadiusM = hasExplicitRadius
    ? maxRadiusM
    : Math.max(maxRadiusM, 6000);
  const rawMaxTrains = options?.maxNearbyTrains ?? DEFAULT_MAX_NEARBY_TRAINS;
  const maxTrains = Number.isFinite(rawMaxTrains)
    ? Math.max(0, Math.floor(rawMaxTrains))
    : DEFAULT_MAX_NEARBY_TRAINS;
  if (maxTrains === 0) return [];

  const period = classifyServicePeriod(timestampMs);
  const activeContexts = getActiveScheduleContexts(dataset, period);
  const tSec = timestampMs / 1000;

  // Track-level signal-block occupancy map, pre-seeded with ego's position on its physical track
  const occupiedSByTrack = new Map<string, number[]>();
  if (
    ego.trackId &&
    typeof ego.trackS === 'number' &&
    Number.isFinite(ego.trackS)
  ) {
    occupiedSByTrack.set(ego.trackId, [ego.trackS]);
  }

  interface NearbyCandidate {
    id: string;
    ctx: ActiveScheduleContext;
    trainS: number;
    distanceM: number;
    lead: { enu: Vec3; headingRad: number; pitchRad: number };
  }

  const candidates: NearbyCandidate[] = [];
  const egoE = ego.positionEnu[0];
  const egoN = ego.positionEnu[1];

  for (const ctx of activeContexts) {
    const track = ctx.effectiveTrack;
    const effectiveRadiusM =
      ctx.schedule.system !== 'MTA' ? regionalRadiusM : maxRadiusM;

    // Fast 2D AABB early-skip: occupiedSByTrack is keyed per track.id so skipping
    // an out-of-range track cannot affect signal-block spacing on any in-range track.
    if (distToAabb2D(egoE, egoN, getTrackAabb(track)) > effectiveRadiusM) {
      continue;
    }

    const timeline = getOrBuildTimeline(dataset, ctx, period);
    const phi = ctx.rule.offsetSec;

    // Ensure active short regional corridors (headway > totalTripSec) still dispatch deterministically.
    // Multi-branch commuter trunks (LIRR/MNR/NJT/PATH/AirTrain) combine multiple branch services
    // through Midtown hubs, so cap their effective trunk headway at 240s (4800m >> 300m signal block).
    const baseDispatchHeadway =
      ctx.rule.headwaySec > timeline.totalTripSec
        ? Math.max(60, timeline.totalTripSec)
        : Math.max(60, ctx.rule.headwaySec);
    const dispatchHeadway =
      ctx.schedule.system !== 'MTA'
        ? Math.min(baseDispatchHeadway, 240)
        : baseDispatchHeadway;

    const kMax = Math.floor((tSec - phi) / dispatchHeadway);
    const kMin = Math.ceil(
      (tSec - timeline.totalTripSec - phi) / dispatchHeadway,
    );

    let occList = occupiedSByTrack.get(track.id);
    if (!occList) {
      occList = [];
      occupiedSByTrack.set(track.id, occList);
    }

    for (let k = kMin; k <= kMax; k++) {
      const elapsedSec = tSec - (phi + k * dispatchHeadway);
      if (elapsedSec < 0 || elapsedSec > timeline.totalTripSec) continue;

      const trainS = evalTripArcLength(timeline, elapsedSec);

      // Signal-block separation check on this physical track
      let blocked = false;
      for (let j = 0; j < occList.length; j++) {
        if (Math.abs(trainS - occList[j]) < signalBlockM) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Record occupancy before distance culling so spacing is invariant to ego position
      occList.push(trainS);

      const lead = sampleTrackWithExtrapolation(track.points, trainS);
      const distM = distanceEnu3D(ego.positionEnu, lead.enu);
      if (distM > effectiveRadiusM) continue;

      candidates.push({
        id: `${ctx.schedule.id}#${k}`,
        ctx,
        trainS,
        distanceM: distM,
        lead,
      });
    }
  }

  candidates.sort((a, b) => a.distanceM - b.distanceM);

  let selected: NearbyCandidate[];
  if (candidates.length <= maxTrains) {
    selected = candidates;
  } else {
    // Reserve up to 2 closest trains per non-MTA RailSystem within radius so dense
    // Midtown MTA corridors cannot crowd out nearby regional rail (LIRR, MNR, PATH, NJT, AIRTRAIN).
    const MAX_RESERVED_PER_REGIONAL = 2;
    const selectedIndices = new Set<number>();
    const reservedPerSystem = new Map<string, number>();

    for (let i = 0; i < candidates.length && selectedIndices.size < maxTrains; i++) {
      const sys = candidates[i].ctx.schedule.system;
      if (sys === 'MTA') continue;
      const count = reservedPerSystem.get(sys) ?? 0;
      if (count < MAX_RESERVED_PER_REGIONAL) {
        selectedIndices.add(i);
        reservedPerSystem.set(sys, count + 1);
      }
    }

    for (let i = 0; i < candidates.length && selectedIndices.size < maxTrains; i++) {
      if (!selectedIndices.has(i)) {
        selectedIndices.add(i);
      }
    }

    selected = [];
    for (const idx of selectedIndices) {
      selected.push(candidates[idx]);
    }
    selected.sort((a, b) => a.distanceM - b.distanceM);
  }

  // Defer articulated car spline sampling until after sorting and capping to maxTrains
  const result: NearbyTrain[] = new Array(selected.length);
  for (let i = 0; i < selected.length; i++) {
    const cand = selected[i];
    const sched = cand.ctx.schedule;
    const trackPoints = cand.ctx.effectiveTrack.points;
    const spacing = sched.carLengthM + COUPLER_GAP_M;
    const cars: NearbyTrainCar[] = new Array(sched.carCount);
    for (let c = 0; c < sched.carCount; c++) {
      const carPose =
        c === 0
          ? cand.lead
          : sampleTrackWithExtrapolation(trackPoints, cand.trainS - c * spacing);
      cars[c] = {
        enu: carPose.enu,
        headingRad: carPose.headingRad,
        pitchRad: carPose.pitchRad,
      };
    }

    result[i] = {
      id: cand.id,
      system: sched.system,
      routeId: sched.routeId,
      color: sched.color,
      distanceM: cand.distanceM,
      enu: cand.lead.enu,
      headingRad: cand.lead.headingRad,
      pitchRad: cand.lead.pitchRad,
      carCount: sched.carCount,
      carLengthM: sched.carLengthM,
      carWidthM: sched.carWidthM,
      cars,
    };
  }

  return result;
}

/**
 * Compute nearby river and bridge landmarks using the M1 spatial query primitive,
 * preserving the normative `relativeElevationFt = (ego.enu[2] - landmarkElevM) * 3.28084` sign convention.
 */
export function computeNearbyLandmarks(
  dataset: TransitDataset,
  ego: EstimatorState,
  maxDistM = DEFAULT_MAX_LANDMARK_RADIUS_M,
): NearbyLandmark[] {
  if (ego.outOfNyc) return [];
  const raw = findNearbyLandmarks(dataset, ego.positionEnu, maxDistM);
  return raw.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    distanceM: item.distanceM,
    relativeElevationFt: item.relativeElevationFt,
  }));
}

/**
 * Assemble a complete, NaN-free WorldStateSnapshot from the current EstimatorState and timestamp.
 */
export function buildWorldStateSnapshot(
  input: BuildWorldStateInput,
): WorldStateSnapshot {
  const { dataset, ego, timestampMs, mode, scenarioId, options } = input;
  const egoConsist = buildEgoConsist(dataset, ego);
  const nearbyTrains = computeNearbyTrains(dataset, ego, timestampMs, options);
  const nearbyLandmarks = computeNearbyLandmarks(
    dataset,
    ego,
    options?.maxLandmarkRadiusM ?? DEFAULT_MAX_LANDMARK_RADIUS_M,
  );

  return {
    timestampMs,
    mode,
    scenarioId,
    ego,
    egoConsist,
    nearbyTrains,
    nearbyLandmarks,
  };
}
