export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type RailSystem = 'MTA' | 'LIRR' | 'MNR' | 'PATH' | 'NJT' | 'AIRTRAIN';

export type StructureType =
  | 'UNDERGROUND_TUNNEL'
  | 'UNDERWATER_TUNNEL'
  | 'ELEVATED'
  | 'BRIDGE'
  | 'OPEN_CUT'
  | 'AT_GRADE'
  | 'STATION';

export type GpsVisibility = 'OPEN_SKY' | 'URBAN_CANYON' | 'PORTAL' | 'UNDERGROUND';

export type ServicePeriod =
  | 'WEEKDAY_AM_RUSH'
  | 'WEEKDAY_MIDDAY'
  | 'WEEKDAY_PM_RUSH'
  | 'WEEKDAY_EVENING'
  | 'WEEKEND_DAY'
  | 'LATE_NIGHT';

export type TrackServiceType = 'EXPRESS' | 'LOCAL' | 'COMMUTER';
export type TrackDirection = 'UPTOWN' | 'DOWNTOWN' | 'OUTBOUND' | 'INBOUND';
export type BoroughName = 'Manhattan' | 'Brooklyn' | 'Queens' | 'Bronx' | 'New Jersey';

export type WaterLandmarkId =
  | 'east-river'
  | 'hudson-river'
  | 'harlem-river'
  | 'upper-bay';

export interface TrackPoint {
  /** Cumulative 3D arc-length along the track polyline in meters (monotonic >= 0). */
  s: number;
  lat: number;
  lon: number;
  /** Elevation in meters relative to Mean Sea Level / river surface (Y = 0). */
  elevM: number;
  /** Precomputed Midtown ENU coordinates [east, north, up] in meters. */
  enu: Vec3;
  structure: StructureType;
  gpsVisibility: GpsVisibility;
  /** Optional segment speed limit in m/s for kinematic clamping & traffic. */
  maxSpeedMps?: number;
}

export interface SampledTrackPoint {
  s: number;
  enu: Vec3;
  tangentEnu: Vec3;
  /** Compass heading in radians: 0 = North (+N), +PI/2 = East (+E). */
  headingRad: number;
  /** Vertical grade pitch in radians (positive = ascending). */
  pitchRad: number;
  /** Signed horizontal curvature dHeading/ds in rad/m (+ = right/CW turn, - = left/CCW turn). */
  curvature: number;
  structure: StructureType;
  gpsVisibility: GpsVisibility;
}

export interface Station {
  id: string;
  name: string;
  system: RailSystem;
  lat: number;
  lon: number;
  elevM: number;
  enu: Vec3;
  routes: string[];
  structure: StructureType;
  gpsVisibility: GpsVisibility;
  borough: BoroughName;
  isExpressStop?: boolean;
  isHub?: boolean;
}

export interface TrackStationRef {
  stationId: string;
  /** Arc-length along parent TrackPolyline in meters (strictly increasing). */
  s: number;
  platformSide?: 'LEFT' | 'RIGHT' | 'ISLAND';
}

export interface TrackPolyline {
  id: string;
  name: string;
  system: RailSystem;
  trunk: string;
  routes: string[];
  serviceType: TrackServiceType;
  direction: TrackDirection;
  /** Hex color string (e.g. '#0039A6'). */
  color: string;
  /** Lateral offset from trunk centerline in meters (e.g. -6, -2, +2, +6). */
  lateralOffsetM: number;
  /** Total 3D arc-length in meters. */
  totalLengthM: number;
  points: TrackPoint[];
  stations: TrackStationRef[];
}

export interface PeriodScheduleRule {
  active: boolean;
  serviceType: TrackServiceType;
  headwaySec: number;
  offsetSec: number;
  dwellSec: number;
  /** Optional local track override used during LATE_NIGHT (e.g. A, 2, 3, 4, 5, D, N, Q). */
  trackIdOverride?: string;
  runTimeMultiplier?: number;
}

export interface InterStationRunTime {
  fromStationId: string;
  toStationId: string;
  meanSec: number;
  stdSec: number;
  dwellSec: number;
  maxSpeedMps: number;
}

export interface RouteSchedule {
  id: string;
  routeId: string;
  system: RailSystem;
  trackId: string;
  lateNightTrackId?: string;
  color: string;
  serviceType: TrackServiceType;
  direction: TrackDirection;
  division: 'A' | 'B' | 'REGIONAL';
  carCount: number;
  carLengthM: number;
  carWidthM: number;
  periods: Record<ServicePeriod, PeriodScheduleRule>;
  runTimes: InterStationRunTime[];
}

export interface WaterBodyLandmark {
  id: WaterLandmarkId;
  name: string;
  elevationM: number;
  color: string;
  /** 2D polygon vertices [east, north] at Y = elevationM (0 m). */
  polygonEnu: Vec2[];
  /** Polyline centerline [east, north] for fast distance queries. */
  centerlineEnu: Vec2[];
  centroidEnu: Vec2;
}

export interface BoroughOutline {
  id: string;
  name: string;
  elevationM: number;
  color: string;
  outlineEnu: Vec2[];
  centroidEnu: Vec2;
}

export interface BridgeLandmark {
  id: string;
  name: string;
  riverId: WaterLandmarkId;
  deckElevationM: number;
  towerHeightM: number;
  widthM: number;
  color: string;
  spanEnu: [Vec2, Vec2];
  deckPointsEnu: Vec3[];
  towersEnu: Vec2[];
  centroidEnu: Vec2;
}

export interface LandmarkDataset {
  waterBodies: WaterBodyLandmark[];
  boroughs: BoroughOutline[];
  bridges: BridgeLandmark[];
}

export interface TransitDataset {
  stations: Station[];
  tracks: TrackPolyline[];
  schedules: RouteSchedule[];
  landmarks: LandmarkDataset;
  stationById: Map<string, Station>;
  trackById: Map<string, TrackPolyline>;
}
