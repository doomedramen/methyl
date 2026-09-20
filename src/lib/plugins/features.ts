import type { PluginStatus } from "@/lib/plugins/host";

export const CORE_ALL_NOTES_PLUGIN_ID = "core-all-notes";
export const CORE_GRAPHS_PLUGIN_ID = "core-graphs";
export const CORE_INBOX_PLUGIN_ID = "core-inbox";

export interface PluginFeatures {
  allNotes: boolean;
  graphs: boolean;
  inbox: boolean;
}

export const DEFAULT_PLUGIN_FEATURES: PluginFeatures = {
  allNotes: true,
  graphs: true,
  inbox: true,
};

export function getPluginFeatures(statuses: readonly PluginStatus[]): PluginFeatures {
  const isEnabled = (id: string): boolean => {
    const status = statuses.find((candidate) => candidate.manifest.id === id);
    // Keep features visible while the real vault host is still loading.
    // The real host replaces it after vault/plugin storage loads.
    return status ? status.state === "enabled" : true;
  };

  return {
    allNotes: isEnabled(CORE_ALL_NOTES_PLUGIN_ID),
    graphs: isEnabled(CORE_GRAPHS_PLUGIN_ID),
    inbox: isEnabled(CORE_INBOX_PLUGIN_ID),
  };
}

export type CollectionName = "notes" | "inbox" | "graphs";

export function isCollectionEnabled(collection: CollectionName, features: PluginFeatures): boolean {
  if (collection === "notes") return features.allNotes;
  if (collection === "inbox") return features.inbox;
  return features.graphs;
}
