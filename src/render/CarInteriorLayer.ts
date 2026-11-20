import * as THREE from 'three';
import type { ViewMode } from '../types/state';
import { computeTrackQuaternion } from './CameraController';
import { mergeBufferGeometries, setUniformVertexColor } from './geometryUtils';

const CAR_LENGTH_M = 18.0;
const HALF_LEN = CAR_LENGTH_M * 0.5; // 9.0
const CAR_WIDTH_M = 3.0;
const HALF_W = CAR_WIDTH_M * 0.5; // 1.5
const FLOOR_Y = 1.20;
const SILL_Y = 2.05;
const HEADER_Y = 3.10;
const CEILING_Y = 3.45;
const WALL_THICK = 0.08;

function makeColoredBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  colorHex: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  setUniformVertexColor(g, new THREE.Color(colorHex));
  return g;
}

function makeColoredCylinder(
  radius: number,
  length: number,
  x: number,
  y: number,
  z: number,
  rotX: number,
  rotZ: number,
  colorHex: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, 6, 1, true);
  if (rotX !== 0) g.rotateX(rotX);
  if (rotZ !== 0) g.rotateZ(rotZ);
  g.translate(x, y, z);
  setUniformVertexColor(g, new THREE.Color(colorHex));
  return g;
}

/**
 * Stylized low-poly NYC subway car interior surrounding the first-person camera.
 * Authored with nose/forward along -Z, floor at Y=1.20m, eye level at Y=2.85m.
 * Renders in <= 4 merged meshes (shell, poles, glass, ceiling lights).
 */
export class CarInteriorLayer {
  public readonly group: THREE.Group;

  private readonly shellMesh: THREE.Mesh;
  private readonly polesMesh: THREE.Mesh;
  private readonly glassMesh: THREE.Mesh;
  private readonly lightsMesh: THREE.Mesh;

  private readonly shellSolidMat: THREE.MeshLambertMaterial;
  private readonly shellGhostMat: THREE.MeshBasicMaterial;
  private readonly polesSolidMat: THREE.MeshLambertMaterial;
  private readonly polesGhostMat: THREE.MeshBasicMaterial;
  private readonly glassMat: THREE.MeshBasicMaterial;
  private readonly lightsSolidMat: THREE.MeshBasicMaterial;
  private readonly lightsGhostMat: THREE.MeshBasicMaterial;

  private currentMode: ViewMode = 'inside';
  private disposed = false;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'car-interior-layer';

    // --- 1. Shell geometry (floor, ceiling, lower side walls, upper headers, window pillars, seats) ---
    const shellParts: THREE.BufferGeometry[] = [];
    const floorColor = 0x1e2430;
    const wallColor = 0x2a3242;
    const pillarColor = 0x354052;
    const ceilingColor = 0x252d3c;
    const seatColor = 0x1d4e89;

    // Floor & ceiling slabs
    shellParts.push(makeColoredBox(CAR_WIDTH_M, 0.08, CAR_LENGTH_M, 0, FLOOR_Y - 0.04, 0, floorColor));
    shellParts.push(makeColoredBox(CAR_WIDTH_M, 0.08, CAR_LENGTH_M, 0, CEILING_Y + 0.04, 0, ceilingColor));

    // Lower side walls (floor to window sill) & upper headers (header to ceiling)
    const lowerWallH = SILL_Y - FLOOR_Y;
    const lowerWallY = FLOOR_Y + lowerWallH * 0.5;
    const headerH = CEILING_Y - HEADER_Y;
    const headerY = HEADER_Y + headerH * 0.5;

