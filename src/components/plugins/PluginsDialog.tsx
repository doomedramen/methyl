"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { usePluginHost, usePluginStatuses } from "@/lib/plugins/react";

export function PluginsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const host = usePluginHost();
  const statuses = usePluginStatuses();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Plugins</DialogTitle>
          <DialogDescription>Enable or disable bundled plugins.</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {statuses.map((status) => (
            <li key={status.manifest.id} className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{status.manifest.name}</div>
                {status.manifest.description ? (
                  <p className="text-sm text-muted-foreground">{status.manifest.description}</p>
                ) : null}
                <p className="text-sm text-muted-foreground">{status.state}</p>
                {status.state === "failed" && status.error ? (
                  <p className="text-sm text-destructive">{status.error}</p>
                ) : null}
              </div>
              <Switch
                checked={status.state === "enabled"}
                onCheckedChange={(checked) => {
                  if (checked) void host.enable(status.manifest.id);
                  else void host.disable(status.manifest.id);
                }}
              />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
