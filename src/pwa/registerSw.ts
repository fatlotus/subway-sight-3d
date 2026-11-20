export type SwState = 'ready' | 'pending' | 'unsupported';

export interface ConnectivityStatus {
  online: boolean;
  swState: SwState;
}

export interface RegisterSwOptions {
  swUrl?: string;
  scope?: string;
}

export interface SwController {
  getStatus(): ConnectivityStatus;
  subscribe(listener: (status: ConnectivityStatus) => void): () => void;
  dispose(): void;
}

function readOnlineState(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

function isLoopbackHost(): boolean {
  if (typeof window === 'undefined' || !window.location?.hostname) {
    return false;
  }
  const host = window.location.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

interface NetworkInformationLike {
  readonly downlink?: number;
  readonly rtt?: number;
  readonly type?: string;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

function getNetworkConnection(): NetworkInformationLike | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { connection?: NetworkInformationLike };
  return nav.connection ?? null;
}

function isConnectionReportingOffline(conn: NetworkInformationLike | null): boolean {
  if (!conn) return false;
  if (conn.type === 'none') return true;
  if (
    typeof conn.downlink === 'number' &&
    conn.downlink === 0 &&
    typeof conn.rtt === 'number' &&
    conn.rtt === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Registers the Workbox service worker and tracks online/offline + SW readiness state.
 * Safe in browsers without Service Worker support and in Node test environments.
 */
export function registerServiceWorker(
  options?: RegisterSwOptions,
): SwController {
  const baseUrl =
    (typeof import.meta !== 'undefined' &&
      (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL) ||
    '/';
  const swUrl = options?.swUrl ?? `${baseUrl}sw.js`;
  const scope = options?.scope ?? baseUrl;

  const swContainer =
    typeof navigator !== 'undefined' &&
    navigator.serviceWorker &&
    typeof navigator.serviceWorker.register === 'function'
      ? navigator.serviceWorker
      : null;

  const navLoadedOverHttp = (): boolean => {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
      return false;
    }
    try {
      const entries = performance.getEntriesByType('navigation') as Array<{
        transferSize?: number;
      }>;
      return entries.length > 0 && typeof entries[0].transferSize === 'number' && entries[0].transferSize > 0;
    } catch {
      return false;
    }
  };

  let disposed = false;
  let sawExplicitConnectivityEvent = false;
  let sawWindowConnectivityEvent = false;
  const initiallyControlled = Boolean(swContainer && swContainer.controller);
  const browserInitiallyOnline = readOnlineState();
  // On loopback-only Linux environments without a default route, Chromium can report
  // navigator.onLine === false even when the local origin is reachable over HTTP.
  let loopbackAssumedOnline =
    !browserInitiallyOnline &&
    isLoopbackHost() &&
    !initiallyControlled &&
    navLoadedOverHttp();
  const initialOnline = browserInitiallyOnline || loopbackAssumedOnline;
  let status: ConnectivityStatus = {
    online: initialOnline,
    swState: !swContainer ? 'unsupported' : initiallyControlled ? 'ready' : 'pending',
  };

  const listeners = new Set<(next: ConnectivityStatus) => void>();

  const notify = (): void => {
    if (disposed) return;
    const snapshot: ConnectivityStatus = { ...status };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const updateStatus = (patch: Partial<ConnectivityStatus>): void => {
    if (disposed) return;
    const nextOnline = patch.online ?? status.online;
    const nextSw = patch.swState ?? status.swState;
    if (nextOnline === status.online && nextSw === status.swState) {
      return;
    }
    status = { online: nextOnline, swState: nextSw };
    notify();
  };

  const handleOnline = (): void => {
    sawExplicitConnectivityEvent = true;
    sawWindowConnectivityEvent = true;
    updateStatus({ online: true });
  };

  const handleOffline = (): void => {
    sawExplicitConnectivityEvent = true;
    sawWindowConnectivityEvent = true;
    updateStatus({ online: false });
  };

  const conn = getNetworkConnection();
  const handleConnectionChange = (): void => {
    const browserOnline = readOnlineState();
    const connOffline = isConnectionReportingOffline(conn);
    if (browserOnline && !connOffline) {
      sawExplicitConnectivityEvent = true;
      updateStatus({ online: true });
      return;
    }
    // In loopback-only environments without a default route, navigator.onLine stays
    // false across live offline/online toggles so window 'offline'/'online' never fire,
    // while NetworkInformation still dispatches a 'change' event on each transition.
    if (
      !browserOnline &&
      !connOffline &&
      isLoopbackHost() &&
      loopbackAssumedOnline &&
      !sawWindowConnectivityEvent
    ) {
      sawExplicitConnectivityEvent = true;
      updateStatus({ online: !status.online });
      return;
    }
    sawExplicitConnectivityEvent = true;
    updateStatus({ online: false });
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  }
  if (conn && typeof conn.addEventListener === 'function') {
    conn.addEventListener('change', handleConnectionChange);
  }

  if (swContainer) {
    if (swContainer.ready && typeof swContainer.ready.then === 'function') {
      try {
        swContainer.ready
          .then(() => {
            if (!disposed) {
              updateStatus({ swState: 'ready' });
            }
          })
          .catch(() => {
            // Ignore rejection.
          });
      } catch {
        // Ignore synchronous throw.
      }
    }

    const skipOfflineControlledRegister = initiallyControlled && !readOnlineState();
    if (!skipOfflineControlledRegister) {
      try {
        Promise.resolve(swContainer.register(swUrl, { scope }))
          .then((registration) => {
            if (disposed) return;
            const patch: Partial<ConnectivityStatus> = {};
            if (registration && registration.active) {
              patch.swState = 'ready';
            }
            // Successful SW script fetch over loopback proves origin reachability when
            // navigator.onLine defaulted to false in a loopback-only environment.
            if (
              !sawExplicitConnectivityEvent &&
              !status.online &&
              !initiallyControlled &&
              isLoopbackHost()
            ) {
              loopbackAssumedOnline = true;
              patch.online = true;
            }
            if (patch.swState !== undefined || patch.online !== undefined) {
              updateStatus(patch);
            }
          })
          .catch(() => {
            // Keep current swState/online if registration fails offline or in dev mode.
          });
      } catch {
        // Ignore synchronous throw from mocked/restricted SW containers.
      }
    }
  }

  return {
    getStatus(): ConnectivityStatus {
      return { ...status };
    },
    subscribe(listener: (next: ConnectivityStatus) => void): () => void {
      if (disposed) {
        return () => {};
      }
      listeners.add(listener);
      listener({ ...status });
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (
        typeof window !== 'undefined' &&
        typeof window.removeEventListener === 'function'
      ) {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
      if (conn && typeof conn.removeEventListener === 'function') {
        conn.removeEventListener('change', handleConnectionChange);
      }
    },
  };
}
