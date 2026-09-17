"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, Plus, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { parseMarkdown } from "@/lib/core/markdown";
import { stripIdComment } from "@/lib/core/doc-id";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { AppSidebar, type NoteRow } from "./AppSidebar";
import type { VaultEngine } from "@/lib/vault/engine";

const SAVE_LABEL: Record<"clean" | "dirty" | "saving", string> = {
  clean: "Saved",
  dirty: "Editing…",
  saving: "Saving…",
};

export function VaultApp() {
  const [engine, setEngine] = useState<VaultEngine | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState<"clean" | "dirty" | "saving">("clean");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Dynamic import keeps loro-crdt WASM out of the prerender module graph.
    Promise.all([import("@/lib/browser/vault"), import("@/lib/vault/engine")])
      .then(async ([{ getVault }, engineMod]) => {
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
  }, []);

  const refreshNotes = useCallback((eng: VaultEngine) => {
    const rows: NoteRow[] = [];
    for (const id of eng.tree.documentIds()) {
      const doc = eng.getDocument(id);
      if (!doc) continue;
      const parsed = parseMarkdown(stripIdComment(doc.getMarkdown()), id);
      rows.push({ id, title: parsed.title || id });
    }
    rows.sort((a, b) => a.title.localeCompare(b.title));
    setNotes(rows);
  }, []);

  const onPersisted = useCallback(() => {
    setSaving("clean");
  }, []);

  const onCreateNote = useCallback(() => {
    if (!engine) return;
    const name = `note-${new Date().toISOString().slice(5, 16).replace("T", "-")}`;
    const doc = engine.createDocument(undefined, name, `# ${name}`);
    setActiveId(doc.id);
    refreshNotes(engine);
  }, [engine, refreshNotes]);

  const activeTitle =
    notes.find((n) => n.id === activeId)?.title ?? (engine ? "ADHD" : "Loading…");

  return (
    <SidebarProvider className="h-full">
      <AppSidebar
        notes={notes}
        activeId={activeId}
        onCreate={onCreateNote}
        onSelect={setActiveId}
      />
      <SidebarInset className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
          <SidebarTrigger className="size-10 md:size-8" />
          <h1 className="min-w-0 truncate text-sm font-medium" aria-live="polite">
            {activeTitle}
          </h1>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs text-muted-foreground",
              )}
              aria-live="polite"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  saving === "clean"
                    ? "bg-emerald-500"
                    : saving === "saving"
                      ? "bg-blue-500 animate-pulse"
                      : "bg-amber-500",
                )}
                aria-hidden
              />
              {SAVE_LABEL[saving]}
            </span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-lg"
                      onClick={onCreateNote}
                      aria-label="New note"
                      className="size-10 md:size-9"
                    >
                      <Plus />
                    </Button>
                  }
                />
                <TooltipContent>New note</TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
                  dirty ? "dirty" : prev === "dirty" ? "saving" : prev,
                )
              }
              onPersisted={onPersisted}
            />
          ) : (
            <VaultEmpty onCreate={onCreateNote} />
          )}
        </main>
      </SidebarInset>
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
      <EmptyDescription>
        Pick a note from the list, or capture the thought that just surfaced.
      </EmptyDescription>
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