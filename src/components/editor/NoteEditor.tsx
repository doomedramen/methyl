"use client";

import { useEffect, useRef } from "react";
import type { VaultEngine } from "@/lib/vault/engine";
import type { EditorView } from "@codemirror/view";
import type { EditorSession } from "@/lib/editor/session";
import type { EditorUser } from "@/lib/editor/sync";

const NAME_KEY = "adhd-name";

function loadUser(): EditorUser {
  const name =
    (typeof window !== "undefined" && localStorage.getItem(NAME_KEY)) || "You";
  return { name, colorClassName: "cm-adhd-you" };
}

/**
 * Lazily bootstraps CodeMirror + Loro bindings inside a <div>.
 * All browser-only CRDT/CM modules are dynamically imported so the SSR
 * prerender never evaluates them (avoids Turbopack WASM crash).
 */
export function NoteEditor({
  engine,
  documentId,
  onDirtyChange,
  onPersisted,
}: {
  engine: VaultEngine;
  documentId: string;
  onDirtyChange?: (dirty: boolean) => void;
  onPersisted?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handle = engine.getDocument(documentId);
    if (!handle) {
      host.textContent = `document not loaded: ${documentId}`;
      return;
    }

    const user = loadUser();
    let disposed = false;

    Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@/lib/editor/session"),
      import("@/lib/editor/sync"),
      import("@/lib/editor/extensions"),
    ])
      .then(async ([stateMod, viewMod, sessionMod, syncMod, extMod]) => {
        if (disposed) return;

        const { EditorState } = stateMod;
        const { EditorView } = viewMod;
        const { createEditorSession } = sessionMod;
        const {
          createCursorEphemeral,
          createUndoManager,
          getContentTextFromDoc,
        } = syncMod;
        const { adhdEditorExtensions, editorBaseTheme } = extMod;

        const undoManager = createUndoManager(handle.doc);
        const ephemeral = createCursorEphemeral();
        const session = createEditorSession({
          engine,
          documentId,
          maxDirtyMs: 3_000,
          onPersisted,
        });

        let view: EditorView | null = null;
        let sessionPromise: Promise<void> = Promise.resolve();
        view = new EditorView({
          parent: host,
          state: EditorState.create({
            doc: getContentTextFromDoc(session.doc).toString(),
            extensions: [
              adhdEditorExtensions({
                doc: session.doc,
                ephemeral,
                user,
                undoManager,
              }),
              editorBaseTheme(),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  session.schedulePersist();
                  onDirtyChange?.(true);
                }
              }),
            ],
          }),
        });

        const flush = () => void session.flush();
        const onHidden = () => {
          if (document.visibilityState === "hidden") flush();
        };
        document.addEventListener("visibilitychange", onHidden);
        window.addEventListener("beforeunload", flush);

        cleanupRef.current = () => {
          document.removeEventListener("visibilitychange", onHidden);
          window.removeEventListener("beforeunload", flush);
          const v = view;
          sessionPromise = session.dispose(true).then(() => v?.destroy());
        };
        void sessionPromise;
      })
      .catch((err) => {
        console.error("Editor init failed", err);
        if (!disposed) host.textContent = String(err);
      });

    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [engine, documentId]);

  return <div ref={hostRef} className="cm-host h-full w-full overflow-auto" />;
}