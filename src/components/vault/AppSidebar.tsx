"use client";

import { Inbox, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { PwaStatus } from "@/components/pwa/PwaStatus";

export interface NoteRow {
  id: string;
  title: string;
}

interface AppSidebarProps {
  notes: NoteRow[];
  activeId: string | null;
  onCreate: () => void;
  onSelect: (id: string) => void;
}

export function AppSidebar({
  notes,
  activeId,
  onCreate,
  onSelect,
}: AppSidebarProps) {
  const { setOpenMobile } = useSidebar();

  const pick = (id: string) => {
    onSelect(id);
    setOpenMobile(false);
  };

  return (
    <Sidebar variant="inset">
      <SidebarHeader className="flex-row items-center justify-between gap-2 pt-6 md:pt-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-wide">ADHD</h1>
          <p className="truncate text-xs text-muted-foreground">
            offline-first vault
          </p>
        </div>
        <Button
          variant="outline"
          size="icon-lg"
          onClick={onCreate}
          aria-label="New note"
          className="size-10 md:size-9"
        >
          <Plus />
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="px-2">Notes</SidebarGroupLabel>
          <SidebarGroupContent>
            {notes.length === 0 ? (
              <Empty className="border-0 p-4">
                <EmptyMedia variant="icon">
                  <Inbox />
                </EmptyMedia>
                <EmptyTitle className="text-sm">No notes yet</EmptyTitle>
              </Empty>
            ) : (
              <SidebarMenu>
                {notes.map((n) => (
                  <SidebarMenuItem key={n.id}>
                    <SidebarMenuButton
                      isActive={n.id === activeId}
                      size="lg"
                      onClick={() => pick(n.id)}
                      className="truncate"
                    >
                      <span className="truncate">{n.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="flex-row items-center justify-between gap-2">
        <PwaStatus />
      </SidebarFooter>
    </Sidebar>
  );
}