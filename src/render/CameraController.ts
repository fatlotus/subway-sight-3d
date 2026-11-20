import * as THREE from 'three';
import type { ViewMode } from '../types/state';

export const EYE_HEIGHT_ABOVE_RAIL_M = 2.85;
export const DEFAULT_FOV_DEG = 68;
export const MIN_FOV_DEG = 45;
export const MAX_FOV_DEG = 90;
export const MAX_PITCH_RAD = (75 * Math.PI) / 180;

export const CHASE_BACK_M = 18;
export const CHASE_UP_M = 7.5;
export const CHASE_PITCH_BIAS_RAD = -0.14;

const DRAG_RAD_PER_PX = 0.0052;
const LOOK_DAMP_LAMBDA = 14;
const FOV_DAMP_LAMBDA = 14;
const GYRO_DAMP_LAMBDA = 16;

const DOUBLE_TAP_MAX_MS = 300;
const DOUBLE_TAP_MAX_MOVE_PX = 10;
const DOUBLE_TAP_MAX_DIST_PX = 30;

// Module-level scratch objects for pure math helpers (zero per-frame heap allocations)
const _scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _scratchScreenQuat = new THREE.Quaternion();
const _poseTrackQuat = new THREE.Quaternion();
const _poseUserQuat = new THREE.Quaternion();
const _poseYawQuat = new THREE.Quaternion();
const _poseChaseBiasQuat = new THREE.Quaternion();
const _poseOffsetVec = new THREE.Vector3();
const _debugLookQuat = new THREE.Quaternion();
const _debugEuler = new THREE.Euler(0, 0, 0, 'YXZ');

const _X_AXIS = new THREE.Vector3(1, 0, 0);
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _Z_AXIS = new THREE.Vector3(0, 0, 1);

/** -90 deg rotation around X so camera looks out the rear of the phone. */
const _Q_MINUS_HALF_PI_X = new THREE.Quaternion(
  -Math.SQRT1_2,
  0,
  0,
  Math.SQRT1_2,
);

function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function isFiniteQuaternion(q: THREE.Quaternion): boolean {
  return (
    Number.isFinite(q.x) &&
    Number.isFinite(q.y) &&
    Number.isFinite(q.z) &&
    Number.isFinite(q.w) &&
    q.lengthSq() > 1e-12
  );
}

/** Wrap yaw angle in radians into (-PI, PI]. */
export function wrapYawRad(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  let wrapped = Math.atan2(Math.sin(rad), Math.cos(rad));
  if (wrapped <= -Math.PI) {
    wrapped = Math.PI;
  }
  return wrapped === 0 ? 0 : wrapped;
}

/** Clamp pitch angle in radians into [-MAX_PITCH_RAD, +MAX_PITCH_RAD] (±75°). */
export function clampPitchRad(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  return Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, rad));
}

/** Clamp camera vertical FOV in degrees into [45, 90], falling back to 68. */
export function clampFovDeg(fov: number): number {
  if (!Number.isFinite(fov)) return DEFAULT_FOV_DEG;
  return Math.max(MIN_FOV_DEG, Math.min(MAX_FOV_DEG, fov));
}

/** Exponentially damped scalar interpolation (frame-rate independent). */
export function dampValue(
  current: number,
  target: number,
  lambda: number,
  dtSec: number,
): number {
  const c = finiteOr(current, 0);
  const t = finiteOr(target, c);
  const l = finiteOr(lambda, 0);
  const dt = finiteOr(dtSec, 0);
  if (dt <= 0 || l <= 0) return c;
  const alpha = 1 - Math.exp(-l * dt);
  return c + (t - c) * alpha;
}

/** Exponentially damped shortest-path angular interpolation in (-PI, PI]. */
export function dampAngleRad(
  current: number,
  target: number,
  lambda: number,
  dtSec: number,
): number {
  const c = wrapYawRad(current);
  const t = wrapYawRad(target);
  const l = finiteOr(lambda, 0);
  const dt = finiteOr(dtSec, 0);
  if (dt <= 0 || l <= 0) return c;
  const diff = wrapYawRad(t - c);
  const alpha = 1 - Math.exp(-l * dt);
  return wrapYawRad(c + diff * alpha);
}

/**
 * Compute Three.js orientation quaternion aligning -Z forward along
 * (headingRad, pitchRad) with zero roll.
 * headingRad = 0 -> North (-Z), +PI/2 -> East (+X).
 * pitchRad > 0 -> ascending (+Y).
 */
export function computeTrackQuaternion(
  headingRad: number,
  pitchRad: number,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const h = finiteOr(headingRad, 0);
  const p = finiteOr(pitchRad, 0);
  _scratchEuler.set(p, -h, 0, 'YXZ');
  out.setFromEuler(_scratchEuler);
  return out;
}

