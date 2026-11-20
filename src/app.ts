import { getTransitDataset } from './data/dataset';
import { TrackParticleFilter } from './localization/particleFilter';
import {
  type ConnectivityStatus,
  registerServiceWorker,
  type SwController,
} from './pwa/registerSw';
import {
  clearCalibration,
  loadLatestCalibration,
  loadSettings,
  saveCalibration,
  saveSettings,
} from './pwa/storage';
import {
  createWakeLockController,
  type WakeLockController,
} from './pwa/wakeLock';
import { SceneManager, type SceneManagerOptions } from './render/SceneManager';
import { LiveSensorSource } from './sensors/liveSensorSource';
import {
  DeterministicSimSource,
  isValidDemoScenarioId,
} from './sensors/simSensorSource';
import { buildWorldStateSnapshot } from './traffic/trafficEngine';
import type { DemoScenarioId, SensorMode, SensorSample } from './types/sensors';
import type {
  DebugSnapshot,
  ViewMode,
  WorldStateSnapshot,
} from './types/state';
import type { TransitDataset } from './types/transit';
import { FallbackView } from './ui/fallbackView';
import { type CalibrationSelection, HudController } from './ui/HudController';

export interface SceneManagerLike {
  update(snapshot: WorldStateSnapshot, dtSec: number): void;
  setViewMode(mode: ViewMode): void;
  setGyroEnabled(enabled: boolean): void;
  handleDeviceOrientation(
    alpha: number,
    beta: number,
    gamma: number,
    screenAngleDeg: number,
  ): void;
  resetCameraView(): void;
  getCameraDebug(): {
    yaw: number;
    pitch: number;
    position: [number, number, number];
    viewMode: string;
    drawCalls: number;
    frameCount: number;
  };
  dispose(): void;
}

export interface SubwaySightAppOptions {
  dataset?: TransitDataset;
  doc?: Document;
  createSceneManager?: (
    canvas: HTMLCanvasElement,
    dataset: TransitDataset,
    options?: SceneManagerOptions,
  ) => SceneManagerLike;
  registerSw?: () => SwController;
  createWakeLock?: () => WakeLockController;
  /** Maximum age of persisted calibration to auto-restore on live startup (default: 12h). */
  calibrationMaxAgeMs?: number;
}

const DEFAULT_CALIBRATION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const LIVE_HEARTBEAT_MS = 1000;
const MAX_DT_SEC = 0.1;

function getScreenAngleDeg(): number {
  if (typeof window === 'undefined') return 0;
  if (
    typeof screen !== 'undefined' &&
    screen.orientation &&
    typeof screen.orientation.angle === 'number'
  ) {
    return screen.orientation.angle;
  }
  const legacyAngle = (window as unknown as { orientation?: number }).orientation;
  return typeof legacyAngle === 'number' && Number.isFinite(legacyAngle)
    ? legacyAngle
    : 0;
}

function nowPerfMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

type IosPermissionState = 'granted' | 'denied';
interface IosPermissionEventCtor {
  requestPermission?: () => Promise<IosPermissionState>;
}

/**
 * Synchronously invokes BOTH DeviceMotionEvent.requestPermission() and
 * DeviceOrientationEvent.requestPermission() in the same user-gesture tick
 * before awaiting either, preserving iOS 13+ Safari user-activation tokens.
 */
function requestIosGyroPermissionsSync(): Promise<IosPermissionState> {
  if (typeof globalThis === 'undefined') {
    return Promise.resolve('denied');
  }
  const g = globalThis as unknown as {
    DeviceMotionEvent?: IosPermissionEventCtor;
    DeviceOrientationEvent?: IosPermissionEventCtor;
  };
  const motionReq =
    typeof g.DeviceMotionEvent?.requestPermission === 'function'
      ? g.DeviceMotionEvent.requestPermission.bind(g.DeviceMotionEvent)
      : null;
  const orientReq =
    typeof g.DeviceOrientationEvent?.requestPermission === 'function'
      ? g.DeviceOrientationEvent.requestPermission.bind(g.DeviceOrientationEvent)
      : null;

  if (!motionReq && !orientReq) {
    return Promise.resolve('granted');
  }

  const promises: Array<Promise<IosPermissionState>> = [];
  let syncFailed = false;

  if (motionReq) {
    try {
      promises.push(Promise.resolve(motionReq()));
    } catch {
      syncFailed = true;
    }
  }

  if (orientReq) {
    try {
      promises.push(Promise.resolve(orientReq()));
    } catch {
      syncFailed = true;
    }
  }

  if (syncFailed) {
    for (const p of promises) {
      void p.catch(() => {});
    }
    return Promise.resolve('denied');
  }

  return Promise.all(promises)
    .then((results) =>
      results.every((res) => res === 'granted') ? 'granted' : 'denied',
    )
    .catch(() => 'denied');
}

