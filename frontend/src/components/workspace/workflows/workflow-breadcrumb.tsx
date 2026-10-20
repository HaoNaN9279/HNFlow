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

type WorkflowBreadcrumbProps = {
  trail: WorkflowTrailEntry[];
  currentName: string;
};

/**
 * Ancestor workflow levels plus the current workflow. `WorkspaceHeader`
 * renders the leading separator; every later level adds its own.
 */
export function WorkflowBreadcrumb({
  trail,
  currentName,
}: WorkflowBreadcrumbProps) {
  return (
    <>
      {trail.map((entry, index) => (
        <Fragment key={`${entry.id}:${index}`}>
          {index > 0 && <BreadcrumbSeparator className="hidden md:block" />}
          <BreadcrumbItem className="hidden md:block">
            <BreadcrumbLink asChild>
              <Link href={hrefForTrailEntry(entry, trail.slice(0, index))}>
                {entry.name}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </Fragment>
      ))}
      {trail.length > 0 && <BreadcrumbSeparator />}
      <BreadcrumbItem>
        <BreadcrumbPage data-testid="workflow-breadcrumb-current">
          {currentName}
        </BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );
}
