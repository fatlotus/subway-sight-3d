import * as THREE from 'three';
import { enuToThree } from '../geo/projection';
import type {
  BoroughOutline,
  BridgeLandmark,
  LandmarkDataset,
  WaterBodyLandmark,
} from '../types/transit';
import { mergeBufferGeometries, setUniformVertexColor } from './geometryUtils';

const GRID_EXTENT_M = 12000;
const GRID_STEP_M = 500;
const GRID_Y_M = 0.05;

function buildWaterGeometry(water: WaterBodyLandmark): THREE.BufferGeometry {
  const contour = water.polygonEnu.map(([e, n]) => new THREE.Vector2(e, n));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);

  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);

  for (let i = 0; i < faces.length; i++) {
    const [ia, ib, ic] = faces[i];
    const pa = water.polygonEnu[ia];
    const pb = water.polygonEnu[ib];
    const pc = water.polygonEnu[ic];

    // Exact Y === 0 for all water vertices (elevM = 0)
    const [ax, , az] = enuToThree(pa[0], pa[1], 0);
    const [bx, , bz] = enuToThree(pb[0], pb[1], 0);
    const [cx, , cz] = enuToThree(pc[0], pc[1], 0);

    const base = i * 9;
    positions[base] = ax;
    positions[base + 1] = 0;
    positions[base + 2] = az;

    positions[base + 3] = bx;
    positions[base + 4] = 0;
    positions[base + 5] = bz;

    positions[base + 6] = cx;
    positions[base + 7] = 0;
    positions[base + 8] = cz;

    normals[base + 1] = 1;
    normals[base + 4] = 1;
    normals[base + 7] = 1;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.computeBoundingSphere();
  return geom;
}

function buildBoroughOutlinesGeometry(
  boroughs: readonly BoroughOutline[],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();

  for (const borough of boroughs) {
    const pts = borough.outlineEnu;
    if (pts.length < 2) continue;
    color.set(borough.color || '#475569');
    const y = borough.elevationM;

    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const [ax, ay, az] = enuToThree(a[0], a[1], y);
      const [bx, by, bz] = enuToThree(b[0], b[1], y);
      positions.push(ax, ay, az, bx, by, bz);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeBoundingSphere();
  return geom;
}

function buildReferenceGridGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let v = -GRID_EXTENT_M; v <= GRID_EXTENT_M; v += GRID_STEP_M) {
    // East-West line
    positions.push(-GRID_EXTENT_M, GRID_Y_M, v, GRID_EXTENT_M, GRID_Y_M, v);
    // North-South line
    positions.push(v, GRID_Y_M, -GRID_EXTENT_M, v, GRID_Y_M, GRID_EXTENT_M);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeBoundingSphere();
  return geom;
}

