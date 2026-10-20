"use client";

import {
  CalendarClock,
  LayersIcon,
  MessagesSquare,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useI18n } from "@/core/i18n/hooks";
import { resolveWorkflowNavPath } from "@/core/workflows/editor-session";

export function WorkspaceNavChatList() {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();

  // Returning to the Workflows tab restores whether the user was in the
  // directory or editing a specific workflow.
  const handleWorkflowsClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const target = resolveWorkflowNavPath();
    if (target === "/workspace/workflows") {
      return;
    }
    event.preventDefault();
    router.push(target);
  };

  return (
    <SidebarGroup className="pt-1">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton isActive={pathname === "/workspace/chats"} asChild>
            <Link className="text-muted-foreground" href="/workspace/chats">
              <MessagesSquare />
              <span>{t.sidebar.chats}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={pathname.startsWith("/workspace/scheduled-tasks")}
            asChild
          >
            <Link
              className="text-muted-foreground"
              href="/workspace/scheduled-tasks"
            >
              <CalendarClock />
              <span>{t.sidebar.scheduledTasks}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={pathname.startsWith("/workspace/workflows")}
            asChild
          >
            <Link
              className="text-muted-foreground"
              href="/workspace/workflows"
              onClick={handleWorkflowsClick}
            >
              <Workflow />
              <span>{t.workflows.title}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={pathname.startsWith("/workspace/capability-groups")}
            asChild
          >
            <Link
              className="text-muted-foreground"
              href="/workspace/capability-groups"
            >
              <LayersIcon />
              <span>{t.sidebar.capabilityGroups}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
