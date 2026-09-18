"use client";

import { useEffect } from "react";
import { FileText, Workflow } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useApp, useCommands } from "@/lib/plugins/react";
import { formatHotkey } from "@/lib/plugins/hotkeys";
import type { NoteRow } from "./AppSidebar";

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: NoteRow[];
  onSelectNote: (id: string) => void;
}

export function CommandMenu({ open, onOpenChange, notes, onSelectNote }: CommandMenuProps) {
  const app = useApp();
  const commands = useCommands();
  const platform = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "mac" : "other";

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
      <CommandInput placeholder="Search notes or run a command…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Notes">
          {notes.map((note) => (
            <CommandItem
              key={note.id}
              value={note.id}
              keywords={[note.title]}
              onSelect={() => run(() => onSelectNote(note.id))}
            >
              {note.isGraph ? (
                <Workflow data-icon="inline-start" />
              ) : (
                <FileText data-icon="inline-start" />
              )}
              {note.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {commands.map((cmd) => (
            <CommandItem
              key={cmd.fullId}
              value={cmd.name}
              keywords={cmd.keywords}
              onSelect={() => run(() => app.commands.execute(cmd.fullId))}
            >
              {cmd.icon ? <cmd.icon data-icon="inline-start" /> : null}
              {cmd.name}
              {cmd.hotkeys?.[0] ? <CommandShortcut>{formatHotkey(cmd.hotkeys[0], platform)}</CommandShortcut> : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
