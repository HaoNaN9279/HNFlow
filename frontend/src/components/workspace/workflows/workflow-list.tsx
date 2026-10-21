"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoveIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/core/i18n/hooks";
import { updateWorkflow } from "@/core/workflows/api";
import { getDefaultNode } from "@/core/workflows/canvas/node-catalog";
import {
  buildWorkflowDirectoryTree,
  workflowFolderOptions,
  workflowFolderPath,
  type WorkflowFolderNode,
} from "@/core/workflows/folder-tree";
import {
  useCreateWorkflow,
  useDeleteWorkflow,
  useWorkflows,
} from "@/core/workflows/hooks";
import type { WorkflowRecord } from "@/core/workflows/types";
import {
  useCreateWorkflowFolder,
  useDeleteWorkflowFolder,
  useUpdateWorkflowFolder,
  useWorkflowFolders,
} from "@/core/workflows/workflow-folders";
import type { WorkflowFolder } from "@/core/workflows/workflow-folders";

/**
 * A structurally valid starter definition for a brand-new workflow.
 *
 * The backend validates every saved definition (`validate_definition`) and
 * requires exactly one `flow:start` and one `flow:end`, so an empty graph is
 * rejected with 422. Seed the canvas with a start → end pair (using the same
 * port defaults the node catalog produces) so creation succeeds and the new
 * workflow opens on a legal, runnable skeleton. The id/name are re-stamped at
 * persistence time.
 */
function blankDefinition(name: string): WorkflowRecord["definition"] {
  return {
    id: "draft",
    name,
    version: "0.1.0",
    nodes: [
      { ...getDefaultNode("flow:start"), id: "start" },
      { ...getDefaultNode("flow:end"), id: "end" },
    ],
    edges: [
      { source: "start", source_port: "out", target: "end", target_port: "in" },
    ],
    metadata: {},
  };
}

