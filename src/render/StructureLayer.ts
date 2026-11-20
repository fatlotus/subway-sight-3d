import * as THREE from 'three';
import { enuToThree, samplePolylineAtS } from '../geo/projection';
import type { ViewMode } from '../types/state';
import type { Station, TrackPolyline, TransitDataset } from '../types/transit';
import { computeTrackQuaternion } from './CameraController';
import { mergeBufferGeometries, setUniformVertexColor } from './geometryUtils';

const MAX_TUNNEL_RIBS = 2500;
const MAX_VIADUCT_COLUMNS = 800;

const TUNNEL_STEP_M = 50;
const VIADUCT_STEP_M = 48;

const NORMAL_TUNNEL_OPACITY = 0.72;
const GHOST_TUNNEL_OPACITY = 0.18;

const PLATFORM_LENGTH_M = 110;
const PLATFORM_WIDTH_M = 4.2;
const PLATFORM_HEIGHT_M = 1.15;
const PLATFORM_LATERAL_OFFSET_M = 3.6;

const SIGN_WIDTH_M = 5.4;
const SIGN_HEIGHT_M = 1.15;
const SIGN_Y_OFFSET_M = 3.65;

const ROUTE_BADGE_COLORS: Record<string, string> = {
  '1': '#EE352E',
  '2': '#EE352E',
  '3': '#EE352E',
  '4': '#00933C',
  '5': '#00933C',
  '6': '#00933C',
  '7': '#B933AD',
  A: '#0039A6',
  C: '#0039A6',
  E: '#0039A6',
  B: '#FF6319',
  D: '#FF6319',
  F: '#FF6319',
  M: '#FF6319',
  N: '#FCCC0A',
  Q: '#FCCC0A',
  R: '#FCCC0A',
  W: '#FCCC0A',
  L: '#A7A9AC',
  G: '#6CBE45',
  J: '#996633',
  Z: '#996633',
};

function spatialKey(e: number, n: number, u: number): string {
  return `${Math.round(e / 14)},${Math.round(n / 14)},${Math.round(u / 6)}`;
}

function buildTunnelRibGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const halfSpan = 2.45;
  const wallH = 4.35;
  const thick = 0.36;
  const depth = 0.48;

  // Left & right vertical ribs
  const left = new THREE.BoxGeometry(thick, wallH, depth);
  left.translate(-halfSpan, wallH * 0.5, 0);
  parts.push(left);

  const right = new THREE.BoxGeometry(thick, wallH, depth);
  right.translate(halfSpan, wallH * 0.5, 0);
  parts.push(right);

  // Full-span crown beam forming a stylized tunnel portal frame
  const crown = new THREE.BoxGeometry(halfSpan * 2 + thick, thick, depth);
  crown.translate(0, wallH + thick * 0.5, 0);
  parts.push(crown);

  const merged = mergeBufferGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

