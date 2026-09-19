export const WORKSPACE_TAB_MIN_WIDTH = 120;
export const WORKSPACE_TAB_ACTIONS_WIDTH = 100;
export const WORKSPACE_TABBAR_PADDING = 20;
export const DEFAULT_WORKSPACE_TAB_LIMIT = 8;

export function maxWorkspaceTabsForWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WORKSPACE_TAB_LIMIT;

  const availableWidth = width - WORKSPACE_TAB_ACTIONS_WIDTH - WORKSPACE_TABBAR_PADDING;
  return Math.max(1, Math.floor(availableWidth / WORKSPACE_TAB_MIN_WIDTH));
}
