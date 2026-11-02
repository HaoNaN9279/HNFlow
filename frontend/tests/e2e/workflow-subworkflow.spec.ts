import { expect, test, type Page } from "@playwright/test";

type MockNode = {
  id: string;
  type: string;
  inputs: { name: string; type: string; required?: boolean }[];
  outputs: { name: string; type: string; required?: boolean }[];
  params: Record<string, unknown>;
  capability_groups: string[];
  agent_name: string | null;
};

type MockRecord = {
  id: string;
  user_id: string;
  name: string;
  schema_version: number;
  definition: {
    id: string;
    name: string;
    version: string;
    nodes: MockNode[];
    edges: never[];
    metadata: Record<string, unknown>;
  };
  metadata: Record<string, unknown>;
  version: string;
  resolved_at: null;
  created_at: string;
  updated_at: string;
};

function record(
  id: string,
  name: string,
  nodes: MockNode[],
  positions: Record<string, { x: number; y: number }> = {},
): MockRecord {
  return {
    id,
    user_id: "e2e-user",
    name,
    schema_version: 1,
    definition: {
      id,
      name,
      version: "0.1.0",
      nodes,
      edges: [],
      metadata: { canvas: { positions } },
    },
    metadata: {},
    version: "0.1.0",
    resolved_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function childRecord(): MockRecord {
  return record(
    "wf-b",
    "子流程B",
    [
      {
        id: "n_b",
        type: "data:assign",
        inputs: [{ name: "in", type: "data", required: true }],
        outputs: [{ name: "out", type: "data", required: true }],
        params: { value: "original" },
        capability_groups: [],
        agent_name: null,
      },
    ],
    { n_b: { x: 120, y: 120 } },
  );
}

function parentRecord(): MockRecord {
  return record(
    "wf-a",
    "父流程A",
    [
      {
        id: "n_sub",
        type: "nested:subworkflow",
        inputs: [],
        outputs: [],
        params: {
          subworkflow: {
            type: "template",
            mode: "compile",
            template_id: "wf-b",
            version: "0.1.0",
          },
        },
        capability_groups: [],
        agent_name: null,
      },
    ],
    { n_sub: { x: 120, y: 120 } },
  );
}

function mockWorkflows(page: Page) {
  let parent = parentRecord();
  let child = childRecord();
  const parentPuts: Record<string, unknown>[] = [];
  const childPuts: Record<string, unknown>[] = [];

  void page.route("**/api/model-profiles*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ profiles: [] }),
    }),
  );

  void page.route("**/api/workflows/wf-a", (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(parent),
      });
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      parentPuts.push(body);
      const definition = body.definition as MockRecord["definition"];
      const metadata = (body.metadata as Record<string, unknown>) ?? {};
      parent = {
        ...parent,
        definition: { ...definition, metadata },
        metadata,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(parent),
      });
    }
    return route.fallback();
  });

  void page.route("**/api/workflows/wf-b", (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(child),
      });
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      childPuts.push(body);
      const definition = body.definition as MockRecord["definition"];
      const metadata = (body.metadata as Record<string, unknown>) ?? {};
      child = {
        ...child,
        definition: { ...definition, metadata },
        metadata,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(child),
      });
    }
    return route.fallback();
  });

  return {
    parentPuts,
    childPuts,
    child: () => child,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    document.cookie = "locale=zh-CN; path=/; SameSite=Lax";
  });
});

test("template mode saves the shared child workflow", async ({ page }) => {
  test.setTimeout(60_000);
  const api = mockWorkflows(page);
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto("/workspace/workflows/wf-a");
  const header = page.locator("header").first();
  const currentCrumb = page.getByTestId("workflow-breadcrumb-current");
  await expect(currentCrumb).toHaveText("父流程A");

  const subworkflowNode = page.locator('[data-node-type="nested:subworkflow"]');
  await expect(subworkflowNode).toHaveAttribute(
    "data-subworkflow-mode",
    "global",
  );
  await subworkflowNode.getByTestId("workflow-node-open-subworkflow").click();
  await page.waitForURL(/\/workspace\/workflows\/wf-b\?trail=/);
  await expect(currentCrumb).toHaveText("子流程B");

  const childNode = page.locator('[data-node-type="data:assign"]');
  await expect(childNode.getByTestId("workflow-port-output-out")).toHaveText(
    "dataout",
  );
  await childNode.getByTestId("workflow-node-display-name").dblclick();
  const nameInput = childNode.getByTestId("workflow-node-name-input");
  await nameInput.fill("全局修改");
  await nameInput.press("Enter");

  const putDone = page.waitForRequest(
    (request) =>
      request.url().includes("/api/workflows/wf-b") &&
      request.method() === "PUT",
  );
  await page.getByRole("button", { name: "保存" }).click();
  await putDone;

  expect(api.childPuts).toHaveLength(1);
  expect(api.child().metadata).toMatchObject({
    canvas: { labels: { n_b: "全局修改" } },
  });
  expect(api.parentPuts).toHaveLength(0);

  // The parent only references the template, so returning to it needs no save.
  await header.getByRole("link", { name: "父流程A", exact: true }).click();
  await page.waitForURL(/\/workspace\/workflows\/wf-a/);
  await expect(currentCrumb).toHaveText("父流程A");
  await expect(page.getByTestId("workflow-dirty-dot")).toHaveCount(0);
});

