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
  onSaveError,
}: {
  engine: VaultEngine;
  documentId: string;
  onDirtyChange?: (dirty: boolean) => void;
  onPersisted?: () => void;
  /** Edits did not reach the stored note (persist threw or text diverged). */
  onSaveError?: () => void;
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
        let view: EditorView | null = null;
        let verifyTimer: ReturnType<typeof setTimeout> | null = null;

        // "Saved" is only true if the editor text matches the stored LoroText.
        const inSync = () =>
          !view || view.state.doc.toString() === getContentTextFromDoc(handle.doc).toString();

        const session = createEditorSession({
          engine,
          documentId,
          maxDirtyMs: 3_000,
          onPersisted: () => {
            if (inSync()) onPersisted?.();
            else onSaveError?.();
          },
          onPersistError: () => onSaveError?.(),
        });
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
                  // Catch edits that never reach the LoroText, so no persist fires.
                  if (verifyTimer) clearTimeout(verifyTimer);
                  verifyTimer = setTimeout(() => {
                    if (!disposed && !inSync()) onSaveError?.();
                  }, 5_000);
                }
              }),
            ],
          }),
        });

        // Work around a loro-codemirror@0.3.3 bug (node_modules/loro-codemirror/
        // dist/sync.js, LoroSyncPluginValue): its constructor unconditionally
        // sets `isInitDispatch = true` inside a `Promise.resolve().then(...)`
        // microtask — regardless of whether the initial content actually
        // differed and needed dispatching — and `update()` silently swallows
        // (never applies to the LoroText) the very next view update while that
        // flag is set, clearing it afterwards. Since our EditorState is
        // already seeded from the LoroText (so the plugin's own init dispatch
        // is always a no-op), the flag stays armed and instead swallows the
        // user's actual first edit: a single bulk insert (e.g. paste, or
        // `execCommand('insertText', ...)`) shows up in the CodeMirror view
        // (CM's own local state applies it regardless) but never reaches the
        // LoroText, so it's typed, looks saved, and is silently lost on
        // reload. Consuming the flag ourselves, right after mount, on a
        // harmless no-op dispatch — scheduled after the plugin's own
        // microtask so it "wins" the swallow instead of a real edit —
        // fixes this without patching the vendored package.
        Promise.resolve().then(() => {
          if (disposed || !view) return;
          view.dispatch({ selection: view.state.selection });
        });

        const flush = () => void session.flush();
        const onHidden = () => {
          if (document.visibilityState === "hidden") flush();
        };
        document.addEventListener("visibilitychange", onHidden);
        window.addEventListener("beforeunload", flush);

        cleanupRef.current = () => {
          if (verifyTimer) clearTimeout(verifyTimer);
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