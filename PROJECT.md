# Project: SubwaySight 3D — Offline First-Person NYC Rail Visualizer

## Architecture

A zero-CDN, offline-first 3D mobile web application (PWA) built with **Vite 8 + TypeScript 7 + Three.js (`0.187.x`) + `vite-plugin-pwa` (Workbox) + Vitest + Playwright (using `/usr/lib/chromium/chromium`)** and a lightweight vanilla DOM/CSS mobile HUD.

### High-Level Data Flow
```
[SensorSource: Live | DeterministicSim | Replay]
        │  SensorSample (GPS, IMU accel/gyro, orientation, timestamp)
        ▼
[Localization Engine (Track-Constrained 1D Particle Filter)]
  ├── GPS Filter (accuracy/staleness gating + negative tunnel-visibility evidence)
  ├── Dead Reckoning (gravity-aligned accel/gyro, vibration dwell detector, ZUPT, yaw curvature)
  └── Historical Timing Model (MTA service periods, inter-station run/dwell/headway tables)
        │  EstimatorState (ego 3D ENU pose, route/express/dir, confidence, stations, sensor pills)
        ▼
[Traffic & Landmark Engine]
  ├── Articulated Own-Train Consist (8–11 cars along 3D spline)
  ├── Rough Real-Time Nearby MTA + Regional Rail Trains (LIRR, MNR, PATH, NJT, AirTrain)
  └── Nearby Rivers (Hudson, East, Harlem) & Bridges distance/visibility
        │  WorldStateSnapshot
        ├───────────────────────────────────────────┐
        ▼                                           ▼
[3D WebGL Renderer (Three.js)]              [Mobile HUD & PWA Shell]
  ├── SceneManager (≤50 draw calls, DPR≤2)    ├── Compact Telemetry HUD (data-testid contract)
  ├── CameraController (Inside/Ghost/Chase)   ├── Manual Calibration Drawer (Station/Line)
  ├── CarInteriorLayer (frame / wireframe)    ├── Built-In Demo Mode (3+ NYC Scenarios)
  ├── TrackLayer (MTA + Regional corridors)   ├── iOS-Safe Gyro & Sensor Permission Flow
  ├── TrainLayer (InstancedMesh consists)     ├── Screen Wake Lock & Visibility Pause
  ├── StructureLayer (tunnels, viaducts)      └── Service Worker Precache + IndexedDB/LS
  └── LandmarkLayer (rivers, shores, bridges)
```

### Coordinate System (Single Source of Truth)
- **Origin**: Midtown Manhattan `LAT_0 = 40.7549`, `LON_0 = -73.9840`, `ALT_0 = 0.0 m` (Mean Sea Level / river surface).
- **Local ENU Conversion**:
  - `M_LAT = 111048.8 m/deg`, `M_LON = 84327.6 m/deg` (`111319.5 * cos(40.7549°)`).
  - `East = (lon - LON_0) * M_LON`, `North = (lat - LAT_0) * M_LAT`, `Up = elevation_m`.
- **Three.js Frame**: `X = East`, `Y = Up`, `Z = -North` (Compass 0° North = `-Z`, 90° East = `+X`).
- **Floating Origin**: Render world shifted relative to camera chunk origin if ego distance > 5 km to prevent float32 GPU jitter.

## Code Layout

