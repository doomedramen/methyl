import { describe, it, expect } from "vitest";
import { reconcileVault, type DocIndex } from "@/lib/core/doc-index";
import { sha256Text } from "@/lib/core/hash";

describe("reconcileVault (sidecar doc index — SPEC §5, §26)", () => {
  it("known path keeps its id across a normal content edit", async () => {
    const hash = await sha256Text("# Garage\nOriginal");
    const prev: DocIndex = {
      "Garage.md": { id: "id-1", contentHash: hash, size: 10, mtime: 0 },
    };
    const result = await reconcileVault(prev, [
      { path: "Garage.md", content: "# Garage\nEdited" },
    ]);
    expect(result.resolved[0]!.kind).toBe("known");
    expect(result.resolved[0]!.id).toBe("id-1");
    expect(result.resolved[0]!.rewrite).toBe(false);
    expect(result.deletedPaths).toEqual([]);
  });

  it("external move: unknown path + matching hash of a now-missing path keeps the id", async () => {
    const content = "# Garage\nOriginal";
    const hash = await sha256Text(content);
    const prev: DocIndex = {
      "Garage.md": { id: "id-1", contentHash: hash, size: 10, mtime: 0 },
    };
    const result = await reconcileVault(prev, [
      { path: "Notes/Garage.md", content },
    ]);
    expect(result.resolved[0]!.kind).toBe("move");
    expect(result.resolved[0]!.id).toBe("id-1");
    expect(result.resolved[0]!.sourcePath).toBe("Garage.md");
    expect(result.deletedPaths).toEqual([]);
  });

  it("external copy: unknown path + matching hash of a still-present path gets a fresh id", async () => {
    const content = "# Garage\nOriginal";
    const hash = await sha256Text(content);
    const prev: DocIndex = {
      "Garage.md": { id: "id-1", contentHash: hash, size: 10, mtime: 0 },
    };
    const result = await reconcileVault(
      prev,
      [
        { path: "Garage.md", content },
        { path: "Garage-copy.md", content },
      ],
      () => "fresh-id",
    );
    const copy = result.resolved.find((r) => r.path === "Garage-copy.md")!;
    expect(copy.kind).toBe("copy");
    expect(copy.id).toBe("fresh-id");
    expect(copy.id).not.toBe("id-1");
    expect(copy.sourcePath).toBe("Garage.md");
  });

  it("unmatched missing path is a deletion", async () => {
    const hash = await sha256Text("# Gone");
    const prev: DocIndex = {
      "Gone.md": { id: "id-1", contentHash: hash, size: 5, mtime: 0 },
    };
    const result = await reconcileVault(prev, []);
    expect(result.deletedPaths).toEqual(["Gone.md"]);
  });

  it("brand new file with no legacy comment and no hash match gets a new id", async () => {
    const result = await reconcileVault({}, [
      { path: "New.md", content: "# New\nHello" },
    ]);
    expect(result.resolved[0]!.kind).toBe("new");
    expect(result.resolved[0]!.id).toBeTruthy();
    expect(result.resolved[0]!.rewrite).toBe(false);
    expect(result.resolved[0]!.cleanContent).toBe("# New\nHello");
  });

  it("migrates a legacy adhd:id comment: recovers the id, strips it, flags rewrite", async () => {
    const legacyId = "11111111-1111-1111-1111-111111111111";
    const raw = `<!-- adhd:id=${legacyId} -->\n\n# Legacy\n\nBody`;
    const result = await reconcileVault({}, [{ path: "Legacy.md", content: raw }]);
    const r = result.resolved[0]!;
    expect(r.kind).toBe("new");
    expect(r.id).toBe(legacyId);
    expect(r.rewrite).toBe(true);
    expect(r.cleanContent).not.toContain("adhd:id");
    expect(r.cleanContent).toBe("# Legacy\n\nBody");
  });

  it("a still-known path with a lingering legacy comment is cleaned but keeps its indexed id", async () => {
    const cleanContent = "# Garage\nOriginal";
    const hash = await sha256Text(cleanContent);
    const prev: DocIndex = {
      "Garage.md": { id: "id-1", contentHash: hash, size: 10, mtime: 0 },
    };
    const raw = `<!-- adhd:id=deadbeef-0000-0000-0000-000000000000 -->\n\n${cleanContent}`;
    const result = await reconcileVault(prev, [{ path: "Garage.md", content: raw }]);
    const r = result.resolved[0]!;
    expect(r.kind).toBe("known");
    expect(r.id).toBe("id-1"); // indexed id wins over a stray legacy comment
    expect(r.rewrite).toBe(true);
    expect(r.cleanContent).toBe(cleanContent);
  });

  it("duplicate legacy ids: second file with an already-claimed legacy id falls back to a fresh id", async () => {
    const legacyId = "22222222-2222-2222-2222-222222222222";
    const result = await reconcileVault(
      {},
      [
        { path: "A.md", content: `<!-- adhd:id=${legacyId} -->\n\n# A\n\nBody A` },
        { path: "B.md", content: `<!-- adhd:id=${legacyId} -->\n\n# B\n\nBody B` },
      ],
      (() => {
        let n = 0;
        return () => `gen-${++n}`;
      })(),
    );
    const a = result.resolved.find((r) => r.path === "A.md")!;
    const b = result.resolved.find((r) => r.path === "B.md")!;
    expect(a.id).toBe(legacyId);
    expect(b.id).not.toBe(legacyId);
    expect(b.id).toBe("gen-1");
  });
});
