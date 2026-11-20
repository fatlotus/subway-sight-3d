import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SceneManagerLike, SubwaySightApp } from '../../src/app';
import { getTransitDataset } from '../../src/data/dataset';
import { resetStorageForTests } from '../../src/pwa/storage';
import type { WorldStateSnapshot } from '../../src/types/state';
import { FallbackView } from '../../src/ui/fallbackView';
import { type HudCallbacks, HudController } from '../../src/ui/HudController';

/** Lightweight Node DOM mock supporting attributes, classList, select options, bubbling, and stopPropagation(). */
class MockEvent {
  readonly type: string;
  propagationStopped = false;
  constructor(type: string) {
    this.type = type;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class MockClassList {
  private readonly set = new Set<string>();
  add(...tokens: string[]): void {
    for (const t of tokens) if (t) this.set.add(t);
  }
  remove(...tokens: string[]): void {
    for (const t of tokens) this.set.delete(t);
  }
  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.set.add(token);
      return true;
    }
    if (force === false) {
      this.set.delete(token);
      return false;
    }
    if (this.set.has(token)) {
      this.set.delete(token);
      return false;
    }
    this.set.add(token);
    return true;
  }
  contains(token: string): boolean {
    return this.set.has(token);
  }
  toString(): string {
    return Array.from(this.set).join(' ');
  }
}

class MockElement {
  readonly tagName: string;
  readonly ownerDocument: MockDocument;
  parentNode: MockElement | null = null;
  readonly children: MockElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly classList = new MockClassList();
  private readonly listeners = new Map<string, Set<(ev: MockEvent) => void>>();

  textContent = '';
  hidden = false;
  type = '';
  value = '';

  constructor(tagName: string, ownerDocument: MockDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(val: string) {
    for (const part of val.split(/\s+/)) {
      if (part) this.classList.add(part);
    }
  }

  get firstChild(): MockElement | null {
    return this.children[0] ?? null;
  }

  appendChild(child: MockElement): MockElement {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === 'SELECT' && this.children.length === 1 && !this.value) {
      this.value = child.value;
    }
    return child;
  }

  removeChild(child: MockElement): MockElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, cb: (ev: MockEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(cb);
  }

