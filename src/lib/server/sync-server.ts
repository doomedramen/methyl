import { SimpleServer, type SimpleServerConfig } from "loro-websocket/server";
import type { CrdtType } from "loro-protocol";
import { ServerStore } from "@/lib/server/store";

export interface SyncServerOptions {
  port: number;
  host?: string;
  vaultPath: string;
  authToken: string;
  saveIntervalMs?: number;
}

export function createSyncServer(options: SyncServerOptions) {
  const store = new ServerStore(`${options.vaultPath}/.adhd/server/sync.sqlite`);

  const config: SimpleServerConfig = {
    port: options.port,
    host: options.host ?? "0.0.0.0",
    saveInterval: options.saveIntervalMs ?? 500,

    authenticate: async (
      _roomId: string,
      _crdtType: CrdtType,
      auth: Uint8Array,
    ) => {
      const token = new TextDecoder().decode(auth);
      if (token !== options.authToken) return null;
      return "write";
    },

    onLoadDocument: async (roomId: string, _crdtType: CrdtType) => {
      const room = store.getRoom(roomId);
      if (room && room.durableVersion) {
        return room.durableVersion;
      }
      return null;
    },

    onSaveDocument: async (
      roomId: string,
      crdtType: CrdtType,
      data: Uint8Array,
    ) => {
      const seq = store.getNextSeq();
      const room = store.getRoom(roomId);
      const newServerSeq = (room?.serverSeq ?? 0) + 1;
      const vvBytes = Buffer.from(data);
      store.upsertRoom(roomId, crdtType as string, vvBytes, newServerSeq);
      store.recordChange(
        seq,
        roomId,
        roomId === "vault-root" ? "tree" : "doc",
      );
    },
  };

  const server = new SimpleServer(config);

  return { server, store, stop: async () => {
    await server.stop();
    store.close();
  }};
}