import { Plugin, API_VERSION, type PluginManifest } from "@/lib/plugins/api";

export const CORE_GRAPHS_PLUGIN_ID = "core-graphs";

export const CORE_GRAPHS_MANIFEST: PluginManifest = {
  id: CORE_GRAPHS_PLUGIN_ID,
  name: "Graphs",
  description: "Visualise connected ideas on a canvas.",
  version: "1.0.0",
  minAppVersion: API_VERSION,
  isCore: true,
};

export class CoreGraphsPlugin extends Plugin {}
