"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { FileText, FolderPlus, Laptop, Moon, PanelLeft, Plus, Sun } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useSidebar } from "@/components/ui/sidebar";
import type { NoteRow } from "./AppSidebar";

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: NoteRow[];
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
  onCreateFolder: () => void;
}

export function CommandMenu({
  open,
  onOpenChange,
  notes,
  onSelectNote,
  onCreateNote,
  onCreateFolder,
}: CommandMenuProps) {
  const { setTheme } = useTheme();
  const { toggleSidebar } = useSidebar();

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
              <FileText data-icon="inline-start" />
              {note.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="New note" onSelect={() => run(onCreateNote)}>
            <Plus data-icon="inline-start" />
            New note
          </CommandItem>
          <CommandItem value="New folder" onSelect={() => run(onCreateFolder)}>
            <FolderPlus data-icon="inline-start" />
            New folder
          </CommandItem>
          <CommandItem
            value="Toggle sidebar"
            onSelect={() => run(toggleSidebar)}
          >
            <PanelLeft data-icon="inline-start" />
            Toggle sidebar
          </CommandItem>
          <CommandItem
            value="Theme: Light"
            onSelect={() => run(() => setTheme("light"))}
          >
            <Sun data-icon="inline-start" />
            Theme: Light
          </CommandItem>
          <CommandItem
            value="Theme: Dark"
            onSelect={() => run(() => setTheme("dark"))}
          >
            <Moon data-icon="inline-start" />
            Theme: Dark
          </CommandItem>
          <CommandItem
            value="Theme: System"
            onSelect={() => run(() => setTheme("system"))}
          >
            <Laptop data-icon="inline-start" />
            Theme: System
          </CommandItem>
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
