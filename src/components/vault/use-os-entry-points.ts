"use client";

import { useEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";
import type { VaultEngine } from "@/lib/vault/engine";
import { captureToInbox } from "@/lib/vault/inbox";
import { shareToCaptures, type SharePayload } from "@/lib/vault/share-payload";
import type { CreateHandler } from "./create-actions";

/**
 * File System Access API's launch-on-open surface. Not in lib.dom yet, so
 * it's typed narrowly here rather than widening `Window` app-wide — see
 * the file_handlers entry in manifest.webmanifest, which is what makes the
 * OS hand Methyl a `?action=open-file` launch with files attached.
 */
interface LaunchParams {
  readonly files: FileSystemFileHandle[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}
declare global {
  interface Window {
    launchQueue?: LaunchQueue;
  }
}

/**
 * The app's OS entry points: home-screen shortcuts, the share target and
 * `?action=` links (new note, new graph, search, share), and files opened
 * with the app (file handlers).
 */
export function useOsEntryPoints({
  engine,
  urlRestored,
  onCreate,
  openDocument,
  refreshNotes,
  setCommandOpen,
}: {
  engine: VaultEngine | null;
  /** Set once the initial note from the URL has been reopened. */
  urlRestored: RefObject<boolean>;
  onCreate: CreateHandler;
  openDocument: (documentId: string) => string;
  refreshNotes: (engine: VaultEngine) => void;
  setCommandOpen: (open: boolean) => void;
}) {
  // OS capture entry points (SPEC: shortcuts, share target, file handlers)
  // all funnel through `?action=` on the shell URL rather than a bespoke
  // route each — manifest.webmanifest's `shortcuts` and `share_target`
  // redirect here, and VaultApp is already the one place that owns engine
  // readiness. Runs once the vault is loaded and the URL-restore effect
  // above has had its turn, so a share doesn't race the initial note
  // reopen into fighting URL updates. `actionHandled` guards against
  // Strict Mode's double effect invocation re-running a share pickup twice.
  const actionHandled = useRef(false);
  useEffect(() => {
    if (!engine || !urlRestored.current || actionHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (!action) return;

    const stripAction = () => {
      params.delete("action");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      );
    };

    // Deferred a tick (rather than called straight from the effect body) so
    // the create/open action's own state updates land in their own render
    // instead of piling onto the one this effect ran in.
    if (action === "new") {
      actionHandled.current = true;
      queueMicrotask(() => onCreate({ kind: "note" }));
      stripAction();
    } else if (action === "new-graph") {
      actionHandled.current = true;
      queueMicrotask(() => onCreate({ kind: "graph" }));
      stripAction();
    } else if (action === "search") {
      actionHandled.current = true;
      queueMicrotask(() => setCommandOpen(true));
      stripAction();
    } else if (action === "share") {
      actionHandled.current = true;
      (async () => {
        try {
          const cache = await caches.open("methyl-share-pending");
          const res = await cache.match("share-pending");
          if (!res) return;
          await cache.delete("share-pending");
          const payload = (await res.json()) as SharePayload;
          let lastId: string | null = null;
          for (const capture of shareToCaptures(payload)) {
            const doc = await captureToInbox(engine, capture.name, capture.markdown);
            lastId = doc.id;
          }
          if (lastId) openDocument(lastId);
          refreshNotes(engine);
          toast.success("Shared into Inbox");
        } catch (e) {
          console.error(e);
          toast.error("Couldn't save the shared content");
        } finally {
          stripAction();
        }
      })();
    }
  }, [engine, onCreate, openDocument, refreshNotes, setCommandOpen, urlRestored]);

  // File double-clicked/"Open with"-ed on the OS (manifest.webmanifest's
  // `file_handlers`) arrives here instead of `?action`'s query string —
  // the browser hands the file handle(s) to this queue rather than
  // encoding file content in the URL. Registering the consumer is a no-op
  // unless the app was actually launched this way.
  useEffect(() => {
    if (!engine || !window.launchQueue) return;
    window.launchQueue.setConsumer(async (params) => {
      if (params.files.length === 0) return;
      try {
        let lastId: string | null = null;
        for (const handle of params.files) {
          const file = await handle.getFile();
          const text = await file.text();
          const doc = await captureToInbox(engine, file.name, text);
          lastId = doc.id;
        }
        if (lastId) openDocument(lastId);
        refreshNotes(engine);
        toast.success(params.files.length > 1 ? "Files added to Inbox" : "File added to Inbox");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't open the file");
      }
    });
  }, [engine, openDocument, refreshNotes]);
}
