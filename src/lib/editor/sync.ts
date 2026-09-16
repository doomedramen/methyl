import {
  type LoroDoc,
  type LoroText,
  EphemeralStore,
  UndoManager,
  type Value,
} from "loro-crdt";
import { getCursorEphemeralKey, getUserEphemeralKey } from "loro-codemirror";
import { CONTENT_KEY } from "@/lib/core/document";

export { getCursorEphemeralKey, getUserEphemeralKey };

/**
 * Our docs keep markdown under the `content` root container (§7).
 * loro-codemirror defaults to a "codemirror" container, so every binding
 * must pass this adapter explicitly.
 */
export function getContentTextFromDoc(doc: LoroDoc): LoroText {
  return doc.getText(CONTENT_KEY);
}

export function createUndoManager(doc: LoroDoc): UndoManager {
  return new UndoManager(doc, {
    maxUndoSteps: 200,
    mergeInterval: 1000,
  });
}

export function createCursorEphemeral(timeoutMs = 10_000): EphemeralStore {
  return new EphemeralStore(timeoutMs);
}

/** Same shape loro-codemirror's presence layer expects for UserState. */
export interface EditorUser extends Record<string, Value> {
  name: string;
  colorClassName: string;
}

export interface EphemeralCursor {
  anchor: number;
  head?: number;
}

/**
 * Record this peer's cursor + user into the ephemeral store and return the
 * encoded payloads to ship over the sync channel. The store is shared with
 * the editor's presence layer; the sync client only relays bytes.
 */
export function encodePeerEphemeral(
  doc: LoroDoc,
  ephemeral: EphemeralStore,
  cursor: EphemeralCursor | null,
  user: EditorUser,
): Uint8Array[] {
  if (cursor) {
    ephemeral.set(getCursorEphemeralKey(doc), { type: "cursor", ...cursor });
  }
  ephemeral.set(getUserEphemeralKey(doc), { type: "user", ...user });
  return [
    ephemeral.encode(getCursorEphemeralKey(doc)),
    ephemeral.encode(getUserEphemeralKey(doc)),
  ];
}

/** Apply remote peers' ephemeral payloads from the sync channel. */
export function applyPeerEphemeral(
  ephemeral: EphemeralStore,
  bytes: Uint8Array[],
): void {
  for (const b of bytes) ephemeral.apply(b);
}