```
/home/antigravity/
├── index.html                      # Mobile PWA entry (viewport-fit=cover, zero external URLs)
├── package.json                    # Scripts: dev, build, preview, test, typecheck, test:e2e
├── tsconfig.json                   # Strict TypeScript config
├── vite.config.ts                  # Vite 8 + vite-plugin-pwa (Workbox generateSW precache)
├── public/
│   ├── manifest.webmanifest        # Standalone PWA manifest
│   └── icons/                      # Local SVG/PNG 192x192 & 512x512 maskable icons
├── src/
│   ├── main.ts                     # App bootstrap, SW registration, clock/DOM wiring
│   ├── app.ts                      # Main controller loop (Sensors → Localization → Traffic → Render/HUD)
│   ├── types/
│   │   ├── transit.ts              # Station, TrackSegment, RoutePattern, Schedule, Landmark types
│   │   ├── sensors.ts              # SensorSample, SensorSource, GpsStatus, DrStatus types
│   │   └── state.ts                # EstimatorState, NearbyTrain, WorldStateSnapshot, DebugSnapshot
│   ├── geo/
│   │   └── projection.ts           # WGS84 ↔ ENU ↔ Three.js conversions, polyline arc-length & tangent sampling
│   ├── data/
│   │   ├── stations.ts             # Core NYC MTA + regional hub stations (lat/lon/ENU/elevation)
│   │   ├── tracks.ts               # 9 MTA trunks (local/express/bi-level) + LIRR/MNR/PATH/NJT/AirTrain
│   │   ├── schedules.ts            # Service periods, headways, inter-station run & dwell times
│   │   ├── landmarks.ts            # Hudson/East/Harlem Rivers, Upper Bay, boroughs, major bridges
│   │   └── dataset.ts              # Unified TransitDataset loader + spatial index + integrity validator
│   ├── sensors/
│   │   ├── liveSensorSource.ts     # Geolocation + DeviceMotion + DeviceOrientation (iOS permission safe)
│   │   ├── simSensorSource.ts      # DeterministicSimSource (Mulberry32 PRNG + 5 NYC ride scenarios)
│   │   └── replaySensorSource.ts   # ReplaySensorSource for recorded traces & deterministic tests
│   ├── localization/
│   │   ├── gpsFilter.ts            # Accuracy/staleness gating + negative tunnel-visibility evidence
│   │   ├── deadReckoning.ts        # Gravity-aligned IMU, vibration dwell detector, ZUPT, yaw curvature
│   │   ├── scheduleModel.ts        # Service period classifier & timetable likelihood evaluator
│   │   └── particleFilter.ts       # Track-constrained 1D hybrid particle filter (250–400 particles)
│   ├── traffic/
│   │   └── trafficEngine.ts        # Own-train consist + rough real-time MTA & regional trains + landmarks
│   ├── render/
│   │   ├── SceneManager.ts         # Three.js WebGL2 setup, DPR cap, FogExp2, context-loss, visibility pause
│   │   ├── CameraController.ts     # First-person rig, Inside/Ghost/Chase views, gyro + touch drag + reset
│   │   ├── CarInteriorLayer.ts     # Train car interior frame / translucent ghost cutaway
│   │   ├── TrackLayer.ts           # Merged color-coded MTA & regional rail tracks
│   │   ├── TrainLayer.ts           # InstancedMesh train consists + lights + route sprites
│   │   ├── StructureLayer.ts       # InstancedMesh tunnel ribs, viaduct columns, stations/signs
│   │   └── LandmarkLayer.ts        # River water planes (Y=0), borough outlines, bridge silhouettes
│   ├── ui/
│   │   ├── styles.css              # Mobile-first safe-area portrait/landscape styles (zero CDN fonts)
│   │   ├── HudController.ts        # Telemetry HUD, calibration drawer, demo controls, sensor permissions
│   │   └── fallbackView.ts         # Graceful WebGL-unavailable / context-lost recovery banner
│   └── pwa/
│       ├── registerSw.ts           # Service Worker registration + online/offline state tracking
│       ├── storage.ts              # localStorage settings + IndexedDB calibration/trip store
│       └── wakeLock.ts             # Screen Wake Lock API wrapper
├── tests/
│   ├── unit/                       # Vitest unit & deterministic replay tests (owned by Implementation Track)
│   └── e2e/                        # Playwright opaque-box E2E test suite (owned by E2E Testing Track)
└── playwright.config.ts            # Playwright config using /usr/lib/chromium/chromium + SwiftShader flags
```

## Feature Inventory

