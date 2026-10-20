"use client";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
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
  revealCapabilityGroup,
  revealCapabilityGroupFile,
} from "@/core/capability-groups/hooks";
import {
  buildCapabilityFileTree,
  type CapabilityTreeNode,
} from "@/core/capability-groups/tree";
import type {
  CapabilityGroupDetail,
  CapabilityGroupFile,
  CapabilityGroupSummary,
} from "@/core/capability-groups/types";
import { useI18n } from "@/core/i18n/hooks";
import { usePersistedBoolean } from "@/hooks/use-persisted-toggle";
import { cn } from "@/lib/utils";

const BUILTIN_CATEGORY_ORDER = [
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

/**
 * Built-in categories keep their curated order; arbitrary top-level folders
 * (a group may invent its own categories by creating directories) follow
 * alphabetically.
 */
function orderedCategoryIds(ids: Iterable<string>): string[] {
  const present = new Set(ids);
  const ordered: string[] = BUILTIN_CATEGORY_ORDER.filter((id) =>
    present.has(id),
  );
  const dynamic = [...present]
    .filter((id) => !(BUILTIN_CATEGORY_ORDER as readonly string[]).includes(id))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return [...ordered, ...dynamic];
}

function categoryLabel(
  labels: ReturnType<typeof useI18n>["t"]["capabilityGroups"],
  id: string,
): string {
  return (labels.categories as Record<string, string | undefined>)[id] ?? id;
}

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
  const [open, setOpen] = usePersistedBoolean(
    `deerflow.ui.capability-group.open.${group.guid}`,
    false,
  );
  const detail = useCapabilityGroup(group.guid, group.version, open);
  const [revealing, setRevealing] = useState(false);
  const countCategories = orderedCategoryIds(
    Object.keys(group.counts).filter(
      (category) => (group.counts[category] ?? 0) > 0,
    ),
  );

  const revealRoot = async () => {
    setRevealing(true);
    try {
      await revealCapabilityGroup(group.guid, group.version);
      toast.success(labels.revealed);
    } catch (error) {
      toast.error(
        `${labels.revealFailed}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setRevealing(false);
    }
  };

  return (
    <section
      className="overflow-hidden rounded-md border"
      data-testid="capability-group"
      data-group-name={group.name}
    >
      <div className="hover:bg-muted/40 flex w-full items-center gap-2 px-3 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
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
            {countCategories
              .map(
                (category) =>
                  `${categoryLabel(labels, category)} ${group.counts[category]}`,
              )
              .join(" · ")}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          disabled={revealing}
          aria-label={`${labels.revealGroup} ${group.name}`}
          title={labels.revealGroup}
          data-testid="capability-group-reveal"
          onClick={() => void revealRoot()}
        >
          <FolderOpenIcon className="size-3.5" />
        </Button>
      </div>

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
  const categoryIds = orderedCategoryIds(
    group.categories
      .filter((item) => item.files.length > 0)
      .map((item) => item.id),
  );

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

  const toolRefs = group.tools ?? [];

  return (
    <div className="flex flex-col">
      {toolRefs.length > 0 && (
        <div className="border-b">
          <div className="bg-muted/30 text-muted-foreground px-3 py-1.5 text-[11px] font-medium tracking-wide uppercase">
            {labels.toolReferences}
          </div>
          <div className="flex flex-col">
            {toolRefs.map((ref) => {
              const permissions = group.tool_permissions?.[ref] ?? [];
              return (
                <div
                  key={ref}
                  className="flex items-center gap-2 border-t px-3 py-1.5 first:border-t-0"
                  data-testid="capability-group-tool-ref"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {ref}
                  </span>
                  {permissions.length > 0 && (
                    <span className="text-muted-foreground shrink-0 text-[10px]">
                      {labels.toolPermissions}: {permissions.join(", ")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {categoryIds.map((category) => {
        const entry = byCategory.get(category);
        if (!entry || entry.files.length === 0) {
          return null;
        }
        const tree = buildCapabilityFileTree(entry.files, category);
        return (
          <div key={category} className="border-b last:border-b-0">
            <div className="bg-muted/30 text-muted-foreground px-3 py-1.5 text-[11px] font-medium tracking-wide uppercase">
              {categoryLabel(labels, category)}
            </div>
            <div className="flex flex-col">
              <CapabilityTreeNodes
                nodes={tree}
                group={group}
                depth={0}
                revealingPath={revealingPath}
                onReveal={(file) => void reveal(file)}
              />
            </div>
          </div>
        );
      })}
      {categoryIds.length === 0 && (
        <div className="text-muted-foreground p-3 text-xs">
          {labels.noFiles}
        </div>
      )}
    </div>
  );
}

function CapabilityTreeNodes({
  nodes,
  group,
  depth,
  revealingPath,
  onReveal,
}: {
  nodes: CapabilityTreeNode[];
  group: CapabilityGroupDetail;
  depth: number;
  revealingPath: string | null;
  onReveal: (file: CapabilityGroupFile) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <CapabilityFolder
            key={`${group.guid}:${node.path}`}
            node={node}
            group={group}
            depth={depth}
            revealingPath={revealingPath}
            onReveal={onReveal}
          />
        ) : (
          <CapabilityFileRow
            key={`${group.guid}:${node.path}`}
            file={node.file}
            depth={depth}
            revealingPath={revealingPath}
            onReveal={onReveal}
          />
        ),
      )}
    </>
  );
}

function CapabilityFolder({
  node,
  group,
  depth,
  revealingPath,
  onReveal,
}: {
  node: Extract<CapabilityTreeNode, { kind: "folder" }>;
  group: CapabilityGroupDetail;
  depth: number;
  revealingPath: string | null;
  onReveal: (file: CapabilityGroupFile) => void;
}) {
  const [open, setOpen] = usePersistedBoolean(
    `deerflow.ui.capability-group.folder.${group.guid}.${group.version}.${node.path}`,
    true,
  );

  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="hover:bg-muted/20 flex items-center gap-2 border-t px-3 py-1.5 text-left first:border-t-0"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        aria-expanded={open}
        data-testid="capability-group-folder"
        data-folder-path={node.path}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? (
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <FolderIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {node.name}
        </span>
        <span className="text-muted-foreground shrink-0 text-[10px]">
          {node.fileCount}
        </span>
      </button>
      {open && (
        <CapabilityTreeNodes
          nodes={node.children}
          group={group}
          depth={depth + 1}
          revealingPath={revealingPath}
          onReveal={onReveal}
        />
      )}
    </div>
  );
}

function CapabilityFileRow({
  file,
  depth,
  revealingPath,
  onReveal,
}: {
  file: CapabilityGroupFile;
  depth: number;
  revealingPath: string | null;
  onReveal: (file: CapabilityGroupFile) => void;
}) {
  const { t } = useI18n();
  const labels = t.capabilityGroups;

  return (
    <div
      className="hover:bg-muted/20 flex items-center gap-3 border-t px-3 py-1.5 first:border-t-0"
      style={{ paddingLeft: `${12 + depth * 16}px` }}
      data-testid="capability-group-file"
      data-file-path={file.path}
    >
      <div
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          file.is_markdown ? "text-foreground" : "text-muted-foreground",
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
        onClick={() => onReveal(file)}
      >
        <FolderOpenIcon className="size-3.5" />
      </Button>
    </div>
  );
}
