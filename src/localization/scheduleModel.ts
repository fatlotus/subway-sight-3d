import type {
  InterStationRunTime,
  PeriodScheduleRule,
  RailSystem,
  RouteSchedule,
  ServicePeriod,
  TrackPolyline,
  TrackServiceType,
  TransitDataset,
} from '../types/transit';

export interface ActiveScheduleContext {
  schedule: RouteSchedule;
  period: ServicePeriod;
  rule: PeriodScheduleRule;
  /** Effective track (rule.trackIdOverride ?? schedule.trackId). */
  effectiveTrack: TrackPolyline;
  /** Effective serviceType (rule.serviceType). */
  effectiveServiceType: TrackServiceType;
  /** Run times aligned with effectiveTrack.stations (scaled by rule.runTimeMultiplier). */
  effectiveRunTimes: InterStationRunTime[];
  /** Cumulative arrival seconds from track start (index matches effectiveTrack.stations). */
  cumulativeStopSec: number[];
  /** Total end-to-end trip duration in seconds. */
  totalTripDurationSec: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const periodCache = new Map<string, { minuteBucket: number; period: ServicePeriod }>();
const contextCache = new WeakMap<
  TransitDataset,
  Map<ServicePeriod, ActiveScheduleContext[]>
>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Pure classifier from local day-of-week (0=Sun..6=Sat) and hour (0..23).
 * Late night (00:00–05:59) applies every day including weekends.
 */
export function classifyServicePeriodFromLocalTime(
  dayOfWeek: number,
  hour: number,
): ServicePeriod {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h < 6) {
    return 'LATE_NIGHT';
  }
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return 'WEEKEND_DAY';
  }
  if (h < 10) {
    return 'WEEKDAY_AM_RUSH';
  }
  if (h < 16) {
    return 'WEEKDAY_MIDDAY';
  }
  if (h < 20) {
    return 'WEEKDAY_PM_RUSH';
  }
  return 'WEEKDAY_EVENING';
}

const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Classify NYC ServicePeriod from epoch milliseconds using America/New_York by default.
 */
export function classifyServicePeriod(
  timestampMs: number,
  timeZone = 'America/New_York',
): ServicePeriod {
  const safeMs =
    Number.isFinite(timestampMs) && Math.abs(timestampMs) <= MAX_DATE_MS
      ? timestampMs
      : Date.now();
  const minuteBucket = Math.floor(safeMs / 60_000);
  const cached = periodCache.get(timeZone);
  if (cached && cached.minuteBucket === minuteBucket) {
    return cached.period;
  }

  const parts = getFormatter(timeZone).formatToParts(new Date(safeMs));

  let dayOfWeek = 3; // fallback Wednesday
  let hour = 12;

  for (const part of parts) {
    if (part.type === 'weekday' && part.value in WEEKDAY_MAP) {
      dayOfWeek = WEEKDAY_MAP[part.value];
    } else if (part.type === 'hour') {
      const parsed = Number.parseInt(part.value, 10);
      if (Number.isFinite(parsed)) {
        hour = parsed % 24; // ICU can format midnight as '24'
      }
    }
  }

  const period = classifyServicePeriodFromLocalTime(dayOfWeek, hour);
  periodCache.set(timeZone, { minuteBucket, period });
  return period;
}

function getAvgCruiseSpeed(serviceType: TrackServiceType): number {
  if (serviceType === 'COMMUTER') return 20.0;
  if (serviceType === 'EXPRESS') return 15.5;
  return 11.5;
}