Every Survey feature assigned a milestone (none unassigned).

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Project Scaffold & Offline Build | Vite 8 + TypeScript 7 + Three.js + `vite-plugin-pwa` + Vitest setup, zero CDN deps, local system fonts & icons | M1 | survey_1 |
| 2 | Local ENU Coordinate Projection | WGS84 ↔ Midtown ENU ↔ Three.js `(X=E, Y=U, Z=-N)` projection + polyline arc-length/tangent/curvature sampling | M1 | survey_1, survey_2 |
| 3 | Core NYC MTA 3D Network Dataset | 9 core trunks (`1/2/3`, `4/5/6`, `7`, `A/C/E`, `B/D/F/M`, `N/Q/R/W`, `L`, `G`, `J/Z`), parallel local/express & bi-level elevations, underground/underwater/elevated/bridge tags | M1 | survey_2 |
| 4 | Historical Train Timing Dataset | Offline service periods (AM/PM rush, midday, evening, weekend, late night), route active flags, headways, inter-station run & dwell times | M1 | survey_2, survey_3 |
| 5 | Basic Geographic Landmarks Data | Offline low-poly geometry for Hudson River, East River, Harlem River, Upper NY Bay (`Y=0`), borough footprints, and major bridges (Manhattan, Williamsburg, Brooklyn, Queensboro, GW) | M1 | survey_2, survey_3 |
| 6 | Other Regional Train Systems Data | Offline 3D corridors, hubs, and schedule patterns for LIRR, Metro-North (`MNR`), PATH, NJ Transit (`NJT`), and AirTrain | M1 | survey_2, survey_3 |
| 7 | Dataset Integrity & Size Budget | Automated validator (monotonic station `s`, crossing clearance, valid refs) + `< 250 KB` gzipped data budget | M1 | survey_2 |
| 8 | Unified Sensor Abstraction & Sim | `SensorSource` interface: `LiveSensorSource` (Geolocation + DeviceMotion/Orientation), `DeterministicSimSource` (seeded PRNG + 5 NYC scenarios), `ReplaySensorSource` | M2 | survey_2, survey_3 |
| 9 | GPS Gating & Tunnel Detection | Accuracy/staleness gating (`accuracy > 150m` rejected, stale > 8s), `PERMISSION_DENIED`/`POSITION_UNAVAILABLE`/`TIMEOUT` handling, negative GPS tunnel-visibility evidence | M2 | survey_2, survey_3 |
| 10 | Gravity-Aligned IMU Dead Reckoning | Horizontal projection, vibration RMS stop/dwell detector, ZUPT bias reset, gyro yaw-rate curvature matching, kinematic speed clamping, station snapping | M2 | survey_2, survey_3 |
| 11 | Multi-Modal Particle Filter Fusion | Track-constrained 1D hybrid particle filter (250–400 particles) fusing GPS + DR + historical timing + manual anchor → `EstimatorState`, Top-K train candidates, confidence %, out-of-NYC detection | M2 | survey_2, survey_3 |
| 12 | Rough Real-Time Traffic & Landmarks | Articulated own-train consist (8–11 cars) + schedule-interpolated nearby MTA & regional rail trains (`LIRR`, `MNR`, `PATH`, `NJT`, `AIRTRAIN`) with signal-block separation + nearby river distances | M2 | survey_2, survey_3 |
| 13 | 3D First-Person WebGL Scene | Three.js WebGL2 engine (`preserveDrawingBuffer: true`, DPR cap `≤2`, no shadows, `FogExp2`, `≤50` draw calls, floating origin, `webglcontextlost` recovery, `visibilitychange` pause) | M3 | survey_1, survey_3 |
| 14 | Camera Rig & View Modes | First-person eye-level mount inside car, toggleable `inside` / `ghost` (X-Ray cutaway) / `chase` modes, smooth touch/pointer drag yaw/pitch + pinch-zoom + double-tap/button reset | M3 | survey_1, survey_3 |
| 15 | Gyroscope Look-Around | Optional `DeviceOrientation` quaternion look-around anchored to track heading (immune to steel-tunnel magnetic distortion), screen orientation angle correction, iOS `requestPermission()` support | M3 | survey_1, survey_3 |
| 16 | 3D Network, Consists & Landmarks Render | Merged color-coded MTA & regional tracks, `InstancedMesh` articulated trains/tunnel ribs/viaduct columns/platforms/signs, translucent `Y=0` river planes, borough outlines & bridge silhouettes | M3 | survey_1, survey_2, survey_3 |
| 17 | Mobile-First Telemetry HUD | Portrait & landscape responsive layout (`100dvw × 100dvh`, `env(safe-area-inset-*)`, `≥44px` tap targets, `<25%` footprint) with full `data-testid` contract & touch isolation | M4 | survey_1, survey_3 |
| 18 | Manual Calibration & Demo Controls | Interactive calibration drawer ("I'm at Station X" / "I'm on Line Y" + Reset) + Built-in Demo Mode switcher (`manhattan-bridge`, `express-overtake`, `lexington-underground`, etc., play/pause, `1×/2×/5×`) | M4 | survey_2, survey_3 |
| 19 | Offline-First PWA & Persistence | Workbox Service Worker precaching (`< 2.5 MB` gz, zero external URLs), cold-start offline support, offline/online status badge, Screen Wake Lock, `localStorage` + `IndexedDB` persistence | M4 | survey_1, survey_3 |
| 20 | Opaque-Box E2E Testability Contract | Stable `data-testid` DOM contract, deterministic `Date.now()`/`performance.now()` clock usage, mock Geolocation/DeviceMotion compatibility, read-only `window.__SUBWAY_VISION_STATE__` snapshot | M4 | survey_3 |
| 21 | Final E2E Pass & Adversarial Hardening | Pass 100% of E2E Tiers 1–4 (`TEST_READY.md`) + Tier 5 white-box adversarial coverage hardening | M5 | project_pattern |

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Scaffold, Projection & Offline NYC Dataset | Project build setup, shared types, ENU projection, 9 MTA trunks, historical schedules, rivers/bridges, 5 regional rail systems, dataset tests | none | DONE (154 stations, 48 tracks, 62 schedules, 32/32 unit tests, 52.79 KB gz) |
| M2 | Sensor Fusion, Dead Reckoning & Traffic Engine | SensorSource (Live/Sim/Replay), GPS filter, IMU dead reckoning, schedule model, 1D particle filter, nearby MTA/regional traffic & landmark engine, unit/replay tests | M1 | DONE (79/79 unit tests, 0.21 ms/tick PF, 0 signal-block violations) |
| M3 | 3D First-Person WebGL Renderer & Camera Rig | Three.js SceneManager, CameraController (Inside/Ghost/Chase, touch + gyro), CarInterior, Track, Train, Structure, and Landmark layers, unit tests | M1 | DONE (22/21/18 draw calls <= 50, SwiftShader WebGL2 verified, 75/75 unit tests) |
| M4 | Mobile HUD, Controls, Offline PWA & App Wiring | Responsive mobile HUD (`data-testid` contract), calibration drawer, demo mode UI, sensor permissions, SW precaching, Wake Lock, IndexedDB/LS, `main.ts`/`app.ts` integration | M2, M3 | DONE (97/97 unit tests, 0.1888 MB gz, <25% portrait & landscape HUD, 5/5 PASS) |
| M5 | Final Milestone: E2E Tiers 1–4 & Tier 5 Hardening | Phase 1: Pass 100% E2E Tiers 1–4 (`TEST_READY.md`); Phase 2: Tier 5 white-box adversarial coverage hardening | M4, TEST_READY.md | DONE (34/34 Tiers 1–4 E2E PASS, 149/149 unit tests incl. 35 Tier 5 adversarial tests, 17 Tier 5 bugs fixed, 194.62 KB gz `dist/`, Whole-Project Forensic Audit CLEAN, 2× fresh Challengers `NO_REMAINING_GAPS`) |