/**
 * Main SubwaySight 3D application controller wiring sensors, localization, traffic,
 * 3D WebGL renderer, mobile HUD, PWA offline services, and debug telemetry snapshot.
 */
export class SubwaySightApp {
  private readonly container: HTMLElement;
  private readonly doc: Document;
  private readonly dataset: TransitDataset;
  private readonly canvas: HTMLCanvasElement;
  private readonly fallbackView: FallbackView;
  private readonly hud: HudController;
  private readonly particleFilter: TrackParticleFilter;
  private readonly liveSource: LiveSensorSource;
  private readonly simSource: DeterministicSimSource;
  private readonly swController: SwController;
  private readonly wakeLock: WakeLockController;
  private readonly sceneManagerFactory: (
    canvas: HTMLCanvasElement,
    dataset: TransitDataset,
    options?: SceneManagerOptions,
  ) => SceneManagerLike;
  private readonly calibrationMaxAgeMs: number;

  private sceneManager: SceneManagerLike | null = null;
  private unsubLive: (() => void) | null = null;
  private unsubSim: (() => void) | null = null;
  private unsubSw: (() => void) | null = null;

  private rafId: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastFramePerfMs = 0;
  private lastStepWallMs = 0;
  private disposed = false;
  private gyroReqSeq = 0;
  private calibrationEpoch = 0;

  private mode: SensorMode = 'live';
  private viewMode: ViewMode = 'inside';
  private gyroEnabled = false;
  private demoScenarioId: DemoScenarioId = 'manhattan-bridge';
  private demoPaused = false;
  private demoSpeedMultiplier: 1 | 2 | 5 = 1;
  private connectivity: ConnectivityStatus = { online: true, swState: 'pending' };

  private latestSnapshot: WorldStateSnapshot;
  private cachedDebugSnapshotRef: WorldStateSnapshot | null = null;
  private cachedVisibleLandmarks: string[] = [];
  private cachedVisibleSystems: string[] = [];

  private readonly handleWindowDeviceOrientation = (
    ev: DeviceOrientationEvent,
  ): void => {
    if (this.disposed || !this.gyroEnabled || !this.sceneManager) return;
    if (ev.alpha === null && ev.beta === null && ev.gamma === null) return;
    const alpha =
      typeof ev.alpha === 'number' && Number.isFinite(ev.alpha) ? ev.alpha : 0;
    const beta =
      typeof ev.beta === 'number' && Number.isFinite(ev.beta) ? ev.beta : 0;
    const gamma =
      typeof ev.gamma === 'number' && Number.isFinite(ev.gamma) ? ev.gamma : 0;
    this.sceneManager.handleDeviceOrientation(
      alpha,
      beta,
      gamma,
      getScreenAngleDeg(),
    );
  };

