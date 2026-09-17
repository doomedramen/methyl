import { LoroDoc, LoroText, type OpId } from "loro-crdt";
import {
  ADHD_ID_COMMENT_RE,
  extractIdFromMarkdown,
  stripIdComment,
} from "@/lib/core/doc-id";

export const CONTENT_KEY = "content";

export class Document {
  readonly doc: LoroDoc;
  readonly id: string;

  constructor(id: string, doc?: LoroDoc) {
    this.id = id;
    this.doc = doc ?? new LoroDoc();
    this.doc.setPeerId(randomPeerId());
  }

  /**
   * Build a Document from Markdown content. Content is always stored clean —
   * no `<!-- adhd:id=... -->` comment. If `markdown` still carries the
   * legacy comment (pre-sidecar-index files), it is stripped here as a
   * one-time migration; callers that care about the legacy id should read
   * it via `Document.extractLegacyId` beforehand.
   */
  static fromMarkdown(id: string, markdown: string): Document {
    const doc = new Document(id);
    doc.setText(stripIdComment(markdown));
    return doc;
  }

  static fromSnapshot(id: string, snapshot: Uint8Array): Document {
    const doc = new LoroDoc();
    doc.import(snapshot);
    return new Document(id, doc);
  }

  /** LEGACY (migration-only): read the old in-content id comment, if any. */
  static extractLegacyId(markdown: string): string | null {
    return extractIdFromMarkdown(markdown);
  }

  getText(key: string = CONTENT_KEY): LoroText {
    return this.doc.getText(key);
  }

  getMarkdown(): string {
    return this.getText().toString();
  }

  setText(markdown: string): void {
    const text = this.getText();
    const cur = text.toString();
    if (cur.length === 0) text.insert(0, markdown);
    else text.splice(0, cur.length, markdown);
    this.doc.commit();
  }

  update(markdown: string): void {
    this.setText(markdown);
  }

  exportUpdates(): Uint8Array {
    this.doc.commit();
    return this.doc.export({ mode: "update" });
  }

  snapshot(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  frontiers(): OpId[] {
    this.doc.commit();
    return this.doc.oplogFrontiers();
  }

  import(bytes: Uint8Array): void {
    this.doc.import(bytes);
    this.doc.commit();
  }

  forkCurrent(): LoroDoc {
    return this.doc.fork();
  }

  /** Fork the doc at a historical version — used for external-edit three-way merge. */
  forkAt(frontiers: OpId[]): LoroDoc {
    return this.doc.forkAt(frontiers);
  }

  /**
   * One-time migration for vaults that predate the sidecar doc index:
   * older LoroText content may still carry the legacy
   * `<!-- adhd:id=... -->` comment (e.g. the seeded "Welcome" note in an
   * existing OPFS vault). Deletes it as a normal CRDT text edit — so the
   * removal is a real op that syncs and persists like any other change,
   * not a silent rewrite — leaving the LoroText (and therefore every
   * future materialised `.md`) clean. Idempotent: a no-op (returns false)
   * once the comment is gone. Callers should treat a `true` result as
   * "this document needs re-materialising" (its hash no longer matches
   * the on-disk `.md`, so the normal isStale()/repairDocument() path
   * picks it up).
   */
  migrateLegacyIdComment(): boolean {
    const text = this.getText();
    const current = text.toString();
    const match = ADHD_ID_COMMENT_RE.exec(current);
    if (!match) return false;
    text.delete(match.index!, match[0].length);
    this.doc.commit();
    return true;
  }
}

function randomPeerId(): bigint {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n =
    BigInt(bytes[0]!) |
    (BigInt(bytes[1]!) << 8n) |
    (BigInt(bytes[2]!) << 16n) |
    (BigInt(bytes[3]!) << 24n);
  return n;
}