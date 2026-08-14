"use client";

import { WorkflowList } from "@/components/workspace/workflows/workflow-list";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";

export default function WorkflowsPage() {
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <WorkflowList />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
