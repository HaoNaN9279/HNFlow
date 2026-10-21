import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ModelProfileList } from "@/components/workspace/model-profiles/model-profile-list";
import type { ModelProfile } from "@/core/model-profiles/types";
import type { Model } from "@/core/models/types";

const mocks = rs.hoisted(() => ({
  profiles: [] as ModelProfile[],
  models: [] as Model[],
  create: rs.fn(),
  update: rs.fn(),
  remove: rs.fn(),
}));

rs.mock("@/core/model-profiles/hooks", () => ({
  useModelProfiles: () => ({
    data: mocks.profiles,
    isLoading: false,
    isError: false,
    isLoadingError: false,
    error: null,
    refetch: rs.fn(),
  }),
  useCreateModelProfile: () => ({ mutate: mocks.create, isPending: false }),
  useUpdateModelProfile: () => ({ mutate: mocks.update, isPending: false }),
  useDeleteModelProfile: () => ({ mutate: mocks.remove, isPending: false }),
}));

rs.mock("@/core/models/hooks", () => ({
  useModels: () => ({
    models: mocks.models,
    isLoading: false,
    error: null,
    refetch: rs.fn(),
  }),
}));

rs.mock("sonner", () => ({
  toast: { success: rs.fn(), error: rs.fn() },
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    t: {
      modelProfiles: {
        title: "Model profiles",
        description: "Manage profiles",
        loading: "Loading...",
        loadFailed: "Failed",
        retry: "Retry",
        empty: "No profiles",
        emptyHint: "Create one",
        create: "New profile",
        createTitle: "Create model profile",
        editTitle: "Edit model profile",
        nameLabel: "Name",
        namePlaceholder: "fast",
        nameHint: "Stable id",
        displayNameLabel: "Display name",
        displayNamePlaceholder: "Fast",
        descriptionLabel: "Description",
        descriptionPlaceholder: "Description",
        targetModelLabel: "Actual model",
        targetModelPlaceholder: "Select model",
        enabledLabel: "Enabled",
        enabledHint: "Disabled profiles cannot be used",
        save: "Save",
        saving: "Saving...",
        cancel: "Cancel",
        delete: "Delete",
        deleteTitle: "Delete model profile",
        deleteConfirm: (name: string) => `Delete ${name}?`,
        deleteBlocked: (count: number) => `Referenced by ${count} workflow(s)`,
        created: "Created",
        updated: "Updated",
        deleted: "Deleted",
        saveFailed: "Save failed",
        deleteFailed: "Delete failed",
        targetMissing: "Target missing",
        disabled: "Disabled",
        referencedBy: (count: number) => `Used by ${count}`,
        noModels: "No models",
        noModelsHint: "Configure models",
        nameInvalid: "Invalid name",
        targetRequired: "Target required",
      },
    },
  }),
}));

const model: Model = {
  id: "m1",
  name: "cloud-fast",
  model: "provider-fast",
  display_name: "Cloud Fast",
};

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: "mp-1",
    user_id: "u1",
    name: "fast",
    display_name: "Fast profile",
    description: "For quick tasks",
    target_model: "cloud-fast",
    target: {
      available: true,
      model: "provider-fast",
      display_name: "Cloud Fast",
      supports_thinking: true,
      supports_reasoning_effort: false,
    },
    enabled: true,
    referenced_by: 2,
    referenced_workflows: 1,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

afterEach(() => {
  mocks.profiles = [];
  mocks.models = [];
  mocks.create.mockReset();
  mocks.update.mockReset();
  mocks.remove.mockReset();
  cleanup();
});

describe("ModelProfileList", () => {
  it("lists profiles with target resolution and references", () => {
    mocks.models = [model];
    mocks.profiles = [profile()];

    render(<ModelProfileList />);

    expect(screen.getByText("Fast profile")).toBeTruthy();
    expect(screen.getByText("fast")).toBeTruthy();
    expect(screen.getByText("cloud-fast")).toBeTruthy();
    expect(screen.getByText("provider-fast")).toBeTruthy();
    expect(screen.getByText("Used by 2")).toBeTruthy();
  });

  it("shows missing target and disabled state", () => {
    mocks.models = [model];
    mocks.profiles = [
      profile({
        enabled: false,
        target: {
          available: false,
          model: null,
          display_name: null,
          supports_thinking: false,
          supports_reasoning_effort: false,
        },
      }),
    ];

    render(<ModelProfileList />);

    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByText("Target missing")).toBeTruthy();
  });

  it("opens create dialog and blocks deletion of a referenced profile", () => {
    mocks.models = [model];
    mocks.profiles = [profile()];

    render(<ModelProfileList />);

    fireEvent.click(screen.getByTestId("model-profile-create"));
    expect(screen.getByText("Create model profile")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Delete: Fast profile"));
    expect(screen.getByText("Referenced by 1 workflow(s)")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables creation when no actual models are configured", () => {
    render(<ModelProfileList />);
    expect(
      screen.getByTestId("model-profile-create").hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("No models")).toBeTruthy();
  });
});