function formatTimestamp(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const intlLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(intlLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function allFolderIds(folders: readonly WorkflowFolder[]): Set<string> {
  return new Set(folders.map((folder) => folder.id));
}

export function WorkflowList() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const workflows = useWorkflows();
  const folders = useWorkflowFolders();
  const createWorkflow = useCreateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();
  const createFolder = useCreateWorkflowFolder();
  const updateFolder = useUpdateWorkflowFolder();
  const deleteFolder = useDeleteWorkflowFolder();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createFolderParent, setCreateFolderParent] = useState<
    string | null | undefined
  >(undefined);
  const [createWorkflowParent, setCreateWorkflowParent] = useState<
    string | null | undefined
  >(undefined);
  const [folderName, setFolderName] = useState("");
  const [workflowName, setWorkflowName] = useState("");
  const [renameTarget, setRenameTarget] = useState<WorkflowFolder | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteFolderTarget, setDeleteFolderTarget] =
    useState<WorkflowFolder | null>(null);
  const [deleteWorkflowTarget, setDeleteWorkflowTarget] =
    useState<WorkflowRecord | null>(null);
  const [moveTarget, setMoveTarget] = useState<WorkflowRecord | null>(null);
  const [moveDestination, setMoveDestination] = useState<string | null>(null);

  const folderList = useMemo(() => folders.data ?? [], [folders.data]);
  const tree = useMemo(
    () => buildWorkflowDirectoryTree(folderList, workflows.data ?? []),
    [folderList, workflows.data],
  );
  // The directory starts fully expanded. Users can collapse subtrees; no
  // persisted state is needed because folders are usually few and the task is
  // navigation rather than long-lived layout.
  useEffect(() => {
    if (folderList.length > 0) {
      setExpanded(allFolderIds(folderList));
    }
  }, [folderList]);

  const moveWorkflow = useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      updateWorkflow(id, { folder_id: folderId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
      setMoveTarget(null);
    },
  });

  const toggleFolder = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const folderLabel = (folderId: string | null | undefined) => {
    const path = workflowFolderPath(folderList, folderId);
    return path.length > 0
      ? path.map((folder) => folder.name).join(" / ")
      : t.workflows.folders.root;
  };

  const handleCreateFolder = () => {
    const name = folderName.trim();
    if (!name || createFolderParent === undefined) return;
    createFolder.mutate(
      { name, parent_id: createFolderParent },
      {
        onSuccess: (folder) => {
          setExpanded((current) => {
            const next = new Set(current);
            if (folder.parent_id) next.add(folder.parent_id);
            next.add(folder.id);
            return next;
          });
          setCreateFolderParent(undefined);
          setFolderName("");
        },
      },
    );
  };

  const handleCreateWorkflow = () => {
    const name = workflowName.trim();
    if (!name || createWorkflowParent === undefined) return;
    createWorkflow.mutate(
      {
        name,
        definition: blankDefinition(name),
        folder_id: createWorkflowParent,
      },
      {
        onSuccess: (record) => {
          setCreateWorkflowParent(undefined);
          setWorkflowName("");
          router.push(`/workspace/workflows/${encodeURIComponent(record.id)}`);
        },
      },
    );
  };

  const handleRenameFolder = () => {
    const name = renameName.trim();
    if (!name || !renameTarget) return;
    updateFolder.mutate(
      { id: renameTarget.id, name },
      {
        onSuccess: () => {
          setRenameTarget(null);
          setRenameName("");
        },
      },
    );
  };

  const renderWorkflow = (workflow: WorkflowRecord, depth: number) => (
    <div
      key={workflow.id}
      className="hover:bg-accent/40 flex items-center gap-2 rounded-md border px-3 py-2"
      style={{ marginLeft: depth * 18 }}
      data-testid={`workflow-row-${workflow.id}`}
    >
      <WorkflowIcon className="text-muted-foreground size-4 shrink-0" />
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
        onClick={() =>
          router.push(`/workspace/workflows/${encodeURIComponent(workflow.id)}`)
        }
      >
        <span className="truncate text-sm font-medium">{workflow.name}</span>
        <span className="text-muted-foreground flex flex-wrap gap-x-3 text-[11px]">
          <span className="font-mono">{workflow.id}</span>
          <span>
            {t.common.version}: {workflow.version}
          </span>
          <span>
            {t.common.lastUpdated}:{" "}
            {formatTimestamp(workflow.updated_at, locale)}
          </span>
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title={t.workflows.folders.move}
        aria-label={t.workflows.folders.move}
        onClick={() => {
          setMoveTarget(workflow);
          setMoveDestination(workflow.folder_id ?? null);
        }}
      >
        <MoveIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setDeleteWorkflowTarget(workflow)}
        aria-label={`${t.common.delete} ${workflow.name}`}
        title={t.common.delete}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );

  const renderFolder = (node: WorkflowFolderNode, depth: number) => {
    const isOpen = expanded.has(node.folder.id);
    return (
      <div key={node.folder.id} className="flex flex-col gap-1">
        <div
          className="hover:bg-accent/40 flex items-center gap-1 rounded-md border px-2 py-1.5"
          style={{ marginLeft: depth * 18 }}
          data-testid={`workflow-folder-${node.folder.id}`}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label={
              isOpen ? t.workflows.collapsePanel : t.workflows.expandPanel
            }
            onClick={() => toggleFolder(node.folder.id)}
          >
            {isOpen ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </Button>
          {isOpen ? (
            <FolderOpenIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : (
            <FolderIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm font-medium"
            onClick={() => toggleFolder(node.folder.id)}
          >
            {node.folder.name}
          </button>
          <span className="text-muted-foreground text-[11px]">
            {node.folders.length + node.workflows.length}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t.workflows.folders.newFolder}
            aria-label={t.workflows.folders.newFolder}
            onClick={() => {
              setCreateFolderParent(node.folder.id);
              setFolderName("");
            }}
          >
            <FolderPlusIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t.workflows.folders.newWorkflow}
            aria-label={t.workflows.folders.newWorkflow}
            onClick={() => {
              setCreateWorkflowParent(node.folder.id);
              setWorkflowName("");
            }}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t.workflows.folders.rename}
            aria-label={t.workflows.folders.rename}
            onClick={() => {
              setRenameTarget(node.folder);
              setRenameName(node.folder.name);
            }}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:text-destructive"
            title={t.workflows.folders.delete}
            aria-label={t.workflows.folders.delete}
            onClick={() => setDeleteFolderTarget(node.folder)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
        {isOpen && (
          <div className="flex flex-col gap-1">
            {node.folders.map((child) => renderFolder(child, depth + 1))}
            {node.workflows.map((workflow) =>
              renderWorkflow(workflow, depth + 1),
            )}
            {node.folders.length === 0 && node.workflows.length === 0 && (
              <p
                className="text-muted-foreground text-xs"
                style={{ marginLeft: (depth + 1) * 18 + 12 }}
              >
                {t.workflows.folders.empty}
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex size-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-6 py-4">
        <h1 className="text-xl font-semibold">{t.workflows.title}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setCreateFolderParent(null);
              setFolderName("");
            }}
            data-testid="workflow-new-folder"
          >
            <FolderPlusIcon className="mr-1.5 size-4" />
            {t.workflows.folders.newFolder}
          </Button>
          <Button
            onClick={() => {
              setCreateWorkflowParent(null);
              setWorkflowName("");
            }}
          >
            <PlusIcon className="mr-1.5 h-4 w-4" />
            {t.workflows.create}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {workflows.isLoading || folders.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : workflows.isError ? (
          <div
            className="text-destructive text-sm"
            data-testid="workflow-list-error"
          >
            {t.workflows.errors.loadFailed}: {workflows.error.message}
          </div>
        ) : folders.isError ? (
          <div className="text-destructive text-sm">
            {t.workflows.folders.loadFailed}: {folders.error.message}
          </div>
        ) : (workflows.data ?? []).length === 0 && folderList.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <p className="font-medium">{t.workflows.empty}</p>
            <Button
              variant="outline"
              onClick={() => {
                setCreateWorkflowParent(null);
                setWorkflowName("");
              }}
            >
              <PlusIcon className="mr-1.5 h-4 w-4" />
              {t.workflows.create}
            </Button>
          </div>
        ) : (
          <div
            className="mx-auto flex w-full max-w-(--container-width-lg) flex-col gap-1"
            data-testid="workflow-list"
          >
            {tree.folders.map((folder) => renderFolder(folder, 0))}
            {tree.workflows.map((workflow) => renderWorkflow(workflow, 0))}
            {tree.folders.length === 0 && tree.workflows.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {t.workflows.folders.empty}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Create folder */}
      <Dialog
        open={createFolderParent !== undefined}
        onOpenChange={(open) => {
          if (!open) setCreateFolderParent(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.folders.newFolderTitle}</DialogTitle>
            <DialogDescription>
              {t.workflows.folders.createIn(
                folderLabel(
                  createFolderParent === undefined ? null : createFolderParent,
                ),
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder={t.workflows.folders.folderName}
            aria-label={t.workflows.folders.folderName}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleCreateFolder();
            }}
            data-testid="workflow-folder-name"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateFolderParent(undefined)}
            >
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleCreateFolder}
              disabled={!folderName.trim() || createFolder.isPending}
            >
              {createFolder.isPending ? t.common.loading : t.workflows.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create workflow */}
      <Dialog
        open={createWorkflowParent !== undefined}
        onOpenChange={(open) => {
          if (!open) setCreateWorkflowParent(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.createTitle}</DialogTitle>
            <DialogDescription>
              {t.workflows.folders.createIn(
                folderLabel(
                  createWorkflowParent === undefined
                    ? null
                    : createWorkflowParent,
                ),
              )}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={workflowName}
            onChange={(event) => setWorkflowName(event.target.value)}
            placeholder={t.workflows.namePlaceholder}
            aria-label={t.workflows.nameLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter" && workflowName.trim()) {
                handleCreateWorkflow();
              }
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateWorkflowParent(undefined)}
            >
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleCreateWorkflow}
              disabled={!workflowName.trim() || createWorkflow.isPending}
            >
              {createWorkflow.isPending ? t.common.loading : t.workflows.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename folder */}
      <Dialog
        open={renameTarget != null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.folders.renameTitle}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
            aria-label={t.workflows.folders.folderName}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleRenameFolder();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleRenameFolder}
              disabled={!renameName.trim() || updateFolder.isPending}
            >
              {updateFolder.isPending ? t.common.loading : t.workflows.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete folder */}
      <Dialog
        open={deleteFolderTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.folders.delete}</DialogTitle>
            <DialogDescription>
              {deleteFolderTarget
                ? t.workflows.folders.deleteConfirm(deleteFolderTarget.name)
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteFolderTarget(null)}
            >
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteFolder.isPending}
              onClick={() => {
                if (!deleteFolderTarget) return;
                deleteFolder.mutate(deleteFolderTarget.id, {
                  onSuccess: () => setDeleteFolderTarget(null),
                });
              }}
            >
              {deleteFolder.isPending ? t.common.loading : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete workflow */}
      <Dialog
        open={deleteWorkflowTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteWorkflowTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.title}</DialogTitle>
            <DialogDescription>
              {deleteWorkflowTarget
                ? t.workflows.deleteConfirm(deleteWorkflowTarget.name)
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteWorkflowTarget(null)}
              disabled={deleteWorkflow.isPending}
            >
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleteWorkflowTarget) return;
                deleteWorkflow.mutate(deleteWorkflowTarget.id, {
                  onSuccess: () => setDeleteWorkflowTarget(null),
                });
              }}
              disabled={deleteWorkflow.isPending}
            >
              {deleteWorkflow.isPending ? t.common.loading : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move workflow */}
      <Dialog
        open={moveTarget != null}
        onOpenChange={(open) => {
          if (!open) setMoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.folders.moveTitle}</DialogTitle>
          </DialogHeader>
          <select
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
            value={moveDestination ?? ""}
            onChange={(event) => setMoveDestination(event.target.value || null)}
            aria-label={t.workflows.folders.moveTarget}
          >
            {workflowFolderOptions(folderList).map((option) => (
              <option key={option.id ?? "root"} value={option.id ?? ""}>
                {"  ".repeat(option.depth)}
                {option.id ? option.label : t.workflows.folders.root}
              </option>
            ))}
          </select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button
              disabled={moveWorkflow.isPending}
              onClick={() => {
                if (!moveTarget) return;
                moveWorkflow.mutate({
                  id: moveTarget.id,
                  folderId: moveDestination,
                });
              }}
            >
              {moveWorkflow.isPending ? t.common.loading : t.workflows.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
