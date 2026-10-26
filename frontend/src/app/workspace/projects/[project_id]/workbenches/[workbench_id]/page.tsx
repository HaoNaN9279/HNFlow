"use client";

import { useParams } from "next/navigation";

import { WorkbenchBoard } from "@/components/workspace/workbenches/workbench-board";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";

export default function ProjectWorkbenchPage() {
  const { project_id: projectId, workbench_id: workbenchId } = useParams<{
    project_id: string;
    workbench_id: string;
  }>();
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <WorkbenchBoard projectId={projectId} workbenchId={workbenchId} />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
