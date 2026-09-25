"use client";

import { OPEN_VAULTS_EVENT } from "@/components/vault/VaultSwitcher";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { VaultEngine } from "@/lib/vault/engine";
import { PluginHost } from "@/lib/plugins/host";
import { CommandRegistry } from "@/lib/plugins/commands";
import { vaultPluginStorage } from "@/lib/plugins/vault-storage";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { PluginHostProvider } from "@/lib/plugins/react";
import type { App, NoteContext, NoteCreationOptions } from "@/lib/plugins/api";
import { useSidebar } from "@/components/ui/sidebar";
import { useSync } from "@/lib/browser/sync-context";
import { useTheme } from "next-themes";
import { Archive, Download, FolderInput, Laptop, Library, Puzzle } from "lucide-react";
import { APP_THEMES } from "@/lib/themes";
import { BUNDLED_PLUGINS } from "@/plugins";
import {
  DEFAULT_PLUGIN_FEATURES,
  getPluginFeatures,
  type PluginFeatures,
} from "@/lib/plugins/features";
import type { resolveWikilink, listWikilinkCandidates } from "@/lib/vault/wikilink";
import type { CreateHandler } from "./create-actions";
import { ActiveEditorRegistry } from "@/lib/editor/active-registry";
import { AttachmentPreviewCache } from "@/lib/vault/attachments";
/**
 * Builds the plugin `App` facade and owns the `PluginHost`/`CommandRegistry`
 * for the mounted vault. Rendered inside `SyncProvider`/`SidebarProvider` (not
 * `VaultApp` itself) because `useSidebar`/`useSync` are only valid inside
 * those providers.
 */
