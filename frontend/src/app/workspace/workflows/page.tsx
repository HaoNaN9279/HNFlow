"use client";

import { useEffect } from "react";

import { WorkflowList } from "@/components/workspace/workflows/workflow-list";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import { setWorkflowLocation } from "@/core/workflows/editor-session";

export default function WorkflowsPage() {
  useEffect(() => {
    setWorkflowLocation({ kind: "directory" });
  }, []);

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <WorkflowList />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
