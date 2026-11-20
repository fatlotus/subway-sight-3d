import { buildTrackPoints, type RawTrackWaypoint } from '../geo/projection';
import type {
  GpsVisibility,
  RailSystem,
  Station,
  StructureType,
  TrackDirection,
  TrackPolyline,
  TrackServiceType,
  TrackStationRef,
} from '../types/transit';

interface WaypointSpec {
  stationId?: string;
  lat?: number;
  lon?: number;
  elevM?: number;
  structure?: StructureType;
  gpsVisibility?: GpsVisibility;
  maxSpeedMps?: number;
  /** If true, this station waypoint is only a pass-through (express skips stop). */
  skipStop?: boolean;
}

interface TrackBuildConfig {
  id: string;
  name: string;
  system: RailSystem;
  trunk: string;
  routes: string[];
  serviceType: TrackServiceType;
  direction: TrackDirection;
  color: string;
  lateralOffsetM: number;
  reverse?: boolean;
  waypoints: readonly WaypointSpec[];
}

function buildDirectedTrack(
  cfg: TrackBuildConfig,
  stationById: ReadonlyMap<string, Station>,
): TrackPolyline {
  const ordered = cfg.reverse ? [...cfg.waypoints].reverse() : [...cfg.waypoints];

  const rawPoints: RawTrackWaypoint[] = [];
  const stationIndices: Array<{ idx: number; stationId: string }> = [];

  for (let i = 0; i < ordered.length; i++) {
    const wp = ordered[i];
    if (wp.stationId) {
      const st = stationById.get(wp.stationId);
      if (!st) {
        throw new Error(`Unknown stationId "${wp.stationId}" in track "${cfg.id}"`);
      }
      rawPoints.push({
        lat: wp.lat ?? st.lat,
        lon: wp.lon ?? st.lon,
        elevM: wp.elevM ?? st.elevM,
        structure: wp.structure ?? st.structure,
        gpsVisibility: wp.gpsVisibility ?? st.gpsVisibility,
        maxSpeedMps: wp.maxSpeedMps ?? (cfg.serviceType === 'COMMUTER' ? 30 : cfg.serviceType === 'EXPRESS' ? 22 : 16),
      });
      if (!wp.skipStop) {
        stationIndices.push({ idx: i, stationId: st.id });
      }
    } else {
      if (wp.lat === undefined || wp.lon === undefined || wp.elevM === undefined) {
        throw new Error(`Non-station waypoint in track "${cfg.id}" missing lat/lon/elevM`);
      }
      rawPoints.push({
        lat: wp.lat,
        lon: wp.lon,
        elevM: wp.elevM,
        structure: wp.structure ?? 'UNDERGROUND_TUNNEL',
        gpsVisibility: wp.gpsVisibility ?? 'UNDERGROUND',
        maxSpeedMps: wp.maxSpeedMps ?? (cfg.serviceType === 'COMMUTER' ? 32 : cfg.serviceType === 'EXPRESS' ? 24 : 18),
      });
    }
  }

  // When reversing, negate lateralOffsetM so right-hand normal stays on the correct physical side
  const effectiveOffset = cfg.reverse ? -cfg.lateralOffsetM : cfg.lateralOffsetM;
  const points = buildTrackPoints(rawPoints, effectiveOffset);
  const totalLengthM = points.length > 0 ? points[points.length - 1].s : 0;

  const stations: TrackStationRef[] = stationIndices.map(({ idx, stationId }) => ({
    stationId,
    s: points[idx].s,
  }));

  return {
    id: cfg.id,
    name: cfg.name,
    system: cfg.system,
    trunk: cfg.trunk,
    routes: [...cfg.routes],
    serviceType: cfg.serviceType,
    direction: cfg.direction,
    color: cfg.color,
    lateralOffsetM: cfg.lateralOffsetM,
    totalLengthM,
    points,
    stations,
  };
}

