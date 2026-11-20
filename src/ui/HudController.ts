import type { ConnectivityStatus } from '../pwa/registerSw';
import {
  DEMO_SCENARIOS,
  isValidDemoScenarioId,
} from '../sensors/simSensorSource';
import type { DemoScenarioId } from '../types/sensors';
import type {
  NearbyLandmark,
  NearbyTrain,
  ViewMode,
  WorldStateSnapshot,
} from '../types/state';
import type {
  RailSystem,
  StructureType,
  TransitDataset,
} from '../types/transit';

export interface CalibrationSelection {
  stationId?: string;
  routeId?: string;
}

export interface HudCallbacks {
  onApplyCalibration(selection: CalibrationSelection): void;
  onResetCalibration(): void;
  onEnterDemoMode(scenarioId: DemoScenarioId): void;
  onExitDemoMode(): void;
  onSelectScenario(scenarioId: DemoScenarioId): void;
  onToggleDemoPause(): void;
  onSelectDemoSpeed(mult: 1 | 2 | 5): void;
  onToggleGyro(): void;
  onResetView(): void;
  onChangeViewMode(mode: ViewMode): void;
}

export interface HudUiState {
  viewMode: ViewMode;
  gyroEnabled: boolean;
  demoMode: boolean;
  demoScenarioId: DemoScenarioId;
  demoPaused: boolean;
  demoSpeedMultiplier: 1 | 2 | 5;
  connectivity: ConnectivityStatus;
}

export interface HudControllerOptions {
  doc?: Document;
}

const VIEW_MODE_CYCLE: readonly ViewMode[] = ['inside', 'ghost', 'chase'];
const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  inside: 'Inside',
  ghost: 'Ghost',
  chase: 'Chase',
};

const SCENARIO_ORDER: readonly DemoScenarioId[] = [
  'manhattan-bridge',
  'express-overtake',
  'lexington-underground',
  'steinway-queens',
  'midtown-multi-system',
];

const MAX_NEARBY_TRAIN_CHIPS = 8;
const MAX_NEARBY_LANDMARK_CHIPS = 4;

const INTERACTIVE_STOP_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'touchstart',
  'touchmove',
] as const;

export function formatStructureLabel(structure: StructureType): string {
  switch (structure) {
    case 'UNDERGROUND_TUNNEL':
      return 'Underground';
    case 'UNDERWATER_TUNNEL':
      return 'Underwater Tunnel';
    case 'ELEVATED':
      return 'Elevated';
    case 'BRIDGE':
      return 'Bridge';
    case 'OPEN_CUT':
      return 'Open Cut';
    case 'AT_GRADE':
      return 'At Grade';
    case 'STATION':
      return 'Station';
    default:
      return 'Track';
  }
}

