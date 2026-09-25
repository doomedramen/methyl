import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { subscribeToChanges } from "@/lib/sync/events";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("subscribeToChanges", () => {
  it("delivers change events, sends the auth header, and reconnects after a drop", async () => {
    const streams: ServerResponse[] = [];
    const seenAuth: (string | undefined)[] = [];
    server = createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.push(res);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`;

    const seqs: number[] = [];
    let connects = 0;
    const abort = new AbortController();
    const done = subscribeToChanges({
      url,
      headers: { authorization: "Bearer t" },
      onChange: (e) => seqs.push(e.seq),
      onConnect: () => connects++,
      signal: abort.signal,
    });

    await waitFor(() => streams.length === 1);
    streams[0]!.write('data: {"seq":3}\n\n');
    streams[0]!.write('data: {"seq":4}\n\ndata: not json\n\n');
    await waitFor(() => seqs.length === 2);
    expect(seqs).toEqual([3, 4]);

    streams[0]!.end();
    await waitFor(() => streams.length === 2, 3000);
    streams[1]!.write('data: {"seq":5}\n\n');
    await waitFor(() => seqs.includes(5));

    expect(seenAuth).toEqual(["Bearer t", "Bearer t"]);
    expect(connects).toBe(2);
    abort.abort();
    for (const s of streams) s.end();
    await done;
  });
});