/** Compute user look-around quaternion in local car frame (YXZ, zero roll). */
export function computeUserLookQuaternion(
  userYawRad: number,
  userPitchRad: number,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const yaw = wrapYawRad(userYawRad);
  const pitch = clampPitchRad(userPitchRad);
  _scratchEuler.set(pitch, yaw, 0, 'YXZ');
  out.setFromEuler(_scratchEuler);
  return out;
}

/**
 * Convert W3C DeviceOrientation Euler angles (degrees) + screen orientation angle
 * into a normalized Three.js camera quaternion.
 */
export function computeDeviceOrientationQuaternion(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
  screenAngleDeg: number,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const alpha = THREE.MathUtils.degToRad(finiteOr(alphaDeg, 0));
  const beta = THREE.MathUtils.degToRad(finiteOr(betaDeg, 0));
  const gamma = THREE.MathUtils.degToRad(finiteOr(gammaDeg, 0));
  const orient = THREE.MathUtils.degToRad(finiteOr(screenAngleDeg, 0));

  _scratchEuler.set(beta, alpha, -gamma, 'YXZ');
  out.setFromEuler(_scratchEuler);
  out.multiply(_Q_MINUS_HALF_PI_X);
  _scratchScreenQuat.setFromAxisAngle(_Z_AXIS, -orient);
  out.multiply(_scratchScreenQuat);
  out.normalize();
  return out;
}

/**
 * Compute relative gyroscope rotation delta `baselineInvQuat * rawQuat`.
 * Left-multiplying by baseline inverse cancels any constant magnetic heading
 * offset (alpha_0) while preserving local pitch and relative yaw.
 */
export function computeRelativeGyroDelta(
  rawQuat: THREE.Quaternion,
  baselineInvQuat: THREE.Quaternion,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  if (!isFiniteQuaternion(rawQuat) || !isFiniteQuaternion(baselineInvQuat)) {
    return out.identity();
  }
  out.copy(baselineInvQuat).multiply(rawQuat).normalize();
  return out;
}

export interface CameraPoseInput {
  egoLocalPos: THREE.Vector3;
  headingRad: number;
  pitchRad: number;
  viewMode: ViewMode;
  userYawRad: number;
  userPitchRad: number;
  gyroEnabled?: boolean;
  gyroDeltaQuat?: THREE.Quaternion;
}

/**
 * Compute camera local position and world orientation for Inside, Ghost, or Chase view.
 * Writes directly into `outPos` and `outQuat` without allocating.
 */
export function computeCameraPose(
  input: CameraPoseInput,
  outPos: THREE.Vector3,
  outQuat: THREE.Quaternion,
): void {
  const ex = finiteOr(input.egoLocalPos.x, 0);
  const ey = finiteOr(input.egoLocalPos.y, 0);
  const ez = finiteOr(input.egoLocalPos.z, 0);

  computeTrackQuaternion(input.headingRad, input.pitchRad, _poseTrackQuat);
  computeUserLookQuaternion(input.userYawRad, input.userPitchRad, _poseUserQuat);

  outQuat.copy(_poseTrackQuat).multiply(_poseUserQuat);
  if (input.gyroEnabled && input.gyroDeltaQuat && isFiniteQuaternion(input.gyroDeltaQuat)) {
    outQuat.multiply(input.gyroDeltaQuat);
  }

  if (input.viewMode === 'chase') {
    _poseChaseBiasQuat.setFromAxisAngle(_X_AXIS, CHASE_PITCH_BIAS_RAD);
    outQuat.multiply(_poseChaseBiasQuat);

    // Orbit chase position around train using track orientation + user yaw
    _poseYawQuat.setFromAxisAngle(_Y_AXIS, wrapYawRad(input.userYawRad));
    _poseOffsetVec.set(0, CHASE_UP_M, CHASE_BACK_M);
    _poseOffsetVec.applyQuaternion(_poseYawQuat).applyQuaternion(_poseTrackQuat);
    outPos.set(ex + _poseOffsetVec.x, ey + _poseOffsetVec.y, ez + _poseOffsetVec.z);
  } else {
    // Eye-level mount inside car (used for both 'inside' and 'ghost')
    _poseOffsetVec.set(0, EYE_HEIGHT_ABOVE_RAIL_M, 0).applyQuaternion(_poseTrackQuat);
    outPos.set(ex + _poseOffsetVec.x, ey + _poseOffsetVec.y, ez + _poseOffsetVec.z);
  }

  outQuat.normalize();
}

interface PointerState {
  x: number;
  y: number;
  movedPx: number;
}

/**
 * First-person camera rig supporting Inside / Ghost / Chase modes,
 * touch/pointer drag look-around, pinch-zoom FOV, double-tap reset,
 * and track-anchored relative gyroscope look-around.
 */
