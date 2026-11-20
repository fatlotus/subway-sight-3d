import type { DemoScenarioId } from '../types/sensors';
import type { TravelDirection, ViewMode } from '../types/state';

export interface AppSettings {
  viewMode: ViewMode;
  gyroEnabled: boolean;
  demoMode: boolean;
  demoScenarioId: DemoScenarioId;
  demoSpeedMultiplier: 1 | 2 | 5;
}

export interface CalibrationRecord {
  id: string;
  stationId?: string;
  routeId?: string;
  direction?: TravelDirection;
  savedAtMs: number;
}

export interface TripRecord {
  id: string;
  startedAtMs: number;
  updatedAtMs: number;
  routeId: string | null;
  startStationId: string | null;
  lastStationId: string | null;
  mode: 'live' | 'sim';
}

const SETTINGS_KEY = 'subwaysight:settings:v1';
const CALIBRATION_MIRROR_KEY = 'subwaysight:calibration:v1';
const DB_NAME = 'subwaysight-db';
const DB_VERSION = 1;
const STORE_CALIBRATIONS = 'calibrations';
const STORE_TRIPS = 'trips';

const VALID_VIEW_MODES = new Set<ViewMode>(['inside', 'ghost', 'chase']);
const VALID_SCENARIOS = new Set<DemoScenarioId>([
  'manhattan-bridge',
  'express-overtake',
  'lexington-underground',
  'steinway-queens',
  'midtown-multi-system',
]);
const VALID_SPEEDS = new Set<1 | 2 | 5>([1, 2, 5]);
const VALID_DIRECTIONS = new Set<TravelDirection>([
  'UPTOWN',
  'DOWNTOWN',
  'OUTBOUND',
  'INBOUND',
  'UNKNOWN',
]);

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  viewMode: 'inside',
  gyroEnabled: false,
  demoMode: false,
  demoScenarioId: 'manhattan-bridge',
  demoSpeedMultiplier: 1,
});

// Transparent in-memory fallbacks when localStorage or IndexedDB is unavailable/blocked.
let memorySettings: AppSettings = { ...DEFAULT_SETTINGS };
let memorySettingsDirty = false;
let memoryCalibrations: CalibrationRecord[] = [];
let memoryTrips: TripRecord[] = [];

function getLocalStorageSafe(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      const ls = globalThis.localStorage;
      if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
        return ls;
      }
    }
  } catch {
    // Private browsing or security error
  }
  return null;
}

function sanitizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  const viewMode =
    typeof obj.viewMode === 'string' && VALID_VIEW_MODES.has(obj.viewMode as ViewMode)
      ? (obj.viewMode as ViewMode)
      : DEFAULT_SETTINGS.viewMode;
  const gyroEnabled =
    typeof obj.gyroEnabled === 'boolean'
      ? obj.gyroEnabled
      : DEFAULT_SETTINGS.gyroEnabled;
  const demoMode =
    typeof obj.demoMode === 'boolean' ? obj.demoMode : DEFAULT_SETTINGS.demoMode;
  const demoScenarioId =
    typeof obj.demoScenarioId === 'string' &&
    VALID_SCENARIOS.has(obj.demoScenarioId as DemoScenarioId)
      ? (obj.demoScenarioId as DemoScenarioId)
      : DEFAULT_SETTINGS.demoScenarioId;
  const demoSpeedMultiplier =
    typeof obj.demoSpeedMultiplier === 'number' &&
    VALID_SPEEDS.has(obj.demoSpeedMultiplier as 1 | 2 | 5)
      ? (obj.demoSpeedMultiplier as 1 | 2 | 5)
      : DEFAULT_SETTINGS.demoSpeedMultiplier;

  return {
    viewMode,
    gyroEnabled,
    demoMode,
    demoScenarioId,
    demoSpeedMultiplier,
  };
}

function sanitizeCalibration(raw: unknown): CalibrationRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.savedAtMs !== 'number' || !Number.isFinite(obj.savedAtMs)) {
    return null;
  }
  const stationId =
    typeof obj.stationId === 'string' && obj.stationId.length > 0
      ? obj.stationId
      : undefined;
  const routeId =
    typeof obj.routeId === 'string' && obj.routeId.length > 0
      ? obj.routeId
      : undefined;
  const direction =
    typeof obj.direction === 'string' &&
    VALID_DIRECTIONS.has(obj.direction as TravelDirection)
      ? (obj.direction as TravelDirection)
      : undefined;
  if (!stationId && !routeId) return null;

  return {
    id: typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : `cal-${obj.savedAtMs}`,
    stationId,
    routeId,
    direction,
    savedAtMs: obj.savedAtMs,
  };
}