function buildViaductBentGeometry(): THREE.BufferGeometry {
  // Unit height (y in [0, 1]) so each instance scales Y to rail elevation
  const parts: THREE.BufferGeometry[] = [];

  const leftCol = new THREE.BoxGeometry(0.65, 1.0, 0.65);
  leftCol.translate(-1.9, 0.5, 0);
  parts.push(leftCol);

  const rightCol = new THREE.BoxGeometry(0.65, 1.0, 0.65);
  rightCol.translate(1.9, 0.5, 0);
  parts.push(rightCol);

  const crossBeam = new THREE.BoxGeometry(4.8, 0.08, 0.85);
  crossBeam.translate(0, 0.96, 0);
  parts.push(crossBeam);

  const merged = mergeBufferGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

function buildPlatformGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Main concrete platform slab
  const slab = new THREE.BoxGeometry(PLATFORM_WIDTH_M, PLATFORM_HEIGHT_M, PLATFORM_LENGTH_M);
  slab.translate(0, PLATFORM_HEIGHT_M * 0.5, 0);
  setUniformVertexColor(slab, new THREE.Color(0x64748b));
  parts.push(slab);

  // Yellow tactile safety strip along the track-facing edge (-X side)
  const strip = new THREE.BoxGeometry(0.42, 0.05, PLATFORM_LENGTH_M);
  strip.translate(-PLATFORM_WIDTH_M * 0.5 + 0.24, PLATFORM_HEIGHT_M + 0.025, 0);
  setUniformVertexColor(strip, new THREE.Color(0xfacc15));
  parts.push(strip);

  const merged = mergeBufferGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

function createStationSignAtlasTexture(
  stations: readonly Station[],
  cols: number,
  rows: number,
): THREE.Texture {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    const cellW = 128;
    const cellH = 32;
    canvas.width = cols * cellW;
    canvas.height = rows * cellH;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      ctx.fillStyle = '#0b0f17';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < stations.length; i++) {
        const st = stations[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = col * cellW;
        const y = row * cellH;

        // MTA-style black plate with thin white top rule
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(x + 2, y + 4, cellW - 4, 2);

        // Station name in system sans-serif (zero external fonts)
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textBaseline = 'top';
        const label = st.name.length > 16 ? `${st.name.slice(0, 15)}…` : st.name;
        ctx.fillText(label, x + 5, y + 8);

        // Up to 4 colored route bullets
        const routes = st.routes.slice(0, 4);
        for (let r = 0; r < routes.length; r++) {
          const routeId = routes[r];
          const bx = x + 10 + r * 14;
          const by = y + 25;
          ctx.fillStyle = ROUTE_BADGE_COLORS[routeId] ?? '#38bdf8';
          ctx.beginPath();
          ctx.arc(bx, by, 5, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = routeId === 'N' || routeId === 'Q' || routeId === 'R' || routeId === 'W'
            ? '#0f172a'
            : '#ffffff';
          ctx.font = 'bold 7px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(routeId.slice(0, 2), bx, by + 0.5);
          ctx.textAlign = 'left';
        }
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      return tex;
    }
  }

  // Node / headless Vitest fallback: 4x4 RGBA DataTexture
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    const idx = i * 4;
    data[idx] = 15;
    data[idx + 1] = 23;
    data[idx + 2] = 42;
    data[idx + 3] = 255;
  }
  const fallbackTex = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat);
  fallbackTex.needsUpdate = true;
  return fallbackTex;
}

/**
 * Renders NYC transit infrastructure in 4 draw calls:
 * 1) Tunnel arch ribs (InstancedMesh, ghost cutaway opacity support)
 * 2) Elevated viaduct columns/bents (InstancedMesh)
 * 3) Station platforms with tactile strips (InstancedMesh)
 * 4) Procedural canvas-textured station signs (1 merged Mesh + 1 atlas texture)
 */
export class StructureLayer {
  public readonly group: THREE.Group;

  private readonly tunnelRibsMesh: THREE.InstancedMesh;
  private readonly viaductColumnsMesh: THREE.InstancedMesh;
  private readonly platformsMesh: THREE.InstancedMesh;
  private readonly signsMesh: THREE.Mesh;

  private readonly tunnelMat: THREE.MeshLambertMaterial;
  private readonly viaductMat: THREE.MeshLambertMaterial;
  private readonly platformMat: THREE.MeshLambertMaterial;
  private readonly signsMat: THREE.MeshBasicMaterial;
  private readonly signsTexture: THREE.Texture;

  private currentMode: ViewMode = 'inside';
  private disposed = false;

