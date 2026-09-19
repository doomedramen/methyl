"use client";

import { Columns2, Plus, Rows2, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
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
}

export function WorkspaceView({
  snapshot,
  store,
  getTabTitle,
  renderTab,
  renderEmpty,
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
      defaultLayout={{
        [first.id]: firstSize,
        [second.id]: secondSize,
      }}
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
}: {
  pane: WorkspacePane;
  focused: boolean;
  canClosePane: boolean;
  store: WorkspaceStore;
  getTabTitle: (tab: WorkspaceTab) => string;
  renderTab: (tab: WorkspaceTab, paneId: string) => ReactNode;
  renderEmpty: (paneId: string, tabId: string) => ReactNode;
}) {
  const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0]!;
  return (
    <section
      className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col border-r last:border-r-0", focused && "workspace-active")}
      data-workspace-pane={pane.id}
      data-workspace-focused={focused ? "true" : "false"}
      onPointerDown={() => store.focusPane(pane.id)}
    >
      <div className="workspace-tabs flex min-h-10 shrink-0 items-end px-3" data-workspace-tabbar="true">
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto" role="tablist" aria-label="Open notes">
          {pane.tabs.map((tab) => {
            const active = tab.id === pane.activeTabId;
            return (
              <div
                key={tab.id}
                className={cn(
                  "workspace-tab group flex min-w-0 max-w-56 items-center rounded-md px-1 text-sm",
                  active ? "workspace-tab-selected text-foreground" : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="min-w-0 flex-1 truncate px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    event.stopPropagation();
                    store.focusTab(tab.id);
                  }}
                >
                  {getTabTitle(tab)}
                </button>
                <button
                  type="button"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`Close ${getTabTitle(tab)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    store.closeTab(tab.id);
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pb-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New tab"
            title="New tab"
            onClick={(event) => {
              event.stopPropagation();
              store.newTab(pane.id);
            }}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Split pane right"
            title="Split pane right"
            onClick={(event) => {
              event.stopPropagation();
              store.split(pane.id, "horizontal");
            }}
          >
            <Columns2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Split pane down"
            title="Split pane down"
            onClick={(event) => {
              event.stopPropagation();
              store.split(pane.id, "vertical");
            }}
          >
            <Rows2 />
          </Button>
          {canClosePane ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close pane"
              title="Close pane"
              onClick={(event) => {
                event.stopPropagation();
                store.closePane(pane.id);
              }}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1" data-workspace-content="true">
        {activeTab.resource ? renderTab(activeTab, pane.id) : renderEmpty(pane.id, activeTab.id)}
      </div>
    </section>
  );
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
