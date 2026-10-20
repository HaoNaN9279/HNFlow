import http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { mockLangGraphAPI } from "./utils/mock-api";
import { addNodeFromCatalog } from "./utils/workflow-canvas";

// ---------------------------------------------------------------------------
// Mock backend — workflow editor + run monitoring (T16).
//
// The editor loads from GET /api/workflows/{id} and saves via PUT; the run
// monitor streams POST /api/workflows/{id}/runs/stream (SSE) and cancels via
// POST /api/workflows/{id}/runs/{runId}/cancel. The list page reads the latest
// run badge from GET /api/console/runs?assistant_id=...&limit=1.
//
// SSE is mocked one of two ways:
//  - one-shot `route.fulfill` with the complete frame sequence (fast paths —
//    the stream is consumed synchronously, so only terminal state is asserted);
//  - a local streaming HTTP server behind `route.continue({ url })` for the
//    cancel test, which needs a genuine in-flight window (metadata + started
//    arrive, the connection stays open) before the Stop button is exercised.
// ---------------------------------------------------------------------------

const WORKFLOW_ID = "wf-e2e";

type MockNode = {
  id: string;
  type: string;
  inputs: { name: string; type: string; required?: boolean }[];
  outputs: { name: string; type: string; required?: boolean }[];
  params: Record<string, unknown>;
  capability_groups: string[];
  agent_name: string | null;
};

type MockEdge = {
  source: string;
  source_port: string;
  target: string;
  target_port: string;
};

type MockWorkflowRecord = {
  id: string;
  user_id: string;
  name: string;
  schema_version: number;
  definition: {
    id: string;
    name: string;
    version: string;
    nodes: MockNode[];
    edges: MockEdge[];
    metadata: Record<string, unknown>;
  };
  metadata: Record<string, unknown>;
  version: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

type MockConsoleRun = {
  run_id: string;
  thread_id: string;
  assistant_id?: string;
  status:
    | "pending"
    | "running"
    | "success"
    | "error"
    | "timeout"
    | "interrupted";
  created_at?: string;
  updated_at?: string;
  duration_seconds?: number;
  error?: string;
};

function blankRecord(): MockWorkflowRecord {
  return {
    id: WORKFLOW_ID,
    user_id: "e2e-user",
    name: "E2E Flow",
    schema_version: 1,
    definition: {
      id: WORKFLOW_ID,
      name: "E2E Flow",
      version: "0.1.0",
      nodes: [],
      edges: [],
      metadata: {},
    },
    metadata: {},
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

/**
 * Two distant anchor nodes to stabilise the canvas viewport (empty-canvas
 * `fitView` zooms to ~2x and overlaps dropped nodes). Same strategy as the
 * T14/T15 specs.
 */
function anchorRecord(): MockWorkflowRecord {
  const record = blankRecord();
  record.definition.nodes = [
    {
      id: "n_anchor1",
      type: "flow:if",
      inputs: [{ name: "in", type: "data", required: true }],
      outputs: [
        { name: "true", type: "bool", required: true },
        { name: "false", type: "bool", required: true },
      ],
      params: {},
      capability_groups: [],
      agent_name: null,
    },
    {
      id: "n_anchor2",
      type: "tool:bash",
      inputs: [{ name: "in", type: "data", required: true }],
      outputs: [{ name: "out", type: "data", required: true }],
      params: {},
      capability_groups: [],
      agent_name: null,
    },
  ];
  record.definition.metadata = {
    canvas: {
      positions: {
        n_anchor1: { x: 60, y: 700 },
        n_anchor2: { x: 700, y: 700 },
      },
    },
  };
  return record;
}

function mockWorkflowsAPI(
  page: Page,
  options?: {
    record?: MockWorkflowRecord;
    list?: MockWorkflowRecord[];
    runs?: MockConsoleRun[];
  },
) {
  let record = options?.record ?? blankRecord();
  const list = options?.list ?? [];
  const runs = options?.runs ?? [];
  let savedPutBody: Record<string, unknown> | null = null;

  void page.route("**/api/workflows", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(list),
      });
    }
    return route.fallback();
  });

  void page.route(`**/api/workflows/${WORKFLOW_ID}`, (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(record),
      });
    }
    if (request.method() === "PUT") {
      savedPutBody = request.postDataJSON() as Record<string, unknown>;
      const definition =
        savedPutBody.definition as MockWorkflowRecord["definition"];
      const metadata = (savedPutBody.metadata as Record<string, unknown>) ?? {};
      record = {
        ...record,
        definition: { ...definition, metadata },
        metadata,
        updated_at: "2026-08-01T00:01:00Z",
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(record),
      });
    }
    return route.fallback();
  });

  // The list badge reads GET /api/console/runs?assistant_id=...&limit=1 — the
  // glob `*` crosses the query string (it does not cross `/`).
  void page.route("**/api/console/runs*", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs, has_more: false }),
      });
    }
    return route.fallback();
  });

  return {
    getSavedPutBody: () => savedPutBody,
    getRecord: () => record,
  };
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function successSse(nodeId: string): string {
  return [
    sseFrame("metadata", { run_id: "run-e2e-1", thread_id: "thread-e2e-1" }),
    sseFrame("wf:node:started", { node_id: nodeId, step: 0 }),
    sseFrame("wf:node:completed", {
      node_id: nodeId,
      step: 0,
      output: { result: "hello" },
    }),
    sseFrame("end", null),
  ].join("");
}

