import type {
  InterStationRunTime,
  PeriodScheduleRule,
  RailSystem,
  RouteSchedule,
  ServicePeriod,
  Station,
  TrackPolyline,
  TrackServiceType,
} from '../types/transit';

export const SERVICE_PERIODS: readonly ServicePeriod[] = [
  'WEEKDAY_AM_RUSH',
  'WEEKDAY_MIDDAY',
  'WEEKDAY_PM_RUSH',
  'WEEKDAY_EVENING',
  'WEEKEND_DAY',
  'LATE_NIGHT',
] as const;

interface RouteSpec {
  routeId: string;
  system: RailSystem;
  color: string;
  division: 'A' | 'B' | 'REGIONAL';
  carCount: number;
  carLengthM: number;
  carWidthM: number;
  fwdTrackId: string;
  revTrackId: string;
  fwdLateNightTrackId?: string;
  revLateNightTrackId?: string;
  baseHeadwayRushSec: number;
  baseHeadwayMiddaySec: number;
  baseHeadwayEveningSec: number;
  baseHeadwayWeekendSec: number;
  baseHeadwayNightSec: number;
  weekendActive?: boolean;
  lateNightActive?: boolean;
  rushOnlyPeakDirection?: boolean;
  offsetSeedSec: number;
}

const ROUTE_SPECS: readonly RouteSpec[] = [
  // 1/2/3 — IRT Broadway–7th Ave (Div A)
  { routeId: '1', system: 'MTA', color: '#EE352E', division: 'A', carCount: 10, carLengthM: 15.54, carWidthM: 2.67, fwdTrackId: 'mta-123-local-uptown', revTrackId: 'mta-123-local-downtown', baseHeadwayRushSec: 210, baseHeadwayMiddaySec: 360, baseHeadwayEveningSec: 450, baseHeadwayWeekendSec: 480, baseHeadwayNightSec: 1200, offsetSeedSec: 0 },
  { routeId: '2', system: 'MTA', color: '#EE352E', division: 'A', carCount: 10, carLengthM: 15.54, carWidthM: 2.67, fwdTrackId: 'mta-123-express-uptown', revTrackId: 'mta-123-express-downtown', fwdLateNightTrackId: 'mta-123-local-uptown', revLateNightTrackId: 'mta-123-local-downtown', baseHeadwayRushSec: 240, baseHeadwayMiddaySec: 420, baseHeadwayEveningSec: 480, baseHeadwayWeekendSec: 540, baseHeadwayNightSec: 1200, offsetSeedSec: 45 },
  { routeId: '3', system: 'MTA', color: '#EE352E', division: 'A', carCount: 10, carLengthM: 15.54, carWidthM: 2.67, fwdTrackId: 'mta-123-express-uptown', revTrackId: 'mta-123-express-downtown', fwdLateNightTrackId: 'mta-123-local-uptown', revLateNightTrackId: 'mta-123-local-downtown', baseHeadwayRushSec: 270, baseHeadwayMiddaySec: 450, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, offsetSeedSec: 120 },

  // 4/5/6 — IRT Lexington Ave (Div A)
  { routeId: '4', system: 'MTA', color: '#00933C', division: 'A', carCount: 10, carLengthM: 15.54, carWidthM: 2.67, fwdTrackId: 'mta-456-express-uptown', revTrackId: 'mta-456-express-downtown', fwdLateNightTrackId: 'mta-456-local-uptown', revLateNightTrackId: 'mta-456-local-downtown', baseHeadwayRushSec: 210, baseHeadwayMiddaySec: 390, baseHeadwayEveningSec: 450, baseHeadwayWeekendSec: 480, baseHeadwayNightSec: 1200, offsetSeedSec: 20 },
  { routeId: '5', system: 'MTA', color: '#00933C', division: 'A', carCount: 10, carLengthM: 15.54, carWidthM: 2.67, fwdTrackId: 'mta-456-express-uptown', revTrackId: 'mta-456-express-downtown', fwdLateNightTrackId: 'mta-456-local-uptown', revLateNightTrackId: 'mta-456-local-downtown', baseHeadwayRushSec: 240, baseHeadwayMiddaySec: 420, baseHeadwayEveningSec: 510, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, offsetSeedSec: 110 },
  { routeId: '6', system: 'MTA', color: '#00933C', division: 'A', carCount: 10, carLengthM: 15.54, carWidthM: 2.67, fwdTrackId: 'mta-456-local-uptown', revTrackId: 'mta-456-local-downtown', baseHeadwayRushSec: 180, baseHeadwayMiddaySec: 360, baseHeadwayEveningSec: 420, baseHeadwayWeekendSec: 480, baseHeadwayNightSec: 1200, offsetSeedSec: 60 },

  // 7 — IRT Flushing (Div A, 11 cars)
  { routeId: '7', system: 'MTA', color: '#B933AD', division: 'A', carCount: 11, carLengthM: 15.54, carWidthM: 2.67, fwdTrackId: 'mta-7-local-outbound', revTrackId: 'mta-7-local-inbound', baseHeadwayRushSec: 180, baseHeadwayMiddaySec: 360, baseHeadwayEveningSec: 420, baseHeadwayWeekendSec: 480, baseHeadwayNightSec: 960, offsetSeedSec: 30 },

  // A/C/E — IND 8th Ave (Div B)
  { routeId: 'A', system: 'MTA', color: '#0039A6', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-ace-express-uptown', revTrackId: 'mta-ace-express-downtown', fwdLateNightTrackId: 'mta-ace-local-uptown', revLateNightTrackId: 'mta-ace-local-downtown', baseHeadwayRushSec: 240, baseHeadwayMiddaySec: 420, baseHeadwayEveningSec: 480, baseHeadwayWeekendSec: 540, baseHeadwayNightSec: 1200, offsetSeedSec: 15 },
  { routeId: 'C', system: 'MTA', color: '#0039A6', division: 'B', carCount: 8, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-ace-local-uptown', revTrackId: 'mta-ace-local-downtown', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 480, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, lateNightActive: false, offsetSeedSec: 90 },
  { routeId: 'E', system: 'MTA', color: '#0039A6', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-e-queens-uptown', revTrackId: 'mta-e-queens-downtown', baseHeadwayRushSec: 210, baseHeadwayMiddaySec: 420, baseHeadwayEveningSec: 480, baseHeadwayWeekendSec: 540, baseHeadwayNightSec: 1200, offsetSeedSec: 150 },

  // B/D/F/M — IND 6th Ave (Div B)
  { routeId: 'B', system: 'MTA', color: '#FF6319', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-bdfm-express-uptown', revTrackId: 'mta-bdfm-express-downtown', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 480, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, weekendActive: false, lateNightActive: false, offsetSeedSec: 35 },
  { routeId: 'D', system: 'MTA', color: '#FF6319', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-bdfm-express-uptown', revTrackId: 'mta-bdfm-express-downtown', fwdLateNightTrackId: 'mta-bdfm-local-uptown', revLateNightTrackId: 'mta-bdfm-local-downtown', baseHeadwayRushSec: 270, baseHeadwayMiddaySec: 450, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, offsetSeedSec: 135 },
  { routeId: 'F', system: 'MTA', color: '#FF6319', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-bdfm-local-uptown', revTrackId: 'mta-bdfm-local-downtown', baseHeadwayRushSec: 240, baseHeadwayMiddaySec: 420, baseHeadwayEveningSec: 480, baseHeadwayWeekendSec: 540, baseHeadwayNightSec: 1200, offsetSeedSec: 75 },
  { routeId: 'M', system: 'MTA', color: '#FF6319', division: 'B', carCount: 8, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-bdfm-local-uptown', revTrackId: 'mta-bdfm-local-downtown', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 480, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, offsetSeedSec: 190 },

  // N/Q/R/W — BMT Broadway (Div B)
  { routeId: 'N', system: 'MTA', color: '#FCCC0A', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-nqrw-express-uptown', revTrackId: 'mta-nqrw-express-downtown', fwdLateNightTrackId: 'mta-nqrw-local-uptown', revLateNightTrackId: 'mta-nqrw-local-downtown', baseHeadwayRushSec: 270, baseHeadwayMiddaySec: 450, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 540, baseHeadwayNightSec: 1200, offsetSeedSec: 50 },
  { routeId: 'Q', system: 'MTA', color: '#FCCC0A', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-nqrw-express-uptown', revTrackId: 'mta-nqrw-express-downtown', fwdLateNightTrackId: 'mta-nqrw-local-uptown', revLateNightTrackId: 'mta-nqrw-local-downtown', baseHeadwayRushSec: 240, baseHeadwayMiddaySec: 420, baseHeadwayEveningSec: 480, baseHeadwayWeekendSec: 540, baseHeadwayNightSec: 1200, offsetSeedSec: 140 },
  { routeId: 'R', system: 'MTA', color: '#FCCC0A', division: 'B', carCount: 10, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-nqrw-local-uptown', revTrackId: 'mta-nqrw-local-downtown', baseHeadwayRushSec: 270, baseHeadwayMiddaySec: 450, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, offsetSeedSec: 80 },
  { routeId: 'W', system: 'MTA', color: '#FCCC0A', division: 'B', carCount: 8, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-nqrw-local-uptown', revTrackId: 'mta-nqrw-local-downtown', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 480, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, weekendActive: false, lateNightActive: false, offsetSeedSec: 200 },

  // L — BMT Canarsie (Div B, 8 cars)
  { routeId: 'L', system: 'MTA', color: '#A7A9AC', division: 'B', carCount: 8, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-l-local-outbound', revTrackId: 'mta-l-local-inbound', baseHeadwayRushSec: 180, baseHeadwayMiddaySec: 360, baseHeadwayEveningSec: 420, baseHeadwayWeekendSec: 480, baseHeadwayNightSec: 960, offsetSeedSec: 25 },

  // G — IND Crosstown (Div B, 5 cars)
  { routeId: 'G', system: 'MTA', color: '#6CBE45', division: 'B', carCount: 5, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-g-local-downtown', revTrackId: 'mta-g-local-uptown', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 480, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, offsetSeedSec: 70 },

  // J/Z — BMT Nassau (Div B, 8 cars)
  { routeId: 'J', system: 'MTA', color: '#996633', division: 'B', carCount: 8, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-jz-local-outbound', revTrackId: 'mta-jz-local-inbound', baseHeadwayRushSec: 270, baseHeadwayMiddaySec: 480, baseHeadwayEveningSec: 540, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, offsetSeedSec: 40 },
  { routeId: 'Z', system: 'MTA', color: '#996633', division: 'B', carCount: 8, carLengthM: 18.44, carWidthM: 3.05, fwdTrackId: 'mta-jz-local-outbound', revTrackId: 'mta-jz-local-inbound', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 600, baseHeadwayEveningSec: 600, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 1200, rushOnlyPeakDirection: true, offsetSeedSec: 160 },

  // REGIONAL — LIRR
  { routeId: 'LIRR-MAIN', system: 'LIRR', color: '#006EC7', division: 'REGIONAL', carCount: 8, carLengthM: 25.9, carWidthM: 3.2, fwdTrackId: 'lirr-main-outbound', revTrackId: 'lirr-main-inbound', baseHeadwayRushSec: 360, baseHeadwayMiddaySec: 720, baseHeadwayEveningSec: 900, baseHeadwayWeekendSec: 900, baseHeadwayNightSec: 1800, offsetSeedSec: 55 },
  { routeId: 'LIRR-GCM', system: 'LIRR', color: '#006EC7', division: 'REGIONAL', carCount: 8, carLengthM: 25.9, carWidthM: 3.2, fwdTrackId: 'lirr-gcm-outbound', revTrackId: 'lirr-gcm-inbound', baseHeadwayRushSec: 420, baseHeadwayMiddaySec: 900, baseHeadwayEveningSec: 1200, baseHeadwayWeekendSec: 1200, baseHeadwayNightSec: 2400, offsetSeedSec: 175 },
  { routeId: 'LIRR-ATL', system: 'LIRR', color: '#006EC7', division: 'REGIONAL', carCount: 6, carLengthM: 25.9, carWidthM: 3.2, fwdTrackId: 'lirr-atl-outbound', revTrackId: 'lirr-atl-inbound', baseHeadwayRushSec: 480, baseHeadwayMiddaySec: 900, baseHeadwayEveningSec: 1200, baseHeadwayWeekendSec: 1200, baseHeadwayNightSec: 2400, offsetSeedSec: 230 },

  // REGIONAL — MNR
  { routeId: 'MNR-HARLEM', system: 'MNR', color: '#0052A5', division: 'REGIONAL', carCount: 8, carLengthM: 25.9, carWidthM: 3.2, fwdTrackId: 'mnr-harlem-outbound', revTrackId: 'mnr-harlem-inbound', baseHeadwayRushSec: 360, baseHeadwayMiddaySec: 900, baseHeadwayEveningSec: 1200, baseHeadwayWeekendSec: 1200, baseHeadwayNightSec: 2400, offsetSeedSec: 95 },

  // REGIONAL — PATH
  { routeId: 'PATH-HOB', system: 'PATH', color: '#D93A30', division: 'REGIONAL', carCount: 8, carLengthM: 15.6, carWidthM: 2.8, fwdTrackId: 'path-hob-outbound', revTrackId: 'path-hob-inbound', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 600, baseHeadwayEveningSec: 900, baseHeadwayWeekendSec: 900, baseHeadwayNightSec: 1800, offsetSeedSec: 65 },
  { routeId: 'PATH-NWK', system: 'PATH', color: '#D93A30', division: 'REGIONAL', carCount: 8, carLengthM: 15.6, carWidthM: 2.8, fwdTrackId: 'path-nwk-outbound', revTrackId: 'path-nwk-inbound', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 600, baseHeadwayEveningSec: 900, baseHeadwayWeekendSec: 900, baseHeadwayNightSec: 2100, offsetSeedSec: 145 },

  // REGIONAL — NJT
  { routeId: 'NJT-NEC', system: 'NJT', color: '#F7931E', division: 'REGIONAL', carCount: 8, carLengthM: 25.9, carWidthM: 3.2, fwdTrackId: 'njt-nec-outbound', revTrackId: 'njt-nec-inbound', baseHeadwayRushSec: 420, baseHeadwayMiddaySec: 900, baseHeadwayEveningSec: 1200, baseHeadwayWeekendSec: 1500, baseHeadwayNightSec: 3600, offsetSeedSec: 115 },

  // REGIONAL — AIRTRAIN
  { routeId: 'AIRTRAIN-JFK', system: 'AIRTRAIN', color: '#00A1DE', division: 'REGIONAL', carCount: 4, carLengthM: 17.6, carWidthM: 3.1, fwdTrackId: 'airtrain-jfk-outbound', revTrackId: 'airtrain-jfk-inbound', baseHeadwayRushSec: 360, baseHeadwayMiddaySec: 480, baseHeadwayEveningSec: 600, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 900, offsetSeedSec: 25 },
  { routeId: 'AIRTRAIN-EWR', system: 'AIRTRAIN', color: '#00A1DE', division: 'REGIONAL', carCount: 4, carLengthM: 15.0, carWidthM: 2.7, fwdTrackId: 'airtrain-ewr-outbound', revTrackId: 'airtrain-ewr-inbound', baseHeadwayRushSec: 300, baseHeadwayMiddaySec: 420, baseHeadwayEveningSec: 600, baseHeadwayWeekendSec: 600, baseHeadwayNightSec: 900, offsetSeedSec: 85 },
];

function avgSpeedForService(serviceType: TrackServiceType): number {
  if (serviceType === 'COMMUTER') return 20.0;
  if (serviceType === 'EXPRESS') return 15.5;
  return 11.5;
}

function maxSpeedForService(serviceType: TrackServiceType): number {
  if (serviceType === 'COMMUTER') return 32.0;
  if (serviceType === 'EXPRESS') return 24.0;
  return 18.0;
}

function buildRunTimes(
  track: TrackPolyline,
  stationById: ReadonlyMap<string, Station>,
): InterStationRunTime[] {
  const avgSpeed = avgSpeedForService(track.serviceType);
  const maxSpeed = maxSpeedForService(track.serviceType);
  const runTimes: InterStationRunTime[] = [];

  for (let i = 0; i < track.stations.length - 1; i++) {
    const fromRef = track.stations[i];
    const toRef = track.stations[i + 1];
    const deltaS = Math.max(50, toRef.s - fromRef.s);
    const meanSec = Math.max(35, Math.round(deltaS / avgSpeed + 18));
    const stdSec = Math.max(8, Math.round(meanSec * 0.14));
    const toStation = stationById.get(toRef.stationId);
    const dwellSec = toStation?.isHub ? 40 : 25;
    runTimes.push({
      fromStationId: fromRef.stationId,
      toStationId: toRef.stationId,
      meanSec,
      stdSec,
      dwellSec,
      maxSpeedMps: maxSpeed,
    });
  }
  return runTimes;
}

function buildPeriodRules(
  spec: RouteSpec,
  track: TrackPolyline,
  lateNightTrackId: string | undefined,
  isForwardDir: boolean,
): Record<ServicePeriod, PeriodScheduleRule> {
  const baseService = track.serviceType;
  const weekendActive = spec.weekendActive ?? true;
  const lateNightActive = spec.lateNightActive ?? true;
  const baseDwell = spec.system === 'MTA' ? 25 : 40;

  // Z train only runs rush-hour peak direction (AM inbound, PM outbound)
  const amActive = spec.rushOnlyPeakDirection ? !isForwardDir : true;
  const pmActive = spec.rushOnlyPeakDirection ? isForwardDir : true;
  const middayActive = !spec.rushOnlyPeakDirection;
  const eveningActive = !spec.rushOnlyPeakDirection;
  const wkndActive = spec.rushOnlyPeakDirection ? false : weekendActive;
  const nightActive = spec.rushOnlyPeakDirection ? false : lateNightActive;

  const nightService: TrackServiceType = lateNightTrackId ? 'LOCAL' : baseService;
  const dirOffset = isForwardDir ? spec.offsetSeedSec : spec.offsetSeedSec + 30;

  return {
    WEEKDAY_AM_RUSH: {
      active: amActive,
      serviceType: baseService,
      headwaySec: spec.baseHeadwayRushSec,
      offsetSec: dirOffset % spec.baseHeadwayRushSec,
      dwellSec: baseDwell + 5,
      runTimeMultiplier: 1.08,
    },
    WEEKDAY_MIDDAY: {
      active: middayActive,
      serviceType: baseService,
      headwaySec: spec.baseHeadwayMiddaySec,
      offsetSec: dirOffset % spec.baseHeadwayMiddaySec,
      dwellSec: baseDwell,
      runTimeMultiplier: 1.0,
    },
    WEEKDAY_PM_RUSH: {
      active: pmActive,
      serviceType: baseService,
      headwaySec: spec.baseHeadwayRushSec,
      offsetSec: (dirOffset + 15) % spec.baseHeadwayRushSec,
      dwellSec: baseDwell + 5,
      runTimeMultiplier: 1.08,
    },
    WEEKDAY_EVENING: {
      active: eveningActive,
      serviceType: baseService,
      headwaySec: spec.baseHeadwayEveningSec,
      offsetSec: dirOffset % spec.baseHeadwayEveningSec,
      dwellSec: baseDwell,
      runTimeMultiplier: 0.98,
    },
    WEEKEND_DAY: {
      active: wkndActive,
      serviceType: baseService,
      headwaySec: spec.baseHeadwayWeekendSec,
      offsetSec: dirOffset % spec.baseHeadwayWeekendSec,
      dwellSec: baseDwell,
      runTimeMultiplier: 1.02,
    },
    LATE_NIGHT: {
      active: nightActive,
      serviceType: nightService,
      headwaySec: spec.baseHeadwayNightSec,
      offsetSec: dirOffset % spec.baseHeadwayNightSec,
      dwellSec: baseDwell,
      trackIdOverride: lateNightTrackId,
      runTimeMultiplier: 0.95,
    },
  };
}

export function createSchedules(
  tracks: readonly TrackPolyline[],
  stations: readonly Station[],
): RouteSchedule[] {
  const trackById = new Map<string, TrackPolyline>(tracks.map((t) => [t.id, t]));
  const stationById = new Map<string, Station>(stations.map((s) => [s.id, s]));
  const schedules: RouteSchedule[] = [];

  for (const spec of ROUTE_SPECS) {
    const directions: Array<{
      trackId: string;
      lateNightTrackId?: string;
      isForward: boolean;
    }> = [
      { trackId: spec.fwdTrackId, lateNightTrackId: spec.fwdLateNightTrackId, isForward: true },
      { trackId: spec.revTrackId, lateNightTrackId: spec.revLateNightTrackId, isForward: false },
    ];

    for (const dir of directions) {
      const track = trackById.get(dir.trackId);
      if (!track) {
        throw new Error(`Schedule for route "${spec.routeId}" references missing track "${dir.trackId}"`);
      }

      schedules.push({
        id: `sched-${spec.routeId.toLowerCase()}-${track.direction.toLowerCase()}`,
        routeId: spec.routeId,
        system: spec.system,
        trackId: track.id,
        lateNightTrackId: dir.lateNightTrackId,
        color: spec.color,
        serviceType: track.serviceType,
        direction: track.direction,
        division: spec.division,
        carCount: spec.carCount,
        carLengthM: spec.carLengthM,
        carWidthM: spec.carWidthM,
        periods: buildPeriodRules(spec, track, dir.lateNightTrackId, dir.isForward),
        runTimes: buildRunTimes(track, stationById),
      });
    }
  }

  return schedules;
}
