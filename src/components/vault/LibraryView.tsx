"use client";

import { BookOpen, ChevronRight, FileText, Inbox, Plus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NoteRow } from "./AppSidebar";

export type LibraryCollection = "notes" | "inbox" | "graphs";

export const COLLECTIONS = {
  notes: { title: "All notes", description: "A little space for everything on your mind.", icon: BookOpen },
  inbox: { title: "Inbox", description: "Capture now. Find a home for it later.", icon: Inbox },
  graphs: { title: "Graphs", description: "Make room for the bigger picture.", icon: Workflow },
};

export function isInboxNote(note: NoteRow): boolean {
  const parts = note.path?.split("/") ?? [];
  return parts.length === 2 && parts[0].toLowerCase() === "inbox";
}

export function collectionNotes(notes: NoteRow[], collection: LibraryCollection): NoteRow[] {
  return notes.filter((note) => collection === "notes" || (collection === "graphs" ? note.isGraph : isInboxNote(note)));
}

export function LibraryView({ collection, notes, recentDocumentIds, onOpen, onCreate, onSearch, disabled }: {
  collection: LibraryCollection;
  notes: NoteRow[];
  recentDocumentIds: string[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onSearch: () => void;
  disabled: boolean;
}) {
  const { title, description, icon: Icon } = COLLECTIONS[collection];
  const visibleNotes = collectionNotes(notes, collection);
  const recent = collection === "notes"
    ? recentDocumentIds.flatMap((id) => notes.find((note) => note.id === id) ?? []).slice(0, 3)
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

  return (
    <div className="library-scroll">
      <div className="library-page" key={collection}>
        <div className="library-heading">
          <Icon aria-hidden="true" className={`collection-symbol collection-${collection}`} />
          <h1>{title}</h1>
          <span className="library-count" aria-label={`${visibleNotes.length} ${visibleNotes.length === 1 ? "note" : "notes"}`}>{visibleNotes.length}</span>
        </div>
        <p className="library-description">{description}</p>
        {recent.length > 0 && <NoteGroup title="Recently opened" notes={recent} onOpen={onOpen} />}
        {Array.from(groups, ([folder, entries]) => (
          <NoteGroup key={folder} title={folder} notes={entries} onOpen={onOpen} />
        ))}
        {visibleNotes.length === 0 && (
          <div className="library-empty">
            <div className={`library-empty-symbol collection-${collection}`}><Icon aria-hidden="true" /></div>
            <h2>{collection === "inbox" ? "A clear mind starts here" : collection === "graphs" ? "Connect your ideas" : "Start with a thought"}</h2>
            <p>{collection === "inbox" ? "Drop a thought in your Inbox. You can organise it when you’re ready." : collection === "graphs" ? "Create a graph to map out an idea, a plan, or how things connect." : "A note, a list, an idea you don’t want to lose. It all belongs here."}</p>
          </div>
        )}
        <Button className="library-create" variant="ghost" onClick={onCreate} disabled={disabled}>
          <span className="library-create-plus"><Plus aria-hidden="true" /></span>
          {createLabel}
        </Button>
        <button className="library-footnote" onClick={onSearch}>Looking for something? Search your notes</button>
      </div>
    </div>
  );
}

function NoteGroup({ title, notes, onOpen }: { title: string; notes: NoteRow[]; onOpen: (id: string) => void }) {
  return (
    <section className="library-group" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {notes.map((note) => {
          const Icon = note.isGraph ? Workflow : FileText;
          const location = note.path?.split("/").slice(0, -1).join(" / ");
          return (
            <li key={note.id}>
              <button className="library-note" onClick={() => onOpen(note.id)}>
                <Icon aria-hidden="true" className={note.isGraph ? "collection-graphs" : ""} />
                <span className="library-note-text"><span>{note.title}</span>{location && <small>{location}</small>}</span>
                <ChevronRight aria-hidden="true" className="library-note-chevron" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