function buildEffectiveRunTimes(
  dataset: TransitDataset,
  sched: RouteSchedule,
  effectiveTrack: TrackPolyline,
  rule: PeriodScheduleRule,
): InterStationRunTime[] {
  const mult = rule.runTimeMultiplier ?? 1.0;

  // If using the schedule's primary track, scale its precomputed runTimes directly.
  if (effectiveTrack.id === sched.trackId && sched.runTimes.length > 0) {
    return sched.runTimes.map((rt) => ({
      ...rt,
      meanSec: Math.max(20, Math.round(rt.meanSec * mult)),
      dwellSec: rule.dwellSec > 0 ? rule.dwellSec : rt.dwellSec,
    }));
  }

  // Late-night track override: borrow base runTimes from a schedule whose primary track matches,
  // or synthesize from effectiveTrack.stations.
  const donor = dataset.schedules.find(
    (s) => s.trackId === effectiveTrack.id && s.runTimes.length > 0,
  );
  if (donor) {
    return donor.runTimes.map((rt) => ({
      ...rt,
      meanSec: Math.max(20, Math.round(rt.meanSec * mult)),
      dwellSec: rule.dwellSec > 0 ? rule.dwellSec : rt.dwellSec,
    }));
  }

  const avgSpeed = getAvgCruiseSpeed(rule.serviceType);
  const maxSpeedMps =
    rule.serviceType === 'COMMUTER'
      ? 30
      : rule.serviceType === 'EXPRESS'
        ? 22
        : 16;

  const synthesized: InterStationRunTime[] = [];
  for (let i = 0; i < effectiveTrack.stations.length - 1; i++) {
    const a = effectiveTrack.stations[i];
    const b = effectiveTrack.stations[i + 1];
    const deltaS = Math.max(50, b.s - a.s);
    const meanSec = Math.max(
      35,
      Math.round((deltaS / avgSpeed + 18) * mult),
    );
    const toStation = dataset.stationById.get(b.stationId);
    synthesized.push({
      fromStationId: a.stationId,
      toStationId: b.stationId,
      meanSec,
      stdSec: Math.max(10, Math.round(meanSec * 0.15)),
      dwellSec: rule.dwellSec > 0 ? rule.dwellSec : toStation?.isHub ? 40 : 25,
      maxSpeedMps,
    });
  }
  return synthesized;
}

function buildContext(
  dataset: TransitDataset,
  sched: RouteSchedule,
  period: ServicePeriod,
): ActiveScheduleContext | null {
  const rule = sched.periods[period];
  if (!rule || !rule.active) return null;

  const effectiveTrackId = rule.trackIdOverride ?? sched.trackId;
  const effectiveTrack = dataset.trackById.get(effectiveTrackId);
  if (!effectiveTrack) return null;

  const effectiveRunTimes = buildEffectiveRunTimes(
    dataset,
    sched,
    effectiveTrack,
    rule,
  );

  const rtByPair = new Map<string, InterStationRunTime>();
  for (const rt of effectiveRunTimes) {
    rtByPair.set(`${rt.fromStationId}->${rt.toStationId}`, rt);
  }

  const avgSpeed = getAvgCruiseSpeed(rule.serviceType);
  const cumulativeStopSec: number[] = [];
  let t = 0;

  if (effectiveTrack.stations.length > 0 && effectiveTrack.stations[0].s > 1) {
    t += effectiveTrack.stations[0].s / avgSpeed;
  }

  for (let i = 0; i < effectiveTrack.stations.length; i++) {
    cumulativeStopSec.push(t);
    if (i < effectiveTrack.stations.length - 1) {
      const a = effectiveTrack.stations[i];
      const b = effectiveTrack.stations[i + 1];
      const rt = rtByPair.get(`${a.stationId}->${b.stationId}`);
      const dwell = i === 0 ? 0 : rt ? rt.dwellSec : rule.dwellSec;
      const runSec = rt
        ? rt.meanSec
        : Math.max(35, Math.round((b.s - a.s) / avgSpeed + 18));
      t += dwell + runSec;
    }
  }

  if (effectiveTrack.stations.length > 0) {
    const lastS = effectiveTrack.stations[effectiveTrack.stations.length - 1].s;
    if (effectiveTrack.totalLengthM - lastS > 1) {
      t += (effectiveTrack.totalLengthM - lastS) / avgSpeed;
    }
  } else {
    t = Math.max(60, effectiveTrack.totalLengthM / avgSpeed);
  }

  return {
    schedule: sched,
    period,
    rule,
    effectiveTrack,
    effectiveServiceType: rule.serviceType,
    effectiveRunTimes,
    cumulativeStopSec,
    totalTripDurationSec: Math.max(60, t),
  };
}