## Interface Contracts

### 1. Shared Data & Projection (`M1` ↔ `M2`, `M3`, `M4`)
- `src/geo/projection.ts`:
  - `wgs84ToEnu(lat: number, lon: number, elevM?: number): [number, number, number]` (`[east, north, up]`)
  - `enuToWgs84(e: number, n: number, u?: number): { lat: number; lon: number; elevM: number }`
  - `enuToThree(e: number, n: number, u: number): [number, number, number]` (`[e, u, -n]`)
  - `samplePolylineAtS(points: TrackPoint[], s: number): { enu: [number, number, number]; tangentEnu: [number, number, number]; headingRad: number; pitchRad: number; curvature: number; structure: StructureType }`
- `src/types/transit.ts`:
  - `RailSystem = 'MTA' | 'LIRR' | 'MNR' | 'PATH' | 'NJT' | 'AIRTRAIN'`
  - `StructureType = 'UNDERGROUND_TUNNEL' | 'UNDERWATER_TUNNEL' | 'ELEVATED' | 'BRIDGE' | 'OPEN_CUT' | 'AT_GRADE' | 'STATION'`
  - `GpsVisibility = 'OPEN_SKY' | 'URBAN_CANYON' | 'PORTAL' | 'UNDERGROUND'`
  - `ServicePeriod = 'WEEKDAY_AM_RUSH' | 'WEEKDAY_MIDDAY' | 'WEEKDAY_PM_RUSH' | 'WEEKDAY_EVENING' | 'WEEKEND_DAY' | 'LATE_NIGHT'`
  - `TransitDataset`: `{ stations: Station[]; tracks: TrackPolyline[]; schedules: RouteSchedule[]; landmarks: LandmarkDataset; stationById: Map<string, Station>; trackById: Map<string, TrackPolyline> }`
