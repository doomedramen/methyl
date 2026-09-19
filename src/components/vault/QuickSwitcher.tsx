"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Workflow } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { rankQuickSwitcher } from "@/lib/workspace/quick-switcher";
import type { NoteRow } from "./AppSidebar";
import type { CreateHandler } from "./create-actions";
import type { WorkspaceOpenMode } from "@/lib/workspace/store";

interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: NoteRow[];
  recentDocumentIds: string[];
  onOpenNote: (id: string, mode?: WorkspaceOpenMode) => void;
  onCreate: CreateHandler;
}

export function QuickSwitcher({
  open,
  onOpenChange,
  notes,
  recentDocumentIds,
  onOpenNote,
  onCreate,
}: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const keyboardMode = useRef<WorkspaceOpenMode>("replace");
  const platform = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "mac" : "other";

  const entries = useMemo(
    () => notes.map((note) => ({ id: note.id, title: note.title, path: note.path ?? note.title, isGraph: note.isGraph })),
    [notes],
  );
  const results = useMemo(
    () => rankQuickSwitcher(entries, query, recentDocumentIds),
    [entries, query, recentDocumentIds],
  );

  const close = useCallback(() => {
    setQuery("");
    keyboardMode.current = "replace";
    onOpenChange(false);
  }, [onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setQuery("");
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "o" || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      handleOpenChange(!open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleOpenChange, open]);

  const select = (id: string, mode = keyboardMode.current) => {
    close();
    onOpenNote(id, mode);
  };

  const createFromQuery = () => {
    const title = query.trim();
    if (!title) return;
    close();
    const name = title.toLowerCase().endsWith(".md") ? title : `${title}.md`;
    onCreate({ kind: "note", options: { name } });
  };

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange} title="Quick Switcher" description="Open a note by title or path">
      <Command
        onKeyDown={(event) => {
          if (event.key === "Enter") keyboardMode.current = event.metaKey || event.ctrlKey ? "new" : "replace";
        }}
        shouldFilter={false}
      >
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search notes by title or path…"
          aria-label="Search notes by title or path"
        />
        <CommandList>
          {results.length === 0 && query.trim() ? (
            <CommandEmpty>
              <button type="button" className="text-primary underline underline-offset-4" onClick={createFromQuery}>
                Create “{query.trim()}”
              </button>
            </CommandEmpty>
          ) : null}
          {results.length > 0 ? (
            <CommandGroup heading="Notes">
              {results.map((entry) => {
                const Icon = entry.isGraph ? Workflow : FileText;
                return (
                  <CommandItem key={entry.id} value={entry.id} onSelect={() => select(entry.id)}>
                    <Icon data-icon="inline-start" />
                    <span className="min-w-0 truncate">{entry.title}</span>
                    <span className="ml-auto max-w-[45%] truncate text-xs text-muted-foreground">{entry.path}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}
          <CommandShortcut className="px-2 pb-1">
            {platform === "mac" ? "⌘↵" : "Ctrl+Enter"} opens in a new tab
          </CommandShortcut>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
