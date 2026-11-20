import { expect, test } from '@playwright/test';
import {
  assertCanvasNonBlank,
  assertNoInvalidTokens,
  attachRuntimeMonitors,
  ensureMode,
  ensureServiceWorkerControlled,
  getAppState,
  installMockGeolocation,
  parseFirstNumber,
  pickOptionDynamically,
  selectDemoScenario,
  touchDragOnCanvas,
  waitForAppReady,
  waitForAppState,
} from './helpers';

test.describe('Tier 4: Real-World NYC Rider Journeys', () => {
  test('S1: Manhattan Bridge crossing (Brooklyn to Manhattan) with East River and bridge-to-tunnel descent', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const startState = await selectDemoScenario(page, 'manhattan-bridge');
    const frameCountStart = startState.frameCount;

    let maxElevationFt = Number.NEGATIVE_INFINITY;
    let minElevationFt = Number.POSITIVE_INFINITY;
    let sawEastRiverState = false;
    let sawEastRiverDom = false;
    let sawNearbyTrainsState = false;
    let sawNearbyTrainsDom = false;
    let verifiedBridgeCanvas = false;
    let verifiedTunnelCanvas = false;
    const elevationSamples: number[] = [];

    const deadline = Date.now() + 24_000;
    while (Date.now() < deadline) {
      const state = await getAppState(page);
      if (state) {
        const elev = state.estimate.elevationFt;
        expect(Number.isFinite(elev), 'Elevation sample must be finite').toBe(true);
        elevationSamples.push(elev);
        maxElevationFt = Math.max(maxElevationFt, elev);
        minElevationFt = Math.min(minElevationFt, elev);
        expect(state.drawCalls).toBeLessThanOrEqual(50);

        if (elev > 0 && !verifiedBridgeCanvas) {
          await assertCanvasNonBlank(page);
          verifiedBridgeCanvas = true;
        }
        if (elev < 0 && !verifiedTunnelCanvas) {
          await assertCanvasNonBlank(page);
          verifiedTunnelCanvas = true;
        }

        if (state.visibleLandmarks.includes('east-river')) {
          sawEastRiverState = true;
          const domCount = await page
            .locator('[data-testid="nearby-landmarks-list"] [data-landmark="east-river"]')
            .count();
          if (domCount >= 1) sawEastRiverDom = true;
        }

        if (state.nearbyTrainCount >= 1) {
          sawNearbyTrainsState = true;
          const trainDomCount = await page
            .locator('[data-testid="nearby-trains-list"] [data-system]')
            .count();
          if (trainDomCount >= 1) sawNearbyTrainsDom = true;
        }

        if (
          sawEastRiverState &&
          sawEastRiverDom &&
          sawNearbyTrainsState &&
          sawNearbyTrainsDom &&
          maxElevationFt > 0 &&
          minElevationFt < 0 &&
          verifiedBridgeCanvas &&
          verifiedTunnelCanvas &&
          state.frameCount - frameCountStart >= 10
        ) {
          break;
        }
      }
      await page.waitForTimeout(300);
    }

    const endState = (await getAppState(page))!;
    expect(elevationSamples.length).toBeGreaterThanOrEqual(5);
    expect(sawEastRiverState, 'Expected east-river in visibleLandmarks').toBe(true);
    expect(sawEastRiverDom, 'Expected east-river in nearby-landmarks-list DOM').toBe(true);
    expect(maxElevationFt, 'Expected elevated bridge section (> 0 ft)').toBeGreaterThan(0);
    expect(minElevationFt, 'Expected underground tunnel section (< 0 ft)').toBeLessThan(0);
    expect(sawNearbyTrainsState, 'Expected nearbyTrainCount >= 1 during crossing').toBe(true);
    expect(sawNearbyTrainsDom, 'Expected nearby trains in DOM list').toBe(true);
    expect(endState.frameCount - frameCountStart).toBeGreaterThanOrEqual(10);

    const gpsStatus = await page.getByTestId('sensor-status-gps').getAttribute('data-status');
    const drStatus = await page.getByTestId('sensor-status-dr').getAttribute('data-status');
    expect(['simulated', 'stale', 'lost']).toContain(gpsStatus);
    expect(['simulated', 'active']).toContain(drStatus);

    for (const id of [
      'hud-train-identity',
      'hud-speed',
      'hud-elevation',
      'hud-current-station',
      'hud-next-station',
    ] as const) {
      assertNoInvalidTokens(await page.getByTestId(id).textContent(), id);
    }

    monitors.assertClean();
  });

  test('S2: 8th Ave express rush-hour commute past Penn Station with Hudson River, regional rail, and ghost view', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const monitors = attachRuntimeMonitors(page);
    await page.clock.setSystemTime(new Date('2026-06-15T08:30:00-04:00')); // Monday 8:30 AM EDT
    await page.goto('/');
    await waitForAppReady(page);

    await selectDemoScenario(page, 'midtown-multi-system');
    await waitForAppState(page, (s) => s.frameCount >= 5 && s.nearbyTrainCount >= 1, {
      timeout: 12_000,
    });

    await expect(page.getByTestId('sensor-status-timing')).toHaveAttribute('data-status', 'active');

    // Verify Hudson River landmark & regional rail near Penn Station
    const pennRegional = ['LIRR', 'NJT', 'PATH'];
    const multiState = await waitForAppState(
      page,
      (s) =>
        s.visibleLandmarks.includes('hudson-river') &&
        s.visibleSystems.includes('MTA') &&
        s.visibleSystems.some((sys) => pennRegional.includes(sys)),
      { timeout: 12_000, message: 'Expected hudson-river + MTA + LIRR/NJT/PATH near Penn Station' }
    );
    expect(multiState.drawCalls).toBeLessThanOrEqual(50);

    await expect(
      page.locator('[data-testid="nearby-landmarks-list"] [data-landmark="hudson-river"]')
    ).toBeVisible();
    const regionalDomCount = await page
      .locator(
        '[data-testid="nearby-trains-list"] [data-system="LIRR"], ' +
          '[data-testid="nearby-trains-list"] [data-system="NJT"], ' +
          '[data-testid="nearby-trains-list"] [data-system="PATH"]'
      )
      .count();
    expect(regionalDomCount).toBeGreaterThanOrEqual(1);

    // Express service verification
    if (multiState.estimate.serviceType !== 'EXPRESS') {
      await selectDemoScenario(page, 'express-overtake');
      const exprState = await waitForAppState(
        page,
        (s) => s.nearbyTrainCount >= 1 && s.estimate.serviceType === 'EXPRESS',
        { timeout: 10_000, message: 'Expected EXPRESS service in express-overtake scenario' }
      );
      expect(exprState.estimate.serviceType).toBe('EXPRESS');
    }

    // Look around via touch drag on canvas
    const camBeforeDrag = (await getAppState(page))!.camera;
    await touchDragOnCanvas(page, 100, -30, 8);
    await waitForAppState(
      page,
      (s) => Math.abs(s.camera.yaw - camBeforeDrag.yaw) > 0.05,
      { timeout: 6_000, message: 'Canvas drag did not rotate camera yaw' }
    );

    // Switch to X-Ray ghost cutaway mode
    for (let i = 0; i < 3; i++) {
      const currentMode = (await getAppState(page))!.camera.viewMode;
      if (currentMode === 'ghost') break;
      await page.getByTestId('btn-view-mode').click();
      await waitForAppState(page, (s) => s.camera.viewMode !== currentMode);
    }
    const ghostState = (await getAppState(page))!;
    expect(ghostState.camera.viewMode).toBe('ghost');
    await waitForAppState(page, (s) => s.frameCount >= ghostState.frameCount + 3);
    await assertCanvasNonBlank(page);

    // Reset camera view
    await page.getByTestId('btn-reset-view').click();
    await waitForAppState(
      page,
      (s) => Math.abs(s.camera.yaw) < 0.3 || Math.abs(s.camera.yaw - camBeforeDrag.yaw) < 0.15,
      {
        timeout: 6_000,
        message: 'Camera did not reset yaw near 0 or baseline',
      }
    );

    monitors.assertClean();
  });

  test('S3: Lexington Ave underground commute past Grand Central with Metro-North/LIRR and view cycling', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    await selectDemoScenario(page, 'lexington-underground');
    const lexState = await waitForAppState(
      page,
      (s) => s.frameCount >= 5 && s.estimate.elevationFt < 0,
      { timeout: 12_000, message: 'lexington-underground did not settle underground (< 0 ft)' }
    );

    expect(lexState.estimate.elevationFt).toBeLessThan(0);
    const hudElev = parseFirstNumber(
      assertNoInvalidTokens(
        await page.getByTestId('hud-elevation').textContent(),
        'hud-elevation'
      )
    );
    expect(Number.isFinite(hudElev)).toBe(true);
    expect(hudElev).toBeLessThan(0);

    const drStatus = await page.getByTestId('sensor-status-dr').getAttribute('data-status');
    const gpsStatus = await page.getByTestId('sensor-status-gps').getAttribute('data-status');
    expect(['active', 'simulated']).toContain(drStatus);
    expect(gpsStatus).not.toBe('locked');

    // Grand Central nearby regional rail (MNR or LIRR alongside MTA)
    await waitForAppState(
      page,
      (s) =>
        s.visibleSystems.includes('MTA') &&
        (s.visibleSystems.includes('MNR') || s.visibleSystems.includes('LIRR')),
      { timeout: 12_000, message: 'Expected MNR or LIRR alongside MTA near Grand Central' }
    );

    const gctRegionalCount = await page
      .locator(
        '[data-testid="nearby-trains-list"] [data-system="MNR"], ' +
          '[data-testid="nearby-trains-list"] [data-system="LIRR"]'
      )
      .count();
    expect(gctRegionalCount).toBeGreaterThanOrEqual(1);

    // Cycle through all 3 camera view modes
    const modes = new Set<string>([(await getAppState(page))!.camera.viewMode]);
    for (let i = 0; i < 3; i++) {
      const before = (await getAppState(page))!;
      await page.getByTestId('btn-view-mode').click();
      const after = await waitForAppState(page, (s) => s.camera.viewMode !== before.camera.viewMode);
      modes.add(after.camera.viewMode);
      expect(after.drawCalls).toBeLessThanOrEqual(50);
      await assertCanvasNonBlank(page);
    }
    expect(modes).toEqual(new Set(['inside', 'ghost', 'chase']));

    // Reset camera view and confirm ongoing render
    await page.getByTestId('btn-reset-view').click();
    const afterReset = (await getAppState(page))!;
    await waitForAppState(page, (s) => s.frameCount >= afterReset.frameCount + 3);

    monitors.assertClean();
  });

  test('S4: Full airplane-mode cold-start commute served from Service Worker cache', async ({
    page,
    context,
  }) => {
    test.setTimeout(45_000);
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'true');
    await ensureServiceWorkerControlled(page, 15_000);
    monitors.assertZeroExternalRequests();

    monitors.reset();
    try {
      // Switch to full airplane mode and perform cold reload
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(page, { timeout: 15_000 });

      await expect(page.getByTestId('offline-status-badge')).toBeVisible();
      await expect(page.getByTestId('offline-status-badge')).toHaveAttribute('data-online', 'false');
      monitors.assertClean();

      // Run active multi-frame offline commute
      const rideStart = await selectDemoScenario(page, 'manhattan-bridge');
      await assertCanvasNonBlank(page);

      const rideEnd = await waitForAppState(
        page,
        (s) => s.frameCount >= rideStart.frameCount + 10,
        { timeout: 12_000, message: 'Offline commute did not advance 10 rendered frames' }
      );
      await assertCanvasNonBlank(page);
      expect(rideEnd.drawCalls).toBeLessThanOrEqual(50);

      for (const id of [
        'hud-train-identity',
        'hud-confidence',
        'hud-speed',
        'hud-elevation',
      ] as const) {
        assertNoInvalidTokens(await page.getByTestId(id).textContent(), id);
      }

      monitors.assertClean();
    } finally {
      await context.setOffline(false);
    }
  });

  test('S5: Out-of-NYC user (London) recovering via Demo Mode and Manual Calibration', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page, {
      initialPosition: {
        coords: { latitude: 51.5074, longitude: -0.1278, accuracy: 20 },
      },
    });
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');

    // Phase 1: Out-of-NYC detection
    const londonState = await waitForAppState(page, (s) => s.estimate.outOfNyc === true, {
      timeout: 10_000,
      message: 'London initial GPS did not report outOfNyc === true',
    });
    expect(londonState.estimate.outOfNyc).toBe(true);
    for (const coord of londonState.camera.position) {
      expect(Number.isFinite(coord)).toBe(true);
    }

    // Phase 2: Recovery via Demo Mode (manhattan-bridge)
    const demoStart = await selectDemoScenario(page, 'manhattan-bridge');
    const demoState = await waitForAppState(
      page,
      (s) =>
        s.mode === 'sim' &&
        s.estimate.outOfNyc === false &&
        (s.nearbyTrainCount >= 1 || s.visibleLandmarks.includes('east-river')),
      { timeout: 10_000, message: 'Demo Mode did not recover NYC scene from outOfNyc' }
    );
    await waitForAppState(page, (s) => s.frameCount >= demoStart.frameCount + 3);
    expect(demoState.drawCalls).toBeLessThanOrEqual(50);
    await assertCanvasNonBlank(page);

    // Phase 3: Recovery via Manual Calibration in Live Mode
    await ensureMode(page, 'live');
    await page.getByTestId('btn-calibrate').click();
    await pickOptionDynamically(
      page.getByTestId('calibrate-station-select'),
      /Grand Central|Times Sq|34 St|14 St|Canal/i
    );
    await pickOptionDynamically(page.getByTestId('calibrate-line-select'), /^[A1246NQ7L]/i);
    await page.getByTestId('btn-calibrate-apply').click();

    const calibrated = await waitForAppState(
      page,
      (s) =>
        s.estimate.outOfNyc === false &&
        s.estimate.line !== null &&
        s.estimate.confidence > 0,
      { timeout: 10_000, message: 'Manual calibration did not recover outOfNyc to NYC station' }
    );
    assertNoInvalidTokens(
      await page.getByTestId('hud-train-identity').textContent(),
      'hud-train-identity'
    );
    assertNoInvalidTokens(
      await page.getByTestId('hud-current-station').textContent(),
      'hud-current-station'
    );
    await waitForAppState(page, (s) => s.frameCount >= calibrated.frameCount + 3);
    await assertCanvasNonBlank(page);

    monitors.assertClean();
  });
});
