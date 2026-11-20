import { expect, test } from '@playwright/test';
import {
  assertCanvasNonBlank,
  assertNoInvalidTokens,
  attachRuntimeMonitors,
  dispatchMotionBurst,
  emitMockGeolocation,
  emitMockGeolocationError,
  ensureMode,
  ensureServiceWorkerControlled,
  getAppState,
  installMockGeolocation,
  pauseMockGeolocation,
  selectDemoScenario,
  touchDragOnCanvas,
  touchDragOnElement,
  VIEWPORT_LANDSCAPE,
  VIEWPORT_PORTRAIT,
  waitForAppReady,
  waitForAppState,
  waitForServiceWorkerReady,
} from './helpers';

test.describe('Tier 2: Boundary & Corner Cases', () => {
  test('T2.1: GPS permission denied (error code 1) degrades gracefully', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');

    await emitMockGeolocationError(page, 1, 'User denied Geolocation');

    await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute('data-status', 'denied');
    const deniedState = await waitForAppState(page, (s) => s.sensorStatus.gps === 'denied');
    expect(deniedState.sensorStatus.gps).toBe('denied');

    // App stays interactive and keeps rendering
    const modeBefore = deniedState.camera.viewMode;
    await page.getByTestId('btn-view-mode').click();
    const afterClick = await waitForAppState(
      page,
      (s) => s.camera.viewMode !== modeBefore && s.frameCount > deniedState.frameCount + 2
    );
    expect(afterClick.camera.viewMode).not.toBe(modeBefore);
    await assertCanvasNonBlank(page);

    monitors.assertClean();
  });

  test('T2.2: Underground GPS timeout (error code 3) hands off to IMU dead reckoning', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');

    await emitMockGeolocation(page, {
      latitude: 40.7527,
      longitude: -73.9772,
      accuracy: 15,
      speed: 9,
      heading: 25,
    });
    await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute('data-status', 'locked');

    await pauseMockGeolocation(page);
    await emitMockGeolocationError(page, 3, 'Geolocation timeout');

    await dispatchMotionBurst(page, {
      samples: 30,
      intervalMs: 45,
      forwardAccel: 1.0,
      vibrationAmp: 0.35,
      yawRate: 0.02,
    });

    await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute(
      'data-status',
      /^(lost|stale)$/
    );
    await expect(page.getByTestId('sensor-status-dr')).toHaveAttribute('data-status', 'active');

    const beforeFrames = (await getAppState(page))!.frameCount;
    await waitForAppState(page, (s) => s.frameCount >= beforeFrames + 4);
    assertNoInvalidTokens(
      await page.getByTestId('hud-elevation').textContent(),
      'hud-elevation'
    );
    assertNoInvalidTokens(await page.getByTestId('hud-speed').textContent(), 'hud-speed');

    monitors.assertClean();
  });

  test('T2.3: Coarse/noisy GPS fix (>500m accuracy) is rejected without teleporting', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');

    // Positive control: lock accurately at Grand Central
    for (let i = 0; i < 3; i++) {
      await emitMockGeolocation(page, {
        latitude: 40.7527,
        longitude: -73.9772,
        accuracy: 12,
        speed: 0,
        heading: 25,
      });
      await page.waitForTimeout(200);
    }
    await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute('data-status', 'locked');
    const lockedState = (await getAppState(page))!;
    const lockedPos = lockedState.camera.position;

    // Inject coarse 1200m fix ~6.9 km south in Brooklyn
    await emitMockGeolocation(page, {
      latitude: 40.6906,
      longitude: -73.9818,
      accuracy: 1200,
      speed: 0,
      heading: 180,
    });
    await page.waitForTimeout(800);

    const afterNoisy = (await getAppState(page))!;
    const horizontalJumpM = Math.hypot(
      afterNoisy.camera.position[0] - lockedPos[0],
      afterNoisy.camera.position[2] - lockedPos[2]
    );
    expect(horizontalJumpM).toBeLessThan(500);
    expect(afterNoisy.estimate.outOfNyc).toBe(false);

    monitors.assertClean();
  });

  test('T2.4: Out-of-NYC coordinates (London & San Francisco) and recovery to NYC', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');

    // London
    await emitMockGeolocation(page, { latitude: 51.5074, longitude: -0.1278, accuracy: 15 });
    const londonState = await waitForAppState(page, (s) => s.estimate.outOfNyc === true, {
      timeout: 8_000,
      message: 'London coordinates did not trigger outOfNyc === true',
    });
    assertNoInvalidTokens(
      await page.getByTestId('hud-train-identity').textContent(),
      'hud-train-identity'
    );
    assertNoInvalidTokens(
      await page.getByTestId('hud-current-station').textContent(),
      'hud-current-station'
    );
    await waitForAppState(page, (s) => s.frameCount >= londonState.frameCount + 3);

    // San Francisco
    await emitMockGeolocation(page, { latitude: 37.7749, longitude: -122.4194, accuracy: 15 });
    await waitForAppState(page, (s) => s.estimate.outOfNyc === true, {
      timeout: 6_000,
      message: 'San Francisco coordinates did not maintain outOfNyc === true',
    });

    // Recovery back to Midtown NYC
    await emitMockGeolocation(page, {
      latitude: 40.7549,
      longitude: -73.984,
      accuracy: 12,
      speed: 5,
      heading: 25,
    });
    const recovered = await waitForAppState(page, (s) => s.estimate.outOfNyc === false, {
      timeout: 8_000,
      message: 'NYC coordinates did not recover outOfNyc back to false',
    });
    expect(recovered.estimate.outOfNyc).toBe(false);

    monitors.assertClean();
  });

  test('T2.5: Express vs local disambiguation on Lexington Ave corridor', async ({
    browser,
    baseURL,
  }) => {
    // Sub-case A: Express run (skip-stop high speed along Lexington Ave + express-overtake)
    const expressCtx = await browser.newContext({
      baseURL,
      timezoneId: 'America/New_York',
      viewport: VIEWPORT_PORTRAIT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'allow',
      ignoreHTTPSErrors: true,
    });
    const expressPage = await expressCtx.newPage();
    const expressMonitors = attachRuntimeMonitors(expressPage);

    let expressServiceType = '';
    try {
      await expressPage.clock.setSystemTime(new Date('2026-11-16T08:30:00-05:00'));
      await installMockGeolocation(expressPage);
      await expressPage.goto('/');
      await waitForAppReady(expressPage);
      await selectDemoScenario(expressPage, 'express-overtake');

      const exprState = await waitForAppState(
        expressPage,
        (s) => s.estimate.serviceType === 'EXPRESS' || s.estimate.speedMph >= 20,
        { timeout: 10_000, message: 'express-overtake did not reach express service/speed' }
      );
      expressServiceType = exprState.estimate.serviceType;
      expect(
        exprState.estimate.serviceType === 'EXPRESS' || exprState.estimate.speedMph >= 20
      ).toBe(true);
      expressMonitors.assertClean();
    } finally {
      await expressCtx.close();
    }

    // Sub-case B: Local stop-and-dwell trace at local-only Lexington stations (23 St & 28 St)
    const localCtx = await browser.newContext({
      baseURL,
      timezoneId: 'America/New_York',
      viewport: VIEWPORT_PORTRAIT,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: 'allow',
      ignoreHTTPSErrors: true,
    });
    const localPage = await localCtx.newPage();
    const localMonitors = attachRuntimeMonitors(localPage);

    try {
      await localPage.clock.setSystemTime(new Date('2026-11-16T08:30:00-05:00'));
      await installMockGeolocation(localPage);
      await localPage.goto('/');
      await waitForAppReady(localPage);
      await ensureMode(localPage, 'live');

      // Dwell at 23 St (local-only), move slowly to 28 St (local-only), dwell at 28 St
      const localFixes = [
        { latitude: 40.7399, longitude: -73.9866, accuracy: 10, speed: 0, heading: 29 },
        { latitude: 40.7399, longitude: -73.9866, accuracy: 10, speed: 0, heading: 29 },
        { latitude: 40.7415, longitude: -73.9854, accuracy: 10, speed: 9, heading: 29 },
        { latitude: 40.7431, longitude: -73.9843, accuracy: 10, speed: 0, heading: 29 },
        { latitude: 40.7431, longitude: -73.9843, accuracy: 10, speed: 0, heading: 29 },
      ];
      for (const fix of localFixes) {
        await emitMockGeolocation(localPage, fix);
        await localPage.waitForTimeout(300);
      }

      const localState = await waitForAppState(
        localPage,
        (s) => s.estimate.stationId !== null && s.estimate.line !== null,
        { timeout: 8_000, message: 'Local trace did not localize on Lexington Ave' }
      );

      expect(
        localState.estimate.serviceType === 'LOCAL' ||
          localState.estimate.serviceType !== expressServiceType
      ).toBe(true);
      localMonitors.assertClean();
    } finally {
      await localCtx.close();
    }
  });

  test('T2.6: Late-night and weekend schedule patterns vs weekday AM rush', async ({
    browser,
    baseURL,
  }) => {
    const runAtTime = async (isoTime: string) => {
      const ctx = await browser.newContext({
        baseURL,
        timezoneId: 'America/New_York',
        viewport: VIEWPORT_PORTRAIT,
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
        serviceWorkers: 'allow',
        ignoreHTTPSErrors: true,
      });
      const page = await ctx.newPage();
      const monitors = attachRuntimeMonitors(page);
      try {
        await page.clock.setSystemTime(new Date(isoTime));
        await page.goto('/');
        await waitForAppReady(page);
        await selectDemoScenario(page, 'midtown-multi-system');

        await expect(page.getByTestId('sensor-status-timing')).toHaveAttribute(
          'data-status',
          'active'
        );
        const state = await waitForAppState(
          page,
          (s) => s.sensorStatus.timing === 'active' && s.frameCount >= 5,
          { timeout: 10_000 }
        );
        await assertCanvasNonBlank(page);
        monitors.assertClean();
        return state;
      } finally {
        await ctx.close();
      }
    };

    const rush = await runAtTime('2026-11-16T08:30:00-05:00'); // Monday AM rush
    const weekend = await runAtTime('2026-11-14T14:00:00-05:00'); // Saturday midday
    const lateNight = await runAtTime('2026-11-15T03:00:00-05:00'); // Sunday 3 AM late night

    expect(rush.sensorStatus.timing).toBe('active');
    expect(weekend.sensorStatus.timing).toBe('active');
    expect(lateNight.sensorStatus.timing).toBe('active');
    expect(rush.nearbyTrainCount).toBeGreaterThan(0);
    expect(rush.nearbyTrainCount).toBeGreaterThanOrEqual(lateNight.nearbyTrainCount);
  });

  test('T2.7: Portrait to landscape rotation mid-ride preserves state with zero overflow', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await selectDemoScenario(page, 'manhattan-bridge');

    const canvas = page.getByTestId('scene-canvas');
    const portraitBox = await canvas.boundingBox();
    expect(portraitBox).not.toBeNull();
    expect(portraitBox!.height).toBeGreaterThan(portraitBox!.width);

    const portraitMode = (await getAppState(page))!.mode;

    // Rotate to landscape
    await page.setViewportSize(VIEWPORT_LANDSCAPE);
    await expect
      .poll(async () => {
        const b = await canvas.boundingBox();
        return !!b && b.width > 700 && b.height <= VIEWPORT_LANDSCAPE.height + 1;
      })
      .toBe(true);

    const landscapeOverflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
    }));
    expect(landscapeOverflow.scrollW).toBeLessThanOrEqual(landscapeOverflow.innerW + 1);
    expect(landscapeOverflow.scrollH).toBeLessThanOrEqual(landscapeOverflow.innerH + 1);

    for (const id of ['hud-train-identity', 'btn-view-mode', 'btn-calibrate'] as const) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} missing in landscape`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORT_LANDSCAPE.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(VIEWPORT_LANDSCAPE.height + 1);
    }
    await assertCanvasNonBlank(page);

    // Rotate back to portrait
    await page.setViewportSize(VIEWPORT_PORTRAIT);
    await expect
      .poll(async () => {
        const b = await canvas.boundingBox();
        return !!b && b.width <= VIEWPORT_PORTRAIT.width + 1 && b.height > 700;
      })
      .toBe(true);

    const afterState = (await getAppState(page))!;
    expect(afterState.mode).toBe(portraitMode);
    await waitForAppState(page, (s) => s.frameCount >= afterState.frameCount + 3);
    await assertCanvasNonBlank(page);

    monitors.assertClean();
  });

  test('T2.8: Touch-on-HUD isolation does not rotate 3D camera', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');
    await pauseMockGeolocation(page);

    await page.getByTestId('btn-reset-view').click();
    await page.waitForTimeout(150);

    const cam0 = (await getAppState(page))!.camera;

    // Drag across HUD telemetry panel — must NOT rotate camera
    await touchDragOnElement(page, page.getByTestId('hud-train-identity'), {
      dx: 90,
      dy: -40,
      steps: 8,
    });
    await page.waitForTimeout(150);
    const camAfterHud = (await getAppState(page))!.camera;

    expect(Math.abs(camAfterHud.yaw - cam0.yaw)).toBeLessThan(0.015);
    expect(Math.abs(camAfterHud.pitch - cam0.pitch)).toBeLessThan(0.015);

    // Positive control: identical drag on scene-canvas MUST rotate camera
    await touchDragOnCanvas(page, 90, -40, 8);
    const camAfterCanvas = await waitForAppState(
      page,
      (s) => Math.abs(s.camera.yaw - camAfterHud.yaw) > 0.05,
      { timeout: 6_000, message: 'Positive control canvas drag did not rotate camera' }
    );
    expect(Math.abs(camAfterCanvas.camera.yaw - camAfterHud.yaw)).toBeGreaterThan(0.05);

    monitors.assertClean();
  });

  test('T2.9: Zero external CDN or third-party network requests across all features', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await waitForServiceWorkerReady(page, 15_000);

    await selectDemoScenario(page, 'manhattan-bridge');
    await selectDemoScenario(page, 'express-overtake');
    await selectDemoScenario(page, 'midtown-multi-system');

    await page.getByTestId('btn-calibrate').click();
    await page.getByTestId('btn-view-mode').click();

    expect(monitors.allRequests.length).toBeGreaterThan(0);
    monitors.assertClean();
  });

  test('T2.10: Cold-start offline reload serves full 3D app from Service Worker cache', async ({
    page,
    context,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'true');
    await ensureServiceWorkerControlled(page, 15_000);

    monitors.reset();
    try {
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const offlineState = await waitForAppReady(page, { timeout: 15_000 });

      await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'false');
      await assertCanvasNonBlank(page);

      await waitForAppState(page, (s) => s.frameCount >= offlineState.frameCount + 5, {
        timeout: 8_000,
        message: 'Render loop did not advance frames after offline cold reload',
      });

      const modeBefore = (await getAppState(page))!.camera.viewMode;
      await page.getByTestId('btn-view-mode').click();
      await waitForAppState(page, (s) => s.camera.viewMode !== modeBefore);

      monitors.assertClean();
    } finally {
      await context.setOffline(false);
    }
  });
});
