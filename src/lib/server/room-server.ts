import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { randomBytes } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  CrdtType,
  JoinErrorCode,
  MAX_MESSAGE_SIZE,
  MessageType,
  UpdateStatusCode,
  bytesToHex,
  decode,
  encode,
  type DocUpdate,
  type DocUpdateFragment,
  type DocUpdateFragmentHeader,
  type HexString,
  type JoinRequest,
  type Permission,
  type ProtocolMessage,
} from "loro-protocol";
import { LoroDoc, VersionVector } from "loro-crdt";

/**
 * Methyl's sync room server (spec item 7), replacing loro-websocket's
 * SimpleServer while speaking the same loro-protocol, so the existing
 * browser client works unchanged.
 *
 * What SimpleServer couldn't do, and this does:
 *  - attach to the app's own HTTP server (no second port, no TCP proxy);
 *  - `push()` an update made on the server (a disk edit) into a room and
 *    broadcast it to the clients in it;
 *  - keep each open room as a live LoroDoc instead of re-importing the
 *    whole snapshot for every update;
 *  - save without losing updates that arrive during a save (SimpleServer
 *    cleared the dirty flag after awaiting its save handler);
 *  - evict rooms nobody has joined for a while, and drop dead sockets.
 *
 * Only Loro documents are served; other CRDT types are refused at join.
 */

export interface RoomClientInfo {
  /** Remote address, for rate limiting failed authentication. */
  address: string;
  /** Unique per connection (tickets are bound to one). */
  connectionId: string;
  /** Who authenticated on this connection; `authenticate` sets it (e.g. `device:<id>`). */
  principal?: string;
}

export interface RoomServerOptions {
  /** Decide a join: "write", "read", or null to refuse. */
  authenticate(roomId: string, auth: Uint8Array, client: RoomClientInfo): Promise<Permission | null>;
  /** Stored snapshot of a room, or null for a new one. */
  load(roomId: string): Promise<Uint8Array | null> | Uint8Array | null;
  /** Persist a room's snapshot; called at most every saveIntervalMs while it changes. */
  save(roomId: string, snapshot: Uint8Array): Promise<void> | void;
  saveIntervalMs?: number;
  /** A room nobody is in is dropped from memory after this long. */
  idleEvictMs?: number;
  heartbeatMs?: number;
  /** Address of an upgrade request (e.g. honouring a trusted proxy). */
  clientAddress?(req: IncomingMessage): string;
  /** A connection closed. */
  onClientClosed?(client: RoomClientInfo): void;
}

interface Room {
  id: string;
  doc: LoroDoc;
  dirty: boolean;
  clients: Set<Client>;
  lastActive: number;
}

