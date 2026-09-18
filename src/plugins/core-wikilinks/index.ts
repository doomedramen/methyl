import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";
import { wikilinkCompletionSource } from "@/lib/editor/wikilink-autocomplete";

export const CORE_WIKILINKS_MANIFEST: PluginManifest = {
  id: "core-wikilinks",
  name: "Core Wikilinks",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreWikilinksPlugin extends Plugin {
  onload(): void {
    this.registerCompletionSource(
      wikilinkCompletionSource(() => this.app.workspace.getWikilinkCandidates?.() ?? []),
    );
  }
}
