# TEST_READY.md — SubwaySight 3D Opaque-Box E2E Suite

**Status**: **READY** (Verified by 2 Reviewers, 2 Challengers, and 1 Forensic Auditor — all PASS/APPROVE/CLEAN).  
**Infrastructure Spec**: `/home/antigravity/TEST_INFRA.md`  
**Playwright Config**: `/home/antigravity/playwright.config.ts` (uses `/usr/lib/chromium/chromium` with `chromiumSandbox: false` and SwiftShader WebGL flags, `serviceWorkers: 'allow'`, mobile portrait `390×844` default, preview server on `http://127.0.0.1:4173`).

---

## Runner Commands

### Build & Run Full 4-Tier E2E Suite
```bash
npm run build && npm run test:e2e
```
*(Or directly via Playwright CLI: `npx playwright test` — `playwright.config.ts` automatically starts `npm run preview -- --port 4173 --strictPort --host 127.0.0.1` with `reuseExistingServer: true`.)*

### Per-Tier Runner Commands
- **Tier 1 (Feature Coverage — 14 tests)**:
  ```bash
  npx playwright test tests/e2e/tier1-features.spec.ts
  ```
- **Tier 2 (Boundary & Corner Cases — 10 tests)**:
  ```bash
  npx playwright test tests/e2e/tier2-boundaries.spec.ts
  ```
- **Tier 3 (Cross-Feature Combinations — 5 tests)**:
  ```bash
  npx playwright test tests/e2e/tier3-combinations.spec.ts
  ```
- **Tier 4 (Real-World NYC Rider Journeys — 5 tests)**:
  ```bash
  npx playwright test tests/e2e/tier4-scenarios.spec.ts
  ```
- **Test Discovery Check**:
  ```bash
  npx playwright test --list
  ```

---

## Coverage Summary

| Tier | File | Tests | Focus |
|---|---|---:|---|
| **Tier 1** | `tests/e2e/tier1-features.spec.ts` | 14 | Isolated happy-path coverage of every user-facing feature in `PROJECT.md § Feature Inventory` (`T1.1`–`T1.14`) |
| **Tier 2** | `tests/e2e/tier2-boundaries.spec.ts` | 10 | GPS denied/timeout/coarse/out-of-NYC, express vs local, late-night/weekend clocks, portrait↔landscape rotation, HUD touch isolation, zero CDN, cold-start offline reload (`T2.1`–`T2.10`) |
| **Tier 3** | `tests/e2e/tier3-combinations.spec.ts` | 5 | Multi-feature compositions: GPS→tunnel DR + East River, offline calibration + demo/live switching, gyro + touch drag + view modes + reset, express overtake + regional rail + atomic HUD/state consistency, late-night + offline + landscape + calibration (`C1`–`C5`) |
| **Tier 4** | `tests/e2e/tier4-scenarios.spec.ts` | 5 | Full end-to-end NYC rider journeys: Manhattan Bridge crossing, 8th Ave Express rush hour past Penn Station, Lexington Ave underground past Grand Central, airplane-mode cold-start commute from SW cache, out-of-NYC recovery via Demo Mode & Manual Calibration (`S1`–`S5`) |
| **Total** | **4 spec files (+ `helpers.ts`)** | **34** | **100% opaque-box, 0 `src/` imports, 0 skipped/vacuous tests** |

---

## Feature Checklist (`PROJECT.md § Feature Inventory`)

- [x] **#1 Project Scaffold & Offline Build** — `T1.1`, `T1.14`, `T2.9`, `T2.10`, `C2`, `C5`, `S4`
- [x] **#2 Local ENU Coordinate Projection** — `T1.5`, `T1.9`, `T2.3`, `T2.4`, `C1`, `C4`, `S1–S5`
- [x] **#3 Core NYC MTA 3D Network Dataset** — `T1.1`, `T1.8`, `T1.13`, `T2.5`, `C1`, `C4`, `S1–S3`
- [x] **#4 Historical Train Timing Dataset** — `T1.7`, `T2.5`, `T2.6`, `C4`, `C5`, `S2`, `S3`
- [x] **#5 Basic Geographic Landmarks (`east-river`, `hudson-river`, `harlem-river`)** — `T1.9`, `C1`, `S1`, `S2`
- [x] **#6 Regional Train Systems (`LIRR`, `MNR`, `PATH`, `NJT`)** — `T1.10`, `C4`, `S2`, `S3`
- [x] **#7 Dataset Integrity & Size Budget** — Verified indirectly via runtime load across `T1.1`–`S5` & zero external requests `T2.9`
- [x] **#8 Unified Sensor Abstraction & Sim** — `T1.5`, `T1.6`, `T1.13`, `T2.1–T2.4`, `C1`, `C2`, `S1`, `S3`, `S5`
- [x] **#9 GPS Gating & Tunnel Detection** — `T1.5`, `T2.1–T2.4`, `C1`, `S1`, `S5`
- [x] **#10 Gravity-Aligned IMU Dead Reckoning** — `T1.6`, `T2.2`, `C1`, `S1`, `S3`
- [x] **#11 Multi-Modal Particle Filter Fusion** — `T1.5–T1.7`, `T1.12`, `T2.3–T2.5`, `C1`, `C2`, `C4`, `C5`, `S1–S5`
- [x] **#12 Rough Real-Time Traffic & Landmarks** — `T1.8–T1.10`, `T2.5`, `T2.6`, `C1`, `C4`, `S1–S3`
- [x] **#13 3D First-Person WebGL Scene (`frameCount`, non-blank pixels, `drawCalls <= 50`)** — `T1.1`, `T2.7`, `T2.10`, `C1–C5`, `S1–S5`
- [x] **#14 Camera Rig & View Modes (`inside`/`ghost`/`chase`, drag & reset)** — `T1.2`, `T1.3`, `T2.8`, `C3`, `S2`, `S3`
- [x] **#15 Gyroscope Look-Around** — `T1.4`, `C3`
- [x] **#16 3D Network, Consists & Landmarks Render** — `T1.1`, `T1.8–T1.10`, `T2.7`, `C3`, `C4`, `S1–S5`
- [x] **#17 Mobile-First Telemetry HUD (`data-testid`, `≥44px` tap targets, footprint, portrait↔landscape)** — `T1.11`, `T2.7`, `T2.8`, `C4`, `C5`, `S1–S5`
- [x] **#18 Manual Calibration & Demo Controls** — `T1.12`, `T1.13`, `C2`, `C5`, `S1`, `S4`, `S5`
- [x] **#19 Offline-First PWA & Persistence (SW precache, cold-start offline reload, zero CDN)** — `T1.14`, `T2.9`, `T2.10`, `C2`, `C5`, `S4`
- [x] **#20 Opaque-Box E2E Testability Contract (`data-testid` + `window.__SUBWAY_VISION_STATE__`)** — `T1.1`–`S5` (34/34 tests)
