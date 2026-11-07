/**
 * Client bundle contract: the loader factory, the keyed slot registrations and
 * the pure layout helpers. No browser is involved — a minimal React stand-in is
 * enough to prove the registration shape.
 */

import assert from "node:assert/strict";
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

/** Capture the loader registration from the bundle. */
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      registration = spec;
    },
  },
};
globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");

await import("../client.js?contract-test");

/**
 * Build the bundle as the loader would.
 * @returns {Record<string, any>} module exports.
 */
function loadBundle() {
  assert.notEqual(registration, null, "the bundle must call __ModuleLoader__.load");
  return registration.factory((name) => {
    if (name === "react") return react;
    if (name === "react-dom") return reactDom;
    throw new Error(`unexpected module ${name}`);
  });
}

/**
 * Apply the bundle to a fake client context.
 * @returns {{entries: Record<string, any>[], exports: Record<string, any>, injected: string[]}} registrations.
 */
function applyBundle() {
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
    inject: (deps, callback) => callback({}),
    effect: () => {},
  };
  exports.apply(ctx);
  return { entries, exports, injected };
}

test("the bundle registers the sidebar entry, the page and the notice", () => {
  const { entries, injected } = applyBundle();
  assert.ok(injected.includes("sidebar.panellist"));
  assert.ok(injected.includes("main"));
  assert.ok(injected.includes("shell.overlay"));
  const names = entries.map((entry) => `${entry.entry.name}:${entry.entry.id ?? entry.entry.key}`);
  assert.ok(names.includes("sidebar.panellist:hnflow"));
  assert.ok(names.includes("main:hnflow"));
  assert.ok(names.includes("shell.overlay:hnflow.notice"));
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

test("the client injects only the slots service", () => {
  const { exports } = applyBundle();
  assert.deepEqual(exports.inject, ["slots"]);
});
