import type { SensorSample, SensorSource } from '../types/sensors';

export interface ReplayOptions {
  speedMultiplier?: 1 | 2 | 5;
  loop?: boolean;
}

/**
 * Deterministic trace playback SensorSource for unit tests and recorded rides.
 * Supports both synchronous stepping (replayAll / stepNext) and timed playback (start / stop).
 */
export class ReplaySensorSource implements SensorSource {
  readonly mode = 'replay' as const;

  private readonly samples: SensorSample[];
  private readonly loop: boolean;
  private readonly listeners = new Set<(sample: SensorSample) => void>();

  private cursor = 0;
  private running = false;
  private paused = false;
  private speedMultiplier: 1 | 2 | 5;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(samples: readonly SensorSample[], options?: ReplayOptions) {
    this.samples = [...samples].sort((a, b) => a.tMs - b.tMs);
    this.speedMultiplier = options?.speedMultiplier ?? 1;
    this.loop = options?.loop ?? false;
  }

  onSample(cb: (sample: SensorSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.paused) {
      this.scheduleNext(0);
    }
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.clearTimer();
    } else if (this.running && this.timer === null) {
      this.scheduleNext(0);
    }
  }

  setSpeedMultiplier(mult: 1 | 2 | 5): void {
    this.speedMultiplier = mult;
  }

  reset(): void {
    this.cursor = 0;
  }

  getCursor(): number {
    return this.cursor;
  }

  getLength(): number {
    return this.samples.length;
  }

  /** Synchronously emit the next sample and advance cursor; returns null when exhausted. */
  stepNext(): SensorSample | null {
    if (this.cursor >= this.samples.length) {
      if (this.loop && this.samples.length > 0) {
        this.cursor = 0;
      } else {
        return null;
      }
    }
    const sample = this.samples[this.cursor];
    this.cursor += 1;
    this.emit(sample);
    return sample;
  }

  /** Synchronously emit all remaining samples in timestamp order. */
  replayAll(): void {
    while (this.cursor < this.samples.length) {
      const sample = this.samples[this.cursor];
      this.cursor += 1;
      this.emit(sample);
    }
  }

  private emit(sample: SensorSample): void {
    for (const cb of this.listeners) {
      cb(sample);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.clearTimer();
    if (!this.running || this.paused) return;
    if (this.cursor >= this.samples.length) {
      if (this.loop && this.samples.length > 0) {
        this.cursor = 0;
      } else {
        this.running = false;
        return;
      }
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || this.paused) return;

      const current = this.samples[this.cursor];
      this.cursor += 1;
      this.emit(current);

      if (this.cursor < this.samples.length) {
        const next = this.samples[this.cursor];
        const rawDelta = Math.max(0, next.tMs - current.tMs);
        const scaledDelay = Math.max(0, Math.round(rawDelta / this.speedMultiplier));
        this.scheduleNext(scaledDelay);
      } else if (this.loop && this.samples.length > 0) {
        this.cursor = 0;
        this.scheduleNext(0);
      } else {
        this.running = false;
      }
    }, delayMs);
  }
}
