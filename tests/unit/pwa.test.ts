import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../../src/pwa/registerSw';
import {
  clearCalibration,
  DEFAULT_SETTINGS,
  listTripRecords,
  loadLatestCalibration,
  loadSettings,
  resetStorageForTests,
  saveCalibration,
  saveSettings,
  saveTripRecord,
} from '../../src/pwa/storage';
import { createWakeLockController } from '../../src/pwa/wakeLock';

function createMemoryLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

function createMockIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();

  const makeRequest = <T>(executor: () => T): IDBRequest<T> => {
    const req = {
      result: undefined as unknown as T,
      error: null as DOMException | null,
      onsuccess: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
    };
    queueMicrotask(() => {
      try {
        req.result = executor();
        req.onsuccess?.({} as Event);
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.({} as Event);
      }
    });
    return req as unknown as IDBRequest<T>;
  };

  return {
    open() {
      const db = {
        objectStoreNames: {
          contains(name: string) {
            return stores.has(name);
          },
        },
        createObjectStore(name: string) {
          if (!stores.has(name)) {
            stores.set(name, new Map());
          }
          return {};
        },
        transaction(storeName: string) {
          const storeMap = stores.get(storeName) ?? new Map<string, unknown>();
          stores.set(storeName, storeMap);
          return {
            onerror: null,
            onabort: null,
            objectStore() {
              return {
                put(value: { id: string }) {
                  return makeRequest(() => {
                    storeMap.set(value.id, value);
                    return value.id;
                  });
                },
                getAll() {
                  return makeRequest(() => Array.from(storeMap.values()));
                },
                clear() {
                  return makeRequest(() => {
                    storeMap.clear();
                    return undefined;
                  });
                },
              };
            },
          };
        },
        close() {},
      };

      const openReq = {
        result: db,
        onupgradeneeded: null as ((ev: Event) => void) | null,
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null,
      };
      queueMicrotask(() => {
        openReq.onupgradeneeded?.({} as Event);
        openReq.onsuccess?.({} as Event);
      });
      return openReq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetStorageForTests();
});