    for (const side of [-1, 1] as const) {
      const wx = side * (HALF_W - WALL_THICK * 0.5);
      shellParts.push(makeColoredBox(WALL_THICK, lowerWallH, CAR_LENGTH_M, wx, lowerWallY, 0, wallColor));
      shellParts.push(makeColoredBox(WALL_THICK, headerH, CAR_LENGTH_M, wx, headerY, 0, wallColor));

      // Longitudinal bench seats along side walls (leaving clear center aisle & door bays)
      const seatX = side * (HALF_W - 0.30);
      const seatY = FLOOR_Y + 0.24;
      for (const zCenter of [-6.8, -2.2, 2.2, 6.8]) {
        shellParts.push(makeColoredBox(0.46, 0.44, 2.4, seatX, seatY, zCenter, seatColor));
      }

      // Window & door frame mullions between panoramic windows
      const windowH = HEADER_Y - SILL_Y;
      const windowY = SILL_Y + windowH * 0.5;
      const pillarZs = [-HALF_LEN + 0.15, -5.2, -3.7, -0.7, 0.7, 3.7, 5.2, HALF_LEN - 0.15];
      for (const pz of pillarZs) {
        shellParts.push(makeColoredBox(WALL_THICK + 0.02, windowH, 0.16, wx, windowY, pz, pillarColor));
      }
    }

    // Front (-Z) and rear (+Z) bulkhead frames (leaving large center cab/end window)
    for (const end of [-1, 1] as const) {
      const ez = end * (HALF_LEN - WALL_THICK * 0.5);
      shellParts.push(makeColoredBox(CAR_WIDTH_M, lowerWallH, WALL_THICK, 0, lowerWallY, ez, wallColor));
      shellParts.push(makeColoredBox(CAR_WIDTH_M, headerH, WALL_THICK, 0, headerY, ez, wallColor));
      const windowH = HEADER_Y - SILL_Y;
      const windowY = SILL_Y + windowH * 0.5;
      shellParts.push(makeColoredBox(0.48, windowH, WALL_THICK, -(HALF_W - 0.24), windowY, ez, pillarColor));
      shellParts.push(makeColoredBox(0.48, windowH, WALL_THICK, HALF_W - 0.24, windowY, ez, pillarColor));
    }

    const shellGeom = mergeBufferGeometries(shellParts);
    for (const p of shellParts) p.dispose();

    // --- 2. Grab poles & overhead handrails (offset from camera center X=0, Z=0) ---
    const poleParts: THREE.BufferGeometry[] = [];
    const poleColor = 0xcbd5e1;
    const poleH = CEILING_Y - FLOOR_Y;
    const poleY = FLOOR_Y + poleH * 0.5;

    // Vertical grab stanchions offset from center line so forward sightline is unobstructed
    const poleCoords: Array<[number, number]> = [
      [-0.78, -5.8],
      [0.78, -5.8],
      [-0.78, -2.5],
      [0.78, -2.5],
      [-0.78, 2.5],
      [0.78, 2.5],
      [-0.78, 5.8],
      [0.78, 5.8],
    ];
    for (const [px, pz] of poleCoords) {
      poleParts.push(makeColoredCylinder(0.026, poleH, px, poleY, pz, 0, 0, poleColor));
    }

    // Two longitudinal overhead handrails
    for (const side of [-1, 1] as const) {
      poleParts.push(
        makeColoredCylinder(
          0.022,
          CAR_LENGTH_M - 1.2,
          side * 0.78,
          HEADER_Y - 0.02,
          0,
          Math.PI * 0.5,
          0,
          poleColor,
        ),
      );
    }

    const polesGeom = mergeBufferGeometries(poleParts);
    for (const p of poleParts) p.dispose();

    // --- 3. Panoramic side windows & front/rear bulkhead glass ---
    const glassParts: THREE.BufferGeometry[] = [];
    const glassColor = 0x7dd3fc;
    const windowH = HEADER_Y - SILL_Y - 0.04;
    const windowY = SILL_Y + (HEADER_Y - SILL_Y) * 0.5;

    for (const side of [-1, 1] as const) {
      const gx = side * (HALF_W - 0.03);
      const pane = new THREE.PlaneGeometry(CAR_LENGTH_M - 0.4, windowH);
      pane.rotateY(Math.PI * 0.5);
      pane.translate(gx, windowY, 0);
      setUniformVertexColor(pane, new THREE.Color(glassColor));
      glassParts.push(pane);
    }
    for (const end of [-1, 1] as const) {
      const gz = end * (HALF_LEN - 0.03);
      const pane = new THREE.PlaneGeometry(CAR_WIDTH_M - 0.96, windowH);
      pane.translate(0, windowY, gz);
      setUniformVertexColor(pane, new THREE.Color(glassColor));
      glassParts.push(pane);
    }