- **Landmark IDs (normative)**: `'east-river'`, `'hudson-river'`, `'harlem-river'`, `'upper-bay'`.

### 2. Sensors, Localization & Traffic (`M2` ↔ `M3`, `M4`)
- `src/types/sensors.ts`:
  - `SensorSample`: `{ tMs: number; gps?: { lat: number; lon: number; accuracyM: number; speedMps?: number; headingDeg?: number; fixAgeMs: number }; gpsErrorCode?: 1 | 2 | 3; imu?: { accelLin: [number, number, number]; accelGrav: [number, number, number]; gyroRadS: [number, number, number] }; orientation?: { alpha: number; beta: number; gamma: number; compassDeg?: number } }`
  - `SensorSource`: `{ readonly mode: 'live' | 'sim' | 'replay'; start(): void; stop(): void; onSample(cb: (sample: SensorSample) => void): () => void; setScenario?(id: DemoScenarioId): void; setPaused?(paused: boolean): void; setSpeedMultiplier?(mult: 1 | 2 | 5): void }`
  - `DemoScenarioId = 'manhattan-bridge' | 'express-overtake' | 'lexington-underground' | 'steinway-queens' | 'midtown-multi-system'`
- `src/types/state.ts`:
  - `EstimatorState`:
    - `routeId: string | null`, `serviceType: 'EXPRESS' | 'LOCAL' | 'COMMUTER' | 'UNKNOWN'`, `direction: 'UPTOWN' | 'DOWNTOWN' | 'OUTBOUND' | 'INBOUND' | 'UNKNOWN'`
    - `displayLabel: string` (e.g. `'A Express — Uptown'` or `'Unknown Train'`)
    - `confidencePct: number` (`0–100`), `candidates: Array<{ routeId: string; serviceType: string; direction: string; probability: number }>`
    - `currentStationId: string | null`, `currentStationName: string`, `nextStationId: string | null`, `nextStationName: string`, `etaSec: number | null`
    - `positionEnu: [number, number, number]`, `positionLatLng: { lat: number; lon: number }`, `headingRad: number`, `pitchRad: number`
    - `speedMps: number`, `speedMph: number`, `elevationM: number`, `elevationFt: number`, `structure: StructureType`
    - `outOfNyc: boolean`, `manualAnchorActive: boolean`
    - `sensorStatus: { gps: 'locked' | 'stale' | 'lost' | 'denied' | 'simulated'; dr: 'active' | 'standby' | 'unavailable' | 'simulated'; timing: 'active' | 'degraded' }`
  - `WorldStateSnapshot`:
    - `timestampMs: number`, `mode: 'live' | 'sim' | 'replay'`, `scenarioId?: DemoScenarioId`
    - `ego: EstimatorState`
    - `egoConsist: Array<{ carIndex: number; enu: [number, number, number]; headingRad: number; pitchRad: number; lengthM: number; widthM: number }>`
    - `nearbyTrains: Array<{ id: string; system: RailSystem; routeId: string; color: string; distanceM: number; enu: [number, number, number]; headingRad: number; pitchRad: number; carCount: number; carLengthM: number; carWidthM: number; cars: Array<{ enu: [number, number, number]; headingRad: number; pitchRad: number }> }>`
    - `nearbyLandmarks: Array<{ id: string; name: string; kind: 'river' | 'bridge'; distanceM: number; relativeElevationFt: number }>`

