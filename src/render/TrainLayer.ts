import * as THREE from 'three';
import type { ViewMode, WorldStateSnapshot } from '../types/state';
import type { RailSystem } from '../types/transit';
import { computeTrackQuaternion } from './CameraController';
import { mergeBufferGeometries } from './geometryUtils';

export const MAX_CARS = 320;
export const MAX_TRAINS = 48;

const CAR_HEIGHT_M = 3.15;
const CAR_BASE_Y_OFFSET_M = 0.45;

const SYSTEM_LIVERY_HEX: Record<RailSystem, number> = {
  MTA: 0xcbd5e1,
  LIRR: 0xdbeafe,
  MNR: 0xe0e7ff,
  PATH: 0xcffafe,
  NJT: 0xf1f5f9,
  AIRTRAIN: 0xfef3c7,
};

/**
 * InstancedMesh renderer for the ego train consist and all nearby MTA + regional
 * trains in 4 draw calls (car bodies, route stripes, headlights, taillights).
 */
export class TrainLayer {
  public readonly group: THREE.Group;

  private readonly bodyMesh: THREE.InstancedMesh;
  private readonly stripeMesh: THREE.InstancedMesh;
  private readonly headlightMesh: THREE.InstancedMesh;
  private readonly taillightMesh: THREE.InstancedMesh;

  private readonly bodyMat: THREE.MeshLambertMaterial;
  private readonly stripeMat: THREE.MeshBasicMaterial;
  private readonly headlightMat: THREE.MeshBasicMaterial;
  private readonly taillightMat: THREE.MeshBasicMaterial;

  // Pre-allocated scratch objects (zero per-frame heap allocations)
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchLiveryColor = new THREE.Color();
  private readonly scratchRouteColor = new THREE.Color();

  private lastSnapshot: WorldStateSnapshot | null = null;
  private lastTimestampMs = NaN;
  private lastViewMode: ViewMode | null = null;
  private lastOx = NaN;
  private lastOy = NaN;
  private lastOz = NaN;

  private disposed = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'train-layer';

    // 1. Car body unit box: [width=1, height=1, length=1] resting on y=0..1, nose at z=-0.5
    const bodyGeom = new THREE.BoxGeometry(1, 1, 1);
    bodyGeom.translate(0, 0.5, 0);

    // 2. Side + roof route-color stripes
    const leftStripe = new THREE.BoxGeometry(0.02, 0.18, 0.98);
    leftStripe.translate(-0.505, 0.54, 0);
    const rightStripe = new THREE.BoxGeometry(0.02, 0.18, 0.98);
    rightStripe.translate(0.505, 0.54, 0);
    const roofStripe = new THREE.BoxGeometry(0.52, 0.03, 0.94);
    roofStripe.translate(0, 1.01, 0);
    const stripeGeom = mergeBufferGeometries([leftStripe, rightStripe, roofStripe]);
    leftStripe.dispose();
    rightStripe.dispose();
    roofStripe.dispose();

    // 3. Twin warm-white headlights at front face z = -0.505
    const hlLeft = new THREE.BoxGeometry(0.14, 0.12, 0.04);
    hlLeft.translate(-0.28, 0.42, -0.505);
    const hlRight = new THREE.BoxGeometry(0.14, 0.12, 0.04);
    hlRight.translate(0.28, 0.42, -0.505);
    const headlightGeom = mergeBufferGeometries([hlLeft, hlRight]);
    hlLeft.dispose();
    hlRight.dispose();

    // 4. Twin red taillights at rear face z = +0.505
    const tlLeft = new THREE.BoxGeometry(0.14, 0.12, 0.04);
    tlLeft.translate(-0.28, 0.42, 0.505);
    const tlRight = new THREE.BoxGeometry(0.14, 0.12, 0.04);
    tlRight.translate(0.28, 0.42, 0.505);
    const taillightGeom = mergeBufferGeometries([tlLeft, tlRight]);
    tlLeft.dispose();
    tlRight.dispose();

