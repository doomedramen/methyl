import { describe, it, expect } from "vitest";
import { LoroDoc } from "loro-crdt";
import {
  createUndoManager,
  createCursorEphemeral,
  encodePeerEphemeral,
  applyPeerEphemeral,
  getContentTextFromDoc,
  getCursorEphemeralKey,
  getUserEphemeralKey,
} from "@/lib/editor/sync";
import { CONTENT_KEY } from "@/lib/core/document";

describe("editor sync primitives", () => {
  it("reads markdown from the content container", () => {
    const doc = new LoroDoc();
    doc.getText(CONTENT_KEY).insert(0, "# Hello");
    expect(getContentTextFromDoc(doc).toString()).toBe("# Hello");
  });

  it("undo manager reverts a local splice and redo restores it", () => {
    const doc = new LoroDoc();
    const text = doc.getText(CONTENT_KEY);
    text.insert(0, "abcd");
    doc.commit();

    const um = createUndoManager(doc);
    text.splice(1, 1, "XY");
    doc.commit();
    expect(text.toString()).toBe("aXYcd");

    expect(um.canUndo()).toBe(true);
    um.undo();
    expect(text.toString()).toBe("abcd");
    um.redo();
    expect(text.toString()).toBe("aXYcd");
  });

  it("remote updates are not undoable", () => {
    const a = new LoroDoc();
    const ta = a.getText(CONTENT_KEY);
    ta.insert(0, "base");
    a.commit();
    const um = createUndoManager(a);

    // Fork B from A's snapshot, then overwrite — mimics an external editor
    // or another device editing the same note (§24).
    const b = new LoroDoc();
    b.import(a.export({ mode: "snapshot" }));
    const tb = b.getText(CONTENT_KEY);
    tb.splice(0, tb.length, "remote stuff");
    b.commit();
    a.import(b.export({ mode: "update" }));

    expect(um.canUndo()).toBe(false);
    expect(ta.toString()).toBe("remote stuff");
  });

  it("cursor ephemeral payload encodes and applies between peers", () => {
    // Two docs with distinct peers, each with its own ephemeral store
    const a = new LoroDoc();
    const storeA = createCursorEphemeral();
    const b = new LoroDoc();
    const storeB = createCursorEphemeral();

    const userA = { name: "Alice", colorClassName: "cm-adhd-red" };
    const bytes = encodePeerEphemeral(a, storeA, { anchor: 3, head: 8 }, userA);

    applyPeerEphemeral(storeB, bytes);

    // storeB sees Alice's cursor under A's doc-derived key
    const cursorKey = getCursorEphemeralKey(a);
    const peerCursor = storeB.get(cursorKey) as { anchor: number; head?: number };
    expect(peerCursor.anchor).toBe(3);
    expect(peerCursor.head).toBe(8);

    const userKey = getUserEphemeralKey(a);
    const peerUser = storeB.get(userKey) as { name: string };
    expect(peerUser.name).toBe("Alice");
  });
});