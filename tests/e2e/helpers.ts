import { expect, type Locator, type Page } from '@playwright/test';

export type GpsSensorStatus = 'locked' | 'stale' | 'lost' | 'denied' | 'simulated';
export type DrSensorStatus = 'active' | 'standby' | 'unavailable' | 'simulated';
export type TimingSensorStatus = 'active' | 'degraded';
export type ViewMode = 'inside' | 'ghost' | 'chase';
export type RailSystem = 'MTA' | 'LIRR' | 'MNR' | 'PATH' | 'NJT' | 'AIRTRAIN';
export type DemoScenarioId =
  | 'manhattan-bridge'
  | 'express-overtake'
  | 'lexington-underground'
  | 'steinway-queens'
  | 'midtown-multi-system';

export const VALID_RAIL_SYSTEMS: ReadonlySet<string> = new Set<RailSystem>([
  'MTA',
  'LIRR',
  'MNR',
  'PATH',
  'NJT',
  'AIRTRAIN',
]);

/**
 * Opaque-box mirror of `window.__SUBWAY_VISION_STATE__`
 * defined in PROJECT.md § Interface Contracts #4.
 * NEVER import types from src/.
 */
export interface SubwayVisionState {
  camera: {
    yaw: number;
    pitch: number;
    position: [number, number, number];
    viewMode: ViewMode | string;
  };
  estimate: {
    line: string | null;
    serviceType: string;
    direction: string;
    confidence: number;
    stationId: string | null;
    nextStationId: string | null;
    elevationFt: number;
    speedMph: number;
    outOfNyc: boolean;
  };
  sensorStatus: {
    gps: GpsSensorStatus;
    dr: DrSensorStatus;
    timing: TimingSensorStatus;
  };
  visibleLandmarks: string[];
  visibleSystems: string[];
  nearbyTrainCount: number;
  drawCalls: number;
  frameCount: number;
  mode: string;
}

export const VIEWPORT_PORTRAIT = { width: 390, height: 844 } as const;
export const VIEWPORT_LANDSCAPE = { width: 844, height: 390 } as const;

const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:4173',
  'http://localhost:4173',
]);
const ALLOWED_SCHEMES = ['data:', 'blob:', 'about:'];

