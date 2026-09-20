import type { App, PluginManifest, Plugin } from "@/lib/plugins/api";
import { CoreAllNotesPlugin, CORE_ALL_NOTES_MANIFEST } from "@/plugins/core-all-notes";
import { CoreCommandsPlugin, CORE_COMMANDS_MANIFEST } from "@/plugins/core-commands";
import { CoreGraphsPlugin, CORE_GRAPHS_MANIFEST } from "@/plugins/core-graphs";
import { CoreInboxPlugin, CORE_INBOX_MANIFEST } from "@/plugins/core-inbox";
import { CoreLivePreviewPlugin, CORE_LIVE_PREVIEW_MANIFEST } from "@/plugins/core-live-preview";
import { CoreTemplatesPlugin, CORE_TEMPLATES_MANIFEST } from "@/plugins/core-templates";
import { CoreWikilinksPlugin, CORE_WIKILINKS_MANIFEST } from "@/plugins/core-wikilinks";
import { WordCountPlugin, WORD_COUNT_MANIFEST } from "@/plugins/word-count";

export const BUNDLED_PLUGINS: [PluginManifest, new (app: App, manifest: PluginManifest) => Plugin][] = [
  [CORE_ALL_NOTES_MANIFEST, CoreAllNotesPlugin],
  [CORE_COMMANDS_MANIFEST, CoreCommandsPlugin],
  [CORE_GRAPHS_MANIFEST, CoreGraphsPlugin],
  [CORE_INBOX_MANIFEST, CoreInboxPlugin],
  [CORE_LIVE_PREVIEW_MANIFEST, CoreLivePreviewPlugin],
  [CORE_TEMPLATES_MANIFEST, CoreTemplatesPlugin],
  [CORE_WIKILINKS_MANIFEST, CoreWikilinksPlugin],
  [WORD_COUNT_MANIFEST, WordCountPlugin],
];
