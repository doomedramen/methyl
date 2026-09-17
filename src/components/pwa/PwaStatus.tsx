"use client";

import { useCallback } from "react";
import {
  ClipboardCopy,
  CloudCheck,
  CloudCog,
  CloudOff,
  Download,
  HardDrive,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { formatBytes, usePwa, type PwaState } from "@/lib/browser/pwa";
import { useSync } from "@/lib/browser/sync-context";
import { SyncStatusRow, syncTriggerLabel } from "@/components/sync/SyncStatusRow";
import { SyncSettingsDialog } from "@/components/sync/SyncSettingsDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import type { VaultEngine } from "@/lib/vault/engine";
import { readDiagnostics } from "@/lib/vault/diagnostics";

const OFFLINE_COPY: Record<
  PwaState["offline"],
  { trigger: string; badge: string; description: string }
> = {
  pending: {
    trigger: "Checking offline…",
    badge: "Checking",
    description: "Setting up so the app opens without a connection.",
  },
  ready: {
    trigger: "Works offline",
    badge: "Ready",
    description: "The app opens and saves notes without a connection.",
  },
  disabled: {
    trigger: "Offline off (dev)",
    badge: "Off",
    description: "Offline support is off in development so code changes show on reload.",
  },
  unavailable: {
    trigger: "Online only",
    badge: "Unavailable",
    description:
      "This browser blocked offline support. Notes still save on this device, but the app needs a connection to open.",
  },
};

function OfflineIcon({ state }: { state: PwaState["offline"] }) {
  if (state === "ready") return <CloudCheck className="text-primary" />;
  if (state === "unavailable") return <CloudOff className="text-muted-foreground" />;
  return <CloudCog className="animate-pulse text-muted-foreground motion-reduce:animate-none" />;
}

/** Compact footer status: offline support, storage protection, space used. */
export function PwaStatus({ engine }: { engine: VaultEngine | null }) {
  const pwa = usePwa();
  const sync = useSync();

  const install = useCallback(async () => {
    if (!pwa.installPrompt) return;
    await pwa.installPrompt.prompt();
  }, [pwa.installPrompt]);

  const copyDiagnostics = useCallback(async () => {
    try {
      const entries = engine ? await readDiagnostics(engine.docStore) : [];
      const mdCount = engine ? (await engine.docStore.listMaterializedPaths()).length : 0;
      const summary = {
        vaultId: engine?.vaultId ?? null,
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
        docCount: engine?.tree.documentIds().length ?? null,
        materializedMarkdownCount: mdCount,
        storageQuota: pwa.quota,
        generatedAt: new Date().toISOString(),
      };
      const payload = JSON.stringify({ summary, diagnostics: entries }, null, 2);
      await navigator.clipboard.writeText(payload);
      toast.success("Diagnostics copied to clipboard.");
    } catch (err) {
      console.warn("[PwaStatus] failed to copy diagnostics", err);
      toast.error("Couldn't copy diagnostics. Try again.");
    }
  }, [engine, pwa.quota]);

  const used = pwa.quota?.usage;
  const total = pwa.quota?.quota;
  const usagePct = used !== undefined && total ? Math.min(100, (used / total) * 100) : undefined;
  const offline = OFFLINE_COPY[pwa.offline];
  const syncLabel = syncTriggerLabel(sync.status);

  return (
    <>
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="justify-start gap-2 text-muted-foreground">
            <OfflineIcon state={pwa.offline} />
            {syncLabel ?? offline.trigger}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80">
        <div className="flex flex-col gap-1">
          <Item size="sm">
            <ItemMedia>
              <OfflineIcon state={pwa.offline} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Offline access</ItemTitle>
              <ItemDescription className="line-clamp-none">{offline.description}</ItemDescription>
            </ItemContent>
            <Badge variant={pwa.offline === "ready" ? "secondary" : "outline"}>
              {offline.badge}
            </Badge>
          </Item>

          <SyncStatusRow />

          <Item size="sm">
            <ItemMedia>
              {pwa.persistent ? (
                <ShieldCheck className="text-primary" />
              ) : (
                <ShieldAlert className="text-muted-foreground" />
              )}
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Notes protected</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {pwa.persistent === true
                  ? "The browser won't clear your notes to free up space."
                  : pwa.persistent === false
                    ? "The browser may clear notes if the device runs low on space. Installing the app usually protects them."
                    : "Checking whether the browser keeps your notes."}
              </ItemDescription>
            </ItemContent>
            <Badge variant={pwa.persistent ? "secondary" : "outline"}>
              {pwa.persistent === true ? "Yes" : pwa.persistent === false ? "No" : "Checking"}
            </Badge>
          </Item>

          {total !== undefined && used !== undefined && (
            <>
              <Separator className="my-1" />
              <Item size="sm">
                <ItemMedia>
                  <HardDrive className="text-muted-foreground" />
                </ItemMedia>
                <ItemContent>
                  <div className="flex w-full items-center justify-between text-sm">
                    <span>Space used</span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatBytes(used)} of {formatBytes(total)}
                    </span>
                  </div>
                  <Progress value={usagePct ?? null} className="w-full" />
                </ItemContent>
              </Item>
            </>
          )}

          <Separator className="my-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={copyDiagnostics}
            className="w-full"
          >
            <ClipboardCopy data-icon="inline-start" />
            Copy diagnostics
          </Button>

          {pwa.installPrompt && (
            <>
              <Separator className="my-1" />
              <Button size="sm" onClick={install} className="w-full">
                <Download data-icon="inline-start" />
                Install app
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
    <SyncSettingsDialog />
    </>
  );
}
