import { sanitizeName } from "@/lib/core/paths";

/**
 * The share target only ever hands us plain strings — see the SW's `/share`
 * route (src/app/sw.ts's registerRoute) and its `share-pending` stash — so
 * a shared file's bytes are already decoded to text before this runs.
 * Binary shares (images, PDFs) aren't supported: the manifest's
 * `share_target.params.files.accept` only lists Markdown/plain-text types.
 */
export interface ShareFilePayload {
  name: string;
  content: string;
}

export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
  files?: ShareFilePayload[];
}

/** One note to create in the Inbox for a captured share. */
export interface ShareCapture {
  name: string;
  markdown: string;
}

const FALLBACK_NAME = "Shared note.md";

function asMdName(name: string): string {
  const safe = sanitizeName(name) ?? "Shared file";
  return safe.toLowerCase().endsWith(".md") ? safe : `${safe.replace(/\.[^.]*$/, "")}.md`;
}

/**
 * Turn a share_target payload into the note(s) to create in Inbox. Shared
 * files win over title/text/url — the OS share sheet doesn't let a share
 * carry both at once in practice, but if it did, dropping the file
 * contents on the floor would be the surprising choice. Each shared file
 * becomes its own note; a plain text/link share becomes exactly one.
 *
 * Pure and synchronous so it's unit-testable without a ServiceWorker or a
 * VaultEngine — src/lib/vault/inbox.ts's captureToInbox() does the actual
 * writing, once per returned capture.
 */
export function shareToCaptures(payload: SharePayload): ShareCapture[] {
  if (payload.files && payload.files.length > 0) {
    return payload.files.map((f) => ({ name: asMdName(f.name), markdown: f.content }));
  }

  const title = payload.title?.trim();
  const body = [payload.text?.trim(), payload.url?.trim()].filter(Boolean).join("\n\n");
  const markdown = [title ? `# ${title}` : null, body || null].filter(Boolean).join("\n\n");
  const name = title ? asMdName(title) : FALLBACK_NAME;
  return [{ name, markdown }];
}