function makeBidirectionalPair(
  base: Omit<TrackBuildConfig, 'id' | 'name' | 'direction' | 'lateralOffsetM' | 'reverse'>,
  idPrefix: string,
  namePrefix: string,
  fwdDir: TrackDirection,
  revDir: TrackDirection,
  fwdOffsetM: number,
  revOffsetM: number,
  stationById: ReadonlyMap<string, Station>,
): [TrackPolyline, TrackPolyline] {
  const fwd = buildDirectedTrack(
    {
      ...base,
      id: `${idPrefix}-${fwdDir.toLowerCase()}`,
      name: `${namePrefix} (${fwdDir})`,
      direction: fwdDir,
      lateralOffsetM: fwdOffsetM,
      reverse: false,
    },
    stationById,
  );
  const rev = buildDirectedTrack(
    {
      ...base,
      id: `${idPrefix}-${revDir.toLowerCase()}`,
      name: `${namePrefix} (${revDir})`,
      direction: revDir,
      lateralOffsetM: revOffsetM,
      reverse: true,
    },
    stationById,
  );
  return [fwd, rev];
}

export function createTracks(stations: readonly Station[]): TrackPolyline[] {
  const stationById = new Map<string, Station>(stations.map((s) => [s.id, s]));
  const tracks: TrackPolyline[] = [];

  // =========================================================================
  // 1. MTA 1/2/3 — IRT Broadway–7th Ave (#EE352E)
  //    4-track lateral offsets: [-6, -2, +2, +6]m
  // =========================================================================
  const irt1LocalWps: WaypointSpec[] = [
    { stationId: 'mta-south-ferry' },
    { stationId: 'mta-wtc-cortlandt' },
    { stationId: 'mta-chambers-123' },
    { stationId: 'mta-14st-123' },
    { stationId: 'mta-34st-penn-123' },
    { stationId: 'mta-times-sq-123' },
    { lat: 40.7680, lon: -73.9822, elevM: -16, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-72st-123' },
    { stationId: 'mta-96st-123' },
    { stationId: 'mta-116st-columbia' },
    { lat: 40.8122, lon: -73.9609, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-125st-1' },
    { lat: 40.8215, lon: -73.9542, elevM: 6, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-168st-1' },
    { stationId: 'mta-191st-1' },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: '1/2/3', routes: ['1', '2', '3'], serviceType: 'LOCAL', color: '#EE352E', waypoints: irt1LocalWps },
      'mta-123-local',
      'Broadway–7th Ave Local',
      'UPTOWN',
      'DOWNTOWN',
      6,
      -6,
      stationById,
    ),
  );

  const irt23ExpWps: WaypointSpec[] = [
    { stationId: 'mta-atlantic-barclays', elevM: -9 },
    { stationId: 'mta-borough-hall', elevM: -9 },
    { stationId: 'mta-clark-st', elevM: -26 },
    { lat: 40.7018, lon: -74.0005, elevM: -38, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-wall-st-23', elevM: -19 },
    { stationId: 'mta-fulton-23', elevM: -19 },
    { stationId: 'mta-chambers-123', elevM: -19 },
    { stationId: 'mta-14st-123', elevM: -16 },
    { stationId: 'mta-34st-penn-123', elevM: -16 },
    { stationId: 'mta-times-sq-123', elevM: -16 },
    { lat: 40.7680, lon: -73.9822, elevM: -16, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-72st-123', elevM: -16 },
    { stationId: 'mta-96st-123', elevM: -16 },
    { lat: 40.7965, lon: -73.9630, elevM: -18, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-110st-cpn', elevM: -18 },
    { stationId: 'mta-125st-23', elevM: -18 },
    { lat: 40.8130, lon: -73.9365, elevM: -28, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-149st-gc', elevM: -18 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: '1/2/3', routes: ['2', '3'], serviceType: 'EXPRESS', color: '#EE352E', waypoints: irt23ExpWps },
      'mta-123-express',
      'Broadway–7th Ave Express',
      'UPTOWN',
      'DOWNTOWN',
      2,
      -2,
      stationById,
    ),
  );

  // =========================================================================
  // 2. MTA 4/5/6 — IRT Lexington Ave (#00933C)
  //    Bi-level vertical separation: Local -11/-12m, Express -20/-23m
  // =========================================================================
  const lexLocalWps: WaypointSpec[] = [
    { stationId: 'mta-bklyn-bridge-city-hall', elevM: -11 },
    { stationId: 'mta-canal-6', elevM: -11 },
    { stationId: 'mta-bleecker-6', elevM: -11 },
    { lat: 40.7318, lon: -73.9906, elevM: -11, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-union-sq-456', elevM: -11 },
    { lat: 40.7364, lon: -73.9896, elevM: -11, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-23st-6', elevM: -12 },
    { stationId: 'mta-33st-6', elevM: -12 },
    { stationId: 'mta-grand-central-456', elevM: -12 },
    { stationId: 'mta-51st-6', elevM: -12 },
    { stationId: 'mta-59st-456', elevM: -11 },
    { stationId: 'mta-86st-456', elevM: -11 },
    { stationId: 'mta-125st-456', elevM: -11 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: '4/5/6', routes: ['4', '5', '6'], serviceType: 'LOCAL', color: '#00933C', waypoints: lexLocalWps },
      'mta-456-local',
      'Lexington Ave Local',
      'UPTOWN',
      'DOWNTOWN',
      2,
      -2,
      stationById,
    ),
  );

  const lexExpressWps: WaypointSpec[] = [
    { stationId: 'mta-atlantic-barclays', elevM: -27 },
    { stationId: 'mta-borough-hall', elevM: -27 },
    { lat: 40.6990, lon: -74.0035, elevM: -37, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-bowling-green', elevM: -24 },
    { stationId: 'mta-wall-st-45', elevM: -24 },
    { stationId: 'mta-fulton-45', elevM: -24 },
    { stationId: 'mta-bklyn-bridge-city-hall', elevM: -24 },
    { lat: 40.7259, lon: -73.9947, elevM: -21, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7318, lon: -73.9906, elevM: -20, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-union-sq-456', elevM: -20 },
    { lat: 40.7364, lon: -73.9896, elevM: -20, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-grand-central-456', elevM: -20 },
    { stationId: 'mta-59st-456', elevM: -20 },
    { stationId: 'mta-86st-456', elevM: -20 },
    { stationId: 'mta-125st-456', elevM: -20 },
    { lat: 40.8086, lon: -73.9337, elevM: -28, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-138st-gc', elevM: -14 },
    { lat: 40.8205, lon: -73.9278, elevM: 2, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-161st-yankee', elevM: 12 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: '4/5/6', routes: ['4', '5'], serviceType: 'EXPRESS', color: '#00933C', waypoints: lexExpressWps },
      'mta-456-express',
      'Lexington Ave Express',
      'UPTOWN',
      'DOWNTOWN',
      2,
      -2,
      stationById,
    ),
  );

  // =========================================================================
  // 3. MTA 7 — IRT Flushing (#B933AD)
  // =========================================================================
  const flushing7Wps: WaypointSpec[] = [
    { stationId: 'mta-hudson-yards-7', elevM: -34 },
    { stationId: 'mta-times-sq-7', elevM: -28 },
    { stationId: 'mta-5ave-bryant-7', elevM: -28 },
    { stationId: 'mta-grand-central-7', elevM: -28 },
    { lat: 40.7470, lon: -73.9648, elevM: -34, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-vernon-jackson-7', elevM: -14 },
    { stationId: 'mta-hunters-pt-7', elevM: -10 },
    { lat: 40.7445, lon: -73.9470, elevM: 2, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-court-sq-7', elevM: 12 },
    { stationId: 'mta-queensboro-plaza-7', elevM: 16 },
    { stationId: 'mta-woodside-61-7', elevM: 15 },
    { stationId: 'mta-junction-blvd-7', elevM: 14 },
    { lat: 40.7550, lon: -73.8450, elevM: 2, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-flushing-main-7', elevM: -10 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: '7', routes: ['7'], serviceType: 'LOCAL', color: '#B933AD', waypoints: flushing7Wps },
      'mta-7-local',
      'Flushing Line',
      'OUTBOUND',
      'INBOUND',
      2,
      -2,
      stationById,
    ),
  );

  // =========================================================================
  // 4. MTA A/C/E — IND 8th Ave (#0039A6)
  //    4-track lateral offsets: [-6, -2, +2, +6]m
  // =========================================================================
  const ind8ExpressWps: WaypointSpec[] = [
    { stationId: 'mta-jay-st-metrotech', elevM: -12 },
    { stationId: 'mta-high-st-ac', elevM: -18 },
    { lat: 40.7048, lon: -73.9985, elevM: -30, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-fulton-ac', elevM: -12 },
    { stationId: 'mta-chambers-wtc-ace', elevM: -12 },
    { stationId: 'mta-canal-ace', elevM: -11 },
    { stationId: 'mta-w4st-ace', elevM: -11 },
    { stationId: 'mta-14st-ace', elevM: -11 },
    { stationId: 'mta-34st-penn-ace', elevM: -11 },
    { stationId: 'mta-42st-pabt-ace', elevM: -11 },
    { stationId: 'mta-59st-columbus-ac', elevM: -11 },
    { stationId: 'mta-125st-ac', elevM: -12 },
    { stationId: 'mta-145st-ac', elevM: -14 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'A/C/E', routes: ['A'], serviceType: 'EXPRESS', color: '#0039A6', waypoints: ind8ExpressWps },
      'mta-ace-express',
      '8th Ave Express',
      'UPTOWN',
      'DOWNTOWN',
      2,
      -2,
      stationById,
    ),
  );

  const ind8LocalWps: WaypointSpec[] = [
    { stationId: 'mta-jay-st-metrotech', elevM: -12 },
    { stationId: 'mta-high-st-ac', elevM: -18 },
    { lat: 40.7048, lon: -73.9985, elevM: -30, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-fulton-ac', elevM: -12 },
    { stationId: 'mta-chambers-wtc-ace', elevM: -12 },
    { stationId: 'mta-canal-ace', elevM: -11 },
    { stationId: 'mta-spring-ce', elevM: -11 },
    { stationId: 'mta-w4st-ace', elevM: -11 },
    { stationId: 'mta-14st-ace', elevM: -11 },
    { stationId: 'mta-23st-ce', elevM: -11 },
    { stationId: 'mta-34st-penn-ace', elevM: -11 },
    { stationId: 'mta-42st-pabt-ace', elevM: -11 },
    { stationId: 'mta-50st-ce', elevM: -11 },
    { stationId: 'mta-59st-columbus-ac', elevM: -11 },
    { stationId: 'mta-72st-c', elevM: -11 },
    { stationId: 'mta-81st-museum', elevM: -11 },
    { stationId: 'mta-125st-ac', elevM: -12 },
    { stationId: 'mta-145st-ac', elevM: -14 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'A/C/E', routes: ['A', 'C'], serviceType: 'LOCAL', color: '#0039A6', waypoints: ind8LocalWps },
      'mta-ace-local',
      '8th Ave Local',
      'UPTOWN',
      'DOWNTOWN',
      6,
      -6,
      stationById,
    ),
  );

  const indEQueensWps: WaypointSpec[] = [
    { stationId: 'mta-chambers-wtc-ace', elevM: -12 },
    { stationId: 'mta-canal-ace', elevM: -11 },
    { stationId: 'mta-spring-ce', elevM: -11 },
    { stationId: 'mta-w4st-ace', elevM: -11 },
    { stationId: 'mta-14st-ace', elevM: -11 },
    { stationId: 'mta-23st-ce', elevM: -11 },
    { stationId: 'mta-34st-penn-ace', elevM: -11 },
    { stationId: 'mta-42st-pabt-ace', elevM: -11 },
    { stationId: 'mta-50st-ce', elevM: -20 },
    { lat: 40.7632, lon: -73.9848, elevM: -28, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-5ave-53-em', elevM: -28 },
    { stationId: 'mta-lex-53-em', elevM: -28 },
    { lat: 40.7528, lon: -73.9575, elevM: -32, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-court-sq-23-em', elevM: -14 },
    { stationId: 'mta-jackson-hts-roosevelt', elevM: -14 },
    { stationId: 'mta-forest-hills-71', elevM: -14 },
    { stationId: 'mta-jamaica-center', elevM: -16 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'A/C/E', routes: ['E'], serviceType: 'LOCAL', color: '#0039A6', waypoints: indEQueensWps },
      'mta-e-queens',
      '8th Ave / 53rd St / Queens Blvd',
      'UPTOWN',
      'DOWNTOWN',
      4,
      -4,
      stationById,
    ),
  );

  // =========================================================================
  // 5. MTA B/D/F/M — IND 6th Ave (#FF6319)
  // =========================================================================
  const ind6ExpressWps: WaypointSpec[] = [
    { stationId: 'mta-dekalb-ave', elevM: -14 },
    { lat: 40.6975, lon: -73.9856, elevM: 6, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { lat: 40.7015, lon: -73.9875, elevM: 40, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.7073, lon: -73.9900, elevM: 42, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.7134, lon: -73.9926, elevM: 40, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.7158, lon: -73.9933, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-grand-st-bd', elevM: -17 },
    { stationId: 'mta-bway-lafayette', elevM: -28 },
    { stationId: 'mta-w4st-bdfm', elevM: -22 },
    { stationId: 'mta-herald-sq-bdfm', elevM: -22 },
    { stationId: 'mta-bryant-park-bdfm', elevM: -22 },
    { stationId: 'mta-rockefeller-bdfm', elevM: -22 },
    { stationId: 'mta-7ave-bd', elevM: -22 },
    { stationId: 'mta-59st-columbus-ac', elevM: -22 },
    { stationId: 'mta-125st-ac', elevM: -23.5 },
    { stationId: 'mta-145st-ac', elevM: -23.5 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'B/D/F/M', routes: ['B', 'D'], serviceType: 'EXPRESS', color: '#FF6319', waypoints: ind6ExpressWps },
      'mta-bdfm-express',
      '6th Ave Express (Manhattan Bridge North)',
      'UPTOWN',
      'DOWNTOWN',
      2,
      -2,
      stationById,
    ),
  );

  const ind6LocalWps: WaypointSpec[] = [
    { stationId: 'mta-jay-st-metrotech', elevM: -22 },
    { stationId: 'mta-york-st-f', elevM: -22 },
    { lat: 40.7075, lon: -73.9885, elevM: -30, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-east-broadway-f', elevM: -25 },
    { stationId: 'mta-delancey-f', elevM: -25 },
    { stationId: 'mta-bway-lafayette', elevM: -27 },
    { stationId: 'mta-w4st-bdfm', elevM: -22 },
    { stationId: 'mta-14st-fm', elevM: -21 },
    { stationId: 'mta-23st-fm', elevM: -21 },
    { stationId: 'mta-herald-sq-bdfm', elevM: -22 },
    { stationId: 'mta-bryant-park-bdfm', elevM: -22 },
    { stationId: 'mta-rockefeller-bdfm', elevM: -22 },
    { stationId: 'mta-57st-f', elevM: -24 },
    { stationId: 'mta-lex-63-f', elevM: -38 },
    { lat: 40.7618, lon: -73.9590, elevM: -36, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-roosevelt-island', elevM: -26 },
    { lat: 40.7565, lon: -73.9480, elevM: -34, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-21st-queensbridge', elevM: -15 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'B/D/F/M', routes: ['D', 'F', 'M'], serviceType: 'LOCAL', color: '#FF6319', waypoints: ind6LocalWps },
      'mta-bdfm-local',
      '6th Ave Local (63rd St)',
      'UPTOWN',
      'DOWNTOWN',
      6,
      -6,
      stationById,
    ),
  );

  // =========================================================================
  // 6. MTA N/Q/R/W — BMT Broadway (#FCCC0A)
  // =========================================================================
  const bmtQExpressWps: WaypointSpec[] = [
    { stationId: 'mta-church-ave-q', elevM: -6, structure: 'OPEN_CUT', gpsVisibility: 'OPEN_SKY' },
    { stationId: 'mta-prospect-park-q', elevM: -6, structure: 'OPEN_CUT', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.6730, lon: -73.9700, elevM: -10, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-atlantic-barclays', elevM: -14 },
    { stationId: 'mta-dekalb-ave', elevM: -14 },
    { lat: 40.6975, lon: -73.9870, elevM: 6, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { lat: 40.7015, lon: -73.9890, elevM: 40, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.7073, lon: -73.9915, elevM: 42, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.7134, lon: -73.9942, elevM: 40, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.7165, lon: -73.9962, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { lat: 40.7182, lon: -73.9985, elevM: -17, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-canal-nqrw', elevM: -17 },
    { stationId: 'mta-union-sq-nqrw', elevM: -18 },
    { stationId: 'mta-herald-sq-nqrw', elevM: -10 },
    { stationId: 'mta-times-sq-nqrw', elevM: -10 },
    { stationId: 'mta-57st-7ave-nqrw', elevM: -10 },
    { lat: 40.7678, lon: -73.9780, elevM: -24, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-lex-63-q', elevM: -30 },
    { stationId: 'mta-72st-q', elevM: -26 },
    { stationId: 'mta-86st-q', elevM: -26 },
    { stationId: 'mta-96st-q', elevM: -24 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'N/Q/R/W', routes: ['N', 'Q'], serviceType: 'EXPRESS', color: '#FCCC0A', waypoints: bmtQExpressWps },
      'mta-nqrw-express',
      'Broadway Express (Manhattan Bridge South)',
      'UPTOWN',
      'DOWNTOWN',
      -18,
      -14,
      stationById,
    ),
  );

  const bmtRWLocalWps: WaypointSpec[] = [
    { stationId: 'mta-court-st-r', elevM: -20 },
    { lat: 40.6986, lon: -74.0025, elevM: -29, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-whitehall-rw', elevM: -6 },
    { stationId: 'mta-cortlandt-rw', elevM: -6 },
    { stationId: 'mta-city-hall-rw', elevM: -6 },
    { stationId: 'mta-canal-nqrw', elevM: -17 },
    { stationId: 'mta-union-sq-nqrw', elevM: -18 },
    { stationId: 'mta-23st-rw', elevM: -12 },
    { stationId: 'mta-herald-sq-nqrw', elevM: -10 },
    { stationId: 'mta-times-sq-nqrw', elevM: -10 },
    { stationId: 'mta-49st-rw', elevM: -10 },
    { stationId: 'mta-57st-7ave-nqrw', elevM: -10 },
    { stationId: 'mta-5ave-59-nrw', elevM: -16 },
    { stationId: 'mta-lex-59-nrw', elevM: -30 },
    { lat: 40.7570, lon: -73.9540, elevM: -32, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7525, lon: -73.9440, elevM: 2, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-queensboro-plaza-nw', elevM: 11 },
    { stationId: 'mta-astoria-ditmars', elevM: 12 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'N/Q/R/W', routes: ['N', 'Q', 'R', 'W'], serviceType: 'LOCAL', color: '#FCCC0A', waypoints: bmtRWLocalWps },
      'mta-nqrw-local',
      'Broadway Local (Astoria)',
      'UPTOWN',
      'DOWNTOWN',
      6,
      -6,
      stationById,
    ),
  );

  // =========================================================================
  // 7. MTA L — BMT Canarsie (#A7A9AC)
  // =========================================================================
  const canarsieLWps: WaypointSpec[] = [
    { stationId: 'mta-8ave-14-l', elevM: -27 },
    { stationId: 'mta-6ave-14-l', elevM: -27 },
    { stationId: 'mta-union-sq-l', elevM: -27 },
    { stationId: 'mta-1ave-14-l', elevM: -27 },
    { lat: 40.7240, lon: -73.9690, elevM: -31, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'mta-bedford-ave-l', elevM: -14 },
    { stationId: 'mta-lorimer-l', elevM: -14 },
    { stationId: 'mta-myrtle-wyckoff-l', elevM: -12 },
    { lat: 40.6880, lon: -73.9065, elevM: 2, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-broadway-jct-l', elevM: 12 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'L', routes: ['L'], serviceType: 'LOCAL', color: '#A7A9AC', waypoints: canarsieLWps },
      'mta-l-local',
      'Canarsie Line',
      'OUTBOUND',
      'INBOUND',
      2,
      -2,
      stationById,
    ),
  );

  // =========================================================================
  // 8. MTA G — IND Crosstown (#6CBE45)
  // =========================================================================
  const crosstownGWps: WaypointSpec[] = [
    { stationId: 'mta-court-sq-g', elevM: -14 },
    { stationId: 'mta-greenpoint-g', elevM: -14 },
    { stationId: 'mta-metropolitan-g', elevM: -21 },
    { stationId: 'mta-hoyt-schermerhorn-g', elevM: -21 },
    { lat: 40.6805, lon: -73.9910, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-smith-9th-g', elevM: 27 },
    { lat: 40.6600, lon: -73.9880, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mta-church-ave-g', elevM: -12 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'G', routes: ['G'], serviceType: 'LOCAL', color: '#6CBE45', waypoints: crosstownGWps },
      'mta-g-local',
      'Crosstown Line',
      'DOWNTOWN',
      'UPTOWN',
      2,
      -2,
      stationById,
    ),
  );

  // =========================================================================
  // 9. MTA J/Z — BMT Nassau (#996633)
  // =========================================================================
  const nassauJZWps: WaypointSpec[] = [
    { stationId: 'mta-broad-st-jz', elevM: -29 },
    { stationId: 'mta-fulton-jz', elevM: -29 },
    { stationId: 'mta-chambers-jz', elevM: -29 },
    { stationId: 'mta-essex-st-jz', elevM: -10 },
    { lat: 40.7172, lon: -73.9845, elevM: 8, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { lat: 40.7138, lon: -73.9725, elevM: 41, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { lat: 40.7104, lon: -73.9625, elevM: 36, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { stationId: 'mta-marcy-ave-jz', elevM: 12 },
    { stationId: 'mta-myrtle-ave-jz', elevM: 12 },
    { stationId: 'mta-broadway-jct-jz', elevM: 18 },
    { lat: 40.6910, lon: -73.8500, elevM: 8, structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY' },
    { stationId: 'mta-jamaica-center', elevM: -22 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MTA', trunk: 'J/Z', routes: ['J', 'Z'], serviceType: 'LOCAL', color: '#996633', waypoints: nassauJZWps },
      'mta-jz-local',
      'Nassau St / Jamaica Line',
      'OUTBOUND',
      'INBOUND',
      2,
      -2,
      stationById,
    ),
  );

  // =========================================================================
  // 10. REGIONAL — LIRR (#006EC7)
  // =========================================================================
  const lirrMainWps: WaypointSpec[] = [
    { stationId: 'lirr-penn-station', elevM: -30 },
    { lat: 40.7485, lon: -73.9800, elevM: -34, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7475, lon: -73.9625, elevM: -42, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7472, lon: -73.9360, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'lirr-woodside', elevM: 8 },
    { stationId: 'lirr-jamaica', elevM: 8 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'LIRR', trunk: 'LIRR-MAIN', routes: ['LIRR-MAIN'], serviceType: 'COMMUTER', color: '#006EC7', waypoints: lirrMainWps },
      'lirr-main',
      'LIRR Main Line (Penn–Jamaica)',
      'OUTBOUND',
      'INBOUND',
      3,
      -3,
      stationById,
    ),
  );

  const lirrGcmWps: WaypointSpec[] = [
    { stationId: 'lirr-gcm', elevM: -48 },
    { lat: 40.7646, lon: -73.9661, elevM: -46, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7595, lon: -73.9540, elevM: -46, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7535, lon: -73.9400, elevM: -46, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7490, lon: -73.9280, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'lirr-woodside', elevM: 8 },
    { stationId: 'lirr-jamaica', elevM: 8 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'LIRR', trunk: 'LIRR-MAIN', routes: ['LIRR-GCM'], serviceType: 'COMMUTER', color: '#006EC7', waypoints: lirrGcmWps },
      'lirr-gcm',
      'LIRR Grand Central Madison',
      'OUTBOUND',
      'INBOUND',
      11,
      7,
      stationById,
    ),
  );

  const lirrAtlWps: WaypointSpec[] = [
    { stationId: 'lirr-atlantic-terminal', elevM: -8 },
    { lat: 40.6780, lon: -73.9250, elevM: -8, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.6840, lon: -73.8750, elevM: 6, structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY' },
    { stationId: 'lirr-jamaica', elevM: 8 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'LIRR', trunk: 'LIRR-ATL', routes: ['LIRR-ATL'], serviceType: 'COMMUTER', color: '#006EC7', waypoints: lirrAtlWps },
      'lirr-atl',
      'LIRR Atlantic Branch',
      'OUTBOUND',
      'INBOUND',
      3,
      -3,
      stationById,
    ),
  );

  // =========================================================================
  // 11. REGIONAL — MNR Metro-North (#0052A5)
  // =========================================================================
  const mnrHarlemWps: WaypointSpec[] = [
    { stationId: 'mnr-grand-central', elevM: -8 },
    { lat: 40.7865, lon: -73.9522, elevM: -6, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7895, lon: -73.9501, elevM: 4, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'mnr-harlem-125', elevM: 10 },
    { lat: 40.8120, lon: -73.9345, elevM: 12, structure: 'BRIDGE', gpsVisibility: 'OPEN_SKY' },
    { stationId: 'mnr-melrose', elevM: 6 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'MNR', trunk: 'MNR-HARLEM', routes: ['MNR-HARLEM'], serviceType: 'COMMUTER', color: '#0052A5', waypoints: mnrHarlemWps },
      'mnr-harlem',
      'Metro-North Park Ave / Harlem Line',
      'OUTBOUND',
      'INBOUND',
      3,
      -3,
      stationById,
    ),
  );

  // =========================================================================
  // 12. REGIONAL — PATH (#D93A30)
  // =========================================================================
  const pathHobWps: WaypointSpec[] = [
    { stationId: 'path-33st', elevM: -14 },
    { stationId: 'path-14st', elevM: -14 },
    { lat: 40.7342, lon: -73.9997, elevM: -14, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7336, lon: -74.0006, elevM: -24, structure: 'UNDERGROUND_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'path-christopher', elevM: -24 },
    { lat: 40.7338, lon: -74.0185, elevM: -32, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'path-hoboken', elevM: -6 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'PATH', trunk: 'PATH-HOB', routes: ['PATH-HOB'], serviceType: 'COMMUTER', color: '#D93A30', waypoints: pathHobWps },
      'path-hob',
      'PATH 33rd St–Hoboken',
      'OUTBOUND',
      'INBOUND',
      2.5,
      -2.5,
      stationById,
    ),
  );

  const pathNwkWps: WaypointSpec[] = [
    { stationId: 'path-wtc', elevM: -22 },
    { lat: 40.7145, lon: -74.0220, elevM: -32, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { stationId: 'path-exchange-pl', elevM: -18 },
    { stationId: 'path-journal-sq', elevM: -4 },
    { lat: 40.7346, lon: -74.1120, elevM: 11, structure: 'ELEVATED', gpsVisibility: 'OPEN_SKY' },
    { stationId: 'path-newark-penn', elevM: 11 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'PATH', trunk: 'PATH-NWK', routes: ['PATH-NWK'], serviceType: 'COMMUTER', color: '#D93A30', waypoints: pathNwkWps },
      'path-nwk',
      'PATH WTC–Newark',
      'OUTBOUND',
      'INBOUND',
      2.5,
      -2.5,
      stationById,
    ),
  );

  // =========================================================================
  // 13. REGIONAL — NJT (#F7931E)
  // =========================================================================
  const njtNecWps: WaypointSpec[] = [
    { stationId: 'njt-penn-station', elevM: -30 },
    { lat: 40.7545, lon: -74.0110, elevM: -34, structure: 'UNDERWATER_TUNNEL', gpsVisibility: 'UNDERGROUND' },
    { lat: 40.7590, lon: -74.0420, elevM: 2, structure: 'OPEN_CUT', gpsVisibility: 'PORTAL' },
    { stationId: 'njt-secaucus', elevM: 4 },
    { stationId: 'njt-newark-penn', elevM: 6 },
    { stationId: 'njt-ewr-station', elevM: 4 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'NJT', trunk: 'NJT-NEC', routes: ['NJT-NEC'], serviceType: 'COMMUTER', color: '#F7931E', waypoints: njtNecWps },
      'njt-nec',
      'NJ Transit Northeast Corridor',
      'OUTBOUND',
      'INBOUND',
      3,
      -3,
      stationById,
    ),
  );

  // =========================================================================
  // 14. REGIONAL — AIRTRAIN (#00A1DE)
  // =========================================================================
  const airtrainJfkWps: WaypointSpec[] = [
    { stationId: 'airtrain-jfk-jamaica', elevM: 14 },
    { stationId: 'airtrain-jfk-federal', elevM: 12 },
    { stationId: 'airtrain-jfk-t4', elevM: 12 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'AIRTRAIN', trunk: 'AIRTRAIN-JFK', routes: ['AIRTRAIN-JFK'], serviceType: 'COMMUTER', color: '#00A1DE', waypoints: airtrainJfkWps },
      'airtrain-jfk',
      'AirTrain JFK',
      'OUTBOUND',
      'INBOUND',
      2.5,
      -2.5,
      stationById,
    ),
  );

  const airtrainEwrWps: WaypointSpec[] = [
    { stationId: 'airtrain-ewr-station', elevM: 10 },
    { stationId: 'airtrain-ewr-tc', elevM: 10 },
  ];

  tracks.push(
    ...makeBidirectionalPair(
      { system: 'AIRTRAIN', trunk: 'AIRTRAIN-EWR', routes: ['AIRTRAIN-EWR'], serviceType: 'COMMUTER', color: '#00A1DE', waypoints: airtrainEwrWps },
      'airtrain-ewr',
      'AirTrain Newark',
      'OUTBOUND',
      'INBOUND',
      2.5,
      -2.5,
      stationById,
    ),
  );

  return tracks;
}
