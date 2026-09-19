"use client";

import { useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";
import { APP_THEMES } from "@/lib/themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function ModeToggle() {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-lg"
                  className="relative size-11 md:size-9"
                >
                  <Sun className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
                  <Moon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
                  <span className="sr-only">Toggle theme</span>
                </Button>
              }
            />
          }
        />
        <TooltipContent>Toggle theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {APP_THEMES.map(({ id, label, icon: Icon }) => (
          <DropdownMenuItem key={id} onClick={() => setTheme(id)}>
            <Icon data-icon="inline-start" />
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor data-icon="inline-start" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
