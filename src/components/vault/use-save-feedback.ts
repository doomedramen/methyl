"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { NoteRow } from "./AppSidebar";

/**
 * Save feedback per document: dirty → saving (only if a persist takes over
 * 250 ms) → saved (shown briefly) → idle, or error with a one-time toast.
 */

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** How long the "Saved" confirmation lingers before hiding. */
const SAVED_VISIBLE_MS = 1500;

export function useSaveFeedback(notes: NoteRow[]) {
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const notesRef = useRef(notes);
  useLayoutEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  const saveErrorShown = useRef(new Set<string>());
  const savingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setDocumentSaveState = useCallback((documentId: string, state: SaveState) => {
    setSaveStates((previous) => ({ ...previous, [documentId]: state }));
  }, []);

  const onPersisting = useCallback((documentId: string) => {
    const existing = savingTimers.current.get(documentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      savingTimers.current.delete(documentId);
      setSaveStates((previous) => {
        if (previous[documentId] !== "dirty" && previous[documentId] !== "error") return previous;
        return { ...previous, [documentId]: "saving" };
      });
    }, 250);
    savingTimers.current.set(documentId, timer);
  }, []);

  const onSaveError = useCallback((documentId: string) => {
    const title = notesRef.current.find((note) => note.id === documentId)?.title ?? "this note";
    if (!saveErrorShown.current.has(documentId)) {
      saveErrorShown.current.add(documentId);
      toast.error(`Changes to “${title}” weren't saved. Copy your text before reloading.`);
    }
    const timer = savingTimers.current.get(documentId);
    if (timer) clearTimeout(timer);
    savingTimers.current.delete(documentId);
    setDocumentSaveState(documentId, "error");
  }, [setDocumentSaveState]);

  const onPersisted = useCallback((documentId: string) => {
    const timer = savingTimers.current.get(documentId);
    if (timer) clearTimeout(timer);
    savingTimers.current.delete(documentId);
    saveErrorShown.current.delete(documentId);
    setDocumentSaveState(documentId, "saved");
    setTimeout(() => {
      setSaveStates((previous) =>
        previous[documentId] === "saved" ? { ...previous, [documentId]: "idle" } : previous,
      );
    }, SAVED_VISIBLE_MS);
  }, [setDocumentSaveState]);

  const onEditorDirtyChange = useCallback((documentId: string, dirty: boolean) => {
    if (!dirty) return;
    setSaveStates((previous) => ({
      ...previous,
      [documentId]: previous[documentId] === "error" ? "error" : "dirty",
    }));
  }, []);

  useEffect(() => {
    const timers = savingTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  return { saveStates, onPersisting, onSaveError, onPersisted, onEditorDirtyChange };
}
