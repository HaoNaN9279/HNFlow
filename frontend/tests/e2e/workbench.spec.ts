import { expect, test } from "@playwright/test";

const PROJECT_ID = "proj-e2e";
const WORKBENCH_ID = "wb-e2e";
const WORKFLOW_ID = "wf-e2e";

const project = {
  id: PROJECT_ID,
  project_id: PROJECT_ID,
  user_id: "default",
  name: "E2E Project",
  description: "Project fixture",
  root_path: "D:/work/e2e",
  manifest_hash: "hash",
  default_environment: null,
  capability_profile: null,
  roots: [{ id: "main", path: ".", mode: "rw" }],
  mcp_allowlist: [],
  secret_refs: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const workbench = {
  id: WORKBENCH_ID,
  user_id: "default",
  project_id: PROJECT_ID,
  name: "E2E Project",
  description: "Workbench fixture",
  revision: 1,
  layout: { version: 1, cards: [] },
  settings: {},
  member_count: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  members: [
    {
      id: "wbm-1",
      workbench_id: WORKBENCH_ID,
      definition_id: WORKFLOW_ID,
      order_index: 0,
      settings: {},
      created_at: "2026-01-01T00:00:00Z",
      definition_name: "E2E Workflow",
      definition_version: "0.1.0",
      definition_exists: true,
    },
  ],
};

const workflow = {
  id: WORKFLOW_ID,
  user_id: "default",
  name: "E2E Workflow",
  schema_version: 1,
  version: "0.1.0",
  definition: {
    id: WORKFLOW_ID,
    name: "E2E Workflow",
    version: "0.1.0",
    metadata: {},
    nodes: [
      {
        id: "start",
        type: "flow:start",
        inputs: [],
        outputs: [{ name: "out", type: "data" }],
      },
      {
        id: "end",
        type: "flow:end",
        inputs: [{ name: "in", type: "data" }],
        outputs: [],
      },
    ],
    edges: [
      { source: "start", source_port: "out", target: "end", target_port: "in" },
    ],
  },
  metadata: {},
  resolved_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const activeRun = {
  run_id: "run-e2e",
  thread_id: "t-e2e",
  definition_id: WORKFLOW_ID,
  definition_name: "E2E Workflow",
  workbench_id: WORKBENCH_ID,
  workbench_name: "E2E Project",
  project_id: PROJECT_ID,
  status: "running",
  display_state: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  elapsed_seconds: 12,
  current_node: "start",
  completed_nodes: 0,
  total_nodes: 2,
  pending_human_task_count: 0,
  pending_human_task_kinds: [],
  error_excerpt: null,
  workbench_attached: true,
};

test("workbench launches runs and the monitor survives navigation", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 900 });

  await page.route("**/api/projects/proj-e2e/workbenches", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([workbench]),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(workbench),
    });
  });

  await page.route(
    `**/api/projects/proj-e2e/workbenches/${WORKBENCH_ID}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(workbench),
      }),
  );

  await page.route(
    `**/api/projects/proj-e2e/workbenches/${WORKBENCH_ID}/runs`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          run_id: "run-new",
          thread_id: "t-new",
          assistant_id: WORKFLOW_ID,
          status: "pending",
          metadata: { workbench_id: WORKBENCH_ID },
          kwargs: {},
          multitask_strategy: "reject",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        }),
      }),
  );

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([workflow]),
    }),
  );

  await page.route("**/api/workflow-monitor/runs*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [activeRun] }),
    }),
  );

  await page.route("**/api/human-tasks*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );

  await page.goto(`/workspace/projects/proj-e2e/workbenches/${WORKBENCH_ID}`);
  await expect(page.getByTestId(`workbench-card-${WORKFLOW_ID}`)).toContainText(
    "E2E Workflow",
  );
  await expect(page.getByTestId("workbench-card-status")).toHaveAttribute(
    "data-status",
    "running",
  );
  await expect(page.getByTestId("global-workflow-monitor")).toBeVisible();

  await page.route("**/api/projects", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([project]),
    }),
  );

  const runRequest = page.waitForRequest(
    (request) =>
      request
        .url()
        .includes(`/api/projects/proj-e2e/workbenches/${WORKBENCH_ID}/runs`) &&
      request.method() === "POST",
  );
  await page.getByTestId("workbench-run").click();
  expect((await runRequest).postDataJSON()).toMatchObject({
    definition_id: WORKFLOW_ID,
  });

  // Collapse the monitor, switch left-sidebar destinations, and verify the
  // panel itself survived rather than being remounted by the page change.
  await page.getByTestId("workflow-monitor-collapse").click();
  await expect(
    page.getByTestId("global-workflow-monitor-collapsed"),
  ).toBeVisible();
  await page.goto("/workspace/projects");
  await expect(
    page.getByTestId("global-workflow-monitor-collapsed"),
  ).toBeVisible();
});
