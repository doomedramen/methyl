"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { VaultEngine } from "@/lib/vault/engine";
import type { EditorView } from "@codemirror/view";
import type { EditorSession } from "@/lib/editor/session";
import type { EditorUser } from "@/lib/editor/sync";
import { Paperclip } from "lucide-react";
import { attachmentMarkdownLink, relativeAttachmentPath } from "@/lib/vault/attachments";
import { useApp, usePluginHost } from "@/lib/plugins/react";
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
  workspaceTabId,
  onAttachmentsChanged,
  onDirtyChange,
  onPersisted,
  onSaveError,
  readOnly = false,
  /** Incrementing counter; a new value asks for an immediate flush. */
  saveRequest = 0,
}: {
  engine: VaultEngine;
  documentId: string;
  /** Stable identity used when more than one editor is mounted in a split. */
  workspaceTabId?: string;
  onAttachmentsChanged?: () => void;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Updated when the (async-bootstrapped) editor session creates its flush,
  // so a save request can fire it from outside the session's lifecycle.
  const flushRef = useRef<(() => void) | null>(null);
  const attachFilesRef = useRef<(files: File[]) => void>(() => undefined);
  const attachmentChangeRef = useRef(onAttachmentsChanged);
  useLayoutEffect(() => {
    attachmentChangeRef.current = onAttachmentsChanged;
  }, [onAttachmentsChanged]);
  // Wikilink click/open/create and live preview are core plugins (Task 10)
  // driven off `app.workspace`; this component only needs the shared
  // EditorExtensionRegistry to seed and live-reconfigure the compartment.
  const pluginHost = usePluginHost();
  const app = useApp();
  // `app` is rebuilt by VaultPluginBridge whenever the active note or save
  // state changes; read it through a ref so those changes never tear down
  // and recreate the editor (which dropped focus, open completions and undo).
  const appRef = useRef(app);
  useLayoutEffect(() => {
    appRef.current = app;
  }, [app]);

  // Reply to the app-level "save now" request (Cmd/Ctrl+S in VaultApp).
  // If nothing is dirty the session's flush no-ops, which is fine — VaultApp
  // shows the "Saved" badge itself for the already-saved case.
  useEffect(() => {
    if (!saveRequest) return;
    flushRef.current?.();
  }, [saveRequest]);

  useLayoutEffect(() => {
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

        const attachFiles = async (files: File[]) => {
          if (disposed || readOnly || !view || files.length === 0) return;
          const links: string[] = [];
          try {
            for (const file of files) {
              const bytes = new Uint8Array(await file.arrayBuffer());
              const node = await engine.createAttachment(file.name || "attachment", bytes);
              const path = relativeAttachmentPath(engine, documentId, node.treeId);
              if (path) links.push(attachmentMarkdownLink(node.name, path));
            }
            await engine.persistTreeIncremental();
            if (links.length > 0 && view) {
              const { from, to } = view.state.selection.main;
              const insert = links.join("\n");
              view.dispatch({
                changes: { from, to, insert },
                selection: { anchor: from + insert.length },
              });
              attachmentChangeRef.current?.();
            }
          } catch (error) {
            console.error("[editor] attachment import failed", error);
          }
        };
        attachFilesRef.current = (files) => void attachFiles(files);
        const onPaste = (event: ClipboardEvent) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0 || readOnly) return;
          event.preventDefault();
          attachFilesRef.current(files);
        };
        const onDragOver = (event: DragEvent) => {
          if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
        };
        const onDrop = (event: DragEvent) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (files.length === 0 || readOnly) return;
          event.preventDefault();
          attachFilesRef.current(files);
        };
        host.addEventListener("paste", onPaste, true);
        host.addEventListener("dragover", onDragOver);
        host.addEventListener("drop", onDrop);

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

        // Exposes this view to app.commands.execute for Command.editorCallback
        // commands (word-count's "Show", any future editor-scoped command).
        // The tab id matters when two split panes are mounted at once.
        const editorTabId = workspaceTabId ?? documentId;
        const focusEditor = () => {
          appRef.current.workspace.setActiveEditorView?.(view, editorTabId);
          appRef.current.workspace.focusEditorTab?.(editorTabId);
        };
        view.dom.addEventListener("focusin", focusEditor);
        appRef.current.workspace.setActiveEditorView?.(view, editorTabId);

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
          attachFilesRef.current = () => undefined;
          host.removeEventListener("paste", onPaste, true);
          host.removeEventListener("dragover", onDragOver);
          host.removeEventListener("drop", onDrop);
          document.removeEventListener("visibilitychange", onHidden);
          window.removeEventListener("beforeunload", flush);
          unsubscribePluginExtensions();
          view?.dom.removeEventListener("focusin", focusEditor);
          appRef.current.workspace.setActiveEditorView?.(null, editorTabId);
          const v = view;
          view = null;
          // Layout-effect cleanup runs before React removes this component's
          // host. Detach CodeMirror before that happens; waiting for the
          // session flush would leave EditorView.destroy() running against a
          // DOM subtree React already owns and may have removed.
          v?.destroy();
          void session.dispose(true);
        };
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
  }, [engine, documentId, pluginHost, readOnly, workspaceTabId]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="cm-host h-full w-full overflow-auto" />
      {!readOnly && (
        <>
          <button
            type="button"
            className="absolute top-2 right-3 z-10 rounded-md border bg-background/85 p-1.5 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
            aria-label="Attach file"
            title="Attach file"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              attachFilesRef.current(files);
            }}
          />
        </>
      )}
    </div>
  );
}
