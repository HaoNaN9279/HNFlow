import { beforeEach, describe, expect, test, rs } from "@rstest/core";

rs.mock("@/core/api/fetcher", () => ({
  fetch: rs.fn(),
}));

rs.mock("@/core/config", () => ({
  getBackendBaseURL: () => "",
}));

import { fetch as fetcher } from "@/core/api/fetcher";
import {
  cancelWorkflowRun,
  continueWorkflowNode,
  createWorkflowRun,
  getWorkflowRun,
  parseWorkflowSseLine,
  streamWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunStreamEvent,
} from "@/core/workflows/runs";

const mockedFetch = rs.mocked(fetcher);

const SAMPLE_RUN: WorkflowRunRecord = {
  run_id: "run-1",
  thread_id: "thread-1",
  status: "pending",
  created_at: "2026-08-01T00:00:00+00:00",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function lastCall(): { url: string; init?: RequestInit } {
  const call = mockedFetch.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  const [input, init] = call;
  return { url: typeof input === "string" ? input : input.url, init };
}

async function collect(
  iterable: AsyncIterable<WorkflowRunStreamEvent>,
): Promise<WorkflowRunStreamEvent[]> {
  const events: WorkflowRunStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("createWorkflowRun", () => {
  test("hits POST /api/workflows/{id}/runs with the payload body", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RUN));

    const result = await createWorkflowRun("wf-1", {
      params: { prompt: "hello" },
      thread_id: "thread-1",
      on_disconnect: "continue",
      metadata: { source: "test" },
    });

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows/wf-1/runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      params: { prompt: "hello" },
      thread_id: "thread-1",
      on_disconnect: "continue",
      metadata: { source: "test" },
    });
    expect(result).toEqual(SAMPLE_RUN);
  });

  test("sends an empty object body when no payload is given", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RUN));

    await createWorkflowRun("wf-1");

    const { init } = lastCall();
    expect(JSON.parse(init?.body as string)).toEqual({});
  });

  test("throws an Error carrying the backend detail on non-2xx", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(404, { detail: "Workflow wf-missing not found" }),
    );

    await expect(createWorkflowRun("wf-missing")).rejects.toThrow(
      "Workflow wf-missing not found",
    );
  });
});

describe("getWorkflowRun", () => {
  test("hits GET /api/workflows/{id}/runs/{runId} with URL encoding", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RUN));

    const result = await getWorkflowRun("wf-1", "run 1/x");

    const { url } = lastCall();
    expect(url).toContain("/api/workflows/wf-1/runs/run%201%2Fx");
    expect(result).toEqual(SAMPLE_RUN);
  });

  test("throws on non-2xx", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(404, { detail: "Run run-9 not found" }),
    );

    await expect(getWorkflowRun("wf-1", "run-9")).rejects.toThrow(
      "Run run-9 not found",
    );
  });
});

describe("cancelWorkflowRun", () => {
  test("resolves on 202 Accepted", async () => {
    mockedFetch.mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(cancelWorkflowRun("wf-1", "run-1")).resolves.toBeUndefined();

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows/wf-1/runs/run-1/cancel");
    expect(init?.method).toBe("POST");
  });

  test("throws the backend detail on 409", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(409, { detail: "Run run-1 cannot be cancelled" }),
    );

    await expect(cancelWorkflowRun("wf-1", "run-1")).rejects.toThrow(
      "Run run-1 cannot be cancelled",
    );
  });
});

