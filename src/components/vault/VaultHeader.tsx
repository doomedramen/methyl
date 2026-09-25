"use client";

import { Check, Circle, Link2, Plus, Search, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModeToggle } from "@/components/mode-toggle";
import type { SaveState } from "./use-save-feedback";

const SAVE_LABEL: Record<Exclude<SaveState, "idle">, string> = {
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Not saved",
};

/** The title bar: sidebar toggle, save status, backlinks, find, theme and capture. */
export function VaultHeader({
  activeId,
  saveState,
  backlinkCount,
  backlinksOpen,
  onOpenBacklinks,
  commandOpen,
  onOpenCommandMenu,
  showCapture,
  captureDisabled,
  onCapture,
}: {
  activeId: string | null;
  saveState: SaveState;
  backlinkCount: number;
  backlinksOpen: boolean;
  onOpenBacklinks: () => void;
  commandOpen: boolean;
  onOpenCommandMenu: () => void;
  showCapture: boolean;
  captureDisabled: boolean;
  onCapture: () => void;
}) {
  return (
    <header className="app-titlebar wco-drag flex min-h-14 shrink-0 items-center gap-2 bg-background px-3">
      <SidebarTrigger className="wco-no-drag size-11 md:size-8" />
      <div className="min-w-0 flex-1" />
      <div className="wco-no-drag ml-auto flex items-center gap-2">
        <span aria-live="polite" className="save-status-slot">
          {activeId && saveState !== "idle" && (
            <Badge
              variant={
                saveState === "saved" ? "secondary" : saveState === "error" ? "destructive" : "outline"
              }
              aria-label={SAVE_LABEL[saveState]}
              title={SAVE_LABEL[saveState]}
              className="animate-in fade-in-0 motion-reduce:animate-none"
            >
              {saveState === "saving" ? (
                <Spinner data-icon="inline-start" />
              ) : saveState === "saved" ? (
                <Check data-icon="inline-start" />
              ) : saveState === "error" ? (
                <TriangleAlert data-icon="inline-start" />
              ) : saveState === "dirty" ? (
                <Circle data-icon="inline-start" />
              ) : null}
              {SAVE_LABEL[saveState]}
            </Badge>
          )}
        </span>
        {activeId && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="backlinks-trigger relative !size-11 !min-h-11 !min-w-11"
                  aria-label="Show backlinks"
                  aria-expanded={backlinksOpen}
                  aria-haspopup="dialog"
                  onClick={onOpenBacklinks}
                >
                  <Link2 />
                  {backlinkCount > 0 && (
                    <Badge
                      aria-hidden="true"
                      variant="secondary"
                      className="pointer-events-none absolute -top-1 -right-1 min-w-5 px-1"
                    >
                      {backlinkCount > 99 ? "99+" : backlinkCount}
                    </Badge>
                  )}
                </Button>
              }
            />
            <TooltipContent>Show backlinks</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className="header-find wco-no-drag size-11 md:hidden"
                aria-label="Find notes"
                aria-expanded={commandOpen}
                aria-haspopup="dialog"
                title="Find notes"
                onClick={onOpenCommandMenu}
              >
                <Search />
              </Button>
            }
          />
          <TooltipContent>Find notes</TooltipContent>
        </Tooltip>
        <ModeToggle />
        {showCapture && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="default"
                  size="icon-lg"
                  className="capture-button wco-no-drag size-11 md:size-9"
                  aria-label="Capture a thought"
                  title="Capture a thought"
                  disabled={captureDisabled}
                  onClick={onCapture}
                >
                  <Plus />
                </Button>
              }
            />
            <TooltipContent>Capture a thought</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
