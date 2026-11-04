// HNFlow browser half for DeepSeek Harness.
//
// Shipped as a prebuilt client bundle: a factory registered on the module
// loader. Only React and react-dom (platform-seeded modules) are required, so no
// build step is involved.
//
// Surfaces (docs/dsh-plugin-plan.md §11.4):
//
// - a left-sidebar page (`sidebar.panellist` + the keyed `main` slot) with three
//   tabs: 工作区 / 通用工作流 / 任务监视;
// - one shared left-tree + right-canvas layout, so the session tab (M6.4) and
//   the task panel (M6.5) can reuse the same components.
//
// The client never reads asset files and never talks to the engine: every piece
// of data and every write goes through `/workflow ui <op> <base64url>` (or a
// plain `/workflow` command), so the page obeys exactly the same rules as typing
// the command by hand.
window.__ModuleLoader__.load({
  id: "dsh-hnflow",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const reactDom = require("react-dom");
    const h = react.createElement;

    /** Services this client plugin consumes directly. */
    const inject = ["slots", "remote", "remote.commands"];

    /** Sidebar entry id; also the `main` panel key (the layout pairs them). */
    const PANEL_ID = "hnflow";

    /** Agent preset that owns the session tab (M6.4). */
    const PRESET_ID = "hnflow";

    /** Read-only canvas geometry. Mirrors the editor's grid fallback. */
    const CANVAS = { columns: 3, stepX: 220, stepY: 130, width: 170, height: 62, padding: 16 };

    const TABS = [
      { id: "workspaces", label: "工作区" },
      { id: "assets", label: "通用工作流" },
      { id: "monitor", label: "任务监视" },
    ];

    const styles = {
      page: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", fontFamily: "var(--dsw-font-sans, inherit)", color: "var(--dsw-alias-label-primary, inherit)" },
      tabbar: { display: "flex", alignItems: "center", gap: "4px", padding: "10px 14px", borderBottom: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.18))" },
      tab: { padding: "4px 10px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "1px solid transparent", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", fontFamily: "inherit", fontSize: "13px", cursor: "pointer" },
      tabActive: { borderColor: "var(--dsw-alias-border-l1, rgba(127,127,127,0.28))", background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))", color: "var(--dsw-alias-label-primary, inherit)" },
      body: { flex: "1 1 auto", minHeight: 0, display: "flex" },
      tree: { width: "280px", flex: "0 0 280px", minHeight: 0, overflow: "auto", padding: "8px", borderRight: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.18))", boxSizing: "border-box" },
      group: { margin: "0 0 6px" },
      groupTitle: { display: "flex", alignItems: "center", gap: "6px", width: "100%", padding: "4px 6px", border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", fontFamily: "inherit", fontSize: "12px", textAlign: "left", cursor: "pointer" },
      item: { display: "flex", flexDirection: "column", gap: "1px", width: "100%", padding: "5px 8px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "none", background: "transparent", color: "var(--dsw-alias-label-primary, inherit)", fontFamily: "inherit", fontSize: "12px", textAlign: "left", cursor: "pointer" },
      itemActive: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))" },
      meta: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)" },
      canvasPane: { flex: "1 1 auto", minWidth: 0, minHeight: 0, overflow: "auto", padding: "14px", boxSizing: "border-box" },
      canvas: { width: "100%", height: "100%", minHeight: "240px", display: "block", borderRadius: "var(--dsw-radius-sm, 6px)", background: "rgba(127,127,127,0.06)" },
      node: { fill: "rgba(127,127,127,0.14)", stroke: "rgba(127,127,127,0.45)", strokeWidth: 1 },
      nodeLabel: { fontSize: "9px", fill: "currentColor", pointerEvents: "none" },
      edge: { stroke: "rgba(127,127,127,0.55)", strokeWidth: 1.2, fill: "none" },
      empty: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", minHeight: "200px", color: "var(--dsw-alias-label-tertiary, inherit)", fontSize: "12px" },
      errorBox: { margin: "10px 14px", padding: "8px 10px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))", color: "var(--dsw-alias-label-danger, #e5534b)", fontSize: "12px", whiteSpace: "pre-wrap" },
      board: { flex: "1 1 auto", minWidth: 0, minHeight: 0, overflow: "auto", padding: "12px 14px", boxSizing: "border-box" },
      boardTitle: { margin: "10px 0 6px", fontSize: "13px", fontWeight: 600 },
      row: { display: "flex", alignItems: "baseline", gap: "10px", padding: "4px 6px", borderRadius: "var(--dsw-radius-sm, 6px)", fontSize: "12px" },
      cell: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    };

    /**
     * Read the model-facing text out of a command result.
     * @param {unknown} result - `remote.commands.execute` result.
     * @returns {string} display text.
     */
    function readText(result) {
      if (result === null || typeof result !== "object") return String(result ?? "");
      for (const key of ["text", "output", "message"]) {
        const value = result[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
      if (result.value !== undefined) return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
      return JSON.stringify(result);
    }

    /**
     * base64url-encode a `/workflow ui` payload (the host decodes it).
     * @param {unknown} value - payload.
     * @returns {string} encoded text without padding.
     */
    function encodePayload(value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value ?? {}));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    }

    /**
     * Parse a JSON payload returned by the host.
     * @param {string} text - command text.
     * @returns {Record<string, any> | null} parsed object, or null.
     */
    function parseJson(text) {
      try {
        const parsed = JSON.parse(String(text ?? ""));
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    /**
     * Map a Workspace store snapshot to the `{id, name, path}` list the tree needs.
     * @param {unknown} snapshot - `ctx.workspaces.list.getSnapshot()` value.
     * @returns {{id: string, name: string, path: string}[]} workspaces with a path.
     */
    function workspaceItems(snapshot) {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      /** @type {{id: string, name: string, path: string}[]} */
      const out = [];
      for (const item of items) {
        const path = typeof item?.path === "string" ? item.path : "";
        if (path.length === 0) continue;
        const id = typeof item.workspaceId === "string" ? item.workspaceId : typeof item.id === "string" ? item.id : path;
        const name = typeof item.title === "string" && item.title.length > 0 ? item.title : path;
        out.push({ id, name, path });
      }
      return out;
    }

    /**
     * Place a definition's nodes on a canvas.
     *
     * Stored `metadata.canvas.positions` wins; otherwise the editor's grid
     * fallback (three columns) keeps the picture stable across renders.
     * @param {Record<string, any> | null} definition - workflow definition.
     * @returns {{nodes: Record<string, any>[], edges: Record<string, any>[], width: number, height: number}} layout.
     */
    function layoutDefinition(definition) {
      const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
      const edges = Array.isArray(definition?.edges) ? definition.edges : [];
      const stored = definition?.metadata?.canvas?.positions ?? {};
      /** @type {Map<string, Record<string, any>>} */
      const placed = new Map();
      nodes.forEach((node, index) => {
        const position = stored[node.id];
        const x = Number.isFinite(position?.x) ? position.x : (index % CANVAS.columns) * CANVAS.stepX;
        const y = Number.isFinite(position?.y) ? position.y : Math.floor(index / CANVAS.columns) * CANVAS.stepY;
        placed.set(node.id, {
          id: String(node.id),
          type: String(node.type ?? ""),
          x: x * 0.55 + CANVAS.padding,
          y: y * 0.34 + CANVAS.padding,
          width: CANVAS.width,
          height: CANVAS.height,
        });
      });
      const laid = [...placed.values()];
      const width = Math.max(...laid.map((node) => node.x + node.width), CANVAS.width) + CANVAS.padding;
      const height = Math.max(...laid.map((node) => node.y + node.height), CANVAS.height) + CANVAS.padding;
      const drawn = edges
        .filter((edge) => placed.has(edge.source) && placed.has(edge.target))
        .map((edge, index) => ({
          id: `${edge.source}:${edge.source_port}->${edge.target}:${edge.target_port}:${index}`,
          from: edge.source,
          to: edge.target,
          path: edgePath(placed.get(edge.source), placed.get(edge.target)),
        }));
      return { nodes: laid, edges: drawn, width, height };
    }

    /**
     * Draw a left-to-right curve between two node boxes.
     * @param {Record<string, any>} from - source box.
     * @param {Record<string, any>} to - target box.
     * @returns {string} SVG path data.
     */
    function edgePath(from, to) {
      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      const y2 = to.y + to.height / 2;
      const bend = Math.max(24, Math.abs(x2 - x1) / 2);
      return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    }

    /**
     * Whether the session runs the HNFlow preset.
     *
     * The `agentPreset` projection is the preset id as a plain string; an older
     * shape carried `{ id }`. An absent projection means "not known yet".
     * @param {unknown} preset - projection value.
     * @returns {boolean} true when the session tab belongs to this session.
     */
    function isHnflowPreset(preset) {
      if (preset === null || preset === undefined) return true;
      if (typeof preset === "string") return preset === PRESET_ID;
      if (typeof preset === "object" && typeof preset.id === "string") return preset.id === PRESET_ID;
      return true;
    }

    /**
     * Resolve once, or after a timeout, with whatever the injection produced.
     * @param {function(function(any): void): void} start - begins an async probe.
     * @param {number} waitMs - fallback delay.
     * @returns {Promise<any>} the first answer.
     */
    function firstAnswer(start, waitMs = 2000) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        try {
          start(done);
        } catch {
          done(undefined);
        }
        setTimeout(() => done(undefined), waitMs);
      });
    }

    /**
     * The workspace list from the client store.
     * @param {Record<string, any>} ctx - client context.
     * @returns {Promise<{id: string, name: string, path: string}[]>} workspaces.
     */
    function listWorkspaces(ctx) {
      return firstAnswer((done) => {
        ctx.inject(["workspaces"], (scope) => {
          try {
            done(workspaceItems(scope.workspaces?.list?.getSnapshot?.()));
          } catch {
            done([]);
          }
        });
      }, 3000).then((value) => (Array.isArray(value) ? value : []));
    }

    /**
     * The session id a global surface must name to run a command.
     *
     * `execute(undefined, …)` reports ok without running anything, so a real id
     * is required (plan §14.2 M6.0 result).
     * @param {Record<string, any>} ctx - client context.
     * @returns {Promise<string | null>} current session id, or the first listed one.
     */
    function commandTarget(ctx) {
      return firstAnswer((done) => {
        ctx.inject(["uiSession", "sessions"], (scope) => {
          try {
            const current = scope.uiSession?.adapter?.current?.getSnapshot?.();
            if (current && typeof current.key === "string") return done(current.key);
            const list = scope.sessions?.list?.getSnapshot?.();
            if (Array.isArray(list?.ids) && list.ids.length > 0) return done(list.ids[0]);
          } catch {
            // fall through to "no session"
          }
          done(null);
        });
      }).then((value) => (typeof value === "string" ? value : null));
    }

    /**
     * Run one `/workflow ui` op and parse its JSON answer.
     * @param {Record<string, any>} ctx - client context.
     * @param {string} op - one of tree / canvas / assetCanvas / monitor.
     * @param {Record<string, any>} payload - op arguments.
     * @returns {Promise<Record<string, any> | null>} parsed payload (null when unreadable).
     */
    async function runUi(ctx, op, payload) {
      const sessionId = await commandTarget(ctx);
      const line = `/workflow ui ${op} ${encodePayload(payload)}`;
      /** @type {unknown} */
      let lastError = null;
      for (const id of sessionId === null ? [undefined] : [sessionId, undefined]) {
        try {
          const result = await ctx.remote.commands.execute(id, line, []);
          if (result && result.ok === false) {
            const code = result.error && result.error.code ? result.error.code : "command-failed";
            const message = result.error && result.error.message ? result.error.message : "";
            lastError = new Error(`hnflow: ${code}: ${message}`);
            continue;
          }
          return parseJson(readText(result));
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("hnflow: no session available to run a command");
    }

    /**
     * The sidebar glyph.
     * @param {{size?: number}} props - glyph size from the sidebar.
     * @returns {unknown} element.
     */
    function HnflowIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 18;
      return h("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.6)}px` }, "aria-hidden": "true" }, "\u25C6");
    }

    /**
     * The right-hand canvas, or the empty state when nothing is selected.
     * @param {{canvas: Record<string, any> | null}} props - resolved canvas payload.
     * @returns {unknown} element.
     */
    function CanvasStage(props) {
      const canvas = props?.canvas ?? null;
      if (canvas === null || canvas.definition === undefined) return h("div", { style: styles.empty }, "选择左侧的工作流查看画布");
      const layout = layoutDefinition(canvas.definition);
      return h(
        "div",
        { style: styles.canvasPane },
        h("div", { style: { ...styles.meta, padding: "0 0 8px" } }, `${canvas.assetName || canvas.alias || canvas.key} · ${canvas.source} · r${canvas.revision ?? "?"}/${canvas.currentRevision ?? "?"}${canvas.drift ? " · 漂移" : ""}`),
        h(
          "svg",
          { viewBox: `0 0 ${layout.width} ${layout.height}`, style: styles.canvas, role: "img", "aria-label": "workflow canvas" },
          ...layout.edges.map((edge) => h("path", { key: edge.id, d: edge.path, style: styles.edge })),
          ...layout.nodes.map((node) =>
            h("g", { key: node.id }, [
              h("rect", { key: "r", x: node.x, y: node.y, width: node.width, height: node.height, rx: 8, style: styles.node }),
              h("text", { key: "t", x: node.x + 8, y: node.y + 20, style: styles.nodeLabel }, node.id),
              h("text", { key: "ty", x: node.x + 8, y: node.y + 36, style: styles.nodeLabel }, node.type),
            ]),
          ),
        ),
      );
    }

    /**
     * The monitor board: every run on top, the pending tasks below.
     * @param {{monitor: Record<string, any> | null}} props - monitor payload.
     * @returns {unknown} element.
     */
    function TaskBoard(props) {
      const monitor = props?.monitor ?? null;
      if (monitor === null) return h("div", { style: styles.empty }, "读取任务状态…");
      const runs = Array.isArray(monitor.runs) ? monitor.runs : [];
      const tasks = Array.isArray(monitor.tasks) ? monitor.tasks : [];
      const counts = runs.reduce((acc, run) => {
        acc[run.status] = (acc[run.status] ?? 0) + 1;
        return acc;
      }, /** @type {Record<string, number>} */ ({}));
      return h(
        "div",
        { style: styles.board },
        h("div", { style: styles.meta }, `${runs.length} 次执行 · ${Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(" · ") || "无"}`),
        h("div", { style: styles.boardTitle }, "全部执行"),
        runs.length === 0
          ? h("div", { style: styles.meta }, "还没有执行记录")
          : h(
              "div",
              null,
              ...runs.map((run) =>
                h("div", { key: run.runId, style: styles.row }, [
                  h("span", { key: "w", style: { ...styles.cell, flex: "0 0 140px" } }, shortPath(run.workspace)),
                  h("span", { key: "s", style: { ...styles.cell, flex: "0 0 120px" } }, shortSession(run.sessionId)),
                  h("span", { key: "f", style: { ...styles.cell, flex: "1 1 auto" } }, run.workflow ?? "—"),
                  h("span", { key: "t", style: { ...styles.cell, flex: "0 0 120px" } }, run.status),
                  h("span", { key: "n", style: { ...styles.cell, flex: "0 0 120px" } }, run.node ?? "—"),
                ]),
              ),
            ),
        h("div", { style: styles.boardTitle }, `需要你处理（${tasks.length}）`),
        tasks.length === 0
          ? h("div", { style: styles.meta }, "没有待处理的任务")
          : h(
              "div",
              null,
              ...tasks.map((task) =>
                h("div", { key: task.taskId, style: styles.row }, [
                  h("span", { key: "w", style: { ...styles.cell, flex: "0 0 140px" } }, shortPath(task.workspace)),
                  h("span", { key: "s", style: { ...styles.cell, flex: "0 0 120px" } }, shortSession(task.sessionId)),
                  h("span", { key: "k", style: { ...styles.cell, flex: "0 0 80px" } }, task.kind),
                  h("span", { key: "d", style: { ...styles.cell, flex: "1 1 auto" } }, task.description || task.nodeId),
                  h("span", { key: "id", style: { ...styles.cell, flex: "0 0 160px" } }, task.taskId),
                ]),
              ),
            ),
      );
    }

    /**
     * Last two path segments, for a compact workspace label.
     * @param {string | null} value - absolute path.
     * @returns {string} short label.
     */
    function shortPath(value) {
      if (typeof value !== "string" || value.length === 0) return "—";
      const parts = value.split(/[\\/]+/u).filter((part) => part.length > 0);
      return parts.slice(-2).join("/");
    }

    /**
     * Compact session label (the id tail).
     * @param {string | null} value - session id.
     * @returns {string} short label.
     */
    function shortSession(value) {
      if (typeof value !== "string" || value.length === 0) return "—";
      return value.length <= 14 ? value : `…${value.slice(-12)}`;
    }

    /**
     * The HNFlow page: three tabs over one tree+canvas layout.
     * @param {{runUi: (op: string, payload: Record<string, any>) => Promise<Record<string, any> | null>}} props - injected command face.
     * @returns {unknown} element.
     */
    function HnflowPage(props) {
      const runUi = props?.runUi;
      const [tab, setTab] = react.useState("workspaces");
      const [tree, setTree] = react.useState(null);
      const [canvas, setCanvas] = react.useState(null);
      const [monitor, setMonitor] = react.useState(null);
      const [error, setError] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [selected, setSelected] = react.useState("");

      /**
       * Load the left tree (workspaces + library).
       * @returns {Promise<void>} resolves once rendered.
       */
      const loadTree = async () => {
        setBusy(true);
        try {
          const workspaces = await listWorkspaces(props.ctx);
          const payload = await runUi("tree", { workspaces });
          setTree(payload);
          setError(payload === null ? "tree payload unreadable" : "");
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Load the monitor board.
       * @returns {Promise<void>} resolves once rendered.
       */
      const loadMonitor = async () => {
        setBusy(true);
        try {
          const payload = await runUi("monitor", {});
          setMonitor(payload);
          setError(payload === null ? "monitor payload unreadable" : "");
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Select one workflow and draw it.
       * @param {string} workspace - workspace root.
       * @param {Record<string, any>} entry - ref entry from the tree.
       * @returns {Promise<void>} resolves once drawn.
       */
      const pickWorkflow = async (workspace, entry) => {
        const key = entry.alias || entry.assetId;
        setSelected(`w:${workspace}:${key}`);
        setBusy(true);
        try {
          const payload = await runUi("canvas", { workspace, key });
          setCanvas(payload);
          setError(payload === null ? "canvas payload unreadable" : "");
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Select one library asset and draw it.
       * @param {Record<string, any>} asset - asset summary.
       * @returns {Promise<void>} resolves once drawn.
       */
      const pickAsset = async (asset) => {
        setSelected(`a:${asset.id}`);
        setBusy(true);
        try {
          const payload = await runUi("assetCanvas", { assetId: asset.id });
          setCanvas(payload);
          setError(payload === null ? "asset canvas unreadable" : "");
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      };

      react.useEffect(() => {
        void loadTree();
      }, []);

      react.useEffect(() => {
        if (tab === "monitor" && monitor === null) void loadMonitor();
      }, [tab]);

      const workspaces = Array.isArray(tree?.workspaces) ? tree.workspaces : [];
      const assets = Array.isArray(tree?.assets) ? tree.assets : [];

      const left =
        tab === "workspaces"
          ? h(
              "div",
              { style: styles.tree },
              workspaces.length === 0 ? h("div", { style: styles.meta }, "还没有工作区") : null,
              ...workspaces.map((workspace) =>
                h(
                  "div",
                  { key: workspace.path, style: styles.group },
                  h("div", { style: styles.groupTitle }, `${workspace.name}${workspace.error ? " · 读取失败" : ""}`),
                  ...(workspace.workflows ?? []).map((entry) =>
                    h(
                      "button",
                      {
                        type: "button",
                        key: `${workspace.path}:${entry.alias || entry.assetId}`,
                        style: selected === `w:${workspace.path}:${entry.alias || entry.assetId}` ? { ...styles.item, ...styles.itemActive } : styles.item,
                        onClick: () => void pickWorkflow(workspace.path, entry),
                      },
                      h("span", null, `${entry.alias || entry.assetId}${entry.hasOverride ? " ·覆盖" : ""}${entry.drift ? " ·漂移" : ""}${entry.missing ? " ·缺失" : ""}`),
                      h("span", { style: styles.meta }, `${entry.assetId} · r${entry.pinnedRevision ?? "latest"}/${entry.currentRevision ?? "?"}`),
                    ),
                  ),
                  (workspace.workflows ?? []).length === 0 ? h("div", { style: { ...styles.meta, padding: "2px 8px" } }, "没有引用的工作流") : null,
                ),
              ),
            )
          : tab === "assets"
            ? h(
                "div",
                { style: styles.tree },
                assets.length === 0 ? h("div", { style: styles.meta }, "资产库是空的") : null,
                ...assets.map((asset) =>
                  h(
                    "button",
                    {
                      type: "button",
                      key: asset.id,
                      style: selected === `a:${asset.id}` ? { ...styles.item, ...styles.itemActive } : styles.item,
                      onClick: () => void pickAsset(asset),
                    },
                    h("span", null, asset.name || asset.id),
                    h("span", { style: styles.meta }, `${asset.id} · r${asset.revision ?? "?"}`),
                  ),
                ),
              )
            : null;

      const right = tab === "monitor" ? h(TaskBoard, { monitor }) : h(CanvasStage, { canvas });

      return h(
        "div",
        { style: styles.page },
        h(
          "div",
          { style: styles.tabbar, role: "tablist" },
          ...TABS.map((entry) =>
            h(
              "button",
              {
                type: "button",
                key: entry.id,
                role: "tab",
                "aria-selected": tab === entry.id ? "true" : "false",
                style: tab === entry.id ? { ...styles.tab, ...styles.tabActive } : styles.tab,
                onClick: () => setTab(entry.id),
              },
              entry.label,
            ),
          ),
          h("span", { style: { flex: "1 1 auto" } }),
          h("button", { type: "button", style: styles.tab, disabled: busy, onClick: () => (tab === "monitor" ? void loadMonitor() : void loadTree()) }, "刷新"),
        ),
        error.length > 0 ? h("div", { style: styles.errorBox }, error) : null,
        h("div", { style: styles.body }, tab === "monitor" ? null : left, right),
      );
    }

    /** Contexts already wired; a repeated apply must not register a second panel. */
    const wired = new WeakSet();

    /**
     * Client plugin body.
     * @param {Record<string, any>} ctx - client context.
     * @returns {void}
     */
    function apply(ctx) {
      if (wired.has(ctx)) return;
      wired.add(ctx);

      // Sidebar rail entry: the host calls `layout.selectPanel('hnflow')` on click.
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 15, label: () => "HNFlow" }, HnflowIcon));

      // The page itself; the layout key must equal the rail entry id.
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID, inject: () => ({ runUi: (op, payload) => runUi(ctx, op, payload), ctx }) }, HnflowPage),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Pure helpers, exported for the contract tests. */
    exports.internals = { readText, encodePayload, parseJson, workspaceItems, layoutDefinition, edgePath, isHnflowPreset, shortPath, shortSession };
    return module.exports;
  },
});
