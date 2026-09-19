"use client";

import { MoreHorizontal, Plus, Rows2, Columns2, X } from "lucide-react";
import { useState, type ReactNode, type KeyboardEvent } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "cn";
import {
  type WorkspaceNode,
  type WorkspacePane,
  type WorkspaceSnapshot,
  type WorkspaceSplit,
  type WorkspaceStore,
  type WorkspaceTab,
} from "@/lib/workspace/store";

export interface WorkspaceViewProps {
  snapshot: WorkspaceSnapshot;
  store: WorkspaceStore;
  getTabTitle: (tab: WorkspaceTab) => string;
  renderTab: (tab: WorkspaceTab, paneId: string) => ReactNode;
  renderEmpty: (paneId: string, tabId: string) => ReactNode;
  onTabActivated?: (tabId: string) => void;
}

export function WorkspaceView({
  snapshot,
  store,
  getTabTitle,
  renderTab,
  renderEmpty,
  onTabActivated,
}: WorkspaceViewProps) {
  return (
    <div className="flex h-full min-h-0 w-full" data-workspace-root="true">
      <WorkspaceNodeView
        node={snapshot.root}
        snapshot={snapshot}
        store={store}
        getTabTitle={getTabTitle}
        renderTab={renderTab}
        renderEmpty={renderEmpty}
        onTabActivated={onTabActivated}
      />
    </div>
  );
}

