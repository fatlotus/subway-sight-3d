import type {
  GpsSample,
  ImuSample,
  OrientationSample,
  SensorSample,
  SensorSource,
} from '../types/sensors';

export type MotionPermissionResult = 'granted' | 'denied' | 'unsupported';

export interface LiveSensorOptions {
  enableHighAccuracy?: boolean;
  maximumAgeMs?: number;
  timeoutMs?: number;
}

interface IosPermissionEventCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

interface WebKitDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

const DEG_TO_RAD = Math.PI / 180;

function finiteOrZero(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function mapGeolocationErrorCode(code: number | undefined): 1 | 2 | 3 {
  if (code === 1) return 1;
  if (code === 3) return 3;
  return 2;
}

/**
 * Live browser sensor source wrapping Geolocation, DeviceMotion, and DeviceOrientation.
 * iOS 13+ motion/orientation permission requests are NEVER called in constructor() or start();
 * callers must invoke requestPermission() / requestMotionPermission() from a user gesture.
 */
export class LiveSensorSource implements SensorSource {
  readonly mode = 'live' as const;

  private readonly options: Required<LiveSensorOptions>;
  private readonly listeners = new Set<(sample: SensorSample) => void>();
  private running = false;
  private watchId: number | null = null;
  private motionAttached = false;
  private orientationAttached = false;

  constructor(options?: LiveSensorOptions) {
    this.options = {
      enableHighAccuracy: options?.enableHighAccuracy ?? true,
      maximumAgeMs: options?.maximumAgeMs ?? 2_000,
      timeoutMs: options?.timeoutMs ?? 10_000,
    };
  }

  onSample(cb: (sample: SensorSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.startGeolocation();
    this.attachMotionListeners();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (
      this.watchId !== null &&
      typeof navigator !== 'undefined' &&
      navigator.geolocation &&
      typeof navigator.geolocation.clearWatch === 'function'
    ) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;

    this.detachMotionListeners();
  }

  /**
   * iOS 13+ user-gesture permission helper for DeviceMotionEvent & DeviceOrientationEvent.
   * Safe to call on Android/desktop/Node where requestPermission is not defined.
   */
  async requestMotionPermission(): Promise<MotionPermissionResult> {
    if (typeof window === 'undefined') {
      return 'unsupported';
    }

    const motionCtor = (
      globalThis as unknown as { DeviceMotionEvent?: IosPermissionEventCtor }
    ).DeviceMotionEvent;
    const orientCtor = (
      globalThis as unknown as { DeviceOrientationEvent?: IosPermissionEventCtor }
    ).DeviceOrientationEvent;

    const hasMotionReq = typeof motionCtor?.requestPermission === 'function';
    const hasOrientReq = typeof orientCtor?.requestPermission === 'function';

    if (!hasMotionReq && !hasOrientReq) {
      if (this.running) {
        this.attachMotionListeners();
      }
      return 'granted';
    }

    try {
      let granted = true;
      if (hasMotionReq && motionCtor?.requestPermission) {
        const res = await motionCtor.requestPermission();
        if (res !== 'granted') granted = false;
      }
      if (hasOrientReq && orientCtor?.requestPermission) {
        const res = await orientCtor.requestPermission();
        if (res !== 'granted') granted = false;
      }

      if (granted && this.running) {
        this.attachMotionListeners();
      }
      return granted ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }

  /** Alias for requestMotionPermission() for concise UI wiring. */
  async requestPermission(): Promise<MotionPermissionResult> {
    return this.requestMotionPermission();
  }

  private emit(sample: SensorSample): void {
    for (const cb of this.listeners) {
      cb(sample);
    }
  }

  private startGeolocation(): void {
    if (
      typeof navigator === 'undefined' ||
      !navigator.geolocation ||
      typeof navigator.geolocation.watchPosition !== 'function'
    ) {
      this.emit({
        tMs: Date.now(),
        gpsErrorCode: 2,
      });
      return;
    }

    try {
      this.watchId = navigator.geolocation.watchPosition(
        this.handleGeoSuccess,
        this.handleGeoError,
        {
          enableHighAccuracy: this.options.enableHighAccuracy,
          maximumAge: this.options.maximumAgeMs,
          timeout: this.options.timeoutMs,
        },
      );
    } catch {
      this.emit({
        tMs: Date.now(),
        gpsErrorCode: 2,
      });
    }
  }

  private attachMotionListeners(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }

    if (!this.motionAttached) {
      window.addEventListener('devicemotion', this.handleDeviceMotion as EventListener);
      this.motionAttached = true;
    }
    if (!this.orientationAttached) {
      window.addEventListener('deviceorientation', this.handleDeviceOrientation as EventListener);
      this.orientationAttached = true;
    }
  }

  private detachMotionListeners(): void {
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') {
      return;
    }

    if (this.motionAttached) {
      window.removeEventListener('devicemotion', this.handleDeviceMotion as EventListener);
      this.motionAttached = false;
    }
    if (this.orientationAttached) {
      window.removeEventListener('deviceorientation', this.handleDeviceOrientation as EventListener);
      this.orientationAttached = false;
    }
  }

  private readonly handleGeoSuccess = (pos: GeolocationPosition): void => {
    if (!this.running) return;
    const nowMs = Date.now();
    const { coords } = pos;

    if (
      !Number.isFinite(coords.latitude) ||
      !Number.isFinite(coords.longitude) ||
      !Number.isFinite(coords.accuracy)
    ) {
      return;
    }

    const fixAgeMs =
      typeof pos.timestamp === 'number' && Number.isFinite(pos.timestamp) && pos.timestamp > 0
        ? Math.max(0, Math.min(600_000, nowMs - pos.timestamp))
        : 0;

    const speedMps =
      typeof coords.speed === 'number' && Number.isFinite(coords.speed) && coords.speed >= 0
        ? coords.speed
        : undefined;

    const headingDeg =
      typeof coords.heading === 'number' && Number.isFinite(coords.heading)
        ? ((coords.heading % 360) + 360) % 360
        : undefined;

    const gps: GpsSample = {
      lat: coords.latitude,
      lon: coords.longitude,
      accuracyM: coords.accuracy,
      speedMps,
      headingDeg,
      fixAgeMs,
    };

    this.emit({
      tMs: nowMs,
      gps,
    });
  };

  private readonly handleGeoError = (err: GeolocationPositionError): void => {
    if (!this.running) return;
    this.emit({
      tMs: Date.now(),
      gpsErrorCode: mapGeolocationErrorCode(err?.code),
    });
  };

  private readonly handleDeviceMotion = (ev: DeviceMotionEvent): void => {
    if (!this.running) return;

    const acc = ev.acceleration;
    const accG = ev.accelerationIncludingGravity;
    const rot = ev.rotationRate;

    const isFin = (v: number | null | undefined): v is number =>
      typeof v === 'number' && Number.isFinite(v);

    const hasAcc =
      acc != null && (isFin(acc.x) || isFin(acc.y) || isFin(acc.z));
    const hasAccG =
      accG != null && (isFin(accG.x) || isFin(accG.y) || isFin(accG.z));
    const hasRot =
      rot != null && (isFin(rot.alpha) || isFin(rot.beta) || isFin(rot.gamma));

    if (!hasAcc && !hasAccG && !hasRot) {
      return;
    }

    // W3C DeviceMotionEvent.rotationRate: beta = X, gamma = Y, alpha = Z (deg/s -> rad/s)
    const imu: ImuSample = {
      accelLin: [
        finiteOrZero(acc?.x),
        finiteOrZero(acc?.y),
        finiteOrZero(acc?.z),
      ],
      accelGrav: [
        finiteOrZero(accG?.x),
        finiteOrZero(accG?.y),
        finiteOrZero(accG?.z),
      ],
      gyroRadS: [
        finiteOrZero(rot?.beta) * DEG_TO_RAD,
        finiteOrZero(rot?.gamma) * DEG_TO_RAD,
        finiteOrZero(rot?.alpha) * DEG_TO_RAD,
      ],
    };

    this.emit({
      tMs: Date.now(),
      imu,
    });
  };

  private readonly handleDeviceOrientation = (ev: DeviceOrientationEvent): void => {
    if (!this.running) return;
    const hasFiniteOrientation =
      (typeof ev.alpha === 'number' && Number.isFinite(ev.alpha)) ||
      (typeof ev.beta === 'number' && Number.isFinite(ev.beta)) ||
      (typeof ev.gamma === 'number' && Number.isFinite(ev.gamma));
    if (!hasFiniteOrientation) {
      return;
    }

    const wk = ev as WebKitDeviceOrientationEvent;
    let compassDeg: number | undefined;
    if (
      typeof wk.webkitCompassHeading === 'number' &&
      Number.isFinite(wk.webkitCompassHeading)
    ) {
      compassDeg = ((wk.webkitCompassHeading % 360) + 360) % 360;
    } else if (ev.absolute && typeof ev.alpha === 'number' && Number.isFinite(ev.alpha)) {
      compassDeg = ((360 - ev.alpha) % 360 + 360) % 360;
    }

    const orientation: OrientationSample = {
      alpha: finiteOrZero(ev.alpha),
      beta: finiteOrZero(ev.beta),
      gamma: finiteOrZero(ev.gamma),
      compassDeg,
    };

    this.emit({
      tMs: Date.now(),
      orientation,
    });
  };
}
