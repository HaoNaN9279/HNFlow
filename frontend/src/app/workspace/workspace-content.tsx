import { cookies } from "next/headers";
import { Toaster } from "sonner";

import { QueryClientProvider } from "@/components/query-client-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { CommandPalette } from "@/components/workspace/command-palette";
import { LeadAgentProvider } from "@/components/workspace/lead-agent/lead-agent-context";
import { SettingsDialogHost } from "@/components/workspace/settings";
import { WorkspaceShell } from "@/components/workspace/workflow-monitor/workspace-shell";
import { WorkspaceSettingsDeepLink } from "@/components/workspace/workspace-settings-deep-link";
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar";

function parseSidebarOpenCookie(
  value: string | undefined,
): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export async function WorkspaceContent({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const initialSidebarOpen = parseSidebarOpenCookie(
    cookieStore.get("sidebar_state")?.value,
  );

  return (
    <QueryClientProvider>
      <LeadAgentProvider>
        <SidebarProvider className="h-screen" defaultOpen={initialSidebarOpen}>
          <WorkspaceSidebar />
          <SidebarInset className="min-w-0 overflow-hidden">
            <WorkspaceShell>{children}</WorkspaceShell>
          </SidebarInset>
        </SidebarProvider>
        <CommandPalette />
        <SettingsDialogHost />
        <WorkspaceSettingsDeepLink />
        <Toaster position="top-center" />
      </LeadAgentProvider>
    </QueryClientProvider>
  );
}
