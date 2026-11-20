import { expect, test } from '@playwright/test';
import {
  assertCanvasNonBlank,
  assertNoInvalidTokens,
  attachRuntimeMonitors,
  dispatchDeviceOrientation,
  dispatchMotionBurst,
  emitMockGeolocation,
  emitMockGeolocationError,
  ensureMode,
  ensureServiceWorkerControlled,
  getAppState,
  installMockGeolocation,
  parseFirstNumber,
  pauseMockGeolocation,
  pickOptionDynamically,
  selectDemoScenario,
  type SubwayVisionState,
  touchDragOnCanvas,
  VALID_RAIL_SYSTEMS,
  VIEWPORT_LANDSCAPE,
  waitForAppReady,
  waitForAppState,
} from './helpers';

test.describe('Tier 3: Cross-Feature Combinations', () => {
  test('C1: GPS lock to tunnel dive dead-reckoning handoff with East River landmark', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');
    await assertCanvasNonBlank(page);

    // Phase A: Bridge / portal approach with high-accuracy GPS
    const bridgeFixes = [
      { latitude: 40.7032, longitude: -73.9896, accuracy: 10, speed: 13, heading: 340 },
      { latitude: 40.7072, longitude: -73.9908, accuracy: 10, speed: 14, heading: 340 },
      { latitude: 40.7112, longitude: -73.9924, accuracy: 12, speed: 13, heading: 335 },
    ];
    for (const fix of bridgeFixes) {
      await emitMockGeolocation(page, fix);
      await page.waitForTimeout(300);
    }

    await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute('data-status', 'locked');
    const bridgeState = await waitForAppState(
      page,
      (s) => s.sensorStatus.gps === 'locked' && s.visibleLandmarks.includes('east-river'),
      { timeout: 10_000, message: 'Expected locked GPS and east-river landmark on Manhattan Bridge' }
    );
    await expect(
      page.locator('[data-testid="nearby-landmarks-list"] [data-landmark="east-river"]')
    ).toBeVisible();
    expect(Number.isFinite(bridgeState.estimate.elevationFt)).toBe(true);
    const frameCountBefore = bridgeState.frameCount;

    // Phase B: Tunnel dive (GPS loss + IMU dead-reckoning handoff)
    await pauseMockGeolocation(page);
    await emitMockGeolocationError(page, 2, 'Position unavailable in tunnel');
    await dispatchMotionBurst(page, {
      samples: 25,
      intervalMs: 70,
      forwardAccel: 0.95,
      vibrationAmp: 0.35,
      yawRate: 0.04,
    });

    await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute(
      'data-status',
      /^(stale|lost)$/
    );
    await expect(page.getByTestId('sensor-status-dr')).toHaveAttribute('data-status', 'active');

    // Phase C: Continuity & smooth elevation bounds across 3 samples
    const elevations: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = (await getAppState(page))!;
      expect(['stale', 'lost']).toContain(s.sensorStatus.gps);
      expect(s.sensorStatus.dr).toBe('active');
      expect(Number.isFinite(s.estimate.elevationFt)).toBe(true);
      expect(s.estimate.elevationFt).toBeGreaterThanOrEqual(-250);
      expect(s.estimate.elevationFt).toBeLessThanOrEqual(300);
      expect(s.drawCalls).toBeLessThanOrEqual(50);
      elevations.push(s.estimate.elevationFt);
      await page.waitForTimeout(200);
    }

    for (let i = 1; i < elevations.length; i++) {
      expect(Math.abs(elevations[i] - elevations[i - 1])).toBeLessThan(120);
    }

    const finalState = (await getAppState(page))!;
    expect(finalState.frameCount).toBeGreaterThan(frameCountBefore);
    await assertCanvasNonBlank(page);

    monitors.assertClean();
  });

  test('C2: Manual calibration while offline combined with demo and live mode switching', async ({
    page,
    context,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'true');
    await ensureServiceWorkerControlled(page, 15_000);
    monitors.assertZeroExternalRequests();

    try {
      // Go offline
      await context.setOffline(true);
      await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'false');

      // Manual calibration offline
      await page.getByTestId('btn-calibrate').click();
      const stationSelect = page.getByTestId('calibrate-station-select');
      const lineSelect = page.getByTestId('calibrate-line-select');
      const applyBtn = page.getByTestId('btn-calibrate-apply');
      await expect(stationSelect).toBeVisible();
      await expect(lineSelect).toBeVisible();
      await expect(applyBtn).toBeVisible();

      await pickOptionDynamically(stationSelect, /Grand Central|34|Penn|Canal|Times Sq/i);
      await pickOptionDynamically(lineSelect, /^[A146NQ]/i);
      await applyBtn.click();

      const calibrated = await waitForAppState(
        page,
        (s) => s.estimate.line !== null && s.estimate.confidence > 0,
        { timeout: 8_000, message: 'Offline manual calibration did not update estimate' }
      );
      expect(calibrated.estimate.line).not.toBeNull();
      expect(calibrated.estimate.confidence).toBeGreaterThan(0);

      assertNoInvalidTokens(
        await page.getByTestId('hud-train-identity').textContent(),
        'hud-train-identity'
      );
      assertNoInvalidTokens(
        await page.getByTestId('hud-current-station').textContent(),
        'hud-current-station'
      );
      const confAttr = await page.getByTestId('hud-confidence').getAttribute('data-confidence');
      const confNum = Number.parseFloat(confAttr ?? '');
      expect(Number.isFinite(confNum)).toBe(true);
      expect(confNum).toBeGreaterThan(0);
      expect(confNum).toBeLessThanOrEqual(100);

      // Toggle Demo Mode on while offline
      const simState = await selectDemoScenario(page, 'manhattan-bridge');
      await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute(
        'data-status',
        'simulated'
      );
      await waitForAppState(page, (s) => s.frameCount >= simState.frameCount + 3);
      await assertCanvasNonBlank(page);

      // Toggle back to Live Mode while offline
      await ensureMode(page, 'live');
      await expect(page.getByTestId('sensor-status-gps')).not.toHaveAttribute(
        'data-status',
        'simulated'
      );
      await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'false');

      monitors.assertClean();
    } finally {
      await context.setOffline(false);
    }
  });

  test('C3: Gyroscope, touch drag, view mode cycling, and camera reset composition', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await selectDemoScenario(page, 'manhattan-bridge');

    const baseCam = (await getAppState(page))!.camera;

    // 1. Enable gyro and dispatch orientation sequence
    await page.getByTestId('btn-gyro-toggle').click();
    for (const sample of [
      { alpha: 30, beta: 75, gamma: 5 },
      { alpha: 90, beta: 65, gamma: -10 },
    ]) {
      await dispatchDeviceOrientation(page, sample);
      await page.waitForTimeout(100);
    }

    const afterGyroState = await waitForAppState(
      page,
      (s) =>
        Number.isFinite(s.camera.yaw) &&
        Number.isFinite(s.camera.pitch) &&
        (Math.abs(s.camera.yaw - baseCam.yaw) > 0.05 ||
          Math.abs(s.camera.pitch - baseCam.pitch) > 0.05),
      { timeout: 6_000, message: 'Gyro orientation did not rotate camera' }
    );
    const afterGyroCam = afterGyroState.camera;

    // 2. Touch drag on canvas center
    await touchDragOnCanvas(page, -95, -35, 8);
    const afterDragState = await waitForAppState(
      page,
      (s) =>
        Number.isFinite(s.camera.yaw) &&
        Number.isFinite(s.camera.pitch) &&
        (Math.abs(s.camera.yaw - afterGyroCam.yaw) > 0.04 ||
          Math.abs(s.camera.pitch - afterGyroCam.pitch) > 0.03),
      { timeout: 6_000, message: 'Touch drag did not update camera after gyro' }
    );
    expect(Number.isFinite(afterDragState.camera.yaw)).toBe(true);
    expect(Number.isFinite(afterDragState.camera.pitch)).toBe(true);

    // 3. Cycle through all 3 view modes
    const visitedModes = new Set<string>([afterDragState.camera.viewMode]);

    for (let i = 0; i < 3; i++) {
      const prevMode = (await getAppState(page))?.camera.viewMode;
      await page.getByTestId('btn-view-mode').click();
      const s = await waitForAppState(page, (st) => st.camera.viewMode !== prevMode, {
        timeout: 6_000,
        message: `View mode did not change from ${String(prevMode)}`,
      });
      visitedModes.add(s.camera.viewMode);
      expect(s.drawCalls).toBeLessThanOrEqual(50);
      await assertCanvasNonBlank(page);
    }
    expect(visitedModes).toEqual(new Set(['inside', 'ghost', 'chase']));

    // 4. Reset camera view
    await page.getByTestId('btn-reset-view').click();
    const resetState = await waitForAppState(
      page,
      (s) =>
        (Math.abs(s.camera.yaw) < 0.3 || Math.abs(s.camera.yaw - baseCam.yaw) < 0.15) &&
        (Math.abs(s.camera.pitch) < 0.3 || Math.abs(s.camera.pitch - baseCam.pitch) < 0.15),
      { timeout: 6_000, message: 'btn-reset-view did not return camera near neutral' }
    );
    await waitForAppState(page, (s) => s.frameCount >= resetState.frameCount + 2);

    monitors.assertClean();
  });

  test('C4: Express overtake, nearby regional rail, and strict HUD-to-state consistency', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // Leg A: express-overtake scenario
    await selectDemoScenario(page, 'express-overtake');
    const expressState = await waitForAppState(
      page,
      (s) => s.mode === 'sim' && s.nearbyTrainCount >= 1 && s.estimate.speedMph > 0,
      { timeout: 10_000, message: 'express-overtake did not show active movement and nearby trains' }
    );
    const expressIdentity = assertNoInvalidTokens(
      await page.getByTestId('hud-train-identity').textContent(),
      'hud-train-identity'
    );
    expect(
      expressState.estimate.serviceType === 'EXPRESS' || /express/i.test(expressIdentity)
    ).toBe(true);
    expect(
      await page.locator('[data-testid="nearby-trains-list"] [data-system]').count()
    ).toBeGreaterThanOrEqual(1);

    // Leg B: midtown-multi-system scenario with regional rail
    await selectDemoScenario(page, 'midtown-multi-system');
    const regionalSystems = ['PATH', 'LIRR', 'NJT', 'MNR'];
    await waitForAppState(
      page,
      (s) =>
        s.visibleSystems.includes('MTA') &&
        s.visibleSystems.some((sys) => regionalSystems.includes(sys)),
      { timeout: 10_000, message: 'Expected MTA + at least one regional system in midtown-multi-system' }
    );

    const domRegionalCount = await page
      .locator(
        '[data-testid="nearby-trains-list"] [data-system="PATH"], ' +
          '[data-testid="nearby-trains-list"] [data-system="LIRR"], ' +
          '[data-testid="nearby-trains-list"] [data-system="NJT"], ' +
          '[data-testid="nearby-trains-list"] [data-system="MNR"]'
      )
      .count();
    expect(domRegionalCount).toBeGreaterThanOrEqual(1);

    // Strict HUD <-> __SUBWAY_VISION_STATE__ consistency audit (3 atomic samples)
    for (let i = 0; i < 3; i++) {
      const sample = await page.evaluate(() => {
        const win = window as Window & { __SUBWAY_VISION_STATE__?: SubwayVisionState };
        const state = win.__SUBWAY_VISION_STATE__ ?? null;
        const textOf = (testId: string): string | null =>
          document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
        const confAttr =
          document.querySelector('[data-testid="hud-confidence"]')?.getAttribute('data-confidence') ??
          null;
        const renderedSystems = Array.from(
          document.querySelectorAll('[data-testid="nearby-trains-list"] [data-system]')
        ).map((el) => el.getAttribute('data-system') ?? '');
        return {
          state,
          identityText: textOf('hud-train-identity'),
          confAttr,
          speedText: textOf('hud-speed'),
          elevText: textOf('hud-elevation'),
          currentStationText: textOf('hud-current-station'),
          nextStationText: textOf('hud-next-station'),
          renderedSystems,
        };
      });

      expect(sample.state).not.toBeNull();
      const state = sample.state!;

      const identityText = assertNoInvalidTokens(sample.identityText, 'hud-train-identity');
      if (state.estimate.line) {
        expect(identityText.toUpperCase()).toContain(state.estimate.line.toUpperCase());
      }

      const hudConf = Number.parseFloat(sample.confAttr ?? '');
      expect(Number.isFinite(hudConf)).toBe(true);
      expect(hudConf).toBeGreaterThanOrEqual(0);
      expect(hudConf).toBeLessThanOrEqual(100);
      expect(Math.abs(hudConf - state.estimate.confidence)).toBeLessThanOrEqual(2);

      const speedText = assertNoInvalidTokens(sample.speedText, 'hud-speed');
      const hudSpeed = parseFirstNumber(speedText);
      expect(Number.isFinite(hudSpeed)).toBe(true);
      expect(hudSpeed).toBeGreaterThanOrEqual(0);
      expect(hudSpeed).toBeLessThanOrEqual(120);
      expect(Math.abs(hudSpeed - state.estimate.speedMph)).toBeLessThanOrEqual(2.5);

      const elevText = assertNoInvalidTokens(sample.elevText, 'hud-elevation');
      const hudElev = parseFirstNumber(elevText);
      expect(Number.isFinite(hudElev)).toBe(true);
      expect(hudElev).toBeGreaterThanOrEqual(-250);
      expect(hudElev).toBeLessThanOrEqual(300);
      expect(Math.abs(hudElev - state.estimate.elevationFt)).toBeLessThanOrEqual(3.5);

      assertNoInvalidTokens(sample.currentStationText, 'hud-current-station');
      assertNoInvalidTokens(sample.nextStationText, 'hud-next-station');

      for (const sys of sample.renderedSystems) {
        expect(VALID_RAIL_SYSTEMS.has(sys), `Invalid data-system "${sys}"`).toBe(true);
      }
      if (state.nearbyTrainCount >= 1) {
        expect(sample.renderedSystems.length).toBeGreaterThanOrEqual(1);
      }

      expect(state.drawCalls).toBeLessThanOrEqual(50);
      await assertCanvasNonBlank(page);
      await page.waitForTimeout(350);
    }

    monitors.assertClean();
  });

  test('C5: Late-night clock, offline mode, landscape rotation, and manual calibration', async ({
    page,
    context,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureServiceWorkerControlled(page, 15_000);

    // Tuesday 2:30 AM EDT (Late Night NYC schedule)
    await page.clock.setSystemTime(new Date('2026-06-16T02:30:00-04:00'));

    try {
      await context.setOffline(true);
      await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'false');

      // Rotate to landscape
      await page.setViewportSize(VIEWPORT_LANDSCAPE);
      const canvas = page.getByTestId('scene-canvas');
      await expect
        .poll(async () => {
          const b = await canvas.boundingBox();
          return !!b && b.width >= 800 && b.height >= 350;
        })
        .toBe(true);

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(VIEWPORT_LANDSCAPE.width + 1);

      for (const id of ['btn-calibrate', 'btn-demo-mode', 'btn-view-mode'] as const) {
        const el = page.getByTestId(id);
        await expect(el).toBeVisible();
        const box = await el.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(43.5);
        expect(box!.height).toBeGreaterThanOrEqual(43.5);
      }

      // Manual calibration under late-night schedule while offline
      await page.getByTestId('btn-calibrate').click();
      await pickOptionDynamically(page.getByTestId('calibrate-station-select'));
      await pickOptionDynamically(page.getByTestId('calibrate-line-select'), /^[A1246NQL7]/i);
      await page.getByTestId('btn-calibrate-apply').click();

      await expect(page.getByTestId('sensor-status-timing')).toHaveAttribute(
        'data-status',
        'active'
      );
      const calState = await waitForAppState(page, (s) => s.estimate.confidence > 0, {
        timeout: 8_000,
      });
      assertNoInvalidTokens(
        await page.getByTestId('hud-train-identity').textContent(),
        'hud-train-identity'
      );
      assertNoInvalidTokens(
        await page.getByTestId('hud-current-station').textContent(),
        'hud-current-station'
      );

      await waitForAppState(page, (s) => s.frameCount >= calState.frameCount + 3);
      await assertCanvasNonBlank(page);

      monitors.assertClean();
    } finally {
      await context.setOffline(false);
    }
  });
});
