export function newDocumentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const now = BigInt(Date.now());
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/**
 * LEGACY (migration-only). ADHD used to stamp `<!-- adhd:id=... -->` into
 * every Markdown file. Document identity now lives in the sidecar doc index
 * (`@/lib/core/doc-index`) and the vault tree — never inside file content.
 * These helpers exist only to recognise and strip the old comment when
 * reading a file that predates the sidecar index, so `.md` files stay
 * 100% clean (in the editor and on disk) going forward.
 */
export const ADHD_ID_COMMENT_RE = /<!--\s*adhd:id=([0-9a-fA-F-]+)\s*-->\n*/;

/** @deprecated Legacy-only; do not call for new content. See doc-index.ts. */
export function insertIdComment(markdown: string, id: string): string {
  const comment = `<!-- adhd:id=${id} -->`;
  const fm = /^---\n[\s\S]*?\n---\n?/.exec(markdown);
  if (fm) {
    return (
      markdown.slice(0, fm[0].length) +
      comment +
      "\n\n" +
      markdown.slice(fm[0].length)
    );
  }
  return comment + "\n\n" + markdown;
}

export function extractIdFromMarkdown(markdown: string): string | null {
  const m = ADHD_ID_COMMENT_RE.exec(markdown);
  return m ? m[1] : null;
}

export function stripIdComment(markdown: string): string {
  return markdown.replace(ADHD_ID_COMMENT_RE, "");
}