// HNFlow browser half for DeepSeek Harness.
//
// Shipped as a prebuilt client bundle: a factory registered on the module
// loader. Only React and react-dom (platform-seeded modules) are required, so no
// build step is involved.
//
// Surfaces (docs/dsh-plugin-plan-v2.md §9):
//
// - a left-sidebar page (`sidebar.panellist` + the keyed `main` slot) with three
//   tabs: 流程 / 运行 / 收件箱;
// - a session tab (`conversation.view`) showing this session's runs and a
//   read-only canvas;
// - a right-sidebar page (`sidebarRightTabs`) with the same inbox;
// - a bottom-right notice for the first sighting of a new inbox item.
//
// Every read goes through the host's Fetch routes (`/api/hnflow/*`), never
// through a slash command: a command would append `command/run` + `command/done`
// to whichever session it named, and the page belongs to no session. Every
// write is an explicit POST with the pending item's revision.
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
    const inject = ["slots"];

    /** Sidebar entry id; also the `main` panel key (the layout pairs them). */
    const PANEL_ID = "hnflow";

    /** Agent preset that owns the session tab. */
    const PRESET_ID = "hnflow";

    /** Read-only canvas geometry. */
    const CANVAS = { columns: 4, stepX: 240, stepY: 140, width: 176, height: 64, padding: 18 };

    const TABS = [
      { id: "flows", label: "流程" },
      { id: "runs", label: "运行" },
      { id: "inbox", label: "收件箱" },
    ];

    const NODE_COLORS = {
      done: "rgba(64,160,110,0.85)",
      running: "rgba(240,170,60,0.9)",
      waiting: "rgba(90,140,240,0.9)",
      failed: "rgba(220,90,90,0.9)",
      blocked: "rgba(150,90,90,0.9)",
      skipped: "rgba(120,120,120,0.6)",
      pending: "rgba(127,127,127,0.55)",
    };

    const styles = {
      page: { height: "100%", minHeight: "320px", boxSizing: "border-box", display: "flex", flexDirection: "column", fontFamily: "var(--dsw-font-sans, inherit)", color: "var(--dsw-alias-label-primary, inherit)" },
      tabbar: { display: "flex", alignItems: "center", gap: "14px", padding: "10px 14px", borderBottom: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.18))" },
      tab: { all: "unset", padding: "2px 0", background: "transparent", color: "inherit", opacity: 0.72, fontFamily: "inherit", fontSize: "13px", fontWeight: 400, lineHeight: "20px", borderBottom: "2px solid transparent", cursor: "pointer" },
      tabActive: { opacity: 1, fontWeight: 600, borderBottomColor: "rgba(110,150,255,0.95)", color: "var(--dsw-alias-label-primary, inherit)" },
      body: { flex: "1 1 auto", minHeight: 0, display: "flex" },
      tree: { flex: "0 0 clamp(190px, 40%, 290px)", minWidth: 0, minHeight: 0, overflow: "auto", padding: "8px", borderRight: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.18))", boxSizing: "border-box" },
      group: { margin: "0 0 8px" },
      groupTitle: { display: "flex", alignItems: "center", gap: "6px", width: "100%", padding: "4px 6px", color: "var(--dsw-alias-label-secondary, inherit)", fontFamily: "inherit", fontSize: "12px", textAlign: "left" },
      item: { display: "flex", flexDirection: "column", gap: "1px", width: "100%", padding: "5px 8px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "none", background: "transparent", backgroundImage: "none", boxShadow: "none", outline: "none", appearance: "none", WebkitAppearance: "none", color: "var(--dsw-alias-label-primary, inherit)", fontFamily: "inherit", fontSize: "12px", textAlign: "left", cursor: "pointer" },
      itemActive: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))" },
      meta: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)" },
      pane: { flex: "1 1 auto", minWidth: 0, minHeight: 0, overflow: "auto", padding: "14px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "10px" },
      canvas: { width: "100%", minHeight: "220px", display: "block", borderRadius: "var(--dsw-radius-sm, 6px)", background: "rgba(127,127,127,0.06)" },
      edge: { stroke: "rgba(127,127,127,0.55)", strokeWidth: 1.2, fill: "none" },
      nodeLabel: { fontSize: "9px", fill: "currentColor", pointerEvents: "none" },
      nodeType: { fontSize: "8px", fill: "currentColor", opacity: 0.7, pointerEvents: "none" },
      empty: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", minHeight: "180px", color: "var(--dsw-alias-label-tertiary, inherit)", fontSize: "12px" },
      errorBox: { margin: "8px 14px", padding: "8px 10px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))", color: "var(--dsw-alias-label-danger, #e5534b)", fontSize: "12px", whiteSpace: "pre-wrap" },
      okBox: { padding: "8px 10px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "1px solid rgba(64,160,110,0.5)", color: "rgba(64,160,110,1)", fontSize: "12px", whiteSpace: "pre-wrap" },
      linkButton: { padding: 0, border: "none", background: "transparent", boxShadow: "none", outline: "none", appearance: "none", WebkitAppearance: "none", color: "var(--dsw-alias-label-secondary, inherit)", fontFamily: "inherit", fontSize: "12px", textDecoration: "underline", cursor: "pointer" },
      button: { all: "unset", padding: "4px 10px", borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))", fontSize: "12px", cursor: "pointer", color: "inherit", fontFamily: "inherit", boxSizing: "border-box" },
      buttonPrimary: { borderColor: "rgba(110,150,255,0.9)", color: "rgba(110,150,255,1)" },
      row: { display: "flex", alignItems: "baseline", gap: "10px", padding: "5px 6px", borderRadius: "var(--dsw-radius-sm, 6px)", fontSize: "12px", cursor: "pointer" },
      rowActive: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))" },
      cell: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      card: { border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px" },
      cardTitle: { fontSize: "12px", fontWeight: 600 },
      input: { width: "100%", boxSizing: "border-box", minHeight: "54px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))", background: "transparent", color: "inherit", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: "11px", padding: "6px 8px" },
      field: { width: "100%", boxSizing: "border-box", borderRadius: "var(--dsw-radius-sm, 6px)", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))", background: "transparent", color: "inherit", fontFamily: "inherit", fontSize: "12px", padding: "5px 8px" },
      toast: { position: "fixed", right: "16px", bottom: "16px", zIndex: 2000, maxWidth: "320px", padding: "10px 12px", borderRadius: "12px", border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))", background: "var(--dsw-specific-menu, #1f1f1f)", boxShadow: "0 8px 24px rgba(0,0,0,0.3)", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-primary, inherit)" },
    };

    /**
     * Fetch JSON from a route.
     * @param {string} url - route URL.
     * @param {Record<string, any>} [options] - fetch options.
     * @returns {Promise<Record<string, any>>} parsed body.
     */
    async function requestJson(url, options) {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...(options ?? {}) });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (payload === null) throw new Error(`hnflow: ${response.status} ${text.slice(0, 120)} (${url})`);
      if (response.ok === false || payload.ok === false) {
        const error = new Error(String(payload.message ?? `hnflow: ${response.status}`));
        error.code = payload.code;
        error.data = payload.data;
        throw error;
      }
      return payload;
    }

    /**
     * Read the page snapshot for a set of workspaces.
     * @param {{path: string}[]} workspaces - workspaces.
     * @returns {Promise<Record<string, any>>} snapshot.
     */
    function fetchState(workspaces) {
      const params = new URLSearchParams();
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) params.append("workspace", workspace.path);
      return requestJson(`/api/hnflow/state?${params.toString()}`);
    }

    /**
     * Read the inbox (the notice uses this).
     * @returns {Promise<Record<string, any>>} inbox payload.
     */
    function fetchInbox() {
      return requestJson("/api/hnflow/inbox");
    }

    /**
     * Read one resolved flow.
     * @param {string} workspace - workspace root.
     * @param {string} key - flow alias or id.
     * @returns {Promise<Record<string, any>>} resolved flow.
     */
    function fetchFlow(workspace, key) {
      return requestJson(`/api/hnflow/flow?workspace=${encodeURIComponent(workspace)}&flow=${encodeURIComponent(key)}`);
    }

    /**
     * Read one full run.
     * @param {string} runId - run identity.
     * @returns {Promise<Record<string, any>>} run payload.
     */
    function fetchRun(runId) {
      return requestJson(`/api/hnflow/run?runId=${encodeURIComponent(runId)}`);
    }

    /**
     * POST a JSON body to a route.
     * @param {string} path - route.
     * @param {Record<string, any>} body - body.
     * @returns {Promise<Record<string, any>>} response.
     */
    function postJson(path, body) {
      return requestJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }

    /**
     * Place a flow's nodes on a canvas.
     * @param {Record<string, any>} definition - flow definition.
     * @returns {{nodes: Record<string, any>[], edges: Record<string, any>[], width: number, height: number}} layout.
     */
    function layoutFlow(definition) {
      const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
      const edges = Array.isArray(definition?.edges) ? definition.edges : [];
      /** @type {Map<string, Record<string, any>>} */
      const placed = new Map();
      nodes.forEach((node, index) => {
        const x = (index % CANVAS.columns) * CANVAS.stepX + CANVAS.padding;
        const y = Math.floor(index / CANVAS.columns) * CANVAS.stepY + CANVAS.padding;
        placed.set(node.id, { id: String(node.id), type: String(node.type ?? ""), x, y, width: CANVAS.width, height: CANVAS.height });
      });
      const laid = [...placed.values()];
      const width = Math.max(...laid.map((node) => node.x + node.width), CANVAS.width) + CANVAS.padding;
      const height = Math.max(...laid.map((node) => node.y + node.height), CANVAS.height) + CANVAS.padding;
      const drawn = edges
        .filter((edge) => placed.has(edge.from) && placed.has(edge.to))
        .map((edge, index) => ({
          id: String(edge.id ?? `${edge.from}:${edge.to}:${index}`),
          from: edge.from,
          to: edge.to,
          path: edgePath(placed.get(edge.from), placed.get(edge.to)),
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
     * Node state by id for a run summary.
     * @param {Record<string, any> | null} run - run summary.
     * @returns {Map<string, string>} node id → status.
     */
    function nodeStatuses(run) {
      /** @type {Map<string, string>} */
      const map = new Map();
      for (const node of Array.isArray(run?.nodes) ? run.nodes : []) {
        if (typeof node?.id === "string") map.set(node.id, String(node.status ?? "pending"));
      }
      return map;
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
     * Compact run label.
     * @param {Record<string, any>} run - run summary.
     * @returns {string} label.
     */
    function runLabel(run) {
      return `${run.flowName ?? run.key ?? run.flowId} · ${run.status}`;
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
     * Read-only flow canvas, optionally coloured by a run.
     * @param {{definition: Record<string, any> | null, run?: Record<string, any> | null}} props - flow and run.
     * @returns {unknown} element.
     */
    function FlowCanvas(props) {
      const definition = props?.definition ?? null;
      if (definition === null || !Array.isArray(definition.nodes)) return h("div", { style: styles.empty }, "选择左侧的流程查看画布");
      const layout = layoutFlow(definition);
      const statuses = nodeStatuses(props?.run ?? null);
      return h(
        "svg",
        { viewBox: `0 0 ${layout.width} ${layout.height}`, style: styles.canvas, role: "img", "aria-label": "flow canvas" },
        ...layout.edges.map((edge) => h("path", { key: edge.id, d: edge.path, style: styles.edge })),
        ...layout.nodes.map((node) =>
          h("g", { key: node.id }, [
            h("rect", { key: "r", x: node.x, y: node.y, width: node.width, height: node.height, rx: 8, fill: "rgba(127,127,127,0.10)", stroke: NODE_COLORS[statuses.get(node.id) ?? "pending"] ?? NODE_COLORS.pending, strokeWidth: 1.6 }),
            h("text", { key: "t", x: node.x + 9, y: node.y + 21, style: styles.nodeLabel }, node.id),
            h("text", { key: "ty", x: node.x + 9, y: node.y + 38, style: styles.nodeType }, `${node.type}${statuses.has(node.id) ? ` · ${statuses.get(node.id)}` : ""}`),
          ]),
        ),
      );
    }

    /**
     * Left tree: workspaces and their referenced flows.
     * @param {{groups: Record<string, any>[], selected: string, onPick: Function}} props - selection.
     * @returns {unknown} element.
     */
    function FlowTree(props) {
      const groups = Array.isArray(props?.groups) ? props.groups : [];
      const onPick = typeof props?.onPick === "function" ? props.onPick : () => {};
      return h(
        "div",
        { style: styles.tree },
        groups.length === 0 ? h("div", { style: styles.meta }, "还没有工作区") : null,
        ...groups.map((group) =>
          h(
            "div",
            { key: group.path, style: styles.group },
            h("div", { style: styles.groupTitle }, `${group.name || shortPath(group.path)}${group.error ? " · 读取失败" : ""}`),
            (group.flows ?? []).length === 0
              ? h("div", { style: { ...styles.meta, padding: "2px 8px" } }, "没有引用的流程")
              : h(
                  "div",
                  null,
                  ...(group.flows ?? []).map((entry) => {
                    const key = `${group.path}:${entry.alias || entry.flowId}`;
                    return h(
                      "button",
                      { type: "button", key, style: props.selected === key ? { ...styles.item, ...styles.itemActive } : styles.item, onClick: () => onPick(group.path, entry) },
                      h("span", null, `${entry.alias || entry.flowId}${entry.hasOverride ? " ·草稿" : ""}${entry.drift ? " ·漂移" : ""}${entry.missing ? " ·缺失" : ""}`),
                      h("span", { style: styles.meta }, `${entry.flowId} · r${entry.pinnedRevision ?? "latest"}/${entry.currentRevision ?? "?"}`),
                    );
                  }),
                ),
          ),
        ),
      );
    }

    /**
     * The flow pane: canvas, publish and run controls.
     * @param {{flow: Record<string, any> | null, busy: boolean, onPublish: Function, onRun: Function, message: string}} props - pane.
     * @returns {unknown} element.
     */
    function FlowPane(props) {
      const flow = props?.flow;
      const [input, setInput] = react.useState("{}");
      if (flow === null) return h("div", { style: styles.empty }, "选择左侧的流程查看画布");
      return h(
        "div",
        { style: styles.pane },
        h("div", { style: styles.meta }, `${flow.alias || flow.flowId} · ${flow.source} · r${flow.revision ?? "?"}/${flow.currentRevision ?? "?"}${flow.drift ? " · 漂移" : ""}`),
        h(FlowCanvas, { definition: flow.definition, run: null }),
        h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [
          h("button", { key: "publish", type: "button", style: { ...styles.button, ...styles.buttonPrimary }, disabled: props.busy, onClick: () => props.onPublish(flow) }, "发布新版本"),
          h("span", { key: "hint", style: styles.meta }, "发布是人工动作：Agent 只能起草"),
        ]),
        h("div", { style: styles.cardTitle }, "启动输入（JSON）"),
        h("textarea", { style: styles.input, value: input, onChange: (event) => setInput(event.target.value), spellCheck: false }),
        h("div", null, h("button", { type: "button", style: styles.button, disabled: props.busy, onClick: () => props.onRun(flow, input) }, "用这份输入运行")),
        props.message.length > 0 ? h("div", { style: styles.okBox }, props.message) : null,
      );
    }

    /**
     * The runs board.
     * @param {{runs: Record<string, any>[], selected: string, onPick: Function}} props - board.
     * @returns {unknown} element.
     */
    function RunsBoard(props) {
      const runs = Array.isArray(props?.runs) ? props.runs : [];
      if (runs.length === 0) return h("div", { style: styles.empty }, "还没有运行记录");
      return h(
        "div",
        { style: styles.tree },
        ...runs.map((run) =>
          h(
            "button",
            { type: "button", key: run.runId, style: props.selected === run.runId ? { ...styles.item, ...styles.itemActive } : styles.item, onClick: () => props.onPick(run) },
            h("span", null, `${runLabel(run)}${run.pending > 0 ? ` · 待人工 ${run.pending}` : ""}`),
            h("span", { style: styles.meta }, `${run.runId} · ${shortPath(run.workspace)} · r${run.revision ?? "latest"}`),
          ),
        ),
      );
    }

    /**
     * One run's node timeline.
     * @param {{run: Record<string, any> | null, definition: Record<string, any> | null}} props - run.
     * @returns {unknown} element.
     */
    function RunPane(props) {
      const run = props?.run;
      if (run === null) return h("div", { style: styles.empty }, "选择左侧的运行查看节点状态");
      return h(
        "div",
        { style: styles.pane },
        h("div", { style: styles.meta }, `${run.runId} · ${run.status} · ${run.source === "override" ? "草稿覆盖" : `r${run.revision ?? "latest"}`} · ${shortPath(run.workspace)}`),
        run.error !== null && run.error !== undefined ? h("div", { style: styles.errorBox }, `${run.error.code}: ${run.error.message}`) : null,
        props.definition !== null ? h(FlowCanvas, { definition: props.definition, run }) : null,
        h("div", { style: styles.cardTitle }, "节点"),
        ...(run.nodes ?? []).map((node) =>
          h("div", { key: node.id, style: styles.row }, [
            h("span", { key: "id", style: { ...styles.cell, flex: "0 0 130px" } }, node.id),
            h("span", { key: "st", style: { ...styles.cell, flex: "0 0 90px" } }, node.status),
            h("span", { key: "at", style: { ...styles.cell, flex: "0 0 60px" } }, node.attempts > 1 ? `×${node.attempts}` : ""),
            h("span", { key: "dg", style: { ...styles.cell, flex: "1 1 auto" } }, node.diagnostic ? `${node.diagnostic.code}: ${node.diagnostic.message}` : ""),
          ]),
        ),
      );
    }

    /**
     * The inbox: gates and deliveries.
     * @param {{items: Record<string, any>[], busy: boolean, onGate: Function, onDeliver: Function}} props - inbox.
     * @returns {unknown} element.
     */
    function InboxView(props) {
      const items = Array.isArray(props?.items) ? props.items : [];
      const [drafts, setDrafts] = react.useState({});
      if (items.length === 0) return h("div", { style: styles.empty }, "收件箱是空的");
      return h(
        "div",
        { style: styles.pane },
        ...items.map((item) => {
          const draft = drafts[item.id] ?? "";
          return h(
            "div",
            { key: item.id, style: styles.card },
            h("div", { style: styles.cardTitle }, `${item.kind === "gate" ? "门禁" : "人工交付"} · ${item.flowName ?? ""} · ${item.nodeId}`),
            h("div", { style: styles.meta }, `run ${item.runId} · ${item.id}${item.attempts > 0 ? ` · 已退回 ${item.attempts} 次` : ""}`),
            item.kind === "gate"
              ? h(
                  "div",
                  { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
                  h("button", { type: "button", style: { ...styles.button, ...styles.buttonPrimary }, disabled: props.busy, onClick: () => props.onGate(item, { decision: "approved", reason: draft }) }, "批准"),
                  h("button", { type: "button", style: styles.button, disabled: props.busy, onClick: () => props.onGate(item, { decision: "modified", reason: draft || "修改后批准" }) }, "修改后批准"),
                  h("button", { type: "button", style: styles.button, disabled: props.busy, onClick: () => props.onGate(item, { decision: "rejected", reason: draft }) }, "拒绝"),
                )
              : null,
            item.whyHuman ? h("div", { style: styles.meta }, `为什么必须由人完成：${item.whyHuman}`) : null,
            item.kind === "gate" ? null : h("div", { style: styles.cardTitle }, "交付物（JSON）"),
            item.kind === "gate" ? null : h("textarea", { style: styles.input, value: draft, spellCheck: false, onChange: (event) => setDrafts({ ...drafts, [item.id]: event.target.value }) }),
            item.kind === "gate"
              ? h("input", { style: styles.field, placeholder: "理由（拒绝时必填）", value: draft, onChange: (event) => setDrafts({ ...drafts, [item.id]: event.target.value }) })
              : h("div", null, h("button", { type: "button", style: styles.button, disabled: props.busy, onClick: () => props.onDeliver(item, draft) }, "提交交付")),
            item.deliverable ? h("div", { style: styles.meta }, `契约：${JSON.stringify(item.deliverable).slice(0, 320)}`) : null,
          );
        }),
      );
    }

    /**
     * Catch a render failure inside a surface and show it instead of a blank
     * panel. Built lazily because the contract tests use a React stub without
     * class components.
     * @returns {unknown} a boundary component, or null when unavailable.
     */
    const RenderBoundary = (() => {
      const Component = react.Component;
      if (typeof Component !== "function") return null;
      return class RenderBoundary extends Component {
        constructor(props) {
          super(props);
          this.state = { message: "" };
        }
        static getDerivedStateFromError(error) {
          return { message: String(error && error.message ? error.message : error) };
        }
        render() {
          if (this.state.message.length > 0) {
            return h("div", { style: { padding: "16px", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: "12px", color: "var(--dsw-alias-label-danger, #e5534b)", whiteSpace: "pre-wrap" } }, `HNFlow 页面渲染失败：${this.state.message}`);
          }
          return this.props.children;
        }
      };
    })();

    /**
     * Wrap a page so a render failure is visible rather than blank.
     * @param {unknown} node - page element.
     * @returns {unknown} wrapped element.
     */
    function withBoundary(node) {
      return RenderBoundary === null ? node : h(RenderBoundary, null, node);
    }

    /**
     * List workspaces from the client store.
     * @param {Record<string, any>} ctx - client context.
     * @returns {Promise<{id: string, name: string, path: string}[]>} workspaces.
     */
    function workspaceList(ctx) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          resolve(Array.isArray(value) ? value : []);
        };
        try {
          ctx.inject(["workspaces"], (scope) => {
            try {
              const items = Array.isArray(scope.workspaces?.list?.getSnapshot?.()?.items) ? scope.workspaces.list.getSnapshot().items : [];
              done(items.filter((item) => typeof item?.path === "string" && item.path.length > 0).map((item) => ({ id: item.workspaceId ?? item.id ?? item.path, name: item.title ?? shortPath(item.path), path: item.path })));
            } catch {
              done([]);
            }
          });
        } catch {
          done([]);
        }
        setTimeout(() => done([]), 2000);
      });
    }

    /**
     * The main page: three tabs over the Fetch routes.
     * @param {{ctx: Record<string, any>}} props - injected context.
     * @returns {unknown} element.
     */
    function HnflowPage(props) {
      const ctx = props.ctx;
      const [tab, setTab] = react.useState("flows");
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState("");
      const [message, setMessage] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [selectedFlow, setSelectedFlow] = react.useState(null);
      const [selectedRun, setSelectedRun] = react.useState(null);

      /**
       * Reload the snapshot.
       * @returns {Promise<void>} resolves once rendered.
       */
      const reload = async () => {
        setBusy(true);
        try {
          const workspaces = await workspaceList(ctx);
          const payload = await fetchState(workspaces);
          setState(payload);
          setError("");
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };

      react.useEffect(() => {
        void reload();
      }, []);

      /**
       * Publish the selected flow.
       * @param {Record<string, any>} flow - tree entry.
       * @returns {Promise<void>} resolves once published.
       */
      const publish = async (flow) => {
        setBusy(true);
        try {
          const result = await postJson("/api/hnflow/publish", { workspace: flow.workspace, flow: flow.alias || flow.flowId });
          setMessage(`已发布 r${result.revision}（${result.contentHash}）`);
          await reload();
        } catch (failure) {
          setError(`${failure.code ?? "publish-failed"}: ${failure.message}`);
        } finally {
          setBusy(false);
        }
      };

      /**
       * Start a run with the pane's JSON input.
       * @param {Record<string, any>} flow - selected flow.
       * @param {string} text - JSON input.
       * @returns {Promise<void>} resolves once started.
       */
      const startRun = async (flow, text) => {
        setBusy(true);
        try {
          let input = {};
          try {
            input = text.trim().length === 0 ? {} : JSON.parse(text);
          } catch (failure) {
            throw Object.assign(new Error(`输入不是合法 JSON：${String(failure.message ?? failure)}`), { code: "input-invalid" });
          }
          const started = await postJson("/api/hnflow/start", { workspace: flow.workspace, flow: flow.alias || flow.flowId, input });
          setMessage(`已启动 ${started.runId}`);
          await reload();
        } catch (failure) {
          setError(`${failure.code ?? "run-failed"}: ${failure.message}`);
        } finally {
          setBusy(false);
        }
      };

      /**
       * Submit a gate decision.
       * @param {Record<string, any>} item - inbox item.
       * @param {{decision: string, reason: string}} decision - decision.
       * @returns {Promise<void>} resolves once submitted.
       */
      const decide = async (item, decision) => {
        setBusy(true);
        try {
          await postJson("/api/hnflow/gate", { runId: item.runId, gateId: item.id, decision: decision.decision, reason: decision.reason, revision: item.revision });
          setMessage(`已提交 ${item.id}`);
          await reload();
        } catch (failure) {
          setError(`${failure.code ?? "gate-failed"}: ${failure.message}`);
        } finally {
          setBusy(false);
        }
      };

      /**
       * Submit a delivery.
       * @param {Record<string, any>} item - inbox item.
       * @param {string} text - JSON payload.
       * @returns {Promise<void>} resolves once submitted.
       */
      const deliver = async (item, text) => {
        setBusy(true);
        try {
          let payload;
          try {
            payload = JSON.parse(text);
          } catch (failure) {
            throw Object.assign(new Error(`交付物不是合法 JSON：${String(failure.message ?? failure)}`), { code: "payload-invalid" });
          }
          await postJson("/api/hnflow/deliverable", { runId: item.runId, requestId: item.id, payload, revision: item.revision });
          setMessage(`已提交 ${item.id}`);
          await reload();
        } catch (failure) {
          setError(`${failure.code ?? "deliver-failed"}: ${failure.message}`);
        } finally {
          setBusy(false);
        }
      };

      const groups = Array.isArray(state?.workspaces) ? state.workspaces : [];
      const runs = Array.isArray(state?.runs) ? state.runs : [];
      const inbox = Array.isArray(state?.inbox) ? state.inbox : [];

      const pickFlow = async (workspace, entry) => {
        setSelectedFlow({ ...entry, workspace, definition: null });
        try {
          const resolved = await fetchFlow(workspace, entry.alias || entry.flowId);
          setSelectedFlow({ ...entry, workspace, definition: resolved.flow.definition, lockfile: resolved.flow.lockfile });
        } catch {
          // the tree entry is still shown; the canvas stays empty
        }
      };

      const pickRun = async (run) => {
        setSelectedRun({ ...run, nodes: run.nodes ?? [] });
        try {
          const full = await fetchRun(run.runId);
          setSelectedRun(full.run);
          const resolved = await fetchFlow(run.workspace, run.flowId);
          setSelectedFlow({ ...resolved.flow, workspace: run.workspace, alias: run.key ?? run.flowId });
        } catch {
          // the summary is enough for the timeline
        }
      };

      const left = tab === "flows" ? h(FlowTree, { groups, selected: selectedFlow === null ? "" : `${selectedFlow.workspace}:${selectedFlow.alias || selectedFlow.flowId}`, onPick: (workspace, entry) => void pickFlow(workspace, entry) }) : tab === "runs" ? h(RunsBoard, { runs, selected: selectedRun?.runId ?? "", onPick: (run) => void pickRun(run) }) : null;

      const right =
        tab === "flows"
          ? h(FlowPane, { flow: selectedFlow, busy, message, onPublish: (flow) => void publish(flow), onRun: (flow, text) => void startRun(flow, text) })
          : tab === "runs"
            ? h(RunPane, { run: selectedRun, definition: selectedFlow?.definition ?? null })
            : h(InboxView, { items: inbox, busy, onGate: (item, decision) => void decide(item, decision), onDeliver: (item, text) => void deliver(item, text) });

      return h(
        "div",
        { style: styles.page },
        h(
          "div",
          { style: styles.tabbar },
          ...TABS.map((entry) =>
            h(
              "button",
              { type: "button", key: entry.id, style: entry.id === tab ? { ...styles.tab, ...styles.tabActive } : styles.tab, onClick: () => setTab(entry.id) },
              `${entry.label}${entry.id === "inbox" && inbox.length > 0 ? ` (${inbox.length})` : ""}`,
            ),
          ),
          h("span", { style: { flex: "1 1 auto" } }),
          h("button", { type: "button", style: styles.linkButton, disabled: busy, onClick: () => void reload() }, "刷新"),
        ),
        state?.degraded === true ? h("div", { style: styles.errorBox }, "VibeStack 未就绪：可以查看流程与运行，但发布和启动会被拒绝。") : null,
        error.length > 0 ? h("div", { style: styles.errorBox }, error) : null,
        message.length > 0 ? h("div", { style: { ...styles.okBox, margin: "8px 14px" } }, message) : null,
        withBoundary(h("div", { style: styles.body }, tab === "inbox" ? null : left, right)),
      );
    }

    /**
     * The session tab: this session's runs.
     * @param {{sessionId: string, ctx: Record<string, any>}} props - session.
     * @returns {unknown} element.
     */
    function SessionView(props) {
      const [state, setState] = react.useState(null);
      const [selected, setSelected] = react.useState(null);
      const [error, setError] = react.useState("");
      react.useEffect(() => {
        void (async () => {
          try {
            const workspaces = await workspaceList(props.ctx);
            const payload = await fetchState(workspaces);
            setState(payload);
            const mine = (payload.runs ?? []).filter((run) => run.hostSessionId === props.sessionId);
            if (mine.length > 0) setSelected(mine[0]);
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        })();
      }, []);
      const runs = Array.isArray(state?.runs) ? state.runs.filter((run) => run.hostSessionId === props.sessionId) : [];
      return h(
        "div",
        { style: styles.page },
        h("div", { style: styles.tabbar }, h("span", { style: styles.meta }, runs.length === 0 ? "这个会话还没有运行" : `${runs.length} 次运行`)),
        error.length > 0 ? h("div", { style: styles.errorBox }, error) : null,
        runs.length === 0
          ? h("div", { style: styles.empty }, "用 `hnflow` 工具的 run 动作在这个会话里启动流程")
          : h(
              "div",
              { style: styles.body },
              h(RunsBoard, { runs, selected: selected?.runId ?? "", onPick: (run) => setSelected(run) }),
              h(RunPane, { run: selected, definition: null }),
            ),
      );
    }

    /** Inbox item ids already announced; module-level so a remount cannot repeat. */
    const announced = new Set();

    /**
     * Bottom-right notice for the first sighting of an inbox item.
     * @returns {unknown} element.
     */
    function Notifier() {
      const [notice, setNotice] = react.useState(null);
      react.useEffect(() => {
        let live = true;
        let timer = null;
        let failures = 0;
        const poll = async () => {
          try {
            const payload = await fetchInbox();
            if (!live) return;
            failures = 0;
            const fresh = [];
            for (const item of Array.isArray(payload.items) ? payload.items : []) {
              if (typeof item?.id !== "string" || announced.has(item.id)) continue;
              announced.add(item.id);
              fresh.push(item);
            }
            if (fresh.length > 0) setNotice({ item: fresh[0], extra: fresh.length - 1 });
          } catch {
            failures += 1;
          }
          if (!live) return;
          timer = setTimeout(() => void poll(), failures === 0 ? 15000 : 60000);
        };
        void poll();
        return () => {
          live = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, []);
      if (notice === null) return null;
      return h(
        "div",
        { style: styles.toast, role: "status" },
        h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "HNFlow 有一项待处理"),
        h("div", { style: styles.meta }, `${notice.item.kind === "gate" ? "门禁" : "交付"} · ${notice.item.flowName ?? ""} · ${notice.item.nodeId}${notice.extra > 0 ? ` 等 ${notice.extra + 1} 条` : ""}`),
        h("div", { style: { display: "flex", gap: "6px", marginTop: "8px" } }, h("button", { type: "button", style: styles.linkButton, onClick: () => setNotice(null) }, "关闭")),
      );
    }

    /**
     * Register one slot, tolerating a host that does not declare it.
     * @param {Record<string, any>} ctx - client context.
     * @param {string} name - slot name.
     * @param {function(Record<string, any>): unknown} build - registration body.
     * @returns {boolean} whether the registration was accepted.
     */
    function registerSlot(ctx, name, build) {
      try {
        ctx.slots.inject(name, () => build(ctx.slots));
        return true;
      } catch {
        return false;
      }
    }

    /** Contexts already wired; a repeated apply must not register a second panel. */
    const wired = new WeakSet();

    /** Session-tab view id. */
    const VIEW_ID = "hnflow";

    /** Right-sidebar page type. */
    const RIGHT_KIND = "hnflow.inbox";

    /** Overlay notice id. */
    const NOTICE_ID = "hnflow.notice";

    /**
     * The right-sidebar tab type registration.
     * @returns {Record<string, any>} definition.
     */
    function rightTabDefinition() {
      return {
        id: RIGHT_KIND,
        kind: RIGHT_KIND,
        priority: "extension",
        title: () => "HNFlow",
        guide: [{ id: "inbox", kind: RIGHT_KIND, title: () => "HNFlow 收件箱", description: () => "门禁与人工交付" }],
      };
    }

    /**
     * Client plugin body.
     * @param {Record<string, any>} ctx - client context.
     * @returns {void}
     */
    function apply(ctx) {
      if (wired.has(ctx)) return;
      wired.add(ctx);

      registerSlot(ctx, "sidebar.panellist", (slots) => slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 15, label: () => "HNFlow" }, HnflowIcon));
      registerSlot(ctx, "main", (slots) => slots.register({ name: "main", key: PANEL_ID, inject: () => ({ ctx }) }, HnflowPage));

      let disposeView = null;
      try {
        ctx.inject(["sessions", "uiSession"], (scope) => {
          let last = null;
          const read = () => {
            try {
              const current = scope.uiSession?.adapter?.current?.getSnapshot?.();
              const snapshot = scope.sessions?.list?.getSnapshot?.() ?? null;
              const id = current && typeof current.key === "string" ? current.key : Array.isArray(snapshot?.ids) ? snapshot.ids[0] : null;
              const preset = id === null ? null : (snapshot?.byId?.[id]?.projectionValues?.agentPreset ?? null);
              if (preset === last) return;
              last = preset;
              if (preset === PRESET_ID && disposeView === null) {
                disposeView = ctx.slots.inject("conversation.view", () =>
                  ctx.slots.register({ name: "conversation.view", id: VIEW_ID, order: 20, label: () => "HNFlow", inject: (sessionId) => ({ ctx, sessionId }) }, SessionView),
                );
              } else if (preset !== PRESET_ID && disposeView !== null) {
                disposeView();
                disposeView = null;
              }
            } catch {
              // a store that is not ready yet simply retries on the next frame
            }
          };
          read();
          for (const store of [scope.sessions?.list, scope.uiSession?.adapter?.current]) {
            if (store && typeof store.subscribe === "function") store.subscribe(read);
          }
        });
      } catch {
        // no session services: the tab stays off
      }

      try {
        ctx.inject(["sidebarRightTabs", "sidebarRight"], (scope) => {
          const tabs = scope.sidebarRightTabs;
          if (!tabs || typeof tabs.register !== "function") return;
          if (typeof scope.effect === "function") scope.effect(() => tabs.register(rightTabDefinition()), "hnflow: right tab type");
          else tabs.register(rightTabDefinition());
          registerSlot(ctx, "sidebar.right.pane.tab", (slots) => slots.register({ name: "sidebar.right.pane.tab", key: RIGHT_KIND, inject: () => ({ ctx }) }, HnflowPage));
          registerSlot(ctx, "sidebar.right.pane.tab.title", (slots) => slots.register({ name: "sidebar.right.pane.tab.title", key: RIGHT_KIND }, () => h("span", null, "HNFlow")));
        });
      } catch {
        // this profile has no right sidebar; the page still shows the inbox
      }

      registerSlot(ctx, "shell.overlay", (slots) => slots.register({ name: "shell.overlay", id: NOTICE_ID }, Notifier));
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Pure helpers, exported for the contract tests. */
    exports.internals = { layoutFlow, edgePath, shortPath, nodeStatuses, rightTabDefinition, runLabel };
    return module.exports;
  },
});
