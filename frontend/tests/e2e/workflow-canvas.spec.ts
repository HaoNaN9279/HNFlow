import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockLangGraphAPI } from "./utils/mock-api";

// ---------------------------------------------------------------------------
// Mock backend — GET/POST /api/workflows, GET/PUT/DELETE /api/workflows/{id}
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
 * A workflow with two temporary "anchor" nodes that exist only to stabilise
 * the canvas viewport.
 *
 * On an empty canvas React Flow's `fitView` leaves the viewport zoomed to
 * ~2x (empty bounds), so the dropped nodes overlap heavily and real-mouse
 * connections cannot reach the source handles. Seeding two distant anchor
 * nodes gives `fitView` a real bounds box and a sane ~0.7x zoom; the test
 * deletes the anchors again before saving so the persisted definition only
 * contains the five dragged nodes.
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
  initialState?: MockWorkflowRecord,
  putBehavior?: { status: number; body: unknown },
) {
  let record = initialState ?? blankRecord();
  let savedPutBody: Record<string, unknown> | null = null;

  void page.route("**/api/workflows", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }
    return route.fallback();
  });

  void page.route("**/api/workflows/wf-e2e", (route) => {
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
      if (putBehavior && putBehavior.status >= 400) {
        return route.fulfill({
          status: putBehavior.status,
          contentType: "application/json",
          body: JSON.stringify(putBehavior.body),
        });
      }
      const definition = savedPutBody.definition as MockWorkflowRecord["definition"];
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
    if (request.method() === "DELETE") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: WORKFLOW_ID, deleted: true }),
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
// Canvas interaction helpers
// ---------------------------------------------------------------------------

async function dropPaletteItem(
  page: Page,
  nodeType: string,
  clientX: number,
  clientY: number,
) {
  const item = page.getByTestId(`palette-item-${nodeType}`);
  await expect(item).toHaveCount(1);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await item.dispatchEvent("dragstart", { dataTransfer });
  await page.locator(".react-flow").dispatchEvent("drop", {
    dataTransfer,
    clientX,
    clientY,
  });
}

/** The `.react-flow__node` wrapper hosting a node of the given catalog type. */
function nodeWrapper(page: Page, nodeType: string): Locator {
  return page.locator(".react-flow__node", {
    has: page.locator(`[data-node-type="${nodeType}"]`),
  });
}

function handleOf(
  page: Page,
  nodeType: string,
  kind: "source" | "target",
): Locator {
  return nodeWrapper(page, nodeType).locator(`.react-flow__handle.${kind}`);
}

/**
 * Real mouse drag from a source handle to a target handle.
 *
 * This must be a real (trusted) input — React Flow only registers its
 * connection drag on trusted pointer events, so synthesised
 * `PointerEvent`/`MouseEvent` dispatches never start a connection. The
 * canvas viewport must therefore be laid out sanely first: an empty canvas
 * leaves `fitView` zoomed to ~2x where nodes overlap and source handles get
 * covered, so tests that connect nodes seed two temporary anchor nodes and
 * delete them again before saving.
 */
async function dragConnect(
  page: Page,
  source: Locator,
  target: Locator,
  options?: { expectedStatus?: "valid" | "invalid" },
) {
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) {
    throw new Error("handle has no bounding box");
  }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 12,
  });
  if (options?.expectedStatus) {
    // The connection line only exists while the drag is in progress. It is
    // an SVG <g> element (no own geometry), so assert presence rather than
    // visibility — `toBeVisible()` always treats it as hidden.
    await expect(
      page.locator(`.react-flow__connection.${options.expectedStatus}`),
    ).toHaveCount(1);
  }
  await page.mouse.up();
}