describe('PWA: registerServiceWorker', () => {
  it('reports unsupported when navigator.serviceWorker is unavailable', () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const sw = registerServiceWorker();
    expect(sw.getStatus()).toEqual({ online: true, swState: 'unsupported' });
    sw.dispose();
  });

  it('registers /sw.js, transitions pending -> ready, and tracks online/offline events', async () => {
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((res) => {
      resolveReady = res;
    });
    const registerMock = vi.fn().mockResolvedValue({ active: null });
    const listeners = new Map<string, Set<() => void>>();

    vi.stubGlobal('navigator', {
      onLine: true,
      serviceWorker: {
        register: registerMock,
        ready: readyPromise,
      },
    });
    vi.stubGlobal('window', {
      addEventListener: (type: string, cb: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners.get(type)?.delete(cb);
      },
    });

    const seen: Array<{ online: boolean; swState: string }> = [];
    const sw = registerServiceWorker();
    const unsub = sw.subscribe((s) => seen.push(s));

    expect(sw.getStatus()).toEqual({ online: true, swState: 'pending' });
    expect(seen).toEqual([{ online: true, swState: 'pending' }]);

    // Trigger offline event
    for (const cb of listeners.get('offline') ?? []) cb();
    expect(sw.getStatus()).toEqual({ online: false, swState: 'pending' });

    // Resolve SW ready
    resolveReady();
    await vi.waitFor(() => {
      expect(sw.getStatus().swState).toBe('ready');
    });
    expect(registerMock).toHaveBeenCalledWith('/sw.js', { scope: '/' });

    // Trigger online event
    for (const cb of listeners.get('online') ?? []) cb();
    expect(sw.getStatus()).toEqual({ online: true, swState: 'ready' });

    unsub();
    sw.dispose();
    expect(listeners.get('online')?.size ?? 0).toBe(0);
    expect(listeners.get('offline')?.size ?? 0).toBe(0);
  });

  it('ignores late SW resolution after dispose and handles registration rejection', async () => {
    let rejectReg!: (err: Error) => void;
    const registerMock = vi.fn(
      () =>
        new Promise((_res, rej) => {
          rejectReg = rej;
        }),
    );

    vi.stubGlobal('navigator', {
      onLine: true,
      serviceWorker: {
        register: registerMock,
        ready: Promise.resolve(),
      },
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const sw = registerServiceWorker();
    const spy = vi.fn();
    sw.subscribe(spy);
    expect(spy).toHaveBeenCalledTimes(1);

    sw.dispose();
    rejectReg(new Error('offline registration error'));
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('recovers loopback online status on SW register() success while respecting explicit offline events', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const registerMock = vi.fn().mockResolvedValue({ active: { state: 'activated' } });

    vi.stubGlobal('navigator', {
      onLine: false,
      serviceWorker: {
        register: registerMock,
        ready: Promise.resolve(),
      },
    });
    vi.stubGlobal('window', {
      location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:4173' },
      addEventListener: (type: string, cb: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners.get(type)?.delete(cb);
      },
    });

    const sw = registerServiceWorker();
    await vi.waitFor(() => {
      expect(sw.getStatus()).toEqual({ online: true, swState: 'ready' });
    });

    // Explicit offline event must immediately flip online to false
    for (const cb of listeners.get('offline') ?? []) cb();
    expect(sw.getStatus()).toEqual({ online: false, swState: 'ready' });

    sw.dispose();
  });

  it('stays swState=ready and online=false on offline reload when controller exists and register() rejects', async () => {
    const registerMock = vi.fn().mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));

    vi.stubGlobal('navigator', {
      onLine: false,
      serviceWorker: {
        controller: { state: 'activated' },
        register: registerMock,
        ready: Promise.resolve(),
      },
    });
    vi.stubGlobal('window', {
      location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:4173' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const sw = registerServiceWorker();
    expect(sw.getStatus()).toEqual({ online: false, swState: 'ready' });

    await Promise.resolve();
    await Promise.resolve();
    expect(sw.getStatus()).toEqual({ online: false, swState: 'ready' });
    sw.dispose();
  });

  it('keeps online=false, swState=ready, and skips register() on offline SW-controlled loopback reload', async () => {
    const listeners = new Map<string, Set<() => void>>();
    const registerMock = vi.fn().mockResolvedValue({ active: { state: 'activated' } });

    vi.stubGlobal('navigator', {
      onLine: false,
      serviceWorker: {
        controller: { state: 'activated' },
        register: registerMock,
        ready: Promise.resolve(),
      },
    });
    vi.stubGlobal('window', {
      location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:4173' },
      addEventListener: (type: string, cb: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners.get(type)?.delete(cb);
      },
    });

    const sw = registerServiceWorker();
    expect(sw.getStatus()).toEqual({ online: false, swState: 'ready' });
    expect(registerMock).not.toHaveBeenCalled();

    await Promise.resolve();
    await Promise.resolve();
    expect(sw.getStatus()).toEqual({ online: false, swState: 'ready' });
    expect(registerMock).not.toHaveBeenCalled();

    // Returning online via browser connectivity event still transitions online -> true
    for (const cb of listeners.get('online') ?? []) cb();
    expect(sw.getStatus()).toEqual({ online: true, swState: 'ready' });

    sw.dispose();
  });

  it('tracks live offline/online transitions via navigator.connection change events (normal and loopback-only)', () => {
    // Case 1: Normal browser where navigator.connection reports downlink=0 & rtt=0 offline
    const connListeners = new Set<() => void>();
    const connObj = {
      downlink: 10,
      rtt: 50,
      type: 'wifi',
      addEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === 'change') connListeners.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === 'change') connListeners.delete(cb);
      }),
    };
    vi.stubGlobal('window', {
      location: { hostname: 'example.com' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      onLine: true,
      connection: connObj,
    });

    const sw1 = registerServiceWorker();
    expect(sw1.getStatus().online).toBe(true);

    connObj.downlink = 0;
    connObj.rtt = 0;
    for (const cb of connListeners) cb();
    expect(sw1.getStatus().online).toBe(false);

    connObj.downlink = 10;
    connObj.rtt = 50;
    for (const cb of connListeners) cb();
    expect(sw1.getStatus().online).toBe(true);

    sw1.dispose();
    expect(connObj.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    // Case 2: Loopback-only Linux container where navigator.onLine starts false and stays false
    const lbConnListeners = new Set<() => void>();
    const lbConn = {
      downlink: 10,
      rtt: 0,
      addEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === 'change') lbConnListeners.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: () => void) => {
        if (type === 'change') lbConnListeners.delete(cb);
      }),
    };
    vi.stubGlobal('window', {
      location: { hostname: '127.0.0.1' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('performance', {
      getEntriesByType: vi.fn(() => [{ transferSize: 1200 }]),
    });
    vi.stubGlobal('navigator', {
      onLine: false,
      connection: lbConn,
    });

    const sw2 = registerServiceWorker();
    expect(sw2.getStatus().online).toBe(true);

    // Live setOffline(true) fires connection 'change' while navigator.onLine stays false
    for (const cb of lbConnListeners) cb();
    expect(sw2.getStatus().online).toBe(false);

    // Live setOffline(false) fires connection 'change' again -> restores online
    for (const cb of lbConnListeners) cb();
    expect(sw2.getStatus().online).toBe(true);

    sw2.dispose();
  });
});

