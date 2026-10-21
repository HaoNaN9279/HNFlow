"use client";

import Link from "next/link";
import { Fragment } from "react";

import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  hrefForTrailEntry,
  type WorkflowTrailEntry,
} from "@/core/workflows/trail";
import type { WorkflowFolder } from "@/core/workflows/workflow-folders";

type WorkflowBreadcrumbProps = {
  trail: WorkflowTrailEntry[];
  currentName: string;
  workbenchId?: string | null;
  folderPath?: WorkflowFolder[];
};

/**
 * Ancestor workflow levels plus the current workflow. `WorkspaceHeader`
 * renders the leading separator; every later level adds its own.
 */
export function WorkflowBreadcrumb({
  trail,
  currentName,
  workbenchId,
  folderPath = [],
}: WorkflowBreadcrumbProps) {
  return (
    <>
      {folderPath.map((folder, index) => (
        <Fragment key={folder.id}>
          {index > 0 && <BreadcrumbSeparator className="hidden md:block" />}
          <BreadcrumbItem className="hidden md:block">
            <BreadcrumbLink asChild>
              <Link
                href={`/workspace/workflows?folder=${encodeURIComponent(folder.id)}`}
              >
                {folder.name}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </Fragment>
      ))}
      {trail.map((entry, index) => (
        <Fragment key={`${entry.id}:${index}`}>
          {(folderPath.length > 0 || index > 0) && (
            <BreadcrumbSeparator className="hidden md:block" />
          )}
          <BreadcrumbItem className="hidden md:block">
            <BreadcrumbLink asChild>
              <Link
                href={hrefForTrailEntry(
                  entry,
                  trail.slice(0, index),
                  workbenchId,
                )}
              >
                {entry.name}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </Fragment>
      ))}
      {(folderPath.length > 0 || trail.length > 0) && <BreadcrumbSeparator />}
      <BreadcrumbItem>
        <BreadcrumbPage data-testid="workflow-breadcrumb-current">
          {currentName}
        </BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );
}
