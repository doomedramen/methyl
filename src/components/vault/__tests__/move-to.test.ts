import { describe, expect, it } from "vitest";
import type { TreeID } from "loro-crdt";
import { currentParent, moveDestinations } from "@/components/vault/MoveToDialog";
import type { SidebarRow } from "@/components/vault/sidebar-rows";

const id = (s: string) => s as TreeID;
const note = (treeId: string, title: string): SidebarRow => ({ treeId: id(treeId), kind: "markdown", id: treeId, title, path: title, isGraph: false } as SidebarRow);
const folder = (treeId: string, name: string, children: SidebarRow[]): SidebarRow => ({ treeId: id(treeId), kind: "directory", name, children } as SidebarRow);

const rows: SidebarRow[] = [
  folder("f1", "Projects", [folder("f2", "Old", []), note("n1", "Plan")]),
  folder("f3", "Inbox", []),
  note("n2", "Loose"),
];

describe("Move to… destinations", () => {
  it("lists the root and every folder, with how many children each has", () => {
    expect(moveDestinations(rows, id("n2")).map((d) => [d.path, d.childCount])).toEqual([
      ["", 3],
      ["Projects", 2],
      ["Projects/Old", 0],
      ["Inbox", 0],
    ]);
  });

  it("leaves out a folder being moved and everything inside it", () => {
    expect(moveDestinations(rows, id("f1")).map((d) => d.path)).toEqual(["", "Inbox"]);
  });

  it("finds the folder an item is in", () => {
    expect(currentParent(rows, id("n1"))).toBe("f1");
    expect(currentParent(rows, id("n2"))).toBeUndefined();
    expect(currentParent(rows, id("missing"))).toBeNull();
  });
});
