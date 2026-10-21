"use client";

import { WorkbenchList } from "@/components/workspace/workbenches/workbench-list";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";

export default function WorkbenchesPage() {
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <WorkbenchList />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
