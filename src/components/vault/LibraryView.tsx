"use client";

import { BookOpen, FileText, Inbox, Plus, Workflow } from "lucide-react";
import type { WorkspaceCollection, WorkspaceOpenMode } from "@/lib/workspace/store";
import { Button } from "@/components/ui/button";
import type { NoteRow } from "./AppSidebar";

export type LibraryCollection = WorkspaceCollection;

export const COLLECTIONS = {
  notes: { title: "All notes", icon: BookOpen },
  inbox: { title: "Inbox", icon: Inbox },
  graphs: { title: "Graphs", icon: Workflow },
} satisfies Record<LibraryCollection, { title: string; icon: typeof BookOpen }>;

const EMPTY_STATES: Record<LibraryCollection, { title: string; description: string }> = {
  notes: { title: "No notes yet", description: "Write a thought to get started." },
  inbox: { title: "Your Inbox is empty", description: "Capture a thought here whenever you need to." },
  graphs: { title: "No graphs yet", description: "Connect ideas on a canvas." },
};

export function isInboxNote(note: NoteRow): boolean {
  const parts = note.path?.split("/") ?? [];
  return parts.length === 2 && parts[0]?.toLowerCase() === "inbox";
}

export function collectionNotes(notes: NoteRow[], collection: LibraryCollection): NoteRow[] {
  return notes.filter((note) =>
    collection === "notes" || (collection === "graphs" ? note.isGraph : isInboxNote(note)),
  );
}

export function LibraryView({
  collection,
  notes,
  recentDocumentIds,
  onOpen,
  onCreate,
  disabled,
}: {
  collection: LibraryCollection;
  notes: NoteRow[];
  recentDocumentIds: string[];
  onOpen: (id: string, mode: WorkspaceOpenMode) => void;
  onCreate: () => void;
  disabled: boolean;
}) {
  const { title, icon: Icon } = COLLECTIONS[collection];
  const visibleNotes = collectionNotes(notes, collection);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const recent = collection === "notes"
    ? recentDocumentIds
      .map((id) => noteById.get(id))
      .filter((note): note is NoteRow => note !== undefined)
      .filter((note, index, list) => list.findIndex((candidate) => candidate.id === note.id) === index)
      .slice(0, 3)
    : [];
  const recentIds = new Set(recent.map((note) => note.id));
  const groups = new Map<string, NoteRow[]>();
  for (const note of visibleNotes) {
    if (recentIds.has(note.id)) continue;
    const folder = note.path?.split("/").slice(0, -1).join(" / ") || "Notes";
    const group = groups.get(folder) ?? [];
    group.push(note);
    groups.set(folder, group);
  }
  const createLabel = collection === "graphs" ? "New graph" : "New note";
  const emptyState = EMPTY_STATES[collection];

  return (
    <div className="library-scroll">
      <div className="library-page">
        <div className="library-heading">
          <Icon aria-hidden="true" className={`collection-symbol collection-${collection}`} />
          <h1>{title}</h1>
        </div>
        {recent.length > 0 && (
          <NoteGroup title="Recently opened" notes={recent} showLocation onOpen={onOpen} />
        )}
        {Array.from(groups, ([folder, entries]) => (
          <NoteGroup key={folder} title={folder} notes={entries} onOpen={onOpen} />
        ))}
        {visibleNotes.length === 0 && (
          <div className="library-empty">
            <h2>{emptyState.title}</h2>
            <p>{emptyState.description}</p>
          </div>
        )}
        <Button className="library-create" variant="ghost" onClick={onCreate} disabled={disabled}>
          <span className="library-create-plus"><Plus aria-hidden="true" /></span>
          {createLabel}
        </Button>
      </div>
    </div>
  );
}

function NoteGroup({
  title,
  notes,
  showLocation = false,
  onOpen,
}: {
  title: string;
  notes: NoteRow[];
  showLocation?: boolean;
  onOpen: (id: string, mode: WorkspaceOpenMode) => void;
}) {
  return (
    <section className="library-group" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {notes.map((note) => {
          const Icon = note.isGraph ? Workflow : FileText;
          const location = note.path?.split("/").slice(0, -1).join(" / ") || "Notes";
          return (
            <li key={note.id}>
              <button
                className="library-note"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    onOpen(note.id, "new");
                  }
                }}
                onClick={(event) =>
                  onOpen(note.id, event.metaKey || event.ctrlKey ? "new" : "replace")
                }
                title={showLocation ? `${note.title} — ${location}` : note.title}
              >
                <Icon aria-hidden="true" className={note.isGraph ? "collection-graphs" : ""} />
                <span className="library-note-text">
                  <span>{note.title}</span>
                  {showLocation && <small>{location}</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