  removeEventListener(type: string, cb: (ev: MockEvent) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  dispatchEvent(ev: MockEvent): boolean {
    let curr: MockElement | null = this;
    while (curr && !ev.propagationStopped) {
      const set = curr.listeners.get(ev.type);
      if (set) {
        for (const fn of Array.from(set)) {
          fn(ev);
        }
      }
      curr = curr.parentNode;
    }
    return true;
  }

  click(): void {
    this.dispatchEvent(new MockEvent('click'));
  }

  findByTestId(testId: string): MockElement | null {
    if (this.attributes.get('data-testid') === testId) return this;
    for (const child of this.children) {
      const found = child.findByTestId(testId);
      if (found) return found;
    }
    return null;
  }

  findAll(predicate: (el: MockElement) => boolean): MockElement[] {
    const out: MockElement[] = [];
    if (predicate(this)) out.push(this);
    for (const child of this.children) {
      out.push(...child.findAll(predicate));
    }
    return out;
  }
}

class MockDocument {
  createElement(tag: string): MockElement {
    return new MockElement(tag, this);
  }
}

function makeSampleSnapshot(
  overrides?: Partial<WorldStateSnapshot>,
): WorldStateSnapshot {
  return {
    timestampMs: Date.UTC(2026, 5, 10, 12, 12, 0),
    mode: 'sim',
    scenarioId: 'manhattan-bridge',
    ego: {
      routeId: 'D',
      serviceType: 'EXPRESS',
      direction: 'UPTOWN',
      displayLabel: 'D Express — Uptown',
      confidencePct: 88,
      candidates: [
        {
          routeId: 'D',
          serviceType: 'EXPRESS',
          direction: 'UPTOWN',
          probability: 0.88,
        },
      ],
      currentStationId: 'mta-dekalb-ave',
      currentStationName: 'DeKalb Ave',
      nextStationId: 'mta-grand-st',
      nextStationName: 'Grand St',
      etaSec: 95,
      positionEnu: [0, 0, 41],
      positionLatLng: { lat: 40.707, lon: -73.99 },
      headingRad: 0.2,
      pitchRad: 0.01,
      speedMps: 14.2,
      speedMph: 32,
      elevationM: 41.1,
      elevationFt: 135,
      structure: 'BRIDGE',
      outOfNyc: false,
      manualAnchorActive: false,
      sensorStatus: { gps: 'simulated', dr: 'simulated', timing: 'active' },
      routeColor: '#FF6319',
      system: 'MTA',
    },
    egoConsist: [],
    nearbyTrains: [
      {
        id: 't-mta-1',
        system: 'MTA',
        routeId: 'N',
        color: '#FCCC0A',
        distanceM: 90,
        enu: [5, 0, 41],
        headingRad: 0.2,
        pitchRad: 0,
        carCount: 8,
        carLengthM: 18,
        carWidthM: 3,
        cars: [],
      },
      {
        id: 't-lirr-1',
        system: 'LIRR',
        routeId: 'LIRR',
        color: '#00985F',
        distanceM: 420,
        enu: [200, 0, -15],
        headingRad: 0,
        pitchRad: 0,
        carCount: 8,
        carLengthM: 25,
        carWidthM: 3.2,
        cars: [],
      },
      {
        id: 't-mnr-1',
        system: 'MNR',
        routeId: 'MNR',
        color: '#0039A6',
        distanceM: 520,
        enu: [250, 0, -10],
        headingRad: 0,
        pitchRad: 0,
        carCount: 8,
        carLengthM: 25,
        carWidthM: 3.2,
        cars: [],
      },
      {
        id: 't-path-1',
        system: 'PATH',
        routeId: 'PATH',
        color: '#D93A30',
        distanceM: 610,
        enu: [-300, 0, -20],
        headingRad: 0,
        pitchRad: 0,
        carCount: 8,
        carLengthM: 15.6,
        carWidthM: 2.8,
        cars: [],
      },
      {
        id: 't-njt-1',
        system: 'NJT',
        routeId: 'NJT',
        color: '#F58220',
        distanceM: 710,
        enu: [-400, 0, -22],
        headingRad: 0,
        pitchRad: 0,
        carCount: 8,
        carLengthM: 25,
        carWidthM: 3.2,
        cars: [],
      },
      {
        id: 't-air-1',
        system: 'AIRTRAIN',
        routeId: 'AirTrain',
        color: '#808183',
        distanceM: 880,
        enu: [500, 0, 12],
        headingRad: 0,
        pitchRad: 0,
        carCount: 4,
        carLengthM: 17,
        carWidthM: 3,
        cars: [],
      },
    ],
    nearbyLandmarks: [
      {
        id: 'east-river',
        name: 'East River',
        kind: 'river',
        distanceM: 15,
        relativeElevationFt: 135,
      },
      {
        id: 'manhattan-bridge',
        name: 'Manhattan Bridge',
        kind: 'bridge',
        distanceM: 5,
        relativeElevationFt: 0,
      },
    ],
    ...overrides,
  };
}

function createCallbacks(): HudCallbacks {
  return {
    onApplyCalibration: vi.fn(),
    onResetCalibration: vi.fn(),
    onEnterDemoMode: vi.fn(),
    onExitDemoMode: vi.fn(),
    onSelectScenario: vi.fn(),
    onToggleDemoPause: vi.fn(),
    onSelectDemoSpeed: vi.fn(),
    onToggleGyro: vi.fn(),
    onResetView: vi.fn(),
    onChangeViewMode: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetStorageForTests();
});

describe('UI: HudController contract & interactions', () => {
  it('renders all required data-testid elements and updates telemetry + nearby lists', () => {
    const doc = new MockDocument();
    const container = doc.createElement('div');
    const dataset = getTransitDataset();
    const callbacks = createCallbacks();

    const hud = new HudController(
      container as unknown as HTMLElement,
      dataset,
      callbacks,
      { doc: doc as unknown as Document },
    );

    const requiredTestIds = [
      'hud-train-identity',
      'hud-confidence',
      'hud-current-station',
      'hud-next-station',
      'hud-speed',
      'hud-elevation',
      'sensor-status-gps',
      'sensor-status-dr',
      'sensor-status-timing',
      'offline-status-badge',
      'nearby-trains-list',
      'nearby-landmarks-list',
      'btn-calibrate',
      'calibrate-station-select',
      'calibrate-line-select',
      'btn-calibrate-apply',
      'btn-calibrate-reset',
      'btn-demo-mode',
      'demo-scenario-select',
      'btn-demo-play-pause',
      'btn-live-mode',
      'btn-gyro-toggle',
      'btn-reset-view',
      'btn-view-mode',
    ];
    for (const id of requiredTestIds) {
      expect(container.findByTestId(id), `missing ${id}`).not.toBeNull();
    }

    // Verify all 5 scenarios populated in demo-scenario-select
    const scenarioSelect = container.findByTestId('demo-scenario-select')!;
    expect(scenarioSelect.children.map((c) => c.value)).toEqual([
      'manhattan-bridge',
      'express-overtake',
      'lexington-underground',
      'steinway-queens',
      'midtown-multi-system',
    ]);

    // Update with sample snapshot
    hud.setUiState({
      connectivity: { online: false, swState: 'ready' },
    });
    hud.update(makeSampleSnapshot());

    expect(container.findByTestId('hud-train-identity')?.textContent).toBe(
      'D Express — Uptown',
    );
    expect(
      container.findByTestId('hud-confidence')?.getAttribute('data-confidence'),
    ).toBe('88');
    expect(container.findByTestId('hud-current-station')?.textContent).toBe(
      'DeKalb Ave',
    );
    expect(container.findByTestId('hud-next-station')?.textContent).toContain(
      'Grand St',
    );
    expect(container.findByTestId('hud-speed')?.textContent).toBe('32 mph');
    expect(container.findByTestId('hud-elevation')?.textContent).toBe(
      '+135 ft Bridge',
    );
    expect(
      container.findByTestId('sensor-status-gps')?.getAttribute('data-status'),
    ).toBe('simulated');
    expect(
      container.findByTestId('offline-status-badge')?.getAttribute('data-online'),
    ).toBe('false');
    expect(
      container.findByTestId('offline-status-badge')?.getAttribute('data-sw'),
    ).toBe('ready');

    // Nearby trains include distinct systems and avoid duplicated system prefixes
    const trainItems = container.findByTestId('nearby-trains-list')!.children;
    const systems = trainItems.map((el) => el.getAttribute('data-system'));
    expect(systems).toEqual(
      expect.arrayContaining(['MTA', 'LIRR', 'MNR', 'PATH', 'NJT', 'AIRTRAIN']),
    );
    const lirrItem = trainItems.find(
      (el) => el.getAttribute('data-system') === 'LIRR',
    )!;
    const lirrLabel = lirrItem.children[1]?.textContent ?? '';
    expect(lirrLabel).toBe('LIRR 420m');
    expect(lirrLabel).not.toContain('LIRR LIRR');

    // Nearby landmarks include east-river
    const lmItems = container.findByTestId('nearby-landmarks-list')!.children;
    expect(lmItems.map((el) => el.getAttribute('data-landmark'))).toContain(
      'east-river',
    );

    hud.dispose();
  });

  it('cycles view mode, fires calibration/demo/gyro/reset callbacks, and isolates touch/pointer events', () => {
    const doc = new MockDocument();
    const container = doc.createElement('div');
    const dataset = getTransitDataset();
    const callbacks = createCallbacks();

    const hud = new HudController(
      container as unknown as HTMLElement,
      dataset,
      callbacks,
      { doc: doc as unknown as Document },
    );

    // Touch/pointer isolation: parent container must NEVER receive pointer/touch from HUD controls
    const parentPointerSpy = vi.fn();
    const parentTouchSpy = vi.fn();
    container.addEventListener('pointerdown', parentPointerSpy);
    container.addEventListener('touchstart', parentTouchSpy);

    const viewBtn = container.findByTestId('btn-view-mode')!;
    viewBtn.dispatchEvent(new MockEvent('pointerdown'));
    viewBtn.dispatchEvent(new MockEvent('touchstart'));
    expect(parentPointerSpy).not.toHaveBeenCalled();
    expect(parentTouchSpy).not.toHaveBeenCalled();

    // View mode cycling: inside -> ghost -> chase -> inside
    viewBtn.click();
    expect(callbacks.onChangeViewMode).toHaveBeenLastCalledWith('ghost');
    hud.setUiState({ viewMode: 'ghost' });
    viewBtn.click();
    expect(callbacks.onChangeViewMode).toHaveBeenLastCalledWith('chase');
    hud.setUiState({ viewMode: 'chase' });
    viewBtn.click();
    expect(callbacks.onChangeViewMode).toHaveBeenLastCalledWith('inside');

    // Gyro & Reset view
    container.findByTestId('btn-gyro-toggle')!.click();
    expect(callbacks.onToggleGyro).toHaveBeenCalledTimes(1);
    container.findByTestId('btn-reset-view')!.click();
    expect(callbacks.onResetView).toHaveBeenCalledTimes(1);

    // Calibration drawer flow
    const calDrawer = container.findByTestId('calibrate-drawer')!;
    expect(calDrawer.hidden).toBe(true);
    container.findByTestId('btn-calibrate')!.click();
    expect(calDrawer.hidden).toBe(false);

    const stationSelect = container.findByTestId('calibrate-station-select')!;
    const lineSelect = container.findByTestId('calibrate-line-select')!;
    stationSelect.value = dataset.stations[0].id;
    lineSelect.value = 'A';
    container.findByTestId('btn-calibrate-apply')!.click();
    expect(callbacks.onApplyCalibration).toHaveBeenCalledWith({
      stationId: dataset.stations[0].id,
      routeId: 'A',
    });
    expect(calDrawer.hidden).toBe(true);

    // Demo controls flow
    container.findByTestId('btn-demo-mode')!.click();
    expect(callbacks.onEnterDemoMode).toHaveBeenCalledWith('manhattan-bridge');
    hud.setUiState({ demoMode: true });

    const scenarioSelect = container.findByTestId('demo-scenario-select')!;
    scenarioSelect.value = 'midtown-multi-system';
    scenarioSelect.dispatchEvent(new MockEvent('change'));
    expect(callbacks.onSelectScenario).toHaveBeenCalledWith(
      'midtown-multi-system',
    );

    container.findByTestId('btn-demo-play-pause')!.click();
    expect(callbacks.onToggleDemoPause).toHaveBeenCalledTimes(1);
    container.findByTestId('btn-demo-speed-5')!.click();
    expect(callbacks.onSelectDemoSpeed).toHaveBeenCalledWith(5);
    container.findByTestId('btn-live-mode')!.click();
    expect(callbacks.onExitDemoMode).toHaveBeenCalledTimes(1);

    // Out-of-NYC & GPS denied banners
    const outSnap = makeSampleSnapshot({
      mode: 'live',
      ego: {
        ...makeSampleSnapshot().ego,
        outOfNyc: true,
        sensorStatus: { gps: 'denied', dr: 'standby', timing: 'active' },
      },
    });
    hud.update(outSnap);
    expect(container.findByTestId('out-of-nyc-banner')?.hidden).toBe(false);
    expect(container.findByTestId('sensor-permission-notice')?.hidden).toBe(
      false,
    );

    // Banner Demo / Try Demo buttons clear hud-btn--active and aria-expanded on btn-calibrate
    const calBtn = container.findByTestId('btn-calibrate')!;
    calBtn.click();
    expect(calDrawer.hidden).toBe(false);
    expect(calBtn.classList.contains('hud-btn--active')).toBe(true);
    expect(calBtn.getAttribute('aria-expanded')).toBe('true');

    container.findByTestId('btn-out-of-nyc-demo')!.click();
    expect(calDrawer.hidden).toBe(true);
    expect(calBtn.classList.contains('hud-btn--active')).toBe(false);
    expect(calBtn.getAttribute('aria-expanded')).toBe('false');

    calBtn.click();
    expect(calBtn.classList.contains('hud-btn--active')).toBe(true);
    container.findByTestId('btn-sensor-notice-demo')!.click();
    expect(calDrawer.hidden).toBe(true);
    expect(calBtn.classList.contains('hud-btn--active')).toBe(false);
    expect(calBtn.getAttribute('aria-expanded')).toBe('false');

    hud.dispose();
  });
});

describe('UI: FallbackView', () => {
  it('toggles unavailable and context-lost states and triggers retry callback', () => {
    const doc = new MockDocument();
    const container = doc.createElement('div');
    const onRetry = vi.fn();

    const fb = new FallbackView(container as unknown as HTMLElement, {
      doc: doc as unknown as Document,
      onRetry,
    });
    expect(fb.isVisible()).toBe(false);

    fb.showUnavailable();
    expect(fb.isVisible()).toBe(true);
    expect(
      container
        .findByTestId('webgl-fallback-banner')
        ?.getAttribute('data-reason'),
    ).toBe('unavailable');

    fb.showContextLost();
    expect(
      container
        .findByTestId('webgl-fallback-banner')
        ?.getAttribute('data-reason'),
    ).toBe('context-lost');

    container.findByTestId('btn-webgl-retry')!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    fb.hide();
    expect(fb.isVisible()).toBe(false);
    fb.dispose();
  });
});

describe('App: SubwaySightApp wiring, iOS gyro permission & WebGL fallback', () => {
  function setupBrowserStubs() {
    const winObj: Record<string, unknown> = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('window', winObj);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    return winObj;
  }

  function createFakeSceneManager(): SceneManagerLike {
    let viewMode = 'inside';
    let frames = 0;
    return {
      update: vi.fn(() => {
        frames++;
      }),
      setViewMode: vi.fn((m) => {
        viewMode = m;
      }),
      setGyroEnabled: vi.fn(),
      handleDeviceOrientation: vi.fn(),
      resetCameraView: vi.fn(),
      getCameraDebug: () => ({
        yaw: 0.1,
        pitch: -0.05,
        position: [1, 2, 3],
        viewMode,
        drawCalls: 21,
        frameCount: frames,
      }),
      dispose: vi.fn(),
    };
  }

  it('wires canvas, HUD, Demo Mode, DebugSnapshot, and synchronous iOS gyro permission', async () => {
    const winObj = setupBrowserStubs();
    const requestPermSpy = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('DeviceOrientationEvent', {
      requestPermission: requestPermSpy,
    });

    const doc = new MockDocument();
    const container = doc.createElement('div');
    const fakeScene = createFakeSceneManager();

    const app = new SubwaySightApp(container as unknown as HTMLElement, {
      doc: doc as unknown as Document,
      createSceneManager: () => fakeScene,
    });

    // iOS requestPermission MUST NOT be called on page load!
    expect(requestPermSpy).not.toHaveBeenCalled();

    // Canvas & HUD mounted as siblings
    expect(container.findByTestId('scene-canvas')).not.toBeNull();
    expect(container.findByTestId('hud-root')).not.toBeNull();

    // DebugSnapshot published on window.__SUBWAY_VISION_STATE__
    const initDebug = winObj.__SUBWAY_VISION_STATE__ as {
      mode: string;
      drawCalls: number;
      camera: { viewMode: string };
    };
    expect(initDebug).toBeDefined();
    expect(initDebug.mode).toBe('live');
    expect(initDebug.drawCalls).toBe(21);
    expect(initDebug.camera.viewMode).toBe('inside');

    // Click btn-gyro-toggle -> MUST call requestPermission synchronously inside click handler
    container.findByTestId('btn-gyro-toggle')!.click();
    expect(requestPermSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(fakeScene.setGyroEnabled).toHaveBeenCalledWith(true);
    });

    // Click btn-demo-mode -> enters sim mode, primes synchronously, updates DebugSnapshot
    container.findByTestId('btn-demo-mode')!.click();
    const demoDebug = app.getDebugSnapshot();
    expect(demoDebug.mode).toBe('sim');
    expect(demoDebug.sensorStatus.gps).toBe('simulated');

    // Switch scenario to midtown-multi-system
    const scenarioSelect = container.findByTestId('demo-scenario-select')!;
    scenarioSelect.value = 'midtown-multi-system';
    scenarioSelect.dispatchEvent(new MockEvent('change'));
    expect(app.getLatestSnapshot().scenarioId).toBe('midtown-multi-system');

    app.dispose();
    expect(fakeScene.dispose).toHaveBeenCalledTimes(1);
  });

  it('recovers gracefully without crashing when WebGL SceneManager throws', () => {
    setupBrowserStubs();
    const doc = new MockDocument();
    const container = doc.createElement('div');

    const app = new SubwaySightApp(container as unknown as HTMLElement, {
      doc: doc as unknown as Document,
      createSceneManager: () => {
        throw new Error('WebGL2 not supported');
      },
    });

    expect(container.findByTestId('webgl-fallback-banner')?.hidden).toBe(false);
    expect(app.getDebugSnapshot().drawCalls).toBe(0);

    // Demo mode & HUD continue working even without WebGL
    app.enterDemoMode('manhattan-bridge');
    expect(app.getDebugSnapshot().mode).toBe('sim');

    app.dispose();
  });

  it('invokes BOTH DeviceMotionEvent and DeviceOrientationEvent requestPermission() synchronously on btn-gyro-toggle click', async () => {
    setupBrowserStubs();
    let resolveMotion!: (v: 'granted' | 'denied') => void;
    let resolveOrient!: (v: 'granted' | 'denied') => void;
    const motionPermSpy = vi.fn(
      () =>
        new Promise<'granted' | 'denied'>((resolve) => {
          resolveMotion = resolve;
        }),
    );
    const orientPermSpy = vi.fn(
      () =>
        new Promise<'granted' | 'denied'>((resolve) => {
          resolveOrient = resolve;
        }),
    );
    vi.stubGlobal('DeviceMotionEvent', { requestPermission: motionPermSpy });
    vi.stubGlobal('DeviceOrientationEvent', {
      requestPermission: orientPermSpy,
    });

    const doc = new MockDocument();
    const container = doc.createElement('div');
    const fakeScene = createFakeSceneManager();

    const app = new SubwaySightApp(container as unknown as HTMLElement, {
      doc: doc as unknown as Document,
      createSceneManager: () => fakeScene,
    });

    // Neither permission API may be invoked on startup
    expect(motionPermSpy).not.toHaveBeenCalled();
    expect(orientPermSpy).not.toHaveBeenCalled();

    // Clicking btn-gyro-toggle MUST invoke BOTH synchronously before any microtask resolves
    container.findByTestId('btn-gyro-toggle')!.click();
    expect(motionPermSpy).toHaveBeenCalledTimes(1);
    expect(orientPermSpy).toHaveBeenCalledTimes(1);

    // Resolve both as granted -> gyro turns on
    resolveMotion('granted');
    resolveOrient('granted');
    await vi.waitFor(() => {
      expect(fakeScene.setGyroEnabled).toHaveBeenCalledWith(true);
    });
    expect(
      container.findByTestId('btn-gyro-toggle')?.getAttribute('aria-pressed'),
    ).toBe('true');

    // Toggle off, then test partial denial (motion granted, orientation denied) -> stays off
    container.findByTestId('btn-gyro-toggle')!.click();
    expect(
      container.findByTestId('btn-gyro-toggle')?.getAttribute('aria-pressed'),
    ).toBe('false');

    motionPermSpy.mockResolvedValueOnce('granted');
    orientPermSpy.mockResolvedValueOnce('denied');
    container.findByTestId('btn-gyro-toggle')!.click();
    expect(motionPermSpy).toHaveBeenCalledTimes(2);
    expect(orientPermSpy).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => {
      expect(
        container.findByTestId('btn-gyro-toggle')?.getAttribute('aria-pressed'),
      ).toBe('false');
    });

    app.dispose();
  });

