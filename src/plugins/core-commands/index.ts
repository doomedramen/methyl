import { FolderPlus, PanelLeft, Plus, RefreshCw, Workflow } from "lucide-react";
import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";

export const CORE_COMMANDS_MANIFEST: PluginManifest = {
  id: "core-commands",
  name: "Core Commands",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

/**
 * Migrated actions from the old hard-coded CommandMenu Actions group.
 *
 * Deviation from the plan: theme commands (`theme-${id}`/`theme-system`) and
 * "Plugins: Manage" are NOT registered here. Theme switching needs
 * `next-themes`' `setTheme`, and the ESLint `no-restricted-imports` rule
 * (Task 12) forbids `src/plugins/**` from importing anything outside the
 * plugin API surface — including `@/lib/themes` (for `APP_THEMES`). Rather
 * than round-trip through `app.workspace.openDialog("theme:...")` as the
 * plan sketches, `VaultApp.tsx`'s plugin bridge registers the theme and
 * "Plugins: Manage" commands directly against the shared `CommandRegistry`
 * under the `core-commands` plugin id, alongside enabling this plugin. That
 * keeps `core-commands/index.ts` itself clean of any non-allowlisted import
 * from the start, instead of adding the import here and removing it in
 * Task 12.
 */
export class CoreCommandsPlugin extends Plugin {
  onload(): void {
    this.addCommand({ id: "new-note", name: "New note", icon: Plus, callback: async () => { await this.app.vault.createNote(); } });
    this.addCommand({
      id: "capture-thought",
      name: "Capture a thought",
      icon: Plus,
      callback: async () => {
        if (this.app.vault.captureThought) await this.app.vault.captureThought();
        else await this.app.vault.createNote();
      },
    });
    this.addCommand({ id: "new-graph", name: "New graph", icon: Workflow, callback: async () => { await this.app.vault.createGraph(); } });
    this.addCommand({ id: "new-folder", name: "New folder", icon: FolderPlus, callback: () => this.app.vault.createFolder("") });
    this.addCommand({ id: "toggle-sidebar", name: "Toggle sidebar", icon: PanelLeft, callback: () => this.app.workspace.toggleSidebar() });
    this.addCommand({
      id: "sync-settings",
      name: "Sync settings",
      icon: RefreshCw,
      keywords: ["server", "connect", "device"],
      callback: () => this.app.workspace.openDialog("sync"),
    });
  }
}
