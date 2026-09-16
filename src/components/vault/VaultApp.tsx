"use client";

import { useCallback, useEffect, useState } from "react";
import { parseMarkdown } from "@/lib/core/markdown";
import { stripIdComment } from "@/lib/core/doc-id";
import { NoteEditor } from "@/components/editor/NoteEditor";
import type { VaultEngine } from "@/lib/vault/engine";

interface NoteRow {
  id: string;
  title: string;
}

export function VaultApp() {
  const [engine, setEngine] = useState<VaultEngine | null>(null);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState<"clean" | "dirty" | "saving">("clean");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Dynamic import keeps loro-crdt WASM out of the prerender module graph.
    Promise.all([
      import("@/lib/browser/vault"),
      import("@/lib/vault/engine"),
    ])
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

  const refreshNotes = useCallback(
    (eng: VaultEngine) => {
      const rows: NoteRow[] = [];
      for (const id of eng.tree.documentIds()) {
        const doc = eng.getDocument(id);
        if (!doc) continue;
        const parsed = parseMarkdown(stripIdComment(doc.getMarkdown()), id);
        rows.push({ id, title: parsed.title || id });
      }
      rows.sort((a, b) => a.title.localeCompare(b.title));
      setNotes(rows);
    },
    [],
  );

  const onPersisted = useCallback(() => {
    setSaving("clean");
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-600">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50">
        <header className="border-b border-zinc-200 px-4 py-3">
          <h1 className="text-sm font-semibold tracking-wide text-zinc-700">
            ADHD
          </h1>
          <p className="text-xs text-zinc-400">offline-first vault</p>
        </header>
        <ul className="flex-1 overflow-auto py-2">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => setActiveId(n.id)}
                className={`w-full truncate px-4 py-1.5 text-left text-sm transition-colors ${
                  activeId === n.id
                    ? "bg-blue-100 text-blue-800"
                    : "text-zinc-700 hover:bg-zinc-100"
                }`}
              >
                {n.title}
              </button>
            </li>
          ))}
          {notes.length === 0 && (
            <li className="px-4 py-2 text-xs text-zinc-400">no notes yet</li>
          )}
        </ul>
        <footer className="border-t border-zinc-200 px-4 py-2 text-xs text-zinc-400">
          {saving === "dirty" && "edits pending…"}
          {saving === "saving" && "waiting for lock…"}
          {saving === "clean" && "saved"}
        </footer>
      </aside>

      <main className="min-w-0 flex-1">
        {activeId && engine ? (
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
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            {engine ? "select a note" : "loading vault…"}
          </div>
        )}
      </main>
    </div>
  );
}