  it('resets stationId and hud-train-identity out of manual calibration lock when clicking btn-calibrate-reset', () => {
    setupBrowserStubs();
    const doc = new MockDocument();
    const container = doc.createElement('div');
    const fakeScene = createFakeSceneManager();

    const app = new SubwaySightApp(container as unknown as HTMLElement, {
      doc: doc as unknown as Document,
      createSceneManager: () => fakeScene,
    });

    // Open calibration drawer, select a specific station & line, and apply
    container.findByTestId('btn-calibrate')!.click();
    const stationSelect = container.findByTestId('calibrate-station-select')!;
    const lineSelect = container.findByTestId('calibrate-line-select')!;
    stationSelect.value = 'mta-116st-columbia';
    lineSelect.value = '1';
    container.findByTestId('btn-calibrate-apply')!.click();

    const afterApply = app.getDebugSnapshot();
    expect(afterApply.estimate.stationId).toBe('mta-116st-columbia');
    expect(app.getLatestSnapshot().ego.manualAnchorActive).toBe(true);
    const identityAfterApply =
      container.findByTestId('hud-train-identity')?.textContent ?? '';
    expect(identityAfterApply).toContain('1');

    // Click btn-calibrate-reset -> MUST clear manual anchor and reset particles/identity
    container.findByTestId('btn-calibrate')!.click();
    container.findByTestId('btn-calibrate-reset')!.click();

    const afterReset = app.getDebugSnapshot();
    expect(app.getLatestSnapshot().ego.manualAnchorActive).toBe(false);
    expect(afterReset.estimate.stationId).not.toBe('mta-116st-columbia');
    expect(
      container.findByTestId('hud-train-identity')?.textContent,
    ).not.toBe(identityAfterApply);

    app.dispose();
  });