    this.bodyMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
    });
    this.stripeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    this.headlightMat = new THREE.MeshBasicMaterial({
      color: 0xfff7d6,
    });
    this.taillightMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
    });

    this.bodyMesh = new THREE.InstancedMesh(bodyGeom, this.bodyMat, MAX_CARS);
    this.bodyMesh.name = 'train-bodies';
    this.bodyMesh.frustumCulled = false;

    this.stripeMesh = new THREE.InstancedMesh(stripeGeom, this.stripeMat, MAX_CARS);
    this.stripeMesh.name = 'train-stripes';
    this.stripeMesh.frustumCulled = false;

    this.headlightMesh = new THREE.InstancedMesh(headlightGeom, this.headlightMat, MAX_TRAINS);
    this.headlightMesh.name = 'train-headlights';
    this.headlightMesh.frustumCulled = false;

    this.taillightMesh = new THREE.InstancedMesh(taillightGeom, this.taillightMat, MAX_TRAINS);
    this.taillightMesh.name = 'train-taillights';
    this.taillightMesh.frustumCulled = false;

    // Pre-allocate instanceColor buffers up front so update() never allocates
    const initColor = new THREE.Color(0xffffff);
    this.bodyMesh.setColorAt(0, initColor);
    this.stripeMesh.setColorAt(0, initColor);

    this.bodyMesh.count = 0;
    this.stripeMesh.count = 0;
    this.headlightMesh.count = 0;
    this.taillightMesh.count = 0;

    this.group.add(
      this.bodyMesh,
      this.stripeMesh,
      this.headlightMesh,
      this.taillightMesh,
    );
  }

  public getRenderedCarCount(): number {
    return this.bodyMesh.count;
  }

  public getRenderedHeadlightCount(): number {
    return this.headlightMesh.count;
  }

  public getRenderedTaillightCount(): number {
    return this.taillightMesh.count;
  }

  public update(
    snapshot: WorldStateSnapshot,
    viewMode: ViewMode,
    originOffset?: THREE.Vector3,
  ): void {
    const ox = originOffset && Number.isFinite(originOffset.x) ? originOffset.x : 0;
    const oy = originOffset && Number.isFinite(originOffset.y) ? originOffset.y : 0;
    const oz = originOffset && Number.isFinite(originOffset.z) ? originOffset.z : 0;

    if (
      snapshot === this.lastSnapshot &&
      snapshot.timestampMs === this.lastTimestampMs &&
      viewMode === this.lastViewMode &&
      ox === this.lastOx &&
      oy === this.lastOy &&
      oz === this.lastOz
    ) {
      return;
    }

    this.lastSnapshot = snapshot;
    this.lastTimestampMs = snapshot.timestampMs;
    this.lastViewMode = viewMode;
    this.lastOx = ox;
    this.lastOy = oy;
    this.lastOz = oz;

    let carIdx = 0;
    let headIdx = 0;
    let tailIdx = 0;

    // 1. Ego consist
    const egoConsist = snapshot.egoConsist;
    if (egoConsist.length > 0) {
      const egoEnu = snapshot.ego.positionEnu;
      const egoPosValid =
        Number.isFinite(egoEnu[0]) &&
        Number.isFinite(egoEnu[1]) &&
        Number.isFinite(egoEnu[2]);
      let egoCarIdx = 0;
      if (egoPosValid) {
        let bestDistSq = Infinity;
        for (let i = 0; i < egoConsist.length; i++) {
          const c = egoConsist[i].enu;
          if (!Number.isFinite(c[0]) || !Number.isFinite(c[1]) || !Number.isFinite(c[2])) {
            continue;
          }
          const de = c[0] - egoEnu[0];
          const dn = c[1] - egoEnu[1];
          const du = c[2] - egoEnu[2];
          const dSq = de * de + dn * dn + du * du;
          if (Number.isFinite(dSq) && dSq < bestDistSq) {
            bestDistSq = dSq;
            egoCarIdx = i;
          }
        }
      }

      const skipEgoCar = viewMode === 'inside' || viewMode === 'ghost';
      const egoSystem: RailSystem = snapshot.ego.system ?? 'MTA';
      this.scratchLiveryColor.setHex(SYSTEM_LIVERY_HEX[egoSystem] ?? 0xcbd5e1);
      this.scratchRouteColor.set(snapshot.ego.routeColor || '#38bdf8');

      for (let i = 0; i < egoConsist.length && carIdx < MAX_CARS; i++) {
        if (skipEgoCar && i === egoCarIdx) continue;
        const car = egoConsist[i];
        if (
          !Number.isFinite(car.enu[0]) ||
          !Number.isFinite(car.enu[1]) ||
          !Number.isFinite(car.enu[2])
        ) {
          continue;
        }
        const lx = car.enu[0] - ox;
        const ly = car.enu[2] + CAR_BASE_Y_OFFSET_M - oy;
        const lz = -car.enu[1] - oz;
        if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) {
          continue;
        }
        const w = Number.isFinite(car.widthM) && car.widthM > 0 ? car.widthM : 3.0;
        const l = Number.isFinite(car.lengthM) && car.lengthM > 0 ? car.lengthM : 18.0;

        this.composeCarMatrix(
          lx,
          ly,
          lz,
          car.headingRad,
          car.pitchRad,
          w,
          CAR_HEIGHT_M,
          l,
        );

        this.bodyMesh.setMatrixAt(carIdx, this.scratchMatrix);
        this.bodyMesh.setColorAt(carIdx, this.scratchLiveryColor);
        this.stripeMesh.setMatrixAt(carIdx, this.scratchMatrix);
        this.stripeMesh.setColorAt(carIdx, this.scratchRouteColor);
        carIdx++;

        if (i === 0 && headIdx < MAX_TRAINS) {
          this.headlightMesh.setMatrixAt(headIdx, this.scratchMatrix);
          headIdx++;
        }
        if (i === egoConsist.length - 1 && tailIdx < MAX_TRAINS) {
          this.taillightMesh.setMatrixAt(tailIdx, this.scratchMatrix);
          tailIdx++;
        }
      }
    }

    // 2. Nearby MTA & regional rail trains
    const nearby = snapshot.nearbyTrains;
    for (let t = 0; t < nearby.length && carIdx < MAX_CARS; t++) {
      const train = nearby[t];
      const cars = train.cars;
      if (cars.length === 0) continue;

      this.scratchLiveryColor.setHex(SYSTEM_LIVERY_HEX[train.system] ?? 0xcbd5e1);
      this.scratchRouteColor.set(train.color || '#94a3b8');

      const w = Number.isFinite(train.carWidthM) && train.carWidthM > 0 ? train.carWidthM : 3.0;
      const l = Number.isFinite(train.carLengthM) && train.carLengthM > 0 ? train.carLengthM : 18.0;

      for (let c = 0; c < cars.length && carIdx < MAX_CARS; c++) {
        const car = cars[c];
        if (
          !Number.isFinite(car.enu[0]) ||
          !Number.isFinite(car.enu[1]) ||
          !Number.isFinite(car.enu[2])
        ) {
          continue;
        }
        const lx = car.enu[0] - ox;
        const ly = car.enu[2] + CAR_BASE_Y_OFFSET_M - oy;
        const lz = -car.enu[1] - oz;
        if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) {
          continue;
        }
        this.composeCarMatrix(
          lx,
          ly,
          lz,
          car.headingRad,
          car.pitchRad,
          w,
          CAR_HEIGHT_M,
          l,
        );

        this.bodyMesh.setMatrixAt(carIdx, this.scratchMatrix);
        this.bodyMesh.setColorAt(carIdx, this.scratchLiveryColor);
        this.stripeMesh.setMatrixAt(carIdx, this.scratchMatrix);
        this.stripeMesh.setColorAt(carIdx, this.scratchRouteColor);
        carIdx++;

        if (c === 0 && headIdx < MAX_TRAINS) {
          this.headlightMesh.setMatrixAt(headIdx, this.scratchMatrix);
          headIdx++;
        }
        if (c === cars.length - 1 && tailIdx < MAX_TRAINS) {
          this.taillightMesh.setMatrixAt(tailIdx, this.scratchMatrix);
          tailIdx++;
        }
      }
    }

    this.bodyMesh.count = carIdx;
    this.stripeMesh.count = carIdx;
    this.headlightMesh.count = headIdx;
    this.taillightMesh.count = tailIdx;

    if (carIdx > 0) {
      this.bodyMesh.instanceMatrix.clearUpdateRanges();
      this.bodyMesh.instanceMatrix.addUpdateRange(0, carIdx * 16);
      this.bodyMesh.instanceMatrix.needsUpdate = true;

      this.stripeMesh.instanceMatrix.clearUpdateRanges();
      this.stripeMesh.instanceMatrix.addUpdateRange(0, carIdx * 16);
      this.stripeMesh.instanceMatrix.needsUpdate = true;

      if (this.bodyMesh.instanceColor) {
        this.bodyMesh.instanceColor.clearUpdateRanges();
        this.bodyMesh.instanceColor.addUpdateRange(0, carIdx * 3);
        this.bodyMesh.instanceColor.needsUpdate = true;
      }
      if (this.stripeMesh.instanceColor) {
        this.stripeMesh.instanceColor.clearUpdateRanges();
        this.stripeMesh.instanceColor.addUpdateRange(0, carIdx * 3);
        this.stripeMesh.instanceColor.needsUpdate = true;
      }
    }

    if (headIdx > 0) {
      this.headlightMesh.instanceMatrix.clearUpdateRanges();
      this.headlightMesh.instanceMatrix.addUpdateRange(0, headIdx * 16);
      this.headlightMesh.instanceMatrix.needsUpdate = true;
    }
    if (tailIdx > 0) {
      this.taillightMesh.instanceMatrix.clearUpdateRanges();
      this.taillightMesh.instanceMatrix.addUpdateRange(0, tailIdx * 16);
      this.taillightMesh.instanceMatrix.needsUpdate = true;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.bodyMesh.geometry.dispose();
    this.stripeMesh.geometry.dispose();
    this.headlightMesh.geometry.dispose();
    this.taillightMesh.geometry.dispose();

    this.bodyMat.dispose();
    this.stripeMat.dispose();
    this.headlightMat.dispose();
    this.taillightMat.dispose();
  }

  private composeCarMatrix(
    x: number,
    y: number,
    z: number,
    headingRad: number,
    pitchRad: number,
    widthM: number,
    heightM: number,
    lengthM: number,
  ): void {
    const safeHeading = Number.isFinite(headingRad) ? headingRad : 0;
    const safePitch = Number.isFinite(pitchRad) ? pitchRad : 0;
    this.scratchPos.set(x, y, z);
    computeTrackQuaternion(safeHeading, safePitch, this.scratchQuat);
    this.scratchScale.set(widthM, heightM, lengthM);
    this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
  }
}
