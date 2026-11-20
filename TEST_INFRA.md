# TEST_INFRA.md — SubwaySight 3D Opaque-Box E2E Test Infrastructure

## 1. Test Philosophy

The SubwaySight 3D E2E suite is **strictly opaque-box and requirement-driven**, derived exclusively from `/home/antigravity/.agents/teamwork/ORIGINAL_REQUEST.md` and `/home/antigravity/PROJECT.md` (Feature Inventory & Interface Contracts §4).

- **Zero Implementation Coupling**: E2E tests NEVER import from `src/` or `tests/unit/`. All interaction happens through:
  1. Normative `data-testid` DOM selectors and `data-*` attributes (`PROJECT.md § Interface Contracts #4`).
  2. Standard Playwright browser APIs (`page.clock.setSystemTime`, `context.setGeolocation`, `context.grantPermissions`, `context.setOffline`, `page.setViewportSize`, `page.reload`, CDP touch/pointer dispatch, network monitoring).
  3. Browser-API-level sensor harnesses (`navigator.geolocation` init-script mock for custom accuracy/timeout/denial injection; `DeviceMotionEvent` and `DeviceOrientationEvent` dispatch).
  4. Rendered `<canvas>` pixel inspection (via `preserveDrawingBuffer: true`) to prove genuine non-blank 3D WebGL output.
  5. The read-only diagnostic snapshot `window.__SUBWAY_VISION_STATE__`.
- **Dynamic Option Discovery**: Calibration dropdown tests select real `<option>` values rendered in the DOM rather than hardcoding internal station IDs.
- **Global Per-Test Invariants**: Every test asserts zero uncaught `pageerror`, zero `console.error`, zero external-origin network requests (offline-first / zero-CDN guarantee), and genuine non-blank 3D rendering (`frameCount > 0`, `drawCalls <= 50`).

---

## 2. Test Architecture

### Runtime & Playwright Configuration (`/home/antigravity/playwright.config.ts`)
- **Browser**: Pre-installed system Chromium (`/usr/lib/chromium/chromium`, Chromium 156) — zero browser download required.
- **Container & WebGL Launch Options**:
  - `chromiumSandbox: false` (required in unprivileged container with `CapEff: 0`)
  - `args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader']`
- **PWA / Offline Support**: `serviceWorkers: 'allow'`, `baseURL: 'http://127.0.0.1:4173'`, `timezoneId: 'America/New_York'`.
- **Web Server**: `npm run preview -- --port 4173 --strictPort --host 127.0.0.1` (`reuseExistingServer: true`).
- **Default Viewport**: Mobile portrait `390×844` (`hasTouch: true`, `isMobile: true`, `deviceScaleFactor: 2`), with dynamic `page.setViewportSize({ width: 844, height: 390 })` for landscape tests.
- **Parallelism & Timeouts**: `workers: process.env.CI ? 1 : 2`, `fullyParallel: false`, `timeout: 45_000`, `expect.timeout: 10_000` (tuned for deterministic SwiftShader WebGL rendering).

### Directory Layout
```
/home/antigravity/
├── playwright.config.ts
└── tests/e2e/
    ├── helpers.ts                  # Strictly opaque-box helpers (geo mock, IMU/orientation dispatch,
    │                               # canvas pixel check, state polling, network/error monitors, CDP touch drag)
    ├── tier1-features.spec.ts      # Tier 1: Isolated feature coverage (14 tests)
    ├── tier2-boundaries.spec.ts    # Tier 2: Boundary & corner cases (10 tests)
    ├── tier3-combinations.spec.ts  # Tier 3: Cross-feature combinations (5 tests)
    └── tier4-scenarios.spec.ts     # Tier 4: Real-world NYC rider journeys (5 tests)
```

---

## 3. Feature Inventory → Tiers 1–4 Mapping

Every feature from `PROJECT.md § Feature Inventory` is mapped below:

| # | Feature | Milestone | Tier 1 (Happy Path) | Tier 2 (Boundaries) | Tier 3 (Combinations) | Tier 4 (Scenarios) |
|---|---------|-----------|---------------------|---------------------|-----------------------|--------------------|
| 1 | Project Scaffold & Offline Build | M1 | T1.1, T1.14 | T2.9 (zero CDN), T2.10 (offline reload) | C2, C5 | S4 |
| 2 | Local ENU Coordinate Projection | M1 | T1.5, T1.9 | T2.3, T2.4 | C1, C4 | S1–S5 |
| 3 | Core NYC MTA 3D Network Dataset | M1 | T1.1, T1.8, T1.13 | T2.5 (express/local) | C1, C4 | S1, S2, S3 |
| 4 | Historical Train Timing Dataset | M1 | T1.7 | T2.5, T2.6 (late-night/weekend) | C4, C5 | S2, S3 |
| 5 | Basic Geographic Landmarks Data | M1 | T1.9 (`east-river`, `hudson-river`, `harlem-river`) | — | C1 | S1, S2 |
| 6 | Other Regional Train Systems Data | M1 | T1.10 (`LIRR`, `MNR`, `PATH`, `NJT`) | — | C4 | S2, S3 |
| 7 | Dataset Integrity & Size Budget | M1 | Verified indirectly by runtime load + T1.1/T1.8–T1.10 & M1 unit tests | T2.9 | C4 | S1–S5 |
| 8 | Unified Sensor Abstraction & Sim | M2 | T1.5, T1.6, T1.13 | T2.1–T2.4 | C1, C2 | S1, S3, S5 |
| 9 | GPS Gating & Tunnel Detection | M2 | T1.5 | T2.1 (denied), T2.2 (timeout), T2.3 (coarse >500m), T2.4 (out-of-NYC) | C1 | S1, S5 |
| 10 | Gravity-Aligned IMU Dead Reckoning | M2 | T1.6 | T2.2 (tunnel DR takeover) | C1 | S1, S3 |
| 11 | Multi-Modal Particle Filter Fusion | M2 | T1.5, T1.6, T1.7, T1.12 | T2.3, T2.4, T2.5 | C1, C2, C4, C5 | S1–S5 |
| 12 | Rough Real-Time Traffic & Landmarks | M2 | T1.8, T1.9, T1.10 | T2.5, T2.6 | C1, C4 | S1, S2, S3 |
| 13 | 3D First-Person WebGL Scene | M3 | T1.1 (non-blank, `frameCount`, `drawCalls <= 50`) | T2.7, T2.10 | C1–C5 | S1–S5 |
| 14 | Camera Rig & View Modes | M3 | T1.2 (drag & reset), T1.3 (`inside`/`ghost`/`chase`) | T2.8 (HUD touch isolation) | C3 | S2, S3 |
| 15 | Gyroscope Look-Around | M3 | T1.4 (`btn-gyro-toggle` + `DeviceOrientationEvent`) | — | C3 | — |
| 16 | 3D Network, Consists & Landmarks Render | M3 | T1.1, T1.8, T1.9, T1.10 | T2.7 | C3, C4 | S1–S5 |
| 17 | Mobile-First Telemetry HUD | M4 | T1.11 (all `data-testid` fields, `≥44px` tap targets, footprint) | T2.7 (portrait↔landscape), T2.8 (touch isolation) | C4, C5 | S1–S5 |
| 18 | Manual Calibration & Demo Controls | M4 | T1.12 (calibration), T1.13 (demo scenarios) | — | C2, C5 | S1, S4, S5 |
| 19 | Offline-First PWA & Persistence | M4 | T1.14 (SW registration & badge) | T2.9 (zero external reqs), T2.10 (cold-start offline reload) | C2, C5 | S4 |
| 20 | Opaque-Box E2E Testability Contract | M4 | T1.1–T1.14 (`data-testid` + `window.__SUBWAY_VISION_STATE__`) | T2.1–T2.10 | C1–C5 | S1–S5 |
| 21 | Final E2E Pass & Adversarial Hardening | M5 | Gate executed in M5 Phase 1 against complete app; Tier 5 added in M5 Phase 2 | M5 Gate | M5 Gate | M5 Gate |

---

## 4. Tier 4 Real-World Application Scenarios (`tests/e2e/tier4-scenarios.spec.ts`)

1. **S1 — Manhattan Bridge Crossing (Brooklyn → Manhattan)**: Rider crosses East River on Manhattan Bridge (`manhattan-bridge` scenario / bridge→tunnel transition), observes `east-river` landmark, elevation dropping from elevated bridge (`> 0 ft`) into Manhattan tunnel (`< 0 ft`), GPS→DR handoff, nearby MTA trains, and smooth HUD updates.
2. **S2 — 8th Ave Express Rush Hour Commute Past Penn Station**: Weekday 8:30 AM EDT (`page.clock.setSystemTime`), rider passes Penn Station / 34th St corridor, sees `hudson-river` and regional rail systems (`LIRR`, `NJT`, `PATH`), express service telemetry, looks around via canvas drag, toggles `ghost` cutaway view, and resets camera.
3. **S3 — Lexington Ave Underground Commute Past Grand Central**: Underground `lexington-underground` ride (`elevationFt < 0`), dead reckoning active, Metro-North (`MNR`) and/or `LIRR` nearby near Grand Central, rider cycles camera view modes and resets view.
4. **S4 — Full Airplane-Mode Cold-Start Commute from Service Worker Cache**: Online visit primes Workbox SW (`data-sw="ready"`), device switches offline (`context.setOffline(true)`), full `page.reload()` succeeds with `data-online="false"`, zero `pageerror`/`console.error`/`requestfailed`, non-blank 3D canvas, and an active multi-frame offline ride via demo mode / manual calibration.
5. **S5 — Out-of-NYC User Recovering via Demo Mode & Manual Calibration**: User launches from out-of-NYC coordinates (London `51.5074, -0.1278`), sees graceful `outOfNyc === true` state without crash, switches to Demo Mode (`manhattan-bridge`) to explore the 3D NYC network, then uses Manual Calibration to anchor to a live NYC station/line and verifies clean recovery (`outOfNyc === false`).

---

## 5. Coverage Thresholds & Gate Criteria

- **Total E2E Tests**: 34 tests across 4 tiers (Tier 1: 14, Tier 2: 10, Tier 3: 5, Tier 4: 5).
- **Feature Coverage**: 100% of user-facing features (#1–#20) covered in Tiers 1–4.
- **Zero Flake / Integrity Rules**:
  - 0 `test.skip`, 0 `test.fixme`, 0 `test.only`.
  - 0 vacuous assertions (`expect(true).toBe(true)`).
  - 0 imports from `src/` or `tests/unit/`.
  - `npx playwright test --list` discovers all 34 tests with exit code 0.
- **M5 Final Gate Requirement**: 100% pass rate (34/34) on `npm run test:e2e` against the production Vite preview build (`npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1`).