async function readNodeTransforms(
  page: Page,
): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(() => {
    const result: Record<string, { x: number; y: number }> = {};
    const regex = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/;
    for (const element of Array.from(
      document.querySelectorAll(".react-flow__node"),
    )) {
      const id = element.getAttribute("data-id");
      const style = element.getAttribute("style") ?? "";
      const match = regex.exec(style);
      if (id && match) {
        result[id] = { x: Number(match[1]), y: Number(match[2]) };
      }
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Workflow canvas", () => {
  test.beforeEach(async ({ page }) => {
    // The workflows copy is asserted in zh-CN (default workspace locale).
    await page.addInitScript(() => {
      document.cookie = "locale=zh-CN; path=/; SameSite=Lax";
    });
    mockLangGraphAPI(page);
  });

  test("drag 5 nodes, connect them, save, and restore on reload", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const api = mockWorkflowsAPI(page, anchorRecord());
    await page.setViewportSize({ width: 1600, height: 900 });

    await page.goto(`/workspace/workflows/${WORKFLOW_ID}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);

    // The two anchor nodes give `fitView` a real bounds box; wait for the
    // viewport to settle before dropping anything (empty-canvas fitView
    // would leave a ~2x zoom where nodes overlap).
    await expect
      .poll(async () => {
        const style = await page
          .locator(".react-flow__viewport")
          .getAttribute("style");
        return (style ?? "").includes("scale(") ? style : null;
      })
      .toBeTruthy();

    // Drop the five catalog nodes onto the canvas (2-column layout so the
    // source/target handles stay clear of each other).
    const canvasBox = (await page.locator(".react-flow").boundingBox())!;
    const spots = [
      { type: "flow:start", x: canvasBox.x + 60, y: canvasBox.y + 60 },
      { type: "ai:llm_agent", x: canvasBox.x + 360, y: canvasBox.y + 60 },
      { type: "human:task", x: canvasBox.x + 60, y: canvasBox.y + 240 },
      { type: "data:assign", x: canvasBox.x + 360, y: canvasBox.y + 240 },
      { type: "flow:end", x: canvasBox.x + 60, y: canvasBox.y + 420 },
    ];
    for (const spot of spots) {
      await dropPaletteItem(page, spot.type, spot.x, spot.y);
      // 2 anchors + 1 dropped node per iteration.
      await expect(page.locator(".react-flow__node")).toHaveCount(
        spots.indexOf(spot) + 3,
      );
    }
    await expect(page.locator(".react-flow__node")).toHaveCount(7);

    // Chain start -> llm -> human -> assign -> end (all `data` ports).
    await dragConnect(
      page,
      handleOf(page, "flow:start", "source"),
      handleOf(page, "ai:llm_agent", "target"),
      { expectedStatus: "valid" },
    );
    await dragConnect(
      page,
      handleOf(page, "ai:llm_agent", "source"),
      handleOf(page, "human:task", "target"),
    );
    await dragConnect(
      page,
      handleOf(page, "human:task", "source"),
      handleOf(page, "data:assign", "target"),
    );
    await dragConnect(
      page,
      handleOf(page, "data:assign", "source"),
      handleOf(page, "flow:end", "target"),
    );
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);

    // Remove the two layout anchors so the saved definition only contains
    // the five dragged nodes.
    for (const anchorType of ["flow:if", "tool:bash"]) {
      await nodeWrapper(page, anchorType).click();
      await page.keyboard.press("Delete");
    }
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);

    // Save and assert the PUT body: 5 nodes, 4 edges, 5 canvas positions.
    const saveButton = page.getByRole("button", { name: "保存" });
    await expect(saveButton).toBeEnabled();
    const putDone = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/workflows/${WORKFLOW_ID}`) &&
        response.request().method() === "PUT",
    );
    await saveButton.click();
    await putDone;
    await expect(page.getByText("工作流已保存")).toBeVisible();

    const putBody = api.getSavedPutBody() as {
      definition: { nodes: MockNode[]; edges: MockEdge[] };
      metadata: {
        canvas?: { positions?: Record<string, { x: number; y: number }> };
      };
    };
    const savedNodes = putBody.definition.nodes;
    const savedEdges = putBody.definition.edges;
    const savedPositions = putBody.metadata.canvas?.positions ?? {};
    expect(savedNodes).toHaveLength(5);
    expect(
      savedNodes.map((node) => node.type).sort(),
    ).toEqual(["ai:llm_agent", "data:assign", "flow:end", "flow:start", "human:task"]);
    // The five dragged nodes must have persisted positions. The two deleted
    // anchor nodes also remain under `metadata.canvas.positions` — the
    // editor does not prune positions when nodes are removed (see T14-5
    // report) — so assert coverage of the saved nodes, not an exact count.
    expect(Object.keys(savedPositions)).toEqual(
      expect.arrayContaining(savedNodes.map((node) => node.id)),
    );
    expect(Object.keys(savedPositions).length).toBeGreaterThanOrEqual(5);

    // D2 wire shape: edges carry source/target ports matching the chain.
    expect(savedEdges).toHaveLength(4);
    const idOf = (type: string) =>
      savedNodes.find((node) => node.type === type)?.id ?? "";
    expect(savedEdges[0]).toEqual({
      source: idOf("flow:start"),
      source_port: "out",
      target: idOf("ai:llm_agent"),
      target_port: "in",
    });
    expect(savedEdges[1]).toEqual({
      source: idOf("ai:llm_agent"),
      source_port: "out",
      target: idOf("human:task"),
      target_port: "in",
    });
    expect(savedEdges[2]).toEqual({
      source: idOf("human:task"),
      source_port: "out",
      target: idOf("data:assign"),
      target_port: "in",
    });
    expect(savedEdges[3]).toEqual({
      source: idOf("data:assign"),
      source_port: "out",
      target: idOf("flow:end"),
      target_port: "in",
    });

    // Reload — the mocked GET now returns the saved definition + metadata.
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(5);
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);

    // D1 restore: the rendered node transforms are flow coordinates (the
    // same space `metadata.canvas.positions` is stored in), so the reloaded
    // node positions must equal the saved positions directly.
    await expect(async () => {
      const restored = await readNodeTransforms(page);
      const firstId = savedNodes[0]!.id;
      const saved = savedPositions[firstId];
      const actual = restored[firstId];
      expect(saved).toBeTruthy();
      expect(actual).toBeTruthy();
      expect(Math.abs(actual!.x - saved!.x)).toBeLessThan(2);
      expect(Math.abs(actual!.y - saved!.y)).toBeLessThan(2);
    }).toPass();

    const restored = await readNodeTransforms(page);
    // Compare against the saved nodes only — `savedPositions` may carry the
    // stale anchor entries the editor never prunes.
    for (const node of savedNodes) {
      const saved = savedPositions[node.id];
      expect(saved, `position for ${node.id} saved`).toBeTruthy();
      const actual = restored[node.id];
      expect(actual, `node ${node.id} restored`).toBeTruthy();
      expect(Math.abs(actual!.x - saved!.x)).toBeLessThan(2);
      expect(Math.abs(actual!.y - saved!.y)).toBeLessThan(2);
    }
  });

  test("rejects port-type mismatch connections and allows same-type ones", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    mockWorkflowsAPI(page);
    await page.setViewportSize({ width: 1600, height: 900 });

    await page.goto(`/workspace/workflows/${WORKFLOW_ID}`);
    await expect(page.locator(".react-flow")).toBeVisible();

    const canvasBox = (await page.locator(".react-flow").boundingBox())!;
    // data:file outputs `file`; data:assign expects `data` on its input.
    await dropPaletteItem(page, "data:file", canvasBox.x + 60, canvasBox.y + 60);
    await dropPaletteItem(page, "data:assign", canvasBox.x + 560, canvasBox.y + 60);
    await dropPaletteItem(page, "flow:start", canvasBox.x + 60, canvasBox.y + 240);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);

    // Mismatch: file -> data is rejected live (invalid connection line),
    // no edge is created and no connect toast appears.
    await dragConnect(
      page,
      handleOf(page, "data:file", "source"),
      handleOf(page, "data:assign", "target"),
      { expectedStatus: "invalid" },
    );
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await expect(page.getByText("端口类型不匹配")).toHaveCount(0);

    // Control: start.out (data) -> data:assign.in (data) succeeds.
    await dragConnect(
      page,
      handleOf(page, "flow:start", "source"),
      handleOf(page, "data:assign", "target"),
      { expectedStatus: "valid" },
    );
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  });

  test("surfaces backend 422 validation errors and highlights target nodes", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const preset = blankRecord();
    preset.definition.nodes = [
      {
        id: "n_start",
        type: "flow:start",
        inputs: [],
        outputs: [{ name: "out", type: "data", required: true }],
        params: {},
        capability_groups: [],
        agent_name: null,
      },
      {
        id: "n_x",
        type: "data:file",
        inputs: [{ name: "in", type: "file", required: true }],
        outputs: [{ name: "out", type: "file", required: true }],
        params: {},
        capability_groups: [],
        agent_name: null,
      },
    ];
    preset.definition.edges = [
      { source: "n_start", source_port: "out", target: "n_x", target_port: "in" },
    ];
    preset.definition.metadata = {
      canvas: {
        positions: {
          n_start: { x: 120, y: 120 },
          n_x: { x: 560, y: 120 },
        },
      },
    };
    mockWorkflowsAPI(page, preset, {
      status: 422,
      body: {
        detail: {
          errors: [
            "edge[0]: incompatible port types — 'n_start.out' is data but 'n_x.in' is file",
            "node 'n_x': file node requires a file input",
          ],
        },
      },
    });
    await page.setViewportSize({ width: 1600, height: 900 });

    await page.goto(`/workspace/workflows/${WORKFLOW_ID}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    // Make the document dirty so Save is enabled, then save into the 422.
    const canvasBox = (await page.locator(".react-flow").boundingBox())!;
    await dropPaletteItem(page, "flow:wait", canvasBox.x + 120, canvasBox.y + 360);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);

    const saveButton = page.getByRole("button", { name: "保存" });
    await expect(saveButton).toBeEnabled();
    const putDone = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/workflows/${WORKFLOW_ID}`) &&
        response.request().method() === "PUT" &&
        response.status() === 422,
    );
    await saveButton.click();
    await putDone;

    // Error strip renders the parsed messages with the validation prefix.
    const errorList = page.getByTestId("workflow-error-list");
    await expect(errorList).toBeVisible();
    await expect(errorList).toContainText("校验失败");
    await expect(errorList.locator('[data-error-id="n_x"]')).toContainText(
      "node 'n_x'",
    );
    await expect(errorList.locator('[data-error-id="0"]')).toContainText(
      "edge[0]",
    );

    // The referenced node carries the error highlight.
    await expect(
      page.locator('.react-flow__node[data-id="n_x"] [data-error="true"]'),
    ).toBeVisible();
    await expect(page.locator('[data-error="true"]')).toHaveCount(1);

    // The pane exposes the error-node count for E2E correlation.
    await expect(
      page.locator(".react-flow[data-error-node-count]"),
    ).toHaveAttribute("data-error-node-count", "1");
  });
});
