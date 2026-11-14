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
      headerButton: { display: "flex", alignItems: "center", gap: "6px", width: "100%", boxSizing: "border-box", padding: "4px 6px", border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", fontFamily: "inherit", fontSize: "12px", textAlign: "left", cursor: "pointer" },
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
      warnBox: { padding: "8px 10px", borderRadius: "var(--dsw-radius-sm, 6px)", border: "1px solid rgba(240,170,60,0.55)", color: "rgba(200,140,30,1)", fontSize: "12px", whiteSpace: "pre-wrap" },
      pre: { margin: 0, padding: "8px", borderRadius: "var(--dsw-radius-sm, 6px)", background: "rgba(127,127,127,0.10)", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: "11px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "320px", overflow: "auto" },
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
     * Read a flow's revision history.
     * @param {string} workspace - workspace root.
     * @param {string} key - flow alias or id.
     * @returns {Promise<Record<string, any>>} history payload.
     */
    function fetchHistory(workspace, key) {
      return requestJson(`/api/hnflow/history?workspace=${encodeURIComponent(workspace)}&flow=${encodeURIComponent(key)}`);
    }

    /**
     * Preview a publish without creating a revision.
     * @param {string} workspace - workspace root.
     * @param {string} key - flow alias or id.
     * @returns {Promise<Record<string, any>>} preview payload.
     */
    function fetchPreview(workspace, key) {
      return requestJson(`/api/hnflow/preview?workspace=${encodeURIComponent(workspace)}&flow=${encodeURIComponent(key)}`);
    }

    /**
     * Read one artifact and its value.
     * @param {string} artifactId - artifact id.
     * @returns {Promise<Record<string, any>>} artifact payload.
     */
    function fetchArtifact(artifactId) {
      return requestJson(`/api/hnflow/artifact?artifactId=${encodeURIComponent(artifactId)}`);
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
     * The label a flow row uses: alias first, then display name, then id.
     * @param {Record<string, any>} entry - ref or asset.
     * @returns {string} label.
     */
    function flowLabel(entry) {
      if (entry?.local === true) return String(entry?.name || entry?.flowName || entry?.flowId || "");
      return String(entry?.alias || entry?.flowId || entry?.name || "");
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
     * Build a nested folder tree from asset/ref entries.
     *
     * Entries carry a library-relative `folder`; `a/b` becomes two nested
     * folders. Files at the root live on the root node.
     * @param {Record<string, any>[]} entries - entries with an optional `folder`.
     * @returns {{folders: Map<string, any>, files: Record<string, any>[]}} tree.
     */
    function folderTree(entries) {
      const root = { folders: new Map(), files: [] };
      for (const entry of Array.isArray(entries) ? entries : []) {
        const parts = String(entry?.folder ?? "")
          .split("/")
          .filter((part) => part.length > 0);
        let node = root;
        for (const part of parts) {
          if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
          node = node.folders.get(part);
        }
        node.files.push(entry);
      }
      const sortNode = (node) => {
        node.folders = new Map([...node.folders.entries()].sort(([left], [right]) => left.localeCompare(right)));
        node.files.sort((left, right) => String(left.name ?? left.alias ?? left.flowId ?? "").localeCompare(String(right.name ?? right.alias ?? right.flowId ?? "")));
        for (const child of node.folders.values()) sortNode(child);
      };
      sortNode(root);
      return root;
    }

    /**
     * Left tree: one reusable library section plus collapsible workspaces,
     * both rendered as nested folders.
     * @param {{groups: Record<string, any>[], assets: Record<string, any>[], selected: string, targetWorkspace: string, onPick: Function, onAdd: Function}} props - selection.
     * @returns {unknown} element.
     */
    function FlowTree(props) {
      const groups = Array.isArray(props?.groups) ? props.groups : [];
      const assets = Array.isArray(props?.assets) ? props.assets : [];
      const onPick = typeof props?.onPick === "function" ? props.onPick : () => {};
      const onAdd = typeof props?.onAdd === "function" ? props.onAdd : () => {};
      const targetWorkspace = typeof props?.targetWorkspace === "string" ? props.targetWorkspace : "";
      const [collapsed, setCollapsed] = react.useState({});
      /**
       * Toggle one section or folder.
       * @param {string} key - stable key.
       * @returns {void}
       */
      const toggle = (key) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

      /**
       * Render one folder node and its descendants.
       * @param {{folders: Map<string, any>, files: Record<string, any>[]}} node - node.
       * @param {string} prefix - folder path prefix.
       * @param {number} depth - nesting depth.
       * @param {'library'|'workspace'} mode - row kind.
       * @param {string} groupPath - owning workspace path.
       * @returns {unknown[]} rows.
       */
      const renderTree = (node, prefix, depth, mode, groupPath) => {
        const rows = [];
        for (const [name, child] of node.folders) {
          const key = `${mode}:${groupPath}:${prefix}${name}`;
          const closed = collapsed[key] === true;
          rows.push(
            h(
              "button",
              {
                type: "button",
                key,
                style: { ...styles.headerButton, paddingLeft: `${6 + depth * 12}px` },
                onClick: () => toggle(key),
              },
              `${closed ? "▸" : "▾"} ${name}`,
            ),
          );
          if (!closed) rows.push(...renderTree(child, `${prefix}${name}/`, depth + 1, mode, groupPath));
        }
        for (const entry of node.files) {
          if (mode === "library") {
            rows.push(
              h(
                "div",
                { key: `library:${entry.id}`, style: { ...styles.item, flexDirection: "row", alignItems: "center", gap: "6px", paddingLeft: `${10 + depth * 12}px`, cursor: "default" } },
                h("span", { key: "name", style: { ...styles.cell, flex: "1 1 auto" } }, String(entry.name ?? entry.id)),
                h("span", { key: "revision", style: styles.meta }, `r${entry.revision ?? "?"}`),
                h(
                  "button",
                  { key: "add", type: "button", style: styles.linkButton, disabled: targetWorkspace.length === 0, title: targetWorkspace.length === 0 ? "没有可引用的工作区" : `引用到 ${shortPath(targetWorkspace)}`, onClick: () => onAdd(targetWorkspace, entry) },
                  "引用",
                ),
              ),
            );
          } else {
            const key = `${groupPath}:${flowLabel(entry)}`;
            const local = entry.local === true;
            rows.push(
              h(
                "button",
                { type: "button", key, style: { ...(props.selected === key ? { ...styles.item, ...styles.itemActive } : styles.item), paddingLeft: `${10 + depth * 12}px` }, onClick: () => onPick(groupPath, entry) },
                h("span", null, `${flowLabel(entry)}${local ? " ·项目草稿" : ""}${entry.hasOverride ? " ·草稿" : ""}${entry.drift ? " ·漂移" : ""}${entry.missing ? " ·缺失" : ""}`),
                h("span", { style: styles.meta }, local ? "仅本工作区 · 可运行" : `${entry.flowId} · r${entry.pinnedRevision ?? "latest"}/${entry.currentRevision ?? "?"}`),
              ),
            );
          }
        }
        return rows;
      };

      const libraryClosed = collapsed.library === true;
      return h(
        "div",
        { style: styles.tree },
        h(
          "div",
          { style: styles.group },
          h("button", { type: "button", style: styles.headerButton, onClick: () => toggle("library") }, `${libraryClosed ? "▸" : "▾"} 通用资产库${assets.length > 0 ? ` (${assets.length})` : ""}`),
          libraryClosed
            ? null
            : h(
                "div",
                null,
                h("div", { style: { ...styles.meta, paddingLeft: "10px" } }, targetWorkspace.length === 0 ? "没有可引用的工作区" : `引用目标：${shortPath(targetWorkspace)}`),
                assets.length === 0
                  ? h("div", { style: { ...styles.meta, paddingLeft: "10px" } }, "资产库是空的")
                  : h("div", null, ...renderTree(folderTree(assets), "", 0, "library", "")),
              ),
        ),
        ...groups.map((group) =>
          h(
            "div",
            { key: group.path, style: styles.group },
            h(
              "button",
              { type: "button", style: styles.headerButton, onClick: () => toggle(`workspace:${group.path}`) },
              `${collapsed[`workspace:${group.path}`] === true ? "▸" : "▾"} ${group.name || shortPath(group.path)}${group.error ? " · 读取失败" : ""}`,
            ),
            collapsed[`workspace:${group.path}`] === true
              ? null
              : (group.flows ?? []).length === 0
                ? h("div", { style: { ...styles.meta, paddingLeft: "10px" } }, "没有引用的流程")
                : h("div", null, ...renderTree(folderTree(group.flows ?? []), "", 0, "workspace", group.path)),
          ),
        ),
      );
    }

    /**
     * The flow pane: canvas, revision history, publish preview and run controls.
     * @param {{flow: Record<string, any> | null, busy: boolean, onRun: Function, onChanged: Function, message: string}} props - pane.
     * @returns {unknown} element.
     */
    function FlowPane(props) {
      const flow = props?.flow;
      const [input, setInput] = react.useState("{}");
      const [history, setHistory] = react.useState(null);
      const [preview, setPreview] = react.useState(null);
      const [confirmRollback, setConfirmRollback] = react.useState(null);
      const [confirmPromote, setConfirmPromote] = react.useState(false);
      const [error, setError] = react.useState("");
      const [note, setNote] = react.useState("");
      const [working, setWorking] = react.useState(false);
      const flowKey = flow === null || flow === undefined ? "" : flow.alias || flow.flowId;
      const workspace = flow === null || flow === undefined ? "" : flow.workspace;
      const isLocal = flow !== null && flow !== undefined && (flow.local === true || flow.source === "local");

      /**
       * Refresh the revision list for the selected flow.
       * @returns {Promise<void>} resolves once loaded.
       */
      const loadHistory = async () => {
        if (isLocal || workspace.length === 0 || flowKey.length === 0) return;
        try {
          const payload = await fetchHistory(workspace, flowKey);
          setHistory(payload.history);
        } catch (failure) {
          setError(`${failure.code ?? "history-failed"}: ${failure.message}`);
        }
      };

      react.useEffect(() => {
        setHistory(null);
        setPreview(null);
        setConfirmRollback(null);
        setConfirmPromote(false);
        setError("");
        setNote("");
        void loadHistory();
      }, [workspace, flowKey, isLocal]);

      /**
       * Run one human action with shared busy/error handling.
       * @param {() => Promise<string>} action - action returning a message.
       * @returns {Promise<void>} resolves once done.
       */
      const act = async (action) => {
        setWorking(true);
        setError("");
        try {
          setNote(await action());
          if (!isLocal) await loadHistory();
          if (typeof props.onChanged === "function") props.onChanged();
        } catch (failure) {
          setError(`${failure.code ?? "action-failed"}: ${failure.message}`);
        } finally {
          setWorking(false);
        }
      };

      if (flow === null) return h("div", { style: styles.empty }, "选择左侧的流程查看画布");
      const busy = props.busy || working;
      const revisions = Array.isArray(history?.revisions) ? history.revisions : [];
      return h(
        "div",
        { style: styles.pane },
        h("div", { style: styles.meta }, isLocal ? `${flow.flowName || flow.name || flow.flowId} · 项目草稿 · 仅本工作区，可运行` : `${flow.alias || flow.flowId} · ${flow.source} · r${flow.revision ?? "?"}/${flow.currentRevision ?? "?"}${flow.drift ? " · 漂移" : ""}`),
        h(FlowCanvas, { definition: flow.definition, run: null }),
        isLocal
          ? h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, [
              h("button", { key: "promote", type: "button", style: { ...styles.button, ...styles.buttonPrimary }, disabled: busy, onClick: () => act(async () => {
                if (!confirmPromote) {
                  setConfirmPromote(true);
                  return `再点一次确认：把「${flow.flowName || flow.flowId}」提升为通用资产 r1，并改为本工作区引用。`;
                }
                setConfirmPromote(false);
                const promoted = await postJson("/api/hnflow/promote", { workspace: flow.workspace, flow: flow.flowId });
                if (typeof props.onPromoted === "function") props.onPromoted(promoted);
                return `已提升为 ${promoted.flowId}（r1）。后续修改仍需人工发布。`;
              }) }, confirmPromote ? "确认提升" : "提升到通用资产库"),
              h("span", { key: "hint", style: styles.meta }, "项目草稿没有版本历史；提升后才进入资产库"),
            ])
          : h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, [
              h("button", { key: "publish", type: "button", style: { ...styles.button, ...styles.buttonPrimary }, disabled: busy, onClick: () => act(async () => {
                const payload = await fetchPreview(flow.workspace, flow.alias || flow.flowId);
                setPreview(payload.preview);
                return "已生成发布预览：确认后才会新增 revision。";
              }) }, "发布新版本"),
              h("span", { key: "hint", style: styles.meta }, "发布是人工动作：Agent 只能起草；先看 diff 再确认"),
            ]),
        note.length > 0 ? h("div", { style: styles.okBox }, note) : null,
        error.length > 0 ? h("div", { style: styles.errorBox }, error) : null,
        isLocal
          ? null
          : h(
              "div",
              { style: { display: "contents" } },
              preview === null
                ? null
                : h(
                    "div",
                    { style: styles.card },
                    h("div", { style: styles.cardTitle }, `发布预览：r${preview.currentRevision} → r${preview.nextRevision}`),
                    h("div", { style: styles.meta }, preview.validation.ok ? "校验通过" : `校验失败（${preview.validation.errors.length} 项）`),
                    ...preview.validation.errors.map((entry) => h("div", { key: `${entry.code}:${entry.nodeId ?? ""}`, style: styles.meta }, `× ${entry.code}${entry.nodeId ? ` [${entry.nodeId}]` : ""}: ${entry.message}`)),
                    h("div", { style: styles.cardTitle }, "变更"),
                    preview.diff?.changed === false
                      ? h("div", { style: styles.meta }, "没有内容变化（仍会生成新 revision）")
                      : h("div", { style: { ...styles.meta, whiteSpace: "pre-wrap" } }, (preview.diff?.summary ?? []).join("\n")),
                    h("div", { style: { display: "flex", gap: "8px" } }, [
                      h("button", { key: "ok", type: "button", style: { ...styles.button, ...styles.buttonPrimary }, disabled: busy || !preview.validation.ok, onClick: () => act(async () => {
                        const result = await postJson("/api/hnflow/publish", { workspace: flow.workspace, flow: flow.alias || flow.flowId, note: "published from the HNFlow page" });
                        setPreview(null);
                        return `已发布 r${result.revision}（${result.contentHash}）`;
                      }) }, "确认发布"),
                      h("button", { key: "cancel", type: "button", style: styles.button, disabled: busy, onClick: () => setPreview(null) }, "取消"),
                    ]),
                  ),
              h("div", { style: styles.cardTitle }, `版本历史（${revisions.length}）`),
              h(
                "div",
                { style: styles.card },
                ...revisions.map((entry) =>
                  h("div", { key: entry.revision, style: { ...styles.row, cursor: "default", alignItems: "center" } }, [
                    h("span", { key: "r", style: { ...styles.cell, flex: "0 0 54px" } }, `r${entry.revision}`),
                    h("span", { key: "h", style: { ...styles.cell, flex: "1 1 auto" } }, `${entry.contentHash}${entry.revision === history.pinnedRevision ? " · 引用钉住" : ""}${entry.revision === history.currentRevision ? " · 当前" : ""}`),
                    h("button", { key: "pin", type: "button", style: styles.linkButton, disabled: busy, onClick: () => act(async () => {
                      await postJson("/api/hnflow/pin", { workspace: flow.workspace, flow: flow.alias || flow.flowId, revision: entry.revision });
                      return `已钉住 r${entry.revision}`;
                    }) }, "钉住"),
                    h("button", { key: "rollback", type: "button", style: styles.linkButton, disabled: busy, onClick: () => act(async () => {
                      if (confirmRollback !== entry.revision) {
                        setConfirmRollback(entry.revision);
                        return `再点一次确认：把 r${entry.revision} 发布为新的 r${(history?.currentRevision ?? 0) + 1}`;
                      }
                      setConfirmRollback(null);
                      const result = await postJson("/api/hnflow/rollback", { workspace: flow.workspace, flow: flow.alias || flow.flowId, revision: entry.revision });
                      return `已把 r${entry.revision} 发布为 r${result.revision}`;
                    }) }, confirmRollback === entry.revision ? "确认回滚" : "回滚"),
                  ]),
                ),
                h("div", { style: { display: "flex", gap: "8px" } }, [h("button", { key: "latest", type: "button", style: styles.linkButton, disabled: busy, onClick: () => act(async () => {
                  await postJson("/api/hnflow/pin", { workspace: flow.workspace, flow: flow.alias || flow.flowId, revision: null });
                  return "引用改为跟随最新版本";
                }) }, "跟随最新")]),
              ),
            ),
        h("div", { style: styles.cardTitle }, "启动输入（JSON）"),
        h("textarea", { style: styles.input, value: input, onChange: (event) => setInput(event.target.value), spellCheck: false }),
        h("div", null, h("button", { type: "button", style: styles.button, disabled: busy, onClick: () => props.onRun(flow, input) }, "用这份输入运行")),
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
            h("span", { style: styles.meta }, `${run.runId} · ${shortPath(run.workspace)} · ${run.source === "local" ? "项目草稿" : `r${run.revision ?? "latest"}`}`),
            run.health && run.health.message ? h("span", { style: { ...styles.meta, flex: "1 1 100%", whiteSpace: "normal" } }, run.health.message) : null,
          ),
        ),
      );
    }

    /**
     * One run's node timeline, artifacts, usage and controls.
     * @param {{run: Record<string, any> | null, definition: Record<string, any> | null, onCancel?: Function, onResume?: Function, busy?: boolean}} props - run.
     * @returns {unknown} element.
     */
    function RunPane(props) {
      const run = props?.run;
      const [artifact, setArtifact] = react.useState(null);
      const [error, setError] = react.useState("");
      react.useEffect(() => {
        setArtifact(null);
        setError("");
      }, [run === null || run === undefined ? "" : run.runId]);
      if (run === null) return h("div", { style: styles.empty }, "选择左侧的运行查看节点状态");
      /**
       * Load one artifact on demand.
       * @param {string} artifactId - artifact id.
       * @returns {Promise<void>} resolves once shown.
       */
      const viewArtifact = async (artifactId) => {
        try {
          const payload = await fetchArtifact(artifactId);
          setArtifact(payload.artifact);
        } catch (failure) {
          setError(`${failure.code ?? "artifact-failed"}: ${failure.message}`);
        }
      };
      const artifacts = Array.isArray(run.artifacts) ? run.artifacts : Object.values(run.artifacts ?? {});
      const nodes = Array.isArray(run.nodes) ? run.nodes : Object.entries(run.nodes ?? {}).map(([id, state]) => ({ id, ...state }));
      const cancellable = run.status === "running" || run.status === "waiting_human" || run.status === "interrupted";
      return h(
        "div",
        { style: styles.pane },
        h("div", { style: styles.meta }, `${run.runId} · ${run.status} · ${run.source === "override" ? "草稿覆盖" : run.source === "local" ? "项目草稿" : `r${run.revision ?? "latest"}`} · ${shortPath(run.workspace)}`),
        run.health && run.health.message
          ? h("div", { style: { ...styles.meta, color: run.health.code === "ok" ? undefined : "var(--dsw-alias-label-warning, #d29922)" } }, `状态说明：${run.health.message}`)
          : null,
        run.trigger ? h("div", { style: styles.meta }, `由触发器启动：${run.trigger.source} · ${run.trigger.triggerId ?? ""}`) : null,
        run.recovery ? h("div", { style: styles.meta }, `恢复说明：${run.recovery.reason === "host-restarted" ? "宿主重启后自动续跑" : String(run.recovery.reason ?? "")}`) : null,
        run.error !== null && run.error !== undefined ? h("div", { style: styles.errorBox }, `${run.error.code}: ${run.error.message}`) : null,
        error.length > 0 ? h("div", { style: styles.errorBox }, error) : null,
        cancellable && typeof props.onCancel === "function"
          ? h("div", { style: { display: "flex", gap: "8px" } }, [
              h("button", { key: "cancel", type: "button", style: styles.button, disabled: props.busy, onClick: () => props.onCancel(run) }, "取消运行"),
              run.status === "interrupted"
                ? h("button", { key: "resume", type: "button", style: { ...styles.button, ...styles.buttonPrimary }, disabled: props.busy, onClick: () => props.onResume(run) }, "继续运行")
                : null,
            ])
          : null,
        props.definition !== null ? h(FlowCanvas, { definition: props.definition, run }) : null,
        run.usage !== null && run.usage !== undefined
          ? h("div", { style: styles.meta }, `累计 token：${run.usage.totalTokens}（输入 ${run.usage.inputTokens} / 输出 ${run.usage.outputTokens}，${run.usage.calls} 次模型调用）`)
          : h("div", { style: styles.meta }, "累计 token：未采集（子会话已结束）"),
        (run.degradations ?? []).length > 0
          ? h("div", { style: styles.warnBox }, `降级：${run.degradations.map((entry) => `${entry.nodeId}→${(entry.fallbackNodeIds ?? []).join("|")}（${entry.code}）`).join("；")}`)
          : null,
        h("div", { style: styles.cardTitle }, "节点"),
        ...nodes.map((node) =>
          h("div", { key: node.id, style: styles.row }, [
            h("span", { key: "id", style: { ...styles.cell, flex: "0 0 130px" } }, node.id),
            h("span", { key: "st", style: { ...styles.cell, flex: "0 0 90px" } }, node.status),
            h("span", { key: "at", style: { ...styles.cell, flex: "0 0 60px" } }, node.attempts > 1 ? `×${node.attempts}` : ""),
            h("span", { key: "dg", style: { ...styles.cell, flex: "1 1 auto" } }, node.diagnostic ? `${node.diagnostic.code}: ${node.diagnostic.message}` : ""),
            node.usage !== null && node.usage !== undefined ? h("span", { key: "tok", style: styles.meta }, `${node.usage.totalTokens} tok`) : null,
            typeof node.artifactId === "string" ? h("button", { key: "art", type: "button", style: styles.linkButton, onClick: () => void viewArtifact(node.artifactId) }, "产物") : null,
          ]),
        ),
        artifacts.length > 0 ? h("div", { style: styles.cardTitle }, "产物") : null,
        artifacts.length > 0
          ? h(
              "div",
              { style: styles.card },
              ...artifacts.map((entry) =>
                h("div", { key: entry.artifactId, style: { ...styles.row, cursor: "default" } }, [
                  h("span", { key: "n", style: { ...styles.cell, flex: "0 0 130px" } }, entry.nodeId),
                  h("span", { key: "k", style: styles.meta }, `${entry.kind}${entry.degraded ? " · 降级" : ""}${entry.accepted === true ? " · 已接受" : ""}`),
                  h("button", { key: "v", type: "button", style: styles.linkButton, onClick: () => void viewArtifact(entry.artifactId) }, "查看"),
                ]),
              ),
            )
          : null,
        artifact === null
          ? null
          : h(
              "div",
              { style: styles.card },
              h("div", { style: styles.cardTitle }, `产物 ${artifact.artifactId} · ${artifact.nodeId}`),
              h("div", { style: styles.meta }, `${artifact.kind} · ${artifact.source}${artifact.degraded ? " · 降级" : ""}${artifact.accepted === true ? " · 已接受" : ""}`),
              h("pre", { style: styles.pre }, JSON.stringify(artifact.value ?? null, null, 2)),
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
            h("div", { style: styles.cardTitle }, `${item.stageLabel ?? (item.kind === "gate" ? "门禁" : "人工交付")} · ${item.flowName ?? ""} · ${item.nodeId}`),
            item.summary ? h("div", { style: { ...styles.meta, whiteSpace: "normal" } }, item.summary) : null,
            h("div", { style: styles.meta }, `run ${item.runId} · ${item.id}${item.attempts > 0 ? ` · 已退回 ${item.attempts} 次` : ""}${item.expired === true ? " · 已过期（仍可处理）" : ""}`),
            h("div", { style: styles.meta }, `流程 r${item.flowRevision ?? "?"}（${item.flowSource ?? "latest"}）· 提问通道 ${item.askedVia ?? "inbox"} · 下游节点 ${(item.consumerNodeIds ?? []).join(", ") || "无"}`),
            item.lastDiagnostic
              ? h("div", { style: { ...styles.meta, whiteSpace: "pre-wrap" } }, `上次未通过：${item.lastDiagnostic.code}: ${item.lastDiagnostic.message}${(item.lastViolations ?? []).length > 0 ? `（${item.lastViolations.length} 处不满足契约）` : ""}`)
              : null,
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
     * Read-only automation panel: triggers, durable effects, last pass.
     *
     * The owner writes triggers as a file (`<workspace>/.hnflow/triggers.json`);
     * this panel only explains what the plugin saw, including parse errors, so
     * a typo is visible without reading logs.
     * @param {{triggers?: Record<string, any>[], automation?: Record<string, any> | null, facts?: Record<string, any> | null}} props - snapshot slices.
     * @returns {unknown} element.
     */
    function AutomationPanel(props) {
      const triggers = Array.isArray(props?.triggers) ? props.triggers : [];
      const automation = props?.automation ?? null;
      const facts = props?.facts ?? null;
      const effects = automation?.effects ?? null;
      const pass = automation?.pass ?? null;
      const errors = Array.isArray(automation?.errors) ? automation.errors : [];
      const channels = Array.isArray(facts?.channels) ? facts.channels : [];
      /**
       * Human-readable trigger condition.
       * @param {Record<string, any>} trigger - trigger row.
       * @returns {string} condition.
       */
      const condition = (trigger) => {
        if (trigger.source === "cron") return `cron ${trigger.cron}`;
        if (trigger.source === "file") return `文件 ${(trigger.watch ?? []).join(", ")}`;
        return `流程完成后 · ${trigger.after}`;
      };
      return h(
        "div",
        { style: styles.card },
        h("div", { style: styles.cardTitle }, "自动化"),
        h(
          "div",
          { style: styles.meta },
          `触发器 ${facts?.triggersEnabled === false ? "已关闭" : "已启用"} · 扫描间隔 ${facts?.passIntervalMs ?? "?"} ms · 运行预算 ${Math.round(Number(facts?.runBudgetMs ?? 0) / 60000)} 分钟`,
        ),
        triggers.length === 0
          ? h("div", { style: styles.meta }, "没有触发器。在 <工作区>/.hnflow/triggers.json 里声明 cron、file 或 run-completed。")
          : h(
              "div",
              null,
              ...triggers.map((trigger) =>
                h("div", { key: `${trigger.workspace}:${trigger.id}`, style: styles.row }, [
                  h("span", { key: "id", style: { ...styles.cell, flex: "0 0 150px" } }, trigger.id),
                  h("span", { key: "src", style: { ...styles.cell, flex: "0 0 90px" } }, trigger.source),
                  h("span", { key: "when", style: { ...styles.cell, flex: "1 1 auto" } }, `${condition(trigger)} → ${trigger.flow}`),
                  h("span", { key: "last", style: styles.meta }, trigger.lastFiredAt ? `上次 ${trigger.lastFiredAt}` : "尚未触发"),
                ]),
              ),
            ),
        errors.length > 0 ? h("div", { style: styles.warnBox }, `触发器问题：${errors.join("；")}`) : null,
        effects === null
          ? null
          : h(
              "div",
              { style: styles.meta },
              `副作用队列：待处理 ${effects.pending} · 已完成 ${effects.done} · 放弃 ${effects.dead}${Array.isArray(effects.recent) && effects.recent.length > 0 ? ` · 最近 ${effects.recent.slice(0, 3).map((entry) => `${entry.kind}/${entry.status}`).join("，")}` : ""}`,
            ),
        pass === null || pass === undefined
          ? null
          : h(
              "div",
              { style: styles.meta },
              `上次扫描：${pass.at ?? "尚未"}${pass.error ? `（失败：${pass.error}）` : ` · 过期 ${pass.expired} · 副作用 ${pass.effects} · 触发 ${pass.triggers} · 续推 ${pass.advanced}`}`,
            ),
        channels.length > 0 ? h("div", { style: styles.meta }, `通知通道：${channels.map((channel) => `${channel.title ?? channel.id}${channel.enabled === false ? "（关）" : ""}`).join("，")}`) : null,
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
       * Cancel or resume a run, then refresh its detail.
       * @param {'cancel'|'resume'} action - route.
       * @param {Record<string, any>} run - run summary.
       * @returns {Promise<void>} resolves once done.
       */
      const controlRun = async (action, run) => {
        setBusy(true);
        try {
          await postJson(`/api/hnflow/${action}`, { runId: run.runId });
          setMessage(action === "cancel" ? `已请求取消 ${run.runId}` : `已继续 ${run.runId}`);
          await reload();
          const full = await fetchRun(run.runId);
          setSelectedRun(full.run);
        } catch (failure) {
          setError(`${failure.code ?? `${action}-failed`}: ${failure.message}`);
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
          if (selectedRun !== null && selectedRun.runId === item.runId) {
            try {
              const full = await fetchRun(item.runId);
              setSelectedRun(full.run);
            } catch {
              // the list still reflects the new status
            }
          }
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
          if (selectedRun !== null && selectedRun.runId === item.runId) {
            try {
              const full = await fetchRun(item.runId);
              setSelectedRun(full.run);
            } catch {
              // the list still reflects the new status
            }
          }
        } catch (failure) {
          setError(`${failure.code ?? "deliver-failed"}: ${failure.message}`);
        } finally {
          setBusy(false);
        }
      };

      const groups = Array.isArray(state?.workspaces) ? state.workspaces : [];
      const assets = Array.isArray(state?.library) ? state.library : [];
      const runs = Array.isArray(state?.runs) ? state.runs : [];
      const inbox = Array.isArray(state?.inbox) ? state.inbox : [];
      const triggers = Array.isArray(state?.triggers) ? state.triggers : [];
      const automation = state?.automation ?? null;
      const facts = state?.facts ?? null;

      /**
       * Reference one library asset in a workspace.
       * @param {string} workspace - workspace root.
       * @param {Record<string, any>} asset - library asset.
       * @returns {Promise<void>} resolves once refreshed.
       */
      const addAsset = async (workspace, asset) => {
        setBusy(true);
        try {
          const added = await postJson("/api/hnflow/add", { workspace, flowId: asset.id });
          setMessage(`已引用 ${asset.name}${added.alias ? `（别名 ${added.alias}）` : ""}`);
          await reload();
        } catch (failure) {
          setError(`${failure.code ?? "add-failed"}: ${failure.message}`);
        } finally {
          setBusy(false);
        }
      };

      const pickFlow = async (workspace, entry) => {
        setSelectedFlow({ ...entry, workspace, definition: null });
        try {
          const resolved = await fetchFlow(workspace, entry.alias || entry.flowId);
          setSelectedFlow({ ...entry, ...resolved.flow, workspace, alias: resolved.flow.alias || entry.alias || resolved.flow.flowId, definition: resolved.flow.definition, lockfile: resolved.flow.lockfile });
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

      const left = tab === "flows" ? h(FlowTree, { groups, assets, selected: selectedFlow === null ? "" : `${selectedFlow.workspace}:${flowLabel(selectedFlow)}`, targetWorkspace: selectedFlow?.workspace ?? groups[0]?.path ?? "", onPick: (workspace, entry) => void pickFlow(workspace, entry), onAdd: (workspace, asset) => void addAsset(workspace, asset) }) : tab === "runs" ? h(RunsBoard, { runs, selected: selectedRun?.runId ?? "", onPick: (run) => void pickRun(run) }) : null;

      const right =
        tab === "flows"
          ? h(FlowPane, { flow: selectedFlow, busy, message, onChanged: () => void reload(), onPromoted: (promoted) => { setSelectedFlow(null); setSelectedRun(null); setMessage(`已提升为 ${promoted.flowId}（r1），后续修改仍需人工发布。`); void reload(); }, onRun: (flow, text) => void startRun(flow, text) })
          : tab === "runs"
            ? h(RunPane, { run: selectedRun, definition: selectedFlow?.definition ?? null, busy, onCancel: (run) => void controlRun("cancel", run), onResume: (run) => void controlRun("resume", run) })
            : h("div", { style: styles.pane }, h(InboxView, { items: inbox, busy, onGate: (item, decision) => void decide(item, decision), onDeliver: (item, text) => void deliver(item, text) }), h(AutomationPanel, { triggers, automation, facts }));

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