export function loadSettings(): AppSettings {
  if (memorySettingsDirty) {
    return { ...memorySettings };
  }
  const ls = getLocalStorageSafe();
  if (!ls) {
    return { ...memorySettings };
  }
  try {
    const raw = ls.getItem(SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed: unknown = JSON.parse(raw);
    const validated = sanitizeSettings(parsed);
    memorySettings = { ...validated };
    return validated;
  } catch {
    return { ...memorySettings };
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  memorySettings = { ...next };

  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.setItem(SETTINGS_KEY, JSON.stringify(next));
      memorySettingsDirty = false;
    } catch {
      // Ignore quota/security errors; in-memory copy remains authoritative.
      memorySettingsDirty = true;
    }
  }
  return next;
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const idb =
        typeof globalThis !== 'undefined'
          ? (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB
          : undefined;
      if (!idb || typeof idb.open !== 'function') {
        resolve(null);
        return;
      }

      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CALIBRATIONS)) {
          db.createObjectStore(STORE_CALIBRATIONS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_TRIPS)) {
          db.createObjectStore(STORE_TRIPS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        resolve(null);
      };
      req.onblocked = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

function runIdbTransaction<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = op(store);
      let settled = false;
      const finish = (val: T | null): void => {
        if (settled) return;
        settled = true;
        try {
          db.close();
        } catch {
          // ignore
        }
        resolve(val);
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      tx.onerror = () => finish(null);
      tx.onabort = () => finish(null);
    } catch {
      try {
        db.close();
      } catch {
        // ignore
      }
      resolve(null);
    }
  });
}

function saveCalibrationMirror(record: CalibrationRecord | null): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    if (record === null) {
      ls.removeItem(CALIBRATION_MIRROR_KEY);
    } else {
      ls.setItem(CALIBRATION_MIRROR_KEY, JSON.stringify(record));
    }
  } catch {
    // ignore
  }
}

function loadCalibrationMirror(): CalibrationRecord | null {
  const ls = getLocalStorageSafe();
  if (!ls) return null;
  try {
    const raw = ls.getItem(CALIBRATION_MIRROR_KEY);
    if (!raw) return null;
    return sanitizeCalibration(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveCalibration(
  record: Omit<CalibrationRecord, 'id' | 'savedAtMs'> & {
    id?: string;
    savedAtMs?: number;
  },
): Promise<CalibrationRecord> {
  const savedAtMs =
    typeof record.savedAtMs === 'number' && Number.isFinite(record.savedAtMs)
      ? record.savedAtMs
      : Date.now();
  const full: CalibrationRecord = {
    id: record.id ?? `cal-${savedAtMs}`,
    stationId: record.stationId,
    routeId: record.routeId,
    direction: record.direction,
    savedAtMs,
  };

  const sanitized = sanitizeCalibration(full);
  if (!sanitized) {
    return full;
  }

  memoryCalibrations = [
    ...memoryCalibrations.filter((item) => item.id !== sanitized.id),
    sanitized,
  ];
  saveCalibrationMirror(sanitized);

  const db = await openDatabase();
  if (db) {
    await runIdbTransaction(db, STORE_CALIBRATIONS, 'readwrite', (store) =>
      store.put(sanitized),
    );
  }

  return sanitized;
}

export async function loadLatestCalibration(): Promise<CalibrationRecord | null> {
  const candidates: CalibrationRecord[] = [];

  const db = await openDatabase();
  if (db) {
    const rows = await runIdbTransaction<CalibrationRecord[]>(
      db,
      STORE_CALIBRATIONS,
      'readonly',
      (store) => store.getAll(),
    );
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const clean = sanitizeCalibration(r);
        if (clean) candidates.push(clean);
      }
    }
  }

  for (const r of memoryCalibrations) {
    const clean = sanitizeCalibration(r);
    if (clean) candidates.push(clean);
  }

  const mirror = loadCalibrationMirror();
  if (mirror) {
    candidates.push(mirror);
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.savedAtMs - a.savedAtMs);
  return candidates[0];
}

export async function clearCalibration(): Promise<void> {
  memoryCalibrations = [];
  saveCalibrationMirror(null);

  const db = await openDatabase();
  if (db) {
    await runIdbTransaction(db, STORE_CALIBRATIONS, 'readwrite', (store) =>
      store.clear(),
    );
  }
}

export async function saveTripRecord(record: TripRecord): Promise<TripRecord> {
  const normalized: TripRecord = { ...record };
  memoryTrips = [
    ...memoryTrips.filter((t) => t.id !== normalized.id),
    normalized,
  ];

  const db = await openDatabase();
  if (db) {
    await runIdbTransaction(db, STORE_TRIPS, 'readwrite', (store) =>
      store.put(normalized),
    );
  }

  return normalized;
}

export async function listTripRecords(): Promise<TripRecord[]> {
  const db = await openDatabase();
  if (db) {
    const rows = await runIdbTransaction<TripRecord[]>(
      db,
      STORE_TRIPS,
      'readonly',
      (store) => store.getAll(),
    );
    if (Array.isArray(rows)) {
      return [...rows].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    }
  }

  return [...memoryTrips].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

/** Reset in-memory caches and localStorage keys (intended for unit tests). */
export function resetStorageForTests(): void {
  memorySettings = { ...DEFAULT_SETTINGS };
  memorySettingsDirty = false;
  memoryCalibrations = [];
  memoryTrips = [];
  const ls = getLocalStorageSafe();
  if (ls) {
    try {
      ls.removeItem(SETTINGS_KEY);
      ls.removeItem(CALIBRATION_MIRROR_KEY);
    } catch {
      // ignore
    }
  }
}