  it('toggles Demo Mode ON and OFF via btn-demo-mode and filters calibration lines by selected station', () => {
    setupBrowserStubs();
    const doc = new MockDocument();
    const container = doc.createElement('div');
    const fakeScene = createFakeSceneManager();

    const app = new SubwaySightApp(container as unknown as HTMLElement, {
      doc: doc as unknown as Document,
      createSceneManager: () => fakeScene,
    });

    const demoBtn = container.findByTestId('btn-demo-mode')!;
    expect(app.getDebugSnapshot().mode).toBe('live');

    // Click btn-demo-mode -> enters sim mode
    demoBtn.click();
    expect(app.getDebugSnapshot().mode).toBe('sim');
    expect(container.findByTestId('demo-drawer')?.hidden).toBe(false);

    // Click btn-demo-mode again -> exits sim mode back to live
    demoBtn.click();
    expect(app.getDebugSnapshot().mode).toBe('live');
    expect(container.findByTestId('demo-drawer')?.hidden).toBe(true);

    // Calibration station -> line filtering
    container.findByTestId('btn-calibrate')!.click();
    const stationSelect = container.findByTestId('calibrate-station-select')!;
    const lineSelect = container.findByTestId('calibrate-line-select')!;
    const allLineCount = lineSelect.children.length;
    expect(allLineCount).toBeGreaterThan(5);

    stationSelect.value = 'mta-canal-ace';
    stationSelect.dispatchEvent(new MockEvent('change'));
    const filteredValues = lineSelect.children
      .map((opt) => opt.value)
      .filter((v) => v.length > 0);
    expect(filteredValues.length).toBeGreaterThan(0);
    expect(filteredValues.length).toBeLessThan(allLineCount - 1);
    expect(filteredValues).toContain('A');
    expect(filteredValues).not.toContain('1');

    // Clearing station restores full line list
    stationSelect.value = '';
    stationSelect.dispatchEvent(new MockEvent('change'));
    expect(lineSelect.children.length).toBe(allLineCount);

    app.dispose();
  });

