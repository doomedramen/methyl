import type { EditorView } from "@codemirror/view";

/**
 * Maps mounted editor views to workspace tabs. The old single ref was
 * mount-order dependent as soon as a split contained two editors.
 */
export class ActiveEditorRegistry {
  private readonly views = new Map<string, EditorView>();
  private focusedTabId: string | null = null;

  set(tabId: string, view: EditorView | null): void {
    if (view) {
      this.views.set(tabId, view);
      this.focusedTabId = tabId;
    } else {
      this.views.delete(tabId);
      if (this.focusedTabId === tabId) this.focusedTabId = null;
    }
  }

  focus(tabId: string): void {
    if (this.views.has(tabId)) this.focusedTabId = tabId;
  }

  get(tabId: string | null | undefined): EditorView | null {
    return tabId ? this.views.get(tabId) ?? null : null;
  }

  getFocused(): EditorView | null {
    return this.get(this.focusedTabId);
  }

  clear(): void {
    this.views.clear();
    this.focusedTabId = null;
  }
}