describe('PWA: storage (localStorage + IndexedDB + fallbacks)', () => {
  it('persists and validates settings in localStorage and rejects invalid values', () => {
    const ls = createMemoryLocalStorage();
    vi.stubGlobal('localStorage', ls);
    resetStorageForTests();

    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

    const saved = saveSettings({
      viewMode: 'ghost',
      gyroEnabled: true,
      demoMode: true,
      demoScenarioId: 'steinway-queens',
      demoSpeedMultiplier: 5,
    });
    expect(saved).toEqual({
      viewMode: 'ghost',
      gyroEnabled: true,
      demoMode: true,
      demoScenarioId: 'steinway-queens',
      demoSpeedMultiplier: 5,
    });
    expect(loadSettings()).toEqual(saved);

    // Corrupt localStorage payload falls back to valid defaults per field
    ls.setItem(
      'subwaysight:settings:v1',
      JSON.stringify({
        viewMode: 'invalid-mode',
        gyroEnabled: 'yes',
        demoMode: true,
        demoScenarioId: 'unknown-scenario',
        demoSpeedMultiplier: 99,
      }),
    );
    expect(loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      demoMode: true,
    });
  });

  it('persists calibrations and trip records in IndexedDB', async () => {
    vi.stubGlobal('localStorage', createMemoryLocalStorage());
    vi.stubGlobal('indexedDB', createMockIndexedDb());
    resetStorageForTests();

    await saveCalibration({
      id: 'cal-1',
      stationId: 'mta-times-sq-42',
      routeId: 'A',
      savedAtMs: 1000,
    });
    await saveCalibration({
      id: 'cal-2',
      stationId: 'mta-grand-central-42',
      routeId: '4',
      savedAtMs: 2000,
    });

    const latest = await loadLatestCalibration();
    expect(latest?.stationId).toBe('mta-grand-central-42');
    expect(latest?.routeId).toBe('4');

    await clearCalibration();
    expect(await loadLatestCalibration()).toBeNull();

    await saveTripRecord({
      id: 'trip-1',
      startedAtMs: 100,
      updatedAtMs: 500,
      routeId: 'D',
      startStationId: 'mta-dekalb-ave',
      lastStationId: 'mta-grand-st',
      mode: 'sim',
    });
    const trips = await listTripRecords();
    expect(trips).toHaveLength(1);
    expect(trips[0].routeId).toBe('D');
  });

  it('falls back transparently to memory when IndexedDB is unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('indexedDB', undefined);
    resetStorageForTests();

    await saveCalibration({
      stationId: 'mta-14-st-union-sq',
      routeId: '4',
      savedAtMs: 5000,
    });
    const latest = await loadLatestCalibration();
    expect(latest?.stationId).toBe('mta-14-st-union-sq');

    await clearCalibration();
    expect(await loadLatestCalibration()).toBeNull();
  });
});