/**
 * Return all active schedule contexts for a given ServicePeriod, cached per (dataset, period).
 */
export function getActiveScheduleContexts(
  dataset: TransitDataset,
  period: ServicePeriod,
  systems?: readonly RailSystem[],
): ActiveScheduleContext[] {
  let byPeriod = contextCache.get(dataset);
  if (!byPeriod) {
    byPeriod = new Map<ServicePeriod, ActiveScheduleContext[]>();
    contextCache.set(dataset, byPeriod);
  }

  let allActive = byPeriod.get(period);
  if (!allActive) {
    allActive = [];
    for (const sched of dataset.schedules) {
      const ctx = buildContext(dataset, sched, period);
      if (ctx) {
        allActive.push(ctx);
      }
    }
    byPeriod.set(period, allActive);
  }

  if (!systems || systems.length === 0) {
    return allActive;
  }
  const allowed = new Set(systems);
  return allActive.filter((ctx) => allowed.has(ctx.schedule.system));
}

/**
 * Check whether a routeId has at least one active schedule in the given service period.
 */
export function isRouteActiveInPeriod(
  dataset: TransitDataset,
  routeId: string,
  period: ServicePeriod,
): boolean {
  const active = getActiveScheduleContexts(dataset, period);
  return active.some((ctx) => ctx.schedule.routeId === routeId);
}

/** Interpolate scheduled elapsed trip time tTrip(s) in seconds from track start. */
function interpolateTripTimeAtS(ctx: ActiveScheduleContext, s: number): number {
  const stations = ctx.effectiveTrack.stations;
  const cumSec = ctx.cumulativeStopSec;

  if (stations.length === 0) {
    const frac =
      ctx.effectiveTrack.totalLengthM > 0
        ? Math.max(0, Math.min(1, s / ctx.effectiveTrack.totalLengthM))
        : 0;
    return frac * ctx.totalTripDurationSec;
  }

  if (s <= stations[0].s) {
    return stations[0].s > 0 ? (s / stations[0].s) * cumSec[0] : 0;
  }

  const lastIdx = stations.length - 1;
  if (s >= stations[lastIdx].s) {
    const remLen = ctx.effectiveTrack.totalLengthM - stations[lastIdx].s;
    const remSec = ctx.totalTripDurationSec - cumSec[lastIdx];
    return remLen > 0
      ? cumSec[lastIdx] + ((s - stations[lastIdx].s) / remLen) * remSec
      : cumSec[lastIdx];
  }

  for (let i = 0; i < lastIdx; i++) {
    if (s >= stations[i].s && s <= stations[i + 1].s) {
      const ds = stations[i + 1].s - stations[i].s;
      const frac = ds > 1e-6 ? (s - stations[i].s) / ds : 0;
      return cumSec[i] + frac * (cumSec[i + 1] - cumSec[i]);
    }
  }

  return cumSec[lastIdx];
}

/**
 * Soft timetable phase log-likelihood at arc-length `s` and epoch `timestampMs`.
 * Bounded in [-2.0, 0.0] so real-world MTA delays never override hard GPS/DR evidence.
 */
