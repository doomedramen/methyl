"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { PluginHost, PluginStatus } from "@/lib/plugins/host";
import type { CommandRegistry, RegisteredCommand } from "@/lib/plugins/commands";
import type { App, NoteContext } from "@/lib/plugins/api";

interface PluginContextValue {
  host: PluginHost;
  commands: CommandRegistry;
  app: App;
  activeNote: NoteContext | null;
}

const PluginContext = createContext<PluginContextValue | null>(null);

export function PluginHostProvider({
  host,
  commands,
  app,
  activeNote,
  children,
}: {
  host: PluginHost;
  commands: CommandRegistry;
  app: App;
  activeNote: NoteContext | null;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ host, commands, app, activeNote }), [host, commands, app, activeNote]);
  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}

function useContextValue(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePluginHost/useCommands must be used within a PluginHostProvider");
  return ctx;
}

export function usePluginHost(): PluginHost {
  return useContextValue().host;
}

export function useApp(): App {
  return useContextValue().app;
}

// `PluginHost.getSnapshot()`/`CommandRegistry.list()` allocate a fresh array
// on every call, which would make useSyncExternalStore's getSnapshot return
// a new reference on every render and loop forever. Cache the array here,
// keyed off the store's own change notifications (and, for commands, off
// `activeNote` too), so getSnapshot is referentially stable between renders
// until the underlying store actually changes.

export function usePluginStatuses(): PluginStatus[] {
  const { host } = useContextValue();
  const cacheRef = useRef<PluginStatus[] | null>(null);

  const getSnapshot = useCallback(() => {
    if (!cacheRef.current) cacheRef.current = host.getSnapshot();
    return cacheRef.current;
  }, [host]);

  const subscribe = useCallback(
    (cb: () => void) =>
      host.subscribe(() => {
        cacheRef.current = null;
        cb();
      }),
    [host],
  );

  // `PluginsDialog`/`CommandMenu` render inside VaultApp's SSR'd tree, so
  // this hook runs during the server render too; useSyncExternalStore
  // throws without a getServerSnapshot in that case.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useCommands(): RegisteredCommand[] {
  const { commands, activeNote } = useContextValue();
  const cacheRef = useRef<{ activeNote: NoteContext | null; list: RegisteredCommand[] } | null>(null);

  const getSnapshot = useCallback(() => {
    if (!cacheRef.current || cacheRef.current.activeNote !== activeNote) {
      cacheRef.current = { activeNote, list: commands.list(activeNote) };
    }
    return cacheRef.current.list;
  }, [commands, activeNote]);

  const subscribe = useCallback(
    (cb: () => void) =>
      commands.subscribe(() => {
        cacheRef.current = null;
        cb();
      }),
    [commands],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