interface FragmentBatch {
  header: DocUpdateFragmentHeader;
  parts: Uint8Array[];
  received: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Client {
  ws: WebSocket;
  info: RoomClientInfo;
  rooms: Map<string, Permission>;
  fragments: Map<HexString, FragmentBatch>;
  alive: boolean;
}

const FRAGMENT_TIMEOUT_MS = 10_000;
// Headroom under MAX_MESSAGE_SIZE for the message's own framing.
const FRAGMENT_BYTES = MAX_MESSAGE_SIZE - 4096;

function newBatchId(): HexString {
  return bytesToHex(randomBytes(8));
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class RoomServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_SIZE * 2 });
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();
  private readonly clients = new Set<Client>();
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly options: RoomServerOptions) {
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
  }

  /** Start saving and heartbeats. */
  start(): void {
    this.saveTimer ??= setInterval(() => void this.saveDirty(), this.options.saveIntervalMs ?? 500);
    this.heartbeatTimer ??= setInterval(() => this.heartbeat(), this.options.heartbeatMs ?? 30_000);
  }

  /**
   * Take WebSocket upgrades on `server` for which `accept(req)` is true.
   * Returns a function that detaches again.
   */
  attach(server: Server, accept: (req: IncomingMessage) => boolean = () => true): () => void {
    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!accept(req)) return;
      this.handleUpgrade(req, socket, head);
    };
    server.on("upgrade", onUpgrade);
    return () => server.off("upgrade", onUpgrade);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  /**
   * Merge an update made on the server (e.g. an ingested disk edit) into a
   * room, and send the new part to every client in it. A room that isn't
   * loaded picks it up from storage when next joined.
   */
  push(roomId: string, update: Uint8Array): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const before = room.doc.version();
    try {
      room.doc.import(update);
    } catch (error) {
      console.error(`[room-server] push to ${roomId} failed`, error);
      return;
    }
    const delta = room.doc.export({ mode: "update", from: before });
    if (room.doc.version().compare(before) === 0) return;
    for (const client of room.clients) this.sendUpdate(client, roomId, delta);
  }

  /** Current snapshot of a loaded room (for tests and diagnostics). */
  snapshot(roomId: string): Uint8Array | null {
    return this.rooms.get(roomId)?.doc.export({ mode: "snapshot" }) ?? null;
  }

  async stop(): Promise<void> {
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.saveTimer = this.heartbeatTimer = null;
    await this.saveDirty();
    for (const client of this.clients) client.ws.close(1001, "Server stopping");
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ── connections ────────────────────────────────────────────────────

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = {
      ws,
      info: {
        address: this.options.clientAddress?.(req) ?? req.socket.remoteAddress ?? "unknown",
        connectionId: randomBytes(12).toString("hex"),
      },
      rooms: new Map(),
      fragments: new Map(),
      alive: true,
    };
    this.clients.add(client);
    ws.on("pong", () => (client.alive = true));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        // loro-websocket's application-level keepalive.
        if (data.toString() === "ping" && ws.readyState === WebSocket.OPEN) ws.send("pong");
        return;
      }
      let message: ProtocolMessage;
      try {
        message = decode(toBytes(data));
      } catch {
        ws.close(1002, "Protocol error");
        return;
      }
      void this.onMessage(client, message).catch((error) => console.error("[room-server] message failed", error));
    });
    ws.on("close", () => this.onClose(client));
    ws.on("error", () => ws.terminate());
  }

  /** Drop every connection whose info matches (e.g. a revoked device's). Returns how many. */
  disconnectWhere(match: (client: RoomClientInfo) => boolean): number {
    let count = 0;
    for (const client of this.clients) {
      if (!match(client.info)) continue;
      count++;
      client.ws.close(4001, "Access revoked");
      // Don't wait for the close handshake: stop serving it now.
      this.onClose(client);
      client.ws.terminate();
    }
    return count;
  }

  private onClose(client: Client): void {
    if (!this.clients.delete(client)) return;
    this.options.onClientClosed?.(client.info);
    for (const batch of client.fragments.values()) clearTimeout(batch.timer);
    for (const roomId of client.rooms.keys()) this.leaveRoom(client, roomId);
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
    }
    const now = Date.now();
    const idle = this.options.idleEvictMs ?? 60_000;
    for (const room of this.rooms.values()) {
      if (room.clients.size === 0 && !room.dirty && now - room.lastActive > idle) {
        this.rooms.delete(room.id);
        room.doc.free();
      }
    }
  }

  private async onMessage(client: Client, message: ProtocolMessage): Promise<void> {
    switch (message.type) {
      case MessageType.JoinRequest:
        return this.onJoin(client, message);
      case MessageType.DocUpdate:
        return this.onUpdate(client, message);
      case MessageType.DocUpdateFragmentHeader:
        return this.onFragmentHeader(client, message);
      case MessageType.DocUpdateFragment:
        return this.onFragment(client, message);
      case MessageType.Leave:
        this.leaveRoom(client, message.roomId);
        return;
      default:
        return; // Acks and room errors from clients need no reply.
    }
  }

  // ── rooms ──────────────────────────────────────────────────────────

  private async room(roomId: string): Promise<Room> {
    const open = this.rooms.get(roomId);
    if (open) return open;
    const pending = this.loading.get(roomId);
    if (pending) return pending;
    const load = (async () => {
      const doc = new LoroDoc();
      const stored = await this.options.load(roomId);
      if (stored && stored.length > 0) doc.import(stored);
      const room: Room = { id: roomId, doc, dirty: false, clients: new Set(), lastActive: Date.now() };
      this.rooms.set(roomId, room);
      return room;
    })();
    this.loading.set(roomId, load);
    try {
      return await load;
    } finally {
      this.loading.delete(roomId);
    }
  }

  private leaveRoom(client: Client, roomId: string): void {
    client.rooms.delete(roomId);
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.clients.delete(client);
    room.lastActive = Date.now();
  }

  private async onJoin(client: Client, message: JoinRequest): Promise<void> {
    const { roomId } = message;
    if (message.crdt !== CrdtType.Loro) {
      return this.joinError(client, message, JoinErrorCode.AppError, "Only Loro documents are served");
    }
    const permission = await this.options.authenticate(roomId, message.auth, client.info);
    if (!permission) return this.joinError(client, message, JoinErrorCode.AuthFailed, "Authentication failed");

    let room: Room;
    try {
      room = await this.room(roomId);
    } catch (error) {
      return this.joinError(client, message, JoinErrorCode.Unknown, error instanceof Error ? error.message : "load failed");
    }
    client.rooms.set(roomId, permission);
    room.clients.add(client);
    room.lastActive = Date.now();

    this.send(client, {
      type: MessageType.JoinResponseOk,
      crdt: CrdtType.Loro,
      roomId,
      permission,
      version: room.doc.version().encode(),
    });
    // Send what the client doesn't have yet.
    let backfill: Uint8Array;
    if (message.version.length > 0) {
      let from: VersionVector;
      try {
        from = VersionVector.decode(message.version);
      } catch {
        from = new VersionVector(null);
      }
      backfill = room.doc.export({ mode: "update", from });
    } else {
      backfill = room.doc.export({ mode: "snapshot" });
    }
    if (room.doc.version().length() > 0) this.sendUpdate(client, roomId, backfill);
  }

  private joinError(client: Client, message: JoinRequest, code: JoinErrorCode, text: string): void {
    this.send(client, { type: MessageType.JoinError, crdt: message.crdt, roomId: message.roomId, code, message: text });
  }

  private async onUpdate(client: Client, message: DocUpdate): Promise<void> {
    const status = this.checkWrite(client, message.roomId, message.updates);
    if (status !== UpdateStatusCode.Ok) return this.ack(client, message.roomId, message.batchId, status);
    await this.applyAndBroadcast(client, message.roomId, message.batchId, message.updates);
  }

  private checkWrite(client: Client, roomId: string, updates: Uint8Array[] = []): UpdateStatusCode {
    if (updates.some((u) => u.length > MAX_MESSAGE_SIZE)) return UpdateStatusCode.PayloadTooLarge;
    const permission = client.rooms.get(roomId);
    if (!permission || permission !== "write") return UpdateStatusCode.PermissionDenied;
    return UpdateStatusCode.Ok;
  }

  private async applyAndBroadcast(client: Client, roomId: string, batchId: HexString, updates: Uint8Array[]): Promise<void> {
    const room = await this.room(roomId);
    try {
      for (const update of updates) room.doc.import(update);
    } catch (error) {
      console.warn(`[room-server] invalid update for ${roomId}`, error);
      return this.ack(client, roomId, batchId, UpdateStatusCode.InvalidUpdate);
    }
    room.dirty = true;
    room.lastActive = Date.now();
    this.ack(client, roomId, batchId, UpdateStatusCode.Ok);
    for (const other of room.clients) {
      if (other === client) continue;
      for (const update of updates) this.sendUpdate(other, roomId, update);
    }
  }

  private onFragmentHeader(client: Client, header: DocUpdateFragmentHeader): void {
    const status = this.checkWrite(client, header.roomId);
    if (status !== UpdateStatusCode.Ok) return this.ack(client, header.roomId, header.batchId, status);
    const timer = setTimeout(() => {
      client.fragments.delete(header.batchId);
      this.ack(client, header.roomId, header.batchId, UpdateStatusCode.FragmentTimeout);
    }, FRAGMENT_TIMEOUT_MS);
    client.fragments.set(header.batchId, {
      header,
      parts: Array.from({ length: header.fragmentCount }, () => new Uint8Array()),
      received: 0,
      timer,
    });
  }

  private async onFragment(client: Client, fragment: DocUpdateFragment): Promise<void> {
    const batch = client.fragments.get(fragment.batchId);
    if (!batch) return this.ack(client, fragment.roomId, fragment.batchId, UpdateStatusCode.FragmentTimeout);
    batch.parts[fragment.index] = fragment.fragment;
    batch.received += 1;
    if (batch.received < batch.parts.length) return;
    clearTimeout(batch.timer);
    client.fragments.delete(fragment.batchId);
    const whole = new Uint8Array(batch.header.totalSizeBytes);
    let offset = 0;
    for (const part of batch.parts) {
      whole.set(part, offset);
      offset += part.length;
    }
    const status = this.checkWrite(client, fragment.roomId);
    if (status !== UpdateStatusCode.Ok) return this.ack(client, fragment.roomId, fragment.batchId, status);
    await this.applyAndBroadcast(client, fragment.roomId, fragment.batchId, [whole]);
  }

  // ── sending ────────────────────────────────────────────────────────

  private send(client: Client, message: ProtocolMessage): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    client.ws.send(encode(message));
  }

  private ack(client: Client, roomId: string, refId: HexString, status: UpdateStatusCode): void {
    this.send(client, { type: MessageType.Ack, crdt: CrdtType.Loro, roomId, refId, status });
  }

  /** Send one update, split into fragments when it's too large for one message. */
  private sendUpdate(client: Client, roomId: string, update: Uint8Array): void {
    if (update.length <= FRAGMENT_BYTES) {
      this.send(client, { type: MessageType.DocUpdate, crdt: CrdtType.Loro, roomId, updates: [update], batchId: newBatchId() });
      return;
    }
    const batchId = newBatchId();
    const count = Math.ceil(update.length / FRAGMENT_BYTES);
    this.send(client, {
      type: MessageType.DocUpdateFragmentHeader,
      crdt: CrdtType.Loro,
      roomId,
      batchId,
      fragmentCount: count,
      totalSizeBytes: update.length,
    });
    for (let i = 0; i < count; i++) {
      this.send(client, {
        type: MessageType.DocUpdateFragment,
        crdt: CrdtType.Loro,
        roomId,
        batchId,
        index: i,
        fragment: update.subarray(i * FRAGMENT_BYTES, (i + 1) * FRAGMENT_BYTES),
      });
    }
  }

  // ── persistence ────────────────────────────────────────────────────

  /**
   * Save every changed room. The dirty flag is cleared *before* the save
   * handler runs, so an update arriving meanwhile marks the room dirty again
   * and is saved next time; a failed save marks it dirty again too. Saves
   * never overlap.
   */
  saveDirty(): Promise<void> {
    this.saving = this.saving.then(async () => {
      for (const room of this.rooms.values()) {
        if (!room.dirty) continue;
        room.dirty = false;
        try {
          await this.options.save(room.id, room.doc.export({ mode: "snapshot" }));
        } catch (error) {
          room.dirty = true;
          console.error(`[room-server] saving ${room.id} failed`, error);
        }
      }
    });
    return this.saving;
  }
}
