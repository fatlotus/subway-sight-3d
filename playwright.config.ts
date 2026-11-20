import { defineConfig } from '@playwright/test';

const isCI = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CI
);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: isCI ? 1 : 2,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'allow',
    timezoneId: 'America/New_York',
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      executablePath: '/usr/lib/chromium/chromium',
      chromiumSandbox: false,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader-webgl',
        '--enable-unsafe-swiftshader',
      ],
    },
  },
  projects: [
    {
      name: 'mobile-portrait',
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