function formatElevation(elevationFt: number, structure: StructureType): string {
  const rounded = Math.round(Number.isFinite(elevationFt) ? elevationFt : 0);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded} ft ${formatStructureLabel(structure)}`;
}

function formatEta(etaSec: number | null): string {
  if (etaSec === null || !Number.isFinite(etaSec) || etaSec < 0) return '';
  const total = Math.round(etaSec);
  if (total < 60) return ` (${total}s)`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return secs > 0 ? ` (${mins}m ${secs}s)` : ` (${mins}m)`;
}

function formatDistanceShort(distanceM: number): string {
  if (!Number.isFinite(distanceM)) return '0m';
  const clamped = Math.max(0, distanceM);
  if (clamped >= 1000) {
    return `${(clamped / 1000).toFixed(1)}km`;
  }
  return `${Math.round(clamped)}m`;
}

function selectRepresentativeTrains(
  trains: readonly NearbyTrain[],
  maxCount: number,
): NearbyTrain[] {
  if (trains.length <= maxCount) {
    return [...trains];
  }
  const chosenIndices = new Set<number>();
  const seenSystems = new Set<RailSystem>();

  // Guarantee each distinct rail system present in nearbyTrains gets representation first.
  for (let i = 0; i < trains.length && chosenIndices.size < maxCount; i++) {
    const sys = trains[i].system;
    if (!seenSystems.has(sys)) {
      seenSystems.add(sys);
      chosenIndices.add(i);
    }
  }

  for (let i = 0; i < trains.length && chosenIndices.size < maxCount; i++) {
    if (!chosenIndices.has(i)) {
      chosenIndices.add(i);
    }
  }

  return Array.from(chosenIndices)
    .sort((a, b) => a - b)
    .map((idx) => trains[idx]);
}

/**
 * Mobile-first telemetry HUD, calibration drawer, demo mode switcher, and sensor/camera controls.
 * Built programmatically via DOM APIs with touch/pointer isolation and diffed updates for 60 fps.
 */
export class HudController {
  private readonly doc: Document;
  private readonly callbacks: HudCallbacks;
  private readonly root: HTMLElement;

  // Telemetry elements
  private readonly routeBulletEl: HTMLElement;
  private readonly trainIdentityEl: HTMLElement;
  private readonly confidenceEl: HTMLElement;
  private readonly offlineBadgeEl: HTMLElement;
  private readonly currentStationEl: HTMLElement;
  private readonly nextStationEl: HTMLElement;
  private readonly speedEl: HTMLElement;
  private readonly elevationEl: HTMLElement;
  private readonly gpsStatusEl: HTMLElement;
  private readonly drStatusEl: HTMLElement;
  private readonly timingStatusEl: HTMLElement;

  // Banners
  private readonly outOfNycBanner: HTMLElement;
  private readonly sensorNoticeBanner: HTMLElement;

  // Nearby lists
  private readonly nearbyTrainsList: HTMLElement;
  private readonly nearbyLandmarksList: HTMLElement;

  // Primary action buttons
  private readonly viewModeBtn: HTMLButtonElement;
  private readonly gyroBtn: HTMLButtonElement;
  private readonly resetViewBtn: HTMLButtonElement;
  private readonly calibrateBtn: HTMLButtonElement;
  private readonly demoBtn: HTMLButtonElement;

  // Calibration drawer controls
  private readonly calibrateDrawer: HTMLElement;
  private readonly stationSelect: HTMLSelectElement;
  private readonly lineSelect: HTMLSelectElement;
  private readonly calibrateApplyBtn: HTMLButtonElement;
  private readonly calibrateResetBtn: HTMLButtonElement;
  private readonly calibrateCloseBtn: HTMLButtonElement;

  // Demo drawer controls
  private readonly demoDrawer: HTMLElement;
  private readonly scenarioSelect: HTMLSelectElement;
  private readonly demoPlayPauseBtn: HTMLButtonElement;
  private readonly demoSpeedBtns: Map<1 | 2 | 5, HTMLButtonElement>;
  private readonly liveModeBtn: HTMLButtonElement;
  private readonly demoCloseBtn: HTMLButtonElement;

  // Banner action buttons
  private readonly outOfNycDemoBtn: HTMLButtonElement;
  private readonly outOfNycCalibrateBtn: HTMLButtonElement;
  private readonly sensorNoticeDemoBtn: HTMLButtonElement;

  private readonly cleanups: Array<() => void> = [];

  private uiState: HudUiState = {
    viewMode: 'inside',
    gyroEnabled: false,
    demoMode: false,
    demoScenarioId: 'manhattan-bridge',
    demoPaused: false,
    demoSpeedMultiplier: 1,
    connectivity: { online: true, swState: 'pending' },
  };

  // Diff cache to avoid unnecessary DOM mutations at 60 fps
  private prevIdentity = '';
  private prevBulletText = '';
  private prevBulletColor = '';
  private prevConfidence = -1;
  private prevCurrentStation = '';
  private prevNextStation = '';
  private prevSpeed = '';
  private prevElevation = '';
  private prevGpsStatus = '';
  private prevDrStatus = '';
  private prevTimingStatus = '';
  private prevOutOfNyc = false;
  private prevSensorDenied = false;
  private prevTrainsKey = '';
  private prevLandmarksKey = '';
  private prevOnline = '';
  private prevSwState = '';

  private readonly dataset: TransitDataset;

  constructor(
    container: HTMLElement,
    dataset: TransitDataset,
    callbacks: HudCallbacks,
    options?: HudControllerOptions,
  ) {
    this.dataset = dataset;
    this.doc = options?.doc ?? container.ownerDocument ?? document;
    this.callbacks = callbacks;

    this.root = this.doc.createElement('div');
    this.root.className = 'hud-root';
    this.root.setAttribute('data-testid', 'hud-root');

    // --- TOP STACK ---
    const topStack = this.doc.createElement('div');
    topStack.className = 'hud-top-stack';

    const topBar = this.doc.createElement('header');
    topBar.className = 'hud-top-bar hud-interactive';
    this.isolatePointerEvents(topBar);

    // Row 1: Identity + Confidence + Offline Badge
    const row1 = this.doc.createElement('div');
    row1.className = 'hud-row';

    const identityGroup = this.doc.createElement('div');
    identityGroup.className = 'hud-identity-group';

    this.routeBulletEl = this.doc.createElement('span');
    this.routeBulletEl.className = 'hud-route-bullet';
    this.routeBulletEl.textContent = '?';

    this.trainIdentityEl = this.doc.createElement('span');
    this.trainIdentityEl.className = 'hud-train-identity';
    this.trainIdentityEl.setAttribute('data-testid', 'hud-train-identity');
    this.trainIdentityEl.textContent = 'Locating Train…';

    identityGroup.appendChild(this.routeBulletEl);
    identityGroup.appendChild(this.trainIdentityEl);

    const topBadges = this.doc.createElement('div');
    topBadges.className = 'hud-top-badges';

    this.confidenceEl = this.doc.createElement('span');
    this.confidenceEl.className = 'hud-pill hud-confidence';
    this.confidenceEl.setAttribute('data-testid', 'hud-confidence');
    this.confidenceEl.setAttribute('data-confidence', '0');
    this.confidenceEl.textContent = '0%';

    this.offlineBadgeEl = this.doc.createElement('span');
    this.offlineBadgeEl.className = 'hud-pill offline-badge';
    this.offlineBadgeEl.setAttribute('data-testid', 'offline-status-badge');
    this.offlineBadgeEl.setAttribute('data-online', 'true');
    this.offlineBadgeEl.setAttribute('data-sw', 'pending');
    this.offlineBadgeEl.textContent = 'Online';

    topBadges.appendChild(this.confidenceEl);
    topBadges.appendChild(this.offlineBadgeEl);

    row1.appendChild(identityGroup);
    row1.appendChild(topBadges);

    // Row 2: Stations + Speed + Elevation
    const row2 = this.doc.createElement('div');
    row2.className = 'hud-telemetry-row';

    const stationsWrap = this.doc.createElement('div');
    stationsWrap.className = 'hud-stations';

    this.currentStationEl = this.doc.createElement('span');
    this.currentStationEl.className = 'hud-station-label';
    this.currentStationEl.setAttribute('data-testid', 'hud-current-station');
    this.currentStationEl.textContent = '—';

    const stationSep = this.doc.createElement('span');
    stationSep.className = 'hud-station-sep';
    stationSep.textContent = '→';

    this.nextStationEl = this.doc.createElement('span');
    this.nextStationEl.className = 'hud-station-label';
    this.nextStationEl.setAttribute('data-testid', 'hud-next-station');
    this.nextStationEl.textContent = '—';

    stationsWrap.appendChild(this.currentStationEl);
    stationsWrap.appendChild(stationSep);
    stationsWrap.appendChild(this.nextStationEl);

    const metricsWrap = this.doc.createElement('div');
    metricsWrap.className = 'hud-metrics';

    this.speedEl = this.doc.createElement('span');
    this.speedEl.setAttribute('data-testid', 'hud-speed');
    this.speedEl.textContent = '0 mph';

    this.elevationEl = this.doc.createElement('span');
    this.elevationEl.setAttribute('data-testid', 'hud-elevation');
    this.elevationEl.textContent = '0 ft Underground';

    metricsWrap.appendChild(this.speedEl);
    metricsWrap.appendChild(this.elevationEl);

    row2.appendChild(stationsWrap);
    row2.appendChild(metricsWrap);

    // Row 3: Sensor Status Pills
    const row3 = this.doc.createElement('div');
    row3.className = 'hud-sensors-row';

    this.gpsStatusEl = this.doc.createElement('span');
    this.gpsStatusEl.className = 'sensor-pill';
    this.gpsStatusEl.setAttribute('data-testid', 'sensor-status-gps');
    this.gpsStatusEl.setAttribute('data-status', 'lost');
    this.gpsStatusEl.textContent = 'GPS: lost';

    this.drStatusEl = this.doc.createElement('span');
    this.drStatusEl.className = 'sensor-pill';
    this.drStatusEl.setAttribute('data-testid', 'sensor-status-dr');
    this.drStatusEl.setAttribute('data-status', 'standby');
    this.drStatusEl.textContent = 'DR: standby';

    this.timingStatusEl = this.doc.createElement('span');
    this.timingStatusEl.className = 'sensor-pill';
    this.timingStatusEl.setAttribute('data-testid', 'sensor-status-timing');
    this.timingStatusEl.setAttribute('data-status', 'active');
    this.timingStatusEl.textContent = 'Timing: active';

    row3.appendChild(this.gpsStatusEl);
    row3.appendChild(this.drStatusEl);
    row3.appendChild(this.timingStatusEl);

    topBar.appendChild(row1);
    topBar.appendChild(row2);
    topBar.appendChild(row3);
    topStack.appendChild(topBar);

    // Out-of-NYC Banner (hidden unless ego.outOfNyc === true)
    this.outOfNycBanner = this.doc.createElement('div');
    this.outOfNycBanner.className = 'hud-banner hud-interactive';
    this.outOfNycBanner.setAttribute('data-testid', 'out-of-nyc-banner');
    this.outOfNycBanner.setAttribute('role', 'status');
    this.outOfNycBanner.hidden = true;
    this.isolatePointerEvents(this.outOfNycBanner);

    const outText = this.doc.createElement('span');
    outText.className = 'hud-banner-text';
    outText.textContent =
      'Outside NYC coverage area. Launch Demo Mode or set a manual NYC station.';

    const outActions = this.doc.createElement('div');
    outActions.className = 'hud-banner-actions';

    this.outOfNycDemoBtn = this.createButton(
      'Demo',
      'btn-out-of-nyc-demo',
      'hud-btn hud-btn--primary hud-btn--compact',
    );
    this.outOfNycCalibrateBtn = this.createButton(
      'Calibrate',
      'btn-out-of-nyc-calibrate',
      'hud-btn hud-btn--compact',
    );
    outActions.appendChild(this.outOfNycDemoBtn);
    outActions.appendChild(this.outOfNycCalibrateBtn);

    this.outOfNycBanner.appendChild(outText);
    this.outOfNycBanner.appendChild(outActions);
    topStack.appendChild(this.outOfNycBanner);

    // Non-blocking Sensor Permission Notice (shown when GPS is denied in Live mode)
    this.sensorNoticeBanner = this.doc.createElement('div');
    this.sensorNoticeBanner.className =
      'hud-banner hud-banner--error hud-interactive';
    this.sensorNoticeBanner.setAttribute(
      'data-testid',
      'sensor-permission-notice',
    );
    this.sensorNoticeBanner.setAttribute('role', 'status');
    this.sensorNoticeBanner.hidden = true;
    this.isolatePointerEvents(this.sensorNoticeBanner);

    const noticeText = this.doc.createElement('span');
    noticeText.className = 'hud-banner-text';
    noticeText.textContent =
      'Location permission denied. Using dead reckoning & schedules, or try Demo Mode.';

    this.sensorNoticeDemoBtn = this.createButton(
      'Try Demo',
      'btn-sensor-notice-demo',
      'hud-btn hud-btn--primary hud-btn--compact',
    );
    this.sensorNoticeBanner.appendChild(noticeText);
    this.sensorNoticeBanner.appendChild(this.sensorNoticeDemoBtn);
    topStack.appendChild(this.sensorNoticeBanner);

    // --- BOTTOM STACK ---
    const bottomStack = this.doc.createElement('div');
    bottomStack.className = 'hud-bottom-stack';

    // Nearby Strip (Trains & Landmarks)
    const nearbyStrip = this.doc.createElement('div');
    nearbyStrip.className = 'hud-nearby-strip hud-interactive';
    this.isolatePointerEvents(nearbyStrip);

    this.nearbyTrainsList = this.doc.createElement('ul');
    this.nearbyTrainsList.className = 'nearby-group';
    this.nearbyTrainsList.setAttribute('data-testid', 'nearby-trains-list');
    this.nearbyTrainsList.setAttribute('aria-label', 'Nearby trains');

    this.nearbyLandmarksList = this.doc.createElement('ul');
    this.nearbyLandmarksList.className = 'nearby-group';
    this.nearbyLandmarksList.setAttribute(
      'data-testid',
      'nearby-landmarks-list',
    );
    this.nearbyLandmarksList.setAttribute('aria-label', 'Nearby landmarks');

    nearbyStrip.appendChild(this.nearbyTrainsList);
    nearbyStrip.appendChild(this.nearbyLandmarksList);

    // Calibration Drawer
    this.calibrateDrawer = this.doc.createElement('section');
    this.calibrateDrawer.className = 'hud-drawer hud-interactive';
    this.calibrateDrawer.setAttribute('data-testid', 'calibrate-drawer');
    this.calibrateDrawer.hidden = true;
    this.isolatePointerEvents(this.calibrateDrawer);

    const calHeader = this.doc.createElement('div');
    calHeader.className = 'hud-drawer-header';

    const calTitle = this.doc.createElement('h2');
    calTitle.className = 'hud-drawer-title';
    calTitle.textContent = 'Manual Calibration';

    this.calibrateCloseBtn = this.createButton(
      'Close',
      'btn-calibrate-close',
      'hud-btn hud-btn--compact',
    );
    calHeader.appendChild(calTitle);
    calHeader.appendChild(this.calibrateCloseBtn);

    const calBody = this.doc.createElement('div');
    calBody.className = 'hud-drawer-body';

    const stationField = this.doc.createElement('label');
    stationField.className = 'hud-field';
    stationField.textContent = "I'm at Station";

    this.stationSelect = this.doc.createElement('select');
    this.stationSelect.className = 'hud-select';
    this.stationSelect.setAttribute('data-testid', 'calibrate-station-select');
    this.populateStationSelect(dataset);
    stationField.appendChild(this.stationSelect);

    const lineField = this.doc.createElement('label');
    lineField.className = 'hud-field';
    lineField.textContent = "I'm on Line";

    this.lineSelect = this.doc.createElement('select');
    this.lineSelect.className = 'hud-select';
    this.lineSelect.setAttribute('data-testid', 'calibrate-line-select');
    this.populateLineSelect(dataset);
    lineField.appendChild(this.lineSelect);

    const calActions = this.doc.createElement('div');
    calActions.className = 'hud-drawer-actions';

    this.calibrateApplyBtn = this.createButton(
      'Apply Anchor',
      'btn-calibrate-apply',
      'hud-btn hud-btn--primary',
    );
    this.calibrateResetBtn = this.createButton(
      'Auto-Detect',
      'btn-calibrate-reset',
      'hud-btn',
    );
    calActions.appendChild(this.calibrateApplyBtn);
    calActions.appendChild(this.calibrateResetBtn);

    calBody.appendChild(stationField);
    calBody.appendChild(lineField);
    calBody.appendChild(calActions);

    this.calibrateDrawer.appendChild(calHeader);
    this.calibrateDrawer.appendChild(calBody);

    // Demo Mode Bar (compact single-row strip when in Demo Mode)
    this.demoDrawer = this.doc.createElement('section');
    this.demoDrawer.className = 'hud-drawer hud-demo-bar hud-interactive';
    this.demoDrawer.setAttribute('data-testid', 'demo-drawer');
    this.demoDrawer.hidden = true;
    this.isolatePointerEvents(this.demoDrawer);

    const demoHeader = this.doc.createElement('div');
    demoHeader.className = 'hud-drawer-header';

    const demoTitle = this.doc.createElement('h2');
    demoTitle.className = 'hud-drawer-title';
    demoTitle.textContent = 'Demo Simulation';

    this.demoCloseBtn = this.createButton(
      'Hide',
      'btn-demo-close',
      'hud-btn hud-btn--compact',
    );
    demoHeader.appendChild(demoTitle);
    demoHeader.appendChild(this.demoCloseBtn);

    const demoBody = this.doc.createElement('div');
    demoBody.className = 'hud-drawer-body';

    const scenarioField = this.doc.createElement('label');
    scenarioField.className = 'hud-field';
    scenarioField.textContent = 'NYC Ride Scenario';

    this.scenarioSelect = this.doc.createElement('select');
    this.scenarioSelect.className = 'hud-select';
    this.scenarioSelect.setAttribute('data-testid', 'demo-scenario-select');
    this.scenarioSelect.setAttribute('aria-label', 'NYC Ride Scenario');
    for (const id of SCENARIO_ORDER) {
      const cfg = DEMO_SCENARIOS[id];
      const opt = this.doc.createElement('option');
      opt.value = id;
      opt.textContent = cfg.label;
      this.scenarioSelect.appendChild(opt);
    }
    scenarioField.appendChild(this.scenarioSelect);

    const demoActions = this.doc.createElement('div');
    demoActions.className = 'hud-drawer-actions';

    this.demoPlayPauseBtn = this.createButton(
      'Pause',
      'btn-demo-play-pause',
      'hud-btn hud-btn--compact',
    );

    const speedGroup = this.doc.createElement('div');
    speedGroup.className = 'hud-speed-group';
    this.demoSpeedBtns = new Map<1 | 2 | 5, HTMLButtonElement>();
    for (const mult of [1, 2, 5] as const) {
      const btn = this.createButton(
        `${mult}×`,
        `btn-demo-speed-${mult}`,
        'hud-btn hud-btn--compact',
      );
      this.demoSpeedBtns.set(mult, btn);
      speedGroup.appendChild(btn);
    }

    this.liveModeBtn = this.createButton(
      'Live Mode',
      'btn-live-mode',
      'hud-btn hud-btn--compact',
    );

    demoActions.appendChild(this.demoPlayPauseBtn);
    demoActions.appendChild(speedGroup);
    demoActions.appendChild(this.liveModeBtn);

    demoBody.appendChild(scenarioField);
    demoBody.appendChild(demoActions);

    this.demoDrawer.appendChild(demoHeader);
    this.demoDrawer.appendChild(demoBody);

    // Primary Bottom Action Bar
    const actionBar = this.doc.createElement('nav');
    actionBar.className = 'hud-action-bar hud-interactive';
    actionBar.setAttribute('aria-label', 'Camera and mode controls');
    this.isolatePointerEvents(actionBar);

    this.viewModeBtn = this.createButton('Inside', 'btn-view-mode', 'hud-btn');
    this.gyroBtn = this.createButton('Gyro', 'btn-gyro-toggle', 'hud-btn');
    this.resetViewBtn = this.createButton('Reset', 'btn-reset-view', 'hud-btn');
    this.calibrateBtn = this.createButton(
      'Calibrate',
      'btn-calibrate',
      'hud-btn',
    );
    this.calibrateBtn.setAttribute('aria-expanded', 'false');
    this.demoBtn = this.createButton('Demo', 'btn-demo-mode', 'hud-btn');

    actionBar.appendChild(this.viewModeBtn);
    actionBar.appendChild(this.gyroBtn);
    actionBar.appendChild(this.resetViewBtn);
    actionBar.appendChild(this.calibrateBtn);
    actionBar.appendChild(this.demoBtn);

    bottomStack.appendChild(nearbyStrip);
    bottomStack.appendChild(this.calibrateDrawer);
    bottomStack.appendChild(this.demoDrawer);
    bottomStack.appendChild(actionBar);

    this.root.appendChild(topStack);
    this.root.appendChild(bottomStack);
    container.appendChild(this.root);

    this.bindEvents();
    this.syncUiStateControls();
  }

  private createButton(
    label: string,
    testId: string,
    className: string,
  ): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.setAttribute('data-testid', testId);
    btn.textContent = label;
    return btn;
  }

  private isolatePointerEvents(el: HTMLElement): void {
    const handler = (ev: Event): void => {
      ev.stopPropagation();
    };
    for (const type of INTERACTIVE_STOP_EVENTS) {
      el.addEventListener(type, handler);
      this.cleanups.push(() => el.removeEventListener(type, handler));
    }
  }

  private listen(
    el: EventTarget,
    type: string,
    handler: (ev: Event) => void,
  ): void {
    el.addEventListener(type, handler);
    this.cleanups.push(() => el.removeEventListener(type, handler));
  }

  private populateStationSelect(dataset: TransitDataset): void {
    const placeholder = this.doc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Any Station —';
    this.stationSelect.appendChild(placeholder);

    const sorted = [...dataset.stations].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const st of sorted) {
      const opt = this.doc.createElement('option');
      opt.value = st.id;
      opt.textContent = `${st.name} (${st.system})`;
      this.stationSelect.appendChild(opt);
    }
  }

  private populateLineSelect(dataset: TransitDataset, stationId?: string): void {
    const prevValue = this.lineSelect.value;
    this.clearChildren(this.lineSelect);

    const placeholder = this.doc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Any Line —';
    this.lineSelect.appendChild(placeholder);

    const station = stationId ? dataset.stationById.get(stationId) : undefined;
    const allowedRoutes =
      station && station.routes.length > 0 ? new Set(station.routes) : null;

    const seen = new Map<string, RailSystem>();
    for (const sch of dataset.schedules) {
      if (allowedRoutes && !allowedRoutes.has(sch.routeId)) {
        continue;
      }
      if (!seen.has(sch.routeId)) {
        seen.set(sch.routeId, sch.system);
      }
    }

    const entries = Array.from(seen.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [routeId, system] of entries) {
      const opt = this.doc.createElement('option');
      opt.value = routeId;
      opt.textContent = system === 'MTA' ? `${routeId} Train` : `${routeId} (${system})`;
      this.lineSelect.appendChild(opt);
    }

    if (prevValue && seen.has(prevValue)) {
      this.lineSelect.value = prevValue;
    } else {
      this.lineSelect.value = '';
    }
  }

  private bindEvents(): void {
    this.listen(this.viewModeBtn, 'click', (ev) => {
      ev.stopPropagation();
      const idx = VIEW_MODE_CYCLE.indexOf(this.uiState.viewMode);
      const next = VIEW_MODE_CYCLE[(idx + 1) % VIEW_MODE_CYCLE.length];
      this.callbacks.onChangeViewMode(next);
    });

    // CRITICAL for iOS 13+: call onToggleGyro synchronously inside click handler.
    this.listen(this.gyroBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onToggleGyro();
    });

    this.listen(this.resetViewBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onResetView();
    });

    this.listen(this.calibrateBtn, 'click', (ev) => {
      ev.stopPropagation();
      const willOpen = Boolean(this.calibrateDrawer.hidden);
      this.setCalibrateDrawerOpen(willOpen);
      if (willOpen) {
        this.demoDrawer.hidden = true;
      }
    });

    this.listen(this.calibrateCloseBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.setCalibrateDrawerOpen(false);
    });

    this.listen(this.calibrateApplyBtn, 'click', (ev) => {
      ev.stopPropagation();
      const stationId = this.stationSelect.value || undefined;
      const routeId = this.lineSelect.value || undefined;
      this.callbacks.onApplyCalibration({ stationId, routeId });
      this.setCalibrateDrawerOpen(false);
    });

    this.listen(this.stationSelect, 'change', (ev) => {
      ev.stopPropagation();
      this.populateLineSelect(this.dataset, this.stationSelect.value || undefined);
    });

    this.listen(this.calibrateResetBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.stationSelect.value = '';
      this.populateLineSelect(this.dataset, undefined);
      this.lineSelect.value = '';
      this.callbacks.onResetCalibration();
      this.setCalibrateDrawerOpen(false);
    });

    this.listen(this.demoBtn, 'click', (ev) => {
      ev.stopPropagation();
      if (!this.uiState.demoMode) {
        this.setCalibrateDrawerOpen(false);
        this.demoDrawer.hidden = false;
        this.callbacks.onEnterDemoMode(this.uiState.demoScenarioId);
      } else if (this.demoDrawer.hidden) {
        this.setCalibrateDrawerOpen(false);
        this.demoDrawer.hidden = false;
      } else {
        this.demoDrawer.hidden = true;
        this.callbacks.onExitDemoMode();
      }
    });

    this.listen(this.demoCloseBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.demoDrawer.hidden = true;
    });

    this.listen(this.scenarioSelect, 'change', (ev) => {
      ev.stopPropagation();
      const val = this.scenarioSelect.value;
      if (isValidDemoScenarioId(val)) {
        this.callbacks.onSelectScenario(val);
      }
    });

    this.listen(this.demoPlayPauseBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.callbacks.onToggleDemoPause();
    });

    for (const [mult, btn] of this.demoSpeedBtns.entries()) {
      this.listen(btn, 'click', (ev) => {
        ev.stopPropagation();
        this.callbacks.onSelectDemoSpeed(mult);
      });
    }

    this.listen(this.liveModeBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.demoDrawer.hidden = true;
      this.callbacks.onExitDemoMode();
    });

    this.listen(this.outOfNycDemoBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.setCalibrateDrawerOpen(false);
      this.demoDrawer.hidden = false;
      this.callbacks.onEnterDemoMode(this.uiState.demoScenarioId);
    });

    this.listen(this.outOfNycCalibrateBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.demoDrawer.hidden = true;
      this.setCalibrateDrawerOpen(true);
    });

    this.listen(this.sensorNoticeDemoBtn, 'click', (ev) => {
      ev.stopPropagation();
      this.setCalibrateDrawerOpen(false);
      this.demoDrawer.hidden = false;
      this.callbacks.onEnterDemoMode(this.uiState.demoScenarioId);
    });
  }

  private setCalibrateDrawerOpen(open: boolean): void {
    this.calibrateDrawer.hidden = !open;
    this.calibrateBtn.classList.toggle('hud-btn--active', open);
    this.calibrateBtn.setAttribute('aria-expanded', String(open));
  }

  setUiState(patch: Partial<HudUiState>): void {
    const wasDemoMode = this.uiState.demoMode;
    this.uiState = {
      ...this.uiState,
      ...patch,
      connectivity: patch.connectivity ?? this.uiState.connectivity,
    };
    if (!wasDemoMode && this.uiState.demoMode) {
      this.setCalibrateDrawerOpen(false);
      this.demoDrawer.hidden = false;
    } else if (wasDemoMode && !this.uiState.demoMode) {
      this.demoDrawer.hidden = true;
    }
    this.syncUiStateControls();
  }

  private syncUiStateControls(): void {
    const {
      viewMode,
      gyroEnabled,
      demoMode,
      demoScenarioId,
      demoPaused,
      demoSpeedMultiplier,
      connectivity,
    } = this.uiState;

    this.viewModeBtn.textContent = VIEW_MODE_LABELS[viewMode];
    this.viewModeBtn.setAttribute('data-view-mode', viewMode);

    this.gyroBtn.textContent = gyroEnabled ? 'Gyro On' : 'Gyro';
    this.gyroBtn.classList.toggle('hud-btn--active', gyroEnabled);
    this.gyroBtn.setAttribute('aria-pressed', String(gyroEnabled));

    this.demoBtn.textContent = demoMode ? 'Demo ●' : 'Demo';
    this.demoBtn.classList.toggle('hud-btn--active', demoMode);

    if (this.scenarioSelect.value !== demoScenarioId) {
      this.scenarioSelect.value = demoScenarioId;
    }

    this.demoPlayPauseBtn.textContent = demoPaused ? 'Resume' : 'Pause';

    for (const [mult, btn] of this.demoSpeedBtns.entries()) {
      btn.classList.toggle('hud-btn--active', mult === demoSpeedMultiplier);
    }

    const onlineStr = String(connectivity.online);
    const swStr = connectivity.swState;
    if (onlineStr !== this.prevOnline || swStr !== this.prevSwState) {
      this.prevOnline = onlineStr;
      this.prevSwState = swStr;
      this.offlineBadgeEl.setAttribute('data-online', onlineStr);
      this.offlineBadgeEl.setAttribute('data-sw', swStr);
      if (!connectivity.online) {
        this.offlineBadgeEl.textContent =
          swStr === 'ready' ? 'Offline Ready' : 'Offline';
      } else {
        this.offlineBadgeEl.textContent =
          swStr === 'ready' ? 'Online · Cached' : 'Online';
      }
    }
  }

  update(snapshot: WorldStateSnapshot): void {
    const { ego } = snapshot;

    // 1. Train identity & route bullet
    const identityText = ego.displayLabel || 'Unknown Train';
    if (identityText !== this.prevIdentity) {
      this.prevIdentity = identityText;
      this.trainIdentityEl.textContent = identityText;
    }

    const bulletText = ego.routeId ? ego.routeId.slice(0, 3) : '?';
    const bulletColor = ego.routeColor ?? '#334155';
    if (
      bulletText !== this.prevBulletText ||
      bulletColor !== this.prevBulletColor
    ) {
      this.prevBulletText = bulletText;
      this.prevBulletColor = bulletColor;
      this.routeBulletEl.textContent = bulletText;
      this.routeBulletEl.style.backgroundColor = bulletColor;
    }

    // 2. Confidence
    const conf = Math.max(
      0,
      Math.min(100, Math.round(Number.isFinite(ego.confidencePct) ? ego.confidencePct : 0)),
    );
    if (conf !== this.prevConfidence) {
      this.prevConfidence = conf;
      this.confidenceEl.setAttribute('data-confidence', String(conf));
      this.confidenceEl.setAttribute(
        'data-level',
        conf >= 70 ? 'high' : conf >= 40 ? 'medium' : 'low',
      );
      this.confidenceEl.textContent = `${conf}%`;
    }

    // 3. Stations
    const currStationText = ego.currentStationName || '—';
    if (currStationText !== this.prevCurrentStation) {
      this.prevCurrentStation = currStationText;
      this.currentStationEl.textContent = currStationText;
    }

    const nextBase = ego.nextStationName || '—';
    const nextStationText =
      nextBase !== '—' ? `${nextBase}${formatEta(ego.etaSec)}` : '—';
    if (nextStationText !== this.prevNextStation) {
      this.prevNextStation = nextStationText;
      this.nextStationEl.textContent = nextStationText;
    }

    // 4. Speed & Elevation
    const speedMph = Math.max(
      0,
      Math.round(Number.isFinite(ego.speedMph) ? ego.speedMph : 0),
    );
    const speedText = `${speedMph} mph`;
    if (speedText !== this.prevSpeed) {
      this.prevSpeed = speedText;
      this.speedEl.textContent = speedText;
    }

    const elevText = formatElevation(ego.elevationFt, ego.structure);
    if (elevText !== this.prevElevation) {
      this.prevElevation = elevText;
      this.elevationEl.textContent = elevText;
    }

    // 5. Sensor status pills
    const { gps, dr, timing } = ego.sensorStatus;
    if (gps !== this.prevGpsStatus) {
      this.prevGpsStatus = gps;
      this.gpsStatusEl.setAttribute('data-status', gps);
      this.gpsStatusEl.textContent = `GPS: ${gps}`;
    }
    if (dr !== this.prevDrStatus) {
      this.prevDrStatus = dr;
      this.drStatusEl.setAttribute('data-status', dr);
      this.drStatusEl.textContent = `DR: ${dr}`;
    }
    if (timing !== this.prevTimingStatus) {
      this.prevTimingStatus = timing;
      this.timingStatusEl.setAttribute('data-status', timing);
      this.timingStatusEl.textContent = `Timing: ${timing}`;
    }

    // 6. Banners
    const outOfNyc = Boolean(ego.outOfNyc);
    if (outOfNyc !== this.prevOutOfNyc) {
      this.prevOutOfNyc = outOfNyc;
      this.outOfNycBanner.hidden = !outOfNyc;
    }

    const sensorDenied = snapshot.mode === 'live' && gps === 'denied';
    if (sensorDenied !== this.prevSensorDenied) {
      this.prevSensorDenied = sensorDenied;
      this.sensorNoticeBanner.hidden = !sensorDenied;
    }

    // 7. Nearby trains (with distinct regional systems represented)
    this.updateNearbyTrains(snapshot.nearbyTrains);

    // 8. Nearby landmarks
    this.updateNearbyLandmarks(snapshot.nearbyLandmarks);
  }

  private updateNearbyTrains(trains: readonly NearbyTrain[]): void {
    const selected = selectRepresentativeTrains(trains, MAX_NEARBY_TRAIN_CHIPS);
    const key = selected
      .map(
        (t) =>
          `${t.system}:${t.routeId}:${Math.round(t.distanceM / 25) * 25}`,
      )
      .join('|');
    if (key === this.prevTrainsKey) return;
    this.prevTrainsKey = key;

    this.clearChildren(this.nearbyTrainsList);
    for (const t of selected) {
      const li = this.doc.createElement('li');
      li.className = 'nearby-chip';
      li.setAttribute('data-system', t.system);

      const dot = this.doc.createElement('span');
      dot.className = 'nearby-chip-dot';
      dot.style.backgroundColor = t.color;

      const label = this.doc.createElement('span');
      const sysPrefix =
        t.system === 'MTA' || t.routeId.toUpperCase().startsWith(t.system)
          ? ''
          : `${t.system} `;
      label.textContent = `${sysPrefix}${t.routeId} ${formatDistanceShort(t.distanceM)}`;

      li.appendChild(dot);
      li.appendChild(label);
      this.nearbyTrainsList.appendChild(li);
    }
  }

  private updateNearbyLandmarks(landmarks: readonly NearbyLandmark[]): void {
    const selected = landmarks.slice(0, MAX_NEARBY_LANDMARK_CHIPS);
    const key = selected
      .map((lm) => {
        const safeDist = Number.isFinite(lm.distanceM)
          ? Math.max(0, lm.distanceM)
          : 0;
        const safeRel = Number.isFinite(lm.relativeElevationFt)
          ? lm.relativeElevationFt
          : 0;
        return `${lm.id}:${Math.round(safeDist / 25) * 25}:${Math.round(safeRel / 5) * 5}`;
      })
      .join('|');
    if (key === this.prevLandmarksKey) return;
    this.prevLandmarksKey = key;

    this.clearChildren(this.nearbyLandmarksList);
    for (const lm of selected) {
      const li = this.doc.createElement('li');
      li.className = 'nearby-chip nearby-chip--landmark';
      li.setAttribute('data-landmark', lm.id);
      const safeRel = Number.isFinite(lm.relativeElevationFt)
        ? lm.relativeElevationFt
        : 0;
      const relFt = Math.round(safeRel);
      const relSign = relFt > 0 ? '+' : '';
      li.textContent = `${lm.name} ${formatDistanceShort(lm.distanceM)} (${relSign}${relFt}ft)`;
      this.nearbyLandmarksList.appendChild(li);
    }
  }

  private clearChildren(el: HTMLElement): void {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  dispose(): void {
    for (const fn of this.cleanups) {
      fn();
    }
    this.cleanups.length = 0;
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
  }
}
