import * as THREE from 'three';
import type { ViewMode, WorldStateSnapshot } from '../types/state';
import type { TransitDataset } from '../types/transit';
import { CameraController, DEFAULT_FOV_DEG } from './CameraController';
import { CarInteriorLayer } from './CarInteriorLayer';
import { LandmarkLayer } from './LandmarkLayer';
import { StructureLayer } from './StructureLayer';
import { TrackLayer } from './TrackLayer';
import { TrainLayer } from './TrainLayer';

const FLOATING_ORIGIN_THRESHOLD_M = 5000;
const SCENE_BG_HEX = 0x0b1120;
const FOG_DENSITY = 0.00045;
const CAMERA_NEAR_M = 0.15;
const CAMERA_FAR_M = 6000;

export interface SceneManagerOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

export interface CameraDebugInfo {
  yaw: number;
  pitch: number;
  position: [number, number, number];
  viewMode: string;
  drawCalls: number;
  frameCount: number;
}

/**
 * Main Three.js WebGL2 scene orchestrator for SubwaySight 3D.
 * Enforces DPR 1, no shadows, no stencil, FogExp2, floating-origin rebasing (>5 km),
 * WebGL context-loss recovery, document visibility pause, and zero per-frame allocations.
 */
export class SceneManager {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cameraController: CameraController;

  private readonly worldGroup: THREE.Group;
  private readonly carInteriorLayer: CarInteriorLayer;
  private readonly trackLayer: TrackLayer;
  private readonly trainLayer: TrainLayer;
  private readonly structureLayer: StructureLayer;
  private readonly landmarkLayer: LandmarkLayer;

  private readonly options: SceneManagerOptions;
  private readonly originOffset = new THREE.Vector3(0, 0, 0);
  private readonly scratchEgoLocalPos = new THREE.Vector3(0, 0, 0);

  private resizeObserver: ResizeObserver | null = null;
  private contextLost = false;
  private isPausedByVisibility = false;
  private disposed = false;

  private lastDrawCalls = 0;
  private frameCount = 0;