    const glassGeom = mergeBufferGeometries(glassParts);
    for (const p of glassParts) p.dispose();

    // --- 4. Overhead LED ceiling light strips ---
    const lightParts: THREE.BufferGeometry[] = [];
    const lightColor = 0xf1f5f9;
    for (const side of [-1, 1] as const) {
      lightParts.push(
        makeColoredBox(0.14, 0.04, CAR_LENGTH_M - 1.6, side * 0.56, CEILING_Y - 0.02, 0, lightColor),
      );
    }
    const lightsGeom = mergeBufferGeometries(lightParts);
    for (const p of lightParts) p.dispose();

    // --- Materials ---
    this.shellSolidMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
    this.shellGhostMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });

    this.polesSolidMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
    this.polesGhostMat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });

    this.glassMat = new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.10,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.lightsSolidMat = new THREE.MeshBasicMaterial({
      color: 0xf8fafc,
    });
    this.lightsGhostMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });

    // --- Meshes (4 draw calls max) ---
    this.shellMesh = new THREE.Mesh(shellGeom, this.shellSolidMat);
    this.shellMesh.name = 'car-interior-shell';

    this.polesMesh = new THREE.Mesh(polesGeom, this.polesSolidMat);
    this.polesMesh.name = 'car-interior-poles';

    this.glassMesh = new THREE.Mesh(glassGeom, this.glassMat);
    this.glassMesh.name = 'car-interior-glass';

    this.lightsMesh = new THREE.Mesh(lightsGeom, this.lightsSolidMat);
    this.lightsMesh.name = 'car-interior-lights';

    this.group.add(this.shellMesh, this.polesMesh, this.glassMesh, this.lightsMesh);
    this.applyMode('inside');
  }

  public setViewMode(mode: ViewMode): void {
    if (this.currentMode === mode) return;
    this.applyMode(mode);
  }

  public getViewMode(): ViewMode {
    return this.currentMode;
  }

  public update(
    egoLocalPos: THREE.Vector3,
    headingRad: number,
    pitchRad: number,
    viewMode: ViewMode,
  ): void {
    if (viewMode !== this.currentMode) {
      this.applyMode(viewMode);
    }
    if (!this.group.visible) return;

    const x = Number.isFinite(egoLocalPos.x) ? egoLocalPos.x : 0;
    const y = Number.isFinite(egoLocalPos.y) ? egoLocalPos.y : 0;
    const z = Number.isFinite(egoLocalPos.z) ? egoLocalPos.z : 0;
    const safeHeading = Number.isFinite(headingRad) ? headingRad : 0;
    const safePitch = Number.isFinite(pitchRad) ? pitchRad : 0;

    this.group.position.set(x, y, z);
    computeTrackQuaternion(safeHeading, safePitch, this.group.quaternion);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.shellMesh.geometry.dispose();
    this.polesMesh.geometry.dispose();
    this.glassMesh.geometry.dispose();
    this.lightsMesh.geometry.dispose();

    this.shellSolidMat.dispose();
    this.shellGhostMat.dispose();
    this.polesSolidMat.dispose();
    this.polesGhostMat.dispose();
    this.glassMat.dispose();
    this.lightsSolidMat.dispose();
    this.lightsGhostMat.dispose();
  }

  private applyMode(mode: ViewMode): void {
    this.currentMode = mode;

    if (mode === 'chase') {
      this.group.visible = false;
      return;
    }

    this.group.visible = true;
    if (mode === 'ghost') {
      this.shellMesh.material = this.shellGhostMat;
      this.polesMesh.material = this.polesGhostMat;
      this.glassMesh.visible = false;
      this.lightsMesh.material = this.lightsGhostMat;
    } else {
      this.shellMesh.material = this.shellSolidMat;
      this.polesMesh.material = this.polesSolidMat;
      this.glassMesh.visible = true;
      this.lightsMesh.material = this.lightsSolidMat;
    }
  }
}