  it('enables gyro look-around in Demo (sim) mode and processes deviceorientation once in live mode', async () => {
    const winListeners = new Map<string, Set<(ev: unknown) => void>>();
    const winObj: Record<string, unknown> = {
      addEventListener: vi.fn((type: string, cb: (ev: unknown) => void) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type)!.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: (ev: unknown) => void) => {
        winListeners.get(type)?.delete(cb);
      }),
    };
    vi.stubGlobal('window', winObj);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const doc = new MockDocument();
    const container = doc.createElement('div');
    const fakeScene = createFakeSceneManager();

    const app = new SubwaySightApp(container as unknown as HTMLElement, {
      doc: doc as unknown as Document,
      createSceneManager: () => fakeScene,
    });

    // Enter Demo Mode first, then enable gyro
    app.enterDemoMode('manhattan-bridge');
    container.findByTestId('btn-gyro-toggle')!.click();
    await vi.waitFor(() => {
      expect(fakeScene.setGyroEnabled).toHaveBeenCalledWith(true);
    });

    // Dispatch deviceorientation while in Demo (sim) mode -> SceneManager receives it
    for (const cb of winListeners.get('deviceorientation') ?? []) {
      cb({ alpha: 45, beta: 70, gamma: -5 });
    }
    expect(fakeScene.handleDeviceOrientation).toHaveBeenCalledTimes(1);
    expect(fakeScene.handleDeviceOrientation).toHaveBeenCalledWith(45, 70, -5, 0);

