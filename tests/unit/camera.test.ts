import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  CameraController,
  CHASE_BACK_M,
  CHASE_UP_M,
  clampFovDeg,
  clampPitchRad,
  computeCameraPose,
  computeDeviceOrientationQuaternion,
  computeRelativeGyroDelta,
  computeTrackQuaternion,
  dampAngleRad,
  dampValue,
  DEFAULT_FOV_DEG,
  EYE_HEIGHT_ABOVE_RAIL_M,
  MAX_FOV_DEG,
  MAX_PITCH_RAD,
  MIN_FOV_DEG,
  wrapYawRad,
} from '../../src/render/CameraController';

function assertFiniteVec3(v: THREE.Vector3): void {
  expect(Number.isFinite(v.x)).toBe(true);
  expect(Number.isFinite(v.y)).toBe(true);
  expect(Number.isFinite(v.z)).toBe(true);
}

function assertFiniteQuat(q: THREE.Quaternion): void {
  expect(Number.isFinite(q.x)).toBe(true);
  expect(Number.isFinite(q.y)).toBe(true);
  expect(Number.isFinite(q.z)).toBe(true);
  expect(Number.isFinite(q.w)).toBe(true);
  expect(q.length()).toBeCloseTo(1, 5);
}

describe('CameraController math helpers', () => {
  it('wraps yaw into (-PI, PI] and guards non-finite inputs', () => {
    expect(wrapYawRad(0)).toBe(0);
    expect(wrapYawRad(Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(wrapYawRad(-Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(wrapYawRad(3 * Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(wrapYawRad(Math.PI * 1.5)).toBeCloseTo(-Math.PI * 0.5, 6);
    expect(wrapYawRad(-Math.PI * 1.5)).toBeCloseTo(Math.PI * 0.5, 6);
    expect(wrapYawRad(Number.NaN)).toBe(0);
    expect(wrapYawRad(Number.POSITIVE_INFINITY)).toBe(0);
    expect(wrapYawRad(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('clamps pitch to ±75 deg and FOV to [45, 90] with finite guards', () => {
    expect(clampPitchRad(0)).toBe(0);
    expect(clampPitchRad(Math.PI)).toBeCloseTo(MAX_PITCH_RAD, 6);
    expect(clampPitchRad(-Math.PI)).toBeCloseTo(-MAX_PITCH_RAD, 6);
    expect(clampPitchRad(Number.NaN)).toBe(0);
    expect(clampPitchRad(Number.POSITIVE_INFINITY)).toBe(0);

    expect(clampFovDeg(68)).toBe(68);
    expect(clampFovDeg(10)).toBe(MIN_FOV_DEG);
    expect(clampFovDeg(140)).toBe(MAX_FOV_DEG);
    expect(clampFovDeg(Number.NaN)).toBe(DEFAULT_FOV_DEG);
    expect(clampFovDeg(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_FOV_DEG);
  });

  it('damps values and angles smoothly along the shortest path', () => {
    const mid = dampValue(0, 10, 10, 0.1);
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(10);
    expect(dampValue(3, 10, 10, 0)).toBe(3);

    // Shortest path across ±PI boundary: from +170 deg toward -170 deg should pass +180
    const start = (170 * Math.PI) / 180;
    const target = (-170 * Math.PI) / 180;
    const step = dampAngleRad(start, target, 10, 0.05);
    expect(Math.abs(step)).toBeGreaterThan((170 * Math.PI) / 180);
  });

  it('aligns -Z forward accurately for cardinal headings and vertical grades with zero roll', () => {
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();

    // North: heading = 0 -> forward = (0, 0, -1)
    const qN = computeTrackQuaternion(0, 0);
    forward.set(0, 0, -1).applyQuaternion(qN);
    expect(forward.x).toBeCloseTo(0, 5);
    expect(forward.y).toBeCloseTo(0, 5);
    expect(forward.z).toBeCloseTo(-1, 5);

    // East: heading = +PI/2 -> forward = (+1, 0, 0)
    const qE = computeTrackQuaternion(Math.PI * 0.5, 0);
    forward.set(0, 0, -1).applyQuaternion(qE);
    expect(forward.x).toBeCloseTo(1, 5);
    expect(forward.y).toBeCloseTo(0, 5);
    expect(forward.z).toBeCloseTo(0, 5);

    // South: heading = PI -> forward = (0, 0, +1)
    const qS = computeTrackQuaternion(Math.PI, 0);
    forward.set(0, 0, -1).applyQuaternion(qS);
    expect(forward.x).toBeCloseTo(0, 5);
    expect(forward.y).toBeCloseTo(0, 5);
    expect(forward.z).toBeCloseTo(1, 5);

    // West: heading = -PI/2 -> forward = (-1, 0, 0)
    const qW = computeTrackQuaternion(-Math.PI * 0.5, 0);
    forward.set(0, 0, -1).applyQuaternion(qW);
    expect(forward.x).toBeCloseTo(-1, 5);
    expect(forward.y).toBeCloseTo(0, 5);
    expect(forward.z).toBeCloseTo(0, 5);

    // Ascending grade (+0.15 rad): forward.y > 0, right.y === 0 (zero roll)
    const qClimb = computeTrackQuaternion(0.4, 0.15);
    forward.set(0, 0, -1).applyQuaternion(qClimb);
    right.set(1, 0, 0).applyQuaternion(qClimb);
    expect(forward.y).toBeCloseTo(Math.sin(0.15), 5);
    expect(right.y).toBeCloseTo(0, 5);
  });

  it('cancels magnetometer offset alpha_0 and preserves local rotation across portrait & landscape screen angles', () => {
    const screenAngles = [0, 90, -90, 180];

    for (const screenAngle of screenAngles) {
      // Same physical phone tilt from baseline (beta 75 -> 95), with two completely different magnetometer offsets
      const baseA = computeDeviceOrientationQuaternion(15, 75, 0, screenAngle);
      const movedA = computeDeviceOrientationQuaternion(15, 95, 0, screenAngle);
      const deltaA = computeRelativeGyroDelta(movedA, baseA.clone().invert());

      const baseB = computeDeviceOrientationQuaternion(162, 75, 0, screenAngle);
      const movedB = computeDeviceOrientationQuaternion(162, 95, 0, screenAngle);
      const deltaB = computeRelativeGyroDelta(movedB, baseB.clone().invert());

      assertFiniteQuat(deltaA);
      assertFiniteQuat(deltaB);

      // Identical relative rotation regardless of magnetometer offset alpha_0
      expect(Math.abs(deltaA.dot(deltaB))).toBeCloseTo(1, 5);

      // Zero jump when raw == baseline
      const zeroDelta = computeRelativeGyroDelta(baseA, baseA.clone().invert());
      expect(Math.abs(zeroDelta.w)).toBeCloseTo(1, 5);

      // Non-trivial rotation angle (~20 deg) preserved
      const angleDeg = THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(deltaA.w))));
      expect(angleDeg).toBeCloseTo(20, 1);
    }
  });
});

describe('CameraController rig & view modes', () => {
  it('supports drag look-around, damping, pinch FOV clamping, and resetCameraView', () => {
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.15, 10000);
    const controller = new CameraController(camera);
    const egoPos = new THREE.Vector3(10, 0, -20);

    controller.applyDragDelta(120, -80);
    for (let i = 0; i < 30; i++) {
      controller.update(egoPos, 0, 0, 1 / 60);
    }

    const angles = controller.getDebugAngles();
    expect(angles.yaw).not.toBe(0);
    expect(angles.pitch).toBeGreaterThan(0);
    expect(Math.abs(angles.pitch)).toBeLessThanOrEqual(MAX_PITCH_RAD);

    // Extreme vertical drag clamps at ±75 deg
    controller.applyDragDelta(0, -100000);
    for (let i = 0; i < 60; i++) {
      controller.update(egoPos, 0, 0, 1 / 60);
    }
    expect(controller.getDebugAngles().pitch).toBeCloseTo(MAX_PITCH_RAD, 2);

    // Pinch zoom out/in clamps FOV within [45, 90]
    controller.applyPinchScale(10);
    for (let i = 0; i < 60; i++) {
      controller.update(egoPos, 0, 0, 1 / 60);
    }
    expect(camera.fov).toBeCloseTo(MIN_FOV_DEG, 1);

    controller.applyPinchScale(0.05);
    for (let i = 0; i < 60; i++) {
      controller.update(egoPos, 0, 0, 1 / 60);
    }
    expect(camera.fov).toBeCloseTo(MAX_FOV_DEG, 1);

    // Reset snaps yaw/pitch to 0 and FOV to 68
    controller.resetCameraView();
    expect(controller.getDebugAngles()).toEqual({ yaw: 0, pitch: 0 });
    expect(camera.fov).toBe(DEFAULT_FOV_DEG);

    controller.dispose();
    controller.dispose(); // idempotent
  });

  it('positions camera accurately in inside, ghost, and chase view modes', () => {
    const egoPos = new THREE.Vector3(100, -12, -250);
    const outPos = new THREE.Vector3();
    const outQuat = new THREE.Quaternion();

    // Inside mode: eye-level +2.85 m above rail
    computeCameraPose(
      { egoLocalPos: egoPos, headingRad: 0, pitchRad: 0, viewMode: 'inside', userYawRad: 0, userPitchRad: 0 },
      outPos,
      outQuat,
    );
    expect(outPos.x).toBeCloseTo(100, 5);
    expect(outPos.y).toBeCloseTo(-12 + EYE_HEIGHT_ABOVE_RAIL_M, 5);
    expect(outPos.z).toBeCloseTo(-250, 5);

    // Ghost mode: same eye-level mount
    const ghostPos = new THREE.Vector3();
    const ghostQuat = new THREE.Quaternion();
    computeCameraPose(
      { egoLocalPos: egoPos, headingRad: 0, pitchRad: 0, viewMode: 'ghost', userYawRad: 0, userPitchRad: 0 },
      ghostPos,
      ghostQuat,
    );
    expect(ghostPos.distanceTo(outPos)).toBeCloseTo(0, 5);

    // Chase mode: behind (+Z when heading North) by CHASE_BACK_M and above by CHASE_UP_M
    const chasePos = new THREE.Vector3();
    const chaseQuat = new THREE.Quaternion();
    computeCameraPose(
      { egoLocalPos: egoPos, headingRad: 0, pitchRad: 0, viewMode: 'chase', userYawRad: 0, userPitchRad: 0 },
      chasePos,
      chaseQuat,
    );
    expect(chasePos.x).toBeCloseTo(100, 5);
    expect(chasePos.y).toBeCloseTo(-12 + CHASE_UP_M, 5);
    expect(chasePos.z).toBeCloseTo(-250 + CHASE_BACK_M, 5);

    // Chase camera tilts slightly downward (-0.14 rad)
    const chaseFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(chaseQuat);
    expect(chaseFwd.y).toBeLessThan(-0.1);
  });

  it('produces zero NaNs on garbage or extreme inputs and handles gyro baseline cleanly', () => {
    const camera = new THREE.PerspectiveCamera(68, 1, 0.15, 10000);
    const controller = new CameraController(camera);

    controller.setGyroEnabled(true);
    // First valid sample establishes baseline -> zero jump
    controller.handleDeviceOrientation(120, 80, 5, 0);
    controller.update(new THREE.Vector3(0, 0, 0), 0, 0, 1 / 60);
    assertFiniteVec3(camera.position);
    assertFiniteQuat(camera.quaternion);
    expect(Math.abs(camera.quaternion.w)).toBeCloseTo(1, 5);

    // Feed garbage values
    controller.applyDragDelta(Number.NaN, Number.POSITIVE_INFINITY);
    controller.applyPinchScale(-5);
    controller.applyPinchScale(Number.NaN);
    controller.handleDeviceOrientation(Number.NaN, Number.POSITIVE_INFINITY, 0, 90);
    controller.update(
      new THREE.Vector3(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    );

    assertFiniteVec3(camera.position);
    assertFiniteQuat(camera.quaternion);
    expect(Number.isFinite(camera.fov)).toBe(true);
    expect(Number.isFinite(controller.getDebugAngles().yaw)).toBe(true);
    expect(Number.isFinite(controller.getDebugAngles().pitch)).toBe(true);

    controller.dispose();
  });

  it('reflects gyroDeltaQuat in getDebugAngles() when gyro is enabled and restores drag angles when disabled', () => {
    const camera = new THREE.PerspectiveCamera(68, 1, 0.15, 10000);
    const controller = new CameraController(camera);
    const egoPos = new THREE.Vector3(0, 0, 0);

    controller.setGyroEnabled(true);
    controller.handleDeviceOrientation(0, 75, 0, 0); // baseline
    controller.update(egoPos, 0, 0, 1 / 60);
    const baseAngles = controller.getDebugAngles();
    expect(Math.abs(baseAngles.yaw)).toBeLessThan(0.01);
    expect(Math.abs(baseAngles.pitch)).toBeLessThan(0.01);

    // Rotate device significantly and step camera slerp
    controller.handleDeviceOrientation(45, 60, 10, 0);
    for (let i = 0; i < 20; i++) {
      controller.update(egoPos, 0, 0, 1 / 60);
    }
    const rotatedAngles = controller.getDebugAngles();
    expect(
      Math.abs(rotatedAngles.yaw - baseAngles.yaw) > 0.1 ||
        Math.abs(rotatedAngles.pitch - baseAngles.pitch) > 0.05,
    ).toBe(true);

    // Disabling gyro returns to unmutated drag angles (0, 0)
    controller.setGyroEnabled(false);
    controller.update(egoPos, 0, 0, 1 / 60);
    expect(controller.getDebugAngles()).toEqual({ yaw: 0, pitch: 0 });

    controller.dispose();
  });
});