export function VaultPluginBridge({
  engine,
  onCreate,
  onCaptureThought,
  onOpenNewFolder,
  onManagePlugins,
  onManageTemplates,
  onOpenTemplatePicker,
  onMoveActiveNote,
  activeNote,
  focusedTabId,
  onOpenNote,
  onNotesChanged,
  readOnly,
  children,
}: {
  engine: VaultEngine | null;
  onCreate: CreateHandler;
  onCaptureThought: () => Promise<string>;
  onOpenNewFolder: () => void;
  /** Opens `PluginsDialog` (Task 11); a no-op until that dialog exists. */
  onManagePlugins?: () => void;
  onManageTemplates?: () => void;
  /** Open "Move to…" for the open note. */
  onMoveActiveNote?: () => void;
  onOpenTemplatePicker?: () => void;
  /** The note in the focused workspace tab. */
  activeNote: NoteContext | null;
  focusedTabId: string | null;
  onOpenNote: (id: string) => void;
  onNotesChanged: () => void;
  /** This tab doesn't hold the writer lock (§12) — block wikilink note creation. */
  readOnly: boolean;
  children: (features: PluginFeatures) => ReactNode;
}) {
  const { toggleSidebar } = useSidebar();
  const { setDialogOpen: setSyncDialogOpen } = useSync();
  const { setTheme } = useTheme();

  const commandRegistry = useMemo(() => new CommandRegistry(), []);
  const fallbackHost = useMemo(() => new PluginHost(makeNoopApp(), new InMemoryPluginStorage()), []);
  const [host, setHost] = useState<PluginHost | null>(null);
  const activeHost = host ?? fallbackHost;
  const [pluginFeatures, setPluginFeatures] = useState<PluginFeatures>(DEFAULT_PLUGIN_FEATURES);

  useEffect(() => {
    const updateFeatures = () => setPluginFeatures(getPluginFeatures(activeHost.getSnapshot()));
    updateFeatures();
    return activeHost.subscribe(updateFeatures);
  }, [activeHost]);

  // `@/lib/vault/wikilink` value-imports `@/lib/vault/engine`, which
  // value-imports `loro-crdt` (WASM) — statically importing it here would
  // pull loro-crdt into the SSR module graph via src/app/page.tsx -> VaultApp
  // and crash the server render (ENOENT on the wasm binary, since the SSR
  // bundle doesn't ship/resolve it the way the client chunk does). Load it
  // dynamically, same as NoteEditor.tsx already does for the same reason.
  const wikilinkModRef = useRef<{
    resolveWikilink: typeof resolveWikilink;
    listWikilinkCandidates: typeof listWikilinkCandidates;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("@/lib/vault/wikilink").then((mod) => {
      if (!cancelled) wikilinkModRef.current = mod;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const notify = useCallback((msg: string, kind?: "info" | "success" | "error") => {
    if (kind === "error") toast.error(msg);
    else if (kind === "success") toast.success(msg);
    else toast(msg);
  }, []);

  // Split panes can mount several CodeMirror views at once. Keep the editor
  // registry separate from the workspace tree: it is a live DOM concern, not
  // persisted vault state.
  const activeEditors = useMemo(() => new ActiveEditorRegistry(), []);
  const attachmentCache = useMemo(
    () => (engine ? new AttachmentPreviewCache(engine) : null),
    [engine],
  );
  useEffect(() => () => attachmentCache?.dispose(), [attachmentCache]);

  const appImpl: App = useMemo<App>(
    () => ({
      commands: {
        list: () => commandRegistry.list(activeNote),
        execute: (fullId) => {
          void commandRegistry.execute(fullId, activeNote, activeEditors.get(focusedTabId), notify);
        },
      },
      workspace: {
        getActiveNote: (): NoteContext | null => activeNote,
        getActiveEditorView: () => activeEditors.get(focusedTabId) ?? activeEditors.getFocused(),
        setActiveEditorView: (view, workspaceTabId) => {
          if (workspaceTabId) activeEditors.set(workspaceTabId, view);
          else if (!view) activeEditors.clear();
        },
        focusEditorTab: (workspaceTabId) => {
          activeEditors.focus(workspaceTabId);
        },
        openNote: (id: string) => onOpenNote(id),
        toggleSidebar: () => toggleSidebar(),
        openDialog: (name: string) => {
          if (name === "sync") {
            setSyncDialogOpen(true);
            return;
          }
          if (name === "plugins") {
            onManagePlugins?.();
            return;
          }
          if (name === "templates") {
            onManageTemplates?.();
            return;
          }
          if (name === "templates:create") {
            onOpenTemplatePicker?.();
            return;
          }
        },
        resolveWikilink: (target: string) =>
          engine && wikilinkModRef.current
            ? wikilinkModRef.current.resolveWikilink(engine.tree, target, activeNote?.documentId ?? "")
            : undefined,
        getWikilinkCandidates: () =>
          engine && wikilinkModRef.current ? wikilinkModRef.current.listWikilinkCandidates(engine.tree) : [],
        resolveAttachment: (target: string, documentId?: string) =>
          attachmentCache?.resolve(target, documentId ?? activeNote?.documentId),
        loadAttachment: (target: string, documentId?: string) =>
          attachmentCache?.load(target, documentId ?? activeNote?.documentId) ?? Promise.resolve(undefined),
        createWikilinkTarget: (target: string) => {
          if (!engine || !wikilinkModRef.current) return;
          if (readOnly) {
            toast.error("This vault is open for editing in another tab.");
            return;
          }
          const parentTreeId = (() => {
            if (!activeNote) return undefined;
            const node = engine.tree.findByDocumentId(activeNote.documentId);
            if (!node) return undefined;
            return engine.tree.tree.getNodeByID(node.treeId)?.parent()?.id;
          })();
          const name = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
          const created = engine.createDocument(parentTreeId, name, "");
          void engine.persistTreeIncremental();
          void engine.persistDocumentIncremental(created.id);
          onNotesChanged();
          toast.success(`Created "${target}"`);
          onOpenNote(created.id);
        },
      },
      vault: {
        createNote: async (options?: NoteCreationOptions) => {
          return (await onCreate({ kind: "note", options })) ?? "";
        },
        captureThought: async () => {
          if (!pluginFeatures.inbox) return "";
          return onCaptureThought();
        },
        createGraph: async () => {
          return (await onCreate({ kind: "graph" })) ?? "";
        },
        createFolder: async (name: string) => {
          if (!name.trim()) {
            onOpenNewFolder();
            return;
          }
          await onCreate({ kind: "folder", name });
        },
        read: async () => null,
        list: () => [],
      },
      notify,
    }),
    [
      activeNote,
      activeEditors,
      attachmentCache,
      commandRegistry,
      engine,
      focusedTabId,
      notify,
      onCreate,
      onCaptureThought,
      pluginFeatures.inbox,
      onManagePlugins,
      onManageTemplates,
      onNotesChanged,
      onOpenNewFolder,
      onOpenNote,
      onOpenTemplatePicker,
      readOnly,
      setSyncDialogOpen,
      toggleSidebar,
    ],
  );

  // Plugins keep the `app` they were constructed with for their whole
  // lifetime, and NoteEditor must not rebuild when it changes — so expose one
  // stable object whose methods always forward to the latest implementation.
  const appImplRef = useRef(appImpl);
  useLayoutEffect(() => {
    appImplRef.current = appImpl;
  }, [appImpl]);
  // The ref is only dereferenced when a plugin calls a method, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [app] = useState(() => forwardingApp(appImplRef));

  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    const newHost = new PluginHost(app, vaultPluginStorage(engine), commandRegistry);
    for (const [manifest, PluginClass] of BUNDLED_PLUGINS) newHost.register(manifest, PluginClass);
    void newHost.enableFromStorage().then(() => {
      if (!cancelled) setHost(newHost);
    });
    return () => {
      cancelled = true;
      // Synchronous: unwinds anything already committed to the shared
      // CommandRegistry/EditorExtensionRegistry and marks in-flight
      // enable() calls (e.g. from StrictMode's double-invoke) to roll back
      // instead of racing a fresh host's registrations (PluginHost.dispose
      // doc comment has the full race).
      newHost.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // Theme switching and "Plugins: Manage" need `next-themes`/dialog state
  // that `src/plugins/**` may not import (ESLint restriction, Task 12), so
  // they're registered here directly against the shared registry under the
  // `core-commands` plugin id rather than inside `CoreCommandsPlugin`.
  useEffect(() => {
    const disposers = [
      commandRegistry.add("core-commands", {
        id: "manage-vaults",
        name: "Vaults: Switch or manage",
        icon: Library,
        keywords: ["vault", "switch", "new vault", "delete vault", "import backup"],
        callback: () => {
          window.dispatchEvent(new Event(OPEN_VAULTS_EVENT));
        },
      }),
      commandRegistry.add("core-commands", {
        id: "export-vault",
        name: "Export vault (Markdown and attachments)",
        icon: Download,
        keywords: ["zip", "download", "portable"],
        callback: () => void downloadVaultExport("portable"),
      }),
      commandRegistry.add("core-commands", {
        id: "export-backup",
        name: "Export full backup",
        icon: Archive,
        keywords: ["zip", "download", "history", "restore"],
        callback: () => void downloadVaultExport("full"),
      }),
      commandRegistry.add("core-commands", {
        id: "move-note",
        name: "Note: Move to…",
        icon: FolderInput,
        keywords: ["move", "folder", "file"],
        callback: () => onMoveActiveNote?.(),
      }),
      commandRegistry.add("core-commands", {
        id: "manage-plugins",
        name: "Plugins: Manage",
        icon: Puzzle,
        callback: () => onManagePlugins?.(),
      }),
      ...APP_THEMES.map(({ id, label, icon }) =>
        commandRegistry.add("core-commands", {
          id: `theme-${id}`,
          name: `Theme: ${label}`,
          icon,
          callback: () => setTheme(id),
        }),
      ),
      commandRegistry.add("core-commands", {
        id: "theme-system",
        name: "Theme: System",
        icon: Laptop,
        callback: () => setTheme("system"),
      }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [commandRegistry, onManagePlugins, onMoveActiveNote, setTheme]);

  // Dispatch registered command hotkeys (Command.hotkeys, via
  // PluginHost.hotkeys) globally. ⌘K itself stays hard-wired inside
  // CommandMenu.tsx (spec §2) and is never registered as a default here, so
  // there's no collision. Plain text inputs (search boxes, dialogs) opt out
  // so typing isn't hijacked; the CodeMirror editor's own contenteditable
  // host is NOT excluded, since editorCallback commands need to fire while
  // the editor has focus too — app.commands.execute already threads the
  // active EditorView through (see setActiveEditorView above) so a matched
  // editorCallback command still gets a real (EditorView, NoteContext) pair
  // without a separate CodeMirror-level keymap.
  useEffect(() => {
    if (!host) return;
    const platform = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "mac" : "other";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const matches = host.hotkeys.handleKeydown(e, platform);
      if (matches.length === 0) return;
      e.preventDefault();
      for (const fullId of matches) app.commands.execute(fullId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [host, app]);

  return (
    <PluginHostProvider host={host ?? fallbackHost} commands={commandRegistry} app={app} activeNote={activeNote}>
      {children(pluginFeatures)}
    </PluginHostProvider>
  );
}

/**
 * Build a vault export (SPEC §40) and hand it to the browser as a download.
 * "portable" is the notes and attachments; "full" adds the `.methyl/`
 * metadata so a restore keeps note identity and history.
 */
async function downloadVaultExport(mode: "portable" | "full"): Promise<void> {
  const pending = toast.loading(mode === "full" ? "Preparing full backup…" : "Preparing export…");
  try {
    const [{ exportVaultZip, exportFileName }, { getVaultFileSystem }] = await Promise.all([
      import("@/lib/vault/export"),
      import("@/lib/browser/vault"),
    ]);
    const blob = await exportVaultZip(getVaultFileSystem(), mode);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFileName(mode);
    anchor.click();
    // Give the download a moment to start before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast.success(mode === "full" ? "Full backup downloaded" : "Vault exported", { id: pending });
  } catch (error) {
    console.error("[export] failed", error);
    toast.error("Export failed — see the console for details", { id: pending });
  }
}

/**
 * An `App` whose every namespace method delegates to `latest.current` at
 * call time. Exported for the identity-stability regression test (Task A1,
 * docs/superpowers/plans/2026-09-18-plugins-roadmap.md) — VaultPluginBridge
 * hands one of these to `PluginHostProvider` and keeps `latest` pointed at
 * the freshly rebuilt `appImpl` on every render, so `useApp()`'s return
 * value never changes identity even though what it delegates to does.
 */
export function forwardingApp(latest: { readonly current: App }): App {
  const get = () => latest.current;
  const ns = <K extends "commands" | "workspace" | "vault">(key: K): App[K] =>
    new Proxy({} as App[K], {
      get: (_t, prop) => {
        const target = get()[key] as Record<PropertyKey, unknown>;
        const value = target[prop];
        return typeof value === "function"
          ? (...args: unknown[]) => (get()[key] as Record<PropertyKey, (...a: unknown[]) => unknown>)[prop](...args)
          : value;
      },
      has: (_t, prop) => prop in (get()[key] as object),
    });
  return {
    commands: ns("commands"),
    workspace: ns("workspace"),
    vault: ns("vault"),
    notify: (...args) => get().notify(...args),
  };
}

function makeNoopApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: { getActiveNote: () => null, openNote: () => {}, toggleSidebar: () => {}, openDialog: () => {} },
    vault: {
      createNote: async () => "",
      createGraph: async () => "",
      createFolder: async () => {},
      read: async () => null,
      list: () => [],
    },
    notify: () => {},
  };
}
