"use client";

import { useParams } from "next/navigation";

import { WorkbenchBoard } from "@/components/workspace/workbenches/workbench-board";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";

export default function WorkbenchPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <WorkbenchBoard workbenchId={id} />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
