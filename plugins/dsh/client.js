// HNFlow browser half for DeepSeek Harness.
//
// Shipped as a prebuilt client bundle: a factory registered on the module
// loader. Only React and react-dom (platform-seeded modules) are required, so no
// build step is involved.
//
// The entry point is a compact "HNFlow" control in `conversation.input.left` —
// the left side of the composer strip, next to the model picker. It opens a
// popover that runs the host's `/workflow` commands and shows their text, which
// keeps every action on the same code path as typing the command by hand: the
// client never talks to the engine or the asset files directly.
//
// It renders only while the session runs the `hnflow` agent preset.
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

    /** Commands offered as buttons; the label is what the user reads. */
    const ACTIONS = [
      { label: "工作流", command: "/workflow", hint: "本工作区引用的工作流" },
      { label: "待办", command: "/workflow tasks", hint: "等待人工的任务" },
      { label: "资产", command: "/workflow asset list", hint: "资产库" },
    ];

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
        width: "320px",
        maxHeight: "360px",
        padding: "8px",
        borderRadius: "var(--dsw-radius-lg, 12px)",
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
        background: "var(--dsw-specific-menu, var(--dsw-specific-input-major, #1f1f1f))",
        boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.28))",
        zIndex: 1100,
      },
      actions: { display: "flex", gap: "4px", flexWrap: "wrap" },
      action: {
        padding: "4px 8px",
        borderRadius: "var(--dsw-radius-sm, 6px)",
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
        background: "transparent",
        color: "var(--dsw-alias-label-primary, inherit)",
        fontFamily: "inherit",
        fontSize: "12px",
        cursor: "pointer",
      },
      actionBusy: { opacity: 0.5, cursor: "default" },
      output: {
        margin: 0,
        maxHeight: "260px",
        overflow: "auto",
        fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
        fontSize: "11px",
        lineHeight: "16px",
        whiteSpace: "pre-wrap",
        color: "var(--dsw-alias-label-secondary, inherit)",
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
     * The composer-strip control.
     * @param {Record<string, unknown>} props - slot props plus the inject face.
     * @returns {unknown} React element or null when the mode is not HNFlow.
     */
    function Panel(props) {
      const preset = typeof props.useProjection === "function" ? props.useProjection("agentPreset") : null;
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [text, setText] = react.useState("");
      const triggerRef = react.useRef(null);
      const [anchor, setAnchor] = react.useState(null);
      const menuId = react.useRef(null);
      if (menuId.current === null) {
        panelSeq += 1;
        menuId.current = "hnflow-panel-" + panelSeq;
      }

      if (preset !== null && preset !== undefined && preset.id !== PRESET_ID) return null;

      /**
       * Run one command and show its result.
       * @param {string} command - `/workflow …` command line.
       * @returns {Promise<void>} resolves once the text is shown.
       */
      const run = async (command) => {
        setBusy(true);
        try {
          setText(await props.run(command));
        } catch (error) {
          setText(String(error && error.message ? error.message : error));
        } finally {
          setBusy(false);
        }
      };

      /**
       * Open or close the popover, anchoring it above the trigger.
       * @returns {void}
       */
      const toggle = () => {
        const next = !open;
        setOpen(next);
        if (!next) return;
        const rect = triggerRef.current && triggerRef.current.getBoundingClientRect ? triggerRef.current.getBoundingClientRect() : null;
        setAnchor(rect === null ? null : { left: rect.left, bottom: window.innerHeight - rect.top + 6 });
        void run("/workflow");
      };

      const trigger = h(
        "button",
        {
          type: "button",
          ref: triggerRef,
          "aria-haspopup": "dialog",
          "aria-expanded": open ? "true" : "false",
          title: "HNFlow 工作流",
          style: open ? { ...styles.trigger, ...styles.triggerOpen } : styles.trigger,
          onClick: toggle,
        },
        h("span", { style: { fontSize: "10px", lineHeight: "1", opacity: 0.8 } }, "\u25C6"),
        h("span", null, "HNFlow"),
      );

      if (!open) return h("span", { style: styles.root }, trigger);

      const body = h(
        "div",
        {
          role: "dialog",
          "aria-label": "HNFlow",
          id: menuId.current,
          style: anchor === null ? { ...styles.menu, position: "absolute", bottom: "34px", left: 0 } : { ...styles.menu, position: "fixed", left: anchor.left, bottom: anchor.bottom },
        },
        h(
          "div",
          { style: styles.actions },
          ...ACTIONS.map((action) =>
            h(
              "button",
              {
                type: "button",
                key: action.command,
                title: action.hint,
                disabled: busy,
                style: busy ? { ...styles.action, ...styles.actionBusy } : styles.action,
                onClick: () => void run(action.command),
              },
              action.label,
            ),
          ),
        ),
        h("pre", { style: styles.output }, text || "…"),
      );

      return h(
        "span",
        { style: styles.root },
        trigger,
        typeof document === "undefined" || reactDom.createPortal === undefined ? body : reactDom.createPortal(body, document.body),
      );
    }

    /**
     * Client plugin body.
     * @param {Record<string, unknown>} ctx - client context.
     * @returns {void}
     */
    function apply(ctx) {
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
    return module.exports;
  },
});
