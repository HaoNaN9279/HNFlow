"use client";

import {
  BrainCircuitIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/core/i18n/hooks";
import {
  useCreateModelProfile,
  useDeleteModelProfile,
  useModelProfiles,
  useUpdateModelProfile,
} from "@/core/model-profiles/hooks";
import type {
  ModelProfile,
  ModelProfileInput,
} from "@/core/model-profiles/types";
import { useModels } from "@/core/models/hooks";
import type { Model } from "@/core/models/types";
import { cn } from "@/lib/utils";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type Draft = {
  name: string;
  displayName: string;
  description: string;
  targetModel: string;
  enabled: boolean;
};

function emptyDraft(models: Model[]): Draft {
  return {
    name: "",
    displayName: "",
    description: "",
    targetModel: models[0]?.name ?? "",
    enabled: true,
  };
}

function draftFrom(profile: ModelProfile): Draft {
  return {
    name: profile.name,
    displayName: profile.display_name,
    description: profile.description ?? "",
    targetModel: profile.target_model,
    enabled: profile.enabled,
  };
}

function toInput(draft: Draft): ModelProfileInput {
  return {
    name: draft.name.trim(),
    display_name: draft.displayName.trim() || undefined,
    description: draft.description.trim() || undefined,
    target_model: draft.targetModel,
    enabled: draft.enabled,
  };
}

export function ModelProfileList() {
  const { t } = useI18n();
  const labels = t.modelProfiles;
  const profilesQuery = useModelProfiles();
  const modelsQuery = useModels();
  const createProfile = useCreateModelProfile();
  const updateProfile = useUpdateModelProfile();
  const deleteProfile = useDeleteModelProfile();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProfile | null>(null);
  const models = modelsQuery.models;

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (profile: ModelProfile) => {
    setEditing(profile);
    setDialogOpen(true);
  };

  const handleSubmit = (draft: Draft) => {
    const input = toInput(draft);
    const onSuccess = () => {
      toast.success(editing ? labels.updated : labels.created);
      setDialogOpen(false);
      setEditing(null);
    };
    const onError = (error: Error) => {
      toast.error(`${labels.saveFailed}: ${error.message}`);
    };
    if (editing) {
      updateProfile.mutate({ id: editing.id, input }, { onSuccess, onError });
    } else {
      createProfile.mutate(input, { onSuccess, onError });
    }
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteProfile.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success(labels.deleted);
        setDeleteTarget(null);
      },
      onError: (error: Error) => {
        toast.error(`${labels.deleteFailed}: ${error.message}`);
      },
    });
  };

  const loading = profilesQuery.isLoading || modelsQuery.isLoading;
  const failed = profilesQuery.isError || modelsQuery.isError;
  const error =
    profilesQuery.error?.message ?? modelsQuery.error?.message ?? "";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <BrainCircuitIcon className="text-muted-foreground size-4" />
            <h1 className="text-lg font-semibold">{labels.title}</h1>
            {profilesQuery.data && (
              <Badge variant="secondary" className="text-[10px]">
                {profilesQuery.data.length}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">{labels.description}</p>
        </div>
        <Button
          type="button"
          onClick={openCreate}
          disabled={models.length === 0}
          data-testid="model-profile-create"
        >
          <PlusIcon className="mr-1.5 size-4" />
          {labels.create}
        </Button>
      </header>

      {models.length === 0 && !modelsQuery.isLoading && (
        <div className="rounded-md border border-dashed p-4 text-sm">
          <p className="font-medium">{labels.noModels}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {labels.noModelsHint}
          </p>
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground py-8 text-sm">
          {labels.loading}
        </div>
      ) : failed ? (
        <div className="border-destructive/40 bg-destructive/5 flex items-center justify-between gap-3 rounded-md border p-3">
          <span className="text-destructive text-sm">
            {labels.loadFailed}: {error}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void profilesQuery.refetch();
              void modelsQuery.refetch();
            }}
          >
            <RefreshCwIcon className="size-3.5" />
            {labels.retry}
          </Button>
        </div>
      ) : (profilesQuery.data ?? []).length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="model-profile-list">
          {(profilesQuery.data ?? []).map((profile) => (
            <ModelProfileRow
              key={profile.id}
              profile={profile}
              onEdit={() => openEdit(profile)}
              onDelete={() => setDeleteTarget(profile)}
            />
          ))}
        </div>
      ) : (
        <div className="text-muted-foreground rounded-md border border-dashed p-8 text-center text-sm">
          <p>{labels.empty}</p>
          <p className="mt-1 text-xs">{labels.emptyHint}</p>
        </div>
      )}

      <ModelProfileDialog
        open={dialogOpen}
        profile={editing}
        models={models}
        saving={createProfile.isPending || updateProfile.isPending}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        onSubmit={handleSubmit}
      />

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{labels.deleteTitle}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? labels.deleteConfirm(deleteTarget.display_name)
                : ""}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && deleteTarget.referenced_by > 0 && (
            <p className="text-destructive text-xs">
              {labels.deleteBlocked(deleteTarget.referenced_workflows)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {labels.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={
                deleteProfile.isPending ||
                (deleteTarget?.referenced_by ?? 0) > 0
              }
            >
              {deleteProfile.isPending ? labels.saving : labels.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModelProfileRow({
  profile,
  onEdit,
  onDelete,
}: {
  profile: ModelProfile;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const labels = t.modelProfiles;
  const targetUnavailable = !profile.target.available;

  return (
    <article
      className="bg-card flex flex-wrap items-start gap-3 rounded-md border p-3"
      data-testid="model-profile-row"
      data-profile-id={profile.id}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {profile.display_name}
          </span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {profile.name}
          </Badge>
          {!profile.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              {labels.disabled}
            </Badge>
          )}
          {targetUnavailable && (
            <Badge variant="destructive" className="text-[10px]">
              {labels.targetMissing}
            </Badge>
          )}
        </div>
        {profile.description && (
          <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
            {profile.description}
          </p>
        )}
        <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-mono">{profile.target_model}</span>
          {profile.target.model && (
            <span className="truncate font-mono">{profile.target.model}</span>
          )}
          <span>{labels.referencedBy(profile.referenced_by)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          aria-label={`${labels.editTitle}: ${profile.display_name}`}
        >
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-destructive"
          onClick={onDelete}
          aria-label={`${labels.delete}: ${profile.display_name}`}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </article>
  );
}

function ModelProfileDialog({
  open,
  profile,
  models,
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  profile: ModelProfile | null;
  models: Model[];
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: Draft) => void;
}) {
  const { t } = useI18n();
  const labels = t.modelProfiles;
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(models));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(profile ? draftFrom(profile) : emptyDraft(models));
    setTouched(false);
  }, [open, profile, models]);

  const nameInvalid = !PROFILE_NAME_PATTERN.test(draft.name.trim());
  const targetMissing =
    !draft.targetModel ||
    !models.some((model) => model.name === draft.targetModel);
  const invalid = nameInvalid || targetMissing;

  const submit = () => {
    setTouched(true);
    if (invalid) return;
    onSubmit(draft);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {profile ? labels.editTitle : labels.createTitle}
          </DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="profile-name">
              {labels.nameLabel}
            </label>
            <Input
              id="profile-name"
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder={labels.namePlaceholder}
              aria-invalid={touched && nameInvalid ? true : undefined}
              className="h-8 text-xs"
            />
            <p className="text-muted-foreground text-[11px]">
              {labels.nameHint}
            </p>
            {touched && nameInvalid && (
              <p className="text-destructive text-xs">{labels.nameInvalid}</p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label
              className="text-xs font-medium"
              htmlFor="profile-display-name"
            >
              {labels.displayNameLabel}
            </label>
            <Input
              id="profile-display-name"
              value={draft.displayName}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
              placeholder={labels.displayNamePlaceholder}
              className="h-8 text-xs"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              className="text-xs font-medium"
              htmlFor="profile-description"
            >
              {labels.descriptionLabel}
            </label>
            <Textarea
              id="profile-description"
              value={draft.description}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder={labels.descriptionPlaceholder}
              className="min-h-16 text-xs"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">
              {labels.targetModelLabel}
            </span>
            <Select
              value={draft.targetModel || undefined}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, targetModel: value }))
              }
            >
              <SelectTrigger
                aria-label={labels.targetModelLabel}
                aria-invalid={touched && targetMissing ? true : undefined}
                className="h-8 text-xs"
              >
                <SelectValue placeholder={labels.targetModelPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.name} value={model.name}>
                    {model.display_name} ({model.model})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {touched && targetMissing && (
              <p className="text-destructive text-xs">
                {labels.targetRequired}
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
            />
            <span>
              <span>{labels.enabledLabel}</span>
              <span className="text-muted-foreground block text-[10px]">
                {labels.enabledHint}
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {labels.cancel}
          </Button>
          <Button
            onClick={submit}
            disabled={saving}
            className={cn(saving && "opacity-80")}
          >
            {saving ? labels.saving : labels.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
