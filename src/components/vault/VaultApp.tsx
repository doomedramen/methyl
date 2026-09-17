"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeID } from "loro-crdt";
import { Check, Inbox, Plus, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { VaultTree, VaultTreeNode } from "@/lib/vault/tree";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { AppSidebar, type FolderRow, type NoteRow, type SidebarRow } from "./AppSidebar";
import { CommandMenu } from "./CommandMenu";
import { ModeToggle } from "@/components/mode-toggle";
import type { VaultEngine } from "@/lib/vault/engine";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const SAVE_LABEL: Record<Exclude<SaveState, "idle">, string> = {
  dirty: "Editing…",
  saving: "Saving…",
  saved: "Saved",
  error: "Not saved",
};

/** How long the "Saved" confirmation lingers before hiding. */
const SAVED_VISIBLE_MS = 2000;

/**
 * Build the nested folder/note tree for the sidebar, in stored tree order.
 * The displayed title is always the tree node's file name (minus `.md`) —
 * never frontmatter `title:` or an `# H1` in the body. Those can be edited
 * or deleted freely without the note vanishing or being relabeled out from
 * under the user; only a rename (which renames the file) changes the title.
 */
function toRow(node: VaultTreeNode, tree: VaultTree): SidebarRow {
  if (node.kind === "directory") {
    return {
      treeId: node.treeId,
      kind: "directory",
      name: node.name,
      children: tree.children(node.treeId).map((child) => toRow(child, tree)),
    };
  }
  return {
    treeId: node.treeId,
    kind: "markdown",
    id: node.documentId ?? node.treeId,
    title: node.name.replace(/\.md$/i, ""),
  };
}

function buildRootRows(tree: VaultTree): SidebarRow[] {
  return tree.roots().map((node) => toRow(node, tree));
}

function flattenNotes(rows: SidebarRow[]): NoteRow[] {
  const out: NoteRow[] = [];
  for (const row of rows) {
    if (row.kind === "markdown") out.push(row);
    else out.push(...flattenNotes(row.children));
  }
  return out;
}

function findFolder(rows: SidebarRow[], treeId: TreeID): FolderRow | undefined {
  for (const row of rows) {
    if (row.kind === "directory") {
      if (row.treeId === treeId) return row;
      const found = findFolder(row.children, treeId);
      if (found) return found;
    }
  }
  return undefined;
}

export function VaultApp() {
  const [engine, setEngine] = useState<VaultEngine | null>(null);
  const [rows, setRows] = useState<SidebarRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);

  const refreshNotes = useCallback((eng: VaultEngine) => {
    setRows(buildRootRows(eng.tree));
  }, []);

  const notes = useMemo(() => flattenNotes(rows), [rows]);

  useEffect(() => {
    let cancelled = false;
    // Dynamic import keeps loro-crdt WASM out of the prerender module graph.
    Promise.all([import("@/lib/browser/vault"), import("@/lib/vault/engine")])
      .then(async ([{ getVault }]) => {
        const eng = await getVault();
        if (cancelled) return;
        setEngine(eng);
        refreshNotes(eng);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNotes]);

  const saveErrorShown = useRef(false);
  const onSaveError = useCallback(() => {
    if (!saveErrorShown.current) {
      saveErrorShown.current = true;
      toast.error("Changes to this note weren't saved. Copy your text before reloading.");
    }
    setSaving("error");
  }, []);

  // Only confirm a save that followed an edit; persists on open stay silent.
  const onPersisted = useCallback(() => {
    setSaving((prev) => (prev === "idle" ? prev : "saved"));
  }, []);

  useEffect(() => {
    if (saving !== "saved") return;
    const t = setTimeout(() => setSaving("idle"), SAVED_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [saving]);

  useEffect(() => {
    setSaving("idle");
    saveErrorShown.current = false;
  }, [activeId]);

  const onCreateNote = useCallback(
    (parentTreeId?: TreeID) => {
      if (!engine) return;
      // Tree auto-suffixes on a name clash within the folder (Untitled.md
      // -> Untitled 2.md -> ...), so it's always safe to ask for the same
      // base name.
      const doc = engine.createDocument(parentTreeId, "Untitled.md", "");
      setActiveId(doc.id);
      void engine.persistTreeIncremental();
      void engine.persistDocumentIncremental(doc.id);
      refreshNotes(engine);
    },
    [engine, refreshNotes],
  );

  const onCreateFolder = useCallback(
    (parentTreeId: TreeID | undefined, name: string) => {
      if (!engine) return;
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
    [engine, refreshNotes],
  );

  const onRenameNote = useCallback(
    async (id: string, title: string) => {
      if (!engine) return;
      try {
        // Renames the file only (tree node name) — content is never
        // touched, so the note can't be orphaned by editing its heading.
        await engine.renameDocument(id, title);
        await engine.persistTreeIncremental();
        refreshNotes(engine);
        toast.success("Note renamed");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't rename note");
      }
    },
    [engine, refreshNotes],
  );

  const onDeleteNote = useCallback(
    async (id: string) => {
      if (!engine) return;
      try {
        await engine.deleteDocument(id);
        setActiveId((cur) => (cur === id ? null : cur));
        refreshNotes(engine);
        toast.success("Note deleted");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't delete note");
      }
    },
    [engine, refreshNotes],
  );

  const onRenameFolder = useCallback(
    async (treeId: TreeID, name: string) => {
      if (!engine) return;
      try {
        await engine.renameFolder(treeId, name);
        await engine.persistTreeIncremental();
        refreshNotes(engine);
        toast.success("Folder renamed");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't rename folder");
      }
    },
    [engine, refreshNotes],
  );

  const onDeleteFolder = useCallback(
    async (treeId: TreeID) => {
      if (!engine) return;
      try {
        const folder = findFolder(rows, treeId);
        const containedIds = folder ? flattenNotes([folder]).map((n) => n.id) : [];
        await engine.deleteFolder(treeId);
        setActiveId((cur) => (cur && containedIds.includes(cur) ? null : cur));
        refreshNotes(engine);
        toast.success("Folder deleted");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't delete folder");
      }
    },
    [engine, refreshNotes, rows],
  );

  const onMove = useCallback(
    async ({ treeId, newParent, index }: { treeId: TreeID; newParent: TreeID | undefined; index: number }) => {
      if (!engine) return;
      try {
        await engine.moveNode(treeId, newParent, index);
        await engine.persistTreeIncremental();
        refreshNotes(engine);
      } catch (e) {
        console.error(e);
        toast.error("Couldn't move item");
      }
    },
    [engine, refreshNotes],
  );

  const activeNote = notes.find((n) => n.id === activeId);
  const activeTitle = activeNote?.title ?? (engine ? null : "Loading…");

  return (
    <SidebarProvider className="h-full">
      <AppSidebar
        rows={rows}
        activeId={activeId}
        onCreate={onCreateNote}
        onCreateFolder={onCreateFolder}
        onSelect={setActiveId}
        onRenameNote={onRenameNote}
        onDeleteNote={onDeleteNote}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        onMove={onMove}
        onOpenCommandMenu={() => setCommandOpen(true)}
        newFolderOpen={newFolderOpen}
        onNewFolderOpenChange={setNewFolderOpen}
      />
      <SidebarInset className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
          <SidebarTrigger className="size-10 md:size-8" />
          <Separator orientation="vertical" className="h-5" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {activeTitle ? (
                <>
                  <BreadcrumbItem>
                    <BreadcrumbLink
                      render={<button type="button" onClick={() => setActiveId(null)} />}
                    >
                      Vault
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate" aria-live="polite">
                      {activeTitle}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              ) : (
                <BreadcrumbItem>
                  <BreadcrumbPage>Vault</BreadcrumbPage>
                </BreadcrumbItem>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex items-center gap-2">
            <span aria-live="polite" className="contents">
              {activeId && saving !== "idle" && (
                <Badge
                  variant={
                    saving === "saved" ? "secondary" : saving === "error" ? "destructive" : "outline"
                  }
                  className="animate-in fade-in-0 motion-reduce:animate-none"
                >
                  {saving === "saving" ? (
                    <Spinner data-icon="inline-start" />
                  ) : saving === "saved" ? (
                    <Check data-icon="inline-start" />
                  ) : saving === "error" ? (
                    <TriangleAlert data-icon="inline-start" />
                  ) : null}
                  {SAVE_LABEL[saving]}
                </Badge>
              )}
            </span>
            <ModeToggle />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-lg"
                    onClick={() => onCreateNote()}
                    aria-label="New note"
                    className="size-10 md:size-9"
                  >
                    <Plus />
                  </Button>
                }
              />
              <TooltipContent>New note</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <main className="min-h-0 flex-1">
          {error ? (
            <VaultError message={error} />
          ) : !engine ? (
            <VaultLoading />
          ) : activeId ? (
            <NoteEditor
              engine={engine}
              documentId={activeId}
              onDirtyChange={(dirty) =>
                setSaving((prev) =>
                  // Keep the error visible until a verified save clears it.
                  prev === "error" ? prev : dirty ? "dirty" : prev === "dirty" ? "saving" : prev,
                )
              }
              onPersisted={onPersisted}
              onSaveError={onSaveError}
            />
          ) : (
            <VaultEmpty onCreate={onCreateNote} />
          )}
        </main>
      </SidebarInset>

      {engine && (
        <CommandMenu
          open={commandOpen}
          onOpenChange={setCommandOpen}
          notes={notes}
          onSelectNote={setActiveId}
          onCreateNote={() => onCreateNote()}
          onCreateFolder={() => setNewFolderOpen(true)}
        />
      )}
    </SidebarProvider>
  );
}

function VaultLoading() {
  return (
    <div className="space-y-3 p-4">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

function VaultEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <Inbox />
      </EmptyMedia>
      <EmptyTitle>Nothing open</EmptyTitle>
      <Button size="lg" onClick={onCreate}>
        <Plus data-icon="inline-start" />
        New note
      </Button>
    </Empty>
  );
}

function VaultError({ message }: { message: string }) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <TriangleAlert className="text-destructive" />
      </EmptyMedia>
      <EmptyTitle>Could not open the vault</EmptyTitle>
      <EmptyDescription className="break-words">{message}</EmptyDescription>
      <Button
        variant="outline"
        size="lg"
        onClick={() => typeof window !== "undefined" && window.location.reload()}
      >
        Reload
      </Button>
    </Empty>
  );
}
