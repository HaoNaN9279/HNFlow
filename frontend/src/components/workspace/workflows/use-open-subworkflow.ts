"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { readSubworkflowSource } from "@/core/workflows/canvas/subworkflow";
import type { WorkflowNode } from "@/core/workflows/canvas/types";
import {
  currentTrailEntry,
  parseWorkflowTrail,
  workflowHref,
} from "@/core/workflows/trail";

import { useWorkflowEditor } from "./workflow-editor-context";

/**
 * Build the URL for a subworkflow node's child editor. Global template
 * references open the stored child workflow; local snapshots open the inline
 * definition rooted at the current workflow (or at the current embedded root).
 */
export function useOpenSubworkflow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { workflowId, definition, embedded, flushDraft } = useWorkflowEditor();

  return useCallback(
    (node: WorkflowNode) => {
      const source = readSubworkflowSource(node.params);
      if (!source) {
        return;
      }
      // The local child editor resolves its snapshot from this workflow's
      // draft. Persist the just-toggled mode before the route changes.
      flushDraft();
      const trail = parseWorkflowTrail(searchParams.get("trail"));
      const embeddedTarget = embedded
        ? { localRoot: embedded.rootId, localPath: embedded.path }
        : undefined;
      const nextTrail = [
        ...trail,
        currentTrailEntry(workflowId, definition.name, embeddedTarget),
      ];

      if (source.kind === "template") {
        router.push(workflowHref(source.templateId, nextTrail));
        return;
      }

      const localPath = embedded ? [...embedded.path, node.id] : [node.id];
      router.push(
        workflowHref(source.definition.id, nextTrail, {
          localRoot: embedded?.rootId ?? workflowId,
          localPath,
        }),
      );
    },
    [definition.name, embedded, flushDraft, router, searchParams, workflowId],
  );
}
