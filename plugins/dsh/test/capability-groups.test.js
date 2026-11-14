/**
 * Capability-group catalog plumbing for the workspace window.
 *
 * The window is pure data: the CLI owns the catalog and the activation write,
 * and the routes only forward. These tests pin the argv shape (so a reordered
 * flag cannot silently break the window), the catalog allowlist behind the
 * preview route, and the three request handlers.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findContent, groupsArgs, selectArgs } from "../capability/lib/groups.js";
import {
  GROUPS_PATH,
  GROUPS_SELECT_PATH,
  GROUPS_TEXT_PATH,
  createGroupsRoutes,
  workspaceOf,
} from "../capability/lib/groups-route.js";

/** A workspace directory that exists, for the `workspace` guard. */
const workspace = await mkdtemp(path.join(os.tmpdir(), "hnflow-groups-"));
const contentFile = path.join(workspace, "rule.md");
await writeFile(contentFile, "# Rule\n\nBody.\n", "utf8");

/** Catalog document the CLI stand-in returns. */
const catalog = {
  schema_version: 2,
  project: workspace,
  groups: [
    {
      name: "unity",
      version: "1.0.0",
      description: "Unity 项目能力组",
      source: "repo",
      fixed: false,
      active: true,
      contents: {
        rules: [{ id: "unity/rules/rule.md", name: "rule", kind: "rules", path: contentFile, scope: "global" }],
      },
    },
  ],
};

/** Recorded CLI calls plus the canned stdout. */
function fakeCli() {
  const calls = [];
  const execute = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("groups")) return { stdout: JSON.stringify(catalog), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { calls, execute };
}

/** Route object by path. */
function route(routes, target) {
  const found = routes.find((entry) => entry.path === target);
  assert.ok(found, `route ${target} is missing`);
  return found;
}

test("groups argv keeps the repository pin ahead of the project", () => {
  assert.deepEqual(groupsArgs("D:/work/demo", "D:/work/repo"), [
    "--repo",
    "D:/work/repo",
    "--project",
    "D:/work/demo",
    "groups",
    "--json",
  ]);
  assert.deepEqual(groupsArgs("D:/work/demo", null), ["--project", "D:/work/demo", "groups", "--json"]);
});

test("activation argv turns the boolean into one verb", () => {
  assert.deepEqual(selectArgs("D:/work/demo", null, "activate", "unity"), [
    "--project",
    "D:/work/demo",
    "activate",
    "unity",
  ]);
  assert.deepEqual(selectArgs("D:/work/demo", "D:/work/repo", "deactivate", "blender"), [
    "--repo",
    "D:/work/repo",
    "--project",
    "D:/work/demo",
    "deactivate",
    "blender",
  ]);
});

test("the catalog is the preview allowlist", () => {
  const hit = findContent(catalog, contentFile);
  assert.equal(hit.ok, true);
  assert.equal(hit.item.name, "rule");
  assert.equal(hit.group.name, "unity");
  const miss = findContent(catalog, path.join(workspace, "other.md"));
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /not capability content/u);
  assert.equal(findContent(catalog, "").ok, false);
});

test("workspaceOf rejects relative and missing directories", () => {
  assert.equal(workspaceOf(workspace), path.resolve(workspace));
  assert.equal(workspaceOf("relative/dir"), null);
  assert.equal(workspaceOf(path.join(workspace, "missing")), null);
  assert.equal(workspaceOf(null), null);
});

test("the list route returns the catalog", async () => {
  const { calls, execute } = fakeCli();
  const routes = createGroupsRoutes({ config: {}, execute });
  const response = await route(routes, GROUPS_PATH).fetch(
    new Request(`http://x${GROUPS_PATH}?workspace=${encodeURIComponent(workspace)}`),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.catalog.groups.length, 1);
  assert.ok(calls[0].args.includes("groups"));
});

test("the list route refuses a workspace it cannot prove", async () => {
  const { execute } = fakeCli();
  const routes = createGroupsRoutes({ config: {}, execute });
  const response = await route(routes, GROUPS_PATH).fetch(
    new Request(`http://x${GROUPS_PATH}?workspace=${encodeURIComponent("relative/dir")}`),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "workspace-required");
});

test("the select route writes through the CLI and returns the new catalog", async () => {
  const { calls, execute } = fakeCli();
  const routes = createGroupsRoutes({ config: {}, execute });
  const response = await route(routes, GROUPS_SELECT_PATH).fetch(
    new Request(`http://x${GROUPS_SELECT_PATH}`, {
      method: "POST",
      body: JSON.stringify({ workspace, group: "unity", active: true }),
    }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.catalog.groups[0].active, true);
  const activation = calls.find((call) => call.args.includes("activate"));
  assert.deepEqual(activation.args.slice(-2), ["activate", "unity"]);
});

test("the select route validates the body", async () => {
  const { execute } = fakeCli();
  const routes = createGroupsRoutes({ config: {}, execute });
  const missingActive = await route(routes, GROUPS_SELECT_PATH).fetch(
    new Request(`http://x${GROUPS_SELECT_PATH}`, { method: "POST", body: JSON.stringify({ workspace, group: "unity" }) }),
  );
  assert.equal(missingActive.status, 400);
  assert.equal((await missingActive.json()).code, "active-required");
  const broken = await route(routes, GROUPS_SELECT_PATH).fetch(
    new Request(`http://x${GROUPS_SELECT_PATH}`, { method: "POST", body: "not json" }),
  );
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).code, "invalid-json");
});

test("the text route reads one catalog entry and truncates to the budget", async () => {
  const { execute } = fakeCli();
  const routes = createGroupsRoutes({ config: {}, execute, textBytes: 4 });
  const response = await route(routes, GROUPS_TEXT_PATH).fetch(
    new Request(`http://x${GROUPS_TEXT_PATH}?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(contentFile)}`),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.text, "# Ru");
  assert.equal(payload.truncated, true);
  assert.equal(payload.group, "unity");
  assert.equal(payload.kind, "rules");
});

test("the text route refuses paths the catalog never reported", async () => {
  const { execute } = fakeCli();
  const routes = createGroupsRoutes({ config: {}, execute });
  const response = await route(routes, GROUPS_TEXT_PATH).fetch(
    new Request(`http://x${GROUPS_TEXT_PATH}?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path.join(workspace, "other.md"))}`),
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "unknown-entry");
});