  constructor(
    canvas: HTMLCanvasElement,
    dataset: TransitDataset,
    options?: SceneManagerOptions,
  ) {
    this.canvas = canvas;
    this.options = options ?? {};

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.shadowMap.enabled = false;
    this.renderer.setPixelRatio(1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SCENE_BG_HEX);
    this.scene.fog = new THREE.FogExp2(SCENE_BG_HEX, FOG_DENSITY);

    const hemiLight = new THREE.HemisphereLight(0xcbd5e1, 0x1e293b, 1.15);
    const dirLight = new THREE.DirectionalLight(0xf8fafc, 0.85);
    dirLight.position.set(180, 320, 140);
    this.scene.add(hemiLight, dirLight);

    const initW = Math.max(1, canvas.clientWidth || canvas.width || window.innerWidth || 1);
    const initH = Math.max(1, canvas.clientHeight || canvas.height || window.innerHeight || 1);
    this.camera = new THREE.PerspectiveCamera(
      DEFAULT_FOV_DEG,
      initW / initH,
      CAMERA_NEAR_M,
      CAMERA_FAR_M,
    );
    this.renderer.setSize(initW, initH, false);

    this.cameraController = new CameraController(this.camera, canvas);

    // Static world layers shifted together by floating-origin offset
    this.worldGroup = new THREE.Group();
    this.worldGroup.name = 'floating-origin-world';

    this.trackLayer = new TrackLayer(dataset.tracks);
    this.structureLayer = new StructureLayer(dataset);
    this.landmarkLayer = new LandmarkLayer(dataset.landmarks);
    this.worldGroup.add(
      this.trackLayer.group,
      this.structureLayer.group,
      this.landmarkLayer.group,
    );
    this.scene.add(this.worldGroup);

    // Dynamic layers rendered directly in floating-origin local space
    this.carInteriorLayer = new CarInteriorLayer();
    this.trainLayer = new TrainLayer();
    this.scene.add(this.carInteriorLayer.group, this.trainLayer.group);

    // Lifecycle & resize listeners
    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    window.addEventListener('resize', this.onResize, false);

    if (typeof document !== 'undefined') {
      this.isPausedByVisibility = Boolean(document.hidden);
      document.addEventListener('visibilitychange', this.onVisibilityChange, false);
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.onResize();
      });
      this.resizeObserver.observe(this.canvas);
    }
  }

  public update(snapshot: WorldStateSnapshot, dtSec: number): void {
    if (this.disposed) return;

    const inTrain = !snapshot.ego.outOfNyc && snapshot.ego.routeId !== null;
    const egoEnu = snapshot.ego.positionEnu;
    const egoWorldX = snapshot.ego.outOfNyc
      ? 0
      : Number.isFinite(egoEnu[0])
        ? egoEnu[0]
        : 0;
    const rawWorldY = Number.isFinite(egoEnu[2]) ? egoEnu[2] : 0;
    const egoWorldY = snapshot.ego.outOfNyc
      ? 140
      : inTrain
        ? rawWorldY
        : Math.max(rawWorldY, 45);
    const egoWorldZ = snapshot.ego.outOfNyc
      ? 0
      : Number.isFinite(egoEnu[1])
        ? egoEnu[1] === 0
          ? 0
          : -egoEnu[1]
        : 0;

    // Floating-origin rebase when horizontal distance from chunk origin exceeds 5 km
    const dxOrigin = egoWorldX - this.originOffset.x;
    const dzOrigin = egoWorldZ - this.originOffset.z;
    if (Math.hypot(dxOrigin, dzOrigin) > FLOATING_ORIGIN_THRESHOLD_M) {
      this.originOffset.set(egoWorldX, 0, egoWorldZ);
      this.worldGroup.position.set(-this.originOffset.x, 0, -this.originOffset.z);
    }

    this.scratchEgoLocalPos.set(
      egoWorldX - this.originOffset.x,
      egoWorldY - this.originOffset.y,
      egoWorldZ - this.originOffset.z,
    );

    const viewMode = this.cameraController.getViewMode();

    this.cameraController.update(
      this.scratchEgoLocalPos,
      inTrain ? snapshot.ego.headingRad : 0,
      inTrain ? snapshot.ego.pitchRad : snapshot.ego.outOfNyc ? -0.35 : -0.25,
      dtSec,
    );

    this.carInteriorLayer.group.visible = inTrain;
    if (inTrain) {
      this.carInteriorLayer.update(
        this.scratchEgoLocalPos,
        snapshot.ego.headingRad,
        snapshot.ego.pitchRad,
        viewMode,
      );
    }

    this.trainLayer.update(snapshot, viewMode, this.originOffset);

    if (this.contextLost || this.isPausedByVisibility) {
      return;
    }

    this.renderer.render(this.scene, this.camera);
    this.lastDrawCalls = this.renderer.info.render.calls;
    this.frameCount++;
  }

  public setViewMode(mode: ViewMode): void {
    this.cameraController.setViewMode(mode);
    this.carInteriorLayer.setViewMode(mode);
    this.structureLayer.setViewMode(mode);
  }

  public setGyroEnabled(enabled: boolean): void {
    this.cameraController.setGyroEnabled(enabled);
  }

  public handleDeviceOrientation(
    alpha: number,
    beta: number,
    gamma: number,
    screenAngleDeg: number,
  ): void {
    this.cameraController.handleDeviceOrientation(alpha, beta, gamma, screenAngleDeg);
  }

  public resetCameraView(): void {
    this.cameraController.resetCameraView();
  }

  public getCameraDebug(): CameraDebugInfo {
    const angles = this.cameraController.getDebugAngles();
    return {
      yaw: angles.yaw,
      pitch: angles.pitch,
      position: [
        this.camera.position.x + this.originOffset.x,
        this.camera.position.y + this.originOffset.y,
        this.camera.position.z + this.originOffset.z,
      ],
      viewMode: this.cameraController.getViewMode(),
      drawCalls: this.lastDrawCalls,
      frameCount: this.frameCount,
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    window.removeEventListener('resize', this.onResize, false);

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange, false);
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.cameraController.dispose();
    this.carInteriorLayer.dispose();
    this.trackLayer.dispose();
    this.trainLayer.dispose();
    this.structureLayer.dispose();
    this.landmarkLayer.dispose();
    this.renderer.dispose();
  }

  private readonly onResize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.width || 1);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.height || 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    if (this.frameCount > 0 && !this.contextLost && !this.isPausedByVisibility) {
      this.renderer.render(this.scene, this.camera);
    }
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.options.onContextLost?.();
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.onResize();
    this.options.onContextRestored?.();
  };

  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined') {
      this.isPausedByVisibility = Boolean(document.hidden);
    }
  };
}
