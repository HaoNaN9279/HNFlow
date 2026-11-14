/**
 * Client bundle contract: the loader factory, the keyed slot registrations and
 * the pure layout helpers. No browser is involved — a minimal React stand-in is
 * enough to prove the registration shape.
 *
 * The module id is part of the contract: the Cordis Loader imports the module
 * named after the package (`dsh-hnflow`), so a factory under another id is
 * stored and never materialized. The capability surface used to live under
 * `dsh-capability` and silently disappeared from every page.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Minimal React/react-dom stand-ins (the bundle never renders here). */
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  Component: class Component {
    constructor(props) {
      this.props = props;
    }
  },
};
const reactDom = { createPortal: (node) => node };

/** Every loader registration the bundle performs. */
const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      registrations.push(spec);
    },
  },
};
globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await import("../client.js?contract-test");

/**
 * Build the bundle as the loader would.
 * @returns {Record<string, any>} module exports.
 */
function loadBundle() {
  assert.equal(registrations.length, 1, "the bundle must call __ModuleLoader__.load exactly once");
  return registrations[0].factory((name) => {
    if (name === "react") return react;
    if (name === "react-dom") return reactDom;
    throw new Error(`unexpected module ${name}`);
  });
}

/**
 * Apply the bundle to a fake client context.
 * @param {{fetch?: Function}} [options] - fetch stand-in for the host routes.
 * @returns {{entries: Record<string, any>[], exports: Record<string, any>, injected: string[]}} registrations.
 */
function applyBundle(options = {}) {
  if (options.fetch !== undefined) globalThis.fetch = options.fetch;
  const exports = loadBundle();
  /** @type {Record<string, any>[]} */
  const entries = [];
  /** @type {string[]} */
  const injected = [];
  const ctx = {
    slots: {
      inject: (name, callback) => {
        injected.push(name);
        callback();
      },
      register: (entry, component) => {
        entries.push({ entry, component });
      },
    },
    inject: (deps, callback) =>
      callback(
        Array.isArray(deps) && deps.includes("modelDirectories")
          ? {
              slots: ctx.slots,
              modelDirectories: {
                directoryFor: () => ({
                  store: {},
                  load: async () => {},
                  select: async () => {},
                }),
              },
              sessions: { subagentAddress: () => undefined },
            }
          : {},
      ),
    effect: () => {},
    // The capability surface reads the live session list to learn the workspace
    // a blank window belongs to; the real client exposes it as `ctx.sessions`.
    sessions: {
      list: {
        getSnapshot: () => ({
          ids: ["session-1"],
          byId: { "session-1": { sessionId: "session-1", cwd: "D:/workspace/HNFlow" } },
          phase: "ready",
        }),
        subscribe: () => () => {},
      },
      subagentAddress: () => undefined,
    },
  };
  exports.apply(ctx);
  return { entries, exports, injected };
}

/** Registered `slot:id-or-key` names, for readable assertions. */
function entryNames(entries) {
  return entries.map((entry) => `${entry.entry.name}:${entry.entry.id ?? entry.entry.key}`);
}

test("the bundle registers one factory under the package name", () => {
  assert.equal(registrations.length, 1, "the Loader materializes one module per package");
  assert.equal(
    registrations[0].id,
    manifest.name,
    `the factory id must equal the package name (${manifest.name}) or the Loader never imports it`,
  );
  assert.equal(manifest.dsh.client.immediately, true, "the page boots the client half without an importer");
});

test("the bundle registers the sidebar entry, the page and the notice", () => {
  const { entries, injected } = applyBundle();
  assert.ok(injected.includes("sidebar.panellist"));
  assert.ok(injected.includes("main"));
  assert.ok(injected.includes("shell.overlay"));
  const names = entryNames(entries);
  assert.ok(names.includes("sidebar.panellist:hnflow"));
  assert.ok(names.includes("main:hnflow"));
  assert.ok(names.includes("shell.overlay:hnflow.notice"));
});

test("the bundle registers the capability surface in the composer", () => {
  const { entries } = applyBundle();
  const names = entryNames(entries);
  assert.ok(names.includes("conversation.input.left:capability-agent"), "the agent picker is missing");
  assert.ok(names.includes("conversation.input.left:capability-inventory"), "the context preview is missing");
  assert.ok(names.includes("settings.section:capability-models"), "the model-layer settings page is missing");
});

test("the model-layer control replaces the right-hand model seat", () => {
  const { entries } = applyBundle();
  const names = entryNames(entries);
  const seat = entries.find((entry) => entry.entry.name === "conversation.input.model");
  assert.ok(seat, "the model seat replacement is missing");
  assert.equal(seat.entry.priority, -1, "the replacement must outrank the native seat");
  assert.ok(
    !names.includes("conversation.input.left:capability-layer"),
    "the layer picker must not share the left strip with the Agent picker",
  );
});

test("the bundle exposes pure layout helpers", () => {
  const { exports } = applyBundle();
  const flow = {
    nodes: [
      { id: "a", type: "agent" },
      { id: "b", type: "gate" },
    ],
    edges: [{ id: "e1", from: "a", to: "b" }],
  };
  const layout = exports.internals.layoutFlow(flow);
  assert.equal(layout.nodes.length, 2);
  assert.equal(layout.edges.length, 1);
  assert.match(layout.edges[0].path, /^M /u);
  assert.equal(exports.internals.layoutFlow({}).nodes.length, 0);
  assert.deepEqual([...exports.internals.nodeStatuses({ nodes: [{ id: "a", status: "done" }] })], [["a", "done"]]);
  assert.equal(exports.internals.shortPath("D:\\work\\demo"), "work/demo");
  assert.equal(exports.internals.runLabel({ flowName: "f", status: "succeeded" }), "f · succeeded");
  assert.equal(exports.internals.rightTabDefinition().kind, "hnflow.inbox");
});

test("the client injects every service the two halves read", () => {
  const { exports } = applyBundle();
  assert.deepEqual(
    [...exports.inject].sort(),
    ["remote", "remote.commands", "remote.session", "sessions", "slots"],
  );
});

test("the left-strip controls receive the workspace-aware sessions service", () => {
  const { entries } = applyBundle();
  const picker = entries.find((entry) => entry.entry.id === "capability-agent");
  const preview = entries.find((entry) => entry.entry.id === "capability-inventory");
  assert.ok(picker, "the agent picker is missing");
  assert.ok(preview, "the context preview is missing");
  const props = picker.entry.inject("session-1");
  assert.equal(props.sessionId, "session-1");
  assert.equal(typeof props.sessionsService?.list?.getSnapshot, "function");
  assert.equal(preview.entry.inject("session-1").sessionsService, props.sessionsService);
});
