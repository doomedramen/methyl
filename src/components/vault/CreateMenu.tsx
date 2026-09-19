"use client";

import { FilePlus, FileText, Plus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTemplatesEnabled } from "@/components/plugins/TemplatesDialog";
import type { CreateHandler } from "./create-actions";

interface CreateMenuProps {
  onCreate: CreateHandler;
  disabled?: boolean;
  className?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
}

/** Shared add control for creating notes, template notes, and graphs. */
export function CreateMenu({
  onCreate,
  disabled,
  className,
  variant = "ghost",
}: CreateMenuProps) {
  const templatesEnabled = useTemplatesEnabled();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant={variant}
                  size="icon-lg"
                  className={cn("relative", className)}
                  disabled={disabled}
                  aria-label="Add"
                >
                  <Plus />
                  <span className="sr-only">Add</span>
                </Button>
              }
            />
          }
        />
        <TooltipContent>Add</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onCreate({ kind: "note" })}>
          <FileText data-icon="inline-start" />
          New note
        </DropdownMenuItem>
        {templatesEnabled ? (
          <DropdownMenuItem onClick={() => onCreate({ kind: "template" })}>
            <FilePlus data-icon="inline-start" />
            From template
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => onCreate({ kind: "graph" })}>
          <Workflow data-icon="inline-start" />
          New graph
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