function buildBridgesGeometries(bridges: readonly BridgeLandmark[]): {
  solidGeom: THREE.BufferGeometry;
  cableGeom: THREE.BufferGeometry;
} {
  const solidParts: THREE.BufferGeometry[] = [];
  const cablePositions: number[] = [];
  const cableColors: number[] = [];

  const bridgeColor = new THREE.Color();
  const towerColor = new THREE.Color();
  const cableColor = new THREE.Color();
  const white = new THREE.Color(0xffffff);

  for (const bridge of bridges) {
    bridgeColor.set(bridge.color || '#94a3b8');
    towerColor.copy(bridgeColor).lerp(white, 0.22);
    cableColor.copy(bridgeColor).lerp(white, 0.45);

    const deckPts = bridge.deckPointsEnu;
    const width = Math.max(8, bridge.widthM);
    const deckThick = 2.4;

    // 1. Deck segments along deckPointsEnu
    for (let i = 0; i < deckPts.length - 1; i++) {
      const a = deckPts[i];
      const b = deckPts[i + 1];
      const [ax, ay, az] = enuToThree(a[0], a[1], a[2]);
      const [bx, by, bz] = enuToThree(b[0], b[1], b[2]);

      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const segLen = Math.hypot(dx, dy, dz);
      const horizLen = Math.hypot(dx, dz);
      if (segLen < 1e-3 || horizLen < 1e-3) continue;

      const heading = Math.atan2(dx, -dz);
      const pitch = Math.atan2(dy, horizLen);

      const segBox = new THREE.BoxGeometry(width, deckThick, segLen);
      const quat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(pitch, -heading, 0, 'YXZ'),
      );
      const mat = new THREE.Matrix4().compose(
        new THREE.Vector3((ax + bx) * 0.5, (ay + by) * 0.5 - deckThick * 0.5, (az + bz) * 0.5),
        quat,
        new THREE.Vector3(1, 1, 1),
      );
      segBox.applyMatrix4(mat);
      setUniformVertexColor(segBox, bridgeColor);
      solidParts.push(segBox);
    }

    // Bridge heading for tower orientation & cable spans
    const spanA = bridge.spanEnu[0];
    const spanB = bridge.spanEnu[1];
    const [sax, , saz] = enuToThree(spanA[0], spanA[1], 0);
    const [sbx, , sbz] = enuToThree(spanB[0], spanB[1], 0);
    const spanDx = sbx - sax;
    const spanDz = sbz - saz;
    const spanLen = Math.hypot(spanDx, spanDz) || 1;
    const bridgeHeading = Math.atan2(spanDx, -spanDz);
    const bridgeQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, -bridgeHeading, 0, 'YXZ'),
    );
    const rx = -spanDz / spanLen;
    const rz = spanDx / spanLen;

    const towerH = Math.max(bridge.deckElevationM + 15, bridge.towerHeightM);
    const legHalfOffset = width * 0.5 + 1.8;

    // 2. Twin portal towers
    for (const [te, tn] of bridge.towersEnu) {
      const [tx, , tz] = enuToThree(te, tn, 0);

      for (const side of [-1, 1] as const) {
        const leg = new THREE.BoxGeometry(3.2, towerH, 4.2);
        const legPos = new THREE.Vector3(
          tx + rx * side * legHalfOffset,
          towerH * 0.5,
          tz + rz * side * legHalfOffset,
        );
        leg.applyMatrix4(
          new THREE.Matrix4().compose(legPos, bridgeQuat, new THREE.Vector3(1, 1, 1)),
        );
        setUniformVertexColor(leg, towerColor);
        solidParts.push(leg);
      }

      // Upper and deck-level crossbeams
      for (const beamY of [towerH - 4.0, bridge.deckElevationM + 10.0]) {
        const beam = new THREE.BoxGeometry(width + 6.5, 3.0, 3.2);
        beam.applyMatrix4(
          new THREE.Matrix4().compose(
            new THREE.Vector3(tx, beamY, tz),
            bridgeQuat,
            new THREE.Vector3(1, 1, 1),
          ),
        );
        setUniformVertexColor(beam, towerColor);
        solidParts.push(beam);
      }
    }

    // 3. Suspension cables & vertical suspenders along left & right edges
    if (bridge.towersEnu.length >= 2) {
      const t0 = enuToThree(bridge.towersEnu[0][0], bridge.towersEnu[0][1], towerH);
      const t1 = enuToThree(bridge.towersEnu[1][0], bridge.towersEnu[1][1], towerH);
      const anchor0 = enuToThree(spanA[0], spanA[1], bridge.deckElevationM);
      const anchor1 = enuToThree(spanB[0], spanB[1], bridge.deckElevationM);

      const pushSeg = (
        x0: number,
        y0: number,
        z0: number,
        x1: number,
        y1: number,
        z1: number,
      ): void => {
        cablePositions.push(x0, y0, z0, x1, y1, z1);
        cableColors.push(
          cableColor.r,
          cableColor.g,
          cableColor.b,
          cableColor.r,
          cableColor.g,
          cableColor.b,
        );
      };

      for (const side of [-1, 1] as const) {
        const offX = rx * side * legHalfOffset;
        const offZ = rz * side * legHalfOffset;

        // Backstays from anchorages to tower tops
        pushSeg(
          anchor0[0] + offX,
          anchor0[1],
          anchor0[2] + offZ,
          t0[0] + offX,
          t0[1],
          t0[2] + offZ,
        );
        pushSeg(
          t1[0] + offX,
          t1[1],
          t1[2] + offZ,
          anchor1[0] + offX,
          anchor1[1],
          anchor1[2] + offZ,
        );

        // Main parabolic catenary between the two towers + vertical suspenders
        const catSteps = 10;
        const sagM = Math.max(8, (towerH - bridge.deckElevationM) * 0.65);
        for (let s = 0; s < catSteps; s++) {
          const u0 = s / catSteps;
          const u1 = (s + 1) / catSteps;
          const ySag0 = 4 * u0 * (1 - u0) * sagM;
          const ySag1 = 4 * u1 * (1 - u1) * sagM;

          const p0x = t0[0] + (t1[0] - t0[0]) * u0 + offX;
          const p0y = towerH - ySag0;
          const p0z = t0[2] + (t1[2] - t0[2]) * u0 + offZ;

          const p1x = t0[0] + (t1[0] - t0[0]) * u1 + offX;
          const p1y = towerH - ySag1;
          const p1z = t0[2] + (t1[2] - t0[2]) * u1 + offZ;

          pushSeg(p0x, p0y, p0z, p1x, p1y, p1z);

          // Vertical suspender down to deck
          if (s > 0) {
            pushSeg(p0x, p0y, p0z, p0x, bridge.deckElevationM, p0z);
          }
        }
      }
    }
  }

  const solidGeom =
    solidParts.length > 0
      ? mergeBufferGeometries(solidParts)
      : new THREE.BoxGeometry(1, 1, 1);
  for (const p of solidParts) p.dispose();

  const cableGeom = new THREE.BufferGeometry();
  cableGeom.setAttribute('position', new THREE.Float32BufferAttribute(cablePositions, 3));
  cableGeom.setAttribute('color', new THREE.Float32BufferAttribute(cableColors, 3));
  cableGeom.computeBoundingSphere();

  return { solidGeom, cableGeom };
}

