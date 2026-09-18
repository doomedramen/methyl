import type { App, PluginManifest, Plugin } from "@/lib/plugins/api";
import { CoreCommandsPlugin, CORE_COMMANDS_MANIFEST } from "@/plugins/core-commands";

export const BUNDLED_PLUGINS: [PluginManifest, new (app: App, manifest: PluginManifest) => Plugin][] = [
  [CORE_COMMANDS_MANIFEST, CoreCommandsPlugin],
];
