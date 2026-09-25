"use client";

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TreeID } from "loro-crdt";
import { toast } from "sonner";
import type { VaultEngine } from "@/lib/vault/engine";
import type { WorkspaceStore } from "@/lib/workspace/store";
import { emptyGraphMarkdown } from "@/lib/graph/detect";
import { ensureInbox } from "@/lib/vault/inbox";
import type { NoteCreationOptions } from "@/lib/plugins/api";
import type { TemplateDialogMode } from "@/components/plugins/TemplatesDialog";
import type { Template } from "@/plugins/core-templates";
import {
  importObsidianVault,
  type ObsidianImportEntry,
  type ObsidianImportProgress,
  type ObsidianImportReport,
} from "@/lib/vault/obsidian-import";
import type { CreateHandler, CreateRequest } from "./create-actions";

/**
 * Creating things: notes, graphs, folders, a captured thought in Inbox, a
 * note from a template, and an Obsidian import. Each checks the writer lock,
 * opens what it made, persists it and refreshes the sidebar.
 */
export function useCreateActions({
  engine,
  workspaceStore,
  requireWriter,
  refreshNotes,
  onSaveError,
  openDocument,
  setEditorFocusRequest,
}: {
  engine: VaultEngine | null;
  workspaceStore: WorkspaceStore | null;
  requireWriter: () => boolean;
  refreshNotes: (engine: VaultEngine) => void;
  onSaveError: (documentId: string) => void;
  openDocument: (documentId: string) => string;
  setEditorFocusRequest: Dispatch<SetStateAction<{ nonce: number; tabId: string } | null>>;
}) {
  const [capturePending, setCapturePending] = useState(false);
  const [templateDialogMode, setTemplateDialogMode] = useState<TemplateDialogMode | null>(null);
  const [templateParentTreeId, setTemplateParentTreeId] = useState<TreeID | undefined>(undefined);

  const captureInFlight = useRef(false);
  const captureRequestNonce = useRef(0);
  const captureThought = useCallback(async (): Promise<string> => {
    if (captureInFlight.current || !engine || !workspaceStore || !requireWriter()) return "";
    captureInFlight.current = true;
    setCapturePending(true);
    try {
      const inboxId = ensureInbox(engine);
      const doc = engine.createDocument(inboxId, "Untitled.md", "");
      const focused = workspaceStore.getFocusedTab();
      const tabId = workspaceStore.open(
        { kind: "document", documentId: doc.id },
        { mode: focused.resource ? "new" : "replace" },
      );
      setEditorFocusRequest({ nonce: ++captureRequestNonce.current, tabId });
      refreshNotes(engine);
      try {
        await engine.persistTreeIncremental();
        await engine.persistDocumentIncremental(doc.id);
      } catch (error) {
        console.error(error);
        onSaveError(doc.id);
      }
      return doc.id;
    } finally {
      captureInFlight.current = false;
      setCapturePending(false);
    }
  }, [engine, onSaveError, refreshNotes, requireWriter, setEditorFocusRequest, workspaceStore]);

  const createNote = useCallback(
    (parentTreeId?: TreeID, options: NoteCreationOptions = {}): string => {
      if (!engine || !requireWriter()) return "";
      // Tree auto-suffixes on a name clash within the folder (Untitled.md
      // -> Untitled 2.md -> ...), so it's always safe to ask for the same
      // base name.
      const doc = engine.createDocument(parentTreeId, options.name ?? "Untitled.md", options.markdown ?? "");
      openDocument(doc.id);
      void engine.persistTreeIncremental();
      void engine.persistDocumentIncremental(doc.id);
      refreshNotes(engine);
      return doc.id;
    },
    [engine, openDocument, refreshNotes, requireWriter],
  );

  const openTemplates = useCallback((mode: TemplateDialogMode, parentTreeId?: TreeID) => {
    setTemplateParentTreeId(parentTreeId);
    setTemplateDialogMode(mode);
  }, []);

  const onTemplateChosen = useCallback(
    (template: Template) => {
      createNote(templateParentTreeId, { markdown: template.content });
    },
    [createNote, templateParentTreeId],
  );

  const createGraph = useCallback(
    (parentTreeId?: TreeID): string => {
      if (!engine || !requireWriter()) return "";
      const doc = engine.createDocument(parentTreeId, "Untitled Graph.md", emptyGraphMarkdown());
      openDocument(doc.id);
      void engine.persistTreeIncremental();
      void engine.persistDocumentIncremental(doc.id);
      refreshNotes(engine);
      return doc.id;
    },
    [engine, openDocument, refreshNotes, requireWriter],
  );

  const createFolder = useCallback(
    (parentTreeId: TreeID | undefined, name: string): void => {
      if (!engine || !requireWriter()) return;
      try {
        engine.createFolder(parentTreeId, name);
        void engine.persistTreeIncremental();
        refreshNotes(engine);
        toast.success("Folder created");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't create folder");
      }
    },
    [engine, refreshNotes, requireWriter],
  );

  const onCreate = useCallback<CreateHandler>(
    (request: CreateRequest): string => {
      if (request.kind === "template") {
        openTemplates("create", request.parentTreeId);
        return "";
      }
      if (request.kind === "graph") {
        return createGraph(request.parentTreeId);
      }
      if (request.kind === "folder") {
        createFolder(request.parentTreeId, request.name);
        return "";
      }
      return createNote(request.parentTreeId, request.options);
    },
    [createFolder, createGraph, createNote, openTemplates],
  );

  const runObsidianImport = useCallback(
    async (
      entries: ObsidianImportEntry[],
      onProgress: (progress: ObsidianImportProgress) => void,
    ): Promise<ObsidianImportReport> => {
      if (!engine) throw new Error("Vault is not ready");
      if (!requireWriter()) throw new Error("Vault is read-only");
      const report = await importObsidianVault(engine, entries, onProgress);
      refreshNotes(engine);
      return report;
    },
    [engine, refreshNotes, requireWriter],
  );

  const closeTemplates = useCallback(() => {
    setTemplateDialogMode(null);
    setTemplateParentTreeId(undefined);
  }, []);

  return {
    captureThought,
    capturePending,
    onCreate,
    openTemplates,
    onTemplateChosen,
    templateDialogMode,
    setTemplateDialogMode,
    closeTemplates,
    runObsidianImport,
  };
}
