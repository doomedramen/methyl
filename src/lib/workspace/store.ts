export type WorkspaceResource =
  | { kind: "document"; documentId: string }
  | { kind: "asset"; treeId: string };

export type WorkspaceCollection = "notes" | "inbox" | "graphs";

export interface WorkspaceTab {
  id: string;
  resource: WorkspaceResource | null;
  /** Collection shown when this tab has no resource. */
  collection?: WorkspaceCollection;
}

export interface WorkspacePane {
  kind: "pane";
  id: string;
  tabs: WorkspaceTab[];
  activeTabId: string;
}

export interface WorkspaceSplit {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: [WorkspaceNode, WorkspaceNode];
  sizes: [number, number];
}

export type WorkspaceNode = WorkspacePane | WorkspaceSplit;

export interface WorkspaceSnapshot {
  version: 1;
  root: WorkspaceNode;
  focusedPaneId: string;
  recentDocumentIds: string[];
}

export interface WorkspacePersistence {
  load(vaultId: string): WorkspaceSnapshot | null;
  save(vaultId: string, snapshot: WorkspaceSnapshot): void;
}

export type WorkspaceOpenMode = "replace" | "new";

export interface WorkspaceOpenOptions {
  mode?: WorkspaceOpenMode;
  paneId?: string;
}

export interface WorkspaceStoreOptions {
  vaultId?: string;
  initial?: WorkspaceSnapshot;
  persistence?: WorkspacePersistence;
  idFactory?: (prefix: "pane" | "tab" | "split") => string;
}

const DEFAULT_PANE_ID = "pane-1";
const DEFAULT_TAB_ID = "tab-1";
const EMPTY_SIZES: [number, number] = [50, 50];