test("navigates nested workflows and saves a local subworkflow into its parent", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const api = mockWorkflows(page);
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto("/workspace/workflows/wf-a");
  const header = page.locator("header").first();
  const currentCrumb = page.getByTestId("workflow-breadcrumb-current");

  await expect(currentCrumb).toHaveText("父流程A");
  await expect(header.getByText("工作区", { exact: true })).toBeVisible();
  await expect(
    header.getByRole("link", { name: "工作流", exact: true }),
  ).toHaveAttribute("href", "/workspace/workflows");
  await expect(
    header
      .getByRole("navigation", { name: "breadcrumb" })
      .locator('[data-slot="breadcrumb-separator"]'),
  ).toHaveCount(2);

  const subworkflowNode = page.locator('[data-node-type="nested:subworkflow"]');
  await expect(subworkflowNode).toHaveAttribute(
    "data-subworkflow-mode",
    "global",
  );
  await expect(subworkflowNode).toHaveClass(/border-zinc-400/);
  await expect(
    subworkflowNode.locator("pre").filter({ hasText: "template_id" }),
  ).toHaveCount(0);

  // Open the template child globally.
  await subworkflowNode.getByTestId("workflow-node-open-subworkflow").click();
  await page.waitForURL(/\/workspace\/workflows\/wf-b\?trail=/);
  await expect(currentCrumb).toHaveText("子流程B");
  await expect(
    header.getByRole("link", { name: "父流程A", exact: true }),
  ).toBeVisible();

  // Ancestor breadcrumb returns to A.
  await header.getByRole("link", { name: "父流程A", exact: true }).click();
  await page.waitForURL(/\/workspace\/workflows\/wf-a/);
  await expect(currentCrumb).toHaveText("父流程A");

  // Switch the node to a local snapshot.
  await subworkflowNode.click({ button: "right" });
  await expect(page.getByTestId("workflow-context-menu")).toBeVisible();
  await page.getByTestId("context-menu-subworkflow-local").click();
  await expect(subworkflowNode).toHaveAttribute(
    "data-subworkflow-mode",
    "local",
  );
  await expect(subworkflowNode).toHaveClass(/border-amber-200/);

  // Open the local snapshot, edit it, and save it into the parent draft.
  await subworkflowNode.getByTestId("workflow-node-open-subworkflow").click();
  await page.waitForURL(/localRoot=wf-a/);
  await expect(currentCrumb).toHaveText("子流程B");

  const childNode = page.locator('[data-node-type="data:assign"]');
  await childNode.getByTestId("workflow-node-display-name").dblclick();
  const nameInput = childNode.getByTestId("workflow-node-name-input");
  await nameInput.fill("本地修改");
  await nameInput.press("Enter");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByText("子工作流已保存到父工作流", { exact: true }),
  ).toBeVisible();

  // The local save did not touch the stored child workflow.
  expect(api.childPuts).toHaveLength(0);
  expect(api.child().metadata).toEqual({});

  // Return to A and persist the inline snapshot.
  await header.getByRole("link", { name: "父流程A", exact: true }).click();
  await page.waitForURL(/\/workspace\/workflows\/wf-a/);
  await expect(currentCrumb).toHaveText("父流程A");

  const putDone = page.waitForRequest(
    (request) =>
      request.url().includes("/api/workflows/wf-a") &&
      request.method() === "PUT",
  );
  await page.getByRole("button", { name: "保存" }).click();
  await putDone;

  const body = api.parentPuts.at(-1) as {
    definition: { nodes: MockNode[] };
  };
  const subNode = body.definition.nodes.find((node) => node.id === "n_sub")!;
  const spec = subNode.params.subworkflow as {
    type: string;
    save_mode: string;
    source_template_id: string;
    definition: {
      metadata: { canvas?: { labels?: Record<string, string> } };
    };
  };

  expect(spec.type).toBe("inline");
  expect(spec.save_mode).toBe("local");
  expect(spec.source_template_id).toBe("wf-b");
  expect(spec.definition.metadata.canvas?.labels).toEqual({
    n_b: "本地修改",
  });
});
