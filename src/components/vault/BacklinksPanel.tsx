"use client";

import { FileText, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { BacklinkEntry } from "@/lib/search/index";
import type { NoteRow } from "./AppSidebar";

interface BacklinksPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTitle: string;
  backlinks: BacklinkEntry[];
  notes: NoteRow[];
  onSelectNote: (id: string) => void;
}

export function BacklinksPanel({
  open,
  onOpenChange,
  currentTitle,
  backlinks,
  notes,
  onSelectNote,
}: BacklinksPanelProps) {
  const noteById = new Map(notes.map((note) => [note.id, note]));

  const selectNote = (id: string) => {
    onSelectNote(id);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 p-0">
        <SheetHeader className="border-b pr-14">
          <SheetTitle>Backlinks</SheetTitle>
          <SheetDescription>Notes linking to “{currentTitle}”.</SheetDescription>
        </SheetHeader>
        {backlinks.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No notes link here yet.</div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 p-2">
              {backlinks.map((backlink) => {
                const note = noteById.get(backlink.from);
                const title = note?.title ?? backlink.fromTitle;
                const Icon = note?.isGraph ? Workflow : FileText;
                return (
                  <Button
                    key={backlink.from}
                    variant="ghost"
                    className="h-auto min-h-11 w-full justify-start gap-3 px-3 py-2.5 text-left"
                    onClick={() => selectNote(backlink.from)}
                  >
                    <Icon aria-hidden="true" className="text-muted-foreground" />
                    <span className="min-w-0 truncate">{title}</span>
                  </Button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
