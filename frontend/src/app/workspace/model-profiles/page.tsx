"use client";

import { ModelProfileList } from "@/components/workspace/model-profiles/model-profile-list";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";

export default function ModelProfilesPage() {
  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <ModelProfileList />
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}
