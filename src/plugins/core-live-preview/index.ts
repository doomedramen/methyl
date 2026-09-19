import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";
import { livePreview } from "@/lib/editor/live-preview";

export const CORE_LIVE_PREVIEW_MANIFEST: PluginManifest = {
  id: "core-live-preview",
  name: "Core Live Preview",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreLivePreviewPlugin extends Plugin {
  onload(): void {
    this.registerEditorExtension(
      livePreview({
        resolveWikilink: (target) => this.app.workspace.resolveWikilink?.(target),
        onOpenWikilink: (documentId) => this.app.workspace.openNote(documentId),
        onCreateWikilink: (target) => this.app.workspace.createWikilinkTarget?.(target),
        resolveAttachment: (target) => this.app.workspace.resolveAttachment?.(
          target,
          this.app.workspace.getActiveNote()?.documentId,
        ),
        loadAttachment: (target) => this.app.workspace.loadAttachment?.(
          target,
          this.app.workspace.getActiveNote()?.documentId,
        ) ?? Promise.resolve(undefined),
      }),
    );
  }
}
