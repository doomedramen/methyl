import { describe, expect, it } from "vitest";
import { createServer } from "http";
import type { AddressInfo } from "net";
import type { LoroWebsocketClientOptions } from "loro-websocket/client";
import { SyncClient } from "@/lib/sync/coordinator";

describe("SyncClient", () => {
  it("destroying before the connection settles leaves no unhandled rejection", async () => {
    // Accepts TCP but never completes the WebSocket handshake.
    const server = createServer();
    server.on("upgrade", () => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = new SyncClient({ url, disablePing: true } as LoroWebsocketClientOptions);
      const connecting = client.connect();
      client.destroy();
      await expect(connecting).rejects.toThrow("Destroyed");
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
