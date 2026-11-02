import { beforeEach, describe, expect, test, rs } from "@rstest/core";

rs.mock("@/core/api/fetcher", () => ({
  fetch: rs.fn(),
}));

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => "http://backend.test",
}));

import { fetch as fetcher } from "@/core/api/fetcher";
import {
  listWorkspaceResourceChanges,
  undoWorkspaceResourceChanges,
  type WorkspaceResourceChangeList,
} from "@/core/workspace-resources/api";

const mockedFetch = rs.mocked(fetcher);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE: WorkspaceResourceChangeList = {
  changes: [
    {
      id: "wsc-1",
      seq: 1,
      run_id: "run-1",
      resource_kind: "workflow",
      resource_id: "wf-1",
      parent_id: null,
      action: "update",
      status: "applied",
      name: "Demo",
      created_at: "2026-10-22T00:00:00+00:00",
      undone_at: null,
    },
  ],
  undoable: { run_id: "run-1", count: 1, resources: [] },
};

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("workspace resource change API", () => {
  test("loads the conversation-scoped history", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE));

    await expect(listWorkspaceResourceChanges("thread 1")).resolves.toEqual(
      SAMPLE,
    );
    const [url, init] = mockedFetch.mock.calls.at(-1)!;
    expect(url).toBe(
      "http://backend.test/api/threads/thread%201/resource-changes",
    );
    expect(init?.method).toBe("GET");
  });

  test("posts an all-or-nothing undo request", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        dry_run: false,
        run_id: "run-1",
        count: 1,
        resources: [],
      }),
    );

    await undoWorkspaceResourceChanges("thread-1", { change_id: "wsc-1" });

    const [url, init] = mockedFetch.mock.calls.at(-1)!;
    expect(url).toBe(
      "http://backend.test/api/threads/thread-1/resource-changes/undo",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ change_id: "wsc-1" }));
  });

  test("surfaces structured undo conflict details", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(409, {
        detail: {
          error: "undo_conflict",
          conflicts: [{ detail: "workflow changed" }],
        },
      }),
    );

    await expect(undoWorkspaceResourceChanges("thread-1")).rejects.toThrow(
      "workflow changed",
    );
  });
});
