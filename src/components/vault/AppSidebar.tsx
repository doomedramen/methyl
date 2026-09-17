"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeID } from "loro-crdt";
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
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
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
  onCreate: (parentTreeId?: TreeID) => void;
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
  row: SidebarRow;
  depth: number;
  parentTreeId: TreeID | undefined;
  siblingIndex: number;
  siblingsLength: number;
}

function flatten(
  rows: SidebarRow[],
  depth: number,
  parentTreeId: TreeID | undefined,
  collapsed: Set<string>,
  out: FlatRow[],
) {
  rows.forEach((row, i) => {
    out.push({ row, depth, parentTreeId, siblingIndex: i, siblingsLength: rows.length });
    if (row.kind === "directory" && !collapsed.has(row.treeId)) {
      flatten(row.children, depth + 1, row.treeId, collapsed, out);
    }
  });
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
  onCreate,
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
    const out: FlatRow[] = [];
    flatten(rows, 0, undefined, collapsed, out);
    return out;
  }, [rows, collapsed]);

  const flatById = useMemo(() => {
    const map = new Map<string, FlatRow>();
    for (const f of flat) map.set(f.row.treeId, f);
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

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) {
      setOverId(null);
      setDropMode(null);
      clearAutoExpand();
      return;
    }
    const overTreeId = over.id as TreeID;
    if (overTreeId === active.id) {
      setOverId(null);
      setDropMode(null);
      clearAutoExpand();
      return;
    }
    const overFlat = flatById.get(overTreeId);
    if (!overFlat) return;

    const overRect = over.rect;
    const activeTranslated = active.rect.current.translated;
    let mode: DropMode = "after";
    if (overRect && activeTranslated) {
      const activeCenterY = activeTranslated.top + activeTranslated.height / 2;
      const relative = (activeCenterY - overRect.top) / overRect.height;
      if (overFlat.row.kind === "directory") {
        if (relative < 0.25) mode = "before";
        else if (relative > 0.75) mode = "after";
        else mode = "inside";
      } else {
        mode = relative < 0.5 ? "before" : "after";
      }
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

  return (
    <Sidebar variant="inset">
      <SidebarHeader className="flex-row items-center justify-between gap-2 pt-6 md:pt-3">
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-wide">Methyl</h1>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-lg"
            onClick={() => {
              setNewFolderParent(undefined);
              onNewFolderOpenChange(true);
            }}
            aria-label="New folder"
            className="size-10 md:size-9"
          >
            <FolderPlus />
          </Button>
          <Button
            variant="outline"
            size="icon-lg"
            onClick={() => onCreate()}
            aria-label="New note"
            className="size-10 md:size-9"
          >
            <Plus />
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <Button
            variant="outline"
            className="mx-2 mb-2 justify-start gap-2 text-muted-foreground"
            onClick={onOpenCommandMenu}
          >
            <Search />
            Search notes
            <Kbd className="ml-auto">⌘K</Kbd>
          </Button>
          <SidebarGroupLabel className="px-2">Notes</SidebarGroupLabel>
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
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                <SidebarMenu className="gap-0.5">
                  {flat.map((f) => (
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
                  ))}
                </SidebarMenu>
                <DragOverlay>
                  {draggedRow ? (
                    <div className="flex items-center gap-2 rounded-md border bg-sidebar px-2 py-1.5 text-sm shadow-md">
                      {draggedRow.kind === "directory" ? (
                        <Folder className="size-4 shrink-0" />
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
        <PwaStatus />
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
                      <SidebarMenuAction showOnHover className="top-2 md:top-1.5" aria-label={`Actions for ${row.name}`}>
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
              <SidebarMenuButton
                isActive={note.id === activeId}
                onClick={() => onPick(note.id)}
                className={ROW_BUTTON}
              >
                {/* Spacer aligns note icons with folder icons (chevron column). */}
                <span aria-hidden className="size-4 shrink-0" />
                <FileText className="text-muted-foreground" />
                <span>{note.title}</span>
              </SidebarMenuButton>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuAction showOnHover className="top-2 md:top-1.5" aria-label={`Actions for ${note.title}`}>
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

/** Row height: comfortable touch target on mobile, compact on desktop. */
const ROW_BUTTON = "h-9 md:h-8";

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