describe("continueWorkflowNode", () => {
  test("posts to /runs/{runId}/continue with node_id and prompt", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RUN));

    const result = await continueWorkflowNode(
      "wf-1",
      "run-1",
      "ai_step",
      "keep going",
    );

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows/wf-1/runs/run-1/continue");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      node_id: "ai_step",
      prompt: "keep going",
    });
    expect(result).toEqual(SAMPLE_RUN);
  });

  test("omits params when not supplied", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RUN));

    await continueWorkflowNode("wf-1", "run-1", "ai_step", "p");

    const { init } = lastCall();
    const body = JSON.parse(init?.body as string);
    expect(body).not.toHaveProperty("params");
  });

  test("includes params when supplied", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RUN));

    await continueWorkflowNode("wf-1", "run-1", "ai_step", "p", {
      input: "fresh",
    });

    const { init } = lastCall();
    expect(JSON.parse(init?.body as string)).toEqual({
      node_id: "ai_step",
      prompt: "p",
      params: { input: "fresh" },
    });
  });

  test("URL-encodes the run id", async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse(200, SAMPLE_RUN));

    await continueWorkflowNode("wf-1", "run 1/x", "ai_step", "p");

    const { url } = lastCall();
    expect(url).toContain("/api/workflows/wf-1/runs/run%201%2Fx/continue");
  });

  test("throws the backend detail on non-2xx", async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse(503, { detail: "Workflow dispatch unavailable" }),
    );

    await expect(
      continueWorkflowNode("wf-1", "run-1", "ai_step", "p"),
    ).rejects.toThrow("Workflow dispatch unavailable");
  });
});

describe("parseWorkflowSseLine", () => {
  test("maps a metadata frame", () => {
    expect(
      parseWorkflowSseLine([
        "event: metadata",
        'data: {"run_id":"r1","thread_id":"t1"}',
      ]),
    ).toEqual({ type: "metadata", runId: "r1", threadId: "t1" });
  });

  test("maps a wf:node:started frame", () => {
    expect(
      parseWorkflowSseLine([
        "event: wf:node:started",
        'data: {"node_id":"n1","step":2}',
      ]),
    ).toEqual({ type: "node-started", nodeId: "n1", step: 2 });
  });

  test("maps a wf:node:completed frame", () => {
    expect(
      parseWorkflowSseLine([
        "event: wf:node:completed",
        'data: {"node_id":"n1","step":3,"output":{"result":42}}',
      ]),
    ).toEqual({
      type: "node-completed",
      nodeId: "n1",
      step: 3,
      output: { result: 42 },
    });
  });

  test("maps a wf:node:failed frame", () => {
    expect(
      parseWorkflowSseLine([
        "event: wf:node:failed",
        'data: {"node_id":"n1","step":4,"error":"boom"}',
      ]),
    ).toEqual({ type: "node-failed", nodeId: "n1", step: 4, error: "boom" });
  });

  test("maps an error frame", () => {
    expect(
      parseWorkflowSseLine([
        "event: error",
        'data: {"message":"kaput","name":"ValueError"}',
      ]),
    ).toEqual({ type: "error", message: "kaput", name: "ValueError" });
  });

  test("maps an end frame with null data", () => {
    expect(parseWorkflowSseLine(["event: end", "data: null"])).toEqual({
      type: "end",
    });
  });

  test("returns null for unknown event types", () => {
    expect(
      parseWorkflowSseLine([
        "event: values",
        'data: {"node_id":"n1","step":1}',
      ]),
    ).toBeNull();
  });

  test("falls back to the data type field when the event line is missing", () => {
    expect(
      parseWorkflowSseLine([
        'data: {"type":"wf:node:started","node_id":"n1","step":1}',
      ]),
    ).toEqual({ type: "node-started", nodeId: "n1", step: 1 });
  });

  test("returns null for frames without data lines (heartbeat / comments)", () => {
    expect(parseWorkflowSseLine([": heartbeat"])).toBeNull();
    expect(parseWorkflowSseLine([])).toBeNull();
    expect(parseWorkflowSseLine(["id: 42"])).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(
      parseWorkflowSseLine(["event: metadata", "data: {not-json"]),
    ).toBeNull();
  });

  test("returns null when required fields are missing", () => {
    expect(
      parseWorkflowSseLine(["event: metadata", 'data: {"run_id":"r1"}']),
    ).toBeNull();
    expect(
      parseWorkflowSseLine([
        "event: wf:node:started",
        'data: {"node_id":"n1"}',
      ]),
    ).toBeNull();
  });
});

