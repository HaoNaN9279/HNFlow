// HNFlow browser half for DeepSeek Harness.
//
// Shipped as a prebuilt client bundle: a factory registered on the module
// loader. Only React and react-dom (platform-seeded modules) are required, so no
// build step is involved.
//
// The entry point is a compact "HNFlow" control in `conversation.input.left` —
// the left side of the composer strip, next to the model picker. It opens a
// popover with a list of the workspace's workflows, a read-only canvas of the
// selected definition, and a few command shortcuts to the host's `/workflow`
// commands.
//
// The client never reads the asset files and never talks to the engine: every
// piece of data and every write goes through a host command, so the panel obeys
// exactly the same rules as typing the command by hand.
window.__ModuleLoader__.load({
  id: "dsh-hnflow",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const reactDom = require("react-dom");
    const h = react.createElement;

    /** Services this client plugin consumes. */
    const inject = ["slots", "remote", "remote.commands"];

    /** Slot entry id, unique inside the composer strip. */
    const ENTRY_ID = "hnflow-panel";

    /** Agent preset this panel belongs to. */
    const PRESET_ID = "hnflow";

    /** Host command that answers with the panel payload (JSON text). */
    const PANEL_COMMAND = "/workflow panel";

    /** Popover width, also used when the anchor is clamped into the viewport. */
    const PANEL_WIDTH = 380;

    /**
     * Panel views, in tab order.
     *
     * A row is either a view the panel renders itself (`kind: "view"`) or a
     * read-only action that forwards to a host command. Ids and labels must stay
     * unique: an earlier revision listed "待办" as a view *and* as an action, so
     * the same label appeared twice in the row while the two buttons did
     * different things.
     */
    const VIEWS = [
      { id: "workflows", label: "工作流", hint: "工作区引用的工作流" },
      { id: "inbox", label: "待办", hint: "等待人工的任务" },
    ];

    /** Read-only actions offered next to the views. */
    const ACTIONS = [{ id: "assets", label: "资产库", command: "/workflow asset list", hint: "资产库列表" }];

    /** Read-only canvas geometry. Mirrors the editor's grid fallback. */
    const CANVAS = { columns: 3, stepX: 220, stepY: 130, width: 170, height: 62, padding: 16 };

    /** Menu ids stay unique per mounted panel. */
    let panelSeq = 0;

    const styles = {
      root: { position: "relative", display: "inline-flex", alignItems: "center" },
      trigger: {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        height: "28px",
        padding: "0 8px",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        border: "none",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontFamily: "inherit",
        fontSize: "13px",
        fontWeight: 500,
        lineHeight: "20px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      },
      triggerOpen: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.18))" },
      menu: {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        boxSizing: "border-box",
        width: `${PANEL_WIDTH}px`,
        maxHeight: "420px",
        overflow: "auto",
        overscrollBehavior: "contain",
        padding: "8px",
        borderRadius: "var(--dsw-radius-lg, 12px)",
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
        background: "var(--dsw-specific-menu, var(--dsw-specific-input-major, #1f1f1f))",
        boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.28))",
        zIndex: 1100,
      },
      tabs: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" },
      tab: {
        padding: "3px 8px",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        border: "1px solid transparent",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary, inherit)",
        fontFamily: "inherit",
        fontSize: "12px",
        cursor: "pointer",
      },
      tabActive: {
        borderColor: "var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
        color: "var(--dsw-alias-label-primary, inherit)",
      },
      body: {
        margin: 0,
        maxHeight: "320px",
        overflow: "auto",
        fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
        fontSize: "11px",
        lineHeight: "16px",
        whiteSpace: "pre-wrap",
        color: "var(--dsw-alias-label-secondary, inherit)",
      },
      list: { display: "flex", flexDirection: "column", gap: "2px", margin: 0, padding: 0, listStyle: "none" },
      item: {
        display: "flex",
        flexDirection: "column",
        gap: "1px",
        width: "100%",
        padding: "5px 8px",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        border: "none",
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: "12px",
        cursor: "pointer",
      },
      itemActive: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.16))" },
      meta: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, inherit)" },
      canvas: { width: "100%", height: "240px", display: "block", borderRadius: "var(--dsw-radius-sm, 6px)", background: "rgba(127,127,127,0.06)" },
      node: { fill: "rgba(127,127,127,0.14)", stroke: "rgba(127,127,127,0.45)", strokeWidth: 1 },
      nodeActive: { fill: "rgba(110,150,255,0.28)", stroke: "rgba(110,150,255,0.9)" },
      nodeLabel: { fontSize: "9px", fill: "currentColor", pointerEvents: "none" },
      edge: { stroke: "rgba(127,127,127,0.55)", strokeWidth: 1.2, fill: "none" },
      editor: { display: "flex", flexDirection: "column", gap: "4px" },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: "72px",
        padding: "6px 8px",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
        background: "rgba(127,127,127,0.08)",
        color: "var(--dsw-alias-label-primary, inherit)",
        fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
        fontSize: "11px",
        lineHeight: "16px",
        resize: "vertical",
      },
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
     * The popover's row of views and actions.
     *
     * Deduped by id *and* label: a repeated row is unreadable and, when the two
     * copies carry different handlers, actively misleading.
     * @returns {{id: string, label: string, kind: "view" | "action", command?: string, hint: string}[]} unique rows, in render order.
     */
    function menuItems() {
      const rows = [
        ...VIEWS.map((view) => ({ id: view.id, label: view.label, kind: "view", hint: view.hint })),
        ...ACTIONS.map((action) => ({ id: action.id, label: action.label, kind: "action", command: action.command, hint: action.hint })),
      ];
      /** @type {Set<string>} */
      const ids = new Set();
      /** @type {Set<string>} */
      const labels = new Set();
      return rows.filter((row) => {
        if (ids.has(row.id) || labels.has(row.label)) return false;
        ids.add(row.id);
        labels.add(row.label);
        return true;
      });
    }

    /**
     * Place the popover against its trigger.
     *
     * Above the trigger when there is room for a usable panel, otherwise below;
     * horizontally clamped so a narrow window or a trigger near the right edge
     * cannot push the panel off screen. `maxHeight` keeps the panel inside the
     * viewport so content never spills over the composer — spilled content would
     * stay clickable in a place that no longer matches what the user sees.
     * @param {{left: number, top: number, right: number, bottom: number}} rect - trigger rect.
     * @param {{width: number, height: number}} viewport - window size.
     * @param {number} [panelWidth] - preferred width.
     * @returns {{placement: "above" | "below", left: number, width: number, maxHeight: number, top?: number, bottom?: number}} fixed-position numbers.
     */
    function placeMenu(rect, viewport, panelWidth = PANEL_WIDTH) {
      const margin = 8;
      const gap = 6;
      const width = Math.min(panelWidth, Math.max(160, viewport.width - margin * 2));
      const left = Math.round(Math.min(Math.max(margin, rect.left), Math.max(margin, viewport.width - width - margin)));
      const spaceAbove = Math.round(rect.top) - gap - margin;
      const spaceBelow = Math.round(viewport.height - rect.bottom) - gap - margin;
      const maxHeight = Math.max(120, Math.min(420, Math.max(spaceAbove, spaceBelow)));
      if (spaceAbove >= 200 || spaceAbove >= spaceBelow) {
        return { placement: "above", left, width, maxHeight: Math.min(maxHeight, Math.max(120, spaceAbove)), bottom: Math.round(viewport.height - rect.top) + gap };
      }
      return { placement: "below", left, width, maxHeight: Math.min(maxHeight, Math.max(120, spaceBelow)), top: Math.round(rect.bottom) + gap };
    }

    /**
     * Drop repeated workflow rows, keeping the first occurrence of each key.
     * @param {unknown} list - candidate entries.
     * @returns {Record<string, any>[]} unique entries.
     */
    function dedupeWorkflows(list) {
      if (!Array.isArray(list)) return [];
      /** @type {Set<string>} */
      const seen = new Set();
      /** @type {Record<string, any>[]} */
      const out = [];
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        const key = entry.alias || entry.assetId;
        if (typeof key !== "string" || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
      return out;
    }

    /**
     * Parse the `/workflow panel` payload.
     * @param {string} text - command output.
     * @returns {{workflows: Record<string, any>[], selected: Record<string, any> | null} | null} payload or null.
     */
    function parsePanelPayload(text) {
      let parsed;
      try {
        parsed = JSON.parse(String(text ?? ""));
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.workflows)) return null;
      return { workflows: dedupeWorkflows(parsed.workflows), selected: typeof parsed.selected === "object" ? parsed.selected : null };
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
     * Build the command that stores one node's edited params.
     * @param {string} key - workflow alias or asset id.
     * @param {string} nodeId - node to edit.
     * @param {string} json - params JSON as typed.
     * @returns {string} command line.
     */
    function nodeCommand(key, nodeId, json) {
      return `/workflow node ${key} ${nodeId} ${json}`;
    }

    /**
     * Build the two-step "write back to the asset" command.
     * @param {string} key - workflow alias or asset id.
     * @param {boolean} confirmed - whether the user confirmed the diff.
     * @returns {string} command line.
     */
    function saveAssetCommand(key, confirmed) {
      return confirmed ? `/workflow save asset ${key} --yes` : `/workflow save asset ${key}`;
    }

    /**
     * Parse the `/workflow inbox` payload.
     * @param {string} text - command output.
     * @returns {Record<string, any>[] | null} tasks, or null when unreadable.
     */
    function parseInbox(text) {
      let parsed;
      try {
        parsed = JSON.parse(String(text ?? ""));
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) return null;
      /** @type {Set<string>} */
      const seen = new Set();
      return parsed.tasks
        .filter((task) => task !== null && typeof task === "object" && typeof task.taskId === "string")
        .filter((task) => {
          if (seen.has(task.taskId)) return false;
          seen.add(task.taskId);
          return true;
        });
    }

    /**
     * A payload skeleton for one task.
     * @param {Record<string, any>} task - pending task summary.
     * @returns {string} JSON text to prefill the editor.
     */
    function taskTemplate(task) {
      if (task.kind === "review") return JSON.stringify({ decision: true, feedback: "" }, null, 2);
      const ports = Array.isArray(task.outputSpec && task.outputSpec.ports) ? task.outputSpec.ports : [];
      /** @type {Record<string, any>} */
      const payload = {};
      for (const port of ports) {
        if (typeof port.name !== "string") continue;
        payload[port.name] = port.type === "bool" ? false : "";
      }
      return JSON.stringify(payload, null, 2);
    }

    /**
     * Build the submission command for one task.
     * @param {string} taskId - task id.
     * @param {string} json - payload as typed.
     * @returns {string} command line.
     */
    function submitCommand(taskId, json) {
      return `/workflow submit ${taskId} ${json}`;
    }

    /**
     * Whether the session runs the HNFlow preset.
     *
     * The `agentPreset` projection is the preset id as a plain string; an older
     * shape carried `{ id }`. An absent projection means "not known yet", which
     * must not hide the control.
     * @param {unknown} preset - projection value.
     * @returns {boolean} true when the control should render.
     */
    function isHnflowPreset(preset) {
      if (preset === null || preset === undefined) return true;
      if (typeof preset === "string") return preset === PRESET_ID;
      if (typeof preset === "object" && typeof preset.id === "string") return preset.id === PRESET_ID;
      return true;
    }

    /**
     * The composer-strip control.
     * @param {Record<string, unknown>} props - slot props plus the inject face.
     * @returns {unknown} React element or null when the mode is not HNFlow.
     */
    function Panel(props) {
      const preset = typeof props.useProjection === "function" ? props.useProjection("agentPreset") : null;
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [payload, setPayload] = react.useState(null);
      const [view, setView] = react.useState("workflows");
      const [text, setText] = react.useState("");
      const [selectedKey, setSelectedKey] = react.useState(null);
      const [nodeId, setNodeId] = react.useState(null);
      const [draft, setDraft] = react.useState("");
      const [confirmSave, setConfirmSave] = react.useState(false);
      const [tasks, setTasks] = react.useState(null);
      const [taskId, setTaskId] = react.useState(null);
      const [taskDraft, setTaskDraft] = react.useState("");
      const [placement, setPlacement] = react.useState(null);
      const rootRef = react.useRef(null);
      const triggerRef = react.useRef(null);
      const menuRef = react.useRef(null);
      const menuId = react.useRef(null);
      if (menuId.current === null) {
        panelSeq += 1;
        menuId.current = "hnflow-panel-" + panelSeq;
      }

      /**
       * Measure the trigger and place the popover against it.
       * @returns {void}
       */
      const measure = () => {
        const trigger = triggerRef.current;
        if (!trigger || typeof trigger.getBoundingClientRect !== "function" || typeof window === "undefined") return;
        setPlacement(placeMenu(trigger.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
      };

      // Measure after mount (and on every viewport change) instead of once inside
      // the click handler: the measured box must match what is on screen.
      react.useLayoutEffect(() => {
        if (!open) return undefined;
        measure();
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
          window.removeEventListener("resize", measure);
          window.removeEventListener("scroll", measure, true);
        };
      }, [open]);

      // The portal lives outside the trigger, so closing on outside press has to
      // consult both boxes explicitly.
      react.useEffect(() => {
        if (!open) return undefined;
        const isInside = (node, target) => node !== null && node !== undefined && typeof node.contains === "function" && node.contains(target);
        const onPointerDown = (event) => {
          if (isInside(rootRef.current, event.target) || isInside(menuRef.current, event.target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("mousedown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);

      if (!isHnflowPreset(preset)) return null;

      /**
       * Run a raw command and show its text.
       * @param {string} command - `/workflow …` command line.
       * @returns {Promise<void>} resolves once shown.
       */
      const runText = async (command) => {
        setBusy(true);
        try {
          setPayload(null);
          setText(await props.run(command));
        } catch (error) {
          setPayload(null);
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Load the panel payload (list + one definition), optionally for one key.
       * @param {string | null} key - workflow alias or asset id.
       * @returns {Promise<void>} resolves once loaded.
       */
      const loadPanel = async (key) => {
        setBusy(true);
        try {
          const next = parsePanelPayload(await props.run(key === null ? PANEL_COMMAND : `${PANEL_COMMAND} ${key}`));
          setSelectedKey(key);
          setNodeId(null);
          if (next === null) {
            setPayload(null);
            setText("panel payload unavailable");
            return;
          }
          setPayload(next);
          setText("");
        } catch (error) {
          setPayload(null);
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Load the pending human tasks.
       * @returns {Promise<void>} resolves once loaded.
       */
      const loadTasks = async () => {
        setBusy(true);
        try {
          const next = parseInbox(await props.run("/workflow inbox"));
          setTasks(next === null ? [] : next);
          setTaskId(null);
          setTaskDraft("");
          setText(next === null ? "inbox payload unavailable" : "");
        } catch (error) {
          setTasks([]);
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Answer the selected task.
       * @returns {Promise<void>} resolves once submitted and reloaded.
       */
      const submitTask = async () => {
        if (taskId === null) return;
        setBusy(true);
        try {
          const message = await props.run(submitCommand(taskId, taskDraft));
          await loadTasks();
          setText(message);
        } catch (error) {
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Open or close the popover.
       * @returns {void}
       */
      const toggle = () => {
        const next = !open;
        setOpen(next);
        if (!next) return;
        setView("workflows");
        void loadPanel(null);
      };

      const trigger = h(
        "button",
        {
          type: "button",
          ref: triggerRef,
          "aria-haspopup": "dialog",
          "aria-expanded": open ? "true" : "false",
          "aria-controls": open ? menuId.current : undefined,
          title: "HNFlow 工作流",
          style: open ? { ...styles.trigger, ...styles.triggerOpen } : styles.trigger,
          onClick: toggle,
        },
        h("span", { style: { fontSize: "10px", lineHeight: "1", opacity: 0.8 } }, "\u25C6"),
        h("span", null, "HNFlow"),
      );

      if (!open) return h("span", { ref: rootRef, style: styles.root }, trigger);

      const selected = payload === null ? null : payload.selected;
      const layout = selected === null ? null : layoutDefinition(selected.definition);
      const activeNode = layout === null || nodeId === null ? null : layout.nodes.find((node) => node.id === nodeId) ?? null;
      const definition = selected === null ? null : selected.definition;
      const activeParams = activeNode === null || definition === null ? null : (definition.nodes ?? []).find((node) => String(node.id) === activeNode.id) ?? null;

      /**
       * Show one node on the canvas and load its params into the editor.
       * @param {Record<string, any>} node - laid-out node.
       * @returns {void}
       */
      const selectNode = (node) => {
        setNodeId(node.id);
        const entry = definition === null ? null : (definition.nodes ?? []).find((candidate) => String(candidate.id) === node.id) ?? null;
        setDraft(JSON.stringify(entry === null || entry.params === undefined ? {} : entry.params, null, 2));
      };

      /**
       * Store the edited params as the workspace override.
       * @returns {Promise<void>} resolves once stored and reloaded.
       */
      const saveNode = async () => {
        if (selected === null || nodeId === null) return;
        setBusy(true);
        try {
          const message = await props.run(nodeCommand(selected.key, nodeId, draft));
          await loadPanel(selected.key);
          setText(message);
        } catch (error) {
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Drop the workspace override for the selected workflow.
       * @returns {Promise<void>} resolves once reloaded.
       */
      const resetOverride = async () => {
        if (selected === null) return;
        setBusy(true);
        try {
          const message = await props.run(`/workflow override reset ${selected.key}`);
          await loadPanel(selected.key);
          setText(message);
        } catch (error) {
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Ask the host for the diff a save would apply (the dry run).
       * @returns {Promise<void>} resolves once the diff is shown.
       */
      const previewSave = async () => {
        if (selected === null) return;
        setBusy(true);
        try {
          setText(await props.run(saveAssetCommand(selected.key, false)));
          setConfirmSave(true);
        } catch (error) {
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Write the workspace override back to the asset.
       * @returns {Promise<void>} resolves once stored and reloaded.
       */
      const confirmSaveAsset = async () => {
        if (selected === null) return;
        setBusy(true);
        try {
          const message = await props.run(saveAssetCommand(selected.key, true));
          setConfirmSave(false);
          await loadPanel(selected.key);
          setText(message);
        } catch (error) {
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      const workflowSections = [
        payload !== null && payload.workflows.length > 0
          ? h(
              "ul",
              { style: styles.list, key: "workflows" },
              ...payload.workflows.map((entry) =>
                h(
                  "li",
                  { key: entry.assetId },
                  h(
                    "button",
                    {
                      type: "button",
                      style: selected !== null && selected.key === (entry.alias || entry.assetId) ? { ...styles.item, ...styles.itemActive } : styles.item,
                      onClick: () => void loadPanel(entry.alias || entry.assetId),
                    },
                    h("span", null, `${entry.alias || entry.assetId}${entry.hasOverride ? " ·覆盖" : ""}${entry.drift ? " ·漂移" : ""}${entry.missing ? " ·缺失" : ""}`),
                    h("span", { style: styles.meta }, `${entry.assetId} · r${entry.pinnedRevision ?? "latest"}/${entry.currentRevision ?? "?"}${entry.description ? ` · ${entry.description}` : ""}`),
                  ),
                ),
              ),
            )
          : null,
        layout === null
          ? null
          : h(
              "svg",
              { key: "canvas", viewBox: `0 0 ${layout.width} ${layout.height}`, style: styles.canvas, role: "img", "aria-label": "workflow canvas" },
              ...layout.edges.map((edge) => h("path", { key: edge.id, d: edge.path, style: styles.edge })),
              ...layout.nodes.map((node) =>
                h("g", { key: node.id, onClick: () => selectNode(node), style: { cursor: "pointer" } }, [
                  h("rect", { key: "r", x: node.x, y: node.y, width: node.width, height: node.height, rx: 8, style: nodeId === node.id ? styles.nodeActive : styles.node }),
                  h("text", { key: "t", x: node.x + 8, y: node.y + 20, style: styles.nodeLabel }, node.id),
                  h("text", { key: "ty", x: node.x + 8, y: node.y + 36, style: styles.nodeLabel }, node.type),
                ]),
              ),
            ),
        activeParams === null
          ? null
          : h(
              "div",
              { key: "node-editor", style: styles.editor },
              h("textarea", {
                value: draft,
                rows: 6,
                spellCheck: false,
                "aria-label": `params for ${activeParams.id}`,
                style: styles.textarea,
                onChange: (event) => setDraft(event.target.value),
              }),
              h(
                "div",
                { style: styles.tabs },
                h("button", { type: "button", disabled: busy, style: styles.tab, onClick: () => void saveNode() }, "保存到工作区"),
                h("button", { type: "button", disabled: busy, style: styles.tab, onClick: () => void resetOverride() }, "撤销覆盖"),
              ),
            ),
        confirmSave
          ? h(
              "div",
              { key: "confirm-save", style: styles.tabs },
              h("button", { type: "button", disabled: busy, style: styles.tab, onClick: () => void confirmSaveAsset() }, "确认写入资产"),
              h("button", { type: "button", disabled: busy, style: styles.tab, onClick: () => setConfirmSave(false) }, "取消"),
            )
          : selected !== null && selected.source === "override"
            ? h(
                "div",
                { key: "save-asset", style: styles.tabs },
                h("button", { type: "button", disabled: busy, style: styles.tab, onClick: () => void previewSave() }, "保存回资产…"),
              )
            : null,
      ];

      const inboxSections = [
        tasks === null || tasks.length === 0
          ? h("div", { key: "empty", style: styles.meta }, tasks === null ? "…" : "没有待办")
          : h(
              "ul",
              { key: "tasks", style: styles.list },
              ...tasks.map((task) =>
                h(
                  "li",
                  { key: task.taskId },
                  h(
                    "button",
                    {
                      type: "button",
                      style: taskId === task.taskId ? { ...styles.item, ...styles.itemActive } : styles.item,
                      onClick: () => {
                        setTaskId(task.taskId);
                        setTaskDraft(taskTemplate(task));
                      },
                    },
                    h("span", null, `${task.taskId} · ${task.kind}`),
                    h("span", { style: styles.meta }, `run ${task.runId} · node ${task.nodeId}${task.description ? ` · ${task.description}` : ""}`),
                  ),
                ),
              ),
            ),
        taskId === null
          ? null
          : h(
              "div",
              { key: "task-editor", style: styles.editor },
              h("textarea", {
                value: taskDraft,
                rows: 5,
                spellCheck: false,
                "aria-label": `payload for ${taskId}`,
                style: styles.textarea,
                onChange: (event) => setTaskDraft(event.target.value),
              }),
              h(
                "div",
                { style: styles.tabs },
                h("button", { type: "button", disabled: busy, style: styles.tab, onClick: () => void submitTask() }, "提交"),
                h("button", { type: "button", disabled: busy, style: styles.tab, onClick: () => { setTaskId(null); setTaskDraft(""); } }, "取消"),
              ),
            ),
      ];

      /**
       * Switch the popover to one row of the tab bar.
       *
       * View rows render content themselves; action rows only print command text.
       * @param {{id: string, kind: "view" | "action", command?: string}} row - menu row.
       * @returns {void}
       */
      const selectRow = (row) => {
        if (row.kind !== "view") {
          setView("text");
          setText("");
          void runText(row.command);
          return;
        }
        if (row.id === "inbox") {
          setView("inbox");
          void loadTasks();
          return;
        }
        setView("workflows");
        void loadPanel(selectedKey);
      };

      const body = h(
        "div",
        {
          ref: menuRef,
          role: "dialog",
          "aria-label": "HNFlow",
          id: menuId.current,
          style: {
            ...styles.menu,
            ...(placement === null
              ? { position: "fixed", left: "8px", bottom: "96px", visibility: "hidden" }
              : {
                  position: "fixed",
                  left: `${placement.left}px`,
                  width: `${placement.width}px`,
                  maxHeight: `${placement.maxHeight}px`,
                  ...(placement.placement === "above" ? { bottom: `${placement.bottom}px` } : { top: `${placement.top}px` }),
                }),
          },
        },
        h(
          "div",
          { style: styles.tabs, role: "tablist" },
          ...menuItems().map((row) =>
            h(
              "button",
              {
                type: "button",
                key: row.id,
                role: row.kind === "view" ? "tab" : undefined,
                "aria-selected": row.kind === "view" ? (view === row.id ? "true" : "false") : undefined,
                title: row.hint,
                style: { ...styles.tab, ...(row.kind === "view" && view === row.id ? styles.tabActive : {}) },
                disabled: busy,
                onClick: () => selectRow(row),
              },
              row.label,
            ),
          ),
        ),
        ...(view === "inbox" ? inboxSections : view === "workflows" ? workflowSections : []),
        text.length > 0 ? h("pre", { key: "text", style: styles.body }, text) : null,
      );

      return h(
        "span",
        { ref: rootRef, style: styles.root },
        trigger,
        typeof document === "undefined" || reactDom.createPortal === undefined ? body : reactDom.createPortal(body, document.body),
      );
    }

    /** Contexts already wired; a repeated apply must not register a second panel. */
    const wired = new WeakSet();

    /**
     * Client plugin body.
     * @param {Record<string, unknown>} ctx - client context.
     * @returns {void}
     */
    function apply(ctx) {
      if (wired.has(ctx)) return;
      wired.add(ctx);
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          {
            name: "conversation.input.left",
            id: ENTRY_ID,
            order: 6,
            inject: (sessionId) => ({
              run: async (command) => {
                const result = await ctx.remote.commands.execute(sessionId, command, []);
                if (result && result.ok === false) {
                  const code = result.error && result.error.code ? result.error.code : "command-failed";
                  const message = result.error && result.error.message ? result.error.message : "";
                  throw new Error("hnflow: " + code + ": " + message);
                }
                return readText(result);
              },
            }),
          },
          Panel,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Pure helpers, exported for the contract tests. */
    exports.internals = {
      parsePanelPayload,
      layoutDefinition,
      edgePath,
      readText,
      nodeCommand,
      saveAssetCommand,
      parseInbox,
      taskTemplate,
      submitCommand,
      isHnflowPreset,
      menuItems,
      placeMenu,
    };
    return module.exports;
  },
});