  constructor(dataset: TransitDataset) {
    this.group = new THREE.Group();
    this.group.name = 'structure-layer';

    const dummyMatrix = new THREE.Matrix4();
    const dummyPos = new THREE.Vector3();
    const dummyQuat = new THREE.Quaternion();
    const dummyScale = new THREE.Vector3(1, 1, 1);

    // --- 1 & 2. Sample tunnel arch ribs & elevated viaduct columns ---
    const tunnelGeom = buildTunnelRibGeometry();
    this.tunnelMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: NORMAL_TUNNEL_OPACITY,
      depthWrite: true,
    });
    this.tunnelRibsMesh = new THREE.InstancedMesh(
      tunnelGeom,
      this.tunnelMat,
      MAX_TUNNEL_RIBS,
    );
    this.tunnelRibsMesh.name = 'structure-tunnel-ribs';
    this.tunnelRibsMesh.frustumCulled = false;

    const viaductGeom = buildViaductBentGeometry();
    this.viaductMat = new THREE.MeshLambertMaterial({
      color: 0x475569,
    });
    this.viaductColumnsMesh = new THREE.InstancedMesh(
      viaductGeom,
      this.viaductMat,
      MAX_VIADUCT_COLUMNS,
    );
    this.viaductColumnsMesh.name = 'structure-viaduct-columns';
    this.viaductColumnsMesh.frustumCulled = false;

    const tunnelVisited = new Set<string>();
    const viaductVisited = new Set<string>();
    const undergroundColor = new THREE.Color(0x334155);
    const underwaterColor = new THREE.Color(0x38617a);

    let tunnelCount = 0;
    let viaductCount = 0;

    for (const track of dataset.tracks) {
      if (track.points.length < 2) continue;

      for (let s = 0; s <= track.totalLengthM; s += TUNNEL_STEP_M) {
        if (tunnelCount >= MAX_TUNNEL_RIBS) break;
        const sampled = samplePolylineAtS(track.points, s);
        if (
          sampled.structure !== 'UNDERGROUND_TUNNEL' &&
          sampled.structure !== 'UNDERWATER_TUNNEL'
        ) {
          continue;
        }
        const key = spatialKey(sampled.enu[0], sampled.enu[1], sampled.enu[2]);
        if (tunnelVisited.has(key)) continue;
        tunnelVisited.add(key);

        const [tx, ty, tz] = enuToThree(sampled.enu[0], sampled.enu[1], sampled.enu[2]);
        dummyPos.set(tx, ty, tz);
        computeTrackQuaternion(sampled.headingRad, sampled.pitchRad, dummyQuat);
        dummyScale.set(1, 1, 1);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);

        this.tunnelRibsMesh.setMatrixAt(tunnelCount, dummyMatrix);
        this.tunnelRibsMesh.setColorAt(
          tunnelCount,
          sampled.structure === 'UNDERWATER_TUNNEL' ? underwaterColor : undergroundColor,
        );
        tunnelCount++;
      }

      for (let s = 0; s <= track.totalLengthM; s += VIADUCT_STEP_M) {
        if (viaductCount >= MAX_VIADUCT_COLUMNS) break;
        const sampled = samplePolylineAtS(track.points, s);
        if (sampled.structure !== 'ELEVATED' || sampled.enu[2] <= 2) {
          continue;
        }
        const key = spatialKey(sampled.enu[0], sampled.enu[1], sampled.enu[2]);
        if (viaductVisited.has(key)) continue;
        viaductVisited.add(key);

        const [tx, ty, tz] = enuToThree(sampled.enu[0], sampled.enu[1], sampled.enu[2]);
        const colHeight = Math.max(1.5, ty - 0.25);
        dummyPos.set(tx, 0, tz);
        computeTrackQuaternion(sampled.headingRad, 0, dummyQuat);
        dummyScale.set(1, colHeight, 1);
        dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);

        this.viaductColumnsMesh.setMatrixAt(viaductCount, dummyMatrix);
        viaductCount++;
      }
    }

    this.tunnelRibsMesh.count = tunnelCount;
    this.tunnelRibsMesh.instanceMatrix.needsUpdate = true;
    if (this.tunnelRibsMesh.instanceColor) {
      this.tunnelRibsMesh.instanceColor.needsUpdate = true;
    }

    this.viaductColumnsMesh.count = viaductCount;
    this.viaductColumnsMesh.instanceMatrix.needsUpdate = true;

    // --- 3 & 4. Station platforms & procedural canvas-textured signs ---
    const stationOrientation = this.computeStationOrientations(dataset.tracks);
    const stationCount = Math.max(1, dataset.stations.length);

    const platformGeom = buildPlatformGeometry();
    this.platformMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });
    this.platformsMesh = new THREE.InstancedMesh(
      platformGeom,
      this.platformMat,
      stationCount,
    );
    this.platformsMesh.name = 'structure-station-platforms';
    this.platformsMesh.frustumCulled = false;

    const cols = 16;
    const rows = Math.max(1, Math.ceil(dataset.stations.length / cols));
    this.signsTexture = createStationSignAtlasTexture(dataset.stations, cols, rows);

    const signGeoms: THREE.BufferGeometry[] = [];
    const rightVec = new THREE.Vector3();

    for (let i = 0; i < dataset.stations.length; i++) {
      const st = dataset.stations[i];
      const orient = stationOrientation.get(st.id) ?? {
        headingRad: 0,
        pitchRad: 0,
        sideSign: 1,
      };

      const [sx, sy, sz] = enuToThree(st.enu[0], st.enu[1], st.enu[2]);
      computeTrackQuaternion(orient.headingRad, 0, dummyQuat);

      // Lateral offset to right or left of rail centerline
      rightVec.set(orient.sideSign * PLATFORM_LATERAL_OFFSET_M, 0, 0).applyQuaternion(dummyQuat);
      dummyPos.set(sx + rightVec.x, sy, sz + rightVec.z);
      dummyScale.set(orient.sideSign, 1, 1);
      dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
      this.platformsMesh.setMatrixAt(i, dummyMatrix);

      // Build station sign quad mapped to its UV cell in the atlas
      const col = i % cols;
      const row = Math.floor(i / cols);
      const u0 = col / cols;
      const u1 = (col + 1) / cols;
      const v1 = 1 - row / rows;
      const v0 = 1 - (row + 1) / rows;

      const plane = new THREE.PlaneGeometry(SIGN_WIDTH_M, SIGN_HEIGHT_M);
      const uvAttr = plane.getAttribute('uv');
      // PlaneGeometry vertex order: 0=TL, 1=TR, 2=BL, 3=BR
      uvAttr.setXY(0, u0, v1);
      uvAttr.setXY(1, u1, v1);
      uvAttr.setXY(2, u0, v0);
      uvAttr.setXY(3, u1, v0);

      // Rotate sign to face the track (+X / -X) and mount above platform
      plane.rotateY(orient.sideSign > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
      const signMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(
          sx + rightVec.x * 0.85,
          sy + SIGN_Y_OFFSET_M,
          sz + rightVec.z * 0.85,
        ),
        dummyQuat,
        new THREE.Vector3(1, 1, 1),
      );
      plane.applyMatrix4(signMatrix);
      signGeoms.push(plane);
    }

    this.platformsMesh.count = dataset.stations.length;
    this.platformsMesh.instanceMatrix.needsUpdate = true;

    const mergedSignsGeom =
      signGeoms.length > 0
        ? mergeBufferGeometries(signGeoms)
        : new THREE.PlaneGeometry(1, 1);
    for (const g of signGeoms) g.dispose();

    this.signsMat = new THREE.MeshBasicMaterial({
      map: this.signsTexture,
      side: THREE.DoubleSide,
    });
    this.signsMesh = new THREE.Mesh(mergedSignsGeom, this.signsMat);
    this.signsMesh.name = 'structure-station-signs';
    this.signsMesh.frustumCulled = false;

    this.group.add(
      this.tunnelRibsMesh,
      this.viaductColumnsMesh,
      this.platformsMesh,
      this.signsMesh,
    );
  }

  public setViewMode(mode: ViewMode): void {
    if (this.currentMode === mode) return;
    this.currentMode = mode;

    if (mode === 'ghost') {
      this.tunnelMat.opacity = GHOST_TUNNEL_OPACITY;
      this.tunnelMat.depthWrite = false;
    } else {
      this.tunnelMat.opacity = NORMAL_TUNNEL_OPACITY;
      this.tunnelMat.depthWrite = true;
    }
  }

  public getTunnelOpacity(): number {
    return this.tunnelMat.opacity;
  }

  public getTunnelDepthWrite(): boolean {
    return this.tunnelMat.depthWrite;
  }

  public getCounts(): {
    tunnelRibs: number;
    viaductColumns: number;
    platforms: number;
  } {
    return {
      tunnelRibs: this.tunnelRibsMesh.count,
      viaductColumns: this.viaductColumnsMesh.count,
      platforms: this.platformsMesh.count,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.tunnelRibsMesh.geometry.dispose();
    this.viaductColumnsMesh.geometry.dispose();
    this.platformsMesh.geometry.dispose();
    this.signsMesh.geometry.dispose();

    this.tunnelMat.dispose();
    this.viaductMat.dispose();
    this.platformMat.dispose();
    this.signsMat.dispose();
    this.signsTexture.dispose();
  }

  private computeStationOrientations(
    tracks: readonly TrackPolyline[],
  ): Map<string, { headingRad: number; pitchRad: number; sideSign: number }> {
    const map = new Map<string, { headingRad: number; pitchRad: number; sideSign: number }>();
    for (const track of tracks) {
      if (track.points.length < 2) continue;
      for (const ref of track.stations) {
        if (map.has(ref.stationId)) continue;
        const sampled = samplePolylineAtS(track.points, ref.s);
        const sideSign = ref.platformSide === 'LEFT' ? -1 : 1;
        map.set(ref.stationId, {
          headingRad: sampled.headingRad,
          pitchRad: sampled.pitchRad,
          sideSign,
        });
      }
    }
    return map;
  }
}
