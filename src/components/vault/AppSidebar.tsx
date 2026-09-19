"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeID } from "loro-crdt";
import type { VaultEngine } from "@/lib/vault/engine";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { PwaStatus } from "@/components/pwa/PwaStatus";
import { CreateMenu } from "./CreateMenu";
import {
  RenameNoteDialog,
  DeleteNoteAlert,
  RenameFolderDialog,
  DeleteFolderAlert,
  NewFolderDialog,
} from "./NoteActions";

export interface FolderRow {
  treeId: TreeID;
  kind: "directory";
  name: string;
  children: SidebarRow[];
}

export interface NoteRow {
  treeId: TreeID;
  kind: "markdown";
  id: string;
  title: string;
  /** Body is a single mermaid flowchart block (SPEC §37) — shown with a
   *  distinct icon and opened in the graph editor rather than as text. */
  isGraph: boolean;
}

export type SidebarRow = FolderRow | NoteRow;

/** Where a drop lands relative to the hovered row. */
type DropMode = "before" | "after" | "inside";

export interface MoveTarget {
  treeId: TreeID;
  newParent: TreeID | undefined;
  index: number;
}

interface AppSidebarProps {
  rows: SidebarRow[];
  activeId: string | null;
  /** Passed through to the footer status popover for the diagnostics copy action. */
  engine: VaultEngine | null;
  onCreate: (parentTreeId?: TreeID) => void;
  onCreateGraph: (parentTreeId?: TreeID) => void;
  onCreateFolder: (parentTreeId: TreeID | undefined, name: string) => void;
  onSelect: (id: string) => void;
  onRenameNote: (id: string, title: string) => void;
  onDeleteNote: (id: string) => void;
  onRenameFolder: (treeId: TreeID, name: string) => void;
  onDeleteFolder: (treeId: TreeID) => void;
  onMove: (target: MoveTarget) => void;
  onOpenCommandMenu: () => void;
  newFolderOpen: boolean;
  onNewFolderOpenChange: (open: boolean) => void;
}

const COLLAPSED_KEY = "adhd.sidebar.collapsedFolders";

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch {
    // ignore — falls back to all-expanded
  }
  return new Set();
}

function saveCollapsed(set: Set<string>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // best-effort only; state still lives in memory for this session
  }
}

interface FlatRow {
  type: "row";
  row: SidebarRow;
  depth: number;
  parentTreeId: TreeID | undefined;
  siblingIndex: number;
  siblingsLength: number;
}

/** Placeholder shown under an expanded folder that has no children, so the
 *  next top-level rows don't visually read as its children. */
interface EmptyFlatRow {
  type: "empty";
  key: string;
  depth: number;
}

interface FolderAfterFlatRow {
  type: "after";
  folderTreeId: TreeID;
  folderName: string;
  depth: number;
}

type FlatEntry = FlatRow | EmptyFlatRow | FolderAfterFlatRow;

const AFTER_DROP_PREFIX = "after-folder:";

function afterDropId(treeId: TreeID): string {
  return `${AFTER_DROP_PREFIX}${treeId}`;
}

function folderIdFromAfterDropId(id: unknown): TreeID | undefined {
  return typeof id === "string" && id.startsWith(AFTER_DROP_PREFIX)
    ? (id.slice(AFTER_DROP_PREFIX.length) as TreeID)
    : undefined;
}

function flatten(
  rows: SidebarRow[],
  depth: number,
  parentTreeId: TreeID | undefined,
  collapsed: Set<string>,
  out: FlatEntry[],
) {
  rows.forEach((row, i) => {
    out.push({ type: "row", row, depth, parentTreeId, siblingIndex: i, siblingsLength: rows.length });
    if (row.kind === "directory" && !collapsed.has(row.treeId)) {
      if (row.children.length === 0) {
        out.push({ type: "empty", key: `${row.treeId}-empty`, depth: depth + 1 });
      } else {
        flatten(row.children, depth + 1, row.treeId, collapsed, out);
      }
    }
    if (row.kind === "directory") {
      // Keep a drop target after the entire visible subtree. This gives a
      // dragged child a reliable way to leave its folder, even when the
      // folder's first child wins row collision detection near its header.
      out.push({
        type: "after",
        folderTreeId: row.treeId,
        folderName: row.name,
        depth,
      });
    }
  });
}

