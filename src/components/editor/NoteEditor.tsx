"use client";

import { useEffect, useRef } from "react";
import type { VaultEngine } from "@/lib/vault/engine";
import type { EditorView } from "@codemirror/view";
import type { EditorSession } from "@/lib/editor/session";
import type { EditorUser } from "@/lib/editor/sync";
import { usePluginHost } from "@/lib/plugins/react";
import { reconfigurePluginCompartment } from "@/lib/plugins/editor";

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
  readOnly = false,
  /** Incrementing counter; a new value asks for an immediate flush. */
  saveRequest = 0,
}: {
  engine: VaultEngine;
  documentId: string;
  onDirtyChange?: (dirty: boolean) => void;
  onPersisted?: () => void;
  /** Edits did not reach the stored note (persist threw or text diverged). */
  onSaveError?: () => void;
  /**
   * This tab doesn't hold the vault's writer lock (§12) — disable editing
   * rather than let two tabs write to the same OPFS store concurrently.
   * Content still updates live if the writer tab (or a sync round) changes
   * it, via the same loro-codemirror doc.subscribe binding as a writable
   * editor; only local keystrokes are blocked.
   */
  readOnly?: boolean;
  saveRequest?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Updated when the (async-bootstrapped) editor session creates its flush,
  // so a save request can fire it from outside the session's lifecycle.
  const flushRef = useRef<(() => void) | null>(null);
  // Wikilink click/open/create and live preview are core plugins (Task 10)
  // driven off `app.workspace`; this component only needs the shared
  // EditorExtensionRegistry to seed and live-reconfigure the compartment.
  const pluginHost = usePluginHost();

  // Reply to the app-level "save now" request (Cmd/Ctrl+S in VaultApp).
  // If nothing is dirty the session's flush no-ops, which is fine — VaultApp
  // shows the "Saved" badge itself for the already-saved case.
  useEffect(() => {
    if (!saveRequest) return;
    flushRef.current?.();
  }, [saveRequest]);

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

        const { EditorState, Compartment } = stateMod;
        const { EditorView } = viewMod;
        const pluginCompartment = new Compartment();
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
                pluginCompartment,
                initialPluginExtension: pluginHost.editorExtensions.buildExtension(),
              }),
              editorBaseTheme(),
              EditorState.readOnly.of(readOnly),
              EditorView.editable.of(!readOnly),
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
        flushRef.current = flush;
        const onHidden = () => {
          if (document.visibilityState === "hidden") flush();
        };
        document.addEventListener("visibilitychange", onHidden);
        window.addEventListener("beforeunload", flush);

        // Live-swap plugin extensions (e.g. a plugin toggled in PluginsDialog)
        // without recreating the view, preserving cursor/undo (spec §3).
        const unsubscribePluginExtensions = pluginHost.editorExtensions.subscribe(() => {
          if (disposed || !view) return;
          reconfigurePluginCompartment(view, pluginCompartment, pluginHost.editorExtensions.buildExtension());
        });

        cleanupRef.current = () => {
          if (verifyTimer) clearTimeout(verifyTimer);
          document.removeEventListener("visibilitychange", onHidden);
          window.removeEventListener("beforeunload", flush);
          unsubscribePluginExtensions();
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
      flushRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [engine, documentId, readOnly, pluginHost]);

  return <div ref={hostRef} className="cm-host h-full w-full overflow-auto" />;
}