export function evaluateTimetablePhaseLogLikelihood(
  ctx: ActiveScheduleContext,
  s: number,
  timestampMs: number,
): number {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(s)) {
    return 0;
  }
  const headway = Math.max(60, ctx.rule.headwaySec);
  const tTrip = interpolateTripTimeAtS(ctx, s);
  const tNowSec = ((timestampMs / 1000) % 86400 + 86400) % 86400;

  const rawMod =
    (((tNowSec - tTrip - ctx.rule.offsetSec) % headway) + headway) % headway;
  const phaseErrSec = rawMod > headway * 0.5 ? rawMod - headway : rawMod;

  const sigmaPhase = Math.max(45, headway * 0.25);
  return -0.5 * Math.min(4.0, (phaseErrSec / sigmaPhase) ** 2);
}

/**
 * Log-likelihood of an observed inter-station run time between two stations.
 */
export function evaluateRunTimeLogLikelihood(
  ctx: ActiveScheduleContext,
  fromStationId: string,
  toStationId: string,
  observedSec: number,
): number {
  if (!Number.isFinite(observedSec) || observedSec <= 0) return 0;

  const rt = ctx.effectiveRunTimes.find(
    (r) => r.fromStationId === fromStationId && r.toStationId === toStationId,
  );
  if (!rt) {
    return -0.5;
  }

  const sigma = Math.max(12, rt.stdSec);
  return -0.5 * Math.min(9.0, ((observedSec - rt.meanSec) / sigma) ** 2);
}

/**
 * Compute current/next station and ETA in seconds from (s, speedMps) along effectiveTrack.
 */
export function estimateNextStationAndEta(
  ctx: ActiveScheduleContext,
  s: number,
  speedMps: number,
  dataset: TransitDataset,
): {
  currentStationId: string | null;
  currentStationName: string;
  nextStationId: string | null;
  nextStationName: string;
  etaSec: number | null;
  distToNearestStationM: number;
  nearestStationId: string | null;
} {
  const stations = ctx.effectiveTrack.stations;
  if (stations.length === 0) {
    return {
      currentStationId: null,
      currentStationName: 'Unknown',
      nextStationId: null,
      nextStationName: 'Unknown',
      etaSec: null,
      distToNearestStationM: Infinity,
      nearestStationId: null,
    };
  }

  let nearestIdx = 0;
  let nearestDist = Infinity;
  let nextIdx = -1;

  for (let i = 0; i < stations.length; i++) {
    const d = Math.abs(stations[i].s - s);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
    if (nextIdx === -1 && stations[i].s > s + 40) {
      nextIdx = i;
    }
  }

  const nearestRef = stations[nearestIdx];
  const nearestStation = dataset.stationById.get(nearestRef.stationId);

  // If within 90m of a station, treat it as currentStation; otherwise use last passed station
  let currentRef = nearestRef;
  if (nearestDist > 90) {
    let lastPassedIdx = 0;
    for (let i = 0; i < stations.length; i++) {
      if (stations[i].s <= s) {
        lastPassedIdx = i;
      } else {
        break;
      }
    }
    currentRef = stations[lastPassedIdx];
  }

  const currentStation = dataset.stationById.get(currentRef.stationId);
  const nextRef = nextIdx >= 0 ? stations[nextIdx] : null;
  const nextStation = nextRef ? dataset.stationById.get(nextRef.stationId) : null;

  let etaSec: number | null = null;
  if (nextRef) {
    const distM = Math.max(0, nextRef.s - s);
    const effectiveSpeed =
      speedMps >= 3.0 ? speedMps : getAvgCruiseSpeed(ctx.effectiveServiceType) * 0.85;
    etaSec = Math.max(0, Math.round(distM / Math.max(1, effectiveSpeed)));
  }

  return {
    currentStationId: currentRef.stationId,
    currentStationName: currentStation?.name ?? currentRef.stationId,
    nextStationId: nextRef ? nextRef.stationId : null,
    nextStationName: nextStation?.name ?? (nextRef ? nextRef.stationId : 'Terminal'),
    etaSec,
    distToNearestStationM: nearestDist,
    nearestStationId: nearestStation?.id ?? nearestRef.stationId,
  };
}
