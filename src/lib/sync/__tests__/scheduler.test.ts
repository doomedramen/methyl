import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncScheduler, type SyncStatus } from "@/lib/sync/scheduler";

describe("SyncScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs immediately on start and reports connecting then synced", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const statuses: SyncStatus["kind"][] = [];
    const s = new SyncScheduler({ run, onStatus: (st) => statuses.push(st.kind) });
    s.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(statuses).toEqual(["connecting", "synced"]);
    s.stop();
  });

  it("schedules the next round after intervalMs on success", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const s = new SyncScheduler({ run, intervalMs: 5000 });
    s.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(4999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it("backs off exponentially on repeated failure, capped at maxBackoffMs", async () => {
    const run = vi.fn().mockRejectedValue(new Error("network down"));
    const statuses: SyncStatus[] = [];
    const s = new SyncScheduler({
      run,
      baseBackoffMs: 100,
      maxBackoffMs: 400,
      onStatus: (st) => statuses.push(st),
    });
    s.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(100); // attempt 0 -> 100ms
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(200); // attempt 1 -> 200ms
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));

    await vi.advanceTimersByTimeAsync(400); // attempt 2 -> 400ms (capped, not 400*2=800... actually 100*2^2=400)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4));

    await vi.advanceTimersByTimeAsync(400); // attempt 3 -> would be 800 but capped at 400
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5));

    const errorStatuses = statuses.filter((st) => st.kind === "error");
    expect(errorStatuses.length).toBeGreaterThanOrEqual(4);
    s.stop();
  });

  it("kick() cancels the pending backoff and retries immediately", async () => {
    let fail = true;
    const run = vi.fn().mockImplementation(async () => {
      if (fail) throw new Error("offline");
    });
    const s = new SyncScheduler({ run, baseBackoffMs: 10_000 });
    s.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    fail = false;
    s.kick();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    s.stop();
  });

  it("a kick during a running round runs another round right after it", async () => {
    let finish!: () => void;
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockResolvedValue(undefined);
    const s = new SyncScheduler({ run, intervalMs: 60_000 });
    s.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    s.kick(); // e.g. a change event arrives mid-round
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    // ...and then back to the normal interval.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it("stop() prevents further scheduled runs", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const s = new SyncScheduler({ run, intervalMs: 1000 });
    s.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
