import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { request } from "http";
import { createSyncServer } from "@/lib/server/sync-server";

const AUTH = "watcher-token";
let portCounter = 24000 + Math.floor(Math.random() * 2000);

function nextPorts() {
  const wsPort = portCounter++;
  return { wsPort, httpPort: portCounter++ };
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${AUTH}` } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function waitFor(check: () => boolean, timeoutMs = 5000, stepMs = 30): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe("sync-server vault watcher integration", () => {
  it("an external .md edit is ingested and shows up in discovery for a reconnecting client", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adhd-sync-watch-"));
    const { wsPort, httpPort } = nextPorts();
    const server = createSyncServer({
      port: wsPort,
      httpPort,
      vaultPath: tmpDir,
      authToken: AUTH,
      saveIntervalMs: 50,
    });
    await server.start();
    try {
      const engine = server.getEngine()!;
      const doc = engine.createDocument(undefined, "note.md", "original");
      await engine.persistTree();
      await engine.persistDocumentIncremental(doc.id);

      const before = await httpGet(httpPort, "/api/changes?after=0");
      const beforeCount = (JSON.parse(before.body) as { changes: unknown[] }).changes.length;

      // External editor changes the file directly on disk.
      writeFileSync(join(tmpDir, "note.md"), "original, edited externally");

      await waitFor(() => {
        return engine.getDocument(doc.id)?.getMarkdown() === "original, edited externally";
      });

      // The ingest must have recorded a change visible to discovery, so a
      // reconnecting/polling client learns about it (no live-push API —
      // see sync-server.ts's design comment). Poll: the tree mutation the
      // earlier waitFor observed and this record happen moments apart.
      let sawDocChange = false;
      let afterCount = beforeCount;
      const deadline = Date.now() + 5000;
      while (!sawDocChange && Date.now() < deadline) {
        const after = await httpGet(httpPort, "/api/changes?after=0");
        const afterChanges = (JSON.parse(after.body) as { changes: { objectId: string }[] }).changes;
        afterCount = afterChanges.length;
        sawDocChange = afterChanges.some((c) => c.objectId === `doc:${doc.id}`);
        if (!sawDocChange) await new Promise((r) => setTimeout(r, 50));
      }
      expect(afterCount).toBeGreaterThan(beforeCount);
      expect(sawDocChange).toBe(true);
    } finally {
      await server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10000);

  it("external rename keeps the document id and updates discovery for the tree room", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adhd-sync-watch-"));
    const { wsPort, httpPort } = nextPorts();
    const server = createSyncServer({
      port: wsPort,
      httpPort,
      vaultPath: tmpDir,
      authToken: AUTH,
      saveIntervalMs: 50,
      vaultId: "renametest",
    });
    await server.start();
    try {
      const engine = server.getEngine()!;
      const doc = engine.createDocument(undefined, "Garage.md", "fix the door");
      await engine.persistTree();
      await engine.persistDocumentIncremental(doc.id);

      const { mkdirSync, renameSync } = await import("fs");
      mkdirSync(join(tmpDir, "Projects"), { recursive: true });
      renameSync(join(tmpDir, "Garage.md"), join(tmpDir, "Projects", "Garage.md"));

      await waitFor(() => {
        const node = engine.tree.findByDocumentId(doc.id);
        return node?.name === "Garage.md" && node.treeId !== undefined;
      });

      const node = engine.tree.findByDocumentId(doc.id)!;
      expect(node.name).toBe("Garage.md");
      expect(engine.getDocument(doc.id)!.getMarkdown()).toBe("fix the door");

      // The tree-room broadcast (recordRoomSave) happens right after the
      // ingest pass that moved the node, in the same async continuation as
      // the tree mutation the earlier waitFor already observed — but poll
      // discovery too rather than racing a single read against it.
      let sawTreeChange = false;
      const deadline = Date.now() + 5000;
      while (!sawTreeChange && Date.now() < deadline) {
        const changes = await httpGet(httpPort, "/api/changes?after=0");
        const parsed = JSON.parse(changes.body) as { changes: { objectId: string }[] };
        sawTreeChange = parsed.changes.some((c) => c.objectId === "vault:renametest");
        if (!sawTreeChange) await new Promise((r) => setTimeout(r, 50));
      }
      expect(sawTreeChange).toBe(true);
    } finally {
      await server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10000);

  it("adopts an external attachment and publishes its bytes", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adhd-sync-watch-"));
    const { wsPort, httpPort } = nextPorts();
    const server = createSyncServer({
      port: wsPort,
      httpPort,
      vaultPath: tmpDir,
      authToken: AUTH,
      saveIntervalMs: 50,
      vaultId: "assetwatch",
    });
    await server.start();
    try {
      const bytes = Buffer.from([1, 3, 3, 7]);
      mkdirSync(join(tmpDir, "Attachments"), { recursive: true });
      writeFileSync(join(tmpDir, "Attachments", "external.png"), bytes);

      await waitFor(() => {
        const node = server.getEngine()!.tree.findByName("external.png")[0];
        return node?.kind === "binary" && server.store.getAssetMeta(String(node.treeId)) !== undefined;
      });

      const node = server.getEngine()!.tree.findByName("external.png")[0]!;
      const meta = server.store.getAssetMeta(String(node.treeId))!;
      expect(meta.size).toBe(bytes.length);
      expect(readFileSync(join(tmpDir, ".adhd/server/assets", meta.sha256))).toEqual(bytes);
    } finally {
      await server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10000);

  it("a client-driven CRDT save writes a clean .md and is not re-ingested as external", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adhd-sync-watch-"));
    const { wsPort, httpPort } = nextPorts();
    const server = createSyncServer({
      port: wsPort,
      httpPort,
      vaultPath: tmpDir,
      authToken: AUTH,
      saveIntervalMs: 50,
      vaultId: "clienttest",
    });
    await server.start();
    try {
      const engine = server.getEngine()!;
      const doc = engine.createDocument(undefined, "note.md", "hello");
      await engine.persistTree();
      await engine.persistDocumentIncremental(doc.id);

      // Simulate the server side of a client save: import an update
      // directly into the engine doc and let onSaveDocument's mirror path
      // materialise it (exercised indirectly — the config's onSaveDocument
      // handler is private, so we call the same public primitives it uses
      // and confirm the resulting .md + index stay clean).
      const activeDoc = engine.getDocument(doc.id)!;
      activeDoc.getText("content").insert(5, " world");
      activeDoc.doc.commit();
      await engine.persistDocumentIncremental(doc.id);

      await new Promise((r) => setTimeout(r, 500)); // let any watcher pass settle

      const mdContent = readFileSync(join(tmpDir, "note.md"), "utf8");
      expect(mdContent).toBe("hello world");
      expect(mdContent).not.toContain("adhd:id");

      // A subsequent explicit ingest pass must find nothing external: the
      // sidecar index was touched by the app's own write.
      const report = await engine.ingestExternalChanges();
      expect(report.edited).toEqual([]);
      expect(report.created).toEqual([]);
      expect(report.deleted).toEqual([]);
    } finally {
      await server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10000);

  it("stop() closes the watcher (no lingering fs handles / errors on cleanup)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adhd-sync-watch-"));
    const { wsPort, httpPort } = nextPorts();
    const server = createSyncServer({
      port: wsPort,
      httpPort,
      vaultPath: tmpDir,
      authToken: AUTH,
      saveIntervalMs: 50,
    });
    await server.start();
    await expect(server.stop()).resolves.toBeUndefined();
    rmSync(tmpDir, { recursive: true, force: true });
  }, 10000);

  it("watch: false disables the filesystem watcher", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adhd-sync-watch-"));
    const { wsPort, httpPort } = nextPorts();
    const server = createSyncServer({
      port: wsPort,
      httpPort,
      vaultPath: tmpDir,
      authToken: AUTH,
      saveIntervalMs: 50,
      watch: false,
    });
    await server.start();
    try {
      const engine = server.getEngine()!;
      const doc = engine.createDocument(undefined, "note.md", "original");
      await engine.persistTree();
      await engine.persistDocumentIncremental(doc.id);

      writeFileSync(join(tmpDir, "note.md"), "changed externally, but nobody is watching");
      await new Promise((r) => setTimeout(r, 400));

      // No watcher running: the external edit is never ingested on its own.
      expect(engine.getDocument(doc.id)!.getMarkdown()).toBe("original");
    } finally {
      await server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10000);
});
