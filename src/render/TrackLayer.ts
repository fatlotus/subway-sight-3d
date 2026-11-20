import * as THREE from 'three';
import { enuToThree } from '../geo/projection';
import type { TrackPolyline } from '../types/transit';

const MAX_SUBDIV_STEP_M = 100;
const MTA_BED_WIDTH_M = 2.6;
const REGIONAL_BED_WIDTH_M = 3.0;
const BED_Y_OFFSET_M = -0.15;

const RAIL_WIDTH_M = 0.18;
const RAIL_HALF_GAUGE_M = 0.72;
const RAIL_Y_OFFSET_M = 0.04;

const ACCENT_WIDTH_M = 0.16;
const ACCENT_Y_OFFSET_M = 0.025;

interface RibbonBuffers {
  positions: number[];
  colors: number[];
}

function appendRibbonQuad(
  buf: RibbonBuffers,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  rx: number,
  rz: number,
  lateralCenter: number,
  halfWidth: number,
  r: number,
  g: number,
  b: number,
): void {
  const leftOff = lateralCenter - halfWidth;
  const rightOff = lateralCenter + halfWidth;

  const aLx = ax + rx * leftOff;
  const aLz = az + rz * leftOff;
  const aRx = ax + rx * rightOff;
  const aRz = az + rz * rightOff;

  const bLx = bx + rx * leftOff;
  const bLz = bz + rz * leftOff;
  const bRx = bx + rx * rightOff;
  const bRz = bz + rz * rightOff;

  // Triangle 1: aL, bL, bR
  buf.positions.push(aLx, ay, aLz, bLx, by, bLz, bRx, by, bRz);
  // Triangle 2: aL, bR, aR
  buf.positions.push(aLx, ay, aLz, bRx, by, bRz, aRx, ay, aRz);

  for (let i = 0; i < 6; i++) {
    buf.colors.push(r, g, b);
  }
}

function buildBufferGeometry(buf: RibbonBuffers): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Renders all MTA and regional rail corridors in 2 merged draw calls:
 * 1) Track bed ribbons (darkened trunk color)
 * 2) Twin running rails (brightened for dark-tunnel legibility) + express/commuter center accent
 */
export class TrackLayer {
  public readonly group: THREE.Group;

  private readonly bedMesh: THREE.Mesh;
  private readonly railsMesh: THREE.Mesh;
  private readonly bedMat: THREE.MeshBasicMaterial;
  private readonly railsMat: THREE.MeshBasicMaterial;
  private disposed = false;

  constructor(tracks: readonly TrackPolyline[]) {
    this.group = new THREE.Group();
    this.group.name = 'track-layer';

    const bedBuf: RibbonBuffers = { positions: [], colors: [] };
    const railBuf: RibbonBuffers = { positions: [], colors: [] };

    const baseColor = new THREE.Color();
    const bedColor = new THREE.Color();
    const railColor = new THREE.Color();
    const accentColor = new THREE.Color();
    const darkSlate = new THREE.Color(0x111827);
    const white = new THREE.Color(0xffffff);

    for (const track of tracks) {
      if (track.points.length < 2) continue;

      baseColor.set(track.color || '#94a3b8');
      bedColor.copy(baseColor).lerp(darkSlate, 0.62);
      railColor.copy(baseColor).lerp(white, 0.45);
      accentColor.copy(baseColor).lerp(white, 0.25);

      const bedHalfW =
        (track.system === 'MTA' ? MTA_BED_WIDTH_M : REGIONAL_BED_WIDTH_M) * 0.5;
      const railHalfW = RAIL_WIDTH_M * 0.5;
      const accentHalfW = ACCENT_WIDTH_M * 0.5;
      const hasCenterAccent =
        track.serviceType === 'EXPRESS' || track.serviceType === 'COMMUTER';

      for (let i = 0; i < track.points.length - 1; i++) {
        const p0 = track.points[i].enu;
        const p1 = track.points[i + 1].enu;
        const [x0, y0, z0] = enuToThree(p0[0], p0[1], p0[2]);
        const [x1, y1, z1] = enuToThree(p1[0], p1[1], p1[2]);

        const dx = x1 - x0;
        const dy = y1 - y0;
        const dz = z1 - z0;
        const segLen = Math.hypot(dx, dy, dz);
        const horizLen = Math.hypot(dx, dz);
        if (segLen < 1e-4 || horizLen < 1e-4) continue;

        // Right-hand horizontal perpendicular in Three.js XZ plane
        const rx = -dz / horizLen;
        const rz = dx / horizLen;

        const steps = Math.max(1, Math.ceil(segLen / MAX_SUBDIV_STEP_M));
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps;
          const t1 = (s + 1) / steps;
          const ax = x0 + dx * t0;
          const ay = y0 + dy * t0;
          const az = z0 + dz * t0;
          const bx = x0 + dx * t1;
          const by = y0 + dy * t1;
          const bz = z0 + dz * t1;

          // 1. Track bed ribbon
          appendRibbonQuad(
            bedBuf,
            ax,
            ay + BED_Y_OFFSET_M,
            az,
            bx,
            by + BED_Y_OFFSET_M,
            bz,
            rx,
            rz,
            0,
            bedHalfW,
            bedColor.r,
            bedColor.g,
            bedColor.b,
          );

          // 2. Twin running rails
          appendRibbonQuad(
            railBuf,
            ax,
            ay + RAIL_Y_OFFSET_M,
            az,
            bx,
            by + RAIL_Y_OFFSET_M,
            bz,
            rx,
            rz,
            -RAIL_HALF_GAUGE_M,
            railHalfW,
            railColor.r,
            railColor.g,
            railColor.b,
          );
          appendRibbonQuad(
            railBuf,
            ax,
            ay + RAIL_Y_OFFSET_M,
            az,
            bx,
            by + RAIL_Y_OFFSET_M,
            bz,
            rx,
            rz,
            RAIL_HALF_GAUGE_M,
            railHalfW,
            railColor.r,
            railColor.g,
            railColor.b,
          );

          if (hasCenterAccent) {
            appendRibbonQuad(
              railBuf,
              ax,
              ay + ACCENT_Y_OFFSET_M,
              az,
              bx,
              by + ACCENT_Y_OFFSET_M,
              bz,
              rx,
              rz,
              0,
              accentHalfW,
              accentColor.r,
              accentColor.g,
              accentColor.b,
            );
          }
        }
      }
    }

    const bedGeom = buildBufferGeometry(bedBuf);
    const railsGeom = buildBufferGeometry(railBuf);

    this.bedMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.railsMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    this.bedMesh = new THREE.Mesh(bedGeom, this.bedMat);
    this.bedMesh.name = 'track-beds';
    this.bedMesh.frustumCulled = false;

    this.railsMesh = new THREE.Mesh(railsGeom, this.railsMat);
    this.railsMesh.name = 'track-rails';
    this.railsMesh.frustumCulled = false;

    this.group.add(this.bedMesh, this.railsMesh);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.bedMesh.geometry.dispose();
    this.railsMesh.geometry.dispose();
    this.bedMat.dispose();
    this.railsMat.dispose();
  }
}
