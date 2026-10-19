"use client";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import {
  useCapabilityGroup,
  useCapabilityGroups,
  revealCapabilityGroupFile,
} from "@/core/capability-groups/hooks";
import type {
  CapabilityGroupDetail,
  CapabilityGroupFile,
  CapabilityGroupSummary,
} from "@/core/capability-groups/types";
import { useI18n } from "@/core/i18n/hooks";
import { cn } from "@/lib/utils";

const CATEGORY_ORDER = [
  "rules",
  "agents",
  "skills",
  "tools",
  "references",
  "templates",
  "assets",
  "evals",
  "other",
] as const;

export default function CapabilityGroupsPage() {
  const { t } = useI18n();
  const labels = t.capabilityGroups;
  const query = useCapabilityGroups();

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-5">
          <header className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold">{labels.title}</h1>
            <p className="text-muted-foreground text-sm">
              {labels.description}
            </p>
          </header>

          {query.isLoading ? (
            <div className="text-muted-foreground py-8 text-sm">
              {labels.loading}
            </div>
          ) : query.isError ? (
            <div className="border-destructive/40 bg-destructive/5 flex items-center justify-between gap-3 rounded-md border p-3">
              <span className="text-destructive text-sm">
                {labels.loadFailed}: {query.error.message}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void query.refetch()}
              >
                <RefreshCwIcon className="size-3.5" />
                {labels.retry}
              </Button>
            </div>
          ) : query.data && query.data.length > 0 ? (
            <div className="flex flex-col gap-2">
              {query.data.map((group) => (
                <CapabilityGroupRow
                  key={`${group.source}:${group.guid}`}
                  group={group}
                />
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground rounded-md border border-dashed p-8 text-center text-sm">
              <p>{labels.empty}</p>
              <p className="mt-1 text-xs">{labels.emptyHint}</p>
            </div>
          )}
        </div>
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}

function CapabilityGroupRow({ group }: { group: CapabilityGroupSummary }) {
  const { t } = useI18n();
  const labels = t.capabilityGroups;
  const [open, setOpen] = useState(false);
  const detail = useCapabilityGroup(group.guid, group.version, open);

  return (
    <section
      className="overflow-hidden rounded-md border"
      data-testid="capability-group"
      data-group-name={group.name}
    >
      <button
        type="button"
        className="hover:bg-muted/40 flex w-full items-center gap-3 px-3 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? (
          <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{group.name}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              v{group.version}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {labels.source[group.source]}
            </Badge>
          </div>
          {group.description && (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {group.description}
            </p>
          )}
        </div>
        <span className="text-muted-foreground hidden shrink-0 text-[11px] sm:block">
          {CATEGORY_ORDER.filter(
            (category) => (group.counts[category] ?? 0) > 0,
          )
            .map(
              (category) =>
                `${labels.categories[category]} ${group.counts[category]}`,
            )
            .join(" 路 ")}
        </span>
      </button>

      {open && (
        <div className="border-t">
          {detail.isLoading ? (
            <div className="text-muted-foreground p-3 text-xs">
              {labels.loadingContents}
            </div>
          ) : detail.isError ? (
            <div className="text-destructive p-3 text-xs">
              {labels.loadContentsFailed}: {detail.error.message}
            </div>
          ) : detail.data ? (
            <CapabilityGroupContents group={detail.data} />
          ) : null}
        </div>
      )}
    </section>
  );
}

export function CapabilityGroupContents({
  group,
}: {
  group: CapabilityGroupDetail;
}) {
  const { t } = useI18n();
  const labels = t.capabilityGroups;
  const [revealingPath, setRevealingPath] = useState<string | null>(null);
  const byCategory = new Map(group.categories.map((item) => [item.id, item]));

  const reveal = async (file: CapabilityGroupFile) => {
    setRevealingPath(file.path);
    try {
      await revealCapabilityGroupFile(group.guid, file.path, group.version);
      toast.success(labels.revealed);
    } catch (error) {
      toast.error(
        `${labels.revealFailed}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setRevealingPath(null);
    }
  };

  return (
    <div className="flex flex-col">
      {CATEGORY_ORDER.map((category) => {
        const entry = byCategory.get(category);
        if (!entry || entry.files.length === 0) {
          return null;
        }
        return (
          <div key={category} className="border-b last:border-b-0">
            <div className="bg-muted/30 text-muted-foreground px-3 py-1.5 text-[11px] font-medium tracking-wide uppercase">
              {labels.categories[category]}
            </div>
            <div className="flex flex-col">
              {entry.files.map((file) => (
                <div
                  key={file.path}
                  className="hover:bg-muted/20 flex items-center gap-3 border-t px-3 py-1.5 first:border-t-0"
                  data-testid="capability-group-file"
                  data-file-path={file.path}
                >
                  <div
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      file.is_markdown
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                    title={file.path}
                  >
                    <span className="font-medium">{file.name}</span>
                    {(file.summary || !file.is_markdown) && (
                      <span className="text-muted-foreground ml-2">
                        {file.is_markdown ? file.summary : file.path}
                      </span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0"
                    disabled={revealingPath !== null}
                    aria-label={`${labels.reveal} ${file.name}`}
                    title={labels.reveal}
                    onClick={() => void reveal(file)}
                  >
                    <FolderOpenIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {group.categories.length === 0 && (
        <div className="text-muted-foreground p-3 text-xs">
          {labels.noFiles}
        </div>
      )}
    </div>
  );
}
