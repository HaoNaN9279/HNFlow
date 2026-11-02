"use client";

import { FolderOpenIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/i18n/hooks";
import type { ProjectContentRecord } from "@/core/project-content/types";

type RevealHandler = (path: string) => void;

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div className="border-b last:border-b-0" data-testid={testId}>
      <div className="bg-muted/30 text-muted-foreground px-3 py-1.5 text-[11px] font-medium tracking-wide uppercase">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  onReveal,
  disabled,
  testId,
}: {
  label: string;
  hint?: string;
  onReveal?: RevealHandler;
  disabled?: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className="flex items-center gap-3 border-t px-3 py-1.5 first:border-t-0"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={label}>
        {label}
      </span>
      {hint && (
        <span className="text-muted-foreground shrink-0 text-[10px]">
          {hint}
        </span>
      )}
      {onReveal && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          disabled={disabled}
          aria-label={`${t.projectContent.reveal} ${label}`}
          title={t.projectContent.reveal}
          onClick={() => onReveal(label)}
        >
          <FolderOpenIcon className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * Read-only view of the project's own content layer.
 *
 * The project (not VibeStack) owns these files, so the panel never offers an
 * edit affordance — it reveals paths and surfaces the trust switches the
 * manifest declares.
 */
export function ProjectContentPanel({
  content,
  onReveal,
  revealDisabled = false,
}: {
  content: ProjectContentRecord;
  onReveal?: RevealHandler;
  revealDisabled?: boolean;
}) {
  const { t } = useI18n();
  const labels = t.projectContent;
  const hasAny =
    content.instructions.length > 0 ||
    content.rules.length > 0 ||
    content.skills.length > 0 ||
    content.tools.length > 0;

  return (
    <section
      className="overflow-hidden rounded-md border"
      data-testid="project-content"
    >
      <div className="flex flex-col gap-1 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{labels.title}</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {content.exists ? labels.contentRoot : labels.noContentRoot}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {labels.skillShadow}:{" "}
            {content.skill_shadow === "allow" ? labels.allow : labels.deny}
          </Badge>
          <Badge
            variant={content.allow_python_tools ? "default" : "outline"}
            className="text-[10px]"
          >
            {labels.pythonTools}:{" "}
            {content.allow_python_tools ? labels.allow : labels.deny}
          </Badge>
        </div>
        <p className="text-muted-foreground font-mono text-[11px]">
          {content.content_root ?? labels.contentRootMissing}
        </p>
        <p className="text-muted-foreground text-xs">{labels.description}</p>
        {content.warnings.map((warning) => (
          <p key={warning} className="text-xs text-amber-600">
            {warning}
          </p>
        ))}
      </div>

      {!hasAny ? (
        <div className="text-muted-foreground border-t p-3 text-xs">
          {labels.empty}
        </div>
      ) : (
        <div className="flex flex-col">
          {content.instructions.length > 0 && (
            <Section
              title={labels.instructions}
              testId="project-content-instructions"
            >
              {content.instructions.map((item) => (
                <Row
                  key={`instruction:${item.path}`}
                  label={item.path}
                  hint={item.layer}
                  onReveal={onReveal}
                  disabled={revealDisabled}
                  testId="project-content-instruction"
                />
              ))}
            </Section>
          )}
          {content.rules.length > 0 && (
            <Section title={labels.rules} testId="project-content-rules">
              {content.rules.map((item) => (
                <Row
                  key={`rule:${item.path}`}
                  label={item.path}
                  onReveal={onReveal}
                  disabled={revealDisabled}
                  testId="project-content-rule"
                />
              ))}
            </Section>
          )}
          {content.skills.length > 0 && (
            <Section title={labels.skills} testId="project-content-skills">
              {content.skills.map((item) => (
                <Row
                  key={`skill:${item.name}`}
                  label={item.name}
                  hint={item.description}
                  onReveal={onReveal}
                  disabled={revealDisabled}
                  testId="project-content-skill"
                />
              ))}
            </Section>
          )}
          {content.tools.length > 0 && (
            <Section title={labels.tools} testId="project-content-tools">
              {content.tools.map((item) => (
                <Row
                  key={`tool:${item.ref}`}
                  label={item.ref}
                  hint={item.error || item.provider}
                  testId="project-content-tool"
                />
              ))}
            </Section>
          )}
        </div>
      )}
    </section>
  );
}
