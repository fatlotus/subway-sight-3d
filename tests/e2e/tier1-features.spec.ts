import { expect, test } from '@playwright/test';
import {
  assertCanvasNonBlank,
  assertNoInvalidTokens,
  attachRuntimeMonitors,
  dispatchDeviceOrientation,
  dispatchMotionBurst,
  emitMockGeolocation,
  ensureMode,
  getAppState,
  installMockGeolocation,
  listSelectOptions,
  pauseMockGeolocation,
  pickOptionDynamically,
  selectDemoScenario,
  touchDragOnCanvas,
  waitForAppReady,
  waitForAppState,
  waitForServiceWorkerReady,
} from './helpers';

test.describe('Tier 1: Feature Coverage', () => {
  test('T1.1: 3D canvas render, frame loop, draw call budget, and state contract', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    const state1 = await waitForAppReady(page);

    const canvas = page.getByTestId('scene-canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(300);
    expect(box!.height).toBeGreaterThanOrEqual(400);

    const state2 = await waitForAppState(
      page,
      (s) => s.frameCount >= state1.frameCount + 10,
      { timeout: 8_000, message: '3D render loop did not advance by 10 frames' }
    );

    expect(state2.drawCalls).toBeGreaterThan(0);
    expect(state2.drawCalls).toBeLessThanOrEqual(50);

    await assertCanvasNonBlank(page);

    expect(state2).toEqual(
      expect.objectContaining({
        camera: expect.objectContaining({
          yaw: expect.any(Number),
          pitch: expect.any(Number),
          position: expect.any(Array),
          viewMode: expect.any(String),
        }),
        estimate: expect.objectContaining({
          serviceType: expect.any(String),
          direction: expect.any(String),
          confidence: expect.any(Number),
          elevationFt: expect.any(Number),
          speedMph: expect.any(Number),
          outOfNyc: expect.any(Boolean),
        }),
        sensorStatus: expect.objectContaining({
          gps: expect.any(String),
          dr: expect.any(String),
          timing: expect.any(String),
        }),
        visibleLandmarks: expect.any(Array),
        visibleSystems: expect.any(Array),
        nearbyTrainCount: expect.any(Number),
        drawCalls: expect.any(Number),
        frameCount: expect.any(Number),
        mode: expect.any(String),
      })
    );

    monitors.assertClean();
  });

  test('T1.2: Camera look-around via touch drag and view reset', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const before = (await getAppState(page))!.camera;
    await touchDragOnCanvas(page, 110, -55, 10);

    const afterDragState = await waitForAppState(
      page,
      (s) =>
        Math.abs(s.camera.yaw - before.yaw) > 0.08 &&
        Math.abs(s.camera.pitch - before.pitch) > 0.03,
      { timeout: 6_000, message: 'Canvas touch drag did not update camera yaw and pitch' }
    );
    expect(Math.abs(afterDragState.camera.yaw - before.yaw)).toBeGreaterThan(0.08);
    expect(Math.abs(afterDragState.camera.pitch - before.pitch)).toBeGreaterThan(0.03);

    await page.getByTestId('btn-reset-view').click();

    const afterResetState = await waitForAppState(
      page,
      (s) =>
        (Math.abs(s.camera.yaw) < 0.08 || Math.abs(s.camera.yaw - before.yaw) < 0.08) &&
        (Math.abs(s.camera.pitch) < 0.08 || Math.abs(s.camera.pitch - before.pitch) < 0.08),
      { timeout: 6_000, message: 'btn-reset-view did not reset camera yaw and pitch' }
    );
    expect(Number.isFinite(afterResetState.camera.yaw)).toBe(true);
    expect(Number.isFinite(afterResetState.camera.pitch)).toBe(true);

    monitors.assertClean();
  });

  test('T1.3: Camera view modes cycle through inside, ghost, and chase', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const mode0 = (await getAppState(page))!.camera.viewMode;
    await assertCanvasNonBlank(page);

    const btnViewMode = page.getByTestId('btn-view-mode');
    await btnViewMode.click();
    const state1 = await waitForAppState(page, (s) => s.camera.viewMode !== mode0, {
      message: 'First btn-view-mode click did not change viewMode',
    });
    const mode1 = state1.camera.viewMode;
    await assertCanvasNonBlank(page);

    await btnViewMode.click();
    const state2 = await waitForAppState(
      page,
      (s) => s.camera.viewMode !== mode1 && s.camera.viewMode !== mode0,
      { message: 'Second btn-view-mode click did not advance to third viewMode' }
    );
    const mode2 = state2.camera.viewMode;
    await assertCanvasNonBlank(page);

    expect(new Set([mode0, mode1, mode2])).toEqual(new Set(['inside', 'ghost', 'chase']));

    await btnViewMode.click();
    await waitForAppState(page, (s) => s.camera.viewMode === mode0, {
      message: 'Third btn-view-mode click did not wrap back to initial viewMode',
    });

    monitors.assertClean();
  });

  test('T1.4: Gyroscope toggle and DeviceOrientationEvent look-around', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const gyroBtn = page.getByTestId('btn-gyro-toggle');
    await expect(gyroBtn).toBeVisible();
    await gyroBtn.click();

    await dispatchDeviceOrientation(page, { alpha: 0, beta: 75, gamma: 0 });
    const frameBase = (await getAppState(page))!.frameCount;
    const baseState = await waitForAppState(page, (s) => s.frameCount >= frameBase + 2);
    const camBase = baseState.camera;

    for (const sample of [
      { alpha: 20, beta: 70, gamma: 5 },
      { alpha: 45, beta: 60, gamma: 15 },
      { alpha: 65, beta: 55, gamma: 18 },
    ]) {
      await dispatchDeviceOrientation(page, sample);
      await page.waitForTimeout(50);
    }

    await waitForAppState(
      page,
      (s) =>
        Math.abs(s.camera.yaw - camBase.yaw) > 0.08 ||
        Math.abs(s.camera.pitch - camBase.pitch) > 0.05,
      { timeout: 6_000, message: 'DeviceOrientationEvent did not rotate camera when gyro enabled' }
    );

    // Disable gyro, wait 3 frames for any gyro-off reset/damping to settle, capture baseline,
    // then verify further orientation events do not cause a yaw jump.
    await gyroBtn.click();
    const frameAfterDisable = (await getAppState(page))!.frameCount;
    const settledState = await waitForAppState(
      page,
      (s) => s.frameCount >= frameAfterDisable + 3
    );
    const yawAfterDisable = settledState.camera.yaw;

    await dispatchDeviceOrientation(page, { alpha: 165, beta: 35, gamma: -25 });
    const frameAfterDispatch = (await getAppState(page))!.frameCount;
    const disabledState = await waitForAppState(
      page,
      (s) => s.frameCount >= frameAfterDispatch + 3
    );
    expect(Math.abs(disabledState.camera.yaw - yawAfterDisable)).toBeLessThan(0.08);

    monitors.assertClean();
  });

  test('T1.5: GPS ingestion and NYC station localization', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');

    const fixes = [
      { latitude: 40.7527, longitude: -73.9772, accuracy: 12, speed: 8.5, heading: 25 },
      { latitude: 40.7532, longitude: -73.9768, accuracy: 12, speed: 9.0, heading: 25 },
      { latitude: 40.7538, longitude: -73.9764, accuracy: 11, speed: 9.2, heading: 25 },
    ];
    for (const fix of fixes) {
      await emitMockGeolocation(page, fix);
      await page.waitForTimeout(300);
    }

    await expect(page.getByTestId('sensor-status-gps')).toHaveAttribute('data-status', 'locked');

    const localized = await waitForAppState(
      page,
      (s) =>
        s.sensorStatus.gps === 'locked' &&
        s.estimate.outOfNyc === false &&
        s.estimate.confidence > 0 &&
        s.estimate.stationId !== null,
      { timeout: 8_000, message: 'App did not localize to an NYC station from GPS fixes' }
    );

    const stationText = assertNoInvalidTokens(
      await page.getByTestId('hud-current-station').textContent(),
      'hud-current-station'
    );
    expect(stationText).not.toMatch(/^(--|unknown)$/i);

    for (const coord of localized.camera.position) {
      expect(Number.isFinite(coord)).toBe(true);
    }

    monitors.assertClean();
  });

  test('T1.6: Dead reckoning via IMU motion when GPS is absent', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensureMode(page, 'live');
    await pauseMockGeolocation(page);

    // Anchor on a valid NYC station via manual calibration so DR starts on track
    await page.getByTestId('btn-calibrate').click();
    await pickOptionDynamically(page.getByTestId('calibrate-station-select'));
    await pickOptionDynamically(page.getByTestId('calibrate-line-select'));
    await page.getByTestId('btn-calibrate-apply').click();

    const beforeState = await waitForAppState(page, (s) => s.estimate.stationId !== null);
    const pos0 = beforeState.camera.position;

    await dispatchMotionBurst(page, {
      samples: 40,
      intervalMs: 45,
      forwardAccel: 1.15,
      vibrationAmp: 0.35,
      yawRate: 0.02,
    });

    await expect(page.getByTestId('sensor-status-dr')).toHaveAttribute('data-status', 'active');

    const afterState = await waitForAppState(
      page,
      (s) => {
        const dx = s.camera.position[0] - pos0[0];
        const dz = s.camera.position[2] - pos0[2];
        return s.sensorStatus.dr === 'active' && (s.estimate.speedMph > 0.5 || Math.hypot(dx, dz) > 0.5);
      },
      { timeout: 8_000, message: 'IMU motion burst did not advance dead reckoning speed or position' }
    );

    expect(afterState.sensorStatus.dr).toBe('active');
    monitors.assertClean();
  });

  test('T1.7: Historical train timing model active during weekday AM rush', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.clock.setSystemTime(new Date('2026-11-16T08:30:00-05:00'));
    await page.goto('/');
    await waitForAppReady(page);

    await expect(page.getByTestId('sensor-status-timing')).toBeVisible();
    await expect(page.getByTestId('sensor-status-timing')).toHaveAttribute('data-status', 'active');

    await selectDemoScenario(page, 'express-overtake');
    const state = await waitForAppState(
      page,
      (s) => s.sensorStatus.timing === 'active' && typeof s.estimate.line === 'string' && s.estimate.line.length > 0
    );

    expect(state.sensorStatus.timing).toBe('active');
    expect(state.estimate.line).toBeTruthy();

    monitors.assertClean();
  });

  test('T1.8: Nearby MTA subway trains rendering and HUD list', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await selectDemoScenario(page, 'express-overtake');

    const state = await waitForAppState(
      page,
      (s) => s.nearbyTrainCount > 0 && s.visibleSystems.includes('MTA'),
      { timeout: 10_000, message: 'Expected nearby MTA trains in express-overtake scenario' }
    );

    expect(state.nearbyTrainCount).toBeGreaterThan(0);
    expect(state.visibleSystems).toContain('MTA');

    const mtaItems = page.locator('[data-testid="nearby-trains-list"] [data-system="MTA"]');
    await expect(mtaItems.first()).toBeVisible();
    expect(await mtaItems.count()).toBeGreaterThanOrEqual(1);
    assertNoInvalidTokens(await mtaItems.first().textContent(), 'nearby MTA train item');

    monitors.assertClean();
  });

  test('T1.9: Geographic landmarks — East River, Hudson River, and Harlem River', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);

    // 1. East River via Manhattan Bridge scenario
    await selectDemoScenario(page, 'manhattan-bridge');
    await waitForAppState(
      page,
      (s) => s.visibleLandmarks.includes('east-river'),
      { timeout: 10_000, message: 'east-river not reported in visibleLandmarks on manhattan-bridge' }
    );
    await expect(
      page.locator('[data-testid="nearby-landmarks-list"] [data-landmark="east-river"]')
    ).toBeVisible();

    // 2. Hudson River via West Village / 125 St riverside GPS
    await ensureMode(page, 'live');
    await emitMockGeolocation(page, {
      latitude: 40.7334,
      longitude: -74.0029,
      accuracy: 10,
      speed: 8,
      heading: 0,
    });
    await waitForAppState(
      page,
      (s) => s.visibleLandmarks.includes('hudson-river'),
      { timeout: 10_000, message: 'hudson-river not reported in visibleLandmarks near West Village' }
    );
    await expect(
      page.locator('[data-testid="nearby-landmarks-list"] [data-landmark="hudson-river"]')
    ).toBeVisible();

    // 3. Harlem River via 125 St–138 St Harlem River crossing GPS
    await emitMockGeolocation(page, {
      latitude: 40.8105,
      longitude: -73.9335,
      accuracy: 10,
      speed: 10,
      heading: 25,
    });
    await waitForAppState(
      page,
      (s) => s.visibleLandmarks.includes('harlem-river'),
      { timeout: 10_000, message: 'harlem-river not reported in visibleLandmarks near Harlem River' }
    );
    await expect(
      page.locator('[data-testid="nearby-landmarks-list"] [data-landmark="harlem-river"]')
    ).toBeVisible();

    monitors.assertClean();
  });

  test('T1.10: Regional rail systems (LIRR, MNR, PATH, NJT) across Midtown hubs', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await installMockGeolocation(page);
    await page.goto('/');
    await waitForAppReady(page);

    const observedStateSystems = new Set<string>();
    const observedDomSystems = new Set<string>();

    const collectSystems = async () => {
      const state = await getAppState(page);
      for (const sys of state?.visibleSystems ?? []) {
        observedStateSystems.add(sys);
      }
      const domSystems = await page
        .locator('[data-testid="nearby-trains-list"] [data-system]')
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute('data-system')).filter((v): v is string => Boolean(v))
        );
      for (const sys of domSystems) {
        observedDomSystems.add(sys);
      }
    };

    // 1. Midtown multi-system demo scenario
    await selectDemoScenario(page, 'midtown-multi-system');
    await waitForAppState(page, (s) => s.visibleSystems.length >= 2, {
      timeout: 10_000,
      message: 'midtown-multi-system did not show multiple rail systems',
    });
    await collectSystems();

    // 2. Penn Station / Herald Sq hub (LIRR, NJT, PATH)
    await ensureMode(page, 'live');
    await emitMockGeolocation(page, {
      latitude: 40.7506,
      longitude: -73.9935,
      accuracy: 10,
      speed: 5,
      heading: 25,
    });
    await expect
      .poll(
        async () => {
          await collectSystems();
          return (['LIRR', 'NJT', 'PATH'] as const).every(
            (sys) => observedStateSystems.has(sys) && observedDomSystems.has(sys)
          );
        },
        {
          timeout: 8_000,
          message: 'Expected LIRR, NJT, and PATH in state and DOM near Penn Station / Herald Sq',
        }
      )
      .toBe(true);

    // 3. Grand Central hub (MNR, LIRR)
    await emitMockGeolocation(page, {
      latitude: 40.7527,
      longitude: -73.9772,
      accuracy: 10,
      speed: 5,
      heading: 25,
    });
    await expect
      .poll(
        async () => {
          await collectSystems();
          return observedStateSystems.has('MNR') && observedDomSystems.has('MNR');
        },
        { timeout: 8_000, message: 'Expected MNR in state and DOM near Grand Central' }
      )
      .toBe(true);

    for (const required of ['LIRR', 'MNR', 'PATH', 'NJT'] as const) {
      expect(observedStateSystems.has(required), `Missing ${required} in visibleSystems`).toBe(true);
      expect(observedDomSystems.has(required), `Missing ${required} in nearby-trains-list DOM`).toBe(
        true
      );
    }

    monitors.assertClean();
  });

  test('T1.11: Mobile HUD data-testid contract, >=44px tap targets, and viewport footprint', async ({
    page,
  }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await selectDemoScenario(page, 'manhattan-bridge');

    const telemetryIds = [
      'hud-train-identity',
      'hud-confidence',
      'hud-current-station',
      'hud-next-station',
      'hud-speed',
      'hud-elevation',
    ] as const;

    for (const id of telemetryIds) {
      const el = page.getByTestId(id);
      await expect(el, `${id} should be visible`).toBeVisible();
      assertNoInvalidTokens(await el.textContent(), id);
    }

    const confAttr = await page.getByTestId('hud-confidence').getAttribute('data-confidence');
    expect(confAttr).not.toBeNull();
    const confVal = Number.parseFloat(confAttr!);
    expect(Number.isFinite(confVal)).toBe(true);
    expect(confVal).toBeGreaterThanOrEqual(0);
    expect(confVal).toBeLessThanOrEqual(100);

    const buttonIds = [
      'btn-calibrate',
      'btn-demo-mode',
      'btn-gyro-toggle',
      'btn-reset-view',
      'btn-view-mode',
    ] as const;

    for (const id of buttonIds) {
      const btn = page.getByTestId(id);
      await expect(btn, `${id} should be visible`).toBeVisible();
      const box = await btn.boundingBox();
      expect(box, `${id} must have a bounding box`).not.toBeNull();
      expect(box!.width, `${id} width must be >= 44px`).toBeGreaterThanOrEqual(43.5);
      expect(box!.height, `${id} height must be >= 44px`).toBeGreaterThanOrEqual(43.5);
    }

    // Center of mobile viewport (195, 422) must expose the 3D scene canvas unobstructed
    const centerTestId = await page.evaluate(() => {
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return hit?.getAttribute('data-testid') ?? null;
    });
    expect(centerTestId).toBe('scene-canvas');

    // Non-canvas visible interactive or painted HUD panels must remain compact (< 35% of viewport),
    // excluding transparent pointer-events: none full-viewport layout wrappers.
    const hudCoverageRatio = await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const viewportArea = vw * vh;
      const canvas = document.querySelector('[data-testid="scene-canvas"]');

      const isTransparentColor = (color: string): boolean => {
        if (!color || color === 'transparent') return true;
        const rgba = color.match(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)$/);
        return rgba !== null && Number.parseFloat(rgba[1]) === 0;
      };

      const hasVisibleBorder = (style: CSSStyleDeclaration): boolean => {
        const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
        return sides.some((side) => {
          const width = Number.parseFloat(style[`border${side}Width`]);
          const bStyle = style[`border${side}Style`];
          const color = style[`border${side}Color`];
          return width > 0 && bStyle !== 'none' && bStyle !== 'hidden' && !isTransparentColor(color);
        });
      };

      const hasVisiblePaint = (style: CSSStyleDeclaration): boolean => {
        if (!isTransparentColor(style.backgroundColor)) return true;
        if (style.backgroundImage && style.backgroundImage !== 'none') return true;
        if (hasVisibleBorder(style)) return true;
        if (style.backdropFilter && style.backdropFilter !== 'none') return true;
        return false;
      };

      const clippedArea = (el: HTMLElement): number => {
        const r = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        return w * h;
      };

      const candidates = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter((el) => {
        if (el === canvas || (canvas && el.contains(canvas))) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity) === 0
        ) {
          return false;
        }
        if (clippedArea(el) <= 0) return false;
        return style.pointerEvents !== 'none' || hasVisiblePaint(style);
      });

      // Keep top-level interactive/painted HUD panels (exclude descendants already inside a counted panel)
      const topLevelPanels = candidates.filter(
        (el) => !candidates.some((other) => other !== el && other.contains(el))
      );

      const area = topLevelPanels.reduce((sum, el) => sum + clippedArea(el), 0);
      return area / viewportArea;
    });
    expect(hudCoverageRatio).toBeGreaterThan(0);
    expect(hudCoverageRatio).toBeLessThan(0.35);

    monitors.assertClean();
  });

  test('T1.12: Manual calibration drawer overrides station and line', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const before = (await getAppState(page))!;
    await page.getByTestId('btn-calibrate').click();

    const stationSelect = page.getByTestId('calibrate-station-select');
    const lineSelect = page.getByTestId('calibrate-line-select');
    const applyBtn = page.getByTestId('btn-calibrate-apply');

    await expect(stationSelect).toBeVisible();
    await expect(lineSelect).toBeVisible();
    await expect(applyBtn).toBeVisible();

    const stationOptions = await listSelectOptions(stationSelect);
    const lineOptions = await listSelectOptions(lineSelect);
    expect(stationOptions.length).toBeGreaterThanOrEqual(5);
    expect(lineOptions.length).toBeGreaterThanOrEqual(5);

    const pickedStation = await pickOptionDynamically(
      stationSelect,
      /Grand Central|Times Sq|14 St|34 St|Canal/i,
      before.estimate.stationId
    );
    const pickedLine = await pickOptionDynamically(
      lineSelect,
      /^[A1246NQ7L]/i,
      before.estimate.line
    );

    await applyBtn.click();

    const after = await waitForAppState(
      page,
      (s) =>
        s.estimate.confidence >= 50 &&
        (s.estimate.stationId === pickedStation.value || s.estimate.line === pickedLine.value),
      { timeout: 8_000, message: 'Manual calibration did not apply selected station/line' }
    );

    const hudStation = assertNoInvalidTokens(
      await page.getByTestId('hud-current-station').textContent(),
      'hud-current-station'
    );
    const hudIdentity = assertNoInvalidTokens(
      await page.getByTestId('hud-train-identity').textContent(),
      'hud-train-identity'
    );

    expect(
      after.estimate.stationId === pickedStation.value ||
        hudStation.toLowerCase().includes(pickedStation.label.slice(0, 5).toLowerCase())
    ).toBe(true);
    expect(
      after.estimate.line === pickedLine.value ||
        hudIdentity.toUpperCase().includes(pickedLine.value.toUpperCase())
    ).toBe(true);
    expect(after.estimate.confidence).toBeGreaterThanOrEqual(50);

    monitors.assertClean();
  });

  test('T1.13: Built-in demo mode and scenario switching', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // 1. manhattan-bridge: elevated above river + east-river landmark
    await selectDemoScenario(page, 'manhattan-bridge');
    const bridgeState = await waitForAppState(
      page,
      (s) =>
        s.mode === 'sim' &&
        s.estimate.elevationFt > 10 &&
        s.visibleLandmarks.includes('east-river'),
      { timeout: 10_000, message: 'manhattan-bridge did not report elevated bridge + east-river' }
    );
    expect(bridgeState.estimate.elevationFt).toBeGreaterThan(10);

    // 2. lexington-underground: underground elevation < 0
    await selectDemoScenario(page, 'lexington-underground');
    const lexState = await waitForAppState(
      page,
      (s) => s.mode === 'sim' && s.estimate.elevationFt < 0,
      { timeout: 10_000, message: 'lexington-underground did not report underground elevation < 0' }
    );
    expect(lexState.estimate.elevationFt).toBeLessThan(0);

    // 3. express-overtake: nearby trains present
    await selectDemoScenario(page, 'express-overtake');
    const overtakeState = await waitForAppState(
      page,
      (s) => s.mode === 'sim' && s.nearbyTrainCount > 0,
      { timeout: 10_000, message: 'express-overtake did not report nearby trains' }
    );
    expect(overtakeState.nearbyTrainCount).toBeGreaterThan(0);

    // 4. midtown-multi-system: >= 2 rail systems visible
    await selectDemoScenario(page, 'midtown-multi-system');
    const multiState = await waitForAppState(
      page,
      (s) => s.mode === 'sim' && s.visibleSystems.length >= 2,
      { timeout: 10_000, message: 'midtown-multi-system did not report >= 2 visible systems' }
    );
    expect(multiState.visibleSystems.length).toBeGreaterThanOrEqual(2);

    // 5. Toggle Demo Mode off → back to live
    await ensureMode(page, 'live');
    const liveState = await getAppState(page);
    expect(liveState?.mode).toBe('live');

    monitors.assertClean();
  });

  test('T1.14: Offline Service Worker registration and status badge', async ({ page }) => {
    const monitors = attachRuntimeMonitors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const badge = page.getByTestId('offline-status-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-online', 'true');
    await waitForServiceWorkerReady(page, 15_000);

    const swActive = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    });
    expect(swActive).toBe(true);

    monitors.assertClean();
  });
});
