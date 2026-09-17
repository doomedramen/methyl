"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { VaultAccessStatus } from "@/lib/browser/vault";
import { Button } from "@/components/ui/button";

/**
 * Shown when this tab doesn't hold the vault's writer lock (§12) — another
 * tab already has it. The editor itself is read-only (see NoteEditor's
 * `readOnly` prop); this banner explains why and offers a way out.
 */
export function VaultAccessBanner({ engine }: { engine: unknown }) {
  const [status, setStatus] = useState<VaultAccessStatus | null>(null);

  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    import("@/lib/browser/vault").then(({ getVaultAccessStatus, onVaultAccessStatusChange }) => {
      if (cancelled) return;
      setStatus(getVaultAccessStatus());
      cleanup = onVaultAccessStatusChange((next) => {
        if (!cancelled) setStatus(next);
      });
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [engine]);

  if (!status || status.kind === "writer") return null;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/50 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <TriangleAlert className="size-4 shrink-0" />
        <span>
          {status.promotable
            ? "This vault is free — reload to edit from this tab."
            : "This vault is open for editing in another tab. This tab is read-only."}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={status.promotable ? status.reload : status.takeOver}
      >
        {status.promotable ? "Reload" : "Use here"}
      </Button>
    </div>
  );
}
