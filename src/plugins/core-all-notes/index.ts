import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";

export const CORE_ALL_NOTES_PLUGIN_ID = "core-all-notes";

export const CORE_ALL_NOTES_MANIFEST: PluginManifest = {
  id: CORE_ALL_NOTES_PLUGIN_ID,
  name: "All notes",
  description: "Browse every note in one collection.",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreAllNotesPlugin extends Plugin {}