export function isAllowedLocalUrl(rawUrl: string): boolean {
  if (ALLOWED_SCHEMES.some((scheme) => rawUrl.startsWith(scheme))) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

export interface RuntimeMonitors {
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: Array<{ url: string; reason: string }>;
  allRequests: string[];
  externalRequests: string[];
  reset(): void;
  assertZeroExternalRequests(): void;
  assertClean(options?: { allowRequestFailed?: boolean }): void;
}

/**
 * Attach before `page.goto()` to capture uncaught errors, console errors,
 * failed requests, and any external-origin network requests.
 */
export function attachRuntimeMonitors(page: Page): RuntimeMonitors {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: Array<{ url: string; reason: string }> = [];
  const allRequests: string[] = [];
  const externalRequests: string[] = [];

  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err));
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('requestfailed', (req) => {
    failedRequests.push({
      url: req.url(),
      reason: req.failure()?.errorText ?? 'unknown',
    });
  });

  page.on('request', (req) => {
    const url = req.url();
    allRequests.push(url);
    if (!isAllowedLocalUrl(url)) {
      externalRequests.push(url);
    }
  });

  return {
    pageErrors,
    consoleErrors,
    failedRequests,
    allRequests,
    externalRequests,
    reset() {
      pageErrors.length = 0;
      consoleErrors.length = 0;
      failedRequests.length = 0;
      allRequests.length = 0;
      externalRequests.length = 0;
    },
    assertZeroExternalRequests() {
      expect(
        externalRequests,
        `Unexpected external network requests: ${externalRequests.join(', ')}`
      ).toEqual([]);
    },
    assertClean(options?: { allowRequestFailed?: boolean }) {
      expect(pageErrors, `Uncaught pageerrors: ${pageErrors.join(' | ')}`).toEqual([]);
      expect(consoleErrors, `Console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      this.assertZeroExternalRequests();
      if (!options?.allowRequestFailed) {
        expect(
          failedRequests,
          `Failed requests: ${JSON.stringify(failedRequests)}`
        ).toEqual([]);
      }
    },
  };
}

/**
 * Read the current `window.__SUBWAY_VISION_STATE__` snapshot.
 */
export async function getAppState(page: Page): Promise<SubwayVisionState | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __SUBWAY_VISION_STATE__?: SubwayVisionState };
    return w.__SUBWAY_VISION_STATE__ ?? null;
  });
}

/**
 * Poll `window.__SUBWAY_VISION_STATE__` until `predicate` returns true.
 */
export async function waitForAppState(
  page: Page,
  predicate: (state: SubwayVisionState) => boolean,
  options?: { timeout?: number; message?: string }
): Promise<SubwayVisionState> {
  const timeout = options?.timeout ?? 12_000;
  let lastState: SubwayVisionState | null = null;
  await expect
    .poll(
      async () => {
        lastState = await getAppState(page);
        return lastState !== null && predicate(lastState);
      },
      {
        timeout,
        intervals: [100, 200, 300],
        message: options?.message ?? 'Timed out waiting for __SUBWAY_VISION_STATE__ condition',
      }
    )
    .toBe(true);
  return lastState!;
}

/**
 * Wait for app boot: WebGL canvas visible with non-zero size and frameCount >= minFrames.
 */
export async function waitForAppReady(
  page: Page,
  options?: { timeout?: number; minFrames?: number }
): Promise<SubwayVisionState> {
  const timeout = options?.timeout ?? 15_000;
  const minFrames = options?.minFrames ?? 3;

  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toBeVisible({ timeout });

  await expect
    .poll(
      async () => {
        const box = await canvas.boundingBox();
        return !!box && box.width > 50 && box.height > 50;
      },
      { timeout, message: 'scene-canvas did not reach non-zero dimensions' }
    )
    .toBe(true);

  return waitForAppState(page, (s) => s.frameCount >= minFrames, {
    timeout,
    message: `App did not reach frameCount >= ${minFrames}`,
  });
}

export interface CanvasSampleStats {
  width: number;
  height: number;
  sampledPixels: number;
  nonTransparentRatio: number;
  nonBlackRatio: number;
  distinctColorBuckets: number;
}

/**
 * Sample pixels from the WebGL canvas (which sets preserveDrawingBuffer: true)
 * by downsampling onto an offscreen 2D canvas.
 */
export async function sampleCanvasPixels(page: Page): Promise<CanvasSampleStats> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="scene-canvas"]');
    if (!canvas) {
      throw new Error('scene-canvas not found');
    }
    const sampleSize = 128;
    const offscreen = document.createElement('canvas');
    offscreen.width = sampleSize;
    offscreen.height = sampleSize;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Could not create 2D context for canvas sampling');
    }
    ctx.drawImage(canvas, 0, 0, sampleSize, sampleSize);
    const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);

    const total = sampleSize * sampleSize;
    let nonTransparent = 0;
    let nonBlack = 0;
    const buckets = new Set<number>();

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a > 10) nonTransparent++;
      if (r + g + b > 15 && a > 10) nonBlack++;
      const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      buckets.add(bucket);
    }

    return {
      width: canvas.width,
      height: canvas.height,
      sampledPixels: total,
      nonTransparentRatio: nonTransparent / total,
      nonBlackRatio: nonBlack / total,
      distinctColorBuckets: buckets.size,
    };
  });
}

/**
 * Assert that the 3D WebGL canvas is actively rendering non-blank, multi-color geometry.
 */
export async function assertCanvasNonBlank(page: Page): Promise<CanvasSampleStats> {
  const stats = await sampleCanvasPixels(page);
  expect(stats.width, 'Canvas internal width must be > 0').toBeGreaterThan(0);
  expect(stats.height, 'Canvas internal height must be > 0').toBeGreaterThan(0);
  expect(stats.nonTransparentRatio, 'Canvas appears fully transparent').toBeGreaterThan(0.5);
  expect(stats.nonBlackRatio, 'Canvas appears blank/all-black').toBeGreaterThan(0.02);
  expect(
    stats.distinctColorBuckets,
    'Canvas appears to be a single uniform flat color (no 3D scene geometry)'
  ).toBeGreaterThanOrEqual(4);
  return stats;
}

// ---------------------------------------------------------------------------
// Mock Geolocation (supports custom accuracy, speed, heading, and error codes)
// ---------------------------------------------------------------------------

export interface MockGeoCoords {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}

export type MockGeoErrorCode = 1 | 2 | 3; // 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT

export interface MockGeoInitOptions {
  initialPosition?: { coords: MockGeoCoords; timestamp?: number };
  initialError?: { code: MockGeoErrorCode; message?: string };
}

/**
 * Install a deterministic mock `navigator.geolocation` BEFORE `page.goto()`.
 * Persists across reloads via `page.addInitScript`.
 */
export async function installMockGeolocation(
  page: Page,
  options: MockGeoInitOptions = {}
): Promise<void> {
  await page.addInitScript((initOpts: MockGeoInitOptions) => {
    type WatchEntry = {
      success: PositionCallback;
      error?: PositionErrorCallback | null;
    };

    let nextWatchId = 1;
    const watchers = new Map<number, WatchEntry>();
    let latestPosition: GeolocationPosition | null = null;
    let latestError: GeolocationPositionError | null = null;
    let paused = false;

    const toGeoPosition = (
      coords: MockGeoCoords,
      timestamp?: number
    ): GeolocationPosition => {
      const c = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy ?? 10,
        altitude: coords.altitude ?? null,
        altitudeAccuracy: coords.altitudeAccuracy ?? null,
        heading: coords.heading ?? null,
        speed: coords.speed ?? null,
        toJSON() {
          return { ...this };
        },
      };
      return {
        coords: c as GeolocationCoordinates,
        timestamp: timestamp ?? Date.now(),
        toJSON() {
          return { coords: c, timestamp: this.timestamp };
        },
      } as GeolocationPosition;
    };

    const toGeoError = (
      code: MockGeoErrorCode,
      message?: string
    ): GeolocationPositionError => ({
      code,
      message:
        message ??
        (code === 1
          ? 'User denied Geolocation'
          : code === 2
            ? 'Position unavailable'
            : 'Geolocation timeout'),
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    });

    if (initOpts.initialPosition) {
      latestPosition = toGeoPosition(
        initOpts.initialPosition.coords,
        initOpts.initialPosition.timestamp
      );
    }
    if (initOpts.initialError) {
      latestError = toGeoError(
        initOpts.initialError.code,
        initOpts.initialError.message
      );
    }

    const mockGeolocation: Geolocation = {
      getCurrentPosition(success, error) {
        queueMicrotask(() => {
          if (paused) return;
          if (latestError && error) {
            error(latestError);
          } else if (latestPosition) {
            success(latestPosition);
          }
        });
      },
      watchPosition(success, error) {
        const id = nextWatchId++;
        watchers.set(id, { success, error });
        queueMicrotask(() => {
          if (paused || !watchers.has(id)) return;
          if (latestError && error) {
            error(latestError);
          } else if (latestPosition) {
            success(latestPosition);
          }
        });
        return id;
      },
      clearWatch(id: number) {
        watchers.delete(id);
      },
    };

    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      get: () => mockGeolocation,
    });

    (window as unknown as Record<string, unknown>).__E2E_GEO__ = {
      pushPosition(coords: MockGeoCoords, timestamp?: number) {
        paused = false;
        latestError = null;
        latestPosition = toGeoPosition(coords, timestamp);
        for (const entry of watchers.values()) {
          entry.success(latestPosition);
        }
      },
      pushError(code: MockGeoErrorCode, message?: string) {
        latestError = toGeoError(code, message);
        for (const entry of watchers.values()) {
          entry.error?.(latestError);
        }
      },
      pause() {
        paused = true;
      },
      getWatchCount() {
        return watchers.size;
      },
    };
  }, options);
}

export async function emitMockGeolocation(
  page: Page,
  coords: MockGeoCoords,
  timestamp?: number
): Promise<void> {
  await page.evaluate(
    ({ c, ts }) => {
      const ctrl = (window as unknown as {
        __E2E_GEO__?: { pushPosition: (coords: MockGeoCoords, ts?: number) => void };
      }).__E2E_GEO__;
      if (!ctrl) {
        throw new Error('installMockGeolocation(page) must be called before page.goto()');
      }
      ctrl.pushPosition(c, ts);
    },
    { c: coords, ts: timestamp }
  );
}

export async function emitMockGeolocationError(
  page: Page,
  code: MockGeoErrorCode,
  message?: string
): Promise<void> {
  await page.evaluate(
    ({ errCode, errMsg }) => {
      const ctrl = (window as unknown as {
        __E2E_GEO__?: { pushError: (code: MockGeoErrorCode, msg?: string) => void };
      }).__E2E_GEO__;
      if (!ctrl) {
        throw new Error('installMockGeolocation(page) must be called before page.goto()');
      }
      ctrl.pushError(errCode, errMsg);
    },
    { errCode: code, errMsg: message }
  );
}

export async function pauseMockGeolocation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ctrl = (window as unknown as {
      __E2E_GEO__?: { pause: () => void };
    }).__E2E_GEO__;
    if (!ctrl) {
      throw new Error('installMockGeolocation(page) must be called before page.goto()');
    }
    ctrl.pause();
  });
}

// ---------------------------------------------------------------------------
// IMU & Orientation Event Helpers
// ---------------------------------------------------------------------------

export interface MockDeviceMotionInput {
  acceleration?: { x: number; y: number; z: number };
  accelerationIncludingGravity?: { x: number; y: number; z: number };
  rotationRate?: { alpha: number; beta: number; gamma: number };
  interval?: number;
}

export async function dispatchDeviceMotion(
  page: Page,
  input: MockDeviceMotionInput
): Promise<void> {
  await page.evaluate((payload: MockDeviceMotionInput) => {
    const accel = payload.acceleration ?? { x: 0, y: 0, z: 0 };
    const accelGrav = payload.accelerationIncludingGravity ?? {
      x: accel.x,
      y: accel.y,
      z: accel.z + 9.81,
    };
    const rot = payload.rotationRate ?? { alpha: 0, beta: 0, gamma: 0 };
    const interval = payload.interval ?? 50;

    let evt: Event;
    try {
      evt = new DeviceMotionEvent('devicemotion', {
        acceleration: accel,
        accelerationIncludingGravity: accelGrav,
        rotationRate: rot,
        interval,
      });
    } catch {
      evt = new Event('devicemotion');
      Object.defineProperties(evt, {
        acceleration: { value: accel },
        accelerationIncludingGravity: { value: accelGrav },
        rotationRate: { value: rot },
        interval: { value: interval },
      });
    }
    window.dispatchEvent(evt);
  }, input);
}

/**
 * Dispatch a realistic stream of `DeviceMotionEvent` samples in-page to drive
 * dead reckoning (forward acceleration + rail vibration RMS + optional yaw rate).
 */
export async function dispatchMotionBurst(
  page: Page,
  options?: {
    samples?: number;
    intervalMs?: number;
    forwardAccel?: number;
    vibrationAmp?: number;
    yawRate?: number;
  }
): Promise<void> {
  const samples = options?.samples ?? 30;
  const intervalMs = options?.intervalMs ?? 50;
  const forwardAccel = options?.forwardAccel ?? 1.1;
  const vibrationAmp = options?.vibrationAmp ?? 0.35;
  const yawRate = options?.yawRate ?? 0.02;

  await page.evaluate(
    async ({ count, dt, fwd, vib, yaw }) => {
      for (let i = 0; i < count; i++) {
        const ax = vib * Math.sin(i * 1.3);
        const ay = fwd + vib * Math.cos(i * 1.7);
        const az = vib * Math.sin(i * 2.3);
        const accel = { x: ax, y: ay, z: az };
        const accelGrav = { x: ax, y: ay, z: az + 9.81 };
        const rot = { alpha: 0.01, beta: 0.01, gamma: yaw };

        let evt: Event;
        try {
          evt = new DeviceMotionEvent('devicemotion', {
            acceleration: accel,
            accelerationIncludingGravity: accelGrav,
            rotationRate: rot,
            interval: dt,
          });
        } catch {
          evt = new Event('devicemotion');
          Object.defineProperties(evt, {
            acceleration: { value: accel },
            accelerationIncludingGravity: { value: accelGrav },
            rotationRate: { value: rot },
            interval: { value: dt },
          });
        }
        window.dispatchEvent(evt);
        await new Promise((resolve) => setTimeout(resolve, dt));
      }
    },
    { count: samples, dt: intervalMs, fwd: forwardAccel, vib: vibrationAmp, yaw: yawRate }
  );
}

export interface MockDeviceOrientationInput {
  alpha: number;
  beta: number;
  gamma: number;
  absolute?: boolean;
  webkitCompassHeading?: number;
}

export async function dispatchDeviceOrientation(
  page: Page,
  input: MockDeviceOrientationInput
): Promise<void> {
  await page.evaluate((payload: MockDeviceOrientationInput) => {
    let evt: Event;
    try {
      evt = new DeviceOrientationEvent('deviceorientation', {
        alpha: payload.alpha,
        beta: payload.beta,
        gamma: payload.gamma,
        absolute: payload.absolute ?? false,
      });
    } catch {
      evt = new Event('deviceorientation');
      Object.defineProperties(evt, {
        alpha: { value: payload.alpha },
        beta: { value: payload.beta },
        gamma: { value: payload.gamma },
        absolute: { value: payload.absolute ?? false },
      });
    }
    if (payload.webkitCompassHeading !== undefined) {
      Object.defineProperty(evt, 'webkitCompassHeading', {
        value: payload.webkitCompassHeading,
      });
    }
    window.dispatchEvent(evt);
  }, input);
}

// ---------------------------------------------------------------------------
// Touch Drag Helpers (CDP native touch → triggers both TouchEvent & PointerEvent)
// ---------------------------------------------------------------------------

export interface TouchDragOptions {
  dx: number;
  dy: number;
  steps?: number;
  startOffsetX?: number;
  startOffsetY?: number;
}

/**
 * Perform a real touch drag on a target element via CDP `Input.dispatchTouchEvent`.
 * Works identically whether the app listens to TouchEvents or PointerEvents.
 */
export async function touchDragOnElement(
  page: Page,
  target: Locator,
  options: TouchDragOptions
): Promise<void> {
  const box = await target.boundingBox();
  if (!box) {
    throw new Error('Cannot touch-drag on element without a visible bounding box');
  }

  const startX = box.x + (options.startOffsetX ?? box.width / 2);
  const startY = box.y + (options.startOffsetY ?? box.height / 2);
  const steps = Math.max(2, options.steps ?? 10);

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: startX, y: startY, id: 1 }],
    });

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = startX + options.dx * t;
      const y = startY + options.dy * t;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y, id: 1 }],
      });
      await page.waitForTimeout(16);
    }

    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}

export async function touchDragOnCanvas(
  page: Page,
  dx: number,
  dy: number,
  steps = 10
): Promise<void> {
  await touchDragOnElement(page, page.getByTestId('scene-canvas'), { dx, dy, steps });
}

// ---------------------------------------------------------------------------
// Service Worker & Mode / Calibration Helpers
// ---------------------------------------------------------------------------

export async function waitForServiceWorkerReady(
  page: Page,
  timeout = 15_000
): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('ServiceWorker API not available');
    }
    await navigator.serviceWorker.ready;
  });

  await expect(page.getByTestId('offline-status-badge')).toHaveAttribute(
    'data-sw',
    'ready',
    { timeout }
  );
}

/**
 * Ensure the Service Worker is active AND controlling the page before going offline.
 * If the initial load did not yet claim the client, performs one online reload.
 */
export async function ensureServiceWorkerControlled(
  page: Page,
  timeout = 15_000
): Promise<void> {
  await waitForServiceWorkerReady(page, timeout);
  const hasController = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  if (!hasController) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, { timeout });
    await waitForServiceWorkerReady(page, timeout);
    const controlledAfterReload = await page.evaluate(
      () => navigator.serviceWorker.controller !== null
    );
    expect(controlledAfterReload, 'ServiceWorker must control page before offline reload').toBe(
      true
    );
  }
}

/**
 * Switch the app into `'live'` or `'sim'` mode via `[data-testid="btn-demo-mode"]`.
 */
export async function ensureMode(
  page: Page,
  desiredMode: 'live' | 'sim',
  timeout = 10_000
): Promise<SubwayVisionState> {
  const current = await getAppState(page);
  if (current?.mode !== desiredMode) {
    await page.getByTestId('btn-demo-mode').click();
  }
  return waitForAppState(page, (s) => s.mode === desiredMode, {
    timeout,
    message: `App did not switch to mode "${desiredMode}"`,
  });
}

/**
 * Enable Demo Mode and select the requested scenario via `[data-testid="demo-scenario-select"]`.
 */
export async function selectDemoScenario(
  page: Page,
  scenario: DemoScenarioId,
  timeout = 10_000
): Promise<SubwayVisionState> {
  await ensureMode(page, 'sim', timeout);
  const select = page.getByTestId('demo-scenario-select');
  await expect(select).toBeVisible({ timeout });
  await select.selectOption(scenario);
  const before = (await getAppState(page))?.frameCount ?? 0;
  return waitForAppState(page, (s) => s.mode === 'sim' && s.frameCount >= before + 2, {
    timeout,
    message: `Demo scenario "${scenario}" did not advance frames`,
  });
}

export interface SelectOptionInfo {
  value: string;
  label: string;
}

/**
 * Dynamically read all non-empty `<option>` entries from a `<select>` locator.
 */
export async function listSelectOptions(locator: Locator): Promise<SelectOptionInfo[]> {
  return locator.evaluate((el) => {
    const select = el as HTMLSelectElement;
    return Array.from(select.options)
      .map((opt) => ({
        value: opt.value.trim(),
        label: (opt.textContent ?? '').trim(),
      }))
      .filter((opt) => opt.value.length > 0);
  });
}

/**
 * Dynamically pick a valid non-empty option from a `<select>` without hardcoding IDs.
 */
export async function pickOptionDynamically(
  locator: Locator,
  preferredRegex?: RegExp,
  excludeValue?: string | null
): Promise<SelectOptionInfo> {
  const options = await listSelectOptions(locator);
  expect(options.length, 'Expected at least one non-empty <option>').toBeGreaterThan(0);

  const candidates = excludeValue
    ? options.filter((o) => o.value !== excludeValue)
    : options;
  const pool = candidates.length > 0 ? candidates : options;

  const chosen =
    (preferredRegex
      ? pool.find((o) => preferredRegex.test(o.label) || preferredRegex.test(o.value))
      : undefined) ?? pool[0];

  await locator.selectOption(chosen.value);
  return chosen;
}

/**
 * Parse the first finite signed number from a HUD text string (e.g., "-42 ft", "34.5 mph").
 */
export function parseFirstNumber(text: string): number {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return Number.NaN;
  }
  return Number.parseFloat(match[0]);
}

/**
 * Assert that a HUD string is non-empty and free of NaN/undefined/null/Infinity tokens.
 */
export function assertNoInvalidTokens(text: string | null, label: string): string {
  const trimmed = (text ?? '').trim();
  expect(trimmed.length, `${label} must be non-empty`).toBeGreaterThan(0);
  expect(trimmed, `${label} contains invalid token`).not.toMatch(/\b(NaN|undefined|null|Infinity)\b/i);
  return trimmed;
}
