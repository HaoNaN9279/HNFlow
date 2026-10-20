import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockLangGraphAPI } from "./utils/mock-api";
import { addNodeFromCatalog } from "./utils/workflow-canvas";

// ---------------------------------------------------------------------------
// Mock backend — GET/POST /api/workflows, GET/PUT/DELETE /api/workflows/{id},
// plus the template list (GET /api/workflows) and skills (mockLangGraphAPI).
//
// The typed node forms (ai:llm_agent / nested:subworkflow) fetch their option
// lists through TanStack Query: /api/agents, /api/skills and /api/workflows.
// The workflow record itself loads from /api/workflows/{id}.
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

/** PUT behavior — static or derived from the actual PUT body (dynamic node ids). */
type PutBehavior =
  | { status: number; body: unknown }
  | ((putBody: Record<string, unknown>) => { status: number; body: unknown });

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
 * T14 canvas spec.
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

function templateRecord(
  id: string,
  name: string,
  version: string,
): MockWorkflowRecord {
  return {
    id,
    user_id: "e2e-user",
    name,
    schema_version: 1,
    definition: { id, name, version, nodes: [], edges: [], metadata: {} },
    metadata: {},
    version,
    resolved_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function mockWorkflowsAPI(
  page: Page,
  initialState: MockWorkflowRecord,
  options?: { putBehavior?: PutBehavior; templates?: MockWorkflowRecord[] },
) {
  let record = initialState;
  let savedPutBody: Record<string, unknown> | null = null;
  const templates = options?.templates ?? [];

  // Workflow list — the subworkflow template picker reads it through
  // `useWorkflowTemplateOptions` (TanStack Query → `listWorkflows`).
  void page.route("**/api/workflows", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(templates),
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
      const behavior =
        typeof options?.putBehavior === "function"
          ? options.putBehavior(savedPutBody)
          : options?.putBehavior;
      if (behavior && behavior.status >= 400) {
        return route.fulfill({
          status: behavior.status,
          contentType: "application/json",
          body: JSON.stringify(behavior.body),
        });
      }
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
// Canvas interaction helpers (mirror the T14 canvas spec)
// ---------------------------------------------------------------------------

/** The `.react-flow__node` wrapper hosting a node of the given catalog type. */
function nodeWrapper(page: Page, nodeType: string): Locator {
  return page.locator(".react-flow__node", {
    has: page.locator(`[data-node-type="${nodeType}"]`),
  });
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Workflow node forms", () => {
  test.beforeEach(async ({ page }) => {
    // Pin the locale so UI copy is deterministic (en-US here).
    await page.addInitScript(() => {
      document.cookie = "locale=en-US; path=/; SameSite=Lax";
    });
    mockLangGraphAPI(page);
    await page.setViewportSize({ width: 1600, height: 900 });
  });

  test("AI node form: edit instruction/agent, save, and restore on reload", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const api = mockWorkflowsAPI(page, anchorRecord());
    await page.goto(`/workspace/workflows/${WORKFLOW_ID}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await waitForSettledViewport(page);

    // Drop the AI node above the anchors and select it.
    const canvasBox = (await page.locator(".react-flow").boundingBox())!;
    await addNodeFromCatalog(
      page,
      "ai:llm_agent",
      canvasBox.x + 360,
      canvasBox.y + 60,
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await nodeWrapper(page, "ai:llm_agent").click();

    const panel = page.getByTestId("workflow-properties-panel");
    await expect(panel).toContainText("AI Agent");
    const instruction = panel.locator('textarea[id$="-instruction"]');
    await expect(instruction).toBeVisible();

    // instruction — required field, fill it.
    const instructionText = "Summarize the monthly report";
    await instruction.fill(instructionText);
    await instruction.blur();

    // agent — switch to Custom agent... and type a name.
    await panel.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: "Custom agent..." }).click();
    const agentInput = page.getByLabel("Custom agent name");
    await expect(agentInput).toBeVisible();
    await agentInput.fill("publisher");
    await agentInput.blur();

    // Remove the two layout anchors so the saved definition only holds the
    // AI node (same anchor strategy as the T14 canvas spec).
    for (const anchorType of ["flow:if", "tool:bash"]) {
      await nodeWrapper(page, anchorType).click();
      await page.keyboard.press("Delete");
    }
    await expect(page.locator(".react-flow__node")).toHaveCount(1);

    // Save and assert the PUT body carries the form values.
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
    expect(putBody.definition.nodes).toHaveLength(1);
    const aiNode = putBody.definition.nodes[0]!;
    expect(aiNode.type).toBe("ai:llm_agent");
    expect(aiNode.params.instruction).toBe(instructionText);
    expect(aiNode.agent_name).toBe("publisher");

    // Reload — the mocked GET now returns the saved definition; re-select the
    // node and assert every form field was restored.
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
    await nodeWrapper(page, "ai:llm_agent").click();
    const restoredPanel = page.getByTestId("workflow-properties-panel");
    await expect(restoredPanel).toContainText("AI Agent");
    await expect(
      restoredPanel.locator('textarea[id$="-instruction"]'),
    ).toHaveValue(instructionText);
    await expect(page.getByLabel("Custom agent name")).toHaveValue("publisher");
  });

  test("subworkflow node: pick a template, save, and restore on reload", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const templates = [
      templateRecord("wf-report", "Report Generator", "1.0.0"),
      templateRecord("wf-etl", "ETL Pipeline", "2.1.0"),
    ];
    const api = mockWorkflowsAPI(page, anchorRecord(), { templates });
    await page.goto(`/workspace/workflows/${WORKFLOW_ID}`);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await waitForSettledViewport(page);

    const canvasBox = (await page.locator(".react-flow").boundingBox())!;
    await addNodeFromCatalog(
      page,
      "nested:subworkflow",
      canvasBox.x + 360,
      canvasBox.y + 60,
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await nodeWrapper(page, "nested:subworkflow").click();

    const panel = page.getByTestId("workflow-properties-panel");
    await expect(panel).toContainText("Subworkflow");

    // The template select lists the mocked /api/workflows records.
    const templateSelect = panel.getByRole("combobox", {
      name: "Workflow template",
    });
    await expect(templateSelect).toBeVisible();
    await templateSelect.click();
    await page
      .getByRole("option", { name: "Report Generator (1.0.0)" })
      .click();
    // Note: the version line and the select label only update after a reload
    // because `handleTemplateSelect` commits without updating local state.

    // Save and assert the compile-mode template spec.
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
    const subNode = putBody.definition.nodes.find(
      (node) => node.type === "nested:subworkflow",
    );
    expect(subNode).toBeTruthy();
    expect(subNode!.params.subworkflow).toEqual({
      type: "template",
      mode: "compile",
      template_id: "wf-report",
      version: "1.0.0",
    });

    // Reload — the selected template is restored in the select + version line.
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await nodeWrapper(page, "nested:subworkflow").click();
    const restoredPanel = page.getByTestId("workflow-properties-panel");
    await expect(restoredPanel).toContainText("Subworkflow");
    await expect(
      restoredPanel.getByRole("combobox", { name: "Workflow template" }),
    ).toContainText("Report Generator (1.0.0)");
    await expect(
      restoredPanel.getByText("1.0.0", { exact: true }),
    ).toBeVisible();
  });

  test("front-end validation is inline and non-blocking; backend 422 highlights the node", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const api = mockWorkflowsAPI(page, anchorRecord(), {
      putBehavior: (putBody) => {
        const nodes = (putBody.definition as { nodes: MockNode[] }).nodes;
        const aiNode = nodes.find((node) => node.type === "ai:llm_agent");
        return {
          status: 422,
          body: {
            detail: {
              errors: [
                `node '${aiNode?.id ?? "unknown"}': agent_name must match ^[A-Za-z0-9-]+$`,
              ],
            },
          },
        };
      },
    });
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
    await nodeWrapper(page, "ai:llm_agent").click();

    const panel = page.getByTestId("workflow-properties-panel");
    await expect(panel).toContainText("AI Agent");

    // Empty instruction surfaces the inline (non-blocking) required error.
    const instruction = panel.locator('textarea[id$="-instruction"]');
    await expect(instruction).toBeVisible();
    await expect(panel.getByText("Instruction is required")).toBeVisible();

    // An invalid custom agent name surfaces the pattern error inline too.
    await panel.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: "Custom agent..." }).click();
    const agentInput = page.getByLabel("Custom agent name");
    await agentInput.fill("bad_name");
    await agentInput.blur();
    await expect(
      panel.getByText("Agent name must match ^[A-Za-z0-9-]+$"),
    ).toBeVisible();

    // Validation is advisory: Save stays enabled and PUTs anyway.
    const saveButton = page.getByRole("button", { name: "Save" });
    await expect(saveButton).toBeEnabled();
    const putDone = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/workflows/${WORKFLOW_ID}`) &&
        response.request().method() === "PUT" &&
        response.status() === 422,
    );
    await saveButton.click();
    await putDone;

    // The PUT body carries the invalid agent name (nothing blocked it).
    const putBody = api.getSavedPutBody() as {
      definition: { nodes: MockNode[] };
    };
    const aiNode = putBody.definition.nodes.find(
      (node) => node.type === "ai:llm_agent",
    );
    expect(aiNode).toBeTruthy();
    expect(aiNode!.agent_name).toBe("bad_name");
    expect(aiNode!.params.instruction).toBe("");

    // Error strip surfaces the parsed message with the validation prefix.
    const errorList = page.getByTestId("workflow-error-list");
    await expect(errorList).toBeVisible();
    await expect(errorList).toContainText("Validation failed: ");
    await expect(
      errorList.locator(`[data-error-id="${aiNode!.id}"]`),
    ).toContainText(`node '${aiNode!.id}'`);

    // The referenced node carries the error highlight.
    await expect(
      page.locator(
        `.react-flow__node[data-id="${aiNode!.id}"] [data-error="true"]`,
      ),
    ).toBeVisible();
    await expect(page.locator('[data-error="true"]')).toHaveCount(1);
    await expect(
      page.locator(".react-flow[data-error-node-count]"),
    ).toHaveAttribute("data-error-node-count", "1");
  });
});
