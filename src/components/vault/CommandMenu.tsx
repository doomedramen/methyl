"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { defaultFilter } from "cmdk";
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
import { useApp, useCommands } from "@/lib/plugins/react";
import { formatHotkey } from "@/lib/plugins/hotkeys";
import type { NoteRow } from "./AppSidebar";
import type { DocIndexEntry } from "@/lib/core/types";

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: NoteRow[];
  onSelectNote: (id: string) => void;
  searchNotes: (query: string, limit?: number) => DocIndexEntry[];
}

export function CommandMenu({
  open,
  onOpenChange,
  notes,
  onSelectNote,
  searchNotes,
}: CommandMenuProps) {
  const app = useApp();
  const commands = useCommands();
  const platform = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "mac" : "other";
  const [query, setQuery] = useState("");
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setQuery("");
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const visibleNotes = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return notes;
    return searchNotes(trimmed, 50)
      .map((result) => noteById.get(result.id))
      .filter((note): note is NoteRow => note !== undefined);
  }, [noteById, notes, query, searchNotes]);
  const visibleCommands = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return commands;
    return commands.filter((command) => defaultFilter(command.name, trimmed, command.keywords) > 0);
  }, [commands, query]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleOpenChange, open]);

  const run = (fn: () => void) => {
    handleOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange}>
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search note titles or content, or run a command…"
        />
        <CommandList>
          <CommandEmpty>No matching notes or commands.</CommandEmpty>
          {visibleNotes.length > 0 && (
            <CommandGroup heading="Notes">
              {visibleNotes.map((note) => (
                <CommandItem
                  key={note.id}
                  value={note.id}
                  onSelect={() => run(() => onSelectNote(note.id))}
                >
                  {note.isGraph ? (
                    <Workflow data-icon="inline-start" />
                  ) : (
                    <FileText data-icon="inline-start" />
                  )}
                  <span className="min-w-0 truncate">{note.title}</span>
                  <span className="ml-auto max-w-[45%] truncate text-xs text-muted-foreground">
                    {note.path ?? "Notes"}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {visibleCommands.length > 0 && (
            // A border, not a separator: a listbox may only contain options
            // and groups.
            <CommandGroup heading="Actions" className={visibleNotes.length > 0 ? "border-t" : undefined}>
              {visibleCommands.map((cmd) => (
                <CommandItem
                  key={cmd.fullId}
                  value={cmd.name}
                  keywords={cmd.keywords}
                  onSelect={() => run(() => app.commands.execute(cmd.fullId))}
                >
                  {cmd.icon ? <cmd.icon data-icon="inline-start" /> : null}
                  {cmd.name}
                  {cmd.hotkeys?.[0] ? (
                    <CommandShortcut>{formatHotkey(cmd.hotkeys[0], platform)}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
