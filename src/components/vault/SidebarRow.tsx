"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { TreeID } from "loro-crdt";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  FolderPlus,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { CreateHandler } from "./create-actions";
import { countDescendants, formatPlacementLabel, type SidebarPlacement } from "./sidebar-dnd";
import { afterDropId, type BinaryRow, type FlatRow, type FolderRow, type NoteRow, type SidebarRow } from "./sidebar-rows";

/** One sidebar row (note, folder or attachment), with its menus, and the drag visuals. */

/** What follows the pointer while a row is dragged: the row and where it would land. */
export function DragPreview({
  draggedRow,
  placement,
  rows,
  activeDragId,
}: {
  draggedRow: SidebarRow | undefined;
  placement: SidebarPlacement | null;
  rows: SidebarRow[];
  activeDragId: TreeID | null;
}) {
  if (!draggedRow) return null;
  return (
    <div
      data-sidebar-drag-preview="true"
      data-sidebar-placement-depth={placement?.depth ?? ""}
      className={cn(
        "flex max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-1 rounded-md border bg-sidebar px-3 py-2 text-sm shadow-lg",
        "-translate-y-full motion-reduce:transition-none",
      )}
      style={{ paddingLeft: `${0.75 + (placement?.depth ?? 0) * 1.1}rem` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {draggedRow.kind === "directory" ? (
          <Folder className="size-4 shrink-0" />
        ) : draggedRow.kind === "binary" ? (
          <Paperclip className="size-4 shrink-0" />
        ) : draggedRow.isGraph ? (
          <Workflow className="size-4 shrink-0" />
        ) : (
          <FileText className="size-4 shrink-0" />
        )}
        <span className="truncate font-medium">
          {draggedRow.kind === "directory" ? draggedRow.name : draggedRow.title}
        </span>
        {draggedRow.kind === "directory" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {countDescendants(draggedRow)} descendants
          </span>
        )}
      </div>
      {placement && (
        <span
          data-sidebar-placement-label="true"
          className={cn("truncate text-xs", !placement.valid && "text-destructive")}
        >
          {formatPlacementLabel(rows, placement, activeDragId ?? undefined)}
        </span>
      )}
    </div>
  );
}

interface RowProps {
  flat: FlatRow;
  activeId: string | null;
  activeResourceKey: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: (treeId: TreeID) => void;
  onPick: (id: string) => void;
  onPickAsset: (treeId: TreeID) => void;
  placement: SidebarPlacement | null;
  isDragging: boolean;
  isDimmed: boolean;
  onCreate: CreateHandler;
  onRequestNewFolder: (parentTreeId?: TreeID) => void;
  onRenameNoteRequest: (row: NoteRow) => void;
  onDeleteNoteRequest: (row: NoteRow) => void;
  onRenameFolderRequest: (row: FolderRow) => void;
  onDeleteFolderRequest: (row: FolderRow) => void;
  onRenameAssetRequest: (row: BinaryRow) => void;
  onDeleteAssetRequest: (row: BinaryRow) => void;
}

export function Row({
  flat,
  activeId,
  activeResourceKey,
  isCollapsed,
  onToggleCollapsed,
  onPick,
  onPickAsset,
  placement,
  isDragging,
  isDimmed,
  onCreate,
  onRequestNewFolder,
  onRenameNoteRequest,
  onDeleteNoteRequest,
  onRenameFolderRequest,
  onDeleteFolderRequest,
  onRenameAssetRequest,
  onDeleteAssetRequest,
}: RowProps) {
  const { row, depth } = flat;
  const { attributes, listeners, setNodeRef: setDragRef } = useDraggable({
    id: row.treeId,
  });
  const { setNodeRef: setDropRef } = useDroppable({ id: row.treeId });

  const isTarget = placement?.targetTreeId === row.treeId;
  const showBefore = placement?.valid && isTarget && placement.mode === "before";
  const showAfter = placement?.valid && isTarget && placement.mode === "after" && row.kind !== "directory";
  const showInside = placement?.valid && isTarget && placement.mode === "inside" && row.kind === "directory";
  const isDestinationParent =
    placement?.valid && placement.parentTreeId === row.treeId && row.kind === "directory";

  const indent = { paddingLeft: `${depth * 1.1}rem` };

  const setRefs = (node: HTMLElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };

  if (row.kind === "directory") {
    return (
      <SidebarMenuItem className="group/menu-item relative">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                ref={setRefs}
                {...attributes}
                {...listeners}
                data-sidebar-drag-row="true"
                data-sidebar-drop-parent={isDestinationParent ? "true" : undefined}
                style={{ ...indent, touchAction: isDragging ? "none" : "pan-y" }}
                className={cn(
                  "relative rounded-md",
                  (isDragging || isDimmed) && "opacity-35",
                  showInside && "bg-sidebar-accent ring-1 ring-sidebar-ring",
                  isDestinationParent && "bg-sidebar-accent/70 ring-1 ring-sidebar-ring/70",
                )}
              >
                {depth > 0 && <IndentGuide depth={depth} />}
                {isDestinationParent && placement && <IndentGuide depth={placement.depth} />}
                <SidebarMenuButton
                  className={ROW_BUTTON}
                  aria-expanded={!isCollapsed}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onToggleCollapsed(row.treeId)}
                >
                  <ChevronRight
                    className={cn(
                      "text-muted-foreground transition-transform motion-reduce:transition-none",
                      !isCollapsed && "rotate-90",
                    )}
                  />
                  {isCollapsed ? <Folder /> : <FolderOpen />}
                  <span>{row.name}</span>
                </SidebarMenuButton>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction
                        showOnHover
                        onPointerDown={(event) => event.stopPropagation()}
                        className="top-1/2! -translate-y-1/2"
                        aria-label={`Actions for ${row.name}`}
                      >
                        <MoreHorizontal />
                      </SidebarMenuAction>
                    }
                  />
                  <DropdownMenuContent align="start" side="right">
                    <DropdownMenuItem onClick={() => onCreate({ kind: "note", parentTreeId: row.treeId })}>
                      <Plus data-icon="inline-start" />
                      New note
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onCreate({ kind: "template", parentTreeId: row.treeId })}>
                      <Plus data-icon="inline-start" />
                      From template
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onRequestNewFolder(row.treeId)}>
                      <FolderPlus data-icon="inline-start" />
                      New folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onRenameFolderRequest(row)}>
                      <Pencil data-icon="inline-start" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDeleteFolderRequest(row)}
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onCreate({ kind: "note", parentTreeId: row.treeId })}>
              <Plus data-icon="inline-start" />
              New note
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreate({ kind: "template", parentTreeId: row.treeId })}>
              <Plus data-icon="inline-start" />
              From template
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRequestNewFolder(row.treeId)}>
              <FolderPlus data-icon="inline-start" />
              New folder
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRenameFolderRequest(row)}>
              <Pencil data-icon="inline-start" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => onDeleteFolderRequest(row)}>
              <Trash2 data-icon="inline-start" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {showBefore && <DropLine position="before" depth={placement?.depth ?? depth} />}
        {showAfter && <DropLine position="after" depth={placement?.depth ?? depth} />}
      </SidebarMenuItem>
    );
  }

  if (row.kind === "binary") {
    const asset = row;
    return (
      <SidebarMenuItem className="group/menu-item relative">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                ref={setRefs}
                {...attributes}
                {...listeners}
                data-sidebar-drag-row="true"
                style={{ ...indent, touchAction: isDragging ? "none" : "pan-y" }}
                className={cn("relative rounded-md", (isDragging || isDimmed) && "opacity-35")}
              >
                {depth > 0 && <IndentGuide depth={depth} />}
                {isDestinationParent && placement && <IndentGuide depth={placement.depth} />}
                <SidebarMenuButton
                  isActive={activeResourceKey === `asset:${String(asset.treeId)}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onPickAsset(asset.treeId)}
                  className={ROW_BUTTON}
                  title={asset.path}
                >
                  <Paperclip className="text-muted-foreground" />
                  <span>{asset.title}</span>
                </SidebarMenuButton>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction
                        showOnHover
                        onPointerDown={(event) => event.stopPropagation()}
                        className="top-1/2! -translate-y-1/2"
                        aria-label={`Actions for ${asset.title}`}
                      >
                        <MoreHorizontal />
                      </SidebarMenuAction>
                    }
                  />
                  <DropdownMenuContent align="start" side="right">
                    <DropdownMenuItem onClick={() => onRenameAssetRequest(asset)}>
                      <Pencil data-icon="inline-start" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onDeleteAssetRequest(asset)}>
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onRenameAssetRequest(asset)}>
              <Pencil data-icon="inline-start" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => onDeleteAssetRequest(asset)}>
              <Trash2 data-icon="inline-start" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {showBefore && <DropLine position="before" depth={placement?.depth ?? depth} />}
        {showAfter && <DropLine position="after" depth={placement?.depth ?? depth} />}
      </SidebarMenuItem>
    );
  }

  const note = row;
  return (
    <SidebarMenuItem className="group/menu-item relative">
      {showBefore && <DropLine position="before" depth={placement?.depth ?? depth} />}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={setRefs}
              {...attributes}
              {...listeners}
              data-sidebar-drag-row="true"
              data-sidebar-drop-parent={isDestinationParent ? "true" : undefined}
              style={{ ...indent, touchAction: isDragging ? "none" : "pan-y" }}
              className={cn("relative rounded-md", (isDragging || isDimmed) && "opacity-35")}
            >
              {depth > 0 && <IndentGuide depth={depth} />}
              {isDestinationParent && placement && <IndentGuide depth={placement.depth} />}
              <SidebarMenuButton
                isActive={note.id === activeId}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onPick(note.id)}
                className={ROW_BUTTON}
              >
                {note.isGraph ? (
                  <Workflow className="text-muted-foreground" />
                ) : (
                  <FileText className="text-muted-foreground" />
                )}
                <span>{note.title}</span>
              </SidebarMenuButton>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction
                      showOnHover
                      onPointerDown={(event) => event.stopPropagation()}
                      className="top-1/2! -translate-y-1/2"
                      aria-label={`Actions for ${note.title}`}
                    >
                      <MoreHorizontal />
                    </SidebarMenuAction>
                  }
                />
                <DropdownMenuContent align="start" side="right">
                  <DropdownMenuItem onClick={() => onRenameNoteRequest(note)}>
                    <Pencil data-icon="inline-start" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => onDeleteNoteRequest(note)}
                  >
                    <Trash2 data-icon="inline-start" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onRenameNoteRequest(note)}>
            <Pencil data-icon="inline-start" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => onDeleteNoteRequest(note)}>
            <Trash2 data-icon="inline-start" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {showBefore && <DropLine position="before" depth={placement?.depth ?? depth} />}
      {showAfter && <DropLine position="after" depth={placement?.depth ?? depth} />}
    </SidebarMenuItem>
  );
}

export function FolderAfterDropZone({
  folderTreeId,
  folderName,
  depth,
  placement,
}: {
  folderTreeId: TreeID;
  folderName: string;
  depth: number;
  placement: SidebarPlacement | null;
}) {
  const { setNodeRef } = useDroppable({ id: afterDropId(folderTreeId) });
  const isTarget = placement?.targetTreeId === folderTreeId;
  const showMarker =
    placement?.valid && isTarget && (placement.mode === "after" || placement.mode === "inside");
  const markerDepth = placement?.depth ?? depth;

  return (
    <li aria-hidden="true" className="relative h-px shrink-0">
      <div
        ref={setNodeRef}
        data-sidebar-drop-zone="after-folder"
        data-sidebar-drop-folder={folderName}
        className={cn(
          "absolute inset-x-2 -top-3 h-6 rounded-sm",
          isTarget && "bg-sidebar-ring/10",
        )}
      >
        {showMarker && <DropLine position="boundary" depth={markerDepth} />}
      </div>
    </li>
  );
}

/** Row height: comfortable touch target on mobile, compact on desktop. */
const ROW_BUTTON = "note-tree-row h-11 md:h-9";

function DropLine({
  position,
  depth,
}: {
  position: "before" | "after" | "boundary";
  depth: number;
}) {
  return (
    <div
      aria-hidden
      data-sidebar-drop-line="true"
      data-sidebar-drop-depth={depth}
      className="pointer-events-none absolute z-10 h-0.5 rounded-full bg-sidebar-ring"
      style={{
        left: `calc(0.5rem + ${depth * 1.1}rem)`,
        right: "0.5rem",
        ...(position === "before"
          ? { top: "-1px" }
          : position === "after"
            ? { bottom: "-1px" }
            : { top: "50%", transform: "translateY(-50%)" }),
      }}
    >
      <span className="absolute -left-1.5 top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-sidebar bg-sidebar-ring" />
    </div>
  );
}

/** Subtle vertical guide aligned to the parent's indent, so nesting reads
 *  clearly at a glance. Purely decorative — sits behind row content. */
function IndentGuide({ depth }: { depth: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 border-l border-sidebar-border"
      style={{ left: `${depth * 1.1 - 0.55}rem` }}
    />
  );
}

export function EmptyFolderRow({ depth }: { depth: number }) {
  return (
    <SidebarMenuItem className="relative">
      <div style={{ paddingLeft: `${depth * 1.1}rem` }} className="relative">
        <IndentGuide depth={depth} />
        <div className={cn(ROW_BUTTON, "flex items-center gap-2 px-2 text-sm text-muted-foreground")}>
          <span aria-hidden className="size-4 shrink-0" />
          <span className="italic">Empty</span>
        </div>
      </div>
    </SidebarMenuItem>
  );
}
