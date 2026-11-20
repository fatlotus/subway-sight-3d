import type { Vec3 } from './transit';

export type SensorMode = 'live' | 'sim' | 'replay';

export type DemoScenarioId =
  | 'manhattan-bridge'
  | 'express-overtake'
  | 'lexington-underground'
  | 'steinway-queens'
  | 'midtown-multi-system';

export type GpsStatus = 'locked' | 'stale' | 'lost' | 'denied' | 'simulated';
export type DrStatus = 'active' | 'standby' | 'unavailable' | 'simulated';
export type TimingStatus = 'active' | 'degraded';

export interface SensorStatus {
  gps: GpsStatus;
  dr: DrStatus;
  timing: TimingStatus;
}

export interface GpsSample {
  lat: number;
  lon: number;
  accuracyM: number;
  speedMps?: number;
  headingDeg?: number;
  fixAgeMs: number;
}

export interface ImuSample {
  /** Linear acceleration excluding gravity [x, y, z] in m/s^2 (device frame). */
  accelLin: Vec3;
  /** Acceleration including gravity [x, y, z] in m/s^2 (device frame). */
  accelGrav: Vec3;
  /** Angular velocity [alpha, beta, gamma] in rad/s. */
  gyroRadS: Vec3;
}

export interface OrientationSample {
  alpha: number;
  beta: number;
  gamma: number;
  compassDeg?: number;
}

export interface SensorSample {
  tMs: number;
  gps?: GpsSample;
  /** GeolocationPositionError code: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT. */
  gpsErrorCode?: 1 | 2 | 3;
  imu?: ImuSample;
  orientation?: OrientationSample;
}

export interface SensorSource {
  readonly mode: SensorMode;
  start(): void;
  stop(): void;
  onSample(cb: (sample: SensorSample) => void): () => void;
  setScenario?(id: DemoScenarioId): void;
  setPaused?(paused: boolean): void;
  setSpeedMultiplier?(mult: 1 | 2 | 5): void;
}
