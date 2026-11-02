import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { WorkflowList } from "@/components/workspace/workflows/workflow-list";
import type { WorkflowRecord } from "@/core/workflows/types";
import type { WorkflowFolder } from "@/core/workflows/workflow-folders";

const mocks = rs.hoisted(() => ({
  listWorkflows: rs.fn(),
  createWorkflow: rs.fn(),
  deleteWorkflow: rs.fn(),
  updateWorkflow: rs.fn(),
  createFolder: rs.fn(),
  updateFolder: rs.fn(),
  deleteFolder: rs.fn(),
  push: rs.fn(),
  toastError: rs.fn(),
  folderData: [] as WorkflowFolder[],
}));

rs.mock("@/core/workflows/hooks", () => ({
  useWorkflows: () => ({
    data: mocks.listWorkflows(),
    isLoading: false,
    isError: false,
  }),
  useCreateWorkflow: () => ({ mutate: mocks.createWorkflow, isPending: false }),
  useDeleteWorkflow: () => ({ mutate: mocks.deleteWorkflow, isPending: false }),
}));

rs.mock("@/core/workflows/workflow-folders", () => ({
  useWorkflowFolders: () => ({
    data: mocks.folderData,
    isLoading: false,
    isError: false,
  }),
  useCreateWorkflowFolder: () => ({
    mutate: mocks.createFolder,
    isPending: false,
  }),
  useUpdateWorkflowFolder: () => ({
    mutate: mocks.updateFolder,
    isPending: false,
  }),
  useDeleteWorkflowFolder: () => ({
    mutate: mocks.deleteFolder,
    isPending: false,
  }),
}));

rs.mock("@/core/workflows/api", () => ({
  updateWorkflow: mocks.updateWorkflow,
}));
rs.mock("sonner", () => ({
  toast: { success: rs.fn(), error: mocks.toastError },
}));
rs.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    locale: "en-US",
    t: {
      common: {
        loading: "Loading...",
        version: "Version",
        lastUpdated: "Last updated",
        delete: "Delete",
        cancel: "Cancel",
      },
      workflows: {
        title: "Workflows",
        empty: "No workflows yet",
        create: "New workflow",
        createTitle: "Create workflow",
        nameLabel: "Name",
        namePlaceholder: "Workflow name",
        deleteConfirm: (name: string) => `Delete ${name}?`,
        save: "Save",
        collapsePanel: "Collapse",
        expandPanel: "Expand",
        folders: {
          root: "Root",
          newFolder: "New folder",
          newFolderTitle: "Create folder",
          folderName: "Folder name",
          createIn: (name: string) => `Create inside ${name}`,
          rename: "Rename",
          renameTitle: "Rename folder",
          delete: "Delete folder",
          deleteConfirm: (name: string) => `Delete folder ${name}?`,
          newWorkflow: "New workflow here",
          move: "Move",
          moveTitle: "Move workflow",
          moveTarget: "Destination folder",
          empty: "This folder is empty",
          loadFailed: "Failed to load folders",
        },
        errors: {
          loadFailed: "Failed to load workflows",
          saveSuccess: "Workflow saved",
          saveFailed: "Failed to save workflow",
          deleteFailed: "Failed to delete workflow",
          validationPrefix: "Validation failed: ",
        },
      },
    },
  }),
}));

const folders: WorkflowFolder[] = [
  {
    id: "folder-a",
    user_id: "u-1",
    name: "Project A",
    parent_id: null,
    order_index: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "folder-b",
    user_id: "u-1",
    name: "Nested",
    parent_id: "folder-a",
    order_index: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

function makeRecord(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: "wf-1",
    user_id: "u-1",
    name: "My workflow",
    folder_id: "folder-b",
    schema_version: 1,
    definition: {
      id: "wf-1",
      name: "My workflow",
      version: "0.1.0",
      nodes: [],
      edges: [],
      metadata: {},
    },
    metadata: {},
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WorkflowList />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  mocks.folderData = [];
  mocks.listWorkflows.mockReset();
  mocks.createWorkflow.mockReset();
  mocks.deleteWorkflow.mockReset();
  mocks.updateWorkflow.mockReset();
  mocks.createFolder.mockReset();
  mocks.updateFolder.mockReset();
  mocks.deleteFolder.mockReset();
  mocks.push.mockReset();
  mocks.toastError.mockReset();
  cleanup();
});

describe("WorkflowList", () => {
  it("renders arbitrary-depth folders and workflow metadata without run status", async () => {
    mocks.folderData = folders;
    mocks.listWorkflows.mockReturnValue([makeRecord()]);

    renderList();

    expect(await screen.findByText("Project A")).toBeTruthy();
    expect(screen.getByText("Nested")).toBeTruthy();
    expect(screen.getByText("My workflow")).toBeTruthy();
    expect(screen.getByText("wf-1")).toBeTruthy();
    expect(screen.queryByTestId("workflow-run-badge")).toBeNull();
  });

  it("creates a workflow inside the selected nested folder", async () => {
    mocks.folderData = folders;
    mocks.listWorkflows.mockReturnValue([]);
    mocks.createWorkflow.mockImplementation(
      (
        _payload,
        options?: { onSuccess?: (record: WorkflowRecord) => void },
      ) => {
        options?.onSuccess?.(makeRecord({ id: "wf-new", name: "Nested flow" }));
      },
    );

    renderList();
    await screen.findByText("Nested");
    fireEvent.click(screen.getAllByLabelText("New workflow here")[1]!);
    const input = await screen.findByLabelText("Name");
    fireEvent.change(input, { target: { value: "Nested flow" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mocks.createWorkflow).toHaveBeenCalledTimes(1));
    expect(mocks.createWorkflow.mock.calls[0]![0]).toMatchObject({
      name: "Nested flow",
      folder_id: "folder-b",
    });
    expect(mocks.push).toHaveBeenCalledWith("/workspace/workflows/wf-new");
  });

  it("creates a nested folder under a folder", async () => {
    mocks.folderData = folders;
    mocks.listWorkflows.mockReturnValue([]);
    mocks.createFolder.mockImplementation(
      (
        _payload,
        options?: { onSuccess?: (folder: WorkflowFolder) => void },
      ) => {
        options?.onSuccess?.({
          ...folders[1]!,
          id: "folder-new",
          name: "New nested",
        });
      },
    );

    renderList();
    await screen.findByText("Project A");
    fireEvent.click(screen.getAllByLabelText("New folder")[0]!);
    const input = await screen.findByTestId("workflow-folder-name");
    fireEvent.change(input, { target: { value: "New nested" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(mocks.createFolder).toHaveBeenCalledWith(
        { name: "New nested", parent_id: "folder-a" },
        expect.anything(),
      ),
    );
  });
});