  constructor(container: HTMLElement, options?: SubwaySightAppOptions) {
    this.container = container;
    this.doc = options?.doc ?? container.ownerDocument ?? document;
    this.dataset = options?.dataset ?? getTransitDataset();
    this.sceneManagerFactory =
      options?.createSceneManager ??
      ((canvas, ds, opts) => new SceneManager(canvas, ds, opts));
    this.calibrationMaxAgeMs =
      options?.calibrationMaxAgeMs ?? DEFAULT_CALIBRATION_MAX_AGE_MS;

    // 1. Mount full-bleed canvas as sibling before HUD root
    this.canvas = this.doc.createElement('canvas');
    this.canvas.className = 'scene-canvas';
    this.canvas.setAttribute('data-testid', 'scene-canvas');
    this.container.appendChild(this.canvas);

    // 2. Restore persisted UI settings
    const saved = loadSettings();
    this.viewMode = saved.viewMode;
    this.demoScenarioId = saved.demoScenarioId;
    this.demoSpeedMultiplier = saved.demoSpeedMultiplier;
    // Never auto-trigger iOS permission prompt on load; only restore gyro if no explicit requestPermission gate exists.
    this.gyroEnabled = saved.gyroEnabled && !this.hasIosMotionPermissionGate();

    // 3. Instantiate core engines
    this.particleFilter = new TrackParticleFilter(this.dataset);
    this.liveSource = new LiveSensorSource();
    this.simSource = new DeterministicSimSource(this.dataset, {
      scenarioId: this.demoScenarioId,
      sampleRateHz: 10,
      autoLoop: true,
    });
    this.simSource.setSpeedMultiplier(this.demoSpeedMultiplier);

    // 4. Fallback view & HUD
    this.fallbackView = new FallbackView(this.container, {
      doc: this.doc,
      onRetry: () => this.tryInitSceneManager(),
    });

    this.hud = new HudController(
      this.container,
      this.dataset,
      {
        onApplyCalibration: (sel) => this.handleApplyCalibration(sel),
        onResetCalibration: () => this.handleResetCalibration(),
        onEnterDemoMode: (id) => this.enterDemoMode(id),
        onExitDemoMode: () => this.exitDemoMode(),
        onSelectScenario: (id) => this.selectDemoScenario(id),
        onToggleDemoPause: () => this.toggleDemoPause(),
        onSelectDemoSpeed: (mult) => this.selectDemoSpeed(mult),
        onToggleGyro: () => this.handleToggleGyro(),
        onResetView: () => this.handleResetView(),
        onChangeViewMode: (mode) => this.handleChangeViewMode(mode),
      },
      { doc: this.doc },
    );

    // 5. PWA Service Worker & Wake Lock
    this.swController = options?.registerSw
      ? options.registerSw()
      : registerServiceWorker();
    this.connectivity = this.swController.getStatus();
    this.unsubSw = this.swController.subscribe((status) => {
      this.connectivity = status;
      this.syncHudState();
    });

    this.wakeLock = options?.createWakeLock
      ? options.createWakeLock()
      : createWakeLockController();
    void this.wakeLock.request();

    // 6. Initialize WebGL SceneManager inside try/catch for graceful fallback
    this.tryInitSceneManager();

    // 7. Initial snapshot before sensors emit
    const initTimeMs = Date.now();
    this.lastStepWallMs = initTimeMs;
    this.latestSnapshot = buildWorldStateSnapshot({
      dataset: this.dataset,
      ego: this.particleFilter.getState(),
      timestampMs: initTimeMs,
      mode: this.mode,
    });

    // 8. Wire sensor callbacks
    this.unsubLive = this.liveSource.onSample((sample) =>
      this.handleSensorSample(sample, 'live'),
    );
    this.unsubSim = this.simSource.onSample((sample) =>
      this.handleSensorSample(sample, 'sim'),
    );
    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      window.addEventListener(
        'deviceorientation',
        this.handleWindowDeviceOrientation,
      );
    }

    // 9. Enter initial mode (saved demoMode or default live)
    if (saved.demoMode) {
      this.enterDemoMode(this.demoScenarioId);
    } else {
      this.startLiveMode();
      void this.restoreRecentCalibrationIfLive();
    }

