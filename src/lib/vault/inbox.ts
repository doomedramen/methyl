import type { TreeID } from "loro-crdt";
import type { Document } from "@/lib/core/document";
import type { VaultEngine } from "@/lib/vault/engine";

/** Top-level folder every OS capture path (share, open-with, shortcuts) lands in. */
export const INBOX_FOLDER_NAME = "Inbox";

/**
 * Find the top-level `Inbox` folder, creating it if it doesn't exist yet.
 * Matches case-insensitively against existing root directories so a vault
 * that already has an "inbox" folder (however capitalized) is reused
 * rather than duplicated. Does not persist — call
 * `engine.persistTreeIncremental()` after, same as `createFolder`.
 */
export function ensureInbox(engine: VaultEngine): TreeID {
  const existing = engine.tree
    .roots()
    .find((n) => n.kind === "directory" && n.name.toLowerCase() === INBOX_FOLDER_NAME.toLowerCase());
  if (existing) return existing.treeId;
  return engine.createFolder(undefined, INBOX_FOLDER_NAME);
}

/**
 * Create a Markdown note in the `Inbox` folder (creating the folder if
 * needed) and persist both the tree and the document. Used by every OS
 * capture entry point (share target, file handler, `?action=` shortcuts)
 * so captured content always lands somewhere visible and predictable
 * rather than at the vault root.
 */
export async function captureToInbox(
  engine: VaultEngine,
  name: string,
  markdown: string,
): Promise<Document> {
  const inboxId = ensureInbox(engine);
  const doc = engine.createDocument(inboxId, name, markdown);
  await engine.persistTreeIncremental();
  await engine.persistDocumentIncremental(doc.id);
  return doc;
}
