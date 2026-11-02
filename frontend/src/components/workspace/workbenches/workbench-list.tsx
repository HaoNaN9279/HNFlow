"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
import {
  useCreateWorkbench,
  useDeleteWorkbench,
  useWorkbenches,
} from "@/core/workflows/workbench-hooks";
import type { WorkbenchRecord } from "@/core/workflows/workbenches";

export function WorkbenchList({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const workbenches = useWorkbenches(projectId);
  const createWorkbench = useCreateWorkbench(projectId);
  const deleteWorkbench = useDeleteWorkbench(projectId);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<WorkbenchRecord | null>(
    null,
  );

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createWorkbench.mutate(
      { name: trimmed, description: description.trim() },
      {
        onSuccess: (record) => {
          setCreateOpen(false);
          setName("");
          setDescription("");
          router.push(
            `/workspace/projects/${encodeURIComponent(projectId)}/workbenches/${encodeURIComponent(record.id)}`,
          );
        },
      },
    );
  };

  return (
    <div className="flex size-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">{t.workbenches.title}</h1>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t.workbenches.description}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon className="mr-1.5 h-4 w-4" />
          {t.workbenches.create}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {workbenches.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : workbenches.isError ? (
          <div className="text-destructive text-sm">
            {t.workbenches.loadFailed}: {workbenches.error.message}
          </div>
        ) : (workbenches.data ?? []).length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <p className="font-medium">{t.workbenches.empty}</p>
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="mr-1.5 h-4 w-4" />
              {t.workbenches.create}
            </Button>
          </div>
        ) : (
          <div
            className="mx-auto grid w-full max-w-(--container-width-lg) gap-3 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="workbench-list"
          >
            {(workbenches.data ?? []).map((workbench) => (
              <div
                key={workbench.id}
                className="hover:bg-accent/40 flex flex-col gap-3 rounded-lg border p-4"
                data-testid={`workbench-row-${workbench.id}`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-col items-start gap-1 text-left"
                  onClick={() =>
                    router.push(
                      `/workspace/projects/${encodeURIComponent(projectId)}/workbenches/${encodeURIComponent(workbench.id)}`,
                    )
                  }
                >
                  <span className="truncate font-medium">{workbench.name}</span>
                  {workbench.description && (
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {workbench.description}
                    </span>
                  )}
                  <span className="text-muted-foreground mt-1 text-xs">
                    {t.workbenches.members(workbench.member_count ?? 0)}
                  </span>
                </button>
                <div className="flex items-center justify-between">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      router.push(
                        `/workspace/projects/${encodeURIComponent(projectId)}/workbenches/${encodeURIComponent(workbench.id)}`,
                      )
                    }
                  >
                    {t.workbenches.open}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    aria-label={`${t.common.delete} ${workbench.name}`}
                    onClick={() => setDeleteTarget(workbench)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workbenches.createTitle}</DialogTitle>
            <DialogDescription>{t.workbenches.description}</DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t.workbenches.namePlaceholder}
            aria-label={t.workbenches.nameLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim()) handleCreate();
            }}
          />
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t.workbenches.descriptionPlaceholder}
            aria-label={t.workbenches.descriptionLabel}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!name.trim() || createWorkbench.isPending}
            >
              {createWorkbench.isPending
                ? t.common.loading
                : t.workbenches.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workbenches.title}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? t.workbenches.deleteConfirm(deleteTarget.name)
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteWorkbench.isPending}
              onClick={() => {
                if (!deleteTarget) return;
                deleteWorkbench.mutate(deleteTarget.id, {
                  onSuccess: () => setDeleteTarget(null),
                });
              }}
            >
              {deleteWorkbench.isPending ? t.common.loading : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
