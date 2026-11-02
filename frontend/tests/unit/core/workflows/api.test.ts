import { beforeEach, describe, expect, test, rs } from "@rstest/core";

rs.mock("@/core/api/fetcher", () => ({
  fetch: rs.fn(),
}));

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => "",
}));

import { fetch as fetcher } from "@/core/api/fetcher";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow,
  type CreateWorkflowPayload,
  type UpdateWorkflowPayload,
} from "@/core/workflows/api";
import { WorkflowValidationErrors } from "@/core/workflows/errors";
import type {
  WorkflowDefinition,
  WorkflowRecord,
} from "@/core/workflows/types";

const mockedFetch = rs.mocked(fetcher);

const SAMPLE_DEFINITION: WorkflowDefinition = {
  id: "wf-sample",
  name: "Sample",
  version: "0.1.0",
  nodes: [
    {
      id: "start",
      type: "flow:start",
      inputs: [],
      outputs: [],
      params: {},
    },
  ],
  edges: [],
  metadata: {},
};

const SAMPLE_RECORD: WorkflowRecord = {
  id: "wf-1",
  user_id: "default",
  name: "Sample",
  schema_version: 1,
  definition: SAMPLE_DEFINITION,
  metadata: {},
  version: "0.1.0",
  resolved_at: null,
  created_at: "2026-08-01T00:00:00+00:00",
  updated_at: "2026-08-01T00:00:00+00:00",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(): { url: string; init?: RequestInit } {
  const call = mockedFetch.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  const [input, init] = call;
  return { url: typeof input === "string" ? input : input.url, init };
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("listWorkflows", () => {
  test("hits GET /api/workflows and returns the record list", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, [SAMPLE_RECORD]));

    const result = await listWorkflows();

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows");
    expect(init?.method).toBeUndefined();
    expect(result).toEqual([SAMPLE_RECORD]);
  });
});

describe("listWorkflowRuns", () => {
  const SAMPLE_RUN = {
    run_id: "run-1",
    thread_id: "thread-1",
    thread_title: "Sample run",
    assistant_id: "wf-1",
    status: "success",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:01:00Z",
    duration_seconds: 42,
    error: null,
  };

  test("hits GET /api/console/runs with an encoded assistant_id and limit", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, { runs: [SAMPLE_RUN], has_more: false }),
    );

    const result = await listWorkflowRuns("wf 1/x", { limit: 1 });

    const { url, init } = lastCall();
    expect(url).toContain("/api/console/runs");
    expect(url).toContain("assistant_id=wf+1%2Fx");
    expect(url).toContain("limit=1");
    expect(init?.method).toBeUndefined();
    expect(result).toEqual({ runs: [SAMPLE_RUN], hasMore: false });
  });

  test("omits limit when not provided", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, { runs: [], has_more: false }),
    );

    await listWorkflowRuns("wf-1");

    const { url } = lastCall();
    expect(url).toContain("assistant_id=wf-1");
    expect(url).not.toContain("limit=");
  });

  test("maps has_more to hasMore", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, { runs: [], has_more: true }),
    );

    const result = await listWorkflowRuns("wf-1");

    expect(result.hasMore).toBe(true);
    expect(result.runs).toEqual([]);
  });

  test("throws the backend detail message on a 503", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(503, {
        detail: "Run history requires a SQL database backend",
      }),
    );

    await expect(listWorkflowRuns("wf-1")).rejects.toThrow(
      "Run history requires a SQL database backend",
    );
  });

  test("falls back to the generated message when detail is missing", async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response("", { status: 503, statusText: "Service Unavailable" }),
    );

    await expect(listWorkflowRuns("wf-1")).rejects.toThrow(
      /Failed to load workflow runs/,
    );
  });
});

describe("getWorkflow", () => {
  test("hits GET /api/workflows/{id} with URL encoding", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RECORD));

    const result = await getWorkflow("wf 1/x");

    const { url } = lastCall();
    expect(url).toContain("/api/workflows/wf%201%2Fx");
    expect(result).toEqual(SAMPLE_RECORD);
  });
});

describe("createWorkflow", () => {
  test("hits POST /api/workflows with the payload body", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RECORD));

    const payload: CreateWorkflowPayload = {
      name: "Sample",
      definition: SAMPLE_DEFINITION,
      metadata: { canvas: { x: 0 } },
      version: "0.1.0",
    };
    const result = await createWorkflow(payload);

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(payload);
    expect(result).toEqual(SAMPLE_RECORD);
  });
});

describe("updateWorkflow", () => {
  test("hits PUT /api/workflows/{id} with a partial payload", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RECORD));

    const payload: UpdateWorkflowPayload = { name: "Renamed" };
    const result = await updateWorkflow("wf-1", payload);

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows/wf-1");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual(payload);
    expect(result).toEqual(SAMPLE_RECORD);
  });
});

describe("deleteWorkflow", () => {
  test("hits DELETE /api/workflows/{id} and returns the deletion result", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(200, { id: "wf-1", deleted: true }),
    );

    const result = await deleteWorkflow("wf-1");

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows/wf-1");
    expect(init?.method).toBe("DELETE");
    expect(result).toEqual({ id: "wf-1", deleted: true });
  });
});

describe("error handling", () => {
  test("throws an Error carrying the backend detail string", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(404, { detail: "Workflow definition not found" }),
    );

    await expect(getWorkflow("wf-missing")).rejects.toThrow(
      "Workflow definition not found",
    );
  });

  test("throws WorkflowValidationErrors with parsed errors for a 422 errors list", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(422, {
        detail: {
          errors: [
            "edge[3]: source node 'missing' not found",
            "node 'A': param 'x' has non-JSON-compatible type set",
          ],
        },
      }),
    );

    const error = await createWorkflow({
      name: "Bad",
      definition: SAMPLE_DEFINITION,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkflowValidationErrors);
    expect((error as WorkflowValidationErrors).errors).toEqual([
      {
        type: "edge",
        id: "3",
        message: "edge[3]: source node 'missing' not found",
      },
      {
        type: "node",
        id: "A",
        message: "node 'A': param 'x' has non-JSON-compatible type set",
      },
    ]);
  });

  test("falls back to the generated message when detail is missing", async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response("", { status: 502, statusText: "Bad Gateway" }),
    );

    await expect(listWorkflows()).rejects.toThrow(/Failed to load workflows/);
  });
});
