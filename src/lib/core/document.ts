import { LoroDoc, LoroText, type OpId } from "loro-crdt";
import {
  extractIdFromMarkdown,
  insertIdComment,
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

  static fromMarkdown(id: string, markdown: string): Document {
    const doc = new Document(id);
    doc.setText(withIdIfMissing(markdown, id));
    return doc;
  }

  static fromSnapshot(id: string, snapshot: Uint8Array): Document {
    const doc = new LoroDoc();
    doc.import(snapshot);
    return new Document(id, doc);
  }

  static extractId(markdown: string): string | null {
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
}

function withIdIfMissing(markdown: string, id: string): string {
  return extractIdFromMarkdown(markdown)
    ? markdown
    : insertIdComment(markdown, id);
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