import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";

export const CORE_INBOX_PLUGIN_ID = "core-inbox";

export const CORE_INBOX_MANIFEST: PluginManifest = {
  id: CORE_INBOX_PLUGIN_ID,
  name: "Inbox",
  description: "Capture thoughts in a dedicated Inbox.",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreInboxPlugin extends Plugin {}