/**
 * Renders NYC geographic landmarks in 8 draw calls:
 * - 4 named translucent water meshes at exact Y === 0
 * - 1 merged LineSegments for all 5 borough shoreline outlines
 * - 1 LineSegments street-level reference grid at Y = 0.05
 * - 2 merged meshes for all 5 major bridges (solid decks/towers + suspension cables)
 */
export class LandmarkLayer {
  public readonly group: THREE.Group;

  private readonly waterMeshes: THREE.Mesh[] = [];
  private readonly waterMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly boroughLines: THREE.LineSegments;
  private readonly boroughMat: THREE.LineBasicMaterial;
  private readonly gridLines: THREE.LineSegments;
  private readonly gridMat: THREE.LineBasicMaterial;
  private readonly bridgeSolidMesh: THREE.Mesh;
  private readonly bridgeSolidMat: THREE.MeshLambertMaterial;
  private readonly bridgeCableLines: THREE.LineSegments;
  private readonly bridgeCableMat: THREE.LineBasicMaterial;
  private disposed = false;

  constructor(landmarks: LandmarkDataset) {
    this.group = new THREE.Group();
    this.group.name = 'landmark-layer';

    // 1. 4 named translucent water planes at exact Y === 0
    for (const water of landmarks.waterBodies) {
      const geom = buildWaterGeometry(water);
      const mat = new THREE.MeshBasicMaterial({
        color: water.color || '#1d6fa5',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = water.id;
      mesh.frustumCulled = true;

      this.waterMeshes.push(mesh);
      this.waterMaterials.push(mat);
      this.group.add(mesh);
    }

    // 2. Merged borough shoreline outlines
    const boroughGeom = buildBoroughOutlinesGeometry(landmarks.boroughs);
    this.boroughMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
    });
    this.boroughLines = new THREE.LineSegments(boroughGeom, this.boroughMat);
    this.boroughLines.name = 'landmark-borough-outlines';
    this.boroughLines.frustumCulled = false;

    // 3. Street-level reference grid (±12km, 500m spacing, Y = 0.05)
    const gridGeom = buildReferenceGridGeometry();
    this.gridMat = new THREE.LineBasicMaterial({
      color: 0x1e293b,
      transparent: true,
      opacity: 0.35,
    });
    this.gridLines = new THREE.LineSegments(gridGeom, this.gridMat);
    this.gridLines.name = 'landmark-reference-grid';
    this.gridLines.frustumCulled = false;

    // 4. Merged bridge silhouettes (solid decks + towers, suspension cables)
    const { solidGeom, cableGeom } = buildBridgesGeometries(landmarks.bridges);
    this.bridgeSolidMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
    this.bridgeSolidMesh = new THREE.Mesh(solidGeom, this.bridgeSolidMat);
    this.bridgeSolidMesh.name = 'landmark-bridges-solid';
    this.bridgeSolidMesh.frustumCulled = true;

    this.bridgeCableMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
    });
    this.bridgeCableLines = new THREE.LineSegments(cableGeom, this.bridgeCableMat);
    this.bridgeCableLines.name = 'landmark-bridges-cables';
    this.bridgeCableLines.frustumCulled = true;

    this.group.add(
      this.boroughLines,
      this.gridLines,
      this.bridgeSolidMesh,
      this.bridgeCableLines,
    );
  }

  public getWaterMeshes(): readonly THREE.Mesh[] {
    return this.waterMeshes;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const mesh of this.waterMeshes) {
      mesh.geometry.dispose();
    }
    for (const mat of this.waterMaterials) {
      mat.dispose();
    }

    this.boroughLines.geometry.dispose();
    this.boroughMat.dispose();
    this.gridLines.geometry.dispose();
    this.gridMat.dispose();
    this.bridgeSolidMesh.geometry.dispose();
    this.bridgeSolidMat.dispose();
    this.bridgeCableLines.geometry.dispose();
    this.bridgeCableMat.dispose();
  }
}