describe('PWA: wakeLock', () => {
  it('gracefully no-ops when navigator.wakeLock is unsupported', async () => {
    vi.stubGlobal('navigator', {});
    const wl = createWakeLockController();
    expect(await wl.request()).toBe(false);
    expect(wl.isActive()).toBe(false);
    await wl.release();
    wl.dispose();
  });

  it('acquires wake lock, re-acquires on visibilitychange, and handles release race', async () => {
    const releaseSpy = vi.fn().mockResolvedValue(undefined);
    const sentinelListeners = new Map<string, Set<() => void>>();
    const makeSentinel = () => ({
      released: false,
      release: releaseSpy,
      addEventListener: (type: string, cb: () => void) => {
        if (!sentinelListeners.has(type)) sentinelListeners.set(type, new Set());
        sentinelListeners.get(type)?.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        sentinelListeners.get(type)?.delete(cb);
      },
    });

    const requestSpy = vi.fn().mockImplementation(async () => makeSentinel());
    const docListeners = new Map<string, Set<() => void>>();
    const mockDoc = {
      visibilityState: 'visible',
      addEventListener: (type: string, cb: () => void) => {
        if (!docListeners.has(type)) docListeners.set(type, new Set());
        docListeners.get(type)?.add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        docListeners.get(type)?.delete(cb);
      },
    };

    vi.stubGlobal('navigator', { wakeLock: { request: requestSpy } });
    vi.stubGlobal('document', mockDoc);

    const wl = createWakeLockController();
    expect(await wl.request()).toBe(true);
    expect(wl.isActive()).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // Simulate OS releasing wake lock when tab backgrounded, then returning visible
    for (const cb of sentinelListeners.get('release') ?? []) cb();
    expect(wl.isActive()).toBe(false);

    for (const cb of docListeners.get('visibilitychange') ?? []) cb();
    await vi.waitFor(() => {
      expect(requestSpy).toHaveBeenCalledTimes(2);
    });
    expect(wl.isActive()).toBe(true);

    // Race test: dispose while an in-flight request resolves
    let resolveInFlight!: (s: ReturnType<typeof makeSentinel>) => void;
    requestSpy.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveInFlight = res;
        }),
    );
    await wl.release();
    const pendingReq = wl.request();
    wl.dispose();
    const lateSentinel = makeSentinel();
    resolveInFlight(lateSentinel);
    expect(await pendingReq).toBe(false);
    expect(releaseSpy).toHaveBeenCalled();
  });
});

describe('PWA: static offline audit', () => {
  const rootDir = path.resolve(__dirname, '../..');

  it('index.html has viewport-fit=cover, local manifest/icons, dark background, and zero external URLs', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('/manifest.webmanifest');
    expect(html).toContain('/icons/icon.svg');
    expect(html).toContain('#0b1120');
    expect(html).not.toMatch(/https?:\/\//i);
  });

  it('manifest.webmanifest is valid standalone PWA manifest with zero external URLs', () => {
    const raw = fs.readFileSync(
      path.join(rootDir, 'public/manifest.webmanifest'),
      'utf8',
    );
    expect(raw).not.toMatch(/https?:\/\//i);
    const parsed = JSON.parse(raw) as {
      display: string;
      icons: Array<{ src: string }>;
    };
    expect(parsed.display).toBe('standalone');
    expect(parsed.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of parsed.icons) {
      expect(icon.src.startsWith('/icons/')).toBe(true);
    }
  });

  it('styles.css uses zero external URLs or CDN web fonts', () => {
    const css = fs.readFileSync(
      path.join(rootDir, 'src/ui/styles.css'),
      'utf8',
    );
    expect(css).not.toMatch(/https?:\/\//i);
    expect(css).not.toMatch(/@import\s+url/i);
    expect(css).toContain('env(safe-area-inset-top)');
    expect(css).toContain('100dvw');
    expect(css).toContain('100dvh');
    expect(css).toContain('min-width: 44px');
    expect(css).toContain('min-height: 44px');
  });
});
