/**
 * Reconnect/backoff driver for SyncHost (SPEC §34), kept DOM-free and
 * dependency-free so it's unit-testable without a browser or fake WebSocket.
 *
 * Behavior:
 *   - `start()` runs `run()` immediately, then on success waits
 *     `intervalMs` before the next round.
 *   - On failure, retries with exponential backoff (`baseBackoffMs` *
 *     2^attempt, capped at `maxBackoffMs`), and reports "offline" instead
 *     of "error" when `navigator.onLine` is known to be false.
 *   - `kick()` (e.g. from a `online`/`visibilitychange` listener) cancels
 *     any pending backoff wait and retries immediately, resetting the
 *     attempt counter.
 *   - `stop()` halts the loop; a subsequent `start()` begins fresh.
 */

export type SyncStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "synced"; at: number }
  | { kind: "offline" }
  | { kind: "error"; message: string };

export interface SchedulerOptions {
  /** Delay between successful sync rounds. Default 15s. */
  intervalMs?: number;
  /** First retry delay after a failure. Default 1s. */
  baseBackoffMs?: number;
  /** Retry delay cap. Default 30s. */
  maxBackoffMs?: number;
  run: () => Promise<void>;
  onStatus?: (status: SyncStatus) => void;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class SyncScheduler {
  private readonly opts: SchedulerOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.cancelTimer();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer();
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  /** Force an immediate retry, resetting the backoff counter. No-op if stopped. */
  kick(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.cancelTimer();
    if (!this.running) void this.tick();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    (this.opts.clearTimeoutFn ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const set = this.opts.setTimeoutFn ?? setTimeout;
    this.timer = set(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.opts.onStatus?.({ kind: "connecting" });
    try {
      await this.opts.run();
      this.running = false;
      this.attempt = 0;
      this.opts.onStatus?.({ kind: "synced", at: (this.opts.now ?? Date.now)() });
      this.schedule(this.opts.intervalMs ?? 15_000);
    } catch (err) {
      this.running = false;
      const base = this.opts.baseBackoffMs ?? 1_000;
      const max = this.opts.maxBackoffMs ?? 30_000;
      const delay = Math.min(max, base * 2 ** this.attempt);
      this.attempt++;
      const knownOffline = typeof navigator !== "undefined" && navigator.onLine === false;
      this.opts.onStatus?.(
        knownOffline
          ? { kind: "offline" }
          : { kind: "error", message: err instanceof Error ? err.message : String(err) },
      );
      this.schedule(delay);
    }
  }
}
