"use client";

import { AlertCircleIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useI18n } from "@/core/i18n/hooks";
import type { WorkflowValidationError } from "@/core/workflows/errors";

/**
 * Error strip for backend 422 validation failures. Each entry renders its
 * message; entries carrying a node/edge id expose it as `data-error-id` so the
 * canvas and E2E tests can correlate the strip with the highlighted element.
 */
export function WorkflowErrorList({
  errors,
}: {
  errors: WorkflowValidationError[];
}) {
  const { t } = useI18n();
  if (errors.length === 0) {
    return null;
  }
  return (
    <Alert variant="destructive" data-testid="workflow-error-list">
      <AlertCircleIcon />
      <AlertTitle>{t.workflows.errors.validationPrefix}</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {errors.map((error, index) => (
            <li
              key={`${error.type}-${error.id ?? "unknown"}-${index}`}
              data-error-id={error.id}
            >
              {error.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