/** Pure hit-testing for drop position within a hovered row.
 *  `relative` is the dragged item's center as a fraction of the hovered
 *  row's height (0 = top edge, 1 = bottom edge). Directory rows get a wide
 *  middle "inside" band (50%) so dropping into a folder is easy; note rows
 *  only ever split before/after. */
export function computeDropMode(relative: number, isDirectory: boolean): DropMode {
  if (isDirectory) {
    if (relative < 0.25) return "before";
    if (relative > 0.75) return "after";
    return "inside";
  }
  return relative < 0.5 ? "before" : "after";
}

function findRow(rows: SidebarRow[], treeId: TreeID): SidebarRow | undefined {
  for (const row of rows) {
    if (row.treeId === treeId) return row;
    if (row.kind === "directory") {
      const found = findRow(row.children, treeId);
      if (found) return found;
    }
  }
  return undefined;
}

function countNotes(row: FolderRow): number {
  let n = 0;
  for (const child of row.children) {
    if (child.kind === "markdown") n += 1;
    else n += countNotes(child);
  }
  return n;
}

export function AppSidebar({
  rows,
  activeId,
  engine,
  onCreate,
  onCreateGraph,
  onCreateFolder,
  onSelect,
  onRenameNote,
  onDeleteNote,
  onRenameFolder,
  onDeleteFolder,
  onMove,
  onOpenCommandMenu,
  newFolderOpen,
  onNewFolderOpenChange,
}: AppSidebarProps) {
  const { setOpenMobile } = useSidebar();
  const [renameTarget, setRenameTarget] = useState<NoteRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderRow | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderRow | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<TreeID | undefined>(undefined);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

  const toggleCollapsed = useCallback((treeId: TreeID) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(treeId)) next.delete(treeId);
      else next.add(treeId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const expand = useCallback((treeId: TreeID) => {
    setCollapsed((prev) => {
      if (!prev.has(treeId)) return prev;
      const next = new Set(prev);
      next.delete(treeId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const flat = useMemo(() => {
    const out: FlatEntry[] = [];
    flatten(rows, 0, undefined, collapsed, out);
    return out;
  }, [rows, collapsed]);

  const flatById = useMemo(() => {
    const map = new Map<string, FlatRow>();
    for (const f of flat) if (f.type === "row") map.set(f.row.treeId, f);
    return map;
  }, [flat]);

  const pick = (id: string) => {
    onSelect(id);
    setOpenMobile(false);
  };

  // --- drag and drop -----------------------------------------------------
  const [activeDragId, setActiveDragId] = useState<TreeID | null>(null);
  const [overId, setOverId] = useState<TreeID | null>(null);
  const [dropMode, setDropMode] = useState<DropMode | null>(null);
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoExpandTarget = useRef<TreeID | null>(null);

  const sensors = useSensors(
    // Mouse: activate on a short drag distance so plain clicks (open note,
    // toggle folder) never get eaten by the drag gesture.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Touch: require a press-and-hold before dragging starts, so a tap still
    // opens a note and a finger-swipe still scrolls the sidebar list.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor),
  );

  const clearAutoExpand = () => {
    if (autoExpandTimer.current) {
      clearTimeout(autoExpandTimer.current);
      autoExpandTimer.current = null;
    }
    autoExpandTarget.current = null;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as TreeID);
  };

  /**
   * dnd-kit only fires `onDragOver` when the *row* under the pointer
   * changes — not as you move within one row. Computing before/inside/after
   * there alone froze the drop mode at whatever it was when the row was
   * entered (usually "after"), so dropping onto a folder reordered instead
   * of moving into it. `onDragMove` fires continuously, so both handlers
   * run this.
   */
  const updateDropTarget = (event: DragOverEvent | DragMoveEvent) => {
    const { active, over } = event;
    if (!over) {
      setOverId(null);
      setDropMode(null);
      clearAutoExpand();
      return;
    }
    const afterFolderId = folderIdFromAfterDropId(over.id);
    const overTreeId = afterFolderId ?? (over.id as TreeID);
    if (overTreeId === active.id) {
      setOverId(null);
      setDropMode(null);
      clearAutoExpand();
      return;
    }
    const overFlat = flatById.get(overTreeId);
    if (!overFlat) return;

    const overRect = afterFolderId ? null : over.rect;
    const activeTranslated = active.rect.current.translated;
    let mode: DropMode = "after";
    if (overRect && activeTranslated) {
      const activeCenterY = activeTranslated.top + activeTranslated.height / 2;
      const relative = (activeCenterY - overRect.top) / overRect.height;
      mode = computeDropMode(relative, overFlat.row.kind === "directory");
    }

    setOverId(overTreeId);
    setDropMode(mode);

    if (mode === "inside" && overFlat.row.kind === "directory" && collapsed.has(overTreeId)) {
      if (autoExpandTarget.current !== overTreeId) {
        clearAutoExpand();
        autoExpandTarget.current = overTreeId;
        autoExpandTimer.current = setTimeout(() => {
          expand(overTreeId);
        }, 600);
      }
    } else {
      clearAutoExpand();
    }
  };

  const handleDragOver = (event: DragOverEvent) => updateDropTarget(event);
  const handleDragMove = (event: DragMoveEvent) => updateDropTarget(event);

  const handleDragEnd = (event: DragEndEvent) => {
    clearAutoExpand();
    const draggedId = activeDragId;
    setActiveDragId(null);
    const currentOverId = overId;
    const currentMode = dropMode;
    setOverId(null);
    setDropMode(null);
    if (!draggedId || !currentOverId || !currentMode) return;
    if (draggedId === currentOverId) return;

    const overFlat = flatById.get(currentOverId);
    if (!overFlat) return;

    // Refuse dropping a folder into its own descendant / itself.
    const draggedRow = findRow(rows, draggedId);
    if (draggedRow?.kind === "directory") {
      const descendant = findRow(draggedRow.children, currentOverId);
      if (descendant || currentOverId === draggedId) {
        toast.error("Can't move a folder into its own descendant");
        return;
      }
    }

    let newParent: TreeID | undefined;
    let index: number;
    if (currentMode === "inside") {
      newParent = currentOverId;
      const target = findRow(rows, currentOverId) as FolderRow;
      index = target.children.length;
    } else {
      newParent = overFlat.parentTreeId;
      index = overFlat.siblingIndex + (currentMode === "after" ? 1 : 0);
      // Loro removes the node before re-inserting it, so every later
      // sibling shifts up by one. Without this, dragging an item DOWN
      // within its own parent (e.g. from above a folder to just below it)
      // landed one slot too far.
      const draggedFlat = flatById.get(draggedId);
      if (
        draggedFlat &&
        draggedFlat.parentTreeId === newParent &&
        draggedFlat.siblingIndex < index
      ) {
        index -= 1;
      }
    }

    onMove({ treeId: draggedId, newParent, index });
  };

  const handleDragCancel = () => {
    clearAutoExpand();
    setActiveDragId(null);
    setOverId(null);
    setDropMode(null);
  };

  const draggedRow = activeDragId ? findRow(rows, activeDragId) : undefined;

  const isEmpty = rows.length === 0;

  // Create actions no-op before the vault engine holds the writer lock
  // (VaultApp's onCreate* guard on a missing engine/lock), so the buttons
  // that surface them stay disabled until writing is actually possible.
  const canWrite = Boolean(engine?.releaseWriterLock);

  return (
    <Sidebar variant="inset">
      <SidebarHeader className="flex-row items-center justify-between gap-2 px-4 pt-6 md:pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/icon.svg" alt="" className="size-6 shrink-0 rounded-md" />
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">Methyl</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 md:hidden"
            onClick={() => setOpenMobile(false)}
            aria-label="Close sidebar"
          >
            <X />
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setNewFolderParent(undefined);
                    onNewFolderOpenChange(true);
                  }}
                  aria-label="New folder"
                  className="size-11 text-muted-foreground md:size-8"
                  disabled={!canWrite}
                >
                  <FolderPlus />
                </Button>
              }
            />
            <TooltipContent>New folder</TooltipContent>
          </Tooltip>
          <CreateMenu
            onCreateNote={() => onCreate()}
            onCreateGraph={() => onCreateGraph()}
            disabled={!canWrite}
            className="size-11 text-muted-foreground md:size-8"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <Button
            variant="ghost"
            className="mb-1 h-11 w-full justify-start gap-2 bg-sidebar-accent/40 px-2 font-normal text-muted-foreground hover:bg-sidebar-accent md:h-8"
            onClick={onOpenCommandMenu}
          >
            <Search className="text-muted-foreground" />
            Search notes
            <Kbd className="ml-auto">⌘K</Kbd>
          </Button>
          <SidebarGroupLabel className="px-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Notes
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {isEmpty ? (
              <Empty className="border-0 p-4">
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle className="text-sm">No notes yet</EmptyTitle>
              </Empty>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                <SidebarMenu className="gap-0.5">
                  {flat.map((f) =>
                    f.type === "empty" ? (
                      <EmptyFolderRow key={f.key} depth={f.depth} />
                    ) : f.type === "after" ? (
                      <FolderAfterDropZone
                        key={afterDropId(f.folderTreeId)}
                        folderTreeId={f.folderTreeId}
                        folderName={f.folderName}
                        depth={f.depth}
                        isOver={overId === f.folderTreeId && dropMode === "after"}
                      />
                    ) : (
                      <Row
                        key={f.row.treeId}
                        flat={f}
                        activeId={activeId}
                        isCollapsed={f.row.kind === "directory" && collapsed.has(f.row.treeId)}
                        onToggleCollapsed={toggleCollapsed}
                        onPick={pick}
                        overId={overId}
                        dropMode={dropMode}
                        isDragging={activeDragId === f.row.treeId}
                        onCreateNote={onCreate}
                        onCreateFolder={(parent) => {
                          setNewFolderParent(parent);
                          onNewFolderOpenChange(true);
                        }}
                        onRenameNoteRequest={setRenameTarget}
                        onDeleteNoteRequest={setDeleteTarget}
                        onRenameFolderRequest={setRenameFolderTarget}
                        onDeleteFolderRequest={setDeleteFolderTarget}
                      />
                    ),
                  )}
                </SidebarMenu>
                <DragOverlay>
                  {draggedRow ? (
                    <div className="flex items-center gap-2 rounded-md border bg-sidebar px-2 py-1.5 text-sm shadow-md">
                      {draggedRow.kind === "directory" ? (
                        <Folder className="size-4 shrink-0" />
                      ) : draggedRow.isGraph ? (
                        <Workflow className="size-4 shrink-0" />
                      ) : (
                        <FileText className="size-4 shrink-0" />
                      )}
                      <span className="truncate">
                        {draggedRow.kind === "directory" ? draggedRow.name : draggedRow.title}
                      </span>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="flex-row items-center justify-between gap-2">
        <PwaStatus engine={engine} />
      </SidebarFooter>

      {renameTarget && (
        <RenameNoteDialog
          open={Boolean(renameTarget)}
          onOpenChange={(open) => !open && setRenameTarget(null)}
          currentTitle={renameTarget.title}
          onRename={(title) => onRenameNote(renameTarget.id, title)}
        />
      )}
      {deleteTarget && (
        <DeleteNoteAlert
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          noteTitle={deleteTarget.title}
          onConfirm={() => onDeleteNote(deleteTarget.id)}
        />
      )}
      {renameFolderTarget && (
        <RenameFolderDialog
          open={Boolean(renameFolderTarget)}
          onOpenChange={(open) => !open && setRenameFolderTarget(null)}
          currentName={renameFolderTarget.name}
          onRename={(name) => onRenameFolder(renameFolderTarget.treeId, name)}
        />
      )}
      {deleteFolderTarget && (
        <DeleteFolderAlert
          open={Boolean(deleteFolderTarget)}
          onOpenChange={(open) => !open && setDeleteFolderTarget(null)}
          folderName={deleteFolderTarget.name}
          noteCount={countNotes(deleteFolderTarget)}
          onConfirm={() => onDeleteFolder(deleteFolderTarget.treeId)}
        />
      )}
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={onNewFolderOpenChange}
        onCreate={(name) => onCreateFolder(newFolderParent, name)}
      />
    </Sidebar>
  );
}

interface RowProps {
  flat: FlatRow;
  activeId: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: (treeId: TreeID) => void;
  onPick: (id: string) => void;
  overId: TreeID | null;
  dropMode: DropMode | null;
  isDragging: boolean;
  onCreateNote: (parentTreeId?: TreeID) => void;
  onCreateFolder: (parentTreeId?: TreeID) => void;
  onRenameNoteRequest: (row: NoteRow) => void;
  onDeleteNoteRequest: (row: NoteRow) => void;
  onRenameFolderRequest: (row: FolderRow) => void;
  onDeleteFolderRequest: (row: FolderRow) => void;
}

function Row({
  flat,
  activeId,
  isCollapsed,
  onToggleCollapsed,
  onPick,
  overId,
  dropMode,
  isDragging,
  onCreateNote,
  onCreateFolder,
  onRenameNoteRequest,
  onDeleteNoteRequest,
  onRenameFolderRequest,
  onDeleteFolderRequest,
}: RowProps) {
  const { row, depth } = flat;
  const { attributes, listeners, setNodeRef: setDragRef } = useDraggable({
    id: row.treeId,
  });
  const { setNodeRef: setDropRef } = useDroppable({ id: row.treeId });

  const isOver = overId === row.treeId;
  const showBefore = isOver && dropMode === "before";
  const showAfter = isOver && dropMode === "after";
  const showInside = isOver && dropMode === "inside" && row.kind === "directory";

  const indent = { paddingLeft: `${depth * 1.1}rem` };

  const setRefs = (node: HTMLElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };

  if (row.kind === "directory") {
    return (
      <SidebarMenuItem className="group/menu-item relative">
        {showBefore && <DropLine position="before" />}
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                ref={setRefs}
                {...attributes}
                {...listeners}
                style={indent}
                className={cn(
                  "relative rounded-md",
                  isDragging && "opacity-40",
                  showInside && "bg-sidebar-accent ring-1 ring-sidebar-ring",
                )}
              >
                {depth > 0 && <IndentGuide depth={depth} />}
                <SidebarMenuButton
                  className={ROW_BUTTON}
                  aria-expanded={!isCollapsed}
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
                      <SidebarMenuAction showOnHover className="top-1/2! -translate-y-1/2" aria-label={`Actions for ${row.name}`}>
                        <MoreHorizontal />
                      </SidebarMenuAction>
                    }
                  />
                  <DropdownMenuContent align="start" side="right">
                    <DropdownMenuItem onClick={() => onCreateNote(row.treeId)}>
                      <Plus data-icon="inline-start" />
                      New note
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onCreateFolder(row.treeId)}>
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
            <ContextMenuItem onClick={() => onCreateNote(row.treeId)}>
              <Plus data-icon="inline-start" />
              New note
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateFolder(row.treeId)}>
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
        {showAfter && <DropLine position="after" />}
      </SidebarMenuItem>
    );
  }

  const note = row;
  return (
    <SidebarMenuItem className="group/menu-item relative">
      {showBefore && <DropLine position="before" />}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              ref={setRefs}
              {...attributes}
              {...listeners}
              style={indent}
              className={cn("relative rounded-md", isDragging && "opacity-40")}
            >
              {depth > 0 && <IndentGuide depth={depth} />}
              <SidebarMenuButton
                isActive={note.id === activeId}
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
                    <SidebarMenuAction showOnHover className="top-1/2! -translate-y-1/2" aria-label={`Actions for ${note.title}`}>
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
      {showAfter && <DropLine position="after" />}
    </SidebarMenuItem>
  );
}

function FolderAfterDropZone({
  folderTreeId,
  folderName,
  depth,
  isOver,
}: {
  folderTreeId: TreeID;
  folderName: string;
  depth: number;
  isOver: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: afterDropId(folderTreeId) });

  return (
    <li aria-hidden="true" className="relative h-px shrink-0">
      <div
        ref={setNodeRef}
        data-sidebar-drop-zone="after-folder"
        data-sidebar-drop-folder={folderName}
        className={cn(
          "pointer-events-none absolute -top-3 h-6 rounded-sm",
          isOver && "bg-sidebar-ring/30",
        )}
        style={{ left: `calc(0.5rem + ${depth * 1.1}rem)`, width: "6rem" }}
      />
    </li>
  );
}

/** Row height: comfortable touch target on mobile, compact on desktop. */
const ROW_BUTTON = "h-11 md:h-8";

function DropLine({ position }: { position: "before" | "after" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-sidebar-ring",
        position === "before" ? "-top-px" : "-bottom-px",
      )}
    />
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

function EmptyFolderRow({ depth }: { depth: number }) {
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