function fallbackId(prefix: "pane" | "tab" | "split"): string {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${prefix}-${uuid}`;
}

function createEmptySnapshot(): WorkspaceSnapshot {
  return {
    version: 1,
    root: {
      kind: "pane",
      id: DEFAULT_PANE_ID,
      tabs: [{ id: DEFAULT_TAB_ID, resource: null, collection: "notes" }],
      activeTabId: DEFAULT_TAB_ID,
    },
    focusedPaneId: DEFAULT_PANE_ID,
    recentDocumentIds: [],
  };
}

function cloneResource(resource: WorkspaceResource | null): WorkspaceResource | null {
  return resource ? { ...resource } : null;
}

function cloneNode(node: WorkspaceNode): WorkspaceNode {
  if (node.kind === "pane") {
    return {
      kind: "pane",
      id: node.id,
      tabs: node.tabs.map((tab) => ({
        id: tab.id,
        resource: cloneResource(tab.resource),
        ...(tab.resource ? {} : { collection: tab.collection ?? "notes" }),
      })),
      activeTabId: node.activeTabId,
    };
  }
  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    children: [cloneNode(node.children[0]), cloneNode(node.children[1])],
    sizes: [node.sizes[0], node.sizes[1]],
  };
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    version: 1,
    root: cloneNode(snapshot.root),
    focusedPaneId: snapshot.focusedPaneId,
    recentDocumentIds: [...snapshot.recentDocumentIds],
  };
}

function isResource(value: unknown): value is WorkspaceResource {
  if (!value || typeof value !== "object") return false;
  const resource = value as Record<string, unknown>;
  return (
    (resource.kind === "document" && typeof resource.documentId === "string") ||
    (resource.kind === "asset" && typeof resource.treeId === "string")
  );
}

function isWorkspaceCollection(value: unknown): value is WorkspaceCollection {
  return value === "notes" || value === "inbox" || value === "graphs";
}

function parseNode(value: unknown): WorkspaceNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (node.kind === "pane" && typeof node.id === "string" && Array.isArray(node.tabs)) {
    const tabs = node.tabs
      .filter((tab): tab is Record<string, unknown> => Boolean(tab && typeof tab === "object"))
      .filter((tab) => typeof tab.id === "string")
      .map((tab) => {
        const resource = isResource(tab.resource) ? { ...tab.resource } : null;
        return {
          id: tab.id as string,
          resource,
          ...(resource
            ? {}
            : { collection: isWorkspaceCollection(tab.collection) ? tab.collection : "notes" }),
        };
      });
    if (tabs.length === 0) return null;
    const activeTabId = typeof node.activeTabId === "string" && tabs.some((tab) => tab.id === node.activeTabId)
      ? node.activeTabId
      : tabs[0]!.id;
    return { kind: "pane", id: node.id, tabs, activeTabId };
  }
  if (
    node.kind === "split" &&
    typeof node.id === "string" &&
    (node.direction === "horizontal" || node.direction === "vertical") &&
    Array.isArray(node.children) &&
    node.children.length === 2
  ) {
    const first = parseNode(node.children[0]);
    const second = parseNode(node.children[1]);
    if (!first || !second) return null;
    const rawSizes = Array.isArray(node.sizes) ? node.sizes : EMPTY_SIZES;
    const firstSize = typeof rawSizes[0] === "number" && rawSizes[0] > 0 ? rawSizes[0] : 50;
    const secondSize = typeof rawSizes[1] === "number" && rawSizes[1] > 0 ? rawSizes[1] : 50;
    return {
      kind: "split",
      id: node.id,
      direction: node.direction,
      children: [first, second],
      sizes: normalizeSizes([firstSize, secondSize]),
    };
  }
  return null;
}

export function normalizeSizes(sizes: [number, number]): [number, number] {
  const first = Math.max(1, sizes[0]);
  const second = Math.max(1, sizes[1]);
  const total = first + second;
  return [(first / total) * 100, (second / total) * 100];
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  const root = parseNode(raw.root);
  if (!root) return null;
  const paneIds = collectPanes(root).map((pane) => pane.id);
  const focusedPaneId = typeof raw.focusedPaneId === "string" && paneIds.includes(raw.focusedPaneId)
    ? raw.focusedPaneId
    : paneIds[0]!;
  const recentDocumentIds = Array.isArray(raw.recentDocumentIds)
    ? raw.recentDocumentIds.filter((id): id is string => typeof id === "string").slice(0, 40)
    : [];
  return { version: 1, root, focusedPaneId, recentDocumentIds };
}

export function resourceKey(resource: WorkspaceResource | null): string | null {
  if (!resource) return null;
  return `${resource.kind}:${resource.kind === "document" ? resource.documentId : resource.treeId}`;
}

export function sameResource(a: WorkspaceResource | null, b: WorkspaceResource | null): boolean {
  return resourceKey(a) === resourceKey(b);
}

export function collectPanes(node: WorkspaceNode): WorkspacePane[] {
  if (node.kind === "pane") return [node];
  return [...collectPanes(node.children[0]), ...collectPanes(node.children[1])];
}

export function collectTabs(node: WorkspaceNode): WorkspaceTab[] {
  return collectPanes(node).flatMap((pane) => pane.tabs);
}

function findPane(node: WorkspaceNode, paneId: string): WorkspacePane | null {
  return collectPanes(node).find((pane) => pane.id === paneId) ?? null;
}

function findTab(node: WorkspaceNode, tabId: string): { pane: WorkspacePane; tab: WorkspaceTab } | null {
  for (const pane of collectPanes(node)) {
    const tab = pane.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return { pane, tab };
  }
  return null;
}

function replaceNode(node: WorkspaceNode, id: string, replacement: WorkspaceNode): WorkspaceNode {
  if (node.id === id) return replacement;
  if (node.kind === "pane") return node;
  return {
    ...node,
    children: [replaceNode(node.children[0], id, replacement), replaceNode(node.children[1], id, replacement)],
  };
}

function removePane(node: WorkspaceNode, paneId: string): { node: WorkspaceNode; removed: boolean } {
  if (node.kind === "pane") return { node, removed: false };
  const [first, second] = node.children;
  if (first.kind === "pane" && first.id === paneId) return { node: second, removed: true };
  if (second.kind === "pane" && second.id === paneId) return { node: first, removed: true };
  const left = removePane(first, paneId);
  if (left.removed) return { node: { ...node, children: [left.node, second] }, removed: true };
  const right = removePane(second, paneId);
  if (right.removed) return { node: { ...node, children: [first, right.node] }, removed: true };
  return { node, removed: false };
}

function sanitizeSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return parseWorkspaceSnapshot(snapshot) ?? createEmptySnapshot();
}

export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot;
  private publishedSnapshot: WorkspaceSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly usedIds = new Set<string>();
  private tabLimit = Number.POSITIVE_INFINITY;
  private idCollisionCounter = 0;
  private readonly vaultId: string;
  private readonly persistence?: WorkspacePersistence;
  private readonly idFactory: (prefix: "pane" | "tab" | "split") => string;

  constructor(options: WorkspaceStoreOptions = {}) {
    this.vaultId = options.vaultId ?? "local";
    this.persistence = options.persistence;
    this.idFactory = options.idFactory ?? fallbackId;
    const persisted = this.persistence?.load(this.vaultId) ?? null;
    this.snapshot = sanitizeSnapshot(options.initial ?? persisted ?? createEmptySnapshot());
    this.publishedSnapshot = cloneSnapshot(this.snapshot);
    for (const pane of collectPanes(this.snapshot.root)) {
      this.usedIds.add(pane.id);
      for (const tab of pane.tabs) this.usedIds.add(tab.id);
    }
    for (const node of collectNodes(this.snapshot.root)) {
      if (node.kind === "split") this.usedIds.add(node.id);
    }
  }

  getSnapshot = (): WorkspaceSnapshot => this.publishedSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getFocusedPane(): WorkspacePane {
    return findPane(this.snapshot.root, this.snapshot.focusedPaneId) ?? collectPanes(this.snapshot.root)[0]!;
  }

  getFocusedTab(): WorkspaceTab {
    const pane = this.getFocusedPane();
    return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0]!;
  }

  getRecentDocumentIds(): string[] {
    return [...this.snapshot.recentDocumentIds];
  }

  setTabLimit(limit: number): void {
    this.tabLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  }

  open(resource: WorkspaceResource, options: WorkspaceOpenOptions = {}): string {
    const existing = collectTabs(this.snapshot.root).find((tab) => sameResource(tab.resource, resource));
    if (existing) {
      this.focusTab(existing.id);
      return existing.id;
    }
    const pane = findPane(this.snapshot.root, options.paneId ?? this.snapshot.focusedPaneId) ?? this.getFocusedPane();
    const mode = options.mode ?? "replace";
    let tabId = pane.activeTabId;
    if ((mode === "new" && this.canAddTab(pane)) || pane.tabs.length === 0) {
      tabId = this.nextId("tab");
      pane.tabs.push({ id: tabId, resource: cloneResource(resource) });
    } else {
      const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs[0]!;
      tabId = tab.id;
      tab.resource = cloneResource(resource);
      tab.collection = undefined;
    }
    pane.activeTabId = tabId;
    this.snapshot.focusedPaneId = pane.id;
    this.remember(resource);
    this.changed();
    return tabId;
  }

  newTab(paneId = this.snapshot.focusedPaneId): string {
    const pane = findPane(this.snapshot.root, paneId) ?? this.getFocusedPane();
    if (!this.canAddTab(pane)) return pane.activeTabId;
    const id = this.nextId("tab");
    pane.tabs.push({ id, resource: null, collection: "notes" });
    pane.activeTabId = id;
    this.snapshot.focusedPaneId = pane.id;
    this.changed();
    return id;
  }

  closeTab(tabId: string): string {
    const found = findTab(this.snapshot.root, tabId);
    if (!found) return this.getFocusedTab().id;
    const { pane } = found;
    if (pane.tabs.length === 1 && collectPanes(this.snapshot.root).length > 1) {
      this.snapshot.focusedPaneId = pane.id;
      this.closePane(pane.id);
      return this.getFocusedTab().id;
    }
    let nextTabId = pane.activeTabId;
    if (pane.tabs.length === 1) {
      pane.tabs[0]!.resource = null;
      pane.tabs[0]!.collection = "notes";
      pane.activeTabId = pane.tabs[0]!.id;
      nextTabId = pane.activeTabId;
    } else {
      const index = pane.tabs.findIndex((tab) => tab.id === tabId);
      pane.tabs.splice(index, 1);
      if (pane.activeTabId === tabId) {
        pane.activeTabId = pane.tabs[Math.max(0, index - 1)]!.id;
        nextTabId = pane.activeTabId;
      }
    }
    this.snapshot.focusedPaneId = pane.id;
    this.changed();
    return nextTabId;
  }

  focusTab(tabId: string): void {
    const found = findTab(this.snapshot.root, tabId);
    if (!found) return;
    found.pane.activeTabId = tabId;
    this.snapshot.focusedPaneId = found.pane.id;
    if (found.tab.resource) this.remember(found.tab.resource);
    this.changed();
  }

  openCollection(collection: WorkspaceCollection, paneId = this.snapshot.focusedPaneId): string {
    const pane = findPane(this.snapshot.root, paneId) ?? this.getFocusedPane();
    const tab = pane.tabs.find((candidate) => !candidate.resource);
    const tabId = tab?.id ?? (this.canAddTab(pane) ? this.nextId("tab") : pane.activeTabId);
    const target = pane.tabs.find((candidate) => candidate.id === tabId);
    if (target) {
      target.resource = null;
      target.collection = collection;
    } else {
      pane.tabs.push({ id: tabId, resource: null, collection });
    }
    pane.activeTabId = tabId;
    this.snapshot.focusedPaneId = pane.id;
    this.changed();
    return tabId;
  }

  focusPane(paneId: string): void {
    if (!findPane(this.snapshot.root, paneId)) return;
    this.snapshot.focusedPaneId = paneId;
    const tab = this.getFocusedTab();
    if (tab.resource) this.remember(tab.resource);
    this.changed();
  }

  split(paneId = this.snapshot.focusedPaneId, direction: WorkspaceSplit["direction"] = "horizontal"): string {
    const pane = findPane(this.snapshot.root, paneId);
    if (!pane) return this.snapshot.focusedPaneId;
    const newPane: WorkspacePane = {
      kind: "pane",
      id: this.nextId("pane"),
      tabs: [{ id: this.nextId("tab"), resource: null, collection: "notes" }],
      activeTabId: "",
    };
    newPane.activeTabId = newPane.tabs[0]!.id;
    const replacement: WorkspaceSplit = {
      kind: "split",
      id: this.nextId("split"),
      direction,
      children: [cloneNode(pane), newPane],
      sizes: [...EMPTY_SIZES],
    };
    this.snapshot.root = replaceNode(this.snapshot.root, pane.id, replacement);
    this.snapshot.focusedPaneId = newPane.id;
    this.changed();
    return newPane.id;
  }

  closePane(paneId: string): void {
    if (collectPanes(this.snapshot.root).length <= 1) return;
    const result = removePane(this.snapshot.root, paneId);
    if (!result.removed) return;
    this.snapshot.root = result.node;
    const panes = collectPanes(this.snapshot.root);
    if (!panes.some((pane) => pane.id === this.snapshot.focusedPaneId)) {
      this.snapshot.focusedPaneId = panes[0]!.id;
    }
    this.changed();
  }

  moveTab(tabId: string, paneId: string): void {
    const source = findTab(this.snapshot.root, tabId);
    const destination = findPane(this.snapshot.root, paneId);
    if (!source || !destination || source.pane.id === destination.id || !this.canAddTab(destination)) return;
    const index = source.pane.tabs.findIndex((tab) => tab.id === tabId);
    const [tab] = source.pane.tabs.splice(index, 1);
    if (!tab) return;
    destination.tabs.push(tab);
    destination.activeTabId = tab.id;
    this.snapshot.focusedPaneId = destination.id;
    if (source.pane.tabs.length === 0) {
      const blank = { id: this.nextId("tab"), resource: null, collection: "notes" as const };
      source.pane.tabs.push(blank);
      source.pane.activeTabId = blank.id;
    } else if (source.pane.activeTabId === tabId) {
      source.pane.activeTabId = source.pane.tabs[Math.max(0, index - 1)]!.id;
    }
    this.changed();
  }

  setSplitSizes(splitId: string, sizes: [number, number]): void {
    const node = findNode(this.snapshot.root, splitId);
    if (!node || node.kind !== "split") return;
    const normalized = normalizeSizes(sizes);
    if (node.sizes[0] === normalized[0] && node.sizes[1] === normalized[1]) return;
    node.sizes = normalized;
    this.changed();
  }

  prune(validResources: Iterable<WorkspaceResource>): void {
    const valid = new Set(Array.from(validResources, resourceKey));
    // Keep missing tab resources visible. The workspace can then explain that
    // a note or attachment is unavailable instead of silently showing a new
    // collection and inviting accidental replacement.
    this.snapshot.recentDocumentIds = this.snapshot.recentDocumentIds.filter((id) => valid.has(`document:${id}`));
    this.changed();
  }

  replaceFromDeepLink(resource: WorkspaceResource | null): void {
    const pane = this.getFocusedPane();
    const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs[0]!;
    tab.resource = cloneResource(resource);
    tab.collection = resource ? undefined : "notes";
    this.snapshot.focusedPaneId = pane.id;
    if (resource) this.remember(resource);
    this.changed();
  }

  private remember(resource: WorkspaceResource): void {
    if (resource.kind !== "document") return;
    this.snapshot.recentDocumentIds = [
      resource.documentId,
      ...this.snapshot.recentDocumentIds.filter((id) => id !== resource.documentId),
    ].slice(0, 40);
  }

  private nextId(prefix: "pane" | "tab" | "split"): string {
    const candidate = this.idFactory(prefix);
    if (!this.usedIds.has(candidate)) {
      this.usedIds.add(candidate);
      return candidate;
    }
    do {
      this.idCollisionCounter += 1;
    } while (this.usedIds.has(`${candidate}-${this.idCollisionCounter}`));
    const unique = `${candidate}-${this.idCollisionCounter}`;
    this.usedIds.add(unique);
    return unique;
  }

  private canAddTab(pane: WorkspacePane): boolean {
    return pane.tabs.length < this.tabLimit;
  }

  private changed(): void {
    this.publishedSnapshot = cloneSnapshot(this.snapshot);
    this.persistence?.save(this.vaultId, this.snapshot);
    for (const listener of this.listeners) listener();
  }
}

function findNode(node: WorkspaceNode, id: string): WorkspaceNode | null {
  if (node.id === id) return node;
  if (node.kind === "pane") return null;
  return findNode(node.children[0], id) ?? findNode(node.children[1], id);
}

function collectNodes(node: WorkspaceNode): WorkspaceNode[] {
  if (node.kind === "pane") return [node];
  return [node, ...collectNodes(node.children[0]), ...collectNodes(node.children[1])];
}

export class LocalStorageWorkspacePersistence implements WorkspacePersistence {
  constructor(private readonly prefix = "methyl.workspace.v1") {}

  load(vaultId: string): WorkspaceSnapshot | null {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(`${this.prefix}:${vaultId}`);
      return raw ? parseWorkspaceSnapshot(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  save(vaultId: string, snapshot: WorkspaceSnapshot): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(`${this.prefix}:${vaultId}`, JSON.stringify(snapshot));
    } catch {
      // Workspace state is a convenience. A full vault or disabled storage
      // must never make note editing fail.
    }
  }
}

export function createEmptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return createEmptySnapshot();
}
