import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LoroDoc } from "loro-crdt";
import { LoroWebsocketClient, type LoroWebsocketClientOptions } from "loro-websocket/client";
import { LoroAdaptor } from "loro-adaptors/loro";
import { createSyncServer } from "@/lib/server/sync-server";

/** Every file under `dir` with its size and mtime. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else out.push(`${path} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe("createSyncServer stop()", () => {
  it("finishes its writes before resolving: nothing changes in the vault afterwards", async () => {
    const vault = mkdtempSync(join(tmpdir(), "methyl-stop-"));
    const server = createSyncServer({ port: 0, vaultPath: vault, authToken: "t", watch: false, saveIntervalMs: 10_000 });
    await server.start();
    const client = new LoroWebsocketClient({ url: `ws://127.0.0.1:${server.ports().ws}`, disablePing: true } as LoroWebsocketClientOptions);
    try {
      await client.connect();
      const doc = new LoroDoc();
      const room = await client.join({ roomId: "doc:stopping", crdtAdaptor: new LoroAdaptor(doc), auth: new TextEncoder().encode("t") });
      await room.waitForReachingServerVersion();
      doc.getText("content").insert(0, "saved on the way out");
      doc.commit();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      client.destroy();
    }
    // The save interval hasn't come round: stop() does the final save,
    // which queues a disk-mirror write.
    await server.stop();
    const after = snapshot(vault);
    await new Promise((r) => setTimeout(r, 700)); // past the index write debounce
    expect(snapshot(vault)).toEqual(after);
    rmSync(vault, { recursive: true, force: true });
  });
});
