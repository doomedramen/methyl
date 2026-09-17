"use client";

import { useCallback } from "react";
import { CloudCheck, CloudCog, Download, HardDrive, ShieldCheck } from "lucide-react";
import { formatBytes, usePwa } from "@/lib/browser/pwa";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";

/** Compact footer status: install affordance, storage persistence, quota. */
export function PwaStatus() {
  const pwa = usePwa();

  const install = useCallback(async () => {
    if (!pwa.installPrompt) return;
    await pwa.installPrompt.prompt();
  }, [pwa.installPrompt]);

  const used = pwa.quota?.usage;
  const total = pwa.quota?.quota;
  const usagePct = used !== undefined && total ? Math.min(100, (used / total) * 100) : undefined;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="justify-start gap-2 text-muted-foreground">
            {pwa.swRegistered ? (
              <CloudCheck className="text-primary" />
            ) : (
              <CloudCog className="animate-pulse" />
            )}
            {pwa.swRegistered ? "Offline ready" : "Starting…"}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-1">
          <Item size="sm">
            <ItemMedia>
              {pwa.swRegistered ? (
                <CloudCheck className="text-primary" />
              ) : (
                <CloudCog className="animate-pulse text-muted-foreground" />
              )}
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Service worker</ItemTitle>
            </ItemContent>
            <Badge variant={pwa.swRegistered ? "secondary" : "outline"}>
              {pwa.swRegistered ? "active" : "booting"}
            </Badge>
          </Item>

          <Item size="sm">
            <ItemMedia>
              <ShieldCheck
                className={pwa.persistent ? "text-primary" : "text-muted-foreground"}
              />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Storage persistence</ItemTitle>
            </ItemContent>
            <Badge variant={pwa.persistent ? "secondary" : "outline"}>
              {pwa.persistent === null || pwa.persistent === undefined
                ? "unknown"
                : pwa.persistent
                  ? "persistent"
                  : "best-effort"}
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
                    <span>Storage quota</span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatBytes(used)} / {formatBytes(total)}
                    </span>
                  </div>
                  <Progress value={usagePct ?? null} className="w-full" />
                </ItemContent>
              </Item>
            </>
          )}

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
  );
}