function failureSse(nodeId: string): string {
  return [
    sseFrame("metadata", { run_id: "run-e2e-2", thread_id: "thread-e2e-1" }),
    sseFrame("wf:node:started", { node_id: nodeId, step: 0 }),
    sseFrame("wf:node:failed", {
      node_id: nodeId,
      step: 0,
      error: "boom: node crashed",
    }),
    sseFrame("error", { message: "boom: node crashed", name: "NodeError" }),
    sseFrame("end", null),
  ].join("");
}

// ---------------------------------------------------------------------------
// Canvas interaction helpers (mirror the T14/T15 specs)
// ---------------------------------------------------------------------------

/** Wait until `fitView` has settled (the viewport carries a scale transform). */
async function waitForSettledViewport(page: Page) {
  await expect
    .poll(async () => {
      const style = await page
        .locator(".react-flow__viewport")
        .getAttribute("style");
      return (style ?? "").includes("scale(") ? style : null;
    })
    .toBeTruthy();
}

/**
 * Open the editor, add one `ai:llm_agent` node (above the two anchor nodes),
 * save it, and return the added node's id — the id the SSE frames must
 * reference for the canvas to paint the run state.
 */
async function openEditorWithAiNode(
  page: Page,
  api: ReturnType<typeof mockWorkflowsAPI>,
): Promise<string> {
  await page.goto(`/workspace/workflows/${WORKFLOW_ID}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await waitForSettledViewport(page);

  const canvasBox = (await page.locator(".react-flow").boundingBox())!;
  await addNodeFromCatalog(
    page,
    "ai:llm_agent",
    canvasBox.x + 360,
    canvasBox.y + 60,
  );
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

  const saveButton = page.getByRole("button", { name: "Save" });
  await expect(saveButton).toBeEnabled();
  const putDone = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/workflows/${WORKFLOW_ID}`) &&
      response.request().method() === "PUT",
  );
  await saveButton.click();
  await putDone;
  await expect(page.getByText("Workflow saved")).toBeVisible();

  const putBody = api.getSavedPutBody() as {
    definition: { nodes: MockNode[] };
  };
  const aiNode = putBody.definition.nodes.find(
    (node) => node.type === "ai:llm_agent",
  );
  expect(aiNode).toBeTruthy();
  return aiNode!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Workflow run monitoring", () => {
  test.beforeEach(async ({ page }) => {
    // Pin the locale so UI copy is deterministic (en-US here).
    await page.addInitScript(() => {
      document.cookie = "locale=en-US; path=/; SameSite=Lax";
    });
    mockLangGraphAPI(page);
    await page.setViewportSize({ width: 1600, height: 900 });
  });

  test("successful run: node completed, panel timeline + output, terminal Success", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const api = mockWorkflowsAPI(page, { record: anchorRecord() });
    const nodeId = await openEditorWithAiNode(page, api);

    // One-shot SSE: metadata -> started -> completed(output) -> end.
    await page.route("**/api/workflows/wf-e2e/runs/stream", (route) => {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: successSse(nodeId),
      });
    });

    const runButton = page.getByRole("button", {
      name: "Run",
      exact: true,
    });
    await expect(runButton).toBeEnabled();
    await runButton.click();

    const runPanel = page.getByTestId("workflow-run-panel");

    // Canvas node painted completed (green border).
    await expect(
      page.locator(
        `.react-flow__node[data-id="${nodeId}"] [data-run-state="completed"]`,
      ),
    ).toHaveCount(1);

    // Timeline entry for the node with status completed + output JSON visible.
    const completedEntry = runPanel.locator(
      `[data-timeline-node="${nodeId}"][data-timeline-status="completed"]`,
    );
    await expect(completedEntry).toHaveCount(1);
    await completedEntry.locator("summary").click();
    await expect(completedEntry.locator("pre")).toContainText(
      '"result": "hello"',
    );

    // Terminal result + run badge.
    await expect(runPanel.getByTestId("workflow-run-terminal")).toContainText(
      "Success",
    );
    await expect(runPanel.getByTestId("workflow-run-badge")).toHaveAttribute(
      "data-status",
      "success",
    );
  });

  test("failed run: node failed, panel error + timeline error, terminal Failed", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const api = mockWorkflowsAPI(page, { record: anchorRecord() });
    const nodeId = await openEditorWithAiNode(page, api);

    // One-shot SSE: metadata -> started -> failed(error) -> error(message) -> end.
    await page.route("**/api/workflows/wf-e2e/runs/stream", (route) => {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: failureSse(nodeId),
      });
    });

    const runButton = page.getByRole("button", {
      name: "Run",
      exact: true,
    });
    await expect(runButton).toBeEnabled();
    await runButton.click();

    const runPanel = page.getByTestId("workflow-run-panel");

    // Canvas node painted failed (destructive border).
    await expect(
      page.locator(
        `.react-flow__node[data-id="${nodeId}"] [data-run-state="failed"]`,
      ),
    ).toHaveCount(1);

    // Timeline failed entry surfaces the node error text.
    const failedEntry = runPanel.locator(
      `[data-timeline-node="${nodeId}"][data-timeline-status="failed"]`,
    );
    await expect(failedEntry).toHaveCount(1);
    await expect(failedEntry).toContainText("boom: node crashed");

    // The run-level error detail (from the `error` SSE frame).
    await expect(runPanel.getByTestId("workflow-run-error")).toContainText(
      "boom: node crashed",
    );

    // Terminal result + run badge.
    await expect(runPanel.getByTestId("workflow-run-terminal")).toContainText(
      "Failed",
    );
    await expect(runPanel.getByTestId("workflow-run-badge")).toHaveAttribute(
      "data-status",
      "error",
    );
  });

  test("cancel an in-flight run: Save disabled, Stop cancels, terminal Interrupted", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const api = mockWorkflowsAPI(page, { record: anchorRecord() });
    const nodeId = await openEditorWithAiNode(page, api);

    // A genuine streaming server: metadata + started arrive, the connection
    // stays open (in-flight window), and the test drives the trailing `end`
    // frame after Stop is exercised. The live response is stashed in an object
    // so TypeScript does not narrow the variable back to `null` (the value is
    // only ever assigned inside the request callback).
    const stream = { res: null as http.ServerResponse | null };
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(
        sseFrame("metadata", {
          run_id: "run-e2e-cancel",
          thread_id: "thread-e2e-1",
        }),
      );
      res.write(sseFrame("wf:node:started", { node_id: nodeId, step: 0 }));
      stream.res = res;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;

    await page.route("**/api/workflows/wf-e2e/runs/stream", (route) => {
      return route.continue({ url: `http://127.0.0.1:${port}/stream` });
    });
    await page.route("**/api/workflows/wf-e2e/runs/*/cancel", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            run_id: "run-e2e-cancel",
            status: "interrupted",
          }),
        });
      }
      return route.fallback();
    });

    try {
      const runButton = page.getByRole("button", {
        name: "Run",
        exact: true,
      });
      await expect(runButton).toBeEnabled();
      await runButton.click();

      const runPanel = page.getByTestId("workflow-run-panel");

      // In-flight window: Stop replaces Run, Save is disabled while running,
      // the node paints running and the panel badge says running.
      await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
      await expect(
        page.locator(
          `.react-flow__node[data-id="${nodeId}"] [data-run-state="running"]`,
        ),
      ).toHaveCount(1);
      await expect(runPanel.getByTestId("workflow-run-badge")).toHaveAttribute(
        "data-status",
        "running",
      );

      // Stop -> POST cancel (202). The stream stays open until the test sends
      // the `end` frame, so the run settles into `interrupted` afterwards.
      const cancelDone = page.waitForResponse(
        (response) =>
          response.url().includes("/cancel") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Stop" }).click();
      await cancelDone;

      const liveRes = stream.res;
      if (liveRes) {
        liveRes.write(sseFrame("end", null));
        liveRes.end();
      }

      await expect(runPanel.getByTestId("workflow-run-terminal")).toContainText(
        "Interrupted",
      );
      await expect(runPanel.getByTestId("workflow-run-badge")).toHaveAttribute(
        "data-status",
        "interrupted",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("list page shows the latest-run badge from console history", async ({
    page,
  }) => {
    const api = mockWorkflowsAPI(page, {
      list: [blankRecord()],
      runs: [
        {
          run_id: "run-hist-1",
          thread_id: "thread-e2e-1",
          assistant_id: WORKFLOW_ID,
          status: "success",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
          duration_seconds: 5,
        },
      ],
    });
    void api;

    await page.goto("/workspace/workflows");

    const badge = page.getByTestId("workflow-run-badge");
    await expect(badge).toHaveAttribute("data-status", "success");
    await expect(badge).toHaveText("Success");
  });

  test("list page renders no badge for empty run history", async ({ page }) => {
    const api = mockWorkflowsAPI(page, { list: [blankRecord()], runs: [] });
    void api;

    const runsDone = page.waitForResponse(
      (response) =>
        response.url().includes("/api/console/runs") &&
        response.request().method() === "GET",
    );
    await page.goto("/workspace/workflows");
    await runsDone;
    await expect(page.getByTestId("workflow-list")).toBeVisible();
    await expect(page.getByTestId("workflow-run-badge")).toHaveCount(0);
  });
});
