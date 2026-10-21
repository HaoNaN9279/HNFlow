"use client";

import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";

import { WorkflowBreadcrumb } from "@/components/workspace/workflows/workflow-breadcrumb";
import { WorkflowCanvas } from "@/components/workspace/workflows/workflow-canvas";
import {
  WorkflowEditorProvider,
  useWorkflowEditor,
} from "@/components/workspace/workflows/workflow-editor-context";
import { WorkflowToolbar } from "@/components/workspace/workflows/workflow-toolbar";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import { useI18n } from "@/core/i18n/hooks";
import { setWorkflowLocation } from "@/core/workflows/editor-session";
import {
  embeddedWorkflowRecord,
  resolveEmbeddedDefinition,
  saveEmbeddedDefinition,
} from "@/core/workflows/embedded-subworkflow";
import { useWorkflow } from "@/core/workflows/hooks";
import { parseLocalPath, parseWorkflowTrail } from "@/core/workflows/trail";

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { t } = useI18n();

  const trail = useMemo(
    () => parseWorkflowTrail(searchParams.get("trail")),
    [searchParams],
  );
  const localRoot = searchParams.get("localRoot");
  const localPathKey = searchParams.get("localPath") ?? "";
  const workbenchId = searchParams.get("workbench");
  const isEmbedded = Boolean(localRoot && localPathKey);
  const workflowQuery = useWorkflow(isEmbedded ? localRoot : id);

  const embeddedRecord = useMemo(() => {
    if (!isEmbedded || !workflowQuery.data) {
      return null;
    }
    const definition = resolveEmbeddedDefinition(
      workflowQuery.data,
      parseLocalPath(localPathKey),
    );
    return definition ? embeddedWorkflowRecord(definition) : null;
  }, [isEmbedded, localPathKey, workflowQuery.data]);

  const embeddedConfig = useMemo(() => {
    if (!isEmbedded || !localRoot || !workflowQuery.data) {
      return undefined;
    }
    const path = parseLocalPath(localPathKey);
    return {
      rootId: localRoot,
      path,
      save: async (
        definition: Parameters<typeof saveEmbeddedDefinition>[2],
      ) => {
        saveEmbeddedDefinition(workflowQuery.data, path, definition);
      },
    };
  }, [isEmbedded, localPathKey, localRoot, workflowQuery.data]);

  const record = isEmbedded ? embeddedRecord : workflowQuery.data;
  const currentName = isEmbedded
    ? embeddedRecord?.name
    : workflowQuery.data?.name;
  const embeddedMissing =
    isEmbedded && workflowQuery.isSuccess && embeddedRecord === null;

  return (
    <WorkspaceContainer>
      <WorkspaceHeader>
        {currentName ? (
          <WorkflowBreadcrumb
            trail={trail}
            currentName={currentName}
            workbenchId={workbenchId}
          />
        ) : null}
      </WorkspaceHeader>
      <WorkspaceBody>
        {workflowQuery.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : workflowQuery.isError ? (
          <div
            className="text-destructive text-sm"
            data-testid="workflow-editor-error"
          >
            {t.workflows.errors.loadFailed}: {workflowQuery.error.message}
          </div>
        ) : embeddedMissing ? (
          <div
            className="text-destructive text-sm"
            data-testid="workflow-editor-error"
          >
            {t.workflows.properties.subworkflow.embeddedNotFound}
          </div>
        ) : record ? (
          <WorkflowEditorProvider
            key={`${record.id}:${localRoot ?? ""}:${localPathKey}`}
            record={record}
            embedded={embeddedConfig}
          >
            <WorkflowEditor />
          </WorkflowEditorProvider>
        ) : null}
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}

/** Layout shell that wires the shared editor state into the panes. */
function WorkflowEditor() {
  const { workflowId } = useWorkflowEditor();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Remember that the Workflows tab is currently showing this workflow, so the
  // sidebar returns here after a tab switch. The full URL keeps breadcrumb
  // ancestors and local-subworkflow targets intact.
  useEffect(() => {
    const query = searchParams.toString();
    setWorkflowLocation({
      kind: "editor",
      workflowId,
      href: query ? `${pathname}?${query}` : pathname,
    });
  }, [pathname, searchParams, workflowId]);

  return (
    <div className="flex size-full flex-col overflow-hidden">
      <WorkflowToolbar />
      <div className="flex min-h-0 flex-1">
        <WorkflowCanvas />
      </div>
    </div>
  );
}
