import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLUGIN_FEATURES,
  getPluginFeatures,
  isCollectionEnabled,
} from "@/lib/plugins/features";

function status(id: string, state: "disabled" | "enabled" | "failed") {
  return { manifest: { id, name: id, version: "1.0.0", minAppVersion: "1.0.0" }, state } as const;
}

describe("plugin-backed collections", () => {
  it("keeps collections enabled before the vault host registers plugins", () => {
    expect(getPluginFeatures([])).toEqual(DEFAULT_PLUGIN_FEATURES);
  });

  it("uses plugin state to gate all three collections", () => {
    const features = getPluginFeatures([
      status("core-all-notes", "disabled"),
      status("core-graphs", "failed"),
      status("core-inbox", "failed"),
    ]);

    expect(features).toEqual({ allNotes: false, graphs: false, inbox: false });
    expect(isCollectionEnabled("notes", features)).toBe(false);
    expect(isCollectionEnabled("inbox", features)).toBe(false);
    expect(isCollectionEnabled("graphs", features)).toBe(false);
  });
});