    // Exit to Live mode -> deviceorientation is processed exactly once (not duplicated via LiveSensorSource)
    app.exitDemoMode();
    for (const cb of winListeners.get('deviceorientation') ?? []) {
      cb({ alpha: 90, beta: 65, gamma: 10 });
    }
    expect(fakeScene.handleDeviceOrientation).toHaveBeenCalledTimes(2);

    app.dispose();
    expect(winListeners.get('deviceorientation')?.size ?? 0).toBe(0);
  });

  it('recovers live heartbeat and calibration schedule period after a backward Date.now() clock jump', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-19T17:00:00Z'));
      setupBrowserStubs();

      const doc = new MockDocument();
      const container = doc.createElement('div');
      const fakeScene = createFakeSceneManager();

      const app = new SubwaySightApp(container as unknown as HTMLElement, {
        doc: doc as unknown as Document,
        createSceneManager: () => fakeScene,
      });

      expect(app.getLatestSnapshot().timestampMs).toBe(
        new Date('2026-11-19T17:00:00Z').getTime(),
      );

      // Jump clock backwards ~5 months to Tuesday 2:30 AM EDT (LATE_NIGHT)
      const lateNightDate = new Date('2026-06-16T02:30:00-04:00');
      vi.setSystemTime(lateNightDate);

      // Live heartbeat must still fire after backward jump
      vi.advanceTimersByTime(1100);
      expect(app.getLatestSnapshot().timestampMs).toBeGreaterThanOrEqual(
        lateNightDate.getTime(),
      );
      expect(app.getLatestSnapshot().timestampMs).toBeLessThan(
        lateNightDate.getTime() + 5_000,
      );

      // Manual calibration on A at 14th St during LATE_NIGHT classifies A as LOCAL
      container.findByTestId('btn-calibrate')!.click();
      const stationSelect = container.findByTestId('calibrate-station-select')!;
      const lineSelect = container.findByTestId('calibrate-line-select')!;
      stationSelect.value = 'mta-14st-ace';
      stationSelect.dispatchEvent(new MockEvent('change'));
      lineSelect.value = 'A';
      container.findByTestId('btn-calibrate-apply')!.click();

      const calDebug = app.getDebugSnapshot();
      expect(calDebug.estimate.line).toBe('A');
      expect(calDebug.estimate.serviceType).toBe('LOCAL');
      expect(calDebug.estimate.confidence).toBeGreaterThanOrEqual(80);

      app.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
