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
 * @param {{fetch?: Function, mode?: string|null, currentSession?: string}} [options] - host-route stand-in, the agent preset of the displayed session, and its id.
 * @returns {{entries: Record<string, any>[], exports: Record<string, any>, injected: string[], menus: Record<string, any>[], setMode: (mode: string|null) => void}} registrations.
 */
function applyBundle(options = {}) {
  if (options.fetch !== undefined) globalThis.fetch = options.fetch;
  const exports = loadBundle();
  /** @type {Record<string, any>[]} */
  const entries = [];
  /** @type {string[]} */
  const injected = [];
  /** @type {Record<string, any>[]} */
  const menus = [];
  const currentSession = options.currentSession ?? "session-1";
  // The session's own agent-preset projection: the live source the standard
  // `useProjection` hook and this bundle both read.
  const mode = {
    value: options.mode ?? null,
    listeners: new Set(),
    face: {
      getSnapshot: () => mode.value,
      subscribe: (listener) => {
        mode.listeners.add(listener);
        return () => {
          mode.listeners.delete(listener);
        };
      },
    },
    set: (next) => {
      mode.value = next;
      for (const listener of [...mode.listeners]) listener(next);
    },
  };
  const ctx = {
    slots: {
      inject: (name, callback) => {
        injected.push(name);
        const start = entries.length;
        callback();
        const added = entries.slice(start);
        return () => {
          for (const entry of added) {
            const index = entries.indexOf(entry);
            if (index >= 0) entries.splice(index, 1);
          }
        };
      },
      register: (entry, component) => {
        entries.push({ entry, component });
      },
    },
    inject: (deps, callback) =>
      callback({
        slots: ctx.slots,
        contextMenus: {
          register: (contribution) => {
            menus.push(contribution);
            return () => {};
          },
        },
        modelDirectories: {
          directoryFor: () => ({
            store: {},
            load: async () => {},
            select: async () => {},
          }),
        },
        sessions: {
          subagentAddress: () => undefined,
          binding: (sessionId) =>
            sessionId === currentSession
              ? { session: { projections: { faceOf: (key) => (key === "agentPreset" ? mode.face : undefined) } } }
              : undefined,
        },
        uiSession: {
          adapter: {
            current: {
              getSnapshot: () => ({ key: currentSession }),
              subscribe: () => () => {},
            },
          },
        },
      }),
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
  return { entries, exports, injected, menus, setMode: mode.set };
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
  assert.ok(
    names.includes("conversation.input.left:capability-workspace-groups"),
    "the workspace-group button is missing",
  );
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

test("the bundle registers the capability-group window on the overlay", () => {
  const { entries } = applyBundle();
  assert.ok(
    entryNames(entries).includes("shell.overlay:capability-groups-window"),
    "the workspace capability-group window is missing",
  );
});

test("the workspace menu no longer carries the capability-group entry", () => {
  const { menus } = applyBundle();
  assert.equal(menus.length, 0, "the entry moved to the session strip; the workspace menu must stay untouched");
});

test("the session strip opens the window for that session's workspace", () => {
  const { entries, exports } = applyBundle();
  const control = entries.find((entry) => entry.entry.id === "capability-workspace-groups");
  assert.ok(control, "the workspace-group button is missing");
  const props = control.entry.inject("session-1");
  assert.equal(props.sessionId, "session-1");
  assert.equal(typeof props.sessionsService?.list?.getSnapshot, "function");
  const element = control.component({ ...props, useProjection: () => "hnflow" });
  assert.equal(element.type, "button");
  assert.equal(element.children[0], "⚙");
  assert.match(element.props.title, /工作区能力组/u);
  element.props.onClick();
  const state = exports.internals.groupsWindow.snapshot();
  assert.equal(state.open, true);
  assert.equal(state.workspace, "D:/workspace/HNFlow");
  assert.equal(state.title, "HNFlow");
});

test("the workspace-group button belongs to the HNFlow mode only", () => {
  const { entries } = applyBundle();
  const control = entries.find((entry) => entry.entry.id === "capability-workspace-groups");
  const props = control.entry.inject("session-1");
  assert.equal(
    control.component({ ...props, useProjection: () => "cordis" }),
    null,
    "the strip of every other mode must stay untouched",
  );
  assert.equal(control.component({ ...props, useProjection: () => null }), null, "an unknown mode shows no button");
  assert.equal(control.component({ ...props, useProjection: () => "hnflow" }).type, "button");
});

test("the workspace record outranks the session cwd", () => {
  const { entries, exports } = applyBundle();
  const control = entries.find((entry) => entry.entry.id === "capability-workspace-groups");
  const element = control.component({
    ...control.entry.inject("session-1"),
    useProjection: () => "hnflow",
    // A session whose cwd is a subdirectory still switches groups on the
    // workspace root, which is where `.hnflow/stack.json` lives.
    useSessions: () => ({
      ids: ["session-1"],
      byId: { "session-1": { sessionId: "session-1", cwd: "D:\\workspace\\HNFlow\\plugins\\dsh" } },
    }),
    useWorkspaces: () => ({
      items: [{ workspaceId: "w1", path: "D:/workspace/HNFlow", sessionIds: ["session-1"] }],
    }),
  });
  element.props.onClick();
  assert.equal(exports.internals.groupsWindow.snapshot().workspace, "D:/workspace/HNFlow");
});

test("the session tab exists only while the displayed session is HNFlow's", () => {
  const bundle = applyBundle({ mode: "hnflow" });
  const hasTab = () => entryNames(bundle.entries).includes("conversation.view:hnflow");
  assert.ok(hasTab(), "an HNFlow session must carry the tab");
  bundle.setMode("cordis");
  assert.ok(!hasTab(), "switching the mode away must remove the tab");
  bundle.setMode("hnflow");
  assert.ok(hasTab(), "switching the mode back must restore the tab");
});

test("a session outside the HNFlow mode never registers the tab", () => {
  const { entries } = applyBundle({ mode: "cordis" });
  assert.ok(!entryNames(entries).includes("conversation.view:hnflow"));
  const unknown = applyBundle();
  assert.ok(!entryNames(unknown.entries).includes("conversation.view:hnflow"), "an unknown preset shows no tab");
});
