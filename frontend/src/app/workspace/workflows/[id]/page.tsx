"use client";

import { useParams } from "next/navigation";

import { WorkflowCanvas } from "@/components/workspace/workflows/workflow-canvas";
import {
  WorkflowEditorProvider,
  useWorkflowEditor,
} from "@/components/workspace/workflows/workflow-editor-context";
import { WorkflowPalette } from "@/components/workspace/workflows/workflow-palette";
import { WorkflowPropertiesPanel } from "@/components/workspace/workflows/workflow-properties-panel";
import { WorkflowToolbar } from "@/components/workspace/workflows/workflow-toolbar";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import { useI18n } from "@/core/i18n/hooks";
import { useWorkflow } from "@/core/workflows/hooks";

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const workflowQuery = useWorkflow(id);

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        {workflowQuery.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : workflowQuery.isError ? (
          <div className="text-destructive text-sm" data-testid="workflow-editor-error">
            {t.workflows.errors.loadFailed}: {workflowQuery.error.message}
          </div>
        ) : workflowQuery.data ? (
          <WorkflowEditorProvider record={workflowQuery.data}>
            <WorkflowEditor />
          </WorkflowEditorProvider>
        ) : null}
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}

/** Layout shell that wires the shared editor state into the three panes. */
function WorkflowEditor() {
  const {
    selectedNode,
    updateNodeParams,
    deleteNode,
    readonly,
  } = useWorkflowEditor();

  return (
    <div className="flex size-full flex-col overflow-hidden">
      <WorkflowToolbar />
      <div className="flex min-h-0 flex-1">
        <WorkflowPalette />
        <WorkflowCanvas />
        <WorkflowPropertiesPanel
          node={selectedNode}
          readonly={readonly}
          onUpdateNodeParams={updateNodeParams}
          onDeleteNode={deleteNode}
        />
      </div>
    </div>
  );
}
