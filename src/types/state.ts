import type { DemoScenarioId, SensorMode, SensorStatus } from './sensors';
import type { RailSystem, StructureType, Vec3 } from './transit';

export type ServiceType = 'EXPRESS' | 'LOCAL' | 'COMMUTER' | 'UNKNOWN';
export type TravelDirection = 'UPTOWN' | 'DOWNTOWN' | 'OUTBOUND' | 'INBOUND' | 'UNKNOWN';
export type ViewMode = 'inside' | 'ghost' | 'chase';

export interface RouteCandidate {
  routeId: string;
  serviceType: string;
  direction: string;
  probability: number;
}

export interface EstimatorState {
  routeId: string | null;
  serviceType: ServiceType;
  direction: TravelDirection;
  displayLabel: string;
  confidencePct: number;
  candidates: RouteCandidate[];
  currentStationId: string | null;
  currentStationName: string;
  nextStationId: string | null;
  nextStationName: string;
  etaSec: number | null;
  positionEnu: Vec3;
  positionLatLng: { lat: number; lon: number };
  headingRad: number;
  pitchRad: number;
  speedMps: number;
  speedMph: number;
  elevationM: number;
  elevationFt: number;
  structure: StructureType;
  outOfNyc: boolean;
  manualAnchorActive: boolean;
  sensorStatus: SensorStatus;
  /** Optional track-space metadata for traffic & renderer continuity. */
  trackId?: string | null;
  trackS?: number;
  system?: RailSystem;
  routeColor?: string;
}

export interface EgoConsistCar {
  carIndex: number;
  enu: Vec3;
  headingRad: number;
  pitchRad: number;
  lengthM: number;
  widthM: number;
}

export interface NearbyTrainCar {
  enu: Vec3;
  headingRad: number;
  pitchRad: number;
}

export interface NearbyTrain {
  id: string;
  system: RailSystem;
  routeId: string;
  color: string;
  distanceM: number;
  enu: Vec3;
  headingRad: number;
  pitchRad: number;
  carCount: number;
  carLengthM: number;
  carWidthM: number;
  cars: NearbyTrainCar[];
}

export interface NearbyLandmark {
  id: string;
  name: string;
  kind: 'river' | 'bridge';
  distanceM: number;
  relativeElevationFt: number;
}

export interface WorldStateSnapshot {
  timestampMs: number;
  mode: SensorMode;
  scenarioId?: DemoScenarioId;
  ego: EstimatorState;
  egoConsist: EgoConsistCar[];
  nearbyTrains: NearbyTrain[];
  nearbyLandmarks: NearbyLandmark[];
}

export interface DebugSnapshot {
  camera: {
    yaw: number;
    pitch: number;
    position: Vec3;
    viewMode: ViewMode;
  };
  estimate: {
    line: string | null;
    serviceType: ServiceType;
    direction: TravelDirection;
    confidence: number;
    stationId: string | null;
    nextStationId: string | null;
    elevationFt: number;
    speedMph: number;
    outOfNyc: boolean;
  };
  sensorStatus: SensorStatus;
  visibleLandmarks: string[];
  visibleSystems: string[];
  nearbyTrainCount: number;
  drawCalls: number;
  frameCount: number;
  mode: SensorMode;
}

declare global {
  interface Window {
    __SUBWAY_VISION_STATE__?: DebugSnapshot;
  }
}
