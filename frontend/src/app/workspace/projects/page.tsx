"use client";

import { ProjectList } from "@/components/workspace/projects/project-list";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";

export default function ProjectsPage() {
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <ProjectList />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
