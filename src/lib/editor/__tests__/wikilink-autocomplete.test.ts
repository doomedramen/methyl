import { describe, it, expect } from "vitest";
import {
  filterWikilinkCandidates,
  matchWikilinkPrefix,
  wikilinkInsertText,
} from "@/lib/editor/wikilink-autocomplete";
import type { WikilinkCandidate } from "@/lib/vault/wikilink";

const CANDIDATES: WikilinkCandidate[] = [
  { documentId: "a", path: "Welcome.md", name: "Welcome", folder: "" },
  { documentId: "b", path: "Projects/Note.md", name: "Note", folder: "Projects" },
  { documentId: "c", path: "Note.md", name: "Note", folder: "" },
  { documentId: "d", path: "Archive/Old note.md", name: "Old note", folder: "Archive" },
];

describe("filterWikilinkCandidates", () => {
  it("returns everything for an empty query", () => {
    expect(filterWikilinkCandidates(CANDIDATES, "")).toHaveLength(4);
  });

  it("filters case-insensitively by substring", () => {
    const result = filterWikilinkCandidates(CANDIDATES, "WEL");
    expect(result.map((c) => c.documentId)).toEqual(["a"]);
  });

  it("ranks a name starting with the query before one that merely contains it", () => {
    const result = filterWikilinkCandidates(CANDIDATES, "old");
    expect(result[0]?.documentId).toBe("d");
  });
});

describe("wikilinkInsertText", () => {
  it("uses the bare name when unambiguous", () => {
    const welcome = CANDIDATES.find((c) => c.documentId === "a")!;
    expect(wikilinkInsertText(welcome, CANDIDATES)).toBe("Welcome");
  });

  it("uses Folder/Name when the name is ambiguous", () => {
    const projectsNote = CANDIDATES.find((c) => c.documentId === "b")!;
    expect(wikilinkInsertText(projectsNote, CANDIDATES)).toBe("Projects/Note");
    const rootNote = CANDIDATES.find((c) => c.documentId === "c")!;
    expect(wikilinkInsertText(rootNote, CANDIDATES)).toBe("Note");
  });
});

describe("matchWikilinkPrefix", () => {
  it("matches an open [[ with no closing bracket yet", () => {
    expect(matchWikilinkPrefix("see [[Wel", 9)).toEqual({ from: 4, query: "Wel" });
  });

  it("matches an empty query right after [[", () => {
    expect(matchWikilinkPrefix("[[", 2)).toEqual({ from: 0, query: "" });
  });

  it("does not match once a closing ] has appeared", () => {
    expect(matchWikilinkPrefix("[[Welcome]] more", 11)).toBeUndefined();
  });

  it("does not match when there is no [[ before the cursor", () => {
    expect(matchWikilinkPrefix("plain text", 5)).toBeUndefined();
  });

  it("does not match across a newline", () => {
    expect(matchWikilinkPrefix("[[foo\nbar", 9)).toBeUndefined();
  });
});
