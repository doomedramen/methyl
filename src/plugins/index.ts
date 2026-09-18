import type { App, PluginManifest, Plugin } from "@/lib/plugins/api";
import { CoreCommandsPlugin, CORE_COMMANDS_MANIFEST } from "@/plugins/core-commands";
import { CoreLivePreviewPlugin, CORE_LIVE_PREVIEW_MANIFEST } from "@/plugins/core-live-preview";
import { CoreWikilinksPlugin, CORE_WIKILINKS_MANIFEST } from "@/plugins/core-wikilinks";
import { WordCountPlugin, WORD_COUNT_MANIFEST } from "@/plugins/word-count";

export const BUNDLED_PLUGINS: [PluginManifest, new (app: App, manifest: PluginManifest) => Plugin][] = [
  [CORE_COMMANDS_MANIFEST, CoreCommandsPlugin],
  [CORE_LIVE_PREVIEW_MANIFEST, CoreLivePreviewPlugin],
  [CORE_WIKILINKS_MANIFEST, CoreWikilinksPlugin],
  [WORD_COUNT_MANIFEST, WordCountPlugin],
];