### 3. Renderer (`M3` ↔ `M4`)
- `SceneManager`:
  - `constructor(canvas: HTMLCanvasElement, dataset: TransitDataset, options?: { onContextLost?: () => void; onContextRestored?: () => void })`
  - `update(snapshot: WorldStateSnapshot, dtSec: number): void`
  - `setViewMode(mode: 'inside' | 'ghost' | 'chase'): void`
  - `setGyroEnabled(enabled: boolean): void`
  - `handleDeviceOrientation(alpha: number, beta: number, gamma: number, screenAngleDeg: number): void`
  - `resetCameraView(): void`
  - `getCameraDebug(): { yaw: number; pitch: number; position: [number, number, number]; viewMode: string; drawCalls: number; frameCount: number }`
  - `dispose(): void`

### 4. Opaque-Box UI & E2E Contract (`M4` ↔ `E2E Testing Track` & `M5`)
- **Required `data-testid` attributes**:
  - `scene-canvas`, `hud-train-identity`, `hud-confidence` (`data-confidence`), `hud-current-station`, `hud-next-station`, `hud-speed`, `hud-elevation`
  - `sensor-status-gps` (`data-status="locked|stale|lost|denied|simulated"`), `sensor-status-dr` (`data-status="active|standby|unavailable|simulated"`), `sensor-status-timing` (`data-status="active|degraded"`)
  - `offline-status-badge` (`data-online="true|false"`, `data-sw="ready|pending|unsupported"`)
  - `nearby-trains-list` (items with `data-system="MTA|LIRR|MNR|PATH|NJT|AIRTRAIN"`)
  - `nearby-landmarks-list` (items with `data-landmark="east-river|hudson-river|harlem-river"`)
  - `btn-calibrate`, `calibrate-station-select`, `calibrate-line-select`, `btn-calibrate-apply`
  - `btn-demo-mode`, `demo-scenario-select`, `btn-gyro-toggle`, `btn-reset-view`, `btn-view-mode`
- **Read-Only Diagnostic Snapshot**: `window.__SUBWAY_VISION_STATE__` exposing `{ camera: { yaw, pitch, position, viewMode }, estimate: { line, serviceType, direction, confidence, stationId, nextStationId, elevationFt, speedMph, outOfNyc }, sensorStatus, visibleLandmarks: string[], visibleSystems: string[], nearbyTrainCount: number, drawCalls: number, frameCount: number, mode: string }`.
- **Headless Chromium E2E Config**: Executable `/usr/lib/chromium/chromium` with launch args `['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader']`.
- **Canonical Commands**:
  - Build: `npm run build`
  - Typecheck: `npm run typecheck`
  - Unit tests: `npm test` (Vitest)
  - Preview server: `npm run preview -- --port 4173 --strictPort`
  - E2E tests: `npm run test:e2e` (Playwright)