    // 10. Start RAF loop & live heartbeat
    this.startLoop();
    this.publishDebugSnapshot();
  }

  private hasIosMotionPermissionGate(): boolean {
    if (typeof globalThis === 'undefined') return false;
    const g = globalThis as unknown as {
      DeviceMotionEvent?: { requestPermission?: unknown };
      DeviceOrientationEvent?: { requestPermission?: unknown };
    };
    return (
      typeof g.DeviceMotionEvent?.requestPermission === 'function' ||
      typeof g.DeviceOrientationEvent?.requestPermission === 'function'
    );
  }

  private tryInitSceneManager(): void {
    if (this.disposed) return;
    if (this.sceneManager) {
      try {
        this.sceneManager.dispose();
      } catch {
        // ignore
      }
      this.sceneManager = null;
    }

    try {
      this.sceneManager = this.sceneManagerFactory(this.canvas, this.dataset, {
        onContextLost: () => {
          this.fallbackView.showContextLost();
        },
        onContextRestored: () => {
          this.fallbackView.hide();
        },
      });
      this.sceneManager.setViewMode(this.viewMode);
      this.sceneManager.setGyroEnabled(this.gyroEnabled);
      this.fallbackView.hide();
    } catch {
      this.sceneManager = null;
      this.fallbackView.showUnavailable();
    }
  }

  private async restoreRecentCalibrationIfLive(): Promise<void> {
    const epoch = this.calibrationEpoch;
    const latest = await loadLatestCalibration();
    if (
      this.disposed ||
      this.mode !== 'live' ||
      epoch !== this.calibrationEpoch ||
      !latest
    ) {
      return;
    }
    const nowMs = Date.now();
    const ageMs = nowMs - latest.savedAtMs;
    if (ageMs >= 0 && ageMs <= this.calibrationMaxAgeMs) {
      this.particleFilter.setManualCalibration(
        {
          stationId: latest.stationId,
          routeId: latest.routeId,
          direction: latest.direction,
        },
        nowMs,
      );
      this.lastStepWallMs = nowMs;
      this.rebuildAndSync(nowMs);
    }
  }

  private startLiveMode(): void {
    if (this.disposed) return;
    this.calibrationEpoch++;
    this.simSource.stop();
    this.mode = 'live';
    this.demoPaused = false;
    this.particleFilter.reset();
    this.liveSource.start();
    this.sceneManager?.setGyroEnabled(this.gyroEnabled);
    this.lastStepWallMs = Date.now();
    this.particleFilter.step({ tMs: this.lastStepWallMs }, 'live');
    this.rebuildAndSync(this.lastStepWallMs);
    this.syncHudState();
  }

  enterDemoMode(scenarioId: DemoScenarioId = this.demoScenarioId): void {
    if (this.disposed) return;
    const safeScenarioId: DemoScenarioId = isValidDemoScenarioId(scenarioId)
      ? scenarioId
      : isValidDemoScenarioId(this.demoScenarioId)
        ? this.demoScenarioId
        : 'manhattan-bridge';
    this.calibrationEpoch++;
    this.liveSource.stop();
    this.mode = 'sim';
    this.demoScenarioId = safeScenarioId;
    this.demoPaused = false;
    this.particleFilter.reset();
    this.simSource.stop();
    this.simSource.setScenario(safeScenarioId);
    this.simSource.setPaused(false);
    this.simSource.setSpeedMultiplier(this.demoSpeedMultiplier);
    this.sceneManager?.setGyroEnabled(this.gyroEnabled);

    // Synchronously prime demo state so HUD & 3D scene immediately reflect the chosen scenario.
    const primeSample = this.simSource.step(0.1);
    this.handleSensorSample(primeSample, 'sim');
    this.simSource.start();

    saveSettings({
      demoMode: true,
      demoScenarioId: this.demoScenarioId,
      demoSpeedMultiplier: this.demoSpeedMultiplier,
    });
    this.syncHudState();
  }

  exitDemoMode(): void {
    if (this.disposed) return;
    saveSettings({ demoMode: false });
    this.startLiveMode();
  }

  selectDemoScenario(scenarioId: DemoScenarioId): void {
    if (this.disposed) return;
    if (!isValidDemoScenarioId(scenarioId)) return;
    this.demoScenarioId = scenarioId;
    saveSettings({ demoScenarioId: scenarioId });
    if (this.mode === 'sim') {
      this.enterDemoMode(scenarioId);
    } else {
      this.syncHudState();
    }
  }

  toggleDemoPause(): void {
    if (this.disposed) return;
    if (this.mode !== 'sim') return;
    this.demoPaused = !this.demoPaused;
    this.simSource.setPaused(this.demoPaused);
    this.syncHudState();
  }

  selectDemoSpeed(mult: 1 | 2 | 5): void {
    if (this.disposed) return;
    this.demoSpeedMultiplier = mult;
    this.simSource.setSpeedMultiplier(mult);
    saveSettings({ demoSpeedMultiplier: mult });
    this.syncHudState();
  }

  private handleApplyCalibration(selection: CalibrationSelection): void {
    if (this.disposed) return;
    if (!selection.stationId && !selection.routeId) {
      return;
    }
    this.calibrationEpoch++;
    const ts =
      this.mode === 'sim' ? this.latestSnapshot.timestampMs : Date.now();
    this.particleFilter.setManualCalibration(
      {
        stationId: selection.stationId,
        routeId: selection.routeId,
      },
      ts,
    );
    if (this.mode === 'live') {
      this.lastStepWallMs = ts;
    }
    void saveCalibration({
      stationId: selection.stationId,
      routeId: selection.routeId,
    });
    this.rebuildAndSync(ts);
  }

  private handleResetCalibration(): void {
    if (this.disposed) return;
    this.calibrationEpoch++;
    this.particleFilter.resetCalibration();
    this.particleFilter.reset();
    void clearCalibration();
    if (this.mode === 'sim') {
      const sample = this.simSource.step(0.1);
      this.particleFilter.step(sample, 'sim');
      this.rebuildAndSync(sample.tMs);
    } else {
      const now = Date.now();
      this.lastStepWallMs = now;
      this.particleFilter.step({ tMs: now }, 'live');
      this.rebuildAndSync(now);
    }
  }

  /**
   * Synchronous click-handler entry for iOS DeviceMotionEvent & DeviceOrientationEvent
   * requestPermission(). Both are invoked synchronously in the same tick before any await.
   */
  private handleToggleGyro(): void {
    if (this.disposed) return;
    const seq = ++this.gyroReqSeq;
    if (this.gyroEnabled) {
      this.gyroEnabled = false;
      this.sceneManager?.setGyroEnabled(false);
      saveSettings({ gyroEnabled: false });
      this.syncHudState();
      this.publishDebugSnapshot();
      return;
    }

    // Call both requestPermission() methods synchronously inside the user gesture stack!
    const permPromise = requestIosGyroPermissionsSync();
    void permPromise.then((result) => {
      if (this.disposed || seq !== this.gyroReqSeq) return;
      if (result === 'granted') {
        this.gyroEnabled = true;
        this.sceneManager?.setGyroEnabled(true);
        saveSettings({ gyroEnabled: true });
      } else {
        this.gyroEnabled = false;
        this.sceneManager?.setGyroEnabled(false);
      }
      this.syncHudState();
      this.publishDebugSnapshot();
    });
  }

  private handleResetView(): void {
    if (this.disposed) return;
    this.sceneManager?.resetCameraView();
    this.publishDebugSnapshot();
  }

  private handleChangeViewMode(nextMode: ViewMode): void {
    if (this.disposed) return;
    this.viewMode = nextMode;
    this.sceneManager?.setViewMode(nextMode);
    saveSettings({ viewMode: nextMode });
    this.syncHudState();
    this.publishDebugSnapshot();
  }

  private handleSensorSample(sample: SensorSample, sourceMode: SensorMode): void {
    if (this.disposed || sourceMode !== this.mode) return;

    this.particleFilter.step(sample, sourceMode);
    this.lastStepWallMs = Date.now();

    const snapshotTs = sourceMode === 'sim' ? sample.tMs : Date.now();
    this.rebuildAndSync(snapshotTs);
  }

  private rebuildAndSync(timestampMs: number): void {
    const ego = this.particleFilter.getState();
    this.latestSnapshot = buildWorldStateSnapshot({
      dataset: this.dataset,
      ego,
      timestampMs,
      mode: this.mode,
      scenarioId: this.mode === 'sim' ? this.demoScenarioId : undefined,
    });
    this.hud.update(this.latestSnapshot);
    this.publishDebugSnapshot();
  }

  private syncHudState(): void {
    this.hud.setUiState({
      viewMode: this.viewMode,
      gyroEnabled: this.gyroEnabled,
      demoMode: this.mode === 'sim',
      demoScenarioId: this.demoScenarioId,
      demoPaused: this.demoPaused,
      demoSpeedMultiplier: this.demoSpeedMultiplier,
      connectivity: this.connectivity,
    });
  }

  private startLoop(): void {
    this.lastFramePerfMs = nowPerfMs();

    // Periodic heartbeat so underground live mode without GPS (and Playwright page.clock) still advances.
    this.heartbeatTimer = setInterval(() => {
      if (this.disposed || this.mode !== 'live') return;
      const nowWall = Date.now();
      if (
        nowWall < this.lastStepWallMs ||
        nowWall - this.lastStepWallMs >= LIVE_HEARTBEAT_MS - 50
      ) {
        this.lastStepWallMs = nowWall;
        this.particleFilter.step({ tMs: nowWall }, 'live');
        this.rebuildAndSync(nowWall);
      }
    }, LIVE_HEARTBEAT_MS);

    const tick = (): void => {
      if (this.disposed) return;

      const currentPerf = nowPerfMs();
      const rawDt = (currentPerf - this.lastFramePerfMs) / 1000;
      this.lastFramePerfMs = currentPerf;
      const dtSec =
        Number.isFinite(rawDt) && rawDt > 0
          ? Math.min(MAX_DT_SEC, rawDt)
          : 1 / 60;

      // Also check wall-clock advancement (and backward clock jumps) inside RAF for clock-mocked environments.
      if (this.mode === 'live') {
        const nowWall = Date.now();
        if (
          nowWall < this.lastStepWallMs ||
          nowWall - this.lastStepWallMs >= LIVE_HEARTBEAT_MS
        ) {
          this.lastStepWallMs = nowWall;
          this.particleFilter.step({ tMs: nowWall }, 'live');
          this.rebuildAndSync(nowWall);
        }
      }

      if (this.sceneManager) {
        this.sceneManager.update(this.latestSnapshot, dtSec);
      }

      this.publishDebugSnapshot();

      if (typeof requestAnimationFrame === 'function') {
        this.rafId = requestAnimationFrame(tick);
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(tick);
    }
  }

  getLatestSnapshot(): WorldStateSnapshot {
    return this.latestSnapshot;
  }

  getDebugSnapshot(): DebugSnapshot {
    const cam = this.sceneManager
      ? this.sceneManager.getCameraDebug()
      : {
          yaw: 0,
          pitch: 0,
          position: [0, 0, 0] as [number, number, number],
          viewMode: this.viewMode,
          drawCalls: 0,
          frameCount: 0,
        };

    const { ego, nearbyLandmarks, nearbyTrains } = this.latestSnapshot;

    if (this.cachedDebugSnapshotRef !== this.latestSnapshot) {
      const visibleSystemsSet = new Set<string>();
      if (ego.system) {
        visibleSystemsSet.add(ego.system);
      }
      for (const train of nearbyTrains) {
        visibleSystemsSet.add(train.system);
      }
      this.cachedVisibleLandmarks = nearbyLandmarks.map((lm) => lm.id);
      this.cachedVisibleSystems = Array.from(visibleSystemsSet);
      this.cachedDebugSnapshotRef = this.latestSnapshot;
    }

    return {
      camera: {
        yaw: cam.yaw,
        pitch: cam.pitch,
        position: cam.position,
        viewMode: this.viewMode,
      },
      estimate: {
        line: ego.routeId,
        serviceType: ego.serviceType,
        direction: ego.direction,
        confidence: ego.confidencePct,
        stationId: ego.currentStationId,
        nextStationId: ego.nextStationId,
        elevationFt: ego.elevationFt,
        speedMph: ego.speedMph,
        outOfNyc: ego.outOfNyc,
      },
      sensorStatus: { ...ego.sensorStatus },
      visibleLandmarks: this.cachedVisibleLandmarks,
      visibleSystems: this.cachedVisibleSystems,
      nearbyTrainCount: nearbyTrains.length,
      drawCalls: cam.drawCalls,
      frameCount: cam.frameCount,
      mode: this.mode,
    };
  }

  private publishDebugSnapshot(): void {
    if (typeof window !== 'undefined') {
      window.__SUBWAY_VISION_STATE__ = this.getDebugSnapshot();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.unsubLive?.();
    this.unsubLive = null;
    this.unsubSim?.();
    this.unsubSim = null;
    this.unsubSw?.();
    this.unsubSw = null;

    if (
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener(
        'deviceorientation',
        this.handleWindowDeviceOrientation,
      );
    }

    this.liveSource.stop();
    this.simSource.stop();
    this.sceneManager?.dispose();
    this.sceneManager = null;
    this.swController.dispose();
    this.wakeLock.dispose();
    this.fallbackView.dispose();
    this.hud.dispose();

    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