function WorkspaceNodeView({
  node,
  snapshot,
  store,
  getTabTitle,
  renderTab,
  renderEmpty,
  onTabActivated,
}: WorkspaceViewProps & { node: WorkspaceNode }) {
  if (node.kind === "pane") {
    return (
      <WorkspacePaneView
        pane={node}
        focused={snapshot.focusedPaneId === node.id}
        canClosePane={flattenPanes(snapshot.root).length > 1}
        store={store}
        getTabTitle={getTabTitle}
        renderTab={renderTab}
        renderEmpty={renderEmpty}
        onTabActivated={onTabActivated}
      />
    );
  }

  const [first, second] = node.children;
  const [firstSize, secondSize] = node.sizes;
  return (
    <ResizablePanelGroup
      orientation={node.direction}
      className="min-h-0 min-w-0 flex-1"
      id={node.id}
      defaultLayout={{ [first.id]: firstSize, [second.id]: secondSize }}
      onLayoutChanged={(layout) => {
        const nextFirst = layout[first.id];
        const nextSecond = layout[second.id];
        if (typeof nextFirst === "number" && typeof nextSecond === "number") {
          store.setSplitSizes(node.id, [nextFirst, nextSecond]);
        }
      }}
    >
      <ResizablePanel id={first.id} defaultSize={firstSize} minSize="20">
        <WorkspaceNodeView
          node={first}
          snapshot={snapshot}
          store={store}
          getTabTitle={getTabTitle}
          renderTab={renderTab}
          renderEmpty={renderEmpty}
          onTabActivated={onTabActivated}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id={second.id} defaultSize={secondSize} minSize="20">
        <WorkspaceNodeView
          node={second}
          snapshot={snapshot}
          store={store}
          getTabTitle={getTabTitle}
          renderTab={renderTab}
          renderEmpty={renderEmpty}
          onTabActivated={onTabActivated}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function WorkspacePaneView({
  pane,
  focused,
  canClosePane,
  store,
  getTabTitle,
  renderTab,
  renderEmpty,
  onTabActivated,
}: {
  pane: WorkspacePane;
  focused: boolean;
  canClosePane: boolean;
  store: WorkspaceStore;
  getTabTitle: (tab: WorkspaceTab) => string;
  renderTab: (tab: WorkspaceTab, paneId: string) => ReactNode;
  renderEmpty: (paneId: string, tabId: string) => ReactNode;
  onTabActivated?: (tabId: string) => void;
}) {
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0]!;
  const [rovingTabId, setRovingTabId] = useState(activeTab.id);
  const effectiveRovingTabId = pane.tabs.some((tab) => tab.id === rovingTabId) ? rovingTabId : activeTab.id;

  const focusTabButton = (tabId: string) => {
    setRovingTabId(tabId);
    requestAnimationFrame(() => document.getElementById(workspaceTabId(tabId))?.focus());
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const nextIndex = index + (event.key === "ArrowLeft" ? -1 : 1);
      const nextTab = pane.tabs[nextIndex];
      if (nextTab) focusTabButton(nextTab.id);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextTab = event.key === "Home" ? pane.tabs[0] : pane.tabs[pane.tabs.length - 1];
      if (nextTab) focusTabButton(nextTab.id);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      store.focusTab(pane.tabs[index]!.id);
      onTabActivated?.(pane.tabs[index]!.id);
    }
  };

  const closeTab = (tabId: string) => {
    const nextTabId = store.closeTab(tabId);
    onTabActivated?.(nextTabId);
    setRovingTabId(nextTabId);
    requestAnimationFrame(() => document.getElementById(workspaceTabId(nextTabId))?.focus());
  };

  const activateTab = (tabId: string) => {
    store.focusTab(tabId);
    onTabActivated?.(tabId);
  };

  return (
    <section
      className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col border-r last:border-r-0", focused && "workspace-active")}
      data-workspace-pane={pane.id}
      data-workspace-focused={focused ? "true" : "false"}
      onPointerDown={() => {
        store.focusPane(pane.id);
        onTabActivated?.(pane.activeTabId);
      }}
    >
      <div className="workspace-tabs flex min-h-10 shrink-0 items-center px-3" data-workspace-tabbar="true">
        <div
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          role="tablist"
          aria-label="Open notes"
          onFocusCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setRovingTabId(pane.activeTabId);
            }
          }}
        >
          {pane.tabs.map((tab, index) => {
            const active = tab.id === pane.activeTabId;
            const tabTitle = getTabTitle(tab);
            return (
              <div
                key={tab.id}
                className={cn(
                  "workspace-tab group flex min-w-0 max-w-56 items-center rounded-md px-1 text-sm",
                  active ? "workspace-tab-selected text-foreground" : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                <button
                  id={workspaceTabId(tab.id)}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={workspacePanelId(tab.id)}
                  tabIndex={effectiveRovingTabId === tab.id ? 0 : -1}
                  className="min-w-0 flex-1 truncate px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onFocus={() => setRovingTabId(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  onClick={(event) => {
                    event.stopPropagation();
                    activateTab(tab.id);
                  }}
                >
                  {tabTitle}
                </button>
                <button
                  type="button"
                  className="workspace-tab-close flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100"
                  aria-label={`Close ${tabTitle}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New tab"
            title="New tab"
            onClick={(event) => {
              event.stopPropagation();
              const id = store.newTab(pane.id);
              onTabActivated?.(id);
              setRovingTabId(id);
              requestAnimationFrame(() => document.getElementById(workspaceTabId(id))?.focus());
            }}
          >
            <Plus />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Pane options"
                  title="Pane options"
                >
                  <MoreHorizontal />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => store.split(pane.id, "horizontal")}>
                <Columns2 data-icon="inline-start" />
                Split right
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => store.split(pane.id, "vertical")}>
                <Rows2 data-icon="inline-start" />
                Split down
              </DropdownMenuItem>
              {canClosePane ? (
                <DropdownMenuItem onClick={() => store.closePane(pane.id)}>
                  <X data-icon="inline-start" />
                  Close pane
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div
        id={workspacePanelId(activeTab.id)}
        className="min-h-0 min-w-0 flex-1"
        data-workspace-content="true"
        role="tabpanel"
        aria-labelledby={workspaceTabId(activeTab.id)}
        tabIndex={-1}
      >
        {activeTab.resource ? renderTab(activeTab, pane.id) : renderEmpty(pane.id, activeTab.id)}
      </div>
    </section>
  );
}

function workspaceTabId(tabId: string): string {
  return `workspace-tab-${tabId}`;
}

function workspacePanelId(tabId: string): string {
  return `workspace-panel-${tabId}`;
}

export function findActiveTab(snapshot: WorkspaceSnapshot): WorkspaceTab | null {
  const panes = flattenPanes(snapshot.root);
  const pane = panes.find((candidate) => candidate.id === snapshot.focusedPaneId);
  return pane?.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane?.tabs[0] ?? null;
}

function flattenPanes(node: WorkspaceNode): WorkspacePane[] {
  if (node.kind === "pane") return [node];
  return [...flattenPanes(node.children[0]), ...flattenPanes(node.children[1])];
}

export function isWorkspaceSplit(node: WorkspaceNode): node is WorkspaceSplit {
  return node.kind === "split";
}
