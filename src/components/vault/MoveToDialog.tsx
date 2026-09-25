"use client";

import { useMemo } from "react";
import type { TreeID } from "loro-crdt";
import { Folder, Home } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { SidebarRow } from "./sidebar-rows";

/** What's being moved. */
export interface MoveItem {
  treeId: TreeID;
  name: string;
}

interface Destination {
  treeId: TreeID | undefined;
  path: string;
  /** Children now: the move appends after them. */
  childCount: number;
}

/**
 * Every folder the item can move into (plus the vault root), leaving out the
 * item itself and, for a folder, everything inside it.
 */
export function moveDestinations(rows: SidebarRow[], movingId: TreeID): Destination[] {
  const out: Destination[] = [{ treeId: undefined, path: "", childCount: rows.length }];
  const visit = (list: SidebarRow[], prefix: string) => {
    for (const row of list) {
      if (row.kind !== "directory" || row.treeId === movingId) continue;
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      out.push({ treeId: row.treeId, path, childCount: row.children.length });
      visit(row.children, path);
    }
  };
  visit(rows, "");
  return out;
}

/** The folder that holds `treeId` now (undefined: the root), or null if not found. */
export function currentParent(rows: SidebarRow[], treeId: TreeID): TreeID | undefined | null {
  const search = (list: SidebarRow[], parent: TreeID | undefined): TreeID | undefined | null => {
    for (const row of list) {
      if (row.treeId === treeId) return parent;
      if (row.kind === "directory") {
        const found = search(row.children, row.treeId);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return search(rows, undefined);
}

/**
 * "Move to…": a searchable folder picker, so moving a note, attachment or
 * folder doesn't need drag and drop (spec item 17).
 */
export function MoveToDialog({
  item,
  rows,
  onOpenChange,
  onMove,
}: {
  item: MoveItem | null;
  rows: SidebarRow[];
  onOpenChange: (open: boolean) => void;
  onMove: (target: { treeId: TreeID; newParent: TreeID | undefined; index: number }) => void;
}) {
  const destinations = useMemo(() => (item ? moveDestinations(rows, item.treeId) : []), [item, rows]);
  const parent = useMemo(() => (item ? currentParent(rows, item.treeId) : null), [item, rows]);

  return (
    <CommandDialog
      open={item !== null}
      onOpenChange={onOpenChange}
      title={item ? `Move “${item.name}” to…` : "Move to…"}
      description="Choose the folder to move it into."
    >
      <Command>
        <CommandInput placeholder={item ? `Move “${item.name}” to…` : "Move to…"} aria-label="Folder" />
        <CommandList>
          <CommandEmpty>No folder matches.</CommandEmpty>
          <CommandGroup heading="Folders">
            {destinations.map((destination) => {
              const here = destination.treeId === parent;
              return (
                <CommandItem
                  key={destination.treeId ?? "root"}
                  value={destination.path || "Vault root"}
                  disabled={here}
                  onSelect={() => {
                    if (!item || here) return;
                    onMove({ treeId: item.treeId, newParent: destination.treeId, index: destination.childCount });
                    onOpenChange(false);
                  }}
                >
                  {destination.treeId ? <Folder data-icon="inline-start" /> : <Home data-icon="inline-start" />}
                  <span className="min-w-0 truncate">{destination.path || "Vault root"}</span>
                  {here && <span className="ml-auto text-xs text-muted-foreground">current</span>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
