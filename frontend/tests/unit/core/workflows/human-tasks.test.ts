import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

import {
  continueDebugPause,
  fetchPendingHumanTasks,
  parseHumanTask,
  pendingDebugPauses,
  skipHumanTask,
  submitHumanTask,
} from "@/core/workflows/human-tasks";

const configMock = rs.hoisted(() => ({ baseUrl: "http://backend.test" }));
const fetchMock = rs.hoisted(() => rs.fn());

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => configMock.baseUrl,
}));

rs.mock("@/core/api/fetcher", () => ({
  fetch: fetchMock,
}));

function jsonResponse(body: unknown, ok = true, statusText = "OK"): Response {
  return {
    ok,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  fetchMock.mockReset();
});

/** One well-formed pending step task. */
function stepTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "ht-1",
    workflow_run_id: "run-1",
    node_id: "a",
    kind: "step",
    status: "pending",
    description: "[step] 节点 a 在单步调试中暂停",
    ...overrides,
  };
}

describe("parseHumanTask", () => {
  it("normalizes a raw row", () => {
    expect(parseHumanTask(stepTask())).toEqual({
      id: "ht-1",
      workflowRunId: "run-1",
      nodeId: "a",
      kind: "step",
      status: "pending",
      description: "[step] 节点 a 在单步调试中暂停",
    });
  });

  it("defaults a missing description to an empty string", () => {
    const parsed = parseHumanTask(stepTask({ description: undefined }));
    expect(parsed?.description).toBe("");
  });

  it("rejects malformed rows instead of inventing a task", () => {
    expect(parseHumanTask(null)).toBeNull();
    expect(parseHumanTask("nope")).toBeNull();
    expect(parseHumanTask(stepTask({ id: undefined }))).toBeNull();
    expect(parseHumanTask(stepTask({ workflow_run_id: 7 }))).toBeNull();
    expect(parseHumanTask(stepTask({ kind: undefined }))).toBeNull();
  });
});

describe("pendingDebugPauses", () => {
  const tasks = [
    parseHumanTask(stepTask())!,
    parseHumanTask(stepTask({ id: "ht-2", node_id: "b", kind: "breakpoint" }))!,
    parseHumanTask(stepTask({ id: "ht-3", node_id: "c", kind: "task" }))!,
    parseHumanTask(
      stepTask({ id: "ht-4", node_id: "d", status: "submitted" }),
    )!,
    parseHumanTask(stepTask({ id: "ht-5", workflow_run_id: "run-2" }))!,
  ];

  it("keeps only pending debug tasks", () => {
    expect(pendingDebugPauses(tasks)).toEqual([
      {
        id: "ht-1",
        runId: "run-1",
        nodeId: "a",
        kind: "step",
        description: "[step] 节点 a 在单步调试中暂停",
      },
      {
        id: "ht-2",
        runId: "run-1",
        nodeId: "b",
        kind: "breakpoint",
        description: "[step] 节点 a 在单步调试中暂停",
      },
      {
        id: "ht-5",
        runId: "run-2",
        nodeId: "a",
        kind: "step",
        description: "[step] 节点 a 在单步调试中暂停",
      },
    ]);
  });

  it("does not claim a run's other human tasks", () => {
    // ht-3 is a plain human:task — the canvas debug card must not offer to
    // resolve it, and ht-4 is already submitted.
    const ids = pendingDebugPauses(tasks).map((pause) => pause.id);
    expect(ids).not.toContain("ht-3");
    expect(ids).not.toContain("ht-4");
  });

  it("keeps a paused run reachable after its resume started a new run", () => {
    // A resume admits a new run id, so the follow-up pause of a stepped run is
    // never scoped to the canvas's own run — it must still be listed.
    const pauses = pendingDebugPauses(tasks, { preferredRunId: "run-canvas" });
    expect(pauses.map((pause) => pause.runId)).toEqual([
      "run-1",
      "run-1",
      "run-2",
    ]);
  });

  it("pins the preferred run's pauses first without dropping the rest", () => {
    const pauses = pendingDebugPauses(tasks, { preferredRunId: "run-2" });
    expect(pauses.map((pause) => pause.id)).toEqual(["ht-5", "ht-1", "ht-2"]);
  });

  it("returns nothing for a list with no pending debug work", () => {
    expect(pendingDebugPauses([])).toEqual([]);
    expect(
      pendingDebugPauses([parseHumanTask(stepTask({ kind: "approval" }))!]),
    ).toEqual([]);
  });
});

describe("fetchPendingHumanTasks", () => {
  it("queries the pending filter and drops malformed rows", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([stepTask(), { id: "broken" }, "nope"]),
    );

    const tasks = await fetchPendingHumanTasks();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks?status=pending",
      { headers: { Accept: "application/json" } },
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.nodeId).toBe("a");
  });

  it("treats a non-array payload as no tasks", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tasks: [] }));
    await expect(fetchPendingHumanTasks()).resolves.toEqual([]);
  });

  it("surfaces the backend detail on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: "Authentication required" },
        false,
        "Unauthorized",
      ),
    );
    await expect(fetchPendingHumanTasks()).rejects.toThrow(
      "Authentication required",
    );
  });
});

describe("debug pause actions", () => {
  it("acknowledges a pause with a non-empty resume payload", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "submitted" }));

    await continueDebugPause("ht/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks/ht%2F1/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // LangGraph re-suspends on a falsy resume payload, so the submission
        // must carry the required `acknowledge` port.
        body: JSON.stringify({ values: { acknowledge: true } }),
      },
    );
  });

  it("submits explicit values", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await submitHumanTask("ht-1", { foo: "bar" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks/ht-1/submit",
      expect.objectContaining({
        body: JSON.stringify({ values: { foo: "bar" } }),
      }),
    );
  });

  it("skips a pause without values", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await skipHumanTask("ht-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.test/api/human-tasks/ht-1/skip",
      { method: "POST" },
    );
  });

  it("joins validation errors from a 422 detail", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: { errors: ["缺少 acknowledge", "类型错误"] } },
        false,
      ),
    );
    await expect(continueDebugPause("ht-1")).rejects.toThrow(
      "缺少 acknowledge; 类型错误",
    );
  });

  it("falls back to a readable message when the detail is opaque", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, false, "Internal Server Error"),
    );
    await expect(skipHumanTask("ht-1")).rejects.toThrow(
      "Failed to skip human task: Internal Server Error",
    );
  });
});