export class CameraController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement | undefined;
  private readonly prevTouchAction: string;

  private viewMode: ViewMode = 'inside';
  private userYawRad = 0;
  private targetYawRad = 0;
  private userPitchRad = 0;
  private targetPitchRad = 0;
  private fovDeg = DEFAULT_FOV_DEG;
  private targetFovDeg = DEFAULT_FOV_DEG;

  private gyroEnabled = false;
  private hasGyroBaseline = false;
  private readonly gyroBaselineInvQuat = new THREE.Quaternion();
  private readonly gyroDeltaQuat = new THREE.Quaternion();
  private readonly gyroTargetDeltaQuat = new THREE.Quaternion();
  private readonly scratchRawGyroQuat = new THREE.Quaternion();

  private readonly activePointers = new Map<number, PointerState>();
  private lastPinchDist = 0;
  private lastTapTimeMs = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private disposed = false;

  private readonly poseInput: CameraPoseInput;

  constructor(camera: THREE.PerspectiveCamera, canvas?: HTMLCanvasElement) {
    this.camera = camera;
    this.canvas = canvas;
    this.prevTouchAction = canvas ? canvas.style.touchAction : '';

    this.camera.fov = DEFAULT_FOV_DEG;
    this.camera.updateProjectionMatrix();

    this.poseInput = {
      egoLocalPos: new THREE.Vector3(),
      headingRad: 0,
      pitchRad: 0,
      viewMode: this.viewMode,
      userYawRad: 0,
      userPitchRad: 0,
      gyroEnabled: false,
      gyroDeltaQuat: this.gyroDeltaQuat,
    };

    if (this.canvas) {
      this.canvas.style.touchAction = 'none';
      this.canvas.addEventListener('pointerdown', this.onPointerDown);
      this.canvas.addEventListener('pointermove', this.onPointerMove);
      this.canvas.addEventListener('pointerup', this.onPointerUp);
      this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    }
  }

  public setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
  }

  public getViewMode(): ViewMode {
    return this.viewMode;
  }

  public setGyroEnabled(enabled: boolean): void {
    this.gyroEnabled = Boolean(enabled);
    this.hasGyroBaseline = false;
    this.gyroDeltaQuat.identity();
    this.gyroTargetDeltaQuat.identity();
  }

  public isGyroEnabled(): boolean {
    return this.gyroEnabled;
  }

  public handleDeviceOrientation(
    alpha: number,
    beta: number,
    gamma: number,
    screenAngleDeg: number,
  ): void {
    if (
      !Number.isFinite(alpha) ||
      !Number.isFinite(beta) ||
      !Number.isFinite(gamma) ||
      !Number.isFinite(screenAngleDeg)
    ) {
      return;
    }

    computeDeviceOrientationQuaternion(
      alpha,
      beta,
      gamma,
      screenAngleDeg,
      this.scratchRawGyroQuat,
    );

    if (!this.hasGyroBaseline) {
      this.gyroBaselineInvQuat.copy(this.scratchRawGyroQuat).invert();
      this.hasGyroBaseline = true;
      this.gyroDeltaQuat.identity();
      this.gyroTargetDeltaQuat.identity();
      return;
    }

    computeRelativeGyroDelta(
      this.scratchRawGyroQuat,
      this.gyroBaselineInvQuat,
      this.gyroTargetDeltaQuat,
    );
  }

  public resetCameraView(): void {
    this.userYawRad = 0;
    this.targetYawRad = 0;
    this.userPitchRad = 0;
    this.targetPitchRad = 0;
    this.fovDeg = DEFAULT_FOV_DEG;
    this.targetFovDeg = DEFAULT_FOV_DEG;
    this.hasGyroBaseline = false;
    this.gyroDeltaQuat.identity();
    this.gyroTargetDeltaQuat.identity();

    if (this.camera.fov !== DEFAULT_FOV_DEG) {
      this.camera.fov = DEFAULT_FOV_DEG;
      this.camera.updateProjectionMatrix();
    }
  }

  public applyDragDelta(dxPx: number, dyPx: number): void {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    this.targetYawRad = wrapYawRad(this.targetYawRad - dxPx * DRAG_RAD_PER_PX);
    this.targetPitchRad = clampPitchRad(this.targetPitchRad - dyPx * DRAG_RAD_PER_PX);
  }

  public applyPinchScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return;
    this.targetFovDeg = clampFovDeg(this.targetFovDeg / scale);
  }

  public update(
    egoLocalPos: THREE.Vector3,
    headingRad: number,
    pitchRad: number,
    dtSec: number,
  ): void {
    const dt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, 0.25) : 0;

    if (dt > 0) {
      this.userYawRad = dampAngleRad(this.userYawRad, this.targetYawRad, LOOK_DAMP_LAMBDA, dt);
      this.userPitchRad = clampPitchRad(
        dampValue(this.userPitchRad, this.targetPitchRad, LOOK_DAMP_LAMBDA, dt),
      );
      this.fovDeg = clampFovDeg(
        dampValue(this.fovDeg, this.targetFovDeg, FOV_DAMP_LAMBDA, dt),
      );

      if (this.gyroEnabled) {
        const gyroAlpha = 1 - Math.exp(-GYRO_DAMP_LAMBDA * dt);
        this.gyroDeltaQuat.slerp(this.gyroTargetDeltaQuat, gyroAlpha);
      }
    }

    if (Math.abs(this.camera.fov - this.fovDeg) > 1e-3) {
      this.camera.fov = this.fovDeg;
      this.camera.updateProjectionMatrix();
    }

    this.poseInput.egoLocalPos.copy(egoLocalPos);
    this.poseInput.headingRad = headingRad;
    this.poseInput.pitchRad = pitchRad;
    this.poseInput.viewMode = this.viewMode;
    this.poseInput.userYawRad = this.userYawRad;
    this.poseInput.userPitchRad = this.userPitchRad;
    this.poseInput.gyroEnabled = this.gyroEnabled;
    this.poseInput.gyroDeltaQuat = this.gyroDeltaQuat;

    computeCameraPose(this.poseInput, this.camera.position, this.camera.quaternion);
  }

  public getDebugAngles(): { yaw: number; pitch: number } {
    if (this.gyroEnabled && isFiniteQuaternion(this.gyroDeltaQuat)) {
      computeUserLookQuaternion(this.userYawRad, this.userPitchRad, _debugLookQuat);
      _debugLookQuat.multiply(this.gyroDeltaQuat);
      _debugEuler.setFromQuaternion(_debugLookQuat, 'YXZ');
      return {
        yaw: wrapYawRad(_debugEuler.y),
        pitch: clampPitchRad(_debugEuler.x),
      };
    }
    return { yaw: this.userYawRad, pitch: this.userPitchRad };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activePointers.clear();

    if (this.canvas) {
      this.canvas.removeEventListener('pointerdown', this.onPointerDown);
      this.canvas.removeEventListener('pointermove', this.onPointerMove);
      this.canvas.removeEventListener('pointerup', this.onPointerUp);
      this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
      this.canvas.style.touchAction = this.prevTouchAction;
    }
  }

  private computePinchDistance(): number {
    if (this.activePointers.size < 2) return 0;
    let first: PointerState | null = null;
    for (const pt of this.activePointers.values()) {
      if (!first) {
        first = pt;
      } else {
        return Math.hypot(pt.x - first.x, pt.y - first.y);
      }
    }
    return 0;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.canvas) {
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture failures on synthetic or detached pointer events
      }
    }

    this.activePointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      movedPx: 0,
    });

    if (this.activePointers.size === 2) {
      this.lastPinchDist = this.computePinchDistance();
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const state = this.activePointers.get(e.pointerId);
    if (!state) return;

    const dx = e.clientX - state.x;
    const dy = e.clientY - state.y;
    state.x = e.clientX;
    state.y = e.clientY;
    state.movedPx += Math.hypot(dx, dy);

    if (this.activePointers.size === 1) {
      this.applyDragDelta(dx, dy);
    } else if (this.activePointers.size >= 2) {
      const dist = this.computePinchDistance();
      if (this.lastPinchDist > 1e-3 && dist > 1e-3) {
        this.applyPinchScale(dist / this.lastPinchDist);
      }
      this.lastPinchDist = dist;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const state = this.activePointers.get(e.pointerId);
    const wasSinglePointer = this.activePointers.size === 1;

    if (this.canvas) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore release failures when pointer wasn't captured
      }
    }

    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) {
      this.lastPinchDist = 0;
    }

    if (wasSinglePointer && state && state.movedPx < DOUBLE_TAP_MAX_MOVE_PX) {
      const now = performance.now();
      const dist = Math.hypot(e.clientX - this.lastTapX, e.clientY - this.lastTapY);
      if (
        this.lastTapTimeMs > 0 &&
        now - this.lastTapTimeMs < DOUBLE_TAP_MAX_MS &&
        dist < DOUBLE_TAP_MAX_DIST_PX
      ) {
        this.resetCameraView();
        this.lastTapTimeMs = 0;
      } else {
        this.lastTapTimeMs = now;
        this.lastTapX = e.clientX;
        this.lastTapY = e.clientY;
      }
    }
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.canvas) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore release failures
      }
    }
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) {
      this.lastPinchDist = 0;
    }
  };
}
