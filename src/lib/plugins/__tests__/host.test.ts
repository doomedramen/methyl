import { describe, expect, it, vi } from "vitest";
import { PluginHost } from "@/lib/plugins/host";
import { InMemoryPluginStorage } from "@/lib/plugins/storage";
import { Plugin, type App, type PluginManifest } from "@/lib/plugins/api";

function makeApp(): App {
  return {
    commands: { list: () => [], execute: () => {} },
    workspace: {
      getActiveNote: () => null,
      openNote: () => {},
      toggleSidebar: () => {},
      openDialog: () => {},
    },
    vault: {
      createNote: async () => "id",
      createGraph: async () => "id",
      createFolder: async () => {},
      read: async () => null,
      list: () => [],
    },
    notify: () => {},
  };
}

const manifestA: PluginManifest = { id: "plugin-a", name: "A", version: "1.0.0", minAppVersion: "1.0.0", isCore: true };
const manifestB: PluginManifest = { id: "plugin-b", name: "B", version: "1.0.0", minAppVersion: "1.0.0" };

describe("PluginHost", () => {
  it("enables and disables a plugin, tracking state", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    const onload = vi.fn();
    const onunload = vi.fn();
    class A extends Plugin {
      onload = onload;
      onunload = onunload;
    }
    host.register(manifestA, A);
    await host.enable("plugin-a");
    expect(onload).toHaveBeenCalledOnce();
    expect(host.list().find((s) => s.manifest.id === "plugin-a")?.state).toBe("enabled");

    await host.disable("plugin-a");
    expect(onunload).toHaveBeenCalledOnce();
    expect(host.list().find((s) => s.manifest.id === "plugin-a")?.state).toBe("disabled");
  });

  it("runs recorded disposers in reverse order on disable", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    const calls: string[] = [];
    class A extends Plugin {
      onload() {
        this.register(() => calls.push("first"));
        this.register(() => calls.push("second"));
      }
    }
    host.register(manifestA, A);
    await host.enable("plugin-a");
    await host.disable("plugin-a");
    expect(calls).toEqual(["second", "first"]);
  });

  it("rolls back partial registrations and marks failed when onload throws", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    const calls: string[] = [];
    class A extends Plugin {
      onload() {
        this.register(() => calls.push("disposed"));
        throw new Error("boom");
      }
    }
    host.register(manifestA, A);
    await host.enable("plugin-a");
    expect(calls).toEqual(["disposed"]);
    const status = host.list().find((s) => s.manifest.id === "plugin-a");
    expect(status?.state).toBe("failed");
    expect(status?.error).toContain("boom");
  });

  it("rejects enabling a plugin whose minAppVersion exceeds API_VERSION", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register({ ...manifestA, minAppVersion: "999.0.0" }, A);
    await host.enable("plugin-a");
    const status = host.list().find((s) => s.manifest.id === "plugin-a");
    expect(status?.state).toBe("failed");
    expect(status?.error).toMatch(/minAppVersion/);
  });

  it("defaults to enabling isCore plugins when plugins.json is absent", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    class B extends Plugin {}
    host.register(manifestA, A);
    host.register(manifestB, B);
    await host.enableFromStorage();
    expect(host.list().find((s) => s.manifest.id === "plugin-a")?.state).toBe("enabled");
    expect(host.list().find((s) => s.manifest.id === "plugin-b")?.state).toBe("disabled");
  });

  it("persists enabled state to plugins.json across host instances", async () => {
    const storage = new InMemoryPluginStorage();
    const host1 = new PluginHost(makeApp(), storage);
    class B extends Plugin {}
    host1.register(manifestB, B);
    await host1.enable("plugin-b");

    const host2 = new PluginHost(makeApp(), storage);
    host2.register(manifestB, B);
    await host2.enableFromStorage();
    expect(host2.list().find((s) => s.manifest.id === "plugin-b")?.state).toBe("enabled");
  });

  it("notifies subscribers on state change", async () => {
    const host = new PluginHost(makeApp(), new InMemoryPluginStorage());
    class A extends Plugin {}
    host.register(manifestA, A);
    const cb = vi.fn();
    host.subscribe(cb);
    await host.enable("plugin-a");
    expect(cb).toHaveBeenCalled();
  });
});
