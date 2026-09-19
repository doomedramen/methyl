"use client";

import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { RenameNoteDialog } from "./NoteActions";
import type { NoteRow } from "./AppSidebar";

/** Stable wrapper: changing the filename must not remount the live editor. */
export function NoteSurface({ note, readOnly, onRename, children }: {
  note: NoteRow;
  readOnly: boolean;
  onRename: (id: string, title: string) => Promise<void>;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  const folder = note.path?.split("/").slice(0, -1).join(" / ") || "Notes";
  return (
    <div className="note-surface">
      <div className="note-heading">
        <p>{folder}</p>
        <h1><button className="note-title" onClick={() => setRenaming(true)} disabled={readOnly} aria-label={`Rename ${note.title}`} title="Rename note">
          <span>{note.title}</span><Pencil aria-hidden="true" />
        </button></h1>
      </div>
      <div className="note-writing">{children}</div>
      {renaming && <RenameNoteDialog open={renaming} onOpenChange={setRenaming} currentTitle={note.title} onRename={(title) => onRename(note.id, title)} />}
    </div>
  );
}
