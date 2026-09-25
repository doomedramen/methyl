"use client";

import { APP_VERSION, versionsDiffer } from "@/lib/core/version";
import { CloudAlert, CloudOff, RefreshCw, Settings2 } from "lucide-react";
import type { SyncStatus } from "@/lib/browser/sync-host";
import { useSync } from "@/lib/browser/sync-context";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

const COPY: Record<
  SyncStatus["kind"],
  { title: string; badge: string; description: string }
> = {
  idle: {
    title: "Sync not set up",
    badge: "Not set up",
    description: "Connect a Methyl server to pick up files copied into its mounted vault.",
  },
  connecting: {
    title: "Connecting…",
    badge: "Connecting",
    description: "Reaching your sync server.",
  },
  synced: {
    title: "Synced",
    badge: "Synced",
    description: "Up to date with your sync server.",
  },
  offline: {
    title: "Offline",
    badge: "Offline",
    description: "No connection right now — will keep retrying. Notes still save on this device.",
  },
  error: {
    title: "Sync error",
    badge: "Error",
    description: "Couldn't reach the sync server. Will keep retrying.",
  },
};

function icon(status: SyncStatus) {
  switch (status.kind) {
    case "connecting":
      return <Spinner className="text-muted-foreground" />;
    case "synced":
      return <RefreshCw className="text-primary" />;
    case "offline":
      return <CloudOff className="text-muted-foreground" />;
    case "error":
      return <CloudAlert className="text-destructive" />;
    default:
      return <Settings2 className="text-muted-foreground" />;
  }
}

function lastSyncedLabel(status: SyncStatus): string | null {
  if (status.kind !== "synced") return null;
  return `Last synced ${new Date(status.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** "Sync" row for the footer status popover — plain language, no jargon. */
export function SyncStatusRow() {
  const { status, canSync, setDialogOpen, serverVersion } = useSync();
  const copy = COPY[status.kind];
  const base =
    status.kind === "error" && "message" in status && status.message
      ? `${copy.description} (${status.message})`
      : lastSyncedLabel(status) ?? copy.description;
  // Client and server from different releases may not understand each
  // other fully: say so, so the user updates one side.
  const description =
    serverVersion && versionsDiffer(APP_VERSION, serverVersion)
      ? `${base} The server runs Methyl ${serverVersion} and this app is ${APP_VERSION}; update the older one.`
      : base;

  return (
    <Item
      size="sm"
      render={<button type="button" onClick={() => setDialogOpen(true)} />}
      className="cursor-pointer text-left"
    >
      <ItemMedia>{icon(status)}</ItemMedia>
      <ItemContent>
        <ItemTitle>Sync</ItemTitle>
        <ItemDescription className="line-clamp-none">{description}</ItemDescription>
      </ItemContent>
      <Badge variant={status.kind === "synced" ? "secondary" : "outline"}>
        {canSync || status.kind !== "idle" ? copy.badge : "Not set up"}
      </Badge>
    </Item>
  );
}

/** Compact label for the footer trigger button when sync is configured. */
export function syncTriggerLabel(status: SyncStatus): string | null {
  switch (status.kind) {
    case "connecting":
      return "Syncing…";
    case "synced":
      return "Synced";
    case "offline":
      return "Sync offline";
    case "error":
      return "Sync error";
    default:
      return null;
  }
}
