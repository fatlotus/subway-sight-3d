interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
  };
}

export interface WakeLockController {
  request(): Promise<boolean>;
  release(): Promise<void>;
  isActive(): boolean;
  dispose(): void;
}

/**
 * Screen Wake Lock wrapper that gracefully no-ops when unsupported,
 * catches errors, handles in-flight release/dispose races, and re-acquires
 * when the document returns to the foreground.
 */
export function createWakeLockController(): WakeLockController {
  let wanted = false;
  let disposed = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let requestSeq = 0;

  const handleSentinelRelease = (): void => {
    sentinel = null;
  };

  const acquire = async (): Promise<boolean> => {
    if (disposed || !wanted) return false;

    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as unknown as NavigatorWithWakeLock)
        : undefined;
    if (!nav?.wakeLock || typeof nav.wakeLock.request !== 'function') {
      return false;
    }

    if (sentinel && !sentinel.released) {
      return true;
    }

    const seq = ++requestSeq;
    try {
      const nextSentinel = await nav.wakeLock.request('screen');
      if (disposed || !wanted || seq !== requestSeq) {
        // Released or disposed while request was in flight — release immediately.
        try {
          await nextSentinel.release();
        } catch {
          // ignore
        }
        return false;
      }

      sentinel = nextSentinel;
      if (typeof nextSentinel.addEventListener === 'function') {
        nextSentinel.addEventListener('release', handleSentinelRelease);
      }
      return true;
    } catch {
      sentinel = null;
      return false;
    }
  };

  const handleVisibilityChange = (): void => {
    if (disposed || !wanted) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void acquire();
    }
  };

  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  const release = async (): Promise<void> => {
    wanted = false;
    requestSeq++;
    const current = sentinel;
    sentinel = null;
    if (!current) return;
    if (typeof current.removeEventListener === 'function') {
      current.removeEventListener('release', handleSentinelRelease);
    }
    try {
      await current.release();
    } catch {
      // ignore
    }
  };

  return {
    async request(): Promise<boolean> {
      if (disposed) return false;
      wanted = true;
      return acquire();
    },
    release,
    isActive(): boolean {
      return Boolean(sentinel && !sentinel.released);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      wanted = false;
      requestSeq++;
      if (
        typeof document !== 'undefined' &&
        typeof document.removeEventListener === 'function'
      ) {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      const current = sentinel;
      sentinel = null;
      if (current) {
        if (typeof current.removeEventListener === 'function') {
          current.removeEventListener('release', handleSentinelRelease);
        }
        void Promise.resolve()
          .then(() => current.release())
          .catch(() => {});
      }
    },
  };
}
