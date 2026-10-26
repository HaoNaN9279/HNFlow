"use client";

import { useParams } from "next/navigation";

import { WorkbenchList } from "@/components/workspace/workbenches/workbench-list";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";

export default function ProjectWorkbenchesPage() {
  const { project_id: projectId } = useParams<{ project_id: string }>();
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <WorkbenchList projectId={projectId} />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
