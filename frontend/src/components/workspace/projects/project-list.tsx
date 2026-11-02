"use client";

import { FolderOpenIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
  useCloseProject,
  useCreateProject,
  useOpenProject,
  useProjects,
} from "@/core/projects/hooks";
import type { ProjectRecord } from "@/core/projects/types";

export function ProjectList() {
  const { t } = useI18n();
  const router = useRouter();
  const projects = useProjects();
  const openProject = useOpenProject();
  const createProject = useCreateProject();
  const closeProject = useCloseProject();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [closeTarget, setCloseTarget] = useState<ProjectRecord | null>(null);

  const openWorkbenches = (project: ProjectRecord) => {
    router.push(
      `/workspace/projects/${encodeURIComponent(project.project_id)}/workbenches`,
    );
  };

  const handleOpen = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setError(null);
    openProject.mutate(trimmed, {
      onSuccess: (project) => {
        setDialogOpen(false);
        openWorkbenches(project);
      },
      onError: (err) => setError(err.message),
    });
  };

  const handleCreate = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setError(null);
    createProject.mutate(
      {
        root_path: trimmed,
        name: name.trim() || undefined,
      },
      {
        onSuccess: (project) => {
          setDialogOpen(false);
          openWorkbenches(project);
        },
        onError: (err) => setError(err.message),
      },
    );
  };

  const busy = openProject.isPending || createProject.isPending;

  return (
    <div className="flex size-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">{t.projects.title}</h1>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t.projects.description}
          </p>
        </div>
        <Button
          onClick={() => {
            setError(null);
            setDialogOpen(true);
          }}
        >
          <PlusIcon className="mr-1.5 h-4 w-4" />
          {t.projects.open}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {projects.isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : projects.isError ? (
          <div className="text-destructive text-sm">
            {t.projects.loadFailed}: {projects.error.message}
          </div>
        ) : (projects.data ?? []).length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <p className="font-medium">{t.projects.empty}</p>
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              <FolderOpenIcon className="mr-1.5 h-4 w-4" />
              {t.projects.open}
            </Button>
          </div>
        ) : (
          <div
            className="mx-auto grid w-full max-w-(--container-width-lg) gap-3 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="project-list"
          >
            {(projects.data ?? []).map((project) => (
              <div
                key={project.project_id}
                className="hover:bg-accent/40 flex flex-col gap-3 rounded-lg border p-4"
                data-testid={`project-row-${project.project_id}`}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-col items-start gap-1 text-left"
                  onClick={() => openWorkbenches(project)}
                >
                  <span className="truncate font-medium">{project.name}</span>
                  <span className="text-muted-foreground w-full truncate font-mono text-[10px]">
                    {project.root_path}
                  </span>
                  {project.error && (
                    <span className="text-destructive line-clamp-2 text-xs">
                      {project.error}
                    </span>
                  )}
                </button>
                <div className="flex items-center justify-between">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openWorkbenches(project)}
                  >
                    {t.projects.openWorkbenches}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    aria-label={`${t.projects.close} ${project.name}`}
                    onClick={() => setCloseTarget(project)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.openTitle}</DialogTitle>
            <DialogDescription>{t.projects.openHint}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t.projects.pathPlaceholder}
              aria-label={t.projects.pathLabel}
            />
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t.projects.namePlaceholder}
              aria-label={t.projects.nameLabel}
            />
            {error && (
              <p className="text-destructive text-xs" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy || !path.trim()}
              onClick={handleOpen}
            >
              {t.projects.openExisting}
            </Button>
            <Button disabled={busy || !path.trim()} onClick={handleCreate}>
              {t.projects.createNew}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={closeTarget != null}
        onOpenChange={(open) => {
          if (!open) setCloseTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.close}</DialogTitle>
            <DialogDescription>
              {closeTarget ? t.projects.closeConfirm(closeTarget.name) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={closeProject.isPending}
              onClick={() => {
                if (!closeTarget) return;
                closeProject.mutate(closeTarget.project_id, {
                  onSuccess: () => setCloseTarget(null),
                });
              }}
            >
              {closeProject.isPending ? t.common.loading : t.projects.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