describe("streamWorkflowRun", () => {
  test("posts to /runs/stream with the payload", async () => {
    mockedFetch.mockResolvedValueOnce(sseResponse([]));

    await collect(streamWorkflowRun("wf-1", { params: { prompt: "hi" } }));

    const { url, init } = lastCall();
    expect(url).toContain("/api/workflows/wf-1/runs/stream");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      params: { prompt: "hi" },
    });
  });

  test("joins events split across chunk boundaries", async () => {
    mockedFetch.mockResolvedValueOnce(
      sseResponse([
        'event: wf:node:started\ndata: {"node_i',
        'd":"n1","step":1}\n\nevent: metadata\ndata: {"run_id"',
        ':"r1","thread_id":"t1"}\n\n',
      ]),
    );

    const events = await collect(streamWorkflowRun("wf-1"));

    expect(events).toEqual([
      { type: "node-started", nodeId: "n1", step: 1 },
      { type: "metadata", runId: "r1", threadId: "t1" },
      { type: "end" },
    ]);
  });

  test("emits multiple events from a single chunk", async () => {
    mockedFetch.mockResolvedValueOnce(
      sseResponse([
        [
          'event: metadata\ndata: {"run_id":"r1","thread_id":"t1"}',
          "",
          'event: wf:node:started\ndata: {"node_id":"n1","step":1}',
          "",
        ].join("\n"),
      ]),
    );

    const events = await collect(streamWorkflowRun("wf-1"));

    expect(events).toEqual([
      { type: "metadata", runId: "r1", threadId: "t1" },
      { type: "node-started", nodeId: "n1", step: 1 },
      { type: "end" },
    ]);
  });

  test("ignores heartbeat comments and blank lines", async () => {
    mockedFetch.mockResolvedValueOnce(
      sseResponse([
        ": heartbeat\n\n",
        'event: metadata\ndata: {"run_id":"r1","thread_id":"t1"}\n\n',
        "\n\n",
      ]),
    );

    const events = await collect(streamWorkflowRun("wf-1"));

    expect(events).toEqual([
      { type: "metadata", runId: "r1", threadId: "t1" },
      { type: "end" },
    ]);
  });

  test("pairs event and data lines within a frame", async () => {
    mockedFetch.mockResolvedValueOnce(
      sseResponse([
        'data: {"run_id":"r1","thread_id":"t1"}\nevent: metadata\n\n',
      ]),
    );

    const events = await collect(streamWorkflowRun("wf-1"));

    expect(events).toEqual([
      { type: "metadata", runId: "r1", threadId: "t1" },
      { type: "end" },
    ]);
  });

  test("handles CRLF line endings", async () => {
    mockedFetch.mockResolvedValueOnce(
      sseResponse([
        'event: metadata\r\ndata: {"run_id":"r1","thread_id":"t1"}\r\n\r\n',
      ]),
    );

    const events = await collect(streamWorkflowRun("wf-1"));

    expect(events).toEqual([
      { type: "metadata", runId: "r1", threadId: "t1" },
      { type: "end" },
    ]);
  });

  test("emits a terminal end event when the stream closes without one", async () => {
    mockedFetch.mockResolvedValueOnce(
      sseResponse([
        'event: metadata\ndata: {"run_id":"r1","thread_id":"t1"}\n\n',
      ]),
    );

    const events = await collect(streamWorkflowRun("wf-1"));

    expect(events).toEqual([
      { type: "metadata", runId: "r1", threadId: "t1" },
      { type: "end" },
    ]);
  });

  test("does not duplicate an explicit end event", async () => {
    mockedFetch.mockResolvedValueOnce(
      sseResponse([
        'event: metadata\ndata: {"run_id":"r1","thread_id":"t1"}\n\n',
        "event: end\ndata: null\n\n",
      ]),
    );

    const events = await collect(streamWorkflowRun("wf-1"));

    expect(events).toEqual([
      { type: "metadata", runId: "r1", threadId: "t1" },
      { type: "end" },
    ]);
  });

  test("throws on non-2xx before reading the body", async () => {
    mockedFetch.mockResolvedValueOnce(sseResponse([], 500));

    await expect(collect(streamWorkflowRun("wf-1"))).rejects.toThrow(
      /Failed to stream workflow run/,
    );
  });
});
