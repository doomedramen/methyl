"use client";

import { FileText, Plus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface CreateMenuProps {
  onCreateNote: () => void;
  onCreateGraph: () => void;
  disabled?: boolean;
  className?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
}

/** Shared add control for creating notes and graphs. */
export function CreateMenu({
  onCreateNote,
  onCreateGraph,
  disabled,
  className,
  variant = "ghost",
}: CreateMenuProps) {
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
        <DropdownMenuItem onClick={onCreateNote}>
          <FileText data-icon="inline-start" />
          New note
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCreateGraph}>
          <Workflow data-icon="inline-start" />
          New graph
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
